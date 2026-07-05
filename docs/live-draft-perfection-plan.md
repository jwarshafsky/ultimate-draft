# Live Draft Perfection Plan — eliminate all material bugs before March 2027

**Status:** APPROVED PLAN, execution not started. Author context: written after
agentreview Round 4 (2026-07-04) found 17 bugs, 11 must-fix — see
`.agentreview-history.md`. Audience: Opus 4.8 agents executing in future
sessions; every phase is a self-contained work order. Jeff is non-technical:
report outcomes in plain terms, ship verified changes only.

## Why this plan is shaped this way

Round 4's bugs were not random. They cluster into four families:

1. **Cross-boundary state** — extension ↔ chrome.storage ↔ app ↔ Supabase
   (stale feeds presenting as live, same-league re-drafts swallowed, seq reuse).
2. **Mode/context contamination** — real-league names/budgets/keepers leaking
   into mocks (picks attributed to real owners, hidden pool).
3. **Rebuilt-DOM wiring** — innerHTML rebuilds + hand-wired listeners (dead
   buttons in some views, typing eaten by background re-renders).
4. **Time & lifecycle** — reloads, hidden-tab throttling, pauses, crashes
   (name-map poisoning, watchdog false alarms, blank hero during pauses).

All were found by agents *reading* code. None would have survived a harness
that *executes* the pipeline against recorded reality. Reviews alone plateau;
the durable fix is: **spec → executable verification → adversarial rounds that
must PROVE findings → live-fire acceptance against ESPN's own data → regression
discipline.** One real draft a year means the harness, not the draft, has to be
where bugs die.

**Definition of "material bug":** anything that on draft day could (a) lose or
mis-attribute a pick, (b) show a wrong number Jeff might act on (budget, max
bid, inflation, value), (c) silently stop capturing, or (d) require more than
one click to recover from. Cosmetics are not material.

---

## Phase 0 — Ground truth: the Live Draft SPEC (1 agent, ~1 session)

You cannot certify "no material bugs" against an undefined "correct."

**Work order:** Read `docs/live-draft-2027-plan.md`, `.agentreview-history.md`,
`CLAUDE.md`, the project memory file, and the Live Draft code (files listed in
Appendix A). Produce `docs/live-draft-spec.md`: every intended behavior as a
numbered, TESTABLE statement. Cover at minimum:

- **Modes:** off / test / real — exactly what each accepts, shows, uploads.
  Real = league 1200 only. Test = generic Team-N, $260, no keepers, full pool,
  `ud_test_my_team` selects "me". Real-league data appears in test mode NOWHERE.
- **Keeper source of truth:** the Keepers tab ONLY (Jeff, 2026-07-04): checked
  major keeper = ML slot at cost; checked MiL keeper = stashed, $0, no slot,
  not auctionable; anyone unchecked is draftable. No league-roster fallbacks.
- **Feed lifecycle:** what opens/rotates/clears a capture; staleness (>15 min +
  no tab = "Last capture", never "Live"); same-league re-draft rotation; the
  clearFeed round trip; INIT backfill and reconciliation semantics.
- **Pick integrity:** dedup by playerId+lot-seq; re-sale replaces; tombstone
  rules (seq / negative-timestamp); commissioner-undo flows (auto suspects +
  manual ✕); manual entry parity.
- **Money/pool invariants** (the heart of the spec — see Phase 1 checker).
- **Supabase mirror:** session identity (leagueId+startedAt), idempotent
  upserts, watermark, is_mock rules, offline behavior.
- **UI contracts:** three views (Setup lobby / Draft Mode / manual fallback),
  which controls exist where, what updates in place vs re-renders, what user
  input must never be lost, Esc semantics.
- **Failure behavior:** for each link in the chain dying (extension, ESPN tab,
  app tab, proxy, Supabase, Rotowire/Claude), what the user sees and the
  recovery path (must be ≤1 click or automatic).

**Gate:** Jeff reads the spec (plain-language summary at top) and corrects it.
Every later phase cites spec numbers. Findings that contradict the spec are
bugs; behaviors the spec missed get added to it first.

## Phase 1 — Executable verification (2–3 agents, ~2 sessions) ← the force multiplier

Build the machinery that turns "an agent claims X" into "a script proves X."
Seeds already exist: the scratchpad harnesses from 2026-07-04 (extension
pipeline stub, ud-bridge delta test) — promote them into the repo.

