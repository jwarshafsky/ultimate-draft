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
  whatIfTab: "addrop",                       // "addrop" | "trade"
  trade: { partner: null, send: [], recv: [] },
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
  const built = buildEngineRosters();
  _standings.built = built.rosters;
  _standings.coverage = built.coverage;
  _standings.computed = computeStandings(built.rosters);
  _standings.odds = simulateTitleOdds(built.rosters, { sims: 3000, fracRemaining: seasonFractionRemaining() });
}

function buildEngineRosters() {
  const ytdTeam = _standings.ytd?.ytdTeam || {};   // ESPN's actual accumulated totals
  const rosters = _standings.ytd?.rosters || {};   // current roster players (for ROS + what-if)
  const teamIds = Object.keys(ytdTeam).length ? Object.keys(ytdTeam) : Object.keys(rosters);

  // Current = ESPN's official season-to-date totals (matches their standings).
  if (_standings.mode === "current") {
    const out = {};
    for (const tid of teamIds) out[tid] = (ytdTeam[tid] || []).slice();
    return { rosters: out, coverage: null };
  }

  const includeYtd = _standings.mode === "full";   // full = YTD + ROS; ros = ROS only
  const src = _standings.rosSource;
  const out = {};
  let matched = 0, total = 0;
  for (const tid of teamIds) {
    const arr = [];
    if (includeYtd) for (const l of (ytdTeam[tid] || [])) arr.push(l); // ESPN actual YTD
    for (const p of (rosters[tid] || [])) {
      total++;
      const ros = src ? getRosLine(src, p.name, p.type) : null;
      if (ros) {
        // Tag ROS only in full mode, where the YTD/ROS split drives the
        // title-odds "fraction remaining". In ROS-only mode there's no YTD, so
        // leave untagged and let the sim use the calendar estimate.
        if (includeYtd) ros._ros = true; else delete ros._ros;
        arr.push(ros);
        matched++;
      }
    }
    out[tid] = arr;
  }
  return { rosters: out, coverage: { matched, total } };
}

// Stat lines to add for a what-if, per mode:
//   current → the FA's YTD line; ros → its ROS line only; full → YTD + ROS.
function _whatIfAddLines(fa) {
  if (!fa) return null;
  const ros = _standings.rosSource ? getRosLine(_standings.rosSource, fa.name, fa.type) : null;
  if (_standings.mode === "current") return [fa];
  if (_standings.mode === "ros") { if (ros) delete ros._ros; return ros ? [ros] : []; }
  if (ros) ros._ros = true;   // full
  return ros ? [fa, ros] : [fa];
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
      html += '<p class="small bad" style="margin-top:8px;">No projections loaded yet. ' +
        '<button class="btn primary" id="std-load-hosted" style="padding:3px 10px;">⬇ Load latest projections</button> ' +
        ' or import a CSV on the <b>Data</b> tab.</p>';
    } else if (_standings.coverage) {
      const cv = _standings.coverage;
      const pctMatched = cv.total ? Math.round(cv.matched / cv.total * 100) : 0;
      const tail = _standings.mode === "full" ? "Unmatched players count YTD only." : "Unmatched players contribute nothing (no projection).";
      html += '<p class="small ' + (pctMatched >= 80 ? 'muted' : 'warn') + '" style="margin-top:8px;">' +
        'Projection: <b>' + esc(getRosSourceLabel(_standings.rosSource)) + '</b> · matched ' +
        cv.matched + '/' + cv.total + ' rostered players (' + pctMatched + '%). ' + tail + '</p>';
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
  for (const [val, lbl] of [["addrop", "Add / Drop"], ["trade", "Trade"]]) {
    const active = _standings.whatIfTab === val;
    html += '<button class="btn' + (active ? ' primary' : ' ghost') + '" data-witab="' + val +
      '" style="border:0; border-radius:0; padding:5px 12px;">' + lbl + '</button>';
  }
  html += '</div>';
  html += (_standings.whatIfTab === "trade") ? renderTradePanel(myId) : renderAddDropPanel(myId);
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

  // Result
  if (_standings.whatIf.add || _standings.whatIf.dropName) {
    const baseRosters = _standings.built;
    const addLines = _whatIfAddLines(_standings.whatIf.add);
    const res = whatIfStandings(baseRosters, {
      teamId: myId, add: addLines, dropName: _standings.whatIf.dropName,
    });
    const d = res.delta;
    const beforeMe = res.before.teams.find(t => t.teamId === myId);
    const afterMe = res.after.teams.find(t => t.teamId === myId);

    // Title-odds before/after (cheaper sim — what-if recomputes on demand).
    const afterRosters = _afterRosters(baseRosters, myId, addLines, _standings.whatIf.dropName);
    const frac = seasonFractionRemaining();
    const oddsBefore = simulateTitleOdds(baseRosters, { sims: 1500, fracRemaining: frac });
    const oddsAfter = simulateTitleOdds(afterRosters, { sims: 1500, fracRemaining: frac });
    const pBefore = oddsBefore.byTeam[myId]?.pFirst || 0;
    const pAfter = oddsAfter.byTeam[myId]?.pFirst || 0;

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

  // Result
  const send = _standings.trade.send, recv = _standings.trade.recv;
  if (send.length || recv.length) {
    const base = _standings.built;
    const after = _afterTradeRosters(base, myId, partner, send, recv);
    const before = computeStandings(base), aft = computeStandings(after);
    const oddsB = _oddsFor(base), oddsA = _oddsFor(after);

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

// Move traded players (all their stat lines, matched by name) between two teams.
function _afterTradeRosters(base, aId, bId, sendNames, recvNames) {
  const next = {};
  for (const [id, players] of Object.entries(base)) next[id] = players.slice();
  const sendSet = new Set(sendNames), recvSet = new Set(recvNames);
  const aSend = (next[aId] || []).filter(l => sendSet.has(l.name));
  const bRecv = (next[bId] || []).filter(l => recvSet.has(l.name));
  next[aId] = (next[aId] || []).filter(l => !sendSet.has(l.name)).concat(bRecv);
  next[bId] = (next[bId] || []).filter(l => !recvSet.has(l.name)).concat(aSend);
  return next;
}

function _afterRosters(baseRosters, teamId, addLines, dropName) {
  const next = {};
  for (const [id, players] of Object.entries(baseRosters)) next[id] = players.slice();
  if (next[teamId]) {
    if (dropName) next[teamId] = next[teamId].filter(p => p.name !== dropName);
    if (addLines) next[teamId] = next[teamId].concat(addLines);
  }
  return next;
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
  const loadHosted = document.getElementById("std-load-hosted");
  if (loadHosted) loadHosted.addEventListener("click", async () => {
    loadHosted.textContent = "Loading…"; loadHosted.disabled = true;
    await loadAllHostedRos();
    if (!_standings.rosSource) _standings.rosSource = firstLoadedRosSource();
    if (_standings.ytd) recomputeStandings();
    renderStandings();
  });

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
}
