// Self-contained env tuning: fast delays + no toast throttling for assertions.
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_TOAST_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0" // never hit the network in CI
// keep the stop-store out of the repo dir unless a suite overrides it
process.env.OPENCODE_RESUME_STOPSTORE ??= join(tmpdir(), "ar-stop-default.json")

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
      { id: "provA", models: { "a-max": {} } },
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
      messages: async ({ path }) => {
        const entries = structuredClone(state.messagesBySession[path.id] ?? [
          { info: { role: "assistant", error: null }, parts: [{ type: "text", text: "ok" }] },
        ])
        if (entries.length) entries[entries.length - 1].info.id = `m${++state.msgN}`
        return { data: entries }
      },
      message: async ({ path }) => ({ data: { parts: [{ type: "text", text: state.msgStore[path.messageID] ?? "" }] } }),
    },
  }
}

function makeState(idle = []) {
  return {
    prompts: [], aborts: [], summarizes: [], toasts: [], permResponses: [],
    idleIds: new Set(idle), msgStore: {}, msgN: 0, sessionList: [], messagesBySession: {},
  }
}
const ev = (type, properties) => ({ event: { type, properties } })

// ---- S1: Stop button (session.error abort) silences everything ---------------
{
  const state = makeState()
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "s1", text: "working..." } }))
  await hooks.event(ev("session.error", { sessionID: "s1", error: { name: "MessageAbortedError", data: { message: "aborted by user" } } }))
  await hooks.event(ev("session.idle", { sessionID: "s1" }))
  await sleep(400)
  ok(state.prompts.length === 0, "S1: no resume/nudge after a user Stop")
  ok(state.toasts.some((t) => t.includes("Stopped by you")), "S1: stop acknowledged with a quiet-until-prompt toast")
}

// ---- S2: an already-scheduled retry is cancelled by the Stop -----------------
{
  const state = makeState()
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  // rate-limit error schedules a resume ~40ms out...
  await hooks.event(ev("session.error", { sessionID: "s2", error: { name: "APIError", data: { statusCode: 429, message: "slow down" } } }))
  // ...user hits Stop before it fires
  await hooks.event(ev("session.error", { sessionID: "s2", error: { name: "MessageAbortedError", data: { message: "aborted by user" } } }))
  await sleep(500)
  ok(state.prompts.length === 0, "S2: queued recovery injection cancelled by Stop")
  ok(state.toasts.some((t) => t.includes("Stopped by you")), "S2: stop was acknowledged")
}

// ---- S3: idle evaluation stays silent after Stop, next real prompt re-arms ---
{
  const state = makeState()
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "s3", text: "step 1 done" } }))
  await hooks.event(ev("todo.updated", { sessionID: "s3", todos: [{ title: "remaining", status: "pending" }] }))
  await hooks.event(ev("session.error", { sessionID: "s3", error: { name: "MessageAbortedError", data: { message: "aborted by user" } } }))
  await hooks.event(ev("session.idle", { sessionID: "s3" })) // unfinished todos, but stopped
  await sleep(350)
  ok(!state.prompts.some((p) => p.text.includes("unfinished items")),
    "S3: todo-drive does NOT fire after a user Stop")
  // a REAL user prompt starts a new workflow -> automation armed again
  await hooks.event(ev("message.updated", { info: { role: "user", sessionID: "s3", id: "u1" } }))
  state.msgStore.u1 = "ok continue with the rest"
  await hooks.event(ev("session.idle", { sessionID: "s3" }))
  await sleep(350)
  ok(state.prompts.some((p) => p.text.includes("unfinished items") && p.id === "s3"),
    "S3: new user prompt re-enables todo-drive")
}

// ---- S4: abort surfaced ONLY on the stored assistant message is caught -------
{
  const state = makeState()
  state.messagesBySession.s4 = [{
    info: { role: "assistant", error: { name: "MessageAbortedError", data: { message: "aborted" } } },
    parts: [{ type: "text", text: "partial progress..." }],
  }]
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "s4", text: "partial progress..." } }))
  await hooks.event(ev("session.idle", { sessionID: "s4" })) // no session.error event at all
  await sleep(350)
  ok(state.prompts.length === 0, "S4: message-only abort still detected at idle")
  ok(state.toasts.some((t) => t.includes("Stopped by you")), "S4: quiet-mode engaged")
  await hooks.event(ev("session.idle", { sessionID: "s4" }))
  await sleep(250)
  ok(state.prompts.length === 0, "S4: stays quiet on subsequent idles")
}

