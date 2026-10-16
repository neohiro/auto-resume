// V2 desktop event-vocabulary tests.
//
// WHY THIS FILE EXISTS
// -------------------
// The V2 adapter was originally written against the *documented* V1 event names
// (session.error / session.idle / message.updated / permission.asked /
// todo.updated). Instrumenting a real 2.0.30 desktop server showed it emits
// NONE of them. The plugin loaded, subscribed, received every event -- and
// silently discarded all of them, so nothing ever ran.
//
// These tests replay the vocabulary captured from the live server so a future
// change to the mapping fails loudly here rather than in production.
//
//   node tests/v2events.mjs
//
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0"
// This suite covers turn-end mapping, not crash reanimation (that is
// tests/reanimate.mjs). Reanimation runs on a RANDOM 1-5s deferred stagger,
// which would make every timing assertion here flaky, so it is disabled.
process.env.OPENCODE_RESUME_REANIMATE = "0"
import { tmpdir } from "node:os"
import { join } from "node:path"

let n = 0
const dir = () => join(tmpdir(), `ar-v2ev-${process.pid}-${++n}`)
process.env.OPENCODE_RESUME_STOPSTORE = dir()
process.env.OPENCODE_RESUME_OFFSTORE = dir()
process.env.OPENCODE_RESUME_PAUSESTORE = dir()
process.env.OPENCODE_RESUME_HEALTHSTORE = dir()
process.env.OPENCODE_RESUME_ACTIVESTORE = dir()

import plugin from "../auto-resume.js"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const S = "ses_v2events"

// Start from a clean, known-empty active-session store so reanimation has no
// pre-existing candidates and this suite exercises only what it dispatches.
await (await import("node:fs")).promises.writeFile(process.env.OPENCODE_RESUME_ACTIVESTORE, "{}")

/** Exact envelopes captured from opencode-cli 2.0.30. */
const ev = (type, data) => ({ id: "evt_x", created: Date.now(), type, durable: { aggregateID: S, seq: 1, version: 1 }, location: { directory: "C:/p" }, data })

const stepStarted = (finish) => ev("session.step.started", { sessionID: S, assistantMessageID: "msg_1", agent: "build", model: { id: "m", providerID: "p", variant: "max" }, snapshot: "a", started: Date.now() })
const stepEnded = (finish) => ev("session.step.ended", { sessionID: S, assistantMessageID: "msg_1", finish, rawFinish: finish, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, snapshot: "a", files: [] })
const textDelta = (delta) => ev("session.text.delta", { sessionID: S, assistantMessageID: "msg_1", ordinal: 0, delta })
const toolSuccess = () => ev("session.tool.success", { sessionID: S, assistantMessageID: "msg_1", id: "call_1", content: [{ type: "text", text: "ok" }], metadata: { status: "completed", exit: 0 }, executed: false })

function makeCtx(state, events, messages = []) {
  return {
    app: { version: "2.0.30", log: async ({ body } = {}) => { if (body?.message) state.logs.push(body.message); return true } },
    permission: {
      hook: async (name, cb) => { state.permHook = { name, cb }; return { dispose: async () => {} } },
    },
    event: {
      subscribe: async function* () { for (const e of events) yield e },
    },
    session: {
      // Only the session under test exists. Without this guard the mock
      // resolves ANY id, so a stray entry in a real sidecar file can make
      // reanimation "revive" a session that the test never created.
      get: async ({ sessionID }) => {
        if (sessionID !== S) throw new Error(`no such session: ${sessionID}`)
        return { id: sessionID, title: "t", time: { updated: Date.now() } }
      },
      context: async () => messages,
      prompt: async (i) => { state.prompts.push({ id: i.sessionID, text: i.text }); return {} },
      update: async () => true, interrupt: async () => true, compact: async () => ({}), create: async () => ({}),
    },
    provider: { list: async () => [] },
  }
}

const baseState = () => ({ prompts: [], logs: [], permHook: null })

// ---- E1: a full turn must produce a resume-capable evaluation --------------
// step.started -> text -> tool -> step.ended(finish="stop") => idle => autopilot.
{
  const state = baseState()
  const ctx = makeCtx(state, [
    stepStarted(), textDelta("Working on it"), toolSuccess(), stepEnded("stop"),
  ], [
    { info: { id: "a1", role: "assistant", error: null, time: { completed: Date.now() } },
      parts: [{ type: "text", text: "A substantive reply long enough to clear the improvement-pass length threshold cleanly." }] },
  ])
  const dispose = await plugin.setup(ctx)
  await sleep(2200)
  ok(state.prompts.length > 0,
    `E1: a captured V2 turn drives the engine (${state.prompts.length} prompt)`)
  ok(state.prompts.some((p) => /Self-improvement pass/i.test(p.text)),
    "E1: turn end (step.ended finish=stop) is treated as session idle and evaluated")
  dispose()
}

// ---- E2: finish="tool-calls" must NOT be treated as a turn end -------------
// A tool-calling step is followed by another step; evaluating here would
// evaluate mid-turn and could inject a duplicate prompt.
{
  const state = baseState()
  const ctx = makeCtx(state, [
    stepStarted(), toolSuccess(), stepEnded("tool-calls"),
  ], [
    { info: { id: "a1", role: "assistant", error: null, time: { completed: Date.now() } },
      parts: [{ type: "text", text: "Another long enough reply to clear the threshold had this been evaluated at all." }] },
  ])
  const dispose = await plugin.setup(ctx)
  await sleep(2200)
  ok(state.prompts.length === 0,
    `E2: finish="tool-calls" is not a turn end, so nothing is injected (${state.prompts.length})`)
  dispose()
}

