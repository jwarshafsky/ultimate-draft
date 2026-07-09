// Learned draft cadence — replaces the hardcoded pacing constants in
// mock-live-feed.js with empirical samples measured from EXTENSION-FED ESPN
// rooms as they accumulate.
//
// SOURCE RULES (Jeff, 2026-07-09):
//   - ESPN mock rooms (feed mode "test") feed the "mock" bucket as they come in.
//   - The real home-league draft (feed mode "real") feeds the "real" bucket.
//   - Once ANY real draft is recorded, practice pacing uses ONLY the real
//     bucket — the league's true tempo beats a room of strangers.
//   - UD-native practice mocks are bot-paced synthetic data and are NEVER
//     recorded (that would be the model eating its own output).
//
// Recording is an UPSERT keyed by stream identity (leagueId:startedAt) — a
// session's samples are re-derived wholesale on each call, so recording midway
// and again at the end never double-counts.
//
// Storage: ud_draft_cadence_v1 (SYNCED). Shape:
//   { real: { [sessionKey]: { at, samples } }, mock: { [sessionKey]: { at, samples } } }
//   samples = { interBidMs: [], increments: [], lotMs: [], betweenLotMs: [], bidsPerLot: [] }

const DRAFT_CADENCE_KEY = "ud_draft_cadence_v1";
const _CAD_MIN_SOLD = 8;      // don't learn from a stub of a draft
const _CAD_MAX_SESSIONS = 8;  // per bucket
const _CAD_CAPS = { interBidMs: 800, increments: 800, lotMs: 250, betweenLotMs: 250, bidsPerLot: 250 };

let _draftCadence = null;

function _cadLoad() {
  if (_draftCadence) return _draftCadence;
  try { _draftCadence = JSON.parse(localStorage.getItem(DRAFT_CADENCE_KEY) || "null"); } catch (e) {}
  if (!_draftCadence || typeof _draftCadence !== "object") _draftCadence = {};
  if (!_draftCadence.real) _draftCadence.real = {};
  if (!_draftCadence.mock) _draftCadence.mock = {};
  return _draftCadence;
}
function _cadSave() {
  try { localStorage.setItem(DRAFT_CADENCE_KEY, JSON.stringify(_draftCadence)); } catch (e) {}
}

// Walk one event stream and measure its pacing. Pure — exported for tests.
// Bounds on every sample class throw away pause artifacts (a 40-minute
// commissioner pause is not "time between lots").
function deriveCadenceFromEvents(evs) {
  const s = { interBidMs: [], increments: [], lotMs: [], betweenLotMs: [], bidsPerLot: [] };
  let lot = null;          // { playerId, startAt, lastBidAt, lastAmount, bids }
  let lastSoldAt = null;
  let sold = 0;
  const push = (arr, v, cap) => { if (arr.length < cap) arr.push(v); };
  for (const e of evs || []) {
    if (!e) continue;
    if (e.cmd === "INIT") { lot = null; lastSoldAt = null; continue; }   // reconnect gap — timings across it are junk
    if (e.cmd === "NOMINATION" && e.playerId != null) {
      if (lastSoldAt != null && e.at && e.at > lastSoldAt) {
        const gap = e.at - lastSoldAt;
        if (gap >= 200 && gap <= 60 * 1000) push(s.betweenLotMs, gap, _CAD_CAPS.betweenLotMs);
      }
      // lastBidAt starts null: the nomination→first-bid delay is a different
      // animal from the bid-to-bid tempo and must not pollute interBidMs.
      lot = { playerId: e.playerId, startAt: e.at || null, lastBidAt: null, lastAmount: null, bids: 0 };
      continue;
    }
    if ((e.cmd === "BID" || e.cmd === "BID_ACK") && lot && e.playerId === lot.playerId) {
      if (Number.isFinite(e.amount)) {
        if (lot.lastAmount != null) {
          const inc = e.amount - lot.lastAmount;
          if (inc >= 1 && inc <= 50) push(s.increments, inc, _CAD_CAPS.increments);
        }
        lot.lastAmount = e.amount;
      }
      if (e.at && lot.lastBidAt && e.at > lot.lastBidAt) {
        const gap = e.at - lot.lastBidAt;
        if (gap >= 50 && gap <= 60 * 1000) push(s.interBidMs, gap, _CAD_CAPS.interBidMs);
      }
      if (e.at) lot.lastBidAt = e.at;
      lot.bids++;
      continue;
    }
    if (e.cmd === "SOLD" && e.playerId != null) {
      if (lot && lot.playerId === e.playerId) {
        if (lot.startAt && e.at && e.at > lot.startAt) {
          const dur = e.at - lot.startAt;
          if (dur >= 3000 && dur <= 5 * 60 * 1000) push(s.lotMs, dur, _CAD_CAPS.lotMs);
        }
        push(s.bidsPerLot, lot.bids, _CAD_CAPS.bidsPerLot);
      }
      sold++;
      lastSoldAt = e.at || lastSoldAt;
      lot = null;
    }
  }
  return { samples: s, sold };
}

