import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, exportBackup, getAiQueueStatus, getSettings, getStats, listInboxCategoryGroups, listPapers, restoreBackup, setSetting } from '../src/db.js';
import { enrichPaperDates, ingestFeed, syncSubscriptions } from '../src/sync.js';

function setup() {
  const db = createDatabase(':memory:');
  const now = '2026-08-20T00:00:00.000Z';
  const result = db.prepare("INSERT INTO subscriptions (category, created_at) VALUES ('cs.LG', ?)").run(now);
  return { db, subscription: db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(Number(result.lastInsertRowid)) };
}

function item(version, overrides = {}) {
  return {
    id: '2508.12345', version, title: `Paper v${version}`, authors: 'Ada Lovelace', abstract: `Abstract v${version}`,
    categories: ['cs.LG'], announcedAt: `2026-08-${19 + version}T04:00:00.000Z`,
    arxivUrl: 'https://arxiv.org/abs/2508.12345', pdfUrl: `https://arxiv.org/pdf/2508.12345v${version}`,
    announceType: version === 1 ? 'new' : 'replace', ...overrides,
  };
}

test('sync is idempotent and versions only move forward', () => {
  const { db, subscription } = setup();
  const first = ingestFeed(db, subscription, { papers: [item(1)], errors: [] }, '2026-08-20T05:00:00.000Z');
  assert.deepEqual([...first.newIds], ['2508.12345']);
  assert.equal(getStats(db).inbox, 1);

  const duplicate = ingestFeed(db, subscription, { papers: [item(1)], errors: [] }, '2026-08-21T05:00:00.000Z');
  assert.equal(duplicate.newIds.size, 0);
  assert.equal(duplicate.updatedIds.size, 0);
  assert.equal(db.prepare('SELECT inbox_activity_at FROM user_paper_states').get().inbox_activity_at, '2026-08-20T05:00:00.000Z');

  db.prepare("UPDATE user_paper_states SET is_read = 1, unread_reason = NULL WHERE paper_id = '2508.12345'").run();
  const update = ingestFeed(db, subscription, { papers: [item(2)], errors: [] }, '2026-08-22T05:00:00.000Z');
  assert.deepEqual([...update.updatedIds], ['2508.12345']);
  assert.deepEqual({ ...db.prepare('SELECT is_read, unread_reason, in_inbox FROM user_paper_states').get() }, { is_read: 0, unread_reason: 'updated', in_inbox: 1 });

  db.prepare("UPDATE user_paper_states SET in_inbox = 0, archived_version = 2 WHERE paper_id = '2508.12345'").run();
  ingestFeed(db, subscription, { papers: [item(2)], errors: [] }, '2026-08-23T05:00:00.000Z');
  assert.equal(db.prepare('SELECT in_inbox FROM user_paper_states').get().in_inbox, 0);

  ingestFeed(db, subscription, { papers: [item(3)], errors: [] }, '2026-08-24T05:00:00.000Z');
  assert.equal(db.prepare('SELECT in_inbox FROM user_paper_states').get().in_inbox, 1);
  ingestFeed(db, subscription, { papers: [item(2)], errors: [] }, '2026-08-25T05:00:00.000Z');
  assert.equal(db.prepare('SELECT latest_version FROM papers').get().latest_version, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_versions').get().count, 3);
  db.close();
});

test('an update to an already unread paper remains ordinary unread', () => {
  const { db, subscription } = setup();
  ingestFeed(db, subscription, { papers: [item(1)], errors: [] });
  ingestFeed(db, subscription, { papers: [item(2)], errors: [] });
  assert.deepEqual({ ...db.prepare('SELECT is_read, unread_reason FROM user_paper_states').get() }, { is_read: 0, unread_reason: 'new' });
  db.close();
});

test('paper queries support stable pagination beyond the first 100 rows', () => {
  const { db, subscription } = setup();
  const papers = Array.from({ length: 205 }, (_, index) => item(1, {
    id: `2608.${String(index + 1).padStart(5, '0')}`,
    title: `Paper ${String(index + 1).padStart(3, '0')}`,
    announcedAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') + index * 1_000).toISOString(),
  }));
  ingestFeed(db, subscription, { papers, errors: [] }, '2026-08-20T05:00:00.000Z');
  const firstPage = listPapers(db, { view: 'inbox', limit: 100, offset: 0 });
  const secondPage = listPapers(db, { view: 'inbox', limit: 100, offset: 100 });
  const thirdPage = listPapers(db, { view: 'inbox', limit: 100, offset: 200 });
  assert.equal(firstPage.length, 100);
  assert.equal(secondPage.length, 100);
  assert.equal(thirdPage.length, 5);
  assert.equal(new Set([...firstPage, ...secondPage, ...thirdPage].map((paper) => paper.id)).size, 205);
  db.close();
});

test('Inbox defaults to arXiv update time and supports hierarchical category multi-select', () => {
  const { db, subscription } = setup();
  ingestFeed(db, subscription, { errors: [], papers: [
    item(1, { id: '2608.00001', title: 'Newest activity', categories: ['cs.LG'] }),
    item(1, { id: '2608.00002', title: 'Newest arXiv update', categories: ['cs.AI', 'cs.LG'] }),
    item(1, { id: '2608.00003', title: 'Other category', categories: ['stat.ML'] }),
  ] }, '2026-08-21T00:00:00.000Z');
  db.prepare("UPDATE papers SET updated_at = '2026-08-18T00:00:00.000Z' WHERE id = '2608.00001'").run();
  db.prepare("UPDATE papers SET updated_at = '2026-08-20T00:00:00.000Z' WHERE id = '2608.00002'").run();
  db.prepare("UPDATE papers SET updated_at = '2026-08-19T00:00:00.000Z' WHERE id = '2608.00003'").run();
  assert.equal(listPapers(db, { view: 'inbox' })[0].id, '2608.00002');
  assert.deepEqual(listPapers(db, { view: 'inbox', category: 'stat.ML' }).map((paper) => paper.id), ['2608.00003']);
  assert.deepEqual(listPapers(db, { view: 'inbox', category: 'cs.AI' }).map((paper) => paper.id), ['2608.00002']);
  assert.deepEqual(listPapers(db, { view: 'inbox', categoryGroup: 'stat' }).map((paper) => paper.id), ['2608.00003']);
  assert.deepEqual(listPapers(db, { view: 'inbox', categories: ['cs.AI', 'stat.ML'] }).map((paper) => paper.id), ['2608.00002', '2608.00003']);
  assert.deepEqual(listPapers(db, { view: 'inbox', categoryGroups: ['cs', 'stat'] }).map((paper) => paper.id), ['2608.00002', '2608.00003', '2608.00001']);
  assert.deepEqual(listPapers(db, { view: 'inbox', categories: ['cs.AI'], categoryGroups: ['stat'] }).map((paper) => paper.id), ['2608.00002', '2608.00003']);
  const groups = listInboxCategoryGroups(db);
  assert.ok(groups.find((group) => group.code === 'cs')?.categories.some((category) => category.code === 'cs.AI'));
  assert.ok(groups.find((group) => group.code === 'stat')?.categories.some((category) => category.code === 'stat.ML'));
  db.prepare("UPDATE user_paper_states SET in_inbox = 0 WHERE paper_id = '2608.00003'").run();
  assert.equal(listInboxCategoryGroups(db).some((group) => group.code === 'stat'), false);
  db.close();
});

test('metadata enrichment stores real published and latest-version dates', async () => {
  const { db, subscription } = setup();
  ingestFeed(db, subscription, { papers: [item(2)], errors: [] });
  const result = await enrichPaperDates(db, null, {
    fetchMetadata: async () => [{
      id: '2508.12345', version: 2,
      publishedAt: '2025-08-01T10:00:00.000Z',
      updatedAt: '2026-08-19T07:50:07.000Z',
    }],
  });
  assert.equal(result.enrichedCount, 1);
  assert.deepEqual({ ...db.prepare('SELECT published_at, updated_at FROM papers').get() }, {
    published_at: '2025-08-01T10:00:00.000Z',
    updated_at: '2026-08-19T07:50:07.000Z',
  });
  db.close();
});

test('backup restores all user data and creates a safety copy', () => {
  const { db, subscription } = setup();
  ingestFeed(db, subscription, { papers: [item(1)], errors: [] });
  const backup = exportBackup(db);
  assert.equal(backup.format, 'arxiv-follow-up-backup');
  db.prepare("DELETE FROM paper_subscriptions").run();
  db.prepare("DELETE FROM user_paper_states").run();
  db.prepare("DELETE FROM paper_versions").run();
  db.prepare("DELETE FROM papers").run();
  const backupDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'afu-test-'));
  restoreBackup(db, backup, { backupDirectory });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM papers').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_paper_states').get().count, 1);
  db.close();
  fs.rmSync(backupDirectory, { recursive: true, force: true });
});

