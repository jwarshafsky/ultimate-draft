// r15-eng-1: money-conservation Monte Carlo (noKeepers + keepers).
const H = require("/Users/jwars/Desktop/Claude/ultimate-draft/test/repro/r15-eng-harness.js");
const { LEAGUE } = H;

function analyze(label, opts) {
  const RUNS = 30;
  let totalSpendPct = [], strandedMax = [], starRatios = [], unfilledTeamsTotal = 0, teamsChecked = 0;
  for (let r = 0; r < RUNS; r++) {
    const { picks, states } = runMockDraft(opts);
    const budget = LEAGUE.draftBudget * LEAGUE.numTeams;
    let spent = 0, keptCost = 0, stranded = [];
    for (const s of Object.values(states)) {
      for (const d of s.drafted) spent += d.price;
      keptCost += s.keptCost || 0;
      if (s.slotsRemaining <= 0) stranded.push(s.budget);
      else unfilledTeamsTotal++;
      teamsChecked++;
    }
    const spendable = budget - keptCost;
    totalSpendPct.push(spent / spendable);
    strandedMax.push(Math.max(0, ...stranded));
    for (const p of picks) if (p.baseValue >= 25) starRatios.push(p.price / p.baseValue);
  }
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log("\n=== " + label + " ===");
  console.log("  total spend % of spendable: mean " + (avg(totalSpendPct) * 100).toFixed(1) + "%  (min " + (Math.min(...totalSpendPct) * 100).toFixed(1) + "% max " + (Math.max(...totalSpendPct) * 100).toFixed(1) + "%)");
  console.log("  star (val>=$25) price/value: mean " + avg(starRatios).toFixed(3) + "  med " + (med(starRatios)!=null?med(starRatios).toFixed(3):"n/a") + "  (n=" + starRatios.length + ")");
  console.log("  stranded on full teams: per-run max mean $" + avg(strandedMax).toFixed(1) + "  worst $" + Math.max(...strandedMax).toFixed(0));
  console.log("  teams NOT filling roster: " + unfilledTeamsTotal + " team-instances (of " + teamsChecked + ")");
}
analyze("noKeepers:true (mock-live-feed cockpit)", { noKeepers: true });
analyze("WITH keepers (Mock Draft tab)", {});
