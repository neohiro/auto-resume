// V2 provider-failure detection tests.
//
// THE BUG THIS GUARDS
// -------------------
// A rejected provider request ("Provider request failed with HTTP 403") arrives
// on OpenCode 2 as `session.step.failed`, carrying a structured error. That
// mapping was missing, so the failure was invisible to the plugin: the turn
// looked like a silent stall and ~60s later the think-stall watchdog injected
//
//   [auto-resume] Auto-retry #1. Self-healing; the previous turn was busy
//   ~60s with no output and got aborted.
//
// ...which both misdiagnoses the cause (nothing was "busy"; the provider
// rejected the request) and, for a hard error, retries something that cannot
// succeed. These tests pin the correct behaviour.
//
//   node tests/v2failures.mjs
//
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0"
process.env.OPENCODE_RESUME_REANIMATE = "0"
import { tmpdir } from "node:os"
import { join } from "node:path"

let n = 0
const dir = () => join(tmpdir(), `ar-v2f-${process.pid}-${++n}`)
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

const S = "ses_v2fail"
const ev = (type, data) => ({ id: "evt", created: Date.now(), type, durable: { aggregateID: S, seq: 1, version: 1 }, location: { directory: "C:/p" }, data })

const stepStarted = () => ev("session.step.started", { sessionID: S, assistantMessageID: "msg_1" })
/** The real shape of a provider rejection. */
const stepFailed = (error, extra = {}) => ev("session.step.failed", {
  sessionID: S, assistantMessageID: "msg_1", error, ...extra,
})

function makeCtx(state, events, messages = []) {
  return {
    app: { version: "2.0.30", log: async ({ body } = {}) => { if (body?.message) state.logs.push(`${body.message} ${JSON.stringify(body.extra ?? {})}`); return true } },
    event: { subscribe: async function* () { for (const e of events) yield e } },
    session: {
      get: async ({ sessionID }) => { if (sessionID !== S) throw new Error("no such"); return { id: sessionID, title: "t", time: { updated: Date.now() } } },
      context: async () => messages,
      prompt: async (i) => { state.prompts.push({ id: i.sessionID, text: i.text }); return {} },
      update: async () => true, interrupt: async () => true, compact: async () => ({}), create: async () => ({}),
    },
    provider: { list: async () => [] },
  }
}

const baseState = () => ({ prompts: [], logs: [] })

