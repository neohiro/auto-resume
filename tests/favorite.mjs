// Favorite-model return: after rotating away from a rate-limited model, the
// plugin must hand an *idle* session back to the user's original model once the
// alternate has proven stable and the favorite's cool-down has cleared.
//
// Env is tuned so the cool-down gate is reachable without waiting an hour.
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0"
process.env.OPENCODE_RESUME_WATCHDOG_MS ??= "40"
// 0 means "out of cooldown as soon as a millisecond passes" -- the watchdog
// fires 40ms later, so `cooling()` reads false by then.
process.env.OPENCODE_RESUME_MODEL_COOLDOWN_MS ??= "0"
process.env.OPENCODE_RESUME_FAVORITE_CHECK_AFTER_MS ??= "0"
process.env.OPENCODE_RESUME_FAVORITE_MIN_TURNS ??= "2"
process.env.OPENCODE_RESUME_STOPSTORE = join(tmpdir(), `ar-fav-stop-${process.pid}-${Date.now()}.json`)
process.env.OPENCODE_RESUME_OFFSTORE = join(tmpdir(), `ar-fav-off-${process.pid}-${Date.now()}.json`)

import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AutoResumePlugin } from "../auto-resume.js"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (type, properties) => ({ event: { type, properties } })

const FAV = { providerID: "provA", modelID: "a-max" }
const ALT = { providerID: "provA", modelID: "a-mini" }
// `session.chat` is not part of the OpenCode SDK (the surface is
// `session.prompt`). The orphaned master branch called it anyway, so the mock
// omits it and records any member the plugin reaches for that the SDK does not
// have -- reintroducing that class of bug fails T1.
const SESSION_METHODS = ["list", "get", "update", "status", "prompt", "abort", "summarize", "messages", "message"]
// Probed with `??` fallbacks by the injection path; absence is expected and
// handled, so touching them is not a defect.
const OPTIONAL_PROBES = new Set(["promptAsync", "postSessionByIdPromptAsync"])

function makeClient(state, models = ["a-max", "a-mini"]) {
  const impls = {
    list: async () => ({ data: state.sessionList.map((id) => ({ id, title: `t ${id}` })) }),
    get: async ({ path }) => ({ data: { id: path.id, title: `t ${path.id}` } }),
    update: async () => ({ data: {} }),
    status: async () => ({ data: Object.fromEntries([...state.idleIds].map((id) => [id, { type: "idle" }])) }),
    prompt: async ({ path, body }) => {
      state.prompts.push({ id: path.id, model: body?.model ?? null })
      return { data: {} }
    },
    abort: async () => true,
    summarize: async () => true,
    messages: async ({ path }) => {
      const entries = structuredClone(state.messagesBySession[path.id] ?? [
        { info: { role: "assistant", error: null, id: `m${++state.msgN}` }, parts: [{ type: "text", text: "ok" }] },
      ])
      if (entries.length) entries[entries.length - 1].info.id = `m${++state.msgN}`
      return { data: entries }
    },
    message: async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
  }
  const session = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === "string" && !(prop in impls)) {
        if (!OPTIONAL_PROBES.has(prop)) state.unknownCalls.add(prop)
        return undefined // match the real SDK: no such method
      }
      return (...args) => impls[prop](...args)
    },
    has(_t, prop) { return prop in impls },
  })
  return {
    app: { log: async ({ body }) => { state.logs.push(body?.message ?? ""); return true } },
    config: { providers: async () => ({
      data: { providers: [{ id: "provA", models: Object.fromEntries(models.map((m) => [m, {}])) }] },
    }) },
    session,
  }
}

function makeState(idle = []) {
  return {
    prompts: [], logs: [], unknownCalls: new Set(),
    idleIds: new Set(idle), msgN: 0, sessionList: [], messagesBySession: {},
  }
}

const cleanTurn = (state, id, model) => {
  state.messagesBySession[id] = [{
    info: { role: "assistant", error: null, providerID: model.providerID, modelID: model.modelID, id: `m${++state.msgN}` },
    parts: [{ type: "text", text: "work" }],
  }]
}

