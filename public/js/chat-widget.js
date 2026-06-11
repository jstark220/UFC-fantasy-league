// ========================================================================
// CHAT POPUP WIDGET
// ========================================================================
// Renders the league chat as a floating popup that lives permanently on
// every league-context page. Two states:
//
//   open       — full popup visible, anchored bottom-right (or fullscreen
//                on narrow viewports)
//   minimized  — collapses to a small crimson bar at the bottom-right
//                with title and unread badge; click to maximize
//
// There is no closed state — the bar always announces chat. State and
// active thread persist in localStorage keyed by league id so the popup
// survives page navigation. The popup DOM is built lazily on the first
// state transition.
//
// Depends on chat.js (must be loaded first), which exposes:
//   window.initChatWidget(leagueId, container, opts)
//   window.onChatThreadChange  — callback we set; chat.js fires it on switchThread
//
// API exposed:
//   ChatWidget.open()      — open the popup (lazy-inits chat on first call)
//   ChatWidget.minimize()  — collapse to the small bar
//   ChatWidget.toggle()    — open <-> minimize
// ========================================================================

(function() {
  function storageKey(lid) { return 'chat-popup-' + lid; }

  let leagueId   = null;
  let popupEl    = null;
  let chatInited = false;

  // Shape stored under storageKey(leagueId):
  //   { state: 'open' | 'minimized', activeThread: 'group' | <member uuid> | null }
  // The bar is permanently visible — there's no "closed" state. Default
  // for first-time visitors is minimized so the popup announces itself
  // without grabbing the screen.
  function loadState() {
    const lid = getLeagueId();
    if (!lid) return { state: 'minimized', activeThread: null };
    try {
      const raw = localStorage.getItem(storageKey(lid));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          // Migrate legacy "closed" persisted state to minimized so users
          // who closed it before still get the bar after this update.
          if (parsed.state === 'closed') parsed.state = 'minimized';
          return parsed;
        }
      }
    } catch (e) {}
    return { state: 'minimized', activeThread: null };
  }

  function saveState(partial) {
    const lid = getLeagueId();
    if (!lid) return;
    const next = Object.assign({}, loadState(), partial);
    try { localStorage.setItem(storageKey(lid), JSON.stringify(next)); } catch (e) {}
  }

  function getLeagueId() {
    if (leagueId) return leagueId;
    const params = new URLSearchParams(window.location.search);
    // score-event uses ?league=, every other page uses ?id=. Tolerate both.
    leagueId = params.get('id') || params.get('league');
    return leagueId;
  }

  // ----------------------------------------------------------------------
  // ensurePopup — build the popup DOM on first call. Idempotent.
  // ----------------------------------------------------------------------
  function ensurePopup() {
    if (popupEl) return popupEl;

    popupEl = document.createElement('div');
    popupEl.className = 'chat-popup';
    popupEl.id = 'chatPopup';
    popupEl.setAttribute('data-state', 'minimized');

    // The bar acts as both header (when open) and the launcher (when minimized).
    // Inner DOM mirrors chat.html so chat.js's existing renderers find their IDs.
    // No close button — the popup is permanently up; users can only switch
    // between open and minimized.
    popupEl.innerHTML =
      '<button class="chat-popup__bar" id="chatPopupBar" type="button" aria-label="Toggle chat">' +
        '<span class="chat-popup__bar-title" id="chatPopupBarTitle">League Chat</span>' +
        '<span class="chat-popup__bar-badge" id="chatPopupBadge" hidden></span>' +
        '<span class="chat-popup__bar-controls">' +
          '<span class="chat-popup__bar-icon" data-action="minimize" title="Minimize" aria-hidden="true">&minus;</span>' +
        '</span>' +
      '</button>' +
      '<div class="chat-popup__body" id="chatPopupBody">' +
        '<aside class="chat-sidebar" id="chatSidebar"></aside>' +
        '<div class="chat-window">' +
          '<div class="chat-header" id="chatHeader">' +
            '<span class="chat-header__title" id="chatHeaderTitle">League Chat</span>' +
            '<span class="chat-header__sub"   id="chatHeaderSub"></span>' +
          '</div>' +
          '<div id="chatMessages" class="chat-messages" aria-live="polite">' +
            '<p class="chat-state">Loading chat...</p>' +
          '</div>' +
          '<form id="chatForm" class="chat-composer" autocomplete="off">' +
            '<textarea id="chatInput" class="chat-composer__input" rows="1" maxlength="2000" ' +
                      'placeholder="Send a message..." aria-label="Message"></textarea>' +
            '<button type="submit" class="btn-primary chat-composer__send" id="chatSendBtn">Send</button>' +
          '</form>' +
        '</div>' +
      '</div>';

    document.body.appendChild(popupEl);

    popupEl.querySelector('#chatPopupBar').addEventListener('click', function(e) {
      const action = e.target.getAttribute && e.target.getAttribute('data-action');
      if (action === 'minimize') { e.stopPropagation(); minimize(); return; }
      // Click on the bar body itself toggles between minimized and open
      const cur = popupEl.getAttribute('data-state');
      if (cur === 'minimized') open();
      else if (cur === 'open') minimize();
    });

    // Persist active thread when chat.js's switchThread fires the callback
    window.onChatThreadChange = function(threadKey) {
      saveState({ activeThread: threadKey || 'group' });
    };

    return popupEl;
  }

  function setState(state) {
    ensurePopup();
    popupEl.setAttribute('data-state', state);
    saveState({ state: state });
  }

  // ----------------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------------
  async function open() {
    if (window.CHAT_POPUP_DISABLED) return;   // page renders chat elsewhere (e.g. hub dock)
    const lid = getLeagueId();
    if (!lid) return;

    ensurePopup();

    if (!chatInited) {
      if (typeof window.initChatWidget !== 'function') {
        console.warn('[chat-widget] chat.js not loaded — cannot init chat');
        return;
      }
      chatInited = true;
      const persisted = loadState();
      const ok = await window.initChatWidget(lid, popupEl, {
        initialThread: persisted.activeThread || null
      });
      if (!ok) {
        // Init failed (not a member, league missing, etc.). Reset so a
        // future call retries cleanly instead of staying stuck "inited".
        chatInited = false;
        return;
      }
    }

    setState('open');
    const input = popupEl.querySelector('#chatInput');
    if (input) input.focus();
  }

  function minimize() {
    ensurePopup();
    setState('minimized');
  }

  function toggle() {
    const cur = popupEl ? popupEl.getAttribute('data-state') : 'minimized';
    if (cur === 'open') minimize();
    else open();
  }

  // ----------------------------------------------------------------------
  // Restore on page load — popup is always present. Default state is
  // minimized; if the user had it open last time on this league, reopen.
  // ----------------------------------------------------------------------
  function restore() {
    if (window.CHAT_POPUP_DISABLED) return;   // page renders chat elsewhere (e.g. hub dock)
    const lid = getLeagueId();
    if (!lid) return;
    const persisted = loadState();
    if (persisted.state === 'open') {
      open();
    } else {
      ensurePopup();
      setState('minimized');
    }
  }

  window.ChatWidget = {
    open:     open,
    toggle:   toggle,
    minimize: minimize
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restore);
  } else {
    restore();
  }
})();
