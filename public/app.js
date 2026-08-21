const state = {
  view: 'inbox',
  bootstrap: null,
  papers: [],
  selected: new Set(),
  selectedCategoryGroups: new Set(),
  selectedCategories: new Set(),
  collectionId: null,
  loading: false,
  hasMorePapers: false,
  aiPollTimer: null,
  paperLoadRequest: 0,
};

const PAPER_PAGE_SIZE = 100;

const elements = {
  title: document.querySelector('#view-title'),
  eyebrow: document.querySelector('#view-eyebrow'),
  paperWorkspace: document.querySelector('#paper-workspace'),
  paperList: document.querySelector('#paper-list'),
  paperSummary: document.querySelector('#paper-summary'),
  loadMoreWrap: document.querySelector('#load-more-wrap'),
  loadMoreButton: document.querySelector('#load-more-button'),
  search: document.querySelector('#search-input'),
  categoryFilter: document.querySelector('#category-filter'),
  categoryFilterLabel: document.querySelector('#category-filter-label'),
  categoryFilterMenu: document.querySelector('#category-filter-menu'),
  readFilter: document.querySelector('#read-filter'),
  updatedFilter: document.querySelector('#updated-filter'),
  timeFilter: document.querySelector('#time-filter'),
  sortFilter: document.querySelector('#sort-filter'),
  selectAll: document.querySelector('#select-all'),
  batchBar: document.querySelector('#batch-bar'),
  selectedCount: document.querySelector('#selected-count'),
  batchCollection: document.querySelector('#batch-collection'),
  collectionStrip: document.querySelector('#collection-strip'),
  subscriptionsPage: document.querySelector('#subscriptions-page'),
  collectionsPage: document.querySelector('#collections-page'),
  settingsPage: document.querySelector('#settings-page'),
  subscriptionList: document.querySelector('#subscription-list'),
  categoryOptions: document.querySelector('#category-options'),
  syncButton: document.querySelector('#sync-button'),
  syncStatus: document.querySelector('#sync-status'),
  dueBanner: document.querySelector('#due-banner'),
  dueMessage: document.querySelector('#due-message'),
  batchAi: document.querySelector('#batch-ai'),
  aiServiceStatus: document.querySelector('#ai-service-status'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value, includeTime = false) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC',
    year: date.getUTCFullYear() === new Date().getUTCFullYear() ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
    hour: includeTime ? '2-digit' : undefined,
    minute: includeTime ? '2-digit' : undefined,
  }).format(date);
}

