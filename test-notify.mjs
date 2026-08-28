import { createOsNotifier } from "./auto-resume.js"

const calls = []
const $ = (cmd, args) => {
  calls.push(args ? [cmd, args] : cmd)
  return Promise.resolve("")
}

const n = createOsNotifier({ $ })
const r = await n("auto-resume test", "hello world")
console.log("drop-file calls (should be empty):", calls.filter(c => !Array.isArray(c) || c[0] === "drop"))
const winCalls = calls.filter(c => Array.isArray(c) && typeof c[0] === "string" && c[0].includes("powershell"))
console.log("win32 calls:", winCalls.map(c => `${c[0]} args[${c[1]?.length ?? '?'}]=${c[1]?.map(a => String(a).slice(0, 40)).join(' ')}`))
console.log("result:", r)
