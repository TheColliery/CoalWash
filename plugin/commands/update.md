---
description: CoalWash self-update — check for a newer version and offer to apply it, or set how updates are handled.
---

Kind-1 self-update — the **agent** verifies (online), the **hook** only schedules (it never networks). If git/network is unavailable, say so and suggest updating manually later (never assume either exists).

1. **Check.** Web-check the latest published CoalWash tag (any means available — the GitHub releases/tags page or API) vs the installed `version` in `.claude-plugin/plugin.json`.
2. **Offer (consent-gated — the only token spend).** Newer available → OFFER `claude plugin update coalwash@coalwash` (then restart); on a file-copy install, offer to re-copy the updated files instead. Already current → say so in one line.
3. **Cadence.** To change how updates are handled, set `updateMode` (`ask` | `auto` | `remind` | `off`) and `updateCheckDays` in `.coalwash.json`. `auto` lets this check run when due without re-asking; `off` silences it entirely.

Security note: CoalWash mutates memory — fidelity/safety fixes matter more than cosmetics here; still, this never auto-applies. It offers, the user runs the update.
