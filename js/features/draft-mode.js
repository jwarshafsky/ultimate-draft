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
  const zones = _dmZones();
  const heights = _dmLayout().heights || {};
  const ctx = { inflation, heights, panels: _dmBuildPanels(inflation) };
  let html = '<div class="dm-wrap">';
  html += _dmTopBar(inflation);
  // TOP zone (default: the on-the-clock hero) — full-width, above the columns.
  html += _dmRenderZone("top", zones.top, ctx);
  // Endgame panel — full-width, directly BELOW the top zone and ABOVE the
  // columns, so turning endgame on (or its auto-detecting) is unmistakable
  // rather than buried in the collapsed bottom drawer (item 10). NOT a panel
  // (conditional, fixed position).
  if (typeof isEndgame === "function" && isEndgame()) {
    html += '<div class="dm-endgame-strip">' + renderEndgamePanel() + '</div>';
  }
  // LEFT | split | RIGHT — the two resizable columns.
  html += '<div class="dm-main">';
  html += _dmRenderZone("left", zones.left, ctx);
  html += '<div class="dm-split" title="Drag to resize"></div>';
  html += _dmRenderZone("right", zones.right, ctx);
  html += '</div>';
  // BOTTOM zone (default: My Plan) — full-width, under the columns.
  html += _dmRenderZone("bottom", zones.bottom, ctx);
  html += _dmBottom();
  html += '</div>';
  root.innerHTML = html;
  wireDraftMode();
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

// Render one zone: a <div class="dm-zone dm-zone-{name}"> holding each panel in
// its persisted order, plus the transient compare card pinned right after the
// roster panel (wherever roster lives). Empty zones still render (with a slim
// drop strip) so they remain drag targets.
function _dmRenderZone(name, ids, ctx) {
  const isCol = (name === "left" || name === "right");
  let inner = "";
  for (const id of (ids || [])) {
    const p = ctx.panels[id];
    if (!p) continue;
    inner += _dmPanelHtml(id, p, ctx.heights);
    // Transient compare card (item 16) — inserted right AFTER "My Roster"
    // wherever roster lives, so it always sits next to my roster. Not draggable,
    // not persisted (no data-dm-card).
    if (id === "roster" && _dmState.compareTeamId != null) {
      const cmp = _dmCompareCardHtml(ctx.heights);
      if (cmp) inner += cmp;
    }
  }
  const empty = inner === "" ? " dm-zone-empty" : "";
  return '<div class="dm-zone dm-zone-' + name + (isCol ? " dm-zone-col" : " dm-zone-full") + empty + '" data-dm-zone="' + name + '">' + inner + '</div>';
}

// One draggable, height-resizable panel card. Body carries data-dm-cardbody for
// the height-persistence observer; the card carries data-dm-card + draggable for
// the reorder/move drag.
function _dmPanelHtml(id, p, heights) {
  const h = heights ? heights[id] : null;
  // Floor at 120px: an early ResizeObserver bug persisted garbage tiny heights
  // (41-80px) that pinned panels to ~one visible row (Jeff: draft history
  // "only shows one unless you scroll"). Anything below the floor renders as
  // auto — a deliberate small panel is still possible down to the CSS
  // min-height, but stored junk can't strangle a card (R17).
  const hStyle = (typeof h === "number" && h >= 120) ? ' style="height:' + h + 'px;"' : '';
  const cls = "card dm-rcard dm-panel" + (p.cls ? " " + p.cls : "");
  return '<div class="' + cls + '" data-dm-card="' + id + '" draggable="true">' +
    '<h3 class="dm-panel-title" style="margin:0 0 6px;" title="Drag to move / rearrange">⠿ ' + p.title + '</h3>' +
    '<div class="dm-cardbody" data-dm-cardbody="' + id + '"' + hStyle + '>' + p.body + '</div></div>';
}

