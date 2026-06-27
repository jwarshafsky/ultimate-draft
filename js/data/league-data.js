// League data layer — reads keeper/roster/trade data from Supabase. In-memory
// cache + realtime subscriptions so the UI stays in sync with The League App.

const LEAGUE = {
  // Hard-coded teams (matches Jeff's league). team_id values match Supabase.
  teams: [
    { id: "matt",   name: "No Jok",                          owner: "Matt" },
    { id: "saxton", name: "Betts a Little",                  owner: "Saxton" },
    { id: "sam",    name: "Livvy Dunne Rizzo'ed up Skenes",  owner: "Sam" },
    { id: "glix",   name: "Tucson Toros",                    owner: "Glicksmans" },
    { id: "jeff",   name: "Hold the Mayo",                   owner: "Jeff", isMe: true },
    { id: "aj",     name: "AJ",                              owner: "AJ" },
    { id: "corey",  name: "Ottawa Lynx",                     owner: "Corey" },
    { id: "jd",     name: "Diagnosis: Stockholm",            owner: "Josh/Doug" },
    { id: "wein",   name: "Team Zach",                       owner: "Larry" },
    { id: "klin",   name: "Team Klinger",                    owner: "Klinger" },
    { id: "dave",   name: "Fried Aroz",                      owner: "Dave" },
    { id: "jtl",    name: "Jesse The Legend",                owner: "Jesse" },
  ],
  // Constitutional constants
  draftBudget: 260,
  numTeams: 12,
  luxuryTax: 350,
  rosterSize: 26,
  maxMlKeepers: 8,
  maxMilKeepers: 10,
  keeperEscalator: 2,
  faabKeeperCost: 6,
  // Roster construction (counts toward draft slots)
  rosterSlots: {
    C: 1, "1B": 1, "2B": 1, "SS": 1, "3B": 1,
    MI: 1, CI: 1, OF: 5, UTIL: 1, P: 9, BENCH: 4,
  },
  // Categories (5x5 roto)
  hitCats: ["R", "HR", "RBI", "SB", "OBP"],
  pitCats: ["QS", "K", "SV_HLD", "ERA", "WHIP"],
};

// Display owner names only — team names are not used anywhere in the UI.
// Make every team's display name its owner so all `t.name` displays show the
// owner (matching/logic is by `id`, never by name).
LEAGUE.teams.forEach(t => { t.name = t.owner; });

function getMyTeam() { return LEAGUE.teams.find(t => t.isMe); }
function getTeam(id) { return LEAGUE.teams.find(t => t.id === id); }

const _data = {
  keeperSelections: {},     // { teamId: { playerName: { keeper, minorKeeper, rule5, tradeBlock } } }
  callupOverrides: {},      // { playerName: { price, year } }
  keeperPriceExceptions: {},// { playerName: truePrice }
  trades: [],
  rosterMoves: [],
  settings: {},
  keyDates: {},
  loaded: false,
  loading: false,
  error: null,
};

const _dataListeners = [];
function onDataChange(fn) {
  _dataListeners.push(fn);
  if (_data.loaded) fn(_data);
}
function fireData() {
  _dataListeners.forEach(fn => { try { fn(_data); } catch (e) { console.error(e); } });
}

async function loadLeagueData() {
  if (_data.loading) return;
  _data.loading = true;
  setStatus("supabase", "loading…", "");
  try {
    const [ks, co, ls, tr, rm] = await Promise.all([
      supabaseClient.from("keeper_selections").select("*"),
      supabaseClient.from("callup_overrides").select("*"),
      supabaseClient.from("league_state").select("*"),
      supabaseClient.from("trades").select("*").order("created_at", { ascending: true }),
      supabaseClient.from("roster_moves").select("*").order("at", { ascending: true }),
    ]);

    // Surface any errors but continue with whatever loaded.
    for (const [label, r] of [
      ["keeper_selections", ks], ["callup_overrides", co],
      ["league_state", ls], ["trades", tr], ["roster_moves", rm],
    ]) {
      if (r.error) console.warn(label + ":", r.error.message);
    }

    _data.keeperSelections = {};
    for (const r of (ks.data || [])) {
      if (!_data.keeperSelections[r.team_id]) _data.keeperSelections[r.team_id] = {};
      _data.keeperSelections[r.team_id][r.player_name] = {
        keeper: !!r.keeper,
        minorKeeper: !!r.minor_keeper,
        rule5: !!r.rule5,
        tradeBlock: !!r.trade_block,
      };
    }

    _data.callupOverrides = {};
    for (const r of (co.data || [])) {
      _data.callupOverrides[r.player_name] = { price: r.price, year: r.year };
    }

    _data.keeperPriceExceptions = {};
    _data.settings = {};
    _data.keyDates = {};
    for (const r of (ls.data || [])) {
      if (r.key === "keeper_price_exceptions") _data.keeperPriceExceptions = r.state || {};
      else if (r.key === "settings") _data.settings = r.state || {};
      else if (r.key === "key_dates") _data.keyDates = r.state || {};
    }

    _data.trades = tr.data || [];
    _data.rosterMoves = rm.data || [];
    _data.loaded = true;
    _data.error = null;
    setStatus("supabase", "ok (" +
      Object.values(_data.keeperSelections).reduce((n, t) => n + Object.keys(t).length, 0) +
      " selections)", "ok");
  } catch (e) {
    _data.error = e.message || String(e);
    setStatus("supabase", "error", "bad");
    console.error("loadLeagueData failed:", e);
  } finally {
    _data.loading = false;
    fireData();
  }
}

let _realtimeChannel = null;
function subscribeRealtime() {
  if (_realtimeChannel) return;
  _realtimeChannel = supabaseClient.channel("ud-league")
    .on("postgres_changes", { event: "*", schema: "public", table: "keeper_selections" }, loadLeagueData)
    .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, loadLeagueData)
    .on("postgres_changes", { event: "*", schema: "public", table: "callup_overrides" }, loadLeagueData)
    .on("postgres_changes", { event: "*", schema: "public", table: "league_state" }, loadLeagueData)
    .on("postgres_changes", { event: "*", schema: "public", table: "roster_moves" }, loadLeagueData)
    .subscribe();
}

function unsubscribeRealtime() {
  try { _realtimeChannel?.unsubscribe(); } catch {}
  _realtimeChannel = null;
}

// --- Accessors ---

function dataReady() { return _data.loaded; }
function getKeeperSelections() { return _data.keeperSelections; }
function getTeamKeepers(teamId) { return _data.keeperSelections[teamId] || {}; }
function getCallupOverride(name) { return _data.callupOverrides[name] || null; }
function getKeeperPriceExceptions() { return _data.keeperPriceExceptions; }
function getTrades() { return _data.trades; }
function getRosterMoves() { return _data.rosterMoves; }
function getKeyDates() { return _data.keyDates; }

// Returns the effective salary for a player on a team, applying
// keeper_price_exceptions and (eventually) trade cost-basis transfers.
function getPlayerSalary(playerName, defaultPrice) {
  const exc = _data.keeperPriceExceptions[playerName];
  if (exc != null) return exc;
  return defaultPrice;
}

// Status bar helpers (defined here so data layer can update the bar)
function setStatus(key, text, kind) {
  const el = document.getElementById("status-" + key);
  if (!el) return;
  el.textContent = key + ": " + text;
  el.className = "status" + (kind ? " " + kind : "");
}
