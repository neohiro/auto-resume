// Coverage metadata generator: the README's suite/assertion counts are
// PRODUCED by this script, not hand-edited, and smoke test I6 plus the CI
// step below fail if they drift.
//
// Counts are STATIC (occurrences of ok() in the direct suites discovered
// from the npm test script, minus the Bun-gated integration suite whose
// assertions are environment-dependent). Static is a lower bound here:
// loops can execute an ok() more than once, never fewer (currently 244
// static vs 249 executed). Rounding the floor to the nearest 10 absorbs
// that skew, so the line only churns on suite additions or 10-boundaries.
//
//   node scripts/coverage.mjs          print JSON metadata
//   node scripts/coverage.mjs --write  rewrite the README coverage markers
//   node scripts/coverage.mjs --check  exit non-zero if the README is stale
//
// Plain node:fs/path/url only, so this runs under the CI setup-node job
// with no Bun dependency.
import { readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export async function collectCoverage(rootDir) {
  const root = String(rootDir).startsWith("file:") ? fileURLToPath(rootDir) : String(rootDir)
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  const testCommand = packageJson.scripts.test
  const files = (await readdir(join(root, "tests"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => entry.name)
    .filter((name) => testCommand.includes(`tests/${name}`) && name !== "integration.bun.mjs")
    .sort()
  let assertions = 0
  for (const name of files) {
    const src = await readFile(join(root, "tests", name), "utf8")
    assertions += (src.match(/\bok\(/g) || []).length
  }
  const floor = Math.floor(assertions / 10) * 10
  return { suites: files.length, assertions, floor, files, text: `${floor}+ assertions across ${files.length} suites` }
}

export function coverageMarker(meta) {
  return `<!-- coverage -->${meta.text}<!-- /coverage -->`
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const mode = process.argv[2]
  if (!mode) {
    console.log(JSON.stringify(await collectCoverage(root), null, 2))
  } else if (mode === "--write" || mode === "--check") {
    const meta = await collectCoverage(root)
    const readmePath = join(root, "README.md")
    const readme = await readFile(readmePath, "utf8")
    const pattern = /<!-- coverage -->.*?<!-- \/coverage -->/
    if (!pattern.test(readme)) {
      console.error("coverage markers missing from README")
      process.exit(1)
    }
    if (mode === "--check") {
      if (!readme.includes(coverageMarker(meta))) {
        console.error(`README coverage stale: expected "${meta.text}"`)
        process.exit(1)
      }
      console.log(`coverage OK: ${meta.text}`)
    } else {
      await writeFile(readmePath, readme.replace(pattern, coverageMarker(meta)), "utf8")
      console.log(`coverage updated: ${meta.text}`)
    }
  } else {
    console.error(`unknown mode: ${mode}`)
    process.exit(1)
  }
}
