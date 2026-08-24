import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDatabase,
  enqueuePaperAnalyses,
  enqueueUnprocessedInboxAnalyses,
  exportBackup,
  getAiQueueStatus,
  getPaperAiAnalysis,
  getSettings,
  getStats,
  listCollections,
  listInboxCategoryGroups,
  listPapers,
  listPaperAiResults,
  listSubscriptions,
  restoreBackup,
  setSetting,
  transaction,
} from './db.js';
import { createAiCoordinator, getAiConfiguration, testAiConnection } from './ai.js';
import { fetchCategoryTaxonomy, getFallbackCategories } from './arxiv.js';
import { HOST, KATEX_DIRECTORY, PORT, PUBLIC_DIRECTORY } from './config.js';
import { dueSubscriptions, enrichPaperDates, syncSubscriptions } from './sync.js';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function json(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

function noContent(response) {
  response.writeHead(204, { 'Cache-Control': 'no-store' });
  response.end();
}

async function readJson(request, maxBytes = 50 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 });
  }
}

function assertMutationRequest(request) {
  if (request.headers['x-afu-request'] !== '1' && request.headers['x-localrss-request'] !== '1') {
    throw Object.assign(new Error('Missing local request header.'), { statusCode: 403 });
  }
  const origin = request.headers.origin;
  if (origin) {
    const allowed = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
    if (!allowed.has(origin)) throw Object.assign(new Error('Cross-origin request denied.'), { statusCode: 403 });
  }
}

function normalizeCategory(category) {
  const value = String(category ?? '').trim();
  if (!/^[a-z-]+(?:\.[A-Za-z-]+)?$/.test(value)) {
    throw Object.assign(new Error('Invalid arXiv category.'), { statusCode: 400 });
  }
  return value;
}

function getCategoryCache(db) {
  return db.prepare(`
    SELECT code, name, group_code AS groupCode, group_name AS groupName, refreshed_at AS refreshedAt
    FROM category_cache ORDER BY group_name, code
  `).all();
}

async function refreshCategories(db) {
  let categories;
  let source = 'arxiv';
  try {
    categories = await fetchCategoryTaxonomy();
  } catch (error) {
    const cached = getCategoryCache(db);
    if (cached.length) return { categories: cached, source: 'cache', warning: error.message };
    categories = getFallbackCategories();
    source = 'fallback';
  }
  const now = new Date().toISOString();
  transaction(db, () => {
    db.exec('DELETE FROM category_cache');
    const insert = db.prepare(`
      INSERT INTO category_cache (code, name, group_code, group_name, refreshed_at) VALUES (?, ?, ?, ?, ?)
    `);
    for (const category of categories) insert.run(category.code, category.name, category.groupCode, category.groupName, now);
  });
  return { categories: getCategoryCache(db), source };
}

function parsePaperFilters(url) {
  const filters = Object.fromEntries(url.searchParams.entries());
  const collect = (name) => [...new Set(url.searchParams.getAll(name)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean))];
  filters.categories = collect('category');
  filters.categoryGroups = collect('categoryGroup');
  delete filters.category;
  delete filters.categoryGroup;
  return filters;
}

