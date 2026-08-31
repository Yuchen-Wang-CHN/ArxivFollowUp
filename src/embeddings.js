import { createHash } from 'node:crypto';
import { EMBEDDING_API_KEY } from './config.js';
import { getSecret, getSettings, transaction } from './db.js';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
const MAX_EXEMPLARS_PER_TARGET = 48;
const NEAREST_EXEMPLAR_COUNT = 3;

function normalizeBaseUrl(value) {
  const url = new URL(String(value ?? '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Embedding Base URL must use http or https.');
  return url.toString().replace(/\/$/, '');
}

export function getEmbeddingConfiguration(db, { includeApiKey = false } = {}) {
  const settings = getSettings(db);
  const savedApiKey = getSecret(db, 'embedding_api_key');
  const configuredThreshold = Number(settings.classification_threshold);
  const configuration = {
    mode: settings.embedding_processing_mode ?? 'off',
    baseUrl: settings.embedding_base_url,
    model: settings.embedding_model,
    batchSize: Math.min(Math.max(Number(settings.embedding_batch_size) || 32, 1), 256),
    timeoutSeconds: Math.min(Math.max(Number(settings.embedding_request_timeout_seconds) || 120, 10), 600),
    threshold: Number.isFinite(configuredThreshold) ? Math.min(Math.max(configuredThreshold, -1), 1) : 0.55,
    margin: Math.min(Math.max(Number(settings.classification_margin) || 0.03, 0), 2),
    archiveColor: settings.archive_color ?? '#64748b',
    apiKeyConfigured: Boolean(savedApiKey || EMBEDDING_API_KEY),
  };
  if (includeApiKey) configuration.apiKey = savedApiKey || EMBEDDING_API_KEY;
  return configuration;
}

function sourceHash(title, abstract) {
  return createHash('sha256').update(`${title}\n${abstract}`).digest('hex');
}

function embeddingInput(paper) {
  return `Title: ${paper.title}\n\nAbstract: ${paper.abstract}`;
}

function normalizeVector(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('Embedding response contains an empty vector.');
  const vector = Float32Array.from(values, Number);
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('Embedding response contains a non-finite value.');
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  if (!norm) throw new Error('Embedding response contains a zero vector.');
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

function vectorBuffer(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function vectorFromBlob(blob, dimensions) {
  if (!blob || !dimensions) return null;
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) return null;
  const copy = Uint8Array.from(bytes);
  return new Float32Array(copy.buffer);
}

function authorizationHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function callEmbeddingApi(config, papers, fetchImpl = fetch) {
  const response = await fetchImpl(`${normalizeBaseUrl(config.baseUrl)}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authorizationHeaders(config.apiKey) },
    body: JSON.stringify({ model: config.model, input: papers.map(embeddingInput) }),
    signal: AbortSignal.timeout(config.timeoutSeconds * 1_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`Embedding service returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    error.statusCode = response.status;
    const retryAfter = response.headers?.get?.('retry-after');
    if (retryAfter && !Number.isNaN(Number(retryAfter))) error.retryAfterMs = Number(retryAfter) * 1_000;
    throw error;
  }
  const payload = await response.json();
  const ordered = [...(payload.data ?? [])].sort((left, right) => Number(left.index) - Number(right.index));
  if (ordered.length !== papers.length) throw new Error(`Embedding response returned ${ordered.length} vectors for ${papers.length} papers.`);
  const vectors = ordered.map((item) => normalizeVector(item.embedding));
  const dimensions = vectors[0].length;
  if (vectors.some((vector) => vector.length !== dimensions)) throw new Error('Embedding response contains inconsistent dimensions.');
  return { vectors, dimensions };
}

export async function testEmbeddingConnection(config, fetchImpl = fetch) {
  const startedAt = Date.now();
  const result = await callEmbeddingApi(config, [{ title: 'Connection test', abstract: 'A short paper about efficient retrieval.' }], fetchImpl);
  return { ok: true, latencyMs: Date.now() - startedAt, dimensions: result.dimensions };
}

export function getEmbeddingQueueStatus(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS count FROM paper_embeddings GROUP BY status').all();
  const status = Object.assign({ pending: 0, running: 0, succeeded: 0, failed: 0 },
    Object.fromEntries(rows.map((row) => [row.status, Number(row.count)])));
  status.classified = Number(db.prepare('SELECT COUNT(*) AS count FROM paper_classifications').get().count);
  return status;
}

export function enqueuePaperEmbeddings(db, paperIds) {
  const ids = [...new Set(paperIds.map(String))];
  const result = { selected: ids.length, queued: 0, alreadyCompleted: 0, alreadyQueued: 0, missing: 0 };
  if (!ids.length) return result;
  const now = new Date().toISOString();
  transaction(db, () => {
    const findPaper = db.prepare('SELECT id, latest_version, title, abstract FROM papers WHERE id = ?');
    const findEmbedding = db.prepare('SELECT status, source_hash FROM paper_embeddings WHERE paper_id = ? AND paper_version = ?');
    const insert = db.prepare(`
      INSERT INTO paper_embeddings (paper_id, paper_version, source_hash, status, queued_at)
      VALUES (?, ?, ?, 'pending', ?)
    `);
    const retry = db.prepare(`
      UPDATE paper_embeddings SET source_hash = ?, status = 'pending', vector = NULL, dimensions = NULL,
        provider = NULL, model = NULL, attempt_count = 0, last_error = NULL, queued_at = ?,
        started_at = NULL, completed_at = NULL, next_attempt_at = NULL
      WHERE paper_id = ? AND paper_version = ?
    `);
    for (const id of ids) {
      const paper = findPaper.get(id);
      if (!paper) { result.missing += 1; continue; }
      const hash = sourceHash(paper.title, paper.abstract);
      const existing = findEmbedding.get(id, paper.latest_version);
      if (!existing) {
        insert.run(id, paper.latest_version, hash, now);
        result.queued += 1;
      } else if (existing.status === 'succeeded' && existing.source_hash === hash) {
        result.alreadyCompleted += 1;
      } else if (['pending', 'running'].includes(existing.status) && existing.source_hash === hash) {
        result.alreadyQueued += 1;
      } else {
        retry.run(hash, now, id, paper.latest_version);
        result.queued += 1;
      }
    }
  });
  return result;
}

export function enqueueUnprocessedPaperEmbeddings(db) {
  const ids = db.prepare(`
    SELECT p.id FROM papers p
    LEFT JOIN paper_embeddings pe ON pe.paper_id = p.id AND pe.paper_version = p.latest_version
    WHERE pe.paper_id IS NULL
    ORDER BY p.first_seen_at, p.id
  `).all().map((row) => row.id);
  return enqueuePaperEmbeddings(db, ids);
}

export function resetPaperEmbeddings(db) {
  const now = new Date().toISOString();
  return transaction(db, () => {
    db.exec('DELETE FROM paper_classifications');
    const result = db.prepare(`
      UPDATE paper_embeddings SET status = 'pending', vector = NULL, dimensions = NULL,
        provider = NULL, model = NULL, attempt_count = 0, last_error = NULL, queued_at = ?,
        started_at = NULL, completed_at = NULL, next_attempt_at = NULL
    `).run(now);
    return { queued: Number(result.changes) };
  });
}

export function enqueueFailedPaperEmbeddings(db) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE paper_embeddings SET status = 'pending', attempt_count = 0, last_error = NULL,
      queued_at = ?, started_at = NULL, completed_at = NULL, next_attempt_at = NULL
    WHERE status = 'failed'
  `).run(now);
  return { queued: Number(result.changes) };
}

function dot(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

function normalizedCentroid(vectors) {
  const centroid = new Float32Array(vectors[0].length);
  for (const vector of vectors) {
    for (let index = 0; index < vector.length; index += 1) centroid[index] += vector[index];
  }
  let squaredNorm = 0;
  for (const value of centroid) squaredNorm += value * value;
  const norm = Math.sqrt(squaredNorm) || 1;
  for (let index = 0; index < centroid.length; index += 1) centroid[index] /= norm;
  return centroid;
}

function diverseExemplars(vectors, limit = MAX_EXEMPLARS_PER_TARGET) {
  if (vectors.length <= limit) return vectors;
  const centroid = normalizedCentroid(vectors);
  let first = 0;
  for (let index = 1; index < vectors.length; index += 1) {
    if (dot(vectors[index], centroid) > dot(vectors[first], centroid)) first = index;
  }
  const selected = [first];
  const selectedSet = new Set(selected);
  const minimumDistances = new Float32Array(vectors.length).fill(Number.POSITIVE_INFINITY);
  while (selected.length < limit) {
    const latest = vectors[selected.at(-1)];
    let next = -1;
    let greatestDistance = -1;
    for (let index = 0; index < vectors.length; index += 1) {
      if (selectedSet.has(index)) continue;
      minimumDistances[index] = Math.min(minimumDistances[index], 1 - dot(vectors[index], latest));
      if (minimumDistances[index] > greatestDistance) {
        greatestDistance = minimumDistances[index];
        next = index;
      }
    }
    if (next < 0) break;
    selected.push(next);
    selectedSet.add(next);
  }
  return selected.map((index) => vectors[index]);
}

function targetScore(vector, target) {
  const nearest = [];
  for (const exemplar of target.exemplars) {
    const similarity = dot(vector, exemplar);
    nearest.push(similarity);
    nearest.sort((left, right) => right - left);
    if (nearest.length > NEAREST_EXEMPLAR_COUNT) nearest.pop();
  }
  const localScore = nearest.reduce((sum, value) => sum + value, 0) / nearest.length;
  return 0.7 * localScore + 0.3 * dot(vector, target.centroid);
}

export function classifyPapers(db, configuration = getEmbeddingConfiguration(db)) {
  const embeddedRows = db.prepare(`
    SELECT p.id, p.latest_version, pe.vector, pe.dimensions, pe.model, pe.source_hash,
      ups.in_inbox,
      EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_id = p.id) AS is_collected
    FROM papers p
    JOIN user_paper_states ups ON ups.paper_id = p.id
    JOIN paper_embeddings pe ON pe.paper_id = p.id AND pe.paper_version = p.latest_version
    WHERE pe.status = 'succeeded' AND pe.vector IS NOT NULL
  `).all();
  const usableRows = embeddedRows.map((row) => ({ ...row, decodedVector: vectorFromBlob(row.vector, row.dimensions) }))
    .filter((row) => row.decodedVector);
  if (!usableRows.length) {
    db.exec('DELETE FROM paper_classifications');
    return { classified: 0, candidates: 0, targets: 0 };
  }
  const dimensions = usableRows[0].dimensions;
  const model = usableRows[0].model;
  const compatibleRows = usableRows.filter((row) => row.dimensions === dimensions && row.model === model);
  const byPaperId = new Map(compatibleRows.map((row) => [row.id, row]));
  const targetVectors = new Map();
  const memberships = db.prepare('SELECT paper_id, collection_id FROM paper_collections ORDER BY collection_id, paper_id').all();
  for (const membership of memberships) {
    const row = byPaperId.get(membership.paper_id);
    if (!row) continue;
    const key = `collection:${membership.collection_id}`;
    if (!targetVectors.has(key)) targetVectors.set(key, []);
    targetVectors.get(key).push(row.decodedVector);
  }
  const targets = [];
  for (const [key, vectors] of targetVectors) {
    if (!vectors.length) continue;
    targets.push({
      key,
      type: 'collection',
      collectionId: Number(key.split(':')[1]),
      centroid: normalizedCentroid(vectors),
      exemplars: diverseExemplars(vectors),
    });
  }
  const profileHash = createHash('sha256').update(JSON.stringify({
    model,
    targets: targets.map((target) => [target.key, targetVectors.get(target.key).length]),
    collectionLabels: memberships.map((row) => [row.paper_id, row.collection_id]).sort(),
  })).digest('hex');
  const candidates = compatibleRows.filter((row) => row.in_inbox && !row.is_collected);
  const predictions = [];
  if (targets.length) {
    for (const candidate of candidates) {
      const scores = targets.map((target) => ({ target, score: targetScore(candidate.decodedVector, target) }))
        .sort((left, right) => right.score - left.score);
      const best = scores[0];
      const secondScore = scores[1]?.score ?? null;
      if (best.score >= configuration.threshold && (secondScore == null || best.score - secondScore >= configuration.margin)) {
        predictions.push({ candidate, best, secondScore });
      }
    }
  }
  const now = new Date().toISOString();
  transaction(db, () => {
    db.exec('DELETE FROM paper_classifications');
    const insert = db.prepare(`
      INSERT INTO paper_classifications (
        paper_id, paper_version, target_type, target_collection_id, score, second_score,
        threshold, model, profile_hash, classified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const prediction of predictions) {
      insert.run(prediction.candidate.id, prediction.candidate.latest_version,
        prediction.best.target.type, prediction.best.target.collectionId,
        prediction.best.score, prediction.secondScore, configuration.threshold,
        model, profileHash, now);
    }
  });
  return { classified: predictions.length, candidates: candidates.length, targets: targets.length };
}

