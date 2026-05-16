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

// Synchronous auth check that bypasses Supabase's library entirely. Reads
// the stored session directly from localStorage. Never hangs, never async,
// just looks at the stored JWT and validates basic fields. Supabase library
// still handles authenticated queries (it reads the same storage key).
function refreshAuthState() {
  try {
    const raw = localStorage.getItem("sb-ud-auth-v1");
    console.log("[auth] storage present:", !!raw);
    if (!raw) {
      currentUser = null;
      fireAuth();
      return;
    }
    const parsed = JSON.parse(raw);
    const u = parsed?.user || parsed?.currentSession?.user;
    const exp = parsed?.expires_at || parsed?.currentSession?.expires_at;
    const now = Math.floor(Date.now() / 1000);
    console.log("[auth] parsed user:", u?.email, "exp:", exp, "now:", now, "valid:", exp > now);
    if (!u?.email) {
      currentUser = null;
      fireAuth();
      return;
    }
    if (!isEmailAllowed(u.email)) {
      console.warn("[auth] email not allowed:", u.email);
      currentUser = null;
      fireAuth();
      return;
    }
    if (exp && exp <= now) {
      // Try async refresh; UI shows gate in the meantime, then updates when refresh completes.
      console.log("[auth] token expired, trying refresh");
      currentUser = null;
      fireAuth();
      supabaseClient.auth.refreshSession().then(r => {
        if (r?.data?.session?.user?.email && isEmailAllowed(r.data.session.user.email)) {
          currentUser = { id: r.data.session.user.id, email: r.data.session.user.email };
          fireAuth();
        }
      }).catch(e => console.warn("[auth] refresh failed:", e));
      return;
    }
    console.log("[auth] OK, signed in as", u.email);
    currentUser = { id: u.id, email: u.email };
    fireAuth();
  } catch (e) {
    console.error("[auth] failed:", e);
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