function changePaperState(db, paperId, action, options = {}) {
  const now = new Date().toISOString();
  const paper = db.prepare(`
    SELECT p.latest_version, ups.* FROM papers p
    JOIN user_paper_states ups ON ups.paper_id = p.id WHERE p.id = ?
  `).get(paperId);
  if (!paper) throw Object.assign(new Error('Paper not found.'), { statusCode: 404 });

  if (action === 'read') {
    db.prepare("UPDATE user_paper_states SET is_read = 1, unread_reason = NULL, read_at = ? WHERE paper_id = ?").run(now, paperId);
  } else if (action === 'unread') {
    db.prepare("UPDATE user_paper_states SET is_read = 0, unread_reason = 'manual', read_at = NULL WHERE paper_id = ?").run(paperId);
  } else if (action === 'archive') {
    db.prepare(`
      UPDATE user_paper_states SET in_inbox = 0, archived_version = ?, archived_at = ? WHERE paper_id = ?
    `).run(paper.latest_version, now, paperId);
  } else if (action === 'inbox') {
    const collectionCount = db.prepare('SELECT COUNT(*) AS count FROM paper_collections WHERE paper_id = ?').get(paperId).count;
    if (collectionCount) throw Object.assign(new Error('Remove the paper from all collections before moving it to Inbox.'), { statusCode: 409 });
    db.prepare(`
      UPDATE user_paper_states SET in_inbox = 1, inbox_activity_at = ?, archived_version = NULL, archived_at = NULL
      WHERE paper_id = ?
    `).run(now, paperId);
  } else if (action === 'addToCollection') {
    const collectionId = Number(options.collectionId);
    const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId);
    if (!collection) throw Object.assign(new Error('Collection not found.'), { statusCode: 404 });
    db.prepare(`
      INSERT OR IGNORE INTO paper_collections (paper_id, collection_id, added_at) VALUES (?, ?, ?)
    `).run(paperId, collectionId, now);
    db.prepare('UPDATE user_paper_states SET in_inbox = 0 WHERE paper_id = ?').run(paperId);
  } else if (action === 'removeFromCollection') {
    const collectionId = Number(options.collectionId);
    const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId);
    if (!collection) throw Object.assign(new Error('Collection not found.'), { statusCode: 404 });
    db.prepare('DELETE FROM paper_collections WHERE paper_id = ? AND collection_id = ?').run(paperId, collectionId);
    const remainingCount = db.prepare('SELECT COUNT(*) AS count FROM paper_collections WHERE paper_id = ?').get(paperId).count;
    if (remainingCount === 0) {
      db.prepare(`
        UPDATE user_paper_states SET in_inbox = 1, inbox_activity_at = ?, archived_version = NULL, archived_at = NULL
        WHERE paper_id = ?
      `).run(now, paperId);
    }
  } else {
    throw Object.assign(new Error('Unknown paper action.'), { statusCode: 400 });
  }
}

function serveStatic(response, pathname) {
  const isKatexAsset = pathname.startsWith('/vendor/katex/');
  const rootDirectory = isKatexAsset ? KATEX_DIRECTORY : PUBLIC_DIRECTORY;
  const relative = isKatexAsset
    ? pathname.slice('/vendor/katex/'.length)
    : pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolvedRoot = path.resolve(rootDirectory);
  const filePath = path.resolve(resolvedRoot, relative);
  if (!filePath.startsWith(`${resolvedRoot}${path.sep}`) && filePath !== path.join(resolvedRoot, 'index.html')) {
    json(response, 403, { error: 'Forbidden.' });
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    json(response, 404, { error: 'Not found.' });
    return;
  }
  const content = fs.readFileSync(filePath);
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(content);
}

