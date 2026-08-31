# auto-resume.js

Resilience + unattended-autonomy plugin for OpenCode. Keeps your turn
alive when OpenCode's own internal retry gives up, rotates models
on free-tier failures, and walks the agent through an unattended
todo list.

**Install**: copy `auto-resume.js` to `~/.config/opencode/plugins/`.
Do NOT also keep a project-level copy — both copies would load and
double-fire every hook.

**Test**: `node --test tests/auto-resume.test.js` (35 tests).

**Version**: 1.16.0. See [CHANGELOG.md](./CHANGELOG.md) for what's
new and how to configure.

## Configuration

All env vars are optional. The plugin ships with sensible defaults
that work for most users.

```bash
# Master switches
export OPENCODE_RESUME_ENABLED=true
export OPENCODE_RESUME_AUTO_UPDATE=false   # off by default as of 1.15

# Aggression preset (1.15+)
export OPENCODE_RESUME_AGGRESSION=balanced   # conservative|balanced|relentless

# Numeric overrides (only set if you need to fine-tune past the preset)
export OPENCODE_RESUME_MAX_CHAIN=8
export OPENCODE_RESUME_MAX_STALL_TAKEOVERS=4

# Favorite-model rotation (1.16+)
export OPENCODE_RESUME_FAVORITE_RETURN=true
export OPENCODE_RESUME_FAVORITE_CHECK_AFTER_MS=300000
export OPENCODE_RESUME_FAVORITE_MIN_TURNS=3

# See the file header for ~40 more env vars (backoff, timeouts, permission
# autopilot, model rotation, etc.)
```

## What it does

- **Recovery** (subsystem 1): network/transport failures, 5xx, 408,
  truncated output, context overflow, empty responses, stalled
  streams, thinking-silence, internal retry loops, server/machine
  crashes. Honors Retry-After. Bounded per-task resume chain.
- **Model rotation** (subsystem 2): puts exhausted models on cooldown,
  picks the best available alternative by capability tier, rotates
  back to your favorite when the cooldown expires.
- **Permission autopilot** (subsystem 3): auto-approves safe
  permissions, rejects dangerous ones, answers directory-grant
  pop-ups so AFK runs never stall.
- **Task driver** (subsystem 4): nudges unfinished todos, debug
  nudges after repeated tool failures, answers the agent's own
  defer-to-user questions, runs self-improvement passes, wrap-up
  proposals.

## Safety rails

- Per-task resume chain cap (`OPENCODE_RESUME_MAX_CHAIN`, default 8)
- Per-task fast-lane stall cap (`OPENCODE_RESUME_MAX_STALL_TAKEOVERS`, default 4)
- Shared autopilot-nudge cap
- Task wall-clock budget
- Spin detection (no-progress watchdog)
- Circuit breaker with cool-down
- Incident-signature dedupe
- Idle-status check before every injection
- User "Stop" is fully respected — the plugin detects the stop,
  cancels everything queued, and stays quiet until the next prompt

## Testing

```bash
node --test tests/auto-resume.test.js
```

35 tests cover: AGGRESSION_PRESETS, PROMPTS.retry attempt ladder,
PROMPTS.proceedAll, QUESTION_PATTERNS coverage (including "which of
these / do all / draft a SPEC"), schedule() same-kind loop detector,
writeOnce() .tmp cleanup, AUTO_RESUME_VERSION, favorite-model
rotation env vars, re-entrancy guard, state-mutation order, and
lastModel cross-check.

## License

MIT (or whatever the upstream project uses). This file is part of
the neohiro ecosystem.
