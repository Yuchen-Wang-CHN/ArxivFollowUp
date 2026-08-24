import { REQUEST_INTERVAL_MS } from './config.js';
import { fetchCategoryFeed, fetchPaperMetadata } from './arxiv.js';
import { enqueuePaperAnalyses, getSettings, transaction } from './db.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function mergeCategories(existingJson, incoming) {
  const existing = JSON.parse(existingJson ?? '[]');
  return JSON.stringify([...new Set([...existing, ...incoming])].sort());
}

export function ingestFeed(db, subscription, feed, now = new Date().toISOString()) {
  const added = new Set();
  const updated = new Set();

  transaction(db, () => {
    for (const item of feed.papers) {
      const existing = db.prepare('SELECT * FROM papers WHERE id = ?').get(item.id);
      const itemCategories = [...new Set([...item.categories, subscription.category])].sort();
      const categoriesJson = JSON.stringify(itemCategories);

      if (!existing) {
        db.prepare(`
          INSERT INTO papers (
            id, latest_version, title, authors, abstract, categories_json, announced_at,
            first_seen_at, last_version_seen_at, arxiv_url, pdf_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(item.id, item.version, item.title, item.authors, item.abstract, categoriesJson,
          item.announcedAt, now, now, item.arxivUrl, item.pdfUrl);
        db.prepare(`
          INSERT INTO user_paper_states (
            paper_id, is_read, unread_reason, in_inbox, inbox_activity_at
          ) VALUES (?, 0, 'new', 1, ?)
        `).run(item.id, now);
        added.add(item.id);
      } else if (item.version > existing.latest_version) {
        const mergedCategories = mergeCategories(existing.categories_json, itemCategories);
        db.prepare(`
          UPDATE papers SET latest_version = ?, title = ?, authors = ?, abstract = ?,
            categories_json = ?, announced_at = ?, last_version_seen_at = ?, arxiv_url = ?, pdf_url = ?
          WHERE id = ?
        `).run(item.version, item.title, item.authors, item.abstract, mergedCategories,
          item.announcedAt, now, item.arxivUrl, item.pdfUrl, item.id);
        const state = db.prepare('SELECT * FROM user_paper_states WHERE paper_id = ?').get(item.id);
        db.prepare(`
          UPDATE user_paper_states SET
            is_read = 0,
            unread_reason = CASE WHEN is_read = 1 THEN 'updated' ELSE unread_reason END,
            read_at = NULL,
            in_inbox = CASE
              WHEN EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_id = user_paper_states.paper_id) THEN 0
              ELSE 1
            END,
            inbox_activity_at = ?
          WHERE paper_id = ?
        `).run(now, item.id);
        if (state) updated.add(item.id);
      } else {
        const mergedCategories = mergeCategories(existing.categories_json, itemCategories);
        if (mergedCategories !== existing.categories_json) {
          db.prepare('UPDATE papers SET categories_json = ? WHERE id = ?').run(mergedCategories, item.id);
        }
      }

      db.prepare(`
        INSERT OR IGNORE INTO paper_versions (
          paper_id, version, title, authors, abstract, categories_json, announced_at,
          first_seen_at, arxiv_url, pdf_url, announce_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(item.id, item.version, item.title, item.authors, item.abstract, categoriesJson,
        item.announcedAt, now, item.arxivUrl, item.pdfUrl, item.announceType);

      db.prepare(`
        INSERT INTO paper_subscriptions (paper_id, subscription_id, matched_category, first_seen_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(paper_id, subscription_id) DO UPDATE SET matched_category = excluded.matched_category
      `).run(item.id, subscription.id, subscription.category, now);
    }
  });

  return { newIds: added, updatedIds: updated, parseErrors: feed.errors ?? [] };
}

export async function syncSubscription(db, subscription, options = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE subscriptions SET last_sync_attempt = ?, last_error = NULL WHERE id = ?
  `).run(now, subscription.id);

  try {
    const feed = await (options.fetchFeed ?? fetchCategoryFeed)(subscription.category, {
      etag: subscription.etag,
      lastModified: subscription.last_modified,
      fetchImpl: options.fetchImpl,
    });
    let result = { newIds: new Set(), updatedIds: new Set(), parseErrors: [] };
    if (!feed.notModified) result = ingestFeed(db, subscription, feed, now);
    db.prepare(`
      UPDATE subscriptions SET last_sync_result = 'success', last_successful_sync = ?,
        last_error = NULL, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified)
      WHERE id = ?
    `).run(now, feed.etag ?? null, feed.lastModified ?? null, subscription.id);
    return { ...result, subscriptionId: subscription.id, category: subscription.category, success: true };
  } catch (error) {
    db.prepare(`
      UPDATE subscriptions SET last_sync_result = 'error', last_error = ? WHERE id = ?
    `).run(error.message, subscription.id);
    return {
      subscriptionId: subscription.id,
      category: subscription.category,
      success: false,
      error: error.message,
      newIds: new Set(),
      updatedIds: new Set(),
      parseErrors: [],
    };
  }
}

let activeSync = null;
let activeEnrichment = null;

async function enrichPaperDatesInternal(db, paperIds = null, options = {}) {
  let ids;
  if (paperIds) {
    ids = [...new Set(paperIds)];
  } else {
    ids = db.prepare('SELECT id FROM papers WHERE updated_at IS NULL ORDER BY id').all().map((row) => row.id);
  }
  const result = { requestedCount: ids.length, enrichedCount: 0, failedBatches: 0, errors: [] };
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    try {
      const metadata = await (options.fetchMetadata ?? fetchPaperMetadata)(batch, { fetchImpl: options.fetchImpl });
      const now = new Date().toISOString();
      transaction(db, () => {
        const update = db.prepare(`
          UPDATE papers SET
            published_at = COALESCE(?, published_at),
            updated_at = CASE WHEN latest_version = ? THEN ? ELSE updated_at END,
            metadata_enriched_at = ?
          WHERE id = ?
        `);
        for (const item of metadata) {
          const change = update.run(item.publishedAt, item.version, item.updatedAt, now, item.id);
          result.enrichedCount += Number(change.changes);
        }
      });
    } catch (error) {
      result.failedBatches += 1;
      result.errors.push(error.message);
    }
  }
  return result;
}

export function enrichPaperDates(db, paperIds = null, options = {}) {
  if (activeEnrichment) return activeEnrichment;
  activeEnrichment = (async () => {
    if (activeSync) await activeSync;
    return enrichPaperDatesInternal(db, paperIds, options);
  })().finally(() => {
    activeEnrichment = null;
  });
  return activeEnrichment;
}

export function syncSubscriptions(db, subscriptions, options = {}) {
  if (activeSync) return activeSync;
  activeSync = (async () => {
    if (activeEnrichment) await activeEnrichment;
    const startedAt = new Date().toISOString();
    const run = db.prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')").run(startedAt);
    const newIds = new Set();
    const updatedIds = new Set();
    const results = [];

    try {
      for (let index = 0; index < subscriptions.length; index += 1) {
        if (index > 0) await (options.sleep ?? delay)(options.requestIntervalMs ?? REQUEST_INTERVAL_MS);
        const result = await syncSubscription(db, subscriptions[index], options);
        results.push(result);
        result.newIds.forEach((id) => newIds.add(id));
        result.updatedIds.forEach((id) => updatedIds.add(id));
      }
      const failedCount = results.filter((result) => !result.success).length;
      const metadata = await enrichPaperDatesInternal(db, [...new Set([...newIds, ...updatedIds])], options);
      let ai = null;
      if (getSettings(db).ai_processing_mode === 'auto' && (newIds.size || updatedIds.size)) {
        ai = enqueuePaperAnalyses(db, [...new Set([...newIds, ...updatedIds])], 'auto');
      }
      const status = failedCount === 0 ? 'success' : failedCount === results.length ? 'error' : 'partial';
      db.prepare(`
        UPDATE sync_runs SET finished_at = ?, status = ?, new_count = ?, updated_count = ?, failed_count = ?
        WHERE id = ?
      `).run(new Date().toISOString(), status, newIds.size, updatedIds.size, failedCount, Number(run.lastInsertRowid));
      return { status, newCount: newIds.size, updatedCount: updatedIds.size, failedCount, metadata, ai, results };
    } catch (error) {
      db.prepare("UPDATE sync_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?")
        .run(new Date().toISOString(), error.message, Number(run.lastInsertRowid));
      throw error;
    } finally {
      activeSync = null;
    }
  })();
  return activeSync;
}

export function dueSubscriptions(db, now = new Date()) {
  const intervalRow = db.prepare("SELECT value FROM settings WHERE key = 'refresh_interval_days'").get();
  const intervalMs = Math.min(Math.max(Number(intervalRow?.value) || 1, 1), 7) * 86_400_000;
  return db.prepare(`
    SELECT * FROM subscriptions WHERE enabled = 1 AND unsubscribed_at IS NULL
  `).all().filter((subscription) => {
    if (!subscription.last_successful_sync) return true;
    return now.getTime() - new Date(subscription.last_successful_sync).getTime() >= intervalMs;
  });
}
