// Supabase client + auth gate. Connects to The League App's Supabase project
// so we read live keeper/roster/trade data without duplicating it.

const SUPABASE_URL = "https://fbllfkrtjsihrkwnbmlw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_aRh0MmQKrMCr8YnTwv9xIg_1F08WXf2";
const ALLOWED_EMAILS = ["jwarshafsky@gmail.com"];

// Use a unique storage key so we don't collide with The League App (which
// also lives on jwarshafsky.github.io and shares localStorage). Implicit
// flow matches the existing Supabase OAuth redirect URL allow-list.
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "implicit",
    storageKey: "sb-ud-auth-v1",
  },
});

let currentUser = null;
const authListeners = [];

function onAuthChange(fn) {
  authListeners.push(fn);
  fn(currentUser);
}

function fireAuth() {
  authListeners.forEach(fn => { try { fn(currentUser); } catch (e) { console.error(e); } });
}

function isEmailAllowed(email) {
  return ALLOWED_EMAILS.map(e => e.toLowerCase()).includes(String(email || "").toLowerCase());
}

async function refreshAuthState() {
  try {
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) console.warn("[auth] getSession error:", error);
    console.log("[auth] getSession ->", session ? { user: session.user?.email, expires: new Date((session.expires_at||0)*1000).toISOString() } : null);
    if (session && session.user && isEmailAllowed(session.user.email)) {
      currentUser = { id: session.user.id, email: session.user.email };
      fireAuth();
      return;
    }
    // Fallback: try to restore from localStorage directly. supabase-js sometimes
    // returns null on first getSession call before it has finished reading
    // storage; if our stored token is valid, trust it.
    try {
      const raw = localStorage.getItem("sb-ud-auth-v1");
      if (raw) {
        const parsed = JSON.parse(raw);
        const u = parsed?.user || parsed?.currentSession?.user;
        const exp = parsed?.expires_at || parsed?.currentSession?.expires_at;
        if (u?.email && isEmailAllowed(u.email)) {
          // Check expiry — if expired, ask Supabase to refresh.
          const now = Math.floor(Date.now() / 1000);
          if (exp && exp > now) {
            console.log("[auth] restored from localStorage");
            currentUser = { id: u.id, email: u.email };
            fireAuth();
            return;
          }
          // Token is expired — try refresh
          console.log("[auth] token expired, refreshing");
          const refreshed = await supabaseClient.auth.refreshSession();
          if (refreshed?.data?.session?.user && isEmailAllowed(refreshed.data.session.user.email)) {
            currentUser = { id: refreshed.data.session.user.id, email: refreshed.data.session.user.email };
            fireAuth();
            return;
          }
        }
      }
    } catch (e) {
      console.warn("[auth] storage fallback failed:", e);
    }
    if (session && session.user && !isEmailAllowed(session.user.email)) {
      await supabaseClient.auth.signOut();
      showAuthMsg("This account isn't authorized.", "err");
    }
    currentUser = null;
    fireAuth();
  } catch (e) {
    console.error("[auth] refreshAuthState failed:", e);
    currentUser = null;
    fireAuth();
  }
}

async function signInGoogle() {
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) showAuthMsg(error.message, "err");
}

async function sendMagicLink(email) {
  const cleaned = (email || "").trim().toLowerCase();
  if (!isEmailAllowed(cleaned)) {
    showAuthMsg("Not authorized.", "err");
    return;
  }
  const { error } = await supabaseClient.auth.signInWithOtp({
    email: cleaned,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) showAuthMsg(error.message, "err");
  else showAuthMsg("Check your email for the sign-in link.", "ok");
}

async function signOut() {
  await supabaseClient.auth.signOut();
}

function showAuthMsg(text, kind) {
  const el = document.getElementById("auth-msg");
  if (!el) return;
  el.textContent = text;
  el.className = "auth-msg" + (kind === "ok" ? " ok" : "");
  el.hidden = false;
}

supabaseClient.auth.onAuthStateChange(() => refreshAuthState());
refreshAuthState();
