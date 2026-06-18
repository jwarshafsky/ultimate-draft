// Standings analyzer engine (in-season). Pure functions — no DOM, no fetch.
//
// Takes the CURRENT rosters of all 12 teams (live from ESPN) plus each
// rostered player's stat line, and projects the rotisserie standings:
//   - aggregate each team's totals in all 10 categories
//   - rank teams 1..12 within each category (ties split points)
//   - award roto points (12 for 1st down to 1 for last) and sum
//   - sort into a standings table
//
// Also computes, for a chosen team, the gap to gain/lose a point in each
// category, and a what-if (add/drop a player) that re-runs the whole thing.
//
// Player stat objects are the normalized shape produced by espn.js
// (parseEspnRosters) — but the engine is source-agnostic, so the test harness
// and any other feed can use it the same way:
//   Hitter: { name, type:"H", R,HR,RBI,SB, H,BB,HBP,SF,AB,PA, OBP }
//   Pitcher:{ name, type:"P", K,QS,SV,HLD, IP,ER,HA,BBA, ERA,WHIP }
// Any missing component is tolerated (rate stats fall back to rate×denominator).

const STANDINGS_CATS = ["R", "HR", "RBI", "SB", "OBP", "QS", "K", "SV_HLD", "ERA", "WHIP"];
// Categories where a LOWER total is better.
const STANDINGS_INVERSE = new Set(["ERA", "WHIP"]);
// Rate categories (need a denominator to aggregate, not a plain sum).
const STANDINGS_RATE = new Set(["OBP", "ERA", "WHIP"]);

function _num(v) { return (typeof v === "number" && isFinite(v)) ? v : 0; }

// Aggregate one team's roster into category totals. Returns an object keyed by
// the 10 cats plus the denominators used for the rate stats (so the UI can show
// "X PA / Y IP behind").
function aggregateTeamCats(players) {
  const t = {
    R: 0, HR: 0, RBI: 0, SB: 0,
    QS: 0, K: 0, SV_HLD: 0,
    _obpNum: 0, _obpDen: 0,   // OBP = (H+BB+HBP) / (AB+BB+HBP+SF)
    _er: 0, _ip: 0,           // ERA = 9*ER/IP
    _whipNum: 0,              // WHIP = (HA+BBA)/IP
    PA: 0, IP: 0,
  };
  for (const p of (players || [])) {
    if (!p) continue;
    if (p.type === "P") {
      t.QS += _num(p.QS);
      t.K += _num(p.K);
      t.SV_HLD += _num(p.SV) + _num(p.HLD);
      const ip = _num(p.IP);
      t.IP += ip;
      t._ip += ip;
      // Earned runs: prefer raw ER, else derive from ERA.
      t._er += p.ER != null ? _num(p.ER) : (_num(p.ERA) * ip / 9);
      // Baserunners: prefer raw H+BB allowed, else derive from WHIP.
      const br = (p.HA != null || p.BBA != null)
        ? _num(p.HA) + _num(p.BBA)
        : _num(p.WHIP) * ip;
      t._whipNum += br;
    } else {
      t.R += _num(p.R);
      t.HR += _num(p.HR);
      t.RBI += _num(p.RBI);
      t.SB += _num(p.SB);
      const pa = _num(p.PA) || (_num(p.AB) + _num(p.BB) + _num(p.HBP) + _num(p.SF));
      t.PA += pa;
      // On-base: prefer raw components, else derive from OBP×PA.
      if (p.H != null || p.BB != null) {
        t._obpNum += _num(p.H) + _num(p.BB) + _num(p.HBP);
        t._obpDen += _num(p.AB) + _num(p.BB) + _num(p.HBP) + _num(p.SF);
      } else {
        t._obpNum += _num(p.OBP) * pa;
        t._obpDen += pa;
      }
    }
  }
  t.OBP = t._obpDen > 0 ? t._obpNum / t._obpDen : 0;
  t.ERA = t._ip > 0 ? (t._er * 9) / t._ip : 0;
  t.WHIP = t._ip > 0 ? t._whipNum / t._ip : 0;
  return t;
}

function catValue(totals, cat) {
  return totals[cat] != null ? totals[cat] : 0;
}