function recoverInterruptedJobs(db) {
  db.prepare(`
    UPDATE paper_embeddings SET status = 'pending', started_at = NULL, next_attempt_at = NULL,
      last_error = 'Application restarted during embedding.'
    WHERE status = 'running'
  `).run();
}

function claimBatch(db, batchSize) {
  return transaction(db, () => {
    const rows = db.prepare(`
      SELECT pe.paper_id, pe.paper_version FROM paper_embeddings pe
      WHERE pe.status = 'pending' AND (pe.next_attempt_at IS NULL OR pe.next_attempt_at <= ?)
      ORDER BY pe.queued_at, pe.paper_id LIMIT ?
    `).all(new Date().toISOString(), batchSize);
    if (!rows.length) return [];
    const now = new Date().toISOString();
    const claim = db.prepare(`
      UPDATE paper_embeddings SET status = 'running', started_at = ?, attempt_count = attempt_count + 1,
        next_attempt_at = NULL, last_error = NULL
      WHERE paper_id = ? AND paper_version = ? AND status = 'pending'
    `);
    for (const row of rows) claim.run(now, row.paper_id, row.paper_version);
    return db.prepare(`
      SELECT pe.*, pv.title, pv.abstract FROM paper_embeddings pe
      JOIN paper_versions pv ON pv.paper_id = pe.paper_id AND pv.version = pe.paper_version
      WHERE (pe.paper_id, pe.paper_version) IN (${rows.map(() => '(?, ?)').join(', ')})
      ORDER BY pe.queued_at, pe.paper_id
    `).all(...rows.flatMap((row) => [row.paper_id, row.paper_version]));
  });
}