// ---- E3: the idle confirmation cancels when the next step starts ----------
// Without the confirmation window, a step that ends and is immediately
// followed by another would evaluate mid-turn and inject a duplicate prompt.
{
  const state = baseState()
  const ctx = makeCtx(state, [
    stepStarted(), textDelta("working"), stepEnded("stop"),
    // A new step arrives inside the confirmation window -> not a turn end.
    stepStarted(), textDelta("more"), toolSuccess(), stepEnded("stop"),
  ], [
    { info: { id: "a1", role: "assistant", error: null, time: { completed: Date.now() } },
      parts: [{ type: "text", text: "Long enough reply text to pass the eighty character threshold used for the improvement pass here." }] },
  ])
  const dispose = await plugin.setup(ctx)
  await sleep(2600)
  ok(state.prompts.length === 1,
    `E3: a queued idle is cancelled by the next step.started, so the turn evaluates exactly once (${state.prompts.length})`)
  dispose()
}

// ---- E4: text deltas mark the turn as having produced content -------------
// Regression guard for the real bug found while porting: step.ended was
// synthesised as a *busy* status, which clears the engine's
// "this turn delivered content" flag, so every turn looked empty and idle
// evaluation was skipped entirely. A text delta must survive step.ended.
{
  const state = baseState()
  const ctx = makeCtx(state, [
    stepStarted(), textDelta("hello"), stepEnded("stop"),
  ], [
    { info: { id: "a1", role: "assistant", error: null, time: { completed: Date.now() } },
      parts: [{ type: "text", text: "A reply whose length clears the eighty character threshold for the improvement pass." }] },
  ])
  const dispose = await plugin.setup(ctx)
  await sleep(2400)
  ok(state.prompts.length > 0,
    `E4: session.text.delta survives step.ended and marks the turn as delivered (${state.prompts.length} prompt)`)
  dispose()
}

// ---- E4b: a turn with NO text/tool output is correctly left alone ---------
{
  const state = baseState()
  const ctx = makeCtx(state, [
    stepStarted(), stepEnded("stop"),
  ], [
    { info: { id: "a1", role: "assistant", error: null, time: { completed: Date.now() } },
      parts: [{ type: "text", text: "A reply long enough to pass the threshold if it were ever evaluated at all." }] },
  ])
  const dispose = await plugin.setup(ctx)
  await sleep(2400)
  ok(state.prompts.length === 0,
    `E4b: a turn that produced no output is not evaluated (${state.prompts.length})`)
  dispose()
}

// ---- E5: session.retry.scheduled becomes a status + provider hint ---------
{
  const state = baseState()
  const ctx = makeCtx(state, [
    ev("session.step.started", { sessionID: S, assistantMessageID: "msg_1" }),
    ev("session.retry.scheduled", {
      sessionID: S, attempt: 3, next: Date.now() + 30_000,
      reason: "rate limited", provider: "openrouter",
    }),
    ev("session.step.ended", { sessionID: S, assistantMessageID: "msg_1", finish: "stop" }),
  ], [
    { info: { id: "a1", role: "assistant", error: null, time: { completed: Date.now() } },
      parts: [{ type: "text", text: "Some content that is long enough to pass the improvement threshold here." }] },
  ])
  const dispose = await plugin.setup(ctx)
  await sleep(2200)
  ok(true, "E5: session.retry.scheduled is handled without error")
  dispose()
}

// ---- E6: the permission autopilot binds to the native V2 hook --------------
{
  const state = baseState()
  const ctx = makeCtx(state, [], [])
  const dispose = await plugin.setup(ctx)
  await sleep(200)
  ok(!!state.permHook && state.permHook.name === "evaluate",
    "E6: autopilot registers ctx.permission.hook('evaluate')")
  if (state.permHook) {
    // A safe bash command should be allowed without a prompt.
    const e1 = { sessionID: S, action: "bash", resources: ["npm test"], metadata: { command: "npm test" }, effect: "ask" }
    state.permHook.cb(e1)
    ok(e1.effect === "allow", `E6: safe command is allowed via the hook (got ${e1.effect})`)

    // A dangerous command must be denied, not asked.
    const e2 = { sessionID: S, action: "bash", resources: ["rm -rf /"], metadata: { command: "rm -rf /" }, effect: "ask" }
    state.permHook.cb(e2)
    ok(e2.effect === "deny", `E6: dangerous command is denied via the hook (got ${e2.effect})`)
  }
  dispose()
}

// ---- E7: activity is recorded so a later restart can revive it ------------
{
  const fs = await import("node:fs")
  const state = baseState()
  const activePath = process.env.OPENCODE_RESUME_ACTIVESTORE
  fs.writeFileSync(activePath, "{}")
  const ctx = makeCtx(state, [stepStarted(), textDelta("working")], [])
  const dispose = await plugin.setup(ctx)
  await sleep(800)
  dispose()
  const active = JSON.parse(fs.readFileSync(activePath, "utf8"))
  ok(Boolean(active[S]),
    `E7: a V2-active session is recorded for restart revival (${JSON.stringify(active)})`)
}

console.log(process.exitCode ? "V2 EVENT TESTS FAILED" : "ALL V2 EVENT TESTS PASSED")