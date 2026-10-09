// Fails the build when package.json and AUTO_RESUME_VERSION drift apart.
// Can be run from any directory; resolves paths relative to this script.
const fs = require("fs")
const path = require("path")
const scriptDir = path.dirname(process.argv[1] || __filename)
const pkg = JSON.parse(fs.readFileSync(path.join(scriptDir, "..", "package.json"), "utf8")).version
const m = fs.readFileSync(path.join(scriptDir, "..", "auto-resume.js"), "utf8").match(/AUTO_RESUME_VERSION = "([^"]+)"/)
if (!m) {
  console.error("AUTO_RESUME_VERSION not found in auto-resume.js")
  process.exit(1)
}
if (m[1] !== pkg) {
  console.error(`version mismatch: package.json=${pkg} auto-resume.js=${m[1]}`)
  process.exit(1)
}
console.log(`version OK: ${pkg}`)
