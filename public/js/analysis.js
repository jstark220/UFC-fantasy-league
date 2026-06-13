// ========================================================================
// ANALYSIS — public index (analysis.html)
//
// Public listing of published articles with category filters. No auth gate.
// If the visitor is signed in we swap the nav CTA; if they're a flagged
// author we surface a "Write" button into the editor.
//
// Depends on: supabaseClient, Articles (articles.js).
// ========================================================================

(function () {
  var A = window.Articles;

  function $(id) { return document.getElementById(id); }

  var activeCategory = 'all';
  var heroMap = {};   // fighter_id -> { name, photo_url } for cover art

  async function init() {
    renderFilters();
    wireNav();
    await load();
  }

  // ---- Top-nav (optional auth + author Write button) --------------------
  async function wireNav() {
    var session = (await supabaseClient.auth.getSession()).data.session;
    if (session) {
      $('navAuth').innerHTML = '<a class="btn-ghost" href="dashboard.html">Dashboard</a>';
      // Only flagged authors get the Write entry point.
      var profile = await A.myProfile();
      if (profile && profile.is_author) {
        $('navWrite').innerHTML = '<a class="btn-secondary btn-sm" href="write.html">✎ Write</a>';
      }
    } else {
      $('navAuth').innerHTML = '<a class="btn-ghost" href="login.html">Log in</a>' +
                               '<a class="btn-primary" href="signup.html">Sign up free</a>';
    }
  }

  // ---- Category filter chips --------------------------------------------
  function renderFilters() {
    var chips = [{ id: 'all', label: 'All' }].concat(A.CATEGORIES);
    $('filters').innerHTML = chips.map(function (c) {
      var active = c.id === activeCategory ? ' analysis-chip--active' : '';
      return '<button class="analysis-chip' + active + '" data-cat="' + c.id + '">' +
             A.escapeHtml(c.label) + '</button>';
    }).join('');
    $('filters').querySelectorAll('.analysis-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activeCategory = btn.getAttribute('data-cat');
        renderFilters();
        load();
      });
    });
  }

  // ---- Load + render the grid -------------------------------------------
  async function load() {
    var grid = $('articleGrid');
    grid.innerHTML = '<p class="draft-empty">Loading analysis…</p>';
    var rows = await A.listPublished({ category: activeCategory });

    if (!rows.length) {
      grid.innerHTML =
        '<div class="analysis-empty">' +
          '<p class="analysis-empty__title">Nothing here yet.</p>' +
          '<p class="analysis-empty__sub">New analysis drops around every card.</p>' +
        '</div>';
      return;
    }

    heroMap = await A.heroFighters(rows);
    grid.innerHTML = rows.map(cardHtml).join('');
  }

  function cardHtml(a) {
    var hero = a.hero_fighter_id ? heroMap[a.hero_fighter_id] : null;
    var coverHtml = (hero && hero.photo_url)
      ? '<div class="analysis-card__cover"><img src="' + A.escapeHtml(hero.photo_url) +
        '" alt="" loading="lazy" onerror="this.parentNode.classList.add(\'analysis-card__cover--blank\')"></div>'
      : '<div class="analysis-card__cover analysis-card__cover--blank"></div>';

    var meta = [];
    if (a.author_name)  meta.push(A.escapeHtml(a.author_name));
    if (a.published_at) meta.push(A.formatDate(a.published_at));

    return (
      '<a class="analysis-card" href="article.html?slug=' + encodeURIComponent(a.slug) + '">' +
        coverHtml +
        '<div class="analysis-card__body">' +
          '<p class="analysis-card__cat">' + A.escapeHtml(A.categoryLabel(a.category)) + '</p>' +
          '<p class="analysis-card__title">' + A.escapeHtml(a.title) + '</p>' +
          (a.dek ? '<p class="analysis-card__dek">' + A.escapeHtml(a.dek) + '</p>' : '') +
          '<p class="analysis-card__meta">' + meta.join(' · ') + '</p>' +
        '</div>' +
      '</a>'
    );
  }

  init();
})();
