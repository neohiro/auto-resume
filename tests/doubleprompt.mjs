// Regression suite for the double-prompt race and its two siblings.
//
//   DP1 — a real user message must not blow up the event handler.
//         (The handler used to touch an in-scope-only variable
//         `sessionErrorSynthLock` -> ReferenceError on every user turn.)
//   DP2 — two recovery plans for the same session must never be dispatched
//         CONCURRENTLY. The generic resume prompt awaits session.status()
//         before it stamps its dedupe marker, so an overlapping second
//         dispatch used to slip past the guard and produce two
//         byte-identical prompts a few milliseconds apart (301 such pairs
//         were found in the local OpenCode store).
//   DP3 — clearing a pending timer must release that plan's schedule key,
//         otherwise the kind is booked forever and every later plan of it
//         is silently dropped (a MISSED prompt, the mirror image of the bug).
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.OPENCODE_RESUME_STOPSTORE ??= join(tmpdir(), `ar-dp-stops-${process.pid}-${Date.now()}.json`)
process.env.OPENCODE_RESUME_OFFSTORE ??= join(tmpdir(), `ar-dp-off-${process.pid}-${Date.now()}.json`)
process.env.OPENCODE_RESUME_ACTIVESTORE ??= join(tmpdir(), `ar-dp-active-${process.pid}-${Date.now()}.json`)

import { createEngine } from "../auto-resume.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (type, properties) => ({ event: { type, properties } })

let failures = 0
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) failures += 1
}

function makeClient(state) {
  return {
    app: {
      log: async ({ body }) => { state.logs.push(body?.message ?? ""); return true },
      toast: async () => {},
    },
    session: {
      status: async () => {
        state.statusPending = true
        state.statusCalls += 1
        await sleep(state.statusDelay)
        state.statusPending = false
        // "idle" everywhere: the resume plan must not fall into the busy-poll
        // branch, it just has to spend the await time.
        return { data: { sess: { type: "idle" } } }
      },
      prompt: async ({ path, body }) => {
        state.prompts.push({
          id: path?.id,
          text: body?.parts?.[0]?.text ?? "",
          model: body?.model,
          duringStatus: state.statusPending,
          at: Date.now(),
        })
        return { data: { info: {}, parts: [] } }
      },
      abort: async ({ path }) => { state.aborts.push(path?.id); return true },
      summarize: async ({ path }) => { state.summarizes.push(path?.id); return true },
      messages: async () => ({ data: [] }),
    },
  }
}

async function freshState(statusDelay = 0) {
  const state = { prompts: [], aborts: [], summarizes: [], logs: [], statusPending: false, statusCalls: 0, statusDelay }
  const hooks = await createEngine({ client: makeClient(state) })
  return { state, hooks }
}

// ---- DP1: a real user turn must not crash the event handler ---------------
{
  const { state, hooks } = await freshState(0)
  // The user message text is fetched to check whether the turn is ours; the
  // mock returns a foreign text, so this is treated as a genuine user turn.
  let threw = null
  try {
    await hooks.event(ev("message.updated", { info: { sessionID: "sessDP1", id: "m-user", role: "user" } }))
  } catch (e) {
    threw = e
  }
  ok(!threw, `DP1: user event resolved without throwing (${threw?.message ?? "no throw"})`)
  ok(!state.logs.some((m) => /failed:|ReferenceError/.test(m)), "DP1: no handler failure logged")
}

// ---- DP2: no two dispatches in flight at the same time --------------------
{
  const { state, hooks } = await freshState(200)
  // First failure -> generic "resume" plan. Its dispatch awaits session.status().
  await hooks.event(ev("session.error", {
    sessionID: "sessDP2",
    error: { name: "APIError", data: { statusCode: 503, isRetryable: false, message: "upstream error" } },
  }))
  // Let the resume timer fire (base delay 30ms) so the dispatch is inside the
  // 200ms status await, then raise a SECOND, different failure.
  await sleep(60)
  await hooks.event(ev("session.error", {
    sessionID: "sessDP2",
    error: { name: "QuotaError", data: { message: "quota exceeded" } },
  }))
  await sleep(1200)
  const concurrent = state.prompts.filter((p) => p.duringStatus)
  ok(concurrent.length === 0, `DP2: no prompt dispatched while another dispatch was in flight (${concurrent.length})`)
  ok(state.prompts.length >= 1, `DP2: recovery still happened (${state.prompts.length} prompt(s))`)
  // No two byte-identical prompts back to back.
  let identical = 0
  for (let i = 1; i < state.prompts.length; i += 1) {
    if (state.prompts[i].text === state.prompts[i - 1].text && state.prompts[i].at - state.prompts[i - 1].at < 3000) identical += 1
  }
  ok(identical === 0, `DP2: no byte-identical prompt pairs (${identical})`)
}

// ---- DP3: a cleared timer must release its schedule key -------------------
{
  const { state, hooks } = await freshState(0)
  // 1st: output-length failure -> "continue" plan (nudge delay 30ms).
  await hooks.event(ev("session.error", {
    sessionID: "sessDP3",
    error: { name: "MessageOutputLengthError", data: { message: "run1" } },
  }))
  await sleep(5)
  // 2nd: a network failure -> "resume" plan; scheduling it REPLACES the
  // pending continue timer. That must release the continue key.
  await hooks.event(ev("session.error", {
    sessionID: "sessDP3",
    error: { name: "APIError", data: { statusCode: 502, isRetryable: false, message: "down" } },
  }))
  await sleep(200)
  // 3rd: another output-length failure -> must be schedulable again.
  await hooks.event(ev("session.error", {
    sessionID: "sessDP3",
    error: { name: "MessageOutputLengthError", data: { message: "run2" } },
  }))
  await sleep(300)
  const continues = state.prompts.filter((p) => p.text.includes("max output length"))
  ok(continues.length >= 1, `DP3: continue prompt still schedulable after a timer swap (${continues.length})`)
}

if (failures) {
  console.error(`\n${failures} doubleprompt regression check(s) failed`)
  process.exit(1)
}
console.log("\n=== doubleprompt regression: all pass ===")
