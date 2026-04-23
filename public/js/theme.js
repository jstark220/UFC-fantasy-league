// ========================================================================
// THEME MANAGER
// Run this script in <head> BEFORE any stylesheets so the data-theme
// attribute is set on <html> before CSS renders, preventing a flash of
// the wrong theme color on page load.
//
// Priority order:
//   1. User's saved preference in localStorage (persists across visits)
//   2. OS-level prefers-color-scheme media query (first visit)
//   3. Dark mode as the hard default
// ========================================================================

// IIFE: runs immediately when the script tag is parsed, before paint
(function () {
  var saved = localStorage.getItem('kf-theme');

  var theme;
  if (saved === 'light' || saved === 'dark') {
    // User has previously chosen a theme -- honor it
    theme = saved;
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    // First visit and OS is set to light mode
    theme = 'light';
  } else {
    // Default: dark mode
    theme = 'dark';
  }

  // Apply immediately to the root element so CSS custom properties resolve
  // to the correct palette before any element is painted
  document.documentElement.setAttribute('data-theme', theme);
}());

// ========================================================================
// toggleTheme()
// Called by any theme-toggle button via onclick="toggleTheme()".
// Flips between dark and light, saves to localStorage, updates button icon.
// ========================================================================
function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme');
  var next    = current === 'light' ? 'dark' : 'light';

  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('kf-theme', next);

  // Update the icon on any theme toggle buttons present on this page
  document.querySelectorAll('.btn-theme').forEach(function (btn) {
    // Moon icon = currently dark (click to go light), Sun = currently light
    btn.textContent = next === 'dark' ? '☾' : '☀';
    btn.setAttribute('aria-label', next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  });
}
