// Draft Mode — fullscreen draft-day layout (ultrawide-first). Entered from the
// Live Draft tab; hides the app tabs/statusbar (body.draft-mode CSS) and
// renders a purpose-built cockpit:
//
//   ┌ HERO: on-the-clock card (auto from the live event stream) ─ ticker ─ my bid panel ┐
//   ├ status strip: feed chips · inflation · my budget/max bid                          │
//   ├ MAIN: available players (BPA / hitters / pitchers / position) │ side panels       │
//   └ BOTTOM (collapsed): pick tracker · teams · call-ups · feed diagnostics            ┘
//
// The on-the-clock card is driven by NOMINATION/BID events captured by Keeper
// Edge — no typing. Manual entry stays in the classic view (Exit button) as the
// fallback if sync dies. Bid-by-bid updates patch the hero in place (no full
// re-render, so nothing jumps mid-keystroke).

const DM_KEY = "ud_draft_mode_v1";   // device-local view state (deliberately not synced)
// boardMode = the exclusive preset ("BPA" | "HIT" | "PIT"); boardPos = a Set of
// position codes for multi-select. When boardPos is non-empty it overrides
// boardMode (one column per selected position). statView toggles the table
// columns ("value" | "stats").
const _dmState = { boardMode: "BPA", boardPos: new Set(), search: "", needsOnly: false, statView: "value",
  compareTeamId: null,        // item 16: another team's roster shown next to mine
  standingsExpanded: false,   // item 17: full per-category standings table
  standingsSort: null };      // item 17: { cat: <key|"roto">, dir: "desc"|"asc" }

function _draftModeOn() {
  try { return localStorage.getItem(DM_KEY) === "1"; } catch (e) { return false; }
}
function setDraftMode(on) {
  // Leaving the cockpit ends a live interactive practice draft (freeze it for
  // Save/Clear) — the bots must not keep drafting in the background off-screen.
  if (!on && typeof mockFeedInteractive === "function" && mockFeedInteractive() &&
      typeof mockFeedFinished === "function" && !mockFeedFinished() &&
      typeof endInteractiveCockpitMock === "function") {
    endInteractiveCockpitMock();
  }
  try { localStorage.setItem(DM_KEY, on ? "1" : "0"); } catch (e) {}
  document.body.classList.toggle("draft-mode", !!on);
  if (!on && typeof _liveDraft !== "undefined") _liveDraft.manualView = false;   // Exit always lands on Draft Setup
  renderDraft();
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // Esc closes the debrief overlay first, never fires while typing in a
  // field (the "clear this box" instinct must not tear down the cockpit).
  if (document.getElementById("debrief-overlay")) { closeDebrief(); return; }
  const t = e.target, ae = document.activeElement;
  const isField = (el) => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
  if (isField(t) || isField(ae)) return;
  if (_draftModeOn() && typeof currentView !== "undefined" && currentView === "draft") setDraftMode(false);
});

// Interactive practice-mock controls (nominate / bid / pass / auto-bid) — wired
// ONCE via document delegation so they survive the innerHTML rebuilds that
// updateDraftModeLive does on every bot bid. The engine (mock-interactive.js)
// owns all the rules; on a rejected action we just surface its error.
document.addEventListener("click", (e) => {
  const t = e.target && e.target.closest ? e.target.closest("[data-icnom],[data-icbid],[data-icbidto],[data-icbidcustom],[data-icpass],[data-icproxy]") : null;
  if (!t || !t.closest("#view-root")) return;
  if (!(typeof mockFeedInteractive === "function" && mockFeedInteractive())) return;
  if (typeof userBid !== "function" || typeof userPass !== "function" || typeof userNominate !== "function") return;
  const show = (r) => { if (r && r.ok === false && r.error && typeof alert === "function") alert(r.error); };
  const num = (id) => { const el = document.getElementById(id); const v = el ? parseInt(el.value, 10) : NaN; return isFinite(v) ? v : null; };
  if (t.dataset.icnom) {
    const name = (document.getElementById("dm-icnom-name")?.value || "").trim();
    if (!name) return;
    show(userNominate(name, num("dm-icnom-open") || 1));
  } else if (t.dataset.icbid) {
    const s = getInteractiveState();
    show(userBid(s.currentBid + (parseInt(t.dataset.icbid, 10) || 1)));
  } else if (t.dataset.icbidto) {
    show(userBid(parseInt(t.dataset.icbidto, 10)));
  } else if (t.dataset.icbidcustom) {
    const amt = num("dm-icbid-custom");
    if (amt != null) show(userBid(amt));
  } else if (t.dataset.icpass) {
    userPass();
  } else if (t.dataset.icproxy) {
    if (typeof setProxyMax !== "function") return;
    setProxyMax(t.dataset.icproxy === "set" ? num("dm-icproxy") : null);
  }
});

// ---------------------------------------------------------------------------
// Current lot from the event stream: walk the log; a NOMINATION (or first BID)
// after the last SOLD opens a lot, SOLD closes it.
function currentLotFromEvents() {
  const evs = _dlog.events;
  let lot = null;
  const soldIds = new Set();   // a trailing BID for an already-SOLD player must not reopen a lot (P2R1 state-2)
  for (const e of evs) {
    // SOLD closes only ITS lot — interleaved frames (NOM B before SOLD A
    // lands) must not blank the player actually on the clock. INIT marks a
    // socket reconnect: NOMINATION/BID during the gap are lost, so a pre-gap
    // lot can't be trusted — reset and let live frames rebuild it.
    if (e.cmd === "SOLD") { if (e.playerId != null) soldIds.add(e.playerId); if (!lot || e.playerId == null || lot.playerId === e.playerId) lot = null; continue; }
    if (e.cmd === "INIT") { lot = null; continue; }
    if (e.cmd === "NOMINATION" && e.playerId != null && e.playerId > 1000) {
      soldIds.delete(e.playerId);   // an explicit re-nomination (undo → re-auction) is legit
      lot = { playerId: e.playerId, nomTeamId: e.teamId, at: e.at, bids: [] };
    } else if ((e.cmd === "BID" || e.cmd === "BID_ACK") && e.playerId != null) {
      if (!lot || lot.playerId !== e.playerId) {
        if (soldIds.has(e.playerId)) continue;   // straggler bid for a completed pick — never reopen
        lot = { playerId: e.playerId, nomTeamId: null, at: e.at, bids: [] };
      }
      if (Number.isFinite(e.amount)) lot.bids.push({ teamId: e.teamId, amount: e.amount, at: e.at, ack: e.cmd === "BID_ACK" });
    }
  }
  if (!lot) return null;
  const lastAt = lot.bids.length ? lot.bids[lot.bids.length - 1].at : lot.at;
  // Quiet lots go IDLE, not blank — every real auction has commissioner
  // pauses, and blanking the hero mid-pause looks like a sync failure. Only a
  // very old lot (>60 min) is treated as ended.
  const quietMs = lastAt ? Date.now() - lastAt : 0;
  if (quietMs > 2 * 60 * 60 * 1000) return null;   // 2h: long commissioner pauses must not blank the card (Jeff, spec Q2)
  const idle = quietMs > 5 * 60 * 1000;
  const name = _resolveEspnName(lot.playerId);
  const top = lot.bids.reduce((m, b) => (b.amount > (m ? m.amount : 0) ? b : m), null);
  return {
    playerId: lot.playerId, name, nomTeamId: lot.nomTeamId,
    bids: lot.bids, highBid: top ? top.amount : 1, highTeamId: top ? top.teamId : lot.nomTeamId,
    lastAt, idle: idle, idleMin: idle ? Math.round(quietMs / 60000) : 0,
  };
}

// "Who else wants him" — opponents likely to bid, by roster fit + budget.
// Year-1 heuristic (no history yet): an opponent is interested if they have an
// open slot at the player's position AND the money to bid competitively. Score
// blends position-need severity with spending power, so the owner who both
// needs the slot and can pay floats to the top.
function ownerInterest(playerName, opts) {
  opts = opts || {};
  const val = getPlayerValue(playerName);
  if (!val || typeof computeLiveTeamStates !== "function") return [];
  const posKey = val.posKey;
  const target = (typeof POS_TARGETS !== "undefined" && POS_TARGETS[posKey]) || 1;
  const inflation = computeLiveInflation();
  const inflated = (typeof inflatedValue === "function") ? inflatedValue(val, inflation) : val.value;
  const states = computeLiveTeamStates();
  const meId = (typeof getMyTeam === "function") ? (typeof getMyDraftTeam === "function" ? getMyDraftTeam() : getMyTeam())?.id : null;
  const out = [];
  for (const st of Object.values(states)) {
    if (st.teamId === meId || st.slotsRemaining <= 0) continue;
    const have = st.posCounts[posKey] || 0;
    const need = Math.max(0, target - have);
    // Flex spots (MI/CI/UTIL/OF) count multi-eligibility loosely: even a "full"
    // starter can want a strong bat for UTIL, so give a small baseline interest.
    const baseline = (posKey === "OF" || posKey === "SP" || posKey === "RP") ? 0.4 : 0.15;
    const needScore = need > 0 ? 1 + need * 0.5 : baseline;
    if (st.maxBid < Math.min(inflated * 0.5, 8) && need === 0) continue;   // can't/won't compete
    const canAfford = st.maxBid >= inflated;
    const moneyFactor = Math.min(1.6, st.maxBid / Math.max(6, inflated));   // rich teams weigh more
    const score = needScore * moneyFactor;
    const bits = [];
    if (need > 0) bits.push("needs " + posKey + (need > 1 ? " ×" + need : ""));
    else bits.push(posKey + " depth");
    bits.push("$" + st.maxBid + " max" + (canAfford ? "" : " (short)"));
    out.push({ ownerName: st.ownerName, teamId: st.teamId, score, need, maxBid: st.maxBid, canAfford, reason: bits.join(", ") });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, opts.limit || 3);
}

function _dmInterestHtml(name) {
  const interest = ownerInterest(name, { limit: 3 });
  if (!interest.length) return '';
  let html = '<div class="small" style="margin-top:6px;"><span class="muted">👀 Likely interested:</span> ';
  html += interest.map(i =>
    '<span style="white-space:nowrap;">' + esc(i.ownerName) +
    ' <span class="' + (i.canAfford ? 'muted' : 'dim') + '">(' + esc(i.reason) + ')</span></span>'
  ).join(' · ');
  html += '</div>';
  return html;
}

// Roster fit — a fast, local score (no AI) blending position need + category
// need + value. Answers "should THIS roster want him?" per row.
// Per-category single-player "notable" thresholds (roughly a clear plus in a
// 12-team league) for the cats we actually score.
const _FIT_NOTABLE = { R: 85, HR: 25, RBI: 85, SB: 15, QS: 10, K: 165, SV_HLD: 12 };
let _fitCtx = null, _fitCtxKey = -1;
function _fitContext() {
  const me = (typeof getMyTeam === "function") ? (typeof getMyDraftTeam === "function" ? getMyDraftTeam() : getMyTeam()) : null;
  if (!me) return null;
  // Recompute only when my roster/picks change (cheap invalidation key).
  const key = (typeof _liveDraft !== "undefined" ? _liveDraft.picks.length : 0) * 1000 + (getMyRoster().length);
  if (_fitCtx && _fitCtxKey === key) return _fitCtx;
  const st = (typeof computeLiveTeamStates === "function") ? computeLiveTeamStates()[me.id] : null;
  const openPos = new Set();
  const openCount = {};
  if (st) for (const [pos, tgt] of Object.entries((typeof POS_TARGETS !== "undefined" ? POS_TARGETS : {}))) {
    const rem = tgt - (st.posCounts[pos] || 0);
    if (rem > 0) { openPos.add(pos); openCount[pos] = rem; }
  }
  // Weak categories = bottom-half projected rank (rank is 1=best..12=worst).
  const cats = (typeof projectTeamCategories === "function") ? projectTeamCategories(getMyRoster()) : null;
  const weak = new Set();
  if (cats && cats.ranks) for (const [c, r] of Object.entries(cats.ranks)) if (r >= 7) weak.add(c);
  _fitCtx = { openPos, openCount, weak, slotsRemaining: st ? st.slotsRemaining : 99 };
  _fitCtxKey = key;
  return _fitCtx;
}

function rosterFit(playerName) {
  const ctx = _fitContext();
  if (!ctx) return null;
  const val = getPlayerValue(playerName);
  if (!val) return null;
  let score = 0; const parts = [];
  // Position need — only NAME the position when it's genuinely scarce info:
  // the last open slot there, or catcher ("fills SP" with 6 SP slots is noise).
  if (ctx.openPos.has(val.posKey)) {
    score += 2;
    const remaining = ctx.openCount ? ctx.openCount[val.posKey] : null;
    if (val.posKey === "C" || remaining === 1) parts.push("last " + val.posKey + " slot");
  }
  else if ((_DM_FLEX[val.posKey === "SS" || val.posKey === "2B" ? "MI" : val.posKey === "1B" || val.posKey === "3B" ? "CI" : "UTIL"] || []).includes(val.posKey) && ctx.openPos.has("UTIL")) { score += 0.5; }
  // Category need — does he clear a notable bar in one of my weak cats?
  const tot = (typeof aggregateCats === "function") ? aggregateCats([playerName]) : null;
  if (tot) {
    for (const c of ["SB", "HR", "R", "RBI", "QS", "K", "SV_HLD"]) {
      if (!ctx.weak.has(c)) continue;
      const v = c === "SV_HLD" ? tot.SV_HLD : tot[c];
      if (v != null && _FIT_NOTABLE[c] && v >= _FIT_NOTABLE[c]) { score += 1; parts.push("+" + (c === "SV_HLD" ? "SV+H" : c)); }
    }
  }
  if (!score) return null;
  return { score, label: parts.slice(0, 3).join(" "), strong: score >= 3 };
}

function _dmFitBadge(name) {
  const f = rosterFit(name);
  if (!f) return '';
  const color = f.strong ? "var(--good)" : "var(--accent)";
  return ' <span class="small" title="Roster fit' + (f.label ? ': ' + esc(f.label) : '') + '" style="color:' + color + ';">' +
    (f.strong ? '★' : '•') + (f.label ? ' ' + esc(f.label) : '') + '</span>';
}

