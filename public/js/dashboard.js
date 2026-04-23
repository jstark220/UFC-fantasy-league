// ========================================================================
// DASHBOARD PAGE LOGIC
// Uses the shared requireAuth() helper from auth-guard.js.
// If logged in, reveals the page and wires up the logout button.
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

async function initDashboard() {
  // requireAuth() checks the session and redirects to login if not found.
  // Returns the user object on success, or null if a redirect fired.
  const user = await requireAuth();
  if (!user) return;

  // Session confirmed - reveal the page (was hidden to prevent content flash)
  document.getElementById('dashboardContent').style.display = 'block';

  // Show the logged-in user's email as the welcome message
  // Logout is handled by the globalLogoutBtn in the nav (calls logOut() from auth-guard.js)
  document.getElementById('welcomeMessage').textContent = 'Logged in as ' + user.email;
}

initDashboard();