function relativeTime(value) {
  if (!value) return 'Never synced';
  const difference = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(difference / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function api(path, options = {}) {
  const requestOptions = { ...options, headers: { ...(options.headers ?? {}) } };
  if (options.body && typeof options.body !== 'string') {
    requestOptions.body = JSON.stringify(options.body);
    requestOptions.headers['Content-Type'] = 'application/json';
  }
  if (options.method && !['GET', 'HEAD'].includes(options.method)) requestOptions.headers['X-AFU-Request'] = '1';
  const response = await fetch(path, requestOptions);
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error ?? `Request failed (${response.status})`);
  return payload;
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  document.querySelector('#toast-region').append(item);
  setTimeout(() => item.remove(), 4_000);
}

function setLoading(loading) {
  state.loading = loading;
  elements.syncButton.disabled = loading;
  elements.syncButton.innerHTML = loading ? '<span>↻</span> Syncing…' : '<span>↻</span> Sync now';
}

function updateStats(stats) {
  if (!state.bootstrap) return;
  state.bootstrap.stats = stats;
  document.querySelector('#inbox-count').textContent = stats.inbox ?? 0;
}

function updateSyncStatus() {
  const successful = state.bootstrap?.subscriptions
    ?.map((item) => item.last_successful_sync)
    .filter(Boolean)
    .sort()
    .at(-1);
  elements.syncStatus.textContent = successful ? `Last sync ${relativeTime(successful)}` : 'Not synced yet';
}

function updateDueBanner() {
  const count = state.bootstrap?.dueSubscriptionCount ?? 0;
  elements.dueBanner.classList.toggle('hidden', count === 0);
  elements.dueMessage.textContent = count ? `${count} 个 Active Subscription 已达到同步周期。` : '';
}

function renderCategoryOptions() {
  elements.categoryOptions.innerHTML = (state.bootstrap.categories ?? []).map((category) =>
    `<option value="${escapeHtml(category.code)}">${escapeHtml(category.name)} · ${escapeHtml(category.groupName)}</option>`
  ).join('');
}

function renderPaperCategoryFilters() {
  const groups = state.bootstrap.paperCategoryGroups ?? [];
  const validGroups = new Set(groups.map((group) => group.code));
  const validCategories = new Set(groups.flatMap((group) => group.categories.map((category) => category.code)));
  let changed = false;
  for (const code of state.selectedCategoryGroups) {
    if (!validGroups.has(code)) { state.selectedCategoryGroups.delete(code); changed = true; }
  }
  for (const code of state.selectedCategories) {
    if (!validCategories.has(code)) { state.selectedCategories.delete(code); changed = true; }
  }
  for (const group of groups) {
    if (!state.selectedCategoryGroups.has(group.code)) continue;
    for (const category of group.categories) {
      if (state.selectedCategories.delete(category.code)) changed = true;
    }
  }

  const selectedLabels = [
    ...state.selectedCategoryGroups,
    ...state.selectedCategories,
  ];
  elements.categoryFilterLabel.textContent = selectedLabels.length === 0
    ? 'All categories'
    : selectedLabels.length <= 2
      ? selectedLabels.join(', ')
      : `${selectedLabels.length} category selections`;
  elements.categoryFilter.classList.toggle('active', selectedLabels.length > 0);
  elements.categoryFilterMenu.innerHTML = `
    <div class="category-filter-actions">
      <strong>Category</strong>
      <button type="button" data-clear-categories ${selectedLabels.length ? '' : 'disabled'}>Clear</button>
    </div>
    ${groups.length ? groups.map((group) => {
      const groupSelected = state.selectedCategoryGroups.has(group.code);
      return `<section class="category-filter-group">
        <label class="category-group-option">
          <input type="checkbox" data-category-group="${escapeHtml(group.code)}" ${groupSelected ? 'checked' : ''}>
          <span><strong>${escapeHtml(group.code)}</strong><small>${escapeHtml(group.name)}</small></span>
        </label>
        <div class="category-filter-children">
          ${group.categories.map((category) => `<label>
            <input type="checkbox" data-category-code="${escapeHtml(category.code)}" data-parent-group="${escapeHtml(group.code)}"
              ${groupSelected || state.selectedCategories.has(category.code) ? 'checked' : ''} ${groupSelected ? 'disabled' : ''}>
            <span><strong>${escapeHtml(category.code)}</strong><small>${escapeHtml(category.name)}</small></span>
          </label>`).join('')}
        </div>
      </section>`;
    }).join('') : '<p class="category-filter-empty">No categories in Inbox</p>'}`;
  elements.categoryFilterMenu.querySelectorAll('[data-category-group]').forEach((checkbox) => {
    const group = groups.find((item) => item.code === checkbox.dataset.categoryGroup);
    checkbox.indeterminate = !checkbox.checked && group.categories.some((category) => state.selectedCategories.has(category.code));
  });
  return changed;
}

function categoryFilterSignature() {
  return JSON.stringify({
    groups: [...state.selectedCategoryGroups].sort(),
    categories: [...state.selectedCategories].sort(),
  });
}

function collectionOptions(selectedIds = []) {
  const selected = new Set(selectedIds.map(Number));
  return (state.bootstrap.collections ?? []).map((collection) =>
    `<option value="${collection.id}" ${selected.has(collection.id) ? 'disabled' : ''}>${escapeHtml(collection.name)}</option>`
  ).join('');
}

function renderCollectionControls() {
  const collections = state.bootstrap.collections ?? [];
  elements.batchCollection.innerHTML = collectionOptions();
  if (!state.collectionId && collections.length) state.collectionId = collections[0].id;
  elements.collectionStrip.innerHTML = collections.map((collection) => `
    <button class="collection-chip ${Number(state.collectionId) === Number(collection.id) ? 'active' : ''}" data-collection-id="${collection.id}">
      ${escapeHtml(collection.name)} · ${collection.paper_count}
    </button>
  `).join('');
}

function renderCollectionsManager() {
  const current = state.bootstrap.collections.find((collection) => Number(collection.id) === Number(state.collectionId));
  elements.collectionsPage.innerHTML = `
    <div class="collection-manage">
      <form id="create-collection-form">
        <input name="name" maxlength="80" placeholder="New collection name" required>
        <button class="button" type="submit">Create collection</button>
        ${current && current.name !== 'Favorites' ? `<button class="button secondary" id="delete-collection" type="button">Delete “${escapeHtml(current.name)}”</button>` : ''}
      </form>
    </div>`;
  document.querySelector('#create-collection-form').addEventListener('submit', createCollection);
  document.querySelector('#delete-collection')?.addEventListener('click', deleteCurrentCollection);
}

function aiExplanation(paper) {
  if (paper.ai_status === 'succeeded' && paper.explanation_zh) {
    return `<p class="ai-explanation ready"><span>AI</span>${escapeHtml(paper.explanation_zh)}</p>`;
  }
  if (paper.ai_status === 'pending' || paper.ai_status === 'running') {
    return `<p class="ai-explanation processing"><span>AI</span>正在生成中文解读…</p>`;
  }
  if (paper.ai_status === 'failed') {
    return `<p class="ai-explanation failed"><span>AI</span>生成失败，可展开后重试</p>`;
  }
  return '<p class="ai-explanation hidden"></p>';
}

function translationPlaceholder(paper) {
  if (paper.ai_status === 'failed') return '中文摘要生成失败，请重试。';
  if (paper.ai_status === 'pending' || paper.ai_status === 'running') return '中文摘要正在生成…';
  return '尚未生成中文摘要。';
}

function paperCard(paper) {
  const isUnread = Number(paper.is_read) === 0;
  const isUpdated = paper.unread_reason === 'updated';
  const categoryChips = paper.categories.slice(0, 4).map((category) => `<span class="category-pill">${escapeHtml(category)}</span>`).join('');
  const extraCategories = paper.categories.length > 4 ? `<span>+${paper.categories.length - 4}</span>` : '';
  const densityClass = state.bootstrap.settings.display_density === 'compact' ? 'compact' : '';
  const action = state.view === 'archive' ? 'inbox' : 'archive';
  const actionLabel = state.view === 'archive' ? 'Move to inbox' : 'Archive';
  const displayedDate = paper.updated_at ?? paper.announced_at;
  const displayedDateLabel = paper.updated_at ? 'Updated' : 'Announced';
  const abstractMode = state.bootstrap.settings.abstract_display_mode ?? 'original';
  return `
    <article class="paper-card ${isUnread ? 'unread' : ''} ${isUpdated ? 'updated' : ''} ${densityClass}" data-paper-id="${escapeHtml(paper.id)}">
      <label class="paper-check"><input class="paper-select" type="checkbox" ${state.selected.has(paper.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(paper.title)}"></label>
      <div class="paper-main" tabindex="0" role="button" aria-expanded="false">
        <div class="paper-title-row">
          <h3 class="paper-title">${escapeHtml(paper.title)}</h3>
          ${isUpdated ? '<span class="badge updated">Updated</span>' : ''}
        </div>
        <p class="authors">${escapeHtml(paper.authors || 'Unknown authors')}</p>
        ${aiExplanation(paper)}
        <div class="paper-meta">
          ${categoryChips}${extraCategories}
          <span>v${paper.latest_version}</span>
          <span title="${paper.updated_at ? 'Latest version timestamp from arXiv metadata (UTC)' : 'RSS announcement date (UTC); exact version timestamp is pending'}">${displayedDateLabel} ${formatDate(displayedDate)}</span>
          ${paper.matched_categories.length ? `<span>via ${escapeHtml(paper.matched_categories.join(', '))}</span>` : ''}
        </div>
        <div class="abstract" data-mode="${escapeHtml(abstractMode)}" data-ai-loaded="0">
          <div class="abstract-toolbar" role="group" aria-label="Abstract display">
            <button type="button" data-abstract-mode="original">原文</button>
            <button type="button" data-abstract-mode="translated">中文</button>
            <button type="button" data-abstract-mode="bilingual">双栏</button>
          </div>
          <div class="abstract-columns">
            <section class="abstract-pane original-pane"><strong>Original</strong><div>${escapeHtml(paper.abstract || 'No abstract in this RSS item.')}</div></section>
            <section class="abstract-pane translated-pane"><strong>中文翻译</strong><div class="translated-text">${escapeHtml(translationPlaceholder(paper))}</div></section>
          </div>
        </div>
      </div>
      <div class="paper-actions">
        <button class="icon-button" data-action="${isUnread ? 'read' : 'unread'}" title="${isUnread ? 'Mark read' : 'Mark unread'}">${isUnread ? '○' : '●'}</button>
        <button class="icon-button" data-action="${action}" title="${actionLabel}">${state.view === 'archive' ? '↥' : '□'}</button>
      </div>
      <div class="expanded-actions">
        <a class="button secondary paper-link" href="${escapeHtml(paper.arxiv_url)}" target="_blank" rel="noopener">arXiv page ↗</a>
        <a class="button secondary paper-link" href="${escapeHtml(paper.pdf_url)}" target="_blank" rel="noopener">PDF ↗</a>
        <select class="collection-picker" aria-label="Add to collection">${collectionOptions(paper.collection_ids)}</select>
        <button class="text-button" data-action="addToCollection">Add to collection</button>
        <button class="text-button" data-action="versions">Version history</button>
        ${paper.ai_status === 'failed' ? '<button class="text-button" data-action="ai-retry">Retry AI</button>' : ''}
        <div class="version-history"></div>
      </div>
    </article>`;
}

function renderPapers() {
  const filtersActive = Boolean(
    elements.search.value.trim()
    || state.selectedCategoryGroups.size
    || state.selectedCategories.size
    || elements.readFilter.value
    || elements.updatedFilter.value
    || elements.timeFilter.value
  );
  const viewTotal = state.view === 'inbox'
    ? Number(state.bootstrap.stats.inbox ?? 0)
    : state.view === 'archive'
      ? Number(state.bootstrap.stats.archived ?? 0)
      : Number(state.bootstrap.collections.find((collection) => Number(collection.id) === Number(state.collectionId))?.paper_count ?? 0);
  elements.paperSummary.textContent = filtersActive
    ? `${state.papers.length} shown${state.hasMorePapers ? ' · more available' : ''}`
    : `Showing ${state.papers.length} of ${viewTotal}`;
  elements.loadMoreWrap.classList.toggle('hidden', !state.hasMorePapers);
  if (!state.papers.length) {
    const copy = state.view === 'inbox'
      ? ['Inbox is clear', '新增论文和版本更新会出现在这里。']
      : state.view === 'archive'
        ? ['Nothing archived', '处理完成的论文会保留在这里。']
        : ['Collection is empty', '把论文加入收藏夹后会显示在这里。'];
    elements.paperList.innerHTML = `<div class="empty-state"><div class="empty-mark">✓</div><h3>${copy[0]}</h3><p>${copy[1]}</p></div>`;
  } else {
    elements.paperList.innerHTML = state.papers.map(paperCard).join('');
  }
  updateSelectionUi();
  ensureAiPolling();
}

function updateAiStatusText(status = state.bootstrap?.ai) {
  if (!status || !elements.aiServiceStatus) return;
  const modeLabels = { off: '关闭', auto: '自动', manual: '手动' };
  const blocked = status.blockedError ? ` · 已暂停：${status.blockedError}` : '';
  elements.aiServiceStatus.textContent = `模式：${modeLabels[status.mode] ?? status.mode} · 运行中 ${status.running ?? status.active ?? 0} · 等待 ${status.pending ?? 0} · 失败 ${status.failed ?? 0}${blocked}`;
}

async function loadPaperAi(card, paperId) {
  const abstract = card.querySelector('.abstract');
  if (!abstract || abstract.dataset.aiLoaded === '1') return;
  try {
    const payload = await api(`/api/papers/${encodeURIComponent(paperId)}/ai`);
    const analysis = payload.analysis;
    const target = abstract.querySelector('.translated-text');
    if (analysis?.status === 'succeeded' && analysis.translation_zh) {
      target.textContent = analysis.translation_zh;
      abstract.dataset.aiLoaded = '1';
    } else {
      target.textContent = translationPlaceholder({ ai_status: analysis?.status });
    }
  } catch (error) {
    abstract.querySelector('.translated-text').textContent = error.message;
  }
}

function patchAiResult(result) {
  const paper = state.papers.find((item) => item.id === result.paper_id);
  if (!paper) return;
  paper.ai_status = result.status;
  paper.explanation_zh = result.explanation_zh;
  paper.has_translation_zh = result.has_translation_zh;
  const card = [...elements.paperList.querySelectorAll('.paper-card')].find((item) => item.dataset.paperId === result.paper_id);
  if (!card) return;
  const old = card.querySelector('.ai-explanation');
  if (old) old.outerHTML = aiExplanation(paper);
  if (result.status === 'succeeded') {
    const abstract = card.querySelector('.abstract');
    if (abstract) abstract.dataset.aiLoaded = '0';
    if (card.classList.contains('expanded') && abstract?.dataset.mode !== 'original') void loadPaperAi(card, result.paper_id);
  }
}

function ensureAiPolling() {
  if (state.aiPollTimer) return;
  const hasWork = state.papers.some((paper) => ['pending', 'running'].includes(paper.ai_status));
  if (!hasWork) return;
  state.aiPollTimer = setTimeout(async () => {
    state.aiPollTimer = null;
    const ids = state.papers.slice(0, 100).map((paper) => paper.id);
    try {
      const params = new URLSearchParams({ ids: ids.join(',') });
      const payload = await api(`/api/ai/results?${params}`);
      payload.results.forEach(patchAiResult);
      state.bootstrap.ai = payload.status;
      updateAiStatusText(payload.status);
    } catch {}
    ensureAiPolling();
  }, 2_000);
}

function currentPaperFilters({ offset = 0, limit = PAPER_PAGE_SIZE + 1 } = {}) {
  const params = new URLSearchParams({ view: state.view === 'collections' ? 'collection' : state.view });
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (state.view === 'collections') params.set('collectionId', state.collectionId);
  if (elements.search.value.trim()) params.set('q', elements.search.value.trim());
  for (const category of state.selectedCategories) params.append('category', category);
  for (const group of state.selectedCategoryGroups) params.append('categoryGroup', group);
  if (elements.readFilter.value) params.set('read', elements.readFilter.value);
  if (elements.updatedFilter.value) params.set('updated', elements.updatedFilter.value);
  if (elements.sortFilter.value) params.set('sort', elements.sortFilter.value);
  if (elements.timeFilter.value) {
    const since = new Date(Date.now() - Number(elements.timeFilter.value) * 86_400_000);
    params.set('since', since.toISOString());
  }
  return params;
}

async function loadPapers({ append = false } = {}) {
  if (!['inbox', 'archive', 'collections'].includes(state.view)) return;
  if (state.view === 'collections' && !state.collectionId) {
    state.papers = [];
    state.hasMorePapers = false;
    renderPapers();
    return;
  }
  const requestId = ++state.paperLoadRequest;
  elements.paperList.classList.add('loading');
  try {
    const offset = append ? state.papers.length : 0;
    const payload = await api(`/api/papers?${currentPaperFilters({ offset })}`);
    if (requestId !== state.paperLoadRequest) return;
    const previousCategoryFilters = categoryFilterSignature();
    state.bootstrap.paperCategoryGroups = payload.paperCategoryGroups;
    renderPaperCategoryFilters();
    if (!append && previousCategoryFilters !== categoryFilterSignature()) {
      return loadPapers();
    }
    state.hasMorePapers = payload.papers.length > PAPER_PAGE_SIZE;
    const page = payload.papers.slice(0, PAPER_PAGE_SIZE);
    state.papers = append ? [...state.papers, ...page] : page;
    if (!append) state.selected.clear();
    updateStats(payload.stats);
    renderPapers();
  } catch (error) {
    if (requestId !== state.paperLoadRequest) return;
    toast(error.message, 'error');
  } finally {
    if (requestId === state.paperLoadRequest) elements.paperList.classList.remove('loading');
  }
}

function renderSubscriptions() {
  const subscriptions = state.bootstrap.subscriptions ?? [];
  elements.subscriptionList.innerHTML = subscriptions.length ? subscriptions.map((subscription) => `
    <article class="subscription-card" data-subscription-id="${subscription.id}">
      <div>
        <div class="subscription-title"><span class="status-dot ${subscription.status}"></span><strong>${escapeHtml(subscription.category)}</strong><span class="badge ${subscription.status === 'error' ? 'updated' : ''}">${subscription.status}</span></div>
        <div class="subscription-meta">Last successful sync: ${relativeTime(subscription.last_successful_sync)}${subscription.last_error ? ` · <span class="subscription-error">${escapeHtml(subscription.last_error)}</span>` : ''}</div>
      </div>
      <div class="subscription-actions">
        <button class="icon-button" data-subscription-action="sync" title="Sync">↻</button>
        <button class="icon-button" data-subscription-action="${subscription.status === 'paused' ? 'resume' : 'pause'}" title="${subscription.status === 'paused' ? 'Resume' : 'Pause'}">${subscription.status === 'paused' ? '▶' : 'Ⅱ'}</button>
        <button class="icon-button" data-subscription-action="unsubscribe" title="Unsubscribe">×</button>
      </div>
    </article>`).join('') : '<div class="empty-state"><div class="empty-mark">⌁</div><h3>No subscriptions yet</h3><p>添加一个 arXiv Category 开始追踪。</p></div>';
}

function showPage(view) {
  elements.paperWorkspace.classList.toggle('hidden', !['inbox', 'archive', 'collections'].includes(view));
  elements.subscriptionsPage.classList.toggle('hidden', view !== 'subscriptions');
  elements.collectionsPage.classList.toggle('hidden', view !== 'collections');
  elements.settingsPage.classList.toggle('hidden', view !== 'settings');
  elements.collectionStrip.classList.toggle('hidden', view !== 'collections');
  document.querySelectorAll('.nav-item[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
}

async function navigate(view) {
  state.view = view;
  state.selected.clear();
  if (['inbox', 'archive', 'collections'].includes(view)) {
    elements.sortFilter.value = view === 'inbox' ? 'updated' : 'activity';
  }
  const headings = {
    inbox: ['YOUR RESEARCH QUEUE', 'Inbox'],
    archive: ['PROCESSED PAPERS', 'Archive'],
    collections: ['SAVED FOR LATER', 'Collections'],
    subscriptions: ['TRACK BY CATEGORY', 'Subscriptions'],
    settings: ['LOCAL PREFERENCES', 'Settings'],
  };
  [elements.eyebrow.textContent, elements.title.textContent] = headings[view];
  showPage(view);
  if (view === 'subscriptions') renderSubscriptions();
  else if (view === 'collections') {
    renderCollectionControls();
    renderCollectionsManager();
    await loadPapers();
  } else if (['inbox', 'archive'].includes(view)) await loadPapers();
}

function updateSelectionUi() {
  elements.batchBar.classList.toggle('hidden', state.selected.size === 0);
  elements.selectedCount.textContent = `${state.selected.size} selected`;
  elements.selectAll.checked = state.papers.length > 0 && state.selected.size === state.papers.length;
  elements.selectAll.indeterminate = state.selected.size > 0 && state.selected.size < state.papers.length;
  elements.batchAi.classList.toggle('hidden', state.bootstrap?.ai?.mode !== 'manual');
}

async function paperAction(paperId, action, extra = {}, reload = true) {
  try {
    const payload = await api(`/api/papers/${encodeURIComponent(paperId)}`, { method: 'PATCH', body: { action, ...extra } });
    updateStats(payload.stats);
    if (reload) await loadPapers();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function runSync(subscriptionId = null) {
  if (state.loading) return;
  setLoading(true);
  try {
    const payload = await api('/api/sync', { method: 'POST', body: subscriptionId ? { subscriptionId } : {} });
    state.bootstrap.subscriptions = payload.subscriptions;
    state.bootstrap.paperCategoryGroups = payload.paperCategoryGroups;
    renderPaperCategoryFilters();
    state.bootstrap.dueSubscriptionCount = 0;
    updateStats(payload.stats);
    updateSyncStatus();
    updateDueBanner();
    renderSubscriptions();
    if (['inbox', 'archive', 'collections'].includes(state.view)) await loadPapers();
    toast(`${payload.newCount} new · ${payload.updatedCount} updated${payload.failedCount ? ` · ${payload.failedCount} failed` : ''}`, payload.failedCount ? 'error' : 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function addSubscription(event) {
  event.preventDefault();
  const input = document.querySelector('#category-input');
  const category = input.value.trim();
  if (!category) return;
  const button = event.submitter;
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    const payload = await api('/api/subscriptions', { method: 'POST', body: { category } });
    state.bootstrap.subscriptions = payload.subscriptions;
    state.bootstrap.paperCategoryGroups = payload.paperCategoryGroups;
    updateStats(payload.stats);
    renderPaperCategoryFilters();
    renderSubscriptions();
    input.value = '';
    toast(`${category}: ${payload.sync.newCount} new · ${payload.sync.updatedCount} updated${payload.sync.failedCount ? ' · sync failed' : ''}`, payload.sync.failedCount ? 'error' : 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Add & sync';
  }
}

async function createCollection(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    const payload = await api('/api/collections', { method: 'POST', body: { name: data.get('name') } });
    state.bootstrap.collections = payload.collections;
    state.collectionId = payload.collectionId;
    renderCollectionControls();
    renderCollectionsManager();
    await loadPapers();
    toast('Collection created');
  } catch (error) { toast(error.message, 'error'); }
}

async function deleteCurrentCollection() {
  const collection = state.bootstrap.collections.find((item) => Number(item.id) === Number(state.collectionId));
  if (!collection || !window.confirm(`Delete “${collection.name}”? Papers will not be deleted.`)) return;
  try {
    await api(`/api/collections/${collection.id}`, { method: 'DELETE' });
    const payload = await api('/api/collections');
    state.bootstrap.collections = payload.collections;
    state.collectionId = payload.collections[0]?.id ?? null;
    renderCollectionControls();
    renderCollectionsManager();
    await loadPapers();
    toast('Collection deleted');
  } catch (error) { toast(error.message, 'error'); }
}

async function restoreFromFile(file) {
  if (!file || !window.confirm('Restore this backup and replace all current ArxivFollowUp data?')) return;
  try {
    const payload = JSON.parse(await file.text());
    await api('/api/restore', { method: 'POST', body: payload });
    toast('Backup restored. Reloading…');
    setTimeout(() => location.reload(), 700);
  } catch (error) { toast(error.message, 'error'); }
}

function debounce(callback, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), wait);
  };
}

document.querySelectorAll('.nav-item[data-view]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
elements.syncButton.addEventListener('click', () => runSync());
document.querySelector('#due-sync-button').addEventListener('click', () => runSync());
elements.loadMoreButton.addEventListener('click', async () => {
  elements.loadMoreButton.disabled = true;
  elements.loadMoreButton.textContent = 'Loading…';
  await loadPapers({ append: true });
  elements.loadMoreButton.disabled = false;
  elements.loadMoreButton.textContent = 'Load 100 more';
});
document.querySelector('#add-subscription-form').addEventListener('submit', addSubscription);

elements.search.addEventListener('input', debounce(loadPapers, 250));
elements.categoryFilterMenu.addEventListener('change', (event) => {
  const groupCode = event.target.dataset.categoryGroup;
  const categoryCode = event.target.dataset.categoryCode;
  if (groupCode) {
    if (event.target.checked) state.selectedCategoryGroups.add(groupCode);
    else state.selectedCategoryGroups.delete(groupCode);
    const group = state.bootstrap.paperCategoryGroups.find((item) => item.code === groupCode);
    for (const category of group?.categories ?? []) state.selectedCategories.delete(category.code);
  } else if (categoryCode) {
    if (event.target.checked) state.selectedCategories.add(categoryCode);
    else state.selectedCategories.delete(categoryCode);
  } else return;
  renderPaperCategoryFilters();
  loadPapers();
});
elements.categoryFilterMenu.addEventListener('click', (event) => {
  if (!event.target.matches('[data-clear-categories]')) return;
  state.selectedCategoryGroups.clear();
  state.selectedCategories.clear();
  renderPaperCategoryFilters();
  loadPapers();
});
document.addEventListener('click', (event) => {
  if (!event.composedPath().includes(elements.categoryFilter)) elements.categoryFilter.open = false;
});
[elements.readFilter, elements.updatedFilter, elements.timeFilter, elements.sortFilter].forEach((element) => element.addEventListener('change', loadPapers));

elements.selectAll.addEventListener('change', () => {
  state.selected.clear();
  if (elements.selectAll.checked) state.papers.forEach((paper) => state.selected.add(paper.id));
  renderPapers();
});
document.querySelector('#clear-selection').addEventListener('click', () => { state.selected.clear(); renderPapers(); });

elements.collectionStrip.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-collection-id]');
  if (!button) return;
  state.collectionId = Number(button.dataset.collectionId);
  renderCollectionControls();
  renderCollectionsManager();
  await loadPapers();
});

elements.paperList.addEventListener('change', (event) => {
  if (!event.target.matches('.paper-select')) return;
  const id = event.target.closest('.paper-card').dataset.paperId;
  if (event.target.checked) state.selected.add(id); else state.selected.delete(id);
  updateSelectionUi();
});

elements.paperList.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches('.paper-main')) event.target.click();
});

