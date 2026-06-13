// ========================================================================
// WRITE — the author editor (write.html)
//
// Gated two ways: requireAuth() forces a login, then we check the user's
// profiles.is_author flag. Non-authors see a short "no access" note; the
// editor never renders for them (and RLS would block writes anyway).
//
// Flow: pick "New article" or one of your existing pieces, fill the form,
// watch the live preview, then Save draft or Publish. Slugs are generated
// from the headline once (on create) and kept stable on edits so published
// URLs never break.
//
// Depends on: supabaseClient, requireAuth (auth-guard.js), Articles
// (articles.js), and marked + DOMPurify (loaded on the page for preview).
// ========================================================================

(function () {
  var A = window.Articles;

  // ---- Editor state -----------------------------------------------------
  var profile      = null;   // { id, display_name, is_author }
  var currentId    = null;   // null = creating; otherwise editing this id
  var currentRow   = null;   // the loaded row (for stable slug + published_at)
  var heroId       = null;   // chosen cover fighter id
  var heroName     = null;
  var heroPhoto    = null;
  var previewTimer = null;

  // ---- DOM --------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  async function init() {
    var user = await requireAuth();
    if (!user) return;                 // redirected to login
    $('pageContent').style.display = '';

    profile = await A.myProfile();
    if (!profile || !profile.is_author) {
      $('notAuthor').style.display = '';
      return;
    }

    $('editor').style.display = '';
    populateCategories();
    wireEvents();
    setNew();
    await renderMyArticles();
  }

  function populateCategories() {
    $('fCategory').innerHTML = A.CATEGORIES.map(function (c) {
      return '<option value="' + c.id + '">' + c.label + '</option>';
    }).join('');
  }

  // ---- Form <-> state ---------------------------------------------------

  function setNew() {
    currentId = null;
    currentRow = null;
    $('fTitle').value = '';
    $('fDek').value = '';
    $('fCategory').value = 'waiver_wire';
    $('fBody').value = '';
    clearHero();
    $('deleteBtn').style.display = 'none';
    $('viewLink').style.display = 'none';
    $('saveStatus').textContent = '';
    updatePreview();
    highlightActiveInList();
  }

  function fillForm(row) {
    currentId = row.id;
    currentRow = row;
    $('fTitle').value = row.title || '';
    $('fDek').value = row.dek || '';
    $('fCategory').value = row.category || 'strategy';
    $('fBody').value = row.body_md || '';
    if (row.hero_fighter_id) {
      // Load the chosen fighter's name/photo for the chip + preview.
      supabaseClient.from('fighters').select('id, name, photo_url')
        .eq('id', row.hero_fighter_id).maybeSingle().then(function (res) {
          if (res && res.data) setHero(res.data); else clearHero();
        });
    } else {
      clearHero();
    }
    $('deleteBtn').style.display = '';
    updateViewLink(row);
    $('saveStatus').textContent = '';
    updatePreview();
    highlightActiveInList();
  }

  function gather() {
    return {
      title:           $('fTitle').value.trim(),
      dek:             $('fDek').value.trim(),
      category:        $('fCategory').value,
      body_md:         $('fBody').value,
      hero_fighter_id: heroId
    };
  }

  // ---- Save / publish / delete ------------------------------------------

  async function save(status) {
    var f = gather();
    if (!f.title) { flash('Add a headline first.', true); return; }
    f.status = status;

    setBusy(true);
    var res;
    if (currentId) {
      // Editing: keep the existing slug so the URL stays stable.
      f.slug = currentRow.slug;
      res = await A.update(currentId, f, currentRow);
    } else {
      // Creating: derive a slug from the headline, retry once on collision.
      f.slug = A.slugify(f.title) || ('post-' + Date.now());
      res = await A.create(f, profile);
      if (res && res.error && res.error.code === '23505') {
        f.slug = f.slug + '-' + Math.random().toString(36).slice(2, 6);
        res = await A.create(f, profile);
      }
    }
    setBusy(false);

    if (res && res.error) { flash('Could not save: ' + res.error.message, true); return; }
    var row = res.data;
    currentId = row.id;
    currentRow = row;
    updateViewLink(row);
    $('deleteBtn').style.display = '';
    flash(status === 'published' ? 'Published.' : 'Draft saved.', false);
    await renderMyArticles();
  }

  async function del() {
    if (!currentId) return;
    if (!confirm('Delete this article? This cannot be undone.')) return;
    var res = await A.remove(currentId);
    if (res && res.error) { flash('Could not delete: ' + res.error.message, true); return; }
    setNew();
    await renderMyArticles();
  }

  // ---- My-articles list -------------------------------------------------

  async function renderMyArticles() {
    var rows = await A.listMine();
    var el = $('myArticles');
    if (!rows.length) { el.innerHTML = '<p class="draft-empty">No articles yet. Write your first one.</p>'; return; }
    el.innerHTML = rows.map(function (r) {
      var statusCls = r.status === 'published' ? 'write-pill--live' : 'write-pill--draft';
      var statusTxt = r.status === 'published' ? 'Published' : 'Draft';
      return (
        '<button class="write-list__item" data-slug="' + A.escapeHtml(r.slug) + '">' +
          '<span class="write-list__title">' + A.escapeHtml(r.title || 'Untitled') + '</span>' +
          '<span class="write-list__meta">' +
            '<span class="write-pill ' + statusCls + '">' + statusTxt + '</span>' +
            '<span class="write-list__cat">' + A.escapeHtml(A.categoryLabel(r.category)) + '</span>' +
          '</span>' +
        '</button>'
      );
    }).join('');
    el.querySelectorAll('.write-list__item').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var row = await A.getBySlug(btn.getAttribute('data-slug'));
        if (row) fillForm(row);
      });
    });
    highlightActiveInList();
  }

  function highlightActiveInList() {
    document.querySelectorAll('.write-list__item').forEach(function (btn) {
      var isActive = currentRow && btn.getAttribute('data-slug') === currentRow.slug;
      btn.classList.toggle('write-list__item--active', !!isActive);
    });
  }

  // ---- Cover-fighter search --------------------------------------------

  var heroSearchTimer = null;
  function onHeroSearch() {
    clearTimeout(heroSearchTimer);
    var q = $('fHero').value.trim();
    if (q.length < 2) { $('heroResults').innerHTML = ''; return; }
    heroSearchTimer = setTimeout(async function () {
      var res = await supabaseClient.from('fighters')
        .select('id, name, photo_url').ilike('name', '%' + q + '%').limit(6);
      var rows = res.data || [];
      $('heroResults').innerHTML = rows.map(function (f) {
        var photo = f.photo_url
          ? '<img src="' + A.escapeHtml(f.photo_url) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
          : '<span class="write-hero-ph"></span>';
        return '<button class="write-hero-opt" data-id="' + f.id + '">' + photo +
               '<span>' + A.escapeHtml(f.name) + '</span></button>';
      }).join('');
      $('heroResults').querySelectorAll('.write-hero-opt').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var f = rows.find(function (x) { return x.id === btn.getAttribute('data-id'); });
          if (f) { setHero(f); $('fHero').value = ''; $('heroResults').innerHTML = ''; }
        });
      });
    }, 220);
  }

  function setHero(f) {
    heroId = f.id; heroName = f.name; heroPhoto = f.photo_url;
    var photo = f.photo_url
      ? '<img src="' + A.escapeHtml(f.photo_url) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
      : '<span class="write-hero-ph"></span>';
    $('heroChosen').innerHTML = photo + '<span>' + A.escapeHtml(f.name) + '</span>' +
      '<button class="write-hero-remove" type="button" aria-label="Remove cover">&times;</button>';
    $('heroChosen').style.display = '';
    $('heroChosen').querySelector('.write-hero-remove').addEventListener('click', clearHero);
    updatePreview();
  }

  function clearHero() {
    heroId = null; heroName = null; heroPhoto = null;
    $('heroChosen').innerHTML = ''; $('heroChosen').style.display = 'none';
    $('heroResults').innerHTML = '';
    updatePreview();
  }

  // ---- Live preview -----------------------------------------------------

  function updatePreview() {
    var title = $('fTitle').value.trim();
    var dek   = $('fDek').value.trim();
    var cat   = A.categoryLabel($('fCategory').value);
    var heroHtml = heroPhoto
      ? '<div class="article-hero-photo"><img src="' + A.escapeHtml(heroPhoto) + '" alt="" onerror="this.style.display=\'none\'"></div>'
      : '';
    $('preview').innerHTML =
      '<p class="article-cat">' + A.escapeHtml(cat) + '</p>' +
      '<h1 class="article-title">' + (A.escapeHtml(title) || '<span class="article-dim">Headline</span>') + '</h1>' +
      (dek ? '<p class="article-dek">' + A.escapeHtml(dek) + '</p>' : '') +
      heroHtml +
      '<div class="article-body">' + A.renderMarkdown($('fBody').value) + '</div>';
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 160);
  }

  // ---- UI helpers -------------------------------------------------------

  function updateViewLink(row) {
    var link = $('viewLink');
    if (row.status === 'published') {
      link.href = 'article.html?slug=' + encodeURIComponent(row.slug);
      link.style.display = '';
    } else {
      link.style.display = 'none';
    }
  }

  function flash(msg, isError) {
    var el = $('saveStatus');
    el.textContent = msg;
    el.className = 'write-status' + (isError ? ' write-status--error' : ' write-status--ok');
  }

  function setBusy(busy) {
    $('publishBtn').disabled = busy;
    $('draftBtn').disabled = busy;
    if (busy) flash('Saving…', false);
  }

  function wireEvents() {
    $('fTitle').addEventListener('input', schedulePreview);
    $('fDek').addEventListener('input', schedulePreview);
    $('fCategory').addEventListener('change', updatePreview);
    $('fBody').addEventListener('input', schedulePreview);
    $('fHero').addEventListener('input', onHeroSearch);
    $('newArticleBtn').addEventListener('click', setNew);
    $('publishBtn').addEventListener('click', function () { save('published'); });
    $('draftBtn').addEventListener('click', function () { save('draft'); });
    $('deleteBtn').addEventListener('click', del);
  }

  init();
})();