function saveBatchSuccess(db, jobs, config, result) {
  const now = new Date().toISOString();
  transaction(db, () => {
    const update = db.prepare(`
      UPDATE paper_embeddings SET status = 'succeeded', vector = ?, dimensions = ?,
        provider = 'openai-compatible', model = ?, last_error = NULL, completed_at = ?, next_attempt_at = NULL
      WHERE paper_id = ? AND paper_version = ? AND source_hash = ?
    `);
    for (let index = 0; index < jobs.length; index += 1) {
      update.run(vectorBuffer(result.vectors[index]), result.dimensions, config.model, now,
        jobs[index].paper_id, jobs[index].paper_version, jobs[index].source_hash);
    }
  });
}

function saveBatchFailure(db, jobs, error) {
  const now = new Date().toISOString();
  transaction(db, () => {
    const update = db.prepare(`
      UPDATE paper_embeddings SET status = ?, last_error = ?, completed_at = ?, next_attempt_at = ?
      WHERE paper_id = ? AND paper_version = ?
    `);
    for (const job of jobs) {
      const canRetry = job.attempt_count < MAX_ATTEMPTS && ![401, 403, 404].includes(error.statusCode);
      const nextAttempt = canRetry
        ? new Date(Date.now() + (error.retryAfterMs ?? RETRY_DELAYS_MS[Math.max(job.attempt_count - 1, 0)])).toISOString()
        : null;
      update.run(canRetry ? 'pending' : 'failed', String(error.message).slice(0, 1_000),
        canRetry ? null : now, nextAttempt, job.paper_id, job.paper_version);
    }
  });
}

