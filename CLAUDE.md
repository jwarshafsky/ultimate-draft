# Ultimate Draft

Personal (single-user) draft + keeper tool for Jeff's 12-team ESPN keeper league
(5x5 roto: R/HR/RBI/SB/OBP + QS/K/SV+HLD/ERA/WHIP; $260 auction; 8 ML + 10 MiL
keepers). Vanilla JS, **no framework, no build step, no modules** — plain script
tags sharing ONE global scope. Hosted on GitHub Pages; deploying = pushing to main.

## Two conventions that fail silently if missed

1. **Cache busting** — every script/CSS tag in `index.html` carries `?v=NN`.
   After ANY js/css change, run `scripts/bump.sh` (stamps all tags to the commit
   count) before committing. A forgotten bump = users run stale code.
2. **One global namespace** — a duplicate top-level `function` shadows by load
   order; a duplicate `const` throws and disables that whole file. Run
   `scripts/check-globals.sh` after adding top-level names.

## Layout (load order matters — see index.html)

- `js/data/` — loaders. Supabase league data (`league-data.js`, tables:
  keeper_selections, callup_overrides, league_state, trades, roster_moves;
  realtime-subscribed), ROS projections (`ros-projections.js` — hosted CSVs
  under `projections/` auto-loaded unless a source is flagged `manual`), ESPN
  via the proxy (`espn.js`), League App rosters/contracts
  (`league-rosters.js` — fetched from jwarshafsky/the-league data.js, 12h cache),
  draft history, NFBC, Statcast, draft-dollar trades (published Google Sheet).
- `js/core/` — pure engines: `valuation.js` (player $), `inflation.js` (keeper
  inflation, budget-conserving tiered model), `standings.js` (roto math +
  Monte Carlo title odds), `mock-engine.js`/`mock-interactive.js` (auction sim).
- `js/features/` — one render function per tab (`renderX()` targets
  `#view-root`, rebuilt via innerHTML on each render; `rerender()` in app.js is
  rAF-coalesced). Biggest: `standings.js` (in-season analyzer), `mock.js`.
- `js/app.js` — shell: auth gate, tab routing (tab persisted in `location.hash`),
  startup loaders.
- `proxy/` — Cloudflare Worker (ESPN fetch + Claude API relay). Deploy:
  `cd proxy && wrangler deploy`.
- `scripts/fetch_ros_projections.py` — scheduled job that refreshes
  `projections/*.csv` + `manifest.json` from FanGraphs. ROS slugs only
  (`steamerr`, `rthebatx`, `ratcdc`) — plain full-season slugs must never be
  fallbacks. Keep slugs in sync with `FG_API_SLUG` in `js/data/ros-projections.js`.

## Working on it

- No tests. Verify with `node -c <file>` (syntax) + browser preview.
- `.agentreview-history.md` logs past review rounds — read it before
  re-reporting known issues.
- Jeff is non-technical: ship working, verified changes; explain in plain terms.
- Luxury-tax logic is deliberately out of scope for this tool (lives in The
  League App instead).
