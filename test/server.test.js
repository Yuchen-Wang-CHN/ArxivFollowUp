import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, getSecret } from '../src/db.js';
import { createApp } from '../src/server.js';
import { ingestFeed, syncSubscriptions } from '../src/sync.js';

test('serves bootstrap and validates local mutation header', async (context) => {
  const db = createDatabase(':memory:');
  const app = createApp({ db, port: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  context.after(() => { app.server.close(); db.close(); });
  const { port } = app.server.address();

  const bootstrapResponse = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.stats.inbox, 0);
  assert.equal(bootstrap.collections[0].name, 'Favorites');

  const katexResponse = await fetch(`http://127.0.0.1:${port}/vendor/katex/katex.min.css`);
  assert.equal(katexResponse.status, 200);
  assert.match(katexResponse.headers.get('content-type'), /^text\/css/);
  assert.match(await katexResponse.text(), /\.katex/);

  const denied = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshIntervalDays: 2 }),
  });
  assert.equal(denied.status, 403);

  const allowed = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-AFU-Request': '1' }, body: JSON.stringify({ refreshIntervalDays: 7, openBrowserOnStart: false }),
  });
  assert.equal(allowed.status, 200);
  const savedSettings = (await allowed.json()).settings;
  assert.equal(savedSettings.refresh_interval_days, '7');
  assert.equal(savedSettings.open_browser_on_start, '0');

  const focusResponse = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-AFU-Request': '1' }, body: JSON.stringify({ focusThreshold: 0.61 }),
  });
  const focusPayload = await focusResponse.json();
  assert.equal(focusResponse.status, 200);
  assert.equal(focusPayload.settings.focus_threshold, '0.61');
  assert.equal(focusPayload.settings.classification_threshold, '0.55');
  assert.equal(focusPayload.stats.focus, 0);

  const invalidFocus = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-AFU-Request': '1' }, body: JSON.stringify({ focusThreshold: 0.5 }),
  });
  assert.equal(invalidFocus.status, 400);
});

