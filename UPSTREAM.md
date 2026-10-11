# Upstream pin

- Upstream: https://github.com/openclaw/openclaw (MIT, OpenClaw Foundation)
- Fork: https://github.com/CommanderMD/mobyd
- Pinned release: **v2026.10.1** (published 2026-10-10)
- Work branch: `mobyd` (cut from the tag). `main` tracks upstream and is never edited directly.

## Rules

- OpenClaw core stays untouched. MOBY-D code lives in `mobyd/nemo/` (the head), `extensions/` (the limbs), `policy/`, `db/`, `docs/`, and one isolated `branding/` patch set.
- Monthly, or on any upstream security release: `git fetch upstream --tags && git merge <new-tag>` on `mobyd`, then update the pin above.
- LICENSE and copyright notices from upstream are kept as-is.
