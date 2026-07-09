// Nomination strategy assistant. Suggests who to nominate based on:
//   - Current phase of draft (open / middle / endgame)
//   - Your filled positions vs. opponents' open positions ("drain" mode)
//   - High-volume players you don't want (dump nominations)
//   - Endgame blockers (drain final dollars to set your $1 buys free)
//
// Surfaced both in the Live Draft view (during the auction) and as a
// pre-draft list on the Overview / Mock pages.

// Compute remaining-need profile for every team. Higher = more open slots and
// positions. Used to decide who's hurt by which nomination.
function teamOpenSlotProfile() {
  const profile = {};
  const test = (typeof draftTestMode === "function") && draftTestMode();
  const selections = test ? {} : getKeeperSelections();
  const teams = (typeof draftTeams === "function") ? draftTeams() : LEAGUE.teams;
  for (const t of teams) {
    const sel = selections[t.id] || {};
    const kept = Object.entries(sel).filter(([_, f]) => f.keeper).map(([n]) => n);
    const posCounts = {};
    for (const name of kept) {
      const val = getPlayerValue(name);
      if (!val) continue;
      posCounts[val.posKey] = (posCounts[val.posKey] || 0) + 1;
    }
    profile[t.id] = {
      teamId: t.id,
      keptCount: kept.length,
      slotsOpen: LEAGUE.rosterSize - kept.length,
      posCounts,
      // "Open need" per position
      openNeed: {},
    };
    for (const pos of ["C", "1B", "2B", "SS", "3B", "OF", "SP", "RP"]) {
      const target = pos === "OF" ? 5 : pos === "SP" ? 6 : pos === "RP" ? 3 : 1;
      profile[t.id].openNeed[pos] = Math.max(0, target - (posCounts[pos] || 0));
    }
  }
  return profile;
}

// Draft-day nomination goals. Each goal selects and re-ranks a different slice
// of the candidate set. "all" is the legacy blended list (drain > dump > blocker).
const NOM_GOALS = [
  { id: "all",       label: "All",            kinds: null },
  { id: "getmyguy",  label: "Get my guy",     kinds: ["target"] },
  { id: "drain",     label: "Drain a rival",  kinds: ["drain", "dump"] },
  { id: "run",       label: "Start a run",    kinds: ["run"] },
  { id: "dump",      label: "Dump overvalued", kinds: ["overvalue"] },
  { id: "burn",      label: "Burn clock",     kinds: ["burn"] },
];
let _nomGoal = "all";
function getNomGoal() { return _nomGoal; }
function setNomGoal(g) { _nomGoal = NOM_GOALS.some(x => x.id === g) ? g : "all"; }

