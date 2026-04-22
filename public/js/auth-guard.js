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
    // No active session - redirect to login before showing any page content
    window.location.href = 'login.html';
    return null;
  }

  // Return the user object so the calling page can use the user's id and email
  return data.session.user;
}