// The transient "compare roster" card (item 16). Not draggable / not persisted.
function _dmCompareCardHtml(heights) {
  const cmpTeam = (typeof getTeam === "function") ? getTeam(_dmState.compareTeamId) : null;
  if (!cmpTeam) { _dmState.compareTeamId = null; return ""; }   // stale id (team gone)
  const title = '🔍 ' + esc(cmpTeam.owner) + '’s Roster ' +
    '<button class="btn ghost dm-cmp-close" title="Close comparison" style="float:right; padding:0 8px; font-size:12px;">✕</button>';
  const h = heights ? heights.compare : null;
  const hStyle = (typeof h === "number" && h >= 120) ? ' style="height:' + h + 'px;"' : '';
  return '<div class="card dm-rcard dm-cmpcard"><h3 style="margin:0 0 6px;">' + title + '</h3>' +
    '<div class="dm-cardbody"' + hStyle + '>' + _dmCompareRosterHtml(_dmState.compareTeamId) + '</div></div>';
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
  if (proj.type === "H") {
    return [["R", proj.R], ["HR", proj.HR], ["RBI", proj.RBI], ["SB", proj.SB], ["OBP", proj.OBP != null ? Number(proj.OBP).toFixed(3) : null]]
      .filter(x => x[1] != null).map(x => '<b>' + x[1] + '</b> <span class="muted">' + x[0] + '</span>').join(" · ");
  }
  return [["QS", proj.QS], ["K", proj.K], ["SV+H", proj.SV_HLD], ["ERA", proj.ERA != null ? Number(proj.ERA).toFixed(2) : null], ["WHIP", proj.WHIP != null ? Number(proj.WHIP).toFixed(2) : null]]
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
  else if (isMyBid) html += '<span class="good">✓ You\'re the high bidder at $' + cur + ' — bots responding…</span>';
  else if (iHavePassed) html += '<span class="muted">You passed on this lot.</span>';
  else if (pricedOut) html += '<span class="bad">Priced out — your max is $' + myMax + '.</span>';
  else html += '<span>Your turn — bid or pass. Max <b>$' + myMax + '</b>.</span>';
  // Countdown while the clock is on you (engine ticks it; _icCockpitRefresh
  // patches the text per second — expiry auto-passes, like a real draft room).
  const clk = (s.useTimer && !isMyBid && !iHavePassed && s.secondsLeft > 0) ? ("⏱ " + s.secondsLeft + "s") : "";
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

// How many position columns fit in the board panel at the current view's
// per-column minimum (stats tables are much wider than value tables). Measured
// from the live DOM; a headless/first render falls back to 2.
const _DM_COL_MIN = { value: 300, stats: 500 };
function _dmBoardColCapacity() {
  const el = (typeof document !== "undefined") ? document.querySelector('[data-dm-card="board"] .dm-cardbody') : null;
  const w = el ? el.clientWidth : 0;
  if (!w) return 2;
  return Math.max(1, Math.floor(w / (_DM_COL_MIN[_dmState.statView] || 300)));
}

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
    html += '<select id="dm-addcol" title="Show another position side-by-side (needs board width)" style="width:auto;">';
    html += '<option value="">＋ column</option>';
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
    // One column PER selected position, side by side. Column count is capped
    // by the ＋ selector (capacity-gated); each column min-width matches the
    // view so tables can never overlap — overflow scrolls instead.
    const base = _dmBasePool();
    // Preserve the segmented-control order for readable, stable columns.
    const cols = _DM_POS_MODES.filter(m => posSel.has(m));
    const minW = _DM_COL_MIN[_dmState.statView] || 300;
    html += '<div class="dm-poscols" style="grid-template-columns: repeat(' + cols.length + ', minmax(' + minW + 'px, 1fr));">';
    for (const m of cols) {
      const rows = base.filter(p => _dmModeMatch(p, m)).slice(0, 40);
      html += '<div class="dm-poscol"><h3 style="margin:6px 0; display:flex; align-items:center; gap:6px;">' + esc(m) +
        (cols.length > 1 ? '<button class="btn ghost" data-dm-colremove="' + esc(m) + '" title="Remove this column" style="width:auto; padding:0 6px; font-size:11px; line-height:1.4;">✕</button>' : '') +
        '</h3>' + _dmTable(rows, inflation) + '</div>';
    }
    html += '</div>';
  } else if (_dmState.boardMode === "BPA") {
    const pool = _dmPoolRows(inflation);
    const hit = pool.filter(p => _DM_HIT_POS.includes(p.posKey)).slice(0, 18);
    const pit = pool.filter(p => p.posKey === "SP" || p.posKey === "RP").slice(0, 18);
    html += '<div class="dm-bpa">';
    html += '<div><h3 style="margin:6px 0;">Best Hitters</h3>' + _dmTable(hit, inflation) + '</div>';
    html += '<div><h3 style="margin:6px 0;">Best Pitchers</h3>' + _dmTable(pit, inflation) + '</div>';
    html += '</div>';
  } else {
    html += _dmTable(_dmPoolRows(inflation).slice(0, 60), inflation);
  }
  return html;
}

