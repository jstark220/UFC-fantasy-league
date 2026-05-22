// ========================================================================
// CUSTOM DROPDOWN — replaces a <select> with a fully-styled component
//
// The native <select>'s opened menu is OS-drawn and unstylable beyond
// background/color. To actually design those rows, the select has to be
// swapped for div-based markup with manual focus / keyboard / click-
// outside handling. This module does that swap.
//
// The underlying <select> stays in the DOM (visually hidden) so:
//   * existing change-event listeners fire normally
//   * form serialization keeps working
//   * any JS that reads .value gets the right answer
//
// Public API:
//   CustomDropdown.enhance(selectEl) — programmatic enhancement
//   CustomDropdown.refresh(selectEl) — re-render after the options
//                                      array is mutated by the host
//
// Authoring tips:
//   * Add `data-custom-dropdown="true"` to a <select> to opt in to
//     auto-enhancement on DOMContentLoaded.
//   * Add `data-sub="..."` to an <option> to render a secondary,
//     muted line beneath the main option label (e.g. event date).
// ========================================================================

(function (root) {
  function escapeHtml(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  var CHEVRON_SVG =
    '<svg viewBox="0 0 12 8" width="12" height="8" aria-hidden="true">' +
      '<path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.75" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  var CHECK_SVG =
    '<svg viewBox="0 0 12 10" width="12" height="10" aria-hidden="true">' +
      '<path d="M1 5l4 4 6-8" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  function enhance(selectEl) {
    if (!selectEl || selectEl.tagName !== 'SELECT') return null;
    if (selectEl.__cdEnhanced) return selectEl.__cdEnhanced;

    // --- Build wrap, trigger, hidden select, menu ----------------------
    var wrap = document.createElement('div');
    wrap.className = 'cd-wrap';
    // Slip in front of the select, then move the select inside.
    selectEl.parentNode.insertBefore(wrap, selectEl);
    wrap.appendChild(selectEl);
    selectEl.classList.add('cd-native-hidden');
    selectEl.setAttribute('aria-hidden', 'true');
    selectEl.setAttribute('tabindex', '-1');

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cd-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (selectEl.id) trigger.setAttribute('aria-labelledby', selectEl.id + '-label');
    wrap.insertBefore(trigger, selectEl);

    // Menu lives inside the wrap (not body) so it's torn down with the
    // wrap when the host re-renders the surrounding DOM. position: fixed
    // keeps it free of any overflow:hidden ancestors.
    var menu = document.createElement('div');
    menu.className = 'cd-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    wrap.appendChild(menu);

    var state = {
      open:          false,
      focusedIdx:    -1,
      searchBuffer:  '',
      searchTimer:   null
    };

    function renderTrigger() {
      var opt = selectEl.options[selectEl.selectedIndex];
      var label = opt ? opt.textContent : '';
      trigger.innerHTML =
        '<span class="cd-trigger__label">' + escapeHtml(label) + '</span>' +
        '<span class="cd-trigger__chevron">' + CHEVRON_SVG + '</span>';
    }

    function renderMenu() {
      var html = '';
      for (var i = 0; i < selectEl.options.length; i++) {
        var opt = selectEl.options[i];
        var sub = opt.getAttribute('data-sub');
        var isSel = i === selectEl.selectedIndex;
        html +=
          '<div class="cd-option' + (isSel ? ' cd-option--selected' : '') + '" ' +
               'role="option" data-idx="' + i + '" ' +
               'aria-selected="' + (isSel ? 'true' : 'false') + '">' +
            '<span class="cd-option__main">' + escapeHtml(opt.textContent) + '</span>' +
            (sub ? '<span class="cd-option__sub">' + escapeHtml(sub) + '</span>' : '') +
            (isSel ? '<span class="cd-option__check">' + CHECK_SVG + '</span>' : '') +
          '</div>';
      }
      menu.innerHTML = html;
    }

    function positionMenu() {
      var rect = trigger.getBoundingClientRect();
      var vw = window.innerWidth, vh = window.innerHeight;
      var GAP = 6, PAD = 8;

      // Width = trigger width minimum; expand to fit longer content but
      // cap at viewport.
      menu.style.minWidth = rect.width + 'px';
      menu.style.maxWidth = (vw - 2 * PAD) + 'px';
      menu.style.left = rect.left + 'px';

      // Measure intrinsic height; clamp to 380px max.
      menu.style.maxHeight = 'none';
      var intrinsicH = menu.scrollHeight;
      var hardCap = 380;

      var spaceBelow = vh - rect.bottom - GAP - PAD;
      var spaceAbove = rect.top - GAP - PAD;
      var openUp = spaceBelow < Math.min(intrinsicH, 220) && spaceAbove > spaceBelow;

      var availableH;
      if (openUp) {
        availableH = Math.min(hardCap, spaceAbove);
        menu.style.top = (rect.top - GAP - Math.min(intrinsicH, availableH)) + 'px';
      } else {
        availableH = Math.min(hardCap, spaceBelow);
        menu.style.top = (rect.bottom + GAP) + 'px';
      }
      menu.style.maxHeight = availableH + 'px';

      // Clamp left if menu would overflow right edge
      var menuRect = menu.getBoundingClientRect();
      if (menuRect.right > vw - PAD) {
        menu.style.left = (vw - PAD - menuRect.width) + 'px';
      }
      if (menuRect.left < PAD) {
        menu.style.left = PAD + 'px';
      }
    }

    function paintFocus() {
      var rows = menu.querySelectorAll('.cd-option');
      for (var i = 0; i < rows.length; i++) {
        rows[i].classList.toggle('cd-option--focused', i === state.focusedIdx);
      }
      var focused = menu.querySelector('.cd-option--focused');
      if (focused) focused.scrollIntoView({ block: 'nearest' });
    }

    function openMenu() {
      if (state.open) return;
      state.open = true;
      renderMenu();
      menu.hidden = false;
      // Two-frame trick so transition kicks in cleanly
      requestAnimationFrame(function () {
        positionMenu();
        menu.classList.add('cd-menu--open');
        state.focusedIdx = selectEl.selectedIndex;
        paintFocus();
        // Scroll the selected option to the middle for long lists
        var sel = menu.querySelector('.cd-option--selected');
        if (sel) sel.scrollIntoView({ block: 'center' });
      });
      trigger.setAttribute('aria-expanded', 'true');
    }

    function closeMenu() {
      if (!state.open) return;
      state.open = false;
      menu.classList.remove('cd-menu--open');
      trigger.setAttribute('aria-expanded', 'false');
      // Hide after the fade so keyboard nav doesn't tab through hidden rows
      window.setTimeout(function () {
        if (!state.open) menu.hidden = true;
      }, 140);
      state.focusedIdx = -1;
    }

    function moveFocus(delta) {
      var max = selectEl.options.length - 1;
      if (max < 0) return;
      var next = state.focusedIdx + delta;
      if (next < 0) next = 0;
      if (next > max) next = max;
      state.focusedIdx = next;
      paintFocus();
    }

    function chooseFocused() {
      if (state.focusedIdx < 0) return;
      selectEl.selectedIndex = state.focusedIdx;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      renderTrigger();
      closeMenu();
      trigger.focus();
    }

    // --- Wire events ---------------------------------------------------
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      if (state.open) closeMenu();
      else openMenu();
    });

    trigger.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!state.open) openMenu();
        else moveFocus(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!state.open) openMenu();
        else moveFocus(-1);
      }
    });

    menu.addEventListener('click', function (e) {
      var row = e.target.closest('.cd-option');
      if (!row) return;
      var idx = parseInt(row.getAttribute('data-idx'), 10);
      if (isNaN(idx)) return;
      state.focusedIdx = idx;
      chooseFocused();
    });

    menu.addEventListener('mousemove', function (e) {
      var row = e.target.closest('.cd-option');
      if (!row) return;
      var idx = parseInt(row.getAttribute('data-idx'), 10);
      if (!isNaN(idx) && idx !== state.focusedIdx) {
        state.focusedIdx = idx;
        paintFocus();
      }
    });

    // Document-level keyboard while open
    function onDocKey(e) {
      if (!state.open) return;
      if (e.key === 'Escape')        { e.preventDefault(); closeMenu(); trigger.focus(); }
      else if (e.key === 'ArrowDown'){ e.preventDefault(); moveFocus(1); }
      else if (e.key === 'ArrowUp')  { e.preventDefault(); moveFocus(-1); }
      else if (e.key === 'Home')     { e.preventDefault(); state.focusedIdx = 0; paintFocus(); }
      else if (e.key === 'End')      { e.preventDefault(); state.focusedIdx = selectEl.options.length - 1; paintFocus(); }
      else if (e.key === 'Enter')    { e.preventDefault(); chooseFocused(); }
      else if (e.key === 'Tab')      { closeMenu(); }
      else if (e.key.length === 1)   {
        // Type-to-search: append char to buffer and jump to first
        // option whose label starts with the buffer.
        if (state.searchTimer) clearTimeout(state.searchTimer);
        state.searchBuffer += e.key.toLowerCase();
        state.searchTimer = setTimeout(function () { state.searchBuffer = ''; }, 700);
        for (var i = 0; i < selectEl.options.length; i++) {
          var label = (selectEl.options[i].textContent || '').toLowerCase();
          if (label.indexOf(state.searchBuffer) === 0) {
            state.focusedIdx = i;
            paintFocus();
            break;
          }
        }
      }
    }
    document.addEventListener('keydown', onDocKey);

    // Click outside closes
    function onDocClick(e) {
      if (!state.open) return;
      if (wrap.contains(e.target)) return;
      closeMenu();
    }
    document.addEventListener('mousedown', onDocClick);

    // Reposition on scroll/resize
    function onReposition() { if (state.open) positionMenu(); }
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);

    // Initial paint
    renderTrigger();

    var instance = {
      refresh: function () {
        renderTrigger();
        if (state.open) renderMenu();
      },
      destroy: function () {
        document.removeEventListener('keydown',   onDocKey);
        document.removeEventListener('mousedown', onDocClick);
        window.removeEventListener('scroll', onReposition, true);
        window.removeEventListener('resize', onReposition);
        if (wrap.parentNode) {
          wrap.parentNode.insertBefore(selectEl, wrap);
          wrap.parentNode.removeChild(wrap);
        }
        selectEl.classList.remove('cd-native-hidden');
        selectEl.removeAttribute('aria-hidden');
        selectEl.removeAttribute('tabindex');
        delete selectEl.__cdEnhanced;
      }
    };
    selectEl.__cdEnhanced = instance;
    return instance;
  }

  function refresh(selectEl) {
    if (selectEl && selectEl.__cdEnhanced) selectEl.__cdEnhanced.refresh();
  }

  // ---- Auto-enhancement ----
  //
  // Selects that should be enhanced:
  //   * Have data-custom-dropdown="true", OR
  //   * Use one of the app's styled classes (.input, .form-input,
  //     .waiver-filter), OR
  //   * Are a direct child of a .form-group container
  // Skipped:
  //   * <select multiple> (component doesn't support multi-select)
  //   * data-no-custom-dropdown opt-out
  //   * already enhanced
  function shouldEnhance(el) {
    if (!el || el.tagName !== 'SELECT')             return false;
    if (el.__cdEnhanced)                            return false;
    if (el.hasAttribute('multiple'))                return false;
    if (el.hasAttribute('data-no-custom-dropdown')) return false;
    if (el.hasAttribute('data-custom-dropdown'))    return true;
    var cl = el.classList;
    if (cl.contains('input') || cl.contains('form-input') || cl.contains('waiver-filter')) {
      return true;
    }
    var parent = el.parentElement;
    if (parent && parent.classList && parent.classList.contains('form-group')) {
      return true;
    }
    return false;
  }

  function enhanceAll(root) {
    var selects = (root || document).querySelectorAll('select');
    for (var i = 0; i < selects.length; i++) {
      if (shouldEnhance(selects[i])) enhance(selects[i]);
    }
  }

  // Watch the document for newly-inserted selects so JS that builds
  // dropdowns at runtime (event pickers, partner pickers, etc.) gets
  // enhanced automatically without each call site needing to know about
  // CustomDropdown.
  function startObserver() {
    if (!window.MutationObserver) return;
    var observer = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes;
        for (var n = 0; n < added.length; n++) {
          var node = added[n];
          if (!node || node.nodeType !== 1) continue;
          if (node.tagName === 'SELECT') {
            if (shouldEnhance(node)) enhance(node);
          } else if (node.querySelectorAll) {
            var inner = node.querySelectorAll('select');
            for (var k = 0; k < inner.length; k++) {
              if (shouldEnhance(inner[k])) enhance(inner[k]);
            }
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    enhanceAll(document);
    startObserver();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  root.CustomDropdown = { enhance: enhance, refresh: refresh, enhanceAll: enhanceAll };
})(typeof window !== 'undefined' ? window : this);
