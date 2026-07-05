// UD-native mock → Live Draft feed.
//
// Runs Ultimate Draft's OWN auction engine (mock-engine.js — owner profiles
// decide WHO bids and how high) and pipes the result into the REAL Draft Mode
// cockpit by emitting the SAME event objects the Keeper Edge extension does:
// NOMINATION / BID / SOLD frames (with seq + `at` timestamps + teamId +
// playerId + amount) straight into `_onDraftEvents(msg)` and cumulative pick
// snapshots into `_applyDraftFeed(feed)`. There are ZERO new render paths — the
// hero, ticker, recommended bid, budgets, invariants, Supabase logging
// (is_mock=true), debrief and stream-key rotation all run exactly as they do
// for a live ESPN mock. The cockpit cannot tell it apart from ESPN.
//
// Two layers, cleanly separated:
//   • WHO / HOW MUCH  — mock-engine.js runMockDraft(): the engine's owner
//     profiles run a full auction and hand back the sales (winner + price per
//     lot). That IS the ground truth; the feed never invents a price.
//   • WHEN            — this file wraps each sale in a realistic bid trace and
//     inter-frame cadence MEASURED from the captured 198-lot ESPN mock of
//     2026-07-04 (see docs/live-draft-2027-plan.md): lots ~25s clock-driven
//     (p95 28s); bids/lot heavily bimodal (median 1, mean ~5.9) — which falls
//     out organically from cheap lots clearing in one bid and star wars taking
//     many; inter-bid median 0.56s / p95 4.5s (log-normal); increments median
//     $1 / mean $2.56 / p90 $6; ~2s between lots.
//
// Speed control (1× real / 4× / instant) scales only the WALL-CLOCK delays —
// event `at` stamps are always the real Date.now() at emit time, so the
// staleness gate / watchdog behave identically to a real feed. "instant" drives
// frames back-to-back (like test/simulate-draft.js) for a full run in seconds.
//
// Leaving/stopping cleans up its timers via the gen-guard pattern borrowed from
// mock-interactive.js (_interactive.gen): every scheduled step captures the
// current generation and no-ops if the generation has moved on.

const MOCK_FEED_LEAGUE_ID = 990001;   // synthetic mock league (never your real 1200)

const _mockFeed = {
  active: false,
  paused: false,
  gen: 0,                 // bumped on every start/pause/resume/stop/speed change
  speed: "4x",            // "1x" | "4x" | "instant"
  script: null,           // built frame list + ground-truth sales
  ctx: null,              // cumulative feed context (seq counter + picks)
  idx: 0,                 // next frame to emit
  startedAt: 0,
  soldLots: 0,
  lastEmitAt: 0,
};

function mockFeedActive() { return !!_mockFeed.active; }

// ---------------------------------------------------------------------------
// Cadence samplers (all Math.random-driven so a seeded RNG makes them
// deterministic in tests). Numbers fitted to the captured ESPN mock.

// Bid increment: median $1, mean ~$2.56, p90 ~$6.
function _mfSampleIncrement() {
  const r = Math.random();
  if (r < 0.48) return 1;
  if (r < 0.68) return 2;
  if (r < 0.80) return 3;
  if (r < 0.89) return 5;
  if (r < 0.94) return 6;
  if (r < 0.98) return 8;
  return 15;
}

// Inter-bid gap in ms: log-normal, median 0.56s, p95 ~4.5s.
function _mfSampleInterBid() {
  const u1 = Math.random() || 1e-9, u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const mu = Math.log(0.56), sigma = 1.26;   // exp(mu)=0.56; exp(mu+1.645σ)≈4.5
  let s = Math.exp(mu + sigma * z);
  s = Math.max(0.15, Math.min(20, s));
  return Math.round(s * 1000);
}

// Lot duration in ms: ESPN's clock dominates — ~25s nearly constant, p95 ~28s.
function _mfSampleLotDuration() {
  const r = Math.random();
  if (r < 0.90) return 25000;
  if (r < 0.97) return 25000 + Math.floor(Math.random() * 3000);   // 25–28s
  return 28000 + Math.floor(Math.random() * 4000);                 // 28–32s
}

// Gap between lots (~2s fixed with a touch of jitter).
function _mfSampleBetweenLots() { return 1800 + Math.floor(Math.random() * 600); }

