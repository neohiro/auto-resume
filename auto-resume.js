/**
 * auto-resume.js — resilience + unattended-autonomy plugin for OpenCode.
 * Install machine-wide:  ~/.config/opencode/plugins/auto-resume.js
 * (Do NOT also keep a project-level copy: global + project copies would both
 *  load and double-fire every hook.)
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
 *  SUBSYSTEM 2 — MODEL ROTATION (no user input required)
 * ══════════════════════════════════════════════════════════════════
 * On free-tier/quota exhaustion or repeated rate limits of a model:
 *   • puts the exhausted model on a cooldown (default 60 min)
 *   • picks the best available alternative automatically:
 *       1. OPENCODE_RESUME_FALLBACK_MODELS preferred chain (env)
 *       2. sibling models from the same provider
 *       3. models from other installed providers
 *     Candidates are ranked by capability tier — Max/Ultra/Opus/Pro/High
 *     variants win whenever they exist; mini/nano/lite/flash variants lose.
 *     (non-chat models like embeddings/TTS/image are always filtered out)
 *   • continues the exact same session/conversation on the new model
 *   • ALSO rotates on persistent model-specific failures: repeated network
 *     errors / endpoint unavailability / 5xx waves on one model move the
 *     session to a different model (without cooldown-penalizing the old one,
 *     since outages are often provider-side and temporary)
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
 *     continue (spin-detection stops it if nothing progresses)
 *   • DEBUG NUDGE: 3 consecutive failed tool calls → tells the model to stop
 *     repeating the failing approach and diagnose the root cause first
 *   • AUTONOMY DIRECTIVE: every injected prompt instructs the model to make
 *     its own decisions, never wait for confirmation, document assumptions
 *   • AUTO-PROCEED: if the agent ends its turn by asking a question
 *     ("Should I proceed...?"), it answers itself and continues (capped)
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
 *  OPENCODE_RESUME_SWITCH_ON_QUOTA       rotate model on free-tier  (true)
 *  OPENCODE_RESUME_SWITCH_ON_RATELIMIT   rotate after N 429s        (true)
 *  OPENCODE_RESUME_SWITCH_ON_FAILURES    rotate after persistent
 *                                        network/5xx failures       (true)
 *  OPENCODE_RESUME_DISABLE_ROTATION      disable ALL model rotation (false)
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

const AUTO_RESUME_VERSION = "1.13.2"
const UPDATE_URL =
  "https://raw.githubusercontent.com/neohiro/auto-resume/main/auto-resume.js"

const DEFAULTS = {
  enabled: true,
  maxChain: 6,
  baseDelayMs: 5_000,
  maxDelayMs: 120_000,
  rateLimitBaseMs: 20_000,
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
  breakerThreshold: 6,
  breakerWindowMs: 900_000,
  breakerCooldownMs: 300_000,
  compactOnOverflow: true,
  noticeThrottleMs: 3_000,
  autoUpdate: true,
  maxTaskCostUsd: 10,
  switchOnQuota: true,
  switchOnRateLimit: true,
  switchOnFailures: true,
  disableRotation: false,
  rlSwitchAfter: 1,
  rotateAfterFailures: 3,
  maxRotations: 3,
  modelCooldownMs: 3_600_000,
  fallbackModels: "",
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
  budgetMs: 28_800_000,
}

const RESUME_TAG = "[auto-resume]"

const AUTONOMY_DIRECTIVE =
  " You are a senior engineer working unattended. Decide, don't ask. Document assumptions; pick sensible defaults." +
  " Done = production-grade, above user expectations: builds + tests + linters/type-checks green; edges + errors handled; security + perf considered; backward-compatible; no TODO/FIXME or dead code; docs match code." +
  " Verify with the real toolchain. Quality > speed. Exceed industry standards."

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

const PROMPTS = {
  retry: (attempt) =>
    `${RESUME_TAG} Auto-retry #${attempt}. Self-healing; the previous turn was busy ~60s with no output and got aborted.` +
    ` Pick up exactly where you stopped; finish production-grade.`,
  resume: (auto, detail, modelNote) =>
    `${RESUME_TAG} Auto-resume. A provider turn failed (network / 5xx / rate-limit / timeout / quota).` +
    (detail ? ` Cause: "${detail}".` : "") +
    (modelNote ? ` ${modelNote}` : "") +
    ` Reconstruct state from the conversation + codebase (re-read files if unsure); continue from exactly where you stopped.` +
    ` Exceed industry standards on the remaining work.`,
  lowBudget: (auto, detail, modelNote) =>
    `${RESUME_TAG} Auto-resume on a tight token/credit budget. The previous reply was rejected for exceeding max_tokens the account can afford.` +
    (detail ? ` Cause: "${detail}".` : "") +
    (modelNote ? ` ${modelNote}` : "") +
    ` Lead with the answer, justify concisely. Skip preamble, restated context, and unchanged code blocks. Edits > rewrites; diffs > restatements. Tight prose, minimal code, no corners cut on correctness or verification. Quality bar above user expectations.` +
    (auto ? AUTONOMY_DIRECTIVE_TIGHT : ""),
  truncated: (auto) =>
    `${RESUME_TAG} Last reply hit max output length and was cut off. Continue seamlessly from the cut point. Close any half-open block/sentence first, then finish. Code must be whole + runnable, not fragmentary.`,
  empty: (auto) =>
    `${RESUME_TAG} Previous reply came back empty (likely a transient provider hiccup). Answer the original request now: concise, precise, production-grade.`,
  todos: () =>
    `${RESUME_TAG} Session idle, todos unfinished. Work them autonomously, one by one: implement end-to-end (code + tests + docs where they matter), verify (build/test/lint), then mark complete. Hold the bar above industry standards — edges, errors, clean integration — until the list is flawless.`,
  proceed: () =>
    `${RESUME_TAG} Proceed autonomously with what you just proposed/asked — answer is yes. Decide and continue.` +
    ` Execute end-to-end at senior level: full impl + tests + error handling + doc touches, verified against the real toolchain. Aim to exceed expectations.` +
    AUTONOMY_DIRECTIVE,
  keepGoing: () =>
    `${RESUME_TAG} You paused mid-work ("continue", "finalize", etc.) — indicating there is still work to do. Pick up now and drive to perfect finalization: finish remaining steps, verify (build/test/lint), nothing half-done. Production-grade, not partial.` +
    AUTONOMY_DIRECTIVE,
  debug: () =>
    `${RESUME_TAG} Multiple tool calls failed. Stop the failing approach. Root-cause: read the FULL error (not just the first line), inspect the actual files/state, form ONE concrete hypothesis, apply the smallest targeted fix for the real cause, prove it (re-run the failing command), add a regression test so this class stays dead.`,
  improve: (cycle, total) =>
    `${RESUME_TAG} Self-improvement pass ${cycle}/${total}. Review all work this session as a principal engineer signing off a release.` +
    ` Hunt concrete gains: correctness, perf, security, robustness, readability — unhandled edges, missing input validation, races, leaks, stale docs/comments, thin test coverage on critical paths, inefficient hot spots, style inconsistencies.` +
    ` Implement what you're confident about and validate (build/test/lint/typecheck). Skip ambiguous/risky items; one-line note why. No new features — raise existing work above industry standards, beyond what the user asked for.`,
  propose: () =>
    `${RESUME_TAG} Todos complete, flawless execution. Do NOT implement more. Don't summarize the work. Wrap-up = NEW info only:` +
    ` (1) Verification status — what you ran (build/test/lint/typecheck) and results; flag anything unverified.` +
    ` (2) Known limitations, risks, assumptions a reviewer should know.` +
    ` (3) Up to 3 follow-up improvement proposals, each with expected payoff — aim above user expectations.`,
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
  if (!t || t.length > 250) return false
  return CONTINUATION_STEM.test(t) || CONTINUATION_ANYWHERE.some((re) => re.test(t))
}

/** Unambiguous phrases count even inside longer replies. */
const looksLikeContinuationLong = (text) => {
  const t = String(text ?? "").trim()
  if (!t) return false
  return CONTINUATION_ANYWHERE.some((re) => re.test(t))
}