// Boot a session, learn the favorite from its first reply, then 429 it into
// rotating. The rotation goes through the real error path, so the
// favorite-return tracker is armed by production code, not poked in by hand.
// The catalog holds exactly one alternate so the rotation target is known.
async function rotatedSession(id, { models, cooldownMs } = {}) {
  if (cooldownMs !== undefined) process.env.OPENCODE_RESUME_MODEL_COOLDOWN_MS = String(cooldownMs)
  const state = makeState([id])
  const hooks = await AutoResumePlugin({ client: makeClient(state, models) })
  await hooks.event(ev("message.updated", { info: { role: "assistant", sessionID: id, ...FAV } }))
  await hooks.event(ev("session.idle", { sessionID: id }))
  await sleep(20)
  await hooks.event(ev("session.error", {
    sessionID: id, error: { name: "RateLimitError", data: { statusCode: 429, message: "rate limited" } },
  }))
  await sleep(80)
  return { state, hooks }
}

const restoredLog = (state) => state.logs.filter((l) => l.includes("restoring favorite model")).length
const settle = async (hooks, state, id, model, times) => {
  for (let i = 0; i < times; i++) {
    cleanTurn(state, id, model)
    await hooks.event(ev("session.idle", { sessionID: id }))
    await sleep(60)
  }
}

// ---- T1: the real SDK has no session.chat, and we never reach for one ----
{
  // Probe a throwaway client so the intentional `chat` lookup isn't recorded.
  const probe = makeClient(makeState())
  ok(!("chat" in probe.session) && typeof probe.session.chat === "undefined",
    "T1a: mock client has no session.chat, matching the real SDK")

  const state = makeState(["t1"])
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await settle(hooks, state, "t1", FAV, 2)
  await sleep(200)
  ok(state.unknownCalls.size === 0,
    `T1b: no unmodelled session.* access during idle ticks (saw: ${[...state.unknownCalls].join(",") || "none"})`)
}

// ---- T2: returns to the favorite once the alternate proves stable ----
{
  const { state, hooks } = await rotatedSession("t2")
  ok(state.prompts.some((p) => p.model?.modelID === ALT.modelID),
    `T2a: rotated onto the only alternate after the 429 (${JSON.stringify(state.prompts.at(-1)?.model)})`)
  await settle(hooks, state, "t2", ALT, 2)
  await sleep(200)
  ok(restoredLog(state) === 1, `T2b: restored the favorite after 2 stable turns (${restoredLog(state)} restores)`)
  ok(state.unknownCalls.size === 0, `T2c: restore needed no SDK call (saw: ${[...state.unknownCalls].join(",") || "none"})`)

  // The observable effect, not just the log line: the next recovery injection
  // must actually carry the favorite model.
  const before = state.prompts.length
  await hooks.event(ev("session.error", {
    sessionID: "t2", error: { name: "APIError", data: { statusCode: 503, message: "service unavailable" } },
  }))
  await sleep(150)
  const injected = state.prompts.at(-1)
  ok(state.prompts.length > before && injected?.model?.modelID === FAV.modelID,
    `T2d: next injected prompt carries the favorite (${JSON.stringify(injected?.model)})`)
}

// ---- T3: holds off until the stability gate is met ----
{
  const { state, hooks } = await rotatedSession("t3")
  await settle(hooks, state, "t3", ALT, 1)
  await sleep(250)
  ok(restoredLog(state) === 0, "T3: held off with only 1 stable turn (favoriteMinTurns is 2)")
}

// ---- T4: the favorite still on cooldown is left alone ----
{
  const { state, hooks } = await rotatedSession("t4", { cooldownMs: 600_000 })
  await settle(hooks, state, "t4", ALT, 3)
  await sleep(200)
  ok(restoredLog(state) === 0, "T4: did not return to a favorite that is still on cooldown")
  process.env.OPENCODE_RESUME_MODEL_COOLDOWN_MS = "0"
}

