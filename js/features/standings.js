// Standings analyzer (in-season). Pulls live ESPN rosters (season-to-date
// actuals) for all 12 teams and projects the rotisserie standings in three
// modes:
//   - "current" = YTD stats only (what's banked so far)
//   - "ros"     = rest-of-season projection only (each team going forward)
//   - "full"    = YTD + ROS (projected FINAL totals — the real season forecast)
// ROS comes from an imported source (Steamer / THE BAT X / ATC). Plus per-cat
// ranks/points, a gap analysis for your team, Monte-Carlo title odds, and an
// add/drop what-if that re-runs the league.

const _standings = {
  ytd: null,         // { rosters, teamMeta, season } — ESPN YTD actuals (mode-independent)
  computed: null,    // computeStandings() on the built rosters
  odds: null,        // simulateTitleOdds() result
  coverage: null,    // { matched, total } ROS match rate (ros/full modes)
  built: null,       // the engine rosters currently displayed
  mode: "current",   // "current" | "ros" | "full"
  rosSource: null,   // selected ROS source id
  loading: false,
  error: null,
  faPool: null,      // normalized free-agent list (YTD lines) for what-if "add"
  whatIf: { add: null, dropName: null },
  whatIfTab: "addrop",                       // "addrop" | "trade" | "pickups"
  trade: { partner: null, send: [], recv: [] },
  pickups: null,                             // cached best-pickups result
};

// Modes that require a ROS projection source.
function _modeNeedsRos(m) { return m === "ros" || m === "full"; }

const STANDINGS_CAT_LABELS = {
  R: "R", HR: "HR", RBI: "RBI", SB: "SB", OBP: "OBP",
  QS: "QS", K: "K", SV_HLD: "SV+HLD", ERA: "ERA", WHIP: "WHIP",
};

function _fmtCat(cat, v) {
  if (v == null || !isFinite(v)) return "—";
  if (cat === "OBP") return v.toFixed(3).replace(/^0/, "");
  if (cat === "ERA" || cat === "WHIP") return v.toFixed(2);
  return Math.round(v).toString();
}
function _pct(p) { return (p * 100 < 1 && p > 0) ? "<1%" : Math.round(p * 100) + "%"; }
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function loadStandingsData() {
  if (_standings.loading) return;
  if (!ESPN.proxyUrl) { _standings.error = "no-proxy"; renderStandings(); return; }
  _standings.loading = true;
  _standings.error = null;
  renderStandings();
  try {
    // Always pull YTD actuals; ROS comes from the imported projection source.
    _standings.ytd = await fetchEspnRosters(0);
    _standings.faPool = null;
    _standings.whatIf = { add: null, dropName: null };
    if (!_standings.rosSource) _standings.rosSource = firstLoadedRosSource();
    recomputeStandings();
  } catch (e) {
    _standings.error = e.message || String(e);
  } finally {
    _standings.loading = false;
    renderStandings();
  }
}

// Build the engine rosters for the current mode/source, then run the standings
// math + title-odds Monte Carlo. Pure recompute — no network.
function recomputeStandings() {
  if (!_standings.ytd) { _standings.computed = null; return; }
  _buildPool();
  const built = buildEngineRosters();
  _standings.built = built.rosters;
  _standings.coverage = built.coverage;
  _standings.computed = computeStandings(built.rosters);
  _standings.odds = simulateTitleOdds(built.rosters, { sims: 3000, fracRemaining: seasonFractionRemaining() });
  _standings.pickups = null;   // base changed — best-pickups must be recomputed
}

// --- Optimal starting lineup --------------------------------------------
// Roto only counts players in active lineup slots, so ROS/Full project each
// team's BEST legal lineup (fill the league's starting slots with the highest-
// projected eligible players), excluding the IL. Bench players count only if
// they out-project a starter at a slot they qualify for.
//   hitters: C(0) 1B(1) 2B(2) 3B(3) SS(4) OF(5)x5 MI(6) CI(7) UTIL(12) = 13
//   pitchers: 9 generic P slots          IL = slot 17 (excluded)
const LINEUP_HIT_SLOTS = [
  { id: 0, cap: 1 }, { id: 1, cap: 1 }, { id: 2, cap: 1 }, { id: 3, cap: 1 },
  { id: 4, cap: 1 }, { id: 5, cap: 5 }, { id: 6, cap: 1 }, { id: 7, cap: 1 }, { id: 12, cap: 1 },
];
const LINEUP_HIT_TRY = [0, 1, 2, 3, 4, 5, 6, 7, 12]; // dedicated first, UTIL last
const LINEUP_P_SLOTS = 9;
const ESPN_IL_SLOT = 17;

function _hitValue(r) {
  return (r.R || 0) * 0.7 + (r.RBI || 0) * 0.7 + (r.HR || 0) * 1.3 + (r.SB || 0) * 1.4 +
    Math.max(0, (r.OBP || 0) - 0.300) * (r.PA || 0) * 3;
}
function _pitValue(r) {
  const ip = r.IP || 0;
  return (r.K || 0) * 0.3 + (r.QS || 0) * 2.5 + ((r.SV || 0) + (r.HLD || 0)) * 1.8 +
    Math.max(0, 4.20 - (r.ERA || 9)) * ip * 0.3 + Math.max(0, 1.28 - (r.WHIP || 9)) * ip * 0.5;
}

