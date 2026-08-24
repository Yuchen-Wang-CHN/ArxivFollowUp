import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { createApp } from '../src/server.js';
import { ingestFeed } from '../src/sync.js';

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
    method: 'PATCH', headers, body: JSON.stringify({ mode: 'manual', maxConcurrency: 10, abstractDisplayMode: 'bilingual' }),
  });
  assert.equal(configured.status, 200);
  assert.equal((await configured.json()).mode, 'manual');

  const queued = await fetch(`http://127.0.0.1:${port}/api/ai/papers/batch`, {
    method: 'POST', headers, body: JSON.stringify({ paperIds: ['2608.00001'] }),
  });
  assert.equal(queued.status, 202);
  assert.equal((await queued.json()).queued, 1);
});