elements.paperList.addEventListener('click', async (event) => {
  const card = event.target.closest('.paper-card');
  if (!card) return;
  const paperId = card.dataset.paperId;
  const abstractModeButton = event.target.closest('[data-abstract-mode]');
  if (abstractModeButton) {
    const abstract = card.querySelector('.abstract');
    abstract.dataset.mode = abstractModeButton.dataset.abstractMode;
    if (abstract.dataset.mode !== 'original') await loadPaperAi(card, paperId);
    return;
  }
  const main = event.target.closest('.paper-main');
  if (main) {
    const expanded = card.classList.toggle('expanded');
    main.setAttribute('aria-expanded', String(expanded));
    if (expanded && card.querySelector('.abstract')?.dataset.mode !== 'original') await loadPaperAi(card, paperId);
    if (expanded && card.classList.contains('unread')) {
      await paperAction(paperId, 'read', {}, false);
      card.classList.remove('unread', 'updated');
      card.querySelector('.badge.updated')?.remove();
      const readButton = card.querySelector('[data-action="read"]');
      if (readButton) { readButton.dataset.action = 'unread'; readButton.title = 'Mark unread'; readButton.textContent = '●'; }
    }
    return;
  }

  if (event.target.closest('.paper-link')) {
    if (card.classList.contains('unread')) void paperAction(paperId, 'read', {}, false);
    return;
  }

  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'ai-retry') {
    try {
      await api(`/api/papers/${encodeURIComponent(paperId)}/ai/retry`, { method: 'POST', body: {} });
      const paper = state.papers.find((item) => item.id === paperId);
      if (paper) { paper.ai_status = 'pending'; paper.explanation_zh = null; }
      renderPapers();
      toast('AI analysis queued');
    } catch (error) { toast(error.message, 'error'); }
    return;
  }
  if (action === 'versions') {
    const container = card.querySelector('.version-history');
    if (container.classList.toggle('visible') && !container.dataset.loaded) {
      try {
        const payload = await api(`/api/papers/${encodeURIComponent(paperId)}/versions`);
        container.innerHTML = payload.versions.map((version) => `<strong>v${version.version}</strong> · ${formatDate(version.announced_at)}${version.announce_type ? ` · ${escapeHtml(version.announce_type)}` : ''}`).join('<br>');
        container.dataset.loaded = '1';
      } catch (error) { toast(error.message, 'error'); }
    }
    return;
  }
  const extra = action === 'addToCollection' ? { collectionId: card.querySelector('.collection-picker').value } : {};
  await paperAction(paperId, action, extra);
  if (action === 'addToCollection') {
    const payload = await api('/api/collections');
    state.bootstrap.collections = payload.collections;
    toast('Added to collection');
  }
});

