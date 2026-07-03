// Device sync. Mirrors the app's user-authored localStorage state (settings,
// projections, notes, draft picks, …) to Cloudflare KV via the proxy Worker's
// /sync/* routes, so logging in on another device restores everything.
//
// How it works:
//   - Storage.prototype.setItem/removeItem are patched: writes to whitelisted
//     ud_* keys are queued and pushed (debounced) with a client timestamp.
//   - On sign-in (and when the tab regains focus) we pull /sync/list, apply
//     any key whose cloud timestamp differs from what this device last saw
//     (tracked in ud_sync_meta_v1), and reload once so every module re-reads
//     localStorage naturally. Last write wins; this is a single-user tool.
//   - Auth is the Supabase login token — NOT the proxy key — so a brand-new
//     device can pull its settings (including the proxy key) right after
//     Google sign-in.
//
// Deliberately NOT synced: refetchable caches (league rosters, draft dollars,
// FanGraphs xwOBA) and the auth session itself.

const UD_DEFAULT_PROXY_URL = "https://ultimate-draft-proxy.jwarshafsky.workers.dev";

const SYNC_META_KEY = "ud_sync_meta_v1";

const SYNC_EXACT_KEYS = new Set([
  "ud_settings_v1",
  "ud_proxy_url", "ud_proxy_key", "ud_season", "ud_league_override",
  "ud_player_notes_v1",
  "ud_proj_hitters_v1", "ud_proj_pitchers_v1", "ud_proj_meta_v1",
  "ud_manual_values_v1", "ud_use_manual_values_v1",
  "ud_my_keepers_v1", "ud_my_keepers_src_v1",
  "ud_keeper_inflation_v1",
  "ud_scenarios_v1",
  "ud_saved_mocks_v1",
  "ud_live_draft_v1",
  "ud_lineup_override_v1",
  "ud_standings_brief_v1",
  "ud_nfbc_v1",
  "ud_savant_hit_v1", "ud_savant_pit_v1",
  "ud_owner_aliases_v1",
  "ud_draft_history_v1",
]);
const SYNC_PREFIXES = ["ud_ros_"];   // manual/hosted ROS projection sources

function _syncEligible(key) {
  if (SYNC_EXACT_KEYS.has(key)) return true;
  return SYNC_PREFIXES.some(p => key.startsWith(p));
}

const _cloudSync = {
  user: null,
  dirty: new Set(),       // keys changed locally, awaiting push
  deleted: new Set(),     // keys removed locally, awaiting cloud delete
  pushTimer: null,
  pushing: false,
  pulling: false,
  lastPullAt: 0,
  lastPushAt: 0,
  status: "idle",         // idle | pulling | pushing | ok | error | signed-out
  error: null,
};

// Originals — all sync bookkeeping writes go through these so they never
// re-trigger the patch.
const _udOrigSetItem = Storage.prototype.setItem;
const _udOrigRemoveItem = Storage.prototype.removeItem;

Storage.prototype.setItem = function (key, value) {
  _udOrigSetItem.call(this, key, value);
  if (this === window.localStorage && _syncEligible(key)) {
    _cloudSync.dirty.add(key);
    _cloudSync.deleted.delete(key);
    _syncSchedulePush();
  }
};
Storage.prototype.removeItem = function (key) {
  _udOrigRemoveItem.call(this, key);
  if (this === window.localStorage && _syncEligible(key)) {
    _cloudSync.deleted.add(key);
    _cloudSync.dirty.delete(key);
    _syncSchedulePush();
  }
};

function _syncMeta() {
  try { return JSON.parse(localStorage.getItem(SYNC_META_KEY) || "{}") || {}; }
  catch (e) { return {}; }
}
function _saveSyncMeta(m) {
  try { _udOrigSetItem.call(localStorage, SYNC_META_KEY, JSON.stringify(m)); } catch (e) {}
}

function _syncBaseUrl() {
  const u = (typeof ESPN !== "undefined" && ESPN.proxyUrl) ? ESPN.proxyUrl : UD_DEFAULT_PROXY_URL;
  return u.replace(/\/+$/, "");
}