// Return the ROS stat lines of a team's optimal starting lineup from its pool
// (players carry {type, eligibleSlots, lineupSlotId, ros}). Excludes IL and
// anyone without a projection.
function optimizeStarters(poolPlayers) {
  const valid = (poolPlayers || []).filter(p => p.ros && p.lineupSlotId !== ESPN_IL_SLOT);
  const hitters = valid.filter(p => p.type === "H").map(p => ({ p, v: _hitValue(p.ros) })).sort((a, b) => b.v - a.v);
  const pitchers = valid.filter(p => p.type === "P").map(p => ({ p, v: _pitValue(p.ros) })).sort((a, b) => b.v - a.v);
  const open = {};
  for (const s of LINEUP_HIT_SLOTS) open[s.id] = s.cap;
  const lines = [];
  for (const { p } of hitters) {
    const elig = new Set(p.eligibleSlots || []);
    for (const sid of LINEUP_HIT_TRY) {
      if (open[sid] > 0 && elig.has(sid)) { open[sid]--; lines.push(p.ros); break; }
    }
  }
  for (const { p } of pitchers.slice(0, LINEUP_P_SLOTS)) lines.push(p.ros);
  return lines;
}

// Per-team pool: every rostered player paired with its ROS line.
function _buildPool() {
  const rosters = _standings.ytd?.rosters || {};
  const src = _standings.rosSource;
  const pool = {};
  for (const [tid, players] of Object.entries(rosters)) {
    pool[tid] = players.map(p => ({
      name: p.name, type: p.type, eligibleSlots: p.eligibleSlots || [],
      lineupSlotId: p.lineupSlotId,
      ros: src ? getRosLine(src, p.name, p.type) : null,
    }));
  }
  _standings.pool = pool;
  return pool;
}

// A free agent as a pool player (eligible to start, not on anyone's IL).
function _faToPoolPlayer(fa) {
  return {
    name: fa.name, type: fa.type, eligibleSlots: fa.eligibleSlots || [], lineupSlotId: undefined,
    ros: _standings.rosSource ? getRosLine(_standings.rosSource, fa.name, fa.type) : null,
  };
}

// Mode-aware stat lines for one team from its pool players.
function _teamLinesFromPool(tid, poolPlayers) {
  const ytdTeam = _standings.ytd?.ytdTeam || {};
  if (_standings.mode === "current") return (ytdTeam[tid] || []).slice();
  const starters = optimizeStarters(poolPlayers).map(r => {
    if (_standings.mode === "full") r._ros = true; else delete r._ros;
    return r;
  });
  return _standings.mode === "full" ? (ytdTeam[tid] || []).concat(starters) : starters;
}

function buildEngineRosters() {
  const pool = _standings.pool || _buildPool();
  const teamIds = Object.keys(pool).length ? Object.keys(pool) : Object.keys(_standings.ytd?.ytdTeam || {});
  const out = {};
  let matched = 0, total = 0;
  for (const tid of teamIds) {
    out[tid] = _teamLinesFromPool(tid, pool[tid] || []);
    if (_standings.mode !== "current") {
      const nonIl = (pool[tid] || []).filter(p => p.lineupSlotId !== ESPN_IL_SLOT);
      total += nonIl.length;
      matched += nonIl.filter(p => p.ros).length;
    }
  }
  return { rosters: out, coverage: _standings.mode === "current" ? null : { matched, total } };
}

// League line-sets with specific teams' pools overridden (for what-ifs). Reuses
// the base built lines for unchanged teams; re-optimizes only the overridden.
function _afterLines(overrides) {
  const out = {};
  for (const tid of Object.keys(_standings.built)) out[tid] = _standings.built[tid];
  for (const [tid, poolPlayers] of Object.entries(overrides)) out[tid] = _teamLinesFromPool(tid, poolPlayers);
  return out;
}

// My pool after a drop and/or add (free agent).
function _poolWithMove(tid, dropName, addFa) {
  let arr = (_standings.pool[tid] || []).slice();
  if (dropName) arr = arr.filter(p => p.name !== dropName);
  if (addFa) arr = arr.concat([_faToPoolPlayer(addFa)]);
  return arr;
}

function _teamLabel(teamId) {
  const t = getTeam(teamId);
  return t ? t.owner : teamId;
}

// Calendar estimate of the fraction of the MLB regular season still unplayed.
// Used as a fallback for the title-odds sim when there's no ROS playing-time
// split to measure it from the data (e.g. Current/YTD mode). MLB regular season
// runs ~Mar 27 → Sep 28.
function seasonFractionRemaining() {
  const season = _standings.ytd?.season || (ESPN && ESPN.season) || new Date().getFullYear();
  const now = new Date();
  const start = new Date(season, 2, 27);
  const end = new Date(season, 8, 28);
  if (now <= start) return 1;
  if (now >= end) return 0.03;     // tiny residual at/after season's end
  return Math.max(0, Math.min(1, (end - now) / (end - start)));
}

