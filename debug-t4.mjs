import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AutoResumePlugin } from "./auto-resume.js"

const ev = (t,p) => ({event:{type:t,properties:p}})
const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeState() {
  return {
    prompts: [], logs: [], updates: [], idleIds: new Set(),
    msgStore: {}, msgN: 0, sessionList: [], messagesBySession: {},
    baseTitles: {}, titles: {}
  }
}

function makeClient(state) {
  return {
    app: { log: async ({ body }) => { state.logs.push(body?.message ?? ''); return true } },
    config: { providers: async () => ({ data: { providers: [] } }) },
    session: {
      list: async () => ({ data: state.sessionList.map(id => ({ id, title: state.baseTitles[id] ?? state.titles[id] ?? '' })) }),
      get: async ({ path }) => ({ data: { id: path.id, title: state.titles[path.id] ?? state.baseTitles[path.id] ?? '' } }),
      update: async ({ path, body }) => { state.updates.push({ id: path.id, title: body.title }); state.titles[path.id] = body.title; return { data: { id: path.id, title: body.title } } },
      status: async () => ({ data: Object.fromEntries([...state.idleIds].map(id => [id, { type: 'idle' }])) }),
      prompt: async () => ({ data: {} }),
      abort: async () => true,
      summarize: async () => true,
      messages: async () => ({ data: [] }),
      message: async ({ path }) => ({ data: { parts: [{ type: 'text', text: state.msgStore[path.messageID] ?? '' }] } }),
    }
  }
}

// Run A: opt out
const dir = await mkdtemp(join(tmpdir(), 'ar-title-'))
const offStore = join(dir, 'off.json')
process.env.OPENCODE_RESUME_OFFSTORE = offStore

const stateA = makeState()
const hooksA = await AutoResumePlugin({ client: makeClient(stateA) })
stateA.msgStore.o1 = '/auto-resume off'
await hooksA.event(ev('message.updated', { info: { role: 'user', sessionID: 'p9', id: 'o1' } }))
await sleep(500)
console.log("A logs:", stateA.logs.filter(l => l.includes("Off")))

// Run B: restart
const stateB = makeState()
stateB.sessionList = [{ id: 'p9', time: { updated: Date.now() - 1000 } }]
stateB.baseTitles.p9 = 'Build the importer'
stateB.messagesBySession.p9 = [{ info: { role: 'user', sessionID: 'p9' }, parts: [] }]
const hooksB = await AutoResumePlugin({ client: makeClient(stateB) })
await sleep(2500)

// Now re-enable
stateB.msgStore.o2 = 'auto-resume on'
await hooksB.event(ev('message.updated', { info: { role: 'user', sessionID: 'p9', id: 'o2' } }))
await sleep(1500)

console.log('TITLE:', JSON.stringify(stateB.titles.p9))
console.log('UPDATES:', stateB.updates.map(u => u.title))
await rm(dir, { recursive: true, force: true })