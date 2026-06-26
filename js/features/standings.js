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
  lineupOverride: { start: new Set(), sit: new Set() },   // your manual force-start/bench
  derivOpen: false,                          // keep the breakdown open across re-renders
  derivTeam: null,                           // which team's breakdown to view (null = mine)
};

// Persist manual lineup overrides across reloads.
const LINEUP_OVERRIDE_KEY = "ud_lineup_override_v1";
function loadLineupOverride() {
  try {
    const o = JSON.parse(localStorage.getItem(LINEUP_OVERRIDE_KEY) || "null");
    if (o) _standings.lineupOverride = { start: new Set(o.start || []), sit: new Set(o.sit || []) };
  } catch {}
}
function saveLineupOverride() {
  localStorage.setItem(LINEUP_OVERRIDE_KEY, JSON.stringify({
    start: [..._standings.lineupOverride.start], sit: [..._standings.lineupOverride.sit],
  }));
}
// Toggle a player between forced-start / forced-bench / auto.
function setLineupOverride(name, mode) {
  const o = _standings.lineupOverride;
  o.start.delete(name); o.sit.delete(name);
  if (mode === "start") o.start.add(name);
  else if (mode === "sit") o.sit.add(name);
  saveLineupOverride();
  _standings.derivOpen = true;   // keep the breakdown open after re-render
  recomputeStandings();
  renderStandings();
}
loadLineupOverride();

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
  // Remaining games-started budget per team under the 200 GS cap.
  const used = _standings.ytd.gsUsed || {};
  _standings.gsRemaining = {};
  for (const tid of Object.keys(_standings.ytd.rosters || {})) {
    _standings.gsRemaining[tid] = Math.max(0, GS_CAP - (used[tid] || 0));
  }
  const built = buildEngineRosters();
  _standings.built = built.rosters;
  _standings.coverage = built.coverage;
  _standings.computed = computeStandings(built.rosters);
  _standings.odds = simulateTitleOdds(built.rosters, { sims: 3000, fracRemaining: seasonFractionRemaining() });
  _standings.pickups = null;   // base changed — best-pickups must be recomputed
}

// --- Optimal lineup -----------------------------------------------------
// HITTERS: roto only counts active lineup slots, so project each team's best
// legal lineup (fill the starting slots with the highest-projected eligible
// players, IL excluded).
//   C(0) 1B(1) 2B(2) 3B(3) SS(4) OF(5)x5 MI(6) CI(7) UTIL(12) = 13
// PITCHERS: every pitcher pitches — relievers' innings all count; starters are
// capped by the league's 200 games-started limit (ESPN statId 33). For ROS we
// allocate the team's REMAINING starts (200 − GS used) to its best starters by
// value-per-start, pro-rating the marginal one. IL excluded.
const LINEUP_HIT_SLOTS = [
  { id: 0, cap: 1 }, { id: 1, cap: 1 }, { id: 2, cap: 1 }, { id: 3, cap: 1 },
  { id: 4, cap: 1 }, { id: 5, cap: 5 }, { id: 6, cap: 1 }, { id: 7, cap: 1 }, { id: 12, cap: 1 },
];
const LINEUP_HIT_TRY = [0, 1, 2, 3, 4, 5, 6, 7, 12]; // dedicated first, UTIL last
const ESPN_IL_SLOT = 17;
const GS_CAP = 200;   // league games-started cap (ESPN lineupSlotStatLimits statId 33)

function _hitValue(r) {
  return (r.R || 0) * 0.7 + (r.RBI || 0) * 0.7 + (r.HR || 0) * 1.3 + (r.SB || 0) * 1.4 +
    Math.max(0, (r.OBP || 0) - 0.300) * (r.PA || 0) * 3;
}
function _pitValue(r) {
  const ip = r.IP || 0;
  return (r.K || 0) * 0.3 + (r.QS || 0) * 2.5 + ((r.SV || 0) + (r.HLD || 0)) * 1.8 +
    Math.max(0, 4.20 - (r.ERA || 9)) * ip * 0.3 + Math.max(0, 1.28 - (r.WHIP || 9)) * ip * 0.5;
}

