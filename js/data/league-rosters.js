// Authoritative roster + contract data, pulled live from The League App
// (jwarshafsky/the-league → js/data.js, the hand-maintained source of truth).
// The live ESPN roster pull is unreliable for keeper purposes (shows dropped/FA
// players, no contract data), so the Keepers page uses THIS instead.
//
// Each team has:
//   majors:  { name, price, yearAcquired, fromMinors }
//   callups: { name, yearAcquired, careerStat, statType }   (MiL-origin, on ML roster)
//   minors:  { name, yearAcquired, careerStat, statType }
//
// Contract logic below is a faithful port of The League App's getContractStatus
// + getMinorLeagueContractStatus (js/app.js).

const LEAGUE_ROSTERS_URL = "https://raw.githubusercontent.com/jwarshafsky/the-league/main/js/data.js";
const LEAGUE_ROSTERS_KEY = "ud_league_rosters_v1";

let _leagueRosters = null;     // parsed LEAGUE_DATA object
let _leagueRostersAt = null;   // ISO timestamp of last successful fetch
let _leagueRostersLoading = false;

// Pull the LEAGUE_DATA object literal out of the raw data.js text. Brace-balanced
// so nested objects/arrays and quoted strings are handled; eval'd via Function
// (it's JS with unquoted keys + comments, so JSON.parse won't do).
function _extractLeagueData(txt) {
  const i = txt.indexOf("LEAGUE_DATA");
  if (i < 0) return null;
  const start = txt.indexOf("{", i);
  if (start < 0) return null;
  let depth = 0, inStr = null, end = -1;
  for (let j = start; j < txt.length; j++) {
    const ch = txt[j], prev = txt[j - 1];
    if (inStr) { if (ch === inStr && prev !== "\\") inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { if (--depth === 0) { end = j; break; } }
  }
  if (end < 0) return null;
  try { return (new Function("return (" + txt.slice(start, end + 1) + ")"))(); }
  catch (e) { console.warn("LEAGUE_DATA parse failed:", e); return null; }
}

function _loadLeagueRostersFromCache() {
  try {
    const c = JSON.parse(localStorage.getItem(LEAGUE_ROSTERS_KEY) || "null");
    if (c && c.data) { _leagueRosters = c.data; _leagueRostersAt = c.at || null; _leagueIdx = null; _adjTeams = null; }
  } catch (e) { /* ignore */ }
}

// Fetch the latest data.js and parse it. Falls back to cache on failure.
async function loadLeagueRosters(force) {
  if (_leagueRostersLoading) return _leagueRosters;
  // Serve the cache only while it's fresh (<12h) — contracts/rosters change
  // after trades and callups, and the old behavior pinned a stale localStorage
  // copy for the whole season unless the refresh button was pressed.
  const freshMs = 12 * 3600 * 1000;
  const fresh = _leagueRostersAt && (Date.now() - new Date(_leagueRostersAt).getTime()) < freshMs;
  if (_leagueRosters && !force && fresh) return _leagueRosters;
  _leagueRostersLoading = true;
  try {
    const r = await fetch(LEAGUE_ROSTERS_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("the-league data.js → " + r.status);
    const data = _extractLeagueData(await r.text());
    if (!data || !Array.isArray(data.teams)) throw new Error("could not parse LEAGUE_DATA");
    _leagueRosters = data;
    _leagueRostersAt = new Date().toISOString();
    _leagueIdx = null;
    _adjTeams = null;
    localStorage.setItem(LEAGUE_ROSTERS_KEY, JSON.stringify({ data, at: _leagueRostersAt }));
  } catch (e) {
    console.warn("loadLeagueRosters:", e.message || e);
    if (!_leagueRosters) _loadLeagueRostersFromCache();   // offline / blocked → cache
    if (!_leagueRosters) throw e;
  } finally {
    _leagueRostersLoading = false;
  }
  return _leagueRosters;
}

function getLeagueRosterData() {
  if (!_leagueRosters) return null;
  return { ..._leagueRosters, teams: _adjustedLeagueTeams() };
}
function getLeagueRostersUpdatedAt() { return _leagueRostersAt; }
function leagueRosterSeason() { return _leagueRosters ? _leagueRosters.season : (new Date().getFullYear()); }
function getLeagueTeamRoster(teamId) {
  const teams = _adjustedLeagueTeams();
  return teams ? teams.find(t => t.id === teamId) || null : null;
}

// --- Supabase roster adjustments -----------------------------------------
// data.js is the hand-maintained BASELINE; moves made in The League App live
// only in Supabase (trades, callup_overrides, roster_moves) and are applied
// at runtime by applyRosterAdjustments() there. Without the same layer here,
// a traded minor-leaguer keeps showing on his old team's keeper board
// (Cole Young, Aug 2026). Faithful port of the app's logic, minus
// minors-draft picks (UD doesn't load draft state; the periodic data.js
// re-import covers those).

let _adjTeams = null;   // cache; cleared on new baseline or Supabase change

// Find a player's baseline record (for a trade of someone the adjusted lists
// no longer contain — mirrors _findOriginalMinorRecord in the app).
function _lrOriginalRecord(name) {
  for (const t of _leagueRosters.teams) {
    for (const list of ["minors", "callups"]) {
      const p = (t[list] || []).find(x => x.name === name);
      if (p) return { ...p };
    }
  }
  return null;
}

// Move `name` from fromId's list to toId's list within `map` (teamId →
// array). Falls back to wherever the player actually lives (chained trades),
// then to `otherMap` (callup-typed asset still sitting in minors, or vice
// versa), then to the baseline record. Mirrors _moveBetweenLists in the app.
function _lrMove(map, fromId, toId, name, otherMap) {
  let player = null;
  const pull = (m, tid) => {
    const list = m.get(tid) || [];
    const i = list.findIndex(p => p.name === name);
    if (i === -1) return null;
    return list.splice(i, 1)[0];
  };
  player = pull(map, fromId);
  if (!player) {
    for (const tid of map.keys()) { player = pull(map, tid); if (player) break; }
  }
  if (!player && otherMap) {
    for (const tid of otherMap.keys()) { player = pull(otherMap, tid); if (player) break; }
  }
  if (!player) player = _lrOriginalRecord(name);
  if (!player) return;
  const toList = map.get(toId) || [];
  if (!toList.find(p => p.name === player.name)) toList.push({ ...player });
  map.set(toId, toList);
}

function _lrApplyTradeSide(minors, callups, fromId, toId, receives) {
  for (const a of (receives || [])) {
    const name = a.value || a.name;
    if (!name) continue;
    if (a.type === "minor") _lrMove(minors, fromId, toId, name, callups);
    else if (a.type === "callup") _lrMove(callups, fromId, toId, name, minors);
    else if (a.type === "major") {
      // ML ownership is ESPN's job (live rosters), but if the player also
      // occupies a call-up slot, that record must follow the trade too.
      let inCallups = false;
      for (const list of callups.values()) if (list.some(p => p.name === name)) { inCallups = true; break; }
      if (inCallups) _lrMove(callups, fromId, toId, name, null);
    }
  }
}

function _adjustedLeagueTeams() {
  if (!_leagueRosters) return null;
  if (_adjTeams) return _adjTeams;
  const minors = new Map(), callups = new Map();
  for (const t of _leagueRosters.teams) {
    minors.set(t.id, (t.minors || []).map(p => ({ ...p })));
    callups.set(t.id, (t.callups || []).map(p => ({ ...p })));
  }
  // 1. Trades, chronologically. team1_receives = what team1 GETS (from team2).
  const trades = (typeof getTrades === "function") ? getTrades() : [];
  const sorted = [...trades].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  for (const t of sorted) {
    _lrApplyTradeSide(minors, callups, t.team2, t.team1, t.team1_receives);
    _lrApplyTradeSide(minors, callups, t.team1, t.team2, t.team2_receives);
  }
  // 2. Legacy callup_overrides: promote minors → callups within the team.
  const overrides = (typeof getCallupOverrides === "function") ? getCallupOverrides() : {};
  for (const name of Object.keys(overrides)) {
    for (const [tid, list] of minors.entries()) {
      const i = list.findIndex(p => p.name === name);
      if (i !== -1) {
        const player = list.splice(i, 1)[0];
        const c = callups.get(tid) || [];
        if (!c.find(p => p.name === player.name)) c.push(player);
        callups.set(tid, c);
        break;
      }
    }
  }
  // 3. roster_moves in time order: callup / demote / drop.
  const moves = (typeof getRosterMoves === "function") ? getRosterMoves() : [];
  const sortedMoves = [...moves].sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  for (const m of sortedMoves) {
    if (!m || !m.player_name || !m.team_id) continue;
    const tm = minors.get(m.team_id) || [], tc = callups.get(m.team_id) || [];
    if (m.kind === "callup") {
      const i = tm.findIndex(p => p.name === m.player_name);
      if (i !== -1) {
        const player = tm.splice(i, 1)[0];
        if (!tc.find(p => p.name === player.name)) tc.push(player);
        callups.set(m.team_id, tc);
      }
    } else if (m.kind === "demote") {
      const i = tc.findIndex(p => p.name === m.player_name);
      if (i !== -1) {
        const player = tc.splice(i, 1)[0];
        const existing = tm.find(p => p.name === player.name);
        if (existing) existing.sendDownCount = (existing.sendDownCount || 0) + 1;
        else tm.push({ ...player, sentDown: true, sendDownCount: (player.sendDownCount || 0) + 1 });
        minors.set(m.team_id, tm);
      }
    } else if (m.kind === "drop") {
      const i = tm.findIndex(p => p.name === m.player_name);
      if (i !== -1) tm.splice(i, 1);
      const j = tc.findIndex(p => p.name === m.player_name);
      if (j !== -1) tc.splice(j, 1);
    }
  }
  _adjTeams = _leagueRosters.teams.map(t => ({
    ...t,
    minors: minors.get(t.id) || [],
    callups: callups.get(t.id) || [],
  }));
  return _adjTeams;
}

// Supabase data changing (a trade entered in The League App) must invalidate
// the adjusted rosters AND the name index built from them.
if (typeof onDataChange === "function") {
  onDataChange(() => { _adjTeams = null; _leagueIdx = null; });
}

// Normalized-name index of every contracted player across all teams, so we can
// overlay a contract onto whoever ESPN says is currently rostered (by name,
// regardless of which team's anchor they were last recorded on). Built from
// the ADJUSTED rosters so kind/teamId reflect Supabase trades and moves.
let _leagueIdx = null;
function _leagueNameIndex() {
  if (_leagueIdx) return _leagueIdx;
  const norm = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const idx = {};
  const teams = _adjustedLeagueTeams();
  if (teams) {
    for (const t of teams) {
      for (const [list, kind] of [["majors", "major"], ["callups", "callup"], ["minors", "minor"]]) {
        for (const p of (t[list] || [])) idx[norm(p.name)] = { teamId: t.id, kind, player: p };
      }
    }
  }
  _leagueIdx = idx;
  return idx;
}

// Contract + keeper cost for a player by name (any team). Returns null if The
// League App has no contract on file (i.e. a FA pickup). season optional.
function getLeagueContractByName(name, season) {
  const norm = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const hit = _leagueNameIndex()[norm(name)];
  if (!hit) return null;
  season = season || leagueRosterSeason();
  if (hit.kind === "major") {
    const c = leagueMajorContract(hit.player, season);
    return { kind: "major", contract: c, cost: c.nextYearPrice, costMissing: false, teamId: hit.teamId };
  }
  const c = leagueMinorContract(hit.player, season);
  let cost = 0, costMissing = false;
  if (hit.kind === "callup") {
    const ov = (typeof getCallupOverride === "function") ? getCallupOverride(hit.player.name) : null;
    cost = ov && ov.price != null ? ov.price : 0;
    costMissing = !(ov && ov.price != null);
  }
  return { kind: hit.kind, contract: c, cost, costMissing, teamId: hit.teamId };
}

// --- Contract logic (ported from The League App app.js) ---

function _maxKeepYearsLR(originalPrice, fromMinors) {
  if (fromMinors) return 3;
  if (originalPrice > 50) return 1;
  if (originalPrice > 40) return 2;
  return 3;
}

// Major-league contract status for { name, price, yearAcquired, fromMinors }.
function leagueMajorContract(player, season) {
  const rawYearsKept = season - player.yearAcquired;
  const preContract = rawYearsKept < 0;
  const yearsKept = preContract ? 0 : rawYearsKept;
  const originalPrice = preContract ? player.price : player.price - yearsKept * 2;
  const maxYears = _maxKeepYearsLR(originalPrice, player.fromMinors);
  const yearsRemaining = maxYears - yearsKept;
  const nextYearPrice = preContract ? player.price : player.price + 2;
  const canKeepNextSeason = yearsRemaining > 0;
  let status, label;
  if (yearsRemaining <= 0) { status = "final"; label = "Final year — can't keep " + (season + 1); }
  else if (yearsRemaining === 1) { status = "expiring"; label = "1 keeper yr left"; }
  else { status = "ok"; label = yearsRemaining + " keeper yrs left"; }
  return { known: true, kind: "major", canKeepNextSeason, status, label,
    yearsKept, yearsRemaining, originalPrice, maxYears, nextYearPrice, fromMinors: !!player.fromMinors };
}

// Minor-league / call-up contract status for { name, yearAcquired, careerStat, statType }.
function leagueMinorContract(player, season) {
  const yearDrafted = player.yearAcquired;
  const yearsHeld = season - yearDrafted;
  let maxYears, contractNote;
  if (yearDrafted < 2027) { maxYears = 4; contractNote = "4-yr MiL contract"; }
  else { maxYears = 99; contractNote = "Call-up + 3"; }
  // Seasons remaining AFTER the current one (pre-2027 contracts only).
  const yearsRemaining = yearDrafted < 2027 ? Math.max(0, maxYears - yearsHeld - 1) : null;
  // §3(f) must-call-up trigger.
  let eligibilityWarning = null;
  if ((player.statType === "AB" && player.careerStat >= 300) ||
      (player.statType === "IP" && player.careerStat >= 75)) {
    eligibilityWarning = (season + 1) + " Must Call Up";
  }
  const canKeepNextSeason = yearsRemaining == null ? true : yearsRemaining > 0;
  let status, label;
  if (yearsRemaining == null) { status = "ok"; label = contractNote; }
  else if (yearsRemaining <= 0) { status = "final"; label = "Final MiL year — can't keep " + (season + 1); }
  else if (yearsRemaining === 1) { status = "expiring"; label = "1 MiL yr left"; }
  else { status = "ok"; label = yearsRemaining + " MiL yrs left"; }
  if (eligibilityWarning) label += " · " + eligibilityWarning;
  return { known: true, kind: "minor", canKeepNextSeason, status, label,
    yearsHeld, yearsRemaining, contractNote, eligibilityWarning };
}

_loadLeagueRostersFromCache();   // seed from cache immediately; refresh async