const tierScore = (modelID) => {
  let score = 0
  for (const [re, pts] of TIER_BONUS) if (re.test(modelID)) score += pts
  for (const [re, pts] of TIER_PENALTY) if (re.test(modelID)) score += pts
  return score
}

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
  return {
    enabled: bool("OPENCODE_RESUME_ENABLED", DEFAULTS.enabled),
    maxChain: num("OPENCODE_RESUME_MAX_CHAIN", DEFAULTS.maxChain),
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
    breakerThreshold: num("OPENCODE_RESUME_BREAKER_THRESHOLD", DEFAULTS.breakerThreshold),
    breakerWindowMs: num("OPENCODE_RESUME_BREAKER_WINDOW_MS", DEFAULTS.breakerWindowMs),
    breakerCooldownMs: num("OPENCODE_RESUME_BREAKER_COOLDOWN_MS", DEFAULTS.breakerCooldownMs),
    compactOnOverflow: bool("OPENCODE_RESUME_COMPACT_ON_OVERFLOW", DEFAULTS.compactOnOverflow),
    // New name wins; the pre-1.10 toast-era env var stays honored as fallback.
    noticeThrottleMs: num("OPENCODE_RESUME_NOTICE_THROTTLE_MS",
      num("OPENCODE_RESUME_TOAST_THROTTLE_MS", DEFAULTS.noticeThrottleMs)),
    autoUpdate: bool("OPENCODE_RESUME_AUTO_UPDATE", DEFAULTS.autoUpdate),
    maxTaskCostUsd: num("OPENCODE_AUTOPILOT_MAX_COST_USD", DEFAULTS.maxTaskCostUsd),
    switchOnQuota: bool("OPENCODE_RESUME_SWITCH_ON_QUOTA", DEFAULTS.switchOnQuota),
    switchOnRateLimit: bool("OPENCODE_RESUME_SWITCH_ON_RATELIMIT", DEFAULTS.switchOnRateLimit),
    switchOnFailures: bool("OPENCODE_RESUME_SWITCH_ON_FAILURES", DEFAULTS.switchOnFailures),
    disableRotation: bool("OPENCODE_RESUME_DISABLE_ROTATION", DEFAULTS.disableRotation),
    rlSwitchAfter: Math.max(1, num("OPENCODE_RESUME_RL_SWITCH_AFTER", 1)),
    rotateAfterFailures: Math.max(1, num("OPENCODE_RESUME_ROTATE_AFTER_FAILURES", DEFAULTS.rotateAfterFailures)),
    maxRotations: num("OPENCODE_RESUME_MAX_ROTATIONS", DEFAULTS.maxRotations),
    modelCooldownMs: num("OPENCODE_RESUME_MODEL_COOLDOWN_MS", DEFAULTS.modelCooldownMs),
    fallbackModels: str("OPENCODE_RESUME_FALLBACK_MODELS", DEFAULTS.fallbackModels),
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
  }
}