// Room temperature — is the room fighting for this player or sitting on hands?
// Heuristic v1 (bid cadence + distinct bidders + price vs market); calibrate
// against recorded draft data once we have some.
function lotTemperature(lot) {
  if (!lot) return null;
  const bidders = new Set(lot.bids.map(b => b.teamId)).size;
  const secsQuiet = lot.lastAt ? (Date.now() - lot.lastAt) / 1000 : 0;
  const val = getPlayerValue(lot.name);
  const nfbc = getNfbc(lot.name);
  const market = Math.max(nfbc?.avg || 0, val ? val.value : 0);
  const ratio = market > 0 ? lot.highBid / market : null;
  if ((bidders <= 2 && lot.bids.length >= 2 && secsQuiet > 8 && (ratio == null || ratio < 0.8)) ||
      (ratio != null && ratio < 0.5 && secsQuiet > 12)) {
    return { level: "cold", note: bidders + " bidder" + (bidders === 1 ? "" : "s") + ", quiet " + Math.round(secsQuiet) + "s" + (ratio != null ? ", " + Math.round(ratio * 100) + "% of market" : "") + " — possible bargain" };
  }
  if (bidders >= 4 || (ratio != null && ratio > 1.05)) {
    return { level: "hot", note: bidders + " bidders" + (ratio != null ? ", " + Math.round(ratio * 100) + "% of market" : "") };
  }
  return { level: "normal", note: bidders + " bidder" + (bidders === 1 ? "" : "s") + " so far" };
}

// Walk-away + stretch recommendation (deterministic v1; the AI panel layers
// judgment on top). Walk-away = value discipline; stretch = what you'd pay if
// he's a target / fills a need, still capped by your max bid.
function recommendBid(playerName) {
  const val = getPlayerValue(playerName);
  if (!val) return null;
  const inflation = computeLiveInflation();
  const inflated = (typeof inflatedValue === "function") ? inflatedValue(val, inflation) : val.value;
  const me = (typeof getMyDraftTeam === "function" ? getMyDraftTeam() : getMyTeam());
  const st = me ? computeLiveTeamStates()[me.id] : null;
  // No seat set in a mock → no personal max. Use null (not a $999 sentinel that
  // would print "my max $999" and inflate walk/stretch in a $260 league, R10).
  const maxBid = st ? st.maxBid : null;
  const reasons = [];
  let walk = Math.round(inflated);
  reasons.push("$" + val.value.toFixed(0) + " value ×" + (inflation ? inflation.multiplier.toFixed(2) : "1.00") + " inflation");
  const tcls = (typeof classifyPriceVsTargets === "function") ? classifyPriceVsTargets(playerName, inflated) : null;
  const isTarget = (typeof getNote === "function") ? !!(getNote(playerName)?.tags || []).includes("target") : false;
  let stretch = walk + Math.max(1, Math.round(inflated * 0.08));
  if (isTarget || tcls === "dream") { stretch = walk + Math.max(2, Math.round(inflated * 0.15)); reasons.push("your target — stretch higher"); }
  if (st) {
    const posKey = val.posKey;
    const need = (st.posCounts[posKey] || 0) === 0;
    if (need) { stretch += 1; reasons.push("fills your empty " + posKey + " slot"); }
  }
  if (maxBid != null && walk > maxBid) { walk = maxBid; reasons.push("capped by your max bid"); }
  if (maxBid != null && stretch > maxBid) stretch = maxBid;
  if (stretch < walk) stretch = walk;
  return { walk: Math.max(1, walk), stretch: Math.max(1, stretch), maxBid, rationale: reasons.join(" · ") };
}

// ---------------------------------------------------------------------------
// Projected standings: each team's eventual roster = keepers (incl call-ups) +
// picks so far + a projected fill of its open slots from the remaining pool,
// where richer teams (higher $/slot) land the better remaining players.
function computeLiveProjStandings() {
  if (typeof computeMockStandings !== "function") return null;
  const states = computeLiveTeamStates();
  const selections = (typeof getEffectiveKeeperSelections === "function") ? getEffectiveKeeperSelections() : {};
  const inflMult = computeLiveInflation()?.multiplier || 1;
  const pool = availableDraftPool();
  const money = {}, slots = {}, fills = {};
  for (const t of (typeof draftTeams === "function" ? draftTeams() : LEAGUE.teams)) {
    const st = states[t.id];
    money[t.id] = Math.max(0, st ? st.budget : 0);
    slots[t.id] = Math.max(0, st ? st.slotsRemaining : 0);
    fills[t.id] = [];
  }
  // Allocate the remaining pool (value-descending) to open teams: the richest
  // team that can still afford a player lands him. Selecting on ABSOLUTE money
  // (not $/slot) matters — a $/slot rule rewards buying cheap players (a
  // below-average buy nudges $/slot UP), so one team runs away and vacuums the
  // whole pool. Money only ever decreases, so richest-wins spreads studs to the
  // funded teams and lets cash-rich teams mop up the leftovers, with no runaway.
  const teamList = (typeof draftTeams === "function" ? draftTeams() : LEAGUE.teams);
  const rank = (t) => money[t.id] * 1000 + slots[t.id];   // money dominates; more open slots breaks ties
  for (const p of pool) {
    const est = Math.max(1, Math.round((p.value || 0) * inflMult));
    let best = null, bestKey = -Infinity;
    for (const t of teamList) {
      if (slots[t.id] <= 0) continue;
      const afford = money[t.id] - (slots[t.id] - 1);   // $1 reserved per other slot
      if (afford < est) continue;
      const key = rank(t);
      if (key > bestKey) { bestKey = key; best = t.id; }
    }
    if (best == null) {
      // Nobody can afford him at estimate — richest open team gets him at max
      for (const t of teamList) {
        if (slots[t.id] <= 0) continue;
        const key = rank(t);
        if (key > bestKey) { bestKey = key; best = t.id; }
      }
      if (best == null) break;   // all rosters full
    }
    const price = Math.min(est, Math.max(1, money[best] - (slots[best] - 1)));
    fills[best].push({ name: p.name, price, value: p.value });
    money[best] -= price;
    slots[best] -= 1;
  }
  // Synthesize mock-engine-shaped states so computeMockStandings does the roto math.
  const synth = {};
  for (const t of (typeof draftTeams === "function" ? draftTeams() : LEAGUE.teams)) {
    const sel = selections[t.id] || {};
    const kept = Object.entries(sel)
      .filter(([_, f]) => f.keeper)   // minor keepers are stashed — no ML slot
      .map(([name]) => ({ name }));
    const picks = _liveDraft.picks.filter(p => p.team === t.id).map(p => ({ name: p.player, price: p.price, value: getPlayerValue(p.player)?.value || 0 }));
    synth[t.id] = { teamId: t.id, ownerName: t.owner, isMe: !!t.isMe, kept, drafted: [...picks, ...fills[t.id]] };
  }
  const res = computeMockStandings(synth);
  if (res) res.projectedFills = fills;
  return res;
}

// ---------------------------------------------------------------------------
// Rendering

function renderDraftMode(root, inflation) {
  document.body.classList.add("draft-mode");
  if (typeof _ensureEspnNames === "function") _ensureEspnNames();   // names + injury flags, best-effort
  if (typeof ensureRotowireNews === "function") ensureRotowireNews();   // player news, best-effort
  // Restore the persisted Value/Stats toggle before rendering the board (once —
  // only if the user hasn't already changed it this session).
  if (!_dmState._statViewLoaded) {
    const lv = _dmLayout().statView;
    if (lv) _dmState.statView = lv;
    const se = _dmLayout().standingsExpanded;   // item 17: restore expanded state
    if (typeof se === "boolean") _dmState.standingsExpanded = se;
    _dmState._statViewLoaded = true;
  }
  const order = _dmPanelOrder();
  const sizes = _dmLayout().sizes || {};
  const ctx = { inflation, sizes, panels: _dmBuildPanels(inflation) };
  let html = '<div class="dm-wrap">';
  html += _dmTopBar(inflation);
  // Endgame panel — full-width, above the free-flow panels, so turning endgame
  // on (or its auto-detecting) is unmistakable. NOT a panel (conditional).
  if (typeof isEndgame === "function" && isEndgame()) {
    html += '<div class="dm-endgame-strip">' + renderEndgamePanel() + '</div>';
  }
  // FREEFORM canvas — every panel is an absolutely-positioned card you drag to
  // any x/y (title-bar handle) and resize in both dimensions (⌟ corner). First
  // visit auto-tiles a sensible default; after that each card keeps exactly
  // where you put it. Position + size persist device-local.
  html += '<div class="dm-canvas" data-dm-flow>';
  for (const id of order) {
    const p = ctx.panels[id];
    if (!p) continue;
    html += _dmPanelHtml(id, p, sizes);
    // Transient compare-roster card pops up over/near My Roster.
    if (id === "roster" && _dmState.compareTeamId != null) html += _dmCompareCardHtml(sizes);
  }
  html += '</div>';
  html += _dmBottom();
  html += '</div>';
  root.innerHTML = html;
  wireDraftMode();
  _dmCanvasLayout();   // place unpositioned cards + size the canvas (needs the DOM)
}

// Build the content (title + inner HTML) for every panel, once per render. The
// inner content functions (_dmHero, _dmBoard, renderCategoryDashboard, …) are
// untouched — they're just wrapped in the panel card shell here.
function _dmBuildPanels(inflation) {
  const p = {};
  p.hero = { title: "On the Clock", body: _dmHero(), cls: "dm-panel-hero" };
  p.board = { title: "Available Players", body: _dmBoard(inflation), cls: "dm-panel-board" };
  p.roster = { title: "My Roster", body: _dmMyRosterHtml() };
  p.budgets = { title: "Budgets", body: _dmBudgetsHtml() };
  p.standings = { title: 'Projected Standings <span class="muted small">if the rest goes to $/slot</span>', body: _dmStandingsHtml() };
  p.noms = { title: "Nominations", body: (typeof renderNominationsPanel === "function") ? renderNominationsPanel() : "" };
  p.history = { title: "Draft History", body: _dmHistoryHtml(), cls: "dm-panel-history" };
  p.cats = { title: "Category Dashboard", body: (typeof renderCategoryDashboard === "function") ? renderCategoryDashboard() : "" };
  p.ai = { title: "AI Assistant", body: (typeof renderAiAssistantPanel === "function") ? renderAiAssistantPanel() : "" };
  p.plan = { title: "My Plan", body: _dmPlanBar() };
  return p;
}

// One freeform panel card. Width + height come from the persisted size (or a
// per-panel default; "wide" panels default to the full canvas width); left/top
// come from the persisted position — a card with no position yet is auto-tiled
// by _dmCanvasLayout after render. Dragging is pointer-based on the title bar
// only (see _dmWireCardDrag), so the body (buttons, inputs, the roster
// player-drag, text selection) stays live. CSS `resize: both` on the card gives
// the ⌟ corner grabber for width+height.
function _dmPanelStyle(id, sizes, pos, fallbackW, fallbackH) {
  const sz = sizes ? sizes[id] : null;
  const w = (sz && typeof sz.w === "number" && sz.w >= 240) ? sz.w : null;
  const h = (sz && typeof sz.h === "number" && sz.h >= 120) ? sz.h : null;
  let s = "width:" + (w != null ? w + "px" : fallbackW) + ";";
  if (h != null) s += "height:" + h + "px;";
  else if (typeof fallbackH === "number") s += "height:" + fallbackH + "px;";
  const p = pos ? pos[id] : null;
  if (p && typeof p.x === "number" && typeof p.y === "number") s += "left:" + p.x + "px;top:" + p.y + "px;";
  return s;
}
function _dmPanelHtml(id, p, sizes) {
  const pos = _dmLayout().pos || {};
  const wide = _DM_WIDE_PANELS.includes(id);
  const style = _dmPanelStyle(id, sizes, pos, wide ? "100%" : ((_DM_DEFAULT_W[id] || 380) + "px"), _DM_DEFAULT_H[id]);
  const cls = "card dm-rcard dm-panel" + (wide ? " dm-panel-wide" : " dm-panel-side") + (p.cls ? " " + p.cls : "");
  return '<div class="' + cls + '" data-dm-card="' + id + '" style="' + style + '">' +
    '<h3 class="dm-panel-title" title="Drag this bar to move the panel anywhere · drag the ⌟ corner to resize"><span class="dm-grip" aria-hidden="true">⠿</span> ' + p.title + '</h3>' +
    '<div class="dm-cardbody" data-dm-cardbody="' + id + '">' + p.body + '</div></div>';
}

// The transient "compare roster" card (item 16). Pops up offset from My Roster
// (positioned by _dmCanvasLayout); resizable but NOT persisted (no data-dm-card).
function _dmCompareCardHtml(sizes) {
  const cmpTeam = (typeof getTeam === "function") ? getTeam(_dmState.compareTeamId) : null;
  if (!cmpTeam) { _dmState.compareTeamId = null; return ""; }   // stale id (team gone)
  const title = '🔍 ' + esc(cmpTeam.owner) + '’s Roster ' +
    '<button class="btn ghost dm-cmp-close" title="Close comparison" style="float:right; padding:0 8px; font-size:12px;">✕</button>';
  const style = _dmPanelStyle("compare", sizes, null, (_DM_DEFAULT_W.roster || 380) + "px", _DM_DEFAULT_H.roster);
  return '<div class="card dm-rcard dm-panel dm-panel-side dm-cmpcard" style="' + style + '"><h3 style="margin:0 0 6px;">' + title + '</h3>' +
    '<div class="dm-cardbody">' + _dmCompareRosterHtml(_dmState.compareTeamId) + '</div></div>';
}