elements.batchBar.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-batch]');
  if (!button) return;
  const action = button.dataset.batch;
  const extra = action === 'addToCollection' ? { collectionId: elements.batchCollection.value } : {};
  const affectedCount = state.selected.size;
  try {
    if (action === 'ai') {
      const payload = await api('/api/ai/papers/batch', { method: 'POST', body: { paperIds: [...state.selected] } });
      for (const paper of state.papers) if (state.selected.has(paper.id) && paper.ai_status !== 'succeeded') paper.ai_status = 'pending';
      state.bootstrap.ai = payload.status;
      renderPapers();
      updateAiStatusText(payload.status);
      toast(`AI queued ${payload.queued} · skipped ${payload.alreadyCompleted + payload.alreadyQueued}`);
      return;
    }
    const payload = await api('/api/papers/batch', { method: 'POST', body: { paperIds: [...state.selected], action, ...extra } });
    updateStats(payload.stats);
    await loadPapers();
    toast(`Updated ${affectedCount} papers`);
  } catch (error) { toast(error.message, 'error'); }
});

elements.subscriptionList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-subscription-action]');
  if (!button) return;
  const card = button.closest('[data-subscription-id]');
  const id = Number(card.dataset.subscriptionId);
  const action = button.dataset.subscriptionAction;
  if (action === 'sync') return runSync(id);
  try {
    if (action === 'unsubscribe') {
      if (!window.confirm('Unsubscribe? Existing papers and states will be kept.')) return;
      await api(`/api/subscriptions/${id}`, { method: 'DELETE' });
      state.bootstrap.subscriptions = state.bootstrap.subscriptions.filter((item) => Number(item.id) !== id);
    } else {
      const payload = await api(`/api/subscriptions/${id}`, { method: 'PATCH', body: { action } });
      state.bootstrap.subscriptions = payload.subscriptions;
    }
    renderSubscriptions();
    updateSyncStatus();
  } catch (error) { toast(error.message, 'error'); }
});

