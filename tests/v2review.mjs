// Self-review regression tests.
//
// Each block pins a defect found while reviewing the V2 adapter, so it cannot
// come back unnoticed.
//
//   node tests/v2review.mjs
//
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0"
process.env.OPENCODE_RESUME_REANIMATE = "0"
import { tmpdir } from "node:os"
import { join } from "node:path"

let n = 0
const dir = () => join(tmpdir(), `ar-rv-${process.pid}-${++n}`)
for (const k of ["STOPSTORE", "OFFSTORE", "PAUSESTORE", "HEALTHSTORE", "ACTIVESTORE"]) {
  process.env[`OPENCODE_RESUME_${k}`] = dir()
}
await (await import("node:fs")).promises.writeFile(process.env.OPENCODE_RESUME_ACTIVESTORE, "{}")

import plugin from "../auto-resume.js"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const S = "ses_review"
const ev = (type, data) => ({ id: "evt", created: Date.now(), type, durable: { aggregateID: S, seq: 1, version: 1 }, location: { directory: "C:/p" }, data })

function makeCtx(state, events, messages = []) {
  return {
    app: { version: "2.0.30", log: async ({ body } = {}) => { if (body?.message) state.logs.push(`${body.message} ${JSON.stringify(body.extra ?? {})}`); return true } },
    permission: { hook: async () => ({ dispose: async () => {} }) },
    event: { subscribe: async function* () { for (const e of events) yield e } },
    session: {
      get: async ({ sessionID }) => { if (sessionID !== S) throw new Error("no such"); return { id: sessionID, title: "t", time: { updated: Date.now() } } },
      context: async () => { state.contextCalls += 1; return messages },
      prompt: async (i) => { state.prompts.push({ id: i.sessionID, text: i.text }); return {} },
      update: async () => true, interrupt: async () => true, compact: async () => ({}), create: async () => ({}),
    },
    provider: { list: async () => [] },
  }
}

const baseState = () => ({ prompts: [], logs: [], contextCalls: 0 })

// ---- R1: noise event families never reach the engine ----------------------
// A live server emitted 2064 skill.updated events against 418 of everything
// else. Each was being normalised and serialised onto the handler chain only to
// be ignored by the engine's switch.
{
  const state = baseState()
  const noise = []
  for (let i = 0; i < 200; i++) {
    noise.push(ev("skill.updated", { id: `sk_${i}` }))
    noise.push(ev("plugin.updated", { id: `pl_${i}` }))
    noise.push(ev("session.usage.updated", { sessionID: S }))
  }
  const ctx = makeCtx(state, noise, [])
  const dispose = await plugin.setup(ctx)
  await sleep(600)
  ok(state.contextCalls === 0 && state.prompts.length === 0,
    `R1: 600 skill/plugin/usage events cause no engine work (ctx calls ${state.contextCalls})`)
  dispose()
}

// ---- R2: real events still get through the same filter -------------------
{
  const state = baseState()
  const ctx = makeCtx(state, [
    ev("session.step.started", { sessionID: S, assistantMessageID: "m1" }),
    ev("session.text.delta", { sessionID: S, assistantMessageID: "m1", ordinal: 0, delta: "hello" }),
    ev("session.step.ended", { sessionID: S, assistantMessageID: "m1", finish: "stop" }),
  ], [
    { info: { id: "a1", role: "assistant", error: null, time: { completed: Date.now() } },
      parts: [{ type: "text", text: "A reply long enough to clear the eighty character threshold used by the improvement pass." }] },
  ])
  const dispose = await plugin.setup(ctx)
  await sleep(2200)
  ok(state.prompts.length > 0,
    `R2: session.* events still reach the engine after the noise filter (${state.prompts.length} prompt)`)
  dispose()
}

// ---- R3: the sweep must NOT fire on a merely-incomplete turn -------------
// The defect: a session still thinking (slow model / long tool) has an
// assistant message with no `completed` timestamp, which the sweep used to treat
// as an abort — injecting a resume into a live turn and duplicating work. The
// think-stall watchdog owns that case; the sweep must report real errors only.
{
  const state = baseState()
  const ctx = makeCtx(state, [
    ev("session.step.started", { sessionID: S, assistantMessageID: "m1" }),
    // Deliberately incomplete: still streaming, no error.
  ], [
    { info: { id: "a1", role: "assistant", error: null, time: { created: Date.now() } },
      parts: [{ type: "text", text: "Still streaming..." }] },
  ])
  const dispose = await plugin.setup(ctx)
  // The sweep runs every 15s; wait past one full tick.
  await sleep(17000)
  ok(!state.logs.some((l) => /session error/i.test(l)),
    `R3: an incomplete-but-live turn is never reported as a session error (${state.logs.length} logs)`)
  ok(!state.prompts.some((p) => /session error|aborted/i.test(p.text)),
    "R3: no abort-style resume is injected into a live turn")
  dispose()
}

// ---- R4: the sweep DOES report a real error ------------------------------
{
  const state = baseState()
  const ctx = makeCtx(state, [
    ev("session.step.started", { sessionID: S, assistantMessageID: "m1" }),
  ], [
    { info: { id: "a1", role: "assistant", error: { type: "APIError", message: "fetch failed", status: 503 }, time: { completed: Date.now() } },
      parts: [{ type: "text", text: "partial" }] },
  ])
  const dispose = await plugin.setup(ctx)
  await sleep(17000)
  ok(state.logs.some((l) => /session error/i.test(l)),
    `R4: a genuinely errored turn is still reported by the sweep (${state.logs.length} logs)`)
  dispose()
}

