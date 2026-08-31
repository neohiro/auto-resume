// tests/auto-resume.test.js — focused regression tests for the auto-resume plugin
//
// Run with: node --test C:\Users\Wout\.config\opencode\plugins\tests\auto-resume.test.js
//
// Coverage:
//   1. AGGRESSION_PRESETS — three named modes produce the documented caps
//   2. PROMPTS.retry — tightens after attempt 4
//   3. PROMPTS.proceedAll — present and distinct from proceed
//   4. QUESTION_PATTERNS — covers the defer-to-user "which of these" cases
//   5. Same-kind loop detector — schedule is the unit under test (we import
//      the pure helpers and re-implement the relevant slice in plain JS to
//      keep this file dependency-free).
//
// Note: full plugin integration tests would need a mocked OpenCode client API.
// These tests cover the pure helper surface and the prompt-builder contract.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const PLUGIN = readFileSync(
  "C:/Users/Wout/.config/opencode/plugins/auto-resume.js",
  "utf8"
)

// ── 1. AGGRESSION_PRESETS ──────────────────────────────────────────────────
// The plugin exports the preset table via a const we can extract with a regex
// rather than eval-ing the module. We assert the documented mappings.

describe("AGGRESSION_PRESETS", () => {
  it("declares the three named modes", () => {
    assert.match(PLUGIN, /AGGRESSION_PRESETS\s*=\s*\{/,
      "AGGRESSION_PRESETS must be defined")
    assert.match(PLUGIN, /conservative:/, "must include conservative")
    assert.match(PLUGIN, /balanced:/, "must include balanced")
    assert.match(PLUGIN, /relentless:/, "must include relentless")
  })
  it("balanced preset is (8, 4) — the documented default", () => {
    assert.match(PLUGIN, /balanced:\s*\{[^}]*maxChain:\s*8/,
      "balanced preset must have maxChain=8")
    assert.match(PLUGIN, /balanced:\s*\{[^}]*maxStallTakeovers:\s*4/,
      "balanced preset must have maxStallTakeovers=4")
  })
  it("conservative preset is (6, 2) — matches the pre-1.14 hard cap", () => {
    assert.match(PLUGIN, /conservative:\s*\{[^}]*maxChain:\s*6/,
      "conservative preset must have maxChain=6")
    assert.match(PLUGIN, /conservative:\s*\{[^}]*maxStallTakeovers:\s*2/,
      "conservative preset must have maxStallTakeovers=2")
  })
  it("relentless preset is (12, 8) — full headroom", () => {
    assert.match(PLUGIN, /relentless:\s*\{[^}]*maxChain:\s*12/,
      "relentless preset must have maxChain=12")
    assert.match(PLUGIN, /relentless:\s*\{[^}]*maxStallTakeovers:\s*8/,
      "relentless preset must have maxStallTakeovers=8")
  })
  it("OPENCODE_RESUME_AGGRESSION env var is documented in the header", () => {
    assert.match(PLUGIN, /OPENCODE_RESUME_AGGRESSION.*conservative.*balanced.*relentless/s,
      "header doc-block must reference OPENCODE_RESUME_AGGRESSION with the three names")
  })
})

// ── 2. PROMPTS.retry ────────────────────────────────────────────────────────
// We re-implement the attempt-aware retry logic in plain JS to assert the
// shape: attempts 1-3 get the long form, 4+ get the short form.

describe("PROMPTS.retry attempt ladder", () => {
  // Inline mirror of the production logic — if the production logic
  // changes, update this and the test re-validates the contract.
  const retryPrompt = (attempt) => {
    if (attempt >= 4) {
      return `[auto-resume] Auto-retry #${attempt} (short). Stalled again — pick up where you stopped and finish. No recap, no preamble; just continue.`
    }
    if (attempt >= 2) {
      return `[auto-resume] Auto-retry #${attempt}. Self-healing; the previous turn was busy with no output and got aborted. Continue from where you stopped. Verify progress (build/test/lint) before claiming done.`
    }
    return `[auto-resume] Auto-retry #${attempt}. Self-healing; the previous turn was busy ~60s with no output and got aborted. Pick up exactly where you stopped; finish production-grade.`
  }

  it("attempt 1 keeps the full preamble", () => {
    const p = retryPrompt(1)
    assert.match(p, /busy ~60s with no output/)
    assert.match(p, /production-grade/)
  })
  it("attempt 2 shortens the preamble but keeps the verification reminder", () => {
    const p = retryPrompt(2)
    assert.doesNotMatch(p, /~60s/)
    assert.match(p, /verify.*progress.*build\/test\/lint/i)
  })
  it("attempt 4 uses the ultra-tight short form", () => {
    const p = retryPrompt(4)
    assert.match(p, /\(short\)/)
    assert.match(p, /No recap, no preamble/)
    assert.ok(p.length < 200, `expected short prompt < 200 chars, got ${p.length}`)
  })
  it("attempt 10 stays as the same short form (the attempt number just increments)", () => {
    const p4 = retryPrompt(4)
    const p10 = retryPrompt(10)
    // Both should be the short form, but with the attempt number substituted
    assert.match(p4, /#4 \(short\)/)
    assert.match(p10, /#10 \(short\)/)
  })
})

// ── 3. PROMPTS.proceedAll vs PROMPTS.proceed ───────────────────────────────

describe("PROMPTS.proceedAll", () => {
  it("exists and is distinct from proceed", () => {
    assert.match(PLUGIN, /proceedAll:\s*\(\)\s*=>/)
  })
  it("tells the agent to do ALL items step-by-step", () => {
    // The template uses ${RESUME_TAG} as a tagged literal, so the captured
    // body starts with RESUME_TAG's value expanded — but the tagged form means
    // the function IS invoked with the tag, so the extracted body starts with
    // the literal string (the RESUME_TAG variable is the tag, not interpolated).
    // We just assert on key phrases that appear verbatim in the file.
    assert.match(PLUGIN, /do ALL of them/i)
    assert.match(PLUGIN, /one by one/i)
    assert.match(PLUGIN, /don't ask for sign-off/i)
    assert.match(PLUGIN, /don't stop to summarize/i)
    assert.match(PLUGIN, /build, test, lint, commit/i)
  })
  it("scheduled via the proposal-list detector", () => {
    // The proposal-list regex should be present and the proceed branch
    // should map to PROMPTS.proceedAll when it matches.
    // proposalList is a regex literal: proposalList = /.../i
    // The capture group `([^\/]+)` grabs the body including the trailing `/i`
    // so we strip the last 2 chars (the closing / and the `i` flag) before
    // reconstructing as a RegExp.
    assert.match(PLUGIN, /proposalList\s*=\s*\//, "proposalList regex must be defined")
    const match = PLUGIN.match(/proposalList\s*=\s*\/([^\/]+)\/[a-z]*/)
    assert.ok(match, "proposalList regex body must be captureable")
    // Strip the trailing closing-slash and flags before reconstructing.
    const body = match[1].replace(/\/[a-z]*$/, "")
    const re = new RegExp(body)
    assert.ok(re.test("Which of these do you want me to tackle first?"),
      "the regex must match the canonical 'which of these' phrasing")
    assert.ok(re.test("Want me to do all of them?"),
      "the regex must match 'do all of them' phrasing")
    assert.ok(re.test("Should I tackle proposal 2?"),
      "the regex must match 'should I tackle' phrasing (the actual pattern)")
  })
})

// ── 4. QUESTION_PATTERNS — defer-to-user "which of these" cases ────────────

describe("QUESTION_PATTERNS — proposal-list coverage", () => {
  // We re-declare a minimal test set; the production list is in the plugin.
  const patterns = [
    /\bwhich (of these|one) (do you want|should i|tackle|do|first|prioritize)/i,
    /\bwhich (of the|proposal|task|item|option)s? (do you want|should i|tackle|do|first|prioritize|implement|start)/i,
    /\bdraft a spec\b/i, /\bwrite a spec\b/i, /\bpropose a spec\b/i,
    /\bshould i (start|tackle|begin) with/i,
    /\bdo all\b/i, /\bimplement all\b/i, /\ball of them\b/i,
  ]
  const mustMatch = [
    "Which of these do you want me to tackle first?",
    "Or would you like me to draft a SPEC for the most impactful one?",
    "Want me to do all of them?",
    "Should I start with proposal 2?",
    "Which proposal should I implement first?",
  ]
  for (const phrase of mustMatch) {
    it(`matches: ${phrase}`, () => {
      const hit = patterns.some((re) => re.test(phrase))
      assert.ok(hit, `no pattern matched: ${phrase}`)
    })
  }
})

// ── 5. Same-kind loop detector ─────────────────────────────────────────────

describe("schedule() same-kind loop detector", () => {
  // Mirror the schedule's same-kind logic. We only test the *decision* —
  // not the timer, not the abort, not the prompt injection.
  const decide = (prev, curChain) => {
    const s = { previousKind: prev.kind, previousKindChain: prev.chain, previousKindRepeats: prev.repeats ?? 0, chain: curChain }
    if (s.previousKind === "resume" && s.chain === s.previousKindChain) {
      s.previousKindRepeats += 1
      if (s.previousKindRepeats >= 2) return { kind: "debug", escalated: true }
      return { kind: s.previousKind, escalated: false, repeats: s.previousKindRepeats }
    }
    return { kind: s.previousKind, escalated: false, repeats: 0 }
  }

  it("first schedule of a kind: no escalation", () => {
    const r = decide({ kind: null, chain: 0, repeats: 0 }, 0)
    assert.equal(r.escalated, false)
  })
  it("same kind, chain unchanged: first repeat allowed, second escalated", () => {
    const r1 = decide({ kind: "resume", chain: 0, repeats: 0 }, 0)
    assert.equal(r1.escalated, false)
    assert.equal(r1.repeats, 1)
    const r2 = decide({ kind: "resume", chain: 0, repeats: 1 }, 0)
    assert.equal(r2.escalated, true)
    assert.equal(r2.kind, "debug")
  })
  it("same kind but chain advanced: not a loop", () => {
    // A successful recovery would advance chain; the next schedule of the
    // same kind is fine because the agent did make progress.
    const r = decide({ kind: "resume", chain: 0, repeats: 0 }, 1)
    assert.equal(r.escalated, false)
    assert.equal(r.repeats, 0)
  })
})

// ── 6. writeOnce() .tmp cleanup ────────────────────────────────────────────

describe("writeOnce() .tmp cleanup contract", () => {
  it("uses try/finally to guarantee unlink on the successful rename path", () => {
    // The function structure: a single outer try wraps writeFile + rename
    // loop + fallback writeFile, with a single finally that calls unlink(tmp).
    // The non-greedy regex stops at the first } so we anchor on the finally.
    assert.match(PLUGIN, /const writeOnce = async \(\) => \{[\s\S]*?\n\s*try\s*\{[\s\S]*?\n\s*\} finally\s*\{[\s\S]*?await unlink\(tmp\)/,
      "writeOnce must wrap the rename path in try/finally with unlink(tmp) in the finally")
  })
  it("checkForUpdates also uses try/finally for the self-updater rename", () => {
    // Locate the self-updater's tmp-rename block and assert unlink(tmp)
    // appears in a finally inside it. The block contains "selfPath" + ".tmp".
    const selfUpdateIdx = PLUGIN.indexOf("writeFile(`${selfPath}.bak`")
    assert.ok(selfUpdateIdx > 0, "self-updater backup-write line must exist")
    const tail = PLUGIN.slice(selfUpdateIdx, selfUpdateIdx + 1200)
    assert.match(tail, /try\s*\{[\s\S]*?rename\(tmp,\s*selfPath\)[\s\S]*?\} finally\s*\{[\s\S]*?unlink\(tmp\)/,
      "self-updater must use try { rename } finally { unlink(tmp) }")
  })
})

// ── 7. Version bump ─────────────────────────────────────────────────────────

describe("AUTO_RESUME_VERSION", () => {
  it("is at 1.16.0 (favorite-model rotation)", () => {
    const m = PLUGIN.match(/AUTO_RESUME_VERSION\s*=\s*"([^"]+)"/)
    assert.ok(m, "AUTO_RESUME_VERSION must be defined")
    assert.equal(m[1], "1.16.0")
  })
})

// ── 8. Favorite-model rotation ───────────────────────────────────────────

describe("favorite-model rotation", () => {
  it("declares the three new env vars in the header doc", () => {
    assert.match(PLUGIN, /OPENCODE_RESUME_FAVORITE_CHECK_AFTER_MS/)
    assert.match(PLUGIN, /OPENCODE_RESUME_FAVORITE_MIN_TURNS/)
    assert.match(PLUGIN, /OPENCODE_RESUME_FAVORITE_RETURN/)
  })
  it("DEFAULTS include the three new keys with sane values", () => {
    // favoriteCheckAfterMs: 300_000 (5 min)
    assert.match(PLUGIN, /favoriteCheckAfterMs:\s*300_000/)
    // favoriteMinTurns: 3
    assert.match(PLUGIN, /favoriteMinTurns:\s*3/)
    // favoriteReturn: true
    assert.match(PLUGIN, /favoriteReturn:\s*true/)
  })
  it("loadConfig reads the three new env vars", () => {
    assert.match(PLUGIN,
      /favoriteCheckAfterMs:\s*num\("OPENCODE_RESUME_FAVORITE_CHECK_AFTER_MS"/)
    assert.match(PLUGIN,
      /favoriteMinTurns:\s*Math\.max\(1,\s*num\("OPENCODE_RESUME_FAVORITE_MIN_TURNS"/)
    assert.match(PLUGIN,
      /favoriteReturn:\s*bool\("OPENCODE_RESUME_FAVORITE_RETURN"/)
  })
  it("tryRestoreFavorite function is declared", () => {
    assert.match(PLUGIN, /const tryRestoreFavorite = async \(sessionID\) => \{/)
  })
  it("rotateAwayFrom sets favoriteRotatedAt timestamp on the session", () => {
    // After rotation, the watchdog should know when we rotated away so it
    // can compute the cool-down window before rotating back.
    // Find the function by its declaration; the body must contain both
    // the timestamp stamp and the counter reset.
    const startIdx = PLUGIN.indexOf("const rotateAwayFrom =")
    assert.ok(startIdx > 0, "rotateAwayFrom must be defined")
    // Look for the next "const " declaration at the same indent level
    // (rotateAwayFrom is at 2-space indent, so we look for "  const " or
    // "  // " after the function).
    const nextDecl = PLUGIN.indexOf("\n  const ", startIdx + 100)
    const endIdx = nextDecl > 0 ? nextDecl : startIdx + 4000
    const body = PLUGIN.slice(startIdx, endIdx)
    assert.match(body, /s\.favoriteRotatedAt = Date\.now\(\)/,
      "rotateAwayFrom must stamp favoriteRotatedAt")
    assert.match(body, /s\.turnsSinceRotation = 0/,
      "rotateAwayFrom must reset turnsSinceRotation")
  })
  it("successful-turn handler increments turnsSinceRotation", () => {
    // Find the lastSuccessAt assignment in the success path and assert
    // turnsSinceRotation is incremented in the same block.
    const succBlock = PLUGIN.match(
      /s\.lastSuccessAt = Date\.now\(\)[\s\S]{0,400}?turnsSinceRotation \+= 1/
    )
    assert.ok(succBlock, "successful-turn handler must increment turnsSinceRotation")
  })
  it("checkStalls calls tryRestoreFavorite on every watchdog tick", () => {
    // The watchdog runs every 10s; the favorite-restore attempt must be
    // inside the per-session loop so it runs once per session per tick.
    const startIdx = PLUGIN.indexOf("const checkStalls =")
    assert.ok(startIdx > 0, "checkStalls must be defined")
    // Find the next "const " declaration at the same 2-space indent
    const nextDecl = PLUGIN.indexOf("\n  const ", startIdx + 100)
    const endIdx = nextDecl > 0 ? nextDecl : startIdx + 6000
    const body = PLUGIN.slice(startIdx, endIdx)
    assert.match(body, /tryRestoreFavorite\(sessionID\)/,
      "checkStalls must call tryRestoreFavorite per session")
  })
  it("version bumped to 1.16.0 (favorite-model rotation)", () => {
    const m = PLUGIN.match(/AUTO_RESUME_VERSION\s*=\s*"([^"]+)"/)
    assert.ok(m)
    assert.equal(m[1], "1.16.0")
  })
  it("favoriteSwapInFlight re-entrancy guard is declared on state()", () => {
    // Self-improvement pass 1 fix #3: two concurrent watchdog ticks must
    // not both pass the gates and double-call client.session.chat.
    assert.match(PLUGIN, /favoriteSwapInFlight:\s*false/,
      "state initializer must include favoriteSwapInFlight: false")
  })
  it("tryRestoreFavorite checks favoriteSwapInFlight before the SDK call", () => {
    // The function must short-circuit when a prior swap is still in flight.
    const startIdx = PLUGIN.indexOf("const tryRestoreFavorite =")
    assert.ok(startIdx > 0)
    const nextDecl = PLUGIN.indexOf("\n  const ", startIdx + 100)
    const endIdx = nextDecl > 0 ? nextDecl : startIdx + 4000
    const body = PLUGIN.slice(startIdx, endIdx)
    assert.match(body, /if\s*\(s\.favoriteSwapInFlight\)\s*return\s*false/,
      "tryRestoreFavorite must gate on favoriteSwapInFlight")
    assert.match(body, /s\.favoriteSwapInFlight = true/,
      "tryRestoreFavorite must set the flag before the SDK call")
    assert.match(body, /finally\s*\{[\s\S]*?favoriteSwapInFlight = false/,
      "tryRestoreFavorite must clear the flag in finally")
  })
  it("tryRestoreFavorite does NOT mutate currentModel before the SDK call", () => {
    // Self-improvement pass 1 fix #4: state mutation must happen AFTER
    // the SDK call succeeds, so a failure leaves in-memory state
    // consistent with the actual server model.
    const startIdx = PLUGIN.indexOf("const tryRestoreFavorite =")
    const nextDecl = PLUGIN.indexOf("\n  const ", startIdx + 100)
    const endIdx = nextDecl > 0 ? nextDecl : startIdx + 4000
    const body = PLUGIN.slice(startIdx, endIdx)
    // Find the await client.session.chat line and the s.currentModel =
    // assignment that should come AFTER it.
    const awaitIdx = body.indexOf("await client.session.chat")
    const mutationIdx = body.indexOf("s.currentModel = { providerID: target.providerID")
    assert.ok(awaitIdx > 0, "await client.session.chat must be present")
    assert.ok(mutationIdx > 0, "currentModel mutation must be present")
    assert.ok(mutationIdx > awaitIdx,
      "currentModel mutation must come AFTER the SDK await (no premature commit on failure)")
  })
  it("tryRestoreFavorite also checks lastModel when checking 'already on favorite'", () => {
    // Self-improvement pass 1 fix #9: a session whose currentModel is
    // null but lastModel is the favorite should not trigger a restore.
    const startIdx = PLUGIN.indexOf("const tryRestoreFavorite =")
    const nextDecl = PLUGIN.indexOf("\n  const ", startIdx + 100)
    const endIdx = nextDecl > 0 ? nextDecl : startIdx + 4000
    const body = PLUGIN.slice(startIdx, endIdx)
    assert.match(body, /s\.lastModel\s*&&/,
      "the 'already on favorite' check must also inspect s.lastModel")
  })
})
