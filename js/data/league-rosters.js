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
    if (c && c.data) { _leagueRosters = c.data; _leagueRostersAt = c.at || null; _leagueIdx = null; }
  } catch (e) { /* ignore */ }
}

// Fetch the latest data.js and parse it. Falls back to cache on failure.
async function loadLeagueRosters(force) {
  if (_leagueRostersLoading) return _leagueRosters;
  if (_leagueRosters && !force) return _leagueRosters;
  _leagueRostersLoading = true;
  try {
    const r = await fetch(LEAGUE_ROSTERS_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("the-league data.js → " + r.status);
    const data = _extractLeagueData(await r.text());
    if (!data || !Array.isArray(data.teams)) throw new Error("could not parse LEAGUE_DATA");
    _leagueRosters = data;
    _leagueRostersAt = new Date().toISOString();
    _leagueIdx = null;
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

function getLeagueRosterData() { return _leagueRosters; }
function getLeagueRostersUpdatedAt() { return _leagueRostersAt; }
function leagueRosterSeason() { return _leagueRosters ? _leagueRosters.season : (new Date().getFullYear()); }
function getLeagueTeamRoster(teamId) {
  return _leagueRosters ? _leagueRosters.teams.find(t => t.id === teamId) || null : null;
}

// Normalized-name index of every contracted player across all teams, so we can
// overlay a contract onto whoever ESPN says is currently rostered (by name,
// regardless of which team's anchor they were last recorded on).
let _leagueIdx = null;
function _leagueNameIndex() {
  if (_leagueIdx) return _leagueIdx;
  const norm = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const idx = {};
  if (_leagueRosters) {
    for (const t of _leagueRosters.teams) {
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
