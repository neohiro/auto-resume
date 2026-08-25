// Self-contained env tuning: fast delays + no notice throttling for assertions.
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0" // never hit the network in CI
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"

// Per-run isolated sidecar stores: never touch the real plugin directory and
// never leak state between runs (a persisted stop/opt-out would poison the
// next run's assertions).
process.env.OPENCODE_RESUME_STOPSTORE ??= join(tmpdir(), `ar-v2-stops-${process.pid}-${Date.now()}.json`)
process.env.OPENCODE_RESUME_OFFSTORE ??= join(tmpdir(), `ar-v2-off-${process.pid}-${Date.now()}.json`)

import { AutoResumePlugin } from "../auto-resume.js"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeClient(state) {
  return {
    app: { log: async ({ body }) => { state.logs.push(body?.message ?? ""); return true } },
    config: {
      providers: async () => ({
        data: {
          providers: [
            { id: "anthropic", models: { "claude-4-opus": {}, "claude-4-haiku": {} } },
            { id: "openai", models: { "gpt-5": {}, "text-embedding-3": {} } },
          ],
        },
      }),
    },
    session: {
      status: async () => ({ data: Object.fromEntries([...state.idleIds].map((id) => [id, { type: "idle" }])) }),
      prompt: async ({ path, body }) => {
        state.prompts.push({ id: path.id, text: body.parts[0].text, model: body.model })
        return { data: {} }
      },
      abort: async () => true,
      summarize: async ({ path }) => { state.summarizes.push(path.id); return true },
      messages: async () => ({
        data: [{
          info: { role: "assistant", error: null, providerID: "openai", modelID: "gpt-5", id: `m${++state.msgN}` },
          parts: [{ type: "text", text: "done" }],
        }],
      }),
      message: async ({ path }) => ({
        data: { parts: [{ type: "text", text: state.msgStore[path.messageID] ?? "" }] },
      }),
      postSessionByIdPermissionsByPermissionId: async ({ path, body }) => {
        state.permResponses.push({ sessionID: path.id, permissionID: path.permissionID, response: body.response })
        return { data: true }
      },
    },
  }
}

async function fresh(idle = []) {
  const state = {
    prompts: [], aborts: [], summarizes: [], logs: [], permResponses: [],
    idleIds: new Set(idle), msgStore: {}, msgN: 0,
  }
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  return { state, hooks }
}
const ev = (type, properties) => ({ event: { type, properties } })

// ---- L: quota/free-tier -> automatic model rotation ------------------------
{
  const { state, hooks } = await fresh(["qA", "qB"])
  await hooks.event(ev("message.updated", { info: { role: "assistant", sessionID: "qA", providerID: "anthropic", modelID: "claude-4-opus" } }))
  await hooks.event(ev("session.error", { sessionID: "qA", error: { name: "UnknownError", data: { message: "Free usage exceeded, subscribe to Go" } } }))
  await sleep(400)
  ok(state.prompts[0]?.id === "qA" && state.prompts[0]?.model?.modelID === "claude-4-haiku",
    `L: quota -> rotated to anthropic sibling (${JSON.stringify(state.prompts[0]?.model)})`)
  // exhaust the sibling too -> must skip cooled-down opus AND non-chat embedding model
  await hooks.event(ev("message.updated", { info: { role: "assistant", sessionID: "qB", providerID: "anthropic", modelID: "claude-4-haiku" } }))
  await hooks.event(ev("session.error", { sessionID: "qB", error: { name: "APIError", data: { statusCode: 402, message: "billing quota exceeded" } } }))
  await sleep(400)
  const second = state.prompts.find((x) => x.id === "qB")?.model
  ok(second?.providerID === "openai" && second?.modelID === "gpt-5",
    `L: cross-provider fallback honors cooldowns (${JSON.stringify(second)})`)
}

