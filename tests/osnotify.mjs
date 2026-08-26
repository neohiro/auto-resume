// Unit coverage for createOsNotifier: drives every OS branch through an
// injected platform + recording shell runner — no process globals mutated,
// so it behaves identically on the win32/darwin/linux CI runners.
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0"
import { createOsNotifier } from "../auto-resume.js"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
// Canary: the factory must never leave an unawaited rejection behind
// (Node >=15 treats those as fatal).
process.on("unhandledRejection", (e) => {
  console.log(`FAIL  unexpected unhandled rejection: ${e?.message ?? e}`)
  process.exitCode = 1
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const recorder = ({ failWhen } = {}) => {
  const calls = []
  const $ = (...args) => {
    const flat = args.flat().map(String)
    calls.push(flat)
    // Mirror Bun's $ contract exactly: .quiet() exists on BOTH outcomes and
    // returns the same promise, so awaiting happens through one handle.
    const p = failWhen && failWhen(flat.join(" "))
      ? Promise.reject(new Error("blocked"))
      : Promise.resolve({ exitCode: 0 })
    p.quiet = () => p
    return p
  }
  return { calls, $ }
}

const joined = (calls, i = 0) => (calls[i] ?? []).join(" ")

const TITLE = `he said "hi" \\ ' ; remove-item -recurse;`
const MSG = "body 'quoted' text"

// ---- 1: no shell runner -> clean false, nothing dispatched ------------------
{
  const notify = createOsNotifier({ platform: "win32" })
  ok(await notify("t", "m") === false, "N1: without a runner the notifier is a no-op")
}

// ---- 2: win32 branch -> full-path powershell with EncodedCommand ------------
{
  const { calls, $ } = recorder()
  const notify = createOsNotifier({ $, platform: "win32", systemRoot: "D:\\Win" })
  ok(await notify(TITLE, MSG) === true, "N2: win32 dispatch resolves true")
  ok(calls.length === 1, "N2: exactly one invocation")
  const argv = joined(calls)
  ok(argv.includes("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
    "N2: uses SystemRoot-relative signed powershell.exe")
  ok(argv.includes("-EncodedCommand"), "N2: passes an encoded command")
  const encoded = calls[0][calls[0].length - 1]
  const decoded = Buffer.from(encoded, "base64").toString("utf16le")
  ok(decoded.includes("$ErrorActionPreference = 'Stop'") && decoded.includes("ToastText02"),
    "N2: payload is the WinRT-toast-with-balloon-fallback script")
  // Injection safety: hostile quotes must arrive doubled inside single quotes.
  ok(decoded.includes(`$title = '${TITLE.replace(/'/g, "''")}'`),
    "N2: single quotes doubled — PS string injection impossible")
  ok(!decoded.includes("\n$title = '" + TITLE), "N2: title never breaks out of its literal")
}

// ---- 3: darwin branch -> osascript with escaped AppleScript literals -------
{
  const { calls, $ } = recorder()
  const notify = createOsNotifier({ $, platform: "darwin" })
  ok(await notify(TITLE, MSG) === true && calls.length === 1, "N3: darwin dispatch via osascript")
  const script = joined(calls)
  ok(script.includes("display notification"), "N3: uses display notification")
  ok(script.includes('\\"hi\\"') && script.includes('\\\\'),
    "N3: backslashes and double quotes escaped for AppleScript")
  ok(calls[0].some((el) => el.includes("display notification") && el.includes("remove-item")),
    "N3: hostile text stays inside one quoted AppleScript argument")
}

// ---- 4: bare linux -> notify-send first -------------------------------------
{
  const { calls, $ } = recorder()
  const notify = createOsNotifier({ $, platform: "linux", wslVersionFile: join(tmpdir(), `ar-n1-${Date.now()}-missing`) })
  ok(await notify("t", "m") === true && calls.length === 1,
    "N4: unreadable /proc/version -> treated as bare linux")
  ok(joined(calls).includes("notify-send"), "N4: libnotify is the first choice")
}

// ---- 5: bare linux fallback -> raw D-Bus when libnotify missing -------------
{
  const { calls, $ } = recorder({ failWhen: (c) => c.includes("notify-send") })
  const notify = createOsNotifier({ $, platform: "linux", wslVersionFile: join(tmpdir(), `ar-n5-${Date.now()}-missing`) })
  ok(await notify("t", "m") === true, "N5: falls through when libnotify fails")
  ok(joined(calls, 1).includes("--dest=org.freedesktop.Notifications") && joined(calls, 1).includes("uint32:0"),
    "N5: raw D-Bus Notifications call with typed args")
  ok(calls.length === 2, "N5: exactly notify-send then dbus-send")
}

// ---- 6: WSL -> delegates to Windows PowerShell ------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "ar-wsl-"))
  const probe = join(dir, "version")
  await writeFile(probe, "Linux version 5.15.153.1-microsoft-standard-WSL2", "utf8")
  const { calls, $ } = recorder()
  const notify = createOsNotifier({ $, platform: "linux", wslVersionFile: probe })
  ok(await notify("t", "m") === true && calls.length === 1, "N6: WSL detected")
  ok(joined(calls).includes("powershell.exe") && joined(calls).includes("-EncodedCommand"),
    "N6: WSL bridges to Windows PowerShell")
  ok(!joined(calls).includes("notify-send"), "N6: skips libnotify on WSL")
  await rm(dir, { recursive: true, force: true })
}

// ---- 7: runner failure everywhere -> false (never throws) -------------------
{
  const { $ } = recorder({ failWhen: () => true })
  const notify = createOsNotifier({ $, platform: "linux", wslVersionFile: join(tmpdir(), `ar-n7-${Date.now()}-missing`) })
  ok(await notify("t", "m") === false, "N7: total notifier failure resolves false")
}

// ---- 8: HUNG notifier -> hard timeout resolves false -------------------------
{
  const everPending = (..._args) => {
    const p = new Promise(() => {}) // never settles — D-Bus autolaunch style
    p.quiet = () => p
    return p
  }
  const calls = []
  const notify = createOsNotifier({
    $: (...args) => { calls.push(1); return everPending(...args) },
    platform: "linux",
    wslVersionFile: join(tmpdir(), `ar-n8-${Date.now()}-missing`),
    timeoutMs: 250,
  })
  const t0 = Date.now()
  let result
  try { result = await notify("t", "m") } catch { result = "threw" }
  const elapsed = Date.now() - t0
  ok(result === false && elapsed < 5_000,
    `N8: hung dispatch times out to false (${elapsed}ms, result=${result})`)
  ok(calls.length === 2, "N8: timed-out libnotify still falls through to D-Bus")
}

await sleep(50)
console.log(process.exitCode ? "OSNOTIFY TESTS FAILED" : "ALL OSNOTIFY TESTS PASSED")