// Rank teams in one category and award roto points. Ties split the points
// (standard roto: two teams tied for 3rd-4th in a 12-team league each get 9.5).
// Returns { [teamId]: { value, rank, points } }.
function rankCategory(teamTotals, cat) {
  const inverse = STANDINGS_INVERSE.has(cat);
  // ERA/WHIP: a team with zero IP has no pitching — treat as worst, not best.
  const entries = Object.entries(teamTotals).map(([id, totals]) => {
    let v = catValue(totals, cat);
    if (inverse && (totals._ip || 0) <= 0) v = Infinity; // no pitching = worst
    return { id, v };
  });
  const n = entries.length;
  // Sort best→worst.
  entries.sort((a, b) => inverse ? a.v - b.v : b.v - a.v);

  const out = {};
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && entries[j + 1].v === entries[i].v) j++;
    // Positions i..j are tied. Points for position k (0-based best) = n - k.
    let pts = 0;
    for (let k = i; k <= j; k++) pts += (n - k);
    const avgPts = pts / (j - i + 1);
    const avgRank = ((i + 1) + (j + 1)) / 2;
    for (let k = i; k <= j; k++) {
      out[entries[k].id] = { value: entries[k].v, rank: avgRank, points: avgPts };
    }
    i = j + 1;
  }
  return out;
}

// Full standings. `rosters` is { teamId: [players] }. Returns:
//   { cats: { cat: rankCategory result }, teams: [ { teamId, totals, byCat, rotoPoints } ] sorted }
function computeStandings(rosters) {
  const teamTotals = {};
  for (const [teamId, players] of Object.entries(rosters)) {
    teamTotals[teamId] = aggregateTeamCats(players);
  }
  const cats = {};
  for (const cat of STANDINGS_CATS) cats[cat] = rankCategory(teamTotals, cat);

  const teams = Object.keys(teamTotals).map(teamId => {
    const byCat = {};
    let rotoPoints = 0;
    for (const cat of STANDINGS_CATS) {
      byCat[cat] = cats[cat][teamId];
      rotoPoints += cats[cat][teamId].points;
    }
    return { teamId, totals: teamTotals[teamId], byCat, rotoPoints };
  });
  // Overall standings: most roto points first. Ties broken alphabetically by id
  // for stable ordering.
  teams.sort((a, b) => b.rotoPoints - a.rotoPoints || (a.teamId < b.teamId ? -1 : 1));
  teams.forEach((t, i) => { t.place = i + 1; });

  return { cats, teams, teamTotals };
}

// For a given team, in each category: the gap to the team ranked one spot
// ABOVE (points to gain) and the cushion over the team one spot BELOW (margin
// before losing a point). Positive `toGain` = how much more of the cat you need.
function categoryGaps(standings, teamId) {
  const gaps = {};
  for (const cat of STANDINGS_CATS) {
    const inverse = STANDINGS_INVERSE.has(cat);
    const ranked = Object.entries(standings.cats[cat])
      .map(([id, r]) => ({ id, value: r.value, rank: r.rank, points: r.points }))
      .sort((a, b) => inverse ? a.value - b.value : b.value - a.value);
    const idx = ranked.findIndex(r => r.id === teamId);
    if (idx < 0) continue;
    const me = ranked[idx];
    const above = idx > 0 ? ranked[idx - 1] : null;       // one place better
    const below = idx < ranked.length - 1 ? ranked[idx + 1] : null; // one worse
    const diff = (a, b) => inverse ? (b - a) : (a - b);   // positive = a is better
    gaps[cat] = {
      value: me.value,
      rank: me.rank,
      points: me.points,
      // amount you must improve your total by to pass the team above you
      toGain: above ? Math.abs(me.value - above.value) : null,
      gainTeam: above ? above.id : null,
      // your cushion over the team below — lose the point if they close this
      cushion: below ? Math.abs(me.value - below.value) : null,
      cushionTeam: below ? below.id : null,
      inverse,
      rate: STANDINGS_RATE.has(cat),
    };
  }
  return gaps;
}