// ---- M: permission autopilot -------------------------------------------------
{
  const { state, hooks } = await fresh([])
  let pid = 0
  const ask = (type, title, metadata) =>
    hooks.event(ev("permission.updated", {
      id: `p${++pid}`, sessionID: "permSess", type, title, metadata: metadata ?? {},
    }))
  await ask("bash", "Run command", { command: "npm test" })
  await ask("bash", "Run command", { command: "rm -rf ./node_modules" })
  await ask("edit", "Edit file src/app.py")
  await ask("webfetch", "Fetch https://example.com")
  await ask("external_directory", "Access directory", { patterns: ["C:\\proj\\data\\*"] })
  await ask("external_directory", "Access directory", { patterns: ["C:\\Windows\\System32\\config\\*"] })
  await ask("external_directory", "Access directory", { patterns: ["/etc/nginx/sites-enabled/*"] })
  await ask("external_directory", "Access directory", { patterns: ["~/.ssh/id_ed25519", "/home/u/.aws/*"] })
  await ask("external_directory", "Access directory", { patterns: ["/Library/Keychains/"] })
  await ask("mystery_type", "Unknown thing")
  await sleep(300)
  const byPerm = Object.fromEntries(state.permResponses.map((r) => [r.permissionID, r.response]))
  ok(byPerm.p1 === "once", "M: safe bash approved")
  ok(byPerm.p2 === "reject", "M: dangerous bash rejected (agent unblocks)")
  ok(byPerm.p3 === "once", "M: edit approved")
  ok(byPerm.p4 === "once", "M: webfetch approved")
  ok(byPerm.p5 === "once", "M: external_directory approved so AFK runs proceed")
  ok(byPerm.p6 === "reject", "M: Windows system area grant denied")
  ok(byPerm.p7 === "reject", "M: Linux /etc grant denied")
  ok(byPerm.p8 === "reject", "M: dotfile credential dirs (.ssh/.aws) denied")
  ok(byPerm.p9 === "reject", "M: macOS keychain grant denied")
  ok(byPerm.p10 === undefined, "M: unknown type left for human in safe mode")
}

// ---- P2/P3: payload-shape matrix driven by tests/fixtures/permission-shapes.json
{
  const { state, hooks } = await fresh([])
  const shapes = JSON.parse(
    readFileSync(new URL("./fixtures/permission-shapes.json", import.meta.url), "utf8"),
  ).shapes
  const byName = {}
  for (const [i, s] of shapes.entries()) {
    const id = `sh${i}`
    const props = s.nested
      ? { sessionID: "shapeSess", permission: { ...s.ask, id } }
      : { ...s.ask, id, sessionID: "shapeSess" }
    await hooks.event(ev(s.event, props))
    byName[s.name] = { id, expect: s.expect }
  }
  await sleep(300)
  const got = Object.fromEntries(state.permResponses.map((r) => [r.permissionID, r.response]))
  for (const s of shapes) {
    const actual = got[byName[s.name].id] ?? null
    ok(actual === s.expect,
      `P2[${s.name}]: ${s.expect ?? "(human-decided)"} — ${s.docs}`)
  }
}
// ---- P5: benign directory asks escalate to "always" after N "once"s ---------
{
  process.env.OPENCODE_AUTOPILOT_DIR_ALWAYS_AFTER = "2"
  const { state, hooks } = await fresh([])
  const ask = (id, pattern) =>
    hooks.event(ev("permission.updated", {
      id, sessionID: "escSess",
      permission: "external_directory", title: "Access external directory",
      metadata: { pattern },
    }))
  await ask("e1", "~/projects/reference/**")
  await ask("e2", "~/projects/reference/**")
  await ask("e3", "~/projects/reference/**") // same boundary -> escalates
  await ask("e4", "~/other/tree/**")          // different boundary -> own counter
  await sleep(300)
  const byPerm = Object.fromEntries(state.permResponses.map((r) => [r.permissionID, r.response]))
  ok(byPerm.e1 === "once" && byPerm.e2 === "once", "P5: first two asks answered once")
  ok(byPerm.e3 === "always", "P5: third ask for the SAME boundary escalates to always")
  ok(byPerm.e4 === "once", "P5: different boundaries keep independent counters")
  delete process.env.OPENCODE_AUTOPILOT_DIR_ALWAYS_AFTER
}
// ---- P4: reply API fallback — first candidate rejecting must not strand ------
{
  const state = {
    prompts: [], aborts: [], summarizes: [], logs: [], permResponses: [],
    idleIds: new Set(), msgStore: {}, msgN: 0,
  }
  const client = makeClient(state)
  client.session.postSessionByIdPermissionsByPermissionId =
    async () => { throw new Error("route drifted") }
  client.session.respondToPermission =
    async ({ path, body }) => {
      state.permResponses.push({ permissionID: path.permissionID, response: body.response })
      return true
    }
  const hooks = await AutoResumePlugin({ client })
  await hooks.event(ev("permission.updated", {
    id: "fb1", sessionID: "permFb",
    permission: "external_directory", metadata: { patterns: ["E:\\data\\*"] },
  }))
  await sleep(250)
  ok(state.permResponses.some((r) => r.permissionID === "fb1" && r.response === "once"),
    "P4: falls through a broken primary SDK method to the next candidate")
}
{
  let asyncCalls = 0
  let syncCalls = 0
  const state = {
    prompts: [], aborts: [], summarizes: [], logs: [], permResponses: [],
    idleIds: new Set(), msgStore: {}, msgN: 0,
  }
  const client = makeClient(state)
  client.session.promptAsync = async ({ path }) => {
    asyncCalls += 1
    state.prompts.push({ id: path.id, text: "[auto-resume] async" })
    return true
  }
  client.session.prompt = async () => { syncCalls += 1; return true }
  const hooks = await AutoResumePlugin({ client })
  await hooks.event(ev("session.error", { sessionID: "asyn", error: { name: "APIError", data: { statusCode: 503, message: "down" } } }))
  await sleep(400)
  ok(asyncCalls === 1 && syncCalls === 0, "P2: fire-and-forget async dispatch preferred")
}

