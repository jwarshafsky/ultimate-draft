# Live Draft 2027 — Redesign & Intelligence Build Plan

**Status:** PLANNED (Jul 3 2026) — open questions for Jeff at the bottom; answers may reshape scope.
**Origin:** Jeff's feature brainstorm (bid database, UI redo, on-the-clock card, projected
standings, strategy input, nomination goals, endgame optimizer, cold-room detector).
**Read first:** `strategy-north-star.md` (feature philosophy), `project_ultimate_draft.md`
memory (extension pipe facts). `live-draft-sync-plan.md` is SUPERSEDED (the Durable Object
relay was the wrong path; the Keeper Edge in-tab WebSocket hook is proven).

---

## The one finding that shapes everything

The Keeper Edge capture script already sees **every draft-room event live, in plain text**:
`NOMINATION <teamId> <n>`, `BID <teamId> <playerId> <amount> <budget?> <timeLeftMs>`,
`BID_ACK`, `PASSED`, `SOLD <teamId> <playerId> <seq> <price> <flag>` — but today it only
keeps SOLD and console-logs the rest (`draft-socket-capture.js:57-58`).

Forwarding the full stream with timestamps is mostly plumbing, and it is the shared
foundation for FOUR of the requested features:
1. **Bid/tendency database** — who bid, when, how much, increments, nomination order.
2. **Auto "on the clock" card** — NOMINATION tells us who's up without Jeff typing anything.
3. **Live bid ticker** — BID frames show the war in progress (who's in, price climbing).
4. **Cold-room detector** — bid cadence + distinct-bidder count are exactly what's needed.

So Phase 1 (capture) unlocks everything else and must land before any mock draft, so every
mock from now on gets recorded.

---

## Phase 1 — Full event capture + sync reliability (FIRST; before next mock)

### 1a. Capture the full stream
- `draft-socket-capture.js`: postMessage ALL commands (NOMINATION, BID, BID_ACK, PASSED,
  SOLD, INIT), each stamped `capturedAt: Date.now()`. Keep CLOCK ignored (flood).
- `draft-bridge.js`: new cumulative `udDraftEvents` store in chrome.storage.local
  (append-only event log: `{cmd, teamId, playerId, amount, ts, seq}`), alongside the
  existing `udDraftFeed` (SOLD-only; unchanged so the current pick pipeline can't break).
  Handle storage quota: chrome.storage.local is 10MB by default — a full auction is a few
  thousand events, fine, but cap + rotate defensively.
- `ud-bridge.js` + draft.js: forward events to the app; app keeps an in-memory event log
  driving the new UI, and mirrors to localStorage (`ud_draft_events_v1`) as backup.

### 1b. Persist to Supabase (the permanent database)
New tables in the existing Supabase project (fbllfkrtjsihrkwnbmlw):
- `draft_sessions` — one row per draft/mock: `{id, league_id, sport, season, started_at,
  is_mock, label}`.
- `draft_events` — raw stream: `{session_id, seq, cmd, espn_team_id, espn_player_id,
  amount, captured_at, raw}`. Insert in small batches from the app tab (already
  authed to Supabase); don't block the UI on writes.
- `draft_picks` — normalized SOLD results (player name resolved, owner mapped) for easy
  querying; written post-hoc from events, or live.
- RLS: same Jeff-only allowlist pattern as existing tables.
- Post-draft analytics (owner tendencies, nomination patterns) run OFF this data in later
  sessions — per Jeff: **collect only in year 1, no speculation; evaluate after the draft.**

### 1c. Sync dropout — diagnose and harden
Known suspects from the code map (mock reported "stopped syncing"):
- Dedup is by playerId forever (`draft-bridge.js` `seen{}`) — an undone/re-auctioned pick
  is silently swallowed. Handle pick-undo (watch for whatever frame ESPN sends on undo —
  capture it in the next mock; the event log makes this diagnosable).
- No staleness/watchdog: if the chrome.storage handoff or postMessage chain dies, the app
  shows nothing. Add a **watchdog chip**: seconds since last event (any cmd — CLOCK counts
  as liveness even though we don't store it), red state + alert if silent >30s while the
  ESPN tab heartbeat is alive (that combination = pipe broken, not draft paused).
- INIT backfill already self-heals reconnects (proven 7/7). Extend: on Real-mode enable,
  reconcile app picks against the full INIT state, not just merge-new.
- **Black-box recorder:** raw frames ring-buffer (last ~500) in chrome.storage, dumpable
  from the app's diagnostics panel — so ANY future dropout can be diagnosed after the fact.
- Test protocol: run an ESPN mock with the event log open; kill/reload each link in the
  chain (ESPN tab reload, app reload, extension reload) and verify self-heal.

**Gate:** a full ESPN mock auction produces a complete, gap-free event log in Supabase and
the SOLD pipeline never desyncs (or visibly alarms when it does).

## Phase 2 — UI overhaul: Draft Mode

A dedicated fullscreen layout (hide app tabs/topbar; `location.hash` route so reload-safe;
Esc or button to exit). Layout top-to-bottom:

1. **On the Clock card (top, prime real estate)** — driven by NOMINATION events (manual
   typeahead remains as a collapsed fallback — non-negotiable safety net if sync dies).
   Shows: player, pos, age/team; **model $ / inflation-adjusted $ / NFBC Avg (Min–Max)**;
   projected stat line; injury flag (ESPN kona injury status); live bid ticker (who's
   bidding, current high, increments); **AI recommended bid** (walk-away + stretch, with
   one-line rationale); "who else wants him" (roster-fit/budget-based year 1, history-based
   later); **room-temperature indicator** (cold/normal/hot — see Phase 3); tier context
   ("2nd of 4 tier-2 SS left").
2. **Status strip (thin):** connection/watchdog chips (extension, ESPN tab, feed age,
   Supabase), inflation badge, my budget/max bid — the stuff that used to hog the top.
3. **Main pane: Available players** — toggle Positions / Hitters / Pitchers / BPA
   (BPA = best-available split hitters|pitchers side by side); columns: model $, inflated $,
   NFBC $, market−model delta, fit badge; sortable; search. **Fit badge is computed locally**
   (roster needs + category needs + strategy + targets) so it's instant for all rows; AI
   commentary reserved for the on-the-clock player (per-player Claude calls are too slow).
4. **Side pane (tabbed):** Projected Standings / Nominations / Strategy brief / My roster.
5. **Bottom (collapsed):** pick tracker (recent picks, revert), diagnostics.

Keep: team strip, endgame panel (auto-appears), category pace. This is a rewrite of
`renderDraft()`'s layout, reusing the existing engines.

## Phase 3 — Intelligence layer

- **Projected standings (live):** for each team, project the final roster = current roster
  (keepers + picks so far) + open slots filled from the remaining pool, where each team's
  share of remaining talent scales with remaining $/slot (greedy allocation at current
  inflation, respecting position needs). Feed rosters through the existing roto engine
  (`standings.js` / `computeMockStandings` pattern). Re-render per pick. Surface "you're
  projected 4th; +X in SB moves you to 2nd" — this drives the recommended bid.
- **AI recommended bid:** deterministic core (value × inflation, category marginal worth
  from projected standings, scarcity/tier cliff, opponent max-bid leverage from
  `computeLiveTeamStates`) + Claude for the judgment layer & rationale. Encodes north-star
  live tactics: round-number breaks ($21 to beat the $20 wall), Shutdown/Squeeze awareness,
  price-enforcement risk.
- **Strategy input:** pre-draft strategy page — structured (punt/target categories, stance
  sliders — mostly exists in Settings `myStrategy`; add per-player target list w/ max
  prices, budget plan by roster area) + **free-text strategy**. Free text gets condensed
  once into a "strategy brief" injected into every AI call (`buildAiContext`). Draft-mode
  side pane shows the brief + adherence ("plan: ≤$40 on C+MI; actual: $37").
- **Nomination suggester v2** (`nominations.js` exists: target/dump/drain): add explicit
  goal selector — Get my guy / Drain a rival ($ or position) / Start a run / Dump an
  overvalued name (NFBC delta ≥ +$5 over model) / Burn clock. Opponent-need-aware drain
  picks (north-star gap #4).
- **Endgame optimizer v2** (`endgame.js` exists): from remaining targets + all teams'
  max bids/slots, sequence nominations & bids to land targets ("nominate X now — only two
  teams can pay >$3"); flag uncontested high-value leftovers.
- **Cold-room detector:** heuristics year 1 — seconds since last BID, distinct bidders,
  bid-increment pattern, price vs NFBC floor. "Room reads cold on this player" cue on the
  on-the-clock card. Calibrate against recorded mock/draft data later (that's the
  database's job).

## Phase 4 — Rehearse, harden, learn

- Dress-rehearsal mocks in Draft Mode end-to-end (ESPN mock + extension + Supabase).
- Pre-draft checklist panel: projections fresh? NFBC imported (date)? proxy key? extension
  heartbeat? Supabase reachable? strategy brief written?
- Post-draft debrief report (auto): every pick vs model/NFBC, surplus by team, what the
  recommended bid would've said, room-temperature accuracy, nomination-pattern first look.
- After the real 2027 draft: owner-tendency analytics on the collected data (nomination
  strategy per owner, bid-increment habits, position/stat overpays, targets telegraphed).

---

## Jeff's answers (Jul 4 2026) — locked in

1. **Draft & mocks:** yes — real draft ~March 2027, and Jeff will run ESPN baseball mocks
   to test capture and rehearse. Phase 1 ships before the next mock.
2. **Past drafts:** yes — import prior seasons' ESPN draft results to seed owner profiles,
   AND do the owner-tendency interview (Jeff-supplied hints, labeled as such).
3. **Screens:** same computer, separate monitors — **optimize Draft Mode for an ultrawide
   monitor** (wide multi-column layout is the design target, not a laptop squeeze).
4. **Recommended bid:** walk-away + stretch price with a one-line rationale. Confirmed.
5. **NFBC:** market-temperature treatment confirmed (own column + delta, never blended).
   Jeff may supply better market data later — keep the market-data layer source-agnostic.
6. **Injury:** ESPN status flag + news headlines + a short AI estimate of when the player
   is expected back.

**Commissioner pick-undos (new requirement):** ESPN drafts can have picks undone by the
commissioner mid-draft. Auto-detect where possible (capture whatever frame ESPN sends on
undo during mocks — the full event log makes this discoverable; INIT-state reconciliation
on reconnect catches it too), and regardless: the pick history must let Jeff **delete any
individual pick manually**, with the deletion remembered so the feed doesn't re-add it
(tombstone by playerId+seq; a later re-auction of the same player IS accepted).

## Non-negotiables carried forward
- Manual pick entry + nomination typeahead stay working as the fallback path.
- Mock-bot bidding data must be segregated (`is_mock`) — never let bot behavior contaminate
  human tendency profiles.
- New localStorage keys → `SYNC_EXACT_KEYS` (CLAUDE.md convention #3); bump `?v=` via
  `scripts/bump.sh`; check globals.
