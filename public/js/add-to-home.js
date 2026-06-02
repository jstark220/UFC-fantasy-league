// ==========================================================================
// ADD TO HOME SCREEN  (league page, mobile only)
// --------------------------------------------------------------------------
// Surfaces an "Add to Home Screen" button in the league header. The button
// itself is gated to mobile + hidden on desktop by CSS (.install-app-btn);
// this script wires up the behavior and hides the button when it makes no
// sense to show it.
//
// Two install paths, because the platforms differ:
//   - Android / Chromium: the browser fires `beforeinstallprompt`. We stash
//     that event and, on click, call its .prompt() to show the real native
//     install sheet.
//   - iOS Safari: there is NO programmatic install API. The only way is the
//     manual Share -> "Add to Home Screen" flow, so on click we open a small
//     instructions modal (reusing the app's existing modal chrome) that walks
//     the user through it.
//
// If the app is already running installed (standalone display mode) the
// button is removed entirely.
// ==========================================================================
(function (root) {
  'use strict';

  // Holds the deferred beforeinstallprompt event on browsers that support it
  // (Android/Chromium). Stays null on iOS Safari, which never fires it.
  var deferredPrompt = null;

  // True when the page is already running as an installed app, so there's
  // nothing to add. Covers both the standard display-mode query and the
  // older iOS-only navigator.standalone flag.
  function isStandalone() {
    return (root.matchMedia && root.matchMedia('(display-mode: standalone)').matches) ||
           root.navigator.standalone === true;
  }

  // iOS share glyph (up arrow out of an open box) for the instructions modal.
  function shareIconSvg() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
             'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
             '<path d="M12 15V3"/>' +
             '<path d="m8 7 4-4 4 4"/>' +
             '<path d="M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2"/>' +
           '</svg>';
  }

  // Vertical 3-dot "more" glyph for the Android instructions.
  function dotsIconSvg() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
             '<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>' +
           '</svg>';
  }

  // True for iOS / iPadOS Safari. iPadOS 13+ reports as "MacIntel" but has a
  // touch screen, so we treat a touch-capable Mac as iPad too.
  function isIOS() {
    var ua = root.navigator.userAgent || '';
    return /iphone|ipad|ipod/i.test(ua) ||
           (root.navigator.platform === 'MacIntel' && root.navigator.maxTouchPoints > 1);
  }

  // Build + show the "how to install" modal. Mirrors the markup of the
  // page-help modal so it inherits the same overlay/card styling. Steps are
  // platform-specific: iOS uses the Share sheet; everything else (Android
  // Chrome without a native prompt, etc.) uses the browser menu.
  function showInstructions() {
    var existing = document.getElementById('a2hsModal');
    if (existing) existing.remove();

    var stepsHtml = isIOS()
      ? '<li>Tap the <strong>Share</strong> button ' +
          '<span class="a2hs-share-icon">' + shareIconSvg() + '</span> ' +
          'in your browser’s toolbar.</li>' +
        '<li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>' +
        '<li>Tap <strong>Add</strong> — the Knockdown Fantasy icon will appear on your home screen.</li>'
      : '<li>Tap the <strong>menu</strong> button ' +
          '<span class="a2hs-share-icon">' + dotsIconSvg() + '</span> ' +
          'in your browser’s toolbar.</li>' +
        '<li>Tap <strong>Add to Home screen</strong> (or <strong>Install app</strong>).</li>' +
        '<li>Confirm — the Knockdown Fantasy icon will appear on your home screen.</li>';

    var overlay = document.createElement('div');
    overlay.id = 'a2hsModal';
    overlay.className = 'fight-card-modal-overlay';
    overlay.innerHTML =
      '<div class="fight-card-modal a2hs-modal" role="dialog" aria-modal="true" aria-labelledby="a2hsTitle">' +
        '<div class="fight-card-modal__header">' +
          '<div>' +
            '<p class="fight-card-modal__eyebrow">Install</p>' +
            '<p class="fight-card-modal__title" id="a2hsTitle">Add to Home Screen</p>' +
          '</div>' +
          '<button class="fight-card-modal__close" id="a2hsCloseBtn" type="button" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="fight-card-modal__body a2hs-modal__body">' +
          '<p class="a2hs-intro">Add Knockdown Fantasy to your home screen so it opens like an app:</p>' +
          '<ol class="a2hs-steps">' + stepsHtml + '</ol>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onEsc);
    }
    function onEsc(e) { if (e.key === 'Escape') close(); }
    document.getElementById('a2hsCloseBtn').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onEsc);
  }

  function removeBtn() {
    var b = document.getElementById('installAppBtn');
    if (b) b.remove();
  }

  function onClick() {
    if (deferredPrompt) {
      // Android/Chromium: fire the real native install prompt.
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () {
        deferredPrompt = null;
      }).catch(function () { /* user dismissed - leave button for retry */ });
      return;
    }
    // iOS Safari (and any browser without the prompt): show manual steps.
    showInstructions();
  }

  function init() {
    var btn = document.getElementById('installAppBtn');
    if (!btn) return;
    if (isStandalone()) { btn.remove(); return; } // already installed
    btn.addEventListener('click', onClick);
  }

  // Capture the install prompt before the browser shows its own mini-infobar
  // so we can trigger it from our button instead.
  root.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
  });
  // Once installed, the button has nothing left to do.
  root.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    removeBtn();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
