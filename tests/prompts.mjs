// Prompt-routing tests.
//
// Every failure shape must reach a message that gives the model the *right*
// remedy. Collapsing distinct causes into one generic "a provider turn failed"
// message is the failure mode these guard against: the model then re-plans when
// it should resume, or retries verbatim when it must rephrase.
//
//   node tests/prompts.mjs
//
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0"
import { tmpdir } from "node:os"
import { join } from "node:path"

let seq = 0
process.env.OPENCODE_RESUME_STOPSTORE ??= join(tmpdir(), `ar-pr-stops-${process.pid}.json`)
process.env.OPENCODE_RESUME_OFFSTORE ??= join(tmpdir(), `ar-pr-off-${process.pid}.json`)

import { AutoResumePlugin } from "../auto-resume.js"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeClient(state) {
  return {
    app: { log: async ({ body }) => { state.logs.push(body?.message ?? ""); return true } },
    config: { providers: async () => ({ providers: [] }) },
    session: {
      status: async () => ({}),
      prompt: async ({ path, body }) => {
        state.prompts.push({ id: path.id, text: body.parts[0].text })
        return { data: {} }
      },
      abort: async () => { state.aborts += 1; return true },
      summarize: async () => true,
      update: async () => true,
      messages: async () => state.messages ?? [],
      message: async ({ path }) => ({ data: { parts: [{ type: "text", text: state.msgStore[path.messageID] ?? "" }] } }),
    },
  }
}

/** Drive one failure through the engine and return everything it injected.
 *  Each caller must use a unique sessionID: the engine keeps per-session state
 *  (chain budget, nudge cap) across instantiations within the same process, so
 *  reusing one id would silently consume the budget other blocks depend on. */
async function promptFor(error, sessionID) {
  const state = { prompts: [], logs: [], msgStore: {}, aborts: 0, messages: [] }
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event({ event: { type: "message.updated", properties: { info: { role: "user", sessionID, id: "u1" } } } })
  state.msgStore.u1 = "do the task"
  await hooks.event({ event: { type: "session.error", properties: { sessionID, error } } })
  await sleep(500)
  return { state, hooks, text: state.prompts.filter((p) => p.id === sessionID).map((p) => p.text).join("\n") }
}

// ---- P1: transport fault gets the transport-specific message ---------------
{
  const { text } = await promptFor({ name: "APIError", data: { message: "fetch failed: ECONNRESET", statusCode: 0 } }, "p1net")
  ok(/connection dropped mid-turn/i.test(text), "P1: transport fault uses the network-drop message")
  ok(/still in the transcript/i.test(text), "P1: transport message reminds the model its output survives")
  ok(!/provider's servers failed/i.test(text), "P1: transport fault is not mislabelled as a provider outage")
}

// ---- P2: provider 5xx gets the provider-specific message -------------------
{
  const { text } = await promptFor({ name: "APIError", data: { message: "internal server error", statusCode: 503 } }, "p2prov")
  ok(/provider's servers failed/i.test(text), "P2: 5xx uses the provider-down message")
  ok(/not at fault/i.test(text), "P2: provider-down message absolves the model's own request")
}

// ---- P3: rate limit names the wait window (V2 retry status) -----------------
{
  const state = { prompts: [], logs: [], msgStore: {}, aborts: 0, messages: [] }
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event({ event: { type: "message.updated", properties: { info: { role: "user", sessionID: "rl", id: "u1" } } } })
  state.msgStore.u1 = "go"
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "rl", status: { type: "retry", attempt: 2, message: "rate limited", action: { reason: "Rate limit reached", provider: "openrouter", title: "429" } } } } })
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "rl", error: { name: "APIError", data: { message: "429 too many requests", statusCode: 429, retryProvider: "openrouter", retryReason: "Rate limit reached", retryNext: Date.now() + 45_000, retryAttempt: 2 } } } } })
  await sleep(500)
  const text = state.prompts.filter((p) => p.id === "rl").map((p) => p.text).join("\n")
  ok(/rate limited/i.test(text), "P3: 429 uses the rate-limited message")
  ok(/openrouter/i.test(text), `P3: the provider name from V2 retry status is surfaced (got: ${/openrouter/i.test(text)})`)
  ok(/45s/i.test(text), `P3: the V2 retry window is rendered as a duration (got: ${/45s/i.test(text)})`)
  ok(/complete, verified increment/i.test(text), "P3: rate-limited message asks for a landed increment")
}

