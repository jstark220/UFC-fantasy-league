// ========================================================================
// LOADING SCREEN — Octagon HUD
//
// A regular octagon outlined in crimson with a "light sweep" travelling
// around its 8 panels (one panel lit per second, looping forever).
// Corner posts flare bright at the same moment. Centered inside: a stat
// readout that cycles through SIG STRIKES → TAKEDOWNS → CTRL TIME etc.,
// each number scrambling for ~350ms before settling — slot-machine feel.
//
// Auto-injects on page load and hides itself when #pageContent (or
// #dashboardContent) flips from display:none to visible.
// ========================================================================

(function () {
  if (window.__loadingScreenInstalled) return;
  window.__loadingScreenInstalled = true;

  // ---- Geometry helpers --------------------------------------------------

  // Octagon centered at (cx, cy), inscribed in a circle of radius r.
  // Vertex angles are 22.5° + 45°·n so the flat sides land on top, bottom,
  // left, and right — the "upright" orientation people recognize.
  function octVertex(cx, cy, r, i) {
    var angle = (22.5 + i * 45) * Math.PI / 180;
    return {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle)
    };
  }
  function octPointsString(cx, cy, r) {
    var pts = [];
    for (var i = 0; i < 8; i++) {
      var v = octVertex(cx, cy, r, i);
      pts.push(v.x.toFixed(2) + ',' + v.y.toFixed(2));
    }
    return pts.join(' ');
  }
  function octSides(cx, cy, r) {
    var s = '';
    for (var i = 0; i < 8; i++) {
      var a = octVertex(cx, cy, r, i);
      var b = octVertex(cx, cy, r, (i + 1) % 8);
      s += '<line class="oct-side oct-side-' + i +
           '" x1="' + a.x.toFixed(2) + '" y1="' + a.y.toFixed(2) +
           '" x2="' + b.x.toFixed(2) + '" y2="' + b.y.toFixed(2) + '"/>';
    }
    return s;
  }
  function octPosts(cx, cy, r) {
    var s = '';
    for (var i = 0; i < 8; i++) {
      var v = octVertex(cx, cy, r, i);
      s += '<circle class="oct-post oct-post-' + i +
           '" cx="' + v.x.toFixed(2) + '" cy="' + v.y.toFixed(2) + '" r="3.5"/>';
    }
    return s;
  }

  // Radial tick marks pointing outward at each of the 8 vertices —
  // tactical-readout precision feel without enclosing the shape.
  function octTicks(cx, cy, r, length) {
    var s = '';
    for (var i = 0; i < 8; i++) {
      var angle = (22.5 + i * 45) * Math.PI / 180;
      var x1 = cx + r * Math.cos(angle);
      var y1 = cy + r * Math.sin(angle);
      var x2 = cx + (r + length) * Math.cos(angle);
      var y2 = cy + (r + length) * Math.sin(angle);
      s += '<line class="oct-tick" x1="' + x1.toFixed(2) + '" y1="' + y1.toFixed(2) +
           '" x2="' + x2.toFixed(2) + '" y2="' + y2.toFixed(2) + '"/>';
    }
    return s;
  }

  // Particle trail: three small sparks along each panel that flash in
  // sequence as the sweep arrives — creates the "energy moving" effect
  // versus discrete panels switching on. Total of 24 sparks (8×3).
  function octSparks(cx, cy, r) {
    var s = '';
    var sweepDur = 8; // seconds, matches the panel-sweep keyframe
    for (var i = 0; i < 8; i++) {
      var a = octVertex(cx, cy, r, i);
      var b = octVertex(cx, cy, r, (i + 1) % 8);
      for (var j = 0; j < 3; j++) {
        var t = 0.25 + j * 0.25;
        var sx = a.x + (b.x - a.x) * t;
        var sy = a.y + (b.y - a.y) * t;
        // Stagger: each panel starts at i seconds, sparks within a panel
        // ripple from start→end of the segment over ~150ms.
        var delay = i * (sweepDur / 8) + j * 0.06;
        s += '<circle class="oct-spark" cx="' + sx.toFixed(2) +
             '" cy="' + sy.toFixed(2) + '" r="1.2" ' +
             'style="animation-delay: ' + delay.toFixed(2) + 's"/>';
      }
    }
    return s;
  }

  // ---- Markup -----------------------------------------------------------

  var CX = 160, CY = 160, R = 128;

  var MARKUP =
    '<div class="oct-stage">' +
      '<svg class="oct-svg" viewBox="0 0 320 320" aria-hidden="true">' +
        '<defs>' +
          // Soft inner glow inside the canvas
          '<radialGradient id="octCanvasGlow" cx="50%" cy="50%" r="55%">' +
            '<stop offset="0%"  stop-color="rgba(193,59,46,0.10)"/>' +
            '<stop offset="70%" stop-color="rgba(193,59,46,0.02)"/>' +
            '<stop offset="100%" stop-color="rgba(193,59,46,0)"/>' +
          '</radialGradient>' +
          // Blurred outline used by the halo layer — gives the octagon
          // atmospheric "presence" rather than the drawn-on look.
          '<filter id="octHaloBlur" x="-20%" y="-20%" width="140%" height="140%">' +
            '<feGaussianBlur stdDeviation="3.5"/>' +
          '</filter>' +
        '</defs>' +

        // Inner canvas glow — subtle radial fill clipped to octagon shape
        '<polygon class="oct-canvas-glow" points="' + octPointsString(CX, CY, R) + '"/>' +

        // Soft halo (blurred crimson outline just outside the main one)
        '<polygon class="oct-halo" points="' + octPointsString(CX, CY, R + 3) + '" filter="url(#octHaloBlur)"/>' +

        // Concentric inner octagons — layered "radar / sonar" depth.
        // Outer (R-12), middle (R-32), inner (R-56), deepest (R-78).
        '<polygon class="oct-ring oct-ring--1" points="' + octPointsString(CX, CY, R - 12) + '"/>' +
        '<polygon class="oct-ring oct-ring--2" points="' + octPointsString(CX, CY, R - 32) + '"/>' +
        '<polygon class="oct-ring oct-ring--3" points="' + octPointsString(CX, CY, R - 56) + '"/>' +
        '<polygon class="oct-ring oct-ring--4" points="' + octPointsString(CX, CY, R - 78) + '"/>' +

        // The 8 panels, 8 corner posts, and 24 sparks — kinetic elements
        '<g class="oct-sides-group">' + octSides(CX, CY, R) + '</g>' +
        '<g class="oct-sparks-group">' + octSparks(CX, CY, R) + '</g>' +

        // Outer frame ring — thin dashed companion to the main outline,
        // creates the "bezel" feel that lifts this from polygon to UI element
        '<polygon class="oct-frame" points="' + octPointsString(CX, CY, R + 10) + '"/>' +

        // Radial tick marks at each vertex — engineering / readout vibe
        '<g class="oct-ticks-group">' + octTicks(CX, CY, R + 12, 6) + '</g>' +

        '<g class="oct-posts-group">' + octPosts(CX, CY, R) + '</g>' +

        // Hairline progress bar below the octagon
        '<line class="oct-progress-bg"   x1="60" y1="304" x2="260" y2="304"/>' +
        '<line class="oct-progress-fill" x1="60" y1="304" x2="260" y2="304"/>' +

        // Center stat readout (label + value only — unit dropped for restraint).
        // Generous vertical gap between label and value so the giant numeral
        // doesn't crowd the caption.
        '<text class="oct-stat-label" x="' + CX + '" y="' + (CY - 38) + '" text-anchor="middle">SIG STRIKES</text>' +
        '<text class="oct-stat-value" x="' + CX + '" y="' + (CY + 38) + '" text-anchor="middle" id="octStatValue">0</text>' +
      '</svg>' +
    '</div>' +

    '<p class="ld-wordmark"><span>Knockdown</span><span>Fantasy</span></p>' +
    '<p class="ld-tag" id="octStatRotator">Initializing…</p>';

  // ---- Stat ticker ------------------------------------------------------
  //
  // Each stat shows for ~2.6s. The first ~350ms is a scramble (random
  // digits flicker), then the value settles on its target. Cycles forever.

  // Each stat has a numeric `target`. For time values (control), the
  // target is total seconds and `format: 'mss'` displays as M:SS while
  // ramping. Stripping the unit row leaves the label + number as the
  // only typography in the center — more breathing room, less fact-sheet.
  var STATS = [
    { label: 'SIG STRIKES', target: 247, format: 'num' },
    { label: 'TAKEDOWNS',   target: 38,  format: 'num' },
    { label: 'CONTROL',     target: 282, format: 'mss' }, // 4:42
    { label: 'KO / TKO',    target: 19,  format: 'num' },
    { label: 'SUBMISSIONS', target: 12,  format: 'num' },
    { label: 'KNOCKDOWNS',  target: 31,  format: 'num' }
  ];

  function formatValue(value, format) {
    if (format === 'mss') {
      var sec = Math.floor(value);
      var m = Math.floor(sec / 60);
      var s = sec % 60;
      return m + ':' + (s < 10 ? '0' + s : s);
    }
    return String(Math.floor(value));
  }

  function startStatTicker(svg) {
    var labelEl = svg.querySelector('.oct-stat-label');
    var valueEl = svg.querySelector('#octStatValue');
    if (!labelEl || !valueEl) return;

    var idx = 0;
    var rafId = null;

    // Odometer ramp: count from 0 to target with ease-out cubic deceleration.
    // ~700ms total — long enough to feel like a count-up, short enough that
    // the value spends most of its slot in the "settled" state.
    function rampTo(target, format, duration) {
      if (rafId) cancelAnimationFrame(rafId);
      var startTs = null;
      function tick(now) {
        if (startTs == null) startTs = now;
        var t = Math.min(1, (now - startTs) / duration);
        var eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
        var current = eased * target;
        valueEl.textContent = formatValue(current, format);
        if (t < 1) {
          rafId = requestAnimationFrame(tick);
        } else {
          rafId = null;
        }
      }
      rafId = requestAnimationFrame(tick);
    }

    function show() {
      var stat = STATS[idx];
      labelEl.textContent = stat.label;
      rampTo(stat.target, stat.format, 700);
      idx = (idx + 1) % STATS.length;
    }

    show();
    var rotateTimer = setInterval(show, 2600);

    // Return a teardown so we can stop ticking once the overlay is hidden.
    return function teardown() {
      clearInterval(rotateTimer);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }

  // ---- Overlay lifecycle ------------------------------------------------

  var _teardownStats = null;

  function ensureOverlay() {
    if (document.getElementById('loadingScreen')) return document.getElementById('loadingScreen');
    var el = document.createElement('div');
    el.id = 'loadingScreen';
    el.className = 'loading-screen';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-label', 'Loading');
    el.innerHTML = MARKUP;

    function place() {
      document.body.insertBefore(el, document.body.firstChild);
      // Kick the stat ticker once the SVG is in the DOM.
      var svg = el.querySelector('.oct-svg');
      if (svg) _teardownStats = startStatTicker(svg);
    }

    if (document.body) {
      place();
    } else {
      document.addEventListener('DOMContentLoaded', place, { once: true });
    }
    return el;
  }

  function hide(overlay) {
    if (!overlay || overlay.classList.contains('loading-screen--hiding')) return;
    overlay.classList.add('loading-screen--hiding');
    if (_teardownStats) { _teardownStats(); _teardownStats = null; }
    window.setTimeout(function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 380);
  }

  function findPageWrapper() {
    return document.getElementById('pageContent')
        || document.getElementById('dashboardContent')
        || null;
  }
  function watchPageContent(overlay) {
    var pc = findPageWrapper();
    if (!pc) {
      // No wrapper on this page (e.g., signup/login) — hide on
      // window.load instead, which fires after all resources are ready.
      window.addEventListener('load', function () { hide(overlay); });
      return;
    }

    if (pc.style.display && pc.style.display !== 'none') {
      hide(overlay);
      return;
    }

    var observer = new MutationObserver(function () {
      if (pc.style.display && pc.style.display !== 'none') {
        observer.disconnect();
        hide(overlay);
      }
    });
    observer.observe(pc, { attributes: true, attributeFilter: ['style', 'class'] });

    // Safety net: hide after a generous timeout even if something never
    // calls display:block. Better to show the empty page than a frozen
    // loading screen forever.
    window.setTimeout(function () {
      observer.disconnect();
      hide(overlay);
    }, 15000);
  }

  window.LoadingScreen = {
    hide:    function () { hide(document.getElementById('loadingScreen')); },
    install: function () { var o = ensureOverlay(); watchPageContent(o); }
  };

  var overlay = ensureOverlay();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      watchPageContent(document.getElementById('loadingScreen') || overlay);
    }, { once: true });
  } else {
    watchPageContent(overlay);
  }
})();
