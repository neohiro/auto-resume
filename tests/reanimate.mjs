// Restart-reanimation tests.
//
// Proves the "server/machine crashed mid-task -> revive the interrupted
// session" subsystem actually fires, across three entrypoints:
//
//   R1  V1 engine + V1 client          (regression guard, unchanged path)
//   R2  V2 default export + V2 context (the path that was silently dead)
//   R3  V2 immediately after a self-update restart
//
// R2 is the important one. OpenCode 2's plugin context exposes no
// session.list() endpoint, so the reanimation scan had nothing to enumerate and
// every restart came back "green" with nothing revived. The adapter now
// reconstructs the candidate list from the plugin's own persisted
// <plugin>.active.json and confirms each candidate with ctx.session.get().
//
//   node tests/reanimate.mjs
//
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtempSync, writeFileSync } from "node:fs"

import plugin, { createEngine } from "../auto-resume.js"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), `ar-reanimate-${process.pid}-`))
let seq = 0
/** Fresh per-scenario sidecars + a seeded active-session store. */
function scenario(activeIDs) {
  const n = ++seq
  const stop = join(dir, `stop-${n}.json`)
  const off = join(dir, `off-${n}.json`)
  const pause = join(dir, `paused-${n}.json`)
  const health = join(dir, `health-${n}.json`)
  const active = join(dir, `active-${n}.json`)
  process.env.OPENCODE_RESUME_STOPSTORE = stop
  process.env.OPENCODE_RESUME_OFFSTORE = off
  process.env.OPENCODE_RESUME_PAUSESTORE = pause
  process.env.OPENCODE_RESUME_HEALTHSTORE = health
  process.env.OPENCODE_RESUME_ACTIVESTORE = active
  writeFileSync(active, JSON.stringify(Object.fromEntries((activeIDs ?? []).map((id) => [id, Date.now()]))))
  return { stop, off, pause, health, active }
}

/** A session that was mid-turn when the server died: last message is an
 *  assistant turn with no `completed` timestamp and no error. */
const interruptedTurn = (id) => ({
  info: { id: `a-${id}`, role: "assistant", providerID: "openai", modelID: "gpt-5", time: { created: Date.now() } },
  parts: [{ type: "text", text: "I was mid-sentence" }],
})

// ---- R1: V1 engine, V1 client — reanimation still revives -------------------
{
  scenario(["v1sess"])
  const prompts = []
  const client = {
    app: { log: async () => true },
    config: { providers: async () => ({ providers: [] }) },
    session: {
      list: async () => [{ id: "v1sess", time: { updated: Date.now() } }],
      messages: async () => [interruptedTurn("v1sess")],
      status: async () => ({}),
      prompt: async ({ path }) => { prompts.push(path.id); return { data: {} } },
      abort: async () => true,
      summarize: async () => true,
      update: async () => true,
      message: async () => ({ data: { parts: [] } }),
    },
  }
  await createEngine({ client })
  await sleep(2600)
  ok(prompts.includes("v1sess"), `R1: V1 reanimation revives an interrupted session (${prompts.length} prompt)`)
}

// ---- R2: V2 entrypoint, V2 context with NO session.list() ------------------
// The V2 context deliberately omits session.list to mirror the real 2.0.30
// surface. Revival must still happen via the persisted active-session store.
{
  scenario(["v2sess"])
  const injected = []
  const ctx = {
    app: { version: "2.0.30", log: async () => true },
    event: { subscribe: async function* () { await new Promise((r) => setTimeout(r, 50)) } },
    session: {
      // NOTE: no `list` — this is what OpenCode 2 actually exposes.
      get: async ({ sessionID }) => ({ id: sessionID, title: "crashed run", time: { updated: Date.now() } }),
      context: async () => [interruptedTurn("v2sess")],
      prompt: async (i) => { injected.push(i.sessionID); return {} },
      update: async () => true,
      interrupt: async () => true,
      compact: async () => ({}),
      create: async () => ({}),
    },
    provider: { list: async () => [] },
  }
  const dispose = await plugin.setup(ctx)
  await sleep(2600)
  ok(injected.includes("v2sess"),
    `R2: V2 reanimation revives without session.list (${injected.length} prompt)`)
  dispose()
}

// ---- R3: reanimation right after a self-update restart ---------------------
// The self-updater replaces this file in place; the next start must both apply
// the version marker and revive what the previous run left interrupted.
{
  scenario(["postupdate"])
  const injected = []
  const notices = []
  const ctx = {
    app: {
      version: "2.0.30",
      log: async ({ body } = {}) => { if (body?.message) notices.push(body.message); return true },
    },
    event: { subscribe: async function* () { await new Promise((r) => setTimeout(r, 50)) } },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, title: "mid-update run", time: { updated: Date.now() } }),
      context: async () => [interruptedTurn("postupdate")],
      prompt: async (i) => { injected.push(i.sessionID); return {} },
      update: async () => true,
      interrupt: async () => true,
      compact: async () => ({}),
      create: async () => ({}),
    },
    provider: { list: async () => [] },
  }
  const dispose = await plugin.setup(ctx)
  await sleep(2600)
  ok(injected.includes("postupdate"),
    `R3: reanimation still fires on the first boot after an auto-update (${injected.length} prompt)`)
  // The revived session must be reported to the user, not silently resumed.
  ok(notices.some((t) => /Revived .*session after restart/i.test(t)),
    "R3: the revival is announced rather than happening silently")
  dispose()
}

// ---- R4: a stopped session is NOT revived after a restart -------------------
{
  scenario(["stoppedsess"])
  // Mark it stopped on disk before the restart — a user Stop must survive it.
  process.env.OPENCODE_RESUME_STOPSTORE = join(dir, "stop-r4.json")
  writeFileSync(process.env.OPENCODE_RESUME_STOPSTORE, JSON.stringify({ stoppedsess: Date.now() }))
  const injected = []
  const ctx = {
    app: { version: "2.0.30", log: async () => true },
    event: { subscribe: async function* () { await new Promise((r) => setTimeout(r, 50)) } },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, title: "stopped", time: { updated: Date.now() } }),
      context: async () => [interruptedTurn("stoppedsess")],
      prompt: async (i) => { injected.push(i.sessionID); return {} },
      update: async () => true,
      interrupt: async () => true,
      compact: async () => ({}),
      create: async () => ({}),
    },
    provider: { list: async () => [] },
  }
  const dispose = await plugin.setup(ctx)
  await sleep(2600)
  ok(!injected.includes("stoppedsess"),
    `R4: a session the user stopped is never revived by a restart (${injected.length} prompt)`)
  dispose()
}

// ---- R5: an empty session is not revived ------------------------------------
{
  scenario(["emptysess"])
  const injected = []
  const ctx = {
    app: { version: "2.0.30", log: async () => true },
    event: { subscribe: async function* () { await new Promise((r) => setTimeout(r, 50)) } },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, title: "empty", time: { updated: Date.now() } }),
      context: async () => [],
      prompt: async (i) => { injected.push(i.sessionID); return {} },
      update: async () => true,
      interrupt: async () => true,
      compact: async () => ({}),
      create: async () => ({}),
    },
    provider: { list: async () => [] },
  }
  const dispose = await plugin.setup(ctx)
  await sleep(2600)
  ok(!injected.includes("emptysess"), "R5: an empty session is not revived")
  dispose()
}

console.log(process.exitCode ? "REANIMATE TESTS FAILED" : "ALL REANIMATE TESTS PASSED")