// Scale a pitcher's counting stats by f (for a starter only partly within the
// remaining GS budget). Rates (ERA/WHIP) are derived from the scaled ER/IP.
function _scalePitcher(r, f) {
  return { ...r, IP: (r.IP || 0) * f, ER: (r.ER || 0) * f, HA: (r.HA || 0) * f,
    BBA: (r.BBA || 0) * f, K: (r.K || 0) * f, QS: (r.QS || 0) * f, GS: (r.GS || 0) * f };
}
// Scale a hitter's stats by f — used for the bench bat that rotates in part-time.
// All on-base components scale too, so OBP contributes at the right (half) weight.
function _scaleHitter(r, f) {
  return { ...r, R: (r.R || 0) * f, HR: (r.HR || 0) * f, RBI: (r.RBI || 0) * f, SB: (r.SB || 0) * f,
    H: (r.H || 0) * f, BB: (r.BB || 0) * f, HBP: (r.HBP || 0) * f, SF: (r.SF || 0) * f,
    AB: (r.AB || 0) * f, PA: (r.PA || 0) * f };
}
// One bench hitter rotates in for a part-season's worth of plate appearances:
// 50% of the starters' average PA (off-days, injuries, platoons). Their rate
// stats are applied over that PA, independent of their own projected playing time.
const BENCH_PA_FRAC = 0.5;

const SLOT_LABEL = { 0: "C", 1: "1B", 2: "2B", 3: "3B", 4: "SS", 5: "OF", 6: "MI", 7: "CI", 12: "UTIL" };

// Eligible starting positions as a short label (e.g. "1B/3B/CI/UTIL").
function _eligPosLabel(eligibleSlots) {
  const order = [0, 1, 2, 3, 4, 5, 6, 7, 12];
  const set = new Set(eligibleSlots || []);
  return order.filter(s => set.has(s)).map(s => SLOT_LABEL[s]).join("/") || "—";
}

