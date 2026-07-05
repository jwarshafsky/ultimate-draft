# Mock Drill Card — what to do during each practice mock (perfection plan Phase 3b)

Run any ESPN mock with the feed on **Test**. Each drill has an expected outcome;
anything else is a finding — export the event log (Live Draft ▸ Diagnostics ▸
Download) and report it.

**Before:** reload Keeper Edge if Claude shipped extension changes since your
last mock; open Draft Setup → paste the mock URL → Apply (seat auto-detects
once the draft room connects; verify the My-team number matches your room).

| # | Drill | Expected |
|---|-------|----------|
| 1 | Join the draft ~2 min late | INIT backfill fills every earlier pick |
| 2 | Let 10+ lots run hands-off | Hero/ticker/reco update in place; invariants line stays ✅ in Diagnostics |
| 3 | Reload the ESPN tab mid-draft | Capture gap self-heals on reconnect (INIT); watchdog guidance if it doesn't |
| 4 | Reload the APP tab mid-draft | Picks/lot/my-team restore in ~3s; no duplicates |
| 5 | Hide the ESPN tab behind other windows 10 min | Picks keep landing (immediate SOLD flush); no false watchdog |
| 6 | Watch a quiet lot 5+ min | "⏸ paused" note within ~10s, hero never blanks |
| 7 | Nominate-with-accents check | Any José/Acuña-type name shows values on the hero |
| 8 | After the mock ends: Debrief ▸ **Run audit** | "✅ CERTIFIED — zero diffs" vs ESPN's official results |
| 9 | Flip feed to Real afterward | Picks purge to 0, invariants ✅, lobby clean |
| 10 | Note ESPN's behavior during any auto-pause | Does CLOCK keep ticking? (calibrates the watchdog) |

**Acceptance (spec):** 3 consecutive mocks with a clean audit (#8), green
invariants throughout (#2), and all drills passing → draft-week freeze.
