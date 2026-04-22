// ========================================================================
// LOGIN PAGE LOGIC
// Calls Supabase to authenticate an existing user.
// Depends on supabaseClient defined in supabase-config.js.
// ========================================================================

const loginForm     = document.getElementById('loginForm');
const emailInput    = document.getElementById('email');
const passwordInput = document.getElementById('password');
const submitBtn     = document.getElementById('submitBtn');
const messageEl     = document.getElementById('message');

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

    // Credentials valid and session stored - go to dashboard
    window.location.href = 'dashboard.html';

  } catch (err) {
    // Supabase returns "Invalid login credentials" for a wrong email or
    // password. We intentionally show the same message for both cases
    // to avoid revealing which one is wrong (security best practice).
    showMessage(err.message, 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Log In';
  }
});