// Builds a ranked nomination list. opts.goal (see NOM_GOALS) selects which
// tactical slice to surface; without it, the legacy blended list is returned.
function suggestNominations(opts) {
  opts = opts || {};
  const goal = opts.goal || null;
  const me = (typeof getMyDraftTeam === "function") ? getMyDraftTeam() : getMyTeam();
  if (!me) return [];
  const myProfile = teamOpenSlotProfile()[me.id];
  const values = getValues();
  if (!values.length) return [];

  // Off the board = predicted keepers + every MiL-rostered player (stashed or
  // called up) — normalized names so accents/suffixes can't leak one through.
  const _nomNk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const keptNames = (typeof draftExcludedNames === "function")
    ? draftExcludedNames()
    : new Set(collectKeepers().map(k => _nomNk(k.name)));
  const draftedNames = new Set(opts.draftedNames || []);
  const pool = values.filter(p => p.value > 0 && !keptNames.has(_nomNk(p.name)) && !draftedNames.has(p.name));

  const inflation = computeTieredInflation();
  const allOpen = teamOpenSlotProfile();
  // Other teams (not me) — their position needs
  const others = Object.values(allOpen).filter(p => p.teamId !== me.id);

  const suggestions = [];

  // 1. Dump candidates — players I don't need but other teams do want.
  // Look for high-value players at positions I'm full on.
  const myFullPositions = new Set(
    Object.entries(myProfile.openNeed).filter(([_, n]) => n === 0).map(([p]) => p)
  );
  for (const p of pool.slice(0, 50)) {
    if (myFullPositions.has(p.posKey) && p.value >= 18) {
      // Demand level: how many other teams want this position
      const demand = others.filter(o => (o.openNeed[p.posKey] || 0) > 0).length;
      if (demand >= 4) {
        suggestions.push({
          kind: "dump",
          player: p,
          reason: "Position is full for you; " + demand + " other teams still need " + p.posKey,
          drainsTeams: others.filter(o => (o.openNeed[p.posKey] || 0) > 0).length,
          priceTarget: Math.round(inflatedValue(p, inflation)),
        });
      }
    }
  }

  // 2. Drain candidates — players at scarce/contested positions, push opponents
  // who really need them. Different from "dump" because you may not even be full;
  // you're just pricing them out for opponents.
  const scarcePositions = ["C", "SS", "RP"];
  for (const pos of scarcePositions) {
    const top = pool.filter(p => p.posKey === pos).slice(0, 3);
    for (const p of top) {
      const demand = others.filter(o => (o.openNeed[pos] || 0) > 0).length;
      if (demand >= 5 && p.value > 5) {
        // Skip if already suggested
        if (!suggestions.find(s => s.player.name === p.name)) {
          suggestions.push({
            kind: "drain",
            player: p,
            reason: "Scarce position; " + demand + " teams still need " + pos,
            drainsTeams: demand,
            priceTarget: Math.round(inflatedValue(p, inflation)),
          });
        }
      }
    }
  }

  // 3. Blocker candidates — late-draft nominations to drain the last $5-10
  // from a couple of opponents who could compete for your endgame $1 targets.
  // (Most useful once we have live draft state; static list shows top
  // "blocker" candidates by position).
  const blockerCutoff = 10;
  for (const p of pool) {
    if (p.value >= 4 && p.value <= blockerCutoff) {
      const demand = others.filter(o => (o.openNeed[p.posKey] || 0) > 0).length;
      if (demand >= 3 && (myProfile.openNeed[p.posKey] || 0) === 0) {
        if (!suggestions.find(s => s.player.name === p.name)) {
          suggestions.push({
            kind: "blocker",
            player: p,
            reason: "Late-draft drainer; " + demand + " teams need " + p.posKey + " but you don't",
            drainsTeams: demand,
            priceTarget: Math.round(inflatedValue(p, inflation)),
          });
        }
      }
    }
  }

  const has = (name) => suggestions.find(s => s.player.name === name);
  const myOpenPos = new Set(Object.entries(myProfile.openNeed).filter(([_, n]) => n > 0).map(([p]) => p));

  // 4. TARGET ("get my guy") — players you flagged as targets or that fit an
  // open slot and are worth the money. What you nominate to actually buy.
  const flagged = (typeof getFlaggedPlayers === "function") ? new Set(getFlaggedPlayers("target").map(f => _nomNk(f.name || f.key))) : new Set();
  for (const p of pool.slice(0, 120)) {
    const isFlagged = flagged.has(_nomNk(p.name));
    const fits = myOpenPos.has(p.posKey);
    if ((isFlagged || (fits && p.value >= 8)) && !has(p.name)) {
      suggestions.push({
        kind: "target", player: p,
        reason: isFlagged ? "Your flagged target" : "Fits your open " + p.posKey + " · $" + p.value.toFixed(0) + " value",
        drainsTeams: 0, priceTarget: Math.round(inflatedValue(p, inflation)),
      });
    }
  }

  // 5. OVERVALUE ("dump overvalued") — market (NFBC) well above our model, and
  // you don't need the position: nominate to let someone else overpay.
  if (typeof getNfbc === "function") {
    for (const p of pool.slice(0, 120)) {
      const nf = getNfbc(p.name);
      const inf = inflatedValue(p, inflation);
      if (nf && nf.avg != null && nf.avg - inf >= 5 && !myOpenPos.has(p.posKey) && !has(p.name)) {
        suggestions.push({
          kind: "overvalue", player: p,
          reason: "Market $" + nf.avg.toFixed(0) + " vs our $" + inf.toFixed(0) + " — let someone overpay",
          drainsTeams: 0, priceTarget: Math.round(inf), marketDelta: nf.avg - inf,
        });
      }
    }
  }

  // 6. RUN ("start a run") — top available at a contested position; nominating
  // it early gets the position bid up while you decide whether to jump in.
  for (const pos of ["C", "SS", "2B", "3B", "1B", "OF", "SP", "RP"]) {
    const top = pool.filter(p => p.posKey === pos)[0];
    if (!top) continue;
    const demand = others.filter(o => (o.openNeed[pos] || 0) > 0).length;
    if (demand >= 4 && top.value >= 10 && !has(top.name)) {
      suggestions.push({
        kind: "run", player: top,
        reason: "Top " + pos + " left; " + demand + " teams need it — nominating starts a run",
        drainsTeams: demand, priceTarget: Math.round(inflatedValue(top, inflation)),
      });
    }
  }

  // 7. BURN ("burn clock") — cheap filler to run the clock / bleed a $1 off
  // someone without exposing a player you care about.
  for (const p of pool.filter(p => p.value >= 1 && p.value <= 3)) {
    if (myOpenPos.has(p.posKey) || has(p.name)) continue;
    suggestions.push({
      kind: "burn", player: p, reason: "Low-stakes filler — nominate to pass the clock",
      drainsTeams: 0, priceTarget: 1,
    });
    if (suggestions.filter(s => s.kind === "burn").length >= 6) break;
  }

  // Goal filter + re-rank.
  const goalDef = goal ? NOM_GOALS.find(g => g.id === goal) : null;
  let out = suggestions;
  if (goalDef && goalDef.kinds) {
    out = suggestions.filter(s => goalDef.kinds.includes(s.kind));
    if (goal === "getmyguy") out.sort((a, b) => b.player.value - a.player.value);
    else if (goal === "dump") out.sort((a, b) => (b.marketDelta || 0) - (a.marketDelta || 0));
    else out.sort((a, b) => b.drainsTeams - a.drainsTeams || b.player.value - a.player.value);
    return out.slice(0, 20);
  }

  // Legacy blended order: drain > dump > blocker (target/overvalue/run/burn are
  // goal-only, not in the default blend), then by drain count.
  const kindOrder = { drain: 0, dump: 1, blocker: 2 };
  out = suggestions.filter(s => s.kind in kindOrder);
  out.sort((a, b) => {
    if (kindOrder[a.kind] !== kindOrder[b.kind]) return kindOrder[a.kind] - kindOrder[b.kind];
    return b.drainsTeams - a.drainsTeams;
  });
  return out.slice(0, 30);
}