// Stats-view columns: per-row we show the right set (hitter vs pitcher). The
// header is a compact combined set so a mixed table still lines up.
const _DM_HIT_STATS = [["R", "R"], ["HR", "HR"], ["RBI", "RBI"], ["SB", "SB"], ["OBP", "OBP"]];
const _DM_PIT_STATS = [["QS", "QS"], ["K", "K"], ["SV+H", "SV_HLD"], ["ERA", "ERA"], ["WHIP", "WHIP"]];

// The projected-stat <td> cells for one player (5 numeric cells). Missing
// projection → dim dashes. Rates: OBP 3dp; ERA/WHIP 2dp.
function _dmStatCells(name) {
  const proj = (typeof getProjection === "function") ? getProjection(name) : null;
  const cell = (v, dec) => {
    if (v == null || v === "" || (typeof v === "number" && !isFinite(v))) return '<td class="num dim">—</td>';
    const out = (dec != null) ? Number(v).toFixed(dec) : v;
    return '<td class="num">' + out + '</td>';
  };
  if (!proj) return '<td class="num dim">—</td>'.repeat(5);
  if (proj.type === "H") {
    return cell(proj.R) + cell(proj.HR) + cell(proj.RBI) + cell(proj.SB) + cell(proj.OBP, 3);
  }
  return cell(proj.QS) + cell(proj.K) + cell(proj.SV_HLD) + cell(proj.ERA, 2) + cell(proj.WHIP, 2);
}

function _dmTable(players, inflation) {
  if (!players.length) return '<p class="muted small">nobody left here.</p>';
  const stats = _dmState.statView === "stats";
  // Combined header for the stats view (hitter cats then pitcher cats collapse
  // onto the same 5 columns; per-row cells pick the matching set).
  const statHead = stats
    ? '<th class="num">R/QS</th><th class="num">HR/K</th><th class="num">RBI/SV+H</th><th class="num">SB/ERA</th><th class="num">OBP/WHIP</th>'
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

// --- panels (four-zone layout) ---
// EVERYTHING in the main area is a panel now: the on-the-clock hero cluster, the
// player board, the side cards, the category dashboard, the AI assistant and the
// My Plan bar. Each panel has a stable id; the user drags panels within AND
// between FOUR zones — top (full-width), left / right (the split columns) and
// bottom (full-width) — and each panel body is height-resizable. Layout is
// DEVICE-LOCAL (monitor-specific) — the same rationale as DM_KEY, so it is
// deliberately NOT in the cloud-sync whitelist. Stored under ud_dm_layout_v1:
//   { zones: { top:[id...], left:[id...], right:[id...], bottom:[id...] },
//     split: <number|null>, heights: { id: px }, statView: "value"|"stats",
//     standingsExpanded: bool, order: [id...] (legacy, kept in sync) }
// split = LEFT column width as a % of the .dm-main track (20–85). heights map a
// panel id → its user-dragged pixel height.
// MIGRATION (nothing ever disappears):
//   • bare Array (v1 order)  → right zone seeded from it, hero/board/plan default
//   • { order:[...] }        → same (order was the right-rail order)
//   • { cols:{left,right} }  → an interim two-column build; folded into zones
//   • { zones:{...} }        → used as-is, then any missing known panel id is
//                              appended to its DEFAULT zone.
const _DM_CARD_ORDER_KEY = "ud_dm_layout_v1";
const _DM_ZONE_IDS = ["top", "left", "right", "bottom"];
// The canonical set of panels and the zone each defaults to. Order within a zone
// here IS the default order — must reproduce today's layout exactly.
const _DM_PANEL_IDS = ["hero", "board", "roster", "budgets", "standings", "noms", "history", "cats", "ai", "plan"];
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
function _dmLayout() {
  try {
    const v = JSON.parse(localStorage.getItem(_DM_CARD_ORDER_KEY) || "null");
    if (Array.isArray(v)) {   // legacy bare array = right-rail order
      return { order: v, zones: _dmZonesFromOrder(v), split: null, heights: {}, statView: null, standingsExpanded: null };
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
        order,
        zones,
        split: (typeof v.split === "number" ? v.split : null),
        heights: (v.heights && typeof v.heights === "object") ? v.heights : {},
        statView: (v.statView === "value" || v.statView === "stats") ? v.statView : null,
        standingsExpanded: (typeof v.standingsExpanded === "boolean") ? v.standingsExpanded : null,
      };
    }
  } catch (e) {}
  return { order: null, zones: _dmNormalizeZones(null), split: null, heights: {}, statView: null, standingsExpanded: null };
}
function _dmSaveLayout(patch) {
  const cur = _dmLayout();
  const next = { order: cur.order, zones: cur.zones, split: cur.split, heights: cur.heights, statView: cur.statView, standingsExpanded: cur.standingsExpanded };
  if (patch && "order" in patch) next.order = patch.order;
  if (patch && "zones" in patch) next.zones = _dmNormalizeZones(patch.zones);
  if (patch && "split" in patch) next.split = patch.split;
  if (patch && "heights" in patch) next.heights = patch.heights;
  if (patch && "statView" in patch) next.statView = patch.statView;
  if (patch && "standingsExpanded" in patch) next.standingsExpanded = patch.standingsExpanded;
  // Keep the legacy `order` (right-rail order) in sync so an OLDER build loading
  // this same key still renders a sane rail.
  if (patch && "zones" in patch && next.zones) next.order = next.zones.right.filter(id => id !== "board");
  try { localStorage.setItem(_DM_CARD_ORDER_KEY, JSON.stringify(next)); } catch (e) {}
}
function _dmZones() { return _dmLayout().zones; }
function _dmSaveZones(zones) { _dmSaveLayout({ zones }); }
// Wipe every layout override (zones / split / heights) → back to the default
// four-zone layout. statView + standingsExpanded are content prefs, kept.
function _dmResetLayout() {
  _dmSaveLayout({ zones: _dmNormalizeZones(null), split: null, heights: {} });
}

