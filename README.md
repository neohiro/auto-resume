<div align="center">

# auto-resume

**Free AI coding agents that don't fall asleep on the job.**

Recovery · Model rotation · Permission autopilot · Task autonomy

</div>

---

OpenCode gives you free LLM coding agents — which is awesome. Unfortunately, compared to other agentic coding software, its sessions are **prone to interruptions**: one network hiccup, rate limit, provider outage or max-token cutoff and your carefully prompted task just… stops. You walk away expecting a finished product and come back to an error message.

**auto-resume makes OpenCode sessions effectively unkillable.** It sits quietly in the background of every session and:

- 🩹 **heals interruptions** — network failures, provider outages, timeouts, truncations, stalls, even crashed servers are recovered without you
- 🔁 **rotates models automatically** — free tier exhausted? Provider down? It moves your task to the strongest healthy model mid-conversation, no input needed
- ✅ **answers permission prompts** — safe-mode autopilot approves routine work and rejects anything dangerous while you're gone
- 🚀 **drives tasks to done** — unfinished todos get finished (including checklists the model writes in plain replies), "Continue to finalize.", "Remaining things to do:" and similar turn-endings actually continue, and the agent's own questions get answered
- 💎 **goes beyond done** — when the model declares victory, it's sent back to critique and improve its own work before you ever see it
- 🏷️ **shows itself** — engaged sessions carry a live `[auto-resume: 🟢 armed / 🔁 recovering / ⏸️ stopped / 🚫 paused]` tag behind the title; say `auto-resume off` to disable it for one session (title restored without a trace) and `auto-resume on` to re-arm
- 🔄 **updates itself** — checks GitHub daily and swaps in new releases automatically (one OpenCode restart to apply; opt-out available)

Install it once, prompt a big task, go to sleep. Come back to completed work.

This is what auto-resume is for.

---

`auto-resume` is a single-file OpenCode plugin that turns flaky, interruption-prone AI coding sessions into unattended ones. It hooks into OpenCode's event bus and keeps work alive whenever something dies — network blips, provider outages, free-tier limits, max-token truncations, stalled streams, permission prompts, unfinished todo lists — and then goes one step further: it makes the model **critique and improve its own finished work**.

## What it does

### 1 — Recovery *(always on)*
| Failure | Automatic response |
|---|---|
| Network / transport errors (`ECONNRESET`, `fetch failed`, DNS, TLS…) | Exponential backoff + jitter, re-injects a continuation prompt |
| Provider outages (5xx, 529 overloaded, gateway errors) | Same, with model rotation after repeated rounds (see below) |
| Rate limits (429) | Honors `Retry-After`; rotates models on repeated strikes |
| Free-tier / quota exhaustion (`402`, "free usage exceeded", …) | **Rotates to another model instantly — no user input** |
| Truncated output (`MessageOutputLengthError`) | Seamless *"continue exactly where you stopped"* nudge |
| Context-window overflow | Triggers compaction, resumes automatically afterwards |
| Empty responses | Re-nudges once |
| Silently stalled streams (busy but no events) | Aborts + restarts the turn |
| Quiet-but-running tools (builds, test suites) | Extended grace window (×4) before any stall verdict |
| Internal retry loops that never end (huge provider `Retry-After` values) | Taken over: aborted and resumed on the plugin's own schedule |
| Client restarts / server crashes mid-task | On startup, recently-interrupted sessions ("Interrupted") are **re-animated** automatically — a restart is never mistaken for a Stop |
| Subagent sessions | Left alone — their parent orchestrator owns them |
| User aborts (**Stop**) | Detected — everything queued is cancelled and automation stays fully quiet until your next prompt |
| Auth errors | Surfaced — never hammered |

### 2 — Model rotation
Anything **model-specific** that keeps failing moves your session elsewhere:

- Exhausted quota → old model gets a cooldown, session continues on the best alternative
- Repeated 429s or persistent network/5xx waves on one model → rotation too
- Selection ranking:
  1. Your preferred chain via `OPENCODE_RESUME_FALLBACK_MODELS`
  2. Strongest sibling of the current provider
  3. Best model of other installed providers
- Candidates are ranked by **capability tier**: `max`/`ultra`/`opus`/`pro`/`high` variants beat `mini`/`nano`/`lite`/`flash`. Non-chat endpoints (embeddings, TTS, image) are filtered out.
- The conversation continues seamlessly — same session, same context, new engine.

### 3 — Permission autopilot
Never comes back from lunch to a session stuck on *"Allow bash command?"*:

- **Safe mode** (default): edits & web fetches approved; shell commands approved *unless* they match a danger blocklist (`rm -rf`, force-push, disk formatting, pipe-to-shell, registry edits…). Matched commands are **rejected** so the agent adapts instead of hanging.
- Unknown permission types stay human-decided in safe mode; `all` mode approves everything.

### 4 — Task driver ("beyond expectations")
The walk-away loop:

1. **Todo drive** — session idles with unfinished todos → nudged to continue (spin-detection stops pointless loops)
2. **Debug nudge** — 3 consecutive failed tool calls → *"diagnose the root cause first"*
3. **Auto-proceed** — agent ends its turn by asking *"Should I proceed…?"* → the plugin answers yes and keeps it moving (capped)
4. **Autonomy directive** — every injected prompt tells the model to decide things itself, never wait for confirmation, document assumptions
5. **Self-improvement passes** — when the model declares the task done, it's told to critically review its own output (correctness, performance, security, robustness, readability) and implement the improvements it's confident about — capped number of cycles
6. **Wrap-up** — final message summarizes what was accomplished plus up to three follow-up proposals, success toast included

## Install

**Easiest: just ask your agent.** You are already talking to an AI with full shell access - let it do the work. Paste this into OpenCode:

```text
Install the auto-resume plugin from https://github.com/neohiro/auto-resume
into my global plugins folder (~/.config/opencode/plugins/) so every
session gets it machine-wide.
```

The agent downloads the single file, puts it in place, and tells you when it is done - restart OpenCode and you are protected. (Yes, auto-resume can help install the thing that will keep auto-resume sessions alive. It appreciates the irony.)


**Option A — one file (recommended):**

Windows PowerShell:
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins" | Out-Null
Invoke-WebRequest "https://raw.githubusercontent.com/neohiro/auto-resume/main/auto-resume.js" -OutFile "$env:USERPROFILE\.config\opencode\plugins\auto-resume.js"
```

macOS / Linux:
```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/neohiro/auto-resume/main/auto-resume.js \
  -o ~/.config/opencode/plugins/auto-resume.js
```

Restart OpenCode. Done.

> ⚠️ Install it in **one place only** — global (`~/.config/opencode/plugins/`) *or* project (`.opencode/plugins/`). Both copies would load and double-fire every hook.

**Option B — clone:**
```sh
git clone https://github.com/neohiro/auto-resume ~/.config/opencode/plugins/auto-resume
```
(OpenCode loads plugin files from the directory root.)

## Configuration

Everything is env vars with sensible defaults. Set them globally or per shell.

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_RESUME_ENABLED` | `true` | Master switch |
| `OPENCODE_RESUME_MAX_CHAIN` | `6` | Max recovery resumes per task |
| `OPENCODE_RESUME_BASE_DELAY_MS` | `5000` | Backoff base |
| `OPENCODE_RESUME_MAX_DELAY_MS` | `120000` | Backoff cap |
| `OPENCODE_RESUME_RATE_LIMIT_BASE_MS` | `20000` | Backoff base for 429s |
| `OPENCODE_RESUME_OUTPUT_LENGTH_MAX` | `3` | Truncation continue-nudges |
| `OPENCODE_RESUME_STALL_TIMEOUT_MS` | `240000` | Busy-without-events ⇒ stalled |
| `OPENCODE_RESUME_WATCHDOG_MS` | `10000` | Stall check interval |
| `OPENCODE_RESUME_RUNNING_TOOL_FACTOR` | `4` | Stall grace multiplier while a tool is running |
| `OPENCODE_RESUME_RETRY_TAKEOVER_MS` | `900000` | Max time in OpenCode's internal retry loop before takeover |
| `OPENCODE_RESUME_RETRY_FUTURE_CAP_MS` | `600000` | Next-retry scheduled further out ⇒ takeover |
| `OPENCODE_RESUME_REANIMATE` | `true` | Revive crashed sessions on startup |
| `OPENCODE_RESUME_REANIMATE_WINDOW_MS` | `600000` | Max age of sessions eligible for revival |
| `OPENCODE_RESUME_AUTO_UPDATE` | `true` | Self-update daily from GitHub (applies on next OpenCode restart) |
| `OPENCODE_RESUME_STOPSTORE` | `<plugin>/auto-resume.js.stopped.json` | Where user-stop markers are persisted across restarts |
| `OPENCODE_RESUME_OFFSTORE` | `<plugin>/auto-resume.js.off.json` | Where per-session opt-outs (`auto-resume off`) are persisted |
| `OPENCODE_RESUME_BREAKER_THRESHOLD` / `_WINDOW_MS` / `_COOLDOWN_MS` | `6` / `900000` / `300000` | Global circuit breaker |
| `OPENCODE_RESUME_COMPACT_ON_OVERFLOW` | `true` | Summarize + resume on overflow |
| `OPENCODE_RESUME_SWITCH_ON_QUOTA` | `true` | Rotate on free-tier exhaustion |
| `OPENCODE_RESUME_SWITCH_ON_RATELIMIT` | `true` | Rotate on repeated 429s |
| `OPENCODE_RESUME_SWITCH_ON_FAILURES` | `true` | Rotate on persistent network/5xx failures |
| `OPENCODE_RESUME_RL_SWITCH_AFTER` | `2` | 429s before rotating |
| `OPENCODE_RESUME_ROTATE_AFTER_FAILURES` | `3` | Failed rounds before rotating |
| `OPENCODE_RESUME_MAX_ROTATIONS` | `3` | Model rotations per task |
| `OPENCODE_RESUME_MODEL_COOLDOWN_MS` | `3600000` | Exhausted-model pause |
| `OPENCODE_RESUME_FALLBACK_MODELS` | *(auto-discover)* | Preferred chain, e.g. `"anthropic/claude-opus-4-1,openai/gpt-5"` |
| `OPENCODE_RESUME_AUTONOMY` | `true` | Master switch for subsystems 3+4 |
| `OPENCODE_AUTOPILOT_PERMISSIONS` | `true` | Auto-answer permission prompts |
| `OPENCODE_AUTOPILOT_PERMISSION_MODE` | `safe` | `safe` \| `all` |
| `OPENCODE_AUTOPILOT_EXTRA_DENY` | *(empty)* | Extra deny substrings, comma-separated (`re:` prefix = regex) |
| `OPENCODE_AUTOPILOT_TODO_DRIVE` | `true` | Continue unfinished todos |
| `OPENCODE_AUTOPILOT_DEBUG_NUDGE` | `true` | Root-cause nudge after tool failures |
| `OPENCODE_AUTOPILOT_IMPROVE` | `true` | Self-improvement pass after completion |
| `OPENCODE_AUTOPILOT_IMPROVE_CYCLES` | `2` | Max improvement cycles |
| `OPENCODE_AUTOPILOT_PROPOSALS` | `true` | Wrap-up proposals message |
| `OPENCODE_AUTOPILOT_PROCEED` | `true` | Answer the agent's own questions and continue |
| `OPENCODE_AUTOPILOT_MAX_PROCEEDS` | `3` | Self-answered questions per task |
| `OPENCODE_AUTOPILOT_MAX_NUDGES` | `25` | Self-driven nudges per task |
| `OPENCODE_AUTOPILOT_BUDGET_MS` | `28800000` (8h) | Wall-clock budget per task (`0` = off) |

