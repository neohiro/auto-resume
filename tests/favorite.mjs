// Model rotation is turned off in all cases — favorite return / rotation tests verify rotation is disabled.
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0"
process.env.OPENCODE_RESUME_STOPSTORE = join(tmpdir(), `ar-fav-stop-${process.pid}-${Date.now()}.json`)
process.env.OPENCODE_RESUME_OFFSTORE = join(tmpdir(), `ar-fav-off-${process.pid}-${Date.now()}.json`)
process.env.OPENCODE_RESUME_ACTIVESTORE = join(tmpdir(), `ar-fav-active-${process.pid}-${Date.now()}.json`)

import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AutoResumePlugin } from "../auto-resume.js"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (type, properties) => ({ event: { type, properties } })

const FAV = { providerID: "provA", modelID: "a-max" }
const ALT = { providerID: "provA", modelID: "a-mini" }
const SESSION_METHODS = ["list", "get", "update", "status", "prompt", "abort", "summarize", "messages", "message"]
const OPTIONAL_PROBES = new Set(["promptAsync", "postSessionByIdPromptAsync"])

function makeClient(state, models = ["a-max", "a-mini"]) {
  const impls = {
    list: async () => ({ data: state.sessionList.map((id) => ({ id, title: `t ${id}` })) }),
    get: async ({ path }) => ({ data: { id: path.id, title: `t ${path.id}` } }),
    update: async () => ({ data: {} }),
    status: async () => ({ data: Object.fromEntries([...state.idleIds].map((id) => [id, { type: "idle" }])) }),
    prompt: async ({ path, body }) => {
      state.prompts.push({ id: path.id, model: body?.model ?? null })
      return { data: {} }
    },
    abort: async () => true,
    summarize: async () => true,
    messages: async ({ path }) => {
      const entries = structuredClone(state.messagesBySession[path.id] ?? [
        { info: { role: "assistant", error: null, id: `m${++state.msgN}` }, parts: [{ type: "text", text: "ok" }] },
      ])
      if (entries.length) entries[entries.length - 1].info.id = `m${++state.msgN}`
      return { data: entries }
    },
    message: async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
  }
  const session = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === "string" && !(prop in impls)) {
        if (!OPTIONAL_PROBES.has(prop)) state.unknownCalls.add(prop)
        return undefined
      }
      return (...args) => impls[prop](...args)
    },
    has(_t, prop) { return prop in impls },
  })
  return {
    app: { log: async ({ body }) => { state.logs.push(body?.message ?? ""); return true } },
    config: { providers: async () => ({
      data: { providers: [{ id: "provA", models: Object.fromEntries(models.map((m) => [m, {}])) }] },
    }) },
    session,
  }
}

function makeState(idle = []) {
  return {
    prompts: [], logs: [], unknownCalls: new Set(),
    idleIds: new Set(idle), msgN: 0, sessionList: [], messagesBySession: {},
  }
}

const cleanTurn = (state, id, model) => {
  state.messagesBySession[id] = [{
    info: { role: "assistant", error: null, providerID: model.providerID, modelID: model.modelID, id: `m${++state.msgN}` },
    parts: [{ type: "text", text: "work" }],
  }]
}

// ---- T1: rotation is turned off in all cases ----
{
  const state = makeState(["t1"])
  const client = makeClient(state)
  const hooks = await AutoResumePlugin({ client })
  state.sessionList = ["t1"]
  cleanTurn(state, "t1", FAV)
  await hooks.event(ev("session.error", {
    sessionID: "t1", error: { name: "RateLimitError", data: { statusCode: 429, message: "rate limited" } },
  }))
  await sleep(100)
  const rotated = state.prompts.some((p) => p.model?.modelID === ALT.modelID)
  ok(!rotated, "T1: rotation turned off in all cases — did not rotate on 429")
}

process.on("exit", () => {
  for (const f of [process.env.OPENCODE_RESUME_STOPSTORE, process.env.OPENCODE_RESUME_OFFSTORE]) {
    try { rmSync(f, { force: true }) } catch { /* best effort */ }
  }
})
