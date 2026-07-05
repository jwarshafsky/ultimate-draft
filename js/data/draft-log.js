// Draft log — mirrors the live draft-room event stream (from the Keeper Edge
// extension) to Supabase, permanently. This is the database behind the owner-
// tendency analysis: every nomination, bid, pass, and sale, with timestamps.
//
// Tables (see supabase/2026-07-04-draft-capture.sql):
//   draft_sessions — one row per draft/mock, upserted by client_key
//                    ("<leagueId>:<startedAt>", device-independent so a reload
//                    or second device can't create a duplicate session)
//   draft_events   — the raw stream, PK (session_id, seq) so re-uploads after
//                    an app reload are idempotent (upsert, ignore duplicates)
//
// Design: never block or break the draft UI. Events queue in memory, flush in
// batches every ~2.5s; failures keep the queue and retry with backoff; status
// is surfaced in the Live Pick Feed diagnostics panel. Uploaded progress is
// remembered per session in localStorage so a reload doesn't re-post the
// whole log (re-posting would be harmless, just wasteful).

const DRAFT_LOG = {
  sessionId: null,
  clientKey: null,
  meta: null,             // { leagueId, sport, startedAt }
  isMock: true,
  queue: [],
  uploadedSeq: 0,
  uploadedCount: 0,
  lastError: null,
  flushing: false,
  timer: null,
  backoffUntil: 0,
};

const _DL_SESSIONS_KEY = "ud_draft_sessions_v1";   // { clientKey: {id, uploadedSeq} } — local cache, NOT device-synced (client_key upsert makes cross-device safe)

function _dlSessionCache() {
  try { return JSON.parse(localStorage.getItem(_DL_SESSIONS_KEY) || "{}") || {}; } catch (e) { return {}; }
}
function _dlSaveSessionCache(cache) {
  try { localStorage.setItem(_DL_SESSIONS_KEY, JSON.stringify(cache)); } catch (e) {}
}

// Queue events for upload. meta identifies the session; events are the bridge's
// event objects ({seq, at, cmd, teamId, playerId, amount, text}).
function logDraftEvents(meta, events, isMock) {
  if (!meta || !meta.leagueId || !meta.startedAt || !Array.isArray(events) || !events.length) return;
  const key = String(meta.leagueId) + ":" + String(meta.startedAt);
  if (DRAFT_LOG.clientKey !== key) {
    // New session — reset state, pick up any previously-uploaded watermark.
    DRAFT_LOG.clientKey = key;
    DRAFT_LOG.meta = { leagueId: String(meta.leagueId), sport: meta.sport || null, startedAt: meta.startedAt };
    DRAFT_LOG.sessionId = null;
    DRAFT_LOG.queue = [];
    DRAFT_LOG.uploadedCount = 0;
    DRAFT_LOG.lastError = null;
    const cached = _dlSessionCache()[key];
    DRAFT_LOG.sessionId = cached?.id || null;
    DRAFT_LOG.uploadedSeq = cached?.uploadedSeq || 0;
  }
  const wasMock = DRAFT_LOG.isMock;
  DRAFT_LOG.isMock = !!isMock;
  // Mode flipped mid-session (e.g. test → real): fix the session row, or the
  // real draft gets permanently mislabeled as a mock in the tendency DB.
  if (DRAFT_LOG.sessionId && wasMock !== DRAFT_LOG.isMock && typeof supabaseClient !== "undefined") {
    supabaseClient.from("draft_sessions").update({ is_mock: DRAFT_LOG.isMock }).eq("id", DRAFT_LOG.sessionId)
      .then(() => {}, () => {});
  }
  for (const e of events) {
    if (!e || e.seq == null || e.seq <= DRAFT_LOG.uploadedSeq) continue;
    DRAFT_LOG.queue.push(e);
  }
  if (DRAFT_LOG.queue.length > 20000) DRAFT_LOG.queue.splice(0, DRAFT_LOG.queue.length - 20000);
  _dlSchedule();
}

function _dlSchedule() {
  if (DRAFT_LOG.timer || !DRAFT_LOG.queue.length) return;
  DRAFT_LOG.timer = setTimeout(() => { DRAFT_LOG.timer = null; _dlFlush(); }, 2500);
}

