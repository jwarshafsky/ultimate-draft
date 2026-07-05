// p2r1-math-2 — FINDING: a team with slotsRemaining === 0 (roster full) still
// reports a large positive maxBid. computeLiveTeamStates computes
//   maxBid = max(0, budget - max(0, slotsRemaining - 1))
// When slotsRemaining = 0, the inner max(0, -1) = 0, so the $1/other-slot
// reserve vanishes and maxBid = budget (any leftover dollars). The team strip
// renders this raw value: a full-roster team shows "max $234" while also being
// flagged "done".
//
// Violated spec: S-095 ("A team with slotsRemaining = 0 MUST have maxBid = 0
// and MUST be flagged done in the team strip").
//
// HAND COMPUTATION:
//   jeff fills all 26 roster slots via picks totalling $26 (26 x $1).
//   budget = 260 - 26 = 234, slotsRemaining = 26 - 26 = 0.
//   SPEC: a full roster can bid on nothing -> maxBid MUST be 0.
//   ACTUAL: max(0, 234 - max(0, 0-1)) = max(0, 234 - 0) = 234.

const realLog = console.log.bind(console);
const { installGlobals, resetDraftState } = require("./_scaffold.js");

installGlobals({
  VALUES: [{ name: "Aaron Judge", posKey: "OF", team: "NYY", type: "H", value: 40 }],
  KEEPER_SELECTIONS: {},
});
resetDraftState();
global.localStorage.setItem("ud_feed_mode", "real");

// Fill all 26 of jeff's roster slots.
for (let i = 0; i < 26; i++) {
  global._liveDraft.picks.push({ player: "Filler " + i, pos: "OF", team: "jeff", price: 1, ts: Date.now() });
}

const st = global.computeLiveTeamStates().jeff;
realLog("slotsRemaining:", st.slotsRemaining, "budget:", st.budget, "maxBid:", st.maxBid);

const EXPECT_SLOTS = 0, EXPECT_MAXBID = 0;
let ok = true;
if (st.slotsRemaining !== EXPECT_SLOTS) { realLog("  slots wrong"); ok = false; }
if (st.maxBid !== EXPECT_MAXBID) {
  realLog("  MISMATCH maxBid: spec S-095 expects 0 for a full roster, got " + st.maxBid);
  ok = false;
}

if (ok) { realLog("\nPASS (no bug)"); process.exit(0); }
realLog("\nFAIL — full-roster team (0 slots) reports maxBid=" + st.maxBid + " (spec S-095: must be 0)");
process.exit(1);
