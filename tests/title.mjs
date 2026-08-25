// Self-contained env tuning: fast delays + no toast throttling for assertions.
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_TOAST_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0" // never hit the network in CI
process.env.OPENCODE_RESUME_STOPSTORE = join(tmpdir(), "ar-title-stops.json")
process.env.OPENCODE_RESUME_OFFSTORE = join(tmpdir(), "ar-title-off.json")

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
    config: { providers: async () => ({ data: { providers: [{ id: "provA", models: { "a-max": {} } }] } }) },
    session: {
      list: async () => ({
        data: state.sessionList.map((id) => ({ id, title: state.baseTitles[id] ?? state.titles[id] ?? "" })),
      }),
      get: async ({ path }) => ({
        data: { id: path.id, title: state.titles[path.id] ?? state.baseTitles[path.id] ?? "" },
      }),
      update: async ({ path, body }) => {
        state.updates.push({ id: path.id, title: body.title })
        if (typeof body.title === "string") state.titles[path.id] = body.title
        return { data: { id: path.id, title: body.title } }
      },
      status: async () => ({ data: Object.fromEntries([...state.idleIds].map((id) => [id, { type: "idle" }])) }),
      prompt: async ({ path, body }) => {
        state.prompts.push({ id: path.id, text: body.parts[0].text })
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
    prompts: [], aborts: [], toasts: [], updates: [],
    idleIds: new Set(idle), msgStore: {}, msgN: 0,
    sessionList: [], messagesBySession: {},
    baseTitles: {}, titles: {},
  }
}
const ev = (type, properties) => ({ event: { type, properties } })

// ---- T1: engaged sessions get "[auto-resume: 🟢 armed]" behind the title -----
{
  const state = makeState()
  state.baseTitles.t1 = "Fix the parser bug"
  state.messagesBySession.t1 = [{
    info: { role: "assistant", error: null },
    parts: [{ type: "text", text: "Plan:\n- [x] scaffold\n- [ ] implement" }],
  }]
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "t1", text: "Plan:" } }))
  await hooks.event(ev("session.idle", { sessionID: "t1" })) // open checkbox -> drive
  await sleep(600)
  ok(state.titles.t1 === "Fix the parser bug [auto-resume: 🟢 armed]",
    "T1: armed tag appended after the original title")
}

// ---- T2: user Stop flips the tag to ⏸️ stopped -------------------------------
{
  const state = makeState()
  state.baseTitles.t2 = "Migrate database"
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("message.updated", { info: { role: "user", sessionID: "t2", id: "u2" } }))
  state.msgStore.u2 = "start the migration"
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "t2", text: "working..." } }))
  await hooks.event(ev("session.error", { sessionID: "t2", error: { name: "MessageAbortedError", data: { message: "aborted by user" } } }))
  await hooks.event(ev("session.idle", { sessionID: "t2" }))
  await sleep(600)
  ok(state.titles.t2 === "Migrate database [auto-resume: ⏸️ stopped]",
    "T2: stop switches the indicator to ⏸️ stopped")
}

// ---- T3: "auto-resume off" restores the pristine title and silences all ------
{
  const state = makeState()
  state.baseTitles.t3 = "Refactor auth flow"
  state.messagesBySession.t3 = [{
    info: { role: "assistant", error: null },
    parts: [{ type: "text", text: "Plan:\n- [ ] work" }],
  }]
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "t3", text: "Plan:" } }))
  await hooks.event(ev("session.idle", { sessionID: "t3" })) // attaches 🟢 + drives
  await sleep(500)
  ok(String(state.titles.t3 ?? "").includes("[auto-resume: 🟢 armed]"),
    "T3 precondition: tag was attached")
  // turn it OFF via in-chat command (register text BEFORE dispatch)
  state.msgStore.off1 = "auto-resume off"
  await hooks.event(ev("message.updated", { info: { role: "user", sessionID: "t3", id: "off1" } }))
  await sleep(600)
  ok(state.titles.t3 === "Refactor auth flow",
    "T3: title restored exactly, no trace of auto-resume")
  // nothing may fire anymore: errors, unfinished todos, idles
  const before = state.prompts.length
  await hooks.event(ev("todo.updated", { sessionID: "t3", todos: [{ title: "x", status: "pending" }] }))
  await hooks.event(ev("session.error", { sessionID: "t3", error: { name: "APIError", data: { statusCode: 503, message: "down" } } }))
  await hooks.event(ev("session.idle", { sessionID: "t3" }))
  await sleep(400)
  ok(state.prompts.length === before, "T3: fully silent while opted out")
  ok(!state.toasts.some((t) => t.includes("Stopped by you")), "T3: no stop-toast confusion")
  ok(state.toasts.some((t) => t.includes("Off for this session")), "T3: opt-out confirmed via toast")
}