export function createApp({ db = createDatabase(), port = PORT, startAiWorker = false } = {}) {
  const ai = startAiWorker
    ? createAiCoordinator(db)
    : { kick() {}, configurationChanged() {}, stop() {}, status: () => ({ ...getAiQueueStatus(db), active: 0, blockedError: null, ...getAiConfiguration(db) }) };
  let server;
  let shutdownStarted = false;
  const shutdown = ({ exitProcess = false } = {}) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    ai.stop();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (db?.isOpen) db.close();
      if (exitProcess) process.exit(0);
    };
    server.close(finish);
    setTimeout(finish, 5_000).unref();
  };
  const handler = async (request, response) => {
    const url = new URL(request.url, `http://${HOST}:${port}`);
    try {
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method)) assertMutationRequest(request);

      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        const categories = getCategoryCache(db);
        const due = dueSubscriptions(db);
        return json(response, 200, {
          settings: getSettings(db),
          stats: getStats(db),
          subscriptions: listSubscriptions(db),
          collections: listCollections(db),
          categories: categories.length ? categories : getFallbackCategories(),
          paperCategoryGroups: listInboxCategoryGroups(db),
          categoriesNeedRefresh: categories.length === 0,
          dueSubscriptionCount: due.length,
          ai: ai.status(),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/categories') {
        const cached = getCategoryCache(db);
        return json(response, 200, { categories: cached.length ? cached : getFallbackCategories(), source: cached.length ? 'cache' : 'fallback' });
      }

      if (request.method === 'GET' && url.pathname === '/api/paper-categories') {
        return json(response, 200, { groups: listInboxCategoryGroups(db) });
      }

      if (request.method === 'POST' && url.pathname === '/api/categories/refresh') {
        const result = await refreshCategories(db);
        return json(response, 200, { ...result, paperCategoryGroups: listInboxCategoryGroups(db) });
      }

      if (request.method === 'GET' && url.pathname === '/api/papers') {
        return json(response, 200, { papers: listPapers(db, parsePaperFilters(url)), paperCategoryGroups: listInboxCategoryGroups(db), stats: getStats(db) });
      }

      if (request.method === 'GET' && url.pathname === '/api/ai/config') {
        return json(response, 200, ai.status());
      }

      if (request.method === 'PATCH' && url.pathname === '/api/ai/config') {
        const payload = await readJson(request);
        let backfill = null;
        if (payload.mode != null) {
          if (!['off', 'auto', 'manual'].includes(payload.mode)) throw Object.assign(new Error('Invalid AI processing mode.'), { statusCode: 400 });
          setSetting(db, 'ai_processing_mode', payload.mode);
        }
        if (payload.baseUrl != null) {
          let parsed;
          try { parsed = new URL(String(payload.baseUrl).trim()); } catch { throw Object.assign(new Error('Invalid AI Base URL.'), { statusCode: 400 }); }
          if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('AI Base URL must use http or https.'), { statusCode: 400 });
          setSetting(db, 'ai_base_url', parsed.toString().replace(/\/$/, ''));
        }
        if (payload.model != null) {
          const model = String(payload.model).trim();
          if (!model || model.length > 200) throw Object.assign(new Error('AI model is required.'), { statusCode: 400 });
          setSetting(db, 'ai_model', model);
        }
        if (payload.maxConcurrency != null) {
          const value = Number(payload.maxConcurrency);
          if (!Number.isInteger(value) || value < 1 || value > 10) throw Object.assign(new Error('AI concurrency must be between 1 and 10.'), { statusCode: 400 });
          setSetting(db, 'ai_max_concurrency', value);
        }
        if (payload.abstractDisplayMode != null) {
          if (!['original', 'translated', 'bilingual'].includes(payload.abstractDisplayMode)) throw Object.assign(new Error('Invalid abstract display mode.'), { statusCode: 400 });
          setSetting(db, 'abstract_display_mode', payload.abstractDisplayMode);
        }
        if (getAiConfiguration(db).mode === 'auto') backfill = enqueueUnprocessedInboxAnalyses(db);
        ai.configurationChanged();
        return json(response, 200, { ...ai.status(), backfill });
      }

      if (request.method === 'POST' && url.pathname === '/api/ai/test') {
        const payload = await readJson(request);
        const config = getAiConfiguration(db);
        if (payload.baseUrl != null) config.baseUrl = String(payload.baseUrl).trim();
        if (payload.model != null) config.model = String(payload.model).trim();
        const result = await testAiConnection(config);
        return json(response, 200, result);
      }

      if (request.method === 'GET' && url.pathname === '/api/ai/status') {
        return json(response, 200, ai.status());
      }

      if (request.method === 'POST' && url.pathname === '/api/runtime/shutdown') {
        const expectedToken = process.env.AFU_TRAY_TOKEN ?? process.env.LOCALRSS_TRAY_TOKEN;
        const providedToken = request.headers['x-afu-tray-token'] ?? request.headers['x-localrss-tray-token'];
        if (!expectedToken || providedToken !== expectedToken) {
          throw Object.assign(new Error('Tray shutdown is not available.'), { statusCode: 403 });
        }
        json(response, 202, { ok: true });
        setImmediate(() => shutdown({ exitProcess: true }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/ai/results') {
        const ids = (url.searchParams.get('ids') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
        if (ids.length > 100) throw Object.assign(new Error('Request at most 100 AI results.'), { statusCode: 400 });
        return json(response, 200, { results: listPaperAiResults(db, ids), status: ai.status() });
      }

      if (request.method === 'POST' && url.pathname === '/api/ai/papers/batch') {
        const payload = await readJson(request);
        if (getAiConfiguration(db).mode !== 'manual') throw Object.assign(new Error('Switch AI processing to Manual before queuing selected papers.'), { statusCode: 409 });
        if (!Array.isArray(payload.paperIds) || payload.paperIds.length === 0 || payload.paperIds.length > 500) {
          throw Object.assign(new Error('Select between 1 and 500 papers.'), { statusCode: 400 });
        }
        const result = enqueuePaperAnalyses(db, payload.paperIds, 'manual');
        ai.kick();
        return json(response, 202, { ...result, status: ai.status() });
      }

      const versionsMatch = url.pathname.match(/^\/api\/papers\/(.+)\/versions$/);
      if (request.method === 'GET' && versionsMatch) {
        const paperId = decodeURIComponent(versionsMatch[1]);
        const versions = db.prepare('SELECT * FROM paper_versions WHERE paper_id = ? ORDER BY version DESC').all(paperId)
          .map((row) => ({ ...row, categories: JSON.parse(row.categories_json) }));
        return json(response, 200, { versions });
      }

      const paperAiRetryMatch = url.pathname.match(/^\/api\/papers\/(.+)\/ai\/retry$/);
      if (request.method === 'POST' && paperAiRetryMatch) {
        if (getAiConfiguration(db).mode === 'off') throw Object.assign(new Error('Enable Manual or Auto AI processing before retrying.'), { statusCode: 409 });
        const result = enqueuePaperAnalyses(db, [decodeURIComponent(paperAiRetryMatch[1])], 'manual', { force: true });
        ai.kick();
        return json(response, 202, result);
      }

      const paperAiMatch = url.pathname.match(/^\/api\/papers\/(.+)\/ai$/);
      if (request.method === 'GET' && paperAiMatch) {
        const paperId = decodeURIComponent(paperAiMatch[1]);
        const paper = db.prepare('SELECT id, latest_version FROM papers WHERE id = ?').get(paperId);
        if (!paper) throw Object.assign(new Error('Paper not found.'), { statusCode: 404 });
        return json(response, 200, { analysis: getPaperAiAnalysis(db, paperId) });
      }

      const paperMatch = url.pathname.match(/^\/api\/papers\/(.+)$/);
      if (request.method === 'PATCH' && paperMatch) {
        const payload = await readJson(request);
        transaction(db, () => changePaperState(db, decodeURIComponent(paperMatch[1]), payload.action, payload));
        return json(response, 200, { ok: true, stats: getStats(db) });
      }

      if (request.method === 'POST' && url.pathname === '/api/papers/batch') {
        const payload = await readJson(request);
        if (!Array.isArray(payload.paperIds) || payload.paperIds.length === 0 || payload.paperIds.length > 500) {
          throw Object.assign(new Error('Select between 1 and 500 papers.'), { statusCode: 400 });
        }
        transaction(db, () => {
          for (const paperId of [...new Set(payload.paperIds)]) changePaperState(db, paperId, payload.action, payload);
        });
        return json(response, 200, { ok: true, stats: getStats(db) });
      }

      if (request.method === 'GET' && url.pathname === '/api/subscriptions') {
        return json(response, 200, { subscriptions: listSubscriptions(db) });
      }

      if (request.method === 'POST' && url.pathname === '/api/subscriptions') {
        const payload = await readJson(request);
        const category = normalizeCategory(payload.category);
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO subscriptions (category, enabled, last_sync_result, created_at)
          VALUES (?, 1, 'never', ?)
          ON CONFLICT(category) DO UPDATE SET enabled = 1, paused_at = NULL, unsubscribed_at = NULL
        `).run(category, now);
        const subscription = db.prepare('SELECT * FROM subscriptions WHERE category = ? COLLATE NOCASE').get(category);
        const result = await syncSubscriptions(db, [subscription]);
        return json(response, result.failedCount ? 202 : 201, { subscription, sync: result, subscriptions: listSubscriptions(db), paperCategoryGroups: listInboxCategoryGroups(db), stats: getStats(db) });
      }

      const subscriptionMatch = url.pathname.match(/^\/api\/subscriptions\/(\d+)$/);
      if (subscriptionMatch && request.method === 'PATCH') {
        const id = Number(subscriptionMatch[1]);
        const payload = await readJson(request);
        const now = new Date().toISOString();
        if (payload.action === 'pause') {
          db.prepare('UPDATE subscriptions SET enabled = 0, paused_at = ? WHERE id = ? AND unsubscribed_at IS NULL').run(now, id);
        } else if (payload.action === 'resume') {
          db.prepare('UPDATE subscriptions SET enabled = 1, paused_at = NULL WHERE id = ? AND unsubscribed_at IS NULL').run(id);
        } else {
          throw Object.assign(new Error('Unknown subscription action.'), { statusCode: 400 });
        }
        return json(response, 200, { subscriptions: listSubscriptions(db) });
      }

      if (subscriptionMatch && request.method === 'DELETE') {
        const id = Number(subscriptionMatch[1]);
        db.prepare('UPDATE subscriptions SET enabled = 0, unsubscribed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        return noContent(response);
      }

      if (request.method === 'POST' && url.pathname === '/api/sync') {
        const payload = await readJson(request);
        let subscriptions;
        if (payload.subscriptionId) {
          subscriptions = db.prepare('SELECT * FROM subscriptions WHERE id = ? AND enabled = 1 AND unsubscribed_at IS NULL').all(Number(payload.subscriptionId));
        } else {
          subscriptions = db.prepare('SELECT * FROM subscriptions WHERE enabled = 1 AND unsubscribed_at IS NULL ORDER BY category').all();
        }
        const result = await syncSubscriptions(db, subscriptions);
        ai.kick();
        return json(response, 200, { ...result, subscriptions: listSubscriptions(db), paperCategoryGroups: listInboxCategoryGroups(db), stats: getStats(db) });
      }

      if (request.method === 'GET' && url.pathname === '/api/collections') {
        return json(response, 200, { collections: listCollections(db) });
      }

      if (request.method === 'POST' && url.pathname === '/api/collections') {
        const payload = await readJson(request);
        const name = String(payload.name ?? '').trim();
        if (!name || name.length > 80) throw Object.assign(new Error('Collection name must be 1–80 characters.'), { statusCode: 400 });
        const result = db.prepare('INSERT INTO collections (name, created_at) VALUES (?, ?)').run(name, new Date().toISOString());
        return json(response, 201, { collectionId: Number(result.lastInsertRowid), collections: listCollections(db) });
      }

      const collectionMatch = url.pathname.match(/^\/api\/collections\/(\d+)$/);
      if (collectionMatch && request.method === 'DELETE') {
        const id = Number(collectionMatch[1]);
        const collection = db.prepare('SELECT name FROM collections WHERE id = ?').get(id);
        if (!collection) throw Object.assign(new Error('Collection not found.'), { statusCode: 404 });
        if (collection.name === 'Favorites') throw Object.assign(new Error('Favorites cannot be deleted.'), { statusCode: 400 });
        db.prepare('DELETE FROM collections WHERE id = ?').run(id);
        return noContent(response);
      }

      if (request.method === 'PATCH' && url.pathname === '/api/settings') {
        const payload = await readJson(request);
        if (payload.refreshIntervalDays != null) {
          const days = Number(payload.refreshIntervalDays);
          if (!Number.isInteger(days) || days < 1 || days > 7) throw Object.assign(new Error('Refresh interval must be 1–7 days.'), { statusCode: 400 });
          setSetting(db, 'refresh_interval_days', String(days));
        }
        if (payload.displayDensity != null) {
          if (!['comfortable', 'compact'].includes(payload.displayDensity)) throw Object.assign(new Error('Invalid display density.'), { statusCode: 400 });
          setSetting(db, 'display_density', payload.displayDensity);
        }
        if (payload.openBrowserOnStart != null) {
          if (typeof payload.openBrowserOnStart !== 'boolean') throw Object.assign(new Error('Open-browser setting must be boolean.'), { statusCode: 400 });
          setSetting(db, 'open_browser_on_start', payload.openBrowserOnStart ? '1' : '0');
        }
        return json(response, 200, { settings: getSettings(db) });
      }

      if (request.method === 'GET' && url.pathname === '/api/backup') {
        const body = JSON.stringify(exportBackup(db), null, 2);
        const filename = `afu-backup-${new Date().toISOString().slice(0, 10)}.json`;
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        response.end(body);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/restore') {
        const payload = await readJson(request);
        const safetyBackup = restoreBackup(db, payload);
        return json(response, 200, { ok: true, safetyBackup, stats: getStats(db) });
      }

      if (request.method === 'GET' || request.method === 'HEAD') return serveStatic(response, url.pathname);
      return json(response, 404, { error: 'Not found.' });
    } catch (error) {
      const statusCode = error.statusCode ?? 500;
      if (statusCode >= 500) console.error(error);
      return json(response, statusCode, { error: error.message ?? 'Internal server error.' });
    }
  };

  server = http.createServer(handler);
  return { db, ai, handler, server, shutdown };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const app = createApp({ startAiWorker: true });
  app.server.listen(PORT, HOST, () => {
    console.log(`ArxivFollowUp is running at http://${HOST}:${PORT}`);
  });

  const metadataBackfill = setTimeout(async () => {
    const result = await enrichPaperDates(app.db);
    if (result.requestedCount) console.log(`Paper dates enriched: ${result.enrichedCount}/${result.requestedCount}`);
  }, 1_000);
  metadataBackfill.unref();

  const scheduler = setInterval(async () => {
    const due = dueSubscriptions(app.db);
    if (due.length) {
      await syncSubscriptions(app.db, due);
      app.ai.kick();
    }
  }, 60 * 60 * 1_000);
  scheduler.unref();

  process.once('SIGINT', () => app.shutdown({ exitProcess: true }));
  process.once('SIGTERM', () => app.shutdown({ exitProcess: true }));
}
