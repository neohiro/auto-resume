// Run T4 in isolation
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0"

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AutoResumePlugin } from "./auto-resume.js"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeState() {
  return {
    prompts: [], aborts: [], logs: [], updates: [],
    idleIds: new Set(), msgStore: {}, msgN: 0,
    sessionList: [], messagesBySession: {},
    baseTitles: {}, titles: {}
  }
}

function makeClient(state) {
  return {
    app: { log: async ({ body }) => { state.logs.push(body?.message ?? ""); return true } },
    config: { providers: async () => ({ data: { providers: [{ id: "provA", models: { "a-max": {} } }] } }) },
    session: {
      list: async () => ({ data: state.sessionList.map(id => ({ id, title: state.baseTitles[id] ?? state.titles[id] ?? "" })) }),
      get: async ({ path }) => ({ data: { id: path.id, title: state.titles[path.id] ?? state.baseTitles[path.id] ?? "" } }),
      update: async ({ path, body }) => { state.updates.push({ id: path.id, title: body.title }); if (typeof body.title === "string") state.titles[path.id] = body.title; return { data: { id: path.id, title: body.title } } },
      status: async () => ({ data: Object.fromEntries([...state.idleIds].map(id => [id, { type: "idle" }])) }),
      prompt: async ({ path, body }) => { state.prompts.push({ id: path.id, text: body.parts[0].text }); return { data: {} } },
      abort: async ({ path }) => { state.aborts.push(path.id); return true },
      summarize: async () => true,
      messages: async ({ path }) => {
        const entries = structuredClone(state.messagesBySession[path.id] ?? [{ info: { role: "assistant", error: null }, parts: [{ type: "text", text: "ok" }] }])
        if (entries.length) entries[entries.length - 1].info.id = `m${++state.msgN}`
        return { data: entries }
      },
      message: async ({ path }) => ({ data: { parts: [{ type: "text", text: state.msgStore[path.messageID] ?? "" }] } }),
    }
  }
}

const ev = (type, properties) => ({ event: { type, properties } })

const dir = await mkdtemp(join(tmpdir(), "ar-title-"))
process.env.OPENCODE_RESUME_OFFSTORE = join(dir, "off.json")

// run #1: opt the session out
const stateA = makeState()
const hooksA = await AutoResumePlugin({ client: makeClient(stateA) })
stateA.msgStore.o1 = "/auto-resume off"
await hooksA.event(ev("message.updated", { info: { role: "user", sessionID: "p9", id: "o1" } }))
await sleep(500)
ok(stateA.logs.some(t => t.includes("Off for this session")), "T4: run #1 opted the session out")

// run #2: OpenCode restarted
const stateB = makeState()
stateB.sessionList = [{ id: "p9", time: { updated: Date.now() - 1000 } }]
stateB.baseTitles.p9 = "Build the importer"
stateB.messagesBySession.p9 = [{ info: { role: "user", sessionID: "p9" }, parts: [] }]
const hooksB = await AutoResumePlugin({ client: makeClient(stateB) })
await sleep(2200)
ok(stateB.prompts.length === 0 && stateB.titles.p9 === undefined, "T4: restarted run keeps the session opted out and never touches it")

await hooksB.event(ev("todo.updated", { sessionID: "p9", todos: [{ title: "x", status: "pending" }] }))
await hooksB.event(ev("session.idle", { sessionID: "p9" }))
await sleep(400)
ok(!stateB.prompts.some(p => p.id === "p9"), "T4: still silent while opted out")

// re-enable via in-chat command
stateB.msgStore.o2 = "auto-resume on"
await hooksB.event(ev("message.updated", { info: { role: "user", sessionID: "p9", id: "o2" } }))
await sleep(600)
console.log("TITLE:", JSON.stringify(stateB.titles.p9))
console.log("UPDATES:", stateB.updates.map(u => u.title))
ok(stateB.titles.p9?.startsWith("🟢"), "T4: 'auto-resume on' re-arms and re-tags the title")

await sleep(200)
const offRaw = JSON.parse(await readFile(process.env.OPENCODE_RESUME_OFFSTORE, "utf8"))
ok(!offRaw.p9, "T4: opt-out marker removed from persistent store")
await rm(dir, { recursive: true, force: true })

console.log(process.exitCode ? "T4 FAILED" : "T4 PASSED")