function _dmMyRosterHtml() {
  const me = (typeof getMyDraftTeam === "function") ? getMyDraftTeam() : null;
  if (!me) return '<p class="muted small">Pick your team on Draft Setup (Test mode) to see your roster.</p>';
  const st = computeLiveTeamStates()[me.id];
  const kept = [];
  if (typeof getEffectiveKeeperSelections === "function" && !draftTestMode()) {
    for (const [n, f] of Object.entries(getEffectiveKeeperSelections()[me.id] || {})) if (f.keeper) kept.push({ name: n, how: "keeper" });
  }
  const picks = _liveDraft.picks.filter(p => p.team === me.id || (me.espnTeamId != null && p.espnTeamId === me.espnTeamId))
    .map(p => ({ name: p.player, how: "$" + p.price }));
  const roster = [...kept, ...picks];
  let html = '<p class="small" style="margin:0 0 4px;">' + roster.length + ' rostered · <b>$' + (st ? st.budget : "?") + '</b> left · ' + (st ? st.slotsRemaining : "?") + ' slots · max bid <b style="color:var(--accent);">$' + (st ? st.maxBid : "?") + '</b></p>';
  if (!roster.length) return html + '<p class="muted small" style="margin:0;">Nobody yet — keepers + your picks appear here.</p>';
  html += '<table class="dm-table"><tbody>';
  for (const r of roster) {
    const v = getPlayerValue(r.name);
    html += '<tr><td>' + esc(v?.posKey || "?") + '</td><td>' + esc(r.name) + '</td><td class="num muted">' + esc(r.how) + '</td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

// Another team's roster, shown next to "My Roster" for comparison (item 16).
// Same data approach as _dmMyRosterHtml but for an arbitrary teamId.
function _dmCompareRosterHtml(teamId) {
  const t = (typeof getTeam === "function") ? getTeam(teamId) : null;
  const st = computeLiveTeamStates()[teamId];
  const kept = [];
  if (typeof getEffectiveKeeperSelections === "function" && !draftTestMode()) {
    for (const [n, f] of Object.entries(getEffectiveKeeperSelections()[teamId] || {})) if (f.keeper) kept.push({ name: n, how: "keeper" });
  }
  const picks = _liveDraft.picks.filter(p => p.team === teamId)
    .map(p => ({ name: p.player, how: "$" + p.price }));
  const roster = [...kept, ...picks];
  let html = '<p class="small" style="margin:0 0 4px;">' + roster.length + ' rostered · <b>$' + (st ? st.budget : "?") + '</b> left · ' + (st ? st.slotsRemaining : "?") + ' slots · max bid <b style="color:var(--accent);">$' + (st ? st.maxBid : "?") + '</b></p>';
  if (!roster.length) return html + '<p class="muted small" style="margin:0;">No keepers or picks yet.</p>';
  html += '<table class="dm-table"><tbody>';
  for (const r of roster) {
    const v = getPlayerValue(r.name);
    html += '<tr><td>' + esc(v?.posKey || "?") + '</td><td>' + esc(r.name) + '</td><td class="num muted">' + esc(r.how) + '</td></tr>';
  }
  html += '</tbody></table>';
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

// Apply + wire the resizable split between the LEFT and RIGHT columns. The
// stored split is the LEFT column's width as a % of the .dm-main track; the
// right column takes the remainder. Reapplied on every render (renders rebuild
// innerHTML). Dragging the .dm-split handle updates it live and persists on
// release. When no split is stored the CSS default (media-query grid) stands.
// Module-level drag state so the document-level move/up listeners (bound ONCE,
// see below) always act on the current .dm-main, never accumulate per render.
let _dmSplitDrag = false;
function _dmApplySplitTemplate(main, pct) {
  const p = Math.max(20, Math.min(85, pct));
  main.style.gridTemplateColumns = p.toFixed(2) + "% 8px minmax(0, 1fr)";
}
function _dmWireSplit() {
  const main = document.querySelector(".dm-main");
  const handle = main ? main.querySelector(".dm-split") : null;
  if (!main || !handle) return;
  const stored = _dmLayout().split;
  if (typeof stored === "number") _dmApplySplitTemplate(main, stored);
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    _dmSplitDrag = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  // Bind the global move/up handlers exactly once for the whole session.
  if (!document._dmSplitBound) {
    document._dmSplitBound = true;
    document.addEventListener("mousemove", (e) => {
      if (!_dmSplitDrag) return;
      const m = document.querySelector(".dm-main");
      if (!m) return;
      const rect = m.getBoundingClientRect();
      if (rect.width <= 0) return;
      _dmApplySplitTemplate(m, ((e.clientX - rect.left) / rect.width) * 100);
    });
    document.addEventListener("mouseup", () => {
      if (!_dmSplitDrag) return;
      _dmSplitDrag = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const m = document.querySelector(".dm-main");
      const leftCol = m ? m.querySelector(".dm-zone-left") : null;
      const rect = m ? m.getBoundingClientRect() : null;
      if (leftCol && rect && rect.width > 0) {
        const pct = (leftCol.getBoundingClientRect().width / rect.width) * 100;
        _dmSaveLayout({ split: Math.max(20, Math.min(85, +pct.toFixed(2))) });
      }
    });
  }
}

// Per-panel resizable HEIGHT: the panel body is CSS `resize: vertical`; capture
// the chosen height on release and persist it, reapplied on render via the
// panel wrapper. Observes EVERY zone (a panel can live anywhere now).
function _dmWireCardResize() {
  const save = (id, px, body) => {
    // Persist only a REAL user resize (R16): the element must still be in the
    // document (a debounced read after an innerHTML rebuild sees a detached
    // node → 0/garbage), and must have MOVED from the height we applied at
    // render (the observer fires once per observe(), i.e. on every render).
    if (!body.isConnected || !(px && px >= 120)) return;   // match the render floor
    const applied = parseInt(body.dataset.dmAppliedH || "", 10);
    if (isFinite(applied) && Math.abs(px - applied) <= 8) return;
    const heights = Object.assign({}, _dmLayout().heights);
    heights[id] = Math.round(px);
    _dmSaveLayout({ heights });
    body.dataset.dmAppliedH = String(Math.round(px));
  };
  document.querySelectorAll(".dm-zone .dm-cardbody[data-dm-cardbody]").forEach(body => {
    const id = body.dataset.dmCardbody;
    if (!body.dataset.dmAppliedH) body.dataset.dmAppliedH = String(body.offsetHeight || "");
    if (typeof ResizeObserver === "function" && !body._dmRO) {
      // Debounce the observer so we persist the settled height, not every frame.
      let t = null;
      body._dmRO = new ResizeObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => save(id, body.offsetHeight, body), 250);
      });
      body._dmRO.observe(body);
    }
  });
}