// ---------------------------------------------------------------------------
// One lot's bid trace: an escalating ladder from $1 to the engine's clearing
// price, winner bidding last. The bidder mix is cosmetic (only the final
// winner + price matter to the recorded pick) so a challenger is chosen just to
// make the price climb realistically. Bid count scales with price + increment
// size, which is exactly what reproduces the bimodal bids/lot shape.
function _mfBidTrace(price, winnerEspn, nomEspn, allEspnIds) {
  const bids = [{ team: nomEspn, amount: 1 }];   // opening $1 by the nominator
  if (price <= 1) {
    // Uncontested — the engine makes the nominator the winner at $1; if a rare
    // engine edge disagrees, put the lone bid on the actual winner.
    if (winnerEspn !== nomEspn) bids[0] = { team: winnerEspn, amount: 1 };
    return bids;
  }
  const challengers = allEspnIds.filter(id => id !== winnerEspn);
  let cur = 1, turn = 0, guard = 0;
  while (cur < price && guard++ < 300) {
    cur = Math.min(price, cur + _mfSampleIncrement());
    const isLast = cur >= price;
    const team = isLast ? winnerEspn : (challengers.length ? challengers[turn % challengers.length] : winnerEspn);
    bids.push({ team, amount: cur });
    turn++;
  }
  const last = bids[bids.length - 1];
  if (last.team !== winnerEspn || last.amount !== price) { last.team = winnerEspn; last.amount = price; }
  return bids;
}

// ---------------------------------------------------------------------------
// Build the full frame script from a single engine run. Pure: no timers, no
// DOM, no Date.now beyond stamping startedAt. Returns the frames (each with a
// `dt` = ms since the previous frame), the ground-truth sales, and the id↔name
// maps. This is where ALL cadence sampling lives, so a test can inspect the
// distributions directly.
function buildMockFeedScript(opts) {
  opts = opts || {};
  const values = (typeof getValues === "function") ? getValues() : [];
  if (!values.length) return null;

  // Real LEAGUE.teams → synthetic ESPN team ids 1..N (generic Team-N in the
  // cockpit). Jeff's own team maps to his seat, announced via setMyDraftEspnId.
  const teamMap = {};
  let myEspnId = 1;
  LEAGUE.teams.forEach((t, i) => { teamMap[t.id] = i + 1; if (t.isMe) myEspnId = i + 1; });
  const allEspnIds = LEAGUE.teams.map((t, i) => i + 1);

  // Player name → synthetic ESPN playerId (>1000 so the cockpit's lot filter
  // accepts it). Seeded into _espnIdToName so picks resolve without a fetch.
  const idByName = {}, nameById = {};
  values.forEach((p, i) => { const id = 900001 + i; idByName[p.name] = id; nameById[id] = p.name; });

  // The engine decides everything real: who nominates, who wins, the price.
  const result = (typeof runMockDraft === "function") ? runMockDraft(opts) : { picks: [] };
  const enginePicks = result.picks || [];

  const startedAt = Date.now();
  const frames = [], sales = [];
  let lotSeq = 0;

  enginePicks.forEach((sale, li) => {
    const pid = idByName[sale.player];
    if (pid == null) return;
    const winnerEspn = teamMap[sale.winnerTeamId];
    const nomEspn = teamMap[sale.nominatorTeamId] != null ? teamMap[sale.nominatorTeamId] : winnerEspn;
    if (winnerEspn == null) return;
    const price = Math.max(1, Math.round(sale.price));
    lotSeq++;

    frames.push({ dt: li === 0 ? 0 : _mfSampleBetweenLots(), cmd: "NOMINATION", teamId: nomEspn, playerId: pid, amount: null });

    const trace = _mfBidTrace(price, winnerEspn, nomEspn, allEspnIds);
    const lotDur = _mfSampleLotDuration();
    let bidElapsed = 0;
    trace.forEach((b, bi) => {
      let dt = bi === 0 ? 300 : _mfSampleInterBid();
      if (bidElapsed + dt > lotDur - 1000) dt = Math.max(120, lotDur - 1000 - bidElapsed);
      bidElapsed += dt;
      frames.push({ dt, cmd: "BID", teamId: b.team, playerId: pid, amount: b.amount });
    });

    // SOLD lands ~lotDur after the nomination — ESPN's clock, not the last bid.
    frames.push({ dt: Math.max(500, lotDur - bidElapsed), cmd: "SOLD", teamId: winnerEspn, playerId: pid, amount: price });
    sales.push({ playerId: pid, teamId: winnerEspn, price, seq: lotSeq });
  });

  return {
    leagueId: MOCK_FEED_LEAGUE_ID, sport: "flb", startedAt, myEspnId,
    frames, sales, nameById, idByName, totalLots: sales.length,
  };
}

