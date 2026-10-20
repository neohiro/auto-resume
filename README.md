<div align="center">

# auto-resume <!-- version --> 2.1.7

**Self-healing OpenCode sessions · retries · model rotation · permission autopilot · quality loops**

[![Version](https://img.shields.io/badge/version-2.1.7-blue)](https://github.com/neohiro/auto-resume/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![OpenCode](https://img.shields.io/badge/plugin-opencode-black)](https://opencode.ai)

Install once. Prompt a big task. Go to sleep. Come back to completed, verified work.

</div>

---

## What it does (one line each)

- **Resilience** — heals transport failures, 5xx, 429, quota, truncated output, stalls, crashes, and restarts automatically
- **Model rotation** — switches to best healthy model when quota/rate-limit/failures persist (opt-in, never silent)
- **Permission autopilot** — safe-mode answers edits/web-fetches; rejects dangerous patterns (`rm -rf`, disk format, registry, pipe-to-shell) automatically; answers workspace-external directory grants
- **Task drive** — unfinished todos/checklists continue; stop-asking questions get answered; wrap-up proposes concrete follow-ups
- **Quality loop** — when the model declares done it reviews its own work for correctness/perf/security/robustness and implements safe improvements; when work is complete it pivots to optimization/UX/performance instead of stopping
- **Self-monitoring** — live title tag (`[auto-resume: 🟢 armed / 🔁 recovering / ⏸️ stopped / 🚫 paused]`); say `auto-resume off/on`
- **Self-updating** — checks GitHub daily; applies new releases on restart (acknowledged via OS notification)

---

## Install (one command)

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/neohiro/auto-resume/main/auto-resume.js \
  -o ~/.config/opencode/plugins/auto-resume.js
```

Windows (PowerShell):
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins" | Out-Null
Invoke-WebRequest "https://raw.githubusercontent.com/neohiro/auto-resume/main/auto-resume.js" `
  -OutFile "$env:USERPROFILE\.config\opencode\plugins\auto-resume.js"
```

Restart OpenCode. The plugin loads automatically — no extra dependencies.

---

## Why it exceeds industry standards

1. **No double prompts** — session-level error-synthesis lock (`sessionErrorSynthLock`) + recent-error guard (`lastErrorSynthAt`) + keyed dedupe (`retryErrKey`) prevent duplicate resume injections when both `session.step.failed` and `session.retry.scheduled` fire.
2. **No missed failures** — retry events carrying `payload.error` synthesize recovery once if `step.failed` never arrives; bounded `retryErrorSent` (max 256) prevents leaks.
3. **Encrypted sidecars** — set `OPENCODE_RESUME_ENCRYPTION_KEY`; all persistent markers (`.stopped.json`, `.off.json`, `.paused.json`, `.active.json`, `.health.json`) use AES-256-GCM. No plaintext session IDs on disk.
4. **Bounded state everywhere** — `messageCache` (512), `statusBySession` (64), `dirAskCounts` (1000), `sweepState` (64), `retryErrorSent` (256), `lastSeenBySession` (256). No unbounded growth.
5. **Defensive event adapter** — normalizes all V2 vocabulary (`session.step.*`, `session.text.*`, `session.retry.scheduled`, `session.permissions`, legacy names) into V1 engine shapes; drop noisy families (`skill.*`, `plugin.*`, etc.) before processing.
6. **Quality-first directives** — `AUTONOMY_DIRECTIVE` requires build/test/lint verification; improvement cycles pivot to optimization/UX when scoped work completes; wrap-up demands verified proof + follow-up proposals.
7. **Plugin registry manifest** — `plugin-manifest.json` declares `id`, `version`, `registry`, `update_url`, `min_opencode_version`, tags. Ready for marketplace integration.

---

## Configuration (env vars, all optional)

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_RESUME_ENABLED` | `true` | Master switch |
| `OPENCODE_RESUME_MAX_CHAIN` | `8` (balanced aggression) | Recovery attempts per task |
| `OPENCODE_RESUME_AUTONOMY` | `true` | Enable task driver (subs 3+4) |
| `OPENCODE_AUTOPILOT_PERMISSIONS` | `true` | Auto-answer safe permission prompts |
| `OPENCODE_AUTOPILOT_PROCEED` | `true` | Answer agent's own questions |
| `OPENCODE_AUTOPILOT_IMPROVE` | `true` | Self-improvement pass after done |
| `OPENCODE_RESUME_ROTATION_ENABLED` | `false` | Master switch for model rotation (never silent) |
| `OPENCODE_RESUME_ENCRYPTION_KEY` | — | AES-256-GCM encryption for sidecars |
| `OPENCODE_RESUME_AUTO_UPDATE` | `true` | Daily self-update check |

Full list in file header (lines 128–201).

---

## Security & privacy

- **Safe mode defaults** — dangerous commands rejected; external directory grants auto-answered only after denylist scan (`SENSITIVE_DIR_RES` covers Windows/Linux/macOS paths).
- **ReDoS protection** — extra deny regexes are screened against catastrophic backtracking (`DANGEROUS_REGEX_PATTERN`) before use.
- **Credential redaction** — error messages holding tokens/keys are redacted before writing to disk or console.
- **Encrypted persistence** — sidecars can be encrypted with `OPENCODE_RESUME_ENCRYPTION_KEY`. If not set, files stay local next to the plugin.

---

## Truth-check / facts

| Claim | Evidence |
|---|---|
| Recovers from interrupted turns | `handleError` schedules `resume`; `reanimate` revives on startup; `session.compacted` resumes after compaction |
| Answers permission prompts | `permission.updated` / `permission.asked` → `respondToPermission`; native V2 `ctx.permission.hook("evaluate")` also registered |
| Rotates models | `rotateAwayFrom` picks from catalog with tier ranking (`TIER_BONUS` / `TIER_PENALTY`); only when `rotationEnabled=true` |
| Resumes after restart | `startupActiveSnapshot` scanned; `reanimate()` revives recent session with `kind` derived from last assistant message |
| Prevents double prompts | `sessionErrorSynthLock` + `lastErrorSynthAt` 5s + `retryErrKey` dedup (v2.1.3) |
| Encrypts sidecars | `encryptPayload` / `decryptPayload` using AES-256-GCM (v2.1.5) |
| Registry manifest exists | `plugin-manifest.json` at repo root (v2.1.5) |

---

## Version history (compact)

- **2.1.7** — double-prompt race fixed (synchronous `dispatchClaims` claim, byte-identical text dedupe, bounded deferred retry); `scheduledKinds` timer-key leak fixed; `ReferenceError` in user-turn handler fixed; regression suite `tests/doubleprompt.mjs`; bounded-concurrency reanimate prefetch (8 workers, 15 s deadline)
- **2.1.5** — encrypted sidecars (AES-256-GCM); plugin registry manifest (`plugin-manifest.json`)
- **2.1.4** — improvement cycles pivot to optimization/UX when work complete; `propose` demands concrete payoff
- **2.1.3** — session-level error-synthesis lock stops double prompts; `sessionErrorSynthLock`
- **2.1.2** — package version sync for plugin list visibility
- **2.1.1** — fast retry schedule + bounded retry budget; duplicate incident dedupe improved
- **2.1.0** – rapid transient retry when rotation off
- **2.0.4** – credential redaction in error prompts
- **2.0.3** – redaction of provider error text
- **2.0.2** – honor provider-stated retry window
- **2.0.1** – rotation master control for auth/rotation
- **2.0.0** – complete OpenCode 2 migration

---

## Test coverage

<!-- coverage -->350+ assertions across 18 suites<!-- /coverage -->

---

## Licensing & contribution

MIT — see `LICENSE`. For bugs or feature requests: open issue at [neohiro/auto-resume](https://github.com/neohiro/auto-resume).

---

<div align="center"><b>Made to exceed expectations — not just meet them.</b></div>