// What-if: clone rosters, apply add/drop on one team, recompute. `add` and
// `drop` are player stat objects / names respectively.
//   opts = { teamId, add: <playerObj|null>, dropName: <string|null> }
// Returns { before, after, delta } standings + the team's roto-point swing.
function whatIfStandings(rosters, opts) {
  const before = computeStandings(rosters);
  const next = {};
  for (const [id, players] of Object.entries(rosters)) next[id] = players.slice();
  const tid = opts.teamId;
  if (tid && next[tid]) {
    if (opts.dropName) next[tid] = next[tid].filter(p => p.name !== opts.dropName);
    if (opts.add) next[tid] = next[tid].concat(Array.isArray(opts.add) ? opts.add : [opts.add]);
  }
  const after = computeStandings(next);
  const beforeMe = before.teams.find(t => t.teamId === tid);
  const afterMe = after.teams.find(t => t.teamId === tid);
  return {
    before, after,
    delta: {
      rotoPoints: (afterMe?.rotoPoints || 0) - (beforeMe?.rotoPoints || 0),
      place: (beforeMe?.place || 0) - (afterMe?.place || 0), // positive = moved up
    },
  };
}

// --- Monte Carlo title odds ---------------------------------------------
// Projected standings are a point estimate; the real finish is uncertain. We
// simulate many seasons by jittering each team's category total and re-running
// the roto math, then count how often each team lands 1st / top-3, and the
// average finish. This is ziguana's "odds to win".
//
// Three things make the model realistic:
//
// 1. FULL-SEASON volatility per category (STANDINGS_CAT_SIGMA): how much a
//    team's season total in that cat can drift, with saves/holds the most
//    volatile and rate stats (OBP/ERA/WHIP) the least.
//
// 2. TIGHTENS AS THE SEASON GOES ON: the jitter scales by the fraction of the
//    season still UNPLAYED. Stats already banked (YTD) can't change; only the
//    rest-of-season portion is uncertain. We measure "fraction remaining" from
//    the data itself — share of a team's plate appearances / innings that come
//    from the ROS projection vs YTD — so a player feed mid-September is nearly
//    locked. (Falls back to a calendar estimate, opts.fracRemaining, when there
//    is no ROS split, e.g. Current mode.)
//
// 3. CORRELATED CATEGORIES: a hot offensive stretch lifts R/HR/RBI/OBP
//    together, and a strong pitching run raises K/QS while lowering ERA/WHIP.
//    We model this with two per-team latent factors (offense, pitching). Each
//    category's shock = loading × group factor + the rest idiosyncratic. ERA
//    and WHIP load NEGATIVELY on the pitching factor (better pitching → lower
//    ratios), and saves/holds load weakly (bullpen roles are their own thing).
const STANDINGS_CAT_SIGMA = {
  R: 0.06, HR: 0.08, RBI: 0.06, SB: 0.10, OBP: 0.015,
  QS: 0.09, K: 0.06, SV_HLD: 0.14, ERA: 0.045, WHIP: 0.035,
};
// Which latent factor each category loads on, and how strongly (signed).
const STANDINGS_CAT_GROUP = {
  R: "off", HR: "off", RBI: "off", SB: "off", OBP: "off",
  QS: "pit", K: "pit", SV_HLD: "pit", ERA: "pit", WHIP: "pit",
};
const STANDINGS_CAT_LOAD = {
  R: 0.55, HR: 0.55, RBI: 0.60, SB: 0.40, OBP: 0.50,
  QS: 0.50, K: 0.50, SV_HLD: 0.20, ERA: -0.50, WHIP: -0.50,
};

// Standard normal via Box-Muller.
function _gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function _clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// Per-team "fraction of season remaining" for hitting (PA) and pitching (IP),
// derived from the share of playing time carried by ROS-tagged lines.
function _teamFractionRemaining(players, fallback) {
  let paAll = 0, paRos = 0, ipAll = 0, ipRos = 0;
  for (const p of (players || [])) {
    if (!p) continue;
    if (p.type === "P") {
      const ip = (typeof p.IP === "number") ? p.IP : 0;
      ipAll += ip; if (p._ros) ipRos += ip;
    } else {
      const pa = (typeof p.PA === "number" && p.PA) ? p.PA :
        ((p.AB || 0) + (p.BB || 0) + (p.HBP || 0) + (p.SF || 0));
      paAll += pa; if (p._ros) paRos += pa;
    }
  }
  return {
    hit: paAll > 0 && paRos > 0 ? _clamp01(paRos / paAll) : fallback,
    pit: ipAll > 0 && ipRos > 0 ? _clamp01(ipRos / ipAll) : fallback,
  };
}