## Safety rails

- **User Stop is absolute**: hitting Stop cancels every queued injection and pauses recovery, todo-drive, auto-proceed, improvement passes, proposals *and* permission autopilot until you send the next prompt — and the stop is **remembered across restarts** (small JSON sidecar file), so a stopped session is never automatically revived
- **Per-session kill switch**: `auto-resume off` in chat disables everything for that session only (survives restarts; title restored with no trace) — `auto-resume on` re-arms. On-by-default everywhere else: install and go
- Per-task resume chain cap, reset by any real user message or clean completion
- Shared autopilot nudge budget + wall-clock budget per task
- Spin detection (todo drive stops when nothing progresses)
- Incident-signature dedupe (one failure never double-triggers)
- Idle-status check immediately before every injection
- Global circuit breaker with cool-down during full outages
- Rotation caps prevent endless provider hopping
- Every injected prompt is tagged `[auto-resume]` so automation is always visible in chat
- Dangerous shell commands are rejected, not silently approved

## Compatibility

Works anywhere OpenCode runs — **Windows, macOS, Linux**. The plugin is a single zero-dependency file using only the OpenCode SDK client, timers, and environment variables, plus the tiny local files it manages itself: the self-update backup, the user-stop memory (`auto-resume.js.stopped.json`), and the per-session opt-out memory (`auto-resume.js.off.json`). Requires Node ≥ 18 semantics (Bun, which runs OpenCode, exceeds this).

Tested against OpenCode's event API: `session.error`, `session.status`, `session.idle`, `message.updated`, `message.part.updated`, `todo.updated`, `permission.updated/replied`, `session.compacted`.

## Development

```sh
git clone https://github.com/neohiro/auto-resume && cd auto-resume
npm test        # 46 assertions across 4 suites, mocked SDK, no OpenCode needed
```

The five suites (60+ assertions) simulate full failure scenarios (outages, quota walls, stalls, permission storms, todo loops) against a mocked client and assert on every injected prompt, abort, permission response, and toast.

## License

[MIT](LICENSE)

