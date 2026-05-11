// ========================================================================
// ACCOUNT SETTINGS PAGE
// ========================================================================
// Handles profile/email/password updates plus a read-only listing of the
// sign-in methods linked to this user. Supabase exposes everything we
// need via:
//
//   supabaseClient.auth.getUser()             — current user + identities
//   supabaseClient.auth.updateUser({email})   — sends double-confirmation
//   supabaseClient.auth.updateUser({password}) — instant change, keeps session
//   supabaseClient.from('profiles').update()  — display name (custom column)
//
// Display name lives on public.profiles.display_name (added via migration
// 2026-05-10_profiles_display_name.sql). The handle_new_user trigger
// creates the profiles row on signup, so we can always assume it exists
// for any signed-in user.
// ========================================================================

// ---- Module state ----
let currentUser = null;

// ---- DOM refs ----
const messageEl       = document.getElementById('message');
const displayNameEl   = document.getElementById('displayName');
const saveDisplayBtn  = document.getElementById('saveDisplayBtn');
const currentEmailEl  = document.getElementById('currentEmail');
const newEmailEl      = document.getElementById('newEmail');
const saveEmailBtn    = document.getElementById('saveEmailBtn');
const passwordSection = document.getElementById('passwordSection');
const newPasswordEl   = document.getElementById('newPassword');
const confirmNewPwdEl = document.getElementById('confirmNewPassword');
const savePasswordBtn = document.getElementById('savePasswordBtn');
const providersList   = document.getElementById('providersList');

// ========================================================================
// HELPERS — message banner
// ========================================================================
function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = 'message ' + type;
  messageEl.style.display = 'block';
  // Scroll the banner into view if the page was scrolled down when the
  // save fired — otherwise the user won't notice the result.
  messageEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function hideMessage() {
  messageEl.style.display = 'none';
}

// ========================================================================
// INIT — load user + profile, populate fields, decide which sections show
// ========================================================================
async function initAccount() {
  const user = await requireAuth();
  if (!user) return;
  currentUser = user;

  // Fill the current-email line and pre-populate the change form. The user
  // changes the value in newEmail; currentEmailEl stays read-only.
  currentEmailEl.textContent = user.email || '(no email on file)';

  // Identities tell us which sign-in providers are linked to this account.
  // Use auth.getUser() to get a fresh copy with identities populated.
  // (The user object from requireAuth comes from getSession() and may or
  // may not include identities depending on Supabase version.)
  const { data: freshUser } = await supabaseClient.auth.getUser();
  const identities = (freshUser && freshUser.user && freshUser.user.identities) || [];
  renderProviders(identities);

  // Password change only makes sense if the user has an email/password
  // identity. OAuth-only users would have nothing to log in with after a
  // password reset, so we hide the whole section for them.
  const hasEmailLogin = identities.some(function(i) { return i.provider === 'email'; });
  passwordSection.style.display = hasEmailLogin ? 'block' : 'none';

  // Pull the display name from profiles. If the column doesn't exist yet
  // (migration not run), this returns an error — we degrade gracefully by
  // leaving the input empty and noting it on save.
  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('display_name')
    .eq('id', user.id)
    .maybeSingle();
  if (profile && profile.display_name) {
    displayNameEl.value = profile.display_name;
  }

  // Wire all save buttons
  saveDisplayBtn.addEventListener('click', saveDisplayName);
  saveEmailBtn.addEventListener('click', saveEmail);
  savePasswordBtn.addEventListener('click', savePassword);

  document.getElementById('pageContent').style.display = '';
}

// ========================================================================
// SAVE: DISPLAY NAME
// ========================================================================
async function saveDisplayName() {
  hideMessage();
  const name = displayNameEl.value.trim();
  if (!name) { showMessage('Display name cannot be empty.', 'error'); return; }

  saveDisplayBtn.disabled = true;
  saveDisplayBtn.textContent = 'Saving...';

  const { error } = await supabaseClient
    .from('profiles')
    .update({ display_name: name })
    .eq('id', currentUser.id);

  saveDisplayBtn.disabled = false;
  saveDisplayBtn.textContent = 'Save profile';

  if (error) {
    // Most likely cause if this fails: the display_name column doesn't
    // exist yet — surface that to the user so they know it's a setup gap.
    showMessage('Could not save profile: ' + error.message, 'error');
    return;
  }
  showMessage('Profile saved.', 'success');
}

// ========================================================================
// SAVE: EMAIL
// updateUser({ email }) sends a confirmation link to BOTH the current and
// new addresses. Until both are clicked, the email on auth.users stays
// the old value. We tell the user that explicitly in the success message.
// ========================================================================
async function saveEmail() {
  hideMessage();
  const newEmail = newEmailEl.value.trim();
  if (!newEmail) { showMessage('Enter a new email address.', 'error'); return; }
  if (newEmail === currentUser.email) {
    showMessage('That is already your email.', 'error');
    return;
  }

  saveEmailBtn.disabled = true;
  saveEmailBtn.textContent = 'Sending...';

  const { error } = await supabaseClient.auth.updateUser({ email: newEmail });

  saveEmailBtn.disabled = false;
  saveEmailBtn.textContent = 'Update email';

  if (error) {
    showMessage('Could not start email change: ' + error.message, 'error');
    return;
  }
  newEmailEl.value = '';
  showMessage(
    'Confirmation links sent to ' + currentUser.email + ' and ' + newEmail +
    '. Click both to complete the change.',
    'success'
  );
}

// ========================================================================
// SAVE: PASSWORD
// updateUser({ password }) applies immediately. The session stays valid
// on this device, but other devices' sessions are revoked.
// ========================================================================
async function savePassword() {
  hideMessage();
  const pwd     = newPasswordEl.value;
  const confirm = confirmNewPwdEl.value;

  if (pwd.length < 8) {
    showMessage('Password must be at least 8 characters.', 'error');
    return;
  }
  if (pwd !== confirm) {
    showMessage('Passwords do not match.', 'error');
    return;
  }

  savePasswordBtn.disabled = true;
  savePasswordBtn.textContent = 'Saving...';

  const { error } = await supabaseClient.auth.updateUser({ password: pwd });

  savePasswordBtn.disabled = false;
  savePasswordBtn.textContent = 'Update password';

  if (error) {
    showMessage('Could not update password: ' + error.message, 'error');
    return;
  }
  newPasswordEl.value = '';
  confirmNewPwdEl.value = '';
  showMessage('Password updated.', 'success');
}

// ========================================================================
// RENDER: SIGN-IN METHODS
// One <li> per identity. We label known providers nicely; unknown ones
// fall back to their raw provider string so we never silently hide one.
// ========================================================================
function renderProviders(identities) {
  if (!identities || identities.length === 0) {
    providersList.innerHTML = '<li class="settings-providers__empty">No sign-in methods linked.</li>';
    return;
  }

  const labels = {
    email:    { name: 'Email & password', detail: function(i) { return i.identity_data && i.identity_data.email; } },
    google:   { name: 'Google',           detail: function(i) { return i.identity_data && i.identity_data.email; } }
  };

  let html = '';
  identities.forEach(function(i) {
    const entry  = labels[i.provider] || { name: i.provider, detail: function() { return ''; } };
    const detail = entry.detail(i) || '';
    html +=
      '<li class="settings-providers__row">' +
        '<span class="settings-providers__name">' + escapeHtml(entry.name) + '</span>' +
        (detail ? '<span class="settings-providers__detail">' + escapeHtml(detail) + '</span>' : '') +
      '</li>';
  });
  providersList.innerHTML = html;
}

// ========================================================================
// HELPERS
// ========================================================================
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initAccount();