// Build a team's counted lineup AND a breakdown of how it was chosen.
//   gsRemaining = starts left under the 200 GS cap (null = no cap)
//   overrides   = { start:Set(names), sit:Set(names) } — manual force-start /
//                 force-bench, applied to the user's own team only.
// IL players are NOT auto-excluded: they compete on their projection (which a
// good ROS source already shrinks for injuries). Force-sit to drop one.
function buildLineup(poolPlayers, gsRemaining, overrides) {
  const startSet = overrides?.start || new Set();
  const sitSet = overrides?.sit || new Set();
  const forced = p => startSet.has(p.name) ? 1 : 0;
  const ilOf = p => p.lineupSlotId === ESPN_IL_SLOT;

  const all = poolPlayers || [];
  const valid = all.filter(p => p.ros && !sitSet.has(p.name));
  const noProj = all.filter(p => !p.ros && !sitSet.has(p.name));
  const sat = all.filter(p => sitSet.has(p.name));   // manually benched
  const lines = [];
  const detail = { hitters: [], benchedHitters: [], relievers: [], starters: [], sat, noProj,
    gsRemaining, spGsProjected: 0, spGsCounted: 0 };

  // A full-time lineup slot's ROS plate appearances — the avg of the team's
  // highest-PA hitters (its everyday regulars), robust to a few injured ones.
  const hPool = valid.filter(p => p.type === "H");
  const paDesc = hPool.map(p => p.ros.PA || 0).sort((a, b) => b - a);
  const nFull = Math.min(13, paDesc.length);
  const fullSlotPA = nFull ? paDesc.slice(0, nFull).reduce((s, x) => s + x, 0) / nFull : 0;
  // Replacement-level per-PA value, for scoring slots that get supplemented.
  const _perPA = p => _hitValue(p.ros) / Math.max(1, p.ros.PA || 0);
  const avgPerPA = hPool.length ? hPool.reduce((s, p) => s + _perPA(p), 0) / hPool.length : 0;
  const replPerPA = 0.6 * avgPerPA;
  // Slot value = the player's own value PLUS the replacement value of the PA a
  // fill-in covers for him. Keeps a good-but-hurt regular (low PA, high rate) in
  // the lineup — supplemented — rather than benched for a healthy scrub.
  const slotScore = p => _hitValue(p.ros) + replPerPA * Math.max(0, fullSlotPA - (p.ros.PA || 0));

  // Hitters → forced-start first, then by slot value; placed greedily.
  const hitters = hPool.sort((a, b) => (forced(b) - forced(a)) || (slotScore(b) - slotScore(a)));
  const open = {};
  for (const s of LINEUP_HIT_SLOTS) open[s.id] = s.cap;
  for (const p of hitters) {
    const elig = new Set(p.eligibleSlots || []);
    let placed = null;
    for (const sid of LINEUP_HIT_TRY) {
      if (open[sid] > 0 && elig.has(sid)) { open[sid]--; placed = sid; break; }
    }
    const e = { name: p.name, ros: p.ros, val: _hitValue(p.ros), elig: p.eligibleSlots, il: ilOf(p), forced: !!forced(p) };
    if (placed != null) { lines.push(p.ros); detail.hitters.push({ ...e, slot: SLOT_LABEL[placed], slotId: placed }); }
    else detail.benchedHitters.push(e);
  }

  // Bench fill-ins: every lineup slot is played all season, so a hurt/low-PA
  // starter's missing plate appearances are covered by a healthy replacement.
  // Fill the PA deficit (full-time target − each starter's projection) plus the
  // usual off-day rotation share, from the best bench bats. Capped per slot and
  // by the deficit so total PA isn't overestimated.
  if (detail.hitters.length) {
    let budget = BENCH_PA_FRAC * fullSlotPA;                  // off-day rotation
    for (const h of detail.hitters) budget += Math.max(0, fullSlotPA - (h.ros.PA || 0)); // injury deficits
    detail.benchFill = { fullSlotPA, players: [] };
    const used = new Set();
    for (const bh of detail.benchedHitters) {
      if (budget < 1) break;
      const bhPA = bh.ros.PA || 0;
      if (bhPA <= 0) continue;
      const fillPA = Math.min(budget, fullSlotPA);   // a replacement plays at most a full slot
      lines.push(_scaleHitter(bh.ros, fillPA / bhPA));
      detail.benchFill.players.push({ ...bh, fillPA, f: fillPA / bhPA });
      used.add(bh);
      budget -= fillPA;
    }
    detail.benchedHitters = detail.benchedHitters.filter(b => !used.has(b));
  }

  // Pitchers → relievers all count; starters forced-first then capped at GS.
  const sps = [];
  for (const p of valid.filter(x => x.type === "P")) {
    const gs = p.ros.GS || 0;
    if (gs >= 1) { sps.push({ name: p.name, ros: p.ros, gs, vps: _pitValue(p.ros) / Math.max(1, gs), il: ilOf(p), forced: !!forced(p) }); detail.spGsProjected += gs; }
    else { lines.push(p.ros); detail.relievers.push({ name: p.name, ros: p.ros, il: ilOf(p) }); }
  }
  sps.sort((a, b) => (forced(b) - forced(a)) || (b.vps - a.vps));
  let budget = (gsRemaining == null) ? Infinity : Math.max(0, gsRemaining);
  for (const s of sps) {
    let counted = 0, frac = 0;
    if (budget > 0) {
      if (s.gs <= budget) { lines.push(s.ros); counted = s.gs; frac = 1; budget -= s.gs; }
      else { frac = budget / s.gs; lines.push(_scalePitcher(s.ros, frac)); counted = budget; budget = 0; }
    }
    detail.spGsCounted += counted;
    detail.starters.push({ name: s.name, gs: s.gs, counted, frac, ros: s.ros, il: s.il, forced: s.forced });
  }
  return { lines, detail };
}

// Return just the counted ROS stat lines (used by the engine builders).
function optimizeStarters(poolPlayers, gsRemaining, overrides) {
  return buildLineup(poolPlayers, gsRemaining, overrides).lines;
}