// ---- T4: opt-out survives a restart; "auto-resume on" re-arms everything -----
{
  const dir = await mkdtemp(join(tmpdir(), "ar-title-"))
  process.env.OPENCODE_RESUME_OFFSTORE = join(dir, "off.json")
  // run #1: opt the session out
  const stateA = makeState()
  const hooksA = await AutoResumePlugin({ client: makeClient(stateA) })
  stateA.msgStore.o1 = "/auto-resume off"
  await hooksA.event(ev("message.updated", { info: { role: "user", sessionID: "p9", id: "o1" } }))
  await sleep(500)
  ok(stateA.toasts.some((t) => t.includes("Off for this session")), "T4: run #1 opted the session out")
  // run #2: OpenCode restarted — persisted opt-out must hold
  const stateB = makeState()
  stateB.sessionList = [{ id: "p9", time: { updated: Date.now() - 1_000 } }]
  stateB.baseTitles.p9 = "Build the importer"
  stateB.messagesBySession.p9 = [
    { info: { role: "user", sessionID: "p9" }, parts: [] }, // unanswered-prompt bait must NOT revive it
  ]
  const hooksB = await AutoResumePlugin({ client: makeClient(stateB) })
  await sleep(2200)
  ok(stateB.prompts.length === 0 && stateB.titles.p9 === undefined,
    "T4: restarted run keeps the session opted out and never touches it")
  await hooksB.event(ev("todo.updated", { sessionID: "p9", todos: [{ title: "x", status: "pending" }] }))
  await hooksB.event(ev("session.idle", { sessionID: "p9" }))
  await sleep(400)
  ok(!stateB.prompts.some((p) => p.id === "p9"), "T4: still silent while opted out")
  // re-enable via in-chat command
  stateB.msgStore.o2 = "auto-resume on"
  await hooksB.event(ev("message.updated", { info: { role: "user", sessionID: "p9", id: "o2" } }))
  await sleep(600)
  ok(stateB.titles.p9 === "Build the importer [auto-resume: 🟢 armed]",
    "T4: 'auto-resume on' re-arms and re-tags the title")
  await sleep(200)
  const offRaw = JSON.parse(await readFile(process.env.OPENCODE_RESUME_OFFSTORE, "utf8"))
  ok(!offRaw.p9, "T4: opt-out marker removed from persistent store")
  await rm(dir, { recursive: true, force: true })
  // keep a valid store path for any later suites
  process.env.OPENCODE_RESUME_OFFSTORE = join(tmpdir(), "ar-title-off.json")
}

// ---- T5: external rename is adopted and re-tagged ----------------------------
{
  process.env.OPENCODE_RESUME_OFFSTORE = join(tmpdir(), "ar-title-off.json")
  const state = makeState()
  state.baseTitles.t5 = "Initial task"
  state.messagesBySession.t5 = [{
    info: { role: "assistant", error: null },
    parts: [{ type: "text", text: "working" }],
  }]
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "t5", text: "working" } }))
  await hooks.event(ev("session.idle", { sessionID: "t5" }))
  await sleep(500)
  ok(String(state.titles.t5 ?? "").includes("[auto-resume:"), "T5 precondition: tag attached")
  // core renames the session (tag dropped by whoever renamed)
  await hooks.event(ev("session.updated", { info: { id: "t5", title: "Rename: parser work" } }))
  await sleep(500)
  ok(state.titles.t5 === "Rename: parser work [auto-resume: 🟢 armed]",
    "T5: external rename adopted, tag re-attached to the new base")
}

// ---- T6: stale tags on opted-out sessions are stripped after a restart -------
{
  const dir = await mkdtemp(join(tmpdir(), "ar-t6-"))
  process.env.OPENCODE_RESUME_OFFSTORE = join(dir, "off.json")
  // simulate an older run that opted t6 out but crashed before restoring the title
  const store = join(dir, "off.json")
  await writeFile(store, JSON.stringify({ t6: Date.now() }), "utf8")
  const state = makeState()
  state.baseTitles.t6 = "Old task [auto-resume: 🟢 armed]" // stale tag baked in
  state.sessionList = [{ id: "t6", time: { updated: Date.now() - 1_000 } }]
  state.messagesBySession.t6 = [{ info: { role: "user", sessionID: "t6" }, parts: [] }]
  await AutoResumePlugin({ client: makeClient(state) })
  await sleep(2200) // init load + zero-trace sweep
  ok(state.titles.t6 === "Old task", "T6: stale tag stripped on startup for opted-out session")
  ok(state.prompts.length === 0, "T6: sweep never revives the session")
  await rm(dir, { recursive: true, force: true })
  process.env.OPENCODE_RESUME_OFFSTORE = join(tmpdir(), "ar-title-off.json")
}

// ---- T7: 🔁 reflects ACTIVE recovery only, not historical errors -------------
{
  process.env.OPENCODE_RESUME_OFFSTORE = join(tmpdir(), "ar-title-off.json")
  const state = makeState()
  state.baseTitles.t7 = "Workflow fixes"
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "t7", text: "working" } }))
  await hooks.event(ev("session.idle", { sessionID: "t7" }))
  await sleep(450)
  ok(String(state.titles.t7 ?? "").includes("🟢 armed"), "T7 precondition: armed baseline")
  // transient error mid-task -> core enters its own retry loop -> actively
  // recovering (status stays "retry" while core works)
  await hooks.event(ev("session.error", { sessionID: "t7", error: { name: "APIError", data: { statusCode: 503, message: "unavailable" } } }))
  await hooks.event(ev("session.status", { sessionID: "t7", status: { type: "retry", attempt: 1, message: "unavailable", next: Date.now() + 5_000 } }))
  await sleep(500)
  ok(String(state.titles.t7 ?? "").includes("🔁 recovering"), "T7: active recovery shows 🔁")
  // clean successful turn afterwards -> back to 🟢 armed (not stuck on 🔁)
  state.messagesBySession.t7 = [{ info: { role: "assistant", error: null }, parts: [{ type: "text", text: "recovered fine" }] }]
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "t7", text: "recovered fine" } }))
  await hooks.event(ev("session.idle", { sessionID: "t7" }))
  await sleep(450)
  ok(String(state.titles.t7 ?? "").includes("🟢 armed"), "T7: clean turn returns tag to 🟢 armed")
}

console.log(process.exitCode ? "TITLE TESTS FAILED" : "ALL TITLE TESTS PASSED")
