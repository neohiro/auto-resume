// V2 entrypoint contract tests.
//
// Exercises the REAL default export ({ id, setup(ctx) }) against a mock V2
// plugin context. The V1 engine suites (v2/v3/v4/stop/...) call the engine
// directly with a V1 client, so nothing else would catch a break in the V2
// adapter itself: a plugin that fails to load at all under OpenCode 2 is
// exactly the regression this file guards against.
//
//   node tests/v2entry.mjs
//
process.env.OPENCODE_RESUME_BASE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_RATE_LIMIT_BASE_MS ??= "40"
process.env.OPENCODE_RESUME_MAX_DELAY_MS ??= "500"
process.env.OPENCODE_RESUME_NUDGE_DELAY_MS ??= "30"
process.env.OPENCODE_RESUME_NOTICE_THROTTLE_MS ??= "0"
process.env.OPENCODE_RESUME_AUTO_UPDATE ??= "0" // never hit the network in CI
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolated sidecar stores so a persisted stop/opt-out from the real plugin
// directory can never poison these assertions.
process.env.OPENCODE_RESUME_STOPSTORE ??= join(tmpdir(), `ar-v2e-stops-${process.pid}-${Date.now()}.json`)
process.env.OPENCODE_RESUME_OFFSTORE ??= join(tmpdir(), `ar-v2e-off-${process.pid}-${Date.now()}.json`)

import plugin, { AutoResumePlugin } from "../auto-resume.js"

const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Build a mock V2 plugin context.
 *  `events` is an array of V2 events to replay on subscribe; the harness
 *  records every client call the adapter makes so the bridging can be
 *  asserted directly (not just its downstream effects). */
function makeCtx(state, { events = [], messages = [], envelope = "properties" } = {}) {
  const recorded = state.calls
  const wrap = (data) => (envelope === "data" ? { data } : data)

  const sessionMessages = { list: async ({ sessionID }) => { recorded.push(["message.list", sessionID]); return wrap(messages) } }

  const ctx = {
    app: { version: "2.0.30", log: async ({ body }) => { recorded.push(["app.log", body?.message]) ; return true } },
    event: {
      subscribe: async function* ({ signal } = {}) {
        recorded.push(["subscribe"])
        for (const ev of events) {
          if (signal?.aborted) return
          // Mirror the server's encoding choice for this run.
          if (envelope === "properties") yield { type: ev.type, properties: ev.properties ?? {} }
          else if (envelope === "data") yield { type: ev.type, data: ev.properties ?? {} }
          else yield { type: ev.type, ...(ev.properties ?? {}) } // flattened
        }
        // Stay open until aborted so the adapter's abort path is exercised.
        await new Promise((resolve) => {
          if (signal) signal.addEventListener("abort", resolve, { once: true })
          else resolve()
        })
      },
    },
    session: {
      list: async () => { recorded.push(["session.list"]); return wrap([]) },
      get: async ({ sessionID }) => { recorded.push(["session.get", sessionID]); return wrap({ id: sessionID, title: "t" }) },
      update: async ({ sessionID, title }) => { recorded.push(["session.update", sessionID, title]); return true },
      prompt: async (input) => {
        recorded.push(["session.prompt", input.sessionID, input.text, input.model?.providerID ?? null])
        state.prompts.push({ id: input.sessionID, text: input.text, model: input.model })
        return wrap({ id: "inbox_1" })
      },
      interrupt: async ({ sessionID }) => { recorded.push(["session.interrupt", sessionID]); return true },
      compact: async ({ sessionID }) => { recorded.push(["session.compact", sessionID]); return wrap({ id: "cmp_1" }) },
      message: sessionMessages,
      permission: {
        reply: async (arg) => {
          recorded.push(["permission.reply", arg.sessionID, arg.requestID, arg.reply])
          state.permResponses.push({ sessionID: arg.sessionID, requestID: arg.requestID, reply: arg.reply })
          return true
        },
      },
    },
    provider: {
      list: async () => { recorded.push(["provider.list"]); return wrap([{ id: "anthropic", models: { "m1": {} } }]) },
    },
    location: { directory: "C:/proj", project: { id: "p1", directory: "C:/proj", canonical: "C:/proj" } },
  }
  return ctx
}

const baseState = () => ({ calls: [], prompts: [], permResponses: [], logs: [] })

// ---- L1: the module shape the V2 loader requires ---------------------------
{
  ok(plugin && typeof plugin === "object", "L1: default export is an object")
  ok(plugin?.id === "auto-resume", `L1: default export carries a stable id (${plugin?.id})`)
  ok(typeof plugin?.setup === "function", "L1: default export provides setup(ctx)")
  // V1 entrypoint must survive for V1 runtimes and the direct-engine suites.
  ok(typeof AutoResumePlugin === "function", "L1: V1 AutoResumePlugin export retained")
}

// ---- L2: setup wires the engine and returns a cleanup ----------------------
{
  const state = baseState()
  const ctx = makeCtx(state, { events: [] })
  const dispose = await plugin.setup(ctx)
  ok(typeof dispose === "function", "L2: setup returns a cleanup function")
  await sleep(60)
  ok(state.calls.some(([m]) => m === "subscribe"), "L2: event subscription established")
  dispose()
  await sleep(30)
  ok(true, "L2: cleanup runs without throwing")
}