const matchesAny = (haystack, patterns) => {
  if (!haystack) return false
  const lower = String(haystack).toLowerCase()
  return patterns.some((p) => lower.includes(p))
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

/** PowerShell source for one Windows notification: tries the modern WinRT
 *  toast first; if the AUMID is blocked (common on hardened builds), falls
 *  back to a NotifyIcon balloon tip, which Windows 10/11 render as a toast. */
const windowsToastPs = (title, message) => `
$ErrorActionPreference = 'Stop'
$title = ${psQuote(title)}
$text  = ${psQuote(message)}
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $nodes = $xml.GetElementsByTagName('text')
  [void]$nodes.Item(0).AppendChild($xml.CreateTextNode($title))
  [void]$nodes.Item(1).AppendChild($xml.CreateTextNode($text))
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show(
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
 *  silently swallow both the notification AND its failure reporting. */
const NOTIFIER_TIMEOUT_MS = 15_000
export const createOsNotifier = ({
  $,
  platform = process.platform,
  systemRoot = process.env.SystemRoot,
  wslVersionFile = "/proc/version",
  timeoutMs = NOTIFIER_TIMEOUT_MS,
} = {}) => {
  const withTimeout = (p) =>
    Promise.race([
      p,
      new Promise((_, reject) => {
        // Deliberately NOT unref'd: this timer is what resolves hung
        // dispatches — an unref'd timer on an otherwise idle event loop
        // would let the process exit (code 13) without settling anything.
        setTimeout(() => reject(new Error(`notifier timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  let wslCache
  const wslProbe = () =>
    platform !== "linux"
      ? Promise.resolve("")
      : (wslCache ??= import("node:fs/promises")
          .then(({ readFile }) => readFile(wslVersionFile, "utf8"))
          .catch(() => ""))
  const runPowerShellToast = async (exe, title, message) => {
    const encoded = Buffer.from(windowsToastPs(title, message), "utf16le").toString("base64")
    await withTimeout($`${exe} -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}`.quiet())
  }
  return async (title, message) => {
    try {
      if (!($ && typeof $ === "function")) return false
      if (platform === "win32") {
        await runPowerShellToast(
          `${systemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
          title, message)
        return true
      }
      if (platform === "darwin") {
        // AppleScript double-quoted strings: escape backslashes first, then quotes
        const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
        await withTimeout($`osascript -e ${`display notification ${q(message)} with title ${q(title)}`}`)
        return true
      }
      // Linux/BSD: WSL hosts delegate to Windows PowerShell; bare metal uses
      // libnotify first and the raw D-Bus Notifications API as fallback.
      if (/microsoft|wsl/i.test(await wslProbe())) {
        await runPowerShellToast("powershell.exe", title, message)
        return true
      }
      try {
        await withTimeout($`notify-send -a auto-resume ${title} ${message}`.quiet())
        return true
      } catch { /* no libnotify installed */ }
      await withTimeout($`dbus-send --session --type=method_call --dest=org.freedesktop.Notifications /org/freedesktop/Notifications org.freedesktop.Notifications.Notify string:${title} uint32:0 string:dialog-information string:${title} string:${message} array:string: dict:string:string: int32:5000`.quiet())
      return true
    } catch {
      return false
    }
  }
}

export const AutoResumePlugin = async ({ client, $ }) => {
  const cfg = loadConfig()

  const sessions = new Map() // sessionID -> state
  const permissionPending = new Map() // sessionID -> ts
  const modelCooldown = new Map() // "provider/model" -> untilTs
  const timers = new Map()
  const breakerFailures = []
  let breakerOpenUntil = 0
  let breakerNoted = false
  let lastNoticeAt = 0
  let catalogCache = null
  let catalogFetchedAt = 0

  // This file's own path on disk (also used by the self-updater below).
  const selfPath = (() => {
    try {
      if (!import.meta.url.startsWith("file:")) return null
      return decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1")
    } catch { return null }
  })()

  // ── persistent JSON sidecars next to this file ─────────────────────────
  // Two tiny maps survive OpenCode restarts:
  //   • .stopped.json — sessions the user STOPPED (quiet until next prompt)
  //   • .off.json     — sessions where auto-resume is turned OFF entirely
  const STORE_TTL_MS = 14 * 86_400_000 // forget ancient markers

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
          const raw = JSON.parse(await readFile(path, "utf8"))
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
      const payload = JSON.stringify(out, null, 2)
      const tmp = `${path}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
      await writeFile(tmp, payload, "utf8")
      // Windows: freshly written files can be briefly locked (AV/indexer), so
      // the atomic rename may fail with EPERM/EACCES/EBUSY — retry with
      // backoff, then fall back to a plain overwrite of the final path.
      for (const delayMs of [25, 50, 100, 200, 400]) {
        try {
          await rename(tmp, path)
          return
        } catch (err) {
          if (!["EPERM", "EACCES", "EBUSY", "EEXIST"].includes(err?.code)) throw err
          await new Promise((r) => setTimeout(r, delayMs))
        }
      }
      try {
        await writeFile(path, payload, "utf8")
      } finally {
        try { await unlink(tmp) } catch { /* best effort */ }
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

  const stopStore = makeMapStore(
    "user-stops",
    str("OPENCODE_RESUME_STOPSTORE", selfPath ? `${selfPath}.stopped.json` : ""),
  )
  const offStore = makeMapStore(
    "opt-outs",
    str("OPENCODE_RESUME_OFFSTORE", selfPath ? `${selfPath}.off.json` : ""),
  )
  const persistedStops = stopStore.map

  /** Stopped = flagged live this run OR remembered from a previous run. */
  const isUserStopped = (sessionID) =>
    Boolean(sessions.get(sessionID)?.userStopped || persistedStops.has(sessionID))

  /** Opted out = auto-resume fully disabled for this session by the user. */
  const isOptedOut = (sessionID) => offStore.map.has(sessionID)

  /** Anything automation might do for this session is blocked. */
  const suppressed = (sessionID) => isUserStopped(sessionID) || isOptedOut(sessionID)

  // ── per-session title indicator ────────────────────────────────────────
  // While auto-resume is enabled for a session, its title is decorated as:
  //   "<glyph> <base title> [auto-resume: <status>]"
  // (leading status glyph + trailing bracket tag). Turning auto-resume off
  // restores the exact previous title — no trace of the plugin remains.
  const TITLE_MARK_TEST = /\[auto-resume:/i
  const TITLE_MARK_STRIP = /\s*\[auto-resume:[^\]]*\]/gi
  const GLYPH_LEAD_RE = /^\s*(?:🟢|🔁|⏸️|🚫)\s+/u
  const STATUS_STYLE = {
    armed:      { glyph: "🟢", label: "armed" },
    recovering: { glyph: "🔁", label: "recovering" },
    stopped:    { glyph: "⏸️", label: "stopped" },
    paused:     { glyph: "🚫", label: "paused" },
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
    const capped = Boolean(
      s && (
        s.costNotified ||
        (cfg.maxTaskCostUsd > 0 && s.taskCost >= cfg.maxTaskCostUsd) ||
        s.chain >= cfg.maxChain ||
        s.nudges >= cfg.maxNudges ||
        s.rotations >= cfg.maxRotations ||
        (cfg.budgetMs > 0 && s.taskStartAt && Date.now() - s.taskStartAt >= cfg.budgetMs)
      ),
    )
    if (capped) return "paused"
    // 🔁 means recovery is happening RIGHT NOW: a queued/dispatched retry,
    // core parked in its own retry loop, or a busy turn that OUR injection
    // started (lastResumeAt newer than the last error AND last success).
    // A plain busy turn that merely has historical errors stays 🟢 armed —
    // the old `(busy|retry) && chain > 0` clause latched 🔁 onto every later
    // user task forever, because chain never resets on success.
    if (
      s && (
        s.pendingResume ||
        s.retryEnteredAt > 0 ||
        s.status === "retry" ||
        (s.status === "busy" &&
          s.lastResumeAt > Math.max(s.lastErrorAt, s.lastSuccessAt))
      )
    ) {
      return "recovering"
    }
    return "armed"
  }

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
    }, 250)
    t.unref?.()
    titleTimers.set(sessionID, t)
  }

  /** Zero-trace guarantee after restarts: if a crash landed between an opt-out
   *  and its restore PATCH, the stored title may still carry a stale tag —
   *  sweep every opted-out session once the stores are loaded. Idempotent
   *  (clean titles produce no PATCH). */
  const restoreOptedOutTitles = () => {
    for (const id of [...offStore.map.keys()]) queueTitleRefresh(id)
  }

  /** In-chat switch: "auto-resume off" disables everything for THIS session;
   *  "auto-resume on" re-enables and starts fresh. Persisted across restarts. */
  const handleToggleCommand = (sessionID, mode) => {
    const s = state(sessionID)
    if (mode === "off") {
      offStore.map.set(sessionID, Date.now())
      offStore.save()
      // an explicit opt-out supersedes any stop marker
      if (persistedStops.delete(sessionID)) stopStore.save()
      s.userStopped = false
      const t = timers.get(sessionID)
      if (t) { clearTimeout(t); timers.delete(sessionID) }
      log("info", "auto-resume disabled for session", { sessionID })
      notice(`${RESUME_TAG}: Off for this session — nothing will be automated here until you say "auto-resume on".`, "info")
      queueTitleRefresh(sessionID)
      return
    }
    const wasOff = isOptedOut(sessionID)
    if (offStore.map.delete(sessionID)) offStore.save()
    if (persistedStops.delete(sessionID)) stopStore.save()
    resetTaskScope(s)
    s.userStopped = false
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
        compactAttempted: false, awaitingCompactionSince: 0,
        pendingResume: false, lastResumeAt: 0, lastInjectAt: 0, lastSuccessAt: 0,
        lastModel: null, currentModel: null, originalModel: null,
        rlStreak: 0, failStreak: 0, rotations: 0,
        todos: [], nudges: 0, driveCount: 0, staleDrives: -1,
        lastDriveCompleted: -1, proposalSent: false, taskStartAt: 0,
        improveDone: 0, improveTotal: 0, lastImprovedAt: 0, noTodoImproveFired: false,
        proceedCount: 0,
        toolErrs: 0, debugArmed: false, toolRunning: false,
        lastTurnHadText: false,
        retryEnteredAt: 0, retryNext: 0, child: false, reanimated: false,
        userStopped: false, takeoverAt: 0,
        lastInjectKind: null,
        lastEvalSig: null,
        taskCost: 0, costNotified: false, budgetNotified: false, gaveUpRearmed: false,
      lowBudgetStreak: 0, lowBudgetSig: null, lowBudgetLastFired: false,
        lowBudgetLastFired: false,
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
    Object.assign(s, {
      chain: 0, continueCount: 0, compactAttempted: false,
      rlStreak: 0, failStreak: 0, rotations: 0,
      nudges: 0, driveCount: 0, staleDrives: -1,
      lastDriveCompleted: -1, proposalSent: false,
      improveDone, improveTotal, lastImprovedAt,
      proceedCount: 0, taskStartAt: Date.now(), toolErrs: 0,
      debugArmed: false, retryEnteredAt: 0, retryNext: 0,
      userStopped: false, takeoverAt: 0, lastTurnHadText: false, taskCost: 0, costNotified: false,
      budgetNotified: false, gaveUpRearmed: false, noTodoImproveFired: false,
      lowBudgetStreak: 0, lowBudgetSig: null, emptyStreak: false,
      lastErrorName: null, lastErrorSig: null,
    })
    if (!keepTimers) s.stallResumes = 0
  }

  const detach = (promise, label) =>
    Promise.resolve().then(promise).catch(
      (err) => console.error(`${RESUME_TAG} ${label} failed:`, err?.message ?? err))

  const log = (level, message, extra) =>
    detach(() => client.app.log({ body: { service: "auto-resume", level, message, extra } }), "app.log")

  /** User-facing notices go to the OpenCode log stream ONLY — the flaky TUI
   *  toast surface was removed in v1.10. Rare milestone events (update
   *  applied) additionally fire a native OS notification via osNotify. */
  const NOTICE_LEVEL = { info: "info", success: "info", warning: "warn", error: "error" }
  const notice = (message, variant = "warning") => {
    const nowMs = Date.now()
    if (cfg.noticeThrottleMs > 0 && nowMs - lastNoticeAt < cfg.noticeThrottleMs) return
    lastNoticeAt = nowMs
    log(NOTICE_LEVEL[variant] ?? "warn", message)
  }

  // ── OS notifications + milestones ──────────────────────────────────────
  const osNotify = createOsNotifier({ $ })

  /** Milestone events (update applied, …): pushed through the native OS
   *  channel AND logged — throttle-exempt because their rarity self-caps
   *  them; lastNoticeAt is reserved up front so ordinary notices stay spaced
   *  even while a slow balloon-tip dispatch is in flight. With
   *  requireDelivery, the durable log line only lands when the OS channel
   *  accepted the job (retry loops then surface failures via their own
   *  warn/debug path instead of implying success). Log entries carry
   *  structured extra fields ({event, os}) for machine filtering. Resolves
   *  true when the OS channel accepted the job. */
  const announce = async (message, {
    title = "auto-resume", requireDelivery = false, event = "milestone",
  } = {}) => {
    const body = message.startsWith(RESUME_TAG) ? message : `${RESUME_TAG}: ${message}`
    lastNoticeAt = Date.now()
    const delivered = await osNotify(title, message.replace(`${RESUME_TAG}: `, ""))
    if (delivered || !requireDelivery) log("info", body, { event, os: delivered })
    return delivered
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

  // ── classification ─────────────────────────────────────────────────
  const classify = (error) => {
    const name = error?.name
    const data = error?.data ?? {}
    const text = `${data.message ?? ""} ${data.responseBody ?? ""}`
    if (name === "MessageAbortedError") return "abort"
    // Fetch-level timeouts/aborts carry different names than user stops
    // (MessageAbortedError) — they are transient infrastructure, retryable.
    if (name === "AbortError" || name === "TimeoutError") return "retryable"
    if (name === "ProviderAuthError") return "auth"
    if (name === "MessageOutputLengthError") return "output_length"
    if (matchesAny(text, QUOTA_PATTERNS)) return "quota"
    if (matchesAny(text, RATE_LIMIT_PATTERNS)) return "rate_limit"
    if (name === "APIError") {
      const code = data.statusCode
      if (code === 429) return "rate_limit"
      if (code === 402) return "quota"   // HTTP 402 Payment Required → quota/credits
      if (code === 408 || code === 409) return "retryable"
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

  /** Short human-readable cause for injected prompts/log lines: e.g.
   *  "APIError HTTP 502 — bad gateway" or "UnknownError — upstream request failed". */
  const describeErr = (error) => {
    if (!error) return ""
    const name = error.name ?? "Error"
    const code = error.data?.statusCode
    const msg = String(error.data?.message ?? error.message ?? "").replace(/\s+/g, " ").trim().slice(0, 120)
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
    if (!headers) return null
    const raw = headers["retry-after"] ??
      Object.entries(headers).find(([k]) => k.toLowerCase() === "retry-after")?.[1]
    if (!raw) return null
    const secs = Number(raw)
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1_000, 600_000)
    const date = Date.parse(raw)
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 600_000)
    return null
  }

  const backoff = (attempt, base) =>
    Math.min(jitter(base * Math.pow(2, Math.max(attempt - 1, 0))), cfg.maxDelayMs)

  // ── model catalog + rotation ───────────────────────────────────────
  const modelKey = (m) => `${m.providerID}/${m.modelID}`
  const cooling = (key) => (modelCooldown.get(key) ?? 0) > Date.now()

  /** Pick the right prompt + model-note for an auto-resume injection.
   *  - sessionID: needed to read the (now-current) model state
   *  - kind: classify() result
   *  - error: raw error object
   *  - rotated: true if we already swapped to a new model for this resume
   *  - rotatedFrom: modelKey of the old model (null if no rotation)
   *  Returns (auto) => string. */
  const buildResumePrompt = (sessionID, kind, error, rotated, rotatedFrom) => {
    // prompt-facing cause: compact, URL/help-text stripped, OpenRouter
    // "requested N tokens, can afford M" rewritten as a one-liner.
    const detail = describeErrForPrompt(error)
    const cur = state(sessionID)
    const nowKey = cur.currentModel ? modelKey(cur.currentModel) : null
    const modelNote = rotated && rotatedFrom && nowKey && rotatedFrom !== nowKey
      ? `You are now on a different model (${nowKey}).`
      : ""
    if (kind === "quota" && isCreditsConstraint(error)) {
      return (a) => PROMPTS.lowBudget(a, detail, modelNote)
    }
    return (a) => PROMPTS.resume(a, detail, modelNote)
  }

  const getCatalog = async () => {
    if (catalogCache && Date.now() - catalogFetchedAt < 300_000) return catalogCache
    try {
      const res = await client.config.providers()
      const data = res?.data ?? res
      catalogCache = Array.isArray(data?.providers) ? data.providers : []
      catalogFetchedAt = Date.now()
    } catch (err) {
      log("warn", "could not fetch provider catalog", { err: err?.message ?? String(err) })
      catalogCache = catalogCache ?? []
    }
    return catalogCache
  }

  const listChatModels = (providers) => {
    const out = []
    for (const prov of providers) {
      for (const modelID of Object.keys(prov?.models ?? {})) {
        if (NON_CHAT_PATTERN.test(modelID)) continue
        out.push({ providerID: prov.id, modelID })
      }
    }
    return out
  }

  const pickAlternateModel = async (exhausted) => {
    const providers = await getCatalog()
    const all = listChatModels(providers)
    if (!all.length) return null

    const exhaustedKey = exhausted ? modelKey(exhausted) : null
    const eligible = all.filter((m) => {
      const k = modelKey(m)
      if (exhaustedKey && k === exhaustedKey) return false
      if (cooling(k)) return false
      return true
    })
    if (!eligible.length) return null

    // Preferred-chain entries keep absolute priority (explicit user intent);
    // everything else is ranked by capability tier — Max/Ultra/Opus/Pro/High
    // variants beat mini/nano/lite/flash — then by provider proximity.
    const chainSet = new Set(
      cfg.fallbackModels.split(",").map((x) => x.trim()).filter(Boolean),
    )
    const groupOf = (m) => {
      if (chainSet.has(modelKey(m))) return 0
      if (!exhausted || m.providerID === exhausted.providerID) return 1
      return 2
    }
    const ordered = [...eligible].sort((a, b) => {
      const ga = groupOf(a)
      const gb = groupOf(b)
      if (ga !== gb) return ga - gb
      const ta = tierScore(a.modelID)
      const tb = tierScore(b.modelID)
      if (ta !== tb) return tb - ta
      return a.modelID.localeCompare(b.modelID)
    })
    return ordered[0] ?? null
  }

  /**
   * Rotate the session to the best available alternate model.
   * @param {boolean} penalize put the old model on cooldown — yes for quota/
   *   auth/rate-limits; no for generic outages, which are usually temporary.
   */
  const rotateAwayFrom = async (sessionID, reason, penalize = true) => {
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
    s.currentModel = { providerID: alt.providerID, modelID: alt.modelID }
    // Fresh lease on the new model — its reliability is unknown so far.
    s.chain = 0
    s.failStreak = 0
    s.rlStreak = 0
    s.rotations += 1
    log("info", "rotated model", {
      sessionID, from: exhausted ? modelKey(exhausted) : null, to: modelKey(alt), reason,
    })
    notice(`${RESUME_TAG}: ${reason} on ${exhausted ? modelKey(exhausted) : "model"} — continuing on ${modelKey(alt)}.`)
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
    const existing = timers.get(sessionID)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      timers.delete(sessionID)
      detach(runPlan(sessionID, plan), "runPlan")
    }, delayMs)
    t.unref?.()
    timers.set(sessionID, t)
    log("info", `scheduled "${plan.kind}" in ${delayMs}ms`, { sessionID })
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
    // Stale-recovery guard: if the session already had a clean turn AFTER
    // this plan was scheduled, core self-healed and the injection would be
    // a spurious "transient error" prompt on a healthy session — drop it.
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
      s.pendingResume = false
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
        const maxPolls = plan.kind === "resume" ? 60 : 12
        if (plan.polls <= maxPolls) {
          schedule(sessionID, 5_000, plan) // core busy/retrying — check again shortly
          return
        }
        log("info", "session stayed busy — dropping stale injection", { sessionID, kind: plan.kind })
        return
      }
    }

    const model = s.currentModel ?? s.lastModel
    const body = { parts: [{ type: "text", text: autonomousPrompt(plan) }] }
    if (model) body.model = model

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
      log("info", `injected "${plan.kind}"`, {
        sessionID,
        model: model ? modelKey(model) : undefined,
        mode: typeof asyncPrompt === "function" ? "async" : "sync",
      })
      queueTitleRefresh(sessionID)
    } catch (err) {
      const ns = client.session ?? {}
      const mode = typeof (ns.promptAsync ?? ns.postSessionByIdPromptAsync) === "function" ? "async" : "sync"
      log("error", `resume prompt rejected (${mode})`, { sessionID, err: err?.message ?? String(err) })
      noteResumeFailure()
      if (plan.kind === "resume" && s.chain < cfg.maxChain) {
        s.chain += 1
        schedule(sessionID, backoff(s.chain, cfg.baseDelayMs), plan)
      } else {
        notice(`${RESUME_TAG}: Could not resume (${err?.message ?? "error"}).`, "error")
      }
    }
  }

  // ── central failure handler ────────────────────────────────────────
  const handleError = async (sessionID, error) => {
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
      sig === s.lastErrorSig && nowMs - s.lastErrorAt < 2_000 && s.lastResumeAt <= s.lastErrorAt
    if (duplicateIncident) return
    s.lastErrorSig = sig
    s.lastErrorAt = nowMs
    s.lastActivity = nowMs
    if (error?.name) s.lastErrorName = error.name

    const kind = classify(error)
    const detail = describeErr(error)
    log("warn", `session error (${kind})`, {
      sessionID, name: error?.name, statusCode: error?.data?.statusCode, message: error?.data?.message,
    })
    queueTitleRefresh(sessionID)

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
      if (!cfg.disableRotation && cfg.switchOnQuota && (await rotateAwayFrom(sessionID, "authentication failed"))) {
        s.chain += 1
        if (s.chain <= cfg.maxChain) {
          schedule(sessionID, cfg.baseDelayMs, { kind: "resume", prompt: buildResumePrompt(sessionID, kind, error, true, authFrom) }); return
        }
      }
      notice(`${RESUME_TAG}: Provider authentication failed — run \`opencode auth login\`.`, "error")
      return
    }

    // ── quota / free-tier exhaustion → rotate model, no user input ──
    if (kind === "quota") {
      // We already fired the last-resort `[auto-resume] Continue.` once and it
      // hit the same wall. Nothing will get through — stop the loop.
      if (s.lowBudgetLastFired) {
        s.lowBudgetLastFired = false
        notice(`${RESUME_TAG}: Token/credit budget is too tight for any prompt to succeed. Manual intervention required.`, "error")
        return
      }
      const quotaFrom = s.lastModel ? modelKey(s.lastModel) : null
      const isCredits = isCreditsConstraint(error)
      const sig = isCredits ? describeErrForPrompt(error) : null
      if (!cfg.disableRotation && cfg.switchOnQuota && (await rotateAwayFrom(sessionID, "quota/free tier exhausted"))) {
        // Track streak even across rotations: every model hitting the same
        // credits constraint = same hopeless budget wall.
        if (isCredits) {
          if (s.lowBudgetSig === sig && s.lowBudgetStreak >= 1) {
            s.lowBudgetStreak = 0; s.lowBudgetSig = null; s.lowBudgetLastFired = false
            notice(`${RESUME_TAG}: Token/credit budget too tight for any model to complete this task (${sig}). Manual intervention required.`, "error")
            return
          }
          s.lowBudgetStreak += 1; s.lowBudgetSig = sig; s.lowBudgetLastFired = false
        }
        schedule(sessionID, cfg.baseDelayMs, { kind: "resume", prompt: buildResumePrompt(sessionID, kind, error, true, quotaFrom) })
        return
      }
      // No alternate model available.
      if (isCredits) {
        const looping = s.lowBudgetStreak > 0 && sig === s.lowBudgetSig
        s.lowBudgetStreak += 1; s.lowBudgetSig = sig
        if (looping || s.lowBudgetStreak >= 1) {
          // Last resort before giving up: inject a 3-word prompt so minimal it
          // can't exceed any token budget. If it also fails, nothing will work.
          s.lowBudgetStreak = 0; s.lowBudgetSig = null; s.lowBudgetLastFired = true
          schedule(sessionID, cfg.baseDelayMs, { kind: "continue", prompt: `${RESUME_TAG} Continue.`, extra: { _lowBudgetLast: true } })
          return
        }
        schedule(sessionID, cfg.baseDelayMs, { kind: "resume", prompt: buildResumePrompt(sessionID, kind, error, false, null) })
        return
      }
      notice(`${RESUME_TAG}: Quota exhausted and no alternate model available — manual action needed.`, "error")
      return
    }

    // ── repeated rate limits on the same model → rotate too ──
    const errText = `${error?.data?.message ?? ""} ${error?.data?.responseBody ?? ""}`
    const isExplicitRateLimit = matchesAny(errText, RATE_LIMIT_PATTERNS)
    if (kind === "rate_limit" && !cfg.disableRotation &&
        (isExplicitRateLimit || s.rlStreak + 1 >= cfg.rlSwitchAfter) &&
        cfg.switchOnRateLimit) {
      const rlFrom = s.lastModel ? modelKey(s.lastModel) : null
      if (await rotateAwayFrom(sessionID, isExplicitRateLimit ? "rate limit exceeded" : "repeated rate limits")) {
        s.rlStreak = 0
        schedule(sessionID, jitter(Math.min(cfg.baseDelayMs, 15_000)), { kind: "resume", prompt: buildResumePrompt(sessionID, kind, error, true, rlFrom) })
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
          // The summarizer model itself may be the problem (quota, outage) —
          // fall back to the best alternate model for this one-shot job.
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
        setTimeout(() => {
          const cur = state(sessionID)
          if (cur.awaitingCompactionSince) {
            cur.awaitingCompactionSince = 0
            notice(`${RESUME_TAG}: Compaction did not complete — not resuming.`, "error")
          }
        }, 180_000).unref?.()
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
      if (!cfg.disableRotation && cfg.switchOnFailures && s.failStreak >= cfg.rotateAfterFailures) {
        const retFrom = s.lastModel ? modelKey(s.lastModel) : null
        if (await rotateAwayFrom(sessionID, "persistent failures", false)) {
          s.failStreak = 0
          schedule(sessionID, jitter(Math.min(cfg.baseDelayMs, 15_000)), { kind: "resume", prompt: buildResumePrompt(sessionID, kind, error, true, retFrom) })
          return
        }
      }
    }

    if (s.pendingResume) return
    if (s.chain >= cfg.maxChain) {
      noteResumeFailure()
      notice(`${RESUME_TAG}: Gave up after ${s.chain} recovery attempts (${kind}). Send a message to try manually.`, "error")
      // Bounded self-re-arm for unattended runs: after a cool-down, reset the
      // chain and try ONCE more — long outages (502 storms, provider blips)
      // must not permanently kill recovery until the user returns.
      if (!s.gaveUpRearmed && !suppressed(sessionID)) {
        s.gaveUpRearmed = true
        const t = setTimeout(() => {
          const cur = state(sessionID)
          if (cur.chain >= cfg.maxChain &&
              cur.lastResumeAt <= s.lastErrorAt && !suppressed(sessionID)) {
            cur.chain = 0
            log("info", "post-give-up re-arm — retrying recovery", { sessionID })
            schedule(sessionID, jitter(cfg.baseDelayMs), { kind: "resume", prompt: PROMPTS.resume })
          }
        }, cfg.rearmMs)
        t.unref?.()
      }
      return
    }
    s.pendingResume = true
    s.chain += 1
    const delay = kind === "rate_limit"
      ? (retryAfterMs(error) ?? backoff(s.chain, cfg.rateLimitBaseMs))
      : backoff(s.chain, cfg.baseDelayMs)
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
  const looksDangerous = (perm) => {
    const blob = JSON.stringify({ t: perm.title, m: perm.metadata, c: perm.callID, p: perm.permission }).toLowerCase()
    return denyList().some((entry) => {
      if (entry.startsWith("re:")) {
        try { return new RegExp(entry.slice(3), "i").test(blob) } catch { return false }
      }
      return blob.includes(entry.toLowerCase())
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
    const ns = client.session ?? {}
    // Known names first (SDK drift across versions), then any other
    // permission-ish method as last resort. Deduped: the scan would otherwise
    // re-add the primary and retry a known-bad shape needlessly.
    const fns = [...new Set([
      ns.postSessionByIdPermissionsByPermissionId,
      ns.respondToPermission,
      ns.postSessionIdPermissionsPermissionId,
      ...Object.keys(ns)
        .filter((k) => /permission/i.test(k) && typeof ns[k] === "function")
        .map((k) => ns[k]),
    ])].filter((f) => typeof f === "function")
    if (!fns.length) { log("warn", "permission API unavailable on this opencode version"); return false }
    const permID = permIdOf(perm)
    let lastErr
    for (const fn of fns) {
      try {
        await fn.call(ns, {
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
    const blob = JSON.stringify({ t: perm.title, m: perm.metadata }).toLowerCase()
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
      return
    }

    const hasContent = (lastAssistant.parts ?? []).some((p) => ["text", "tool", "reasoning"].includes(p?.type))
    const errored = Boolean(info.error)

    if (!errored && hasContent) {
      noteSuccess()
      // A clean turn supersedes any recovery still waiting to fire: without
      // this, error→scheduled resume + core's own successful retry produced
      // spurious "transient infrastructure error" prompts on healthy turns.
      s.lastSuccessAt = Date.now()
      s.toolErrs = 0
      s.gaveUpRearmed = false
      s.budgetNotified = false
      s.lowBudgetStreak = 0; s.lowBudgetSig = null; s.lowBudgetLastFired = false

      const todos = s.todos ?? []
      const open = todos.filter((t) => t.status === "pending" || t.status === "in_progress")
      const finished = todos.filter((t) => t.status === "completed" || t.status === "cancelled")

      // Implicit todo lists: markdown checkboxes in the assistant's own reply
      // count as a todo list even when the todo tool was never used.
      const replyText = (lastAssistant.parts ?? [])
        .map((x) => (x?.type === "text" ? x.text : "")).join(" ")
      const boxes = [...replyText.matchAll(/[-*+]\s+\[([ xX])\]/g)]
      const cbOpen = boxes.filter((m) => m[1] === " ").length
      const cbDone = boxes.length - cbOpen

      // The agent ended its turn by asking a question or announcing more
      // work ("Continue to finalize.") instead of finishing — keep it going.
      if (open.length === 0 && s.lastInjectKind !== "propose" && cfg.autonomy && cfg.proceedOnAsk &&
          s.proceedCount < cfg.maxProceeds && s.nudges < cfg.maxNudges && budgetLeft(s)) {
        const text = (lastAssistant.parts ?? [])
          .map((x) => (x?.type === "text" ? x.text : "")).join(" ")
        if (text && text.trim()) {
          const asked = QUESTION_PATTERNS.some((re) => re.test(text))
          const stubbed = looksLikeContinuationStub(text) || looksLikeContinuationLong(text)
          if (asked || stubbed) {
            s.proceedCount += 1
            s.nudges += 1
            log("info", asked ? "agent asked a question — proceeding autonomously" : "agent announced continuation but stopped — resuming", { sessionID })
            schedule(sessionID, cfg.nudgeDelayMs, {
              kind: "proceed",
              prompt: asked ? PROMPTS.proceed : PROMPTS.keepGoing,
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
      if (cfg.autonomy && cfg.todoDrive && (open.length > 0 || cbOpen > 0) &&
          s.nudges < cfg.maxNudges && budgetLeft(s)) {
        const doneNow = finished.length + cbDone
        if (doneNow === s.lastDriveCompleted) {
          s.staleDrives += 1
        } else {
          s.staleDrives = 0
          s.lastDriveCompleted = doneNow
        }
        if (s.staleDrives < 2) {
          s.nudges += 1
          s.driveCount += 1
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

    if (!errored && !hasContent && s.lastResumeAt && s.emptyNudges < 2) {
      s.emptyNudges += 1
      log("info", "empty response detected, nudging", { sessionID, emptyNudges: s.emptyNudges })
      if (s.emptyNudges >= 2) {
        notice(`${RESUME_TAG}: Two empty responses in a row (likely a context compaction or model loop). Pausing auto-resume — send a new prompt to resume.`, "warning")
        s.emptyStreak = true
        return
      }
      schedule(sessionID, cfg.nudgeDelayMs, { kind: "empty", prompt: PROMPTS.empty })
    }
  }

  // ── stall + stuck-retry watchdog ───────────────────────────────────
  const takeover = (sessionID, why, noticeMsg, plan = { kind: "resume", prompt: PROMPTS.resume }) => {
    const s = state(sessionID)
    if (s.chain >= cfg.maxChain || s.stallResumes >= 2) return
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
      setTimeout(() => schedule(sessionID, 800, plan), 1_500).unref?.()
    }, "takeover-abort")
  }

  const checkStalls = () => {
    const nowMs = Date.now()
    // Memory hygiene: drop state for sessions that have been idle for hours.
    for (const [sessionID, s] of sessions) {
      if (s.status === "busy" || s.status === "retry") continue
      if (nowMs - s.lastActivity > 21_600_000) {
        sessions.delete(sessionID)
        knownTitles.delete(sessionID)
        writtenTitles.delete(sessionID)
        for (const k of dirAskCounts.keys()) {
          if (k.startsWith(`${sessionID}|`)) dirAskCounts.delete(k)
        }
        const tt = titleTimers.get(sessionID)
        if (tt) clearTimeout(tt)
        titleTimers.delete(sessionID)
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

      if (s.status !== "busy") continue
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
      takeover(sessionID, "stalled stream detected, aborting + resuming",
        `${RESUME_TAG}: Response appears stuck — restarting it.`)
    }
  }

  // ── crash recovery: revive sessions killed by a server/machine restart ──
  // Recovery timers live in the server process, so a crash orphans any turn
  // that was mid-recovery or awaiting its first reply. On startup we scan
  // recent sessions and give those a fresh continuation.
  const reanimate = async () => {
    await Promise.all([stopStore.load(), offStore.load()]) // markers known before any revival decision
    if (!cfg.reanimate) return
    let list = []
    try {
      const res = await client.session.list()
      list = (res?.data ?? res) ?? []
    } catch (err) {
      log("warn", "reanimation scan failed", { err: err?.message ?? String(err) })
      return
    }
    if (!Array.isArray(list)) return
    const cutoff = Date.now() - cfg.reanimateWindowMs
    for (const sess of list) {
      if (!sess?.id || sess.parentID) continue // subagents belong to parents
      // The user stopped this session or turned auto-resume off here:
      // never auto-start it, whatever happened.
      if (suppressed(sess.id)) continue
      if ((sess.time?.updated ?? 0) < cutoff) continue // too old to be a crash victim
      const s = state(sess.id)
      if (s.reanimated) continue
      s.reanimated = true

      let entries = []
      try {
        const r = await client.session.messages({ path: { id: sess.id } })
        entries = (r?.data ?? r) ?? []
      } catch { continue }
      if (!entries.length) continue
      const lastEntry = entries[entries.length - 1]
      const lastInfo = lastEntry?.info
      if (!lastInfo) continue

      resetTaskScope(s)

      // A prompt that never received any reply: the turn died at submission.
      if (lastInfo.role === "user") {
        log("info", "reanimating session with unanswered prompt", { sessionID: sess.id })
        schedule(sess.id, 1_500, { kind: "resume", prompt: PROMPTS.resume })
        notice(`${RESUME_TAG}: Revived a session interrupted by the restart.`)
        continue
      }

      // Graceful shutdowns make core stamp the in-flight message with
      // MessageAbortedError — identical to a Stop press in stored data.
      // But genuine Stops were persisted LIVE at press time and filtered
      // above via suppressed(); anything reaching this point is an
      // INTERRUPTION (crash or client restart), not a user decision.
      // A hard kill leaves no error at all — detect those via a missing
      // completion timestamp (only trusted when time object exists).
      const incomplete =
        lastInfo.role === "assistant" &&
        !lastInfo.error &&
        typeof lastInfo.time === "object" &&
        lastInfo.time !== null &&
        !(lastInfo.time.completed > 0)

      if (lastInfo.role === "assistant" && (lastInfo.error || incomplete)) {
        let kind = lastInfo.error ? classify(lastInfo.error) : "interrupted"
        if (kind === "abort") kind = "retryable" // shutdown artifact → revive
        if (["auth", "fatal", "overflow"].includes(kind)) continue
        if (lastInfo.modelID) {
          s.lastModel = { providerID: lastInfo.providerID, modelID: lastInfo.modelID }
        }
        if (kind === "quota" || kind === "rate_limit") {
          await rotateAwayFrom(sess.id, "quota/rate limit (after restart)", true)
        }
        log("info", "reanimating interrupted session", { sessionID: sess.id, kind })
        schedule(
          sess.id,
          1_500,
          kind === "output_length"
            ? { kind: "continue", prompt: PROMPTS.truncated }
            : { kind: "resume", prompt: PROMPTS.resume },
        )
        notice(`${RESUME_TAG}: Revived a session interrupted by the restart.`)
      }
    }
    // reconnect rescans double as zero-trace sweeps for opted-out sessions
    restoreOptedOutTitles()
  }


  // -- self-updater: daily check against the official repo -------------------
  let lastUpdateCheckAt = 0
  let lastReanimateAt = 0
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
    if (Date.now() - lastNoticeTryAt < 30_000) return
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
      await writeFile(tmp, src, "utf8")
      await rename(tmp, selfPath)
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
    detach(() => log("info", `auto-resume v${AUTO_RESUME_VERSION} initialized`), "init-log")
    detach(stopStore.load, "stop-store-load")
    detach(offStore.load, "off-store-load")
    detach(async () => {
      await Promise.all([stopStore.load(), offStore.load()])
      restoreOptedOutTitles()
    }, "optout-title-restore")
    detach(checkForUpdates, "update-check")
    // Long-lived processes: re-probe hourly; the built-in 24h window makes
    // this an actual daily check while OpenCode stays open.
    const upd = setInterval(() => detach(checkForUpdates, "update-check"), 3_600_000)
    upd.unref?.()
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
          deliveryTimers = [
            setTimeout(() => detach(deliverPendingNotice, "notice-deliver"), 800),
            setTimeout(() => detach(deliverPendingNotice, "notice-fallback"), 15_000),
          ]
        } catch { /* cosmetic only */ }
      }, "update-notice")
    }
    detach(reanimate, "reanimate")
  } else {
    console.warn(`${RESUME_TAG} disabled via OPENCODE_RESUME_ENABLED`)
  }

  return {
    event: async (input) => {
      if (!cfg.enabled) return
      const event = input && typeof input === "object" ? input.event : null
      if (!event || typeof event.type !== "string") return
      try {
        const type = event.type
        const p = event.properties ?? {}

        switch (type) {
          case "session.error": {
            if (p.sessionID && p.error) detach(handleError(p.sessionID, p.error), "handleError")
            break
          }

          case "message.updated": {
            nudgePendingNotice()
            const info = p.info
            if (!info?.sessionID) break
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
              const toggleCmd = /^\/?auto[- ]?resume[ :]?(off|on)[.!]?\s*$/i.exec(userText.trim())
              if (toggleCmd) {
                handleToggleCommand(info.sessionID, toggleCmd[1].toLowerCase())
                break
              }
              if (!ours) {
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

            if (info.role === "assistant") {
              if (info.modelID) {
                const s = state(info.sessionID)
                const seen = { providerID: info.providerID, modelID: info.modelID }
                s.originalModel = s.originalModel ?? seen
                s.lastModel = seen
              }
              if (typeof info.cost === "number") state(info.sessionID).taskCost += info.cost
              if (info.error) detach(handleError(info.sessionID, info.error), "handleError")
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
              detach(evaluateIdle(p.sessionID), "evaluateIdle")
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
            permissionPending.set(sessionID, Date.now()) // always: watchdog depends on it
            const permID = permIdOf(perm)
            if (!permID) break
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
            if (p.sessionID) permissionPending.delete(p.sessionID)
            break
          }

          case "server.connected": {
            // Laptop woke up / client reconnected: rescan for sessions that
            // were orphaned while the machine was asleep (throttled).
            const nowMs = Date.now()
            if (cfg.reanimate && nowMs - lastReanimateAt > 300_000) {
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

          case "session.compacted": {
            const s = sessions.get(p.sessionID)
            if (s?.awaitingCompactionSince) {
              s.awaitingCompactionSince = 0
              log("info", "compaction done, resuming", { sessionID: p.sessionID })
              schedule(p.sessionID, 3_000, { kind: "resume", prompt: PROMPTS.resume })
            }
            break
          }

          case "session.deleted": {
            const id = p.info?.id ?? p.sessionID
            if (id) {
              sessions.delete(id)
              permissionPending.delete(id)
              const hadMarker = persistedStops.delete(id) || offStore.map.delete(id)
              if (hadMarker) {
                stopStore.save()
                offStore.save()
              }
              knownTitles.delete(id)
              writtenTitles.delete(id)
              for (const k of dirAskCounts.keys()) {
                if (k.startsWith(`${id}|`)) dirAskCounts.delete(k)
              }
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

