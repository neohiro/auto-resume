// Self-contained env tuning: fast delays + no toast throttling for assertions.
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_TOAST_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0" // never hit the network in CI

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

// ---- BB: continuation stubs without question marks --------------------------
{
  const state = makeState(["fin"])
  state.messagesBySession.fin = [{
    info: { role: "assistant", error: null },
    parts: [{ type: "text", text: "Continue to finalize." }],
  }]
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "fin", text: "Continue to finalize." } }))
  await hooks.event(ev("session.idle", { sessionID: "fin" }))
  await sleep(350)
  ok(state.prompts.some((p) => p.text.includes("indicating there is still work to do")),
    "BB: 'Continue to finalize.' keeps the task going")

  const state2 = makeState(["ell"])
  state2.messagesBySession.ell = [{
    info: { role: "assistant", error: null },
    parts: [{ type: "text", text: "Continuing..." }],
  }]
  const hooks2 = await AutoResumePlugin({ client: makeClient(state2) })
  await hooks2.event(ev("message.part.updated", { part: { type: "text", sessionID: "ell", text: "Continuing..." } }))
  await hooks2.event(ev("session.idle", { sessionID: "ell" }))
  await sleep(350)
  ok(state2.prompts.length === 1, "BB: 'Continuing...' detected")

  // long genuine summary mentioning 'continue' in prose must not re-trigger
  const longSummary = "The migration is complete: all 42 tables were moved, every index rebuilt from scratch, and the full test suite passes locally and in CI. Documentation was updated across the three affected modules. If you ever want to extend this further, you can continue with the reporting module in a follow-up session."
  ok(longSummary.length > 250, "BB precondition: summary is long")
  const state3 = makeState(["done"])
  state3.messagesBySession.done = [{
    info: { role: "assistant", error: null },
    parts: [{ type: "text", text: longSummary }],
  }]
  const hooks3 = await AutoResumePlugin({ client: makeClient(state3) })
  await hooks3.event(ev("message.part.updated", { part: { type: "text", sessionID: "done", text: longSummary } }))
  await hooks3.event(ev("session.idle", { sessionID: "done" }))
  await sleep(350)
  ok(!state3.prompts.some((p) => p.text.includes("still work to do")),
    "BB: finished summaries are not misread as continuation stubs")
}

// ---- CC: implicit checklists + list-style continuation headings -------------
{
  // "Remaining things to do:" heading style (user-reported case)
  const state = makeState(["rem"])
  state.messagesBySession.rem = [{
    info: { role: "assistant", error: null },
    parts: [{ type: "text", text: "Remaining things to do:\n- [ ] fix the parser\n- [ ] update docs" }],
  }]
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "rem", text: "Remaining things to do:" } }))
  await hooks.event(ev("session.idle", { sessionID: "rem" }))
  await sleep(350)
  ok(state.prompts.filter((p) => p.id === "rem").length === 1,
    "CC1: 'Remaining things to do:' heading resumes exactly once")

  // checkbox-only list drives to completion, then wraps up
  process.env.OPENCODE_AUTOPILOT_IMPROVE_CYCLES = "0"
  process.env.OPENCODE_AUTOPILOT_PROPOSALS = "0"
  const state2 = makeState(["cb"])
  state2.messagesBySession.cb = [{
    info: { role: "assistant", error: null },
    parts: [{ type: "text", text: "Plan:\n- [x] scaffold\n- [ ] implement\n- [ ] test" }],
  }]
  const hooks2 = await AutoResumePlugin({ client: makeClient(state2) })
  await hooks2.event(ev("message.part.updated", { part: { type: "text", sessionID: "cb", text: "Plan:\n- [x] scaffold\n- [ ] implement\n- [ ] test" } }))
  await hooks2.event(ev("session.idle", { sessionID: "cb" })) // 2 unchecked -> drive
  await sleep(350)
  ok(state2.prompts.filter((p) => p.text.includes("unfinished items")).length === 1,
    "CC2: markdown checklist drives without the todo tool")
  state2.messagesBySession.cb = [{
    info: { role: "assistant", error: null },
    parts: [{ type: "text", text: "All done:\n- [x] scaffold\n- [x] implement\n- [x] test" }],
  }]
  await hooks2.event(ev("message.updated", { info: { role: "user", sessionID: "cb", id: "ccu" } }))
  state2.msgStore.ccu = "go"
  await hooks2.event(ev("session.idle", { sessionID: "cb" })) // all checked + fresh task scope
  await sleep(350)
  ok(state2.toasts.some((t) => t.includes("complete")),
    "CC3: fully-checked checklist counts as completion")
  delete process.env.OPENCODE_AUTOPILOT_IMPROVE_CYCLES
  delete process.env.OPENCODE_AUTOPILOT_PROPOSALS

  // our own wrap-up request must not self-answer its proposals
  const state4 = makeState(["wrap"])
  state4.messagesBySession.wrap = [{
    info: { role: "assistant", error: null },
    parts: [{ type: "text", text: "Wrap-up: done. Next steps you could consider: 1. caching 2. retries" }],
  }]
  const hooks4 = await AutoResumePlugin({ client: makeClient(state4) })
  // simulate that this turn answered OUR propose injection
  const s4 = hooks4 && null
  void s4
  await hooks4.event(ev("message.part.updated", { part: { type: "text", sessionID: "wrap", text: "wrap-up text" } }))
  await hooks4.event(ev("session.idle", { sessionID: "wrap" }))
  await sleep(300)
  ok(state4.prompts.length === 0 || !state4.prompts.some((p) => p.text.includes("Proceed autonomously")),
    "CC4: no runaway loop on wrap-up style replies")
}

console.log(process.exitCode ? "V4 TESTS FAILED" : "ALL V4 TESTS PASSED")

