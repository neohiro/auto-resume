// Fails the build when package.json and AUTO_RESUME_VERSION drift apart.
const fs = require("fs")
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")).version
const m = fs.readFileSync("auto-resume.js", "utf8").match(/AUTO_RESUME_VERSION = "([^"]+)"/)
if (!m) {
  console.error("AUTO_RESUME_VERSION not found in auto-resume.js")
  process.exit(1)
}
if (m[1] !== pkg) {
  console.error(`version mismatch: package.json=${pkg} auto-resume.js=${m[1]}`)
  process.exit(1)
}
console.log(`version OK: ${pkg}`)
