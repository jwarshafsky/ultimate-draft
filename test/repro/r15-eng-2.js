// r15-eng-2: endgame roster-fill under stress + nomination variety.
const H = require("/Users/jwars/Desktop/Claude/ultimate-draft/test/repro/r15-eng-harness.js");
const { LEAGUE } = H;

// (b) Every team fills — even the least-cash team. Run many, assert no team
// ever ends with slotsRemaining > 0 and a pool that still had a $1 player.
let fillFails = 0, runs = 40;
for (let r = 0; r < runs; r++) {
  const { picks, states } = runMockDraft({ noKeepers: true });
  const drafted = new Set(picks.map(p => p.player.toLowerCase()));
  const tailLeft = H.VALUES.filter(p => p.value > 0 && !drafted.has(p.name.toLowerCase())).length;
  for (const s of Object.values(states)) {
    if (s.slotsRemaining > 0 && tailLeft > 0) fillFails++;
  }
}
console.log("(b) roster-fill failures (open slot while pool non-empty):", fillFails, "/", runs * 12, "team-instances");

// (c) Nomination variety: no single owner nominating the same position forever.
// Track nominatorTeamId -> position nominated. A healthy sim spreads across
// positions. Flag if any owner nominates one position >70% of the time.
const nomByOwner = {};
for (let r = 0; r < 10; r++) {
  const { picks } = runMockDraft({ noKeepers: true });
  for (const p of picks) {
    const o = p.nominatorTeamId;
    (nomByOwner[o] = nomByOwner[o] || {});
    nomByOwner[o][p.pos] = (nomByOwner[o][p.pos] || 0) + 1;
  }
}
let worst = 0, worstOwner = null;
for (const [o, posc] of Object.entries(nomByOwner)) {
  const tot = Object.values(posc).reduce((a, b) => a + b, 0);
  const top = Math.max(...Object.values(posc));
  const frac = top / tot;
  if (frac > worst) { worst = frac; worstOwner = o; }
}
console.log("(c) worst single-position nomination concentration:", (worst * 100).toFixed(1) + "% (owner " + worstOwner + ")  — <70% = healthy");

// (e) Determinism/gen note is a timer concern (mock-live-feed), covered separately.