function renderStandings() {
  const root = document.getElementById("view-root");
  if (!root) return;
  const me = getMyTeam();
  // Make sure a ROS source is selected whenever any are imported.
  if (!_standings.rosSource) _standings.rosSource = firstLoadedRosSource();

  let html = '<div class="card"><h2>Standings Analyzer</h2>';
  html += '<p class="muted small">Live ESPN rosters → rotisserie standings for all 12 teams. ' +
    '<b>Current</b> = stats banked so far · <b>Rest of Season</b> = projection going forward only · ' +
    '<b>Full Season</b> = YTD + rest-of-season (the projected final standings).</p>';

  // Mode + ROS source + refresh
  html += '<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:6px;">';
  html += '<div class="seg" style="display:inline-flex; border:1px solid var(--border); border-radius:6px; overflow:hidden;">';
  for (const [val, lbl] of [["current", "Current (YTD)"], ["ros", "Rest of Season"], ["full", "Full Season"]]) {
    const active = _standings.mode === val;
    html += '<button class="btn' + (active ? ' primary' : ' ghost') + '" data-mode="' + val +
      '" style="border:0; border-radius:0; padding:6px 12px;">' + lbl + '</button>';
  }
  html += '</div>';

  // ROS source dropdown (active in rest-of-season / full modes)
  const srcEnabled = _modeNeedsRos(_standings.mode);
  html += '<label class="small muted" style="display:inline-flex; align-items:center; gap:6px;">Projection ' +
    '<select id="std-ros-src"' + (srcEnabled ? "" : " disabled") + '>';
  for (const s of ROS_SOURCES) {
    const has = rosHasData(s.id);
    const c = getRosCounts(s.id);
    const sel = _standings.rosSource === s.id ? " selected" : "";
    html += '<option value="' + s.id + '"' + sel + (has ? "" : " disabled") + '>' +
      esc(s.label) + (has ? ' (' + (c.hitters + c.pitchers) + ')' : ' — not imported') + '</option>';
  }
  html += '</select></label>';

  html += '<button class="btn primary" id="std-refresh"' + (ESPN.proxyUrl ? '' : ' disabled') + '>' +
    (_standings.loading ? 'Loading…' : '↻ Refresh from ESPN') + '</button>';
  if (_standings.ytd) {
    html += '<span class="muted small">Season ' + esc(String(_standings.ytd.season)) +
      ' · ' + Object.keys(_standings.ytd.rosters).length + ' teams</span>';
  }
  html += '</div>';

  // Coverage / source hints
  if (_modeNeedsRos(_standings.mode)) {
    if (!firstLoadedRosSource()) {
      html += '<p class="small bad" style="margin-top:8px;">No projections loaded yet. Add them on the <b>Data</b> tab (Rest-of-Season Projections → paste FanGraphs JSON).</p>';
    } else if (_standings.coverage) {
      const cv = _standings.coverage;
      const pctMatched = cv.total ? Math.round(cv.matched / cv.total * 100) : 0;
      html += '<p class="small ' + (pctMatched >= 80 ? 'muted' : 'warn') + '" style="margin-top:8px;">' +
        'Projection: <b>' + esc(getRosSourceLabel(_standings.rosSource)) + '</b> · projecting each team’s best starting lineup (13 hitters + 9 pitchers, IL excluded) · ' +
        cv.matched + '/' + cv.total + ' active players have a projection (' + pctMatched + '%).</p>';
    }
  }

  if (_standings.error === "no-proxy" || !ESPN.proxyUrl) {
    html += '<p class="small bad" style="margin-top:10px;">Set your ESPN proxy URL in Settings to enable live standings.</p>';
  } else if (_standings.error) {
    html += '<p class="small bad" style="margin-top:10px;">ESPN load failed: ' + esc(_standings.error) + '</p>';
  } else if (!_standings.computed && !_standings.loading) {
    html += '<p class="small muted" style="margin-top:10px;">Hit “Refresh from ESPN” to pull live rosters and build the standings.</p>';
  }
  html += '</div>';

  if (_standings.computed) {
    // Title odds & what-if are about the FINISH — only meaningful once a
    // projection is layered on (Rest of Season / Full Season). Current mode is
    // a snapshot of what's already banked.
    if (_standings.mode !== "current") html += renderTitleOddsCard(_standings.computed, _standings.odds, me?.id);
    html += renderStandingsTable(_standings.computed, me?.id);
    if (me) html += renderGapCard(_standings.computed, me.id);
    if (me && _standings.mode !== "current") html += renderWhatIfCard(me.id);
  }

  root.innerHTML = html;
  wireStandings();
}