// ---- P4: quota exhaustion without rotation gets the budget message ---------
{
  const { text } = await promptFor({ name: "APIError", data: { message: "insufficient credits", statusCode: 402 } }, "p4quota")
  ok(/exhausted quota|no alternate model/i.test(text), "P4: exhausted quota gets the spend-it message")
  ok(/finish and verify what is already in flight/i.test(text), "P4: quota message directs effort to work in flight")
}

// ---- P5: an unattributable failure is NOT retried ---------------------------
// An unknown error with no network/quota/rate-limit signal is classified
// "fatal" and deliberately left alone. Injecting a generic resume here would
// hammer a request the provider has already refused for a reason we cannot
// name, so silence is the correct outcome — assert that rather than the
// fallback prompt.
{
  const state = { prompts: [], logs: [], msgStore: {}, aborts: 0, messages: [] }
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event({ event: { type: "message.updated", properties: { info: { role: "user", sessionID: "p5fat", id: "u1" } } } })
  state.msgStore.u1 = "go"
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "p5fat", error: { name: "SomeUnknownError", data: { message: "something odd happened" } } } } })
  await sleep(500)
  ok(state.prompts.filter((p) => p.id === "p5fat").length === 0,
    "P5: an unattributable failure is not blindly retried")
  ok(state.logs.some((l) => /Unrecoverable error/i.test(l)),
    "P5: the unrecoverable error is surfaced instead of silently retried")
}

// ---- P6: finish=content-filter drives the reframe message (V2-only) --------
// This is the case that cannot be handled without V2: the finish reason is a
// first-class field, not an error string. Retrying verbatim would be blocked
// again, so the message must change the framing rather than the work.
{
  const state = { prompts: [], logs: [], msgStore: {}, aborts: 0 }
  const client = makeClient(state)
  state.messages = [
    { info: { id: "a1", role: "assistant", error: null, finish: "content-filter", time: { completed: Date.now() } }, parts: [{ type: "text", text: "partial" }] },
  ]
  const hooks = await AutoResumePlugin({ client })
  await hooks.event({ event: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "cf", text: "partial" } } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "cf" } } })
  await sleep(500)
  const text = state.prompts.filter((p) => p.id === "cf").map((p) => p.text).join("\n")
  ok(/safety filter/i.test(text), `P6: content-filter finish reason drives its own message (got: ${/safety filter/i.test(text)})`)
  ok(/verbatim will be blocked again/i.test(text), "P6: content-filter message warns against a verbatim retry")
  ok(/reframe/i.test(text), "P6: content-filter message instructs reframing")
}

// ---- P7: a normal clean turn is NOT treated as content-filtered ------------
{
  const state = { prompts: [], logs: [], msgStore: {}, aborts: 0 }
  const client = makeClient(state)
  state.messages = [
    { info: { id: "a1", role: "assistant", error: null, finish: "stop", time: { completed: Date.now() } },
      parts: [{ type: "text", text: "A perfectly ordinary reply with plenty of characters to satisfy the improvement-pass threshold cleanly." }] },
  ]
  const hooks = await AutoResumePlugin({ client })
  await hooks.event({ event: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "ok", text: "ordinary reply" } } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ok" } } })
  await sleep(500)
  const text = state.prompts.filter((p) => p.id === "ok").map((p) => p.text).join("\n")
  ok(!/safety filter/i.test(text), "P7: a normal finish=stop turn is never routed to the content-filter message")
}

console.log(process.exitCode ? "PROMPT TESTS FAILED" : "ALL PROMPT TESTS PASSED")