// ---- S5: duplicate abort events produce exactly one notice -------------------
{
  const state = makeState()
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  const abort = ev("session.error", { sessionID: "s5", error: { name: "MessageAbortedError", data: { message: "aborted by user" } } })
  await hooks.event(abort)
  await hooks.event(abort)
  await sleep(200)
  ok(state.toasts.filter((t) => t.includes("Stopped by you")).length === 1,
    "S5: repeated abort events do not spam")
}

// ---- S6: stall watchdog never takes over a stopped session -------------------
{
  process.env.OPENCODE_RESUME_STALL_TIMEOUT_MS = "100"
  process.env.OPENCODE_RESUME_WATCHDOG_MS = "40"
  const state = makeState()
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("session.status", { sessionID: "s6", status: { type: "busy" } }))
  await hooks.event(ev("session.error", { sessionID: "s6", error: { name: "MessageAbortedError", data: { message: "aborted by user" } } }))
  await sleep(400) // well past the 100ms stall timeout
  ok(!state.aborts.includes("s6"), "S6: watchdog leaves stopped sessions alone")
  ;["OPENCODE_RESUME_STALL_TIMEOUT_MS", "OPENCODE_RESUME_WATCHDOG_MS"]
    .forEach((k) => delete process.env[k])
}

// ---- S7: permissions stay human-decided after a Stop -------------------------
{
  const state = makeState()
  const client = makeClient(state)
  client.session.postSessionByIdPermissionsByPermissionId =
    async ({ path, body }) => { state.permResponses.push({ id: path.permissionID, response: body.response }); return true }
  const hooks = await AutoResumePlugin({ client })
  await hooks.event(ev("session.error", { sessionID: "s7", error: { name: "MessageAbortedError", data: { message: "aborted by user" } } }))
  await hooks.event(ev("permission.updated", { sessionID: "s7", id: "perm-1", type: "bash", title: "ls" }))
  await sleep(200)
  ok(state.permResponses.length === 0, "S7: autopilot does not answer permissions after Stop")
}

// ---- S8: a new user prompt re-arms full recovery ------------------------------
{
  const state = makeState()
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("session.error", { sessionID: "s8", error: { name: "MessageAbortedError", data: { message: "aborted by user" } } }))
  await sleep(200)
  ok(state.prompts.length === 0, "S8 precondition: quiet after Stop")
  await hooks.event(ev("message.updated", { info: { role: "user", sessionID: "s8", id: "u8" } }))
  state.msgStore.u8 = "try again"
  // infra failure on the NEW task -> automatic recovery must work again
  await hooks.event(ev("session.error", { sessionID: "s8", error: { name: "APIError", data: { statusCode: 503, message: "service unavailable" } } }))
  await sleep(600)
  ok(state.prompts.some((p) => p.id === "s8" && p.text.includes("transient infrastructure error")),
    "S8: recovery re-armed by a new user prompt")
}

// ---- S9: the plugin's OWN takeover abort is not a user stop -------------------
{
  process.env.OPENCODE_RESUME_STALL_TIMEOUT_MS = "100"
  process.env.OPENCODE_RESUME_WATCHDOG_MS = "40"
  const state = makeState()
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("session.status", { sessionID: "s9", status: { type: "busy" } }))
  await sleep(300) // watchdog detects the stall -> takeover aborts + schedules resume
  ok(state.aborts.includes("s9"), "S9: takeover aborts a stalled stream")
  // that abort surfaces as MessageAbortedError + idle...
  await hooks.event(ev("session.error", { sessionID: "s9", error: { name: "MessageAbortedError", data: { message: "aborted" } } }))
  await hooks.event(ev("session.idle", { sessionID: "s9" }))
  // ...but the takeover's own scheduled resume must still fire
  await sleep(3200)
  ok(state.prompts.some((p) => p.id === "s9" && p.text.includes("transient infrastructure error")),
    "S9: takeover-induced abort is NOT mistaken for a user stop")
  ;["OPENCODE_RESUME_STALL_TIMEOUT_MS", "OPENCODE_RESUME_WATCHDOG_MS"]
    .forEach((k) => delete process.env[k])
}

