// Self-contained env tuning: fast delays + no notice throttling for assertions.
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0" // never hit the network in CI
// keep the stop-store out of the repo dir unless a suite overrides it;
// unique per run so a previous run's persisted stops can't poison this one
const defaultStops0 = join(tmpdir(), `ar-stop-default-${process.pid}-${Date.now()}.json`)
process.env.OPENCODE_RESUME_STOPSTORE ??= defaultStops0

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
    app: { log: async ({ body }) => { state.logs.push(body?.message ?? ""); return true } },
    config: { providers: async () => ({ data: { providers: [
      { id: "provA", models: { "a-max": {} } },
    ] } }) },
    session: {
      list: async () => ({ data: state.sessionList }),
      status: async () => {
        // Optional gate: hold the status probe open so a test can land a user
        // Stop while runPlan is suspended deciding whether to inject.
        if (state.statusGate) {
          state.statusGate.entered?.()
          await state.statusGate.promise
        }
        return { data: Object.fromEntries([...state.idleIds].map((id) => [id, { type: "idle" }])) }
      },
      prompt: async ({ path, body }) => {
        state.prompts.push({ id: path.id, text: body.parts[0].text, model: body.model })
        return { data: {} }
      },
      abort: async ({ path }) => { state.aborts.push(path.id); return true },
      summarize: async () => true,
      messages: async ({ path }) => {
        // Optional gate: hold this session's fetch open so a test can land a
        // concurrent event while evaluateIdle is suspended on the await.
        // `entered` resolves once the fetch is actually parked, so the test
        // can fire at the exact moment the caller is inside the await window.
        if (state.messageGate && state.messageGate.id === path.id) {
          state.messageGate.entered?.()
          await state.messageGate.promise
        }
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
    prompts: [], aborts: [], summarizes: [], logs: [], permResponses: [],
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
  ok(state.logs.some((t) => t.includes("Stopped by you")), "S1: stop acknowledged with a quiet-until-prompt notice")
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
  ok(state.logs.some((t) => t.includes("Stopped by you")), "S2: stop was acknowledged")
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
  ok(!state.prompts.some((p) => p.text.includes("todos unfinished")),
    "S3: todo-drive does NOT fire after a user Stop")
  // a REAL user prompt starts a new workflow -> automation armed again
  await hooks.event(ev("message.updated", { info: { role: "user", sessionID: "s3", id: "u1" } }))
  state.msgStore.u1 = "ok continue with the rest"
  await hooks.event(ev("session.idle", { sessionID: "s3" }))
  await sleep(350)
  ok(state.prompts.some((p) => p.text.includes("todos unfinished") && p.id === "s3"),
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
  ok(state.logs.some((t) => t.includes("Stopped by you")), "S4: quiet-mode engaged")
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
  ok(state.logs.filter((t) => t.includes("Stopped by you")).length === 1,
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
  ok(state.prompts.some((p) => p.id === "s8" && p.text.includes("Auto-resume")),
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
  ok(state.prompts.some((p) => p.id === "s9" && p.text.includes("Auto-resume")),
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
  ok(!state.prompts.some((p) => p.text.includes("todos unfinished")),
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
  process.env.OPENCODE_RESUME_STOPSTORE = defaultStops0
}

// ---- S12: restart-time aborts are interruptions, not user stops --------------
{
  const now = Date.now()
  const state = makeState()
  state.sessionList = [
    { id: "sd", time: { updated: now - 2_000 } },      // graceful shutdown mid-turn
    { id: "hk", time: { updated: now - 2_500 } },      // hard kill, no error written
    { id: "done", time: { updated: now - 3_000 } },    // finished normally before restart
  ]
  state.messagesBySession.sd = [{
    info: { role: "assistant", error: { name: "MessageAbortedError", data: { message: "aborted" } },
            providerID: "provA", modelID: "a-max", time: { created: now - 5_000, completed: now - 4_000 } },
    parts: [],
  }]
  state.messagesBySession.hk = [{
    info: { role: "assistant", error: null, time: { created: now - 5_000 } },
    parts: [{ type: "text", text: "partial..." }],
  }]
  state.messagesBySession.done = [{
    info: { role: "assistant", error: null, time: { created: now - 9_000, completed: now - 8_000 } },
    parts: [{ type: "text", text: "All done." }],
  }]
  await AutoResumePlugin({ client: makeClient(state) })
  await sleep(2200)
  ok(state.prompts.some((p) => p.id === "sd"), "S12: shutdown-abort revived as an interruption")
  ok(!state.logs.some((t) => t.includes("Stopped by you")), "S12: shutdown-abort NOT misread as a stop")
  ok(state.prompts.some((p) => p.id === "hk"), "S12: hard-killed incomplete turn revived")
  ok(!state.prompts.some((p) => p.id === "done"), "S12: normally finished session left alone")
}

// ---- S13: silent thinking gets a fast, clearly-labelled automatic retry ------
{
  const dir = await mkdtemp(join(tmpdir(), "ar-think-"))
  process.env.OPENCODE_RESUME_THINK_STALL_MS = "150"
  process.env.OPENCODE_RESUME_WATCHDOG_MS = "40"
  const state = makeState()
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("session.status", { sessionID: "think", status: { type: "busy" } }))
  await sleep(300) // past the 150ms think-stall window
  ok(state.aborts.includes("think"), "S13: silent thinking aborted at the fast threshold")
  // Wait for the takeover chain to run its course. Each stall takeover re-arms
  // the next one on a 1500ms + 800ms delay, and OPENCODE_RESUME_MAX_STALL_TAKEOVERS
  // now defaults to 4 (it was a hard 2 before), so the labelled retry prompt is
  // injected on the LAST hop of that chain -- ~2.3s later than under the old cap.
  // The 2500ms this used to wait was inside that window and only passed by luck.
  await sleep(9000)
  ok(state.prompts.some((p) => p.id === "think" && p.text.includes("Auto-retry")),
    "S13: retry prompt is explicitly labelled")
  ok(state.logs.some((t) => t.includes("automatic retry")), "S13: notice says 'automatic retry'")
  // OPENCODE_RESUME_MAX_STALL_TAKEOVERS replaced the old hard-coded cap of 2
  // (balanced preset = 4). Pin it: the chain must reach the configured ceiling
  // and stop there, never overshoot.
  const stallAborts = state.aborts.filter((id) => id === "think").length
  ok(stallAborts === 4, `S13: stall takeovers capped at maxStallTakeovers (${stallAborts}, expected 4)`)
  // A deep retry (#4) must switch to the terse prompt — a model stuck in a retry
  // loop re-emits a recap when the nudge keeps growing.
  ok(state.prompts.some((p) => p.id === "think" && p.text.includes("(short)")),
    "S13: deep retries get the terse prompt")
  // Regression guard: the stall-retry chain must NEVER be escalated to the
  // "debug" (change-approach) prompt. Once maxStallTakeovers is reached, chain
  // and stallResumes are frozen at the cap, so the anti-redundant-repeat
  // heuristic sees "chain unchanged" and would otherwise treat the watchdog's
  // own re-ticks as a model loop -- rewriting the plan to a tool-failure prompt
  // and never delivering the retry. The watchdog re-arms 4x on a 1500+800ms
  // delay, so with a long enough wait the escalation DOES fire and the retry
  // text disappears; this assertion is what catches it.
  ok(state.prompts.every((p) => p.id !== "think" || !p.text.includes("Multiple tool calls failed")),
    "S13: stall retries are never escalated to the debug (tool-failure) prompt")
  // tool activity keeps its grace: no fast abort for quiet-but-running tools
  await hooks.event(ev("session.status", { sessionID: "toolx", status: { type: "busy" } }))
  await hooks.event(ev("message.part.updated", { part: { type: "tool", sessionID: "toolx", state: { status: "running" }, tool: "bash" } }))
  await sleep(400)
  ok(!state.aborts.includes("toolx"), "S13: running tools keep their extended grace")
  await rm(dir, { recursive: true, force: true })
  ;["OPENCODE_RESUME_THINK_STALL_MS", "OPENCODE_RESUME_WATCHDOG_MS"].forEach((k) => delete process.env[k])
}

// ---- S14: race condition — session.idle fires BEFORE session.error (abort) -----
// Regression guard for the post-await suppression re-check in evaluateIdle().
//
// OpenCode can deliver session.idle before the session.error that carries the
// user's Stop. evaluateIdle() is detached, so it is suspended on
// `await client.session.messages(...)` while handleError() calls
// markUserStopped(). Without the re-check, evaluation continues on a session the
// user just stopped: it burns the nudge budget, latches emptyStreak, and logs a
// misleading "empty response detected" line.
//
// The gate holds the fetch open so the Stop provably lands INSIDE the await
// window -- without it the fetch resolves before the error is even dispatched
// and the test passes no matter what the code does.
{
  const state = makeState()
  // A resume must already have happened for the empty-nudge path to engage
  // (it is gated on s.lastResumeAt), so make the session relevant up front.
  state.messagesBySession.s14 = [{
    info: { role: "assistant", error: null },
    parts: [{ type: "text", text: "some output" }],
  }]
  let release
  let entered
  const insideFetch = new Promise((r) => { entered = r })
  state.messageGate = { id: "s14", entered, promise: new Promise((r) => { release = r }) }
  const hooks = await AutoResumePlugin({ client: makeClient(state) })

  // Arm the session: a real assistant turn with text, then a resume so
  // lastResumeAt is set and the empty-nudge branch becomes reachable.
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "s14", text: "working" } }))
  await hooks.event(ev("session.error", { sessionID: "s14", error: { name: "APIError", data: { statusCode: 429, message: "slow down" } } }))
  await sleep(300)
  state.prompts.length = 0 // forget the recovery injection; only the race matters

  // The turn the user is aborting came back empty.
  state.messagesBySession.s14 = [{ info: { role: "assistant", error: null }, parts: [] }]

  // session.idle fires FIRST and parks inside the messages() fetch...
  await hooks.event(ev("session.idle", { sessionID: "s14" }))
  // ...wait until evaluation is genuinely suspended on that await, so the Stop
  // below provably lands inside the window rather than before it.
  await insideFetch
  // ...then the user's Stop lands while that fetch is still in flight.
  await hooks.event(ev("session.error", { sessionID: "s14", error: { name: "MessageAbortedError", data: { message: "aborted by user" } } }))
  ok(state.logs.some((t) => t.includes("Stopped by you")), "S14: stop acknowledged")
  release()
  await sleep(400)

  ok(state.prompts.length === 0, "S14: no empty nudge when idle fetch resumes after the abort")
  // The guard's real job: evaluation must ABORT, not merely fail to schedule.
  // Without it the stopped session still burns budget and latches state.
  ok(!state.logs.some((t) => t.includes("empty response detected")),
    "S14: aborted evaluation is abandoned (no empty-nudge bookkeeping on a stopped session)")
  // A real user prompt re-arms the session and the automation must work
  // normally again -- the guard must not permanently poison it. A new turn
  // that ends in an empty response should nudge again, proving the empty-nudge
  // path is reachable once the Stop is cleared.
  state.messagesBySession.s14 = [{ info: { role: "assistant", error: null }, parts: [{ type: "text", text: "ok, continuing" }] }]
  await hooks.event(ev("message.updated", { info: { role: "user", sessionID: "s14", id: "u-s14" } }))
  state.msgStore["u-s14"] = "carry on"
  await sleep(50)
  state.messagesBySession.s14 = [{ info: { role: "assistant", error: null }, parts: [] }]
  await hooks.event(ev("session.idle", { sessionID: "s14" }))
  await sleep(400)
  ok(state.prompts.some((p) => p.id === "s14" && p.text.includes("Previous reply came back empty")),
    "S14: a new user prompt re-arms automation and the empty-nudge path works again")
}

// ---- S15: user Stop landing WHILE the injection plan is in flight ------------
// The most consequential variant of the same class. runPlan() checks
// suppression, then awaits session.status() before deciding to inject. A Stop
// that lands inside that window used to be ignored and the "Auto-resume" prompt
// was dispatched anyway -- a real injection into a silenced session.
{
  const state = makeState()
  let release
  let entered
  const insideStatus = new Promise((r) => { entered = r })
  state.statusGate = { entered, promise: new Promise((r) => { release = r }) }
  const hooks = await AutoResumePlugin({ client: makeClient(state) })

  // A rate-limit failure schedules a recovery injection...
  await hooks.event(ev("session.error", { sessionID: "s15", error: { name: "APIError", data: { statusCode: 429, message: "slow down" } } }))
  // ...which is now parked inside runPlan's session.status() probe...
  await insideStatus
  // ...and the user hits Stop right in that window.
  await hooks.event(ev("session.error", { sessionID: "s15", error: { name: "MessageAbortedError", data: { message: "aborted by user" } } }))
  release()
  await sleep(500)

  ok(state.prompts.length === 0,
    "S15: no resume injected when Stop lands while the plan is mid-flight")
  ok(state.logs.some((t) => t.includes("while the plan was in flight")),
    "S15: in-flight plan is cancelled explicitly (auditable in the log)")
}

// ---- S16: the empty-nudge path keeps its own prompt under repeat pressure ----
// The anti-redundant-repeat heuristic in schedule() escalates a repeated plan
// kind to the "debug" (change-approach) prompt when the chain counter hasn't
// moved between two back-to-back schedules. That is the intended behaviour for
// a model stuck asking the same question, but it must not be able to hijack the
// empty-streak nudge into a tool-failure prompt — the two are unrelated failure
// modes, and the escalation rewrites plan.kind, so the swap is observable in
// the injected text.
{
  const state = makeState()
  // The empty-nudge path is gated on s.lastResumeAt, so the session needs a
  // recovery first -- mirror S14's setup: a prior 429 resume, then an empty
  // assistant turn on each idle.
  state.messagesBySession.s16 = [
    { info: { role: "assistant", error: null }, parts: [{ type: "text", text: "some output" }] },
  ]
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("session.error", { sessionID: "s16", error: { name: "APIError", data: { statusCode: 429, message: "slow down" } } }))
  await sleep(500)
  // Now the session is past a resume; feed genuinely empty assistant turns.
  // NOTE: hasContent tests for the *presence* of a text/tool/reasoning part,
  // not its length — a text part with "" still counts as content, so an
  // "empty" turn must have NO parts at all.
  state.idleIds.add("s16")
  state.messagesBySession.s16 = [
    { info: { role: "assistant", error: null }, parts: [] },
  ]
  for (let i = 0; i < 4; i += 1) {
    await hooks.event(ev("session.idle", { sessionID: "s16" }))
    await sleep(150)
  }
  await sleep(600)
  const injected = state.prompts.filter((p) => p.id === "s16")
  ok(injected.length > 0, "S16: empty-nudge path injected at least once")
  // Every injection on this path must be an empty-streak nudge. The
  // anti-redundant-repeat heuristic rewrites plan.kind to "debug" when a kind
  // repeats with an unmoved chain; if that ever captured the empty path the
  // model would be told to root-cause "multiple tool calls failed" when nothing
  // of the sort happened.
  ok(injected.every((p) => !p.text.includes("Multiple tool calls failed")),
    "S16: empty-nudge never escalated to the debug (tool-failure) prompt")
  // And the empty-streak latch must still latch: repeated empty responses are
  // counted, not spammed forever (emptyNudges is capped at 2 + one keep-going).
  const emptyNotices = state.logs.filter((t) => t.includes("empty response detected")).length
  ok(emptyNotices >= 1 && emptyNotices <= 2,
    `S16: empty nudges stay bounded (${emptyNotices} nudges)`)
}

console.log(process.exitCode ? "STOP TESTS FAILED" : "ALL STOP TESTS PASSED")
