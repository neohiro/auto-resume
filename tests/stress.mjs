// Adversarial suite: malformed input fuzzing, event floods, multi-session storms.
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "20"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "30"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "300"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "15"
process.env.OPENCODE_RESUME_TOAST_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0"

import { AutoResumePlugin } from "../auto-resume.js"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let unhandled = []
process.on("unhandledRejection", (e) => unhandled.push(String(e)))

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
        state.prompts.push({ id: path.id, text: body.parts[0].text })
        return { data: {} }
      },
      abort: async () => true,
      summarize: async () => true,
      messages: async () => ({
        data: [{ info: { role: "assistant", error: null, id: `m${++state.msgN}` }, parts: [{ type: "text", text: "ok" }] }],
      }),
      message: async () => ({ data: { parts: [] } }),
    },
  }
}

async function fresh() {
  const state = { prompts: [], aborts: [], toasts: [], idleIds: new Set(), msgStore: {}, sessionList: [], msgN: 0 }
  const hooks = await AutoResumePlugin({ client: makeClient(state) })
  return { state, hooks }
}
const ev = (type, properties) => ({ event: { type, properties } })

// ---- FF: malformed event battery ---------------------------------------------
{
  const { hooks } = await fresh()
  const garbage = [
    null, undefined, {}, { event: null }, { event: {} },
    ev("nonexistent.event", {}),
    ev("session.error", {}),
    ev("session.error", { sessionID: "x" }),
    ev("session.error", { sessionID: "", error: undefined }),
    ev("session.error", { sessionID: 42, error: "not-an-object" }),
    ev("session.error", { sessionID: "x", error: {} }),
    ev("session.error", { sessionID: "x", error: { name: 123, data: null } }),
    ev("message.updated", {}),
    ev("message.updated", { info: null }),
    ev("message.updated", { info: { role: "weird", sessionID: null } }),
    ev("message.part.updated", { part: null }),
    ev("message.part.updated", { part: { type: 42 } }),
    ev("todo.updated", { sessionID: "x", todos: "not-an-array" }),
    ev("todo.updated", { sessionID: "x", todos: [null, { status: 1 }, undefined] }),
    ev("session.status", {}),
    ev("session.status", { sessionID: "x", status: null }),
    ev("permission.updated", { sessionID: "x" }),
    ev("permission.updated", { sessionID: "x", id: "p1", type: null, title: 5, metadata: "oops" }),
    ev("session.compacted", {}),
    ev("session.deleted", {}),
  ]
  let survived = true
  for (const g of garbage) {
    try { await hooks.event(g) } catch (err) { survived = false; console.log("threw on:", JSON.stringify(g)?.slice(0, 60), err.message) }
  }
  ok(survived, `FF: ${garbage.length} malformed events handled without throwing`)
}

// ---- GG: event flood ----------------------------------------------------------
{
  const { state, hooks } = await fresh(["flood"])
  const t0 = Date.now()
  for (let i = 0; i < 3000; i++) {
    await hooks.event(ev("message.part.updated", { part: { type: "text", sessionID: "flood", text: `chunk ${i} ${"x".repeat(50)}` } }))
  }
  const dt = Date.now() - t0
  ok(dt < 5000, `GG: 3000-event flood processed in ${dt}ms`)
  // flood counts as activity -> no stall takeover afterwards
  await sleep(200)
  ok(!state.aborts.includes("flood"), "GG: flood kept session alive (no false stall)")
}

// ---- HH: simultaneous multi-session failure storm ------------------------------
{
  process.env.OPENCODE_RESUME_BREAKER_THRESHOLD = "40" // keep breaker out of this test's way
  const { state, hooks } = await fresh()
  const ids = Array.from({ length: 30 }, (_, i) => `storm${i}`)
  for (const id of ids) {
    await hooks.event(ev("message.updated", { info: { role: "assistant", sessionID: id, providerID: "provA", modelID: "a-max" } }))
  }
  for (const id of ids) {
    await hooks.event(ev("session.error", { sessionID: id, error: { name: "APIError", data: { statusCode: 503, message: `storm ${id}` } } }))
  }
  await sleep(600)
  const recovered = new Set(state.prompts.map((p) => p.id))
  ok(recovered.size === ids.length, `HH: all ${ids.length} concurrent failures recovered (${recovered.size})`)
  ok(unhandled.length === 0, "HH: zero unhandled rejections during storm")
  delete process.env.OPENCODE_RESUME_BREAKER_THRESHOLD
}

// ---- II: timer hygiene after session deletion ----------------------------------
{
  const { state, hooks } = await fresh()
  await hooks.event(ev("session.error", { sessionID: "gone", error: { name: "APIError", data: { statusCode: 503, message: "boom" } } }))
  await hooks.event(ev("session.deleted", { info: { id: "gone" } }))
  await sleep(400)
  ok(!state.prompts.some((p) => p.id === "gone"), "II: pending resume cancelled by session deletion")
}

console.log(`unhandled rejections total: ${unhandled.length}`)
if (unhandled.length) process.exitCode = 1
console.log(process.exitCode ? "STRESS TESTS FAILED" : "ALL STRESS TESTS PASSED")