document.querySelector('#refresh-days').addEventListener('change', async (event) => {
  try {
    const payload = await api('/api/settings', { method: 'PATCH', body: { refreshIntervalDays: Number(event.target.value) } });
    state.bootstrap.settings = payload.settings;
    toast('Refresh interval saved');
  } catch (error) { toast(error.message, 'error'); }
});
document.querySelector('#display-density').addEventListener('change', async (event) => {
  try {
    const payload = await api('/api/settings', { method: 'PATCH', body: { displayDensity: event.target.value } });
    state.bootstrap.settings = payload.settings;
    document.body.dataset.density = event.target.value;
    renderPapers();
  } catch (error) { toast(error.message, 'error'); }
});
document.querySelector('#open-browser-on-start').addEventListener('change', async (event) => {
  try {
    const payload = await api('/api/settings', { method: 'PATCH', body: { openBrowserOnStart: event.target.checked } });
    state.bootstrap.settings = payload.settings;
    toast('Startup browser preference saved');
  } catch (error) { toast(error.message, 'error'); }
});
document.querySelector('#ai-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const abstractDisplayMode = document.querySelector('#abstract-display-mode').value;
    const payload = await api('/api/ai/config', {
      method: 'PATCH',
      body: {
        mode: document.querySelector('#ai-mode').value,
        baseUrl: document.querySelector('#ai-base-url').value,
        model: document.querySelector('#ai-model').value,
        maxConcurrency: Number(document.querySelector('#ai-concurrency').value),
        abstractDisplayMode,
      },
    });
    state.bootstrap.ai = payload;
    state.bootstrap.settings.ai_processing_mode = payload.mode;
    state.bootstrap.settings.abstract_display_mode = abstractDisplayMode;
    updateAiStatusText(payload);
    updateSelectionUi();
    renderPapers();
    toast(payload.backfill?.queued ? `AI settings saved · queued ${payload.backfill.queued} Inbox papers` : 'AI settings saved');
  } catch (error) { toast(error.message, 'error'); }
  finally { if (button) button.disabled = false; }
});
document.querySelector('#abstract-display-mode').addEventListener('change', () => {
  document.querySelector('#ai-settings-form').requestSubmit();
});
document.querySelector('#test-ai').addEventListener('click', async (event) => {
  event.target.disabled = true;
  event.target.textContent = 'Testing…';
  try {
    const result = await api('/api/ai/test', { method: 'POST', body: {
      baseUrl: document.querySelector('#ai-base-url').value,
      model: document.querySelector('#ai-model').value,
    } });
    toast(`AI connected in ${result.latencyMs} ms`);
  } catch (error) { toast(error.message, 'error'); }
  finally { event.target.disabled = false; event.target.textContent = 'Test connection'; }
});
document.querySelector('#refresh-categories').addEventListener('click', async (event) => {
  event.target.disabled = true;
  try {
    const payload = await api('/api/categories/refresh', { method: 'POST' });
    state.bootstrap.categories = payload.categories;
    state.bootstrap.paperCategoryGroups = payload.paperCategoryGroups;
    renderCategoryOptions();
    renderPaperCategoryFilters();
    toast(`Category catalog refreshed (${payload.categories.length})`);
  } catch (error) { toast(error.message, 'error'); }
  finally { event.target.disabled = false; }
});
document.querySelector('#restore-input').addEventListener('change', (event) => restoreFromFile(event.target.files[0]));

