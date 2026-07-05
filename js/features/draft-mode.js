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
const _dmState = { boardMode: "BPA", search: "", needsOnly: false };

function _draftModeOn() {
  try { return localStorage.getItem(DM_KEY) === "1"; } catch (e) { return false; }
}
function setDraftMode(on) {
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

// ---------------------------------------------------------------------------
// Current lot from the event stream: walk the log; a NOMINATION (or first BID)
// after the last SOLD opens a lot, SOLD closes it.
function currentLotFromEvents() {
  const evs = _dlog.events;
  let lot = null;
  for (const e of evs) {
    // SOLD closes only ITS lot — interleaved frames (NOM B before SOLD A
    // lands) must not blank the player actually on the clock. INIT marks a
    // socket reconnect: NOMINATION/BID during the gap are lost, so a pre-gap
    // lot can't be trusted — reset and let live frames rebuild it.
    if (e.cmd === "SOLD") { if (!lot || e.playerId == null || lot.playerId === e.playerId) lot = null; continue; }
    if (e.cmd === "INIT") { lot = null; continue; }
    if (e.cmd === "NOMINATION" && e.playerId != null && e.playerId > 1000) {
      lot = { playerId: e.playerId, nomTeamId: e.teamId, at: e.at, bids: [] };
    } else if ((e.cmd === "BID" || e.cmd === "BID_ACK") && e.playerId != null) {
      if (!lot || lot.playerId !== e.playerId) lot = { playerId: e.playerId, nomTeamId: null, at: e.at, bids: [] };
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
  if (st) for (const [pos, tgt] of Object.entries((typeof POS_TARGETS !== "undefined" ? POS_TARGETS : {}))) {
    if ((st.posCounts[pos] || 0) < tgt) openPos.add(pos);
  }
  // Weak categories = bottom-half projected rank (rank is 1=best..12=worst).
  const cats = (typeof projectTeamCategories === "function") ? projectTeamCategories(getMyRoster()) : null;
  const weak = new Set();
  if (cats) for (const [c, r] of Object.entries(cats.ranks)) if (r >= 7) weak.add(c);
  _fitCtx = { openPos, weak, slotsRemaining: st ? st.slotsRemaining : 99 };
  _fitCtxKey = key;
  return _fitCtx;
}

function rosterFit(playerName) {
  const ctx = _fitContext();
  if (!ctx) return null;
  const val = getPlayerValue(playerName);
  if (!val) return null;
  let score = 0; const parts = [];
  // Position need
  if (ctx.openPos.has(val.posKey)) { score += 2; parts.push("fills " + val.posKey); }
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
  return ' <span class="small" title="Roster fit: ' + esc(f.label) + '" style="color:' + color + ';">' +
    (f.strong ? '★' : '•') + ' ' + esc(f.label) + '</span>';
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
  const maxBid = st ? st.maxBid : 999;
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
  if (walk > maxBid) { walk = maxBid; reasons.push("capped by your max bid"); }
  if (stretch > maxBid) stretch = maxBid;
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
  for (const p of pool) {
    const est = Math.max(1, Math.round((p.value || 0) * inflMult));
    let best = null, bestPerSlot = -1;
    for (const t of (typeof draftTeams === "function" ? draftTeams() : LEAGUE.teams)) {
      if (slots[t.id] <= 0) continue;
      const afford = money[t.id] - (slots[t.id] - 1);   // $1 reserved per other slot
      if (afford < est && !(est <= 1)) continue;
      const perSlot = money[t.id] / slots[t.id];
      if (perSlot > bestPerSlot) { bestPerSlot = perSlot; best = t.id; }
    }
    if (best == null) {
      // Nobody can afford him at estimate — richest open team gets him at max
      for (const t of (typeof draftTeams === "function" ? draftTeams() : LEAGUE.teams)) {
        if (slots[t.id] <= 0) continue;
        const perSlot = money[t.id] / slots[t.id];
        if (perSlot > bestPerSlot) { bestPerSlot = perSlot; best = t.id; }
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
  let html = '<div class="dm-wrap">';
  html += _dmTopBar(inflation);
  html += _dmHero();
  html += '<div class="dm-main">';
  html += '<div>' + _dmBoard(inflation) + '</div>';
  html += '<div class="dm-side">' + _dmSide() + '</div>';
  html += '</div>';
  html += _dmBottom();
  html += '</div>';
  root.innerHTML = html;
  wireDraftMode();
}

function _dmTopBar(inflation) {
  const me = (typeof getMyDraftTeam === "function" ? getMyDraftTeam() : getMyTeam());
  const st = me ? computeLiveTeamStates()[me.id] : null;
  let html = '<div class="card dm-topbar">';
  html += '<b>DRAFT MODE</b>';
  html += '<span class="muted small">' + _liveDraft.picks.length + ' picks</span>';
  if (inflation) html += '<span class="badge">infl ' + inflation.multiplier.toFixed(2) + '×</span>';
  if (st) html += '<span class="small">My budget <b>$' + st.budget + '</b> · ' + st.slotsRemaining + ' slots · max bid <b style="color:var(--accent);">$' + st.maxBid + '</b></span>';
  html += '<span id="dm-feedchips" class="small" style="display:inline-flex; gap:10px;">' + _dmFeedChips() + '</span>';
  html += '<span style="flex:1;"></span>';
  html += '<button class="btn ghost" id="dm-debrief" title="Post-draft recap">📋 Debrief</button>';
  html += '<button class="btn ghost" id="dm-exit" title="Esc also exits">✕ Exit to setup</button>';
  html += '</div>';
  return html;
}

function _dmFeedChips() {
  const dot = (on, color) => '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (on ? color : "var(--text-3)") + ';margin-right:4px;vertical-align:middle;"></span>';
  const lastFrame = Math.max(_feed.lastFrameAt || 0, _dlog.lastEventAt || 0);
  const quiet = lastFrame ? (Date.now() - lastFrame) / 1000 : null;
  const stalled = draftTabOpen() && lastFrame && quiet > 30;
  let s = '<span>' + dot(_feed.extPresent, "var(--good)") + 'ext</span>';
  s += '<span>' + dot(draftTabOpen(), "var(--good)") + 'ESPN tab</span>';
  s += '<span>' + dot(lastFrame && quiet < 30, stalled ? "var(--bad)" : "var(--good)") + (lastFrame ? (stalled ? '<b style="color:var(--bad);">feed quiet ' + Math.round(quiet) + 's</b>' : 'feed ' + Math.round(quiet) + 's') : 'no data') + '</span>';
  s += '<span class="muted">mode ' + esc(getFeedMode()) + '</span>';
  return s;
}

function _dmHero() {
  const lot = (getFeedMode() !== "off") ? currentLotFromEvents() : null;
  const manual = _liveDraft.current;
  const name = lot ? lot.name : (manual ? manual.player : null);
  let html = '<div class="dm-hero">';

  // --- player card --- (data-player is the stable change-detection key; the
  // visible name now carries an injury chip so its textContent can't be used)
  html += '<div class="card dm-otc" id="dm-otc" data-player="' + esc(name || "") + '">';
  if (!name) {
    html += '<div class="otc-label">On the Clock</div>';
    html += '<div class="dm-player muted">Waiting for a nomination…</div>';
    html += '<div class="small muted">Nominations on ESPN appear here automatically' + (getFeedMode() === "off" ? ' — turn the pick feed ON below.' : '.') + '</div>';
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
    if (typeof renderPlayerNewsBlock === "function") html += renderPlayerNewsBlock(name);
    html += '<div id="dm-interest">' + _dmInterestHtml(name) + '</div>';
    const temp = lot ? lotTemperature(lot) : null;
    html += '<div id="dm-temp">' + (temp ? _dmTempChip(temp) : '') + '</div>';
    if (lot && lot.idle) html += '<div class="small" style="margin-top:4px; color:var(--warn);">⏸ Lot quiet ' + lot.idleMin + 'm — draft likely paused; resumes automatically.</div>';
  }
  html += '</div>';

  // --- ticker ---
  html += '<div class="card dm-ticker-card"><div class="otc-label">Bidding</div>';
  html += '<div id="dm-bidline" class="dm-bidline">' + (lot ? _dmBidLine(lot) : '<span class="muted small">—</span>') + '</div>';
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

function _dmBidLine(lot) {
  return '<span class="dm-bignum">$' + lot.highBid + '</span> <span class="small">' + esc(_dmTeamLabel(lot.highTeamId)) + '</span>';
}

function _dmTickerHtml(lot) {
  const rows = lot.bids.slice(-8).reverse();
  if (!rows.length) return '<div class="muted small">no bids yet</div>';
  return rows.map(b => '<div class="small">' + '$' + b.amount + ' — ' + esc(_dmTeamLabel(b.teamId)) + (b.ack ? '' : '') + '</div>').join("");
}

function _dmRecoHtml(name, lot) {
  const r = recommendBid(name);
  if (!r) return '<span class="muted small">no value data for ' + esc(name) + '</span>';
  const high = lot ? lot.highBid : (_liveDraft.highBid || 0);
  let verdict, vcolor;
  if (high < r.walk) { verdict = "room to bid"; vcolor = "var(--good)"; }
  else if (high < r.stretch) { verdict = "stretch territory"; vcolor = "var(--warn)"; }
  else { verdict = "walk away"; vcolor = "var(--bad)"; }
  let html = '<div class="dm-reco-nums">';
  html += '<div><span class="muted small">walk-away</span><br><b class="dm-bignum">$' + r.walk + '</b></div>';
  html += '<div><span class="muted small">stretch</span><br><b class="dm-bignum" style="color:var(--warn);">$' + r.stretch + '</b></div>';
  html += '<div><span class="muted small">my max</span><br><b class="dm-bignum muted">$' + r.maxBid + '</b></div>';
  html += '</div>';
  html += '<div class="small" style="margin-top:4px; color:' + vcolor + ';"><b>' + verdict + '</b> <span class="muted">at $' + high + '</span></div>';
  html += '<div class="muted small" style="margin-top:4px;">' + esc(r.rationale) + '</div>';
  const tactic = _bidTactic(name, high, r, lot);
  if (tactic) html += '<div class="small" style="margin-top:4px; color:var(--accent);">💡 ' + esc(tactic) + '</div>';
  return html;
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

function _dmPoolRows(inflation) {
  let pool = availableDraftPool();
  if (_dmState.search) {
    const q = _dmState.search.toLowerCase();
    pool = pool.filter(p => p.name.toLowerCase().includes(q));
  }
  const m = _dmState.boardMode;
  if (m === "HIT") pool = pool.filter(p => _DM_HIT_POS.includes(p.posKey));
  else if (m === "PIT") pool = pool.filter(p => p.posKey === "SP" || p.posKey === "RP");
  else if (_DM_FLEX[m]) pool = pool.filter(p => _DM_FLEX[m].includes(p.posKey));
  else if (m !== "BPA") pool = pool.filter(p => p.posKey === m);
  if (_dmState.needsOnly) {
    const me = (typeof getMyDraftTeam === "function" ? getMyDraftTeam() : getMyTeam());
    const st = me ? computeLiveTeamStates()[me.id] : null;
    if (st) pool = pool.filter(p => (st.posCounts[p.posKey] || 0) === 0);
  }
  return pool;
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

function _dmBoard(inflation) {
  let html = '<div class="card">';
  html += _dmTierCliffBanner();
  html += '<div class="dm-board-head">';
  html += '<div class="seg dm-seg">' + _DM_MODES.map(m =>
    '<button class="btn' + (_dmState.boardMode === m ? ' primary' : ' ghost') + '" data-dm-mode="' + m + '">' + (m === "HIT" ? "Hitters" : m === "PIT" ? "Pitchers" : m) + '</button>').join("") + '</div>';
  html += '<input id="dm-search" placeholder="Search…" value="' + esc(_dmState.search) + '" style="width:180px;">';
  html += '<label class="small muted" style="white-space:nowrap;"><input type="checkbox" id="dm-needs"' + (_dmState.needsOnly ? " checked" : "") + '> my needs</label>';
  html += '</div>';

  if (_dmState.boardMode === "BPA") {
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
  html += '</div>';
  return html;
}

function _dmTable(players, inflation) {
  if (!players.length) return '<p class="muted small">nobody left here.</p>';
  let html = '<table class="dm-table"><thead><tr><th>Player</th><th>Fit</th><th>Pos</th><th class="num">$</th><th class="num">Infl</th><th class="num">NFBC</th><th class="num">Δmkt</th><th></th></tr></thead><tbody>';
  for (const p of players) {
    const inf = inflatedValue(p, inflation);
    const nfbc = getNfbc(p.name);
    const delta = nfbc?.avg != null ? nfbc.avg - inf : null;
    const fit = (typeof rosterFit === "function") ? rosterFit(p.name) : null;
    html += '<tr' + (fit && fit.strong ? ' style="background:rgba(63,185,80,.08);"' : '') + '>';
    html += '<td><span class="player-name" data-player="' + esc(p.name) + '" style="cursor:pointer;">' + esc(p.name) + '</span>' +
      (typeof renderTagIcons === "function" ? renderTagIcons(p.name) : '') + '</td>';
    html += '<td class="small">' + (fit ? '<span title="' + esc(fit.label) + '" style="color:' + (fit.strong ? 'var(--good)' : 'var(--accent)') + ';">' + (fit.strong ? '★ ' : '• ') + esc(fit.label) + '</span>' : '<span class="dim">—</span>') + '</td>';
    html += '<td>' + esc(p.posKey) + '</td>';
    html += '<td class="num">$' + p.value.toFixed(0) + '</td>';
    html += '<td class="num"><b>$' + inf.toFixed(0) + '</b></td>';
    html += '<td class="num' + (nfbc?.avg ? '' : ' dim') + '">' + (nfbc?.avg ? '$' + nfbc.avg.toFixed(0) : '—') + '</td>';
    html += '<td class="num' + (delta == null ? ' dim' : delta > 3 ? '" style="color:var(--warn);' : delta < -3 ? '" style="color:var(--good);' : '') + '">' + (delta == null ? '—' : (delta > 0 ? '+' : '') + delta.toFixed(0)) + '</td>';
    html += '<td><button class="btn ghost pool-nominate" data-name="' + esc(p.name) + '" title="Manual: start auction" style="padding:1px 7px; font-size:10px;">▶</button></td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

// --- side panels ---
function _dmSide() {
  let html = '';
  const brief = (typeof strategyForAi === "function") ? strategyForAi() : null;
  html += '<div class="card"><h3 style="margin:0 0 6px;">My Plan</h3>' +
    (brief
      ? '<div class="small" style="white-space:pre-wrap;">' + esc(brief) + '</div>'
      : '<p class="muted small" style="margin:0;">No strategy written — Settings ▸ Draft Strategy.</p>') +
    '</div>';
  html += '<div class="card"><h3 style="margin:0 0 6px;">Projected Standings <span class="muted small">if the rest of the draft goes to $/slot</span></h3>' + _dmStandingsHtml() + '</div>';
  html += '<div class="card"><h3 style="margin:0 0 6px;">Nominations</h3>' + renderNominationsPanel() + '</div>';
  html += renderCategoryDashboard();
  html += renderAiAssistantPanel();
  return html;
}

function _dmStandingsHtml() {
  let res = null;
  try { res = computeLiveProjStandings(); } catch (e) { console.warn("proj standings failed:", e); }
  if (!res || !res.teams || !res.anyData) return '<p class="muted small">Needs stat projections (Data tab) — showing nothing rather than junk.</p>';
  let html = '<table class="dm-table"><thead><tr><th class="num">#</th><th>Team</th><th class="num">Roto</th></tr></thead><tbody>';
  res.teams.forEach((t, i) => {
    html += '<tr' + (t.isMe ? ' style="background:rgba(79,142,247,.10);"' : '') + '><td class="num">' + (i + 1) + '</td><td>' + esc(t.owner) + '</td><td class="num">' + t.rotoPoints.toFixed(1) + '</td></tr>';
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

// --- bottom zone ---
function _dmBottom() {
  let html = '<details class="dm-bottom"><summary class="small muted" style="cursor:pointer;">Pick tracker · teams · call-ups · feed</summary>';
  html += '<div style="margin-top:8px;">';
  html += renderDraftFeedPanel();
  html += '<div class="card" style="padding:8px;"><h3 style="margin:0 0 6px;">Teams</h3>' + renderTeamStrip() + '</div>';
  if (isEndgame()) html += renderEndgamePanel();
  html += '<div class="dm-main" style="grid-template-columns:1fr 1fr;">';
  html += '<div>' + renderRecentPicks() + '</div>';
  html += '</div>';
  html += '</div></details>';
  return html;
}

// --- live in-place updates (no full re-render on every bid) ---
function updateDraftModeLive() {
  if (!_draftModeOn() || typeof currentView === "undefined" || currentView !== "draft") return;
  const lot = (getFeedMode() !== "off") ? currentLotFromEvents() : null;
  const otc = document.getElementById("dm-otc");
  if (!otc) return;
  // Player changed (new nomination / sold) → full re-render for fresh panels.
  const shownName = otc.getAttribute("data-player") || "";
  const lotName = lot ? lot.name : (_liveDraft.current ? _liveDraft.current.player : "");
  if (shownName !== lotName) { renderDraft(); return; }
  if (lot) {
    const bidline = document.getElementById("dm-bidline");
    if (bidline) bidline.innerHTML = _dmBidLine(lot);
    const ticker = document.getElementById("dm-ticker");
    if (ticker) ticker.innerHTML = _dmTickerHtml(lot);
    const temp = document.getElementById("dm-temp");
    if (temp) { const t = lotTemperature(lot); temp.innerHTML = t ? _dmTempChip(t) : ''; }
    const reco = document.getElementById("dm-reco");
    if (reco) reco.innerHTML = _dmRecoHtml(lot.name, lot);
    const interest = document.getElementById("dm-interest");
    if (interest) interest.innerHTML = _dmInterestHtml(lot.name);
  }
  const chips = document.getElementById("dm-feedchips");
  if (chips) chips.innerHTML = _dmFeedChips();
}

function wireDraftMode() {
  document.getElementById("dm-exit")?.addEventListener("click", () => setDraftMode(false));
  document.getElementById("dm-debrief")?.addEventListener("click", () => { if (typeof openDebrief === "function") openDebrief(); });
  // Kick the AI injury-return estimate for the player on the clock (if hurt).
  const otcName = document.getElementById("dm-otc")?.getAttribute("data-player");
  if (otcName && typeof wirePlayerNewsBlock === "function") wirePlayerNewsBlock(otcName);
  document.querySelectorAll("[data-dm-mode]").forEach(b => b.addEventListener("click", () => {
    _dmState.boardMode = b.dataset.dmMode;
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
  document.querySelectorAll("#view-root .player-name").forEach(el => el.addEventListener("click", () => openNoteEditor(el.dataset.player)));
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
  if (typeof wireNominationsPanel === "function") wireNominationsPanel(renderDraft);
  if (typeof wireAiPanel === "function") wireAiPanel();
}
