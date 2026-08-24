// Self-contained env tuning: fast delays + no toast throttling for assertions.
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_TOAST_THROTTLE_MS ??= "0"

import { AutoResumePlugin } from "../auto-resume.js"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeClient(state) {
  return {
    app: { log: async () => true },
    tui: { showToast: async ({ body }) => { state.toasts.push(body.message); return true } },
    config: { providers: async () => ({ data: { providers: [
      { id: "provA", models: { "a-max": {}, "a-mini": {} } },
      { id: "provB", models: { "b-pro": {} } },
    ] } }) },
    session: {
      list: async () => ({ data: state.sessionList }),
      status: async () => ({ data: Object.fromEntries([...state.idleIds].map((id) => [id, { type: "idle" }])) }),
      prompt: async ({ path, body }) => {
        state.prompts.push({ id: path.id, text: body.parts[0].text, model: body.model })
        return { data: {} }
      },
      abort: async ({ path }) => { state.aborts.push(path.id); return true },
      summarize: async () => true,
      messages: async ({ path }) => ({
        data: state.messagesBySession[path.id] ??
          [{ info: { role: "assistant", error: null }, parts: [{ type: "text", text: "ok" }] }],
      }),
      message: async ({ path }) => ({ data: { parts: [{ type: "text", text: state.msgStore[path.messageID] ?? "" }] } }),
    },
  }
}

function makeState(idle = []) {
  return {
    prompts: [], aborts: [], summarizes: [], toasts: [], permResponses: [],
    idleIds: new Set(idle), msgStore: {}, sessionList: [], messagesBySession: {},
  }
}
const fresh = (idle) => AutoResumePlugin({ client: makeClient(makeState(idle)) }).then((hooks) => hooks)
const ev = (type, properties) => ({ event: { type, properties } })

// ---- W: stuck internal-retry loop gets taken over ---------------------------
{
  process.env.OPENCODE_RESUME_RETRY_FUTURE_CAP_MS = "150"
  process.env.OPENCODE_RESUME_WATCHDOG_MS = "50"
  const state = makeState()
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  const farFuture = Date.now() + 20 * 60 * 1000
  await hooks.event(ev("session.status", { sessionID: "stuck", status: { type: "retry", attempt: 1, message: "overloaded", next: farFuture } }))
  await sleep(600)
  ok(state.aborts.includes("stuck"), "W: stuck retry loop aborted")
  await sleep(3000)
  ok(state.prompts.some((p) => p.id === "stuck"), "W: takeover resumed the task")
  delete process.env.OPENCODE_RESUME_RETRY_FUTURE_CAP_MS
  delete process.env.OPENCODE_RESUME_WATCHDOG_MS
}

// ---- X: crash re-animation on startup ----------------------------------------
{
  const now = Date.now()
  const state = makeState()
  state.sessionList = [
    { id: "recent-crash", time: { updated: now - 2_000 } },
    { id: "old-crash", time: { updated: now - 3_600_000 } },
    { id: "child-session", parentID: "parent-1", time: { updated: now - 1_000 } },
  ]
  state.messagesBySession["recent-crash"] = [{
    info: { role: "assistant", error: { name: "APIError", data: { statusCode: 502, message: "bad gateway" } }, providerID: "provB", modelID: "b-pro" },
    parts: [],
  }]
  state.messagesBySession["old-crash"] = [
    { info: { role: "assistant", error: { name: "APIError", data: { statusCode: 500, message: "boom" } } }, parts: [] },
  ]
  state.messagesBySession["child-session"] = [
    { info: { role: "user", sessionID: "child-session" }, parts: [] },
  ]
  await AutoResumePlugin({ client: makeClient(state) }) // init runs the scan
  await sleep(2200)
  ok(state.prompts.some((p) => p.id === "recent-crash" && p.model?.modelID === "b-pro"),
    "X: recently crashed session revived with its model")
  ok(!state.prompts.some((p) => p.id === "old-crash"), "X: stale session left alone")
  ok(!state.prompts.some((p) => p.id === "child-session"), "X: subagent sessions never revived")
  // unanswered prompt variant
  const st2 = makeState()
  st2.sessionList = [{ id: "unanswered", time: { updated: now - 3_000 } }]
  st2.messagesBySession.unanswered = [{ info: { role: "user", sessionID: "unanswered" }, parts: [] }]
  await AutoResumePlugin({ client: makeClient(st2) })
  await sleep(2200)
  ok(st2.prompts.some((p) => p.id === "unanswered"), "X2: prompt that never got a reply is re-sent")
}