function _dmTopBar(inflation) {
  const me = (typeof getMyDraftTeam === "function" ? getMyDraftTeam() : getMyTeam());
  const st = me ? computeLiveTeamStates()[me.id] : null;
  let html = '<div class="card dm-topbar">';
  html += '<b>DRAFT MODE</b>';
  html += '<span class="muted small">' + _liveDraft.picks.length + ' picks</span>';
  if (inflation) html += '<span class="badge">infl ' + inflation.multiplier.toFixed(2) + '×</span>';
  if (st) html += '<span class="small">My budget <b>$' + st.budget + '</b> · ' + st.slotsRemaining + ' slots · max bid <b style="color:var(--accent);">$' + st.maxBid + '</b></span>';
  // Endgame badge — visible whenever endgame is active (forced OR auto-detected),
  // so the auto path is no longer silent (item 10).
  const egOn = (typeof isEndgame === "function") && isEndgame();
  const egForced = (typeof isEndgameForced === "function") && isEndgameForced();
  if (egOn) html += '<span class="badge" style="color:var(--warn); border-color:var(--warn); background:rgba(210,153,34,.10);" title="' + (egForced ? 'Endgame forced on' : 'Endgame auto-detected — late scarcity phase') + '">🔥 ENDGAME' + (egForced ? '' : ' <span class="muted">(auto)</span>') + '</span>';
  html += '<span id="dm-feedchips" class="small" style="display:inline-flex; gap:10px;">' + _dmFeedChips() + '</span>';
  html += '<span style="flex:1;"></span>';
  if (typeof _mfTopbarHtml === "function") html += _mfTopbarHtml();   // mirrored practice-mock controls
  html += '<button class="btn ghost' + (egForced ? ' dm-endgame-on' : '') + '" id="dm-endgame" title="Force the endgame tools on (auto-detection stays as fallback)">' + (egForced ? '🔥 Endgame: ON' : 'Endgame: auto') + '</button>';
  html += '<button class="btn ghost" id="dm-reset-layout" title="Reset every panel to its default position and size">↺ Layout</button>';
  html += '<button class="btn ghost" id="dm-debrief" title="Post-draft recap">📋 Debrief</button>';
  html += '<button class="btn ghost" id="dm-exit" title="Esc also exits">✕ Exit to setup</button>';
  html += '</div>';
  return html;
}

function _dmFeedChips() {
  const dot = (on, color) => '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (on ? color : "var(--text-3)") + ';margin-right:4px;vertical-align:middle;"></span>';
  const lastFrame = Math.max(_feed.lastFrameAt || 0, _dlog.lastEventAt || 0);
  const quiet = lastFrame ? (Date.now() - lastFrame) / 1000 : null;
  // A UD-native mock has no extension/ESPN-tab — show a clean practice-mock chip
  // instead of grey ext/tab dots + "mode off" (R14).
  if (typeof mockFeedActive === "function" && mockFeedActive()) {
    return '<span>' + dot(true, "var(--good)") + '🤖 practice draft</span>' +
      '<span>' + dot(lastFrame && quiet < 30, "var(--good)") + (lastFrame ? 'feed ' + Math.round(quiet) + 's' : 'starting…') + '</span>';
  }
  const stalled = (typeof _feedStallState === "function") ? _feedStallState().level === "stalled"
    : (draftTabOpen() && lastFrame && quiet > 30);
  let s = '<span>' + dot(_feed.extPresent, "var(--good)") + 'ext</span>';
  s += '<span>' + dot(draftTabOpen(), "var(--good)") + 'ESPN tab</span>';
  s += '<span>' + dot(lastFrame && quiet < 30, stalled ? "var(--bad)" : "var(--good)") + (lastFrame ? (stalled ? '<b style="color:var(--bad);">feed quiet ' + Math.round(quiet) + 's</b>' : 'feed ' + Math.round(quiet) + 's') : 'no data') + '</span>';
  s += '<span class="muted">mode ' + esc(getFeedMode()) + '</span>';
  return s;
}

function _dmHero() {
  const lot = (getFeedMode() !== "off" || (typeof mockFeedActive === "function" && mockFeedActive())) ? currentLotFromEvents() : null;
  const manual = _liveDraft.current;
  // "Player NNNNN" = an unresolved placeholder id (ESPN sends a sentinel like
  // 25000 when no one has nominated yet, per Jeff's mock; it also appears
  // briefly while the name map loads). Never show it as a real lot.
  const lotIsPlaceholder = lot && /^Player \d+$/.test(lot.name || "");
  const name = (lot && !lotIsPlaceholder) ? lot.name : (manual ? manual.player : null);
  let html = '<div class="dm-hero">';

  // --- player card --- (data-player is the stable change-detection key; the
  // visible name now carries an injury chip so its textContent can't be used)
  html += '<div class="card dm-otc" id="dm-otc" data-player="' + esc(name || "") + '">';
  if (!name) {
    const icOn = typeof mockFeedInteractive === "function" && mockFeedInteractive();
    if (icOn && typeof mockFeedFinished === "function" && mockFeedFinished()) {
      html += '<div class="otc-label">Practice draft</div>';
      html += '<div class="dm-player muted">Practice draft complete 🎉</div>';
      html += '<div class="small muted">Open <b>Debrief</b> to review, then <b>Save &amp; clear</b> or <b>Clear</b> from the top bar.</div>';
    } else if (icOn) {
      html += '<div class="otc-label">Practice draft</div>';
      html += _dmInteractiveNominateHtml();
    } else {
      html += '<div class="otc-label">On the Clock</div>';
      html += '<div class="dm-player muted">Waiting for a nomination…</div>';
      html += '<div class="small muted">Nominations on ESPN appear here automatically' + (getFeedMode() === "off" ? ' — turn the pick feed ON below.' : '.') + '</div>';
      if (lotIsPlaceholder) html += '<div class="small dim" style="margin-top:4px;">(ESPN sent a placeholder nomination id — the room is between lots, or player names are still loading.)</div>';
    }
  } else {
    const val = getPlayerValue(name);
    const nfbc = getNfbc(name);
    const sc = (typeof getStatcast === "function") ? getStatcast(name) : null;
    const sig = (typeof statcastBuySell === "function") ? statcastBuySell(name) : null;
    const infl = val ? inflatedValue(val, computeLiveInflation()) : null;
    html += '<div class="otc-label">On the Clock' + (lot && lot.nomTeamId != null ? ' <span class="muted small">nominated by ' + esc(_dmTeamLabel(lot.nomTeamId)) + '</span>' : '') + '</div>';
    const inj = (typeof espnInjuryLabel === "function") ? espnInjuryLabel(name) : null;
    html += '<div class="dm-player">' + esc(name) +
      (inj ? ' <span class="small" style="color:var(--bad); border:1px solid var(--bad); border-radius:4px; padding:1px 6px; vertical-align:middle;">🚑 ' + esc(inj) + '</span>' : '') + '</div>';
    html += '<div class="otc-meta">';
    html += '<span class="kbd">' + esc(val?.posKey || "?") + '</span>';
    if (val?.team) html += ' <span class="muted">' + esc(val.team) + '</span>';
    html += ' · <b>$' + (val ? val.value.toFixed(0) : "?") + '</b> <span class="muted">value</span>';
    if (infl != null) html += ' · <b>$' + infl.toFixed(0) + '</b> <span class="muted">w/ inflation</span>';
    if (nfbc?.avg) html += ' · <b>$' + nfbc.avg.toFixed(0) + '</b> <span class="muted">NFBC' + (nfbc.min != null && nfbc.max != null ? ' [' + nfbc.min + '–' + nfbc.max + ']' : '') + '</span>';
    html += '</div>';
    html += '<div class="otc-meta small">' + _dmProjLine(name) + '</div>';
    if (sig) html += '<div class="otc-signal ' + sig.signal + '">' + (sig.signal === "buy" ? "📈" : "📉") + ' ' + esc(sig.reason) + '</div>';
    if (typeof renderPlayerNewsBlock === "function") {
      const newsBlock = renderPlayerNewsBlock(name);
      html += newsBlock;
      if (!newsBlock && inj) html += '<div class="small dim" style="margin-top:4px;">No recent Rotowire item — no return estimate available.</div>';
    }
    html += '<div id="dm-interest">' + _dmInterestHtml(name) + '</div>';
    const temp = lot ? lotTemperature(lot) : null;
    html += '<div id="dm-temp">' + (temp ? _dmTempChip(temp) : '') + '</div>';
    html += '<div id="dm-idle">' + (lot && lot.idle ? '<div class="small" style="margin-top:4px; color:var(--warn);">⏸ Lot quiet ' + lot.idleMin + 'm — draft likely paused; resumes automatically.</div>' : '') + '</div>';
  }
  html += '</div>';

  // --- ticker ---
  html += '<div class="card dm-ticker-card"><div class="otc-label">Bidding</div>';
  html += '<div id="dm-bidline" class="dm-bidline">' + (lot ? _dmBidLine(lot) : '<span class="muted small">—</span>') + '</div>';
  html += '<div id="dm-bidmeter">' + (lot ? _dmBidMeter(lot) : '') + '</div>';
  html += '<div id="dm-ticker" class="dm-ticker">' + (lot ? _dmTickerHtml(lot) : '') + '</div>';
  html += '</div>';

  // --- my bid panel ---
  html += '<div class="card dm-mybid"><div class="otc-label">Your Call</div>';
  html += '<div id="dm-reco">' + (name ? _dmRecoHtml(name, lot) : '<span class="muted small">—</span>') + '</div>';
  html += '</div>';

  html += '</div>';
  return html;
}

function _dmTeamLabel(espnOrOwnerId) {
  if (draftTestMode()) return "Team " + espnOrOwnerId;
  // A running practice mock feeds REAL ESPN ids — resolve them to the real owner
  // via the mock's own id→owner map (covers even a synthetic seat with no
  // ESPN_TEAM_ID_MAP entry). Real drafts fall through to the standard mapping.
  if (typeof mockFeedActive === "function" && mockFeedActive() && typeof mockFeedOwnerName === "function") {
    const nm = mockFeedOwnerName(espnOrOwnerId);
    if (nm) return nm;
  }
  const owner = espnTeamIdToOwnerId(espnOrOwnerId);
  return (owner && getTeam(owner)?.owner) || ("Team " + espnOrOwnerId);
}

function _dmProjLine(name) {
  const proj = (typeof getProjection === "function") ? getProjection(name) : null;
  if (!proj) return '<span class="dim">no stat projection loaded</span>';
  const n = v => (v != null && isFinite(v)) ? Math.round(v) : null;   // counting stats → whole numbers
  if (proj.type === "H") {
    return [["R", n(proj.R)], ["HR", n(proj.HR)], ["RBI", n(proj.RBI)], ["SB", n(proj.SB)], ["OBP", proj.OBP != null ? Number(proj.OBP).toFixed(3) : null]]
      .filter(x => x[1] != null).map(x => '<b>' + x[1] + '</b> <span class="muted">' + x[0] + '</span>').join(" · ");
  }
  return [["QS", n(proj.QS)], ["K", n(proj.K)], ["SV+H", n(proj.SV_HLD)], ["ERA", proj.ERA != null ? Number(proj.ERA).toFixed(2) : null], ["WHIP", proj.WHIP != null ? Number(proj.WHIP).toFixed(2) : null]]
    .filter(x => x[1] != null).map(x => '<b>' + x[1] + '</b> <span class="muted">' + x[0] + '</span>').join(" · ");
}

function _dmTempChip(temp) {
  const color = temp.level === "cold" ? "var(--accent)" : temp.level === "hot" ? "var(--bad)" : "var(--text-2)";
  const label = temp.level === "cold" ? "🧊 ROOM READS COLD" : temp.level === "hot" ? "🔥 room is hot" : "room normal";
  return '<div class="small" style="margin-top:6px; color:' + color + ';"><b>' + label + '</b> <span class="muted">' + esc(temp.note) + '</span></div>';
}

// Fair value = the player's inflation-adjusted price. The live bid is read
// against it as bargain (≤0.85×) → fair (0.85–1.15×) → overpay (>1.15×).
function _dmFairValue(name) {
  const val = (typeof getPlayerValue === "function") ? getPlayerValue(name) : null;
  if (!val) return null;
  if (typeof inflatedValue === "function" && typeof computeLiveInflation === "function") {
    const f = inflatedValue(val, computeLiveInflation());
    if (isFinite(f) && f > 0) return f;
  }
  return val.value > 0 ? val.value : null;
}
function _dmBidColor(bid, fair) {
  if (!fair || fair <= 0) return "";
  return bid <= fair * 0.85 ? "var(--good)" : bid <= fair * 1.15 ? "var(--warn)" : "var(--bad)";
}

function _dmBidLine(lot) {
  const fair = _dmFairValue(lot.name);
  const color = _dmBidColor(lot.highBid, fair);
  return '<span class="dm-bignum"' + (color ? ' style="color:' + color + ';"' : '') + '>$' + lot.highBid + '</span> <span class="small">' + esc(_dmTeamLabel(lot.highTeamId)) + '</span>';
}

// A bargain→fair→overpay gradient band with a marker at the current bid — moves
// live as the auction climbs, so the room's price is readable at a glance.
function _dmBidMeter(lot) {
  const fair = _dmFairValue(lot.name);
  if (!fair) return '';
  const bid = Math.max(1, lot.highBid || 1);
  // Your personal thresholds live on the meter as ticks (so the separate "Your
  // Call" numbers aren't duplicated): the white tick = fair = walk-away, and an
  // accent tick = your stretch price for this player.
  const reco = (typeof recommendBid === "function") ? recommendBid(lot.name) : null;
  const stretch = (reco && reco.stretch && reco.stretch > fair) ? reco.stretch : null;
  const ceiling = Math.max(Math.ceil(fair * 1.8), Math.ceil((stretch || 0) * 1.12), Math.ceil(bid * 1.1), 6);
  const pct = (v) => Math.max(0, Math.min(100, (v / ceiling) * 100));
  const bargainEnd = pct(fair * 0.85), fairMid = pct(fair), overpayStart = pct(fair * 1.15), bidPct = pct(bid);
  const grad = 'linear-gradient(90deg, var(--good) 0%, var(--good) ' + bargainEnd.toFixed(1) +
    '%, var(--warn) ' + fairMid.toFixed(1) + '%, var(--bad) ' + overpayStart.toFixed(1) + '%, var(--bad) 100%)';
  let h = '<div style="position:relative; height:13px; border-radius:7px; margin:8px 0 3px; background:' + grad + '; box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);">';
  h += '<div title="fair $' + Math.round(fair) + '" style="position:absolute; left:' + fairMid.toFixed(1) + '%; top:-3px; bottom:-3px; width:2px; background:var(--warn);"></div>';
  if (stretch) h += '<div title="your stretch $' + Math.round(stretch) + '" style="position:absolute; left:' + pct(stretch).toFixed(1) + '%; top:-3px; bottom:-3px; width:2px; background:var(--accent);"></div>';
  h += '<div style="position:absolute; left:' + bidPct.toFixed(1) + '%; top:-6px; transform:translateX(-50%); font-size:12px; line-height:1; text-shadow:0 1px 2px rgba(0,0,0,.6);">▼</div>';
  h += '</div>';
  h += '<div class="small" style="display:flex; justify-content:space-between; gap:6px;"><span style="color:var(--good);">bargain</span>' +
    '<span><span style="color:var(--warn);">Fair $' + Math.round(fair) + '</span>' +
    (stretch ? ' <span style="color:var(--accent);">· stretch $' + Math.round(stretch) + '</span>' : '') + '</span>' +
    '<span style="color:var(--bad);">overpay</span></div>';
  return h;
}

