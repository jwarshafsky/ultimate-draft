// Call-up tracker — who is stashed on a minor-league roster vs called up to a
// major-league roster. Draft rules (Jeff, Jul 4 2026):
//
//   1. A player on ANY team's minor-league roster is NOT available in the
//      auction (excluded from the pool, the typeahead, and live inflation's
//      remaining-value — his value is off the board without costing budget).
//   2. A stashed minor leaguer does NOT occupy a projected ML roster slot.
//      A CALLED-UP one does (and carries his call-up cost).
//
// Base truth is imported from The League App's rosters (league-rosters.js):
//   kind "minor"  → stashed
//   kind "callup" → called up
// plus Jeff's own predicted MiL keepers (my-keepers minorKeeper flags) count
// as stashed even if The League App doesn't list them yet. Jeff can override
// any player either way in the Call-ups panel; overrides live in
// ud_callups_v1 (device-synced) keyed by normalized name.

const CALLUPS_KEY = "ud_callups_v1";
let _callupOverrides = null;   // normName -> { status: "up"|"stashed", name }

function _cuNorm(s) {
  return (typeof normalizePlayerName === "function") ? normalizePlayerName(s) : String(s || "").trim().toLowerCase();
}

function _cuLoad() {
  if (_callupOverrides) return _callupOverrides;
  try { _callupOverrides = JSON.parse(localStorage.getItem(CALLUPS_KEY) || "{}") || {}; }
  catch (e) { _callupOverrides = {}; }
  return _callupOverrides;
}
function _cuSave() {
  try { localStorage.setItem(CALLUPS_KEY, JSON.stringify(_cuLoad())); } catch (e) {}
}

function getCallupStatusOverride(name) {
  const o = _cuLoad()[_cuNorm(name)];
  return o ? o.status : null;
}

// status: "up" | "stashed" | "auto" (clears the override → league data rules)
function setCallupStatusOverride(name, status) {
  const map = _cuLoad();
  const key = _cuNorm(name);
  if (status === "up" || status === "stashed") map[key] = { status, name };
  else delete map[key];
  _cuSave();
  if (typeof onDataChange === "function") { try { onDataChange("callups"); } catch (e) {} }
}

// League-data base status: "up" (on ML roster via call-up), "stashed" (on a
// MiL roster), or null (not a tracked minor leaguer). My-keeper minor
// predictions count as stashed so pre-draft planning already excludes them.
function callupBaseStatus(name) {
  const key = _cuNorm(name);
  if (typeof _leagueNameIndex === "function") {
    const e = _leagueNameIndex()[key];
    if (e) {
      if (e.kind === "minor") return "stashed";
      if (e.kind === "callup") return "up";
      return null;   // "major" — a regular ML contract, not call-up tracked
    }
  }
  if (typeof getEffectiveKeeperSelections === "function") {
    const sel = getEffectiveKeeperSelections();
    for (const players of Object.values(sel)) {
      for (const [n, f] of Object.entries(players)) {
        if (f.minorKeeper && _cuNorm(n) === key) return "stashed";
      }
    }
  }
  return null;
}

// Effective status: manual override beats league data.
function callupStatus(name) {
  return getCallupStatusOverride(name) || callupBaseStatus(name);
}
function isCalledUp(name)   { return callupStatus(name) === "up"; }
function isStashedMinor(name) { return callupStatus(name) === "stashed"; }

// One combined off-the-board set for every draft pool: predicted keepers
// (major + minor) PLUS every tracked minor leaguer. A MiL-rostered player is
// OWNED whether stashed or called up — call-up status only decides whether he
// occupies a projected ML roster slot, never whether he's auctionable.
// Normalized names.
function draftExcludedNames() {
  const out = new Set();
  for (const r of listMinorLeaguers()) out.add(r.key);
  if (typeof collectKeepers === "function") {
    for (const k of collectKeepers()) out.add(_cuNorm(k.name));
  }
  return out;
}

// Rows for the Call-ups panel: every tracked minor leaguer, grouped by team.
function listMinorLeaguers() {
  const rows = [];
  const seen = new Set();
  const overrides = _cuLoad();
  if (typeof _leagueNameIndex === "function") {
    const idx = _leagueNameIndex();
    for (const [key, e] of Object.entries(idx)) {
      if (e.kind !== "minor" && e.kind !== "callup") continue;
      const base = e.kind === "minor" ? "stashed" : "up";
      const ov = overrides[key] ? overrides[key].status : null;
      rows.push({ key, name: e.player.name, teamId: e.teamId, base, override: ov, status: ov || base, source: "league" });
      seen.add(key);
    }
  }
  if (typeof getEffectiveKeeperSelections === "function") {
    const sel = getEffectiveKeeperSelections();
    for (const [teamId, players] of Object.entries(sel)) {
      for (const [n, f] of Object.entries(players)) {
        const key = _cuNorm(n);
        if (!f.minorKeeper || seen.has(key)) continue;
        const ov = overrides[key] ? overrides[key].status : null;
        rows.push({ key, name: n, teamId, base: "stashed", override: ov, status: ov || "stashed", source: "predicted" });
        seen.add(key);
      }
    }
  }
  // Overrides for players neither source knows (manually added edge cases)
  for (const [key, o] of Object.entries(overrides)) {
    if (!seen.has(key)) rows.push({ key, name: o.name, teamId: null, base: null, override: o.status, status: o.status, source: "manual" });
  }
  return rows;
}
