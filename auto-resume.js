/**
 * auto-resume.js — resilience + unattended-autonomy plugin for OpenCode.
 * Install machine-wide:  ~/.config/opencode/plugins/auto-resume.js
 * (Do NOT also keep a project-level copy: global + project copies would both
 *  load and double-fire every hook.)
 *
 * ══════════════════════════════════════════════════════════════════
 *  RUNTIME SUPPORT — OpenCode 1.x AND OpenCode 2.x
 * ══════════════════════════════════════════════════════════════════
 *  OpenCode 2 does not run V1 plugins: its loader imports the module and
 *  requires the DEFAULT export to be a plugin definition carrying an `id` plus
 *  `setup(ctx)`. This file therefore exposes BOTH entrypoints from one module:
 *
 *    • `export default { id, setup(ctx) }`  — OpenCode 2.x (Promise plugin)
 *    • `export const createEngine`           — the engine itself, driven
 *      directly by the test suites against a bridged client
 *
 *  The V2 `setup` does not reimplement the engine. It builds a small adapter
 *  that maps the V2 plugin context onto the V1 SDK client the engine already
 *  speaks (`ctx.session.prompt({ sessionID, text })`,
 *  `ctx.session.interrupt(...)`, `ctx.permission.reply(...)`, ...), subscribes
 *  to `ctx.event.subscribe()`, normalizes each V2 event onto the V1
 *  `{ type, properties }` shape, and feeds that engine. See the
 *  "OPENCODE V2 ENTRYPOINT" section at the bottom of this file.
 *
 *  Two V2 platform changes are worth knowing about:
 *    • V2 has no `todowrite` tool and no `todo.updated` event. The TODO drive,
 *      improvement loop and wrap-up key off the plan the model writes inline
 *      (markdown checkboxes / a "next steps" list) instead of a structured todo
 *      tool. Detection scans the most recent such plan, so a plan stated a few
 *      turns ago keeps driving even when the newest reply is a short ack.
 *    • V2 removed `client.app.log`; log lines fall back to the server console.
 *
 * ══════════════════════════════════════════════════════════════════
 *  SUBSYSTEM 1 — RECOVERY (always on while plugin enabled)
 * ══════════════════════════════════════════════════════════════════
 * Keeps a turn alive whenever OpenCode's own internal retry gives up:
 *   • network/transport failures (ECONNRESET, fetch failed, DNS, TLS, ...)
 *   • provider outages (5xx, 529 overloaded, gateway errors)
 *   • request timeouts (408) — exponential backoff + jitter, honors Retry-After
 *   • truncated output (MessageOutputLengthError) → seamless continue nudge
 *   • context-window overflow → triggers compaction, resumes afterwards
 *   • empty responses → re-nudge
 *   • stalled streams (busy w/o events) → abort + restart (skips pending perms,
 *     extended grace while a long tool legitimately runs)
 *   • model "thinking" with zero events → labelled automatic retry (~60s, abort
 *     + resume, labelled as self-healing, not error) before the full stall
 *   • internal retry loops that never end (huge provider Retry-After values)
 *     → taken over: aborted and resumed by the plugin
 *   • server/machine crashes → on startup, recently-active interrupted
 *     sessions are re-animated automatically
 *   • subagent/child sessions are left to their parent orchestrator
 *   • user aborts ("Stop") are fully respected: the plugin detects the stop,
 *     cancels everything already queued, and stays completely quiet — no
 *     recovery, nudges, or autopilot — until the user sends a new prompt.
 *     Stops are remembered on disk, so restarting OpenCode never auto-revives
 *     a stopped session (the plugin's own takeover restarts are exempt)
 *
 * ══════════════════════════════════════════════════════════════════
 *  SUBSYSTEM 2 — MODEL ROTATION (opt-in, master switch OFF by default)
 * ══════════════════════════════════════════════════════════════════
 * Rotation is NEVER triggered silently. The master switch
 *   OPENCODE_RESUME_ROTATION_ENABLED
 * defaults to false. When off (the default), NO model rotation occurs under
 * any circumstance — quota exhaustion, rate limits, failures, deprecation,
 * or post-restart recovery all stay on the same model.
 *
 * When the user explicitly enables rotation (env var = true):
 *   • puts the exhausted model on a cooldown (default 60 min)
 *   • picks the best available alternative automatically:
 *       1. OPENCODE_RESUME_FALLBACK_MODELS preferred chain (env)
 *       2. sibling models from the same provider
 *       3. models from other installed providers
 *     Candidates are ranked by capability tier — Max/Ultra/Opus/Pro/High
 *     variants win whenever they exist; mini/nano/lite/flash variants lose.
 *     (non-chat models like embeddings/TTS/image are always filtered out)
 *   • continues the exact same session/conversation on the new model
 *
 * ══════════════════════════════════════════════════════════════════
 *  SUBSYSTEM 3 — PERMISSION AUTOPILOT (unattended operation)
 * ══════════════════════════════════════════════════════════════════
 * Auto-answers permission prompts so the agent never blocks while you're away:
 *   • safe mode (default): edits/web-fetches approved; shell commands approved
 *     UNLESS they match a dangerous-pattern blocklist (rm -rf, force push,
 *     disk format, registry edits, pipe-to-shell ...) — matched ones are
 *     REJECTED so the agent adapts instead of hanging
 *   • workspace-external directory grants ("Allow always / once" pop-ups)
 *     are answered automatically so AFK runs never stall on them; a built-in
 *     cross-OS regex denylist rejects sensitive system areas (Windows, Linux
 *     and macOS conventions alike) no matter which path style the grant uses
 *   • unknown permission types are left for the user in safe mode
 *
 * ══════════════════════════════════════════════════════════════════
 *  SUBSYSTEM 4 — TASK DRIVER (walk-away automation)
 * ══════════════════════════════════════════════════════════════════
 * Lets you hand a big task to OpenCode and leave:
 *   • TODO DRIVE: session goes idle with unfinished todos → nudges it to
 *     continue (spin-detection stops it if nothing progresses). Tracks both
 *     structured todos (OpenCode 1 cores) and inline markdown plans, which is
 *     the only task-tracking available on OpenCode 2.
 *   • DEBUG NUDGE: 3 consecutive failed tool calls → tells the model to stop
 *     repeating the failing approach and diagnose the root cause first
 *   • AUTONOMY DIRECTIVE: every injected prompt instructs the model to make
 *     its own decisions, never wait for confirmation, document assumptions
 *   • AUTO-PROCEED: if the agent ends its turn by asking a question
 *     ("Should I proceed...?"), it answers itself and continues (capped).
 *     While the model is asking, the session title is decorated with a
 *     ❓ "asking" glyph; the moment the user sends a message OR the next
 *     turn resolves the chain, the glyph clears (armed/recovering/etc.
 *     takes over) so the user always sees the real state.
 *   • WRAP-UP: when the todo list completes → asks once for concrete
 *     improvement proposals (listed, not implemented) + success notice
 *   • BEYOND EXPECTATIONS: before wrapping up, runs a self-critique pass —
 *     the model reviews its own work for correctness/perf/security/robustness
 *     improvements and implements the safe ones (capped number of cycles)
 *
 * Safety rails: per-task resume-chain cap, shared autopilot-nudge cap, task
 * wall-clock budget, spin detection, circuit breaker with cool-down,
 * incident-signature dedupe, idle-status check before every injection.
 * All injected user messages are tagged "[auto-resume]" for visibility.
 * Each engaged session also carries a live status decoration —
 *   "🟢 <title> [auto-resume: armed]"   (🔁 recovering / ⏸️ stopped / 🚫 paused)
 * with the glyph leading and the bracket tag trailing. Turning auto-resume off
 * for a session ("auto-resume off" in chat) removes every trace of it from
 * the title until "auto-resume on" is sent.
 *
 * ══════════════════════════════════════════════════════════════════
 *  CONFIGURATION (env vars, all optional)
 * ══════════════════════════════════════════════════════════════════
 *  OPENCODE_RESUME_ENABLED               master switch              (true)
 *  OPENCODE_RESUME_MAX_CHAIN             recovery resumes per task  (6)
 *  OPENCODE_RESUME_BASE_DELAY_MS         backoff base               (5000)
 *  OPENCODE_RESUME_MAX_DELAY_MS          backoff cap                (120000)
 *  OPENCODE_RESUME_RATE_LIMIT_BASE_MS    429 backoff base           (20000)
 *  OPENCODE_RESUME_OUTPUT_LENGTH_MAX     truncation nudges          (3)
 *  OPENCODE_RESUME_NUDGE_DELAY_MS        continue-nudge delay       (1500)
 *  OPENCODE_RESUME_STALL_TIMEOUT_MS      busy-silence => stalled    (240000)
 *  OPENCODE_RESUME_THINK_STALL_MS        thinking-silence => retry  (60000)
 *  OPENCODE_RESUME_REARM_MS              give-up cool-down before one
 *                                        bounded recovery re-arm     (600000)
 *  OPENCODE_RESUME_WATCHDOG_MS           stall check interval       (10000)
 *  OPENCODE_RESUME_RUNNING_TOOL_FACTOR   grace multiplier while a
 *                                        tool is running            (4)
 *  OPENCODE_RESUME_RETRY_TAKEOVER_MS     stuck-in-core-retry limit  (900000)
 *  OPENCODE_RESUME_RETRY_FUTURE_CAP_MS   absurd next-retry distance (600000)
 *  OPENCODE_RESUME_REANIMATE             revive crashed sessions    (true)
 *  OPENCODE_RESUME_REANIMATE_WINDOW_MS   max age for revival        (600000)
 *  OPENCODE_RESUME_BREAKER_THRESHOLD     failures before breaker    (6)
 *  OPENCODE_RESUME_BREAKER_WINDOW_MS     breaker rolling window     (900000)
 *  OPENCODE_RESUME_BREAKER_COOLDOWN_MS   breaker cool-down          (300000)
 *  OPENCODE_RESUME_COMPACT_ON_OVERFLOW   summarize then resume      (true)
 *  OPENCODE_RESUME_NOTICE_THROTTLE_MS    min gap between user notices
 *                                      (legacy OPENCODE_RESUME_TOAST_THROTTLE_MS
 *                                      still honored)             (3000)
 *  OPENCODE_RESUME_ROTATION_ENABLED     master switch for rotation  (false)
 *  OPENCODE_RESUME_SWITCH_ON_QUOTA       rotate model on free-tier  (false)
 *  OPENCODE_RESUME_SWITCH_ON_RATELIMIT   rotate after N 429s        (false)
 *  OPENCODE_RESUME_SWITCH_ON_FAILURES    rotate after persistent
 *                                        network/5xx failures       (false)
 *  OPENCODE_RESUME_DISABLE_ROTATION      legacy alias for
 *                                        ROTATION_ENABLED=false     (true)
 *  OPENCODE_RESUME_FAVORITE_RETURN        hand the session back to the
 *                                        user's original model once the
 *                                        alternate proves stable        (true)
 *  OPENCODE_RESUME_FAVORITE_CHECK_AFTER_MS  min time on the alternate
 *                                        before returning            (300000)
 *  OPENCODE_RESUME_FAVORITE_MIN_TURNS       stable turns on the alternate
 *                                        required before returning    (3)
 *  OPENCODE_RESUME_RL_SWITCH_AFTER       429s before rotating       (1)
 *  OPENCODE_RESUME_ROTATE_AFTER_FAILURES failed rounds before
 *                                        rotating away              (3)
 *  OPENCODE_RESUME_MAX_ROTATIONS         model rotations per task   (3)
 *  OPENCODE_RESUME_MODEL_COOLDOWN_MS     exhausted-model pause      (3600000)
 *  OPENCODE_RESUME_FALLBACK_MODELS       preferred chain, e.g.
 *                                        "anthropic/claude-sonnet-4,openai/gpt-5,cerebras/llama3.3-70b"
 *  OPENCODE_RESUME_AUTONOMY              master switch subsystem 3+4(true)
 *  OPENCODE_AUTOPILOT_PERMISSIONS        auto-answer permissions    (true)
 *  OPENCODE_AUTOPILOT_PERMISSION_MODE    safe | all                 (safe)
 *  OPENCODE_AUTOPILOT_EXTRA_DENY        comma-separated extra deny regexes
 *  OPENCODE_AUTOPILOT_DIR_ALWAYS_AFTER  benign external-directory asks of the
 *                                      SAME boundary escalate once->always
 *                                      after N auto-answers         (0=off)
 *  OPENCODE_AUTOPILOT_TODO_DRIVE         continue unfinished todos  (true)
 *  OPENCODE_AUTOPILOT_DEBUG_NUDGE        diagnose after tool errors (true)
 *  OPENCODE_AUTOPILOT_PROPOSALS          wrap-up proposals message  (true)
 *  OPENCODE_AUTOPILOT_PROCEED            answer the agent's own
 *                                        questions and continue     (true)
 *  OPENCODE_AUTOPILOT_MAX_PROCEEDS       self-answers per task      (3)
 *  OPENCODE_AUTOPILOT_IMPROVE            self-improvement pass      (true)
 *  OPENCODE_AUTOPILOT_IMPROVE_CYCLES     max improvement cycles     (2)
 *  OPENCODE_AUTOPILOT_IMPROVE_MAX        session-wide improve cap   (4)
 *  OPENCODE_AUTOPILOT_IMPROVE_COOLDOWN_MS cooldown before re-arm    (600000 = 10min)
 *  OPENCODE_AUTOPILOT_MAX_NUDGES         max self-driven nudges/task(25)
 *  OPENCODE_AUTOPILOT_BUDGET_MS          wall-clock budget per task (28800000 = 8h, 0=off)
 *  OPENCODE_RESUME_AUTO_UPDATE           self-update daily from GitHub (true)
 *  OPENCODE_RESUME_STOPSTORE             user-stop memory file
 *                                        (<plugin dir>/auto-resume.js.stopped.json)
 *  OPENCODE_RESUME_OFFSTORE              per-session opt-out memory file
 *                                        (<plugin dir>/auto-resume.js.off.json)
 *  OPENCODE_AUTOPILOT_MAX_COST_USD       spend cap per task, USD     (10, 0=off)
 */

import { writeFile, rename, unlink } from "node:fs/promises"
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"

const AUTO_RESUME_VERSION = "2.1.6"

/** Optional sidecar encryption. When OPENCODE_RESUME_ENCRYPTION_KEY is set,
 *  all persisted stores are encrypted with AES-256-GCM and the ciphertext is
 *  stored as base64. No plaintext session IDs or health metrics are written. */
const ENCRYPTION_KEY = process.env.OPENCODE_RESUME_ENCRYPTION_KEY || null
const encryptPayload = (text) => {
  if (!ENCRYPTION_KEY) return text
  const iv = randomBytes(16)
  const key = scryptSync(ENCRYPTION_KEY, "auto-resume-salt-v2", 32)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return iv.toString("base64") + ":" + encrypted.toString("base64") + ":" + tag.toString("base64")
}
const decryptPayload = (data) => {
  if (!ENCRYPTION_KEY) return data
  if (typeof data !== "string" || !data.includes(":")) return data
  const [ivB64, encB64, tagB64] = data.split(":")
  const iv = Buffer.from(ivB64, "base64")
  const encrypted = Buffer.from(encB64, "base64")
  const tag = Buffer.from(tagB64, "base64")
  const key = scryptSync(ENCRYPTION_KEY, "auto-resume-salt-v2", 32)
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
}

const UPDATE_URL =
  "https://raw.githubusercontent.com/neohiro/auto-resume/main/auto-resume.js"

/** This module's own path on disk, resolved at import time.
 *
 *  The engine computes the same value locally (each plugin instance owns its
 *  sidecars), but the V2 adapter needs it before the engine exists: it has to
 *  find <plugin>.active.json to know which sessions were alive when the last
 *  server died, because OpenCode 2 exposes no session-list endpoint to plugins.
 *  Resolving it here keeps the adapter independent of engine internals. */
const MODULE_SELF_PATH = (() => {
  try {
    if (!import.meta.url.startsWith("file:")) return null
    return decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1")
  } catch { return null }
})()

/** One-word aggression preset → (maxChain, maxStallTakeovers). Numeric
 *  env vars (OPENCODE_RESUME_MAX_CHAIN, OPENCODE_RESUME_MAX_STALL_TAKEOVERS)
 *  override the preset when set. conservative matches the pre-1.14 hard cap;
 *  relentless buys maximum headroom for unattended free-tier runs where the
 *  user genuinely wants the agent to keep trying. balanced is the default. */
const AGGRESSION_PRESETS = {
  conservative: { maxChain: 6, maxStallTakeovers: 2 },
  balanced:     { maxChain: 8, maxStallTakeovers: 4 },
  relentless:   { maxChain: 12, maxStallTakeovers: 8 },
}
const DEFAULT_AGGRESSION = "balanced"

const DEFAULTS = {
  enabled: true,
  budgetPrompts: false,
  reanimate: false,
  baseDelayMs: 5_000,
  maxDelayMs: 120_000,
  rateLimitBaseMs: 20_000,
  /* Fast-burst retry for TRANSIENT failures (403/5xx/network) when model
   * rotation is off — the default configuration.
   *
   * With rotation off there is no other model to move to, so the only recovery
   * lever is trying the same one again. Escalating backoff is the wrong shape
   * for a blip: a 403 or 502 that clears in two seconds is still sitting
   * behind a 40s wait. A blip is overwhelmingly the common case, so the early
   * attempts come fast and close together.
   *
   * Growth is gentle (1.5x, not 2x) and the ceiling is low, so this stays a
   * "keep pushing through it" posture rather than a tight infinite loop. It is
   * still bounded three ways: maxChain attempts, the circuit breaker, and
   * s.pendingResume which drops a retry that lands while one is in flight.
   *
   * Deliberately NOT applied to rate_limit: there the provider states when its
   * bucket refills, and hammering ahead of that just burns the quota faster.
   */
  fastRetry: true,
  fastRetryBaseMs: 1_200,
  fastRetryGrowth: 1.8,
  fastRetryMaxMs: 30_000,
  /* Ceiling on the attempt budget that fast retry scales maxChain up to.
   *
   * At the shipped values (base 1.2s, 1.8x growth, 8 maxChain) the fast
   * schedule would cover the same wall-clock window as the old escalating one
   * in about 26 attempts. 32 keeps that window while staying far below the
   * ~68 a literal match would need — every attempt is a real provider request,
   * and the point of this is decent tokens/hour on free models, not spending
   * quota to buy patience. */
  fastRetryMaxChain: 32,
  outputLengthMax: 3,
  nudgeDelayMs: 1_500,
  stallTimeoutMs: 240_000,
  thinkStallMs: 60_000,
  rearmMs: 600_000,
  watchdogMs: 10_000,
  runningToolFactor: 4,
  retryTakeoverMs: 900_000,
  retryFutureCapMs: 600_000,
  reanimate: true,
  reanimateWindowMs: 600_000,
  favoriteReturn: true,
  favoriteCheckAfterMs: 300_000,
  favoriteMinTurns: 3,
  breakerThreshold: 6,
  breakerWindowMs: 900_000,
  breakerCooldownMs: 300_000,
  compactOnOverflow: true,
  noticeThrottleMs: 3_000,
  autoUpdate: true,
  maxTaskCostUsd: 10,
  // Model rotation — ALL defaults are OFF. Rotation is NEVER triggered silently.
  // The master switch OPENCODE_RESUME_ROTATION_ENABLED defaults to false.
  // When off (the default), NO model rotation occurs under ANY circumstance.
  // To enable: explicitly set OPENCODE_RESUME_ROTATION_ENABLED=true
  rotationEnabled: false,
  switchOnQuota: false,
  switchOnRateLimit: false,
  switchOnFailures: false,
  disableRotation: true,
  rlSwitchAfter: 1,
  rotateAfterFailures: 3,
  maxRotations: 3,
  modelCooldownMs: 3_600_000,
  fallbackModels: "",
  // Comma-separated list of model IDs to permanently avoid (deprecated/unavailable).
  // These are filtered out during rotation and put on permanent cooldown.
  // Example: "exo,exo-1,exo-2,old-model-name"
  denylistModels: "",
  autonomy: true,
  permissions: true,
  permissionMode: "safe",
  extraDeny: "",
  dirAlwaysAfter: 0,
  todoDrive: true,
  debugNudge: true,
  proposals: true,
  proceedOnAsk: true,
  maxProceeds: 3,
  improveLoop: true,
  improveCycles: 2,
  improveMax: 4,
  improveCooldownMs: 600_000,
  maxNudges: 25,
  budgetMs: 0, // Off by default; only active when user defines OPENCODE_AUTOPILOT_BUDGET_MS
  // Maximum entries in dirAskCounts before forced cleanup (0 = unlimited, but
  // periodic cleanup in checkStalls will still run). Default 1000 entries.
  maxDirAskCounts: 1000,
}

// ── Named constants for magic numbers ─────────────────────────────────────
// Session idle timeout before cleanup (6 hours)
const SESSION_IDLE_CLEANUP_MS = 21_600_000
// Title refresh debounce delay
const TITLE_REFRESH_DEBOUNCE_MS = 250
// Max output length for continuation stub detection
const CONTINUATION_STUB_MAX_LEN = 250
// Minimum text length for no-todo improvement pass
const NO_TODO_IMPROVE_MIN_CHARS = 80

/** Markdown checklist / plan markers the model writes for itself.
 *  OpenCode 2 removed the first-class `todowrite` tool and the `todo.updated`
 *  event, so a V2 model has no structured task tracker — it tracks remaining
 *  work either with markdown checkboxes (`- [ ]` / `- [x]`) or, when the core
 *  still exposes tool todos (V1 cores), via the todo list itself. */
const CHECKBOX_RE = /[-*+]\s+\[([ xX~+-])\]/g
const PLAN_HEADING_RE = /^\s*(?:#{1,6}\s*)?(?:todo|to-do|task|plan|next steps?|remaining|checklist|outstanding)\b/im
const textOfParts = (parts) =>
  (parts ?? []).map((x) => (x?.type === "text" ? (x.text ?? "") : "")).join("\n")

/** Count the checkboxes in a block of assistant text. */
const checkboxCounts = (text) => {
  const boxes = [...String(text ?? "").matchAll(CHECKBOX_RE)]
  const open = boxes.filter((m) => m[1] !== "x" && m[1] !== "X").length
  return { open, done: boxes.length - open, total: boxes.length }
}

/** Resolve the most recent self-authored plan from a session's messages.
 *
 *  Used only when no tool-backed todo list exists — i.e. on OpenCode 2, where
 *  `todowrite`/`todo.updated` are gone. Scans assistant messages from newest to
 *  oldest and returns the first message that actually contains a checklist (or
 *  a plan heading), so a plan the model stated several turns ago keeps driving
 *  continuation even when the newest reply is just a short confirmation.
 *
 *  Returns `{ open, done, total, text }` or null when the session has no plan. */
const latestPlanFromMessages = (entries, maxScan = 12) => {
  const assistants = []
  for (let i = entries.length - 1; i >= 0 && assistants.length < maxScan; i -= 1) {
    if (entries[i]?.info?.role === "assistant") assistants.push(entries[i])
  }
  for (const msg of assistants) {
    const text = textOfParts(msg?.parts)
    if (!text) continue
    const counts = checkboxCounts(text)
    if (counts.total > 0) return { ...counts, text }
    // A heading-only plan ("## Next steps" with prose underneath) still marks
    // outstanding work even without checkboxes.
    if (PLAN_HEADING_RE.test(text)) return { open: 1, done: 0, total: 1, text }
  }
  return null
}
// Improved title display window (3 minutes)
const IMPROVED_TITLE_WINDOW_MS = 180_000
// Compaction watchdog timeout (3 minutes)
const COMPACTION_WATCHDOG_MS = 180_000
// Takeover retry delay
const TAKEOVER_RETRY_DELAY_MS = 1_500
// Takeover schedule delay
const TAKEOVER_SCHEDULE_DELAY_MS = 800
// Poll interval for busy sessions
const BUSY_POLL_INTERVAL_MS = 5_000
// Max polls for resume plans
const MAX_RESUME_POLLS = 60
// Max polls for other plans
const MAX_OTHER_POLLS = 12
// Reanimate scan interval (5 minutes)
const REANIMATE_SCAN_INTERVAL_MS = 300_000
// Update check interval (1 hour)
const UPDATE_CHECK_INTERVAL_MS = 3_600_000
// Update notice delivery retry interval (30 seconds)
const NOTICE_DELIVERY_RETRY_MS = 30_000
// OS notification timeout
const OS_NOTIFICATION_TIMEOUT_MS = 15_000
// Notice drop file max size (1 MiB)
const NOTICE_DROP_MAX_BYTES = 1_048_576
// Notice drop file keep lines
const NOTICE_DROP_KEEP_LINES = 200
// Notice drop lock timeout
const NOTICE_DROP_LOCK_TIMEOUT_MS = 2_000
// Notice drop lock stale threshold
const NOTICE_DROP_LOCK_STALE_MS = 30_000
// Perm fingerprint max length
const PERM_FINGERPRINT_MAX_LEN = 4096
// Store TTL (14 days)
const STORE_TTL_MS = 14 * 86_400_000
// Restart recovery window (24 hours)
const RESTART_RECOVERY_WINDOW_MS = 86_400_000
// Failure velocity window (60 seconds)
const FAILURE_VELOCITY_WINDOW_MS = 60_000
// Duplicate incident dedupe window (2 seconds)
const DUPLICATE_INCIDENT_WINDOW_MS = 2_000
// Deprecation cooldown (1 year)
const DEPRECATION_COOLDOWN_MS = 86_400_000 * 365

const RESUME_TAG = "[auto-resume]"

const AUTONOMY_DIRECTIVE =
  " You are a principal engineer working unattended. Decide, don't ask. Document assumptions; pick sensible defaults." +
  " Done = production-grade, above industry standards and above user expectations: builds + tests + linters/type-checks green; edges + errors handled; security + perf considered; backward-compatible; no TODO/FIXME or dead code; docs match code; verify with the real toolchain. Quality > speed. Exceed expectations."

/** Compact version of AUTONOMY_DIRECTIVE for the lowBudget path — keeps the
 *  production-grade definition but drops the "working unattended / don't ask"
 *  boilerplate since the model is already in context and needs the token
 *  budget for the actual work, not the framing. ~85 chars vs ~391. */
const AUTONOMY_DIRECTIVE_TIGHT =
  " Done = production-grade: builds + tests + linters/type-checks green; no TODO/FIXME or dead code; docs match code. Verify. Quality > speed."

/** Shared closing line — quality bar + verification reminder. Appended by
 *  prompts that produce real artifact output (not pure re-orients). Kept short
 *  so the same words don't repeat across every prompt. */
const QUALITY = " Senior-grade output: verify (build/test/lint) before claiming done. No TODOs, no apology, no recap. Exceed expectations."

/** "Your own prior output is still in the transcript" — the single most useful
 *  thing to tell a model resuming a cut-off turn. Models that suspect a fresh
 *  context re-plan, re-read files, and re-explain; those tokens are wasted and
 *  the user sees a redundant recap. Say it once, centrally. */
const TRANSCRIPT_INTACT =
  " Everything you already wrote this turn is still in the transcript — resume mid-thought, don't re-plan, don't re-read what you've already read, don't restate finished code."

/** Format a provider-supplied retry window (ms) as a human duration. */
const fmtWait = (ms) => {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return ""
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m <= 90 ? `${m}min` : `${(m / 60).toFixed(1)}h`
}

const PROMPTS = {
  /* ── Recovery: one prompt per *distinct* failure shape ──────────────────────
   * These used to collapse into a single "a provider turn failed" message.
   * That is the wrong trade: the remedy differs per failure, and a model given
   * the wrong remedy does the wrong thing — it re-plans when it should resume,
   * or retries verbatim when it must rephrase. Each entry below states the one
   * thing that actually fixes that failure mode.
   */

  /** Transport dropped (ECONNRESET / DNS / TLS / fetch failed / socket hang).
   *  Nothing about the work was rejected — only the pipe broke. The correct
   *  behaviour is the *smallest* possible re-entry: resume the exact token. */
  networkDrop: (auto, detail, hint) =>
    `${RESUME_TAG} Auto-resume. The connection dropped mid-turn — a transport fault, not a rejection.` +
    (detail ? ` Cause: "${detail}".` : "") +
    (hint?.provider ? ` Provider: ${hint.provider}.` : "") +
    ` Your request was fine and your reasoning was not at fault. Do not re-plan, re-summarise, or re-derive what you had already worked out.` +
    TRANSCRIPT_INTACT,

  /** Provider-side 5xx / 529 / gateway / overload. The request is valid; the
   *  provider is unhealthy. Identical remedy to a transport drop, but naming
   *  the cause stops the model from suspecting its own request was malformed. */
  providerDown: (auto, detail, hint) =>
    `${RESUME_TAG} Auto-resume. The provider's servers failed (${(detail || "5xx / overloaded").slice(0, 80)}) — your request was not at fault.` +
    (hint?.provider ? ` Provider: ${hint.provider}.` : "") +
    ` Retry the same work the same way; don't simplify or defensively rewrite the request.` +
    TRANSCRIPT_INTACT,

  /** 429 / throttle. The critical detail is the *wait*: a model told "rate
   *  limited" without a window tends to either stall or immediately re-do the
   *  heaviest part. Also worth steering toward landing an increment so a
   *  second throttle can't lose everything. */
  rateLimited: (auto, detail, hint) =>
    `${RESUME_TAG} Rate limited.` +
    (hint?.provider ? ` Provider: ${hint.provider}.` : "") +
    (hint?.retryWait ? ` Window: ~${hint.retryWait}.` : "") +
    (hint?.reason ? ` Note: "${String(hint.reason).slice(0, 80)}".` : (detail ? ` Cause: "${detail}".` : "")) +
    ` Work continues; this may be temporary. Land a verified increment when possible.` +
    TRANSCRIPT_INTACT,

  /** 402 / free tier / insufficient credits with no alternate model available.
   *  Budget is the binding constraint, so the instruction is about *spending*
   *  it: finish what is in flight, start nothing new, keep replies tight. */
  quotaExhausted: (auto, detail, hint) =>
    `${RESUME_TAG} Quota/credit balance low.` +
    (detail ? ` Note: "${detail}".` : "") +
    ` Work continues within remaining budget; prefer verified increments.` +
    TRANSCRIPT_INTACT,

  /** Provider safety filter stopped the turn. Retrying verbatim is guaranteed
   *  to fail again and burns quota, so the message's whole job is to change the
   *  framing rather than the work. Only reachable on OpenCode 2, which reports
   *  the finish reason directly instead of burying it in an error string. */
  contentFilter: () =>
    `${RESUME_TAG} Auto-resume. Your previous reply was stopped by the provider's safety filter — not by length, quota, or a network fault.` +
    ` Repeating it verbatim will be blocked again.` +
    ` Reframe the request in neutral, task-focused terms and continue with the parts that do not touch the blocked content.` +
    ` If the blocked portion is not essential to the user's goal, complete everything else and state plainly what you skipped and why. Do not stall on it.`,

  /** Context overflow → compaction → resume. Without this the model treats the
   *  truncated history as corruption and frequently restarts the task from
   *  scratch, which is the single most expensive failure mode after compaction. */
  afterCompaction: () =>
    `${RESUME_TAG} Auto-resume. The conversation exceeded the context window, so earlier turns were compacted into a summary.` +
    ` This is normal — nothing was lost from the codebase, and the recent turns plus the summary are intact.` +
    ` Do NOT restart the task or re-derive earlier decisions; the summary already carries them.` +
    ` Re-read only the specific files you still need, then continue from exactly where you stopped.`,

  /** The turn was aborted while a tool was still running. The tool may well
   *  have completed its work, so blind re-execution is the expensive mistake
   *  (and can double-apply a migration or re-run a deploy). */
  stalledInTool: () =>
    `${RESUME_TAG} Auto-resume. The turn stalled while a tool call was still running and was aborted waiting on it.` +
    ` Before re-running anything, check whether it already landed — read the file, check the process, or query the result.` +
    ` Re-executing a completed side-effecting tool can double-apply it. If it did not land, re-run that one step; otherwise continue past it.`,

  retry: (attempt) => {
    // Later attempts get terser: a model stuck in a retry loop tends to
    // re-emit a recap when the prompt grows, so shorten as we escalate.
    if (attempt >= 4) {
      return `${RESUME_TAG} Auto-retry #${attempt} (short). Stalled again — pick up where you stopped and finish. No recap, no preamble; just continue.`
    }
    if (attempt >= 2) {
      return `${RESUME_TAG} Auto-retry #${attempt}. Self-healing; the previous turn was busy with no output and got aborted.` +
        ` Continue from where you stopped. Verify progress (build/test/lint) before claiming done.`
    }
    return `${RESUME_TAG} Auto-retry #${attempt}. Self-healing; the previous turn was busy ~60s with no output and got aborted.` +
      ` Pick up exactly where you stopped; finish production-grade.`
  },
  /** Generic fallback. Only reached for a failure we cannot attribute to a
   *  specific cause; the dedicated variants above carry the actionable advice,
   *  so this stays deliberately non-committal rather than guessing. */
  resume: (auto, detail, modelNote) =>
    `${RESUME_TAG} Auto-resume. A provider turn failed (network / 5xx / rate-limit / timeout / quota).` +
    (detail ? ` Cause: "${detail}".` : "") +
    (modelNote ? ` ${modelNote}` : "") +
    ` Reconstruct state from the conversation + codebase (re-read files if unsure); continue from exactly where you stopped.` +
    ` Exceed industry standards on the remaining work.`,
  lowBudget: (auto, detail, modelNote) =>
    `${RESUME_TAG} Quality-demanding retry — verify state from conversation + codebase, then resume from exactly where you stopped, exceeding industry standards.` +
    (detail ? ` Note: "${detail}".` : "") +
    (modelNote ? ` ${modelNote}` : "") +
    ` Lead with substance, skip preamble/restated context/unchanged code. Edits > rewrites; diffs > restatements. Verify correctness; no corners cut.` +
    (auto ? AUTONOMY_DIRECTIVE_TIGHT : ""),
  truncated: (auto) =>
    `${RESUME_TAG} Last reply hit the provider's max output length and was cut off mid-stream — not a content rejection.` +
    ` Continue from the exact cut point: if a block or sentence is half-written, close it first.` +
    ` Do not re-emit code you have already written — finish the remainder and move on.` +
    ` If the remaining work will not fit in one reply, split it: land a complete increment, then continue.`,
  empty: (auto) =>
    `${RESUME_TAG} Previous reply came back empty — zero content — which is a transient provider hiccup, not a judgement on the request.` +
    ` Answer the original request now: lead with the substance, concise and precise.` +
    ` If you already produced the answer earlier in this session, restate that result rather than redoing the work.`,
  todos: () =>
    `${RESUME_TAG} Session idle, todos unfinished. Work the list you set yourself (tool-tracked todos where the client provides them, otherwise the checklist you wrote inline), one item at a time:` +
    ` implement each end-to-end (code + tests + docs where they matter), verify it actually runs, then tick it off before moving on — don't batch ticks at the end.` +
    ` If an item turns out to be wrong, blocked, or already done, say which and why rather than forcing it.` +
    ` If everything is genuinely done, say so in one line and stop.`,
  proceed: () =>
    `${RESUME_TAG} Proceed autonomously with what you just proposed/asked — the answer is yes.` +
    ` Don't restate the question or ask it again. Finish the work end-to-end — full implementation, tests, error handling, doc touches — verified against the real toolchain.` +
    ` If a decision genuinely can't be made without input, take the safe call, document the assumption in one line, and keep going.` +
    AUTONOMY_DIRECTIVE,
  proceedAll: () =>
    `${RESUME_TAG} You asked "which of these should I tackle first?" — autonomous answer: do ALL of them, one by one, end-to-end.` +
    ` Order them by dependency: whatever unblocks the others first, then the widest blast radius, then the cheapest wins.` +
    ` Build, test, lint, commit, then move to the next. No sign-off between items, no summary between items — just drive them to completion in order.` +
    ` If one is genuinely risky or ambiguous, implement the safe core, note the assumption in one line, and continue.` +
    AUTONOMY_DIRECTIVE,
  keepGoing: () =>
    `${RESUME_TAG} You paused mid-work ("continue", "finalize", etc.), indicating there is still work to do.` +
    ` Pick up at the exact point you stopped and drive it to full finalization: finish every remaining step, verify (build/test/lint), leave nothing half-done.` +
    ` Don't ask whether to continue — that was the question you already answered.` +
    AUTONOMY_DIRECTIVE,
  debug: () =>
    `${RESUME_TAG} Multiple tool calls failed in a row. Stop retrying the failing approach.` +
    ` Root-cause it: read the FULL error (not the first line — the actionable cause is often below it), inspect the real files/state, form ONE concrete hypothesis.` +
    ` Apply the smallest targeted fix for the actual cause, prove it by re-running the same command, and add a regression test so this class stays dead.` +
    ` If the same error persists after the fix, the hypothesis was wrong — state what you ruled out before trying a different one, rather than cycling blindly.`,
  improve: (cycle, total) =>
    `${RESUME_TAG} Self-improvement pass ${cycle}/${total}. Review this session's work as a principal engineer signing off a release.` +
    ` Hunt concrete gains: correctness, perf, security, robustness, readability — unhandled edges, missing input validation, races, resource leaks, stale docs/comments, thin coverage on critical paths, inefficient hot spots, style inconsistencies.` +
    ` Prioritise by real risk, not by how easy the fix is. Implement what you're confident about and validate (build/test/lint/typecheck); skip ambiguous/risky items with a one-line reason.` +
    ` No new scoped features — but when the scoped work is fully complete, do not stop; pivot to optimization, UX polish, performance tuning, accessibility, and documentation clarity — raise everything above industry standards, beyond what the user asked for.` +
    ` If everything is genuinely perfect already, say so and propose one concrete UX/performance optimization anyway rather than inventing busywork.`,
  propose: () =>
    `${RESUME_TAG} Scoped work appears complete. Do NOT simply summarise; instead provide concrete optimization/UX/performance improvements:` +
    ` (1) Verification status — exactly what you ran (build/test/lint/typecheck) and result.` +
    ` (2) One concrete optimization or UX improvement with expected payoff.` +
    ` (3) If scoped work is perfect, propose one accessibility, performance, or usability enhancement — contribute to increased quality even when all scoped work is complete.`,
}

const NETWORK_PATTERNS = [
  "fetch failed", "econnreset", "econnrefused", "econnaborted", "etimedout",
  "esockettimedout", "socket hang up", "connection refused", "connection reset",
  "connection closed", "connection terminated", "other side closed",
  "premature close", "terminated", "stream ended unexpectedly", "network",
  "enotfound", "eai_again", "dns", "tls", "ssl", "handshake", "gateway",
  "overloaded_error", "overloaded", "bad gateway", "service unavailable",
  "internal server error", "unavailable", "upstream", "unable to connect",
  "load failed", "epipe", "too many requests",
]

const RATE_LIMIT_PATTERNS = [
  "rate limit exceeded", "rate limit", "rate limited", "rate-limit",
  "too many requests", "quota exceeded", "request limit", "throttle",
]

const OVERFLOW_PATTERNS = [
  "context length", "context window", "too many tokens", "token limit",
  "maximum context", "input length exceeds", "input tokens exceed",
  "prompt is too long", "prompt too long", "reduce the length",
  "exceed the maximum number of tokens",
]

const QUOTA_PATTERNS = [
  "free usage exceeded", "free tier", "free-tier", "quota", "billing",
  "payment required", "credit balance", "insufficient", "usage limit",
  "limit reached", "upgrade to go", "subscribe to go", "exceeded your",
  "requires more credits", "insufficient_credit", "insufficient_quota",
  "insufficient credits", "insufficient balance", "insufficient credit",
  "credit", "afford", "out of credits", "no credits",
  "not available for your country", "not available in your country", /geo.*restrict/i, /country.*not.*support/i,
]

/** A second, narrower tier of phrases that mean the model asked for too many
 *  max_tokens (or a too-large response) given the current account/credit
 *  state — the canonical OpenRouter "You requested up to N tokens, but can
 *  only afford M" message. We classify these as quota (so we rotate) but
 *  ALSO switch to a more concise prompt so the same model can still finish
 *  the task under the smaller budget. Order in this list = priority. */
const MAX_TOKENS_PATTERNS = [
  "requires more credits, or fewer max_tokens",
  "you requested up to",
  "but can only afford",
  "max_tokens",
  "reduce max_tokens",
  "fewer max_tokens",
  "context length exceeded",
  "context_length_exceeded",
  "maximum context length",
]

/** Model ids that look like non-chat endpoints and must never receive prompts. */
const NON_CHAT_PATTERN = /embed|whisper|tts|speech|transcri|image|imagen|dall|moderation|guard|rerank|vision-only|caption/i

/** Known deprecated / permanently unavailable model IDs that should never be
 *  selected by auto-rotation. These models are put on a permanent cooldown
 *  and filtered out during model selection. Can be extended via
 *  OPENCODE_RESUME_DENYLIST_MODELS (comma-separated model IDs). */
const DEPRECATED_MODELS = new Set([
  "exo",
  "exo-1",
  "exo-2",
])

/** Patterns in error messages that indicate a TEMPORARY rate limit or quota
 *  throttling with a specific retry time (e.g., "Please retry in 40.911s",
 *  "retry in 22.145 seconds") rather than a permanent unrecoverable quota exhaustion.
 *  When detected, we treat it as a temporary rate limit/retryable error and
 *  DO NOT rotate models away from the current provider/model. */
const TEMPORARY_RATE_LIMIT_PATTERNS = [
  /retry in \d+(\.\d+)?\s*(seconds?|secs?|s|minutes?|mins?|hours?)/i,
  /try again in \d+(\.\d+)?\s*(seconds?|secs?|s|minutes?|mins?|hours?)/i,
  /wait \d+(\.\d+)?\s*(seconds?|secs?|s|minutes?|mins?|hours?) before/i,
  /rate limit.*reset in \d+/i,
  /quota.*reset in \d+/i,
  /available in \d+(\.\d+)?\s*(seconds?|secs?|s|minutes?|mins?|hours?)/i,
  /exhausted for metric.*retry in/i,
  /free_tier.*retry in/i,
]

/** Check if an error message indicates a temporary rate limit with a specific
 *  retry time rather than permanent quota exhaustion. */
const isTemporaryRateLimit = (error) => {
  const msg = `${error?.data?.message ?? ""} ${error?.data?.responseBody ?? ""}`.toLowerCase()
  return TEMPORARY_RATE_LIMIT_PATTERNS.some((re) => re.test(msg))
}

/** Extract the retry delay a provider asked for, from the error BODY.
 *
 *  isTemporaryRateLimit() detects that a provider gave a concrete wait time;
 *  this reads what that time actually is. Without it the delay is unknown and
 *  the caller falls back to exponential backoff — which either retries too
 *  early (guaranteeing another 429) or waits far longer than the provider asked.
 *
 *  Both phrasings are anchored on a capture group, which is what makes
 *  extraction possible where the detection patterns alone cannot. Gemini is the
 *  common case: "Please retry in 28.462826513s" alongside a free-tier token
 *  bucket that genuinely refills in that window.
 *
 *  Returns milliseconds, capped, or null when the body carries no explicit
 *  wait. */
const RETRY_IN_BODY_RE = [
  /(?:please\s+)?retry in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|hours?|hrs?|h)\b/i,
  /try again in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|hours?|hrs?|h)\b/i,
  /available in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|hours?|hrs?|h)\b/i,
]
const RETRY_UNIT_MS = { s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000, h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000 }