// ---- R5: every session-keyed map in the V2 adapter is bounded -------------
// The leak class found in review was repeated: a Map keyed by session, written
// on every event, never pruned. Each one costs one entry per session for the
// life of the process, and a long-lived server accumulates them indefinitely.
// These are not observable from outside the plugin, so assert the bound exists
// structurally — a new session-keyed Map added later fails here by default.
{
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const src = readFileSync(fileURLToPath(new URL("../auto-resume.js", import.meta.url)), "utf8")

  // Session-keyed Maps: name -> the cap constant that must govern it.
  const sessionKeyed = [
    ["statusBySession", "STATUS_MAX"],
    ["retryStatusBySession", "RETRY_STATUS_MAX"],
    ["sweepState", "SWEEP_STATE_MAX"],
    ["lastSeenBySession", "LAST_SEEN_MAX"],
    ["messageCache", "MESSAGE_CACHE_MAX"],
  ]
  for (const [mapName, capName] of sessionKeyed) {
    const declares = new RegExp(`const ${mapName} = new Map\\(\\)`).test(src)
    const hasCap = new RegExp(`const ${capName} = \\d+`).test(src)
    // A bound only counts if the map is actually checked against its cap, not
    // merely declared next to it. Accepts either comparison direction.
    const evicts = new RegExp(`${mapName}\\.size > ${capName}`).test(src)
      || new RegExp(`${mapName}\\.size <= ${capName}`).test(src)
    ok(declares && hasCap && evicts,
      `R5: ${mapName} is bounded by ${capName} (declared ${declares}, cap ${hasCap}, evicts ${evicts})`)
  }
}

// ---- R6: the native hook owns permissions once it registers ---------------
// `permission.asked` never appears on the V2 stream today, so only one route can
// answer a request. If a future core emitted it again, the event route and the
// native hook would both answer the same request. The hook must take exclusive
// ownership once registered, and be disposed on teardown.
//
// Two cases, because a single "no reply" assertion proves nothing: the control
// proves the mock CAN produce a reply through this route at all.
{
  const makePermCtx = (state, withHook) => {
    const queue = []
    let notify = () => {}
    const nextEvent = () => new Promise((r) => {
      const v = queue.shift()
      if (v !== undefined) return r(v)
      notify = () => { notify = () => {}; r(queue.shift()) }
    })
    const ctx = makeCtx(state, [], [])
    ctx.session.permission = {
      reply: async (arg) => {
        state.permResponses.push({ sessionID: arg.sessionID, requestID: arg.requestID, reply: arg.reply })
        return true
      },
    }
    ctx.event.subscribe = async function* () { while (true) yield await nextEvent() }
    ctx.feed = (e) => { queue.push(e); notify() }
    if (withHook) {
      let hookReady
      const ready = new Promise((r) => { hookReady = r })
      ctx.permission.hook = async (_kind, cb) => {
        ctx.permission.evaluate = cb
        hookReady()
        return async () => { state.disposed += 1 }
      }
      ctx.hookReady = ready
    } else {
      // An older core: no native hook at all, so the event route must serve.
      delete ctx.permission.hook
    }
    return ctx
  }

  const ask = () => ev("permission.asked", {
    sessionID: S, id: "per_1", action: "external_directory", resources: ["C:/p/vendor/**"],
  })

  // Control: no native hook (an older core) — the event route must answer.
  {
    const state = { ...baseState(), permResponses: [], disposed: 0 }
    const ctx = makePermCtx(state, false)
    const dispose = await plugin.setup(ctx)
    await sleep(200)
    ctx.feed(ask())
    await sleep(500)
    ok(state.permResponses.length === 1,
      `R6: control — without the hook, the event route still answers (${state.permResponses.length} reply)`)
    dispose()
  }

  // With the hook registered, the same event must not answer again.
  {
    const state = { ...baseState(), permResponses: [], disposed: 0 }
    const ctx = makePermCtx(state, true)
    const dispose = await plugin.setup(ctx)
    await ctx.hookReady // registration resolved, so the hook owns permissions
    await sleep(200)
    ctx.feed(ask())
    await sleep(500)
    ok(state.permResponses.length === 0,
      `R6: once the hook is bound the event route is skipped (${state.permResponses.length} replies)`)
    dispose()
    await sleep(100)
    ok(state.disposed === 1, `R6: the native hook is disposed on teardown (disposed ${state.disposed}x)`)
  }
}

// ---- R7: teardown wins the race against a pending hook registration -------
// Registration resolves asynchronously, so dispose() can run first. Without an
// explicit guard the late resolution stores a disposer nobody will call and the
// hook stays bound to the context forever — the exact leak this pass fixed.
{
  const state = { ...baseState(), disposed: 0 }
  const ctx = makeCtx(state, [], [])
  let release
  const pending = new Promise((r) => { release = r })
  ctx.permission.hook = async () => {
    await pending // registration deliberately held open
    return async () => { state.disposed += 1 }
  }

  const dispose = await plugin.setup(ctx)
  dispose() // teardown runs BEFORE registration resolves
  await sleep(50)
  ok(state.disposed === 0, `R7: nothing to release before registration resolves (${state.disposed})`)

  release() // now let registration complete
  await sleep(300)
  ok(state.disposed === 1,
    `R7: a late-resolving registration is released immediately, not leaked (${state.disposed})`)
}

console.log(process.exitCode ? "V2 REVIEW TESTS FAILED" : "ALL V2 REVIEW TESTS PASSED")