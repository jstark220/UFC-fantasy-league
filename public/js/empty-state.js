// ========================================================================
// EMPTY STATE
// Shared component for "nothing here yet" placeholders. Replaces the
// scattered `<p class="draft-empty">No X yet.</p>` italic-gray-text lines
// across the app with a consistent, branded card: SVG glyph, headline,
// sub-text, optional CTA.
//
// Usage:
//   EmptyState.html({
//     kind:    'roster' | 'trades' | 'fighters' | 'events' | 'activity'
//              | 'search' | 'standings' | 'claims' | 'generic',
//     title:   'Headline text',
//     body:    'Supporting sentence',          // optional
//     cta:     { label: '...', href: '...' },  // optional
//     compact: false,                          // tighter padding for nested
//                                              // panels (e.g. modal bodies)
//   })
//
//   -> returns an HTML string the caller can drop into innerHTML
//
//   EmptyState.render(elementOrId, opts)
//     Shorthand that replaces the element's contents.
//
// Icons are inline SVG so they pick up `currentColor` from the parent's
// text color — no separate icon font/dep needed.
// ========================================================================

(function (root) {

  // 64×64 line-art glyphs. Each is a single <svg> string so the consumer
  // doesn't need to know about viewBox sizing.
  function svg(paths) {
    return (
      '<svg class="empty-state__icon" viewBox="0 0 64 64" fill="none" ' +
        'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true">' +
        paths +
      '</svg>'
    );
  }

  var ICONS = {
    // Empty roster — clipboard + dashed slots
    roster: svg(
      '<rect x="14" y="10" width="36" height="44" rx="3" />' +
      '<path d="M22 10v-2a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v2" />' +
      '<path d="M22 22h20" stroke-dasharray="2 3" />' +
      '<path d="M22 32h20" stroke-dasharray="2 3" />' +
      '<path d="M22 42h12" stroke-dasharray="2 3" />'
    ),
    // No trade offers — two arrows in a circle
    trades: svg(
      '<circle cx="32" cy="32" r="22" />' +
      '<path d="M22 26h18" /><path d="m37 22 3 4-3 4" />' +
      '<path d="M42 38H24" /><path d="m27 34-3 4 3 4" />'
    ),
    // No fighters available — magnifier over blank
    fighters: svg(
      '<circle cx="26" cy="28" r="12" />' +
      '<path d="m36 38 12 12" />' +
      '<path d="M20 28h12" stroke-dasharray="2 3" />'
    ),
    // No events scheduled — calendar
    events: svg(
      '<rect x="10" y="14" width="44" height="40" rx="3" />' +
      '<path d="M10 24h44" />' +
      '<path d="M22 10v8" /><path d="M42 10v8" />' +
      '<circle cx="22" cy="36" r="2" fill="currentColor" stroke="none" />' +
      '<circle cx="32" cy="36" r="2" fill="currentColor" stroke="none" opacity="0.4" />' +
      '<circle cx="42" cy="36" r="2" fill="currentColor" stroke="none" opacity="0.4" />'
    ),
    // No activity yet — pulse / radar
    activity: svg(
      '<circle cx="32" cy="32" r="4" fill="currentColor" stroke="none" />' +
      '<circle cx="32" cy="32" r="12" opacity="0.55" />' +
      '<circle cx="32" cy="32" r="20" opacity="0.3" />'
    ),
    // Search returned nothing — magnifier with no-match line
    search: svg(
      '<circle cx="26" cy="26" r="14" />' +
      '<path d="m37 37 12 12" />' +
      '<path d="m20 32 12-12" />'
    ),
    // No standings / scoring yet — bar chart
    standings: svg(
      '<path d="M10 50h44" />' +
      '<rect x="14" y="34" width="8" height="16" />' +
      '<rect x="28" y="22" width="8" height="28" />' +
      '<rect x="42" y="28" width="8" height="22" />'
    ),
    // No claims — paper with check
    claims: svg(
      '<rect x="14" y="10" width="36" height="44" rx="3" />' +
      '<path d="M22 24h20" /><path d="M22 32h20" /><path d="M22 40h12" />'
    ),
    // Generic fallback — circle with dot
    generic: svg(
      '<circle cx="32" cy="32" r="22" />' +
      '<circle cx="32" cy="32" r="3" fill="currentColor" stroke="none" />'
    )
  };

  function escapeHtml(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function html(opts) {
    opts = opts || {};
    var kind = opts.kind || 'generic';
    var icon = ICONS[kind] || ICONS.generic;
    var title = opts.title || 'Nothing here yet';
    var body  = opts.body  || '';
    var cta   = opts.cta;

    var ctaHtml = '';
    if (cta && cta.label) {
      var klass = cta.kind === 'secondary' ? 'btn-secondary' : 'btn-primary';
      ctaHtml = cta.href
        ? '<a href="' + escapeHtml(cta.href) + '" class="' + klass + ' empty-state__cta">' + escapeHtml(cta.label) + '</a>'
        : '<button type="button" class="' + klass + ' empty-state__cta" data-empty-cta="1">' + escapeHtml(cta.label) + '</button>';
    }

    var rootClass = 'empty-state' + (opts.compact ? ' empty-state--compact' : '');
    return (
      '<div class="' + rootClass + '">' +
        '<div class="empty-state__icon-wrap">' + icon + '</div>' +
        '<p class="empty-state__title">' + escapeHtml(title) + '</p>' +
        (body ? '<p class="empty-state__body">' + escapeHtml(body) + '</p>' : '') +
        ctaHtml +
      '</div>'
    );
  }

  function render(target, opts) {
    var el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return null;
    el.innerHTML = html(opts);
    // Return the CTA button (if any) so callers can attach a handler.
    return el.querySelector('[data-empty-cta]');
  }

  root.EmptyState = { html: html, render: render };
})(typeof window !== 'undefined' ? window : this);