// ---- L3: V2 session.error -> resume prompt injected via ctx.session.prompt --
// This is the core promise of the plugin: an interrupted/errored turn is
// resumed. Exercised across all three stream encodings because the adapter must
// not depend on how the transport happens to nest the payload.
for (const envelope of ["properties", "data", "flat"]) {
  const state = baseState()
  const ctx = makeCtx(state, {
    envelope,
    events: [
      { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } },
      { type: "message.updated", properties: { sessionID: "s1", info: { id: "m0", type: "user", role: "user", time: { created: Date.now() } } } },
      { type: "session.error", properties: { sessionID: "s1", error: { type: "APIError", message: "fetch failed", status: 503 } } },
      // The failed turn ends: the session goes idle, which is when the engine
      // dispatches its queued resume.
      { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } },
    ],
  })
  const dispose = await plugin.setup(ctx)
  await sleep(500)
  const injected = state.prompts.filter((p) => p.id === "s1" && /auto-resume/i.test(p.text))
  ok(injected.length > 0,
    `L3[${envelope}]: session.error triggers a resume prompt through ctx.session.prompt (${injected.length})`)
  // The adapter must translate the V2 structured error into the V1 envelope the
  // classifier reads; a 5xx must be classified retryable, not auth/fatal.
  ok(!/authentication|api key/i.test(injected[0]?.text ?? ""),
    `L3[${envelope}]: 5xx error is not misread as an auth failure`)
  dispose()
}

// ---- L4: V2 permission.asked -> autopilot reply via ctx.permission.reply ----
{
  const state = baseState()
  const ctx = makeCtx(state, {
    events: [
      {
        type: "permission.asked",
        properties: {
          id: "per_1",
          sessionID: "s2",
          action: "external_directory",
          resources: ["C:/proj/vendor/**"],
        },
      },
    ],
  })
  const dispose = await plugin.setup(ctx)
  await sleep(300)
  ok(state.permResponses.length === 1,
    `L4: V2 permission.asked is answered through ctx.permission.reply (${state.permResponses.length})`)
  ok(state.permResponses[0]?.requestID === "per_1" && state.permResponses[0]?.sessionID === "s2",
    "L4: reply carries the request id and session id from the V2 payload")
  ok(["once", "always", "reject"].includes(state.permResponses[0]?.reply),
    `L4: reply uses a V2-valid decision (${state.permResponses[0]?.reply})`)
  dispose()
}

// ---- L5: dangerous shell permission is rejected, not granted ----------------
{
  const state = baseState()
  const ctx = makeCtx(state, {
    events: [
      {
        type: "permission.asked",
        properties: {
          id: "per_danger",
          sessionID: "s3",
          action: "bash",
          resources: ["rm -rf /"],
        },
      },
    ],
  })
  const dispose = await plugin.setup(ctx)
  await sleep(300)
  ok(state.permResponses[0]?.reply === "reject",
    `L5: dangerous command rejected via V2 (${state.permResponses[0]?.reply})`)
  dispose()
}

