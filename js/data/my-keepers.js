// My keeper picks — Jeff's OWN keeper decisions and predictions. Separate from
// the league-website marks (keeper_selections in Supabase). For his own team
// these are his choices; for the other 11 teams they're his predictions. Local
// only (single user), persisted to localStorage.
//
// Shape: { [teamId]: { [playerName]: { picked: bool, ineligible: bool } } }
//   picked     — Jeff thinks/decides this player is a keeper
//   ineligible — manual override: not keepable (e.g. FA added after the trade
//                deadline, a case we can't detect from draft history alone)
//
// Also stores the keepers-page projection-source preference.

const MYKEEPERS_KEY = "ud_my_keepers_v1";
const MYKEEPERS_SRC_KEY = "ud_my_keepers_src_v1";

const _myKeepers = { teams: {} };
let _myKeepersSource = null;

function loadMyKeepers() {
  try {
    const v = JSON.parse(localStorage.getItem(MYKEEPERS_KEY) || "null");
    if (v && v.teams) _myKeepers.teams = v.teams;
  } catch (e) { /* ignore */ }
  _myKeepersSource = localStorage.getItem(MYKEEPERS_SRC_KEY) || null;
}

function saveMyKeepers() {
  localStorage.setItem(MYKEEPERS_KEY, JSON.stringify(_myKeepers));
}

function _myTeam(teamId) {
  if (!_myKeepers.teams[teamId]) _myKeepers.teams[teamId] = {};
  return _myKeepers.teams[teamId];
}

// --- Accessors ---

function getMyKeeper(teamId, name) {
  return (_myKeepers.teams[teamId] || {})[name] || null;
}

function isMyKeeper(teamId, name) {
  return !!getMyKeeper(teamId, name)?.picked;
}

function isMyIneligible(teamId, name) {
  return !!getMyKeeper(teamId, name)?.ineligible;
}

// All player names Jeff has marked as keepers for a team.
function getMyTeamPicks(teamId) {
  const t = _myKeepers.teams[teamId] || {};
  return Object.keys(t).filter(n => t[n].picked);
}

// --- Mutators (persist + re-render) ---

function setMyKeeper(teamId, name, picked) {
  const t = _myTeam(teamId);
  if (!t[name]) t[name] = { picked: false, ineligible: false };
  t[name].picked = !!picked;
  // Clean up fully-empty entries to keep storage tidy.
  if (!t[name].picked && !t[name].ineligible) delete t[name];
  saveMyKeepers();
}

function setMyIneligible(teamId, name, ineligible) {
  const t = _myTeam(teamId);
  if (!t[name]) t[name] = { picked: false, ineligible: false };
  t[name].ineligible = !!ineligible;
  if (!t[name].picked && !t[name].ineligible) delete t[name];
  saveMyKeepers();
}

// Effective keeper set for the whole app's inflation/budget math: treat Jeff's
// PREDICTED keepers as the actual keepers. Per team, his predictions win; for a
// team he hasn't predicted, fall back to that team's league-site marks. A pick
// he flagged ineligible (won't really be kept) is excluded. Shape matches
// getKeeperSelections(): { teamId: { name: { keeper, minorKeeper, ... } } }.
function getEffectiveKeeperSelections() {
  const league = (typeof getKeeperSelections === "function") ? getKeeperSelections() : {};
  const teamIds = new Set();
  if (typeof LEAGUE !== "undefined" && LEAGUE.teams) LEAGUE.teams.forEach(t => teamIds.add(t.id));
  Object.keys(league).forEach(id => teamIds.add(id));
  Object.keys(_myKeepers.teams).forEach(id => teamIds.add(id));

  const out = {};
  for (const tid of teamIds) {
    const lg = league[tid] || {};
    const picks = getMyTeamPicks(tid).filter(n => !isMyIneligible(tid, n));
    if (picks.length) {
      out[tid] = {};
      for (const name of picks) {
        // Minor (cost $0) if the league site flags it minor; else a major keeper.
        const minor = !!(lg[name] && lg[name].minorKeeper);
        out[tid][name] = { keeper: !minor, minorKeeper: minor, rule5: false, tradeBlock: false };
      }
    } else {
      out[tid] = lg;  // no predictions for this team → use league-site marks
    }
  }
  return out;
}

// --- Projection-source preference (keepers page) ---

function getKeeperProjSource() { return _myKeepersSource; }
function setKeeperProjSource(sourceId) {
  _myKeepersSource = sourceId || null;
  if (sourceId) localStorage.setItem(MYKEEPERS_SRC_KEY, sourceId);
  else localStorage.removeItem(MYKEEPERS_SRC_KEY);
}

loadMyKeepers();
