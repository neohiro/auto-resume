// End-to-end verification of the self-updater against the REAL GitHub repo.
// Each scenario runs an isolated copy of the plugin, exactly like OpenCode
// loads it at startup.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs"
import { pathToFileURL } from "node:url"
const require0 = readdirSync

const NODE_OK = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ROOT = ".updtest"
// Discover the remote version once; all expectations derive from it.
const res0 = await fetch("https://raw.githubusercontent.com/neohiro/auto-resume/main/auto-resume.js")
const remoteSource = res0.ok ? await res0.text() : ""
const REMOTE = remoteSource.match(/AUTO_RESUME_VERSION = "([^"]+)"/)?.[1] ?? null
if (!REMOTE) { console.log("SKIP: cannot reach GitHub"); process.exit(0) }
console.log(`remote main version: ${REMOTE}`)
const SOURCE = new URL("../auto-resume.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

function scenario(name) {
  const dir = `${ROOT}/${name}`
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const file = `${dir}/auto-resume.js`
  return { dir, file }
}

async function boot(file) {
  const state = { prompts: [], toasts: [] }
  const client = {
    app: { log: async () => true },
    tui: { showToast: async ({ body }) => { state.toasts.push(body.message); return true } },
    config: { providers: async () => ({ data: { providers: [] } }) },
    session: new Proxy({}, { get: () => async () => ({ data: {} }) }),
  }
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}-${Math.random()}`)
  await mod.AutoResumePlugin({ client })
  return state
}

const versionOf = (file) => readFileSync(file, "utf8").match(/AUTO_RESUME_VERSION = "([^"]+)"/)?.[1]

rmSync(ROOT, { recursive: true, force: true })

// ---- T1: stale local copy updates itself from GitHub ------------------------
{
  const { file, dir } = scenario("stale")
  const original = readFileSync(SOURCE, "utf8")
  writeFileSync(file, original.replace(/AUTO_RESUME_VERSION = "[^"]+"/, 'AUTO_RESUME_VERSION = "1.0.0"'))
  const state = await boot(file)
  await sleep(4000)
  NODE_OK(versionOf(file) === REMOTE, `T1: stale copy self-updated 1.0.0 -> ${versionOf(file)} (GitHub main)`)
  NODE_OK(existsSync(`${file}.bak`) && versionOf(`${file}.bak`) === "1.0.0", "T1: .bak backup of previous version created")
  const leftovers = existsSync(`${dir}/auto-resume.js.tmp`) ||
    require0(dir).some((f) => f.endsWith(".tmp"))
  NODE_OK(!leftovers, "T1: no temp-file leftovers")
  NODE_OK(state.toasts.some((t) => t.includes(`Updated 1.0.0 -> ${REMOTE}`) && t.includes("Restart OpenCode")),
    "T1: toast tells user to restart")
}

// ---- T2: current version -> clean no-op --------------------------------------
{
  const { file } = scenario("current")
  writeFileSync(file, remoteSource)
  const state = await boot(file)
  await sleep(4000)
  NODE_OK(versionOf(file) === REMOTE && !existsSync(`${file}.bak`), "T2: up-to-date install left untouched")
  NODE_OK(!state.toasts.some((t) => t.includes("Updated")), "T2: no update toast when current")
}

// ---- T3: locally newer than remote -> no downgrade ---------------------------
{
  const { file } = scenario("future")
  writeFileSync(file, readFileSync(SOURCE, "utf8").replace(/AUTO_RESUME_VERSION = "[^"]+"/, 'AUTO_RESUME_VERSION = "99.0.0"'))
  const before = readFileSync(file, "utf8")
  const state = await boot(file)
  await sleep(4000)
  NODE_OK(readFileSync(file, "utf8") === before && !existsSync(`${file}.bak`), "T3: newer local version not downgraded")
}

// ---- T4: unreachable endpoint -> silent resilience ----------------------------
{
  const { file } = scenario("offline")
  writeFileSync(file, readFileSync(SOURCE, "utf8").replace(
    /const UPDATE_URL =\s*"[^"]+"/,
    'const UPDATE_URL = "http://127.0.0.1:9/auto-resume.js"',
  ))
  const before = readFileSync(file, "utf8")
  let threw = false
  try { await boot(file) } catch { threw = true }
  await sleep(1500)
  NODE_OK(!threw && readFileSync(file, "utf8") === before, "T4: unreachable update endpoint fails silently, plugin still boots")
}

// ---- T5/T6: restart confirmation (pure ack semantics, network-independent) ---
{
  const { file } = scenario("ack")
  // Simulate an install that was updated during a past session: current
  // feature-complete code, but the ack marker still holds the OLD version.
  writeFileSync(file, readFileSync(SOURCE, "utf8").replace(/AUTO_RESUME_VERSION = "[^"]+"/, 'AUTO_RESUME_VERSION = "7.7.7"'))
  writeFileSync(`${file}.acked`, "0.8.0")
  const s2 = await boot(file)
  await sleep(1500)
  NODE_OK(s2.toasts.some((t) => t.includes("Now running v7.7.7") && t.includes("(previously 0.8.0)")),
    "T5: restart confirms the applied update exactly once")
  const s3 = await boot(file)
  await sleep(1200)
  NODE_OK(!s3.toasts.some((t) => t.includes("Now running v")), "T6: confirmation never fires again")
}

console.log(process.exitCode ? "UPDATER VERIFICATION FAILED" : "UPDATER VERIFICATION: ALL PATHS PROVEN")