function _dmTickerHtml(lot) {
  const rows = lot.bids.slice(-8).reverse();
  if (!rows.length) return '<div class="muted small">no bids yet</div>';
  return rows.map(b => '<div class="small">' + '$' + b.amount + ' — ' + esc(_dmTeamLabel(b.teamId)) + (b.ack ? '' : '') + '</div>').join("");
}

// ---------------------------------------------------------------------------
// Interactive practice-mock cockpit controls (mock-interactive.js drives the
// auction; these are YOUR nominate + bid/pass buttons). Wired once via document
// delegation (see the bottom of this file) so they survive the innerHTML
// rebuilds of updateDraftModeLive.

// The nominate box shown in the hero when it's your turn (no lot open yet).
function _dmInteractiveNominateHtml() {
  const s = (typeof getInteractiveState === "function") ? getInteractiveState() : null;
  const me = (typeof getMyTeam === "function") ? getMyTeam() : null;
  if (!s || s.phase !== "nominating" || !me) return '<div class="dm-player muted">Setting up…</div>';
  const nomId = s.nominationOrder[s.currentNominator % s.nominationOrder.length];
  if (nomId !== me.id) {
    const espn = (typeof mockFeedEspnId === "function") ? mockFeedEspnId(nomId) : null;
    return '<div class="dm-player muted" style="font-size:20px;">' + esc(espn != null ? _dmTeamLabel(espn) : "A team") + ' is choosing…</div>' +
      '<div class="small muted">They\'ll nominate a player in a moment.</div>';
  }
  const myState = s.states[me.id];
  const maxBid = myState ? Math.max(0, myState.budget - Math.max(0, myState.slotsRemaining - 1)) : 0;
  let html = '<div class="dm-player" style="color:var(--accent); font-size:22px;">Your turn to nominate</div>';
  html += '<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">';
  html += '<input id="dm-icnom-name" list="dm-icnom-list" placeholder="Player name…" autocomplete="off" style="flex:1; min-width:220px; font-size:16px;">';
  html += '<datalist id="dm-icnom-list">';
  for (const p of s.pool.slice(0, 200)) html += '<option value="' + esc(p.name) + '">' + esc(p.posKey) + ' · $' + p.value.toFixed(0) + '</option>';
  html += '</datalist>';
  html += '<input id="dm-icnom-open" type="number" min="1" value="1" style="width:100px; font-size:16px;" title="Opening bid">';
  html += '<button class="btn primary" data-icnom="1" style="width:auto; padding:10px 18px;">Nominate</button>';
  html += '</div>';
  html += '<div class="small muted" style="margin-top:6px;">Type a name (or click one on the board below). Your max bid: <b>$' + maxBid + '</b>.</div>';
  return html;
}

// Your bid / pass panel, shown at the top of Your Call during a live lot.
function _dmInteractiveBidControls(lot) {
  const s = (typeof getInteractiveState === "function") ? getInteractiveState() : null;
  const me = (typeof getMyTeam === "function") ? getMyTeam() : null;
  if (!s || s.phase !== "bidding" || !me) return "";
  const myState = s.states[me.id];
  if (!myState) return "";
  const cur = s.currentBid;
  const isMyBid = s.currentWinner === me.id;
  const iHavePassed = s.passedTeams && s.passedTeams.has(me.id);
  const myMax = Math.max(0, myState.budget - Math.max(0, myState.slotsRemaining - 1));
  const pricedOut = myMax <= cur;
  // While paused the engine rejects every action — grey the controls out too,
  // so a live-looking button doesn't invite a dead click (R16).
  const icPaused = (typeof _mockFeed !== "undefined") && !!_mockFeed.paused;
  const canAct = !icPaused && !isMyBid && !iHavePassed && !pricedOut;
  const fair = _dmFairValue(lot ? lot.name : (s.current && s.current.name)) || 0;
  const parVal = Math.round(fair);
  let html = '<div class="dm-icbid" style="margin:0 0 10px; padding:8px; border:1px solid var(--accent); border-radius:8px; background:rgba(79,142,247,.06);">';
  html += '<div class="small" style="margin-bottom:6px; display:flex; justify-content:space-between; gap:8px;"><span>';
  if (icPaused) html += '<span class="muted">⏸ Paused — resume from the top bar to keep bidding.</span>';
  else if (isMyBid) html += '<span class="good">✓ You\'re the high bidder at $' + cur + ' — bid again to hold them off.</span>';
  else if (iHavePassed) html += '<span class="muted">You\'re out of this lot — bid to jump back in.</span>';
  else if (pricedOut) html += '<span class="bad">Priced out — your max is $' + myMax + '.</span>';
  else html += '<span>Bid any time — lot closes when the clock hits 0. Max <b>$' + myMax + '</b>.</span>';
  // Shared lot clock (continuous model): everyone sees the same countdown; the
  // hammer falls to the current high bidder at 0. _icCockpitRefresh patches it.
  const clk = (s.useTimer && s.secondsLeft > 0) ? ("⏱ " + s.secondsLeft + "s") : "";
  html += '</span><b id="dm-icclock" style="color:' + (s.secondsLeft <= 4 ? 'var(--bad)' : 'var(--warn)') + '; font-size:15px; min-width:44px; text-align:right;">' + clk + '</b>';
  html += '</div>';
  html += '<div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">';
  for (const inc of [1, 2, 5]) {
    const en = canAct && (cur + inc) <= myMax;
    html += '<button class="btn primary" data-icbid="' + inc + '"' + (en ? '' : ' disabled') + ' style="width:auto; padding:6px 12px; min-width:46px;">+$' + inc + '</button>';
  }
  const parEn = canAct && parVal > cur && parVal <= myMax;
  if (parVal > 0) html += '<button class="btn" data-icbidto="' + parVal + '"' + (parEn ? '' : ' disabled') + ' style="width:auto; padding:6px 10px;" title="Bid to fair value">→ $' + parVal + '</button>';
  html += '<input id="dm-icbid-custom" type="number" min="' + (cur + 1) + '" placeholder="$" style="width:70px;"' + (canAct ? '' : ' disabled') + '>';
  html += '<button class="btn" data-icbidcustom="1"' + (canAct ? '' : ' disabled') + ' style="width:auto; padding:6px 10px;">Bid</button>';
  const passEn = !icPaused && !isMyBid && !iHavePassed;
  html += '<button class="btn ghost" data-icpass="1"' + (passEn ? '' : ' disabled') + ' style="width:auto; padding:6px 12px;">Pass</button>';
  html += '</div>';
  if (!iHavePassed) {
    if (s.proxyMax != null) html += '<div class="small" style="margin-top:6px;"><span class="good">Auto-bidding up to <b>$' + s.proxyMax + '</b></span> <button class="btn ghost" data-icproxy="cancel" style="width:auto; padding:2px 10px; font-size:11px;">Cancel</button></div>';
    else html += '<div class="small" style="margin-top:6px; display:flex; align-items:center; gap:6px;"><span class="muted">Auto-bid up to</span><input id="dm-icproxy" type="number" min="' + (cur + 1) + '" placeholder="$max" style="width:70px;"><button class="btn" data-icproxy="set" style="width:auto; padding:3px 10px; font-size:11px;">Set</button></div>';
  }
  html += '</div>';
  return html;
}

function _dmRecoHtml(name, lot) {
  const pre = (typeof mockFeedInteractive === "function" && mockFeedInteractive()) ? _dmInteractiveBidControls(lot) : "";
  const r = recommendBid(name);
  if (!r) return pre + '<span class="muted small">no value data for ' + esc(name) + '</span>';
  const high = lot ? lot.highBid : (_liveDraft.highBid || 0);
  let verdict, vcolor;
  if (high < r.walk) { verdict = "room to bid"; vcolor = "var(--good)"; }
  else if (high < r.stretch) { verdict = "stretch territory"; vcolor = "var(--warn)"; }
  else { verdict = "walk away"; vcolor = "var(--bad)"; }
  // The walk-away/stretch prices now live on the bid meter as ticks, so this
  // panel is the DECISION: a big verdict word + your budget cap + the why.
  let html = '<div style="color:' + vcolor + '; font-size:22px; font-weight:800; line-height:1.1;">' + verdict + '</div>';
  html += '<div class="small muted" style="margin-top:3px;">at <b style="color:var(--text);">$' + high + '</b>' +
    (r.maxBid != null ? ' · your budget max <b style="color:var(--text);">$' + r.maxBid + '</b>' : '') + '</div>';
  html += '<div class="muted small" style="margin-top:6px;">' + esc(r.rationale) + '</div>';
  const tactic = _bidTactic(name, high, r, lot);
  if (tactic) html += '<div class="small" style="margin-top:4px; color:var(--accent);">💡 ' + esc(tactic) + '</div>';
  // Practice-mock bid controls (item 3). In a real ESPN draft Jeff bids on ESPN,
  // so these appear ONLY during a running UD-native mock with a live lot. A "+$1"
  // quick-raise plus a number box (pre-filled at high+1) + Bid. Wired in
  // wireDraftMode(); userMockBid() clamps + re-resolves the lot (mock-live-feed.js).
  // watch-only mock (legacy playback): the interactive mock has its own richer
  // bid/pass panel prepended above, so gate this out when interactive.
  const watchOnlyMock = typeof mockFeedActive === "function" && mockFeedActive() &&
    !(typeof mockFeedInteractive === "function" && mockFeedInteractive());
  if (lot && lot.playerId != null && watchOnlyMock) {
    const next = high + 1;
    html += '<div style="display:flex; gap:6px; align-items:center; margin-top:8px; flex-wrap:wrap;">';
    html += '<button class="btn primary" id="dm-mock-bid1" style="width:auto; padding:6px 12px;" title="Quick raise to $' + next + '">+$1 → $' + next + '</button>';
    html += '<input id="dm-mock-bidamt" type="number" min="' + next + '" value="' + next + '" style="width:80px; font-size:16px; padding:5px 8px; border:1px solid var(--border); background:var(--bg-3); color:var(--text);">';
    html += '<button class="btn ghost" id="dm-mock-bid" style="width:auto; padding:6px 12px;">Bid</button>';
    html += '</div>';
    html += '<div class="small muted" style="margin-top:3px;">You bid here; the bots react and can counter — win a lot by topping the room.</div>';
  }
  return pre + html;
}

// One tactical nudge (kept deliberately light): break a round-number wall, or
// a shutdown jump to the field's max when you want the player and can afford it.
function _bidTactic(name, high, r, lot) {
  if (!r || high >= r.walk) return null;   // only when you'd still bid
  // Round-number resistance: rooms stall at $10/$20/$30.
  if (high >= 10 && high % 10 === 0 && high + 1 <= r.maxBid) {
    return "Bid $" + (high + 1) + " to break the $" + high + " wall.";
  }
  // Shutdown: if the interested field's top max bid is below yours, a jump to
  // their max ends it — nobody can legally top it.
  const interest = (typeof ownerInterest === "function") ? ownerInterest(name, { limit: 5 }) : [];
  const fieldMax = interest.reduce((m, i) => Math.max(m, i.maxBid || 0), 0);
  if (fieldMax > 0 && fieldMax >= high && fieldMax < r.maxBid && fieldMax <= r.stretch && interest.length >= 1) {
    return "Shutdown: a jump to $" + fieldMax + " tops the field's max — no one can counter.";
  }
  return null;
}

// --- available players board ---
const _DM_MODES = ["BPA", "HIT", "PIT", "C", "1B", "2B", "SS", "3B", "MI", "CI", "OF", "UTIL", "SP", "RP"];
const _DM_FLEX = { MI: ["2B", "SS"], CI: ["1B", "3B"], UTIL: ["C", "1B", "2B", "SS", "3B", "OF", "UTIL", "DH"] };
const _DM_HIT_POS = ["C", "1B", "2B", "SS", "3B", "OF", "UTIL", "DH"];

// The set of positions that pass a single mode code (BPA = everything, HIT/PIT
// the two big buckets, flex codes their eligibility list, a bare position code
// itself). Shared by single- and multi-column rendering.
function _dmModeMatch(p, m) {
  if (m === "BPA") return true;
  if (m === "HIT") return _DM_HIT_POS.includes(p.posKey);
  if (m === "PIT") return p.posKey === "SP" || p.posKey === "RP";
  if (_DM_FLEX[m]) return _DM_FLEX[m].includes(p.posKey);
  return p.posKey === m;
}

// The available pool with the global search + "my needs" filters applied, but
// WITHOUT any mode/position filter (callers slice per column/mode themselves).
function _dmBasePool() {
  let pool = availableDraftPool();
  if (_dmState.search) {
    const q = _dmState.search.toLowerCase();
    pool = pool.filter(p => p.name.toLowerCase().includes(q));
  }
  if (_dmState.needsOnly) {
    const me = (typeof getMyDraftTeam === "function" ? getMyDraftTeam() : getMyTeam());
    const st = me ? computeLiveTeamStates()[me.id] : null;
    if (st) pool = pool.filter(p => (st.posCounts[p.posKey] || 0) === 0);
  }
  return pool;
}

