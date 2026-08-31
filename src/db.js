import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  AI_DEFAULT_BASE_URL,
  AI_DEFAULT_MODEL,
  BACKUP_DIRECTORY,
  DATABASE_PATH,
  EMBEDDING_DEFAULT_BASE_URL,
  EMBEDDING_DEFAULT_MODEL,
  SCHEMA_VERSION,
} from './config.js';

const TABLES_IN_RESTORE_ORDER = [
  'settings',
  'category_cache',
  'subscriptions',
  'papers',
  'paper_versions',
  'paper_ai_analyses',
  'archived_paper_tombstones',
  'paper_subscriptions',
  'user_paper_states',
  'collections',
  'paper_collections',
  'sync_runs',
];
const REBUILDABLE_TABLES = ['paper_classifications', 'paper_embeddings'];
const OPTIONAL_RESTORE_TABLES = new Set(['paper_ai_analyses', 'archived_paper_tombstones']);
const databasePaths = new WeakMap();

function ensureParentDirectory(filePath) {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function createDatabase(databasePath = DATABASE_PATH) {
  ensureParentDirectory(databasePath);
  const db = new DatabaseSync(databasePath, { timeout: 5_000 });
  databasePaths.set(db, databasePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS category_cache (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      group_code TEXT NOT NULL,
      group_name TEXT NOT NULL,
      refreshed_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY,
      category TEXT NOT NULL UNIQUE COLLATE NOCASE,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      last_sync_result TEXT NOT NULL DEFAULT 'never' CHECK (last_sync_result IN ('never', 'success', 'error')),
      last_successful_sync TEXT,
      last_sync_attempt TEXT,
      last_error TEXT,
      etag TEXT,
      last_modified TEXT,
      created_at TEXT NOT NULL,
      paused_at TEXT,
      unsubscribed_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS papers (
      id TEXT PRIMARY KEY,
      latest_version INTEGER NOT NULL CHECK (latest_version > 0),
      title TEXT NOT NULL,
      authors TEXT NOT NULL,
      abstract TEXT NOT NULL,
      categories_json TEXT NOT NULL,
      announced_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_version_seen_at TEXT NOT NULL,
      arxiv_url TEXT NOT NULL,
      pdf_url TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS paper_versions (
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version > 0),
      title TEXT NOT NULL,
      authors TEXT NOT NULL,
      abstract TEXT NOT NULL,
      categories_json TEXT NOT NULL,
      announced_at TEXT,
      first_seen_at TEXT NOT NULL,
      arxiv_url TEXT NOT NULL,
      pdf_url TEXT NOT NULL,
      announce_type TEXT,
      PRIMARY KEY (paper_id, version)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS paper_ai_analyses (
      paper_id TEXT NOT NULL,
      paper_version INTEGER NOT NULL CHECK (paper_version > 0),
      source_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
      trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
      priority INTEGER NOT NULL DEFAULT 0,
      translation_zh TEXT,
      explanation_zh TEXT,
      provider TEXT,
      model TEXT,
      prompt_version INTEGER NOT NULL DEFAULT 1,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      queued_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      next_attempt_at TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      PRIMARY KEY (paper_id, paper_version),
      FOREIGN KEY (paper_id, paper_version) REFERENCES paper_versions(paper_id, version) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS paper_subscriptions (
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
      matched_category TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      PRIMARY KEY (paper_id, subscription_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS user_paper_states (
      paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
      is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
      unread_reason TEXT CHECK (unread_reason IN ('new', 'manual', 'updated') OR unread_reason IS NULL),
      read_at TEXT,
      in_inbox INTEGER NOT NULL DEFAULT 1 CHECK (in_inbox IN (0, 1)),
      inbox_activity_at TEXT NOT NULL,
      archived_version INTEGER,
      archived_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS archived_paper_tombstones (
      paper_id TEXT PRIMARY KEY,
      archived_version INTEGER NOT NULL CHECK (archived_version > 0),
      archived_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color TEXT NOT NULL DEFAULT '#64748b',
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS paper_collections (
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL,
      PRIMARY KEY (paper_id, collection_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'error')),
      new_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS paper_embeddings (
      paper_id TEXT NOT NULL,
      paper_version INTEGER NOT NULL CHECK (paper_version > 0),
      source_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
      vector BLOB,
      dimensions INTEGER,
      provider TEXT,
      model TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      queued_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      next_attempt_at TEXT,
      PRIMARY KEY (paper_id, paper_version),
      FOREIGN KEY (paper_id, paper_version) REFERENCES paper_versions(paper_id, version) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS paper_classifications (
      paper_id TEXT NOT NULL,
      paper_version INTEGER NOT NULL CHECK (paper_version > 0),
      target_type TEXT NOT NULL CHECK (target_type IN ('archive', 'collection')),
      target_collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      second_score REAL,
      threshold REAL NOT NULL,
      model TEXT NOT NULL,
      profile_hash TEXT NOT NULL,
      classified_at TEXT NOT NULL,
      PRIMARY KEY (paper_id, paper_version),
      FOREIGN KEY (paper_id, paper_version) REFERENCES paper_versions(paper_id, version) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_papers_announced_at ON papers(announced_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_state_inbox_activity ON user_paper_states(in_inbox, inbox_activity_at DESC);
    CREATE INDEX IF NOT EXISTS idx_paper_subscriptions_subscription ON paper_subscriptions(subscription_id);
    CREATE INDEX IF NOT EXISTS idx_paper_collections_collection ON paper_collections(collection_id, added_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_queue ON paper_ai_analyses(status, trigger, priority DESC, next_attempt_at, queued_at);
    CREATE INDEX IF NOT EXISTS idx_embedding_queue ON paper_embeddings(status, next_attempt_at, queued_at);
    CREATE INDEX IF NOT EXISTS idx_classification_target ON paper_classifications(target_type, target_collection_id, score DESC);
    CREATE INDEX IF NOT EXISTS idx_tombstones_archived_at ON archived_paper_tombstones(archived_at DESC);
  `);

  const paperColumns = new Set(db.prepare('PRAGMA table_info(papers)').all().map((column) => column.name));
  if (!paperColumns.has('published_at')) db.exec('ALTER TABLE papers ADD COLUMN published_at TEXT');
  if (!paperColumns.has('updated_at')) db.exec('ALTER TABLE papers ADD COLUMN updated_at TEXT');
  if (!paperColumns.has('metadata_enriched_at')) db.exec('ALTER TABLE papers ADD COLUMN metadata_enriched_at TEXT');

  const collectionColumns = new Set(db.prepare('PRAGMA table_info(collections)').all().map((column) => column.name));
  if (!collectionColumns.has('color')) {
    db.exec("ALTER TABLE collections ADD COLUMN color TEXT NOT NULL DEFAULT '#64748b'");
    db.exec(`
      UPDATE collections SET color = CASE id % 8
        WHEN 0 THEN '#0ea5e9' WHEN 1 THEN '#f59e0b' WHEN 2 THEN '#8b5cf6' WHEN 3 THEN '#10b981'
        WHEN 4 THEN '#ef4444' WHEN 5 THEN '#06b6d4' WHEN 6 THEN '#ec4899' ELSE '#84cc16' END
    `);
  }

  const now = new Date().toISOString();
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('refresh_interval_days', '1');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('display_density', 'comfortable');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('ai_processing_mode', 'off');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('ai_base_url', AI_DEFAULT_BASE_URL);
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('ai_model', AI_DEFAULT_MODEL);
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('ai_max_concurrency', '10');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('ai_request_timeout_seconds', '120');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('abstract_display_mode', 'original');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('open_browser_on_start', '1');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('embedding_processing_mode', 'off');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('embedding_base_url', EMBEDDING_DEFAULT_BASE_URL);
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('embedding_model', EMBEDDING_DEFAULT_MODEL);
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('embedding_batch_size', '32');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('embedding_request_timeout_seconds', '120');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('classification_threshold', '0.55');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('classification_margin', '0.03');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('focus_threshold', '0.60');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('archive_color', '#64748b');
  db.prepare("INSERT OR IGNORE INTO collections (name, color, created_at) VALUES (?, '#f59e0b', ?)").run('Favorites', now);
  db.exec("DELETE FROM paper_classifications WHERE target_type = 'archive'");
  db.prepare(`
    UPDATE user_paper_states SET in_inbox = 0
    WHERE EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_id = user_paper_states.paper_id)
  `).run();
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getSettings(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, row.value]));
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

export function getSecret(db, key) {
  return db.prepare('SELECT value FROM secrets WHERE key = ?').get(key)?.value ?? null;
}

export function setSecret(db, key, value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) db.prepare('DELETE FROM secrets WHERE key = ?').run(key);
  else db.prepare('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, normalized);
}

export function listSubscriptions(db, { includeUnsubscribed = false } = {}) {
  const where = includeUnsubscribed ? '' : 'WHERE unsubscribed_at IS NULL';
  return db.prepare(`
    SELECT *,
      CASE
        WHEN enabled = 0 THEN 'paused'
        WHEN last_sync_result = 'error' THEN 'error'
        ELSE 'active'
      END AS status
    FROM subscriptions ${where}
    ORDER BY category COLLATE NOCASE
  `).all();
}

export function listCollections(db) {
  return db.prepare(`
    SELECT c.*, COUNT(pc.paper_id) AS paper_count
    FROM collections c
    LEFT JOIN paper_collections pc ON pc.collection_id = c.id
    GROUP BY c.id
    ORDER BY CASE WHEN c.name = 'Favorites' THEN 0 ELSE 1 END, c.name COLLATE NOCASE
  `).all();
}

function categoryGroupExpression(valueExpression, cachedGroupExpression) {
  return `COALESCE(${cachedGroupExpression}, CASE
    WHEN ${valueExpression} GLOB 'cs.*' THEN 'cs'
    WHEN ${valueExpression} GLOB 'math.*' THEN 'math'
    WHEN ${valueExpression} GLOB 'stat.*' THEN 'stat'
    WHEN ${valueExpression} GLOB 'q-bio.*' THEN 'q-bio'
    WHEN ${valueExpression} GLOB 'q-fin.*' THEN 'q-fin'
    WHEN ${valueExpression} GLOB 'eess.*' THEN 'eess'
    WHEN ${valueExpression} GLOB 'econ.*' THEN 'econ'
    ELSE 'physics'
  END)`;
}

function focusThreshold(db) {
  const value = Number(db.prepare("SELECT value FROM settings WHERE key = 'focus_threshold'").get()?.value);
  return Number.isFinite(value) && value >= -1 && value <= 1 ? value : 0.6;
}

export function listInboxCategoryGroups(db, { view = 'inbox' } = {}) {
  const groupExpression = categoryGroupExpression('inbox_category.code', 'cc.group_code');
  const focusJoin = view === 'focus'
    ? 'LEFT JOIN paper_classifications pcl ON pcl.paper_id = p.id AND pcl.paper_version = p.latest_version'
    : '';
  const focusFilter = view === 'focus'
    ? "AND (ups.unread_reason IN ('updated', 'manual') OR pcl.score >= ?)"
    : '';
  const parameters = view === 'focus' ? [focusThreshold(db)] : [];
  const rows = db.prepare(`
    WITH inbox_categories AS (
      SELECT DISTINCT paper_category.value AS code
      FROM papers p
      JOIN user_paper_states ups ON ups.paper_id = p.id AND ups.in_inbox = 1
      ${focusJoin}
      JOIN json_each(p.categories_json) paper_category
      WHERE NOT EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_id = p.id)
        ${focusFilter}
    )
    SELECT inbox_category.code, COALESCE(cc.name, inbox_category.code) AS name,
      ${groupExpression} AS group_code,
      COALESCE(cc.group_name, CASE ${groupExpression}
        WHEN 'cs' THEN 'Computer Science'
        WHEN 'math' THEN 'Mathematics'
        WHEN 'stat' THEN 'Statistics'
        WHEN 'q-bio' THEN 'Quantitative Biology'
        WHEN 'q-fin' THEN 'Quantitative Finance'
        WHEN 'eess' THEN 'Electrical Engineering and Systems Science'
        WHEN 'econ' THEN 'Economics'
        ELSE 'Physics'
      END) AS group_name
    FROM inbox_categories inbox_category
    LEFT JOIN category_cache cc ON cc.code = inbox_category.code
    ORDER BY group_name COLLATE NOCASE, inbox_category.code COLLATE NOCASE
  `).all(...parameters);
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.group_code)) groups.set(row.group_code, { code: row.group_code, name: row.group_name, categories: [] });
    groups.get(row.group_code).categories.push({ code: row.code, name: row.name });
  }
  return [...groups.values()];
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function filterList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.flatMap((item) => String(item).split(',')).map((item) => item.trim()).filter(Boolean))];
}

export function listPapers(db, filters = {}) {
  const view = filters.view ?? 'inbox';
  const conditions = [];
  const values = [];
  let collectionJoin = '';

  if (view === 'collection') {
    collectionJoin = 'JOIN paper_collections selected_pc ON selected_pc.paper_id = p.id';
    conditions.push('selected_pc.collection_id = ?');
    values.push(Number(filters.collectionId));
  } else if (view === 'archive') {
    conditions.push('ups.in_inbox = 0 AND ups.archived_at IS NOT NULL');
  } else {
    conditions.push('ups.in_inbox = 1 AND NOT EXISTS (SELECT 1 FROM paper_collections inbox_pc WHERE inbox_pc.paper_id = p.id)');
    if (view === 'focus') {
      conditions.push("(ups.unread_reason IN ('updated', 'manual') OR pcl.score >= ?)");
      values.push(focusThreshold(db));
    }
  }

  if (filters.q) {
    const query = `%${filters.q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    conditions.push(`(p.title LIKE ? ESCAPE '\\' OR p.authors LIKE ? ESCAPE '\\' OR p.abstract LIKE ? ESCAPE '\\' OR p.id LIKE ? ESCAPE '\\' OR p.categories_json LIKE ? ESCAPE '\\')`);
    values.push(query, query, query, query, query);
  }
  const selectedCategories = filterList(filters.categories ?? filters.category);
  const selectedCategoryGroups = filterList(filters.categoryGroups ?? filters.categoryGroup);
  if (selectedCategories.length || selectedCategoryGroups.length) {
    const groupExpression = categoryGroupExpression('paper_category.value', 'category_definition.group_code');
    const categoryConditions = [];
    if (selectedCategories.length) {
      categoryConditions.push(`paper_category.value IN (${placeholders(selectedCategories)})`);
      values.push(...selectedCategories);
    }
    if (selectedCategoryGroups.length) {
      categoryConditions.push(`${groupExpression} IN (${placeholders(selectedCategoryGroups)})`);
      values.push(...selectedCategoryGroups);
    }
    conditions.push(`EXISTS (
      SELECT 1 FROM json_each(p.categories_json) paper_category
      LEFT JOIN category_cache category_definition ON category_definition.code = paper_category.value
      WHERE ${categoryConditions.join(' OR ')}
    )`);
  }
  if (filters.read === 'read') conditions.push('ups.is_read = 1');
  if (filters.read === 'unread') conditions.push('ups.is_read = 0');
  if (filters.updated === 'true') conditions.push("ups.unread_reason = 'updated'");
  if (filters.collectionFilter) {
    conditions.push('EXISTS (SELECT 1 FROM paper_collections filter_pc WHERE filter_pc.paper_id = p.id AND filter_pc.collection_id = ?)');
    values.push(Number(filters.collectionFilter));
  }

  const timeColumn = view === 'collection'
    ? 'selected_pc.added_at'
    : view === 'archive' ? 'ups.archived_at' : 'ups.inbox_activity_at';
  if (filters.since) {
    conditions.push(`${timeColumn} >= ?`);
    values.push(filters.since);
  }

  const sortColumn = filters.sort === 'updated' || (!filters.sort && ['focus', 'inbox'].includes(view))
    ? 'COALESCE(p.updated_at, p.announced_at, ups.inbox_activity_at)'
    : timeColumn;
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const rows = db.prepare(`
    SELECT p.*, ups.is_read, ups.unread_reason, ups.in_inbox, ups.inbox_activity_at,
      ups.archived_version, ups.archived_at,
      paa.status AS ai_status, paa.explanation_zh, paa.translation_zh IS NOT NULL AS has_translation_zh,
      pcl.target_type AS predicted_target_type, pcl.target_collection_id AS predicted_collection_id,
      pcl.score AS classification_score, pcl.second_score AS classification_second_score,
      predicted_collection.name AS predicted_collection_name, predicted_collection.color AS predicted_collection_color,
      GROUP_CONCAT(DISTINCT ps.matched_category) AS matched_categories,
      GROUP_CONCAT(DISTINCT pc.collection_id) AS collection_ids
    FROM papers p
    JOIN user_paper_states ups ON ups.paper_id = p.id
    ${collectionJoin}
    LEFT JOIN paper_subscriptions ps ON ps.paper_id = p.id
    LEFT JOIN paper_collections pc ON pc.paper_id = p.id
    LEFT JOIN paper_ai_analyses paa ON paa.paper_id = p.id AND paa.paper_version = p.latest_version
    LEFT JOIN paper_classifications pcl ON pcl.paper_id = p.id AND pcl.paper_version = p.latest_version
    LEFT JOIN collections predicted_collection ON predicted_collection.id = pcl.target_collection_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY p.id
    ORDER BY ${sortColumn} DESC, ups.inbox_activity_at DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).all(...values, limit, offset);

  return rows.map((row) => ({
    ...row,
    categories: JSON.parse(row.categories_json),
    matched_categories: row.matched_categories ? row.matched_categories.split(',') : [],
    collection_ids: row.collection_ids ? row.collection_ids.split(',').map(Number) : [],
  }));
}

export function getStats(db) {
  const threshold = focusThreshold(db);
  const active = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN ups.in_inbox = 1 AND NOT EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_id = ups.paper_id) THEN 1 ELSE 0 END), 0) AS inbox,
      COALESCE(SUM(CASE WHEN ups.in_inbox = 1 AND ups.is_read = 0 AND NOT EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_id = ups.paper_id) THEN 1 ELSE 0 END), 0) AS unread,
      COALESCE(SUM(CASE WHEN ups.in_inbox = 1 AND ups.unread_reason = 'updated' AND NOT EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_id = ups.paper_id) THEN 1 ELSE 0 END), 0) AS updated,
      COALESCE(SUM(CASE WHEN ups.in_inbox = 1
        AND NOT EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_id = ups.paper_id)
        AND (ups.unread_reason IN ('updated', 'manual') OR pcl.score >= ?) THEN 1 ELSE 0 END), 0) AS focus,
      COALESCE(SUM(CASE WHEN ups.in_inbox = 1 AND ups.is_read = 0
        AND NOT EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_id = ups.paper_id)
        AND (ups.unread_reason IN ('updated', 'manual') OR pcl.score >= ?) THEN 1 ELSE 0 END), 0) AS focus_unread,
      COALESCE(SUM(CASE WHEN ups.in_inbox = 1 AND ups.unread_reason = 'updated'
        AND NOT EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_id = ups.paper_id)
        AND (ups.unread_reason IN ('updated', 'manual') OR pcl.score >= ?) THEN 1 ELSE 0 END), 0) AS focus_updated
    FROM user_paper_states ups
    JOIN papers p ON p.id = ups.paper_id
    LEFT JOIN paper_classifications pcl ON pcl.paper_id = p.id AND pcl.paper_version = p.latest_version
  `).get(threshold, threshold, threshold);
  return {
    ...active,
    archived: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM user_paper_states
      WHERE in_inbox = 0 AND archived_at IS NOT NULL
    `).get().count),
  };
}

export function getLatestCompletedSyncRunId(db) {
  return Number(db.prepare(`
    SELECT COALESCE(MAX(id), 0) AS id FROM sync_runs WHERE status != 'running'
  `).get().id);
}

export function getSyncChangesSince(db, afterRunId, throughRunId = null) {
  const upperBound = throughRunId == null ? '' : 'AND id <= ?';
  const parameters = throughRunId == null ? [afterRunId] : [afterRunId, throughRunId];
  const row = db.prepare(`
    SELECT
      COUNT(*) AS run_count,
      COALESCE(SUM(new_count), 0) AS new_count,
      COALESCE(SUM(updated_count), 0) AS updated_count,
      COALESCE(SUM(failed_count), 0) AS failed_count,
      COALESCE(MAX(id), ?) AS latest_sync_run_id
    FROM sync_runs
    WHERE id > ? ${upperBound} AND status != 'running'
  `).get(afterRunId, ...parameters);
  return {
    runCount: Number(row.run_count),
    newCount: Number(row.new_count),
    updatedCount: Number(row.updated_count),
    failedCount: Number(row.failed_count),
    latestSyncRunId: Number(row.latest_sync_run_id),
  };
}

function paperSourceHash(title, abstract) {
  return createHash('sha256').update(`${title}\n${abstract}`).digest('hex');
}

export function enqueuePaperAnalyses(db, paperIds, trigger = 'manual', options = {}) {
  const ids = [...new Set(paperIds.map(String))];
  const result = { selected: ids.length, queued: 0, alreadyCompleted: 0, alreadyQueued: 0, missing: 0 };
  if (!ids.length) return result;
  const now = new Date().toISOString();
  const priority = trigger === 'manual' ? 100 : 0;

  transaction(db, () => {
    const findPaper = db.prepare('SELECT id, latest_version, title, abstract FROM papers WHERE id = ?');
    const findAnalysis = db.prepare('SELECT status FROM paper_ai_analyses WHERE paper_id = ? AND paper_version = ?');
    const insert = db.prepare(`
      INSERT INTO paper_ai_analyses (
        paper_id, paper_version, source_hash, status, trigger, priority, queued_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
    `);
    const retry = db.prepare(`
      UPDATE paper_ai_analyses SET status = 'pending', trigger = ?, priority = ?, queued_at = ?,
        started_at = NULL, completed_at = NULL, next_attempt_at = NULL, last_error = NULL, attempt_count = 0
      WHERE paper_id = ? AND paper_version = ?
    `);
    for (const id of ids) {
      const paper = findPaper.get(id);
      if (!paper) { result.missing += 1; continue; }
      const existing = findAnalysis.get(id, paper.latest_version);
      if (!existing) {
        insert.run(id, paper.latest_version, paperSourceHash(paper.title, paper.abstract), trigger, priority, now);
        result.queued += 1;
      } else if (existing.status === 'succeeded' && !options.force) {
        result.alreadyCompleted += 1;
      } else if (['pending', 'running'].includes(existing.status)) {
        result.alreadyQueued += 1;
      } else {
        retry.run(trigger, priority, now, id, paper.latest_version);
        result.queued += 1;
      }
    }
  });
  return result;
}

export function enqueueFailedPaperAnalyses(db) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE paper_ai_analyses SET status = 'pending', trigger = 'manual', priority = 100, queued_at = ?,
      started_at = NULL, completed_at = NULL, next_attempt_at = NULL, last_error = NULL, attempt_count = 0
    WHERE status = 'failed'
  `).run(now);
  return { queued: Number(result.changes) };
}

export function enqueueUnprocessedInboxAnalyses(db) {
  const ids = db.prepare(`
    SELECT p.id FROM papers p
    JOIN user_paper_states ups ON ups.paper_id = p.id
    LEFT JOIN paper_ai_analyses paa ON paa.paper_id = p.id AND paa.paper_version = p.latest_version
    WHERE ups.in_inbox = 1 AND paa.paper_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_id = p.id)
    ORDER BY ups.inbox_activity_at DESC, p.id
  `).all().map((row) => row.id);
  return enqueuePaperAnalyses(db, ids, 'auto');
}

export function enqueueUnprocessedFocusAnalyses(db) {
  const ids = db.prepare(`
    SELECT p.id FROM papers p
    JOIN user_paper_states ups ON ups.paper_id = p.id
    LEFT JOIN paper_classifications pcl ON pcl.paper_id = p.id AND pcl.paper_version = p.latest_version
    LEFT JOIN paper_ai_analyses paa ON paa.paper_id = p.id AND paa.paper_version = p.latest_version
    WHERE ups.in_inbox = 1 AND paa.paper_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_id = p.id)
      AND (ups.unread_reason IN ('updated', 'manual') OR pcl.score >= ?)
    ORDER BY ups.inbox_activity_at DESC, p.id
  `).all(focusThreshold(db)).map((row) => row.id);
  return enqueuePaperAnalyses(db, ids, 'auto');
}

export function getPaperAiAnalysis(db, paperId) {
  return db.prepare(`
    SELECT paa.* FROM papers p
    LEFT JOIN paper_ai_analyses paa ON paa.paper_id = p.id AND paa.paper_version = p.latest_version
    WHERE p.id = ?
  `).get(paperId) ?? null;
}

export function listPaperAiResults(db, paperIds) {
  const ids = [...new Set(paperIds.map(String))].slice(0, 100);
  if (!ids.length) return [];
  return db.prepare(`
    SELECT p.id AS paper_id, paa.paper_version, paa.status, paa.explanation_zh,
      paa.translation_zh IS NOT NULL AS has_translation_zh, paa.last_error
    FROM papers p
    LEFT JOIN paper_ai_analyses paa ON paa.paper_id = p.id AND paa.paper_version = p.latest_version
    WHERE p.id IN (${placeholders(ids)})
  `).all(...ids);
}

export function getAiQueueStatus(db) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count FROM paper_ai_analyses GROUP BY status
  `).all();
  return Object.assign({ pending: 0, running: 0, succeeded: 0, failed: 0 },
    Object.fromEntries(rows.map((row) => [row.status, Number(row.count)])));
}

export function exportBackup(db) {
  const tables = Object.fromEntries(TABLES_IN_RESTORE_ORDER.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  return {
    format: 'arxiv-follow-up-backup',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    tables,
  };
}

export function restoreBackup(db, payload, options = {}) {
  const compatibleFormats = new Set(['arxiv-follow-up-backup', 'localrss-backup']);
  if (!payload || !compatibleFormats.has(payload.format) || ![1, 2, 3, 4, SCHEMA_VERSION].includes(payload.schemaVersion) || !payload.tables) {
    throw new Error('This is not a compatible ArxivFollowUp backup.');
  }

  const databasePath = databasePaths.get(db);
  const backupDirectory = options.backupDirectory
    ?? (databasePath && databasePath !== ':memory:' ? path.join(path.dirname(databasePath), 'backups') : BACKUP_DIRECTORY);
  fs.mkdirSync(backupDirectory, { recursive: true });
  const safetyPath = path.join(backupDirectory, `before-restore-${new Date().toISOString().replaceAll(':', '-')}.json`);
  fs.writeFileSync(safetyPath, JSON.stringify(exportBackup(db), null, 2), 'utf8');

  transaction(db, () => {
    for (const table of REBUILDABLE_TABLES) db.exec(`DELETE FROM ${table}`);
    for (const table of [...TABLES_IN_RESTORE_ORDER].reverse()) db.exec(`DELETE FROM ${table}`);
    for (const table of TABLES_IN_RESTORE_ORDER) {
      const rows = OPTIONAL_RESTORE_TABLES.has(table) && !payload.tables[table] ? [] : payload.tables[table];
      if (!Array.isArray(rows)) throw new Error(`Backup table is missing: ${table}`);
      for (const row of rows) {
        const columns = Object.keys(row);
        if (columns.length === 0) continue;
        db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders(columns)})`).run(...columns.map((column) => row[column]));
      }
    }
  });
  migrate(db);
  return safetyPath;
}

export function closeDatabase(db) {
  if (db?.isOpen) db.close();
}
