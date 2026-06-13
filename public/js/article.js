// ========================================================================
// ARTICLE — public reader (article.html?slug=...)
//
// Public page: no auth gate. Anyone (logged in or not, including search
// engines) can read a published article. Drafts resolve only for their
// author, courtesy of the RLS SELECT policy.
//
// Renders the article's Markdown body with Articles.renderMarkdown, which
// sanitizes with DOMPurify, so author text can never inject scripts.
//
// Depends on: supabaseClient, Articles (articles.js), marked + DOMPurify.
// ========================================================================

(function () {
  var A = window.Articles;

  function $(id) { return document.getElementById(id); }

  // Swap the top-nav auth control based on whether someone's signed in.
  async function wireNavAuth(article) {
    var session = (await supabaseClient.auth.getSession()).data.session;
    var el = $('navAuth');
    if (session) {
      // Logged in: offer the dashboard, plus an Edit link if they wrote this.
      var editBtn = '';
      if (article && session.user && session.user.id === article.author_id) {
        editBtn = '<a class="btn-ghost" href="write.html">Edit</a>';
      }
      el.innerHTML = editBtn + '<a class="btn-ghost" href="dashboard.html">Dashboard</a>';
    } else {
      el.innerHTML = '<a class="btn-ghost" href="login.html">Log in</a>' +
                     '<a class="btn-primary" href="signup.html">Sign up free</a>';
    }
  }

  async function init() {
    var slug = new URLSearchParams(window.location.search).get('slug');
    if (!slug) { notFound(); return; }

    var article = await A.getBySlug(slug);
    if (!article) { notFound(); return; }

    // Optional cover art from the article's hero fighter.
    var hero = null;
    if (article.hero_fighter_id) {
      var map = await A.heroFighters([article]);
      hero = map[article.hero_fighter_id] || null;
    }

    render(article, hero);
    wireNavAuth(article);

    // Title the tab with the headline (helps when sharing / bookmarking).
    document.title = article.title + ' - Knockdown Fantasy';
  }

  function render(a, hero) {
    var draftFlag = a.status !== 'published'
      ? '<span class="article-draft-flag">Draft preview</span>' : '';

    var heroHtml = (hero && hero.photo_url)
      ? '<div class="article-hero-photo">' +
          '<img src="' + A.escapeHtml(hero.photo_url) + '" alt="' + A.escapeHtml(hero.name) + '" onerror="this.parentNode.style.display=\'none\'">' +
        '</div>'
      : '';

    var meta = [];
    if (a.author_name)   meta.push('By ' + A.escapeHtml(a.author_name));
    if (a.published_at)  meta.push(A.formatDate(a.published_at));
    meta.push(A.readMinutes(a.body_md) + ' min read');

    $('articleRoot').innerHTML =
      '<a class="article-back" href="analysis.html">← All analysis</a>' +
      '<header class="article-head">' +
        '<p class="article-cat">' + A.escapeHtml(A.categoryLabel(a.category)) + draftFlag + '</p>' +
        '<h1 class="article-title">' + A.escapeHtml(a.title) + '</h1>' +
        (a.dek ? '<p class="article-dek">' + A.escapeHtml(a.dek) + '</p>' : '') +
        '<p class="article-meta">' + meta.join(' · ') + '</p>' +
      '</header>' +
      heroHtml +
      '<div class="article-body">' + A.renderMarkdown(a.body_md) + '</div>' +
      '<div class="article-foot">' +
        '<a class="btn-secondary" href="analysis.html">← Back to all analysis</a>' +
      '</div>';
  }

  function notFound() {
    $('articleRoot').innerHTML =
      '<a class="article-back" href="analysis.html">← All analysis</a>' +
      '<div class="article-notfound">' +
        '<p class="article-notfound__title">Article not found</p>' +
        '<p class="article-notfound__sub">It may have been unpublished or the link is wrong.</p>' +
        '<a class="btn-primary" href="analysis.html">Browse analysis</a>' +
      '</div>';
    wireNavAuth(null);
  }

  init();
})();