const retryAfterMsFromBody = (error, capMs = 600_000) => {
  const text = `${error?.data?.message ?? ""} ${error?.data?.responseBody ?? ""} ${error?.message ?? ""}`
  for (const re of RETRY_IN_BODY_RE) {
    const m = text.match(re)
    if (!m) continue
    const value = Number(m[1])
    if (!Number.isFinite(value) || value < 0) continue
    const unit = RETRY_UNIT_MS[String(m[2]).toLowerCase()]
    if (!unit) continue
    // A provider asking for a sub-second retry is noise; don't busy-loop on it.
    return Math.min(Math.max(Math.ceil(value * unit), 1000), capMs)
  }
  return null
}

/** Model selection tracking for intelligent rotation — avoids picking the same
 *  model repeatedly by tracking recent selections per session. */
const modelSelectionHistory = new Map() // sessionID -> Array<{modelKey, timestamp}>
const MAX_SELECTION_HISTORY = 5
const SELECTION_HISTORY_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Router aggregators (OpenRouter, Groq, LiteLLM, etc.): the user's request
 *  hits an upstream provider they don't directly pay, so a single brief
 *  provider outage, a 429 from one upstream, or a quota exhaustion on the
 *  FREE TIER behind the router can take a while to clear.  When we detect
 *  one of these we (a) wait longer between retries, (b) compact the prompt
 *  one extra time before giving up, and (c) escalate to bare "Continue"
 *  only on the 4th attempt (not the 3rd) so the cost-saving variants have
 *  one more chance.  Matched against either the provider id or the model id
 *  so a user can name a custom provider that fronts these services. */
const ROUTER_RE = /\b(openrouter|groq|litellm|portkey|together|deepinfra|anyscale|fireworks|octoai|replicate|cohere|perplexity|mistral|nousresearch|openai|anthropic|google|gemini|meta|llama|qwen|deepseek)\b/i

/** Capability-tier hints used to prefer the strongest variant of a family.
 *  Word-boundary matched against the model id, case-insensitive. */
const TIER_BONUS = [
  [/\bmax(imum)?\b/i, 60], [/\bultra\b/i, 60], [/\bopus\b/i, 55],
  [/\bpro\b/i, 45], [/\bhigh\b/i, 45], [/\bpremium\b/i, 40],
  [/\badvanced?\b/i, 35], [/\b(xl|xxl)\b/i, 30], [/\blarge(r)?\b/i, 25],
  [/\b(sonnet|gpt-?[5-9]|o[1-9])\b/i, 20], [/\b(200b|405b|671b)\b/i, 20],
  [/\b(70b|72b|80b|120b|140b|235b)\b/i, 15], [/\bthinking\b/i, 10],
]
const TIER_PENALTY = [
  [/\bmini\b/i, -50], [/\bnano\b/i, -50], [/\btiny\b/i, -45],
  [/\bsmall(est)?\b/i, -40], [/\blite\b/i, -40], [/\bflash\b/i, -35],
  [/\binstant\b/i, -35], [/\bexpress\b/i, -35], [/\bhaiku\b/i, -30],
  [/\bfast(est)?\b/i, -25], [/\bbasic\b/i, -25], [/\blean\b/i, -20],
]

/** Turn-ending question markers: the agent stopped to ask instead of doing. */
const QUESTION_PATTERNS = [
  /\bshall i\b/i, /\bshould i\b/i, /\bwould you like me\b/i,
  /\bdo you want me to\b/i, /\bwant me to\b/i, /\bcan i (proceed|continue|start|begin|go ahead)\b/i,
  /\bshould we\b/i, /\blet me know (if|when|whether)\b/i,
  /\bawait(ing)? (your|further) (confirmation|instructions|approval|input)\b/i,
  /\bwaiting for your\b/i, /\bprompt (me|you) when\b/i,
  // Proposal-list / defer-to-user shapes: the agent is offering a menu of
  // options rather than asking a yes/no proceed question. These route to the
  // stronger PROMPTS.proceedAll ("do all of them, in order").
  /\bwhich (of these|one) (do you want|should i|tackle|do|first|prioritize)/i,
  /\bwhich (of the|proposal|task|item|option)s? (do you want|should i|tackle|do|first|prioritize|implement|start)/i,
  /\bdraft a spec\b/i, /\bwrite a spec\b/i, /\bpropose a spec\b/i,
  /\bwhich (is|would be) (most|best) (impactful|important|priority)/i,
  /\bprioritize (these|them|the)\b/i,
  /\bpick (one|the) (to start|to tackle|first|to begin)\b/i,
  /\bwhere (should i|would you like me) (start|begin|tackle)\b/i,
  /\bshould (i|we) (start|tackle|begin) with\b/i,
  /\bgo for (the |)(proposal|task|most impactful|first|all)\b/i,
  /\bdo all\b/i, /\bimplement all\b/i, /\ball of them\b/i,
  /\bshall i (tackle|draft|write|implement|start|begin)/i,
  /\bwhich approach\b/i,
]

/** Turn-ending continuation stubs: the agent announced more work but stopped
 *  ("Continue to finalize.", "Continuing...", "To be continued.") without a
 *  question mark — so the question detector never fires on these. */
const CONTINUATION_ANYWHERE = [
  /\bcontinue to finalize\b/i,
  /\bto be continued\b/i,
  /\bwill continue\b/i,
  /\bcontinu(e|ing) (in the next|with the next|shortly|below)\b/i,
  /\bmore (to come|coming soon|follows)\b/i,
  /\bremaining things to do\b/i,
  /\bleft on the (list|todo)\b/i,
  /\bstill (?:on the (list|todo)|to be done|remaining)\b/i,
  /\bitems? remain(?:ing)?\b/i,
]
const CONTINUATION_STEM = /^(continue|continuing|resumed?|proceeding|finalizing|finalize|finishing|finishing up|wrapping up|next up|partial(?:ly)? (?:done|complete)|incomplete)\b/i

/** A short closing line announcing unfinished work. */
const looksLikeContinuationStub = (text) => {
  const t = String(text ?? "").trim()
  if (!t || t.length > CONTINUATION_STUB_MAX_LEN) return false
  return CONTINUATION_STEM.test(t) || CONTINUATION_ANYWHERE.some((re) => re.test(t))
}

/** Unambiguous phrases count even inside longer replies. */
const looksLikeContinuationLong = (text) => {
  const t = String(text ?? "").trim()
  if (!t) return false
  return CONTINUATION_ANYWHERE.some((re) => re.test(t))
}

// Tier score cache with size limit to prevent unbounded growth
const TIER_SCORE_CACHE_MAX = 500
const tierScoreCache = new Map()
const tierScore = (modelID) => {
  const cached = tierScoreCache.get(modelID)
  if (cached !== undefined) return cached
  let score = 0
  for (const [re, pts] of TIER_BONUS) if (re.test(modelID)) score += pts
  for (const [re, pts] of TIER_PENALTY) if (re.test(modelID)) score += pts
  if (tierScoreCache.size >= TIER_SCORE_CACHE_MAX) {
    const firstKey = tierScoreCache.keys().next().value
    tierScoreCache.delete(firstKey)
  }
  tierScoreCache.set(modelID, score)
  return score
}

/** Regex patterns that indicate potentially dangerous user-supplied regexes
 *  (ReDoS vectors). Used to reject malicious patterns in OPENCODE_AUTOPILOT_EXTRA_DENY.
 *  This is a heuristic filter, not a guarantee — it catches common catastrophic
 *  backtracking constructs but cannot detect all ReDoS vectors. */