// Supabase access token for the signed-in user (the Worker verifies it).
async function _syncToken() {
  try {
    const { data } = await supabaseClient.auth.getSession();
    if (data?.session?.access_token) return data.session.access_token;
  } catch (e) {}
  try {
    const raw = JSON.parse(localStorage.getItem("sb-ud-auth-v1") || "null");
    return raw?.access_token || raw?.currentSession?.access_token || null;
  } catch (e) { return null; }
}

function _syncSetStatus(status, error) {
  _cloudSync.status = status;
  _cloudSync.error = error || null;
  if (typeof setStatus === "function") {
    const label = status === "ok" ? "synced"
      : status === "pulling" ? "pulling…"
      : status === "pushing" ? "pushing…"
      : status === "error" ? "error"
      : status === "signed-out" ? "—"
      : status;
    setStatus("sync", label, status === "error" ? "warn" : status === "ok" ? "ok" : "");
  }
  // Live-refresh the Settings card if it's on screen.
  const el = document.getElementById("sync-status-line");
  if (el) el.textContent = getCloudSyncInfo().summary;
}

function _syncSchedulePush(delayMs) {
  if (_cloudSync.pushTimer) clearTimeout(_cloudSync.pushTimer);
  _cloudSync.pushTimer = setTimeout(_syncPush, delayMs != null ? delayMs : 1500);
}

async function _syncPush() {
  _cloudSync.pushTimer = null;
  if (_cloudSync.pushing || !_cloudSync.user) return;
  if (!_cloudSync.dirty.size && !_cloudSync.deleted.size) return;
  const token = await _syncToken();
  if (!token) { _syncSetStatus("signed-out"); return; }
  _cloudSync.pushing = true;
  _syncSetStatus("pushing");
  const base = _syncBaseUrl();
  const headers = { "content-type": "application/json", authorization: "Bearer " + token };
  const meta = _syncMeta();
  let failed = false;
  try {
    for (const key of [..._cloudSync.dirty]) {
      const value = localStorage.getItem(key);
      if (value == null) { _cloudSync.dirty.delete(key); continue; }
      const at = Date.now();
      const r = await fetch(base + "/sync/set", {
        method: "POST", headers, body: JSON.stringify({ key, value, at }),
      });
      if (!r.ok) { failed = true; break; }
      _cloudSync.dirty.delete(key);
      meta[key] = at;
    }
    if (!failed) {
      for (const key of [..._cloudSync.deleted]) {
        const r = await fetch(base + "/sync/delete", {
          method: "POST", headers, body: JSON.stringify({ key }),
        });
        if (!r.ok) { failed = true; break; }
        _cloudSync.deleted.delete(key);
        delete meta[key];
      }
    }
  } catch (e) {
    failed = true;
    _cloudSync.error = e.message || String(e);
  }
  _saveSyncMeta(meta);
  _cloudSync.pushing = false;
  _cloudSync.lastPushAt = Date.now();
  if (failed) {
    _syncSetStatus("error", _cloudSync.error || "push failed");
    _syncSchedulePush(30000);   // retry
  } else {
    _syncSetStatus("ok");
  }
}