function renderTitleOddsCard(computed, odds, myId) {
  if (!odds) return "";
  // Order teams by P(1st) desc.
  const rows = computed.teams.map(t => ({
    teamId: t.teamId, roto: t.rotoPoints, place: t.place, ...(odds.byTeam[t.teamId] || {}),
  })).sort((a, b) => (b.pFirst || 0) - (a.pFirst || 0));
  const maxP = Math.max(0.0001, ...rows.map(r => r.pFirst || 0));

  const fracTxt = Math.round(seasonFractionRemaining() * 100);
  let html = '<div class="card" style="border-color: rgba(79,142,247,.4);"><h3>Title Odds</h3>';
  html += '<p class="muted small">Probability of finishing 1st, from ' + odds.sims.toLocaleString() +
    ' simulated seasons. Uncertainty scales with the rest-of-season still to play (≈' + fracTxt +
    '% left' + (_standings.mode === 'full' ? ', measured from each team’s ROS share' : ', calendar estimate') +
    ') and categories move together (offense and pitching swing as a unit), so odds tighten as the year progresses.</p>';
  html += '<div style="overflow-x:auto;"><table><thead><tr>' +
    '<th>Team</th><th class="num">Proj roto</th><th class="num">P(1st)</th><th>&nbsp;</th>' +
    '<th class="num">Top 3</th><th class="num">Avg finish</th></tr></thead><tbody>';
  for (const r of rows) {
    const mine = r.teamId === myId;
    html += '<tr' + (mine ? ' style="background:rgba(79,142,247,.10);font-weight:600;"' : '') + '>';
    html += '<td>' + esc(_teamLabel(r.teamId)) + (mine ? ' ◄' : '') + '</td>';
    html += '<td class="num">' + (Math.round(r.roto * 10) / 10) + '</td>';
    html += '<td class="num">' + _pct(r.pFirst || 0) + '</td>';
    // mini bar
    const w = Math.round((r.pFirst || 0) / maxP * 100);
    html += '<td style="width:120px;"><div style="background:var(--border);border-radius:3px;height:8px;width:110px;">' +
      '<div style="background:var(--accent);height:8px;border-radius:3px;width:' + w + '%;"></div></div></td>';
    html += '<td class="num">' + _pct(r.pTop3 || 0) + '</td>';
    html += '<td class="num">' + (r.avgFinish ? r.avgFinish.toFixed(1) : "—") + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table></div></div>';
  return html;
}

function renderStandingsTable(computed, myId) {
  const heading = _standings.mode === "current" ? "Current Roto Standings (YTD)" :
    _standings.mode === "ros" ? "Rest-of-Season Roto Standings" : "Full-Season Projected Standings";
  let html = '<div class="card"><h3>' + heading + '</h3>';
  html += '<div style="overflow-x:auto;"><table><thead><tr>';
  html += '<th>#</th><th>Team</th>';
  for (const cat of STANDINGS_CATS) html += '<th class="num">' + STANDINGS_CAT_LABELS[cat] + '</th>';
  html += '<th class="num">Roto</th></tr></thead><tbody>';

  for (const team of computed.teams) {
    const mine = team.teamId === myId;
    html += '<tr' + (mine ? ' style="background:rgba(79,142,247,.10);font-weight:600;"' : '') + '>';
    html += '<td class="num">' + team.place + '</td>';
    html += '<td>' + esc(_teamLabel(team.teamId)) + (mine ? ' ◄' : '') + '</td>';
    for (const cat of STANDINGS_CATS) {
      const c = team.byCat[cat];
      const n = computed.teams.length;
      const cls = c.points >= n - 2 ? ' good' : c.points <= 3 ? ' bad' : '';
      html += '<td class="num' + cls + '" title="rank ' + c.rank + ' · ' + c.points + ' pts">' +
        _fmtCat(cat, c.value) +
        '<span class="muted" style="font-size:10px;"> ' + (Math.round(c.points * 10) / 10) + '</span></td>';
    }
    html += '<td class="num" style="font-family:var(--mono);font-weight:700;">' +
      (Math.round(team.rotoPoints * 10) / 10) + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  html += '<p class="muted small" style="margin-top:6px;">Each cell shows the category total and roto points earned (small). Roto = sum across all 10 categories (max ' +
    (computed.teams.length * 10) + ').</p>';
  html += '</div>';
  return html;
}

function renderGapCard(computed, myId) {
  const gaps = categoryGaps(computed, myId);
  const me = computed.teams.find(t => t.teamId === myId);
  if (!me) return "";
  let html = '<div class="card"><h3>Your Category Gaps</h3>';
  html += '<p class="muted small">You’re in ' + (me.place ? ordinal(me.place) : "—") + ' with ' +
    (Math.round(me.rotoPoints * 10) / 10) + ' roto points. ' +
    'For each category: how much you need to gain a point, and your cushion before losing one.</p>';
  html += '<div style="overflow-x:auto;"><table><thead><tr>' +
    '<th>Cat</th><th class="num">Your total</th><th class="num">Pts</th>' +
    '<th class="num">To gain +1</th><th>(pass)</th><th class="num">Cushion</th><th>(over)</th>' +
    '</tr></thead><tbody>';
  for (const cat of STANDINGS_CATS) {
    const g = gaps[cat];
    if (!g) continue;
    const gain = g.toGain == null ? "—" : _fmtGap(cat, g.toGain);
    const cushion = g.cushion == null ? "—" : _fmtGap(cat, g.cushion);
    html += '<tr>';
    html += '<td>' + STANDINGS_CAT_LABELS[cat] + '</td>';
    html += '<td class="num">' + _fmtCat(cat, g.value) + '</td>';
    html += '<td class="num">' + (Math.round(g.points * 10) / 10) + '</td>';
    html += '<td class="num">' + gain + '</td>';
    html += '<td class="muted small">' + (g.gainTeam ? esc(_teamLabel(g.gainTeam)) : "—") + '</td>';
    html += '<td class="num">' + cushion + '</td>';
    html += '<td class="muted small">' + (g.cushionTeam ? esc(_teamLabel(g.cushionTeam)) : "—") + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table></div></div>';
  return html;
}

function _fmtGap(cat, v) {
  if (cat === "OBP") return (v).toFixed(3).replace(/^0/, "");
  if (cat === "ERA" || cat === "WHIP") return v.toFixed(2);
  return Math.round(v).toString();
}

// Unique player names on a team (from the canonical YTD roster).
function _teamPlayerNames(teamId) {
  const r = _standings.ytd?.rosters[teamId] || [];
  return [...new Set(r.map(p => p.name))].sort((a, b) => a < b ? -1 : 1);
}

// Title odds for a roster set (cheaper sim used by what-ifs).
function _oddsFor(rosters) {
  return simulateTitleOdds(rosters, { sims: 1500, fracRemaining: seasonFractionRemaining() });
}

function renderWhatIfCard(myId) {
  let html = '<div class="card"><h3>What-If</h3>';
  // Sub-tab: Add/Drop vs Trade
  html += '<div class="seg" style="display:inline-flex; border:1px solid var(--border); border-radius:6px; overflow:hidden; margin-bottom:10px;">';
  for (const [val, lbl] of [["addrop", "Add / Drop"], ["trade", "Trade"], ["pickups", "Best Pickups"]]) {
    const active = _standings.whatIfTab === val;
    html += '<button class="btn' + (active ? ' primary' : ' ghost') + '" data-witab="' + val +
      '" style="border:0; border-radius:0; padding:5px 12px;">' + lbl + '</button>';
  }
  html += '</div>';
  html += _standings.whatIfTab === "trade" ? renderTradePanel(myId)
        : _standings.whatIfTab === "pickups" ? renderPickupsPanel(myId)
        : renderAddDropPanel(myId);
  html += '</div>';
  return html;
}

function renderAddDropPanel(myId) {
  const roster = (_standings.ytd?.rosters[myId]) || [];
  let html = '';
  html += '<p class="muted small">See how a roster move reshuffles the league and your title odds. Drop one of your players and/or add a free agent.</p>';
  html += '<div style="display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end;">';

  // Drop
  html += '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">Drop' +
    '<select id="wi-drop" style="min-width:180px;"><option value="">— none —</option>';
  for (const p of roster.slice().sort((a, b) => a.name < b.name ? -1 : 1)) {
    const sel = _standings.whatIf.dropName === p.name ? ' selected' : '';
    html += '<option value="' + esc(p.name) + '"' + sel + '>' + esc(p.name) + ' (' + p.type + ')</option>';
  }
  html += '</select></label>';

  // Add (free agent)
  html += '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">Add (free agent)' +
    '<input id="wi-add" list="wi-fa-list" placeholder="' +
    (_standings.faPool ? 'type a name…' : 'click “Load free agents”') + '" style="min-width:200px;" value="' +
    esc(_standings.whatIf.add?.name || "") + '"' + (_standings.faPool ? '' : ' disabled') + '></label>';
  if (_standings.faPool) {
    html += '<datalist id="wi-fa-list">';
    for (const p of _standings.faPool.slice(0, 400)) html += '<option value="' + esc(p.name) + '">';
    html += '</datalist>';
  } else {
    html += '<button class="btn ghost" id="wi-load-fa">Load free agents</button>';
  }
  html += '<button class="btn primary" id="wi-run">Apply</button>';
  html += '<button class="btn ghost" id="wi-clear">Clear</button>';
  html += '</div>';

  // Result — re-optimize my lineup after the move (a worse add won't help).
  if (_standings.whatIf.add || _standings.whatIf.dropName) {
    const beforeMe = _standings.computed.teams.find(t => t.teamId === myId);
    const afterLines = _afterLines({ [myId]: _poolWithMove(myId, _standings.whatIf.dropName, _standings.whatIf.add) });
    const after = computeStandings(afterLines);
    const afterMe = after.teams.find(t => t.teamId === myId);
    const d = { rotoPoints: afterMe.rotoPoints - beforeMe.rotoPoints, place: beforeMe.place - afterMe.place };
    const frac = seasonFractionRemaining();
    const pBefore = simulateTitleOdds(_standings.built, { sims: 1500, fracRemaining: frac }).byTeam[myId]?.pFirst || 0;
    const pAfter = simulateTitleOdds(afterLines, { sims: 1500, fracRemaining: frac }).byTeam[myId]?.pFirst || 0;

    html += '<div style="margin-top:12px; padding-top:10px; border-top:1px solid var(--border);">';
    const moveTxt = [];
    if (_standings.whatIf.dropName) moveTxt.push("drop " + esc(_standings.whatIf.dropName));
    if (_standings.whatIf.add) moveTxt.push("add " + esc(_standings.whatIf.add.name));
    html += '<p class="small">Move: ' + moveTxt.join(" · ") + '</p>';
    html += '<div class="grid cols-3" style="gap:10px;">';
    html += _statBox("Roto points", (Math.round(beforeMe.rotoPoints * 10) / 10) + ' → ' +
      (Math.round(afterMe.rotoPoints * 10) / 10), d.rotoPoints);
    html += _statBox("Standing", ordinal(beforeMe.place) + ' → ' + ordinal(afterMe.place), d.place);
    html += _statBox("Title odds", _pct(pBefore) + ' → ' + _pct(pAfter), (pAfter - pBefore) * 100);
    html += '</div>';

    const rows = [];
    for (const cat of STANDINGS_CATS) {
      const b = beforeMe.byCat[cat].points;
      const a = afterMe.byCat[cat].points;
      if (Math.abs(a - b) > 0.001) rows.push([cat, b, a]);
    }
    if (rows.length) {
      html += '<table style="margin-top:8px;font-size:12px;"><thead><tr><th>Cat</th><th class="num">Before</th><th class="num">After</th><th class="num">Δ</th></tr></thead><tbody>';
      for (const [cat, b, a] of rows) {
        const dd = a - b;
        html += '<tr><td>' + STANDINGS_CAT_LABELS[cat] + '</td><td class="num">' + (Math.round(b * 10) / 10) +
          '</td><td class="num">' + (Math.round(a * 10) / 10) + '</td><td class="num ' +
          (dd > 0 ? 'good' : 'bad') + '">' + (dd > 0 ? '+' : '') + (Math.round(dd * 10) / 10) + '</td></tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';
  }
  return html;
}

// --- Trade what-if -------------------------------------------------------
function renderTradePanel(myId) {
  const teams = LEAGUE.teams.filter(t => t.id !== myId);
  if (!_standings.trade.partner) _standings.trade.partner = teams[0].id;
  const partner = _standings.trade.partner;
  const myNames = _teamPlayerNames(myId);
  const theirNames = _teamPlayerNames(partner);

  let html = '<p class="muted small">Propose a trade and see how it reshuffles the whole league — both teams’ roto points, standing, and title odds. Hold ⌘/Ctrl to pick multiple players.</p>';
  html += '<div style="display:flex; gap:16px; flex-wrap:wrap; align-items:flex-start;">';

  // Partner
  html += '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">Trade with' +
    '<select id="tr-partner" style="min-width:170px;">';
  for (const t of teams) {
    html += '<option value="' + t.id + '"' + (t.id === partner ? ' selected' : '') + '>' + esc(t.owner) + ' — ' + esc(t.name) + '</option>';
  }
  html += '</select></label>';

  // You send
  html += '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">You send (' + esc(_teamLabel(myId)) + ')' +
    '<select id="tr-send" multiple size="7" style="min-width:200px;">';
  for (const nm of myNames) {
    html += '<option value="' + esc(nm) + '"' + (_standings.trade.send.includes(nm) ? ' selected' : '') + '>' + esc(nm) + '</option>';
  }
  html += '</select></label>';

  // You receive
  html += '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">You receive (' + esc(_teamLabel(partner)) + ')' +
    '<select id="tr-recv" multiple size="7" style="min-width:200px;">';
  for (const nm of theirNames) {
    html += '<option value="' + esc(nm) + '"' + (_standings.trade.recv.includes(nm) ? ' selected' : '') + '>' + esc(nm) + '</option>';
  }
  html += '</select></label>';

  html += '<div style="display:flex;flex-direction:column;gap:6px;">' +
    '<button class="btn primary" id="tr-apply">Apply trade</button>' +
    '<button class="btn ghost" id="tr-clear">Clear</button></div>';
  html += '</div>';

  // Result — both teams' lineups re-optimized after the swap.
  const send = _standings.trade.send, recv = _standings.trade.recv;
  if (send.length || recv.length) {
    const afterLines = _afterLines(_poolsAfterTrade(myId, partner, send, recv));
    const before = _standings.computed, aft = computeStandings(afterLines);
    const oddsB = _oddsFor(_standings.built), oddsA = _oddsFor(afterLines);

    html += '<div style="margin-top:12px; padding-top:10px; border-top:1px solid var(--border);">';
    html += '<p class="small">' + esc(_teamLabel(myId)) + ' sends <b>' + (send.map(esc).join(", ") || "—") +
      '</b> · receives <b>' + (recv.map(esc).join(", ") || "—") + '</b></p>';
    html += '<table style="font-size:12px;"><thead><tr><th>Team</th><th class="num">Roto</th><th class="num">Standing</th><th class="num">Title odds</th></tr></thead><tbody>';
    for (const tid of [myId, partner]) {
      const bT = before.teams.find(t => t.teamId === tid), aT = aft.teams.find(t => t.teamId === tid);
      const dR = aT.rotoPoints - bT.rotoPoints, dPlace = bT.place - aT.place;
      const pB = oddsB.byTeam[tid]?.pFirst || 0, pA = oddsA.byTeam[tid]?.pFirst || 0;
      const col = d => d > 0.05 ? 'good' : d < -0.05 ? 'bad' : 'muted';
      html += '<tr' + (tid === myId ? ' style="font-weight:600;"' : '') + '>';
      html += '<td>' + esc(_teamLabel(tid)) + (tid === myId ? ' ◄' : '') + '</td>';
      html += '<td class="num">' + (Math.round(bT.rotoPoints * 10) / 10) + ' → ' + (Math.round(aT.rotoPoints * 10) / 10) +
        ' <span class="' + col(dR) + '">(' + (dR > 0 ? '+' : '') + (Math.round(dR * 10) / 10) + ')</span></td>';
      html += '<td class="num">' + ordinal(bT.place) + ' → ' + ordinal(aT.place) +
        ' <span class="' + col(dPlace) + '">(' + (dPlace > 0 ? '+' : '') + dPlace + ')</span></td>';
      html += '<td class="num">' + _pct(pB) + ' → ' + _pct(pA) +
        ' <span class="' + col((pA - pB) * 100) + '">(' + ((pA - pB) > 0 ? '+' : '') + Math.round((pA - pB) * 100) + 'pp)</span></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';

    // My per-category point swing
    const bMe = before.teams.find(t => t.teamId === myId), aMe = aft.teams.find(t => t.teamId === myId);
    const rows = [];
    for (const cat of STANDINGS_CATS) {
      const b = bMe.byCat[cat].points, a = aMe.byCat[cat].points;
      if (Math.abs(a - b) > 0.001) rows.push([cat, b, a]);
    }
    if (rows.length) {
      html += '<p class="muted small" style="margin-top:8px;">Your category points</p>';
      html += '<table style="font-size:12px;"><thead><tr><th>Cat</th><th class="num">Before</th><th class="num">After</th><th class="num">Δ</th></tr></thead><tbody>';
      for (const [cat, b, a] of rows) {
        const dd = a - b;
        html += '<tr><td>' + STANDINGS_CAT_LABELS[cat] + '</td><td class="num">' + (Math.round(b * 10) / 10) +
          '</td><td class="num">' + (Math.round(a * 10) / 10) + '</td><td class="num ' +
          (dd > 0 ? 'good' : 'bad') + '">' + (dd > 0 ? '+' : '') + (Math.round(dd * 10) / 10) + '</td></tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';
  }
  return html;
}

// --- Best free-agent pickups (by title-odds gain) ------------------------
// Two-stage for speed: screen every candidate FA by the (cheap) deterministic
// roto-point gain from adding them, then run the Monte-Carlo title odds only on
// the top few to report the actual championship-% lift.
function computeBestPickups(myId) {
  const fas = _standings.faPool || [];
  const baseRoto = _standings.computed.teams.find(t => t.teamId === myId).rotoPoints;
  const cands = [];
  let scanned = 0;
  for (const fa of fas) {
    if (scanned >= 90) break;
    const pp = _faToPoolPlayer(fa);
    if (!pp.ros) continue;                    // no projection in this source → skip
    scanned++;
    // Add to my pool, re-optimize my lineup (a FA worse than my starters = no gain).
    const afterLines = _afterLines({ [myId]: (_standings.pool[myId] || []).concat([pp]) });
    const dRoto = computeStandings(afterLines).teams.find(t => t.teamId === myId).rotoPoints - baseRoto;
    cands.push({ fa, dRoto });
  }
  cands.sort((a, b) => b.dRoto - a.dRoto);
  const top = cands.slice(0, 8);
  const frac = seasonFractionRemaining();
  const baseP = simulateTitleOdds(_standings.built, { sims: 1500, fracRemaining: frac }).byTeam[myId]?.pFirst || 0;
  for (const c of top) {
    const afterLines = _afterLines({ [myId]: (_standings.pool[myId] || []).concat([_faToPoolPlayer(c.fa)]) });
    c.pAfter = simulateTitleOdds(afterLines, { sims: 1500, fracRemaining: frac }).byTeam[myId]?.pFirst || 0;
    c.dPct = c.pAfter - baseP;
  }
  top.sort((a, b) => b.dPct - a.dPct || b.dRoto - a.dRoto);
  return { baseP, rows: top, scanned };
}

function renderPickupsPanel(myId) {
  let html = '<p class="muted small">Free agents ranked by how much they’d raise your championship odds. Each FA is slotted into your best lineup (rest-of-season), so only those who out-project a current starter show a gain. Uses the ' +
    esc(getRosSourceLabel(_standings.rosSource) || "selected") + ' projection.</p>';

  if (_standings.mode === "current") {
    return html + '<p class="small warn">Switch to <b>Rest of Season</b> or <b>Full Season</b> — pickups affect the projected finish, not banked stats.</p>';
  }
  if (!_standings.faPool) {
    return html + '<button class="btn primary" id="pk-load">Load free agents & rank</button>';
  }
  if (!_standings.pickups) {
    return html + '<button class="btn primary" id="pk-run">Rank best pickups</button>' +
      ' <span class="muted small">' + _standings.faPool.length + ' free agents loaded.</span>';
  }

  const pk = _standings.pickups;
  html += '<div style="margin-bottom:8px;"><button class="btn ghost" id="pk-run">↻ Re-rank</button>' +
    ' <span class="muted small">Your current title odds: ' + _pct(pk.baseP) + ' · scanned ' + pk.scanned + ' FAs</span></div>';
  if (!pk.rows.length) return html + '<p class="small muted">No free agents with a projection in this source.</p>';
  html += '<div style="overflow-x:auto;"><table><thead><tr>' +
    '<th>#</th><th>Free agent</th><th>Pos</th><th class="num">Title odds after</th><th class="num">Δ odds</th><th class="num">Δ roto</th><th></th></tr></thead><tbody>';
  pk.rows.forEach((c, i) => {
    html += '<tr>';
    html += '<td class="num">' + (i + 1) + '</td>';
    html += '<td>' + esc(c.fa.name) + '</td>';
    html += '<td>' + (c.fa.type === "P" ? "P" : "H") + '</td>';
    html += '<td class="num">' + _pct(c.pAfter) + '</td>';
    html += '<td class="num ' + (c.dPct > 0.0005 ? 'good' : c.dPct < -0.0005 ? 'bad' : '') + '">' +
      (c.dPct > 0 ? '+' : '') + Math.round(c.dPct * 100) + 'pp</td>';
    html += '<td class="num ' + (c.dRoto > 0 ? 'good' : c.dRoto < 0 ? 'bad' : '') + '">' +
      (c.dRoto > 0 ? '+' : '') + (Math.round(c.dRoto * 10) / 10) + '</td>';
    html += '<td><button class="btn ghost" data-pk-add="' + esc(c.fa.name) + '" style="padding:2px 8px;">Try in Add/Drop</button></td>';
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

// Move traded players between two teams' pools (by name). Returns the override
// map {aId: newPool, bId: newPool} for _afterLines.
function _poolsAfterTrade(aId, bId, sendNames, recvNames) {
  const sendSet = new Set(sendNames), recvSet = new Set(recvNames);
  const aPool = _standings.pool[aId] || [], bPool = _standings.pool[bId] || [];
  const aSend = aPool.filter(p => sendSet.has(p.name));
  const bRecv = bPool.filter(p => recvSet.has(p.name));
  return {
    [aId]: aPool.filter(p => !sendSet.has(p.name)).concat(bRecv),
    [bId]: bPool.filter(p => !recvSet.has(p.name)).concat(aSend),
  };
}

function _statBox(label, valueText, delta) {
  const cls = delta > 0 ? 'good' : delta < 0 ? 'bad' : 'muted';
  const sign = delta > 0 ? '+' : '';
  const deltaTxt = Math.abs(delta) < 0.05 ? 'no change' : (sign + (Math.round(delta * 10) / 10));
  return '<div class="stat-row" style="flex-direction:column;align-items:flex-start;border:1px solid var(--border);border-radius:6px;padding:8px;">' +
    '<span class="label muted small">' + label + '</span>' +
    '<span class="value" style="font-size:15px;">' + valueText + '</span>' +
    '<span class="' + cls + ' small">' + deltaTxt + '</span></div>';
}

function wireStandings() {
  document.querySelectorAll("[data-mode]").forEach(b => {
    b.addEventListener("click", () => {
      const m = b.dataset.mode;
      if (m === _standings.mode) return;
      _standings.mode = m;
      if (_modeNeedsRos(m) && !_standings.rosSource) _standings.rosSource = firstLoadedRosSource();
      _standings.whatIf = { add: null, dropName: null };
      if (_standings.ytd) recomputeStandings();
      renderStandings();
    });
  });
  const srcSel = document.getElementById("std-ros-src");
  if (srcSel) srcSel.addEventListener("change", () => {
    _standings.rosSource = srcSel.value;
    if (_standings.ytd) recomputeStandings();
    renderStandings();
  });
  const refresh = document.getElementById("std-refresh");
  if (refresh) refresh.addEventListener("click", loadStandingsData);

  const drop = document.getElementById("wi-drop");
  if (drop) drop.addEventListener("change", () => { _standings.whatIf.dropName = drop.value || null; renderStandings(); });
  const add = document.getElementById("wi-add");
  if (add) add.addEventListener("change", () => {
    const name = add.value.trim();
    _standings.whatIf.add = name && _standings.faPool ? (_standings.faPool.find(p => p.name === name) || null) : null;
    renderStandings();
  });
  const loadFa = document.getElementById("wi-load-fa");
  if (loadFa) loadFa.addEventListener("click", async () => {
    loadFa.textContent = "Loading…"; loadFa.disabled = true;
    try { _standings.faPool = await fetchEspnFreeAgents(0); }
    catch (e) { _standings.error = e.message || String(e); }
    renderStandings();
  });
  const run = document.getElementById("wi-run");
  if (run) run.addEventListener("click", renderStandings);
  const clear = document.getElementById("wi-clear");
  if (clear) clear.addEventListener("click", () => { _standings.whatIf = { add: null, dropName: null }; renderStandings(); });

  // What-if sub-tab (Add/Drop ↔ Trade)
  document.querySelectorAll("[data-witab]").forEach(b => {
    b.addEventListener("click", () => {
      if (_standings.whatIfTab === b.dataset.witab) return;
      _standings.whatIfTab = b.dataset.witab;
      renderStandings();
    });
  });
  // Trade controls
  const partner = document.getElementById("tr-partner");
  if (partner) partner.addEventListener("change", () => {
    _standings.trade.partner = partner.value;
    _standings.trade.recv = [];   // partner changed — clear the receive list
    renderStandings();
  });
  const apply = document.getElementById("tr-apply");
  if (apply) apply.addEventListener("click", () => {
    const sendSel = document.getElementById("tr-send");
    const recvSel = document.getElementById("tr-recv");
    _standings.trade.send = sendSel ? [...sendSel.selectedOptions].map(o => o.value) : [];
    _standings.trade.recv = recvSel ? [...recvSel.selectedOptions].map(o => o.value) : [];
    renderStandings();
  });
  const trClear = document.getElementById("tr-clear");
  if (trClear) trClear.addEventListener("click", () => { _standings.trade.send = []; _standings.trade.recv = []; renderStandings(); });

  // Best Pickups
  const pkLoad = document.getElementById("pk-load");
  if (pkLoad) pkLoad.addEventListener("click", async () => {
    pkLoad.textContent = "Loading…"; pkLoad.disabled = true;
    try { _standings.faPool = await fetchEspnFreeAgents(0); _standings.pickups = computeBestPickups(getMyTeam().id); }
    catch (e) { _standings.error = e.message || String(e); }
    renderStandings();
  });
  const pkRun = document.getElementById("pk-run");
  if (pkRun) pkRun.addEventListener("click", () => {
    pkRun.textContent = "Ranking…"; pkRun.disabled = true;
    // let the button repaint before the (brief) compute blocks
    setTimeout(() => { _standings.pickups = computeBestPickups(getMyTeam().id); renderStandings(); }, 20);
  });
  document.querySelectorAll("[data-pk-add]").forEach(b => {
    b.addEventListener("click", () => {
      const name = b.dataset.pkAdd;
      _standings.whatIf = { add: (_standings.faPool || []).find(p => p.name === name) || null, dropName: null };
      _standings.whatIfTab = "addrop";
      renderStandings();
    });
  });
}
