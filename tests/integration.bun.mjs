// Integration suite: boots the plugin the way OpenCode does — with Bun's REAL
// shell runner ($) — and proves OS notifications actually dispatch through it.
// Skips cleanly under plain Node; CI runs it via the setup-bun job.
//
// NOTE: on success this shows ONE real OS notification per scenario. That is
// the point of the suite.
import { mkdtemp, rm, readFile, writeFile, cp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}

if (typeof Bun === "undefined") {
  console.log("SKIP: bun runtime required (npm test covers everything else)")
  process.exit(0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { $ } = await import("bun")

// Wrap the real runner: record invocations, keep Bun's promise contract intact
// (the returned thenable already carries .quiet/.nothrow).
const shellCalls = []
const real$ = (...args) => {
  shellCalls.push(args.flat().map(String).join(" ").slice(0, 120))
  return $(...args)
}
const SOURCE = new URL("../auto-resume.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const SOURCE_VERSION = (await readFile(SOURCE, "utf8")).match(/AUTO_RESUME_VERSION = "([^"]+)"/)?.[1]
const { createOsNotifier, AutoResumePlugin } = await import(pathToFileURL(SOURCE).href)

const logs = []
const mockClient = () => ({
  app: { log: async ({ body }) => { logs.push(body?.message ?? ""); return true } },
  config: { providers: async () => ({ data: { providers: [] } }) },
  session: new Proxy({}, { get: () => async () => ({ data: {} }) }),
})

// ---- I1: real shell dispatch through createOsNotifier -----------------------
{
  const notify = createOsNotifier({ $: real$ })
  let result = false
  try {
    result = await notify("auto-resume integration", `real-$ check on ${process.platform}`)
  } catch (e) {
    console.log(`FAIL  I1 threw unexpectedly: ${e?.message}`)
    process.exitCode = 1
  }
  ok(shellCalls.length >= 1, "I1: real Bun $ was invoked at least once")
  if (process.platform === "linux") {
    // notifier binaries may legitimately be absent on bare runners
    ok(typeof result === "boolean", `I1: linux dispatch resolved boolean (${result})`)
    ok(result === false || /notify-send|dbus-send/.test(shellCalls.join(" ")),
      "I1: linux attempt went through libnotify/dbus")
  } else {
    ok(result === true, `I1: ${process.platform} notification dispatched for real`)
    ok(/EncodedCommand|osascript/i.test(shellCalls.join(" ")), "I1: platform-native payload used")
  }
}

// ---- I2: full plugin boot — restart confirmation over the REAL channel ------
{
  const dir = await mkdtemp(join(tmpdir(), "ar-integ-"))
  const file = join(dir, "auto-resume.js")
  await cp(SOURCE, file)
  await writeFile(`${file}.acked`, "0.0.1", "utf8") // stale marker forces delivery

  const before = shellCalls.length
  const hooks = await AutoResumePlugin({ client: mockClient(), $: real$ })
  void hooks // arming happens during init; nothing else to drive

  // Delivery fires ~800ms after arming; poll up to 40s — headless runners can
  // burn TWO 15s notifier timeouts (libnotify + D-Bus autolaunch hang) before
  // the failure warn lands; genuine deliveries commit within seconds.
  let acked = ""
  for (let i = 0; i < 160; i += 1) {
    await sleep(250)
    acked = (await readFile(`${file}.acked`, "utf8").catch(() => "")).trim()
    if (acked === SOURCE_VERSION) break
  }
  const dispatched = shellCalls.length > before
  const deliveredDurably =
    acked === SOURCE_VERSION &&
    logs.some((m) => m.includes("Now running v")) &&
    logs.some((m) => m.includes("update notice delivered via OS notification"))
  const surfacedFailure =
    logs.some((m) => m.includes("update notice delivery failed"))
  if (!dispatched) {
    ok(false, "I2: no OS dispatch attempted at all")
  } else {
    ok(true, `I2: OS dispatch attempted (${shellCalls.length - before} call/s)`)
    // Exactly one honest outcome is acceptable: a durable delivery (ack +
    // trace log) OR a surfaced, retryable failure. Fake success is the bug.
    ok(
      (deliveredDurably && !surfacedFailure) || (surfacedFailure && acked !== SOURCE_VERSION),
      `I2: honest outcome (acked='${acked || ""}', delivered=${deliveredDurably}, failure-surfaced=${surfacedFailure})`,
    )
    if (process.exitCode) {
      console.log("I2 diagnostics — logs:", JSON.stringify(logs, null, 1))
      console.log("I2 diagnostics — shellCalls:", JSON.stringify(shellCalls, null, 1))
    }
  }
  await rm(dir, { recursive: true, force: true })
}

await sleep(100)
console.log(process.exitCode ? "INTEGRATION TESTS FAILED" : "ALL INTEGRATION TESTS PASSED")