// Helper to render a nomination panel (used inside the Live Draft view and the
// Overview as a sidebar). Returns an HTML string. Includes a goal selector that
// re-ranks the suggestions to the current tactical intent.
function renderNominationsPanel(opts) {
  opts = opts || {};
  const goal = getNomGoal();
  // Pass the live pick list — without it the card suggested already-SOLD
  // players all draft long (P2R2 dress rehearsal F1).
  const drafted = (typeof _liveDraft !== "undefined" && Array.isArray(_liveDraft.picks))
    ? _liveDraft.picks.map(p => p.player) : [];
  const suggestions = suggestNominations({ goal, draftedNames: drafted });

  // Goal selector (buttons wired by the draft views via the .nom-goal class).
  let html = '<div class="nom-goals" style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px;">';
  for (const g of NOM_GOALS) {
    html += '<button class="btn nom-goal ' + (goal === g.id ? 'primary' : 'ghost') + '" data-nom-goal="' + g.id + '" style="padding:2px 8px; font-size:11px;">' + esc(g.label) + '</button>';
  }
  html += '</div>';

  if (!suggestions.length) {
    html += '<div class="muted small">' + (goal === "all"
      ? "Nomination suggestions appear once projections are loaded and your keepers are set."
      : "No strong “" + esc(NOM_GOALS.find(g => g.id === goal)?.label || goal) + "” candidates right now — try another goal.") + '</div>';
    html += _nomTellsBlock();
    return html;
  }
  const colors = { drain: "var(--bad)", dump: "var(--warn)", blocker: "var(--accent)", target: "var(--good)", overvalue: "var(--warn)", run: "var(--accent)", burn: "var(--text-3)" };
  html += '<table style="font-size: 12px;"><thead><tr>';
  html += '<th>Kind</th><th>Player</th><th>Pos</th><th class="num">Target $</th><th>Why</th></tr></thead><tbody>';
  for (const s of suggestions) {
    html += '<tr>';
    html += '<td><span class="kbd" style="color: ' + (colors[s.kind] || "var(--text-2)") + '; font-size: 10px;">' + s.kind.toUpperCase() + '</span></td>';
    html += '<td><span class="nom-pick" data-name="' + esc(s.player.name) + '" style="cursor:pointer;" title="Start auction">' + esc(s.player.name) + '</span></td>';
    html += '<td>' + esc(s.player.posKey) + '</td>';
    html += '<td class="num">$' + s.priceTarget + '</td>';
    html += '<td class="small muted">' + esc(s.reason) + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  html += _nomTellsBlock();
  return html;
}

// Live nomination tells (draft archaeology — north-star §7): owners who chase
// their own nominations or keep hammering one position, read straight from the
// event stream this draft. Empty until enough nominations accumulate.
function _nomTellsBlock() {
  if (typeof nominationTellsSummary !== "function") return '';
  let rows = [];
  try { rows = nominationTellsSummary() || []; } catch (_) { return ''; }
  if (!rows.length) return '';
  let html = '<div class="small" style="margin-top:10px; padding-top:8px; border-top:1px solid var(--border);">';
  html += '<div class="muted" style="margin-bottom:4px;">📡 <b>Nomination tells</b> (this draft)</div>';
  for (const r of rows) {
    html += '<div style="margin-top:2px;"><b>' + esc(r.label) + '</b> <span class="muted">— ' + esc(r.note) + '</span></div>';
  }
  html += '</div>';
  return html;
}

// Wire the goal buttons + click-to-nominate. Call after any render that
// includes renderNominationsPanel(); rerenderFn refreshes the host view.
function wireNominationsPanel(rerenderFn) {
  document.querySelectorAll(".nom-goal").forEach(b => b.addEventListener("click", () => {
    setNomGoal(b.dataset.nomGoal);
    if (typeof rerenderFn === "function") rerenderFn();
  }));
  document.querySelectorAll(".nom-pick").forEach(el => el.addEventListener("click", () => {
    if (typeof startAuction === "function") startAuction(el.dataset.name, 1);
  }));
}