**1a. `test/` harness (node, no framework).** `scripts/test.sh` runs everything;
    each file is plain node with tiny assert helpers (repo convention: no deps).
   - `test/ext-pipeline.test.js` — stub `window`/`chrome.storage`/`location`,
     load the real `draft-socket-capture.js` + `draft-bridge.js` + `ud-bridge.js`
     (eval), drive frames, assert storage/postMessage outcomes. Cases: dedup,
     re-sale replace, INIT backfill, same-league re-draft rotation, seq bump on
     restore, pagehide flush, clearFeed non-resurrection, delta forwarding.
   - `test/app-engines.test.js` — stub the data globals, load the real engine
     files, assert: exclusions (keeper-tab-only, test-mode empty), inflation
     math, computeLiveTeamStates (real + test), tombstone matrix (seq match /
     seq differ / negative-ts before/after), lot detection (interleaved SOLD,
     INIT boundary, idle vs ended), recommendBid caps, config save/load.
   - `test/fixtures/` — **recorded reality**: raw frame logs exported from real
     mocks (the app's "Download event log" JSON). Every mock Jeff runs adds a
     fixture. Replaying fixtures through the pipeline must reproduce the exact
     final pick list.
   - **Convention (add to CLAUDE.md):** every bug found from now on gets a
     failing fixture/case BEFORE the fix; `scripts/test.sh` must pass before
     any push.

**1b. Invariant checker (runs in-app + in tests).** `js/core/invariants.js`,
    `checkDraftInvariants()` returning violations; surfaced in the feed
    diagnostics panel (draft day = continuous self-audit) and asserted after
    every simulated pick in tests:
   - **Money:** Σ(team budgets) + Σ(spent) + Σ(keeper costs) = Σ(260 + adj)
     per mode; every maxBid = budget − (slotsRemaining − 1); no negatives.
   - **Pool:** drafted ∪ excluded ∪ available partitions getValues(); nobody in
     two sets; picks count ≤ teams × rosterSize.
   - **Feed:** event seqs strictly increasing per session; every SOLD in the
     event log ↔ exactly one pick (or a tombstone); no pick without a source.
   - **Mode:** in test mode, NO output object anywhere contains a real owner id
     or name (scan states/labels/AI context for the 12 known owner strings).
   - **UI:** no duplicate DOM ids after each render of each view.

**1c. Draft simulator.** `test/simulate-draft.js` — generates a full synthetic
    auction as a frame script (≈300 lots; configurable seed events: undo mid
    -draft, re-nomination, reconnect INIT mid-stream, 20-min pause, duplicate
    frames, unknown commands, hidden-tab flush delays, app reload at pick N,
    extension reload at pick M, same-league second draft). Replays through the
    REAL pipeline (headless for the extension half; preview browser for the app
    half via the /tmp mirror + `preview_*` tools). Asserts fixtures' final state
    + all invariants after every event. This is the acceptance machine — "the
    simulator passes with all chaos flags on" is the phase gate.

**Gate:** `scripts/test.sh` green; simulator green with chaos on; every Round-4
bug reproduced as a now-passing case (regression-proofing the past).

## Phase 2 — Adversarial rounds until dry (4–5 Opus agents per round, parallel)

Now reviews get teeth: **a finding only counts with a failing reproduction**
(harness case, simulator flag, or preview_eval script). This kills the
plausible-but-wrong findings and turns every real one into a permanent test.

**Round structure (repeat):**
1. Dispatch 4–5 parallel Opus agents, rotating lenses so each round differs
   (consult `.agentreview-history.md` — do NOT re-report):
   - *State-machine prover* — enumerate feed/session/lot lifecycles as explicit
     state machines; hunt unreachable/absorbing states, race windows.
   - *Chaos engineer* — extend the simulator with new disaster scripts; every
     crash/blank/wrong-number is a finding.
   - *Domain auditor* — recompute budgets/inflation/values/standings by hand
     from fixtures; any divergence from the app is a finding. Includes keeper
     edge cases (expired contracts, ineligible flags, two-way players, accents).
   - *UI contract tester* — scripted preview_eval walks of all three views:
     every button clicked, every input typed-into while events fire, focus/
     Esc/overlay matrix, duplicate-id scan.
   - *Data-integrity/security* — Supabase rows vs event log reconciliation,
     RLS probes with the anon key, proxy auth, what happens to malformed/
     hostile frame content (ESPN protocol is untrusted input).
2. Synthesis agent verifies each finding's reproduction actually fails, ranks,
   ships fixes (each fix lands WITH its test), updates history file.
3. **Stop condition:** two consecutive rounds with zero material findings.
   Expect 2–4 rounds. If a finding recurs across rounds after a fix, that's a
   structural problem — redesign that seam, don't re-patch.

**How to run:** Jeff kicks each round off with `/agentreview` (rotating lens
list), or — for the full parallel machinery with verification fan-out — says
**"use a workflow"** / enables ultracode so the orchestrator can run
find → reproduce → fix → re-test pipelines in one shot.

## Phase 3 — Live-fire acceptance (Jeff + 1 agent per mock)

The simulator proves logic; only real ESPN traffic proves the protocol.

**3a. Post-mock audit tool (build first, ~half session).** After any draft ends,
    ESPN's REST `mDraftDetail` becomes accurate. Add `scripts/audit_draft.py`
    (or an in-app Debrief section): fetch official post-draft results via the
    proxy, diff against (i) the app's recorded picks and (ii) Supabase
    draft_events SOLDs. **Zero diffs = certified capture.** Every mock ends
    with this audit; any diff is a Phase-2-style finding with the event log
    attached as the fixture.

**3b. Scripted mock protocol** (checklist doc `docs/mock-drill-card.md`): join
    late (backfill), reload ESPN tab mid-draft, reload app mid-draft, hide the
    ESPN tab for 10 minutes (throttling), let a lot sit through a pause, draft
    twice on the same mock league (rotation), flip Draft Mode ↔ manual, second
    device watching (sync guard), kill Wi-Fi 60s. Each drill has an expected
    outcome from the spec; Jeff runs the mock, the agent reads the exported
    event log + audit diff and files findings.

**Acceptance bar for draft-day readiness:** 3 consecutive mocks with (a) zero
audit diffs, (b) zero invariant violations in diagnostics, (c) all drills
passing, (d) nothing material from the accompanying review pass. Then a
**draft-week freeze**: no code changes in the final week except found-bug fixes,
each with its test; pre-draft checklist (extension reloaded, proxy key, fresh
projections/NFBC, config loaded, Supabase reachable, audit tool dry-run).

## Phase 4 — Keep it perfect (standing discipline)

- `scripts/test.sh` green before every push (CLAUDE.md convention #4).
- Every bug → fixture first, fix second. Every mock → fixture + audit.
- Invariant panel stays on in diagnostics permanently.
- One `/agentreview` round after any multi-file Live Draft change.
- Quarterly (Oct/Jan) + draft-eve full pass: simulator + drills + one round.

## Budget & sequencing

| Phase | Sessions (est.) | Parallel Opus agents | Blocking? |
|---|---|---|---|
| 0 Spec | 1 | 1 | Yes — everything cites it |
| 1 Harness/simulator | 2 | 2–3 | Yes — rounds need teeth |
| 2 Rounds until dry | 2–4 | 4–5/round + fixers | After 1 |
| 3 Live-fire | per mock (~8 mos of mocks) | 1/mock | Ongoing to March |
| 4 Discipline | trivial per change | — | Standing |

Do NOT start Phase 2 before Phase 1 exists — that repeats Round 4's ceiling
(smart agents, unverifiable claims). Phases 0+1 can start immediately.

## Appendix A — File map for cold-start agents

App (`/Users/jwars/Desktop/Claude/ultimate-draft/`): `js/features/draft.js`
(dispatcher, feed receiver, draft context, delegation), `draft-setup.js`
(lobby/configs), `draft-mode.js` (cockpit, lot detection, reco), `endgame.js`
(team states, optimizer), `nominations.js`, `debrief.js`, `keepers.js` (keeper
source of truth); `js/core/inflation.js` (collectKeepers, draftExcludedNames,
budgets), `valuation.js`; `js/data/draft-log.js` (Supabase), `espn.js`,
`rotowire.js`, `strategy.js`, `budget-adjust.js`, `cloud-sync.js`.
Extension (`/Users/jwars/Desktop/Claude/keeper-edge-extension/`):
`draft-socket-capture.js`, `draft-bridge.js`, `ud-bridge.js` (NOT a git repo;
Jeff reloads it manually). Proxy: `proxy/worker.js`. Conventions: CLAUDE.md
(bump.sh, check-globals.sh, sync whitelist). Preview: serve a `/tmp` mirror
(Desktop is TCC-blocked for harness-spawned servers).

## Appendix B — Known-bug archaeology (seed the regression suite from these)

Round 4 list in `.agentreview-history.md` (stale-Live, re-draft swallow, mock
contamination, seq reuse, SOLD/lot interleave, input-eating re-renders, dead
delegation targets, Esc, name poisoning, extPresent, sync clobber, is_mock,
tombstones, config half-apply). Earlier: udDraftFeed read-modify-write race,
called-up pool leak, accent-fragile keeper sets (5 pools), live max bids
ignoring traded draft dollars.
