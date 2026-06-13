// ========================================================================
// ARTICLES — shared data layer + safe Markdown rendering
//
// One module that the three Analysis pages all use:
//   analysis.html / analysis.js  — public index (list published)
//   article.html  / article.js   — public reader (one article by slug)
//   write.html    / write.js      — gated editor (author create/edit)
//
// Reads/writes the `articles` table created by
// sql/2026-06-13_articles.sql under RLS:
//   - published rows are readable by everyone (incl. anonymous visitors)
//   - drafts are readable only by their author
//   - only profiles with is_author = true can insert/update/delete, and
//     only their own rows
//
// Markdown is rendered with marked (parse) + DOMPurify (sanitize), both
// loaded via CDN on the pages that need them. We NEVER inject raw article
// HTML without sanitizing — body_md is author-controlled text and could
// otherwise carry a script tag.
//
// Depends on supabaseClient (supabase-config.js). marked / DOMPurify are
// optional and feature-gated, so this file is safe to load on a page that
// only lists articles (no rendering needed there).
// ========================================================================

(function (root) {

  // ---- Categories -------------------------------------------------------
  // The id is what's stored in articles.category; the label is what readers
  // see. Add/rename here and every surface (filters, cards, editor) updates.
  var CATEGORIES = [
    { id: 'waiver_wire',   label: 'Waiver Wire' },
    { id: 'rankings',      label: 'Rankings' },
    { id: 'event_preview', label: 'Event Preview' },
    { id: 'recap',         label: 'Recap' },
    { id: 'strategy',      label: 'Strategy' }
  ];

  function categoryLabel(id) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].id === id) return CATEGORIES[i].label;
    }
    return 'Analysis';
  }

  // ---- Small helpers ----------------------------------------------------

  function escapeHtml(str) {
    if (str == null) return '';
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  // "UFC 320: Waiver Wire Targets!" -> "ufc-320-waiver-wire-targets"
  // Lowercase, spaces/punctuation to single hyphens, trimmed.
  function slugify(text) {
    return String(text || '')
      .toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip accents
      .replace(/[^a-z0-9]+/g, '-')                       // non-alnum -> hyphen
      .replace(/^-+|-+$/g, '')                           // trim hyphens
      .slice(0, 80);
  }

  // "2026-06-13T..." -> "June 13, 2026"
  function formatDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
      });
    } catch (e) { return ''; }
  }

  // Rough read-time estimate from the markdown source (~220 wpm).
  function readMinutes(md) {
    var words = String(md || '').trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 220));
  }

  // ---- Markdown rendering (sanitized) -----------------------------------
  // Returns trusted HTML, or a plain-text fallback if the libs aren't loaded.
  function renderMarkdown(md) {
    var src = String(md || '');
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      // Fallback: show the raw text safely rather than nothing.
      return '<pre class="article-md-fallback">' + escapeHtml(src) + '</pre>';
    }
    var rawHtml = marked.parse(src, { breaks: true, gfm: true });
    // Sanitize: strip scripts/event handlers, keep normal article markup.
    return DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: ['target', 'rel'],
      FORBID_TAGS: ['style', 'iframe', 'form', 'input'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick']
    });
  }

  // ---- Reads (public) ---------------------------------------------------

  // Columns the index/reader need. We avoid joining profiles (byline is
  // denormalized onto author_name), so these queries work for anon readers.
  var LIST_COLS = 'id, slug, title, dek, category, status, author_name, ' +
                  'hero_fighter_id, published_at, created_at';
  var FULL_COLS = LIST_COLS + ', body_md, author_id, updated_at';

  // List published articles, optionally filtered by category. Newest first.
  async function listPublished(opts) {
    opts = opts || {};
    var q = supabaseClient
      .from('articles')
      .select(LIST_COLS)
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(opts.limit || 60);
    if (opts.category && opts.category !== 'all') q = q.eq('category', opts.category);
    var res = await q;
    return res.data || [];
  }

  // One article by slug (published, or the author's own draft via RLS).
  async function getBySlug(slug) {
    var res = await supabaseClient
      .from('articles').select(FULL_COLS).eq('slug', slug).maybeSingle();
    return (res && res.data) || null;
  }

  // Fetch hero fighters' photos for a set of article rows in one query.
  // Returns { fighter_id: { name, photo_url } }.
  async function heroFighters(rows) {
    var ids = [];
    (rows || []).forEach(function (r) {
      if (r.hero_fighter_id && ids.indexOf(r.hero_fighter_id) === -1) ids.push(r.hero_fighter_id);
    });
    if (!ids.length) return {};
    var res = await supabaseClient
      .from('fighters').select('id, name, photo_url').in('id', ids);
    var map = {};
    (res.data || []).forEach(function (f) { map[f.id] = f; });
    return map;
  }

  // ---- Author check + writes (gated by RLS) -----------------------------

  // The current user's profile, including the is_author flag. null if signed
  // out. Used by write.html to gate the editor and stamp the byline.
  async function myProfile() {
    var s = (await supabaseClient.auth.getSession()).data.session;
    if (!s) return null;
    var res = await supabaseClient
      .from('profiles').select('id, display_name, is_author').eq('id', s.user.id).maybeSingle();
    return (res && res.data) || null;
  }

  // Articles authored by the current user (drafts + published), newest first.
  async function listMine() {
    var s = (await supabaseClient.auth.getSession()).data.session;
    if (!s) return [];
    var res = await supabaseClient
      .from('articles').select(LIST_COLS)
      .eq('author_id', s.user.id)
      .order('updated_at', { ascending: false });
    return res.data || [];
  }

  // Insert a new article. `fields` carries title/dek/category/body_md/
  // hero_fighter_id/status. author_id + author_name are stamped from the
  // session/profile so the caller can't spoof them (RLS also enforces
  // author_id = auth.uid()). Returns { data, error }.
  async function create(fields, profile) {
    var row = {
      slug:            fields.slug,
      title:           fields.title,
      dek:             fields.dek || null,
      category:        fields.category,
      body_md:         fields.body_md || '',
      status:          fields.status || 'draft',
      author_id:       profile.id,
      author_name:     profile.display_name || 'Staff',
      hero_fighter_id: fields.hero_fighter_id || null,
      published_at:    fields.status === 'published' ? new Date().toISOString() : null
    };
    return await supabaseClient.from('articles').insert(row).select(FULL_COLS).maybeSingle();
  }

  // Update an existing article by id. Only the editable fields are sent.
  // When transitioning draft -> published the first time, stamp published_at.
  async function update(id, fields, existing) {
    var patch = {
      slug:            fields.slug,
      title:           fields.title,
      dek:             fields.dek || null,
      category:        fields.category,
      body_md:         fields.body_md || '',
      status:          fields.status,
      hero_fighter_id: fields.hero_fighter_id || null
    };
    if (fields.status === 'published' && existing && !existing.published_at) {
      patch.published_at = new Date().toISOString();
    }
    return await supabaseClient.from('articles').update(patch).eq('id', id).select(FULL_COLS).maybeSingle();
  }

  async function remove(id) {
    return await supabaseClient.from('articles').delete().eq('id', id);
  }

  root.Articles = {
    CATEGORIES:     CATEGORIES,
    categoryLabel:  categoryLabel,
    escapeHtml:     escapeHtml,
    slugify:        slugify,
    formatDate:     formatDate,
    readMinutes:    readMinutes,
    renderMarkdown: renderMarkdown,
    listPublished:  listPublished,
    getBySlug:      getBySlug,
    heroFighters:   heroFighters,
    myProfile:      myProfile,
    listMine:       listMine,
    create:         create,
    update:         update,
    remove:         remove
  };
})(typeof window !== 'undefined' ? window : this);