// ---- Q4: recovery self-cancels when the session already recovered ------------
{
  // widen the dispatch window so the test controls ordering deterministically
  process.env.OPENCODE_RESUME_BASE_DELAY_MS = "300"
  const { state, hooks } = await fresh(["qR"])
  await hooks.event(ev("session.error", { sessionID: "qR", error: { name: "APIError", data: { statusCode: 502, message: "bad gateway" } } }))
  // core recovers on its own and completes a clean turn BEFORE our timer fires
  await sleep(80)
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "qR", text: "done fine" } }))
  await hooks.event(ev("session.idle", { sessionID: "qR" }))
  await sleep(500) // past the 300ms dispatch moment
  ok(!state.prompts.some((p) => p.id === "qR"),
    "Q4: no spurious resume after the session already recovered")
  process.env.OPENCODE_RESUME_BASE_DELAY_MS = "30" // restore for later blocks
}

// ---- Q3: upstream/unavailable phrasing + AbortError are captured, with cause --
{
  const { state, hooks } = await fresh(["qE"])
  // real-world shape seen in logs: "Upstream request failed: Endpoint is unavailable."
  await hooks.event(ev("session.error", { sessionID: "qE", error: { name: "UnknownError", data: { message: "AI_APICallError: Upstream request failed: Endpoint is unavailable." } } }))
  await sleep(400)
  const resume = state.prompts.find((p) => p.id === "qE")
  ok(Boolean(resume) && resume.text.includes("transient infrastructure error"),
    "Q3: upstream-unavailable error triggers recovery")
  ok(Boolean(resume) && resume.text.includes("Endpoint is unavailable"),
    "Q3: injected prompt names the detected cause")
  // fetch-level aborts/timeouts (NOT user stops) retry too
  await hooks.event(ev("message.updated", { info: { role: "user", sessionID: "qE2", id: "x" } }))
  state.msgStore.x = "go"
  await hooks.event(ev("session.error", { sessionID: "qE2", error: { name: "AbortError", data: { message: "The operation was aborted" } } }))
  await sleep(400)
  ok(state.prompts.some((p) => p.id === "qE2"), "Q3: fetch-level AbortError retried")
}

// ---- Q2: quality passes (improve/propose) exempt from drive-nudge budget ------
{
  process.env.OPENCODE_AUTOPILOT_MAX_NUDGES = "1"
  const todosPending = [
    { id: "t1", status: "pending", content: "work", priority: "high" },
  ]
  const todosDone = [
    { id: "t1", status: "completed", content: "work", priority: "high" },
  ]
  const { state, hooks } = await fresh(["qS"])
  await hooks.event(ev("todo.updated", { sessionID: "qS", todos: todosPending }))
  await hooks.event(ev("session.idle", { sessionID: "qS" })) // consumes nudge #1 on a drive
  await sleep(350)
  ok(state.prompts.some((p) => p.text.includes("unfinished items")), "Q2: drive fired with budget")
  // budget now exhausted; another idle with pending todos -> one-time notice
  await hooks.event(ev("session.idle", { sessionID: "qS" }))
  await sleep(300)
  ok(state.logs.some((t) => t.includes("Drive-nudge budget") && t.includes("Self-improvement passes still run")),
    "Q2: budget exhaustion surfaced with a clear notice")
  // complete the todos -> improve MUST fire despite exhausted drive budget
  await hooks.event(ev("todo.updated", { sessionID: "qS", todos: todosDone }))
  await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "qS", text: "all done" } }))
  await hooks.event(ev("session.idle", { sessionID: "qS" }))
  await sleep(400)
  ok(state.prompts.some((p) => p.text.includes("Self-improvement pass 1/2")),
    "Q2: improvement pass fires despite exhausted drive budget")
  delete process.env.OPENCODE_AUTOPILOT_MAX_NUDGES
}