test('restore accepts backups created before the ArxivFollowUp rename', () => {
  const { db, subscription } = setup();
  ingestFeed(db, subscription, { papers: [item(1)], errors: [] });
  const backup = exportBackup(db);
  backup.format = 'localrss-backup';
  db.prepare('DELETE FROM paper_subscriptions').run();
  db.prepare('DELETE FROM user_paper_states').run();
  db.prepare('DELETE FROM paper_versions').run();
  db.prepare('DELETE FROM papers').run();
  const backupDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'afu-legacy-test-'));
  restoreBackup(db, backup, { backupDirectory });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM papers').get().count, 1);
  db.close();
  fs.rmSync(backupDirectory, { recursive: true, force: true });
});

test('auto AI mode queues newly synchronized papers without blocking sync', async () => {
  const { db, subscription } = setup();
  setSetting(db, 'ai_processing_mode', 'auto');
  const result = await syncSubscriptions(db, [subscription], {
    fetchFeed: async () => ({ papers: [item(1)], errors: [] }),
    fetchMetadata: async () => [],
  });
  assert.equal(result.status, 'success');
  assert.equal(result.ai.queued, 1);
  assert.equal(getAiQueueStatus(db).pending, 1);
  db.close();
});

test('restoring a schema 2 backup adds new AI defaults', () => {
  const { db } = setup();
  const backup = exportBackup(db);
  backup.schemaVersion = 2;
  delete backup.tables.paper_ai_analyses;
  backup.tables.settings = backup.tables.settings.filter((row) => !row.key.startsWith('ai_') && row.key !== 'abstract_display_mode');
  const backupDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'afu-test-'));
  restoreBackup(db, backup, { backupDirectory });
  assert.equal(getSettings(db).ai_processing_mode, 'off');
  assert.equal(getSettings(db).abstract_display_mode, 'original');
  db.close();
  fs.rmSync(backupDirectory, { recursive: true, force: true });
});