function _dmPoolRows(inflation) {
  return _dmBasePool().filter(p => _dmModeMatch(p, _dmState.boardMode));
}

// Scan the available pool for tier cliffs: a position whose best remaining tier
// is down to its last 1-2 players with a real value drop to the next tier — the
// "last elite SS on the board" scarcity signal.
function tierCliffs() {
  if (typeof tierForValue !== "function") return [];
  const pool = availableDraftPool();
  const byPos = {};
  for (const p of pool) (byPos[p.posKey] = byPos[p.posKey] || []).push(p);
  const cliffs = [];
  for (const pos of ["C", "1B", "2B", "SS", "3B", "OF", "SP", "RP"]) {
    const list = (byPos[pos] || []).slice().sort((a, b) => b.value - a.value);
    if (list.length < 2) continue;
    const topTier = tierForValue(list[0].value);
    if (topTier === "T5") continue;   // no cliff worth calling at the bottom
    const inTier = list.filter(p => tierForValue(p.value) === topTier);
    const next = list.find(p => tierForValue(p.value) !== topTier);
    const gap = next ? list[inTier.length - 1].value - next.value : 0;
    if (inTier.length <= 2 && gap >= 4) {
      cliffs.push({ pos, tier: topTier, countLeft: inTier.length, names: inTier.map(p => p.name), gap: Math.round(gap), nextVal: next ? Math.round(next.value) : null });
    }
  }
  // Tightest cliffs first (fewest left, then biggest drop).
  cliffs.sort((a, b) => a.countLeft - b.countLeft || b.gap - a.gap);
  return cliffs;
}

function _dmTierCliffBanner() {
  const cliffs = tierCliffs();
  if (!cliffs.length) return '';
  const shown = cliffs.slice(0, 4).map(c =>
    '<span style="white-space:nowrap;"><b style="color:var(--warn);">' + c.countLeft + ' ' + c.tier + ' ' + esc(c.pos) + '</b> left' +
    ' <span class="muted">(then −$' + c.gap + ')</span></span>'
  ).join(' · ');
  return '<div class="small" style="margin-bottom:8px; padding:5px 8px; border:1px solid var(--warn); background:rgba(210,153,34,.08);">⛰️ <b>Tier cliffs:</b> ' + shown + '</div>';
}

// The positions that participate in multi-select (BPA/HIT/PIT are exclusive
// presets that clear the multi-set; everything else toggles in/out).
const _DM_PRESETS = ["BPA", "HIT", "PIT"];
const _DM_POS_MODES = _DM_MODES.filter(m => !_DM_PRESETS.includes(m));

function _dmBoard(inflation) {
  const posSel = _dmState.boardPos;   // Set of selected position codes
  const multi = posSel && posSel.size > 0;
  // No .card wrapper here — the panel shell (_dmPanelHtml) supplies the card +
  // resizable body. This returns the board's inner content only.
  let html = '';
  html += _dmTierCliffBanner();
  html += '<div class="dm-board-head">';
  html += '<div class="seg dm-seg">' + _DM_MODES.map(m => {
    const isPreset = _DM_PRESETS.includes(m);
    const active = isPreset ? (!multi && _dmState.boardMode === m) : posSel.has(m);
    return '<button class="btn' + (active ? ' primary' : ' ghost') + '" data-dm-mode="' + m + '">' + (m === "HIT" ? "Hitters" : m === "PIT" ? "Pitchers" : m) + '</button>';
  }).join("") + '</div>';
  // ＋ add-a-column: only in a position view; options exclude already-shown
  // positions. Capacity is re-checked on selection (board width can change).
  if (multi) {
    html += '<select id="dm-addcol" title="Show another position alongside — cards flow and wrap to fit" style="width:auto;">';
    html += '<option value="">＋ position</option>';
    for (const m of _DM_POS_MODES.filter(x => !posSel.has(x))) html += '<option value="' + m + '">' + esc(m) + '</option>';
    html += '</select>';
  }
  html += '<input id="dm-search" placeholder="Search…" value="' + esc(_dmState.search) + '" style="width:180px;">';
  // Value / Stats column toggle (item 12).
  html += '<div class="seg dm-seg dm-statview">' +
    '<button class="btn' + (_dmState.statView === "value" ? ' primary' : ' ghost') + '" data-dm-statview="value">Value</button>' +
    '<button class="btn' + (_dmState.statView === "stats" ? ' primary' : ' ghost') + '" data-dm-statview="stats">Stats</button></div>';
  html += '<label class="small muted" style="white-space:nowrap;"><input type="checkbox" id="dm-needs"' + (_dmState.needsOnly ? " checked" : "") + '> my needs</label>';
  html += '</div>';

  if (multi) {
    // One card PER selected position. FREE-FLOW: cards size to their own content
    // and wrap (see .dm-poscols) — no forced equal-width columns, no capacity
    // gate. Add as many positions as you like; they flow and wrap.
    const base = _dmBasePool();
    // Preserve the segmented-control order for readable, stable cards.
    const cols = _DM_POS_MODES.filter(m => posSel.has(m));
    html += '<div class="dm-poscols">';
    for (const m of cols) {
      const rows = base.filter(p => _dmModeMatch(p, m)).slice(0, 40);
      html += '<div class="dm-poscol"><h3 style="margin:6px 0; display:flex; align-items:center; gap:6px;">' + esc(m) +
        (cols.length > 1 ? '<button class="btn ghost" data-dm-colremove="' + esc(m) + '" title="Remove this column" style="width:auto; padding:0 6px; font-size:11px; line-height:1.4;">✕</button>' : '') +
        '</h3>' + _dmTable(rows, inflation, _dmKindForMode(m)) + '</div>';
    }
    html += '</div>';
  } else if (_dmState.boardMode === "BPA") {
    const pool = _dmPoolRows(inflation);
    const hit = pool.filter(p => _DM_HIT_POS.includes(p.posKey)).slice(0, 18);
    const pit = pool.filter(p => p.posKey === "SP" || p.posKey === "RP").slice(0, 18);
    html += '<div class="dm-bpa">';
    html += '<div><h3 style="margin:6px 0;">Best Hitters</h3>' + _dmTable(hit, inflation, "H") + '</div>';
    html += '<div><h3 style="margin:6px 0;">Best Pitchers</h3>' + _dmTable(pit, inflation, "P") + '</div>';
    html += '</div>';
  } else {
    html += _dmTable(_dmPoolRows(inflation).slice(0, 60), inflation, _dmKindForMode(_dmState.boardMode));
  }
  return html;
}

// Stats-view columns: per-row we show the right set (hitter vs pitcher). The
// header defaults to the table's kind (hitting or pitching stat names); the
// combined slash form is only a fallback for a genuinely mixed table.
const _DM_HIT_STATS = [["R", "R"], ["HR", "HR"], ["RBI", "RBI"], ["SB", "SB"], ["OBP", "OBP"]];
const _DM_PIT_STATS = [["QS", "QS"], ["K", "K"], ["SV+H", "SV_HLD"], ["ERA", "ERA"], ["WHIP", "WHIP"]];

// The projected-stat <td> cells for one player (5 numeric cells). Missing
// projection → dim dashes. Counting stats round to whole numbers (Jeff: no
// 62.1184); rates keep their meaningful precision (OBP 3dp; ERA/WHIP 2dp).
function _dmStatCells(name) {
  const proj = (typeof getProjection === "function") ? getProjection(name) : null;
  const cell = (v, dec) => {
    if (v == null || v === "" || (typeof v === "number" && !isFinite(v))) return '<td class="num dim">—</td>';
    return '<td class="num">' + Number(v).toFixed(dec || 0) + '</td>';
  };
  if (!proj) return '<td class="num dim">—</td>'.repeat(5);
  if (proj.type === "H") {
    return cell(proj.R) + cell(proj.HR) + cell(proj.RBI) + cell(proj.SB) + cell(proj.OBP, 3);
  }
  return cell(proj.QS) + cell(proj.K) + cell(proj.SV_HLD) + cell(proj.ERA, 2) + cell(proj.WHIP, 2);
}

// Stats-view header for a table kind: "H" → hitting stat names, "P" → pitching,
// anything else → the combined slash form (mixed table).
function _dmStatHead(kind) {
  const cols = kind === "H" ? _DM_HIT_STATS.map(s => s[0])
    : kind === "P" ? _DM_PIT_STATS.map(s => s[0])
    : ["R/QS", "HR/K", "RBI/SV+H", "SB/ERA", "OBP/WHIP"];
  return cols.map(c => '<th class="num">' + c + '</th>').join("");
}

// The table kind for a board mode code: pitcher modes → "P", BPA (mixed) → null,
// everything else (HIT, the position codes, MI/CI/UTIL flex) → "H".
function _dmKindForMode(m) {
  if (m === "PIT" || m === "SP" || m === "RP") return "P";
  if (m === "BPA") return null;
  return "H";
}

