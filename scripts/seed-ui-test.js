import { createDatabase, enqueuePaperAnalyses } from '../src/db.js';
import { ingestFeed } from '../src/sync.js';

if (!process.env.AFU_DATABASE_PATH) throw new Error('AFU_DATABASE_PATH is required.');

const db = createDatabase(process.env.AFU_DATABASE_PATH);
const now = '2026-08-20T04:00:00.000Z';
const result = db.prepare(`
  INSERT INTO subscriptions (category, created_at, last_sync_result, last_successful_sync)
  VALUES ('cs.LG', ?, 'success', ?)
`).run(now, now);
const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(Number(result.lastInsertRowid));
const paper = {
  id: '2508.12345',
  version: 1,
  title: 'Structured Agents for Reliable Scientific Discovery',
  authors: 'Ada Lovelace, Alan Turing',
  abstract: 'We introduce a structured agent architecture for reliable scientific discovery. The method separates planning, retrieval, verification, and reporting into auditable stages.',
  categories: ['cs.LG', 'cs.AI'],
  announcedAt: now,
  arxivUrl: 'https://arxiv.org/abs/2508.12345',
  pdfUrl: 'https://arxiv.org/pdf/2508.12345v1',
  announceType: 'new',
};
const legacyPaper = {
  id: 'hep-th/9901001',
  version: 2,
  title: 'A Legacy Identifier Test for Local Research Archives',
  authors: 'Emmy Noether',
  abstract: 'This fixture verifies that legacy arXiv identifiers remain searchable and deduplicated.',
  categories: ['hep-th'],
  announcedAt: '2026-08-19T04:00:00.000Z',
  arxivUrl: 'https://arxiv.org/abs/hep-th/9901001',
  pdfUrl: 'https://arxiv.org/pdf/hep-th/9901001v2',
  announceType: 'replace',
};

ingestFeed(db, subscription, { papers: [paper, legacyPaper], errors: [] }, now);
db.prepare("UPDATE user_paper_states SET is_read = 1, unread_reason = NULL WHERE paper_id = '2508.12345'").run();
ingestFeed(db, subscription, {
  papers: [{
    ...paper,
    version: 2,
    title: `${paper.title} — Revised`,
    announcedAt: '2026-08-20T06:00:00.000Z',
    pdfUrl: 'https://arxiv.org/pdf/2508.12345v2',
    announceType: 'replace',
  }],
  errors: [],
}, '2026-08-20T06:05:00.000Z');
enqueuePaperAnalyses(db, [paper.id], 'manual');
db.prepare(`
  UPDATE paper_ai_analyses SET status = 'succeeded',
    translation_zh = ?, explanation_zh = ?, provider = 'vllm-openai-compatible',
    model = 'Qwen/Qwen3.8-27B-FP8', completed_at = ?
  WHERE paper_id = ? AND paper_version = 2
`).run(
  '我们提出了一种结构化智能体架构，将规划、检索、验证和报告拆分为可审计的阶段，以支持可靠的科学发现。',
  '这篇论文通过把智能体工作流拆成可审计阶段来提高科学发现过程的可靠性。',
  new Date().toISOString(), paper.id,
);
db.close();