// HTML5 drag to move a panel WITHIN and BETWEEN the four zones. Every zone is a
// drop target (including empty ones — they keep a slim visible strip while a
// drag is active). On drop we read back the DOM order of each zone and persist
// the whole { top,left,right,bottom } map. The compare card is transient (no
// data-dm-card) so it never participates and never persists.
function _dmWireCardDrag() {
  const zones = [...document.querySelectorAll(".dm-zone[data-dm-zone]")];
  if (!zones.length) return;
  let dragging = null;
  const clearOver = () => document.querySelectorAll(".dm-dragover, .dm-zone-dragover")
    .forEach(c => c.classList.remove("dm-dragover", "dm-zone-dragover"));
  // Read the current panel order out of each zone's DOM and persist it.
  const persist = () => {
    const next = { top: [], left: [], right: [], bottom: [] };
    for (const z of zones) {
      const name = z.dataset.dmZone;
      if (!next[name]) continue;
      next[name] = [...z.querySelectorAll(".card[data-dm-card]")].map(c => c.dataset.dmCard);
    }
    _dmSaveZones(next);
  };
  // Insert the dragged card relative to a sibling card (before/after by midpoint).
  const insertRelative = (card, e) => {
    const rect = card.getBoundingClientRect();
    const parent = card.parentNode;
    if (e.clientY < rect.top + rect.height / 2) parent.insertBefore(dragging, card);
    else parent.insertBefore(dragging, card.nextSibling);
  };
  document.querySelectorAll(".dm-zone .card[data-dm-card]").forEach(card => {
    card.addEventListener("dragstart", (e) => {
      dragging = card; card.classList.add("dm-dragging");
      try { e.dataTransfer.effectAllowed = "move"; } catch (_) {}
      document.body.classList.add("dm-dragging-active");   // reveal empty-zone drop strips
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dm-dragging");
      document.body.classList.remove("dm-dragging-active");
      clearOver();
      dragging = null;
    });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragging || dragging === card) return;
      // Skip the transient compare card as a sibling anchor — insert before it.
      const anchor = card.classList.contains("dm-cmpcard") ? null : card;
      if (anchor) { anchor.classList.add("dm-dragover"); insertRelative(anchor, e); }
    });
    card.addEventListener("dragleave", () => card.classList.remove("dm-dragover"));
  });
  // Zone-level drop target: handles empty zones and the gap below the last card.
  zones.forEach(z => {
    z.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragging) return;
      z.classList.add("dm-zone-dragover");
      // If the pointer is below every card in this zone, append to the end.
      const cards = [...z.querySelectorAll(".card[data-dm-card]")];
      const last = cards[cards.length - 1];
      if (!cards.length) { z.appendChild(dragging); return; }
      if (last && last !== dragging) {
        const r = last.getBoundingClientRect();
        if (e.clientY > r.bottom) z.appendChild(dragging);
      }
    });
    z.addEventListener("dragleave", (e) => {
      // Only clear when actually leaving the zone (not entering a child).
      if (!z.contains(e.relatedTarget)) z.classList.remove("dm-zone-dragover");
    });
    z.addEventListener("drop", (e) => { e.preventDefault(); clearOver(); persist(); });
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
  // ＋ add-a-column selector (multi-position view) — gated on the board panel
  // actually having room for another column at the current view's width.
  document.getElementById("dm-addcol")?.addEventListener("change", (e) => {
    const m = e.target.value;
    if (!m) return;
    if (_dmState.boardPos.size >= _dmBoardColCapacity()) {
      alert("No room for another column — widen the board (drag the divider between the columns, or move the board to the full-width top zone), or switch Stats → Value.");
      e.target.value = "";
      return;
    }
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
  _dmWireSplit();
  _dmWireCardResize();
  if (typeof wireNominationsPanel === "function") wireNominationsPanel(renderDraft);
  if (typeof wireAiPanel === "function") wireAiPanel();
}