// ---- T5: never swaps a busy session ----
// Stability is banked across idle turns (that is the only path that runs
// evaluateIdle), then the user starts working. The watchdog interval is
// stretched and the gate raised so the only ticks that see an open gate are
// the ones that run while the session is busy.
{
  process.env.OPENCODE_RESUME_WATCHDOG_MS = "250"
  process.env.OPENCODE_RESUME_FAVORITE_MIN_TURNS = "3"
  const { state, hooks } = await rotatedSession("t5")
  await settle(hooks, state, "t5", ALT, 2)
  // Third turn crosses the gate; mark busy immediately after it lands so the
  // first tick that sees an open gate also sees "busy".
  cleanTurn(state, "t5", ALT)
  await hooks.event(ev("session.idle", { sessionID: "t5" }))
  // No sleep here: idle and busy must land in the same microtask drain. Any
  // macrotask gap (even sleep(10)) admits a watchdog tick that observes an
  // open gate on a still-idle session and restores — a test-timing flake, not
  // a plugin bug (busy sessions are correctly skipped once busy is observed).
  await hooks.event(ev("session.status", { sessionID: "t5", status: { type: "busy" } }))
  await sleep(700) // several watchdog ticks
  ok(restoredLog(state) === 0, "T5: no swap while the session is busy")
  process.env.OPENCODE_RESUME_WATCHDOG_MS = "40"
  process.env.OPENCODE_RESUME_FAVORITE_MIN_TURNS = "2"
}

// ---- T5b: a queued recovery blocks the swap ----
// The busy guard lives at the call site; this pins the separate pendingResume
// gate, which is the case the call site cannot cover (idle, but a resume is
// already scheduled and about to read currentModel).
{
  process.env.OPENCODE_RESUME_FAVORITE_MIN_TURNS = "1"
  process.env.OPENCODE_RESUME_WATCHDOG_MS = "250"
  process.env.OPENCODE_RESUME_BASE_DELAY_MS = "3000" // keep the recovery queued
  process.env.OPENCODE_RESUME_MAX_DELAY_MS = "3000"
  const { state, hooks } = await rotatedSession("t5b")
  await settle(hooks, state, "t5b", ALT, 1)
  // A 503 schedules a recovery; while that is pending, status is still idle.
  await hooks.event(ev("session.error", {
    sessionID: "t5b", error: { name: "APIError", data: { statusCode: 503, message: "service unavailable" } },
  }))
  await sleep(700) // watchdog ticks at 250/500/750, recovery still queued
  ok(restoredLog(state) === 0, "T5b: no swap while a recovery is already queued")
  process.env.OPENCODE_RESUME_FAVORITE_MIN_TURNS = "2"
  process.env.OPENCODE_RESUME_WATCHDOG_MS = "40"
  process.env.OPENCODE_RESUME_BASE_DELAY_MS = "30"
  process.env.OPENCODE_RESUME_MAX_DELAY_MS = "500"
}

// ---- T6: idempotent once home -- no repeated restores or notice churn ----
{
  const { state, hooks } = await rotatedSession("t6")
  await settle(hooks, state, "t6", ALT, 2)
  await sleep(200)
  const first = restoredLog(state)
  // Many more idle ticks on the now-favorite model.
  for (let i = 0; i < 3; i++) {
    cleanTurn(state, "t6", FAV)
    await hooks.event(ev("session.idle", { sessionID: "t6" }))
    await sleep(120)
  }
  ok(first === 1 && restoredLog(state) === 1,
    `T6: restored exactly once, then stayed quiet (${first} -> ${restoredLog(state)})`)
}

// ---- T7: disabled by config ----
{
  process.env.OPENCODE_RESUME_FAVORITE_RETURN = "0"
  const { state, hooks } = await rotatedSession("t7")
  await settle(hooks, state, "t7", ALT, 3)
  await sleep(200)
  ok(restoredLog(state) === 0, "T7: FAVORITE_RETURN=0 disables the restore")
  delete process.env.OPENCODE_RESUME_FAVORITE_RETURN
}

process.on("exit", () => {
  for (const f of [process.env.OPENCODE_RESUME_STOPSTORE, process.env.OPENCODE_RESUME_OFFSTORE]) {
    try { rmSync(f, { force: true }) } catch { /* best effort */ }
  }
})