test('paper API accepts repeated category and category-group filters', async (context) => {
  const db = createDatabase(':memory:');
  const now = '2026-08-20T00:00:00.000Z';
  const inserted = db.prepare("INSERT INTO subscriptions (category, created_at) VALUES ('cs.AI', ?)").run(now);
  const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(Number(inserted.lastInsertRowid));
  const paper = (id, categories) => ({
    id, version: 1, title: id, authors: 'Author', abstract: 'Abstract', categories, announcedAt: now,
    arxivUrl: `https://arxiv.org/abs/${id}`, pdfUrl: `https://arxiv.org/pdf/${id}`, announceType: 'new',
  });
  ingestFeed(db, subscription, { errors: [], papers: [
    paper('2608.00001', ['cs.AI']),
    paper('2608.00002', ['stat.ML']),
    paper('2608.00003', ['math.OC']),
  ] }, now);

  const app = createApp({ db, port: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  context.after(() => { app.server.close(); db.close(); });
  const { port } = app.server.address();

  const exactResponse = await fetch(`http://127.0.0.1:${port}/api/papers?category=stat.ML&category=math.OC`);
  assert.equal(exactResponse.status, 200);
  assert.deepEqual((await exactResponse.json()).papers.map((item) => item.id).sort(), ['2608.00002', '2608.00003']);

  const mixedResponse = await fetch(`http://127.0.0.1:${port}/api/papers?categoryGroup=stat&category=math.OC`);
  assert.equal(mixedResponse.status, 200);
  assert.deepEqual((await mixedResponse.json()).papers.map((item) => item.id).sort(), ['2608.00002', '2608.00003']);
});

test('sync API reports changes from a background run unseen by the page', async (context) => {
  const db = createDatabase(':memory:');
  const now = '2026-08-20T00:00:00.000Z';
  const inserted = db.prepare("INSERT INTO subscriptions (category, created_at) VALUES ('cs.AI', ?)").run(now);
  const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(Number(inserted.lastInsertRowid));
  const paper = {
    id: '2608.00001', version: 1, title: 'Background paper', authors: 'Author', abstract: 'Abstract',
    categories: ['cs.AI'], announcedAt: now, arxivUrl: 'https://arxiv.org/abs/2608.00001',
    pdfUrl: 'https://arxiv.org/pdf/2608.00001', announceType: 'new',
  };

  const background = await syncSubscriptions(db, [subscription], {
    fetchFeed: async () => ({ papers: [paper], errors: [] }),
    fetchMetadata: async () => [],
  });
  assert.equal(background.newCount, 1);

  const app = createApp({
    db,
    port: 0,
    syncOptions: {
      fetchFeed: async () => ({ papers: [paper], errors: [] }),
      fetchMetadata: async () => [],
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  context.after(() => { app.server.close(); db.close(); });
  const { port } = app.server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AFU-Request': '1' },
    body: JSON.stringify({ afterSyncRunId: 0 }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.newCount, 0);
  assert.equal(payload.updatedCount, 0);
  assert.deepEqual(payload.changesSince, {
    runCount: 2,
    newCount: 1,
    updatedCount: 0,
    failedCount: 0,
    latestSyncRunId: payload.runId,
  });
});

test('adding a paper to a collection removes it from Inbox', async (context) => {
  const db = createDatabase(':memory:');
  const now = '2026-08-20T00:00:00.000Z';
  const inserted = db.prepare("INSERT INTO subscriptions (category, created_at) VALUES ('cs.AI', ?)").run(now);
  const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(Number(inserted.lastInsertRowid));
  ingestFeed(db, subscription, { errors: [], papers: [{
    id: '2608.01001', version: 1, title: 'Collected paper', authors: 'Author', abstract: 'Abstract',
    categories: ['cs.AI'], announcedAt: now, arxivUrl: 'https://arxiv.org/abs/2608.01001',
    pdfUrl: 'https://arxiv.org/pdf/2608.01001', announceType: 'new',
  }] }, now);
  const favorites = db.prepare("SELECT id FROM collections WHERE name = 'Favorites'").get();

  const app = createApp({ db, port: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  context.after(() => { app.server.close(); db.close(); });
  const { port } = app.server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/papers/2608.01001`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-AFU-Request': '1' },
    body: JSON.stringify({ action: 'addToCollection', collectionId: favorites.id }),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).stats.inbox, 0);
  const inboxResponse = await fetch(`http://127.0.0.1:${port}/api/papers?view=inbox`);
  assert.deepEqual((await inboxResponse.json()).papers, []);
  const collectionResponse = await fetch(`http://127.0.0.1:${port}/api/papers?view=collection&collectionId=${favorites.id}`);
  assert.deepEqual((await collectionResponse.json()).papers.map((paper) => paper.id), ['2608.01001']);
  const archiveResponse = await fetch(`http://127.0.0.1:${port}/api/papers?view=archive`);
  assert.deepEqual((await archiveResponse.json()).papers, []);

  const createResponse = await fetch(`http://127.0.0.1:${port}/api/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AFU-Request': '1' },
    body: JSON.stringify({ name: 'Reading list' }),
  });
  const readingListId = (await createResponse.json()).collectionId;
  const changeCollection = (action, collectionId) => fetch(`http://127.0.0.1:${port}/api/papers/2608.01001`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-AFU-Request': '1' },
    body: JSON.stringify({ action, collectionId }),
  });

  await changeCollection('addToCollection', readingListId);
  ingestFeed(db, subscription, { errors: [], papers: [{
    id: '2608.01001', version: 2, title: 'Collected paper v2', authors: 'Author', abstract: 'Updated abstract',
    categories: ['cs.AI'], announcedAt: '2026-08-21T00:00:00.000Z', arxivUrl: 'https://arxiv.org/abs/2608.01001',
    pdfUrl: 'https://arxiv.org/pdf/2608.01001v2', announceType: 'replace',
  }] }, '2026-08-21T00:00:00.000Z');
  assert.equal(db.prepare('SELECT in_inbox FROM user_paper_states WHERE paper_id = ?').get('2608.01001').in_inbox, 0);

  const removeFavoritesResponse = await changeCollection('removeFromCollection', favorites.id);
  assert.equal((await removeFavoritesResponse.json()).stats.inbox, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_collections WHERE paper_id = ?').get('2608.01001').count, 1);

  const removeLastResponse = await changeCollection('removeFromCollection', readingListId);
  assert.equal((await removeLastResponse.json()).stats.inbox, 1);
  const restoredInboxResponse = await fetch(`http://127.0.0.1:${port}/api/papers?view=inbox`);
  assert.deepEqual((await restoredInboxResponse.json()).papers.map((paper) => paper.id), ['2608.01001']);
  assert.deepEqual({ ...db.prepare('SELECT in_inbox, archived_version, archived_at FROM user_paper_states WHERE paper_id = ?').get('2608.01001') }, {
    in_inbox: 1, archived_version: null, archived_at: null,
  });
});

test('archiving preserves local content until explicit deletion, then suppresses the same RSS version', async (context) => {
  const db = createDatabase(':memory:');
  const now = '2026-08-20T00:00:00.000Z';
  const inserted = db.prepare("INSERT INTO subscriptions (category, created_at) VALUES ('cs.AI', ?)").run(now);
  const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(Number(inserted.lastInsertRowid));
  const paper = {
    id: '2608.02001', version: 1, title: 'Disposable paper', authors: 'Author', abstract: 'Abstract',
    categories: ['cs.AI'], announcedAt: now, arxivUrl: 'https://arxiv.org/abs/2608.02001',
    pdfUrl: 'https://arxiv.org/pdf/2608.02001', announceType: 'new',
  };
  ingestFeed(db, subscription, { errors: [], papers: [paper] }, now);
  db.prepare(`
    INSERT INTO paper_ai_analyses (paper_id, paper_version, source_hash, status, trigger, queued_at)
    VALUES (?, 1, 'hash', 'succeeded', 'manual', ?)
  `).run(paper.id, now);
  db.prepare(`
    INSERT INTO paper_embeddings (paper_id, paper_version, source_hash, status, vector, dimensions, model, queued_at)
    VALUES (?, 1, 'hash', 'succeeded', ?, 2, 'embedding-model', ?)
  `).run(paper.id, Buffer.from(new Float32Array([1, 0]).buffer), now);

  const app = createApp({ db, port: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  context.after(() => { app.server.close(); db.close(); });
  const { port } = app.server.address();
  const archived = await fetch(`http://127.0.0.1:${port}/api/papers/${paper.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-AFU-Request': '1' },
    body: JSON.stringify({ action: 'archive' }),
  });

  assert.equal(archived.status, 200);
  assert.equal((await archived.json()).stats.archived, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM papers').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_ai_analyses').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_embeddings').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM archived_paper_tombstones').get().count, 0);
  const archivePayload = await (await fetch(`http://127.0.0.1:${port}/api/papers?view=archive`)).json();
  assert.equal(archivePayload.papers[0].id, paper.id);
  assert.equal(archivePayload.papers[0].abstract, 'Abstract');

  const purged = await fetch(`http://127.0.0.1:${port}/api/papers/${paper.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-AFU-Request': '1' },
    body: JSON.stringify({ action: 'purgeArchive' }),
  });
  assert.equal(purged.status, 200);
  assert.equal((await purged.json()).stats.archived, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM papers').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_ai_analyses').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_embeddings').get().count, 0);
  assert.deepEqual({ ...db.prepare('SELECT * FROM archived_paper_tombstones').get() }, {
    paper_id: paper.id, archived_version: 1, archived_at: db.prepare('SELECT archived_at FROM archived_paper_tombstones').get().archived_at,
  });
  const emptyArchive = await (await fetch(`http://127.0.0.1:${port}/api/papers?view=archive`)).json();
  assert.deepEqual(emptyArchive.papers, []);

  const duplicate = ingestFeed(db, subscription, { errors: [], papers: [paper] }, '2026-08-21T00:00:00.000Z');
  assert.equal(duplicate.newIds.size, 0);
  assert.equal(duplicate.updatedIds.size, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM papers').get().count, 0);

  const update = ingestFeed(db, subscription, { errors: [], papers: [{
    ...paper, version: 2, title: 'Disposable paper v2', abstract: 'Updated abstract', announceType: 'replace',
  }] }, '2026-08-22T00:00:00.000Z');
  assert.deepEqual([...update.updatedIds], [paper.id]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM archived_paper_tombstones').get().count, 0);
  assert.deepEqual({ ...db.prepare('SELECT latest_version FROM papers WHERE id = ?').get(paper.id) }, { latest_version: 2 });
  assert.deepEqual({ ...db.prepare('SELECT unread_reason, in_inbox FROM user_paper_states WHERE paper_id = ?').get(paper.id) }, {
    unread_reason: 'updated', in_inbox: 1,
  });
});

test('AI configuration and manual batch endpoints validate mode and queue selected papers', async (context) => {
  const db = createDatabase(':memory:');
  const now = '2026-08-20T00:00:00.000Z';
  const inserted = db.prepare("INSERT INTO subscriptions (category, created_at) VALUES ('cs.AI', ?)").run(now);
  const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(Number(inserted.lastInsertRowid));
  ingestFeed(db, subscription, { errors: [], papers: [{
    id: '2608.00001', version: 1, title: 'AI paper', authors: 'Author', abstract: 'Abstract',
    categories: ['cs.AI'], announcedAt: now, arxivUrl: 'https://arxiv.org/abs/2608.00001',
    pdfUrl: 'https://arxiv.org/pdf/2608.00001', announceType: 'new',
  }] }, now);

  const app = createApp({ db, port: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  context.after(() => { app.server.close(); db.close(); });
  const { port } = app.server.address();
  const headers = { 'Content-Type': 'application/json', 'X-AFU-Request': '1' };

  const blocked = await fetch(`http://127.0.0.1:${port}/api/ai/papers/batch`, {
    method: 'POST', headers, body: JSON.stringify({ paperIds: ['2608.00001'] }),
  });
  assert.equal(blocked.status, 409);

  const configured = await fetch(`http://127.0.0.1:${port}/api/ai/config`, {
    method: 'PATCH', headers, body: JSON.stringify({ mode: 'manual', maxConcurrency: 25, abstractDisplayMode: 'bilingual' }),
  });
  assert.equal(configured.status, 200);
  const configuration = await configured.json();
  assert.equal(configuration.mode, 'manual');
  assert.equal(configuration.maxConcurrency, 25);

  const queued = await fetch(`http://127.0.0.1:${port}/api/ai/papers/batch`, {
    method: 'POST', headers, body: JSON.stringify({ paperIds: ['2608.00001'] }),
  });
  assert.equal(queued.status, 202);
  assert.equal((await queued.json()).queued, 1);
});

test('LLM and Embedding API keys are stored locally without being returned by bootstrap', async (context) => {
  const db = createDatabase(':memory:');
  const app = createApp({ db, port: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  context.after(() => { app.server.close(); db.close(); });
  const { port } = app.server.address();
  const headers = { 'Content-Type': 'application/json', 'X-AFU-Request': '1' };

  const llm = await fetch(`http://127.0.0.1:${port}/api/ai/config`, {
    method: 'PATCH', headers, body: JSON.stringify({ apiKey: 'llm-local-secret' }),
  });
  const embedding = await fetch(`http://127.0.0.1:${port}/api/embeddings/config`, {
    method: 'PATCH', headers, body: JSON.stringify({ apiKey: 'embedding-local-secret', archiveColor: '#334155' }),
  });
  const bootstrap = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();

  assert.equal(llm.status, 200);
  assert.equal(embedding.status, 200);
  assert.equal(getSecret(db, 'ai_api_key'), 'llm-local-secret');
  assert.equal(getSecret(db, 'embedding_api_key'), 'embedding-local-secret');
  assert.equal(bootstrap.ai.apiKeyConfigured, true);
  assert.equal(bootstrap.embeddings.apiKeyConfigured, true);
  assert.equal(bootstrap.embeddings.archiveColor, '#334155');
  assert.equal(JSON.stringify(bootstrap).includes('local-secret'), false);
});

test('AI retry-failed endpoint requeues every failed analysis', async (context) => {
  const db = createDatabase(':memory:');
  const now = '2026-08-20T00:00:00.000Z';
  const inserted = db.prepare("INSERT INTO subscriptions (category, created_at) VALUES ('cs.AI', ?)").run(now);
  const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(Number(inserted.lastInsertRowid));
  ingestFeed(db, subscription, { errors: [], papers: ['1', '2'].map((suffix) => ({
    id: `2608.1000${suffix}`, version: 1, title: `Failed paper ${suffix}`, authors: 'Author', abstract: 'Abstract',
    categories: ['cs.AI'], announcedAt: now, arxivUrl: `https://arxiv.org/abs/2608.1000${suffix}`,
    pdfUrl: `https://arxiv.org/pdf/2608.1000${suffix}`, announceType: 'new',
  })) }, now);
  db.prepare(`
    INSERT INTO paper_ai_analyses (paper_id, paper_version, source_hash, status, trigger, queued_at, last_error, attempt_count)
    VALUES (?, 1, 'hash', 'failed', 'manual', ?, 'provider error', 3)
  `).run('2608.10001', now);
  db.prepare(`
    INSERT INTO paper_ai_analyses (paper_id, paper_version, source_hash, status, trigger, queued_at, last_error, attempt_count)
    VALUES (?, 1, 'hash', 'failed', 'auto', ?, 'timeout', 3)
  `).run('2608.10002', now);

  const app = createApp({ db, port: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  context.after(() => { app.server.close(); db.close(); });
  const { port } = app.server.address();
  const request = () => fetch(`http://127.0.0.1:${port}/api/ai/retry-failed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AFU-Request': '1' }, body: '{}',
  });

  assert.equal((await request()).status, 409);
  db.prepare("UPDATE settings SET value = 'manual' WHERE key = 'ai_processing_mode'").run();
  const response = await request();
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.queued, 2);
  assert.equal(payload.status.pending, 2);
  assert.equal(payload.status.failed, 0);
  assert.deepEqual(db.prepare(`
    SELECT DISTINCT status, trigger, priority, last_error, attempt_count FROM paper_ai_analyses ORDER BY status
  `).all().map((row) => ({ ...row })), [{ status: 'pending', trigger: 'manual', priority: 100, last_error: null, attempt_count: 0 }]);
});