// ---------------------------------------------------------------------------
// Emit path — identical shapes to the extension bridge (draft-bridge.js). One
// cumulative feed context carries the running seq counter + pick list.
function _mfMakeContext(script) {
  return { leagueId: script.leagueId, sport: script.sport, startedAt: script.startedAt, seq: 0, picks: [] };
}

// Deliver ONE frame into the real pipeline with the given wall-clock stamp.
// NOMINATION/BID go to _onDraftEvents (the raw stream → hero/ticker/Supabase);
// SOLD additionally pushes a cumulative pick snapshot to _applyDraftFeed (the
// pick pipeline → processEspnPicks → the board).
function _mfApplyFrame(ctx, fr, at) {
  const seq = ++ctx.seq;
  const ev = { seq, at, cmd: fr.cmd, teamId: fr.teamId, playerId: fr.playerId, amount: fr.amount, text: "" };
  if (typeof _onDraftEvents === "function") {
    _onDraftEvents({ log: { leagueId: ctx.leagueId, sport: ctx.sport, startedAt: ctx.startedAt }, events: [ev], full: false });
  }
  if (fr.cmd === "SOLD") {
    ctx.picks.push({ playerId: fr.playerId, teamId: fr.teamId, price: fr.amount, seq, ts: at });
    if (typeof _applyDraftFeed === "function") {
      _applyDraftFeed({ leagueId: ctx.leagueId, sport: ctx.sport, startedAt: ctx.startedAt, updatedAt: at, picks: ctx.picks.slice() });
    }
  }
  return seq;
}

// ---------------------------------------------------------------------------
// Arm the app for a mock (no scheduling): test mode + synthetic league so the
// cockpit runs generic Team-N / $260 / no keepers / full pool, a clean draft
// stream, seeded names, and my seat. Shared by startMockFeed and the test.
function _mfResetDraftState() {
  if (typeof _liveDraft !== "undefined") {
    _liveDraft.picks = [];
    _liveDraft.deleted = {};
    _liveDraft.streamKey = null;
    if (typeof saveLiveDraft === "function") saveLiveDraft();
  }
  if (typeof _dlog !== "undefined") {
    _dlog.events = []; _dlog.leagueId = null; _dlog.startedAt = 0;
    _dlog.lastEventAt = 0; _dlog.initState = null;
  }
  if (typeof _feed !== "undefined") {
    _feed.staleInfo = null; _feed.staleRetained = null; _feed.connected = false; _feed.count = 0;
  }
}

function _mfSeedNames(nameById) {
  // _espnIdToName is a top-level `let` in draft.js (shared global lexical
  // scope). Seeding it here makes _ensureEspnNames() a no-op — no ESPN fetch —
  // so synthetic picks resolve to real player names.
  if (typeof _espnIdToName !== "undefined") {
    _espnIdToName = Object.assign(_espnIdToName || {}, nameById);
  }
}

function _mfArm(script) {
  if (typeof setLeagueOverride === "function") setLeagueOverride(String(MOCK_FEED_LEAGUE_ID));
  if (typeof setFeedMode === "function") setFeedMode("test");
  _mfResetDraftState();
  _mfSeedNames(script.nameById);
  if (typeof setMyDraftEspnId === "function") setMyDraftEspnId(script.myEspnId);
  _mockFeed.script = script;
  _mockFeed.ctx = _mfMakeContext(script);
  _mockFeed.idx = 0;
  _mockFeed.startedAt = script.startedAt;
  _mockFeed.soldLots = 0;
}

