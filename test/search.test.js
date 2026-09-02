import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, setSetting } from '../src/db.js';
import { ingestFeed } from '../src/sync.js';
import { searchPapers } from '../src/search.js';
import { createApp } from '../src/server.js';

function setup() {
  const db = createDatabase(':memory:');
  const now = '2026-08-20T00:00:00.000Z';
  const subscriptionId = db.prepare(`
    INSERT INTO subscriptions (category, enabled, last_sync_result, created_at)
    VALUES ('cs.AI', 1, 'never', ?)
  `).run(now).lastInsertRowid;
  const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId);
  ingestFeed(db, subscription, { errors: [], papers: [
    {
      id: '2608.50001', version: 1, title: 'Graph message passing', authors: 'Ada Author',
      abstract: 'A graph neural network for structured prediction.', categories: ['cs.LG'],
      announcedAt: now, arxivUrl: 'https://arxiv.org/abs/2608.50001', pdfUrl: 'https://arxiv.org/pdf/2608.50001', announceType: 'new',
    },
    {
      id: '2608.50002', version: 1, title: 'Reliable autonomous planning', authors: 'Ben Author',
      abstract: 'Robust planning for autonomous agents.', categories: ['cs.AI'],
      announcedAt: now, arxivUrl: 'https://arxiv.org/abs/2608.50002', pdfUrl: 'https://arxiv.org/pdf/2608.50002', announceType: 'new',
    },
  ] }, now);
  return { db, now };
}

test('natural-language search uses BM25 only when Embedding is off and indexes notes', async () => {
  const { db } = setup();
  setSetting(db, 'search_dense_weight', '0.80');
  db.prepare("UPDATE user_paper_states SET note = 'reproducibility checklist' WHERE paper_id = '2608.50002'").run();
  let embeddingCalled = false;

  const titleResult = await searchPapers(db, {
    query: 'graph message', filters: { view: 'inbox' },
    fetchImpl: async () => { embeddingCalled = true; throw new Error('should not be called'); },
  });
  const noteResult = await searchPapers(db, { query: 'reproducibility', filters: { view: 'inbox' } });

  assert.equal(embeddingCalled, false);
  assert.equal(titleResult.search.mode, 'bm25');
  assert.equal(titleResult.search.effectiveDenseWeight, 0);
  assert.equal(titleResult.papers[0].id, '2608.50001');
  assert.equal(noteResult.papers[0].id, '2608.50002');
  db.close();
});

test('hybrid search fuses BM25 and Dense ranks and degrades safely on API failure', async () => {
  const { db, now } = setup();
  setSetting(db, 'embedding_processing_mode', 'auto');
  setSetting(db, 'search_dense_weight', '0.75');
  db.prepare(`
    INSERT INTO paper_embeddings (paper_id, paper_version, source_hash, status, vector, dimensions, model, queued_at)
    VALUES ('2608.50002', 1, 'hash', 'succeeded', ?, 2, 'Qwen/Qwen3-Embedding-0.6B', ?)
  `).run(Buffer.from(new Float32Array([0, 1]).buffer), now);
  const fetchImpl = async () => ({
    ok: true,
    async json() { return { data: [{ index: 0, embedding: [0, 1] }] }; },
  });

  const hybrid = await searchPapers(db, { query: 'graph', filters: { view: 'inbox' }, fetchImpl });
  const degraded = await searchPapers(db, {
    query: 'graph', filters: { view: 'inbox' }, fetchImpl: async () => { throw new Error('offline'); },
  });

  assert.equal(hybrid.search.mode, 'hybrid');
  assert.equal(hybrid.search.effectiveDenseWeight, 0.75);
  assert.equal(hybrid.papers[0].id, '2608.50002');
  assert.equal(degraded.search.mode, 'bm25');
  assert.equal(degraded.search.degraded, true);
  assert.equal(degraded.papers[0].id, '2608.50001');
  db.close();
});

test('search API returns ranked papers and validates the configurable Dense weight', async () => {
  const { db } = setup();
  const app = createApp({ db, port: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const headers = { 'Content-Type': 'application/json', 'X-AFU-Request': '1' };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/search`, {
      method: 'POST', headers, body: JSON.stringify({ query: 'autonomous planning', view: 'inbox' }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.search.mode, 'bm25');
    assert.equal(result.papers[0].id, '2608.50002');

    const saved = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PATCH', headers, body: JSON.stringify({ searchDenseWeight: 0.35 }),
    });
    assert.equal((await saved.json()).settings.search_dense_weight, '0.35');
    const invalid = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PATCH', headers, body: JSON.stringify({ searchDenseWeight: 1.1 }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
  }
});
