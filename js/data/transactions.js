// Full-season ESPN transaction log → per-player contract roots.
//
// Keeper pricing needs to know whether a rostered player's contract chain is
// still LIVE (drafted, possibly traded since — trades never change the root)
// or was broken by a drop and re-rooted as a $6 FA. ESPN's mTransactions2
// view exposes every executed add/drop/draft per scoring period; league 1200
// is public and lm-api-reads reflects any Origin, so the browser fetches ESPN
// directly (no proxy, no cookies). Trade transactions come back with EMPTY
// items anonymously — fine, because the root only depends on draft/add/drop.
//
// Commissioner "manual trades" (ESPN can't process some trades, so the commish
// drops the player on team A and instantly adds him to team B) are detected as
// a cross-team DROP→ADD pair within 30 minutes on a non-FAAB add, and treated
// as a hop that PRESERVES the chain rather than a root-resetting FA add.
//
// First load walks every scoring period (~1 request each); after that the
// cache (per-period, so refetches are idempotent) makes loads incremental —
// only the last cached period and anything newer are refetched.
// ud_espn_tx_v1 is a refetchable cache — deliberately NOT sync-whitelisted.

const ESPN_TX_KEY = "ud_espn_tx_v1";
const ESPN_TX_HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb";
const TX_MANUAL_TRADE_MS = 30 * 60 * 1000;
const TX_FETCH_CONCURRENCY = 6;

let _txLog = null;          // { periods: { "30": [event] }, lastPeriod, at } or null
let _txEventsByPlayer = null;  // memoized flatten: { playerId: [events sorted by date] }
let _txLoading = false;

function _txLeagueBase() {
  return ESPN_TX_HOST + "/seasons/" + ESPN.season + "/segments/0/leagues/" + ESPN.leagueId;
}

// Compact one raw transaction list into membership events we keep:
// executed ADD / DROP / DRAFT items. k: A(dd)/D(rop)/R(draft); w: true when
// the add came through the waiver processor (a genuine FAAB pickup).
function _txExtract(transactions) {
  const out = [];
  for (const t of (transactions || [])) {
    if (t.status !== "EXECUTED" || t.isPending) continue;
    const date = t.processDate || t.proposedDate || 0;
    for (const it of (t.items || [])) {
      if (it.type === "ADD") {
        out.push({ p: it.playerId, d: date, k: "A", w: t.type === "WAIVER", to: it.toTeamId || 0 });
      } else if (it.type === "DROP") {
        out.push({ p: it.playerId, d: date, k: "D", from: it.fromTeamId || 0 });
      } else if (it.type === "DRAFT") {
        out.push({ p: it.playerId, d: date, k: "R", to: it.toTeamId || 0 });
      }
    }
  }
  return out;
}

// Test hook: drop in-memory state so the next call re-reads localStorage.
function _txResetForTest() { _txLog = null; _txEventsByPlayer = null; }

function _txLoadFromCache() {
  try {
    const c = JSON.parse(localStorage.getItem(ESPN_TX_KEY) || "null");
    if (c && c.periods) { _txLog = c; return; }
  } catch (e) {}
  _txLog = null;
}

function _txSave() {
  try { localStorage.setItem(ESPN_TX_KEY, JSON.stringify(_txLog)); } catch (e) {}
}

// Walk scoring periods and cache their events. Returns true when anything new
// was fetched (callers re-render on that). Never throws — a failed walk just
// leaves the cache as-is and the pricing falls back to heuristics.
async function loadTransactionLog(force) {
  if (_txLoading) return false;
  _txLoading = true;
  try {
    if (_txLog === null) _txLoadFromCache();
    const bare = await fetch(_txLeagueBase(), { cache: "no-store" });
    if (!bare.ok) return false;
    const current = (await bare.json()).scoringPeriodId;
    if (!current) return false;
    if (!_txLog) _txLog = { periods: {}, lastPeriod: 0, at: null };
    // Refetch the last cached period too — it may have gained events since.
    const from = force ? 1 : Math.max(1, _txLog.lastPeriod || 1);
    const todo = [];
    for (let sp = from; sp <= current; sp++) todo.push(sp);
    if (!todo.length) return false;
    let fetched = 0;
    const worker = async () => {
      while (todo.length) {
        const sp = todo.shift();
        const r = await fetch(_txLeagueBase() + "?view=mTransactions2&scoringPeriodId=" + sp,
          { cache: "no-store" });
        if (!r.ok) continue;
        const d = await r.json();
        _txLog.periods[sp] = _txExtract(d.transactions);
        fetched++;
      }
    };
    await Promise.all(Array.from({ length: TX_FETCH_CONCURRENCY }, worker));
    if (fetched) {
      _txLog.lastPeriod = current;
      _txLog.at = new Date().toISOString();
      _txEventsByPlayer = null;
      _txSave();
    }
    return fetched > 0;
  } catch (e) {
    return false;
  } finally {
    _txLoading = false;
  }
}

function _txEvents(playerId) {
  if (_txLog === null) _txLoadFromCache();
  if (!_txLog) return null;
  if (!_txEventsByPlayer) {
    _txEventsByPlayer = {};
    for (const evs of Object.values(_txLog.periods)) {
      for (const e of evs) (_txEventsByPlayer[e.p] = _txEventsByPlayer[e.p] || []).push(e);
    }
    for (const list of Object.values(_txEventsByPlayer)) list.sort((a, b) => a.d - b.d);
  }
  return _txEventsByPlayer[playerId] || null;
}

// Resolve a rostered player's contract root from his event trail:
//   "live" — rooted in a draft pick (chain unbroken; trades are transparent)
//   "fa"   — rooted in a genuine FAAB/FA add → $6 keeper
//   null   — no log, no events, or a trail we can't read (commish direct
//            moves leave no transactions) → caller falls back to heuristics.
function txContractRoot(playerName) {
  const pid = (typeof espnPlayerIdByName === "function") ? espnPlayerIdByName(playerName) : null;
  if (!pid) return null;
  const evs = _txEvents(pid);
  if (!evs || !evs.length) return null;
  let i = evs.length - 1;
  // Trailing DROP for a player still shown on a roster: ESPN's waiver run
  // (11:00 PM EDT) writes the executed DROP to the transaction feed before
  // the roster feed removes the player (Jul 12 2026: Cowser). Price the stint
  // that's ending — the player leaves the roster views on their own once the
  // feeds agree.
  while (i >= 0 && evs[i].k === "D") i--;
  if (i < 0) return null;
  while (i >= 0) {
    const e = evs[i];
    if (e.k === "D") return null;        // mid-trail drop → unreadable
    if (e.k === "R") return "live";
    if (e.k === "A") {
      if (e.w) return "fa";              // FAAB add — root resets
      // Instant (non-waiver) add: commissioner manual trade if another team
      // dropped him moments earlier — a hop, keep walking the older trail.
      let hop = -1;
      for (let j = i - 1; j >= 0; j--) {
        const d2 = evs[j];
        if (d2.k === "D" && e.d - d2.d > 0 && e.d - d2.d <= TX_MANUAL_TRADE_MS && d2.from !== e.to) {
          hop = j; break;
        }
      }
      if (hop >= 0) { i = hop - 1; continue; }
      return "fa";                        // instant add with no matching drop
    }
    i--;
  }
  return null;
}
