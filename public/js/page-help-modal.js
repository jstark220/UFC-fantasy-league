// ========================================================================
// PAGE HELP MODAL
// Shared "How it works" component. Each page registers its own structured
// content (title + sections); this module handles the trigger button, the
// modal chrome, first-visit auto-open, and the localStorage flag that
// stops it auto-opening every load.
//
// Usage:
//   PageHelp.register('league', {
//     title: 'How Knockdown Fantasy works',
//     sections: [
//       { heading: 'The big idea',  body: '<p>...</p>' },
//       { heading: 'Your roster',   body: '<p>...</p>' },
//       ...
//     ]
//   });
//   PageHelp.attachTrigger('howItWorksBtn', 'league');  // optional
//   PageHelp.autoOpenIfFirstVisit('league');            // optional
//
// The trigger can be any element with an id — usually a small "? How it
// works" ghost button placed in the page header.
// ========================================================================

(function (root) {
  var REGISTRY = {};

  function register(pageKey, config) { REGISTRY[pageKey] = config; }

  function storageKey(pageKey) { return 'pageHelp_seen_' + pageKey; }

  function hasSeen(pageKey) {
    try { return localStorage.getItem(storageKey(pageKey)) === '1'; }
    catch (e) { return true; /* localStorage blocked → don't auto-show */ }
  }
  function markSeen(pageKey) {
    try { localStorage.setItem(storageKey(pageKey), '1'); } catch (e) {}
  }
  function resetSeen(pageKey) {
    try { localStorage.removeItem(storageKey(pageKey)); } catch (e) {}
  }

  function escapeAttr(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function show(pageKey) {
    var cfg = REGISTRY[pageKey];
    if (!cfg) {
      console.warn('PageHelp.show: no content registered for "' + pageKey + '"');
      return;
    }

    // Strip any prior instance (re-opening from a different trigger
    // shouldn't stack overlays).
    var existing = document.getElementById('pageHelpModal');
    if (existing) existing.remove();

    var sectionsHtml = (cfg.sections || []).map(function (s) {
      return '<section class="page-help__section">' +
               '<h3 class="page-help__heading">' + escapeAttr(s.heading) + '</h3>' +
               '<div class="page-help__body">' + (s.body || '') + '</div>' +
             '</section>';
    }).join('');

    var overlay = document.createElement('div');
    overlay.id = 'pageHelpModal';
    overlay.className = 'fight-card-modal-overlay page-help-overlay';
    overlay.innerHTML =
      '<div class="fight-card-modal page-help-modal" role="dialog" aria-modal="true" aria-labelledby="pageHelpTitle">' +
        '<div class="fight-card-modal__header">' +
          '<div>' +
            '<p class="fight-card-modal__eyebrow">' + escapeAttr(cfg.eyebrow || 'How it works') + '</p>' +
            '<p class="fight-card-modal__title" id="pageHelpTitle">' + escapeAttr(cfg.title) + '</p>' +
          '</div>' +
          '<button class="fight-card-modal__close" id="pageHelpCloseBtn" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="fight-card-modal__body page-help__body-wrap">' + sectionsHtml + '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    markSeen(pageKey);

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onEsc);
    }
    function onEsc(e) { if (e.key === 'Escape') close(); }
    document.getElementById('pageHelpCloseBtn').addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onEsc);
  }

  function attachTrigger(elementId, pageKey) {
    var el = document.getElementById(elementId);
    if (!el) return;
    el.addEventListener('click', function () { show(pageKey); });
  }

  function autoOpenIfFirstVisit(pageKey) {
    if (!hasSeen(pageKey)) {
      // Defer one frame so the page's own auth/data fetches don't have to
      // race the modal append.
      window.setTimeout(function () { show(pageKey); }, 150);
    }
  }

  root.PageHelp = {
    register:              register,
    show:                  show,
    attachTrigger:         attachTrigger,
    autoOpenIfFirstVisit:  autoOpenIfFirstVisit,
    markSeen:              markSeen,
    resetSeen:             resetSeen,
    hasSeen:               hasSeen
  };
})(typeof window !== 'undefined' ? window : this);