async function _dlEnsureSession() {
  if (DRAFT_LOG.sessionId) return DRAFT_LOG.sessionId;
  const m = DRAFT_LOG.meta;
  const started = new Date(m.startedAt);
  const { data, error } = await supabaseClient
    .from("draft_sessions")
    .upsert({
      client_key: DRAFT_LOG.clientKey,
      league_id: m.leagueId,
      sport: m.sport,
      season: started.getFullYear(),
      is_mock: DRAFT_LOG.isMock,
      label: (m.sport === "ffl" ? "football" : "baseball") + " " + (DRAFT_LOG.isMock ? "mock" : "DRAFT") + " " + started.toISOString().slice(0, 10),
      started_at: started.toISOString(),
    }, { onConflict: "client_key" })
    .select("id")
    .single();
  if (error) throw error;
  DRAFT_LOG.sessionId = data.id;
  const cache = _dlSessionCache();
  cache[DRAFT_LOG.clientKey] = Object.assign({}, cache[DRAFT_LOG.clientKey], { id: data.id });
  _dlSaveSessionCache(cache);
  return data.id;
}

async function _dlFlush() {
  if (DRAFT_LOG.flushing || !DRAFT_LOG.queue.length) return;
  if (Date.now() < DRAFT_LOG.backoffUntil) { DRAFT_LOG.timer = setTimeout(() => { DRAFT_LOG.timer = null; _dlFlush(); }, 5000); return; }
  if (typeof supabaseClient === "undefined" || typeof currentUser === "undefined" || !currentUser) { _dlSchedule(); return; }
  DRAFT_LOG.flushing = true;
  try {
    const sessionId = await _dlEnsureSession();
    const batch = DRAFT_LOG.queue.slice(0, 500);
    const rows = batch.map(e => ({
      session_id: sessionId,
      seq: e.seq,
      cmd: String(e.cmd || "?").slice(0, 24),
      espn_team_id: Number.isFinite(e.teamId) ? e.teamId : null,
      espn_player_id: Number.isFinite(e.playerId) ? e.playerId : null,
      amount: Number.isFinite(e.amount) ? e.amount : null,
      raw: (e.text || "").slice(0, 300) || null,
      captured_at: e.at ? new Date(e.at).toISOString() : null,
    }));
    const { error } = await supabaseClient
      .from("draft_events")
      .upsert(rows, { onConflict: "session_id,seq", ignoreDuplicates: true });
    if (error) throw error;
    DRAFT_LOG.queue.splice(0, batch.length);
    DRAFT_LOG.uploadedCount += batch.length;
    DRAFT_LOG.uploadedSeq = Math.max(DRAFT_LOG.uploadedSeq, ...batch.map(e => e.seq || 0));
    DRAFT_LOG.lastError = null;
    const cache = _dlSessionCache();
    cache[DRAFT_LOG.clientKey] = Object.assign({}, cache[DRAFT_LOG.clientKey], { id: sessionId, uploadedSeq: DRAFT_LOG.uploadedSeq });
    _dlSaveSessionCache(cache);
  } catch (e) {
    DRAFT_LOG.lastError = e?.message || String(e);
    DRAFT_LOG.backoffUntil = Date.now() + 15000;
    console.warn("[draft-log] upload failed (will retry):", DRAFT_LOG.lastError);
  } finally {
    DRAFT_LOG.flushing = false;
    if (DRAFT_LOG.queue.length) _dlSchedule();
    if (typeof updateDraftDiagnostics === "function") updateDraftDiagnostics();
  }
}

// Status for the diagnostics panel.
function draftLogStatus() {
  return {
    sessionId: DRAFT_LOG.sessionId,
    clientKey: DRAFT_LOG.clientKey,
    isMock: DRAFT_LOG.isMock,
    uploaded: DRAFT_LOG.uploadedCount,
    uploadedSeq: DRAFT_LOG.uploadedSeq,
    pending: DRAFT_LOG.queue.length,
    lastError: DRAFT_LOG.lastError,
  };
}