// Which bucket does the CURRENT session belong in — or null when it must not
// be recorded at all (bot mocks, feed off, manual-only drafts).
function _cadBucket() {
  if (typeof mockFeedActive === "function" && mockFeedActive()) return null;   // bot-paced — never learn from it
  const mode = (typeof getFeedMode === "function") ? getFeedMode() : "off";
  if (mode === "real" && typeof ESPN !== "undefined" && typeof UD_HOME_LEAGUE_ID !== "undefined" &&
      Number(ESPN.leagueId) === Number(UD_HOME_LEAGUE_ID)) return "real";
  if (mode === "test" || mode === "real") return "mock";   // an ESPN room, but not the home league's real draft
  return null;
}

// Measure the current event log into its bucket. Safe to call at any time —
// no-ops unless there's a recordable session with enough sold lots.
// Returns the bucket name when something was written/refreshed, else null.
function recordDraftCadence() {
  const bucket = _cadBucket();
  if (!bucket) return null;
  if (typeof _dlog === "undefined" || !Array.isArray(_dlog.events) || !_dlog.events.length) return null;
  const { samples, sold } = deriveCadenceFromEvents(_dlog.events);
  if (sold < _CAD_MIN_SOLD || !samples.interBidMs.length) return null;
  const store = _cadLoad();
  const key = _dlog.leagueId + ":" + _dlog.startedAt;
  store[bucket][key] = { at: Date.now(), samples };
  const keys = Object.keys(store[bucket]);
  if (keys.length > _CAD_MAX_SESSIONS) {
    keys.sort((a, b) => (store[bucket][a].at || 0) - (store[bucket][b].at || 0));
    for (const k of keys.slice(0, keys.length - _CAD_MAX_SESSIONS)) delete store[bucket][k];
  }
  _cadSave();
  return bucket;
}

// Pooled samples for the practice-mock samplers. REAL data wins outright the
// moment it exists; otherwise every recorded ESPN mock pools together; null →
// callers fall back to the fitted 2026-07-04 constants.
function getCadenceSamples() {
  const store = _cadLoad();
  for (const bucket of ["real", "mock"]) {
    const sessions = Object.values(store[bucket]);
    if (!sessions.length) continue;
    const pooled = { interBidMs: [], increments: [], lotMs: [], betweenLotMs: [], bidsPerLot: [] };
    for (const sess of sessions) {
      for (const k of Object.keys(pooled)) {
        if (sess.samples && Array.isArray(sess.samples[k])) pooled[k].push(...sess.samples[k]);
      }
    }
    if (pooled.interBidMs.length >= 30 && pooled.lotMs.length >= _CAD_MIN_SOLD) {
      return { source: bucket, sessions: sessions.length, ...pooled };
    }
  }
  return null;
}

// Uniform draw from an empirical sample array (Math.random-driven so seeded
// test RNGs keep it deterministic). null/empty → caller uses its fallback.
function cadenceDraw(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}