// ---- L6: message normalization — role mapping + text extraction -------------
// V2 replaced { role, parts } with a discriminated `type` and folded text into
// either `content[]` (assistant) or `text` (user/synthetic). The engine keys
// everything off info.role, and uses user-message text to recognize its OWN
// "[auto-resume]" injections so they don't count as a new human task. Both
// must survive the bridge.
{
  // (a) An assistant turn whose reply ends with an unchecked checklist drives
  //     the todo-drive — proving `type:"assistant"` maps to role + content maps
  //     to parts.
  const state = baseState()
  process.env.OPENCODE_AUTOPILOT_MAX_NUDGES = "1"
  const ctx = makeCtx(state, {
    messages: [
      { id: "m1", type: "assistant", model: { providerID: "o", id: "g" }, time: { completed: 1 },
        content: [{ type: "text", text: "Done with step one.\n- [x] scaffold\n- [ ] wire it up" }] },
    ],
    events: [
      { type: "session.status", properties: { sessionID: "sA", status: { type: "busy" } } },
      { type: "message.part.updated", properties: { sessionID: "sA", part: { type: "text", text: "wire it up" } } },
      { type: "session.idle", properties: { sessionID: "sA" } },
    ],
  })
  const disposeA = await plugin.setup(ctx)
  await sleep(500)
  ok(state.prompts.some((p) => p.id === "sA" && /todos unfinished/i.test(p.text)),
    "L6a: V2 assistant message (type/content) is understood and drives the todo-drive")
  disposeA()
  delete process.env.OPENCODE_AUTOPILOT_MAX_NUDGES

  // (b) A user message must yield readable text so the plugin can recognize its
  //     OWN injection. The engine reads user text back via session.message() and
  //     checks for the "[auto-resume]" tag; the adapter answers from the event
  //     it already saw (message cache) or the message list. If this broke, the
  //     plugin would treat every self-injection as a fresh human task and reset
  //     its task scope mid-run — a runaway loop. Observable signal: after a
  //     self-tagged injection, a subsequent idle that WOULD drive must still be
  //     gated by the injected prompt not counting as new work.
  const state2 = baseState()
  process.env.OPENCODE_AUTOPILOT_MAX_NUDGES = "1"
  const ctx2 = makeCtx(state2, {
    messages: [
      { id: "m1", type: "assistant", model: { providerID: "o", id: "g" }, time: { completed: 1 },
        content: [{ type: "text", text: "Step one done.\n- [ ] step two" }] },
    ],
    events: [
      { type: "session.status", properties: { sessionID: "sB", status: { type: "busy" } } },
      { type: "message.part.updated", properties: { sessionID: "sB", part: { type: "text", text: "step two" } } },
      { type: "session.idle", properties: { sessionID: "sB" } },
      { type: "session.status", properties: { sessionID: "sB", status: { type: "busy" } } },
      // Our own resume injection arrives as a user-role V2 message. It must be
      // recognized as ours and must NOT count as a new task (no scope reset).
      { type: "message.updated", properties: { sessionID: "sB", info: { id: "u_ours", type: "user", text: { text: "[auto-resume] Session idle, todos unfinished." }, time: { created: 3 } } } },
      { type: "session.status", properties: { sessionID: "sB", status: { type: "busy" } } },
      { type: "session.idle", properties: { sessionID: "sB" } },
    ],
  })
  const disposeB = await plugin.setup(ctx2)
  await sleep(500)
  const drives = state2.prompts.filter((p) => p.id === "sB" && /todos unfinished/i.test(p.text))
  // The self-injected prompt must not have reset the nudge budget: with a cap of
  // 1 the drive can only fire once even though idle fired twice.
  ok(drives.length === 1,
    `L6b: self-tagged V2 user injection does not reset task scope (drives=${drives.length}, expected 1)`)
  disposeB()
  delete process.env.OPENCODE_AUTOPILOT_MAX_NUDGES
}

// ---- L7: V2 has no todowrite tool, so the plan fallback must drive ----------
{
  process.env.OPENCODE_AUTOPILOT_MAX_NUDGES = "1"
  const state = baseState()
  const ctx = makeCtx(state, {
    // Plan stated two turns ago; the newest assistant reply is a bare
    // confirmation with no checklist. Without the cross-message fallback the
    // todo-drive would never fire under V2.
    messages: [
      { id: "msg_p1", type: "assistant", model: { providerID: "openai", id: "gpt-5" }, time: { created: 1 },
        content: [{ type: "text", text: "Plan:\n- [x] scaffold\n- [ ] implement\n- [ ] test" }] },
      { id: "msg_p2", type: "assistant", model: { providerID: "openai", id: "gpt-5" }, time: { created: 2 },
        content: [{ type: "text", text: "done for now" }] },
    ],
    events: [
      { type: "session.status", properties: { sessionID: "s5", status: { type: "busy" } } },
      { type: "message.part.updated", properties: { sessionID: "s5", part: { type: "text", text: "done for now" } } },
      { type: "session.idle", properties: { sessionID: "s5" } },
    ],
  })
  const dispose = await plugin.setup(ctx)
  await sleep(500)
  ok(state.prompts.some((p) => p.id === "s5" && /todos unfinished/i.test(p.text)),
    "L7: plan from an earlier reply still drives todo-drive under V2 (no todowrite tool)")
  dispose()
  delete process.env.OPENCODE_AUTOPILOT_MAX_NUDGES
}

// ---- L8: session.idle is routed even without a prior status event ----------
{
  const state = baseState()
  const ctx = makeCtx(state, {
    messages: [
      { id: "msg_i1", type: "assistant", model: { providerID: "openai", id: "gpt-5" }, time: { created: 1 },
        content: [{ type: "text", text: "Here is a fairly long substantive answer describing what was done in this turn, with enough characters to count as real output for the improvement pass to consider. All good here." }] },
    ],
    events: [
      { type: "message.part.updated", properties: { sessionID: "s6", part: { type: "text", text: "All good here." } } },
      { type: "session.idle", properties: { sessionID: "s6" } },
    ],
  })
  const dispose = await plugin.setup(ctx)
  await sleep(500)
  ok(state.prompts.some((p) => p.id === "s6" && /auto-resume/i.test(p.text)),
    "L8: session.idle alone drives the no-plan improvement/autopilot path")
  dispose()
}

// ---- L9: unknown events and malformed payloads must not throw --------------
{
  const state = baseState()
  const ctx = makeCtx(state, {
    events: [
      { type: "something.unknown", properties: { sessionID: "s7" } },
      { type: "message.updated", properties: null },
      { type: "session.error", properties: { sessionID: "s7" } },
      { type: "permission.asked", properties: {} },
      { type: "session.status", properties: {} },
    ],
  })
  const dispose = await plugin.setup(ctx)
  await sleep(200)
  ok(true, "L9: unknown/malformed events do not crash the adapter")
  dispose()
}

console.log(process.exitCode ? "V2 ENTRYPOINT TESTS FAILED" : "ALL V2 ENTRYPOINT TESTS PASSED")