// Draft invariant checker — the continuous self-audit. Runs in-app (surfaced in
// the feed diagnostics panel) and in tests (asserted after every simulated
// pick). checkDraftInvariants() recomputes the money/pool/feed/mode/UI
// invariants from live state and returns a list of violations; it NEVER throws
// (every external call is behind a typeof guard and wrapped so a missing global
// or a malformed object degrades to a skipped check, not a crash on draft day).
//
// Violation shape: { id, severity: "error"|"warn", detail }.
//   error = something that could lose/mis-attribute a pick or show a wrong,
//           actionable number (budget/max bid/pool/mode leak).
//   warn  = a soft anomaly (a legitimately-overspent team, a SOLD event with no
//           matching pick yet) that merits a look but isn't necessarily a bug.
//
// Invariant families (see docs/live-draft-perfection-plan.md Phase 1b):
//   I-MONEY  — per-team budget/maxBid identities + spend conservation
//   I-POOL   — drafted/excluded/available partition getValues()
//   I-FEED   — event seqs increasing; SOLD ↔ pick (or tombstone); no dup pickId
//   I-MODE   — in test mode, no real owner id/name leaks into any draft output
//   I-UI     — no duplicate DOM ids inside #view-root

// Small local helpers — kept file-local (underscore-prefixed, unique names) so
// they can't collide with the app's own globals under the shared scope.
function _invNk(s) {
  return (typeof normalizePlayerName === "function")
    ? normalizePlayerName(s)
    : String(s || "").toLowerCase();
}

