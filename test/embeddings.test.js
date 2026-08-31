import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, setSecret, setSetting } from '../src/db.js';
import { createEmbeddingCoordinator, getEmbeddingQueueStatus } from '../src/embeddings.js';
import { ingestFeed } from '../src/sync.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function addPapers(db) {
  const now = '2026-08-20T00:00:00.000Z';
  const inserted = db.prepare("INSERT INTO subscriptions (category, created_at) VALUES ('cs.AI', ?)").run(now);
  const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(Number(inserted.lastInsertRowid));
  const definitions = [
    ['2608.20001', 'Archived seed'],
    ['2608.20002', 'Agent seed'],
    ['2608.20003', 'Likely archive'],
    ['2608.20004', 'Likely agent'],
  ];
  ingestFeed(db, subscription, { errors: [], papers: definitions.map(([id, title]) => ({
    id, version: 1, title, authors: 'Test Author', abstract: `${title} abstract`, categories: ['cs.AI'],
    announcedAt: now, arxivUrl: `https://arxiv.org/abs/${id}`, pdfUrl: `https://arxiv.org/pdf/${id}`, announceType: 'new',
  })) }, now);
  db.prepare("UPDATE user_paper_states SET in_inbox = 0, archived_version = 1, archived_at = ? WHERE paper_id = '2608.20001'").run(now);
  const collection = db.prepare("INSERT INTO collections (name, color, created_at) VALUES ('Agents', '#8b5cf6', ?)").run(now);
  db.prepare('INSERT INTO paper_collections (paper_id, collection_id, added_at) VALUES (?, ?, ?)')
    .run('2608.20002', Number(collection.lastInsertRowid), now);
  db.prepare("UPDATE user_paper_states SET in_inbox = 0 WHERE paper_id = '2608.20002'").run();
  return Number(collection.lastInsertRowid);
}

test('embedding worker batches papers, sends its own API key, and classifies Inbox against Collections only', async () => {
  const db = createDatabase(':memory:');
  const collectionId = addPapers(db);
  setSetting(db, 'embedding_processing_mode', 'auto');
  setSetting(db, 'classification_threshold', '0.8');
  setSetting(db, 'classification_margin', '0.05');
  setSecret(db, 'embedding_api_key', 'embedding-secret');
  let authorization;
  let requestBody;
  let classificationCallbackCount = 0;
  const vectors = new Map([
    ['Archived seed', [1, 0]],
    ['Agent seed', [0, 1]],
    ['Likely archive', [0.99, 0.05]],
    ['Likely agent', [0.05, 0.99]],
  ]);
  const coordinator = createEmbeddingCoordinator(db, {
    onClassificationChanged: () => { classificationCallbackCount += 1; },
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return {
            data: requestBody.input.map((input, index) => {
              const title = [...vectors.keys()].find((candidate) => input.includes(`Title: ${candidate}\n`));
              return { index, embedding: vectors.get(title) };
            }),
          };
        },
      };
    },
  });

  const deadline = Date.now() + 2_000;
  while ((getEmbeddingQueueStatus(db).succeeded < 4 || getEmbeddingQueueStatus(db).classified < 1) && Date.now() < deadline) await wait(10);
  coordinator.stop();

  assert.equal(authorization, 'Bearer embedding-secret');
  assert.equal(requestBody.model, 'Qwen/Qwen3-Embedding-0.6B');
  assert.equal(requestBody.input.length, 4);
  assert.ok(classificationCallbackCount > 0);
  assert.deepEqual(db.prepare(`
    SELECT paper_id, target_type, target_collection_id FROM paper_classifications ORDER BY paper_id
  `).all().map((row) => ({ ...row })), [
    { paper_id: '2608.20004', target_type: 'collection', target_collection_id: collectionId },
  ]);
  db.close();
});
