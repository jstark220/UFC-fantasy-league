// ========================================================================
// RESET PASSWORD PAGE LOGIC
// Step 2 of the password reset flow. The user landed here via a recovery
// link from their email. Supabase's JS SDK auto-processes the URL fragment
// during createClient() and creates a session for the user — so by the
// time this script runs we either have a valid recovery session OR we
// don't (link expired, opened twice, etc.).
//
// The PASSWORD_RECOVERY auth-state event also fires during that process.
// We listen for it so the page reveals the form as soon as we know the
// session is good; if it never fires (no valid token), we degrade to the
// "invalid link" view after a short wait.
// ========================================================================

const resetForm       = document.getElementById('resetForm');
const newPasswordEl   = document.getElementById('newPassword');
const confirmPwdEl    = document.getElementById('confirmPassword');
const submitBtn       = document.getElementById('submitBtn');
const messageEl       = document.getElementById('message');
const invalidLinkEl   = document.getElementById('invalidLink');
const subtitleEl      = document.getElementById('subtitle');

let recoveryReady = false;  // true once we know we're in a valid recovery session

function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = 'message ' + type;
  messageEl.style.display = 'block';
}
function hideMessage() { messageEl.style.display = 'none'; }

function showResetForm() {
  if (recoveryReady) return;  // idempotent — both the listener and getSession may fire
  recoveryReady = true;
  resetForm.style.display = '';
  invalidLinkEl.style.display = 'none';
}

function showInvalidLink() {
  if (recoveryReady) return;  // don't override if we already revealed the form
  invalidLinkEl.style.display = 'block';
  resetForm.style.display = 'none';
  subtitleEl.style.display = 'none';
}

// ---- Detect the recovery session ----
// supabase-js fires PASSWORD_RECOVERY when it processes a recovery link's
// hash fragment. Listen for it. As a belt-and-suspenders fallback, also
// check getSession() in case the SDK finished processing before this
// listener attached.
supabaseClient.auth.onAuthStateChange(function(event) {
  if (event === 'PASSWORD_RECOVERY') {
    showResetForm();
  }
});

(async function checkExistingSession() {
  const { data } = await supabaseClient.auth.getSession();
  // Only treat an existing session as a recovery session if the URL
  // actually has a recovery fragment — otherwise a regular logged-in
  // user could land here and silently get a password reset form, which
  // would skip the email-verification gate.
  const hash = window.location.hash || '';
  const looksLikeRecovery = hash.includes('type=recovery') ||
                            hash.includes('access_token=');
  if (data.session && looksLikeRecovery) {
    showResetForm();
  } else {
    // Wait a beat for the SDK to process the URL hash; if no recovery
    // event fires by then, show the invalid-link view.
    setTimeout(function() {
      if (!recoveryReady) showInvalidLink();
    }, 800);
  }
})();

// ---- Submit handler ----
resetForm.addEventListener('submit', async function(event) {
  event.preventDefault();
  hideMessage();

  const pwd     = newPasswordEl.value;
  const confirm = confirmPwdEl.value;

  if (pwd.length < 8) {
    showMessage('Password must be at least 8 characters.', 'error');
    return;
  }
  if (pwd !== confirm) {
    showMessage('Passwords do not match.', 'error');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving...';

  const { error } = await supabaseClient.auth.updateUser({ password: pwd });

  submitBtn.disabled = false;
  submitBtn.textContent = 'Set password';

  if (error) {
    showMessage(error.message, 'error');
    return;
  }

  showMessage('Password updated. Redirecting...', 'success');
  // The user is now logged in via the recovery session — send them straight in.
  setTimeout(function() {
    const path = window.location.pathname;
    const dir = path.substring(0, path.lastIndexOf('/'));
    window.location.href = window.location.origin + dir + '/dashboard.html';
  }, 1200);
});