// Run fn(); on any throw return `fallback` instead of propagating. Used to wrap
// every call into app code so a single bad object can't take down the audit.
function _invSafe(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

// The 12 real owner display strings — used by I-MODE to detect real-league
// contamination in test mode. Whole-value comparison only (never substring).
const _INV_REAL_OWNER_NAMES = [
  "Jeff", "AJ", "Matt", "Sam", "Saxton", "Glix", "Corey", "JD", "Wein",
  "Klin", "Dave", "JTL",
  // The LEAGUE.teams owner display names differ from the id tokens above; guard
  // both so either representation leaking is caught.
  "Glicksmans", "Josh/Doug", "Larry", "Klinger", "Jesse",
];
const _INV_REAL_OWNER_IDS = [
  "jeff", "aj", "matt", "sam", "saxton", "glix", "corey", "jd", "wein",
  "klin", "dave", "jtl",
];

// ---------------------------------------------------------------------------
// I-MONEY — budget/maxBid identities + spend conservation.
// For each team in the CURRENT draft context:
//   base   = 260 + adj (real) | 260 (test)
//   budget = base − keeperCost − spent
//   maxBid = max(0, budget − max(0, slotsRemaining − 1))
// and Σ spent across teams === Σ pick prices.
function _invCheckMoney(v) {
  const states = _invSafe(() =>
    (typeof computeLiveTeamStates === "function") ? computeLiveTeamStates() : null, null);
  if (!states) return;   // engine not loaded — skip, don't fail
  const test = _invSafe(() => (typeof draftTestMode === "function") && draftTestMode(), false);
  const draftBudget = _invSafe(() => LEAGUE.draftBudget, 260) || 260;
  const rosterSize = _invSafe(() => LEAGUE.rosterSize, 26) || 26;

  let sumSpent = 0;
  for (const st of Object.values(states)) {
    if (!st) continue;
    const adj = test ? 0 : _invSafe(() =>
      (typeof getBudgetAdjustment === "function") ? (getBudgetAdjustment(st.teamId) || 0) : 0, 0);
    const base = draftBudget + adj;
    const spent = Number(st.spent) || 0;
    const keptCost = Number(st.keptCost) || 0;
    sumSpent += spent;

    // budget identity
    const expectBudget = base - keptCost - spent;
    if (st.budget !== expectBudget) {
      v.push({
        id: "I-MONEY", severity: "error",
        detail: (st.ownerName || st.teamId) + ": budget " + st.budget +
          " != base(" + base + ") − keepers(" + keptCost + ") − spent(" + spent + ") = " + expectBudget,
      });
    }

    // maxBid identity
    const slotsRem = Number(st.slotsRemaining) || 0;
    const expectMax = Math.max(0, st.budget - Math.max(0, slotsRem - 1));
    if (st.maxBid !== expectMax) {
      v.push({
        id: "I-MONEY", severity: "error",
        detail: (st.ownerName || st.teamId) + ": maxBid " + st.maxBid +
          " != max(0, budget(" + st.budget + ") − (slotsRemaining(" + slotsRem + ")−1)) = " + expectMax,
      });
    }

    // Negative budget: a warn if spend legitimately exceeds base (overspend the
    // app allows via confirm-through), an error if the numbers are impossible.
    if (st.budget < 0) {
      const legitOverspend = spent > (base - keptCost);
      v.push({
        id: "I-MONEY", severity: legitOverspend ? "warn" : "error",
        detail: (st.ownerName || st.teamId) + ": negative budget " + st.budget +
          (legitOverspend ? " (spent $" + spent + " exceeds $" + (base - keptCost) + " available — overspent)" : ""),
      });
    }
    if (st.maxBid < 0) {
      v.push({
        id: "I-MONEY", severity: "error",
        detail: (st.ownerName || st.teamId) + ": negative maxBid " + st.maxBid,
      });
    }
    // Roster overfilled — more keepers + picks than roster slots.
    if (slotsRem < 0) {
      v.push({
        id: "I-MONEY", severity: "warn",
        detail: (st.ownerName || st.teamId) + ": slotsRemaining " + slotsRem +
          " (keepers+picks exceed rosterSize " + rosterSize + ")",
      });
    }
  }

  // Σ spent across teams === Σ pick prices. (Picks not attributable to any
  // team in the context still count in the pick total; a mismatch flags picks
  // that fell off the team ledger — a mis-attribution.)
  const picks = _invSafe(() =>
    (typeof _liveDraft !== "undefined" && Array.isArray(_liveDraft.picks)) ? _liveDraft.picks : [], []);
  const sumPickPrice = picks.reduce((s, p) => s + (Number(p.price) || 0), 0);
  if (sumSpent !== sumPickPrice) {
    v.push({
      id: "I-MONEY", severity: "error",
      detail: "Σ team spent ($" + sumSpent + ") != Σ pick prices ($" + sumPickPrice +
        ") — $" + (sumPickPrice - sumSpent) + " of picks not attributed to a context team",
    });
  }
}

// ---------------------------------------------------------------------------
// I-POOL — drafted / excluded / available partition getValues().
//   available = values − drafted − excluded   (defined, not asserted)
// Violations:
//   - drafted ∩ excluded nonempty (a name is both taken and a keeper)
//   - a pick for a player currently in the excluded (keeper) set = error
//   - picks count > numTeams × rosterSize
function _invCheckPool(v) {
  const values = _invSafe(() => (typeof getValues === "function") ? getValues() : null, null);
  const picks = _invSafe(() =>
    (typeof _liveDraft !== "undefined" && Array.isArray(_liveDraft.picks)) ? _liveDraft.picks : [], []);
  const excluded = _invSafe(() =>
    (typeof draftExcludedNames === "function") ? draftExcludedNames() : new Set(), new Set());

  const draftedNames = new Set(picks.map(p => _invNk(p.player)));

  // drafted ∩ excluded — a name can't be both a completed pick and an
  // off-the-board keeper (kept players aren't auctionable).
  for (const name of draftedNames) {
    if (excluded.has(name)) {
      v.push({
        id: "I-POOL", severity: "error",
        detail: 'player "' + name + '" is both drafted and in the excluded (keeper) set',
      });
    }
  }

  // A pick whose name is in the excluded set = a kept player was drafted.
  // (Same root cause as above but reported per-pick with the price for repro.)
  for (const pk of picks) {
    if (excluded.has(_invNk(pk.player))) {
      v.push({
        id: "I-POOL", severity: "error",
        detail: 'kept player "' + pk.player + '" was drafted (price $' + (pk.price != null ? pk.price : "?") + ")",
      });
    }
  }

  // Overlap sanity within the value pool: no name should be counted in two
  // partitions. available is DEFINED as values−drafted−excluded, so the only
  // possible overlap is drafted∩excluded (checked above); we additionally flag
  // any drafted-or-excluded name that isn't even in the value pool as info-free
  // (that's legal — a ghost/manual pick — so no violation), keeping the
  // partition precise.
  if (values) {
    const maxPicks = _invSafe(() =>
      (LEAGUE.numTeams || 12) * (LEAGUE.rosterSize || 26), 12 * 26);
    if (picks.length > maxPicks) {
      v.push({
        id: "I-POOL", severity: "error",
        detail: "picks count " + picks.length + " exceeds numTeams×rosterSize (" + maxPicks + ")",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// I-FEED — event-stream + pick integrity.
//   - _dlog.events seqs strictly increasing
//   - every SOLD event playerId with no matching pick AND no tombstone → warn
//   - duplicate espnPlayerId among picks → error
function _invCheckFeed(v) {
  const events = _invSafe(() =>
    (typeof _dlog !== "undefined" && Array.isArray(_dlog.events)) ? _dlog.events : [], []);
  const picks = _invSafe(() =>
    (typeof _liveDraft !== "undefined" && Array.isArray(_liveDraft.picks)) ? _liveDraft.picks : [], []);
  const deleted = _invSafe(() =>
    (typeof _liveDraft !== "undefined" && _liveDraft.deleted) ? _liveDraft.deleted : {}, {});

  // Seqs strictly increasing (per the current session — _dlog is one session).
  let lastSeq = null;
  for (const e of events) {
    if (!e || e.seq == null) continue;
    if (lastSeq != null && !(e.seq > lastSeq)) {
      v.push({
        id: "I-FEED", severity: "error",
        detail: "event seq not strictly increasing: " + e.seq + " follows " + lastSeq +
          " (cmd " + (e.cmd || "?") + ")",
      });
    }
    if (e.seq != null) lastSeq = e.seq;
  }

  // Duplicate espnPlayerId among held picks — the pipeline dedups by playerId,
  // so two live picks for one player means dedup failed (a lost/doubled pick).
  const seenPid = new Set();
  for (const pk of picks) {
    if (pk.espnPlayerId == null) continue;
    if (seenPid.has(pk.espnPlayerId)) {
      v.push({
        id: "I-FEED", severity: "error",
        detail: "duplicate espnPlayerId " + pk.espnPlayerId + " among held picks (dedup failed)",
      });
    }
    seenPid.add(pk.espnPlayerId);
  }

  // Auction minimum is $1 — a pick priced below that is a parse gap or a bad
  // manual entry ($0 exists only on keeper contracts, never sale prices).
  for (const pk of picks) {
    if (!(pk.price >= 1)) {
      v.push({
        id: "I-FEED", severity: "warn",
        detail: "pick '" + (pk.player || pk.espnPlayerId) + "' priced $" + pk.price + " — below the $1 auction minimum (parse gap?)",
      });
    }
  }

  // Every SOLD event should map to a held pick (by playerId) OR a tombstone
  // (deleted via commissioner undo). A SOLD with neither is a missing pick.
  // Only judged for events carrying a playerId. A later SOLD of the same
  // player (re-sale) reuses the id, so a held pick for it satisfies the check.
  const heldPids = new Set(picks.filter(p => p.espnPlayerId != null).map(p => p.espnPlayerId));
  const soldPids = new Set();
  for (const e of events) {
    if (!e || e.cmd !== "SOLD" || e.playerId == null) continue;
    soldPids.add(e.playerId);
  }
  for (const pid of soldPids) {
    const hasPick = heldPids.has(pid);
    const hasTomb = Object.prototype.hasOwnProperty.call(deleted, pid) ||
      Object.prototype.hasOwnProperty.call(deleted, String(pid));
    if (!hasPick && !hasTomb) {
      v.push({
        id: "I-FEED", severity: "warn",
        detail: "SOLD event for playerId " + pid + " has no matching pick and no tombstone (missing pick)",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// I-MODE — in test mode, NO draft-context output may carry a real owner id or
// name. We compare against the TEAM OBJECT FIELDS (owner / ownerName / owner
// id) of the states/teams — never against raw JSON of the whole payload —
// because a player's name might legitimately contain "Sam", "Matt", etc. The
// AI context is scanned defensively (its own team-identity fields only).
function _invCheckMode(v) {
  const test = _invSafe(() => (typeof draftTestMode === "function") && draftTestMode(), false);
  if (!test) return;   // real mode legitimately carries real owners

  const realNames = new Set(_INV_REAL_OWNER_NAMES.map(s => s.toLowerCase()));
  const realIds = new Set(_INV_REAL_OWNER_IDS);

  // Flag a value if it equals a real owner name (whole-value, case-insensitive)
  // or a real owner id token. `where` names the field for the repro.
  const flagValue = (val, where) => {
    if (val == null) return;
    const s = String(val);
    if (realNames.has(s.toLowerCase())) {
      v.push({ id: "I-MODE", severity: "error", detail: "test mode leak: real owner name \"" + s + "\" in " + where });
    } else if (realIds.has(s)) {
      v.push({ id: "I-MODE", severity: "error", detail: "test mode leak: real owner id \"" + s + "\" in " + where });
    }
  };

  // Team objects (draftTeams) — id/owner/ownerName/name fields.
  const teams = _invSafe(() =>
    (typeof draftTeams === "function") ? draftTeams() : [], []);
  for (const t of teams) {
    if (!t) continue;
    flagValue(t.id, "draftTeams[].id");
    flagValue(t.owner, "draftTeams[].owner");
    flagValue(t.ownerName, "draftTeams[].ownerName");
    flagValue(t.name, "draftTeams[].name");
  }

  // Team states — teamId/ownerName/teamName fields.
  const states = _invSafe(() =>
    (typeof computeLiveTeamStates === "function") ? computeLiveTeamStates() : {}, {});
  for (const st of Object.values(states)) {
    if (!st) continue;
    flagValue(st.teamId, "teamState.teamId");
    flagValue(st.ownerName, "teamState.ownerName");
    flagValue(st.teamName, "teamState.teamName");
  }

  // Picks — a pick's `team` field must be an "espn:N" id in test mode, never a
  // real owner id token.
  const picks = _invSafe(() =>
    (typeof _liveDraft !== "undefined" && Array.isArray(_liveDraft.picks)) ? _liveDraft.picks : [], []);
  for (const pk of picks) {
    if (!pk) continue;
    flagValue(pk.team, "pick.team");
  }

  // AI context — scan only its identity-bearing fields, and only if buildAiContext
  // is loaded. Wrapped so a throwing/absent builder can't fail the audit.
  const ctx = _invSafe(() =>
    (typeof buildAiContext === "function") ? buildAiContext() : null, null);
  if (ctx && typeof ctx === "object") {
    flagValue(ctx.myTeam, "aiContext.myTeam");
    flagValue(ctx.myTeamId, "aiContext.myTeamId");
    if (ctx.me && typeof ctx.me === "object") {
      flagValue(ctx.me.id, "aiContext.me.id");
      flagValue(ctx.me.owner, "aiContext.me.owner");
      flagValue(ctx.me.ownerName, "aiContext.me.ownerName");
    }
    // If the context enumerates teams, scan each team's identity fields.
    if (Array.isArray(ctx.teams)) {
      for (const t of ctx.teams) {
        if (!t) continue;
        flagValue(t.id, "aiContext.teams[].id");
        flagValue(t.owner, "aiContext.teams[].owner");
        flagValue(t.ownerName, "aiContext.teams[].ownerName");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// I-UI — no duplicate DOM ids inside #view-root (a rebuilt-innerHTML view that
// emits the same id twice breaks id-based wiring silently). Guarded for the
// no-DOM (headless test) environment.
function _invCheckUi(v) {
  if (typeof document === "undefined" || !document || typeof document.querySelectorAll !== "function") return;
  const root = _invSafe(() => document.getElementById("view-root"), null);
  if (!root || typeof root.querySelectorAll !== "function") return;
  const seen = new Set(), dup = new Set();
  const nodes = _invSafe(() => root.querySelectorAll("[id]"), []);
  nodes.forEach(el => {
    const id = el && el.id;
    if (!id) return;
    if (seen.has(id)) dup.add(id);
    seen.add(id);
  });
  for (const id of dup) {
    v.push({ id: "I-UI", severity: "error", detail: 'duplicate DOM id "' + id + '" inside #view-root' });
  }
}

// ---------------------------------------------------------------------------
// Public: run every family and return the collected violations. Never throws —
// each family is wrapped so a bug in one check can't hide the others.
function checkDraftInvariants() {
  const violations = [];
  _invSafe(() => _invCheckMoney(violations));
  _invSafe(() => _invCheckPool(violations));
  _invSafe(() => _invCheckFeed(violations));
  _invSafe(() => _invCheckMode(violations));
  _invSafe(() => _invCheckUi(violations));

  const counts = { error: 0, warn: 0 };
  for (const x of violations) {
    if (x && x.severity === "error") counts.error++;
    else if (x && x.severity === "warn") counts.warn++;
  }
  return { violations, checkedAt: Date.now(), counts };
}

// Public: short HTML line for the diagnostics panel. Green when clean, amber
// when only warns, red when any error. Lists up to three violation ids.
function renderInvariantsLine() {
  const _esc = (typeof esc === "function") ? esc : (s => String(s == null ? "" : s));
  const res = _invSafe(() => checkDraftInvariants(), null);
  if (!res) return '<span class="muted">invariants: (unavailable)</span>';
  const { violations, counts } = res;
  const nChecks = 5;   // MONEY / POOL / FEED / MODE / UI
  if (!violations.length) {
    return '<span style="color:var(--good);">✅ invariants ok</span> ' +
      '<span class="muted">(' + nChecks + ' checks)</span>';
  }
  // Order errors first, then warns; summarize the leading few.
  const sorted = violations.slice().sort((a, b) =>
    (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1));
  const lead = sorted.slice(0, 3)
    .map(x => x.id + " — " + String(x.detail || "").slice(0, 90))
    .join("; ");
  const anyError = counts.error > 0;
  const icon = anyError ? "⚠" : "△";
  const color = anyError ? "var(--bad)" : "var(--warn)";
  const n = violations.length;
  return '<span style="color:' + color + ';">' + icon + ' ' + n + ' violation' + (n === 1 ? '' : 's') +
    '</span> <span class="muted">(' + counts.error + ' err, ' + counts.warn + ' warn): ' + _esc(lead) + '</span>';
}

// Node/test export (no-op in the browser where `module` is undefined).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { checkDraftInvariants, renderInvariantsLine };
}
