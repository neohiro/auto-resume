// Fast-retry spacing, measured under the SHIPPED defaults.
//
// This lives in its own file because the rest of the suite pins
// BASE_DELAY_MS=30 so other tests run fast — which makes any timing assertion
// there meaningless: an escalating backoff off a 30ms base looks *faster* than
// the production config it is meant to be compared against.
//
// Here nothing is overridden except what must be: auto-update off, reanimation
// off, and storage redirected to a temp dir. The delays under test are the real
// ones a user gets.
//
//   node tests/fastretry.mjs
//
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0"
process.env.OPENCODE_RESUME_REANIMATE = "0"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"

// Explicitly shipped values (defaults at the time of writing).
process.env.OPENCODE_RESUME_FAST_RETRY ??= "true"
process.env.OPENCODE_RESUME_FAST_RETRY_BASE_MS ??= "1200"
process.env.OPENCODE_RESUME_FAST_RETRY_GROWTH ??= "1.5"
process.env.OPENCODE_RESUME_FAST_RETRY_MAX_MS ??= "8000"
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "5000"

import { tmpdir } from "node:os"
import { join } from "node:path"

let n = 0
const dir = () => join(tmpdir(), `ar-fr-${process.pid}-${++n}`)
for (const k of ["STOPSTORE", "OFFSTORE", "PAUSESTORE", "HEALTHSTORE", "ACTIVESTORE"]) {
  process.env[`OPENCODE_RESUME_${k}`] = dir()
}
await (await import("node:fs")).promises.writeFile(process.env.OPENCODE_RESUME_ACTIVESTORE, "{}")

const plugin = (await import("../auto-resume.js")).default

let failures = 0
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const S = "ses_fastretry"
const ATTEMPTS = 4
const ev = (type, data) => ({
  id: "evt", created: Date.now(), type,
  durable: { aggregateID: S, seq: 1, version: 1 },
  location: { directory: "C:/p" }, data,
})

const ERR_403 = ev("session.step.failed", {
  sessionID: S,
  error: { type: "APIError", message: "Provider request failed with HTTP 403", status: 403 },
})

/** Drive a persistent outage: every resumed attempt fails again. */
async function measureGaps(rotateEnabled) {
  if (rotateEnabled === true) process.env.OPENCODE_RESUME_ROTATION_ENABLED = "true"
  else delete process.env.OPENCODE_RESUME_ROTATION_ENABLED

  const stamps = []
  const logs = []
  const queue = []
  let notify = () => {}
  const next = () => new Promise((r) => {
    const v = queue.shift()
    if (v !== undefined) return r(v)
    notify = () => { notify = () => {}; r(queue.shift()) }
  })

  const ctx = {
    app: { version: "2.0.30", log: async ({ body } = {}) => { if (body?.message) logs.push(body.message); return true } },
    permission: { hook: async () => ({ dispose: async () => {} }) },
    event: { subscribe: async function* () { while (true) yield await next() } },
    session: {
      get: async ({ sessionID }) => { if (sessionID !== S) throw new Error("no such"); return { id: sessionID, title: "t", time: { updated: Date.now() } } },
      context: async () => [],
      update: async () => true,
      interrupt: async () => true,
      compact: async () => ({}),
      create: async () => ({}),
      prompt: async (i) => {
        stamps.push(Date.now())
        // The outage continues: the attempt we just made fails identically.
        // A step.end first, otherwise the session still reads as BUSY and the
        // engine adds a 5s busy-poll to every gap, which would measure the
        // poll interval rather than the retry schedule.
        queue.push(ev("session.step.ended", {
          sessionID: S, assistantMessageID: `m_${stamps.length}`, finish: "error",
        }))
        queue.push(ERR_403)
        notify()
        return {}
      },
    },
    provider: { list: async () => [] },
  }

  const dispose = await plugin.setup(ctx)
  queue.push(ev("session.step.started", { sessionID: S, assistantMessageID: "m1" }))
  queue.push(ERR_403)
  notify()

  const deadline = Date.now() + 120_000
  while (stamps.length < ATTEMPTS && Date.now() < deadline) await sleep(50)
  dispose()
  return stamps.slice(1).map((t, i) => t - stamps[i])
}

// ---- G1: rotation off (the default) retries fast and consecutively ---------
const fast = await measureGaps(false)
{
  ok(fast.length === ATTEMPTS - 1,
    `G1: ${ATTEMPTS} attempts all fired (got ${fast.length + 1})`)
  if (fast.length) {
    // Shipped config: 1.2s base, 1.5x growth, 8s cap, +-25% jitter.
    const ceiling = 8_000 * 1.25
    ok(fast.every((g) => g < ceiling),
      `G1: every gap is under the 8s cap + jitter (${fast.map((g) => (g / 1000).toFixed(1) + "s").join(", ")})`)
    // The decisive one: the old escalating backoff started at 5s and doubled,
    // so its FIRST gap was already >5s. Anything under that proves the fast
    // path is in use rather than the old schedule.
    ok(fast[0] < 5_000,
      `G1: the first retry is well under the old 5s base (${(fast[0] / 1000).toFixed(2)}s)`)
    const span = fast.at(-1)
    ok(span < 30_000,
      `G1: all ${ATTEMPTS} attempts inside 30s (${(span / 1000).toFixed(1)}s)`)
  } else {
    ok(false, "G1: not enough attempts to measure")
  }
}

// ---- G2: growth is gentle, not doubling ------------------------------------
if (fast.length >= 3) {
  const ratios = fast.slice(1).map((g, i) => g / Math.max(fast[i], 1))
  // 1.5x nominal + jitter can stretch a ratio; allow generous slack but catch a
  // return to the old 2x doubling.
  ok(ratios.every((r) => r < 2.6),
    `G2: growth stays gentle (ratios ${ratios.map((r) => r.toFixed(2)).join(", ")})`)
}

// ---- G3: rotation ON keeps the slower ramp (budget protection) -------------
// With rotation the next attempt lands on a DIFFERENT model; spacing them out
// stops the fast burst from draining the replacement's budget as fast as the
// previous one ran dry. This is a deliberate difference, not an oversight.
const slow = await measureGaps(true)
{
  // With rotation on, `backoff()` grows 5s, 10s, 20s, 40s… so the 5th attempt
  // would need ~75s. The budget below only asks for enough attempts to prove
  // the FIRST wait differs, which is the whole point of G3.
  ok(slow.length >= 2,
    `G3: attempts fired with rotation on (got ${slow.length + 1})`)
  if (slow.length && fast.length) {
    ok(slow[0] >= 4_000,
      `G3: with rotation on the first wait uses the full base (${(slow[0] / 1000).toFixed(2)}s)`)
    ok(slow[0] > fast[0],
      `G3: rotation-on waits longer than rotation-off (${(slow[0] / 1000).toFixed(2)}s vs ${(fast[0] / 1000).toFixed(2)}s)`)
  } else {
    ok(false, "G3: not enough attempts to measure")
  }
}

console.log(failures ? "FAST RETRY TESTS FAILED" : "ALL FAST RETRY TESTS PASSED")
process.exitCode = failures ? 1 : 0