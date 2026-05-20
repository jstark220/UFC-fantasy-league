// ========================================================================
// LOGIN PAGE LOGIC
// Calls Supabase to authenticate an existing user.
// Depends on supabaseClient defined in supabase-config.js.
// ========================================================================

// Propagate ?next= onto the "Sign up" cross-link so deep-link visitors
// who choose to sign up instead of log in don't lose their destination.
(function preserveNextOnSignupLink() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next || next.charAt(0) !== '/') return;
  document.querySelectorAll('a[href="signup.html"]').forEach(function(a) {
    a.href = 'signup.html?next=' + encodeURIComponent(next);
  });
})();

const loginForm     = document.getElementById('loginForm');
const emailInput    = document.getElementById('email');
const passwordInput = document.getElementById('password');
const submitBtn     = document.getElementById('submitBtn');
const messageEl     = document.getElementById('message');
const googleBtn     = document.getElementById('googleBtn');

// ========================================================================
// HELPER: SHOW/HIDE MESSAGE BANNER
// ========================================================================
function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = 'message ' + type;
  messageEl.style.display = 'block';
}

function hideMessage() {
  messageEl.style.display = 'none';
}

// ========================================================================
// FORM SUBMIT HANDLER
// ========================================================================
loginForm.addEventListener('submit', async function(event) {
  // Prevent default browser form submission
  event.preventDefault();

  hideMessage();

  const email    = emailInput.value.trim();
  const password = passwordInput.value;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Logging in...';

  try {
    // auth.signInWithPassword() checks credentials against Supabase Auth.
    // On success it stores the session in localStorage automatically,
    // so future page loads can retrieve it via getSession() without
    // making the user log in again.
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

    if (error) throw error;

    // Credentials valid and session stored — go to the page the user was
    // trying to reach (set by auth-guard's redirect) or the dashboard.
    window.location.href = nextDestination();

  } catch (err) {
    // Supabase returns "Invalid login credentials" for a wrong email or
    // password. We intentionally show the same message for both cases
    // to avoid revealing which one is wrong (security best practice).
    showMessage(err.message, 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Log In';
  }
});

// ========================================================================
// nextDestination — where to send the user after a successful sign-in.
// Reads ?next= (set by auth-guard when redirecting an unauthenticated
// user away from a deep link) and falls back to dashboard.html. Only
// returns paths within this origin to avoid open-redirect risk.
// ========================================================================
function nextDestination() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (next && next.charAt(0) === '/') {
    return next; // same-origin relative path — safe to navigate to
  }
  // Default: dashboard, derived from the current page's directory so it
  // works under /public/ in dev and at root in prod.
  const path = window.location.pathname;
  const dir = path.substring(0, path.lastIndexOf('/'));
  return dir + '/dashboard.html';
}

// ========================================================================
// GOOGLE SIGN-IN
// signInWithOAuth redirects the browser to Google. After the user signs in,
// Google sends them to the Supabase callback URL configured for this project,
// Supabase exchanges the code for a session, then redirects to redirectTo
// below. We derive the dashboard URL from the current page's directory so
// the same code works whether the dev server points at the project root
// (URLs include /public/) or at the public/ folder (URLs at root).
// The function returns before the navigation happens, so the only code that
// matters after success is what runs on dashboard.html via auth-guard.
// ========================================================================
function dashboardUrl() {
  const path = window.location.pathname;
  const dir = path.substring(0, path.lastIndexOf('/'));
  // Propagate ?next= through the OAuth round-trip so deep links (invite
  // links, etc.) survive the Google sign-in detour. dashboard.js reads
  // the param on landing and forwards there.
  const next = new URLSearchParams(window.location.search).get('next');
  const qs = (next && next.charAt(0) === '/') ? '?next=' + encodeURIComponent(next) : '';
  return window.location.origin + dir + '/dashboard.html' + qs;
}

googleBtn.addEventListener('click', async function() {
  hideMessage();
  googleBtn.disabled = true;

  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: dashboardUrl() }
    });
    if (error) throw error;
    // On success, the browser navigates away — nothing more to do here.
  } catch (err) {
    showMessage(err.message, 'error');
    googleBtn.disabled = false;
  }
});
