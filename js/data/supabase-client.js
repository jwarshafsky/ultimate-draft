// Supabase client + auth gate. Connects to The League App's Supabase project
// so we read live keeper/roster/trade data without duplicating it.

const SUPABASE_URL = "https://fbllfkrtjsihrkwnbmlw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_aRh0MmQKrMCr8YnTwv9xIg_1F08WXf2";
const ALLOWED_EMAILS = ["jwarshafsky@gmail.com"];

// Use a unique storage key so we don't collide with The League App (which
// also lives on jwarshafsky.github.io and shares localStorage). Switching to
// PKCE flow which is more reliable for SPAs and handles refresh better than
// the legacy implicit flow.
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "pkce",
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
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session && session.user && isEmailAllowed(session.user.email)) {
    currentUser = { id: session.user.id, email: session.user.email };
  } else {
    if (session && session.user && !isEmailAllowed(session.user.email)) {
      await supabaseClient.auth.signOut();
      showAuthMsg("This account isn't authorized.", "err");
    }
    currentUser = null;
  }
  fireAuth();
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
