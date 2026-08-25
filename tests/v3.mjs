// Self-contained env tuning: fast delays + no notice throttling for assertions.
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0" // never hit the network in CI
import { tmpdir } from "node:os"
import { join } from "node:path"

// Per-run isolated sidecar stores: never touch the real plugin directory and
// never leak state between runs (a persisted stop/opt-out would poison the
// next run's assertions).
process.env.OPENCODE_RESUME_STOPSTORE ??= join(tmpdir(), `ar-v3-stops-${process.pid}-${Date.now()}.json`)
process.env.OPENCODE_RESUME_OFFSTORE ??= join(tmpdir(), `ar-v3-off-${process.pid}-${Date.now()}.json`)

import { AutoResumePlugin } from "../auto-resume.js"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeClient(state, providers) {
  return {
    app: { log: async ({ body }) => { state.logs.push(body?.message ?? ""); return true } },
    config: { providers: async () => ({ data: { providers } }) },
    session: {
      status: async () => ({ data: Object.fromEntries([...state.idleIds].map((id) => [id, { type: "idle" }])) }),
      prompt: async ({ path, body }) => {
        state.prompts.push({ id: path.id, text: body.parts[0].text, model: body.model })
        return { data: {} }
      },
      abort: async () => true,
      summarize: async () => true,
      messages: async () => ({
        data: [{ info: { role: "assistant", error: null, providerID: "provA", modelID: "m", id: `m${++state.msgN}` }, parts: [{ type: "text", text: "ok" }] }],
      }),
      message: async ({ path }) => ({ data: { parts: [{ type: "text", text: state.msgStore[path.messageID] ?? "" }] } }),
    },
  }
}

async function fresh(idle, providers) {
  const state = { prompts: [], aborts: [], summarizes: [], logs: [], permResponses: [], idleIds: new Set(idle), msgStore: {}, msgN: 0 }
  const hooks = await AutoResumePlugin({ client: makeClient(state, providers) })
  return { state, hooks }
}
const ev = (type, properties) => ({ event: { type, properties } })

// ---- Q: persistent network/5xx failures rotate models too -------------------
{
  process.env.OPENCODE_RESUME_ROTATE_AFTER_FAILURES = "2"
  const providers = [
    { id: "provA", models: { "a-base": {}, "a-max": {}, "a-mini": {} } },
    { id: "provB", models: { "b-pro": {} } },
  ]
  const { state, hooks } = await fresh(["pf"], providers)
  await hooks.event(ev("message.updated", { info: { role: "assistant", sessionID: "pf", providerID: "provA", modelID: "a-base" } }))
  await hooks.event(ev("session.error", { sessionID: "pf", error: { name: "APIError", data: { statusCode: 503, message: "service unavailable" } } }))
  await sleep(200)
  ok(state.prompts.length === 1 && state.prompts[0]?.model?.modelID === "a-base",
    `Q: first failure retries same model (${state.prompts[0]?.model?.modelID})`)
  await hooks.event(ev("session.error", { sessionID: "pf", error: { name: "UnknownError", data: { message: "fetch failed: ECONNRESET" } } }))
  await sleep(300)
  const rotated = state.prompts.at(-1)?.model
  ok(rotated?.providerID === "provA" && rotated?.modelID === "a-max",
    `Q: streak of 2 -> rotated to strongest sibling a-max (${JSON.stringify(rotated)})`)
  delete process.env.OPENCODE_RESUME_ROTATE_AFTER_FAILURES
}

// ---- R: tier ranking prefers Max/Pro over mini/lite everywhere ---------------
{
  const providers = [
    { id: "provA", models: { "x-lite": {}, "x-mini": {}, "y-pro": {} } },
    { id: "provB", models: { "z-ultra": {}, "z-nano": {} } },
  ]
  const { state, hooks } = await fresh(["tier"], providers)
  await hooks.event(ev("message.updated", { info: { role: "assistant", sessionID: "tier", providerID: "provA", modelID: "x-lite" } }))
  await hooks.event(ev("session.error", { sessionID: "tier", error: { name: "APIError", data: { statusCode: 402, message: "quota exhausted" } } }))
  await sleep(300)
  // x-lite is exhausted+cooled; eligible siblings: x-mini(-50), y-pro(+45)
  ok(state.prompts[0]?.model?.modelID === "y-pro",
    `R: tier beats alphabetical/sibling order -> y-pro (${JSON.stringify(state.prompts[0]?.model)})`)
}

// ---- T: rotation cap stops endless provider hopping --------------------------
{
  process.env.OPENCODE_RESUME_MAX_ROTATIONS = "1"
  process.env.OPENCODE_RESUME_RL_SWITCH_AFTER = "1"
  process.env.OPENCODE_RESUME_MAX_CHAIN = "2"
  const providers = [
    { id: "provA", models: { "a1": {}, "a2": {} } },
    { id: "provB", models: { "b1": {} } },
  ]
  const { state, hooks } = await fresh(["hop"], providers)
  await hooks.event(ev("message.updated", { info: { role: "assistant", sessionID: "hop", providerID: "provA", modelID: "a1" } }))
  for (let i = 0; i < 8; i++) {
    await hooks.event(ev("session.error", { sessionID: "hop", error: { name: "APIError", data: { statusCode: 429, message: `rate limit wave ${i}` } } }))
    await sleep(120)
  }
  const distinctModels = new Set(state.prompts.map((p) => p.model?.modelID).filter(Boolean))
  ok(distinctModels.size <= 3, `T: rotations bounded (${[...distinctModels].join(",")})`)
  ok(state.logs.some((t) => t.toLowerCase().includes("no alternate") || t.toLowerCase().includes("gave up")),
    "T: honest give-up notice when rotations exhausted")
  delete process.env.OPENCODE_RESUME_MAX_ROTATIONS
  delete process.env.OPENCODE_RESUME_RL_SWITCH_AFTER
  delete process.env.OPENCODE_RESUME_MAX_CHAIN
}

// ---- V: improvement loop respects IMPROVE_CYCLES and then wraps up -----------
{
  process.env.OPENCODE_AUTOPILOT_IMPROVE_CYCLES = "1"
  const todosDone = [{ id: "t", status: "completed", content: "done thing", priority: "high" }]
  const { state, hooks } = await fresh(["imp"])
  await hooks.event(ev("todo.updated", { sessionID: "imp", todos: todosDone }))
  await hooks.event(ev("session.idle", { sessionID: "imp" }))
  await sleep(350)
  ok(state.prompts.filter((p) => p.text.includes("Self-improvement pass")).length === 1,
    "V: exactly one improvement pass with CYCLES=1")
  await hooks.event(ev("session.idle", { sessionID: "imp" }))
  await sleep(350)
  ok(state.prompts.filter((p) => p.text.includes("wrap-up")).length === 1, "V: proposals follow improvements")
  await hooks.event(ev("session.idle", { sessionID: "imp" }))
  await sleep(250)
  ok(state.logs.some((t) => t.includes("complete")), "V: final success notice")
  delete process.env.OPENCODE_AUTOPILOT_IMPROVE_CYCLES
}

console.log(process.exitCode ? "V3 TESTS FAILED" : "ALL V3 TESTS PASSED")
