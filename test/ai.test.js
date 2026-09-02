import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiCoordinator } from '../src/ai.js';
import { createDatabase, enqueuePaperAnalyses, enqueueUnprocessedFocusAnalyses, enqueueUnprocessedInboxAnalyses, getAiQueueStatus, getPaperAiAnalysis, setSetting } from '../src/db.js';
import { ingestFeed } from '../src/sync.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function addPapers(db, count) {
  const now = '2026-08-20T00:00:00.000Z';
  const row = db.prepare("INSERT INTO subscriptions (category, created_at) VALUES ('cs.AI', ?)").run(now);
  const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(Number(row.lastInsertRowid));
  ingestFeed(db, subscription, {
    errors: [],
    papers: Array.from({ length: count }, (_, index) => ({
      id: `2608.${String(index + 1).padStart(5, '0')}`,
      version: 1,
      title: `Paper ${index + 1}`,
      authors: 'Test Author',
      abstract: `Abstract ${index + 1}`,
      categories: ['cs.AI'],
      announcedAt: now,
      arxivUrl: `https://arxiv.org/abs/2608.${String(index + 1).padStart(5, '0')}`,
      pdfUrl: `https://arxiv.org/pdf/2608.${String(index + 1).padStart(5, '0')}`,
      announceType: 'new',
    })),
  }, now);
}

test('manual AI queue is deduplicated and processed with a rolling concurrency limit', async () => {
  const db = createDatabase(':memory:');
  addPapers(db, 7);
  setSetting(db, 'ai_processing_mode', 'manual');
  setSetting(db, 'ai_max_concurrency', '3');
  const ids = db.prepare('SELECT id FROM papers ORDER BY id').all().map((row) => row.id);
  const queued = enqueuePaperAnalyses(db, ids, 'manual');
  assert.equal(queued.queued, 7);
  assert.equal(enqueuePaperAnalyses(db, ids, 'manual').alreadyQueued, 7);

  let active = 0;
  let maximumActive = 0;
  const requests = [];
  const coordinator = createAiCoordinator(db, {
    fetchImpl: async (_url, options) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      requests.push(JSON.parse(options.body));
      await wait(12);
      active -= 1;
      return {
        ok: true,
        async json() {
          return {
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translation_zh: '中文摘要', explanation_zh: '这篇论文解释了一个测试方法。' }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        },
      };
    },
  });

  const deadline = Date.now() + 2_000;
  while (getAiQueueStatus(db).succeeded < 7 && Date.now() < deadline) await wait(10);
  coordinator.stop();

  assert.equal(getAiQueueStatus(db).succeeded, 7);
  assert.equal(maximumActive, 3);
  assert.equal(requests.length, 7);
  assert.ok(requests.every((body) => body.messages[1].content.match(/Abstract \d+/g)?.length === 1));
  assert.ok(requests.every((body) => body.chat_template_kwargs.enable_thinking === false));
  assert.equal(getPaperAiAnalysis(db, ids[0]).translation_zh, '中文摘要');
  db.close();
});

test('automatic reconciliation queues every unprocessed Inbox paper and excludes Archive', () => {
  const db = createDatabase(':memory:');
  addPapers(db, 4);
  db.prepare("UPDATE user_paper_states SET in_inbox = 0 WHERE paper_id = '2608.00004'").run();
  const first = enqueueUnprocessedInboxAnalyses(db);
  const second = enqueueUnprocessedInboxAnalyses(db);
  assert.equal(first.queued, 3);
  assert.equal(second.queued, 0);
  assert.equal(getAiQueueStatus(db).pending, 3);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM paper_ai_analyses WHERE paper_id = '2608.00004'").get().count, 0);
  db.close();
});

test('Focus reconciliation queues only relevant predictions and explicit follow-ups', () => {
  const db = createDatabase(':memory:');
  addPapers(db, 3);
  const now = '2026-08-20T00:00:00.000Z';
  const favorites = db.prepare("SELECT id FROM collections WHERE name = 'Favorites'").get();
  db.prepare(`
    INSERT INTO paper_classifications (
      paper_id, paper_version, target_type, target_collection_id, score, second_score,
      threshold, model, profile_hash, classified_at
    ) VALUES ('2608.00001', 1, 'collection', ?, 0.72, NULL, 0.55, 'test-model', 'profile', ?)
  `).run(favorites.id, now);
  db.prepare("UPDATE user_paper_states SET unread_reason = 'manual', focus_override = 1 WHERE paper_id = '2608.00002'").run();

  const result = enqueueUnprocessedFocusAnalyses(db);
  assert.equal(result.queued, 2);
  assert.deepEqual(db.prepare('SELECT paper_id FROM paper_ai_analyses ORDER BY paper_id').all().map((row) => row.paper_id), ['2608.00001', '2608.00002']);
  db.close();
});
