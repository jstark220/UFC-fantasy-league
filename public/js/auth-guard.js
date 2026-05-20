// ========================================================================
// AUTH GUARD
// Shared helper used by every protected page.
// Call requireAuth() at the start of each page's init function.
// Returns the logged-in user object, or redirects to login and returns null.
// Depends on supabaseClient defined in supabase-config.js.
// ========================================================================

async function requireAuth() {
  // getSession() reads from localStorage - no network call needed
  const { data } = await supabaseClient.auth.getSession();

  if (!data.session) {
    // Preserve the intended destination so the login flow can return the
    // user back here after auth. Used by invite links (/join-league.html?code=…)
    // and any future deep links that hit the auth gate.
    const intended = window.location.pathname + window.location.search;
    const nextParam = '?next=' + encodeURIComponent(intended);
    window.location.href = 'login.html' + nextParam;
    return null;
  }

  // Inject a fixed-position logout button once per page load.
  // Doing it here means every protected page gets it for free.
  if (!document.getElementById('globalLogoutBtn')) {
    const btn = document.createElement('button');
    btn.id = 'globalLogoutBtn';
    btn.className = 'btn-logout';
    btn.textContent = 'Log out';
    btn.addEventListener('click', logOut);
    document.body.appendChild(btn);
  }

  // Inject an Account link into the top-nav next to the logout button, on
  // every page that has one. Skipped on account.html itself (the link is
  // self-referential there). Done once per page load.
  const existingLogout = document.getElementById('globalLogoutBtn');
  const onAccountPage  = window.location.pathname.endsWith('/account.html');
  if (existingLogout && !document.getElementById('accountLink') && !onAccountPage) {
    const link = document.createElement('a');
    link.id = 'accountLink';
    link.className = 'btn-ghost';
    link.textContent = 'Account';
    link.href = 'account.html';
    existingLogout.parentNode.insertBefore(link, existingLogout);
  }

  // Return the user object so the calling page can use the user's id and email
  return data.session.user;
}

async function logOut() {
  await supabaseClient.auth.signOut();
  window.location.href = 'login.html';
}