export function createEmbeddingCoordinator(db, options = {}) {
  recoverInterruptedJobs(db);
  if (getEmbeddingConfiguration(db).mode === 'auto') enqueueUnprocessedPaperEmbeddings(db);
  let timer = null;
  let active = null;
  let stopped = false;
  let blockedError = null;
  let classificationRequested = true;

  const schedule = (delay = 0) => {
    if (stopped) return;
    if (timer) {
      if (delay > 0) return;
      clearTimeout(timer);
    }
    timer = setTimeout(() => { timer = null; void pump(); }, delay);
    timer.unref?.();
  };

  const pump = async () => {
    if (stopped || active) return;
    const config = getEmbeddingConfiguration(db, { includeApiKey: true });
    if (!blockedError && config.mode === 'auto') {
      const jobs = claimBatch(db, config.batchSize);
      if (jobs.length) {
        active = (async () => {
          try {
            const result = await callEmbeddingApi(config, jobs, options.fetchImpl ?? fetch);
            saveBatchSuccess(db, jobs, config, result);
            classificationRequested = true;
          } catch (error) {
            saveBatchFailure(db, jobs, error);
            if ([401, 403, 404].includes(error.statusCode)) blockedError = error.message;
          } finally {
            active = null;
            schedule();
          }
        })();
        return;
      }
    }
    if (classificationRequested) {
      classificationRequested = false;
      const result = classifyPapers(db, config);
      options.onClassificationChanged?.(result);
    }
    schedule(1_000);
  };

  schedule();
  return {
    kick() {
      if (getEmbeddingConfiguration(db).mode === 'auto') enqueueUnprocessedPaperEmbeddings(db);
      schedule();
    },
    configurationChanged({ reset = false } = {}) {
      blockedError = null;
      if (reset) resetPaperEmbeddings(db);
      if (getEmbeddingConfiguration(db).mode === 'auto') enqueueUnprocessedPaperEmbeddings(db);
      classificationRequested = true;
      schedule();
    },
    classificationChanged() { classificationRequested = true; schedule(); },
    status() {
      return {
        ...getEmbeddingQueueStatus(db),
        active: active ? 1 : 0,
        blockedError,
        ...getEmbeddingConfiguration(db),
      };
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