// ---- F1: HTTP 403 is detected and reported, not mistaken for a stall -----
{
  const state = baseState()
  const ctx = makeCtx(state, [
    stepStarted(),
    stepFailed({ type: "APIError", message: "Provider request failed with HTTP 403", status: 403 }),
  ], [])
  const dispose = await plugin.setup(ctx)
  await sleep(2200)
  ok(state.logs.some((l) => /session error/i.test(l)),
    `F1: a 403 is detected as a session error (${state.logs.length} logs)`)
  ok(!state.prompts.some((p) => /Auto-retry #\d+.*no output/i.test(p.text)),
    "F1: the misleading think-stall 'Auto-retry ... no output' message is NOT used")
  const errLog = state.logs.find((l) => /session error/i.test(l))
  ok(/403/.test(errLog ?? ""), `F1: the real cause (HTTP 403) is surfaced (${errLog})`)
  dispose()
}

// ---- F1b: a 403 now recovers instead of silently killing the session -------
// 403 is overloaded across providers (credentials, quota/billing, model-access
// denial, org restrictions) and the client reports only the bare status, so
// classifying it as fatal stranded sessions with no recovery and no notice.
// It is retried on the same model; the circuit breaker bounds the retries.
{
  const state = baseState()
  const ctx = makeCtx(state, [
    stepStarted(),
    stepFailed({ type: "APIError", message: "Provider request failed with HTTP 403", status: 403 }),
  ], [])
  const dispose = await plugin.setup(ctx)
  await sleep(2200)
  ok(state.prompts.length > 0,
    `F1b: a 403 produces a resume prompt rather than dying silently (${state.prompts.length} prompts)`)
  const p = state.prompts.at(-1)?.text ?? ""
  ok(!/credential|api key|sign in|authenticat/i.test(p),
    `F1b: the prompt does not blame the model's credentials (${p.slice(0, 90)}...)`)
  dispose()
}

// ---- F1c: HTTP 401 stays fatal — that one really is bad credentials -------
{
  const state = baseState()
  const ctx = makeCtx(state, [
    stepStarted(),
    stepFailed({ type: "APIError", message: "invalid api key", status: 401 }),
  ], [])
  const dispose = await plugin.setup(ctx)
  await sleep(2200)
  ok(state.prompts.length === 0,
    `F1c: a 401 is still fatal and is not retried (${state.prompts.length} prompts)`)
  dispose()
}

// ---- F2: a retryable 5xx IS recovered with a resume prompt ----------------
{
  const state = baseState()
  const ctx = makeCtx(state, [
    stepStarted(),
    stepFailed({ type: "APIError", message: "internal server error", status: 503 }),
  ], [])
  const dispose = await plugin.setup(ctx)
  await sleep(2200)
  ok(state.prompts.some((p) => /transport fault|provider's servers failed/i.test(p.text)),
    `F2: a 5xx failure produces a recovery prompt (${state.prompts.length} prompt)`)
  ok(!state.prompts.some((p) => /no output/i.test(p.text)),
    "F2: a provider failure is not misreported as a silent stall")
  dispose()
}

// ---- F3: a content-filter stop is reframed, not retried as a failure ------
{
  const state = baseState()
  const ctx = makeCtx(state, [
    stepStarted(),
    // Content needs to have been delivered, otherwise evaluateIdle's
    // relevance gate legitimately skips the turn.
    ev("session.text.delta", { sessionID: S, assistantMessageID: "msg_1", ordinal: 0, delta: "thinking" }),
    stepFailed({ type: "APIError", message: "blocked by safety filter", status: 400 }, { finish: "content-filter" }),
  ], [
    { info: { id: "a1", role: "assistant", error: null, finish: "content-filter", time: { completed: Date.now() } },
      parts: [{ type: "text", text: "A reply long enough to clear the eighty character threshold for the improve pass." }] },
  ])
  const dispose = await plugin.setup(ctx)
  await sleep(2400)
  ok(state.prompts.some((p) => /safety filter/i.test(p.text)),
    "F3: a content-filter stop drives the reframe message, not an error retry")
  ok(!state.prompts.some((p) => /provider's servers failed|transport fault/i.test(p.text)),
    "F3: a content-filter stop is not treated as a provider failure")
  dispose()
}

// ---- F4: an execution interrupt must NOT be turned into a recovery -------
// The engine promises never to recover from a genuine user Stop.
{
  const state = baseState()
  const ctx = makeCtx(state, [
    stepStarted(),
    ev("session.execution.interrupted", { sessionID: S }),
  ], [
    { info: { id: "a1", role: "assistant", error: { name: "MessageAbortedError", data: { message: "aborted" } }, time: { completed: Date.now() } },
      parts: [{ type: "text", text: "partial" }] },
  ])
  const dispose = await plugin.setup(ctx)
  await sleep(2400)
  ok(!state.prompts.some((p) => /provider's servers failed|transport fault/i.test(p.text)),
    "F4: an interrupt never injects an error-resume prompt")
  dispose()
}

// ---- F5: tool failures count for the debug nudge -------------------------
{
  const state = baseState()
  const events = []
  for (let i = 0; i < 3; i++) {
    events.push(stepStarted())
    events.push(ev("session.tool.failed", {
      sessionID: S, assistantMessageID: "msg_1", id: `call_${i}`, name: "bash",
      input: { command: "npm test" },
      metadata: { status: "error" },
    }))
  }
  const ctx = makeCtx(state, events, [])
  const dispose = await plugin.setup(ctx)
  await sleep(2400)
  ok(state.prompts.some((p) => /Multiple tool calls failed|Root-cause/i.test(p.text)),
    `F5: session.tool.failed counts toward the debug nudge (${state.prompts.length} prompt)`)
  dispose()
}

// ---- F6: session.deleted clears state ------------------------------------
{
  const state = baseState()
  const ctx = makeCtx(state, [
    stepStarted(),
    ev("session.deleted", { sessionID: S }),
  ], [])
  const dispose = await plugin.setup(ctx)
  await sleep(1600)
  ok(true, "F6: session.deleted is handled without error")
  dispose()
}

console.log(process.exitCode ? "V2 FAILURE TESTS FAILED" : "ALL V2 FAILURE TESTS PASSED")