// ========================================================================
// FORGOT PASSWORD PAGE LOGIC
// Step 1 of the password reset flow: the user enters their email and we
// ask Supabase to send them a recovery link. The link itself points at
// reset-password.html, where the user actually sets a new password.
// ========================================================================

const forgotForm = document.getElementById('forgotForm');
const emailInput = document.getElementById('email');
const submitBtn  = document.getElementById('submitBtn');
const messageEl  = document.getElementById('message');

function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = 'message ' + type;
  messageEl.style.display = 'block';
}
function hideMessage() { messageEl.style.display = 'none'; }

// Derive the reset-password URL from the current page's directory so it
// works whether dev serves from the project root (/public/) or from
// public/ as the root (production behind Vercel).
function resetPasswordUrl() {
  const path = window.location.pathname;
  const dir = path.substring(0, path.lastIndexOf('/'));
  return window.location.origin + dir + '/reset-password.html';
}

forgotForm.addEventListener('submit', async function(event) {
  event.preventDefault();
  hideMessage();

  const email = emailInput.value.trim();
  if (!email) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending...';

  // resetPasswordForEmail never reveals whether the address is registered
  // (it returns success either way) — so we show the same success message
  // regardless. That's a security best practice: don't leak which emails
  // have accounts.
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: resetPasswordUrl()
  });

  submitBtn.disabled = false;
  submitBtn.textContent = 'Send reset link';

  if (error) {
    showMessage(error.message, 'error');
    return;
  }

  showMessage(
    'If an account exists for that email, a reset link is on the way. ' +
    'Check your inbox (and spam folder) for a message from Knockdown Fantasy.',
    'success'
  );
  emailInput.value = '';
});
