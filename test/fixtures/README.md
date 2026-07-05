# Test fixtures — recorded reality

Fixtures are the app's **"Download event log" JSON exports** taken from real ESPN mocks (the button in Live Draft ▸ Diagnostics ▸ ⬇ Download event log).

Naming convention: `YYYY-MM-DD-league<id>.json` (e.g. `2026-08-14-league778421.json`).

Replaying a fixture's `events` through the real pipeline must reproduce its exact final pick list.

Every mock Jeff runs adds a fixture; **every future bug gets a fixture/case here BEFORE its fix lands** (regression discipline — `scripts/test.sh` must stay green).