async function boot() {
  try {
    state.bootstrap = await api('/api/bootstrap');
    updateStats(state.bootstrap.stats);
    renderCategoryOptions();
    renderPaperCategoryFilters();
    renderCollectionControls();
    renderSubscriptions();
    updateSyncStatus();
    updateDueBanner();
    document.querySelector('#refresh-days').value = state.bootstrap.settings.refresh_interval_days;
    document.querySelector('#display-density').value = state.bootstrap.settings.display_density;
    document.querySelector('#open-browser-on-start').checked = state.bootstrap.settings.open_browser_on_start !== '0';
    document.querySelector('#ai-mode').value = state.bootstrap.ai.mode;
    document.querySelector('#ai-base-url').value = state.bootstrap.ai.baseUrl;
    document.querySelector('#ai-model').value = state.bootstrap.ai.model;
    document.querySelector('#ai-concurrency').value = state.bootstrap.ai.maxConcurrency;
    document.querySelector('#abstract-display-mode').value = state.bootstrap.ai.abstractDisplayMode;
    updateAiStatusText(state.bootstrap.ai);
    await navigate('inbox');
    if (state.bootstrap.categoriesNeedRefresh) {
      api('/api/categories/refresh', { method: 'POST' }).then((payload) => {
        state.bootstrap.categories = payload.categories;
        renderCategoryOptions();
      }).catch(() => {});
    }
  } catch (error) {
    elements.paperList.innerHTML = `<div class="empty-state"><h3>Could not start ArxivFollowUp</h3><p>${escapeHtml(error.message)}</p></div>`;
  }
}

boot();