// ---- N: todo drive -> improvement passes -> wrap-up proposals ---------------
{
  const todosOpen = [
    { id: "t1", status: "completed", content: "a", priority: "high" },
    { id: "t2", status: "pending", content: "b", priority: "high" },
  ]
  const todosDone = [
    { id: "t1", status: "completed", content: "a", priority: "high" },
    { id: "t2", status: "completed", content: "b", priority: "high" },
  ]
  const { state, hooks } = await fresh(["td"])
  await hooks.event(ev("todo.updated", { sessionID: "td", todos: todosOpen }))
  await hooks.event(ev("session.idle", { sessionID: "td" })) // clean turn, unfinished todos
  await sleep(400)
  ok(state.prompts.some((p) => p.text.includes("todo list still has unfinished")), "N: todo-drive nudge sent")
  await hooks.event(ev("todo.updated", { sessionID: "td", todos: todosDone }))
  await hooks.event(ev("session.idle", { sessionID: "td" }))
  await sleep(350)
  ok(state.prompts.some((p) => p.text.includes("Self-improvement pass 1/2")), "N: improvement pass 1 runs before wrap-up")
  await hooks.event(ev("session.idle", { sessionID: "td" }))
  await sleep(350)
  ok(state.prompts.some((p) => p.text.includes("Self-improvement pass 2/2")), "N: improvement pass 2 runs")
  await hooks.event(ev("session.idle", { sessionID: "td" }))
  await sleep(350)
  ok(state.prompts.filter((p) => p.text.includes("wrap-up")).length === 1, "N: single proposal prompt after improvements")
  await hooks.event(ev("session.idle", { sessionID: "td" }))
  await sleep(300)
  ok(state.logs.some((t) => t.includes("complete")), "N: success notice shown")
}

// ---- O: debug nudge after consecutive tool failures --------------------------
{
  const { state, hooks } = await fresh(["dbg"])
  const toolPart = (status) => ev("message.part.updated", {
    part: { type: "tool", sessionID: "dbg", state: { status }, tool: "bash" },
  })
  for (let i = 0; i < 3; i++) await hooks.event(toolPart("error"))
  await sleep(400)
  ok(state.prompts.filter((p) => p.text.includes("root cause")).length === 1, "O: debug nudge after 3 failures")
  await hooks.event(toolPart("error"))
  await sleep(200)
  ok(state.prompts.filter((p) => p.text.includes("root cause")).length === 1, "O: armed once per streak")
  await hooks.event(toolPart("completed"))
  await hooks.event(toolPart("error"))
  await hooks.event(toolPart("error"))
  await sleep(200)
  ok(state.prompts.filter((p) => p.text.includes("root cause")).length === 1, "O: streak reset on success")
}

// ---- P: max-nudges cap + real-user-message scope reset ------------------------
{
  process.env.OPENCODE_AUTOPILOT_MAX_NUDGES = "1"
  const { state, hooks } = await fresh(["rs"])
  const todo = [{ id: "t", status: "pending", content: "x", priority: "low" }]
  await hooks.event(ev("todo.updated", { sessionID: "rs", todos: todo }))
  await hooks.event(ev("session.idle", { sessionID: "rs" }))
  await sleep(350)
  ok(state.prompts.length === 1, "P: first drive nudge allowed")
  await hooks.event(ev("session.idle", { sessionID: "rs" }))
  await sleep(350)
  ok(state.prompts.length === 1, "P: cap blocks further nudges")
  // real human message -> new task scope -> cap budget restored
  state.msgStore.um1 = "New task: please refactor the auth module"
  await hooks.event(ev("message.updated", { info: { role: "user", sessionID: "rs", id: "um1" } }))
  await sleep(50)
  await hooks.event(ev("session.idle", { sessionID: "rs" }))
  await sleep(350)
  ok(state.prompts.length === 2, "P: new user task restores nudge budget")
  // our own injected message (tagged) must NOT reset scope
  state.msgStore.um2 = "[auto-resume] The todo list still has unfinished items..."
  await hooks.event(ev("todo.updated", { sessionID: "rs", todos: [{ id: "t2", status: "pending", content: "y", priority: "low" }] }))
  await sleep(20)
  await hooks.event(ev("message.updated", { info: { role: "user", sessionID: "rs", id: "um2" } }))
  await hooks.event(ev("session.idle", { sessionID: "rs" }))
  await sleep(350)
  // if the tagged message had been misjudged as human, scope would reset and
  // another drive-nudge would fire despite the exhausted cap -> stays at 2.
  ok(state.prompts.length === 2, "P: injected message does not reset scope (cap still holds)")
  delete process.env.OPENCODE_AUTOPILOT_MAX_NUDGES
}

console.log(process.exitCode ? "V2 TESTS FAILED" : "ALL V2 TESTS PASSED")