const DANGEROUS_REGEX_PATTERN = /\(\?[:=!]|\(\?<[^>]+>|\{[0-9]*,[0-9]*\}|\?\?|\+\+|\*\*|\(\s*\(\?|\(\?\+|\(\?\*|\(\?<[=!]|\(\?P<|\(\?P=|(\w)\1*[+*]\1*[+*]|[+*][+*]|[+*]\?[+*]/g

/** Shell fragments considered too dangerous to auto-approve in safe mode.
 *  Plain case-insensitive substrings by default; "re:<body>" opts into regex
 *  (kept off by default after ':(){' / '| sudo sh' style footguns). */
const DANGEROUS_PATTERNS = [
  "rm -rf", "rm -fr", "rm -r /", "rmdir /s", "del /s", "del /f", "erase /f",
  "format ", "mkfs", "dd if=", "fork bomb", ":(){", "shutdown", "reboot",
  "halt ", "git push --force", "git push -f", "git reset --hard",
  "git clean -fd", "git clean -df", "drop database", "drop table",
  "truncate table", "chmod -r 777", "reg add hkey", "reg delete",
  "remove-item -recurse", "remove-item -force", "curl | sh", "curl | bash",
  "curl|sh", "curl|bash", "wget | sh", "wget | bash", "wget|sh",
  "| sudo sh", "|sudo sh", "--no-verify",
  "> /dev/sda", "diskpart", "cipher /w", "vssadmin delete",
]

function num(name, fallback) {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= 0 ? v : fallback
}
function str(name, fallback) {
  const v = process.env[name]
  return v === undefined || v === "" ? fallback : v
}
function bool(name, fallback) {
  const v = process.env[name]
  if (v === undefined || v === "") return fallback
  return !["0", "false", "no", "off"].includes(v.toLowerCase())
}

function loadConfig() {
  // The retry base, read once so the fast-retry path can inherit it.
  const cfgBaseDelay = () => num("OPENCODE_RESUME_BASE_DELAY_MS", DEFAULTS.baseDelayMs)
  const aggressionRaw = str("OPENCODE_RESUME_AGGRESSION", DEFAULT_AGGRESSION).toLowerCase()
  const aggressionKey = Object.hasOwn(AGGRESSION_PRESETS, aggressionRaw)
    ? aggressionRaw
    : DEFAULT_AGGRESSION
  const preset = AGGRESSION_PRESETS[aggressionKey]
  const hasRawChain = process.env.OPENCODE_RESUME_MAX_CHAIN !== undefined
  const hasRawStall = process.env.OPENCODE_RESUME_MAX_STALL_TAKEOVERS !== undefined
  return {
    enabled: bool("OPENCODE_RESUME_ENABLED", DEFAULTS.enabled),
    budgetPrompts: bool("OPENCODE_RESUME_BUDGET_PROMPTS", DEFAULTS.budgetPrompts),
    reanimate: bool("OPENCODE_RESUME_REANIMATE", DEFAULTS.reanimate),
    maxChain: hasRawChain
      ? num("OPENCODE_RESUME_MAX_CHAIN", preset.maxChain)
      : preset.maxChain,
    maxStallTakeovers: hasRawStall
      ? Math.max(1, num("OPENCODE_RESUME_MAX_STALL_TAKEOVERS", preset.maxStallTakeovers))
      : preset.maxStallTakeovers,
    baseDelayMs: num("OPENCODE_RESUME_BASE_DELAY_MS", DEFAULTS.baseDelayMs),
    maxDelayMs: num("OPENCODE_RESUME_MAX_DELAY_MS", DEFAULTS.maxDelayMs),
    rateLimitBaseMs: num("OPENCODE_RESUME_RATE_LIMIT_BASE_MS", DEFAULTS.rateLimitBaseMs),
    outputLengthMax: num("OPENCODE_RESUME_OUTPUT_LENGTH_MAX", DEFAULTS.outputLengthMax),
    nudgeDelayMs: num("OPENCODE_RESUME_NUDGE_DELAY_MS", DEFAULTS.nudgeDelayMs),
    stallTimeoutMs: num("OPENCODE_RESUME_STALL_TIMEOUT_MS", DEFAULTS.stallTimeoutMs),
    thinkStallMs: num("OPENCODE_RESUME_THINK_STALL_MS", DEFAULTS.thinkStallMs),
    rearmMs: num("OPENCODE_RESUME_REARM_MS", DEFAULTS.rearmMs),
    watchdogMs: num("OPENCODE_RESUME_WATCHDOG_MS", DEFAULTS.watchdogMs),
    runningToolFactor: Math.max(1, num("OPENCODE_RESUME_RUNNING_TOOL_FACTOR", DEFAULTS.runningToolFactor)),
    retryTakeoverMs: num("OPENCODE_RESUME_RETRY_TAKEOVER_MS", DEFAULTS.retryTakeoverMs),
    retryFutureCapMs: num("OPENCODE_RESUME_RETRY_FUTURE_CAP_MS", DEFAULTS.retryFutureCapMs),
    reanimate: bool("OPENCODE_RESUME_REANIMATE", DEFAULTS.reanimate),
    reanimateWindowMs: num("OPENCODE_RESUME_REANIMATE_WINDOW_MS", DEFAULTS.reanimateWindowMs),
    favoriteReturn: bool("OPENCODE_RESUME_FAVORITE_RETURN", DEFAULTS.favoriteReturn),
    favoriteCheckAfterMs: num("OPENCODE_RESUME_FAVORITE_CHECK_AFTER_MS", DEFAULTS.favoriteCheckAfterMs),
    favoriteMinTurns: Math.max(1, num("OPENCODE_RESUME_FAVORITE_MIN_TURNS", DEFAULTS.favoriteMinTurns)),
    breakerThreshold: num("OPENCODE_RESUME_BREAKER_THRESHOLD", DEFAULTS.breakerThreshold),
    breakerWindowMs: num("OPENCODE_RESUME_BREAKER_WINDOW_MS", DEFAULTS.breakerWindowMs),
    breakerCooldownMs: num("OPENCODE_RESUME_BREAKER_COOLDOWN_MS", DEFAULTS.breakerCooldownMs),
    compactOnOverflow: bool("OPENCODE_RESUME_COMPACT_ON_OVERFLOW", DEFAULTS.compactOnOverflow),
    // New name wins; the pre-1.10 toast-era env var stays honored as fallback.
    noticeThrottleMs: num("OPENCODE_RESUME_NOTICE_THROTTLE_MS",
      num("OPENCODE_RESUME_TOAST_THROTTLE_MS", DEFAULTS.noticeThrottleMs)),
    autoUpdate: bool("OPENCODE_RESUME_AUTO_UPDATE", DEFAULTS.autoUpdate),
    maxTaskCostUsd: num("OPENCODE_AUTOPILOT_MAX_COST_USD", DEFAULTS.maxTaskCostUsd),
    // Rotation master switch — OFF by default. ALL rotation flags default to OFF.
    // Rotation is NEVER triggered silently. User must explicitly enable via
    // OPENCODE_RESUME_ROTATION_ENABLED=true to activate ANY rotation behavior.
    rotationEnabled: bool("OPENCODE_RESUME_ROTATION_ENABLED", false),
    /* Fast-burst retry for transient failures (403/5xx/network), used when
     * rotation is OFF — the default. With no other model to move to, retrying
     * the same one is the only recovery lever, so the early attempts come fast
     * and close together instead of escalating 5s, 10s, 20s, 40s… past an
     * outage that may have already cleared.
     *
     * The base defaults to BASE_DELAY_MS when that is set, so the documented
     * "how soon do we retry" knob still applies and suites that tune it down
     * keep working. fastRetryMaxMs is deliberately much lower than
     * maxDelayMs: this is a "keep pushing through it" posture, not a loop.
     */
    fastRetry: bool("OPENCODE_RESUME_FAST_RETRY", DEFAULTS.fastRetry),
    fastRetryBaseMs: num("OPENCODE_RESUME_FAST_RETRY_BASE_MS", Math.min(cfgBaseDelay(), DEFAULTS.fastRetryBaseMs)),
    fastRetryGrowth: num("OPENCODE_RESUME_FAST_RETRY_GROWTH", DEFAULTS.fastRetryGrowth),
    fastRetryMaxMs: num("OPENCODE_RESUME_FAST_RETRY_MAX_MS", DEFAULTS.fastRetryMaxMs),
    fastRetryMaxChain: num("OPENCODE_RESUME_FAST_RETRY_MAX_CHAIN", DEFAULTS.fastRetryMaxChain),
    switchOnQuota: bool("OPENCODE_RESUME_SWITCH_ON_QUOTA", DEFAULTS.switchOnQuota),
    switchOnRateLimit: bool("OPENCODE_RESUME_SWITCH_ON_RATELIMIT", DEFAULTS.switchOnRateLimit),
    switchOnFailures: bool("OPENCODE_RESUME_SWITCH_ON_FAILURES", DEFAULTS.switchOnFailures),
    disableRotation: bool("OPENCODE_RESUME_DISABLE_ROTATION", DEFAULTS.disableRotation),
    rlSwitchAfter: Math.max(1, num("OPENCODE_RESUME_RL_SWITCH_AFTER", 1)),
    rotateAfterFailures: Math.max(1, num("OPENCODE_RESUME_ROTATE_AFTER_FAILURES", DEFAULTS.rotateAfterFailures)),
    maxRotations: num("OPENCODE_RESUME_MAX_ROTATIONS", DEFAULTS.maxRotations),
    modelCooldownMs: num("OPENCODE_RESUME_MODEL_COOLDOWN_MS", DEFAULTS.modelCooldownMs),
    fallbackModels: str("OPENCODE_RESUME_FALLBACK_MODELS", DEFAULTS.fallbackModels),
    // Denylist of deprecated/unavailable models (comma-separated).
    // These are NEVER selected during rotation and put on permanent cooldown.
    denylistModels: str("OPENCODE_RESUME_DENYLIST_MODELS", DEFAULTS.denylistModels),
    autonomy: bool("OPENCODE_RESUME_AUTONOMY", DEFAULTS.autonomy),
    permissions: bool("OPENCODE_AUTOPILOT_PERMISSIONS", DEFAULTS.permissions),
    permissionMode: str("OPENCODE_AUTOPILOT_PERMISSION_MODE", DEFAULTS.permissionMode).toLowerCase(),
    extraDeny: str("OPENCODE_AUTOPILOT_EXTRA_DENY", DEFAULTS.extraDeny),
    // After N auto-approved "once" answers for the SAME benign external
    // directory boundary in one session, escalate to "always" (core saves the
    // proposed patterns for the session). 0 disables escalation.
    dirAlwaysAfter: num("OPENCODE_AUTOPILOT_DIR_ALWAYS_AFTER", DEFAULTS.dirAlwaysAfter),
    todoDrive: bool("OPENCODE_AUTOPILOT_TODO_DRIVE", DEFAULTS.todoDrive),
    debugNudge: bool("OPENCODE_AUTOPILOT_DEBUG_NUDGE", DEFAULTS.debugNudge),
    proposals: bool("OPENCODE_AUTOPILOT_PROPOSALS", DEFAULTS.proposals),
    proceedOnAsk: bool("OPENCODE_AUTOPILOT_PROCEED", DEFAULTS.proceedOnAsk),
    maxProceeds: num("OPENCODE_AUTOPILOT_MAX_PROCEEDS", DEFAULTS.maxProceeds),
    improveLoop: bool("OPENCODE_AUTOPILOT_IMPROVE", DEFAULTS.improveLoop),
    improveCycles: num("OPENCODE_AUTOPILOT_IMPROVE_CYCLES", DEFAULTS.improveCycles),
    improveMax: num("OPENCODE_AUTOPILOT_IMPROVE_MAX", DEFAULTS.improveMax),
    improveCooldownMs: num("OPENCODE_AUTOPILOT_IMPROVE_COOLDOWN_MS", DEFAULTS.improveCooldownMs),
    maxNudges: num("OPENCODE_AUTOPILOT_MAX_NUDGES", DEFAULTS.maxNudges),
    budgetMs: num("OPENCODE_AUTOPILOT_BUDGET_MS", DEFAULTS.budgetMs),
    maxDirAskCounts: num("OPENCODE_RESUME_MAX_DIR_ASK_COUNTS", DEFAULTS.maxDirAskCounts),
  }
}

const matchesAny = (haystack, patterns) => {
  if (!haystack || !Array.isArray(patterns) || patterns.length === 0) return false
  const lower = String(haystack).toLowerCase()
  return patterns.some((p) => {
    if (p instanceof RegExp) {
      p.lastIndex = 0
      return p.test(lower)
    }
    return lower.includes(String(p).toLowerCase())
  })
}

const isCreditsConstraint = (error) => {
  const msg = String(error?.data?.message ?? "").toLowerCase()
  const body = String(error?.data?.responseBody ?? "").toLowerCase()
  const combined = msg + " " + body
  return matchesAny(combined, MAX_TOKENS_PATTERNS)
}

const jitter = (ms) => Math.round(ms + ms * 0.25 * (Math.random() * 2 - 1))

// ── native OS notifications ─────────────────────────────────────────────
// The popup channel for rare milestone events (e.g. a completed self-update):
// renders even when no TUI/desktop client is attached. Best effort by design
// — every path resolves false instead of throwing.
//   • Windows  WinRT toast via PowerShell, balloon-tip fallback
//   • macOS    AppleScript display notification
//   • Linux    notify-send → raw D-Bus → WSL PowerShell bridge

const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'"

// WSL marker regex compiled once (used on every Linux notification dispatch).
const WSL_PROBE_RE = /microsoft|wsl/i
// Free/unlimited model-id markers — compiled once, used per-model in the
// rotation rank function.  Model ids are short so a substring match is
// enough; these never anchor.
const UNLIMITED_RE = /unlimited/
const FREE_RE = /free/

/** PowerShell source for one Windows notification: tries the modern WinRT
 *  toast first; if the AUMID is blocked (common on hardened builds), falls
 *  back to a NotifyIcon balloon tip, which Windows 10/11 render as a toast. */
const windowsToastPs = (title, message) => `
$ErrorActionPreference = 'Stop'
$title = ${psQuote(title)}
$text  = ${psQuote(message)}
# auto-resume's AUMID — registered lazily on first call so the toast shows
# "auto-resume" in the header, not "Windows PowerShell".  Falls back to
# the well-known PowerShell AUMID if Start Menu registration fails.
$aumid = 'auto-resume@neohiro'
try {
  $startMenu = [Environment]::GetFolderPath('Programs')
  $lnkPath   = Join-Path $startMenu 'auto-resume.lnk'
  $iconPath  = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'auto-resume\\auto-resume.ico'
  if (-not (Test-Path $iconPath)) {
    $iconDir = Split-Path $iconPath -Parent
    if (-not (Test-Path $iconDir)) { [void](New-Item -ItemType Directory -Path $iconDir -Force) }
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap 32,32
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromArgb(255, 30, 30, 30))
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 80, 200, 120))
    $g.FillEllipse($brush, 4, 4, 24, 24)
    $brush2 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    $font = New-Object System.Drawing.Font 'Segoe UI', 14, ([System.Drawing.FontStyle]::Bold)
    $g.DrawString('A', $font, $brush2, 7, 4)
    $g.Dispose(); $brush.Dispose(); $brush2.Dispose(); $font.Dispose()
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $fs = [System.IO.File]::Create($iconPath)
    $icon.Save($fs); $fs.Close(); $icon.Dispose(); $bmp.Dispose()
  }
  if (-not (Test-Path $lnkPath)) {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnkPath)
    $sc.TargetPath = 'powershell.exe'
    $sc.IconLocation = "$iconPath,0"
    $sc.Save()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws)
  }
  $sig = @"
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern void SetCurrentProcessExplicitAppUserModelID([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string AppID);
"@
  if (-not ('Pinvoke' -as [type])) { Add-Type -MemberDefinition $sig -Name Pinvoke }
  [Pinvoke]::SetCurrentProcessExplicitAppUserModelID($aumid)
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $nodes = $xml.GetElementsByTagName('text')
  [void]$nodes.Item(0).AppendChild($xml.CreateTextNode($title))
  [void]$nodes.Item(1).AppendChild($xml.CreateTextNode($text))
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show(
    [Windows.UI.Notifications.ToastNotification]::new($xml))
  exit 0
} catch {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $tip = New-Object System.Windows.Forms.NotifyIcon
    $tip.Icon = [System.Drawing.SystemIcons]::Information
    $tip.Visible = $true
    $tip.BalloonTipTitle = $title
    $tip.BalloonTipText = $text
    $tip.ShowBalloonTip(10000)
    Start-Sleep -Seconds 11
    $tip.Dispose()
    exit 0
  } catch { exit 1 }
}`

/** Build a best-effort OS notifier bound to an OpenCode shell runner ($).
 *  platform / systemRoot / wslVersionFile are injectable so tests can drive
 *  every OS branch without mutating process globals. Returns
 *  async (title, message) => boolean — true once a notifier accepted the job.
 *  Every dispatch races a hard timeout (default 15s): headless hosts can hang
 *  indefinitely inside D-Bus autolaunch, and an un-resolving await would
 *  silently swallow both the notification AND its failure reporting.
 *
 *  The shell runner is accepted in two shapes:
 *    1. Bun's tagged-template literal:  $\`exe -arg val\`         (call-site uses backticks)
 *    2. A plain function:               $(cmd, [args])            (Node, child_process.spawn-like)
 *  We build argv arrays and dispatch via shape 2; this also dodges the
 *  PowerShell argument-parsing landmines that template-interpolated spaces
 *  create.  When no shell runner is provided, every platform falls through
 *  to a tiny JSON drop-file next to the plugin so the TUI / launcher can
 *  surface the notice to the user — better than going silent. */
const NOTIFIER_TIMEOUT_MS = OS_NOTIFICATION_TIMEOUT_MS
export const createOsNotifier = ({
  $,
  platform = process.platform,
  systemRoot = process.env.SystemRoot,
  wslVersionFile = "/proc/version",
  timeoutMs = NOTIFIER_TIMEOUT_MS,
  dropFile = null, // tests: inject a memory-backed drop instead of writing disk
  dropMaxBytes = NOTICE_DROP_MAX_BYTES,
  dropKeepLines = NOTICE_DROP_KEEP_LINES,
  dropLockTimeoutMs = NOTICE_DROP_LOCK_TIMEOUT_MS,
  dropLockStaleMs = NOTICE_DROP_LOCK_STALE_MS,
} = {}) => {
  const withTimeout = (p) =>
    new Promise((resolve, reject) => {
      // Keep this timer ref'd while a dispatch is pending: it is what resolves
      // hung dispatches on an otherwise idle event loop.
      const timer = setTimeout(() => reject(new Error(`notifier timed out after ${timeoutMs}ms`)), timeoutMs)
      // Clear the watchdog as soon as the dispatch settles. Without this,
      // every successful notification leaves a timeout-length timer behind,
      // keeping the event loop (and sometimes the host process) alive needlessly.
      Promise.resolve(p).then(
        (value) => { clearTimeout(timer); resolve(value) },
        (err) => { clearTimeout(timer); reject(err) },
      )
    })

  /** Invoke the host shell runner with an argv array.  Bun's $\`…\` returns
   *  a thenable with .quiet; a plain function returns a Promise.  Both shapes
   *  are accepted so the plugin works under Bun, plain Node, and OpenCode's
   *  injected $ alike.  Resolves to the runner's resolved value; rejects with
   *  any error the runner surfaced. */
  const runShell = async (cmd, args) => {
    if (!($ && typeof $ === "function")) throw new Error("no shell runner")
    try {
      const ret = $(cmd, args)
      const p = ret && typeof ret.then === "function" ? ret : Promise.resolve(ret)
      if (ret && typeof ret === "object" && typeof ret.quiet === "function") {
        return await ret.quiet()
      }
      return await p
    } catch (err) {
      // Some runners throw on non-zero exit; the caller decides what that means.
      throw err
    }
  }

  /** Bound the drop file's growth. The file is append-only and this plugin
   *  runs for weeks at a time, and every notice that cannot reach a real OS
   *  channel lands here as a line — so without a cap it grows without bound on
   *  exactly the hosts that can least afford the disk churn (those where the
   *  notifier is broken and *every* notice falls back to the file).
   *
   *  Compaction rewrites the SAME path in place rather than rotating to a
   *  sidecar: the TUI tails this file, and rotating would strand a tailer on
   *  the old inode. The rewrite goes through a tmp + rename so a tailer never
   *  observes a half-written file, with a plain overwrite as the fallback for
   *  the Windows sharing violations that path exists to absorb.
   *
   *  Same-process drops are serialised by drop() before this runs, so no
   *  additional in-process compaction guard is needed here. Cross-process
   *  overlap is prevented by the file lock acquired in drop(). */
  const compactDropFile = async (fs) => {
    if (!dropFile || dropMaxBytes <= 0) return
    let size = 0
    try { size = (await fs.stat(dropFile)).size } catch { return } // missing file: nothing to compact
    if (size <= dropMaxBytes) return
    const raw = await fs.readFile(dropFile, "utf8")
    const kept = raw.split("\n").filter(Boolean).slice(-dropKeepLines)
    if (!kept.length) return
    const text = `${kept.join("\n")}\n`
    const tmp = `${dropFile}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.writeFile(tmp, text, "utf8")
      try { await fs.rename(tmp, dropFile) }
      catch {
        // Windows: the tailer may hold the destination open. Losing atomicity
        // is preferable to losing the log.
        await fs.writeFile(dropFile, text, "utf8")
      }
    } finally {
      try { await fs.unlink(tmp) } catch { /* renamed away, or already gone */ }
    }
  }

  /** Cross-process mutual exclusion for the compact-then-append sequence.
   *  Same-process drops are already serialised by drop(), so this lock only
   *  needs to coordinate separate OpenCode instances sharing one plugin
   *  directory: without it, one instance could append between another's
   *  compact-read and compact-write and lose its notice to the rename.
   *
   *  The lock is existence-based (`wx` exclusive create) with a JSON
   *  {pid, ts, token} payload. Only a lock whose timestamp is provably
   *  older than dropLockStaleMs is ever reaped — an unreadable or fresh
   *  lock is waited on, never stolen, so a slow holder is delayed, not
   *  corrupted. Release deletes the lock only when its token still
   *  matches, so we can never remove a successor's fresh lock.
   *
   *  Failing to acquire the lock forfeits COMPACTION for this notice, not
   *  the notice itself: the caller still appends. A best-effort log must
   *  degrade to unbounded-before-silent, never the reverse. */
  const acquireDropLock = async (fs, lockPath) => {
    const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    const deadline = Date.now() + dropLockTimeoutMs
    for (;;) {
      let handle
      try {
        handle = await fs.open(lockPath, "wx")
      } catch (err) {
        if (err?.code !== "EEXIST") return null
        let stale = false
        try {
          const ts = JSON.parse(await fs.readFile(lockPath, "utf8"))?.ts
          stale = Number.isFinite(ts) && Date.now() - ts > dropLockStaleMs
        } catch { /* unreadable lock: wait, never steal */ }
        if (stale) {
          await fs.unlink(lockPath).catch(() => {})
          continue
        }
        if (Date.now() >= deadline) return null
        await new Promise((r) => setTimeout(r, 25))
        continue
      }
      try {
        // A failed payload write must not leak the lock handle, even though
        // acquisition itself is about to be abandoned.
        await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now(), token }))
      } finally {
        await handle.close().catch(() => {})
      }
      let released = false
      return async () => {
        if (released) return
        released = true
        try {
          const raw = await fs.readFile(lockPath, "utf8").catch(() => "")
          if (raw.includes(token)) await fs.unlink(lockPath).catch(() => {})
        } catch { /* best effort */ }
      }
    }
  }

  /** Serialise drops inside this process so same-process notices never
   *  contend on the file lock with each other — they queue here instead,
   *  and the file lock stays purely a cross-process mechanism. */
  let dropChain = Promise.resolve()
  const serializeDrop = (fn) => {
    const run = dropChain.then(fn, fn)
    dropChain = run.catch(() => {})
    return run
  }

  /** Best-effort user-visible fallback: append a tiny JSON line to a drop file
   *  next to the plugin.  The TUI / launcher tails this file and surfaces
   *  unread entries as transient banners — guaranteed to land somewhere the
   *  user can see, even on hosts without a working OS notifier. */
  const drop = async (title, message) => {
    if (typeof dropFile === "function") {
      try { await dropFile(title, message); return true } catch { return false }
    }
    if (!dropFile) return false
    return serializeDrop(async () => {
      try {
        const { mkdir, appendFile, stat, readFile, writeFile, rename, unlink, open } = await import("node:fs/promises")
        const { dirname } = await import("node:path")
        await mkdir(dirname(dropFile), { recursive: true })
        const release = await acquireDropLock({ open, readFile, unlink }, `${dropFile}.lock`).catch(() => null)
        try {
          // Deliberately swallowed: failing to compact must never cost us the
          // notice itself, so the append below is attempted either way.
          if (release) {
            await compactDropFile({ stat, readFile, writeFile, rename, unlink }).catch(() => {})
          }
          const line = JSON.stringify({ ts: Date.now(), title, message }) + "\n"
          await appendFile(dropFile, line, "utf8")
          return true
        } finally {
          await release?.().catch(() => {})
        }
      } catch { return false }
    })
  }

  let wslCache
  const wslProbe = () =>
    platform !== "linux"
      ? Promise.resolve("")
      : (wslCache ??= import("node:fs/promises")
          .then(({ readFile }) => readFile(wslVersionFile, "utf8"))
          .catch(() => ""))

  const runPowerShellToast = async (exe, title, message) => {
    const encoded = Buffer.from(windowsToastPs(title, message), "utf16le").toString("base64")
    // Pass as argv; avoids the host shell re-parsing a long string and the
    // template-literal `cmd ${val}` path that produced empty commands when
    // OpenCode injected $ as a plain function.
    await withTimeout(
      runShell(exe, [
        "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-EncodedCommand", encoded,
      ]),
    )
  }

  /** Try the OS channel; if every attempt fails, drop a JSON entry and
   *  resolve true so the caller still has confidence the user was told. */
  return async (title, message) => {
    const dropFallback = async () => {
      const ok = await drop(title, message)
      return ok
    }
    try {
      if (!($ && typeof $ === "function")) return await dropFallback()
      if (platform === "win32") {
        await runPowerShellToast(
          `${systemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
          title, message)
        return true
      }
      if (platform === "darwin") {
        // AppleScript double-quoted strings: escape backslashes first, then quotes
        const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
        await withTimeout(
          runShell("osascript", ["-e", `display notification ${q(message)} with title ${q(title)}`]),
        )
        return true
      }
      // Linux/BSD: WSL hosts delegate to Windows PowerShell; bare metal uses
      // libnotify first and the raw D-Bus Notifications API as fallback.
      if (WSL_PROBE_RE.test(await wslProbe())) {
        await runPowerShellToast("powershell.exe", title, message)
        return true
      }
      try {
        await withTimeout(
          runShell("notify-send", ["-a", "auto-resume", title, message]),
        )
        return true
      } catch { /* no libnotify installed */ }
      await withTimeout(
        runShell("dbus-send", [
          "--session", "--type=method_call",
          "--dest=org.freedesktop.Notifications",
          "/org/freedesktop/Notifications",
          "org.freedesktop.Notifications.Notify",
          `string:${title}`, "uint32:0", "string:dialog-information",
          `string:${title}`, `string:${message}`,
          "array:string:", "dict:string:string:", "int32:5000",
        ]),
      )
      return true
    } catch {
      return await dropFallback()
    }
  }
}

/** Plan kinds that take part in the anti-redundant-repeat heuristic in
 *  schedule(). A back-to-back repeat of one of these, with no observed
 *  progress, is almost always the model asking the same question twice.
 *
 *  "empty" is deliberately excluded: the empty-streak ladder has its own
 *  escalation, and nothing increments `chain` on that path, so an empty turn
 *  would always look like an unmoved-chain repeat and hijack the third nudge
 *  into the tool-failure prompt. "debug" is excluded because it is the
 *  escalation target itself. "retry"/"takeover" are excluded: they only fire
 *  after real failures, and S13 pins that they never escalate. */
const SAME_KIND_WATCHED = new Set(["proceed", "drive"])

/** Graceful-shutdown hooks are process-global: every plugin instantiation
 *  registers its own cleanup, but the process.on listeners are attached
 *  exactly once and fan out to all registered cleanups. Without this, each
 *  instantiation adds 3 permanent listeners (node warns past 10) — a slow
 *  leak in long-lived hosts that hot-reload the plugin. */
const shutdownCleanups = []
let shutdownHooksArmed = false
const armShutdownHooks = () => {
  if (shutdownHooksArmed) return
  shutdownHooksArmed = true
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    try {
      process.on(sig, () => {
        for (const fn of [...shutdownCleanups]) {
          try { fn() } catch { /* best effort */ }
        }
      })
    } catch { /* not available in all environments */ }
  }
}

export const createEngine = async ({ client }) => {
  const cfg = loadConfig()

  const sessions = new Map() // sessionID -> state
  const permissionPending = new Map() // sessionID -> timestamp (for watchdog)
  const permissionPendingById = new Map() // "sessionID|permID" -> timestamp (for dedupe)
  const modelCooldown = new Map() // "provider/model" -> untilTs
  const timers = new Map()
  const scheduledKinds = new Set() // sessionID|kind -> prevents duplicate schedules
  const breakerFailures = []
  let breakerOpenUntil = 0
  let breakerNoted = false
  let lastNoticeAt = 0
  let catalogCache = null
  let catalogFetchedAt = 0
  let cachedPermFns = null
  let lastReanimateAt = 0
  let firstSessionActivity = true

  // This file's own path on disk (also used by the self-updater below).
  const selfPath = (() => {
    try {
      if (!import.meta.url.startsWith("file:")) return null
      return decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1")
    } catch { return null }
  })()

  // ── persistent JSON sidecars next to this file ─────────────────────────
  // Three tiny maps survive OpenCode restarts:
  //   • .stopped.json — sessions the user STOPPED (quiet until next prompt)
  //   • .off.json     — sessions where auto-resume is turned OFF entirely
  //   • .paused.json  — sessions the user PAUSED (visible 🚫, quiet until "on")
  // Ancient markers are forgotten after STORE_TTL_MS (module scope).

  const makeMapStore = (label, path) => {
    const map = new Map() // sessionID -> timestamp
    let loading = null
    let saveChain = Promise.resolve()
    const load = () => {
      if (!path) return Promise.resolve()
      // Single-flight: every caller awaits the SAME read, so a revival scan
      // racing the init load always observes the fully restored markers.
      loading ??= (async () => {
        try {
          const { readFile } = await import("node:fs/promises")
          const rawText = await readFile(path, "utf8")
          const decrypted = decryptPayload(rawText)
          const raw = JSON.parse(decrypted)
          const cutoff = Date.now() - STORE_TTL_MS
          if (raw && typeof raw === "object") {
            for (const [id, ts] of Object.entries(raw)) {
              if (typeof ts === "number" && ts > cutoff) map.set(id, ts)
            }
          }
          log("info", `restored persisted ${label}`, { count: map.size })
        } catch { /* no store yet (or unreadable) — start empty */ }
      })()
      return loading
    }
    const writeOnce = async () => {
      if (!path) return
      const out = {}
      const cutoff = Date.now() - STORE_TTL_MS
      for (const [id, ts] of map) if (ts > cutoff) out[id] = ts
      const payload = encryptPayload(JSON.stringify(out, null, 2))
      const tmp = `${path}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
      try {
        await writeFile(tmp, payload, "utf8")
        // Windows: freshly written files can be briefly locked (AV/indexer), so
        // the atomic rename may fail with EPERM/EACCES/EBUSY — retry with
        // backoff, then fall back to a plain overwrite of the final path.
        for (const delayMs of [25, 50, 100, 200, 400]) {
          try {
            // A successful rename consumes `tmp`, so the finally below has
            // nothing left to remove on this path.
            await rename(tmp, path)
            return
          } catch (err) {
            if (!["EPERM", "EACCES", "EBUSY", "EEXIST"].includes(err?.code)) throw err
            await new Promise((r) => setTimeout(r, delayMs))
          }
        }
        // All retries failed: plain overwrite the final path. tmp is left
        // intact for the finally block below to clean up.
        await writeFile(path, payload, "utf8")
      } finally {
        // The store used to clean up only on the "all retries failed" path, so
        // a non-retryable rename error (ENOSPC, EROFS, ...) propagated out of
        // writeOnce and orphaned a uniquely-suffixed tmp file. Every orphan is
        // permanent: the name embeds a timestamp + random suffix, so nothing
        // ever overwrites or collects it. Hoisting the cleanup to `finally`
        // covers the throw path too. On the success path unlink is a no-op
        // (rename already moved the file) and its ENOENT is swallowed.
        try { await unlink(tmp) } catch { /* already gone or locked */ }
      }
    }
    // Serialize saves: overlapping renames on the same destination are the
    // main source of transient Windows sharing violations.
    const save = () => {
      saveChain = saveChain.then(writeOnce).catch((err) =>
        log("warn", `could not persist ${label}`, { err: err?.message ?? String(err) }))
      return saveChain
    }
    return { map, load, save }
  }

  /** Generic object store for non-timestamp values (e.g., provider health metrics). */
  const makeObjectStore = (label, path) => {
    const map = new Map() // key -> arbitrary object
    let loading = null
    let saveChain = Promise.resolve()
    const load = () => {
      if (!path) return Promise.resolve()
      loading ??= (async () => {
        try {
          const { readFile } = await import("node:fs/promises")
          const rawText = await readFile(path, "utf8")
          const decrypted = decryptPayload(rawText)
          const raw = JSON.parse(decrypted)
          if (raw && typeof raw === "object") {
            for (const [key, val] of Object.entries(raw)) {
              if (val && typeof val === "object") map.set(key, val)
            }
          }
          log("info", `restored persisted ${label}`, { count: map.size })
        } catch { /* no store yet (or unreadable) — start empty */ }
      })()
      return loading
    }
    const writeOnce = async () => {
      if (!path) return
      const out = {}
      for (const [key, val] of map) out[key] = val
      const payload = encryptPayload(JSON.stringify(out, null, 2))
      const tmp = `${path}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
      try {
        await writeFile(tmp, payload, "utf8")
        for (const delayMs of [25, 50, 100, 200, 400]) {
          try {
            await rename(tmp, path)
            return
          } catch (err) {
            if (!["EPERM", "EACCES", "EBUSY", "EEXIST"].includes(err?.code)) throw err
            await new Promise((r) => setTimeout(r, delayMs))
          }
        }
        await writeFile(path, payload, "utf8")
      } finally {
        try { await unlink(tmp) } catch { /* already gone or locked */ }
      }
    }
    const save = () => {
      saveChain = saveChain.then(writeOnce).catch((err) =>
        log("warn", `could not persist ${label}`, { err: err?.message ?? String(err) }))
      return saveChain
    }
    return { map, load, save }
  }

  const stopStore = makeMapStore(
    "user-stops",
    str("OPENCODE_RESUME_STOPSTORE", selfPath ? `${selfPath}.stopped.json` : ""),
  )
  const offStore = makeMapStore(
    "opt-outs",
    str("OPENCODE_RESUME_OFFSTORE", selfPath ? `${selfPath}.off.json` : ""),
  )
  // Pause is a separate persisted store: "off" strips the title, "pause" keeps
  // the 🚫 indicator visible.  Sharing offStore would conflate the two and
  // we couldn't tell which mode to restore on startup.
  const pauseStore = makeMapStore(
    "user-pauses",
    str("OPENCODE_RESUME_PAUSESTORE", selfPath ? `${selfPath}.paused.json` : ""),
  )
  const activeSessionStore = makeMapStore(
    "active-sessions",
    str("OPENCODE_RESUME_ACTIVESTORE", selfPath ? `${selfPath}.active.json` : ""),
  )
  // Provider health cache — tracks per-model success/failure rates across restarts
  // to bias rotation away from flaky models. Key: "provider/model", value: {success, failures, lastUpdated}
  const providerHealthStore = makeObjectStore(
    "provider-health",
    str("OPENCODE_RESUME_HEALTHSTORE", selfPath ? `${selfPath}.health.json` : ""),
  )
  // Startup snapshot of sessions that were active before restart.
  // Used by reanimate() on server.connected to avoid reviving current-run sessions.
  let startupActiveSnapshot = new Map()
  const recordActiveSession = (sessionID) => {
    if (!sessionID || typeof sessionID !== "string" || sessionID.length > 256) return
    if (suppressed(sessionID)) return
    activeSessionStore.map.set(sessionID, Date.now())
    // Fire-and-forget save; serialize via saveChain to avoid Windows sharing violations
    activeSessionStore.save()
  }

  const DEPRECATION_PATTERNS = [
    "deprecated", "model is deprecated", "model has been deprecated",
    "sunset", "sunsetted", "discontinued", "no longer supported",
    "shut down", "shutdown", "retired", "eol",
  ]
  const isDeprecatedError = (error) => {
    const data = error?.data ?? {}
    const text = `${data.message ?? ""} ${data.responseBody ?? ""} ${error?.message ?? ""}`.toLowerCase()
    const code = Number(data.statusCode)
    if (code === 404 || code === 410) return true
    return matchesAny(text, DEPRECATION_PATTERNS)
  }
  const modelFailureVelocities = new Map()
  const cleanModelFailureVelocities = (nowMs) => {
    for (const [key, failures] of modelFailureVelocities) {
      const filtered = failures.filter((ts) => nowMs - ts < FAILURE_VELOCITY_WINDOW_MS)
      if (filtered.length === 0) modelFailureVelocities.delete(key)
      else modelFailureVelocities.set(key, filtered)
    }
  }
  const persistedStops = stopStore.map

  /** Stopped = flagged live this run OR remembered from a previous run. */
  const isUserStopped = (sessionID) =>
    Boolean(sessions.get(sessionID)?.userStopped || persistedStops.has(sessionID))

  /** Paused = user said "auto-resume pause" — visible 🚫, suppressed until "on". */
  const isUserPaused = (sessionID) =>
    Boolean(sessions.get(sessionID)?.userPaused || pauseStore.map.has(sessionID))

  /** Opted out = auto-resume fully disabled for this session by the user. */
  const isOptedOut = (sessionID) => offStore.map.has(sessionID)

  /** Anything automation might do for this session is blocked. */
  const suppressed = (sessionID) =>
    isUserStopped(sessionID) || isOptedOut(sessionID) || isUserPaused(sessionID)

  // ── per-session title indicator ────────────────────────────────────────
  // While auto-resume is enabled for a session, its title is decorated as:
  //   "<glyph> <base title> [auto-resume: <status>]"
  // (leading status glyph + trailing bracket tag). Turning auto-resume off
  // restores the exact previous title — no trace of the plugin remains.
  const TITLE_MARK_TEST = /\[auto-resume:/i
  const TITLE_MARK_STRIP = /\s*\[auto-resume:[^\]]*\]/gi
  // Leading glyph is OUR exclusive status signal. It REPLACES (not appends)
  // so one glance tells the user the most actionable state, even when several
  // are true at once. Priority order: stopped > paused > recovering > armed.
  // Every paused sub-state uses 🚫 as the leading glyph (the user prefers
  // that one character for "I stopped because the plugin decided to") and
  // disambiguates the cause in the trailing label — the leading character
  // never changes between pause causes, only the text inside the brackets.
  // 🟢🔁⏸️⏳💰📋🧪💤🔴 are the active/armed/recovering glyphs; 🚫 is the
  // universal "paused by auto-resume" signal; ❓ is the model-is-asking
  // state (set on question-pattern detection, cleared on user action or
  // the next clean turn).
  const GLYPH_LEAD_RE = /^\s*(?:🟢|🔁|⏸️|🚫|⏳|💸|🔕|🪙|📋|🧪|✅|🏁|🔄|⏱|💤|🟡|🔴|❓)\s+/u
  const STATUS_STYLE = {
    asking:      { glyph: "❓", label: "asking" },
    armed:        { glyph: "🟢", label: "armed" },
    recovering:   { glyph: "🔁", label: "recovering" },
    // User active stop (mid-turn): ⏸️ — the core Stop button was pressed.
    stopped:      { glyph: "⏸️", label: "stopped" },
    // User said "auto-resume pause": 🚫 visible in title; suppressed until "on".
    userPaused:  { glyph: "⏸️", label: "paused by you" },
    // Cap-based pauses: cause-built label, 🚫 glyph throughout.
    pausedCost:   { glyph: "🚫", label: "paused · cost cap" },
    pausedBudget: { glyph: "🚫", label: "paused · time budget" },
    pausedNudges: { glyph: "🚫", label: "paused · nudges" },
    pausedRetry:  { glyph: "🚫", label: "paused · retries" },
    pausedRot:    { glyph: "🚫", label: "paused · rotations" },
    // Armed sub-states: each gets its own leading glyph because they need
    // different action (top up / run todos / wait / inspect / nothing).
    lowBudget:    { glyph: "🪙", label: "armed · tight budget" },
    todo:         { glyph: "📋", label: "armed · todo drive" },
    improving:    { glyph: "🧪", label: "armed · improving" },
    improved:     { glyph: "✅", label: "armed · improved" },
    proposing:    { glyph: "🏁", label: "armed · wrap-up" },
    idle:         { glyph: "💤", label: "armed · idle" },
    fatal:        { glyph: "🔴", label: "armed · unrecoverable" },
  }
  const knownTitles = new Map()   // sessionID -> latest raw title we saw
  const writtenTitles = new Map() // sessionID -> last title this plugin wrote
  const titleTimers = new Map()   // sessionID -> debounce timer

  /** Remove our trailing tag; strip a leading STATUS glyph if present — those
   *  four glyphs are ours exclusively, so decoration never accumulates even
   *  when OpenCode's auto-titler echoes decorated text back. */
  const extractBaseTitle = (raw) => {
    let s = String(raw).replace(TITLE_MARK_STRIP, "").trimEnd()
    const m = GLYPH_LEAD_RE.exec(s)
    if (m) s = s.slice(m[0].length)
    return s.trimEnd()
  }

  const statusKeyOf = (sessionID) => {
    const s = sessions.get(sessionID)
    if (s?.userStopped || persistedStops.has(sessionID)) return "stopped"
    if (isUserPaused(sessionID)) return "userPaused"

    if (s?.costNotified || (cfg.maxTaskCostUsd > 0 && (s?.taskCost ?? 0) >= cfg.maxTaskCostUsd))
      return "pausedCost"
    if (s?.chain >= cfg.maxChain) return "pausedRetry"
    if (s?.rotations >= cfg.maxRotations) return "pausedRot"
    if (s?.nudges >= cfg.maxNudges) return "pausedNudges"
    if (cfg.budgetMs > 0 && s?.taskStartAt && Date.now() - s.taskStartAt >= cfg.budgetMs)
      return "pausedBudget"

    // Armed sub-states: most actionable signal first.
    // Fatal / auth error: 🔴 tells user it can't self-heal.
    if (s?.lastErrorName === "fatal" || s?.lastErrorName === "auth") return "fatal"
    if (s?.lowBudgetStreak > 0) return "lowBudget"
    if (s?.todos?.some((t) => t.status !== "completed" && t.status !== "cancelled")) return "todo"

    // Self-improvement active: 🧪 — set true when a cycle is in flight,
    // cleared when all cycles are done. Checked before recovering so the
    // model isn't masked by a generic 🔁 while it's actively working.
    if (s?.improveActive) return "improving"

    // Post-completion window: ✅ — shown briefly after all cycles finish so
    // the user sees explicit confirmation before returning to armed/idle.
    if (s?.improvedAt > 0 && (s?.improveDone ?? 0) >= (cfg.improveCycles ?? 1)) {
      if (Date.now() - s.improvedAt < IMPROVED_TITLE_WINDOW_MS) return "improved"
    }

    // Model asked a question (❓): set when the plugin detects a question
    // pattern and schedules an auto-proceed. Cleared immediately when the user
    // sends a new prompt or the next assistant turn resolves the chain.
    if (s?.askingSince) return "asking"

    // Active recovery: 🔁 only while something is genuinely happening and
    // no more-specific armed sub-state is active.
    if (s && (s.pendingResume || s.retryEnteredAt > 0 || s.status === "retry" ||
        (s.status === "busy" && s.lastResumeAt > Math.max(s.lastErrorAt, s.lastSuccessAt))))
      return "recovering"

    if (s?.proposalSent) return "proposing"
    const quietFor = s ? Date.now() - (s.lastActivity ?? 0) : 0
    if (quietFor > 5 * 60_000) return "idle"

    return "armed"
  }

  /** Compose the human-readable sub-state suffix shown inside the trailing
   *  `[auto-resume: <status>]` tag.  Returns a list of dot-separated
   *  fragments; the caller joins them.  Sub-states are ranked by importance
   *  so the most actionable signal lands first when space is tight. */
  let titleApiCache // undefined = not yet resolved; false = unavailable
  const resolveSessionUpdate = () => {
    if (titleApiCache !== undefined) return titleApiCache
    const ns = client.session ?? {}
    const fn =
      ns.update ?? ns.updateSessionById ?? ns.patchSessionById ?? ns.patchSessionId ??
      Object.keys(ns)
        .map((k) => ns[k])
        .find((f) => typeof f === "function" && f.name && /(update|patch|rename)/i.test(f.name))
    titleApiCache = typeof fn === "function" ? fn : false
    log("info", titleApiCache
      ? `title indicator bound to client.session.${titleApiCache.name || "(anonymous)"}`
      : "title indicator unavailable: no session-update API found on this SDK")
    return titleApiCache
  }

  const fetchSessionTitle = async (sessionID) => {
    const ns = client.session ?? {}
    try {
      const get =
        ns.get ?? ns.getSessionById ??
        Object.keys(ns)
          .map((k) => ns[k])
          .find((f) => typeof f === "function" && f.name && /^get/i.test(f.name))
      if (typeof get === "function") {
        const res = await get.call(ns, { path: { id: sessionID } })
        const data = res?.data ?? res
        if (typeof data?.title === "string") return data.title
      }
    } catch { /* fall through to list */ }
    try {
      const res = await client.session.list()
      const list = (res?.data ?? res) ?? []
      const hit = Array.isArray(list) ? list.find((x) => x?.id === sessionID) : null
      if (typeof hit?.title === "string") return hit.title
    } catch { /* ignore */ }
    return null
  }

  const refreshTitleNow = async (sessionID) => {
    try {
      if (sessions.get(sessionID)?.child) return
      const update = resolveSessionUpdate()
      if (typeof update !== "function") return
      let raw = knownTitles.get(sessionID)
      if (raw == null) {
        raw = await fetchSessionTitle(sessionID)
        if (raw == null) return
        knownTitles.set(sessionID, raw)
      }
      const base = extractBaseTitle(raw)
      if (isOptedOut(sessionID)) {
        // Off: restore the pristine title — remove every trace of us.
        if (base !== raw) {
          await update.call(client.session, { path: { id: sessionID }, body: { title: base } })
          log("info", "title restored (auto-resume off)", { sessionID })
        }
        writtenTitles.delete(sessionID)
        knownTitles.set(sessionID, base)
        return
      }
      const style = STATUS_STYLE[statusKeyOf(sessionID)]
      const target = `${style.glyph} ${base} [auto-resume: ${style.label}]`
      if (target === raw || target === writtenTitles.get(sessionID)) return
      await update.call(client.session, { path: { id: sessionID }, body: { title: target } })
      writtenTitles.set(sessionID, target)
      knownTitles.set(sessionID, target)
      log("info", `title indicator → ${style.label}`, { sessionID })
    } catch (err) {
      log("warn", "title indicator update failed", { sessionID, err: err?.message ?? String(err) })
    }
  }

  /** Coalesce bursts of transitions into one PATCH per session. */
  const queueTitleRefresh = (sessionID) => {
    if (sessions.get(sessionID)?.child) return
    const existing = titleTimers.get(sessionID)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      titleTimers.delete(sessionID)
      detach(refreshTitleNow(sessionID), "title-refresh")
    }, TITLE_REFRESH_DEBOUNCE_MS)
    t.unref?.()
    titleTimers.set(sessionID, t)
  }

  /** Zero-trace guarantee after restarts: if a crash landed between an opt-out
   *  and its restore PATCH, the stored title may still carry a stale tag —
   *  sweep every opted-out session once the stores are loaded. Idempotent
   *  (clean titles produce no PATCH). */
  const restoreOptedOutTitles = () => {
    // off: strip the title; pause: re-apply the 🚫 indicator.
    for (const id of [...offStore.map.keys()]) queueTitleRefresh(id)
    for (const id of [...pauseStore.map.keys()]) queueTitleRefresh(id)
  }

  /** In-chat switch: "auto-resume off" (silent, strip title), "auto-resume pause"
   *  (visible 🚫 title, suppress injections until "on"), "auto-resume on" re-arms.
   *  Off and pause are both persisted across restarts via separate stores. */
  const handleToggleCommand = (sessionID, mode) => {
    const s = state(sessionID)
    if (mode === "off") {
      offStore.map.set(sessionID, Date.now())
      offStore.save()
      // an explicit opt-out supersedes any stop/pause marker
      s.userStopped = false
      s.userPaused = false
      if (pauseStore.map.delete(sessionID)) pauseStore.save()
      if (persistedStops.delete(sessionID)) stopStore.save()
      const t = timers.get(sessionID)
      if (t) { clearTimeout(t); timers.delete(sessionID) }
      log("info", "auto-resume disabled for session", { sessionID })
      notice(`${RESUME_TAG}: Off for this session — nothing will be automated here until you say "auto-resume on".`, "info")
      queueTitleRefresh(sessionID)
      return
    }
    if (mode === "pause") {
      // "pause": suppress injections, keep title visible with 🚫 glyph.
      // Persisted in pauseStore so it survives restarts too.
      s.userStopped = false
      s.userPaused = true
      pauseStore.map.set(sessionID, Date.now())
      pauseStore.save()
      if (offStore.map.delete(sessionID)) offStore.save()
      if (persistedStops.delete(sessionID)) stopStore.save()
      const t = timers.get(sessionID)
      if (t) { clearTimeout(t); timers.delete(sessionID) }
      log("info", "auto-resume paused for session", { sessionID })
      notice(`${RESUME_TAG}: Paused — say "auto-resume on" to resume.`, "info")
      queueTitleRefresh(sessionID)
      return
    }
    // mode === "on"
    const wasOff = isOptedOut(sessionID)
    if (offStore.map.delete(sessionID)) offStore.save()
    if (pauseStore.map.delete(sessionID)) pauseStore.save()
    if (persistedStops.delete(sessionID)) stopStore.save()
    resetTaskScope(s)
    s.userStopped = false
    s.userPaused = false
    s.currentModel = null
    s.emptyNudges = 0
    s.emptyStreak = false
    log("info", "auto-resume enabled for session", { sessionID })
    notice(`${RESUME_TAG}: ${wasOff ? "On again for this session" : "Already on here"} — armed. 🟢`, "info")
    queueTitleRefresh(sessionID)
  }

  const state = (id) => {
    let s = sessions.get(id)
    if (!s) {
      s = {
        status: "unknown", lastActivity: Date.now(),
        lastErrorAt: 0, lastErrorSig: null, lastErrorName: null,
        chain: 0, continueCount: 0, stallResumes: 0, emptyNudges: 0, emptyStreak: false,
        previousKind: null, previousKindChain: 0, previousKindRepeats: 0,
        compactAttempted: false, awaitingCompactionSince: 0,
        pendingResume: false, lastResumeAt: 0, lastInjectAt: 0, lastSuccessAt: 0,
        lastModel: null, currentModel: null, originalModel: null,
        rlStreak: 0, failStreak: 0, rotations: 0,
        favoriteRotatedAt: 0, turnsSinceRotation: 0, rotatedTo: null,
        todos: [], nudges: 0, driveCount: 0, staleDrives: -1,
        proposalSent: false, taskStartAt: 0,
        improveDone: 0, improveTotal: 0, lastImprovedAt: 0, noTodoImproveFired: false,
        proceedCount: 0,
        toolErrs: 0, debugArmed: false, toolRunning: false,
        lastTurnHadText: false,
        retryEnteredAt: 0, retryNext: 0, child: false, reanimated: false,
        rearmTimer: null, compactionTimer: null,
        userStopped: false, takeoverAt: 0,
        lastInjectKind: null,
        lastEvalSig: null,
        lastUserPromptAt: 0,
        askingSince: null,
        userPaused: false,
        taskCost: 0, costNotified: false, budgetNotified: false, gaveUpRearmed: false,
        lowBudgetStreak: 0, lowBudgetSig: null, lowBudgetLastFired: false,
        lowBudgetPending: false,
        lastNudgeCompletedCount: -1,
      }
      sessions.set(id, s)
    }
    return s
  }

  /** Task-scope boundary: resets per-task counters on fresh tasks and follow-ups.
   *  When `followUp` is true, preserve improve counters so improvement passes
   *  don't re-trigger on the same topic within the cooldown window. */
  const resetTaskScope = (s, { keepTimers = true, followUp = false } = {}) => {
    const improveDone = followUp ? s.improveDone : 0
    const improveTotal = followUp ? s.improveTotal : 0
    const lastImprovedAt = followUp ? s.lastImprovedAt : 0
    // Drop any pending rearm/compaction-watchdog timers from the previous
    // task. Without this they fire on the new task, observe chain === 0
    // (the condition is no longer met), and just sit in memory as a
    // useless closure holding the old state until they expire.
    if (s.rearmTimer) { clearTimeout(s.rearmTimer); s.rearmTimer = null }
    if (s.compactionTimer) { clearTimeout(s.compactionTimer); s.compactionTimer = null }
    Object.assign(s, {
      chain: 0, continueCount: 0, compactAttempted: false,
      rlStreak: 0, failStreak: 0, rotations: 0,
      nudges: 0, driveCount: 0, staleDrives: -1,
      proposalSent: false,
      previousKind: null, previousKindChain: 0, previousKindRepeats: 0,
      improveDone, improveTotal, lastImprovedAt,
      improveActive: false, improvedAt: 0, // 🧪 running, ✅ just-finished window
      askingSince: null,
      proceedCount: 0, taskStartAt: Date.now(), toolErrs: 0,
      debugArmed: false, retryEnteredAt: 0, retryNext: 0,
      userStopped: false, takeoverAt: 0, lastTurnHadText: false, taskCost: 0, costNotified: false,
      budgetNotified: false, gaveUpRearmed: false, noTodoImproveFired: false,
      lowBudgetStreak: 0, lowBudgetSig: null, lowBudgetLastFired: false, lowBudgetPending: false, userPaused: false, emptyStreak: false,
      lastErrorName: null, lastErrorSig: null,
      lastNudgeCompletedCount: -1,
      // Clear lastEvalSig so that evaluateIdle will re-process the last
      // assistant message after a real user message (scope reset).
      lastEvalSig: null,
    })
    if (!keepTimers) s.stallResumes = 0
  }

  const detach = (promise, label) =>
    Promise.resolve().then(promise).catch(
      (err) => {
        const msg = `${RESUME_TAG} ${label} failed: ${err?.message ?? err}`
        console.error(msg)
        // Also log through the app.log system for persistence
        log("error", msg, { label })
      })

  const log = (level, message, extra) =>
    detach(() => client.app.log({ body: { service: "auto-resume", level, message, extra } }), "app.log")

  /** User-facing notices go to the OpenCode TUI toast first (native in-app
   *  surface), then to the app log stream, with the OS notifier reserved as
   *  a last-resort backup for hosts where the TUI channel is unavailable.
   *  Rare milestone events (update applied) additionally fire a native OS
   *  notification via announce so they reach the user when OpenCode is
   *  backgrounded. */
  const NOTICE_LEVEL = { info: "info", success: "info", warning: "warn", error: "error" }
  const TOAST_VARIANT = { info: "info", success: "success", warning: "warning", error: "error" }
  let tuiToastCache // undefined = not yet resolved; false = unavailable
  const resolveTuiToast = () => {
    if (tuiToastCache !== undefined) return tuiToastCache
    const tui = client.tui ?? {}
    const notification = client.notification ?? {}
    const window = client.window ?? {}
    const app = client.app ?? {}
    
    const fn =
      typeof tui.showToast === "function" ? (b) => tui.showToast(b) :
      typeof notification.show === "function" ? (b) => notification.show(b) :
      typeof window.showInformationMessage === "function" ? (b) => window.showInformationMessage(b?.body?.message ?? b) :
      typeof app.notify === "function" ? (b) => app.notify(b) :
      typeof tui.notify === "function" ? (b) => tui.notify(b) :
      null

    tuiToastCache = fn ?? false
    log("info", tuiToastCache
      ? "native TUI toast/notification channel bound successfully"
      : "native TUI toast channel unavailable — falling back to app log + OS")
    return tuiToastCache
  }
  const showTuiToast = (message, variant) => {
    const fn = resolveTuiToast()
    if (!fn) return false
    try {
      const res = fn({ body: { title: "auto-resume", message, variant: TOAST_VARIANT[variant] ?? "info" } })
      return res && typeof res.then === "function" ? res.then(() => true).catch(() => false) : true
    } catch {
      try {
        const fnFlat = resolveTuiToast()
        if (typeof fnFlat === "function") {
          fnFlat({ title: "auto-resume", message, type: variant })
          return true
        }
      } catch { /* ignore */ }
      return false
    }
  }

  /** Suppress UI error popups when auto-resume is actively recovering an error. */
  const suppressErrorPopups = async () => {
    try {
      const dismiss = client.tui?.dismissToast ?? client.notification?.dismiss ?? client.tui?.clearToasts
      if (typeof dismiss === "function") {
        await dismiss()
      }
    } catch { /* best effort */ }
  }
  const notice = (message, variant = "warning") => {
    const nowMs = Date.now()
    if (cfg.noticeThrottleMs > 0 && nowMs - lastNoticeAt < cfg.noticeThrottleMs) {
      log("debug", `notice throttled (${Math.round(cfg.noticeThrottleMs / 1000)}s gap): ${message.slice(0, 80)}`)
      return
    }
    lastNoticeAt = nowMs
    // Native TUI toast is the primary surface. We don't block on it (toast
    // promises are detached) so a slow toast never stalls the plugin, but
    // the log line is always written so the message is never lost.
    const tuiShown = showTuiToast(message, variant)
    log(NOTICE_LEVEL[variant] ?? "warn", message, { tui: tuiShown })
  }

  // ── OS notifications + milestones ──────────────────────────────────────
  // Drop-file fallback lives next to the plugin so the desktop client can
  // surface notices to the user even on hosts where the OS channel (WinRT
  // toast / osascript / libnotify) is blocked. The file
  // is one JSON line per event; tail-friendly and cheap to ignore.
  const noticeDropFile = selfPath
    ? selfPath.replace(/[\\/][^\\/]+$/, "/auto-resume-notices.jsonl")
    : null
  // No `$` here: OpenCode 2's plugin context has no shell-runner helper, so
  // createOsNotifier falls back to spawning the notifier directly. It still
  // accepts one for tests and for Bun hosts that supply a shell runner.
  const osNotify = createOsNotifier({ dropFile: noticeDropFile })

  /** Milestone events (update applied, …): pushed through the native TUI
   *  toast first, with the OS notifier as a backup for hosts where the TUI
   *  channel is unavailable. Throttle-exempt because their rarity self-caps
   *  them; lastNoticeAt is reserved up front so ordinary notices stay
   *  spaced even while a slow dispatch is in flight. With requireDelivery,
   *  the durable log line only lands when at least one channel accepted the
   *  job. Log entries carry structured extra fields ({event, tui, os}) for
   *  machine filtering. Resolves true when ANY channel accepted the job. */
  const announce = async (message, {
    title = "auto-resume", requireDelivery = false, event = "milestone",
  } = {}) => {
    const body = message.startsWith(RESUME_TAG) ? message : `${RESUME_TAG}: ${message}`
    lastNoticeAt = Date.now()
    const tuiShown = showTuiToast(message, "info")
    const delivered = await osNotify(title, message.replace(`${RESUME_TAG}: `, ""))
    if (delivered || tuiShown || !requireDelivery)
      log("info", body, { event, tui: tuiShown, os: delivered })
    else
      log("warn", `${body} (all channels unavailable; check ${noticeDropFile ?? "plugin log"})`,
        { event, tui: false, os: false })
    return delivered || tuiShown
  }

  // ── circuit breaker ────────────────────────────────────────────────
  const breakerOpen = () => Date.now() < breakerOpenUntil
  const noteResumeFailure = () => {
    const nowMs = Date.now()
    breakerFailures.push(nowMs)
    while (breakerFailures.length && nowMs - breakerFailures[0] > cfg.breakerWindowMs) breakerFailures.shift()
    if (breakerFailures.length >= cfg.breakerThreshold) {
      breakerOpenUntil = nowMs + cfg.breakerCooldownMs
      breakerFailures.length = 0
      log("warn", "circuit breaker opened", { cooldownMs: cfg.breakerCooldownMs })
      notice(`${RESUME_TAG} Repeated failures — pausing auto-recovery for ${Math.round(cfg.breakerCooldownMs / 60_000)} min.`, "error")
    }
  }
  const noteSuccess = () => { breakerFailures.length = 0; breakerOpenUntil = 0; breakerNoted = false }

  /** Record provider health metrics for rotation bias. */
  const recordHealth = (modelKey, success) => {
    const rawKey = typeof modelKey === "string" ? modelKey.trim() : String(modelKey ?? "").trim()
    if (!rawKey) return
    const key = rawKey.toLowerCase()
    const entry = providerHealthStore.map.get(key) ?? { success: 0, failures: 0, lastUpdated: 0 }
    if (success) entry.success += 1
    else entry.failures += 1
    entry.lastUpdated = Date.now()
    providerHealthStore.map.set(key, entry)
    providerHealthStore.save()
  }

  /** Emit rotation telemetry for observability (batched to reduce I/O). */
  const telemetryQueue = []
  const TELEMETRY_FLUSH_INTERVAL_MS = 5000
  const TELEMETRY_MAX_BATCH = 50
  let telemetryFlushTimer = null
  const flushTelemetry = () => {
    if (telemetryQueue.length === 0) return
    try {
      const { appendFile } = require("node:fs/promises")
      const path = selfPath
        ? selfPath.replace(/[\\/][^\\/]+$/, "/auto-resume-metrics.jsonl")
        : null
      if (!path) return
      let guard = 0
      while (telemetryQueue.length > 0 && guard++ < 1000) {
        const batch = telemetryQueue.splice(0, TELEMETRY_MAX_BATCH)
        const payload = batch.map((e) => JSON.stringify(e)).join("\n") + "\n"
        appendFile(path, payload, "utf8").catch(() => {})
      }
    } catch { /* best effort */ }
  }
  const emitRotationTelemetry = (sessionID, fromModel, toModel, reason) => {
    telemetryQueue.push({
      ts: Date.now(),
      sessionID,
      from: fromModel,
      to: toModel,
      reason,
    })
    if (telemetryQueue.length >= TELEMETRY_MAX_BATCH) flushTelemetry()
    if (!telemetryFlushTimer) {
      telemetryFlushTimer = setTimeout(() => {
        telemetryFlushTimer = null
        flushTelemetry()
      }, TELEMETRY_FLUSH_INTERVAL_MS)
      telemetryFlushTimer.unref?.()
    }
  }

  // ── classification ─────────────────────────────────────────────────
  const classify = (error) => {
    const name = error?.name
    const data = error?.data ?? {}
    const text = `${data.message ?? ""} ${data.responseBody ?? ""}`
    if (name === "AbortError" || name === "TimeoutError") return "retryable"
    if (name === "MessageAbortedError") {
      const msg = String(data.message ?? "").toLowerCase()
      // If it's an SDK/transport drop, timeout, or network disconnect without explicit
      // user initiation, treat it as a retryable infrastructure error rather than a user stop.
      if (data.userInitiated !== true && (
          msg.includes("network") || msg.includes("timeout") || msg.includes("stream") ||
          msg.includes("disconnect") || msg.includes("connection") || msg.includes("socket") ||
          msg.includes("terminated") || msg.includes("hung")
      )) {
        return "retryable"
      }
      return "abort"
    }
    if (name === "ProviderAuthError") return "auth"
    if (name === "MessageOutputLengthError") return "output_length"
    // If the error message specifies a temporary retry duration (e.g., Gemini's
    // "Please retry in 40.911s"), treat it as a temporary rate limit / retryable
    // rather than permanent quota exhaustion so we stick with the model and retry.
    if (isTemporaryRateLimit(error)) return "rate_limit"
    if (matchesAny(text, QUOTA_PATTERNS)) return "quota"
    if (matchesAny(text, RATE_LIMIT_PATTERNS)) return "rate_limit"
    if (name === "APIError") {
      const code = data.statusCode
      if (code === 429) return "rate_limit"
      if (code === 402) return "quota"   // HTTP 402 Payment Required → quota/credits
      if (code === 408 || code === 409) return "retryable"
      // HTTP 403 is overloaded across providers: rejected credentials, quota or
      // billing exhaustion, model-access denial and org restrictions all surface
      // as 403, and the client usually reports only the bare status. Treating it
      // as fatal meant a quota wall killed the session with no recovery and no
      // notice. Retry the same model instead — the circuit breaker bounds how
      // long that can go on, and opens with a user-facing notice if it persists.
      // HTTP 401 stays fatal: that one really is bad credentials.
      if (code === 403) return "retryable"
      if (typeof code === "number" && code >= 500) return "retryable"
      if (data.isRetryable === true) return "retryable"
      if (matchesAny(text, OVERFLOW_PATTERNS)) return "overflow"
      if (matchesAny(text, NETWORK_PATTERNS)) return "retryable"
      return "fatal"
    }
    if (name === "UnknownError") {
      if (matchesAny(data.message, OVERFLOW_PATTERNS)) return "overflow"
      if (matchesAny(text, NETWORK_PATTERNS)) return "retryable"
      return "fatal"
    }
    return "fatal"
  }

  /** Redact credential-shaped substrings from provider error text.
   *
   *  Error text reaches surfaces that escape the session entirely: the
   *  plaintext notice drop-file, and OS toast notifications. On Windows those
   *  render on the lock screen and are mirrored to the cloud, so a key echoed
   *  by a provider would be readable by anyone at the machine and persisted
   *  off-box. describeErrForPrompt also strips URLs, which covers the common
   *  `?key=…` shape, but inline secrets survive that: "invalid key sk-…",
   *  "Authorization: Bearer …".
   *
   *  Patterns are anchored to credential *syntax* rather than length alone, so
   *  the surrounding prose the model and user need — "invalid API key",
   *  "unauthorized" — is preserved intact. */
  const redactSecrets = (text) => String(text ?? "")
    // Prefixed vendor keys: sk-…, sk-ant-…, rk-…, pk-…, gsk_…
    .replace(/\b(?:sk|rk|pk|gsk|xai)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted-key]")
    // "Authorization: Bearer eyJ…" / "authorization=bearer …"
    .replace(/\b(authorization\s*[:=]\s*bearer\s+)\S+/gi, "$1[redacted-token]")
    // Labelled secrets: api_key=…, token: …, "password": "…"
    .replace(/\b(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|secret|password|passwd)(\s*[:=]\s*)["']?\S+/gi, "$1$2[redacted]")

  /** Short human-readable cause for injected prompts/log lines: e.g.
   *  "APIError HTTP 502 — bad gateway" or "UnknownError — upstream request failed". */
  const describeErr = (error) => {
    if (!error) return ""
    const name = error.name ?? "Error"
    const code = error.data?.statusCode
    const msg = redactSecrets(String(error.data?.message ?? error.message ?? "").replace(/\s+/g, " ").trim()).slice(0, 120)
    const parts = [name, typeof code === "number" ? `HTTP ${code}` : "", msg].filter(Boolean)
    return parts.join(" — ")
  }

  /** Compact, model-facing cause for injected prompts. Strips URLs, the
   *  "To increase, visit …" tail, JSON blobs, and trailing marketing/help text
   *  so the injected message stays well under any per-prompt token budget.
   *  Also derives a one-line "requested N, can afford M" summary for the
   *  OpenRouter-style messages. */
  const describeErrForPrompt = (error) => {
    if (!error) return ""
    const name = error.name ?? "Error"
    const code = error.data?.statusCode
    let raw = String(error.data?.message ?? error.message ?? "").replace(/\s+/g, " ").trim()
    // Some providers (OpenRouter, others) dump the error as a JSON blob in
    // the message field. Pull out the inner `message` if present, otherwise
    // drop the JSON envelope entirely so the model sees just the prose.
    if (raw.startsWith("{") && raw.endsWith("}")) {
      try {
        const obj = JSON.parse(raw)
        if (typeof obj?.message === "string" && obj.message.trim()) {
          raw = obj.message
        } else if (typeof obj?.error?.message === "string" && obj.error.message.trim()) {
          raw = obj.error.message
        } else {
          raw = ""
        }
      } catch { /* not JSON; leave raw as-is */ }
    }
    // responseBody sometimes carries the real message (e.g. when
    // data.message is the JSON blob above). Prefer whichever is shorter
    // after cleaning, so we keep the more compact human prose.
    if (error.data?.responseBody) {
      const body = String(error.data.responseBody).replace(/\s+/g, " ").trim()
      if (body && body.length < raw.length) raw = body
    }
    // Drop URLs (settings/credits/upgrade etc. — the model can't act on them).
    let msg = raw.replace(/https?:\/\/\S+/g, "").replace(/\s{2,}/g, " ").trim()
    // Drop "to increase, visit …", "upgrade to …", "subscribe to go …" tails —
    // they're marketing copy, not actionable. Match with or without a preceding
    // period. Also strip any orphaned "Visit" or "see" that survives URL removal.
    msg = msg.replace(/\.\s*(to (increase|fix|resolve).*)$/i, "")
             .replace(/\s+(to (increase|fix|resolve).*)$/i, "")
             .replace(/\s+(visit\s+\S+.*)$/i, "")
             .replace(/\s+(upgrade\s+to\s+\S+.*)$/i, "")
             .replace(/\s+(subscribe\s+to\s+\S+.*)$/i, "")
             .replace(/\.\s*(upgrade\s+to.*)$/i, "")
             .replace(/[,\s]+(visit|upgrade|subscribe)\s*$/i, "")
             .replace(/\s+visit\s*$/i, "")
             .replace(/\s+see\s+\S+.*$/i, "")
             .replace(/[.,]\s*$/, "")   // drop trailing bare comma or period
             .trim()
    // Derive a compact "requested N tokens, can afford M" summary when the
    // raw message follows the OpenRouter "requested up to X tokens, but can
    // only afford Y" shape. This is what the model needs to know to write
    // a shorter reply.
    const m = msg.match(/requested\s+(?:up\s+to\s+)?(\d+)\s*tokens?[,\s]+(?:but\s+)?(?:can\s+(?:only\s+)?afford|only)\s+(\d+)/i)
    if (m) msg = `requested ${m[1]} tokens, can afford ${m[2]}`
    // Strip credentials before the cap: redaction must not be defeated by the
    // truncation below, and the cap would otherwise preserve a partial key.
    msg = redactSecrets(msg).trim()
    // Hard cap: keep the injected cause small even after stripping.
    if (msg.length > 90) msg = msg.slice(0, 87) + "…"
    const parts = [name, typeof code === "number" ? `HTTP ${code}` : "", msg].filter(Boolean)
    return parts.join(" — ")
  }

  /** The Stop button (user abort) surfaces as MessageAbortedError. */
  const isAbortError = (error) =>
    Boolean(error) && (
      error.name === "MessageAbortedError" ||
      /abort/i.test(String(error?.data?.message ?? ""))
    )

  const retryAfterMs = (error) => {
    const headers = error?.data?.responseHeaders
    if (headers) {
      const raw = headers["retry-after"] ??
        Object.entries(headers).find(([k]) => k.toLowerCase() === "retry-after")?.[1]
      if (raw !== undefined && raw !== null) {
        const secs = Number(raw)
        if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1_000, 600_000)
        const date = Date.parse(raw)
        if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 600_000)
      }
    }
    // No usable Retry-After header. Many providers state the wait in the body
    // instead ("Please retry in 28.462826513s"); honour it rather than falling
    // back to exponential backoff, which retries either too early or far later
    // than the provider asked.
    return retryAfterMsFromBody(error)
  }

  const backoff = (attempt, base) =>
    Math.min(jitter(base * Math.pow(2, Math.max(attempt - 1, 0))), cfg.maxDelayMs)

  /** Delay before the next recovery attempt.
   *
   *  Transient failures retry fast and consecutively; rate limits wait for the
   *  window the provider stated. See the fastRetry defaults for why the two
   *  shapes differ. */
  const usesFastRetry = () => cfg.fastRetry && !cfg.rotationEnabled

  /** Delay before the next recovery attempt.
   *
   *  Transient failures retry fast and consecutively; rate limits wait for the
   *  window the provider stated. See the fastRetry defaults for why the two
   *  shapes differ. */
  const retryDelay = (kind, chain, error) => {
    if (kind === "rate_limit") return retryAfterMs(error) ?? backoff(chain, cfg.rateLimitBaseMs)
    // Only the no-rotation default gets the fast burst. With rotation on, a
    // slow ramp is deliberate: the next attempt lands on a DIFFERENT model, and
    // spacing them out avoids burning the new model's budget as fast as the
    // old one ran dry.
    if (usesFastRetry()) {
      const ms = cfg.fastRetryBaseMs * Math.pow(cfg.fastRetryGrowth, Math.max(chain - 1, 0))
      return Math.min(jitter(ms), cfg.fastRetryMaxMs)
    }
    return backoff(chain, cfg.baseDelayMs)
  }

  /** How many recovery attempts this session gets before giving up.
   *
   *  maxChain is a COUNT, and shortening every wait shrinks the wall-clock
   *  window that count covers. At an 8s ceiling, 8 attempts spanned ~40s —
   *  against ~8.5 minutes for the old escalating schedule at the same count.
   *  That traded "persistent" for "snappy": a two-minute outage the old timing
   *  rode out got abandoned in under a minute.
   *
   *  So the budget scales with the schedule: count how many fast attempts cover
   *  the window the escalating one covered, bounded. Solved numerically rather
   *  than algebraically because both schedules have ceilings, which the closed
   *  form ignores — and it is only ever ~8 iterations.
   *
   *  Bounded at fastRetryMaxChain because every attempt is a real provider
   *  request: an uncapped budget would spend free-tier quota to buy patience,
   *  which is backwards on exactly the free models this targets. */
  const retryBudget = () => {
    if (!usesFastRetry()) return cfg.maxChain
    const g = Math.max(1.01, cfg.fastRetryGrowth)
    const b = Math.max(1, cfg.fastRetryBaseMs)
    let target = 0
    for (let i = 0; i < cfg.maxChain; i++) target += Math.min(cfg.baseDelayMs * Math.pow(2, i), cfg.maxDelayMs)
    let n = cfg.maxChain
    let window = 0
    while (n < cfg.fastRetryMaxChain && window < target) {
      window += Math.min(b * Math.pow(g, n - 1), cfg.fastRetryMaxMs)
      n += 1
    }
    return Math.max(cfg.maxChain, Math.min(n, cfg.fastRetryMaxChain))
  }

  // ── model catalog + rotation ───────────────────────────────────────
  const modelKey = (m) => `${m.providerID}/${m.modelID}`
  const cooling = (key) => (modelCooldown.get(key) ?? 0) > Date.now()
  const isRouter = (m) => {
    if (!m) return false
    const id = String(m.providerID ?? "").toLowerCase()
    const mid = String(m.modelID ?? "").toLowerCase()
    return ROUTER_RE.test(id) || ROUTER_RE.test(mid)
  }

  /** Pick the right prompt + model-note for an auto-resume injection.
   *  - sessionID: needed to read the (now-current) model state
   *  - kind: classify() result
   *  - error: raw error object
   *  - rotated: true if we already swapped to a new model for this resume
   *  - rotatedFrom: modelKey of the old model (null if no rotation)
   *  Returns (auto) => string. */
  /** Split the generic "retryable" bucket into the two causes that need
   *  *opposite* advice from the model. A transport fault (ECONNRESET, DNS,
   *  TLS, socket hang) means "resume at the exact token"; a provider 5xx/529
   *  means "the same request will fail identically, so wait and retry
   *  unchanged". Collapsing them — as they were — produces a prompt that is
   *  half right in both directions.
   *
   *  HTTP status wins when present, because it is the provider's own verdict
   *  rather than our reading of an error string. */
  const splitRetryable = (error) => {
    const code = Number(error?.data?.statusCode ?? error?.status)
    if (typeof code === "number" && Number.isFinite(code)) {
      if (code === 429) return "rate_limit"
      if (code === 402) return "quota"
      if (code === 408) return "timeout"
      if (code >= 500) return "provider"
      if (code === 401) return "auth"
      // 403 is classified retryable (see classify); on the prompt side it is a
      // provider-side refusal, so the model should wait and retry unchanged
      // rather than assume its credentials or its output were at fault.
      if (code === 403) return "provider"
      if (code >= 400) return "fatal"
    }
    const text = `${error?.data?.message ?? ""} ${error?.data?.responseBody ?? ""} ${error?.message ?? ""}`
    if (matchesAny(text, RATE_LIMIT_PATTERNS)) return "rate_limit"
    if (matchesAny(text, QUOTA_PATTERNS)) return "quota"
    if (matchesAny(text, OVERFLOW_PATTERNS)) return "overflow"
    // 5xx / gateway / overload phrasings that arrive without a status code.
    if (/\b(50[0-9]|52[0-9]|529)\b/.test(text) ||
        matchesAny(text, ["bad gateway", "service unavailable", "internal server error",
                          "overloaded", "gateway", "upstream"])) {
      return "provider"
    }
    if (matchesAny(text, NETWORK_PATTERNS)) return "network"
    return "network"
  }

  /** Build the provider-facing hint block the V2 adapter attaches (rate-limit
   *  window, provider name, the provider's own reason). The OpenCode 2 event
   *  stream carries this detail; a context without it simply gets an empty
   *  hint. */
  const v2Hint = (error) => {
    const d = error?.data ?? {}
    const retryNext = d.retryNext
    const wait = retryNext && retryNext > Date.now() ? fmtWait(retryNext - Date.now()) : ""
    return {
      provider: d.retryProvider,
      reason: d.retryReason,
      attempt: d.retryAttempt,
      retryWait: wait,
    }
  }

  const buildResumePrompt = (sessionID, kind, error, rotated, rotatedFrom) => {
    // prompt-facing cause: compact, URL/help-text stripped, OpenRouter
    // "requested N tokens, can afford M" rewritten as a one-liner.
    const detail = describeErrForPrompt(error)
    const cur = state(sessionID)
    const nowKey = cur.currentModel ? modelKey(cur.currentModel) : null
    const modelNote = rotated && rotatedFrom && nowKey && rotatedFrom !== nowKey
      ? `You are now on a different model (${nowKey}).`
      : ""
    const hint = v2Hint(error)
    // Pick the prompt that matches the actual failure shape. Every branch here
    // carries advice the generic one cannot give.
    if (kind === "quota" && isCreditsConstraint(error)) {
      return (a) => PROMPTS.lowBudget(a, detail, modelNote)
    }
    if (kind === "rate_limit") return (a) => PROMPTS.rateLimited(a, detail, hint)
    if (kind === "quota") return (a) => PROMPTS.quotaExhausted(a, detail, hint)
    if (kind === "retryable") {
      const sub = splitRetryable(error)
      if (sub === "provider") return (a) => PROMPTS.providerDown(a, detail, hint)
      if (sub === "timeout") return (a) => PROMPTS.providerDown(a, detail, hint)
      if (sub === "network") return (a) => PROMPTS.networkDrop(a, detail, hint)
      if (sub === "rate_limit") return (a) => PROMPTS.rateLimited(a, detail, hint)
      if (sub === "quota") return (a) => PROMPTS.quotaExhausted(a, detail, hint)
    }
    return (a) => PROMPTS.resume(a, detail, modelNote)
  }

  // Catalog cache TTL (5 minutes)
  const CATALOG_CACHE_TTL_MS = 300_000

  const getCatalog = async () => {
    if (catalogCache && Date.now() - catalogFetchedAt < CATALOG_CACHE_TTL_MS) return catalogCache
    try {
      const providersFn = client.config?.providers
      if (typeof providersFn !== "function") return catalogCache ?? []
      const res = await providersFn()
      const data = res?.data ?? res
      catalogCache = Array.isArray(data?.providers) ? data.providers : []
      catalogFetchedAt = Date.now()
    } catch (err) {
      log("warn", "could not fetch provider catalog", { err: err?.message ?? String(err) })
      // Do NOT stamp catalogFetchedAt on failure — we want to retry on the next
      // call instead of waiting 5 minutes. Keep the prior cache (if any) as a
      // stale fallback so rotation can still work with old data.
      catalogCache = catalogCache ?? []
    }
    return catalogCache
  }

  const isModelActivated = (modelObj) => {
    if (!modelObj || Object.prototype.toString.call(modelObj) !== "[object Object]") return true
    // If any activation flag is explicitly false, the model is not activated.
    // Absence of flags means activated (backward compatible).
    for (const flag of ["enabled", "active", "selected", "allowed"]) {
      if (flag in modelObj && !modelObj[flag]) return false
    }
    return true
  }

  const listChatModels = (providers) => {
    const out = []
    for (const prov of providers) {
      for (const modelID of Object.keys(prov?.models ?? {})) {
        if (NON_CHAT_PATTERN.test(modelID)) continue
        const modelObj = prov.models[modelID]
        if (!isModelActivated(modelObj)) continue
        out.push({ providerID: prov.id, modelID })
      }
    }
    return out
  }

  const pickAlternateModel = async (sessionID, exhausted) => {
    if (!cfg.rotationEnabled) return null
    const nowMs = Date.now()
    // Periodic cleanup of failure velocities to prevent unbounded growth
    cleanModelFailureVelocities(nowMs)
    const providers = await getCatalog()
    const all = listChatModels(providers)
    if (!all.length) return null

    // Build denylist: built-in deprecated models + user-configured denylist
    const denylist = new Set(DEPRECATED_MODELS)
    if (cfg.denylistModels) {
      for (const m of cfg.denylistModels.split(",")) {
        const trimmed = m.trim().toLowerCase()
        if (trimmed) denylist.add(trimmed)
      }
    }

    const exhaustedKey = exhausted ? modelKey(exhausted) : null
    const eligible = all.filter((m) => {
      const k = modelKey(m)
      const kLower = k.toLowerCase()
      if (exhaustedKey && k === exhaustedKey) return false
      if (cooling(k)) return false
      // Filter out deprecated/denylisted models
      if (denylist.has(kLower) || denylist.has(m.modelID.toLowerCase())) return false
      return true
    })
    if (!eligible.length) return null

    // Load provider health data for biasing rotation away from flaky models
    const healthData = providerHealthStore.map // key: "provider/model" -> {success, failures, lastUpdated}
    const getHealthScore = (m) => {
      const key = modelKey(m).toLowerCase()
      const h = healthData.get(key)
      if (!h || typeof h !== "object") return 0
      const total = (h.success ?? 0) + (h.failures ?? 0)
      if (total < 3) return 0 // not enough data
      const failureRate = (h.failures ?? 0) / total
      // Negative score = penalize high failure rate
      return Math.round(-failureRate * 100)
    }

    // Intelligent rotation: track selection history to avoid picking the same
    // model repeatedly. We prefer models that haven't been used recently.
    // Clean up stale session histories (TTL-based) to prevent memory leaks.
    for (const [sid, h] of modelSelectionHistory) {
      const latest = h[h.length - 1]?.timestamp ?? 0
      if (nowMs - latest > SELECTION_HISTORY_TTL_MS) modelSelectionHistory.delete(sid)
    }
    const history = modelSelectionHistory.get(sessionID) ?? []
    const recentKeys = new Set(history.slice(-MAX_SELECTION_HISTORY).map((h) => h.modelKey))

    // Budget-aware model selection.  When the user is hitting token/credit
    // caps we want a model that won't hit the same wall — prioritise entries
    // in the user's explicit preferred chain, then models that carry
    // "unlimited" in their id (these usually have no per-request cap), then
    // "free" variants (no per-credit cost), then same-provider for minimal
    // capability surprise, then other-provider, then by tier score as a
    // final tie-breaker.  The previous sort ordered exclusively by tier,
    // which kept pushing the user back onto the same expensive model. */
    const chainSet = new Set(
      cfg.fallbackModels.split(",").map((x) => x.trim()).filter(Boolean),
    )
    const freeRank = (m) => {
      // Lower = preferred.  0 = chain (explicit user intent), 1 = unlimited,
      // 2 = free, 3 = same-provider, 4 = other-provider.
      if (chainSet.has(modelKey(m))) return 0
      const id = String(m.modelID ?? "").toLowerCase()
      if (UNLIMITED_RE.test(id)) return 1
      if (FREE_RE.test(id)) return 2
      if (exhausted && m.providerID === exhausted.providerID) return 3
      return 4
    }
    const ordered = [...eligible].sort((a, b) => {
      const ra = freeRank(a)
      const rb = freeRank(b)
      if (ra !== rb) return ra - rb
      const ta = tierScore(a.modelID)
      const tb = tierScore(b.modelID)
      if (ta !== tb) return tb - ta
      // Tie-breaker: prefer models not recently used (intelligent rotation)
      const ka = modelKey(a)
      const kb = modelKey(b)
      const aRecent = recentKeys.has(ka)
      const bRecent = recentKeys.has(kb)
      if (aRecent !== bRecent) return aRecent ? 1 : -1
      return a.modelID.localeCompare(b.modelID)
    })

    const selected = ordered[0] ?? null
    if (selected) {
      // Record selection in history for this session
      const newHistory = [...history, { modelKey: modelKey(selected), timestamp: nowMs }]
      if (newHistory.length > MAX_SELECTION_HISTORY * 2) {
        newHistory.splice(0, newHistory.length - MAX_SELECTION_HISTORY * 2)
      }
      modelSelectionHistory.set(sessionID, newHistory)
    }
    return selected
  }

  /**
   * Rotate the session to the best available alternate model.
   * @param {boolean} penalize put the old model on cooldown — yes for quota/
   *   auth/rate-limits; no for generic outages, which are usually temporary.
   */
  const rotateAwayFrom = async (sessionID, reason, penalize = true) => {
    if (!cfg.rotationEnabled) return false
    const s = state(sessionID)
    if (s.rotations >= cfg.maxRotations) {
      log("warn", "rotation cap reached", { sessionID, rotations: s.rotations })
      return false
    }
    const exhausted = s.currentModel ?? s.lastModel
    if (exhausted && penalize) {
      modelCooldown.set(modelKey(exhausted), Date.now() + cfg.modelCooldownMs)
      log("info", "model put on cooldown", { sessionID, model: modelKey(exhausted), reason })
    }
    const alt = await pickAlternateModel(exhausted)
    if (!alt) {
      log("warn", "no alternate model available", { sessionID })
      return false
    }
    // A user Stop can land while the catalog lookup is in flight. Rotating
    // anyway would reset the retry counters and pop a "continuing on <model>"
    // notice for a session the user just silenced, so bail out quietly.
    if (suppressed(sessionID)) {
      log("info", "rotation abandoned — session was stopped by the user", { sessionID, reason })
      return false
    }
    s.currentModel = { providerID: alt.providerID, modelID: alt.modelID }
    // Fresh lease on the new model — its reliability is unknown so far.
    // Clear failure velocities for both old and new models.
    if (exhausted) modelFailureVelocities.delete(modelKey(exhausted))
    modelFailureVelocities.delete(modelKey(alt))
    s.chain = 0
    s.failStreak = 0
    s.rlStreak = 0
    s.rotations += 1
    // Arm the favorite-return tracker. `rotatedTo` records *which* model we
    // chose so tryRestoreFavorite can tell "still on our alternate" apart
    // from "the session has since moved on" and back off instead.
    s.favoriteRotatedAt = Date.now()
    s.turnsSinceRotation = 0
    s.rotatedTo = { providerID: alt.providerID, modelID: alt.modelID }
    log("info", "rotated model", {
      sessionID, from: exhausted ? modelKey(exhausted) : null, to: modelKey(alt), reason,
    })
    notice(`${RESUME_TAG}: ${reason} on ${exhausted ? modelKey(exhausted) : "model"} — continuing on ${modelKey(alt)}.`)
    queueTitleRefresh(sessionID)
    if (exhausted) emitRotationTelemetry(sessionID, modelKey(exhausted), modelKey(alt), reason)
    return true
  }

  /** Hand an idle session back to the model the user originally picked, once
   *  the alternate we rotated to has proven stable and the favorite's own
   *  cool-down has expired.
   *
   *  Deliberately does NOT call the SDK. The model is carried per-prompt
   *  (`currentModel` is merged into the body of the next injection), so
   *  clearing the rotation is all that is needed for the *next* injected
   *  prompt to use the favorite. The orphaned `master` branch shipped a
   *  `client.session.chat(...)` call here instead, but that method does not
   *  exist in the OpenCode SDK — the session surface is `session.prompt` —
   *  so the call would have thrown on every idle tick. It was also
   *  unnecessary: `rotateAwayFrom` has always worked this way.
   *
   *  Synchronous, so there is no re-entrancy window to guard.
   *  @returns true if a restore was committed. */
  const tryRestoreFavorite = (sessionID) => {
    if (!cfg.favoriteReturn) return false
    const s = state(sessionID)
    const fav = s.originalModel
    if (!fav || !s.favoriteRotatedAt) return false

    const current = s.currentModel ?? s.lastModel
    // Our rotation is no longer the one in effect (the rotation lease was
    // cleared by a completed task and the session has since moved on). Drop
    // the tracker rather than yanking the model back.
    if (s.rotatedTo && (!current
        || current.providerID !== s.rotatedTo.providerID
        || current.modelID !== s.rotatedTo.modelID)) {
      log("info", "favorite-return skipped — session moved off our alternate", { sessionID })
      s.favoriteRotatedAt = 0
      s.turnsSinceRotation = 0
      s.rotatedTo = null
      return false
    }
    // Already home.
    if (current
        && current.providerID === fav.providerID
        && current.modelID === fav.modelID) {
      s.favoriteRotatedAt = 0
      s.turnsSinceRotation = 0
      s.rotatedTo = null
      return false
    }
    // Still inside the cool-down window, or the alternate hasn't proven
    // itself yet.
    if (Date.now() - s.favoriteRotatedAt < cfg.favoriteCheckAfterMs) return false
    if (s.turnsSinceRotation < cfg.favoriteMinTurns) return false
    // The favorite is probably still rate-limited — that is why we left.
    if (cooling(modelKey(fav))) return false
    // Never swap while a recovery is already queued: the model is read when
    // the injection body is built, so a pending resume would go out on the
    // alternate and leave the session straddling two models. Busy/retry is
    // already excluded by the call site, which only offers idle sessions.
    if (s.pendingResume) return false

    log("info", "restoring favorite model", {
      sessionID,
      from: current ? modelKey(current) : null,
      to: modelKey(fav),
      turnsOnAlternate: s.turnsSinceRotation,
    })
    s.currentModel = { providerID: fav.providerID, modelID: fav.modelID }
    s.rotatedTo = null
    s.favoriteRotatedAt = 0
    s.turnsSinceRotation = 0
    // Clear failure velocity for the restored model so it gets a fresh start
    modelFailureVelocities.delete(modelKey(fav))
    // A fresh lease, exactly like rotateAwayFrom hands the alternate: we have
    // no evidence yet that the favorite is healthy again.
    s.chain = 0
    s.failStreak = 0
    s.rlStreak = 0
    notice(`${RESUME_TAG}: ${modelKey(fav)} is available again — returning to it.`)
    queueTitleRefresh(sessionID)
    return true
  }

  // ── scheduling / injection ─────────────────────────────────────────
  /** User hit Stop: go fully quiet — cancel everything queued, inject nothing,
   *  auto-answer no permissions — until a REAL user prompt starts a new task. */
  const markUserStopped = (sessionID, why) => {
    const s = state(sessionID)
    if (s.userStopped) return
    s.userStopped = true
    persistedStops.set(sessionID, Date.now())
    stopStore.save()
    const t = timers.get(sessionID)
    if (t) { clearTimeout(t); timers.delete(sessionID) }
    log("info", "user stop detected — automation paused until next prompt", { sessionID, why })
    notice(`${RESUME_TAG}: Stopped by you — staying quiet until your next prompt.`, "info")
    queueTitleRefresh(sessionID)
  }

  /** User reverted a message: they want the time to edit and reprompt
   *  manually, so go fully quiet — cancel everything queued, inject nothing,
   *  auto-answer no permissions — until a REAL user prompt starts a new task.
   *  Same mechanics as a Stop (including the persisted marker, so a restart
   *  before reprompting never auto-revives the reverted session); only the
   *  wording differs. The next real user prompt lifts it via the
   *  message.updated handler, exactly like a Stop. */
  const markReverted = (sessionID, why) => {
    const s = state(sessionID)
    // Bump the user-activity clock even when already stopped: any plan that
    // was scheduled before this revert is stale and runPlan must drop it.
    s.lastUserPromptAt = Date.now()
    if (s.userStopped) {
      cancelPending(sessionID, "revert")
      return
    }
    s.userStopped = true
    persistedStops.set(sessionID, Date.now())
    stopStore.save()
    const t = timers.get(sessionID)
    if (t) { clearTimeout(t); timers.delete(sessionID) }
    s.pendingResume = false
    s.lowBudgetPending = false
    log("info", "user revert detected — automation paused until next prompt", { sessionID, why })
    notice(`${RESUME_TAG}: Reverted by you — staying quiet while you edit and reprompt manually.`, "info")
    queueTitleRefresh(sessionID)
  }

  /** Aborts issued by our own takeover (stall/retry restarts) must never read
   *  as user stops — the takeover schedules its own resume right after. */
  const isOwnTakeoverAbort = (s) =>
    s.takeoverAt > 0 && Date.now() - s.takeoverAt < 10_000

  const schedule = (sessionID, delayMs, plan) => {
    if (suppressed(sessionID)) {
      state(sessionID).pendingResume = false
      log("info", `not scheduling "${plan.kind}" — session was stopped by the user`, { sessionID })
      return
    }
    // Stamp creation time once: recovery plans dispatched after a later clean
    // turn are stale and get dropped (see runPlan).
    if (!plan.createdTs) plan.createdTs = Date.now()
    // Anti-redundant-repeats: a back-to-back plan of the SAME kind with no
    // observed progress (chain counter unchanged) is almost always the agent
    // asking the same question / stalling the same way twice. Escalate to
    // an explicit "change approach" prompt instead of firing the same kind
    // verbatim — this prevents the loop where auto-resume keeps injecting
    // the same proceed/retry/empty message while the model re-emits the
    // same deferring question.
    const s = state(sessionID)
    // The ORIGINAL kind, captured before any escalation below. The escalation
    // rewrites plan.kind to "debug", so recording the rewritten value would
    // make the next same-kind plan look like a *different* kind, reset the
    // counter to 0 via the else-branch, and silently undo the escalation one
    // turn later -- a stuck model would then flip-flop forever between the
    // "continue anyway" nudge and the "root-cause it" prompt instead of
    // converging on the latter.
    const originalKind = plan.kind
    if (SAME_KIND_WATCHED.has(originalKind) && s.previousKind === originalKind && s.chain === s.previousKindChain) {
      const repeatCount = (s.previousKindRepeats ?? 0) + 1
      s.previousKindRepeats = repeatCount
      if (repeatCount >= 2) {
        log("warn", `same-kind repeat #${repeatCount} for "${originalKind}" — escalating`, { sessionID })
        plan = { ...plan, kind: "debug", prompt: PROMPTS.debug }
      } else {
        log("info", `same-kind repeat for "${originalKind}" — allowing once before escalation`, { sessionID })
      }
    } else {
      s.previousKindRepeats = 0
    }
    // Record the ORIGINAL kind (before escalation) so repeat detection
    // correctly identifies subsequent identical asks and keeps escalating.
    s.previousKind = originalKind
    s.previousKindChain = s.chain
    // Duplicate-prevention lives in exactly two places, and both are needed:
    //   • scheduledKinds (below) — blocks a SECOND live timer for the same
    //     session+kind. A poll re-arm is the same timer continuing, not a
    //     duplicate, so it is exempt (see BUSY_POLL re-schedule in runPlan).
    //   • lastInjected (in runPlan) — blocks a second injection of the same kind
    //     inside the dispatch window.
    // Nothing else may gate scheduling: an earlier wall-clock guard here looked
    // harmless but silently killed poll re-arms and dropped recovery entirely.
    // Final duplicate-prevention layer: suppress any new schedule within 3s of a
    // previous injection — catches engine-level / cross-instance duplicates.
    const last = lastInjected.get(sessionID)
    if (last && (Date.now() - last.at < 3000)) {
      log("info", `suppressing rapid duplicate schedule (${plan.kind}) for ${sessionID}: last ${last.kind} at ${last.at}`)
      return
    }
    const kindKey = `${sessionID}|${plan.kind}`
    if (!cfg.budgetPrompts && (plan.kind === "lowBudget" || plan.kind === "quota")) {
      log("info", `budget prompts disabled; skipping "${plan.kind}" for ${sessionID}`)
      return
    }
    if (scheduledKinds.has(kindKey)) {
      log("info", `skipping duplicate schedule "${plan.kind}" for ${sessionID}`)
      return
    }
    const existing = timers.get(sessionID)
    if (existing) clearTimeout(existing)
    scheduledKinds.add(kindKey)
    const t = setTimeout(() => {
      timers.delete(sessionID)
      scheduledKinds.delete(kindKey)
      detach(runPlan(sessionID, plan), "runPlan")
    }, delayMs)
    t.unref?.()
    timers.set(sessionID, t)
    log("info", `scheduled "${plan.kind}" in ${delayMs}ms`, { sessionID })
  }

  const lastInjected = new Map() // sessionID -> { kind, at }

  /** Cancel any pending auto-injection on a session and clear its pendingResume
   *  flag.  Called the moment we observe the user sending their own message —
   *  a stale plan would otherwise fire AFTER the new user prompt and pollute
   *  the conversation with a spurious "Continue" / "Auto-resume".  The plan's
   *  createdTs is also recorded in session state so a race where the timer
   *  fires before cancelPending can still be caught by runPlan. */
  const cancelPending = (sessionID, why) => {
    const t = timers.get(sessionID)
    if (t) { clearTimeout(t); timers.delete(sessionID) }
    for (const k of scheduledKinds) if (k.startsWith(`${sessionID}|`)) scheduledKinds.delete(k)
    const s = sessions.get(sessionID)
    if (s) {
      s.pendingResume = false
      s.lowBudgetPending = false
      s.lastUserPromptAt = Date.now()
      if (s.askingSince) {
        s.askingSince = null
        queueTitleRefresh(sessionID)
      }
      // A fresh user turn is the strongest "previousKind reset" signal:
      // any auto-injection loop the model was stuck in is now broken.
      s.previousKind = null
      s.previousKindChain = 0
      s.previousKindRepeats = 0
    }
    if (t) log("info", `cancelled pending auto-injection — ${why}`, { sessionID })
  }

  const autonomousPrompt = (plan) =>
    plan.prompt instanceof Function
      ? plan.prompt(cfg.autonomy)
      : plan.prompt

  /** Child (subagent) sessions belong to their parent orchestrator — never inject. */
  const injectionAllowed = (sessionID) => {
    const s = sessions.get(sessionID)
    if (s?.child) {
      log("info", "skipping injection into subagent session", { sessionID })
      return false
    }
    return true
  }

  const runPlan = async (sessionID, plan) => {
    if (!injectionAllowed(sessionID)) return
    const last = lastInjected.get(sessionID)
    if (last && last.kind === plan.kind && Date.now() - last.at < 3000) {
      log("info", `dropping duplicate injection "${plan.kind}" for ${sessionID}`)
      return
    }
    const s0 = state(sessionID)
    if (suppressed(sessionID)) {
      log("info", `suppressed "${plan.kind}" — session was stopped by the user`, { sessionID })
      return
    }
    if (cfg.maxTaskCostUsd > 0 && s0.taskCost >= cfg.maxTaskCostUsd) {
      if (!s0.costNotified) {
        s0.costNotified = true
        log("warn", "task cost cap reached - stopping auto-injections", { sessionID, spent: Math.round(s0.taskCost * 100) / 100 })
        notice(`${RESUME_TAG}: Task cost $${s0.taskCost.toFixed(2)} reached the $${cfg.maxTaskCostUsd} cap - pausing auto-drive. Raise OPENCODE_AUTOPILOT_MAX_COST_USD to continue.`, "warning")
      }
      return
    }
    // Stale-plan guards:
    // 1. A user prompt arrived AFTER we scheduled this plan → drop it.
    //    (covers Continue, Auto-resume, todos, improve, etc. — every kind)
    if (plan.createdTs && s0.lastUserPromptAt > plan.createdTs) {
      log("info", `dropping "${plan.kind}" — user prompt arrived after this plan was scheduled`, { sessionID })
      return
    }
    // 2. The session self-healed with a clean assistant turn AFTER we scheduled
    //    this plan → drop it (resume plans only).
    if (plan.kind === "resume" && plan.createdTs &&
        s0.lastSuccessAt >= plan.createdTs) {
      log("info", "dropping recovery — session already recovered on its own", { sessionID })
      return
    }
    const s = state(sessionID)

    if (plan.kind === "resume") {
      if (breakerOpen()) {
        if (!breakerNoted) {
          breakerNoted = true
          notice(`${RESUME_TAG} Circuit breaker open — auto-recovery suppressed.`, "error")
        }
        return
      }
      // We are about to inject a real prompt; clear the same-kind loop
      // tracker so the NEXT schedule (after this turn resolves) starts fresh.
      s.previousKind = null
      s.previousKindChain = 0
      s.previousKindRepeats = 0
      let status
      try {
        const res = await client.session.status()
        status = (res?.data ?? res)?.[sessionID]?.type
      } catch { status = "unknown" }
      if (status && status !== "idle") {
        // Core is mid-turn (often retrying through a provider outage).
        // Poll patiently — but NEVER force-inject onto a live turn: a queued
        // prompt would fire right after and duplicate the work. If the busy
        // turn dies on its own, its session.error re-arms recovery anyway.
        plan.polls = (plan.polls || 0) + 1
        const maxPolls = plan.kind === "resume" ? MAX_RESUME_POLLS : MAX_OTHER_POLLS
        if (plan.polls <= maxPolls) {
          schedule(sessionID, BUSY_POLL_INTERVAL_MS, plan) // core busy/retrying — check again shortly
          return
        }
        log("info", "session stayed busy — dropping stale injection", { sessionID, kind: plan.kind })
        return
      }
    }

    const model = s.currentModel ?? s.lastModel
    const body = { parts: [{ type: "text", text: autonomousPrompt(plan) }] }
    if (model) body.model = model

    // Re-check after the session.status() await above. A user Stop that lands
    // while this plan was mid-flight must cancel the injection outright —
    // otherwise the prompt is dispatched into a session the user just
    // silenced, which is exactly the "Stop doesn't stick" behaviour this guard
    // exists to prevent. (Non-resume kinds skip that await, but re-checking is
    // free and keeps the invariant local to the dispatch site.)
    if (suppressed(sessionID)) {
      log("info", `suppressed "${plan.kind}" — user stopped the session while the plan was in flight`, { sessionID })
      return
    }
    // Also re-check for a user prompt that arrived during the status await:
    // the stale-plan guard at the top runs BEFORE the await, so a prompt
    // landing during the async call would be missed. This check catches it.
    if (plan.createdTs && s.lastUserPromptAt > plan.createdTs) {
      log("info", `dropping "${plan.kind}" — user prompt arrived during status check`, { sessionID })
      return
    }

    s.lastInjectKind = plan.kind
    s.lastInjectAt = Date.now() // mark BEFORE dispatch: user-message event arrives at turn start
    s.lastResumeAt = s.lastInjectAt
    try {
      // Fire-and-forget when the server supports it: the sync prompt BLOCKS
      // until the AI reply completes, so provider outages turned each resume
      // into a minutes-long hang followed by "fetch failed" and retry storms.
      const ns = client.session ?? {}
      const asyncPrompt = ns.promptAsync ?? ns.postSessionByIdPromptAsync
      if (typeof asyncPrompt === "function") {
        await asyncPrompt.call(ns, { path: { id: sessionID }, body })
      } else {
        await ns.prompt({ path: { id: sessionID }, body })
      }
      s.pendingResume = false
      // Clear lowBudgetPending for lowBudget/continue plans so subsequent
      // quota errors can schedule new plans if this one succeeded.
      if (plan.kind === "lowBudget" || plan.kind === "continue") {
        s.lowBudgetPending = false
      }
      log("info", `injected "${plan.kind}"`, {
        sessionID,
        model: model ? modelKey(model) : undefined,
        mode: typeof asyncPrompt === "function" ? "async" : "sync",
      })
      lastInjected.set(sessionID, { kind: plan.kind, at: Date.now() })
      queueTitleRefresh(sessionID)
    } catch (err) {
      const ns = client.session ?? {}
      const mode = typeof (ns.promptAsync ?? ns.postSessionByIdPromptAsync) === "function" ? "async" : "sync"
      log("error", `resume prompt rejected (${mode})`, {
        sessionID, err: redactSecrets(err?.message ?? String(err)),
      })
      noteResumeFailure()
      if (plan.kind === "resume" && s.chain < cfg.maxChain) {
        s.chain += 1
        schedule(sessionID, backoff(s.chain, cfg.baseDelayMs), plan)
      } else {
        // A rejection can echo upstream detail; this reaches an OS toast.
        notice(`${RESUME_TAG}: Could not resume (${redactSecrets(err?.message ?? "error")}).`, "error")
      }
    }
  }

  // ── central failure handler ────────────────────────────────────────
  const handleError = async (sessionID, error) => {
    if (!sessionID) return
    // Suppress false-positive error autoprompts when no real error exists.
    const hasRealError = error && (error.name || (error.data && (error.data.statusCode || error.data.message)) || error.message)
    if (!hasRealError) {
      log("info", "ignoring false-positive error prompt — no real error", { sessionID })
      return
    }
    if (sessions.get(sessionID)?.child) {
      log("info", "ignoring error in subagent session (parent orchestrates)", { sessionID })
      return
    }
    const s = state(sessionID)
    if (suppressed(sessionID)) {
      log("info", "ignoring error — automation is off for this session", { sessionID })
      return
    }
    const nowMs = Date.now()
    // Dedupe only the SAME incident (session.error + message.updated both fire);
    // anything recurring after a dispatched resume is a new incident.
    const sig = `${error?.name}:${error?.data?.statusCode ?? ""}:${error?.data?.message ?? ""}`
    const duplicateIncident =
      sig === s.lastErrorSig && nowMs - s.lastErrorAt < DUPLICATE_INCIDENT_WINDOW_MS && (s.lastResumeAt <= s.lastErrorAt || nowMs - s.lastResumeAt < DUPLICATE_INCIDENT_WINDOW_MS)
    if (duplicateIncident) return
    s.lastErrorSig = sig
    s.lastErrorAt = nowMs
    s.lastActivity = nowMs
    if (error?.name) s.lastErrorName = error.name

    const kind = classify(error)
    const detail = describeErr(error)
    log("warn", `session error (${kind})`, {
      sessionID, name: error?.name, statusCode: error?.data?.statusCode,
      // Raw provider text can echo the credential that failed. The log is
      // persisted on disk and mirrored to the server console, so redact.
      message: redactSecrets(error?.data?.message ?? error?.message ?? ""),
    })
    queueTitleRefresh(sessionID)
    if (kind !== "abort" && kind !== "auth" && kind !== "fatal") {
      await suppressErrorPopups()
    }

    const currentModel = s.currentModel ?? s.lastModel
    const curModelKey = currentModel ? modelKey(currentModel) : null
    if (curModelKey) {
      // Clean up stale failure velocities periodically
      cleanModelFailureVelocities(nowMs)
      if (isDeprecatedError(error)) {
        modelCooldown.set(curModelKey, Date.now() + DEPRECATION_COOLDOWN_MS)
        if (catalogCache) {
          for (const prov of catalogCache) {
            if (prov?.models && currentModel.modelID in prov.models) {
              delete prov.models[currentModel.modelID]
            }
          }
        }
        log("warn", "model deprecated — removing and rotating", { sessionID, model: curModelKey })
        notice(`${RESUME_TAG}: Model ${curModelKey} is deprecated — removed from active models and rotated.`, "error")
        if (cfg.rotationEnabled) {
          await rotateAwayFrom(sessionID, "model deprecated", true)
          s.chain += 1
          if (s.chain <= cfg.maxChain) {
            schedule(sessionID, cfg.baseDelayMs, { kind: "resume", prompt: buildResumePrompt(sessionID, kind, error, true, curModelKey) })
            return
          }
        }
      }

      let failures = modelFailureVelocities.get(curModelKey) ?? []
      failures = failures.filter(ts => nowMs - ts < FAILURE_VELOCITY_WINDOW_MS)
      failures.push(nowMs)
      modelFailureVelocities.set(curModelKey, failures)
      // Record failure for provider health cache (bias rotation away from flaky models)
      recordHealth(curModelKey, false)

      if (failures.length >= 2 && cfg.rotationEnabled) {
        log("warn", "model failed multiple times in <60s — force rotating instead of retrying", { sessionID, model: curModelKey, count: failures.length })
        notice(`${RESUME_TAG}: Model ${curModelKey} failed repeatedly within 60s — force-rotating to avoid retry storms.`)
        modelCooldown.set(curModelKey, Date.now() + cfg.modelCooldownMs)
        const rotOk = await rotateAwayFrom(sessionID, "repeated rapid failures", true)
        if (rotOk) {
          s.chain += 1
          if (s.chain <= cfg.maxChain) {
            schedule(sessionID, cfg.baseDelayMs, { kind: "resume", prompt: buildResumePrompt(sessionID, kind, error, true, curModelKey) })
            return
          }
        }
      }
    }

    // An error on the improve turn: the cycle isn't "in flight" anymore
    // regardless of which kind of error fired. Clear here so the title
    // drops 🧪 immediately instead of waiting for the next task boundary.
    s.improveActive = false

    if (kind === "abort") {
      if (isOwnTakeoverAbort(s)) {
        log("info", "ignoring abort issued by our own takeover", { sessionID })
        return
      }
      markUserStopped(sessionID, error?.name ?? "abort")
      return
    }
    if (kind === "auth") {
      // Auth is provider-scoped: rotate to another PROVIDER's model if possible.
      const authFrom = s.lastModel ? modelKey(s.lastModel) : null
      if (cfg.rotationEnabled && (await rotateAwayFrom(sessionID, "authentication failed"))) {
        s.chain += 1
        if (s.chain <= cfg.maxChain) {
          schedule(sessionID, cfg.baseDelayMs, { kind: "resume", prompt: buildResumePrompt(sessionID, kind, error, true, authFrom) }); return
        }
      }
      notice(`${RESUME_TAG}: Provider authentication failed — run \`opencode auth login\`.`, "error")
      return
    }

    // ── quota / free-tier exhaustion: budget cascade or rotation ──────────
    if (kind === "quota") {
      const isCredits = isCreditsConstraint(error)
      const sig = isCredits ? describeErrForPrompt(error) : null
      const sameBudget = isCredits && sig && sig === s.lowBudgetSig
      const quotaFrom = s.lastModel ? modelKey(s.lastModel) : null

      // Always rotate on quota — pick a free/unlimited model first so the
      // next attempt has a better chance of fitting in the budget.
      if (cfg.rotationEnabled && cfg.switchOnQuota) {
        const rotated = await rotateAwayFrom(sessionID, "quota/free tier exhausted")
        if (rotated) {
          s.chain += 1
          // New model may still hit the budget wall — compact prompt for the
          // first attempt after rotation so we stay within tight token limits.
          if (s.chain <= cfg.maxChain) {
            schedule(sessionID, cfg.baseDelayMs, {
              kind: "lowBudget",
              prompt: buildResumePrompt(sessionID, kind, error, true, quotaFrom),
            })
          }
          return
        }
        // No model to rotate to — fall through to cascade below.
      }

      // No rotation possible.  Cascade: compact × N → bare Continue.
      // Routers (OpenRouter, Groq, etc.) hide per-upstream capacity behind a
      // single API: a brief outage on one upstream can throttle the whole
      // router for minutes. Give the cascade one extra compact attempt so we
      // don't burn straight through to bare "Continue" on what is usually a
      // transient issue. Direct providers keep 2+1 (compact × 2 → Continue).
      // Routers get 3+1 (compact × 3 → Continue).
      const routerModel = s.currentModel ?? s.lastModel
      const compactRounds = isRouter(routerModel) ? 3 : 2
      const settleBase = isRouter(routerModel)
        ? Math.max(cfg.baseDelayMs, 15_000)  // let upstream token bucket refill
        : cfg.baseDelayMs

      // Guard against duplicate scheduling: if a lowBudget plan is already
      // pending for this same budget signature, don't schedule another.
      // Multiple quota errors can arrive rapidly before the plan executes.
      if (s.lowBudgetPending && sameBudget) {
        log("info", "lowBudget plan already pending — skipping duplicate", { sessionID })
        return
      }

      if (!sameBudget || s.lowBudgetStreak < compactRounds) {
        if (sameBudget) s.lowBudgetStreak += 1
        else { s.lowBudgetStreak = 1; s.lowBudgetSig = sig }
        s.lowBudgetLastFired = false
        s.lowBudgetPending = true
        schedule(sessionID, settleBase, {
          kind: "lowBudget",
          prompt: buildResumePrompt(sessionID, kind, error, false, null),
        })
        return
      }

      // Final attempt: same budget hit (compactRounds + 1) times → bare
      // "Continue".  Routers: attempt 5; direct: attempt 4.
      if (s.lowBudgetStreak === compactRounds) {
        s.lowBudgetStreak += 1
        s.lowBudgetLastFired = true
        s.lowBudgetPending = true
        schedule(sessionID, cfg.baseDelayMs, {
          kind: "continue",
          prompt: `Continue`,
          extra: { _lowBudgetLast: true },
        })
        return
      }

      // Everything failed.
      s.lowBudgetStreak = 0; s.lowBudgetSig = null; s.lowBudgetLastFired = false
      s.lowBudgetPending = false
      notice(`${RESUME_TAG}: Token/credit budget too tight — ${isCredits ? sig : "quota exhausted"}. Manual intervention required.`, "error")
      return
    }

    // ── repeated rate limits on the same model → rotate too ──
    const errText = `${error?.data?.message ?? ""} ${error?.data?.responseBody ?? ""}`
    const isExplicitRateLimit = matchesAny(errText, RATE_LIMIT_PATTERNS)
    if (kind === "rate_limit" && cfg.rotationEnabled &&
        (isExplicitRateLimit || s.rlStreak + 1 >= cfg.rlSwitchAfter) &&
        cfg.switchOnRateLimit) {
      const rlFrom = s.lastModel ? modelKey(s.lastModel) : null
      if (await rotateAwayFrom(sessionID, isExplicitRateLimit ? "rate limit exceeded" : "repeated rate limits")) {
        s.rlStreak = 0
        // Routers (OpenRouter, Groq, etc.) wrap many upstreams behind one
        // quota. A 429 from a single upstream can throttle the whole router
        // for a minute, so we wait longer before retrying. Direct providers
        // get the 15s cap (their rate-limits usually clear faster).
        const rlDelay = isRouter(s.currentModel ?? s.lastModel)
          ? Math.max(cfg.baseDelayMs, 45_000)
          : Math.min(cfg.baseDelayMs, 15_000)
        schedule(sessionID, jitter(rlDelay), { kind: "resume", prompt: buildResumePrompt(sessionID, kind, error, true, rlFrom) })
        return
      }
    }

    if (kind === "output_length") {
      if (s.continueCount >= cfg.outputLengthMax) {
        notice(`${RESUME_TAG}: Output kept hitting max length ${cfg.outputLengthMax}x — giving up.`, "warning")
        return
      }
      s.continueCount += 1
      schedule(sessionID, cfg.nudgeDelayMs, { kind: "continue", prompt: PROMPTS.truncated })
      return
    }

    if (kind === "overflow") {
      if (!cfg.compactOnOverflow || s.compactAttempted) {
        notice(`${RESUME_TAG}: Context window exhausted${s.compactAttempted ? " (compaction already tried)" : ""}.`, "error")
        return
      }
      s.compactAttempted = true
      s.awaitingCompactionSince = Date.now()
      detach(async () => {
        const summarizeWith = async (model) => {
          const body = model ? { providerID: model.providerID, modelID: model.modelID } : undefined
          await client.session.summarize({ path: { id: sessionID }, body })
        }
        try {
          await summarizeWith(s.currentModel ?? s.lastModel)
          log("info", "compaction requested after overflow", { sessionID })
        } catch (err) {
          if (!cfg.rotationEnabled) {
            log("info", "compaction failed on primary model — rotation disabled, not retrying on alternate", { sessionID })
            notice(`${RESUME_TAG}: Compaction failed and model rotation is disabled.`, "error")
            return
          }
          log("warn", "compaction failed on primary model, rotating summarizer", {
            sessionID, err: err?.message ?? String(err),
          })
          const alt = await pickAlternateModel(s.currentModel ?? s.lastModel)
          if (!alt) {
            notice(`${RESUME_TAG}: Compaction failed and no alternate model available.`, "error")
            return
          }
          await summarizeWith(alt)
          log("info", "compaction requested on alternate model", { sessionID, model: modelKey(alt) })
        }
        if (s.compactionTimer) clearTimeout(s.compactionTimer)
        s.compactionTimer = setTimeout(() => {
          const cur = state(sessionID)
          if (cur.compactionTimer) cur.compactionTimer = null
          if (cur.awaitingCompactionSince) {
            cur.awaitingCompactionSince = 0
            notice(`${RESUME_TAG}: Compaction did not complete — not resuming.`, "error")
          }
        }, COMPACTION_WATCHDOG_MS)
        s.compactionTimer.unref?.()
      }, "summarize")
      return
    }

    if (kind === "fatal") {
      notice(`${RESUME_TAG}: Unrecoverable error (${error?.name ?? "unknown"}) — not retrying.`, "error")
      return
    }

    // ── retryable | rate_limit(first strikes) ──
    if (kind === "rate_limit") s.rlStreak += 1

    // Persistent model-specific trouble (endpoint down, network errors, 5xx
    // waves, timeouts): after N failed rounds on the same model, move on.
    // No cooldown penalty — provider outages are usually temporary.
    if (kind === "retryable") {
      s.failStreak += 1
      if (cfg.rotationEnabled && cfg.switchOnFailures && s.failStreak >= cfg.rotateAfterFailures) {
        const retFrom = s.lastModel ? modelKey(s.lastModel) : null
        if (await rotateAwayFrom(sessionID, "persistent failures", false)) {
          s.failStreak = 0
          schedule(sessionID, jitter(Math.min(cfg.baseDelayMs, 15_000)), { kind: "resume", prompt: buildResumePrompt(sessionID, kind, error, true, retFrom) })
          return
        }
      }
    }

    if (s.pendingResume) return
    if (s.chain >= retryBudget()) {
      noteResumeFailure()
      notice(`${RESUME_TAG}: Gave up after ${s.chain} recovery attempts (${kind}). Send a message to try manually.`, "error")
      // Bounded self-re-arm for unattended runs: after a cool-down, reset the
      // chain and try ONCE more — long outages (502 storms, provider blips)
      // must not permanently kill recovery until the user returns. We also
      // reset stallResumes here: the within-task stall-takeover cap
      // (maxStallTakeovers, default 4) is an anti-loop guard, NOT a hard
      // kill — a session that hit the cap should get a fresh budget after
      // the rearm window.
      if (!s.gaveUpRearmed && !suppressed(sessionID)) {
        s.gaveUpRearmed = true
        if (s.rearmTimer) clearTimeout(s.rearmTimer)
        s.rearmTimer = setTimeout(() => {
          const cur = state(sessionID)
          if (cur.rearmTimer) cur.rearmTimer = null
          if (cur.chain >= cfg.maxChain &&
              cur.lastResumeAt <= s.lastErrorAt && !suppressed(sessionID)) {
            cur.chain = 0
            cur.stallResumes = 0
            log("info", "post-give-up re-arm — retrying recovery", { sessionID })
            schedule(sessionID, jitter(cfg.baseDelayMs), { kind: "resume", prompt: PROMPTS.resume })
          }
        }, cfg.rearmMs)
        s.rearmTimer.unref?.()
      }
      return
    }
    s.pendingResume = true
    s.chain += 1
    const delay = retryDelay(kind, s.chain, error)
    schedule(sessionID, delay, { kind: "resume", prompt: buildResumePrompt(sessionID, kind, error, false, null) })
  }

  // ── permission autopilot ───────────────────────────────────────────
  let denyListCache = null
  const denyList = () => {
    if (!denyListCache) {
      const extra = cfg.extraDeny.split(",").map((x) => x.trim()).filter(Boolean)
      denyListCache = [...DANGEROUS_PATTERNS, ...extra]
    }
    return denyListCache
  }
  // Fingerprint for permission-based lookups.  Uses JSON for the outer structure
  // so no byte in title or metadata can collide with the field boundary — a
  // metadata string containing '\x00' would be indistinguishable from a metadata
  // object whose JSON has '\x00' at the same offset (e.g. a directory named
  // 'foo\x00bar' vs the object {foo:'bar'}).  JSON-encoding the outer array
  // eliminates that ambiguity without changing the deny-list semantics.
  // Only includes title + metadata (not the tool name) to avoid false hits from
  // tool names like 'external_directory' matching denylist fragments.
  const permFingerprint = (perm) => {
    const meta = perm.metadata
    const metaStr = meta == null ? "" : Array.isArray(meta) ? meta.join(" ") : typeof meta === "object" ? JSON.stringify(meta) : String(meta)
    return JSON.stringify([String(perm.title ?? ""), metaStr]).toLowerCase()
  }

  const looksDangerous = (perm) => {
    const blob = permFingerprint(perm)
    // Cap at 4 KB so user-controlled regexes from OPENCODE_AUTOPILOT_EXTRA_DENY
    // can't cause catastrophic backtracking (ReDoS).  Perm titles are short.
    const capped = blob.length > 4096 ? blob.slice(0, 4096) : blob
    return denyList().some((entry) => {
      if (entry.startsWith("re:")) {
        const pattern = entry.slice(3)
        // ReDoS protection: limit regex complexity and execution time
        // Reject patterns with nested quantifiers, excessive alternation, or other dangerous constructs
        if (DANGEROUS_REGEX_PATTERN.test(pattern)) {
          log("warn", "Rejected potentially dangerous regex in extraDeny", { pattern: pattern.slice(0, 50) })
          return false
        }
        try { return new RegExp(pattern, "i").test(capped) } catch { return false }
      }
      return capped.includes(entry.toLowerCase())
    })
  }

  /** OpenCode's Permission info names the tool/type field `permission`
   *  ({ id, sessionID, permission: "external_directory", metadata, title });
   *  older cores and our own test mocks used `type`. Tolerate both. */
  const permTypeOf = (perm) => String(perm?.permission ?? perm?.type ?? "").toLowerCase()
  const permIdOf = (perm) => perm?.id ?? perm?.permissionID

  /** Reply to a pending request. The SDK surface drifted across versions, so
   *  candidates are probed IN ORDER until one resolves — a wrong-shape call
   *  rejecting must not strand the ask. */
  const respondToPermission = async (sessionID, perm, response, why) => {
    if (!cachedPermFns) {
      const root = client ?? {}
      const sessionNS = client?.session ?? {}
      const candidates = [
        [root.postSessionIdPermissionsPermissionId, root],
        [sessionNS.postSessionByIdPermissionsByPermissionId, sessionNS],
        [sessionNS.respondToPermission, sessionNS],
        [sessionNS.postSessionIdPermissionsPermissionId, sessionNS],
        ...Object.keys(root)
          .filter((k) => /permission/i.test(k) && typeof root[k] === "function")
          .map((k) => [root[k], root]),
        ...Object.keys(sessionNS)
          .filter((k) => /permission/i.test(k) && typeof sessionNS[k] === "function")
          .map((k) => [sessionNS[k], sessionNS]),
      ]
      const seen = new Set()
      cachedPermFns = candidates.filter(([f]) => {
        if (typeof f !== "function" || seen.has(f)) return false
        seen.add(f)
        return true
      })
    }
    const fns = cachedPermFns
    if (!fns.length) { log("warn", "permission API unavailable on this opencode version"); return false }
    const permID = permIdOf(perm)
    // permID is the only path-segment we own; refuse to send an undefined
    // identifier rather than let the SDK fabricate "session/.../permissions/undefined".
    // The caller at the permission.updated event also guards this, but
    // respondToPermission is a public-ish helper and may be called by future
    // paths (e.g., periodic sweep of stale permissionPending entries).
    if (!permID) {
      log("warn", "permission response skipped — missing permID", {
        sessionID, type: permTypeOf(perm), why,
      })
      return false
    }
    if (String(permID).length > 256) {
      log("warn", "permission response skipped — permID too long", {
        sessionID, type: permTypeOf(perm), why, len: String(permID).length,
      })
      return false
    }
    let lastErr
    for (const [fn, receiver] of fns) {
      try {
        await fn.call(receiver, {
          path: { id: sessionID, permissionID: permID },
          body: { response },
        })
        log("info", `permission auto-${response}`, { sessionID, type: permTypeOf(perm), why })
        notice(`${RESUME_TAG}: auto-${response} ${permTypeOf(perm)} permission (${why}).`, response === "reject" ? "warning" : "info")
        return true
      } catch (err) {
        lastErr = err
      }
    }
    log("warn", "permission respond failed", {
      sessionID, err: lastErr?.message ?? String(lastErr),
    })
    // A silent failure strands AFK runs on a popup — surface it.
    notice(`${RESUME_TAG}: Could not auto-answer a ${permTypeOf(perm)} permission — it needs your attention.`, "warning")
    return false
  }

  const EDIT_TYPES = ["edit", "write", "patch", "file", "apply_patch"]
  const SHELL_TYPES = ["bash", "shell", "command", "terminal", "execute"]
  const WEB_TYPES = ["webfetch", "fetch", "web", "url"]
  // Workspace-external directory grants ("Allow always / Allow once" pop-ups):
  // without an answer the session stalls forever — a show-stopper when AFK.
  const DIR_TYPES = ["external_directory", "directory", "path"]

  /** Sensitive system areas that must never be auto-granted, expressed for
   *  ALL major path conventions (Windows / Linux / macOS) so a grant is
   *  rejected no matter which OS style the pattern uses on any host.
   *  Segment-anchored to avoid false hits like "\network" or "cabinet".
   *  Applied against the JSON payload, where backslashes are escaped —
   *  the [\\/] character class matches either separator form. */
  const SENSITIVE_DIR_RES = [
    /[\\/]windows([\\/"'*]|$)/i,
    /system32([\\/"'*]|$)/i,
    /[\\/]program files(\s*\(x86\))?([\\/"']|$)/i,
    /[\\/](etc|proc|sys|dev|boot|root|usr|bin|sbin|lib|var)([\\/"'*]|$)/i,
    /[\\/]\.(ssh|gnupg|aws|kube|docker|azure|gcp)([\\/"']|$)/i,
    /[\\/]library[\\/]keychains?([\\/"']|$)/i,
  ]
  const sensitiveDirHit = (perm) => {
    const blob = permFingerprint(perm)
    return SENSITIVE_DIR_RES.some((re) => re.test(blob))
  }

  /** Identifies WHICH external boundary an ask refers to, so repeated asks
   *  for the same directory escalate together while different directories
   *  keep independent counters. */
  const dirSignature = (sessionID, perm) => {
    const m = perm.metadata ?? {}
    const pattern = m.patterns ?? m.pattern ?? m.path ?? m.directory ?? ""
    return `${sessionID}|${permTypeOf(perm)}|${JSON.stringify(pattern)}`
  }
  const dirAskCounts = new Map() // "<sessionID>|<type>|<pattern>" -> benign answers
  const dirAskCountsBySession = new Map() // sessionID -> Set of keys

  const decidePermission = (sessionID, perm) => {
    if (!cfg.autonomy || !cfg.permissions) return null
    if (cfg.permissionMode === "off") return null
    const type = permTypeOf(perm)
    if (looksDangerous(perm)) return "reject"
    if (EDIT_TYPES.includes(type) || WEB_TYPES.includes(type)) return "once"
    // Answered "once" so unattended runs proceed; repeated asks for the same
    // directory are each answered automatically. Cross-OS sensitive areas are
    // rejected outright; paths can additionally be deny-listed via
    // OPENCODE_AUTOPILOT_EXTRA_DENY. With DIR_ALWAYS_AFTER > 0, the Nth+1
    // benign ask for the SAME boundary escalates to "always" so core saves
    // its proposed patterns instead of re-asking forever.
    if (DIR_TYPES.includes(type) || type.includes("directory")) {
      if (sensitiveDirHit(perm)) return "reject"
      if (cfg.dirAlwaysAfter > 0) {
        const sig = dirSignature(sessionID, perm)
        const seen = (dirAskCounts.get(sig) ?? 0) + 1
        dirAskCounts.set(sig, seen)
        // Track key for efficient per-session cleanup
        let keySet = dirAskCountsBySession.get(sessionID)
        if (!keySet) { keySet = new Set(); dirAskCountsBySession.set(sessionID, keySet) }
        keySet.add(sig)
        return seen > cfg.dirAlwaysAfter ? "always" : "once"
      }
      return "once"
    }
    if (SHELL_TYPES.includes(type)) return "once" // danger already checked above
    if (cfg.permissionMode === "all") return "once"
    return null // safe mode: unknown types stay human-decided
  }

  // ── idle evaluation: success reset, todo drive, proposals ─────────
  const budgetLeft = (s) =>
    !cfg.budgetMs || !s.taskStartAt || Date.now() - s.taskStartAt < cfg.budgetMs

  const evaluateIdle = async (sessionID) => {
    const s = state(sessionID)
    if (s.evaluatingIdle) return
    s.evaluatingIdle = true
    try {
    if (suppressed(sessionID)) { s.awaitingCompactionSince = 0; return }
    const relevant =
      s.lastErrorName || s.lastResumeAt || s.continueCount ||
      s.todos.length || s.lastTurnHadText
    s.awaitingCompactionSince = 0
    if (!relevant) return
    // any engaged session shows its indicator while auto-resume is enabled
    queueTitleRefresh(sessionID)

    let entries = []
    try {
      const res = await client.session.messages({ path: { id: sessionID } })
      entries = (res?.data ?? res) ?? []
    } catch { return }

    // Re-check suppression after the async fetch — the session may have been
    // stopped by a concurrent session.error handler while we were waiting.
    if (suppressed(sessionID)) return

    let lastAssistant = null
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]?.info?.role === "assistant") { lastAssistant = entries[i]; break }
    }
    if (!lastAssistant) return

    // session.status(idle) and session.idle fire for the SAME turn end —
    // evaluate each finished turn exactly once, keyed by its last message.
    const turnSig = `${lastAssistant.info?.id ?? ""}:${(lastAssistant.parts ?? []).length}`
    if (turnSig && turnSig === s.lastEvalSig) return
    s.lastEvalSig = turnSig

    const info = lastAssistant.info
    if (info.modelID && !s.currentModel) {
      s.lastModel = { providerID: info.providerID, modelID: info.modelID }
      s.originalModel = s.originalModel ?? s.lastModel
    }

    // Stop-button presses that never raised session.error still leave a
    // MessageAbortedError on the stored assistant message — honor those too.
    if (isAbortError(info.error)) {
      if (!isOwnTakeoverAbort(s)) {
        markUserStopped(sessionID, "assistant message carries an abort error")
      }
      // Aborted improve cycle: the cycle is no longer "in flight" regardless
      // of the stop origin (user or our own takeover). Clearing the flag here
      // prevents the title from being stuck at 🧪 until the next task reset.
      s.improveActive = false
      return
    }

    const hasContent = (lastAssistant.parts ?? []).some((p) => ["text", "tool", "reasoning"].includes(p?.type))
    const errored = Boolean(info.error)

    /* Provider safety filter stopped the turn. OpenCode 2 reports this as an
     * explicit finish reason rather than burying it in an error string, so it
     * is detectable without guessing. It needs its own message: every other
     * recovery prompt tells the model to *continue*, but a filtered reply will
     * be filtered again verbatim. The correct remedy is to reframe, or to skip
     * the blocked part and finish everything else — so drive that directly
     * instead of letting the generic success/empty paths decide. */
    if (info.finish === "content-filter" && cfg.autonomy && s.contentFilterFired !== info.id) {
      s.contentFilterFired = info.id
      log("warn", "turn stopped by provider content filter", { sessionID, messageID: info.id })
      if (s.nudges < cfg.maxNudges && budgetLeft(s)) {
        s.nudges += 1
        s.chain = 0
        schedule(sessionID, cfg.nudgeDelayMs, { kind: "contentFilter", prompt: PROMPTS.contentFilter })
        return
      }
      notice(`${RESUME_TAG}: Provider content filter blocked the last reply — finishing around it.`, "warning")
      return
    }

    if (!errored && hasContent) {
      noteSuccess()
      const curKey = s.currentModel ?? s.lastModel
      if (curKey) recordHealth(modelKey(curKey), true)
      // A clean turn supersedes any recovery still waiting to fire: without
      // this, error→scheduled resume + core's own successful retry produced
      // spurious "transient infrastructure error" prompts on healthy turns.
      s.lastSuccessAt = Date.now()
      s.toolErrs = 0
      s.gaveUpRearmed = false
      s.budgetNotified = false
      s.lowBudgetStreak = 0; s.lowBudgetSig = null; s.lowBudgetLastFired = false
      s.lowBudgetPending = false
      s.emptyStreak = false  // recovered — clear the empty-loop latch
      s.askingSince = null
      // A clean turn is the evidence that the alternate is working. Count it
      // toward the favorite-return stability gate.
      if (s.favoriteRotatedAt) s.turnsSinceRotation += 1

      // Self-improvement: a clean turn closes out the in-flight improve
      // cycle. If that was the LAST scheduled cycle, latch improvedAt so the
      // title shows ✅ for a short window before settling to armed/idle.
      if (s.improveActive) {
        s.improveActive = false
        if (s.improveDone >= cfg.improveCycles) s.improvedAt = Date.now()
      }

      const todos = s.todos ?? []
      const open = todos.filter((t) => t.status === "pending" || t.status === "in_progress")
      const finished = todos.filter((t) => t.status === "completed" || t.status === "cancelled")

      // Implicit todo lists: markdown checkboxes in the assistant's own reply
      // count as a todo list even when the todo tool was never used.
      const replyText = (lastAssistant.parts ?? [])
        .map((x) => (x?.type === "text" ? x.text : "")).join(" ")
      let boxes = [...replyText.matchAll(CHECKBOX_RE)]
      let cbOpen = boxes.filter((m) => m[1] !== "x" && m[1] !== "X").length
      let cbDone = boxes.length - cbOpen

      // OpenCode 2 dropped the todo tool and the todo.updated event, so a V2
      // model has no structured task list. When the newest reply carries no
      // checklist, fall back to the most recent plan the model wrote earlier in
      // the conversation — otherwise a plan stated a few turns ago silently
      // stops driving continuation the moment the next reply is a short
      // confirmation. Tool-backed todos (V1 cores) always take precedence, so
      // existing behaviour is unchanged where the structured list exists.
      if (todos.length === 0 && boxes.length === 0) {
        const plan = latestPlanFromMessages(entries)
        if (plan && plan.open > 0) {
          cbOpen = plan.open
          cbDone = plan.done
          boxes = new Array(plan.total).fill("[ ]")
        }
      }

      // The agent ended its turn by asking a question or announcing more
      // work ("Continue to finalize.") instead of finishing — keep it going.
      if (open.length === 0 && s.lastInjectKind !== "propose" && cfg.autonomy && cfg.proceedOnAsk &&
          s.proceedCount < cfg.maxProceeds && s.nudges < cfg.maxNudges && budgetLeft(s)) {
        if (replyText && replyText.trim()) {
          const asked = QUESTION_PATTERNS.some((re) => re.test(replyText))
          const stubbed = looksLikeContinuationStub(replyText) || looksLikeContinuationLong(replyText)
          // "Which of these do you want me to tackle first?" / "Should I tackle
          // proposal 2?" / "Want me to do all of them?" / "draft a SPEC for X" —
          // these are proposal-list / defer-to-user questions. Different from a
          // simple yes/no proceed: the user wants unattended execution of N items,
          // so fire a stronger "do all, step-by-step" prompt instead of the
          // generic proceed nudge.
          const proposalList = /\b(which (of these|one)|tackle (first|proposal)|do all\b|implement all\b|all of them|draft a spec|write a spec)\b/i.test(replyText)
          if (asked || stubbed) {
            s.proceedCount += 1
            s.nudges += 1
            // The ❓ "asking" glyph is reserved for actual question turns —
            // stubs ("Continue to finalize.") aren't a question, the user
            // isn't being asked anything. Setting askingSince for a stub
            // would mislead the user into thinking the model is waiting on
            // them. The notice is already gated to `asked` only.
            if (asked) s.askingSince = Date.now()
            log("info",
              proposalList ? "agent asked a proposal-list question — proceeding to do all" :
              asked ? "agent asked a question — proceeding autonomously" :
              "agent announced continuation but stopped — resuming",
              { sessionID })
            if (asked) {
              notice(`${RESUME_TAG}: model asked — answering autonomously.`, "info")
            }
            schedule(sessionID, cfg.nudgeDelayMs, {
              kind: "proceed",
              prompt: proposalList ? PROMPTS.proceedAll : (asked ? PROMPTS.proceed : PROMPTS.keepGoing),
            })
            return
          }
        }
      }

      // Full completion → self-improvement passes → wrap-up proposals → notice
      if ((todos.length > 0 || boxes.length > 0) && open.length === 0 && cbOpen === 0) {
        // Quality passes are EXEMPT from the shared nudge budget: they have
        // their own hard caps (improveCycles / proposalSent), and burning the
        // drive budget must never silence final-quality passes on long runs.
        if (cfg.autonomy && cfg.improveLoop && s.improveDone < cfg.improveCycles
            && s.improveTotal < cfg.improveMax && budgetLeft(s)) {
          const cycle = s.improveDone + 1
          s.improveDone = cycle
          s.improveTotal += 1
          s.lastImprovedAt = Date.now()
          s.improveActive = true
          s.nudges += 1
          log("info", "improvement pass", { sessionID, cycle: `${cycle}/${cfg.improveCycles}` })
          schedule(sessionID, cfg.nudgeDelayMs, {
            kind: "improve",
            prompt: () => PROMPTS.improve(cycle, cfg.improveCycles),
          })
          return
        }
        if (cfg.autonomy && cfg.proposals && !s.proposalSent && budgetLeft(s)) {
          s.proposalSent = true
          s.nudges += 1
          schedule(sessionID, cfg.nudgeDelayMs, { kind: "propose", prompt: PROMPTS.propose })
          return
        }
        notice(`${RESUME_TAG}: Task list complete. ✅`, "success")
        return
      }

      // No-todo autopilot: many LLMs (cheap/free routers, smaller open-source
      // models, fast inference endpoints) never call the todo tool and never
      // emit markdown checkboxes. Without this branch the entire subsystem 4
      // (self-improvement + wrap-up proposals) silently skips their sessions.
      // We still require (a) substantive text output, (b) no pending todos /
      // boxes, and (c) a clean (non-error) turn — same safety rails as the
      // todo-driven path — and gate behind the same improve caps/budget so
      // a no-todo session never gets more autonomy than a structured one.
      const noTodos = todos.length === 0 && boxes.length === 0
      // Honour the same cooldown + proposalSent latches as the todo path so a
      // single follow-up question can't instantly re-trigger the loop.
      const cooldownOk = !s.lastImprovedAt ||
        (cfg.improveCooldownMs === 0) ||
        (Date.now() - s.lastImprovedAt >= cfg.improveCooldownMs)
      if (noTodos && !s.noTodoImproveFired && !s.proposalSent && cooldownOk
          && s.lastInjectKind !== "improve" && s.lastInjectKind !== "propose"
          && cfg.autonomy && cfg.improveLoop
          && s.improveDone < cfg.improveCycles && s.improveTotal < cfg.improveMax
          && budgetLeft(s)) {
        const text = (lastAssistant.parts ?? [])
          .map((x) => (x?.type === "text" ? x.text : "")).join(" ").trim()
        // Only fire when the model actually delivered answer-shaped text, so
        // trivial acks / single-line tool echoes don't trigger a critique pass.
        if (text.length >= 80) {
          const cycle = s.improveDone + 1
          s.improveDone = cycle
          s.improveTotal += 1
          s.lastImprovedAt = Date.now()
          s.improveActive = true
          s.nudges += 1
          s.noTodoImproveFired = true
          log("info", "no-todo autopilot: improvement pass on a non-todo model", {
            sessionID, cycle: `${cycle}/${cfg.improveCycles}`, chars: text.length,
          })
          schedule(sessionID, cfg.nudgeDelayMs, {
            kind: "improve",
            prompt: () => PROMPTS.improve(cycle, cfg.improveCycles),
          })
          return
        }
      }

      // Unfinished todos → drive continuation (with spin detection + caps)
      // Spin detection tracks progress SINCE THE LAST NUDGE, not total progress.
      // This prevents false "progress" when the model completes unrelated todos
      // between nudges without actually addressing the stuck items.
      if (cfg.autonomy && cfg.todoDrive && (open.length > 0 || cbOpen > 0) &&
          s.nudges < cfg.maxNudges && budgetLeft(s)) {
        const doneNow = finished.length + cbDone
        // Compare against completed count at last nudge (or initial -1)
        const baseline = s.lastNudgeCompletedCount >= 0 ? s.lastNudgeCompletedCount : doneNow
        if (doneNow === baseline) {
          s.staleDrives += 1
        } else {
          s.staleDrives = 0
        }
        if (s.staleDrives < 2) {
          s.nudges += 1
          s.driveCount += 1
          // Record completed count AT THE TIME OF THIS NUDGE for next comparison
          s.lastNudgeCompletedCount = doneNow
          log("info", "todo-drive nudge", { sessionID, open: open.length + cbOpen, drive: s.driveCount })
          schedule(sessionID, cfg.nudgeDelayMs, { kind: "todos", prompt: PROMPTS.todos })
          return
        }
        log("warn", "todo-drive stopped: no progress across nudges", { sessionID })
        notice(`${RESUME_TAG}: Todos stalled without progress — stopping auto-drive.`, "warning")
        return
      }
      // Nudge budget exhausted on drives/proceeds: say so ONCE instead of
      // silently going dark — quality passes (improve/propose) still run.
      if ((open.length > 0 || cbOpen > 0) && !s.budgetNotified) {
        s.budgetNotified = true
        notice(`${RESUME_TAG}: Drive-nudge budget (${cfg.maxNudges}) reached — pausing todo-drives. Self-improvement passes still run. Send a new prompt to refill.`, "warning")
      }
      return
    }

    if (!errored && !hasContent && s.lastResumeAt) {
      // Respond to consecutive empty turns (context compaction, streaming glitch, or
      // a silent model).  Retry up to 3 times: the first two are a compact
      // "empty" nudge; the third is an explicit "keep going" nudge that
      // survives even if the model has nothing queued.  After that the nudges
      // cap takes over so we don't spam indefinitely.
      if (s.emptyNudges < 2) {
        s.emptyNudges += 1
        log("info", "empty response detected, nudging", { sessionID, emptyNudges: s.emptyNudges })
        schedule(sessionID, cfg.nudgeDelayMs, { kind: "empty", prompt: PROMPTS.empty })
      } else if (s.emptyNudges === 2 && s.nudges < cfg.maxNudges) {
        s.emptyNudges += 1
        log("info", "still empty after 2 nudges — explicit keep-going", { sessionID })
        schedule(sessionID, cfg.nudgeDelayMs, { kind: "empty", prompt: PROMPTS.keepGoing })
      }
      // Mark the session as stuck; cleared by any content-bearing response so
      // the flag doesn't poison the next idle evaluation after we recover.
      s.emptyStreak = true
    }

    // Failsafe: if the turn ended in any non-success way (empty, errored,
    // fall-through), the improve cycle is no longer "in flight". Without this,
    // a non-success end leaves the title pinned at 🧪 until the next task
    // boundary — masking the actual state of the session. The success branch
    // already cleared this above; this catches the errored/empty paths.
    if (errored || !hasContent) s.improveActive = false
    } finally {
      s.evaluatingIdle = false
    }
  }

  // ── stall + stuck-retry watchdog ───────────────────────────────────
  const takeover = (sessionID, why, noticeMsg, plan = { kind: "resume", prompt: PROMPTS.resume }) => {
    const s = state(sessionID)
    // The previous hard cap of `s.stallResumes >= 2` forced babysitting on
    // long free-tier stalls once the model hit retry #3. Stall takeovers are
    // now capped independently via `cfg.maxStallTakeovers` (env:
    // OPENCODE_RESUME_MAX_STALL_TAKEOVERS, default 4) on top of the
    // `maxChain` ceiling — both must allow a retry. chain can also be
    // advanced by non-stall retries (e.g. 429 backoffs), so the two caps
    // are orthogonal: stall path is bounded by maxStallTakeovers, aggregate
    // path by maxChain.
    if (s.chain >= cfg.maxChain || s.stallResumes >= cfg.maxStallTakeovers) return
    s.stallResumes += 1
    s.chain += 1
    s.lastActivity = Date.now()
    s.takeoverAt = Date.now() // our own abort — must not read as a user stop
    s.retryEnteredAt = 0
    s.retryNext = 0
    log("warn", why, { sessionID })
    notice(noticeMsg)
    queueTitleRefresh(sessionID)
    detach(async () => {
      try { await client.session.abort({ path: { id: sessionID } }) } catch { /* already dead */ }
      setTimeout(() => schedule(sessionID, TAKEOVER_SCHEDULE_DELAY_MS, plan), TAKEOVER_RETRY_DELAY_MS).unref?.()
    }, "takeover-abort")
  }
  const checkStalls = () => {
    const nowMs = Date.now()
    // Periodic cleanup for dirAskCounts to prevent unbounded growth.
    // Remove entries for sessions that no longer exist, and enforce max size.
    if (dirAskCounts.size > 0) {
      // Use dirAskCountsBySession for efficient per-session cleanup
      for (const [sessionID, keySet] of dirAskCountsBySession) {
        if (!sessions.has(sessionID)) {
          for (const k of keySet) dirAskCounts.delete(k)
          dirAskCountsBySession.delete(sessionID)
        }
      }
      // If still over limit, remove oldest entries (first inserted).
      if (cfg.maxDirAskCounts > 0 && dirAskCounts.size > cfg.maxDirAskCounts) {
        const toRemove = dirAskCounts.size - cfg.maxDirAskCounts
        let removed = 0
        for (const k of dirAskCounts.keys()) {
          if (removed >= toRemove) break
          dirAskCounts.delete(k)
          // Also remove from per-session index to prevent unbounded Set growth
          const sid = k.split("|")[0]
          const keySet = dirAskCountsBySession.get(sid)
          if (keySet) {
            keySet.delete(k)
            if (keySet.size === 0) dirAskCountsBySession.delete(sid)
          }
          removed++
        }
        log("debug", "dirAskCounts size limit exceeded, removed oldest entries", { removed })
      }
    }

    // Health cache TTL cleanup: remove entries not updated in 30 days to prevent unbounded growth.
    const HEALTH_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
    for (const [modelKey, entry] of providerHealthStore.map) {
      if (nowMs - (entry.lastUpdated ?? 0) > HEALTH_CACHE_TTL_MS) {
        providerHealthStore.map.delete(modelKey)
      }
    }
    if (providerHealthStore.map.size > 0) providerHealthStore.save()

    // Memory hygiene: drop state for sessions that have been idle for hours.
    for (const [sessionID, s] of sessions) {
      if (s.status === "busy" || s.status === "retry") continue
      if (nowMs - s.lastActivity > SESSION_IDLE_CLEANUP_MS) {
        // Drop any orphaned timers first so the closures don't outlive the
        // session and fire into a deleted state.
        if (s.rearmTimer) { clearTimeout(s.rearmTimer); s.rearmTimer = null }
        if (s.compactionTimer) { clearTimeout(s.compactionTimer); s.compactionTimer = null }
        sessions.delete(sessionID)
        knownTitles.delete(sessionID)
        writtenTitles.delete(sessionID)

        // Efficient dirAskCounts cleanup using per-session index
        const keySet = dirAskCountsBySession.get(sessionID)
        if (keySet) {
          for (const k of keySet) dirAskCounts.delete(k)
          dirAskCountsBySession.delete(sessionID)
        }
        const tt = titleTimers.get(sessionID)
        if (tt) clearTimeout(tt)
        titleTimers.delete(sessionID)
        const pt = timers.get(sessionID)
        if (pt) clearTimeout(pt)
        timers.delete(sessionID)
        permissionPending.delete(sessionID)
      }
    }
    for (const [sessionID, s] of sessions) {
      if (s.child || suppressed(sessionID)) continue

      // A session parked in OpenCode's internal retry loop can wait for a
      // provider-specified Retry-After of effectively unlimited length.
      // If it sits there too long, or the next attempt is absurdly far in
      // the future, take over: abort and resume on our own terms.
      if (s.status === "retry") {
        const enteredAt = s.retryEnteredAt || nowMs
        const nextIn = s.retryNext ? s.retryNext - nowMs : 0
        const absurdFuture = Boolean(s.retryNext) && nextIn > cfg.retryFutureCapMs
        const tooLong = nowMs - enteredAt > cfg.retryTakeoverMs
        if (absurdFuture || tooLong) {
          takeover(sessionID,
            absurdFuture
              ? "retry loop scheduled absurdly far ahead — taking over"
              : "retry loop exceeded takeover limit — taking over",
            `${RESUME_TAG}: Retry loop is stuck — taking over.`)
        }
        continue
      }

      if (s.status !== "busy") {
        // Idle: the user isn't mid-turn, so this is the safe moment to give
        // the session back to their favorite model if it's due.
        tryRestoreFavorite(sessionID)
        continue
      }
      // Check if any permission is pending for this session
      if (permissionPending.has(sessionID)) continue
      const silentFor = nowMs - s.lastActivity
      // Fast lane: model "thinking" with zero events for a short window -> labelled
      // automatic retry (abort + resume). Tool activity keeps its own longer grace below.
      if (!s.toolRunning && cfg.thinkStallMs > 0 && silentFor >= cfg.thinkStallMs) {
        const attempt = Math.min(s.stallResumes + 1, 9)
        takeover(sessionID,
          `thinking stalled ${Math.round(silentFor / 1000)}s with no output — automatic retry #${attempt}`,
          `${RESUME_TAG}: No output for ~${Math.round(cfg.thinkStallMs / 1000)}s — automatic retry #${attempt}.`,
          { kind: "retry", prompt: () => PROMPTS.retry(attempt) })
        continue
      }
      // A genuinely running tool gets an extended grace window: quiet builds,
      // installs, test suites are legitimate silence, not stalls.
      const silenceLimit = s.toolRunning
        ? cfg.stallTimeoutMs * cfg.runningToolFactor
        : cfg.stallTimeoutMs
      if (nowMs - s.lastActivity < silenceLimit) continue
      // A stall while a tool was still in flight needs different advice from a
      // stall on a silent model: the tool may already have applied its effect,
      // so re-running it can double-apply a migration, re-deploy, or re-send.
      const stallPlan = s.toolRunning
        ? { kind: "resume", prompt: PROMPTS.stalledInTool }
        : undefined
      takeover(sessionID, "stalled stream detected, aborting + resuming",
        s.toolRunning
          ? `${RESUME_TAG}: A tool call never returned — checking whether it landed.`
          : `${RESUME_TAG}: Response appears stuck — restarting it.`,
        stallPlan)
    }
  }

  // ── crash recovery: revive sessions killed by a server/machine restart ──
  // Recovery timers live in the server process, so a crash orphans any turn
  // that was mid-recovery or awaiting its first reply. On startup we scan
  // recent sessions and give those a fresh continuation.
  const reanimate = async (activeSessionsSnapshot = null) => {
    await Promise.all([stopStore.load(), offStore.load(), pauseStore.load(), providerHealthStore.load()])
    // On startup, use the snapshot captured before any events could modify the store.
    // On server.connected (client restart), reload the store to get the latest state —
    // the startup snapshot is stale and misses sessions that became active after startup.
    if (!activeSessionsSnapshot) {
      await activeSessionStore.load()
      activeSessionsSnapshot = new Map()
      for (const [id, ts] of activeSessionStore.map) {
        activeSessionsSnapshot.set(id, ts)
      }
    }
    if (!cfg.reanimate) return
    let list = []
    try {
      const res = await client.session.list()
      list = (res?.data ?? res) ?? []
    } catch (err) {
      log("warn", "reanimation scan failed", { err: err?.message ?? String(err) })
    }
    // Only revive sessions that exist in the current session list.
    // The active store is only used to extend the revival window for sessions
    // that are currently in the session list (not to add phantom sessions from
    // previous test runs or stale data).
    if (!Array.isArray(list)) return
    const cutoff = Date.now() - cfg.reanimateWindowMs
    const activeCutoff = Date.now() - RESTART_RECOVERY_WINDOW_MS
    const activeList = [...list].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)).slice(0, 50)
    for (const sess of activeList) {
      if (!sess?.id || sess.parentID) continue
      if (typeof sess.id !== "string" || sess.id.length > 256) continue
      if (suppressed(sess.id)) continue
      const activeTs = activeSessionsSnapshot.get(sess.id)
      const isActiveStore = typeof activeTs === "number" && activeTs > activeCutoff
      if (!isActiveStore && (sess.time?.updated ?? 0) < cutoff) continue
      const s = state(sess.id)
      if (s.reanimated) continue
      s.reanimated = true

      let entries = []
      try {
        const r = await Promise.race([
          client.session.messages({ path: { id: sess.id } }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("messages fetch timeout")), 10_000))
        ])
        entries = (r?.data ?? r) ?? []
      } catch { continue }
      if (suppressed(sess.id)) continue
      // Only revive sessions that have actual conversation history.
      // Empty sessions (just created, no messages) should not be auto-prompted.
      if (!entries.length) continue
      const lastEntry = entries[entries.length - 1]
      const lastInfo = lastEntry?.info
      if (!lastInfo) continue

      resetTaskScope(s)

      // A prompt that never received any reply: the turn died at submission.
      if (lastInfo.role === "user") {
        if (suppressed(sess.id)) continue
        log("info", "reanimating session with unanswered prompt", { sessionID: sess.id })
        schedule(sess.id, TAKEOVER_RETRY_DELAY_MS, { kind: "resume", prompt: PROMPTS.resume })
        notice(`${RESUME_TAG}: Revived a session interrupted by the restart.`)
        continue
      }

      const incomplete =
        lastInfo.role === "assistant" &&
        !lastInfo.error &&
        typeof lastInfo.time === "object" &&
        lastInfo.time !== null &&
        !(lastInfo.time.completed > 0)

      if (lastInfo.role === "assistant" && (lastInfo.error || incomplete || isActiveStore)) {
        let kind = lastInfo.error ? classify(lastInfo.error) : "interrupted"
        if (kind === "abort") kind = "retryable"
        if (["auth", "fatal", "overflow"].includes(kind)) continue
        if (lastInfo.modelID) {
          s.lastModel = { providerID: lastInfo.providerID, modelID: lastInfo.modelID }
        }
        if ((kind === "quota" || kind === "rate_limit") && cfg.rotationEnabled) {
          await rotateAwayFrom(sess.id, "quota/rate limit (after restart)", true)
          if (suppressed(sess.id)) continue
        }
        if (suppressed(sess.id)) continue
        log("info", "reanimating previously active session after restart", { sessionID: sess.id, kind })
        schedule(
          sess.id,
          TAKEOVER_RETRY_DELAY_MS,
          kind === "output_length"
            ? { kind: "continue", prompt: PROMPTS.truncated }
            : { kind: "resume", prompt: `${RESUME_TAG} Client/server restarted. Re-animating previously active session. Reconstruct state from conversation + codebase and continue from exactly where you stopped.` },
        )
        notice(`${RESUME_TAG}: Revived previously active session after restart.`)
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    restoreOptedOutTitles()
  }


  // -- self-updater: daily check against the official repo -------------------
  let lastUpdateCheckAt = 0
  let pendingUpdateNotice = null
  let noticeDelivering = false
  let lastNoticeTryAt = 0
  let noticeAttempts = 0
  let deliveryTimers = []

  /** Delivery of a one-shot update confirmation as a native OS notification —
   *  the TUI toast channel no longer exists. The .acked marker commits only
   *  after the OS notifier accepted the job, so failed attempts retry on the
   *  next activity nudge (at most every 30s). Persistent failure (notifier-less
   *  hosts) downgrades to debug after 3 tries so busy logs aren't flooded. */
  const deliverPendingNotice = async () => {
    if (!pendingUpdateNotice || noticeDelivering) return
    if (Date.now() - lastNoticeTryAt < NOTICE_DELIVERY_RETRY_MS) return
    noticeDelivering = true
    try {
      const n = pendingUpdateNotice
      const { readFile, writeFile } = await import("node:fs/promises")
      const current = (await readFile(n.ackPath, "utf8").catch(() => "")).trim()
      if (current === AUTO_RESUME_VERSION) {
        pendingUpdateNotice = null
        for (const t of deliveryTimers.splice(0)) clearTimeout(t)
        return
      }
      const osOk = await announce(n.message, { requireDelivery: true })
      if (!osOk) throw new Error("OS notifier unavailable")
      await writeFile(n.ackPath, AUTO_RESUME_VERSION, "utf8")
      pendingUpdateNotice = null
      for (const t of deliveryTimers.splice(0)) clearTimeout(t) // delivered: stop retry passes
      log("info", "update notice delivered via OS notification")
    } catch (err) {
      lastNoticeTryAt = Date.now()
      noticeAttempts += 1
      log(noticeAttempts >= 3 ? "debug" : "warn",
        "update notice delivery failed — retrying later", { err: err?.message ?? String(err) })
    } finally {
      noticeDelivering = false
    }
  }

  /** First sign of client life: settle briefly so the notifier stack is up,
   *  then attempt delivery exactly once per arming. */
  let noticeNudged = false
  const nudgePendingNotice = () => {
    if (!pendingUpdateNotice || noticeNudged) return
    noticeNudged = true
    const t = setTimeout(() => {
      noticeNudged = false
      detach(deliverPendingNotice, "notice-deliver")
    }, 2_500)
    t.unref?.()
  }
  const isNewerVersion = (remote, local) => {
    const r = String(remote).split(".").map((x) => parseInt(x, 10) || 0)
    const l = String(local).split(".").map((x) => parseInt(x, 10) || 0)
    for (let i = 0; i < 3; i += 1) {
      if ((r[i] || 0) !== (l[i] || 0)) return (r[i] || 0) > (l[i] || 0)
    }
    return false
  }
  const checkForUpdates = async () => {
    if (!cfg.autoUpdate || !selfPath) return
    if (Date.now() - lastUpdateCheckAt < 86_400_000) return
    lastUpdateCheckAt = Date.now()
    try {
      const res = await fetch(`${UPDATE_URL}?t=${Date.now()}`, {
        headers: { "user-agent": `auto-resume-plugin/${AUTO_RESUME_VERSION}` },
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15_000) : undefined,
      })
      if (!res.ok) return
      const src = await res.text()
      if (!src.startsWith("/**")) return // sanity: plausible release only
      const match = src.match(/AUTO_RESUME_VERSION = "([^"]+)"/)
      if (!match) return
      if (!isNewerVersion(match[1], AUTO_RESUME_VERSION)) {
        log("debug", "auto-resume up to date", { local: AUTO_RESUME_VERSION, remote: match[1] })
        return
      }
      let current = ""
      try {
        const { readFile } = await import("node:fs/promises")
        current = await readFile(selfPath, "utf8")
      } catch { /* keep empty backup */ }
      await writeFile(`${selfPath}.bak`, current, "utf8")
      const tmp = `${selfPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
      try {
        await writeFile(tmp, src, "utf8")
        await rename(tmp, selfPath)
      } finally {
        // Self-updater renamed its tmp into place — drop the tmp now so a
        // successful update doesn't leak a unique-suffix file next to the
        // plugin. Windows locks on a freshly-written file can transiently
        // fail unlink; that's fine, it self-cleans on the next update.
        try { await unlink(tmp) } catch { /* best effort */ }
      }
      log("info", "self-updated", { from: AUTO_RESUME_VERSION, to: match[1], path: selfPath })
      // Update completed → user-facing channels: an OpenCode log entry plus a
      // native OS notification (works even when no client window is open).
      detach(() =>
        announce(
          `${RESUME_TAG}: Updated ${AUTO_RESUME_VERSION} -> ${match[1]}. Restart OpenCode to load it.`,
          { title: "auto-resume updated", event: "update-applied" },
        ), "milestone-announce")
    } catch (err) {
      log("debug", "update check skipped", { err: err?.message ?? String(err) })
    }
  }
  if (cfg.enabled) {
    const wd = setInterval(() => detach(checkStalls, "watchdog"), cfg.watchdogMs)
    wd.unref?.()
    const upd = setInterval(() => detach(checkForUpdates, "update-check"), 3_600_000)
    upd.unref?.()
    // Track active timers for cleanup
    const activeIntervals = [wd, upd]
    const activeTimeouts = [...deliveryTimers]
    // Cleanup function for graceful shutdown
    const cleanup = () => {
      for (const t of activeIntervals) clearInterval(t)
      for (const t of activeTimeouts) clearTimeout(t)
      // Cancel all pending scheduled work so nothing fires after shutdown.
      for (const t of timers.values()) { try { clearTimeout(t) } catch { /* ignore */ } }
      timers.clear()
      for (const t of titleTimers.values()) { try { clearTimeout(t) } catch { /* ignore */ } }
      titleTimers.clear()
      for (const s of sessions.values()) {
        if (s?.rearmTimer) { clearTimeout(s.rearmTimer); s.rearmTimer = null }
        if (s?.compactionTimer) { clearTimeout(s.compactionTimer); s.compactionTimer = null }
      }
      // Save any pending stores
      stopStore.save().catch(() => {})
      offStore.save().catch(() => {})
      pauseStore.save().catch(() => {})
      activeSessionStore.save().catch(() => {})
      providerHealthStore.save().catch(() => {})
      // Flush any pending telemetry
      flushTelemetry()
      if (telemetryFlushTimer) clearTimeout(telemetryFlushTimer)
    }
    // Attach cleanup to process signals for graceful shutdown (listeners
    // attached once per process; see armShutdownHooks).
    shutdownCleanups.push(cleanup)
    armShutdownHooks()
    // Also expose cleanup on the plugin for external callers
    globalThis.__autoResumeCleanup = cleanup

    detach(() => log("info", `auto-resume v${AUTO_RESUME_VERSION} initialized`), "init-log")
    detach(pauseStore.load, "pause-store-load")
    detach(stopStore.load, "stop-store-load")
    detach(offStore.load, "off-store-load")
    detach(providerHealthStore.load, "provider-health-store-load")
    detach(activeSessionStore.load, "active-session-store-load")
    detach(async () => {
      await Promise.all([stopStore.load(), offStore.load(), pauseStore.load(), providerHealthStore.load(), activeSessionStore.load()])
      restoreOptedOutTitles()
    }, "optout-title-restore")
    detach(checkForUpdates, "update-check")
    // One-shot update confirmations are delivered as native OS notifications:
    // a short settle delay after init avoids racing server startup, then the
    // first session/message activity, a server.connected event, or an 15s
    // fallback re-attempt failed deliveries.
    if (cfg.autoUpdate) {
      detach(async () => {
        if (!selfPath) return
        try {
          const { readFile } = await import("node:fs/promises")
          const ackPath = `${selfPath}.acked`
          const acked = (await readFile(ackPath, "utf8").catch(() => "")).trim()
          if (acked === AUTO_RESUME_VERSION) return
          pendingUpdateNotice = {
            ackPath,
            message: `${RESUME_TAG}: Now running v${AUTO_RESUME_VERSION}${acked ? ` (previously ${acked})` : ""} — update fully applied.`,
          }
          // Deliberately REF'D (no unref): these timers are the delivery
          // mechanism for a milestone the ack protocol must not lose. Bun
          // has been observed never firing unref'd timers once the host
          // loop goes quiet — exactly when a headless CI test waits on them.
          // deliverPendingNotice clears both once the notice resolves.
          const timers = [
            setTimeout(() => detach(deliverPendingNotice, "notice-deliver"), 800),
            setTimeout(() => detach(deliverPendingNotice, "notice-fallback"), OS_NOTIFICATION_TIMEOUT_MS),
          ]
          deliveryTimers = timers
          activeTimeouts.push(...timers)
        } catch { /* cosmetic only */ }
      }, "update-notice")
    }
    // Snapshot active sessions from PREVIOUS run BEFORE any events can modify the store.
    // This ensures we only revive sessions that were active before the restart.
    startupActiveSnapshot = new Map()
    try {
      await activeSessionStore.load()
      for (const [id, ts] of activeSessionStore.map) {
        startupActiveSnapshot.set(id, ts)
      }
    } catch { /* ignore */ }
    // Run reanimation with the snapshot
    await reanimate(startupActiveSnapshot)
    // Deferred reanimation: server may not have populated session list yet.
    // Retry after a random delay (1s-5s) to stagger requests and catch asynchronously loaded sessions.
    const staggerMs = Math.floor(Math.random() * 4000) + 1000
    setTimeout(() => detach(reanimate, "reanimate-deferred"), staggerMs).unref?.()
  } else {
    console.warn(`${RESUME_TAG} disabled via OPENCODE_RESUME_ENABLED`)
  }

  return {
    /* Bridge for the V2 adapter. Not a V1 hook name — V1 core only reads the
     * keys it knows (event, tool, chat.*, permission.ask, ...), so an extra
     * property is inert there. It exists so ctx.permission.hook("evaluate")
     * can reuse the exact same decision logic (safe-mode rules, cross-OS
     * deny-list, escalation counters) instead of duplicating it on the V2
     * side. Returns null when the autopilot should not decide (disabled,
     * opted out, safe-mode unlisted type), meaning "leave this to the human". */
    __evaluatePermission: (sessionID, request) => {
      const perm = v2PermissionToV1({
        ...request,
        action: request?.action,
        resources: Array.isArray(request?.resources) ? request.resources : [],
        metadata: request?.metadata,
        sessionID,
      })
      if (suppressed(sessionID)) return null
      const decision = decidePermission(sessionID, perm)
      if (!decision) return null
      return {
        effect: decision === "reject" ? "deny" : "allow",
        reply: decision,
        type: permTypeOf(perm),
      }
    },
    event: async (input) => {
      if (!cfg.enabled) return
      const event = input && typeof input === "object" ? input.event : null
      if (!event || typeof event.type !== "string") return
      try {
        const type = event.type
        const p = event.properties ?? {}

        switch (type) {
          case "session.error": {
            if (p.sessionID) recordActiveSession(p.sessionID)
            if (p.sessionID && p.error) detach(handleError(p.sessionID, p.error), "handleError")
            break
          }

          case "message.updated": {
            nudgePendingNotice()
            const info = p.info
            if (!info?.sessionID) break
            recordActiveSession(info.sessionID)
            state(info.sessionID).lastActivity = Date.now()

            if (info.role === "user") {
              // Fresh task boundary — unless it's OUR own injected prompt.
              // UserMessage carries no parts in this event, so verify by
              // fetching the stored message text and matching our tag.
              const s0 = state(info.sessionID)
              let ours = false
              let userText = ""
              if (info.id) {
                try {
                  const res = await client.session.message({
                    path: { id: info.sessionID, messageID: info.id },
                  })
                  const data = res?.data ?? res
                  userText = (data?.parts ?? [])
                    .map((x) => (x?.type === "text" ? x.text : "")).join(" ")
                  ours = userText.includes(RESUME_TAG)
                } catch { ours = false }
              }
              // In-chat switch: exactly "auto-resume off" / "auto-resume on"
              // (leading "/" allowed). Short exact match so prose never trips it.
              const toggleCmd = /^\/?auto[- ]?resume[ :]?(off|on|pause)[.!]?\s*$/i.exec(userText.trim())
              if (toggleCmd) {
                handleToggleCommand(info.sessionID, toggleCmd[1].toLowerCase())
                break
              }
              if (!ours) {
                // Cancel any plugin-injected plan that was queued before this user
                // prompt arrived — the new conversation must not be polluted by
                // a stale "Continue" / "Auto-resume" that fires seconds later.
                cancelPending(info.sessionID, "user prompt arrived")
                sessionErrorSynthLock.delete(info.sessionID)
                // A REAL prompt starts a new workflow — lift the stop, on
                // disk too, so future runs automate this session again.
                // (An explicit opt-out is only lifted by "auto-resume on".)
                if (persistedStops.delete(info.sessionID)) stopStore.save()
                // Follow-up detection: if all todos are already complete (or
                // the no-todo autopilot has already fired for this session)
                // and the improve-cooldown hasn't elapsed yet, preserve
                // improve counters so improvement passes don't re-trigger on
                // the same topic.  Once the cooldown expires, reset
                // everything so new work gets a fresh improvement cycle.
                const todos = s0.todos ?? []
                const allDone = todos.length > 0 &&
                  todos.every((t) => t.status === "completed" || t.status === "cancelled")
                const cooldownElapsed = !s0.lastImprovedAt ||
                  (cfg.improveCooldownMs !== 0 && Date.now() - s0.lastImprovedAt >= cfg.improveCooldownMs)
                const followUp = (allDone || s0.noTodoImproveFired) && !cooldownElapsed
                resetTaskScope(s0, { followUp })
                s0.currentModel = null
                s0.emptyNudges = 0
                s0.emptyStreak = false
                queueTitleRefresh(info.sessionID)
              }
              s0.lastTurnHadText = false // new turn begins
              break
            }
            // Fallback reanimation on first session activity: catches initial
            // startup when server.connected doesn't fire or fires before sessions load.
            if (firstSessionActivity && cfg.reanimate) {
              firstSessionActivity = false
              if (Date.now() - lastReanimateAt > REANIMATE_SCAN_INTERVAL_MS) {
                lastReanimateAt = Date.now()
                detach(reanimate, "reanimate-activity")
              }
            }
            // Capture model + spend from assistant messages.
            if (info.role === "assistant") {
              const s = state(info.sessionID)
              if (info.modelID) {
                const seen = { providerID: info.providerID, modelID: info.modelID }
                s.originalModel = s.originalModel ?? seen
                s.lastModel = seen
              }
              /* Accumulate spend against the per-task cost cap
               * (OPENCODE_AUTOPILOT_MAX_COST_USD).
               *
               * This used to never happen: taskCost was initialised to 0 and
               * compared against the cap, but nothing ever added to it, so the
               * cap could not trip and the "paused - cost cap" title state and
               * the cap notice were unreachable. Accumulate on the assistant
               * message, which is where the provider reports turn cost.
               *
               * Guarded because message.updated can be re-delivered: count a
               * given message once, or a re-render inflates the total and halts
               * a healthy task. */
              const cost = Number(info.cost)
              if (Number.isFinite(cost) && cost > 0) {
                // Bounded: one id per assistant message would grow for the
                // life of the process. Re-delivery is always of the same
                // (most recent) message, so a short window is sufficient.
                if (!s.countedCostMessageIds) s.countedCostMessageIds = []
                const costMsgID = info.id
                if (!costMsgID || !s.countedCostMessageIds.includes(costMsgID)) {
                  if (costMsgID) {
                    s.countedCostMessageIds.push(costMsgID)
                    if (s.countedCostMessageIds.length > 16) s.countedCostMessageIds.shift()
                  }
                  s.taskCost = (s.taskCost ?? 0) + cost
                }
              }
            }
            break
          }

          case "message.part.updated": {
            const part = p.part
            if (!part?.sessionID) break
            const s = state(part.sessionID)
            s.lastActivity = Date.now()
            if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
              s.lastTurnHadText = true
            } else if (part.type === "tool") {
              const st = part.state?.status
              if (st === "running") {
                s.toolRunning = true // heartbeat: long-running tools get grace
              } else if (st === "completed" || st === "error") {
                s.toolRunning = false
              }
              if (st === "error") {
                s.toolErrs += 1
                if (cfg.autonomy && cfg.debugNudge && s.toolErrs >= 3 && !s.debugArmed &&
                    s.nudges < cfg.maxNudges && budgetLeft(s)) {
                  s.debugArmed = true
                  s.nudges += 1
                  log("warn", "consecutive tool failures — sending debug nudge", {
                    sessionID: part.sessionID, fails: s.toolErrs,
                  })
                  schedule(part.sessionID, cfg.nudgeDelayMs, { kind: "debug", prompt: PROMPTS.debug })
                }
              } else if (st === "completed") {
                s.toolErrs = 0
                s.debugArmed = false
              }
            }
            break
          }

          case "todo.updated": {
            if (p.sessionID && Array.isArray(p.todos)) state(p.sessionID).todos = p.todos
            break
          }

          case "session.status": {
            nudgePendingNotice()
            if (!p.sessionID) break
            recordActiveSession(p.sessionID)
            const s = state(p.sessionID)
            s.status = p.status?.type ?? "unknown"
            s.lastActivity = Date.now()
            if (s.status === "retry") {
              if (!s.retryEnteredAt) s.retryEnteredAt = Date.now()
              if (typeof p.status?.next === "number") s.retryNext = p.status.next
            } else {
              s.retryEnteredAt = 0
              s.retryNext = 0
            }
            if (s.status === "busy") s.lastTurnHadText = false
            if (s.status === "idle") {
              s.pendingResume = false
              // Defer to session.idle which fires for the same turn;
              // evaluateIdle deduplicates via lastEvalSig, but we skip here
              // to avoid double-scheduling when both events fire.
            }
            break
          }

          case "session.idle": {
            nudgePendingNotice()
            if (p.sessionID) {
              const s = state(p.sessionID)
              s.status = "idle"
              s.pendingResume = false
              detach(evaluateIdle(p.sessionID), "evaluateIdle")
            }
            break
          }

          case "permission.updated":
          case "permission.asked": {
            // Payload shapes seen across cores:
            //   • FLAT (current): properties ARE the Permission info and
            //     `p.permission` holds the TOOL NAME STRING ("external_directory")
            //   • NESTED (older): the info object lives under p.permission
            // Only treat p.permission as the info object when it really is one.
            const perm = p.permission && typeof p.permission === "object" ? p.permission : p
            const sessionID = perm.sessionID ?? p.sessionID
            if (!sessionID) break
            const permID = permIdOf(perm)
            permissionPending.set(sessionID, Date.now()) // for watchdog: any perm pending for session
            // Composite key: permIDs alone can't be attributed back to a
            // session, which left the session.deleted prefix-scan dead code.
            if (permID) permissionPendingById.set(`${sessionID}|${permID}`, Date.now())
            // After a user Stop, the human owns every decision again.
            const decision = suppressed(sessionID) ? null : decidePermission(sessionID, perm)
            if (decision) {
              detach(respondToPermission(sessionID, perm, decision,
                decision === "reject" ? "dangerous pattern" : "autopilot"), "permission")
            } else {
              // Visibility: a silently-ignored ask looks identical to a dead
              // autopilot from the outside. Say why it was left alone.
              log("info", "permission left for manual decision", {
                sessionID, type: permTypeOf(perm),
                reason: suppressed(sessionID) ? "session stopped/opted-out" : "safe mode: unlisted type",
              })
            }
            break
          }

          case "permission.replied": {
            const permID = p.permissionID ?? p.id
            if (p.sessionID) permissionPending.delete(p.sessionID)
            if (permID) {
              if (p.sessionID) {
                permissionPendingById.delete(`${p.sessionID}|${permID}`)
              } else {
                // No session attribution on the reply: fall back to a suffix
                // scan so the entry can't leak.
                for (const k of permissionPendingById.keys()) {
                  if (k === String(permID) || k.endsWith(`|${permID}`)) permissionPendingById.delete(k)
                }
              }
            }
            break
          }

          case "server.connected": {
            // Laptop woke up / client reconnected: rescan for sessions that
            // were orphaned while the machine was asleep (throttled).
            const nowMs = Date.now()
            if (cfg.reanimate && nowMs - lastReanimateAt > REANIMATE_SCAN_INTERVAL_MS) {
              lastReanimateAt = nowMs
              detach(reanimate, "reanimate")
            }
            nudgePendingNotice()
            break
          }

          case "session.created":
          case "session.updated": {
            const info = p.info
            if (info?.id) {
              recordActiveSession(info.id)
              // Revert sets a revert marker on the session (messageID [+ partID]
              // of the truncation point). The user is taking manual control to
              // edit and reprompt — cancel any queued autoprompt and stay quiet
              // until their next prompt, exactly like a Stop.
              if (info.revert?.messageID ?? info.revert) {
                markReverted(info.id, "session carries a revert marker")
                break
              }
              const s = state(info.id)
              if (info.parentID) s.child = true
              // Adopt external renames: if the user (or core) retitled the
              // session and our tag is gone, re-attach it to the new base.
              if (typeof info.title === "string" && knownTitles.get(info.id) !== info.title) {
                knownTitles.set(info.id, info.title)
                if (writtenTitles.has(info.id) && !TITLE_MARK_TEST.test(info.title)) {
                  writtenTitles.delete(info.id)
                  queueTitleRefresh(info.id)
                }
              }
            }
            break
          }

          case "message.removed":
          case "message.part.removed": {
            // Revert cleanup deletes messages/parts after the truncation point
            // (sessions.removeMessage/removePart). Even when the revert marker
            // above was missed or ordered differently, a deletion means the
            // conversation just changed under us: any queued auto-injection was
            // planned against the pre-deletion history and must not fire into
            // the reverted session. Lightweight on purpose — cancel the pending
            // plan and stamp user activity so in-flight plans drop as stale —
            // without persistent suppression (compaction also prunes history).
            const id = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID
            if (id) cancelPending(id, "message removed")
            break
          }

          case "session.compacted": {
            const s = sessions.get(p.sessionID)
            if (s?.awaitingCompactionSince) {
              s.awaitingCompactionSince = 0
              if (s.compactionTimer) { clearTimeout(s.compactionTimer); s.compactionTimer = null }
              log("info", "compaction done, resuming", { sessionID: p.sessionID })
              // The history was just rewritten into a summary. A generic resume
              // reads like data loss and makes models restart the task; say
              // explicitly that compaction is expected and the work is intact.
              schedule(p.sessionID, 3_000, { kind: "resume", prompt: PROMPTS.afterCompaction })
            }
            break
          }
          case "session.deleted": {
            // Match the rest of the file: session events use p.sessionID.
            // Previously this read p.info?.id, which was a no-op when the
            // payload shape was flat — the entire cleanup (permissionPending,
            // stores, timers, dirAskCounts) silently skipped, leaking
            // everything in-memory for that session.
            const id = p.sessionID ?? p.info?.id
            if (id) {
              // Orphaned timers (rearm / compaction-watchdog) hold closures
              // over the session state; clear them BEFORE we drop the
              // session so a no-op run on a deleted session can't touch
              // live state later.
              const s = sessions.get(id)
              if (s?.rearmTimer) { clearTimeout(s.rearmTimer); s.rearmTimer = null }
              if (s?.compactionTimer) { clearTimeout(s.compactionTimer); s.compactionTimer = null }
              sessions.delete(id)
              permissionPending.delete(id)
              // permissionPendingById is keyed "sessionID|permID"; drop this session's entries
              for (const k of permissionPendingById.keys()) {
                if (k.startsWith(`${id}|`)) permissionPendingById.delete(k)
              }
              const hadMarker =
                persistedStops.delete(id) ||
                offStore.map.delete(id) ||
                pauseStore.map.delete(id)
              if (hadMarker) {
                stopStore.save()
                offStore.save()
                pauseStore.save()
              }
              knownTitles.delete(id)
              writtenTitles.delete(id)

              // Efficient dirAskCounts cleanup using per-session index
              const keySet = dirAskCountsBySession.get(id)
              if (keySet) {
                for (const k of keySet) dirAskCounts.delete(k)
                dirAskCountsBySession.delete(id)
              }
              // Clean up model selection history
              modelSelectionHistory.delete(id)
              const tt = titleTimers.get(id)
              if (tt) clearTimeout(tt)
              titleTimers.delete(id)
              const t = timers.get(id)
              if (t) clearTimeout(t)
              timers.delete(id)
            }
            break
          }
        }
      } catch (err) {
        console.error(`${RESUME_TAG} event handler error:`, err?.message ?? err)
      }
    },
  }
}

/* ═══════════════════════════════════════════════════════════════════════
 *  OPENCODE V2 ENTRYPOINT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * OpenCode 2.x does NOT run V1 plugins. Its loader imports the module and
 * requires the DEFAULT export to be a plugin definition — an object with a
 * stable `id` and a `setup(ctx)` (Promise plugins) or `effect(host)` (Effect
 * plugins). A V1 module (named export returning hooks) fails at load with:
 *
 *   Plugin must export a default definition with an id and an effect or
 *   setup function.  (cause: SchemaError(Missing key at ["default"]))
 *
 * `Plugin.define()` is an identity function (`(p) => p`), so the definition
 * can be exported as a plain object literal. That matters here: this plugin
 * is installed as a bare `file://` module with no node_modules next to it,
 * so it must not `import { Plugin } from "@opencode/plugin"` — the specifier
 * would not resolve outside a package context.
 *
 * Everything above is the V1 engine and is left untouched. Below, a thin
 * adapter reconciles two very different surfaces:
 *
 *   • the V1 SDK client (`client.session.prompt({ path, body })`,
 *     `client.session.status()`, `client.config.providers()`, ...) → the V2
 *     plugin context (`ctx.session.prompt({ sessionID, text })`,
 *     `ctx.session.interrupt(...)`, `ctx.provider.list()`, ...)
 *   • the V1 `event` hook (`{ event: { type, properties } }`) → the V2
 *     `ctx.event.subscribe()` async iterable
 *
 * The adapter is deliberately defensive: every call is feature-detected and
 * every event payload is normalized across all three encodings the stream
 * may use (`properties`, `data`, or flattened). A capability that is absent
 * on a given build degrades to a no-op instead of throwing, because a throw
 * inside the event loop would silently disable every recovery path.
 */

/** Best-effort read of an event payload under any of the encodings the V2
 *  stream has used. Newer cores nest under `properties`, some under `data`,
 *  and the event-sourced union flattens the schema onto the event itself. */
const v2EventPayload = (ev) => {
  if (!ev || typeof ev !== "object") return null
  if (ev.properties && typeof ev.properties === "object") return ev.properties
  if (ev.data && typeof ev.data === "object" && !Array.isArray(ev.data)) return ev.data
  return ev
}

/** V2 `Session.StructuredError` ({ type, message, status }) → the V1 error
 *  envelope ({ name, data:{ statusCode, message } }) the classifier reads.
 *  Already-V1 errors pass through untouched. */
const v2ErrorToV1 = (err) => {
  if (!err || typeof err !== "object") return err
  if (err.name || err.data) return err
  const message = err.message ?? ""
  return {
    name: err.type ?? err.name ?? "UnknownError",
    message,
    data: {
      message,
      statusCode: err.status ?? err.statusCode ?? err.data?.statusCode,
      responseBody: err.response?.body ?? err.data?.responseBody,
    },
  }
}

/** Map a V2 message onto the V1 `{ info, parts }` envelope the engine reads.
 *
 *  V2 replaced V1's `role` + separate `parts` with a single discriminated union:
 *  the message carries `type` ("user" | "assistant" | "synthetic" | "system" |
 *  "compaction" | "skill" | "shell") and — for assistant turns — a typed
 *  `content[]` array holding text / reasoning / tool blocks. The engine keys
 *  almost everything off `info.role`, so the discriminator has to be translated
 *  back, and V2 "synthetic"/"skill" turns must still read as user-role input
 *  because that is exactly what the plugin itself injects. */
const v2MessageInfo = (msg, sessionID) => {
  if (!msg || typeof msg !== "object") return null
  if (msg.info) return msg // already in the { info, parts } shape
  const model = msg.model ?? null
  const kind = msg.type ?? msg.role ?? ""
  const role =
    kind === "assistant" ? "assistant"
      : kind === "user" || kind === "synthetic" || kind === "skill" ? "user"
        : kind || undefined
  const info = {
    id: msg.id,
    sessionID: msg.sessionID ?? sessionID,
    role,
    providerID: model?.providerID ?? msg.providerID,
    modelID: model?.id ?? model?.modelID ?? msg.modelID,
    model,
    agent: msg.agent,
    error: v2ErrorToV1(msg.error),
    finish: msg.finish ?? msg.rawFinish,
    rawFinish: msg.rawFinish ?? msg.finish,
    // V2 records how many times the core already retried this turn, and why.
    // The provider's own retry counter is a far better signal than inferring
    // "it has been failing" from repeated identical errors.
    retry: msg.retry,
    cost: msg.cost,
    tokens: msg.tokens,
    time: msg.time,
  }
  let parts = []
  if (Array.isArray(msg.parts)) {
    parts = msg.parts
  } else if (Array.isArray(msg.content)) {
    // V2 folded parts into a typed `content` array on the message.
    parts = msg.content.map((c) => {
      if (c?.type === "tool") {
        const st = c.state ?? {}
        return {
          type: "tool",
          callID: c.id,
          tool: c.name,
          state: {
            // V2 renamed the streaming state; the engine only knows the V1
            // running/completed/error triple.
            status: st.status === "streaming" ? "running" : st.status,
            input: st.input,
            output: st.output,
            error: v2ErrorToV1(st.error),
            title: st.title ?? c.name,
          },
        }
      }
      if (c?.type === "text") return { type: "text", text: c.text ?? "" }
      if (c?.type === "reasoning") return { type: "reasoning", text: c.text ?? "" }
      return c
    })
  }
  if (parts.length === 0) {
    // V2 stores user/synthetic/system text directly on the message: `text` is
    // a string on synthetic and a { text, files, agents, skills } object on user
    // turns. The engine reads prompt text off the parts, and uses it to spot
    // its OWN "[auto-resume]" injections so they don't look like a new task.
    const raw = msg.text
    const text = typeof raw === "string" ? raw : raw?.text
    if (typeof text === "string" && text.length > 0) parts = [{ type: "text", text }]
  }
  return { info, parts }
}

/** V2 `Permission.Request` uses `action` + `resources`; the engine's autopilot
 *  reads a `permission`/`type` name plus `title`/`metadata`. Bridge the two so
 *  the existing decision logic (and its deny-list fingerprint) keeps working. */
const v2PermissionToV1 = (payload) => {
  const p = v2EventPayload(payload) ?? {}
  const resources = Array.isArray(p.resources) ? p.resources : []
  const action = String(p.action ?? p.permission ?? p.type ?? "").toLowerCase()
  const meta = {
    ...(p.metadata && typeof p.metadata === "object" ? p.metadata : {}),
    resources,
    // The deny-list fingerprint and the dangerous-pattern scan both read the
    // command/path out of metadata, so surface each resource under the field
    // names the V1 engine already looks for.
    command: p.metadata?.command ?? resources[0],
    pattern: p.metadata?.pattern ?? resources[0],
    patterns: p.metadata?.patterns ?? resources,
    path: p.metadata?.path ?? resources[0],
  }
  return {
    ...p,
    id: p.id,
    sessionID: p.sessionID,
    permission: action,
    type: action,
    title: p.title ?? p.message ?? [action, ...resources].filter(Boolean).join(" "),
    metadata: meta,
  }
}

/** Build the V1-shaped `client` the engine expects out of a V2 plugin context.
 *
 *  Method mapping (V1 → V2):
 *    session.list()          → ctx.session.list()
 *    session.get()           → ctx.session.get({ sessionID })
 *    session.update()        → ctx.session.update({ sessionID, title })
 *    session.status()        → ctx.session.status() ?? session.status event cache
 *    session.messages()      → ctx.session.message.list() / ctx.session.context()
 *    session.message()       → ctx.session.message.get() / context lookup
 *    session.prompt()        → ctx.session.prompt({ sessionID, text })
 *    session.abort()         → ctx.session.interrupt({ sessionID, continue:false })
 *    session.summarize()     → ctx.session.compact({ sessionID })
 *    permission reply        → ctx.permission.reply() / ctx.session.permission.reply()
 *    config.providers()      → ctx.provider.list()
 *    app.log()               → ctx.app.log() ?? console
 *
 *  `session.status()` has no direct V2 equivalent in the plugin context, so it
 *  is served from a cache fed by the `session.status` / `session.idle` /
 *  `session.busy` events. That is the same information the V1 endpoint
 *  returned, and it keeps the engine's "don't inject into a live turn" guard
 *  working. */
const buildV2Client = (ctx, hooks) => {
  const sid = (v) => (typeof v === "string" ? v : v?.id ?? v?.sessionID ?? v?.path?.id)
  const unwrap = (res) => (res && typeof res === "object" && "data" in res ? res.data : res)

  // Statuses observed on the event stream, newest write wins.
  //
  // Bounded: keyed by session, never pruned otherwise, so a long-lived server
  // would keep one entry per session it had ever seen. Re-inserting before the
  // size check keeps Map's insertion order in recency order, so evicting the
  // first key drops the least recently seen session rather than an arbitrary
  // one. The sweep reads the newest few, so evicted entries are idle sessions
  // that no longer matter.
  const statusBySession = new Map()
  const STATUS_MAX = 64
  const setStatus = (sessionID, type) => {
    if (!sessionID || !type) return
    statusBySession.delete(sessionID)
    statusBySession.set(sessionID, type)
    while (statusBySession.size > STATUS_MAX) {
      const oldest = statusBySession.keys().next().value
      if (oldest === undefined) break
      statusBySession.delete(oldest)
    }
  }

  /* OpenCode 2 publishes a far richer "why is this session still going" signal
   * than V1 ever did. While a turn is waiting on a provider it emits
   *   session.status = { type:"retry", attempt, message,
   *                      action:{ reason, provider, title, message, label, link },
   *                      next }
   * `action.reason` / `action.provider` / `action.title` / `action.message` /
   * `action.link` are authored by the provider, and `next` is the moment the
   * core will try again. That is precisely the information a resume prompt
   * should carry: "rate limited, wait 40s" beats a generic "a provider turn
   * failed". Capture the latest per session and fold it into the error the
   * engine classifies, so the prompt builder can quote it. V1 cores have no
   * equivalent, so this is a no-op there. */
  const retryStatusBySession = new Map()
  // Bounded: one entry per session that ever entered a provider retry, for the
  // life of the process. A long-running server would accumulate these without
  // limit. Evict the oldest once over capacity — the hint is only read moments
  // after the error it accompanies, so evicting stale entries is harmless.
  const RETRY_STATUS_MAX = 64
  const rememberRetryStatus = (sessionID, status) => {
    if (!sessionID || !status || status.type !== "retry") return
    retryStatusBySession.delete(sessionID)
    retryStatusBySession.set(sessionID, status)
    while (retryStatusBySession.size > RETRY_STATUS_MAX) {
      const oldest = retryStatusBySession.keys().next().value
      if (oldest === undefined) break
      retryStatusBySession.delete(oldest)
    }
  }
  const retryHint = (sessionID) => {
    const st = retryStatusBySession.get(sessionID)
    if (!st) return null
    const action = st.action ?? {}
    return {
      attempt: typeof st.attempt === "number" ? st.attempt : undefined,
      next: typeof st.next === "number" ? st.next : undefined,
      reason: action.reason ?? st.message,
      provider: action.provider,
      title: action.title,
      detail: action.message,
      label: action.label,
      link: action.link,
    }
  }

  // Track assistant-message state so `session.message()` can answer for a
  // single message without a dedicated round trip.
  //
  // Bounded: one entry per message ever seen, so without a cap this grows with
  // total conversation volume for the life of the process. Eviction is safe by
  // construction — the reader falls back to a live fetch and then to a full
  // message list, so a miss only ever costs a round trip that was always
  // possible. Re-inserting before the size check keeps Map's insertion order in
  // recency order, so the active session's newest messages are what survive.
  const messageCache = new Map() // "sessionID|messageID" -> { info, parts }
  const MESSAGE_CACHE_MAX = 512

  const remember = (msg, sessionID) => {
    const shaped = v2MessageInfo(msg, sessionID)
    if (shaped?.info?.id) {
      const key = `${shaped.info.sessionID}|${shaped.info.id}`
      messageCache.delete(key)
      messageCache.set(key, shaped)
      while (messageCache.size > MESSAGE_CACHE_MAX) {
        const oldest = messageCache.keys().next().value
        if (oldest === undefined) break
        messageCache.delete(oldest)
      }
    }
    return shaped
  }

  /** Session ids this plugin recorded as active, newest first.
   *
   *  OpenCode 2's plugin context exposes no session-list endpoint (its session
   *  domain is create/get/remove/switchAgent/switchModel/prompt/generate/
   *  command/compact/synthetic/interrupt/update/move/wait/context). Restart
   *  reanimation therefore cannot enumerate sessions the way V1's
   *  `session.list()` allowed.
   *
   *  It does not need to: reanimation only revives sessions that were alive
   *  when the last server died, and the plugin already persists exactly that
   *  set to <plugin>.active.json on every observed event. Reading it back gives
   *  a candidate list that is strictly *narrower* than the old full listing,
   *  and the engine still cross-checks each candidate's current state (title,
   *  last message, suppressed markers) before reviving. Candidates are confirmed
   *  to still exist with `session.get()`, so stale ids from an older install are
   *  dropped rather than revived as phantoms. */
  const persistedActiveSessionIDs = async (limit = 50) => {
    const path = process.env.OPENCODE_RESUME_ACTIVESTORE ||
      (MODULE_SELF_PATH ? `${MODULE_SELF_PATH}.active.json` : "")
    if (!path) return []
    try {
      const { readFile } = await import("node:fs/promises")
      const raw = JSON.parse(await readFile(path, "utf8"))
      if (!raw || typeof raw !== "object") return []
      return Object.entries(raw)
        .filter(([id, ts]) => typeof id === "string" && id.length <= 256 && typeof ts === "number")
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id]) => id)
    } catch {
      return []
    }
  }

  /** Session list for the engine's reanimation scan.
   *  Prefers a real listing when the build provides one, otherwise reconstructs
   *  it from the persisted active-session store (see above). */
  const listSessions = async () => {
    if (typeof ctx.session?.list === "function") {
      try {
        const res = unwrap(await ctx.session.list({}))
        if (Array.isArray(res)) return res
      } catch { /* fall back to the persisted candidate set */ }
    }
    const ids = await persistedActiveSessionIDs()
    const out = []
    for (const id of ids) {
      if (typeof ctx.session?.get !== "function") break
      try {
        const info = unwrap(await ctx.session.get({ sessionID: id }))
        // V2 wraps the payload as { data }; unwrap already peeled that, but a
        // build that returns the envelope directly still resolves here.
        const session = info?.data && typeof info.data === "object" ? info.data : info
        if (session && typeof session === "object") out.push(session)
      } catch { /* the session is gone (deleted/expired) — skip it */ }
    }
    return out
  }

  const fetchMessages = async (sessionID) => {
    const list = ctx.session?.message?.list ?? ctx.session?.messages ?? ctx.session?.context
    if (typeof list !== "function") return []
    // ctx.session.context is a plain GET keyed only by sessionID; passing extra
    // keys is harmless on some builds and rejected on others, so try the
    // documented shape first and only then the richer paginated one.
    let res
    try {
      res = await list.call(ctx.session, { sessionID })
    } catch {
      try {
        res = await list.call(ctx.session, { sessionID, limit: 200 })
      } catch {
        return []
      }
    }
    const data = unwrap(res)
    const arr = Array.isArray(data)
      ? data
      : Array.isArray(data?.messages)
        ? data.messages
        : Array.isArray(data?.data)
          ? data.data
          : []
    return arr.map((m) => remember(m, sessionID)).filter(Boolean)
  }

  const facade = {
    app: {
      // V2 has no app.log endpoint on the plugin context; fall back to the
      // server console so notices/logs are still observable.
      log: async ({ body } = {}) => {
        const line = `[${body?.service ?? "auto-resume"}] ${body?.level ?? "info"}: ${body?.message ?? ""}`
        const extra = body?.extra
        try {
          if (typeof ctx.app?.log === "function") {
            await ctx.app.log({ body: { service: body?.service ?? "auto-resume", level: body?.level ?? "info", message: body?.message ?? "", extra } })
            return true
          }
        } catch { /* fall through to console */ }
        if (extra === undefined) console.log(line)
        else console.log(line, extra)
        return true
      },
    },
    session: {
      list: async () => listSessions(),
      get: async (input) => unwrap(await ctx.session.get({ sessionID: sid(input) })),
      update: async (input) => {
        const title = input?.body?.title
        if (title == null) return true
        await ctx.session.update({ sessionID: sid(input), title })
        return true
      },
      status: async () => {
        // Prefer a live call if this build exposes one; otherwise fall back to
        // the event-derived cache.
        if (typeof ctx.session.status === "function") {
          try {
            return unwrap(await ctx.session.status())
          } catch { /* fall through */ }
        }
        const out = {}
        for (const [id, type] of statusBySession) out[id] = { type }
        return out
      },
      messages: async (input) => fetchMessages(sid(input)),
      message: async (input) => {
        const sessionID = input?.path?.id ?? input?.sessionID
        const messageID = input?.path?.messageID ?? input?.messageID
        const get = ctx.session?.message?.get
        if (typeof get === "function" && messageID) {
          try {
            const res = unwrap(await get.call(ctx.session.message, { sessionID, messageID }))
            if (res) return { data: res }
          } catch { /* fall through to cache */ }
        }
        const cached = messageCache.get(`${sessionID}|${messageID}`)
        if (cached) return { data: cached }
        const all = await fetchMessages(sessionID)
        const hit = all.find((m) => m?.info?.id === messageID)
        return { data: hit ?? { parts: [] } }
      },
      prompt: async (input) => {
        const sessionID = sid(input)
        const parts = input?.body?.parts ?? []
        const text = parts.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n").trim()
        if (!text) return { data: {} }
        const model = input?.body?.model
        const payload = { sessionID, text }
        if (model?.providerID && (model?.modelID ?? model?.id)) {
          payload.model = { providerID: model.providerID, id: model.modelID ?? model.id }
        }
        // V2 prompt admission is asynchronous: it returns the admitted inbox
        // item instead of blocking until the reply completes.
        return unwrap(await ctx.session.prompt(payload))
      },
      abort: async (input) => {
        // The V2 route is queried as `?resume=`; the published docs spell the
        // flag `continue`, so send both and let each build read the one it
        // knows. resume:false means "stop the current turn", which is what a
        // stall takeover wants before it schedules its own continuation.
        await ctx.session.interrupt({ sessionID: sid(input), resume: false, continue: false })
        return true
      },
      summarize: async (input) => {
        const sessionID = sid(input)
        const body = input?.body
        const model = body?.providerID ? { providerID: body.providerID, id: body.modelID ?? body.modelID } : undefined
        await ctx.session.compact(model ? { sessionID, model } : { sessionID })
        return true
      },
      // Exposed under a /permission/i key so the engine's candidate scan finds
      // it; it calls with the V1 `{ path, body }` envelope.
      respondToPermission: async (input) => {
        const sessionID = input?.path?.id ?? input?.sessionID
        const requestID = input?.path?.permissionID ?? input?.permissionID
        const reply = input?.body?.response ?? input?.reply ?? input?.decision
        if (!sessionID || !requestID || !reply) return false
        const arg = { sessionID, requestID, reply }
        if (typeof ctx.permission?.reply === "function") {
          return unwrap(await ctx.permission.reply(arg))
        }
        if (typeof ctx.session?.permission?.reply === "function") {
          return unwrap(await ctx.session.permission.reply(arg))
        }
        return false
      },
    },
    config: {
      providers: async () => {
        const list = ctx.provider?.list
        if (typeof list !== "function") return { providers: [] }
        const data = unwrap(await list.call(ctx.provider))
        const arr = Array.isArray(data) ? data : Array.isArray(data?.providers) ? data.providers : []
        return {
          providers: arr.map((p) => ({
            id: p?.id ?? p?.providerID,
            models: p?.models ?? {},
          })),
        }
      },
    },
  }
  // Expose the same reply helper at the client root (the engine probes both).
  facade.postSessionIdPermissionsPermissionId = facade.session.respondToPermission

  return { client: facade, setStatus, remember, rememberRetryStatus, retryHint, messageCache, statusBySession }
}

/** Event families the engine has no handling for. A prefix list, so new
 *  members of an existing family are covered automatically. Anything not
 *  listed still reaches the engine, so a future event is never silently
 *  dropped. */
const V2_NOISE_EVENTS = [
  "skill.", "plugin.", "provider.", "model.", "integration.", "mcp.",
  "reference.", "command.", "agent.", "worktree.", "websearch.",
  "project.", "lsp.", "pty.", "shell.", "rpc.", "session.usage.",
  "session.instructions.", "session.inbox.", "session.tool.input.",
  "server.info", "server.pair",
]

let adapterInitLock = false

export default {
  id: "auto-resume",
  setup: async (ctx) => {
    if (adapterInitLock) {
      // Prevent double adapter load when OpenCode reloads or duplicates hooks.
      return
    }
    adapterInitLock = true
    const hooksForClient = {}
    const { client, setStatus, remember, rememberRetryStatus, retryHint, statusBySession } = buildV2Client(ctx, hooksForClient)

    // Instantiate the V1 engine against the bridged client.
    const engine = await createEngine({ client })
    const handle = engine?.event
    if (typeof handle !== "function") {
      throw new Error("auto-resume: engine did not return an event handler")
    }

    const controller = new AbortController()
    // Serialize event delivery: the engine mutates shared per-session state and
    // awaits async client calls, so events must be processed in order — but
    // never block the stream reader (the V2 event stream fails on a slow
    // consumer). Chain instead of awaiting in the loop.
    let chain = Promise.resolve()

    /* Whether the native V2 permission hook is the live decision point.
     *
     * `permission.asked` does not appear on the V2 stream, so today only one of
     * the two routes can ever answer a request. But if a future core emits it
     * again, both would run and the request would be answered twice. Once the
     * hook has actually registered it owns permissions outright and the event
     * route is skipped. Deliberately flipped only on success: if registration
     * fails, the event route stays live so the autopilot still works. Declared
     * here (not beside the hook) because the event pump starts before the hook
     * is registered, and reading it must not hit the temporal dead zone. */
    let permissionHookBound = false

    // The hook's teardown handle, once registration resolves.
    let hookDisposer = null

    // Set by teardown. Registration resolves asynchronously, so dispose() can
    // run first; without this the late `.then` would store a disposer nobody
    // will ever call and leave the hook registered on the context forever.
    let disposed = false

    /* ── V2 event vocabulary → the engine's legacy event vocabulary ──────────
     *
     * This is the single most important part of the V2 port. OpenCode 2 does
     * NOT emit the V1 event names. Instrumenting a live 2.0.30 desktop server
     * and capturing its full stream shows a completely different vocabulary:
     *
     *   session.step.started / .streamed / .ended      (per model step)
     *   session.text.started / .delta / .ended
     *   session.reasoning.started / .delta / .ended
     *   session.tool.input.started / .ended, .called / .progress / .success
     *   session.retry.scheduled
     *   session.permissions        (a RULESET update, not a request)
     *   session.usage.updated, session.instructions.updated
     *   shell.created / .exited / .deleted
     *   skill.updated, plugin.updated, provider.updated, model.updated, ...
     *   server.connected
     *
     * and NOT ONE of session.error / session.idle / session.status /
     * message.updated / message.part.updated / permission.asked / todo.updated.
     *
     * Each native event is therefore translated into the legacy event the
     * engine already understands, so none of the recovery logic below has to
     * change. Envelope: { id, created, type, durable, location, data }.
     */
    const synth = (type, properties) => {
      // Single choke point for every event into the engine — the live stream, the
      // startup reanimation and the fallback sweep all funnel through here.
      // After teardown the plugin must be inert: an in-flight sweep iteration or
      // an already-queued event would otherwise still reach the engine and
      // inject a resume into a session the plugin no longer manages.
      if (disposed) return
      chain = chain.then(() => handle({ event: { type, properties } })).catch((err) => {
        console.error(`${RESUME_TAG} event handler error:`, err?.message ?? err)
      })
    }

    // Turn-end confirmation. A step ending with finish "tool-calls" means the
    // agent is about to run another step, not that the turn is over. When the
    // finish reason is anything else the turn is effectively done — but we
    // still confirm: if a new step starts inside the grace window the queued
    // idle is cancelled, so an evaluateIdle never fires mid-turn.
    const IDLE_CONFIRM_MS = 1_200
    const idleArmed = new Map() // sessionID -> timer
    const armIdle = (sessionID) => {
      if (!sessionID) return
      if (idleArmed.has(sessionID)) clearTimeout(idleArmed.get(sessionID))
      const t = setTimeout(() => {
        idleArmed.delete(sessionID)
        setStatus(sessionID, "idle")
        synth("session.idle", { sessionID })
      }, IDLE_CONFIRM_MS)
      t.unref?.()
      idleArmed.set(sessionID, t)
    }
    const cancelIdle = (sessionID) => {
      const t = idleArmed.get(sessionID)
      if (t) { clearTimeout(t); idleArmed.delete(sessionID) }
    }

    // Tool-failure tracking, so the engine's debug nudge still works. V2 splits
    // a tool call across several events; only the terminal ones matter here.
    // The status is handed straight to the engine as a message.part.updated —
    // no per-call state is retained here, so this path allocates nothing.

    const dispatch = (ev) => {
      const type = ev?.type
      if (typeof type !== "string") return
      /* Drop event families the engine cannot act on before doing any work.
       *
       * A live 2.0.30 server emitted 2064 skill.updated events in a ~30s
       * window against 418 events of everything else combined. Each was
       * being normalised and pushed onto the serialised handler chain only
       * for the engine switch to ignore it, making this the hottest path in
       * the plugin for no benefit.
       *
       * Denylist rather than allowlist on purpose: an event family the
       * engine learns to handle later still reaches it. */
      if (V2_NOISE_EVENTS.some((p) => type === p || type.startsWith(p))) return
      const payload = v2EventPayload(ev) ?? {}
      let properties = payload
      const sessionID = payload.sessionID ?? payload.durable?.aggregateID ?? null
      if (sessionID) rememberLastSeen(sessionID, Date.now())

      /* ── native V2 vocabulary ─────────────────────────────────────────── */
      // session.step.failed carries the provider error and is handled in the
      // failure block below; it must not fall into the ordinary step branch.
      if (type.startsWith("session.step.") && type !== "session.step.failed") {
        if (!sessionID) return
        cancelIdle(sessionID)
        if (type === "session.step.started") {
          setStatus(sessionID, "busy")
          // A new step opens a new turn: mirrors the legacy `session.status`
          // busy transition the engine uses to reset per-turn flags.
          synth("session.status", { sessionID, status: { type: "busy" } })
        } else if (type === "session.step.streamed") {
          synth("session.status", { sessionID, status: { type: "busy" } })
        } else if (type === "session.step.ended") {
          // Deliberately NOT a busy transition. The engine clears the
          // "this turn delivered content" flag on busy, so marking a *finished*
          // step busy would erase the text/reasoning/tool output that just
          // arrived and make the turn look empty -- which silently skips idle
          // evaluation, and with it every recovery, todo-drive and improvement
          // path. An ended step is the opposite of busy.
          const finish = String(payload.finish ?? payload.rawFinish ?? "").toLowerCase().trim()
          const recentFailure = (lastErrorSynthAt.get(sessionID) ?? 0) > Date.now() - 3000
          // Guard against malformed/missing finish values.
          const isRealEnd = finish && finish !== "" && !(finish === "busy" || (String(payload.rawFinish ?? "").includes("busy") && !finish.includes("stop")))
          if (finish === "tool-calls") {
            // Another step follows: NOT a turn end.
          } else if (isRealEnd && !recentFailure) {
            armIdle(sessionID)
          }
        }
        return
      }

      if (type.startsWith("session.text.")) {
        if (!sessionID) return
        cancelIdle(sessionID)
        if (type !== "session.text.started") {
          // Text is content: this is what makes a turn count as "delivered".
          synth("message.part.updated", {
            part: { type: "text", sessionID, text: payload.text ?? payload.delta ?? "" },
          })
        }
        return
      }

      if (type.startsWith("session.reasoning.")) {
        if (!sessionID) return
        cancelIdle(sessionID)
        synth("message.part.updated", {
          part: { type: "reasoning", sessionID, text: payload.text ?? payload.delta ?? "" },
        })
        return
      }

      /* ── failure events (the ones that actually carry a provider error) ──
       *
       * A rejected request — "Provider request failed with HTTP 403", 429, 5xx,
       * a network drop — arrives as session.step.failed carrying a structured
       * error. This mapping was absent, so every provider failure looked
       * identical to a silent stall: nothing was detected, and the think-stall
       * watchdog fired ~60s later with a misleading "busy with no output"
       * message instead of the actual cause. */
      if (type === "session.step.failed" || type === "session.execution.failed") {
        if (!sessionID) return
        cancelIdle(sessionID)
        const raw = payload.error ?? {
          type: "ProviderError",
          message: payload.rawFinish ?? payload.message ?? "provider request failed",
          status: payload.status,
        }
        const normalized = v2ErrorToV1(raw)
        const hint = retryHint(sessionID)
        if (normalized && typeof normalized === "object") {
          normalized.data = {
            ...(normalized.data ?? {}),
            statusCode: normalized.data?.statusCode ?? raw.status ?? raw.statusCode,
            retryAttempt: payload.attempt ?? raw.attempt ?? hint?.attempt,
            retryNext: hint?.next,
            retryReason: hint?.reason ?? payload.rawFinish,
            retryProvider: raw.provider ?? hint?.provider,
          }
        }
        // A content-filter stop is not a provider failure to retry: the engine
        // has a dedicated reframe path for it in idle evaluation. Let the turn
        // end and let that run instead of injecting a generic error resume.
        const filtered = payload.finish === "content-filter" ||
          normalized?.name === "ContentFilterError"
        // A failed step is definitively over: the turn cannot continue, so mark
        // the session idle immediately. Without this the engine's injection guard
        // still sees "busy" and defers the recovery prompt by a full poll
        // interval, which reads to the user as the plugin not reacting.
        setStatus(sessionID, "idle")
        const synthLockKey = sessionID
        if (!filtered && !sessionErrorSynthLock.has(synthLockKey)) {
          sessionErrorSynthLock.add(synthLockKey)
          synth("session.error", { sessionID, error: normalized })
          lastErrorSynthAt.set(sessionID, Date.now())
        }
        // Clear synthesis lock after recovery injects so a future error
        // (e.g., retry after rotation) is not permanently suppressed.
        const clearTimer = setTimeout(() => sessionErrorSynthLock.delete(synthLockKey), 30000)
        clearTimer.unref?.()
        // The turn is over either way, so evaluate idle state once.
        armIdle(sessionID)
        return
      }

      /* An execution interrupt is NOT surfaced as an error on purpose. It fires
       * for both a user Stop and our own takeover, and the engine already
       * distinguishes them from the stored assistant message (isAbortError ->
       * markUserStopped). Synthesising an error here would let a genuine user
       * Stop be "recovered" from, which is exactly the behaviour the plugin
       * promises never to do. Just let the turn end. */
      if (type === "session.execution.interrupted") {
        // FIX: tool-execution interrupted must reach the engine (message.part.updated
        // with interrupted error) so evaluation doesn't miss a stopped tool.
        if (!sessionID) return
        cancelIdle(sessionID)
        // Tool execution interrupted needs to reach the engine so it can
        // count the failure / stop correctly, not just sit idle silently.
        synth("message.part.updated", {
          part: {
            type: "tool",
            sessionID,
            tool: payload.tool ?? payload.name ?? "unknown",
            callID: payload.id ?? payload.callID ?? "",
            state: {
              status: "error",
              input: payload.input ?? payload.text,
              error: { name: "ExecutionInterrupted", message: "Tool execution interrupted" },
            },
          },
        })
        armIdle(sessionID)
        return
      }

      /* A compaction that failed leaves the turn unfinished. Surface it so the
       * overflow path can act rather than sitting on a half-summarised context. */
      if (type === "session.compaction.failed") {
        if (!sessionID) return
        synth("session.error", {
          sessionID,
          error: v2ErrorToV1(payload.error ?? {
            type: "CompactionError",
            message: payload.message ?? "compaction failed",
            status: payload.status,
          }),
        })
        return
      }

      if (type === "session.deleted") {
        if (!sessionID) return
        // Performance: purge dead message cache for deleted session so
        // long-lived servers don't retain useless entries.
        for (const key of messageCache.keys()) {
          if (key.startsWith(`${sessionID}|`)) messageCache.delete(key)
        }
        synth("session.deleted", { sessionID })
        return
      }

      if (type.startsWith("session.tool.")) {
        if (!sessionID) return
        cancelIdle(sessionID)
        const callID = payload.id ?? payload.callID ?? ""
        const metaStatus = payload.metadata?.status ?? payload.state?.status
        let status = null
        if (type === "session.tool.input.started" || type === "session.tool.input.ended") {
          status = "running"
        } else if (type === "session.tool.called") {
          status = "running"
        } else if (type === "session.tool.progress") {
          status = "running"
        } else if (type === "session.tool.success") {
          status = metaStatus === "error" ? "error" : "completed"
        } else if (type === "session.tool.failed" || type === "session.tool.error" || type === "session.tool.failure") {
          status = "error"
        }
        if (!status) return
        // The engine counts tool errors off part updates; replay them through the
        // legacy part shape so the debug-nudge heuristic keeps working.
        synth("message.part.updated", {
          part: {
            type: "tool",
            sessionID,
            tool: payload.name ?? payload.tool ?? "",
            callID,
            state: {
              status,
              input: payload.input ?? payload.text,
              error: status === "error" ? (payload.error ?? { name: "UnknownError", data: { message: payload.metadata?.status ?? "tool failed" } }) : undefined,
            },
          },
        })
        return
      }

      if (type === "session.retry.scheduled") {
        // V2's only failure-ish signal: the core is about to retry the request.
        if (!sessionID) return
        const attempt = payload.attempt ?? payload.count ?? 1
        const next = payload.next ?? payload.at ?? payload.at ?? undefined
        const reason = payload.reason ?? payload.message ?? payload.detail
        const provider = payload.provider ?? payload.providerID
        rememberRetryStatus(sessionID, {
          type: "retry",
          attempt,
          next,
          message: reason,
          action: { reason, provider, title: payload.title, message: payload.detail, link: payload.link },
        })
        setStatus(sessionID, "retry")
        synth("session.status", {
          sessionID,
          status: { type: "retry", attempt, next, message: reason, action: { reason, provider, title: payload.title } },
        })
        // Retry schedules are normal recovery, not new failures — the original
        // error arrived via session.step.failed (or the sweep catches misses).
        // BUT if the core never emits step.failed, a retry that carries an error
        // payload must still reach the engine once — deduped so it never loops.
        const retryErrKey = `${sessionID}|retry:${attempt}`
        const recentErr = (lastErrorSynthAt.get(sessionID) ?? 0) > Date.now() - 5000
        if (payload.error && !retryErrorSent.has(retryErrKey) && !recentErr && !sessionErrorSynthLock.has(sessionID)) {
          retryErrorSent.add(retryErrKey)
          if (retryErrorSent.size > RETRY_ERROR_MAX) {
            const oldest = retryErrorSent.values().next().value
            if (oldest !== undefined) retryErrorSent.delete(oldest)
          }
          sessionErrorSynthLock.add(sessionID)
          lastErrorSynthAt.set(sessionID, Date.now())
          const rawErr = payload.error
          const normalized = v2ErrorToV1(rawErr)
          const hint = retryHint(sessionID)
          if (normalized && typeof normalized === "object") {
            normalized.data = {
              ...(normalized.data ?? {}),
              retryAttempt: attempt,
              retryNext: next,
              retryReason: reason?.reason ?? reason?.title ?? payload.title,
              retryProvider: provider ?? hint?.provider,
            }
          }
          synth("session.error", { sessionID, error: normalized })
        }
        return
      }

      if (type === "session.permissions") {
        // A ruleset update (action/resource/effect), NOT a pending request.
        // The autopilot binds to ctx.permission.hook("evaluate") instead, which
        // is race-free and needs no event at all.
        return
      }

      if (type === "session.usage.updated" || type === "session.instructions.updated") {
        return
      }

      /* ── legacy vocabulary (still emitted by some builds; keep working) ── */
      if (type === "session.status" && payload.sessionID) {
        setStatus(payload.sessionID, payload.status?.type ?? "unknown")
        rememberRetryStatus(payload.sessionID, payload.status)
      } else if (type === "session.idle" && payload.sessionID) {
        setStatus(payload.sessionID, "idle")
      } else if (type === "message.updated" && payload.sessionID && payload.info) {
        const shaped = remember(payload.info, payload.sessionID)
        if (payload.info?.role === "assistant" || payload.info?.role === "user") {
          setStatus(payload.sessionID, "busy")
        }
        if (shaped) properties = { ...payload, info: shaped.info, parts: shaped.parts }
      } else if (type === "message.part.updated" && payload.part) {
        // V2 parts travel on the event payload; the session id lives beside the
        // part rather than inside it. The engine reads `part.sessionID`, so
        // re-attach it. Do NOT round-trip through the message adapter here — a
        // bare part is not a message and would be mangled.
        const part = { ...payload.part, sessionID: payload.part.sessionID ?? payload.sessionID }
        properties = { ...payload, part }
      }

      if (type === "session.error") {
        const normalized = v2ErrorToV1(payload.error)
        // Fold in V2's own account of the failure so the resume prompt can quote
        // the provider's reason instead of guessing from the message text.
        const hint = retryHint(payload.sessionID)
        const attempts = payload.error?.retry?.attempt ?? payload.info?.retry?.attempt ?? hint?.attempt
        if (normalized && typeof normalized === "object" && (hint || attempts)) {
          normalized.data = {
            ...(normalized.data ?? {}),
            retryAttempt: attempts,
            retryNext: hint?.next,
            retryReason: hint?.reason ?? hint?.title ?? hint?.detail,
            retryProvider: hint?.provider,
          }
        }
        properties = { ...payload, error: normalized }
      } else if (type === "permission.asked" || type === "permission.updated") {
        // Once the native hook is live it owns this decision; answering again
        // here would reply to the same request twice.
        if (permissionHookBound) return
        properties = v2PermissionToV1(payload)
      }

      synth(type, properties)
    }

    const pump = (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          dispatch(ev)
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error(`${RESUME_TAG} event stream error:`, err?.message ?? err)
        }
      }
    })()

    // Kick off crash reanimation immediately (mirrors the V1 boot behavior).
    void (async () => {
      try {
        await ctx.app?.version
      } catch { /* version is best-effort */ }
      await new Promise((r) => setTimeout(r, 0))
      // Fire a synthetic server.connected so the engine performs its startup
      // reanimation exactly as it did under V1.
      dispatch({ type: "server.connected", properties: {} })
    })()

    /* ── Permission autopilot via the native V2 hook ──────────────────────
     *
     * The event route is gone: `permission.asked` never appears on the V2
     * stream, so the old "watch for an ask, then reply" loop had nothing to
     * bind to. V2 exposes the decision point directly instead —
     * ctx.permission.hook("evaluate") runs after the configured rules resolve
     * and BEFORE the action executes or a prompt is published. Setting
     * `effect` there is race-free: no window exists in which the user sees a
     * prompt that the autopilot is about to answer, which was the old design's
     * main weakness.
     *
     * The decision logic itself is the engine's, reused verbatim via the
     * bridge it exposes, so safe-mode rules and the deny-list stay in one
     * place. V2 effects are allow | ask | deny; the engine answers with
     * once | always | reject, which maps as reject→deny and everything
     * approved→allow. */
    const evalPermission = engine.__evaluatePermission
    if (typeof evalPermission === "function" && typeof ctx.permission?.hook === "function") {
      ctx.permission.hook("evaluate", (event) => {
        try {
          const verdict = evalPermission(event.sessionID, {
            action: event.action,
            resources: event.resources,
            metadata: event.metadata,
            source: event.source,
          })
          if (!verdict) return // leave the human's rules untouched
          event.effect = verdict.effect
          if (verdict.message) event.message = verdict.message
        } catch (err) {
          console.error(`${RESUME_TAG} permission evaluate failed:`, err?.message ?? err)
        }
      }).then((disposeHook) => {
        if (disposed) {
          // Teardown already ran while this was in flight. Release the hook now,
          // or it stays bound to the context for the life of the server.
          if (typeof disposeHook === "function") {
            try { void disposeHook() } catch { /* teardown is best-effort */ }
          }
          return
        }
        permissionHookBound = true
        hookDisposer = typeof disposeHook === "function" ? disposeHook : null
      }).catch((err) => {
        // Registration failed: leave permissionHookBound false so the event
        // route stays live and the autopilot still works.
        console.error(`${RESUME_TAG} permission hook registration failed:`, err?.message ?? err)
      })
    }

    /* ── Fallback failure detection ───────────────────────────────────────
     *
     * `session.retry.scheduled` is V2's only push-based failure signal and it
     * does not fire for every failure mode (a turn that simply dies produces
     * no retry), and a transport hiccup can drop an event outright. So a slow
     * sweep also inspects engaged sessions directly and replays any error the
     * newest assistant turn carries back to the engine as a session.error.
     *
     * It deliberately does NOT act on a turn that is merely incomplete. A
     * missing `completed` timestamp is the same shape as a session that is
     * still thinking — a slow model, a long-running tool — so reacting to it
     * injects a resume into a live turn and duplicates its work. The think-stall
     * watchdog owns that case, with proper timing and a running-tool grace
     * window; this sweep only catches errors the event stream missed.
     *
     * Bounded on purpose — it only inspects sessions that look engaged (busy,
     * retrying, or quiet-but-not-idle), never more than a handful at a time,
     * and remembers the last message it acted on so the same dead turn is
     * never reported twice. */
    const sweepState = new Map() // sessionID -> last assistant message id handled
    const retryErrorSent = new Set() // dedupe retries that carry errors
    const RETRY_ERROR_MAX = 256
    const sessionErrorSynthLock = new Set() // only one error synthesis per session at a time
    const lastErrorSynthAt = new Map() // sessionID -> timestamp of last synthesized session.error
    const SWEEP_STATE_MAX = 64
    const SWEEP_MS = 15_000
    const SWEEP_MAX = 4
    const SWEEP_WINDOW_MS = 10 * 60_000
    // Last time we observed ANY event for a session, so the sweep can revisit
    // sessions that have since gone idle.
    //
    // Bounded: keyed by session, and the sweep only ever reads entries inside
    // SWEEP_WINDOW_MS, so an entry past that age is dead weight. Left unpruned it
    // would keep one entry per session touched since boot, for the life of the
    // process. Map preserves insertion order, so size alone is not a recency
    // signal here — prune on timestamp instead.
    const lastSeenBySession = new Map()
    const LAST_SEEN_MAX = 256
    const rememberLastSeen = (sessionID, at) => {
      lastSeenBySession.set(sessionID, at)
      if (lastSeenBySession.size <= LAST_SEEN_MAX) return
      const cutoff = at - SWEEP_WINDOW_MS
      for (const [id, seen] of lastSeenBySession) {
        if (lastSeenBySession.size <= LAST_SEEN_MAX) break
        if (seen <= cutoff) lastSeenBySession.delete(id)
      }
      // Everything is recent and we are still over cap: drop oldest-inserted
      // rather than grow without bound. Re-insert keeps recency ordering honest
      // for the next pass.
      while (lastSeenBySession.size > LAST_SEEN_MAX) {
        const oldest = lastSeenBySession.keys().next().value
        if (oldest === undefined) break
        lastSeenBySession.delete(oldest)
      }
    }
    const sweep = async () => {
      if (typeof client?.session?.context !== "function" && typeof ctx.session?.context !== "function") return
      const candidates = [...new Set([...statusBySession.keys(), ...lastSeenBySession.keys()])]
        // Not filtered by status: a session halted by a hard provider
        // rejection goes idle, so a busy/retry filter missed exactly the
        // failures this sweep exists to catch.
        .filter((id) => (lastSeenBySession.get(id) ?? 0) > Date.now() - SWEEP_WINDOW_MS)
        .sort((a, b) => (lastSeenBySession.get(b) ?? 0) - (lastSeenBySession.get(a) ?? 0))
        .slice(0, SWEEP_MAX)
      for (const [sessionID] of candidates) {
        try {
          const entries = await client.session.messages({ path: { id: sessionID } })
          const list = (entries?.data ?? entries) ?? []
          const last = list[list.length - 1]
          const info = last?.info
          if (!info || info.role !== "assistant") continue
          const msgID = info.id ?? ""
          if (!msgID || sweepState.get(sessionID) === msgID) continue
          sweepState.delete(sessionID)
          sweepState.set(sessionID, msgID)
          while (sweepState.size > SWEEP_STATE_MAX) {
            const oldest = sweepState.keys().next().value
            if (oldest === undefined) break
            sweepState.delete(oldest)
          }

          // Real errors only.
          //
          // This sweep used to ALSO fire on any assistant turn with no
          // `completed` timestamp. That shape is identical to a session that
          // is simply still thinking — a slow model, a long tool — so it
          // injected resumes into live turns and duplicated work. The
          // think-stall watchdog already owns "incomplete turn", with proper
          // timing and a running-tool grace window. Since session.step.failed
          // is mapped, this sweep only needs to catch errors the stream
          // missed.
          // Guard against event-duplication: sweep must not synthesize an error
          // the event pump (session.step.failed / retry.scheduled) already handled.
          if (info.error) {
            const synthLockKey = sessionID
            const recentErr = (lastErrorSynthAt.get(sessionID) ?? 0) > Date.now() - DUPLICATE_INCIDENT_WINDOW_MS
            if (!sessionErrorSynthLock.has(synthLockKey) && !recentErr) {
              sessionErrorSynthLock.add(synthLockKey)
              synth("session.error", { sessionID, error: v2ErrorToV1(info.error) })
              lastErrorSynthAt.set(sessionID, Date.now())
            }
          }
        } catch { /* session gone or unreadable */ }
      }
    }
    const sweepTimer = setInterval(() => { void sweep() }, SWEEP_MS)
    sweepTimer.unref?.()

    return () => {
      disposed = true
      controller.abort()
      clearInterval(sweepTimer)
      for (const t of idleArmed.values()) clearTimeout(t)
      idleArmed.clear()
      // Release the native permission hook. Without this it stays registered on
      // the context after teardown, so a re-initialised plugin would answer
      // permissions twice — once per live hook.
      if (hookDisposer) {
        try { void hookDisposer() } catch { /* teardown is best-effort */ }
        hookDisposer = null
      }
      permissionHookBound = false
      void pump
    }
  },
}

