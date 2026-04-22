// ========================================================================
// DASHBOARD PAGE LOGIC
// Auth guard: redirects to login if no session exists.
// If logged in, reveals the page and wires up the logout button.
// Depends on supabaseClient defined in supabase-config.js.
// ========================================================================

async function initDashboard() {
  // getSession() reads the stored session from localStorage - no network call.
  // Returns { data: { session }, error }
  const { data, error } = await supabaseClient.auth.getSession();

  // No active session means the visitor is not logged in.
  // Redirect them to login before revealing any page content.
  if (!data.session) {
    window.location.href = 'login.html';
    return; // stop here so nothing below runs
  }

  // Session confirmed - reveal the page (was hidden to prevent content flash)
  document.getElementById('dashboardContent').style.display = 'block';

  // Show the logged-in user's email as the welcome message
  const userEmail = data.session.user.email;
  document.getElementById('welcomeMessage').textContent = 'Welcome, ' + userEmail;

  // Wire up the logout button
  document.getElementById('logoutBtn').addEventListener('click', async function() {
    // signOut() clears the session both on the Supabase server and in
    // localStorage, so a refresh will no longer find a valid session
    await supabaseClient.auth.signOut();
    window.location.href = 'login.html';
  });
}

// Run immediately when the page loads
initDashboard();