// ---- Y: auto-proceed when the agent ends by asking a question ----------------
{
  process.env.OPENCODE_AUTOPILOT_MAX_PROCEEDS = "1"
  const state = makeState(["ask"])
  state.messagesBySession.ask = [{
    info: { role: "assistant", error: null },
    parts: [{ type: "text", text: "I found two approaches. Should I proceed with the database migration?" }],
  }]
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  // simulate the turn that produced the question
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "ask", text: "Should I proceed with the migration?" } }))
  await hooks.event(ev("session.idle", { sessionID: "ask" }))
  await sleep(350)
  ok(state.prompts.some((p) => p.text.includes("Proceed autonomously with exactly what you just proposed")),
    "Y: agent's own question auto-answered")
  await hooks.event(ev("session.idle", { sessionID: "ask" }))
  await sleep(250)
  ok(state.prompts.filter((p) => p.text.includes("Proceed autonomously")).length === 1,
    "Y: proceeds capped per task")
  // a statement ending without any question marker must NOT trigger proceed
  const state2 = makeState(["stmt"])
  state2.messagesBySession.stmt = [{
    info: { role: "assistant", error: null },
    parts: [{ type: "text", text: "All done. The build passes and tests are green." }],
  }]
  const hooks2 = await AutoResumePlugin({ client: makeClient(state2) })
  await hooks2.event(ev("message.part.updated", { part: { type: "text", sessionID: "stmt", text: "All done." } }))
  await hooks2.event(ev("session.idle", { sessionID: "stmt" }))
  await sleep(300)
  ok(state2.prompts.length === 0, "Y2: plain statements are left alone")
  delete process.env.OPENCODE_AUTOPILOT_MAX_PROCEEDS
}

// ---- Z: running tools get extended stall grace --------------------------------
{
  process.env.OPENCODE_RESUME_STALL_TIMEOUT_MS = "120"
  process.env.OPENCODE_RESUME_RUNNING_TOOL_FACTOR = "4"
  process.env.OPENCODE_RESUME_WATCHDOG_MS = "40"
  const state = makeState()
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("session.status", { sessionID: "build", status: { type: "busy" } }))
  await hooks.event(ev("message.part.updated", { part: { type: "tool", sessionID: "build", state: { status: "running" }, tool: "bash" } }))
  await sleep(260) // past base 120ms silence, inside 480ms grace window
  ok(!state.aborts.includes("build"), "Z: quiet-but-running tool NOT killed at base timeout")
  await sleep(400) // total > grace window
  ok(state.aborts.includes("build"), "Z: hung tool still taken over after grace window")
  ;["OPENCODE_RESUME_STALL_TIMEOUT_MS", "OPENCODE_RESUME_RUNNING_TOOL_FACTOR", "OPENCODE_RESUME_WATCHDOG_MS"]
    .forEach((k) => delete process.env[k])
}

// ---- AA: subagent errors are never injected into ------------------------------
{
  const state = makeState()
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("session.created", { info: { id: "kid", parentID: "root-1" } }))
  await hooks.event(ev("session.error", { sessionID: "kid", error: { name: "APIError", data: { statusCode: 503, message: "down" } } }))
  await sleep(300)
  ok(state.prompts.length === 0, "AA: subagent failure left to parent orchestrator")
}

console.log(process.exitCode ? "V4 TESTS FAILED" : "ALL V4 TESTS PASSED")

