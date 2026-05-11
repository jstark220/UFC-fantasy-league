// ========================================================================
// SIGNUP PAGE LOGIC
// Validates the form and calls Supabase to create a new user account.
// Depends on supabaseClient defined in supabase-config.js.
// ========================================================================

// Grab references to the DOM elements we'll read from and update
const signupForm    = document.getElementById('signupForm');
const emailInput    = document.getElementById('email');
const passwordInput = document.getElementById('password');
const confirmInput  = document.getElementById('confirmPassword');
const submitBtn     = document.getElementById('submitBtn');
const messageEl     = document.getElementById('message');
const googleBtn     = document.getElementById('googleBtn');

// ========================================================================
// HELPER: SHOW/HIDE MESSAGE BANNER
// type is 'error' or 'success', which maps to CSS class names in styles.css
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
signupForm.addEventListener('submit', async function(event) {
  // Prevent the browser from reloading the page on form submit
  event.preventDefault();

  hideMessage();

  const email    = emailInput.value.trim();
  const password = passwordInput.value;
  const confirm  = confirmInput.value;

  // ---- Client-side validation (runs before any network request) ----

  if (password !== confirm) {
    showMessage('Passwords do not match.', 'error');
    return;
  }

  // Supabase enforces this server-side too, but checking early gives a
  // friendlier message without waiting for a round-trip
  if (password.length < 8) {
    showMessage('Password must be at least 8 characters.', 'error');
    return;
  }

  // ---- Disable button while the request is in flight ----
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating account...';

  try {
    // auth.signUp() creates the user in Supabase Auth.
    // The handle_new_user() database trigger fires automatically here
    // and creates a matching row in the public.profiles table.
    //
    // Email confirmation is disabled in dev, so Supabase returns a live
    // session immediately. On success we redirect straight to the dashboard.
    //
    // TODO (post-MVP): When email confirmation is enabled for production,
    // the session here will be null until the user clicks the confirmation
    // link. At that point, redirect to a "check your email" page instead.
    const { data, error } = await supabaseClient.auth.signUp({ email, password });

    if (error) throw error;

    // Account created and session is live - go to dashboard
    window.location.href = 'dashboard.html';

  } catch (err) {
    // Common Supabase error: "User already registered"
    showMessage(err.message, 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Account';
  }
});

// ========================================================================
// GOOGLE SIGN-UP
// Same call as login — signInWithOAuth upserts the user, so it works whether
// the Google account is new to us or existing. The handle_new_user trigger
// fires on first OAuth sign-in just like it does for password signups, so
// the public.profiles row gets created automatically.
// dashboardUrl() derives the post-auth URL from the current page so it
// works whether dev serves from the project root or from public/.
// ========================================================================
function dashboardUrl() {
  const path = window.location.pathname;
  const dir = path.substring(0, path.lastIndexOf('/'));
  return window.location.origin + dir + '/dashboard.html';
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