function _dmTable(players, inflation, kind) {
  if (!players.length) return '<p class="muted small">nobody left here.</p>';
  const stats = _dmState.statView === "stats";
  // No explicit kind → infer from the rows so a homogeneous table still gets
  // real stat names instead of the slash fallback.
  if (stats && kind === undefined) {
    const isP = p => p.posKey === "SP" || p.posKey === "RP";
    kind = players.every(isP) ? "P" : players.every(p => !isP(p)) ? "H" : null;
  }
  const statHead = stats
    ? _dmStatHead(kind)
    : '<th class="num">$</th><th class="num">Infl</th><th class="num">NFBC</th><th class="num">Δmkt</th>';
  let html = '<table class="dm-table"><thead><tr><th>Player</th><th>Fit</th><th>Pos</th>' + statHead + '<th></th></tr></thead><tbody>';
  for (const p of players) {
    const inf = inflatedValue(p, inflation);
    const nfbc = getNfbc(p.name);
    const delta = nfbc?.avg != null ? nfbc.avg - inf : null;
    const fit = (typeof rosterFit === "function") ? rosterFit(p.name) : null;
    html += '<tr' + (fit && fit.strong ? ' style="background:rgba(63,185,80,.08);"' : '') + '>';
    const tier = (typeof tierForValue === "function") ? tierForValue(p.value) : null;
    const tierColor = (tier && typeof TIER_COLORS !== "undefined" && TIER_COLORS[tier]) ? TIER_COLORS[tier] : "transparent";
    html += '<td><span title="' + (tier || '') + '" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + tierColor + ';margin-right:5px;"></span>' +
      '<span class="player-name" data-player="' + esc(p.name) + '" style="cursor:pointer;">' + esc(p.name) + '</span>' +
      (typeof renderTagIcons === "function" ? renderTagIcons(p.name) : '') + '</td>';
    html += '<td class="small">' + (fit ? '<span title="' + esc(fit.label) + '" style="color:' + (fit.strong ? 'var(--good)' : 'var(--accent)') + ';">' + (fit.strong ? '★ ' : '• ') + esc(fit.label) + '</span>' : '<span class="dim">—</span>') + '</td>';
    html += '<td>' + esc(p.posKey) + '</td>';
    if (stats) {
      html += _dmStatCells(p.name);
    } else {
      html += '<td class="num">$' + p.value.toFixed(0) + '</td>';
      html += '<td class="num"><b>$' + inf.toFixed(0) + '</b></td>';
      html += '<td class="num' + (nfbc?.avg ? '' : ' dim') + '">' + (nfbc?.avg ? '$' + nfbc.avg.toFixed(0) : '—') + '</td>';
      html += '<td class="num' + (delta == null ? ' dim' : delta > 3 ? '" style="color:var(--warn);' : delta < -3 ? '" style="color:var(--good);' : '') + '">' + (delta == null ? '—' : (delta > 0 ? '+' : '') + delta.toFixed(0)) + '</td>';
    }
    // With a live feed, nominations happen on ESPN — a manual ▶ here looks
    // dead (Jeff: "arrows don't do anything"). Make the action useful: 🎯
    // toggles the player as a target (feeds fit/reco/nomination goals).
    if (getFeedMode() !== "off" || (typeof mockFeedActive === "function" && mockFeedActive())) {
      const isTgt = (typeof getPlayerNote === "function") && (getPlayerNote(p.name)?.tags || []).includes("target");
      html += '<td><button class="btn ghost dm-target" data-name="' + esc(p.name) + '" title="' + (isTgt ? "Un-flag target" : "Flag as target") + '" style="padding:1px 7px; font-size:10px;' + (isTgt ? 'color:var(--good);' : '') + '">🎯</button></td>';
    } else {
      html += '<td><button class="btn ghost pool-nominate" data-name="' + esc(p.name) + '" title="Manual: start auction" style="padding:1px 7px; font-size:10px;">▶</button></td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

// --- panels (free-flow layout) ---
// EVERYTHING in the main area is a panel: the on-the-clock hero cluster, the
// player board, the side cards, the category dashboard, the AI assistant and the
// My Plan bar. Panels live in ONE free-flow container: they flow left-to-right
// and wrap, each independently width/height-resizable (CSS resize:both) and
// drag-reorderable to anywhere in the flow — no fixed columns. Layout is
// DEVICE-LOCAL (monitor-specific) — the same rationale as DM_KEY, so it is
// deliberately NOT in the cloud-sync whitelist. Stored under ud_dm_layout_v1:
//   { flow: [id...], sizes: { id: {w,h} }, statView, standingsExpanded, ... }
// MIGRATION (nothing ever disappears): the legacy four-zone shape (zones/split/
// heights) still parses — _dmPanelOrder concatenates top→left→right→bottom into
// the flow order, and _dmSizesFromHeights folds old per-panel heights into sizes.
// The zone helpers below are kept only to read those legacy layouts.
const _DM_CARD_ORDER_KEY = "ud_dm_layout_v1";
const _DM_ZONE_IDS = ["top", "left", "right", "bottom"];
// The canonical set of panels. The array order IS the default flow order.
const _DM_PANEL_IDS = ["hero", "board", "roster", "budgets", "standings", "noms", "history", "cats", "ai", "plan"];
// Panels that default to a full-width row; everything else defaults to a fixed
// side-panel width and wraps. (Inline width from a user resize always overrides.)
const _DM_WIDE_PANELS = ["hero", "board", "plan"];
const _DM_DEFAULT_W = { roster: 380, budgets: 340, standings: 480, noms: 380, history: 440, cats: 480, ai: 440 };
const _DM_DEFAULT_H = { board: 560, roster: 520, budgets: 300, standings: 360, noms: 320, history: 360, cats: 360, ai: 380 };
const _DM_DEFAULT_ZONES = {
  top: ["hero"],
  left: ["board"],
  right: ["roster", "budgets", "standings", "noms", "history", "cats", "ai"],
  bottom: ["plan"],
};
// The default zone for a given panel id (used when appending a missing panel).
function _dmDefaultZoneFor(id) {
  for (const z of _DM_ZONE_IDS) if (_DM_DEFAULT_ZONES[z].includes(id)) return z;
  return "right";
}
// Merge a (possibly partial / stale) zones object with the defaults: keep the
// user's placement + order for every id they have, then append any known panel
// id they're missing to its default zone so a panel never vanishes.
function _dmNormalizeZones(zones) {
  const out = { top: [], left: [], right: [], bottom: [] };
  const seen = new Set();
  for (const z of _DM_ZONE_IDS) {
    const arr = Array.isArray(zones && zones[z]) ? zones[z] : [];
    for (const id of arr) {
      if (_DM_PANEL_IDS.includes(id) && !seen.has(id)) { out[z].push(id); seen.add(id); }
    }
  }
  for (const id of _DM_PANEL_IDS) {
    if (seen.has(id)) continue;
    out[_dmDefaultZoneFor(id)].push(id);
    seen.add(id);
  }
  return out;
}
// Build four zones from a legacy right-rail order array. hero/board/plan keep
// their default zones; the old rail order seeds the right zone; any newer panel
// id falls into its default zone via normalization.
function _dmZonesFromOrder(order) {
  const right = Array.isArray(order) ? order.filter(id => _DM_PANEL_IDS.includes(id) && !["hero", "board", "plan"].includes(id)) : [];
  return _dmNormalizeZones({ top: ["hero"], left: ["board"], right, bottom: ["plan"] });
}
// Fold an interim two-column { left, right } object into the four-zone shape.
function _dmZonesFromCols(cols) {
  return _dmNormalizeZones({
    top: ["hero"],
    left: Array.isArray(cols.left) ? cols.left : ["board"],
    right: Array.isArray(cols.right) ? cols.right : [],
    bottom: ["plan"],
  });
}
// Legacy heights map { id: px } → new sizes map { id: {h: px} } (widths were not
// stored in the old zone model, so only height carries over).
function _dmSizesFromHeights(heights) {
  const out = {};
  if (heights && typeof heights === "object") for (const k in heights) if (typeof heights[k] === "number") out[k] = { h: heights[k] };
  return out;
}
function _dmLayout() {
  try {
    const v = JSON.parse(localStorage.getItem(_DM_CARD_ORDER_KEY) || "null");
    if (Array.isArray(v)) {   // legacy bare array = right-rail order → seed flow
      return { flow: v, sizes: {}, order: v, zones: _dmZonesFromOrder(v), split: null, heights: {}, statView: null, standingsExpanded: null };
    }
    if (v && typeof v === "object") {
      const order = Array.isArray(v.order) ? v.order : null;
      let zones;
      if (v.zones && typeof v.zones === "object" && _DM_ZONE_IDS.some(z => Array.isArray(v.zones[z]))) {
        zones = _dmNormalizeZones(v.zones);                 // already migrated
      } else if (v.cols && typeof v.cols === "object" && (Array.isArray(v.cols.left) || Array.isArray(v.cols.right))) {
        zones = _dmZonesFromCols(v.cols);                   // interim two-column build
      } else {
        zones = _dmZonesFromOrder(order);                   // old order array (or defaults if none)
      }
      return {
        flow: Array.isArray(v.flow) ? v.flow : null,        // stacking order (last = on top)
        sizes: (v.sizes && typeof v.sizes === "object") ? v.sizes : _dmSizesFromHeights(v.heights),
        pos: (v.pos && typeof v.pos === "object") ? v.pos : {},   // freeform {id:{x,y}}
        order,
        zones,
        split: (typeof v.split === "number" ? v.split : null),
        heights: (v.heights && typeof v.heights === "object") ? v.heights : {},
        statView: (v.statView === "value" || v.statView === "stats") ? v.statView : null,
        standingsExpanded: (typeof v.standingsExpanded === "boolean") ? v.standingsExpanded : null,
      };
    }
  } catch (e) {}
  return { flow: null, sizes: {}, pos: {}, order: null, zones: _dmNormalizeZones(null), split: null, heights: {}, statView: null, standingsExpanded: null };
}
function _dmSaveLayout(patch) {
  const cur = _dmLayout();
  const next = { flow: cur.flow, sizes: cur.sizes, pos: cur.pos, order: cur.order, zones: cur.zones, split: cur.split, heights: cur.heights, statView: cur.statView, standingsExpanded: cur.standingsExpanded };
  if (patch && "flow" in patch) next.flow = patch.flow;
  if (patch && "sizes" in patch) next.sizes = patch.sizes;
  if (patch && "pos" in patch) next.pos = patch.pos;
  if (patch && "order" in patch) next.order = patch.order;
  if (patch && "zones" in patch) next.zones = _dmNormalizeZones(patch.zones);
  if (patch && "split" in patch) next.split = patch.split;
  if (patch && "heights" in patch) next.heights = patch.heights;
  if (patch && "statView" in patch) next.statView = patch.statView;
  if (patch && "standingsExpanded" in patch) next.standingsExpanded = patch.standingsExpanded;
  try { localStorage.setItem(_DM_CARD_ORDER_KEY, JSON.stringify(next)); } catch (e) {}
}
function _dmZones() { return _dmLayout().zones; }
function _dmSaveZones(zones) { _dmSaveLayout({ zones }); }
// The flat panel STACKING order (render order = z-order, last on top). Migrates
// from the old four-zone layout by concatenating top→left→right→bottom. Always
// normalized to the full panel set: missing ids appended in canonical order,
// unknown ids dropped, dupes removed.
function _dmPanelOrder() {
  const lay = _dmLayout();
  let order = Array.isArray(lay.flow) ? lay.flow.slice() : null;
  if (!order) {
    const z = lay.zones || {};
    order = [].concat(z.top || [], z.left || [], z.right || [], z.bottom || []);
  }
  const seen = new Set(); const out = [];
  for (const id of order) if (_DM_PANEL_IDS.includes(id) && !seen.has(id)) { out.push(id); seen.add(id); }
  for (const id of _DM_PANEL_IDS) if (!seen.has(id)) { out.push(id); seen.add(id); }
  return out;
}
// Wipe every layout override → back to the default auto-tiled layout + sizes.
// statView + standingsExpanded are content prefs, kept.
function _dmResetLayout() {
  _dmSaveLayout({ flow: null, sizes: {}, pos: {}, zones: _dmNormalizeZones(null), split: null, heights: {} });
}

// Shelf-pack tiler for cards with no stored position (first visit / new panel):
// left→right rows that wrap at the canvas width, row height = tallest card in
// the row. Pure — takes [{id,w,h}] + width, returns {id:{x,y}} — so it's
// testable headlessly.
function _dmShelfPack(items, W, startY) {
  const gap = 12;
  let x = 0, y = startY || 0, rowH = 0;
  const out = {};
  for (const it of items) {
    const w = Math.min(it.w || 300, W);
    if (x > 0 && x + w > W) { x = 0; y += rowH + gap; rowH = 0; }
    out[it.id] = { x: Math.round(x), y: Math.round(y) };
    x += w + gap;
    rowH = Math.max(rowH, it.h || 200);
  }
  return out;
}

// Position every canvas card. Cards WITH a stored pos go exactly there; cards
// without one (first visit, a newly shipped panel) are shelf-packed below the
// lowest pinned card and their computed spots are PERSISTED immediately — from
// then on every card is pinned, so dragging one never shuffles the others.
// Also stacks z-order by flow order and sizes the canvas to contain everything
// (absolute children don't grow their parent).
function _dmCanvasLayout() {
  const canvas = document.querySelector("[data-dm-flow]");
  if (!canvas) return;
  const W = canvas.clientWidth || 1200;
  const pos = Object.assign({}, _dmLayout().pos);
  const cards = [...canvas.querySelectorAll(":scope > .card[data-dm-card]")];
  const missing = cards.filter(c => !pos[c.dataset.dmCard]);
  if (missing.length) {
    let startY = 0;
    for (const c of cards) {
      const p = pos[c.dataset.dmCard];
      if (p) startY = Math.max(startY, p.y + c.offsetHeight + 12);
    }
    const packed = _dmShelfPack(missing.map(c => ({ id: c.dataset.dmCard, w: c.offsetWidth || 300, h: c.offsetHeight || 200 })), W, startY);
    Object.assign(pos, packed);
    _dmSaveLayout({ pos });
  }
  cards.forEach((c, i) => {
    const p = pos[c.dataset.dmCard];
    if (p) { c.style.left = p.x + "px"; c.style.top = p.y + "px"; }
    c.style.zIndex = String(10 + i);
  });
  // Compare card pops up offset from My Roster, always on top.
  const cmp = canvas.querySelector(".dm-cmpcard");
  if (cmp) {
    const rp = pos.roster;
    cmp.style.left = ((rp ? rp.x : 0) + 28) + "px";
    cmp.style.top = ((rp ? rp.y : 0) + 28) + "px";
    cmp.style.zIndex = "500";
  }
  _dmCanvasHeight(canvas);
}
function _dmCanvasHeight(canvas) {
  let max = 0;
  canvas.querySelectorAll(":scope > .card").forEach(c => { max = Math.max(max, c.offsetTop + c.offsetHeight); });
  canvas.style.height = (max + 16) + "px";
}

// --- roster slots (fixed template) ---------------------------------------
// Jeff's canonical roster: ALWAYS render all of these, in this exact order, with
// "--" for an empty slot. 26 slots total.
const _DM_ROSTER_SLOTS = [
  "C", "1B", "2B", "SS", "3B", "CI", "MI", "OF", "OF", "OF", "OF", "OF", "Util",
  "P", "P", "P", "P", "P", "P", "P", "P", "P", "BN", "BN", "BN", "BN",
];

// Can a player (its value record, carrying .elig / .type / .posKey) legally fill
// a given slot type? BN accepts anyone; Util any hitter; P any pitcher.
function _dmSlotAccepts(slotType, val) {
  if (slotType === "BN") return true;
  const isP = val && (val.type === "P" || val.posKey === "SP" || val.posKey === "RP");
  if (slotType === "P") return !!isP;
  if (slotType === "Util") return !!val && !isP;          // any hitter
  if (!val) return false;
  const elig = val.elig || [];
  if (slotType === "CI") return elig.includes("CI") || elig.includes("1B") || elig.includes("3B");
  if (slotType === "MI") return elig.includes("MI") || elig.includes("2B") || elig.includes("SS");
  return elig.includes(slotType);                          // C/1B/2B/SS/3B/OF
}

// Manual slot pins (drag overrides), device-local per team:
//   { [teamKey]: { [playerName]: slotIndex } }
const _DM_ROSTER_SLOTS_KEY = "ud_dm_roster_slots_v1";
let _dmRosterOverridesCache = null;
function _dmRosterOverrides() {
  if (_dmRosterOverridesCache) return _dmRosterOverridesCache;
  try { _dmRosterOverridesCache = JSON.parse(localStorage.getItem(_DM_ROSTER_SLOTS_KEY) || "{}") || {}; }
  catch (e) { _dmRosterOverridesCache = {}; }
  return _dmRosterOverridesCache;
}
function _dmSaveRosterOverrides() {
  try { localStorage.setItem(_DM_ROSTER_SLOTS_KEY, JSON.stringify(_dmRosterOverrides())); } catch (e) {}
}
function _dmSetRosterPin(teamKey, playerName, slotIndex) {
  const all = _dmRosterOverrides();
  const t = (all[teamKey] = all[teamKey] || {});
  for (const n of Object.keys(t)) if (t[n] === slotIndex) delete t[n];   // one player per slot
  t[playerName] = slotIndex;
  _dmSaveRosterOverrides();
}
function _dmClearRosterPin(teamKey, playerName) {
  const all = _dmRosterOverrides();
  if (all[teamKey] && all[teamKey][playerName] != null) { delete all[teamKey][playerName]; _dmSaveRosterOverrides(); }
}

// A roster entry: { name, how, val, value }. `how` is the display badge.
function _dmRosterEntry(name, how) {
  const val = (typeof getPlayerValue === "function") ? getPlayerValue(name) : null;
  return { name, how, val, value: (val && val.value) || 0 };
}

// Assign entries to the fixed slot template. Manual pins win; the rest autofill
// best-effort (most-constrained player first, then value), starters before
// bench. Returns { slots:[{type,i,player}], overflow:[entry] }.
function _dmAssignRoster(entries, overrides) {
  const slots = _DM_ROSTER_SLOTS.map((type, i) => ({ type, i, player: null }));
  const byName = new Map(entries.map(e => [e.name, e]));
  const placed = new Set();
  // 1) manual pins — highest value first so a collision resolves deterministically
  const pins = Object.entries(overrides || {})
    .filter(([n, idx]) => byName.has(n) && slots[idx])
    .sort((a, b) => (byName.get(b[0]).value || 0) - (byName.get(a[0]).value || 0));
  for (const [n, idx] of pins) {
    if (!slots[idx].player) { slots[idx].player = byName.get(n); placed.add(n); }
  }
  // 2) autofill the rest
  const startTypes = ["C", "1B", "2B", "SS", "3B", "CI", "MI", "OF", "Util", "P"];
  const eligCount = e => startTypes.reduce((n, t) => n + (_dmSlotAccepts(t, e.val) ? 1 : 0), 0);
  const rest = entries.filter(e => !placed.has(e.name))
    .sort((a, b) => eligCount(a) - eligCount(b) || (b.value || 0) - (a.value || 0));
  for (const e of rest) {
    const primary = e.val && e.val.posKey;   // prefer the player's own position slot
    let s = primary ? slots.find(x => !x.player && x.type === primary && _dmSlotAccepts(x.type, e.val)) : null;
    if (!s) s = slots.find(x => !x.player && x.type !== "BN" && _dmSlotAccepts(x.type, e.val));
    if (!s) s = slots.find(x => !x.player && x.type === "BN");
    if (s) { s.player = e; placed.add(e.name); }
  }
  return { slots, overflow: entries.filter(e => !placed.has(e.name)) };
}

// Render the fixed-slot roster table. teamKey scopes the drag pins.
function _dmRosterSlotsHtml(entries, teamKey) {
  const overrides = _dmRosterOverrides()[teamKey] || {};
  const { slots, overflow } = _dmAssignRoster(entries, overrides);
  const tk = esc(String(teamKey));
  let html = '<table class="dm-table dm-roster-slots"><tbody>';
  for (const s of slots) {
    const p = s.player;
    html += '<tr class="dm-slotrow" data-dm-slot="' + s.i + '" data-dm-team="' + tk + '">';
    html += '<td class="dm-slotlabel">' + esc(s.type) + '</td>';
    if (p) {
      html += '<td><span class="dm-slotplayer" draggable="true" data-dm-player="' + esc(p.name) + '" data-dm-team="' + tk +
        '" title="Drag to another slot · double-click to auto-fill">' + esc(p.name) + '</span></td>';
      html += '<td class="num muted">' + esc(p.how) + '</td>';
    } else {
      html += '<td class="dm-slotempty">--</td><td></td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  if (overflow.length) {
    html += '<p class="small" style="margin:4px 0 0; color:var(--warn);">Over roster limit: ' +
      overflow.map(e => esc(e.name)).join(", ") + '</p>';
  }
  return html;
}

function _dmMyRosterHtml() {
  const me = (typeof getMyDraftTeam === "function") ? getMyDraftTeam() : null;
  if (!me) return '<p class="muted small">Pick your team on Draft Setup (Test mode) to see your roster.</p>';
  const st = computeLiveTeamStates()[me.id];
  const entries = [];
  if (typeof getEffectiveKeeperSelections === "function" && !draftTestMode()) {
    for (const [n, f] of Object.entries(getEffectiveKeeperSelections()[me.id] || {})) if (f.keeper) entries.push(_dmRosterEntry(n, "keeper"));
  }
  for (const p of _liveDraft.picks.filter(p => p.team === me.id || (me.espnTeamId != null && p.espnTeamId === me.espnTeamId))) {
    entries.push(_dmRosterEntry(p.player, "$" + p.price));
  }
  let html = '<p class="small" style="margin:0 0 4px;">' + entries.length + ' rostered · <b>$' + (st ? st.budget : "?") + '</b> left · ' + (st ? st.slotsRemaining : "?") + ' slots · max bid <b style="color:var(--accent);">$' + (st ? st.maxBid : "?") + '</b></p>';
  html += _dmRosterSlotsHtml(entries, me.id);
  return html;
}

// Another team's roster, shown next to "My Roster" for comparison (item 16).
// Same data approach as _dmMyRosterHtml but for an arbitrary teamId.
function _dmCompareRosterHtml(teamId) {
  const st = computeLiveTeamStates()[teamId];
  const entries = [];
  if (typeof getEffectiveKeeperSelections === "function" && !draftTestMode()) {
    for (const [n, f] of Object.entries(getEffectiveKeeperSelections()[teamId] || {})) if (f.keeper) entries.push(_dmRosterEntry(n, "keeper"));
  }
  for (const p of _liveDraft.picks.filter(p => p.team === teamId)) entries.push(_dmRosterEntry(p.player, "$" + p.price));
  let html = '<p class="small" style="margin:0 0 4px;">' + entries.length + ' rostered · <b>$' + (st ? st.budget : "?") + '</b> left · ' + (st ? st.slotsRemaining : "?") + ' slots · max bid <b style="color:var(--accent);">$' + (st ? st.maxBid : "?") + '</b></p>';
  html += _dmRosterSlotsHtml(entries, teamId);
  return html;
}

function _dmBudgetsHtml() {
  const states = Object.values(computeLiveTeamStates());
  states.sort((a, b) => b.budget - a.budget);
  let html = '<table class="dm-table"><thead><tr><th>Team</th><th class="num">$</th><th class="num">Slots</th><th class="num">Max</th></tr></thead><tbody>';
  for (const st of states) {
    // Clicking an opponent's row opens their roster next to mine (item 16).
    html += '<tr' + (st.isMe ? ' style="background:rgba(79,142,247,.10);"'
      : ' class="dm-teamrow" data-dm-teamview="' + esc(String(st.teamId)) + '" style="cursor:pointer;" title="Compare ' + esc(st.ownerName) + '\'s roster"') +
      '><td>' + esc(st.ownerName) + '</td><td class="num">$' + st.budget + '</td><td class="num">' + st.slotsRemaining + '</td><td class="num">$' + st.maxBid + '</td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

// My Plan panel body (item 15) — the strategyForAi brief or the "no strategy"
// hint. The panel card + "My Plan" title are supplied by the panel wrapper.
function _dmPlanBar() {
  const brief = (typeof strategyForAi === "function") ? strategyForAi() : null;
  return brief
    ? '<div class="small" style="white-space:pre-wrap;">' + esc(brief) + '</div>'
    : '<p class="muted small" style="margin:0;">No strategy written — Settings ▸ Draft Strategy.</p>';
}

// Full pick-by-pick draft history (newest first), for the "history" side card.
function _dmHistoryHtml() {
  const picks = (typeof _liveDraft !== "undefined" && _liveDraft.picks) ? _liveDraft.picks : [];
  if (!picks.length) return '<p class="muted small" style="margin:0;">No picks yet — the running board appears here newest-first.</p>';
  let html = '<table class="dm-table"><thead><tr><th class="num">#</th><th>Player</th><th>Pos</th><th class="num">$</th><th>Won by</th></tr></thead><tbody>';
  for (let i = picks.length - 1; i >= 0; i--) {
    const pk = picks[i];
    const pos = pk.pos || (getPlayerValue(pk.player)?.posKey) || "?";
    const who = _dmTeamLabel(pk.espnTeamId != null ? pk.espnTeamId : pk.team);
    html += '<tr><td class="num dim">' + (i + 1) + '</td><td>' + esc(pk.player) + '</td><td>' + esc(pos) +
      '</td><td class="num">$' + pk.price + '</td><td class="small">' + esc(who) + '</td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

// (The old left/right column split handle is gone — panels are a single
// free-flow layout now; each panel resizes its own width + height.)

// Per-panel resizable WIDTH + HEIGHT: each panel card is CSS `resize: both`.
// We persist a size ONLY when it changed during an actual pointer gesture on
// the card (mousedown → mouseup with a size delta) — a ResizeObserver alone
// can't tell a user drag from a window/layout reflow, which would wrongly
// freeze a full-width panel's width. Gesture detection avoids that.
function _dmWireCardResize() {
  const canvas = document.querySelector("[data-dm-flow]");
  if (!canvas) return;
  // Record the card's size when a press starts on it (could be a resize grab).
  canvas.addEventListener("mousedown", (e) => {
    const card = e.target.closest(".dm-canvas > .card[data-dm-card]");
    if (!card) return;
    card._dmStartW = card.offsetWidth; card._dmStartH = card.offsetHeight; card._dmMaybeResize = true;
  });
  // On release, if a tracked card actually changed size, persist it. One-time
  // document listener (wireDraftMode re-runs each render — don't stack).
  if (!window._dmCardResizeWired) {
    window._dmCardResizeWired = true;
    document.addEventListener("mouseup", () => {
      let changed = false;
      document.querySelectorAll(".dm-canvas > .card[data-dm-card]").forEach(card => {
        if (!card._dmMaybeResize) return;
        card._dmMaybeResize = false;
        const w = Math.round(card.offsetWidth), h = Math.round(card.offsetHeight);
        if (!card.isConnected || !(w >= 240 && h >= 120)) return;
        if (Math.abs(w - (card._dmStartW || 0)) <= 4 && Math.abs(h - (card._dmStartH || 0)) <= 4) return;   // no real resize
        const sizes = Object.assign({}, _dmLayout().sizes || {});
        sizes[card.dataset.dmCard] = { w, h };
        _dmSaveLayout({ sizes });
        changed = true;
      });
      // A grown card may now poke past the canvas bottom — refit the canvas.
      const cv = document.querySelector("[data-dm-flow]");
      if (changed && cv) _dmCanvasHeight(cv);
    });
  }
}

// Freeform pointer drag: press a panel's title bar and move it to ANY x/y on the
// canvas. Plain mousemove positioning (no HTML5 DnD — no ghost image, no drop
// targets, pixel-exact). The pressed card jumps to the top of the stack; on
// release its position persists and the canvas refits. The body of the card
// stays fully interactive (buttons, inputs, the roster player-drag) because the
// handle is the only place a move can start.
function _dmWireCardDrag() {
  const canvas = document.querySelector("[data-dm-flow]");
  if (!canvas) return;
  canvas.querySelectorAll(":scope > .card[data-dm-card]").forEach(card => {
    const handle = card.querySelector(".dm-panel-title");
    if (!handle) return;
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;                          // left button only
      if (e.target.closest("button, input, select, a")) return;   // controls in the title stay clickable
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, left: card.offsetLeft, top: card.offsetTop };
      let moved = false;
      card.classList.add("dm-dragging");
      card.style.zIndex = "900";                            // ride above everything while moving
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      const move = (ev) => {
        const W = canvas.clientWidth;
        const nx = Math.max(0, Math.min(start.left + (ev.clientX - start.x), Math.max(0, W - 120)));
        const ny = Math.max(0, start.top + (ev.clientY - start.y));
        if (!moved && (Math.abs(ev.clientX - start.x) > 3 || Math.abs(ev.clientY - start.y) > 3)) moved = true;
        card.style.left = nx + "px";
        card.style.top = ny + "px";
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        card.classList.remove("dm-dragging");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (!moved) { card.style.zIndex = ""; return; }     // a plain click, not a drag
        const id = card.dataset.dmCard;
        const pos = Object.assign({}, _dmLayout().pos);
        pos[id] = { x: card.offsetLeft, y: card.offsetTop };
        // Moving a card also raises it: it goes to the end of the stacking order.
        const flow = _dmPanelOrder().filter(x => x !== id); flow.push(id);
        _dmSaveLayout({ pos, flow });
        _dmCanvasHeight(canvas);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  });
}

// Compact category-total label for the expanded standings (item 17): OBP 3dp,
// ERA/WHIP 2dp, everything else rounded whole.
const _DM_STANDINGS_CATS = ["R", "HR", "RBI", "SB", "OBP", "QS", "K", "SV_HLD", "ERA", "WHIP"];
const _DM_CAT_HEAD = { R: "R", HR: "HR", RBI: "RBI", SB: "SB", OBP: "OBP", QS: "QS", K: "K", SV_HLD: "SV+H", ERA: "ERA", WHIP: "WHIP" };
function _dmCatTotal(totals, c) {
  const v = totals ? totals[c] : null;
  if (v == null || (typeof v === "number" && !isFinite(v))) return "—";
  if (c === "OBP") return Number(v).toFixed(3);
  if (c === "ERA" || c === "WHIP") return Number(v).toFixed(2);
  return Math.round(v);
}

function _dmStandingsHtml() {
  let res = null;
  try { res = computeLiveProjStandings(); } catch (e) { console.warn("proj standings failed:", e); }
  if (!res || !res.teams || !res.anyData) return '<p class="muted small">Needs stat projections (Data tab) — showing nothing rather than junk.</p>';

  const expanded = !!_dmState.standingsExpanded;
  const toggle = '<button class="btn ghost dm-standings-expand" title="' +
    (expanded ? 'Collapse to ranks' : 'Expand — per-category totals, sortable') + '" style="float:right; padding:0 8px; font-size:12px;">' +
    (expanded ? '⤢ Collapse' : '⤢ Expand') + '</button>';

  if (!expanded) {
    // Collapsed: rank / owner / roto. Rows clickable to compare rosters (item 16).
    let html = toggle;
    html += '<table class="dm-table"><thead><tr><th class="num">#</th><th>Team</th><th class="num">Roto</th></tr></thead><tbody>';
    res.teams.forEach((t, i) => {
      const clickable = !t.isMe && t.teamId != null;
      html += '<tr' + (t.isMe ? ' style="background:rgba(79,142,247,.10);"'
        : (clickable ? ' class="dm-teamrow" data-dm-teamview="' + esc(String(t.teamId)) + '" style="cursor:pointer;" title="Compare ' + esc(t.owner) + '\'s roster"' : '')) +
        '><td class="num">' + (i + 1) + '</td><td>' + esc(t.owner) + '</td><td class="num">' + t.rotoPoints.toFixed(1) + '</td></tr>';
    });
    html += '</tbody></table>';
    const me = res.teams.find(t => t.isMe);
    if (me) {
      const cats = Object.entries(me.catPoints || {}).sort((a, b) => a[1] - b[1]);
      if (cats.length) {
        html += '<div class="small muted" style="margin-top:4px;">Weakest: ' + cats.slice(0, 3).map(c => c[0]).join(", ") +
          ' · Strongest: ' + cats.slice(-2).map(c => c[0]).join(", ") + '</div>';
      }
    }
    return html;
  }

  // Expanded: one row per team, one column per category (total + roto points),
  // sortable by any category. Default sort = total roto (descending).
  const sort = _dmState.standingsSort;
  const teams = res.teams.slice();
  if (sort && sort.cat && sort.cat !== "roto") {
    const c = sort.cat;
    const lower = (c === "ERA" || c === "WHIP");
    const raw = (t) => {
      const v = t.totals ? t.totals[c] : null;
      if (v == null || (typeof v === "number" && !isFinite(v))) return lower ? Infinity : -Infinity;
      return v;
    };
    teams.sort((a, b) => {
      const d = raw(a) - raw(b);
      // "desc" = best first: for lower-is-better cats best = smallest.
      return sort.dir === "asc" ? (lower ? -d : d) : (lower ? d : -d);
    });
  } else if (sort && sort.cat === "roto" && sort.dir === "asc") {
    teams.sort((a, b) => a.rotoPoints - b.rotoPoints);
  }
  // (default order from computeLiveProjStandings is already roto desc)

  const arrow = (key) => (sort && sort.cat === key) ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  let html = toggle;
  html += '<div style="overflow-x:auto;">';
  html += '<table class="dm-table dm-standings-full"><thead><tr>';
  html += '<th>Team</th>';
  for (const c of _DM_STANDINGS_CATS) {
    html += '<th class="num dm-sortcat" data-dm-sortcat="' + c + '" style="cursor:pointer;" title="Sort by ' + esc(_DM_CAT_HEAD[c]) + '">' + esc(_DM_CAT_HEAD[c]) + arrow(c) + '</th>';
  }
  html += '<th class="num dm-sortcat" data-dm-sortcat="roto" style="cursor:pointer;" title="Sort by total roto">Roto' + arrow("roto") + '</th>';
  html += '</tr></thead><tbody>';
  for (const t of teams) {
    html += '<tr' + (t.isMe ? ' style="background:rgba(79,142,247,.10);"' : '') + '><td>' + esc(t.owner) + '</td>';
    for (const c of _DM_STANDINGS_CATS) {
      const pts = t.catPoints ? t.catPoints[c] : null;
      const ptsLabel = (pts != null) ? '<span class="muted" style="font-size:10px;"> ' + (Math.round(pts * 10) / 10) + '</span>' : '';
      html += '<td class="num">' + _dmCatTotal(t.totals, c) + ptsLabel + '</td>';
    }
    html += '<td class="num"><b>' + t.rotoPoints.toFixed(1) + '</b></td>';
  }
  html += '</tbody></table></div>';
  html += '<div class="small muted" style="margin-top:4px;">Big number = projected category total; small = roto points. Click a column to sort.</div>';
  return html;
}

// --- bottom zone ---
function _dmBottom() {
  let html = '<details class="dm-bottom"><summary class="small muted" style="cursor:pointer;">Pick tracker · teams · feed</summary>';
  html += '<div style="margin-top:8px;">';
  // Endgame panel now renders prominently below the hero (item 10), not here.
  html += '<div class="dm-bottom-grid">';
  html += '<div>' + renderDraftFeedPanel() + '</div>';
  html += '<div class="card" style="padding:8px;"><h3 style="margin:0 0 6px;">Teams</h3>' + renderTeamStrip() + '</div>';
  html += '<div>' + renderRecentPicks() + '</div>';
  html += '</div>';
  html += '</div></details>';
  return html;
}

// --- live in-place updates (no full re-render on every bid) ---
function updateDraftModeLive() {
  if (typeof mockFeedPumping === "function" && mockFeedPumping()) return;   // a fast-forward renders once when it finishes
  if (!_draftModeOn() || typeof currentView === "undefined" || currentView !== "draft") return;
  const lot = (getFeedMode() !== "off" || (typeof mockFeedActive === "function" && mockFeedActive())) ? currentLotFromEvents() : null;
  const otc = document.getElementById("dm-otc");
  if (!otc) return;
  // Player changed (new nomination / sold) → full re-render for fresh panels.
  const shownName = otc.getAttribute("data-player") || "";
  const lotName = lot ? lot.name : (_liveDraft.current ? _liveDraft.current.player : "");
  if (shownName !== lotName) { renderDraft(); return; }
  if (lot) {
    const bidline = document.getElementById("dm-bidline");
    if (bidline) bidline.innerHTML = _dmBidLine(lot);
    const meter = document.getElementById("dm-bidmeter");
    if (meter) meter.innerHTML = _dmBidMeter(lot);
    const ticker = document.getElementById("dm-ticker");
    if (ticker) ticker.innerHTML = _dmTickerHtml(lot);
    const temp = document.getElementById("dm-temp");
    if (temp) { const t = lotTemperature(lot); temp.innerHTML = t ? _dmTempChip(t) : ''; }
    const reco = document.getElementById("dm-reco");
    if (reco) {
      // Preserve half-typed bid/proxy inputs (+focus/caret) across the patch —
      // bots bid every ~0.5s, and the innerHTML rewrite otherwise eats Jeff's
      // keystrokes mid-number, making custom bids untypable (R16).
      const keep = {};
      for (const kid of ["dm-icbid-custom", "dm-icproxy", "dm-mock-bidamt"]) {
        const el = document.getElementById(kid);
        if (el && (el.value !== "" || document.activeElement === el)) {
          keep[kid] = { v: el.value, f: document.activeElement === el, s: el.selectionStart, e: el.selectionEnd };
        }
      }
      reco.innerHTML = _dmRecoHtml(lot.name, lot);
      for (const kid of Object.keys(keep)) {
        const el = document.getElementById(kid);
        if (!el) continue;
        const k = keep[kid];
        if (k.v !== "") el.value = k.v;
        if (k.f) { el.focus(); try { if (k.s != null) el.setSelectionRange(k.s, k.e); } catch (_) {} }
      }
    }
    const interest = document.getElementById("dm-interest");
    if (interest) interest.innerHTML = _dmInterestHtml(lot.name);
    const idleEl = document.getElementById("dm-idle");
    if (idleEl) idleEl.innerHTML = lot.idle ? '<div class="small" style="margin-top:4px; color:var(--warn);">⏸ Lot quiet ' + lot.idleMin + 'm — draft likely paused; resumes automatically.</div>' : '';
  }
  const chips = document.getElementById("dm-feedchips");
  if (chips) chips.innerHTML = _dmFeedChips();
}

function wireDraftMode() {
  document.getElementById("dm-exit")?.addEventListener("click", () => setDraftMode(false));
  // Practice-mock bid controls (item 3). Only meaningful during a running mock.
  // Delegate on #dm-reco (a stable element whose innerHTML updateDraftModeLive
  // swaps in place on every bid) so +$1 / Bid keep working without a full
  // re-render + re-wire. userMockBid clamps the amount and re-resolves the lot.
  if (typeof mockFeedActive === "function" && mockFeedActive()) {
    const reco = document.getElementById("dm-reco");
    if (reco && !reco._mockBidWired) {
      reco._mockBidWired = true;
      reco.addEventListener("click", (e) => {
        const t = e.target && e.target.closest ? e.target.closest("#dm-mock-bid1,#dm-mock-bid") : null;
        if (!t || typeof userMockBid !== "function") return;
        const lot = (typeof currentLotFromEvents === "function") ? currentLotFromEvents() : null;
        const high = (lot && Number.isFinite(lot.highBid)) ? lot.highBid : 0;
        let amt;
        if (t.id === "dm-mock-bid1") amt = high + 1;
        else {
          const box = document.getElementById("dm-mock-bidamt");
          amt = box ? (parseInt(box.value, 10) || (high + 1)) : (high + 1);
        }
        userMockBid(amt);
      });
    }
  }
  document.getElementById("dm-debrief")?.addEventListener("click", () => { if (typeof openDebrief === "function") openDebrief(); });
  document.getElementById("dm-endgame")?.addEventListener("click", () => { if (typeof setEndgameForced === "function") { setEndgameForced(!isEndgameForced()); renderDraft(); } });
  // Reset layout (Jeff WILL paint himself into a corner) — confirm, then clear
  // zones/split/heights back to the default and re-render.
  document.getElementById("dm-reset-layout")?.addEventListener("click", () => {
    if (typeof confirm === "function" && !confirm("Reset all draft-mode panels to their default position and size?")) return;
    _dmResetLayout();
    renderDraft();
  });
  // Kick the AI injury-return estimate for the player on the clock (if hurt).
  const otcName = document.getElementById("dm-otc")?.getAttribute("data-player");
  if (otcName && typeof wirePlayerNewsBlock === "function") wirePlayerNewsBlock(otcName);
  document.querySelectorAll("[data-dm-mode]").forEach(b => b.addEventListener("click", () => {
    const m = b.dataset.dmMode;
    if (_DM_PRESETS.includes(m)) {
      // Exclusive preset — clears any multi-position selection.
      _dmState.boardPos.clear();
      _dmState.boardMode = m;
    } else {
      // Clicking a position SWAPS to it (Jeff: "should swap, not add").
      // Extra side-by-side columns are added via the ＋ selector instead.
      _dmState.boardPos = new Set([m]);
      _dmState.boardMode = "";
    }
    renderDraft();
  }));
  // ＋ add-a-position selector (multi-position view). Free-flow: cards wrap to
  // fit, so there's no capacity gate — add as many as you want.
  document.getElementById("dm-addcol")?.addEventListener("change", (e) => {
    const m = e.target.value;
    if (!m) return;
    _dmState.boardPos.add(m);
    renderDraft();
  });
  document.querySelectorAll("[data-dm-colremove]").forEach(x => x.addEventListener("click", () => {
    _dmState.boardPos.delete(x.dataset.dmColremove);
    if (!_dmState.boardPos.size) _dmState.boardMode = "BPA";
    renderDraft();
  }));
  document.querySelectorAll("[data-dm-statview]").forEach(b => b.addEventListener("click", () => {
    _dmState.statView = b.dataset.dmStatview;
    _dmSaveLayout({ statView: _dmState.statView });   // persisted alongside the layout
    renderDraft();
  }));
  document.getElementById("dm-search")?.addEventListener("input", (e) => {
    _dmState.search = e.target.value;
    const caret = e.target.selectionStart;
    renderDraft();
    const el = document.getElementById("dm-search");
    if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch (_) {} }
  });
  document.getElementById("dm-needs")?.addEventListener("change", (e) => { _dmState.needsOnly = e.target.checked; renderDraft(); });
  document.querySelectorAll(".pool-nominate").forEach(b => b.addEventListener("click", () => startAuction(b.dataset.name, 1)));
  document.querySelectorAll(".dm-target").forEach(b => b.addEventListener("click", () => {
    if (typeof toggleTag === "function") { toggleTag(b.dataset.name, "target"); renderDraft(); }
  }));
  document.querySelectorAll("#view-root .player-name").forEach(el => el.addEventListener("click", () => openNoteEditor(el.dataset.player)));
  // Compare-roster (item 16): clicking an opponent row in Budgets / Standings
  // opens their roster next to mine; ✕ closes it.
  document.querySelectorAll(".dm-teamrow[data-dm-teamview]").forEach(row => row.addEventListener("click", () => {
    const id = row.dataset.dmTeamview;
    const num = Number(id);
    _dmState.compareTeamId = Number.isFinite(num) && String(num) === id ? num : id;
    renderDraft();
  }));
  document.querySelector(".dm-cmp-close")?.addEventListener("click", () => { _dmState.compareTeamId = null; renderDraft(); });
  // Roster slot drag-to-reposition. Autofill is the default; dragging a player
  // onto an eligible slot pins them there (double-click a player = back to auto).
  // Pins are scoped per team, so you can't drag a player between two rosters.
  document.querySelectorAll(".dm-slotplayer").forEach(el => {
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", JSON.stringify({ team: el.dataset.dmTeam, player: el.dataset.dmPlayer }));
      e.dataTransfer.effectAllowed = "move";
      el.classList.add("dm-slot-dragging");
    });
    el.addEventListener("dragend", () => el.classList.remove("dm-slot-dragging"));
    el.addEventListener("dblclick", () => { _dmClearRosterPin(el.dataset.dmTeam, el.dataset.dmPlayer); renderDraft(); });
  });
  document.querySelectorAll(".dm-slotrow").forEach(row => {
    row.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; row.classList.add("dm-slot-over"); });
    row.addEventListener("dragleave", () => row.classList.remove("dm-slot-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault(); row.classList.remove("dm-slot-over");
      let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch (_) { return; }
      if (!data || String(row.dataset.dmTeam) !== String(data.team)) return;   // same roster only
      const slotIndex = Number(row.dataset.dmSlot);
      const slotType = _DM_ROSTER_SLOTS[slotIndex];
      const val = (typeof getPlayerValue === "function") ? getPlayerValue(data.player) : null;
      if (!_dmSlotAccepts(slotType, val)) {   // reject clearly-illegal drops (hitter→P, etc.)
        row.classList.add("dm-slot-invalid");
        setTimeout(() => row.classList.remove("dm-slot-invalid"), 400);
        return;
      }
      _dmSetRosterPin(data.team, data.player, slotIndex);
      renderDraft();
    });
  });
  // Projected-standings expand toggle + sortable columns (item 17).
  document.querySelector(".dm-standings-expand")?.addEventListener("click", () => {
    _dmState.standingsExpanded = !_dmState.standingsExpanded;
    _dmSaveLayout({ standingsExpanded: _dmState.standingsExpanded });
    renderDraft();
  });
  document.querySelectorAll(".dm-sortcat[data-dm-sortcat]").forEach(th => th.addEventListener("click", () => {
    const cat = th.dataset.dmSortcat;
    const cur = _dmState.standingsSort;
    // First click on a column → sort desc (best first); click again → asc.
    if (cur && cur.cat === cat) _dmState.standingsSort = { cat, dir: cur.dir === "desc" ? "asc" : "desc" };
    else _dmState.standingsSort = { cat, dir: "desc" };
    renderDraft();
  }));
  // Feed-panel buttons are wired once via delegation in draft.js.
  document.querySelectorAll(".live-revert").forEach(b => b.addEventListener("click", () => {
    const idx = parseInt(b.dataset.idx, 10);
    if (confirm("Revert to before pick #" + (idx + 1) + "?")) revertToPick(idx);
  }));
  document.querySelectorAll(".live-delete").forEach(b => b.addEventListener("click", () => {
    const idx = parseInt(b.dataset.idx, 10);
    const pk = _liveDraft.picks[idx];
    if (pk && confirm("Delete pick #" + (idx + 1) + " (" + pk.player + ")?")) deletePickAt(idx);
  }));
  document.getElementById("picks-showall")?.addEventListener("click", () => { _liveDraft.showAllPicks = !_liveDraft.showAllPicks; renderDraft(); });
  _dmWireCardDrag();
  _dmWireCardResize();
  if (typeof wireNominationsPanel === "function") wireNominationsPanel(renderDraft);
  if (typeof wireAiPanel === "function") wireAiPanel();
}
