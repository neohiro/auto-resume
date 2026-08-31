# auto-resume.js — changelog

User-relevant changes, newest first. See git log for full history.

## v1.16.0 — 2026-08-31

**Favorite-model rotation** — when auto-rotate moves you off your favorite
model (free-tier outage, quota hit, auth failure, rate-limit storm), the
plugin now rotates BACK once the cooldown has expired and the alternate
has proven stable.

New env vars (all optional, conservative defaults):

- `OPENCODE_RESUME_FAVORITE_RETURN` — master switch (default `true`)
- `OPENCODE_RESUME_FAVORITE_CHECK_AFTER_MS` — min time on alternate
  before attempting to go back (default `300_000` = 5 min)
- `OPENCODE_RESUME_FAVORITE_MIN_TURNS` — successful turns on alternate
  required before rotating back (default `3`)

The user's manually-chosen model is the source of truth. Auto-rotate
away is a temporary detour, not a permanent downgrade. Implementation
includes a re-entrancy guard (`favoriteSwapInFlight`) to prevent two
concurrent watchdog ticks from double-calling the model-swap API.

## v1.15.0 — 2026-08-31

**3-state aggression preset** — one-word env var replaces the
two-knob interaction:

- `OPENCODE_RESUME_AGGRESSION=conservative` — (maxChain=6, maxStallTakeovers=2), the old hard cap
- `OPENCODE_RESUME_AGGRESSION=balanced` (default) — (maxChain=8, maxStallTakeovers=4)
- `OPENCODE_RESUME_AGGRESSION=relentless` — (maxChain=12, maxStallTakeovers=8), full headroom for unattended free-tier runs

Numeric env vars (`OPENCODE_RESUME_MAX_CHAIN`,
`OPENCODE_RESUME_MAX_STALL_TAKEOVERS`) override the preset when both
are set.

**Intelligent retry prompts** — `PROMPTS.retry` tightens at attempt 4+:
no more redundant 4-sentence preamble on the 5th retry.

**Proposal-list nudge** — when the model ends its turn with "Which of
these do you want me to tackle first?" / "draft a SPEC for X" / "do all
of them", the plugin injects a stronger `proceedAll` prompt that
executes every proposal end-to-end, step-by-step, unattended. No more
getting stuck after a defer-to-user question.

**Same-kind loop detector** — if the plugin schedules the same
recovery kind twice in a row with no progress, it escalates to the
generic `debug` prompt instead of repeating the same injection.

**Expanded question patterns** — now catches "tackle first", "do all",
"draft a spec", "should I start with", "go for the most impactful",
"which approach", etc. — any defer-to-user phrasing.

**`.tmp` cleanup fixed** — `writeOnce()` and the self-updater both
wrap the rename path in `try/finally { unlink(tmp) }`, preventing
the unique-suffix `.tmp` files from accumulating forever on Windows.

**Self-updater disabled by default** — `OPENCODE_RESUME_AUTO_UPDATE` now
defaults to `false`. The self-updater overwrote a local v1.16.0 install
with the upstream v1.13.17, which would have been silent regression.
Set `OPENCODE_RESUME_AUTO_UPDATE=true` to opt back in once the
upstream catches up.

## v1.14.0 — 2026-08-31

**`OPENCODE_RESUME_MAX_STALL_TAKEOVERS` configurable** (default 4) —
replaces the hardcoded `stallResumes >= 2` cap that forced babysitting
on long free-tier stalls once the model hit retry #3. The new cap is
orthogonal to `OPENCODE_RESUME_MAX_CHAIN`: chain is the aggregate
budget, maxStallTakeovers is the fast-lane-only budget. Both must
allow a retry.

## v1.13.x and earlier

Pre-1.14. See git log.