// ---------------------------------------------------------------------------
// Playback (gen-guarded timers).
function _mfSpeedDelay(dt) {
  if (_mockFeed.speed === "instant") return 0;
  const factor = _mockFeed.speed === "4x" ? 4 : 1;
  return Math.max(0, Math.round((dt || 0) / factor));
}
function _mfLater(fn, ms) {
  const g = _mockFeed.gen;
  setTimeout(() => { if (_mockFeed.gen === g && _mockFeed.active && !_mockFeed.paused) fn(); }, ms);
}
function _mfScheduleNext() {
  if (!_mockFeed.active || _mockFeed.paused || !_mockFeed.script) return;
  const frames = _mockFeed.script.frames;
  if (_mockFeed.idx >= frames.length) { _mfFinish(); return; }
  const fr = frames[_mockFeed.idx];
  _mfLater(() => {
    const at = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
    _mfApplyFrame(_mockFeed.ctx, fr, at);
    if (fr.cmd === "SOLD") _mockFeed.soldLots++;
    _mockFeed.idx++;
    _mockFeed.lastEmitAt = at;
    _mfUpdateStatus();
    _mfScheduleNext();
  }, _mfSpeedDelay(fr.dt));
}
function _mfFinish() {
  _mockFeed.active = false;
  _mockFeed.paused = false;
  _mockFeed.gen++;
  if (typeof currentView !== "undefined" && currentView === "draft" && typeof renderDraft === "function") renderDraft();
}

function startMockFeed(opts) {
  opts = opts || {};
  stopMockFeed({ silent: true });
  const script = buildMockFeedScript(opts);
  if (!script || !script.frames.length) {
    if (typeof alert === "function") alert("No projections loaded — import values on the Data tab first, then start a practice mock.");
    return false;
  }
  if (opts.speed) _mockFeed.speed = opts.speed;
  _mfArm(script);
  _mockFeed.active = true;
  _mockFeed.paused = false;
  _mockFeed.gen++;
  if (typeof currentView !== "undefined" && currentView === "draft" && typeof renderDraft === "function") renderDraft();
  _mfScheduleNext();
  return true;
}
function pauseMockFeed() {
  if (!_mockFeed.active || _mockFeed.paused) return;
  _mockFeed.paused = true;
  _mockFeed.gen++;   // invalidate the in-flight timer
  if (typeof currentView !== "undefined" && currentView === "draft" && typeof renderDraft === "function") renderDraft();
}
function resumeMockFeed() {
  if (!_mockFeed.active || !_mockFeed.paused) return;
  _mockFeed.paused = false;
  _mockFeed.gen++;
  if (typeof currentView !== "undefined" && currentView === "draft" && typeof renderDraft === "function") renderDraft();
  _mfScheduleNext();
}
function stopMockFeed(opts) {
  opts = opts || {};
  const wasActive = _mockFeed.active;
  _mockFeed.active = false;
  _mockFeed.paused = false;
  _mockFeed.gen++;   // kill any scheduled step
  // Picks + event log are LEFT in place so Jeff can open Debrief / audit the
  // practice run; "Reset draft" (or starting another mock) clears them.
  if (!opts.silent && wasActive && typeof currentView !== "undefined" && currentView === "draft" && typeof renderDraft === "function") renderDraft();
}
function setMockFeedSpeed(s) {
  if (s !== "1x" && s !== "4x" && s !== "instant") return;
  _mockFeed.speed = s;
  if (_mockFeed.active && !_mockFeed.paused) { _mockFeed.gen++; _mfScheduleNext(); }
  _mfUpdateStatus();
}
function getMockFeedSpeed() { return _mockFeed.speed; }