// Returns { byTeam: { [teamId]: { pFirst, pTop3, avgFinish, finishDist } },
// teamIds, sims }. opts: { sims=3000, uncertainty=1, fracRemaining=1 }.
function simulateTitleOdds(rosters, opts) {
  opts = opts || {};
  const sims = opts.sims || 3000;
  const uncertainty = opts.uncertainty != null ? opts.uncertainty : 1;
  const fallbackFrac = opts.fracRemaining != null ? opts.fracRemaining : 1;
  const teamIds = Object.keys(rosters);
  const n = teamIds.length;
  if (!n) return { byTeam: {}, teamIds: [], sims: 0 };

  const totals = {};
  const frac = {};        // id -> { hit, pit }
  for (const id of teamIds) {
    totals[id] = aggregateTeamCats(rosters[id]);
    frac[id] = _teamFractionRemaining(rosters[id], fallbackFrac);
  }

  const stats = {};
  for (const id of teamIds) stats[id] = { first: 0, top3: 0, finishSum: 0, dist: new Array(n).fill(0) };

  const base = {}; // cat -> { id: value }
  for (const cat of STANDINGS_CATS) {
    base[cat] = {};
    for (const id of teamIds) base[cat][id] = catValue(totals[id], cat);
  }

  for (let s = 0; s < sims; s++) {
    // Draw each team's two latent factors for this simulated season.
    const F = {}; // id -> { off, pit }
    for (const id of teamIds) F[id] = { off: _gauss(), pit: _gauss() };

    const pts = {};
    for (const id of teamIds) pts[id] = 0;

    for (const cat of STANDINGS_CATS) {
      const inverse = STANDINGS_INVERSE.has(cat);
      const sigma = (STANDINGS_CAT_SIGMA[cat] || 0.06) * uncertainty;
      const group = STANDINGS_CAT_GROUP[cat];
      const load = STANDINGS_CAT_LOAD[cat] || 0;
      const idio = Math.sqrt(Math.max(0, 1 - load * load));
      const sampled = [];
      for (const id of teamIds) {
        if (inverse && (totals[id]._ip || 0) <= 0) { sampled.push({ id, v: Infinity }); continue; }
        const f = group === "off" ? frac[id].hit : frac[id].pit;
        const shock = load * F[id][group] + idio * _gauss();
        let v = base[cat][id] * (1 + sigma * f * shock);
        if (v < 0) v = 0;
        sampled.push({ id, v });
      }
      sampled.sort((a, b) => inverse ? a.v - b.v : b.v - a.v);
      for (let k = 0; k < n; k++) pts[sampled[k].id] += (n - k);
    }

    const order = teamIds.slice().sort((a, b) => pts[b] - pts[a]);
    for (let place = 0; place < n; place++) {
      const id = order[place];
      stats[id].finishSum += (place + 1);
      stats[id].dist[place] += 1;
      if (place === 0) stats[id].first += 1;
      if (place < 3) stats[id].top3 += 1;
    }
  }

  const byTeam = {};
  for (const id of teamIds) {
    const st = stats[id];
    byTeam[id] = {
      pFirst: st.first / sims,
      pTop3: st.top3 / sims,
      avgFinish: st.finishSum / sims,
      finishDist: st.dist.map(c => c / sims),
    };
  }
  return { byTeam, teamIds, sims };
}

// Expose for the browser test harness / console.
if (typeof window !== "undefined") {
  window.UDStandings = {
    aggregateTeamCats, rankCategory, computeStandings,
    categoryGaps, whatIfStandings, simulateTitleOdds,
    STANDINGS_CATS, STANDINGS_INVERSE,
    STANDINGS_CAT_SIGMA, STANDINGS_CAT_GROUP, STANDINGS_CAT_LOAD,
  };
}