// Pull the cloud snapshot and apply anything newer than what this device has.
// Reloads the page once if anything changed (so every module re-reads
// localStorage), unless an auction is mid-flight on the Live Draft tab.
async function syncPullNow(opts) {
  if (_cloudSync.pulling || !_cloudSync.user) return 0;
  const token = await _syncToken();
  if (!token) { _syncSetStatus("signed-out"); return 0; }
  _cloudSync.pulling = true;
  _syncSetStatus("pulling");
  let changed = 0;
  try {
    const base = _syncBaseUrl();
    const headers = { authorization: "Bearer " + token };
    const r = await fetch(base + "/sync/list", { headers });
    if (!r.ok) throw new Error("sync list failed (" + r.status + ")");
    const cloud = (await r.json()).keys || {};
    const meta = _syncMeta();

    // First-run migration: local keys the cloud has never seen → queue push.
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && _syncEligible(k) && !(k in cloud)) _cloudSync.dirty.add(k);
    }

    for (const [key, at] of Object.entries(cloud)) {
      if (!_syncEligible(key)) continue;                                       // never apply unknown keys
      if (_cloudSync.dirty.has(key) || _cloudSync.deleted.has(key)) continue; // local edit pending — it wins
      if (meta[key] === at) continue;                                          // already applied
      // First contact for this key on this device: if a local value already
      // exists, keep it and push it up rather than letting cloud data of
      // unknown age overwrite real local data. After that, last write wins.
      if (!(key in meta) && localStorage.getItem(key) != null) {
        _cloudSync.dirty.add(key);
        continue;
      }
      const g = await fetch(base + "/sync/get?key=" + encodeURIComponent(key), { headers });
      if (!g.ok) continue;
      const body = await g.json();
      if (body.value == null) continue;
      if (localStorage.getItem(key) !== body.value) {
        _udOrigSetItem.call(localStorage, key, body.value);
        changed++;
      }
      meta[key] = at;
    }

    // Keys this device once synced that no longer exist in the cloud were
    // deleted on another device — remove them here too. KV's list is
    // eventually consistent (a just-pushed key can be missing from it for up
    // to ~a minute), so confirm each suspected deletion with a direct get
    // before touching local data.
    for (const key of Object.keys(meta)) {
      if (!(key in cloud) && !_cloudSync.dirty.has(key) && !_cloudSync.deleted.has(key)) {
        const g = await fetch(base + "/sync/get?key=" + encodeURIComponent(key), { headers });
        if (!g.ok) continue;
        const body = await g.json();
        if (body.value != null) { meta[key] = body.at; continue; }  // list was just stale
        if (localStorage.getItem(key) != null) {
          _udOrigRemoveItem.call(localStorage, key);
          changed++;
        }
        delete meta[key];
      }
    }

    _saveSyncMeta(meta);
    _cloudSync.lastPullAt = Date.now();
    _syncSetStatus("ok");
  } catch (e) {
    _syncSetStatus("error", e.message || String(e));
  }
  _cloudSync.pulling = false;

  if (_cloudSync.dirty.size || _cloudSync.deleted.size) _syncSchedulePush(0);

  if (changed && (!opts || opts.reloadOnChange !== false)) {
    const auctionLive = (typeof _liveDraft !== "undefined") && _liveDraft.current;
    if (!auctionLive) location.reload();
  }
  return changed;
}

// For the Settings card / debugging.
function getCloudSyncInfo() {
  const fmt = (t) => t ? new Date(t).toLocaleTimeString() : "never";
  const state = !_cloudSync.user ? "signed out"
    : _cloudSync.status === "error" ? ("error: " + (_cloudSync.error || "unknown"))
    : _cloudSync.status;
  return {
    ..._cloudSync,
    summary: "Status: " + state + " · last pull " + fmt(_cloudSync.lastPullAt) +
      " · last push " + fmt(_cloudSync.lastPushAt) +
      (_cloudSync.dirty.size ? " · " + _cloudSync.dirty.size + " pending" : ""),
  };
}

function _initCloudSync() {
  onAuthChange((user) => {
    const wasSignedOut = !_cloudSync.user;
    _cloudSync.user = user;
    if (user && wasSignedOut) syncPullNow();
    if (!user) _syncSetStatus("signed-out");
  });
  // Coming back to the tab after using another device → pick up its changes.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && _cloudSync.user &&
        Date.now() - _cloudSync.lastPullAt > 30000) {
      syncPullNow();
    }
  });
  // Flush pending pushes when leaving (best effort; debounce may be waiting).
  window.addEventListener("pagehide", () => {
    if (_cloudSync.dirty.size || _cloudSync.deleted.size) _syncPush();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _initCloudSync);
} else {
  _initCloudSync();
}