// Plate appearances a two-way player loses each start he pitches (he's in the
// SP slot, not a hitting slot that day). His hitting projection is docked
// PER_START × his projected remaining starts.
const TWO_WAY_PA_PER_START = 4.5;

// Reduce a hitter's projection by `lostPA` plate appearances (scaling all
// counting components; OBP rate unchanged).
function _reduceHitterPA(r, lostPA) {
  const pa = r.PA || 0;
  if (pa <= 0 || lostPA <= 0) return r;
  return _scaleHitter(r, Math.max(0, (pa - lostPA) / pa));
}

// Per-team pool: every rostered player paired with its ROS line. Two-way
// players (Ohtani) become TWO pool entries — a hitter (PA docked for his
// pitching starts) and a pitcher (his SP line, counted against the GS cap).
function _buildPool() {
  const rosters = _standings.ytd?.rosters || {};
  const src = _standings.rosSource;
  const pool = {};
  const mk = (p, type, ros) => ({ name: p.name, type, eligibleSlots: p.eligibleSlots || [], lineupSlotId: p.lineupSlotId, injuryStatus: p.injuryStatus, ros });
  for (const [tid, players] of Object.entries(rosters)) {
    const arr = [];
    for (const p of players) {
      if (p.twoWay) {
        const pitRos = src ? getRosLine(src, p.name, "P") : null;
        let hitRos = src ? getRosLine(src, p.name, "H") : null;
        if (hitRos && pitRos) hitRos = _reduceHitterPA(hitRos, TWO_WAY_PA_PER_START * (pitRos.GS || 0));
        arr.push(mk(p, "H", hitRos));
        arr.push(mk(p, "P", pitRos));
      } else {
        arr.push(mk(p, p.type, src ? getRosLine(src, p.name, p.type) : null));
      }
    }
    pool[tid] = arr;
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
  const gsRem = _standings.gsRemaining ? _standings.gsRemaining[tid] : null;
  // Manual lineup overrides apply to your own team only; opponents stay auto.
  const ov = (tid === getMyTeam()?.id) ? _standings.lineupOverride : null;
  const starters = optimizeStarters(poolPlayers, gsRem, ov).map(r => {
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
        'Projection: <b>' + esc(getRosSourceLabel(_standings.rosSource)) + '</b> · best lineup: 13 hitters + a bench bat (50% of avg PA) + all pitchers (starts capped at 200 GS/season); IL counted if projected well · ' +
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
    html += renderCoverageBanner(me?.id);   // auto-flag incomplete projections
    // Title odds & what-if are about the FINISH — only meaningful once a
    // projection is layered on (Rest of Season / Full Season). Current mode is
    // a snapshot of what's already banked.
    if (_standings.mode !== "current") html += renderTitleOddsCard(_standings.computed, _standings.odds, me?.id);
    html += renderStandingsTable(_standings.computed, me?.id);
    if (me) html += renderGapCard(_standings.computed, me.id);
    if (me && _standings.mode !== "current") html += renderDerivation(me.id);
    if (_standings.mode !== "current") html += renderCoverageAudit(me?.id);
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

// Transparency: show exactly which players (and how much of each) build the
// user's ROS totals — the optimized lineup, the GS-cap allocation, and what's
// excluded. Collapsible so it doesn't dominate.
function renderDerivation(myId) {
  // View any team; default to yours. Overrides/edit only on your own team.
  const tid = (_standings.derivTeam && _standings.pool?.[_standings.derivTeam]) ? _standings.derivTeam : myId;
  const isMine = tid === myId;
  const pool = _standings.pool?.[tid] || [];
  const gsUsed = (_standings.ytd?.gsUsed?.[tid]) || 0;
  const gsRem = _standings.gsRemaining?.[tid];
  const ov = isMine ? _standings.lineupOverride : { start: new Set(), sit: new Set() };
  const { lines, detail } = buildLineup(pool, gsRem, ov);
  const tot = aggregateTeamCats(lines);
  const modeLbl = _standings.mode === "full" ? "Full-Season" : "Rest-of-Season";
  const hasOverrides = ov.start.size || ov.sit.size;

  // Small controls: ★ forced badge, IL badge, and (your team only) a Start/Bench toggle.
  const badges = (p) => (p.il ? ' <span class="warn" style="font-size:10px;">IL</span>' : '') +
    (p.forced ? ' <span style="color:var(--accent);font-size:10px;">★set</span>' : '');
  const act = (name, inLineup) => {
    if (!isMine) return '<td></td>';   // read-only for opponents
    const forced = ov.start.has(name) || ov.sit.has(name);
    const btn = inLineup
      ? '<button class="btn ghost" data-lo="sit" data-lo-name="' + esc(name) + '" style="padding:0 7px;font-size:11px;">Bench</button>'
      : '<button class="btn ghost" data-lo="start" data-lo-name="' + esc(name) + '" style="padding:0 7px;font-size:11px;">Start</button>';
    return '<td>' + btn + (forced ? ' <a href="#" data-lo="auto" data-lo-name="' + esc(name) + '" style="color:var(--accent);font-size:11px;">auto</a>' : '') + '</td>';
  };

  let html = '<div class="card"><details id="deriv-details"' + (_standings.derivOpen ? ' open' : '') +
    '><summary style="cursor:pointer;"><b>How ' + (isMine ? 'your' : esc(_teamLabel(tid)) + '’s') + ' ' + modeLbl +
    ' total is built</b> <span class="muted small">(' + esc(getRosSourceLabel(_standings.rosSource)) + ' projection)</span></summary>';

  // Team selector
  html += '<label class="small muted" style="display:inline-flex; align-items:center; gap:6px; margin-top:8px;">View team ' +
    '<select id="deriv-team">';
  for (const t of LEAGUE.teams) {
    html += '<option value="' + t.id + '"' + (t.id === tid ? ' selected' : '') + '>' + esc(t.owner) + (t.id === myId ? ' (you)' : '') + '</option>';
  }
  html += '</select></label>';

  if (isMine) {
    html += '<p class="muted small" style="margin-top:6px;">Your best legal lineup (IL players included if they project well). Use <b>Start</b>/<b>Bench</b> to override — the rest re-optimizes around your picks.' +
      (hasOverrides ? ' <button class="btn ghost" id="lo-reset" style="padding:0 8px;font-size:11px;">Reset to optimal</button>' : '') + '</p>';
  } else {
    html += '<p class="muted small" style="margin-top:6px;">' + esc(_teamLabel(tid)) + '’s auto-optimized lineup (read-only) — exactly the stats counted for them in the standings.</p>';
  }

  if (_standings.mode === "full") {
    html += '<p class="muted small">Full-Season = ' + (isMine ? 'your' : 'their') + ' <b>banked YTD</b> (ESPN actuals) + the rest-of-season projection below.</p>';
  }

  // ROS category totals (matches the standings contribution)
  html += '<p class="muted small" style="margin-top:6px;">Rest-of-season totals from this lineup:</p>';
  html += '<table style="font-size:12px;"><tbody><tr>';
  for (const c of STANDINGS_CATS) html += '<th class="num">' + STANDINGS_CAT_LABELS[c] + '</th>';
  html += '</tr><tr>';
  for (const c of STANDINGS_CATS) html += '<td class="num">' + _fmtCat(c, tot[c]) + '</td>';
  html += '</tr></tbody></table>';

  // Hitters — ESPN position order, then the 50% bench bat.
  html += '<h3 style="margin-top:12px;">Hitters (lineup)</h3>';
  html += '<table style="font-size:12px;"><thead><tr><th>Slot</th><th>Player</th><th class="num">R</th><th class="num">HR</th><th class="num">RBI</th><th class="num">SB</th><th class="num">OBP</th><th class="num">PA</th><th></th></tr></thead><tbody>';
  const hitStatCells = (r) => '<td class="num">' + Math.round(r.R || 0) + '</td><td class="num">' + Math.round(r.HR || 0) +
    '</td><td class="num">' + Math.round(r.RBI || 0) + '</td><td class="num">' + Math.round(r.SB || 0) +
    '</td><td class="num">' + (r.OBP || 0).toFixed(3).replace(/^0/, "") + '</td><td class="num">' + Math.round(r.PA || 0) + '</td>';
  for (const h of detail.hitters.slice().sort((a, b) => a.slotId - b.slotId)) {
    html += '<tr><td class="muted">' + h.slot + '</td><td>' + esc(h.name) + badges(h) + '</td>' + hitStatCells(h.ros) + act(h.name, true) + '</tr>';
  }
  for (const bf of (detail.benchFill?.players || [])) {
    html += '<tr class="muted"><td class="muted">BN</td><td>' + esc(bf.name) + ' (fill-in)' + badges(bf) + '</td>' + hitStatCells(_scaleHitter(bf.ros, bf.f)) + act(bf.name, true) + '</tr>';
  }
  html += '</tbody></table>';
  if (detail.benchFill?.players.length) html += '<p class="muted small">Bench fill-ins cover off-days and injured starters (a full-time slot ≈ <b>' +
    Math.round(detail.benchFill.fullSlotPA) + ' PA</b>): ' +
    detail.benchFill.players.map(bf => esc(bf.name) + ' ' + Math.round(bf.fillPA) + ' PA').join(", ") + '.</p>';

  // Benched hitters (out-projected) — with eligibility + value so you can see why.
  if (detail.benchedHitters.length) {
    html += '<p class="muted small" style="margin-top:8px;">Not in lineup — out-projected at every eligible slot (Start to force in):</p>';
    html += '<table style="font-size:12px;"><thead><tr><th>Player</th><th>Eligible</th><th class="num">HR</th><th class="num">SB</th><th class="num">OBP</th><th class="num">PA</th><th class="num">value</th><th></th></tr></thead><tbody>';
    for (const b of detail.benchedHitters.slice().sort((a, b2) => b2.val - a.val)) {
      const r = b.ros;
      html += '<tr><td>' + esc(b.name) + badges(b) + '</td><td class="muted small">' + _eligPosLabel(b.elig) + '</td>' +
        '<td class="num">' + Math.round(r.HR || 0) + '</td><td class="num">' + Math.round(r.SB || 0) + '</td>' +
        '<td class="num">' + (r.OBP || 0).toFixed(3).replace(/^0/, "") + '</td><td class="num">' + Math.round(r.PA || 0) + '</td>' +
        '<td class="num">' + Math.round(b.val) + '</td>' + act(b.name, false) + '</tr>';
    }
    html += '</tbody></table>';
  }

  // Pitchers + GS cap
  html += '<h3 style="margin-top:12px;">Pitchers</h3>';
  html += '<p class="small ' + (detail.spGsProjected > (gsRem ?? 1e9) ? 'warn' : 'muted') + '">' +
    'Games started: <b>' + Math.round(gsUsed) + '</b> used / ' + GS_CAP + ' cap → <b>' + Math.round(gsRem ?? 0) + '</b> left. ' +
    'Starters project <b>' + Math.round(detail.spGsProjected) + '</b> starts; <b>' + Math.round(detail.spGsCounted) + '</b> counted' +
    (detail.spGsProjected > (gsRem ?? 1e9) ? ' (capped — lowest-value starts dropped).' : '.') + '</p>';
  if (detail.starters.length) {
    html += '<table style="font-size:12px;"><thead><tr><th>Starter</th><th class="num">GS proj</th><th class="num">GS counted</th><th class="num">IP</th><th class="num">K</th><th class="num">QS</th><th class="num">ERA</th><th class="num">WHIP</th><th></th></tr></thead><tbody>';
    for (const s of detail.starters) {
      const r = s.ros, dropped = s.counted <= 0, partial = s.frac > 0 && s.frac < 1;
      const note = dropped ? ' <span class="bad small">(over cap)</span>' : partial ? ' <span class="warn small">(' + Math.round(s.frac * 100) + '%)</span>' : '';
      html += '<tr' + (dropped ? ' class="muted"' : '') + '><td>' + esc(s.name) + note + badges(s) + '</td>' +
        '<td class="num">' + Math.round(s.gs) + '</td><td class="num">' + (Math.round(s.counted * 10) / 10) + '</td>' +
        '<td class="num">' + Math.round((r.IP || 0) * (dropped ? 0 : s.frac)) + '</td>' +
        '<td class="num">' + Math.round((r.K || 0) * (dropped ? 0 : s.frac)) + '</td>' +
        '<td class="num">' + Math.round((r.QS || 0) * (dropped ? 0 : s.frac)) + '</td>' +
        '<td class="num">' + (r.ERA || 0).toFixed(2) + '</td><td class="num">' + (r.WHIP || 0).toFixed(2) + '</td>' + act(s.name, !dropped) + '</tr>';
    }
    html += '</tbody></table>';
  }
  if (detail.relievers.length) {
    html += '<p class="muted small" style="margin-top:8px;">Relievers (all innings count):</p>';
    html += '<table style="font-size:12px;"><thead><tr><th>Reliever</th><th class="num">IP</th><th class="num">K</th><th class="num">SV</th><th class="num">HLD</th><th class="num">ERA</th><th class="num">WHIP</th><th></th></tr></thead><tbody>';
    for (const rp of detail.relievers) {
      const r = rp.ros;
      html += '<tr><td>' + esc(rp.name) + badges(rp) + '</td><td class="num">' + Math.round(r.IP || 0) + '</td>' +
        '<td class="num">' + Math.round(r.K || 0) + '</td><td class="num">' + Math.round(r.SV || 0) + '</td>' +
        '<td class="num">' + Math.round(r.HLD || 0) + '</td><td class="num">' + (r.ERA || 0).toFixed(2) + '</td>' +
        '<td class="num">' + (r.WHIP || 0).toFixed(2) + '</td>' + act(rp.name, true) + '</tr>';
    }
    html += '</tbody></table>';
  }

  // Manually benched + no-projection
  const foot = [];
  if (detail.sat.length) foot.push('Benched by you: ' + detail.sat.map(p => esc(p.name) + ' <a href="#" data-lo="auto" data-lo-name="' + esc(p.name) + '" style="color:var(--accent);">restore</a>').join(", "));
  if (detail.noProj.length) foot.push('No projection in this source (not counted): ' + detail.noProj.map(p => esc(p.name)).join(", "));
  if (foot.length) {
    html += '<div class="small muted" style="margin-top:10px; padding-top:8px; border-top:1px solid var(--border);">' +
      foot.map(e => '<div>' + e + '</div>').join("") + '</div>';
  }

  html += '</details></div>';
  return html;
}

// Is a rostered player injured (on the IL or carrying a DL/OUT status)? Such a
// player legitimately has no projection — expected, not a data error.
function _isInjured(p) {
  if (p.lineupSlotId === ESPN_IL_SLOT) return true;
  const s = p.injuryStatus || "";
  return /DL|IL|OUT/.test(s);   // SIXTY_DAY_DL, TEN_DAY_DL, OUT, etc. (not DAY_TO_DAY/ACTIVE)
}

// Rostered players with NO projection (hitter: no PA, pitcher: no IP), split
// into `active` (likely a data problem to fix) and `injured` (expected).
function _coverageFlags(myId) {
  const active = [], injured = [];
  if (!_standings.pool) return { active, injured };
  for (const [tid, players] of Object.entries(_standings.pool)) {
    for (const p of players) {
      const missing = p.type === "H" ? !(p.ros && (p.ros.PA || 0) > 0) : !(p.ros && (p.ros.IP || 0) > 0);
      if (!missing) continue;
      const row = { name: p.name, owner: _teamLabel(tid), mine: tid === myId, type: p.type };
      (_isInjured(p) ? injured : active).push(row);
    }
  }
  return { active, injured };
}

// Auto-banner — only for ACTIVE players missing a projection (a real import gap).
// Injured/out players are expected and don't trigger it.
function renderCoverageBanner(myId) {
  if (_standings.mode === "current" || !firstLoadedRosSource()) return "";
  const { active } = _coverageFlags(myId);
  if (!active.length) return "";
  const mine = active.filter(m => m.mine).map(m => m.name + (m.type === "P" ? " (pitching)" : ""));
  let html = '<div class="card" style="border-color: rgba(248,81,73,.55); background: rgba(248,81,73,.06);">';
  html += '<p class="bad" style="margin:0;"><b>⚠ ' + active.length + ' healthy rostered player' + (active.length === 1 ? '' : 's') +
    ' have no projection</b> in ' + esc(getRosSourceLabel(_standings.rosSource)) +
    ' — likely an incomplete import or name mismatch (these players score zero).</p>';
  if (mine.length) html += '<p class="small" style="margin:4px 0 0;">On your team: <b>' + mine.map(esc).join(", ") + '</b>.</p>';
  html += '<p class="small muted" style="margin:4px 0 0;">Re-import this source via <b>file upload</b> on the Data tab. Full list in “Projection coverage” below.</p>';
  html += '</div>';
  return html;
}

function renderCoverageAudit(myId) {
  if (!_standings.pool) return "";
  const { active, injured } = _coverageFlags(myId);
  if (!active.length && !injured.length) {
    return '<div class="card"><p class="small good">✓ Projection coverage complete — every healthy rostered player has a projection.</p></div>';
  }
  const sortFn = (a, b) => (b.mine - a.mine) || (a.owner < b.owner ? -1 : 1);
  active.sort(sortFn); injured.sort(sortFn);
  const nameCell = (f) => '<td' + (f.mine ? ' style="font-weight:600;"' : '') + '>' + esc(f.name) +
    (f.type === "P" ? ' <span class="muted small">(pitching)</span>' : '') + (f.mine ? ' ◄' : '') + '</td>' +
    '<td class="muted small">' + esc(f.owner) + '</td>';

  let html = '<div class="card"><details' + (active.length ? ' open' : '') + '><summary style="cursor:pointer;"><b>Projection coverage</b> ' +
    '<span class="small ' + (active.length ? 'bad' : 'good') + '">' + active.length + ' to fix</span>' +
    (injured.length ? ' <span class="small muted">· ' + injured.length + ' injured (expected)</span>' : '') + '</summary>';

  if (active.length) {
    html += '<p class="muted small" style="margin-top:8px;"><b>Healthy players with no projection</b> — likely an incomplete import or name mismatch. Re-import that source (file upload). Tell me any names that should match and I’ll fix the matcher.</p>';
    html += '<table style="font-size:12px;"><thead><tr><th>Player</th><th>Team</th></tr></thead><tbody>';
    for (const f of active) html += '<tr>' + nameCell(f) + '</tr>';
    html += '</tbody></table>';
  } else {
    html += '<p class="small good" style="margin-top:8px;">✓ Every healthy rostered player has a projection.</p>';
  }

  if (injured.length) {
    html += '<details style="margin-top:10px;"><summary class="muted small" style="cursor:pointer;">' + injured.length + ' injured / IL players with no projection (expected — they’re out)</summary>';
    html += '<table style="font-size:12px; margin-top:6px;"><tbody>';
    for (const f of injured) html += '<tr>' + nameCell(f) + '</tr>';
    html += '</tbody></table></details>';
  }
  html += '</details></div>';
  return html;
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

  // Lineup overrides (Start / Bench / restore-to-auto) in the breakdown.
  document.querySelectorAll("[data-lo]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      setLineupOverride(el.dataset.loName, el.dataset.lo);
    });
  });
  const loReset = document.getElementById("lo-reset");
  if (loReset) loReset.addEventListener("click", () => {
    _standings.lineupOverride = { start: new Set(), sit: new Set() };
    saveLineupOverride();
    _standings.derivOpen = true;
    recomputeStandings();
    renderStandings();
  });
  const dd = document.getElementById("deriv-details");
  if (dd) dd.addEventListener("toggle", () => { _standings.derivOpen = dd.open; });
  const dt = document.getElementById("deriv-team");
  if (dt) dt.addEventListener("change", () => {
    _standings.derivTeam = dt.value;
    _standings.derivOpen = true;
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
