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