// ---- S10: our OWN injected prompt must not read as a new user prompt ---------
// (limited case: an injection dispatched just before the Stop lands after it)
{
  const state = makeState()
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("todo.updated", { sessionID: "s10", todos: [{ title: "t", status: "pending" }] }))
  await hooks.event(ev("session.error", { sessionID: "s10", error: { name: "MessageAbortedError", data: { message: "aborted by user" } } }))
  // the handler fetches the message text DURING dispatch — register it first
  state.msgStore.own1 = "[auto-resume] Continue working through them autonomously now, one by one."
  await hooks.event(ev("message.updated", { info: { role: "user", sessionID: "s10", id: "own1" } }))
  await hooks.event(ev("session.idle", { sessionID: "s10" })) // todos pending, but stop stands
  await sleep(350)
  ok(!state.prompts.some((p) => p.text.includes("unfinished items")),
    "S10: own injected prompt does NOT clear a user stop")
}

// ---- S11: stops persist across a restart; stopped sessions never auto-start --
{
  const dir = await mkdtemp(join(tmpdir(), "ar-stop-"))
  process.env.OPENCODE_RESUME_STOPSTORE = join(dir, "stops.json")
  // run #1: the user stops the task
  const hooksA = await AutoResumePlugin({ client: makeClient(makeState()) })
  await hooksA.event(ev("session.error", { sessionID: "p1", error: { name: "MessageAbortedError", data: { message: "aborted by user" } } }))
  await sleep(150) // let the store flush to disk
  const savedRaw = JSON.parse(await readFile(process.env.OPENCODE_RESUME_STOPSTORE, "utf8"))
  ok(savedRaw.p1 > 0, "S11: stop marker flushed to disk")
  // run #2: OpenCode restarted — fresh plugin state, store reloaded from disk
  const stateB = makeState()
  stateB.sessionList = [{ id: "p1", time: { updated: Date.now() - 1_000 } }]
  stateB.messagesBySession.p1 = [{ info: { role: "user", sessionID: "p1" }, parts: [] }] // unanswered-prompt bait
  const hooksB = await AutoResumePlugin({ client: makeClient(stateB) })
  await sleep(2200)
  ok(!stateB.prompts.some((p) => p.id === "p1"),
    "S11: restarted run does not auto-start a stopped session")
  await hooksB.event(ev("todo.updated", { sessionID: "p1", todos: [{ title: "x", status: "pending" }] }))
  await hooksB.event(ev("session.idle", { sessionID: "p1" }))
  await sleep(300)
  ok(!stateB.prompts.some((p) => p.id === "p1"),
    "S11: persisted stop keeps automation quiet after restart")
  // stray infra failures on a stopped session must not resurrect anything
  await hooksB.event(ev("session.error", { sessionID: "p1", error: { name: "APIError", data: { statusCode: 503, message: "service unavailable" } } }))
  await sleep(300)
  ok(!stateB.prompts.some((p) => p.id === "p1"),
    "S11: errors on a persisted-stopped session stay ignored")
  // only the user's next real prompt lifts the stop — on disk too
  await hooksB.event(ev("message.updated", { info: { role: "user", sessionID: "p1", id: "up1" } }))
  stateB.msgStore.up1 = "alright, go"
  await sleep(200)
  const raw = JSON.parse(await readFile(process.env.OPENCODE_RESUME_STOPSTORE, "utf8"))
  ok(!raw.p1, "S11: cleared stop removed from the persistent store")
  await rm(dir, { recursive: true, force: true })
  // keep a valid store path for any later suites
  process.env.OPENCODE_RESUME_STOPSTORE = join(tmpdir(), "ar-stop-after-s11.json")
}

console.log(process.exitCode ? "STOP TESTS FAILED" : "ALL STOP TESTS PASSED")
