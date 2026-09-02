import { getEmbeddingConfiguration, embedSearchQuery } from './embeddings.js';
import { getSettings, listDenseSearchCandidates, listPapers, searchPaperText } from './db.js';

const RRF_K = 60;
const MIN_CANDIDATE_POOL = 200;
const MAX_CANDIDATE_POOL = 500;

function denseWeight(db) {
  const value = Number(getSettings(db).search_dense_weight);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0.6;
}

function ftsQueryFor(value) {
  const tokens = String(value).normalize('NFKC')
    .match(/[\p{L}\p{N}]+(?:[._+-][\p{L}\p{N}]+)*/gu)
    ?.slice(0, 40) ?? [];
  return tokens.map((token) => `"${token}"`).join(' OR ');
}

function vectorFromBlob(blob, dimensions) {
  if (!blob || !dimensions) return null;
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) return null;
  return new Float32Array(Uint8Array.from(bytes).buffer);
}

function dot(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

function denseRanks(db, queryEmbedding, filters, limit) {
  return listDenseSearchCandidates(db, filters)
    .filter((row) => row.model === queryEmbedding.model && row.dimensions === queryEmbedding.dimensions)
    .map((row) => {
      const vector = vectorFromBlob(row.vector, row.dimensions);
      return vector ? { paper_id: row.id, score: dot(queryEmbedding.vector, vector) } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.paper_id.localeCompare(right.paper_id))
    .slice(0, limit);
}

function fuseRanks(bm25Rows, denseRows, bm25Weight, effectiveDenseWeight) {
  const fused = new Map();
  const add = (paperId, contribution, details) => {
    const current = fused.get(paperId) ?? { paperId, hybridScore: 0, bm25Score: null, denseSimilarity: null };
    current.hybridScore += contribution;
    Object.assign(current, details);
    fused.set(paperId, current);
  };
  if (bm25Weight > 0) bm25Rows.forEach((row, index) => add(row.paper_id, bm25Weight / (RRF_K + index + 1), { bm25Score: row.score }));
  if (effectiveDenseWeight > 0) denseRows.forEach((row, index) => add(row.paper_id, effectiveDenseWeight / (RRF_K + index + 1), { denseSimilarity: row.score }));
  return [...fused.values()].sort((left, right) => right.hybridScore - left.hybridScore || left.paperId.localeCompare(right.paperId));
}

export async function searchPapers(db, options = {}) {
  const query = String(options.query ?? '').trim();
  if (!query) throw Object.assign(new Error('Search query is required.'), { statusCode: 400 });
  if (query.length > 2_000) throw Object.assign(new Error('Search query must be at most 2000 characters.'), { statusCode: 400 });

  const offset = Math.max(Number(options.offset) || 0, 0);
  const limit = Math.min(Math.max(Number(options.limit) || 21, 1), 100);
  const candidateLimit = Math.min(Math.max(offset + limit + 1, MIN_CANDIDATE_POOL), MAX_CANDIDATE_POOL);
  const filters = { ...(options.filters ?? {}), q: null, offset: 0, limit: MAX_CANDIDATE_POOL };
  const requestedDenseWeight = denseWeight(db);
  const embeddingConfig = getEmbeddingConfiguration(db);
  const ftsQuery = ftsQueryFor(query);
  const bm25Rows = ftsQuery ? searchPaperText(db, ftsQuery, filters, candidateLimit) : [];

  let denseRows = [];
  let degraded = false;
  let message = null;
  const denseEnabled = embeddingConfig.mode === 'auto' && requestedDenseWeight > 0;
  if (denseEnabled) {
    try {
      const queryEmbedding = await embedSearchQuery(db, query, options.fetchImpl ?? fetch);
      denseRows = denseRanks(db, queryEmbedding, filters, candidateLimit);
      if (!denseRows.length) {
        degraded = true;
        message = 'No compatible paper embeddings are available; showing BM25 results.';
      }
    } catch (error) {
      degraded = true;
      message = `Dense search unavailable; showing BM25 results. ${error.message}`;
    }
  }

  const effectiveDenseWeight = denseRows.length ? requestedDenseWeight : 0;
  const effectiveBm25Weight = effectiveDenseWeight ? 1 - effectiveDenseWeight : 1;
  const ranked = fuseRanks(bm25Rows, denseRows, effectiveBm25Weight, effectiveDenseWeight);
  const page = ranked.slice(offset, offset + limit);
  const ids = page.map((row) => row.paperId);
  const papersById = ids.length
    ? new Map(listPapers(db, { ...filters, paperIds: ids, limit: ids.length }).map((paper) => [paper.id, paper]))
    : new Map();
  const papers = page.map((rankedPaper, index) => ({
    ...papersById.get(rankedPaper.paperId),
    search_rank: offset + index + 1,
    hybrid_score: rankedPaper.hybridScore,
    bm25_score: rankedPaper.bm25Score,
    dense_similarity: rankedPaper.denseSimilarity,
  })).filter((paper) => paper.id);

  return {
    papers,
    search: {
      query,
      mode: effectiveDenseWeight ? 'hybrid' : 'bm25',
      requestedDenseWeight,
      effectiveDenseWeight,
      effectiveBm25Weight,
      degraded,
      message,
      hasMore: ranked.length > offset + limit,
    },
  };
}