// ---------------------------------------------------------------------------
// UI — one card on the Draft Setup lobby, a compact cluster mirrored in the
// Draft Mode top bar. Buttons wired once via document-level delegation (they
// survive the innerHTML rebuilds of both views).
function _mfSpentSoFar() {
  return (_mockFeed.ctx && _mockFeed.ctx.picks) ? _mockFeed.ctx.picks.reduce((s, p) => s + (p.price || 0), 0) : 0;
}
function _mfStatusText() {
  const s = _mockFeed.script;
  if (!s) return "Idle — press Start to run a full auction against the bots.";
  const total = s.totalLots, done = _mockFeed.soldLots;
  if (_mockFeed.active) {
    return (_mockFeed.paused ? "⏸ Paused" : "● Running") + " — lot <b>" + done + "</b> / " + total +
      " · $" + _mfSpentSoFar() + " spent · " + esc(_mockFeed.speed);
  }
  if (done >= total && total > 0) return "✓ Finished — " + total + " lots. Open Debrief to review, or Reset draft to clear.";
  return "Stopped at lot " + done + " / " + total + ".";
}
function _mfUpdateStatus() {
  const el = (typeof document !== "undefined") ? document.getElementById("mf-status") : null;
  if (el) el.innerHTML = _mfStatusText();
  const cmp = (typeof document !== "undefined") ? document.getElementById("mf-status-compact") : null;
  if (cmp && _mockFeed.script) cmp.textContent = _mockFeed.soldLots + "/" + _mockFeed.script.totalLots;
}

function _mfSpeedSeg() {
  const seg = (val, label) => '<button class="btn' + (_mockFeed.speed === val ? ' primary' : ' ghost') +
    '" data-mockspeed="' + val + '" style="border-radius:0; padding:3px 10px;">' + label + '</button>';
  return '<span class="seg" style="display:inline-flex; border:1px solid var(--border); border-radius:6px; overflow:hidden;">' +
    seg("1x", "1×") + seg("4x", "4×") + seg("instant", "Instant") + '</span>';
}

// compact=true → an inline cluster for the Draft Mode top bar.
function renderMockFeedControls(compact) {
  const active = _mockFeed.active, paused = _mockFeed.paused;
  const btn = (act, label, cls) => '<button class="btn ' + (cls || "ghost") + '" data-mockfeed="' + act +
    '" style="width:auto; padding:' + (compact ? "3px 10px" : "6px 14px") + ';">' + label + '</button>';

  let controls = "";
  if (!active) controls += btn("start", (compact ? "🤖 Practice" : "🤖 Start practice mock"), "primary");
  else {
    controls += paused ? btn("resume", "▶ Resume", "primary") : btn("pause", "⏸ Pause");
    controls += btn("stop", "■ Stop");
  }

  if (compact) {
    let s = '<span class="small" style="display:inline-flex; gap:6px; align-items:center;">';
    if (active) s += '<span class="muted">🤖 mock <b id="mf-status-compact">' + _mockFeed.soldLots + '/' + (_mockFeed.script ? _mockFeed.script.totalLots : 0) + '</b></span>';
    s += controls + _mfSpeedSeg() + '</span>';
    return s;
  }

  let html = '<div class="card">';
  html += '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">';
  html += '<h3 style="margin:0;">🤖 Practice vs bots</h3>';
  html += '<span class="muted small">UD\'s own auction engine, feeding the real cockpit — no ESPN tab needed</span>';
  html += '<span style="flex:1;"></span>';
  html += _mfSpeedSeg();
  html += controls;
  html += '</div>';
  html += '<p class="muted small" style="margin:6px 0 0;">Owner tendencies decide who bids and how high; real ESPN pacing (~25s lots) decides when. Enter Draft to watch it in the cockpit — hero, ticker, recommended bid, budgets, invariants and Debrief all run live.</p>';
  html += '<div class="small" id="mf-status" style="margin-top:6px;">' + _mfStatusText() + '</div>';
  html += '</div>';
  return html;
}

// Top-bar hook used by draft-mode.js _dmTopBar.
function _mfTopbarHtml() { return renderMockFeedControls(true); }

if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("click", (e) => {
    const t = e.target && e.target.closest ? e.target.closest("[data-mockfeed],[data-mockspeed]") : null;
    if (!t || !t.closest || !t.closest("#view-root")) return;
    if (t.dataset.mockfeed) {
      const a = t.dataset.mockfeed;
      if (a === "start") startMockFeed();
      else if (a === "pause") pauseMockFeed();
      else if (a === "resume") resumeMockFeed();
      else if (a === "stop") stopMockFeed();
    } else if (t.dataset.mockspeed) {
      setMockFeedSpeed(t.dataset.mockspeed);
    }
  });
}

// Node/test export (no-op in the browser where `module` is undefined).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildMockFeedScript, _mfBidTrace, _mfSampleIncrement };
}
