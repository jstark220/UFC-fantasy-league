// ============================================================================
// mobile-nav.js
//
// Auto-injects a hamburger button into the existing .top-nav on mobile and
// builds a slide-out drawer from the page's existing nav links + log-out
// button. No HTML edits required per page — every page that already has
// <nav class="top-nav"> with .top-nav__links and .top-nav__actions picks
// this up for free.
//
// Behavior:
//   - Hamburger button is hidden on desktop via CSS (@media min-width: 768px).
//   - Tapping the button opens a right-side drawer with all link/action items.
//   - Drawer closes on: link tap, outside tap (overlay), Esc, hamburger re-tap.
//   - Drawer content is re-cloned each time it opens so dynamic links (e.g.
//     league-page nav buttons injected by league.js) stay in sync.
//
// Why a JS module instead of CSS-only: nav links on logged-in pages are
// injected at runtime by other scripts (league.js header actions, auth-guard
// log-out button), and we want the drawer to mirror whatever's currently in
// the top nav at the moment of opening — a static markup approach would go
// stale.
// ============================================================================

(function () {
  'use strict';

  // Run after DOMContentLoaded so the nav is in the DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    // Find the top nav — every page that has one uses this exact class
    var nav = document.querySelector('.top-nav');
    if (!nav) return;

    // Don't double-install if this script accidentally loads twice
    if (nav.querySelector('.top-nav__hamburger')) return;

    // ----- Hamburger button (lives inside the nav, visible only on mobile) -----
    var hamburger = document.createElement('button');
    hamburger.type = 'button';
    hamburger.className = 'top-nav__hamburger';
    hamburger.setAttribute('aria-label', 'Open menu');
    hamburger.setAttribute('aria-expanded', 'false');
    // Three-bar icon. SVG so it scales cleanly with currentColor.
    hamburger.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<line x1="3" y1="6"  x2="21" y2="6"/>' +
      '<line x1="3" y1="12" x2="21" y2="12"/>' +
      '<line x1="3" y1="18" x2="21" y2="18"/>' +
      '</svg>';
    nav.appendChild(hamburger);

    // ----- Drawer + overlay (appended to body so they're outside the nav's stacking) -----
    var overlay = document.createElement('div');
    overlay.className = 'mobile-drawer__overlay';
    overlay.setAttribute('aria-hidden', 'true');

    var drawer = document.createElement('aside');
    drawer.className = 'mobile-drawer';
    drawer.setAttribute('aria-hidden', 'true');
    drawer.setAttribute('aria-label', 'Site menu');

    // Drawer header: title + close button. The title is just a label so
    // the user knows what opened; the close X is redundant with the
    // hamburger but standard for accessibility.
    var header = document.createElement('div');
    header.className = 'mobile-drawer__header';
    header.innerHTML =
      '<span class="mobile-drawer__title">Menu</span>' +
      '<button type="button" class="mobile-drawer__close" aria-label="Close menu">' +
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<line x1="6" y1="6"  x2="18" y2="18"/>' +
      '<line x1="6" y1="18" x2="18" y2="6"/>' +
      '</svg>' +
      '</button>';
    drawer.appendChild(header);

    // Body of the drawer — content is rebuilt each time it opens
    var body = document.createElement('div');
    body.className = 'mobile-drawer__body';
    drawer.appendChild(body);

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    // ----- Open / close logic -----
    function openDrawer() {
      // Rebuild drawer body from the live nav so dynamic links stay in sync
      buildDrawerBody(body);

      drawer.classList.add('mobile-drawer--open');
      overlay.classList.add('mobile-drawer__overlay--open');
      drawer.setAttribute('aria-hidden', 'false');
      overlay.setAttribute('aria-hidden', 'false');
      hamburger.setAttribute('aria-expanded', 'true');
      // Lock body scroll while drawer is open
      document.body.style.overflow = 'hidden';
    }

    function closeDrawer() {
      drawer.classList.remove('mobile-drawer--open');
      overlay.classList.remove('mobile-drawer__overlay--open');
      drawer.setAttribute('aria-hidden', 'true');
      overlay.setAttribute('aria-hidden', 'true');
      hamburger.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }

    hamburger.addEventListener('click', function () {
      if (drawer.classList.contains('mobile-drawer--open')) closeDrawer();
      else openDrawer();
    });

    overlay.addEventListener('click', closeDrawer);
    drawer.querySelector('.mobile-drawer__close').addEventListener('click', closeDrawer);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.classList.contains('mobile-drawer--open')) {
        closeDrawer();
      }
    });

    // ----- Build / rebuild drawer body from the live nav -----
    function buildDrawerBody(container) {
      container.innerHTML = '';

      // Section 1: nav links (the "← League" / "← Dashboard" / etc. back links,
      // plus any links a page added to .top-nav__links).
      // The first link is the page's back link — it's already rendered
      // inline in the nav on mobile (see .top-nav__links CSS), so we skip
      // it here to avoid showing the same destination twice in the drawer.
      var linksContainer = nav.querySelector('.top-nav__links');
      if (linksContainer) {
        var linkChildren = Array.prototype.slice.call(linksContainer.children);
        linkChildren.forEach(function (el, idx) {
          if (idx === 0) return; // back link, already visible in nav
          var clone = cloneAsDrawerItem(el);
          if (clone) container.appendChild(clone);
        });
      }

      // Section 2: actions (theme toggle stays in nav header on mobile,
      // but log out / sign up / log in should go in the drawer)
      var actionsContainer = nav.querySelector('.top-nav__actions');
      if (actionsContainer) {
        var actionChildren = Array.prototype.slice.call(actionsContainer.children);
        var hasAction = false;
        actionChildren.forEach(function (el) {
          // Skip the theme toggle — that lives in the nav header on mobile so
          // the user doesn't have to open the drawer to flip light/dark.
          if (el.classList && el.classList.contains('btn-theme')) return;

          var clone = cloneAsDrawerItem(el);
          if (clone) {
            if (!hasAction) {
              // Light divider before action items so they read as a group
              var divider = document.createElement('div');
              divider.className = 'mobile-drawer__divider';
              container.appendChild(divider);
              hasAction = true;
            }
            container.appendChild(clone);
          }
        });
      }
    }

    // Clone a nav item as a full-width drawer row. Closes the drawer on tap.
    //
    // For buttons we don't rely on the clone's own event listeners — cloneNode
    // doesn't copy listeners attached via addEventListener (which is how
    // draft.js wires Restart Mock, fullscreen, sound toggle, the ? help
    // button, etc.). Instead we proxy: when the drawer button is tapped,
    // we programmatically click the ORIGINAL DOM node, which fires whatever
    // handlers it has (inline onclick, addEventListener, both).
    //
    // For anchors we let the cloned <a href> navigate normally — the
    // browser follows the href, no proxy needed.
    function cloneAsDrawerItem(el) {
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag !== 'a' && tag !== 'button') return null;

      var clone = el.cloneNode(true);
      clone.className = 'mobile-drawer__item';

      if (tag === 'button') {
        // Strip inline onclick from the clone so it doesn't double-fire
        // (the original will fire its own onclick when we proxy the click).
        clone.removeAttribute('onclick');
        // Also strip type="submit" inheritance hazards just in case
        clone.type = 'button';

        clone.addEventListener('click', function (e) {
          // Stop the synthetic event from bubbling to overlay/document
          e.preventDefault();
          e.stopPropagation();
          // Defer the original click so the drawer-close animation can
          // start. Some original handlers (fullscreen, etc.) move focus
          // around — doing it after a tick keeps the order clean.
          setTimeout(function () { el.click(); }, 0);
          setTimeout(closeDrawer, 0);
        });
      } else {
        // Anchor: cloned href is enough. Just close the drawer on tap.
        clone.addEventListener('click', function () {
          setTimeout(closeDrawer, 0);
        });
      }

      return clone;
    }
  }
})();
