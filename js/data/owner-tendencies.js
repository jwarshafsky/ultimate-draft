// Persistent per-owner draft tendencies — the "draft archaeology" store
// (north-star §7). Snapshots the live nomination tells (nominationTells() in
// draft-mode.js) into localStorage so what an owner telegraphed THIS draft is
// still known NEXT year.
//
// CONTAMINATION RULE (plan non-negotiable): profiles describe the 11 humans in
// Jeff's league, so a session is recorded ONLY when every gate passes:
//   - feed mode REAL (an ESPN mock room is full of strangers; a UD practice
//     mock is full of bots — neither says anything about league-mates)
//   - the HOME league id (no override active)
//   - not a UD-native practice mock (mockFeedActive)
//   - enough signal to mean something (≥ MIN_NOMS nominations captured)
// Recording is an UPSERT keyed by the stream identity (leagueId:startedAt), so
// calling it repeatedly during/after a draft just refreshes that session's
// snapshot — never duplicates it.
//
// Storage: ud_owner_tendencies_v1 (SYNCED — cloud-sync SYNC_EXACT_KEYS).
// Shape: { sessions: { [sessionKey]: { at, season, owners: {
//   [ownerId]: { noms, chased, ownWins, targets: [names], posNoms: {pos: n} }
// } } } }

const OWNER_TENDENCIES_KEY = "ud_owner_tendencies_v1";
const _OT_MIN_NOMS = 8;   // don't archive a session with almost no nominations

let _ownerTendencies = null;

function _otLoad() {
  if (_ownerTendencies) return _ownerTendencies;
  try { _ownerTendencies = JSON.parse(localStorage.getItem(OWNER_TENDENCIES_KEY) || "null"); } catch (e) {}
  if (!_ownerTendencies || typeof _ownerTendencies !== "object" || !_ownerTendencies.sessions) {
    _ownerTendencies = { sessions: {} };
  }
  return _ownerTendencies;
}
function _otSave() {
  try { localStorage.setItem(OWNER_TENDENCIES_KEY, JSON.stringify(_ownerTendencies)); } catch (e) {}
}

// Every gate that keeps bot/stranger data out of the human profiles.
function _otEligible() {
  if (typeof getFeedMode !== "function" || getFeedMode() !== "real") return false;
  if (typeof mockFeedActive === "function" && mockFeedActive()) return false;
  if (typeof draftTestMode === "function" && draftTestMode()) return false;
  if (typeof ESPN !== "undefined" && typeof UD_HOME_LEAGUE_ID !== "undefined" &&
      Number(ESPN.leagueId) !== Number(UD_HOME_LEAGUE_ID)) return false;
  return true;
}

// Snapshot the current draft's tells into the store. Safe to call at any time
// (debrief open, lobby render) — no-ops unless every gate passes.
// Returns true when a snapshot was written/refreshed.
function recordOwnerTendencies() {
  if (!_otEligible()) return false;
  if (typeof nominationTells !== "function" || typeof _dlog === "undefined") return false;
  let byTeam = null;
  try { byTeam = nominationTells(); } catch (e) { return false; }
  if (!byTeam) return false;
  const totalNoms = Object.values(byTeam).reduce((s, t) => s + (t.noms || 0), 0);
  if (totalNoms < _OT_MIN_NOMS) return false;
  const owners = {};
  for (const [espnId, t] of Object.entries(byTeam)) {
    const ownerId = (typeof espnTeamIdToOwnerId === "function") ? espnTeamIdToOwnerId(Number(espnId)) : null;
    if (!ownerId) continue;   // unmapped team — never store raw espn ids in human profiles
    owners[ownerId] = {
      noms: t.noms || 0, chased: t.chased || 0, ownWins: t.ownWins || 0,
      targets: (t.targets || []).slice(0, 6),
      posNoms: Object.assign({}, t.posNoms || {}),
    };
  }
  if (!Object.keys(owners).length) return false;
  const key = _dlog.leagueId + ":" + _dlog.startedAt;
  const store = _otLoad();
  store.sessions[key] = { at: Date.now(), season: new Date().getFullYear(), owners };
  // Keep the store bounded — one real draft a year means this never triggers,
  // but a runaway caller must not grow it unbounded.
  const keys = Object.keys(store.sessions);
  if (keys.length > 12) {
    keys.sort((a, b) => (store.sessions[a].at || 0) - (store.sessions[b].at || 0));
    for (const k of keys.slice(0, keys.length - 12)) delete store.sessions[k];
  }
  _otSave();
  return true;
}

// Aggregated history for one owner across all recorded real drafts.
// Returns null when nothing is recorded for them.
function getOwnerTendencyHistory(ownerId) {
  const store = _otLoad();
  const agg = { drafts: 0, noms: 0, chased: 0, ownWins: 0, targets: [], posNoms: {} };
  for (const s of Object.values(store.sessions)) {
    const o = s.owners && s.owners[ownerId];
    if (!o) continue;
    agg.drafts++;
    agg.noms += o.noms || 0; agg.chased += o.chased || 0; agg.ownWins += o.ownWins || 0;
    for (const n of o.targets || []) if (!agg.targets.includes(n)) agg.targets.push(n);
    for (const [pos, n] of Object.entries(o.posNoms || {})) agg.posNoms[pos] = (agg.posNoms[pos] || 0) + n;
  }
  return agg.drafts ? agg : null;
}

// One-line historical read for the tells UI ("last real draft: chased 4/9"),
// or null when there's no history worth a line.
function ownerTendencyNote(espnTeamId) {
  const ownerId = (typeof espnTeamIdToOwnerId === "function") ? espnTeamIdToOwnerId(Number(espnTeamId)) : null;
  if (!ownerId) return null;
  const h = getOwnerTendencyHistory(ownerId);
  if (!h || h.noms < 3) return null;
  const bits = [];
  if (h.chased >= 2) bits.push("chased " + h.chased + "/" + h.noms + " own noms");
  const hunted = Object.entries(h.posNoms).filter(([, n]) => n >= 3 && n / h.noms >= 0.4).map(([pos]) => pos);
  if (hunted.length) bits.push("hunts " + hunted.join("/"));
  if (!bits.length) return null;
  return "history (" + h.drafts + " real draft" + (h.drafts === 1 ? "" : "s") + "): " + bits.join(", ");
}
