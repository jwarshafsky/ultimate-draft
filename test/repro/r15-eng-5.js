// r15-eng-5 (Lens 2): Mock Draft TAB headless paths still work after the
// noKeepers threading + shared computeMockStandings. Loads the harness (engine
// + globals), stubs document/window, evals mock.js, and drives:
//   - runMockDraft() WITH keepers (the tab's default) → non-empty states
//   - computeMockStandings(states) on that run → ranks all 12, no crash
//   - runMockDraftMonteCarlo(25) → aggregated rows
//   - saveMockToArchive path shape (getSavedMocks/_writeSavedMocks/_mockGrade)
const fs = require("fs");
const APP = "/Users/jwars/Desktop/Claude/ultimate-draft/js/";
const H = require("/Users/jwars/Desktop/Claude/ultimate-draft/test/repro/r15-eng-harness.js");

// aggregateCats: mock.js's computeMockStandings calls it. Provide a minimal
// version that returns per-name category totals (real one lives in standings).
// For the standings math we just need SOME numeric totals; use value as a proxy.
global.aggregateCats = (names) => {
  let R = 0, IP = 0;
  for (const n of names) { const p = H.VAL_BY_NAME[n.toLowerCase()]; if (p) { R += p.value; if (p.type === "P") IP += 10; } }
  return { R, HR: R, RBI: R, SB: R, OBP: R / 100, QS: IP, K: IP, SV_HLD: IP, ERA: IP ? 3.5 : 0, WHIP: IP ? 1.2 : 0, IP };
};
global.currentView = "x";
global.esc = (s) => String(s);
global.localStorage = (() => { const m = {}; return { getItem: k => k in m ? m[k] : null, setItem: (k, v) => m[k] = String(v), removeItem: k => delete m[k] }; })();
global.document = { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } };
global.window = {};
global.getMyTeam = () => H.LEAGUE.teams.find(t => t.isMe);
global.onInteractiveChange = null;

let src = fs.readFileSync(APP + "features/mock.js", "utf8");
src += "\nglobalThis.computeMockStandings=computeMockStandings;globalThis._mockGrade=_mockGrade;globalThis.getSavedMocks=getSavedMocks;globalThis._writeSavedMocks=_writeSavedMocks;";
eval(src);

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };

// 1. keeper-mode run
const { picks, states } = runMockDraft({});   // WITH keepers = tab default
ok(picks.length > 250, "tab keeper-mode run drafts a full board (" + picks.length + " picks)");
ok(Object.keys(states).length === 12, "12 team states produced");

// 2. computeMockStandings on a keeper run (uses kept + drafted)
const st = computeMockStandings(states);
ok(st.teams.length === 12 && st.teams.every(t => t.rank >= 1 && t.rank <= 12), "standings rank all 12");
ok(st.anyData === true, "standings has category data");
const mine = st.teams.find(t => t.isMe);
ok(mine != null, "my team present in standings");
ok(typeof _mockGrade(mine.rank, st.N) === "string", "grade computes for my rank");

// 3. Monte Carlo (tab, keeper mode)
const mc = runMockDraftMonteCarlo(15, {});
ok(Array.isArray(mc) && mc.length > 50, "MC returns aggregated player rows (" + mc.length + ")");
ok(mc.every(r => r.median >= 0 && r.mean >= 0 && r.p10 <= r.p90), "MC percentiles ordered (p10<=p90)");

// 4. noKeepers MC (what the live-feed uses) — same function, different opts
const mcNK = runMockDraftMonteCarlo(15, { noKeepers: true });
ok(mcNK.length > mc.length, "noKeepers MC has MORE players (keepers not excluded): " + mcNK.length + " > " + mc.length);

console.log(fails === 0 ? "\nALL PASS" : "\n" + fails + " FAILED");
process.exit(fails ? 1 : 0);
