import { AI_API_KEY } from './config.js';
import { enqueueUnprocessedInboxAnalyses, getAiQueueStatus, getSecret, getSettings, transaction } from './db.js';

const PROMPT_VERSION = 1;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];

function normalizeBaseUrl(value) {
  const url = new URL(String(value ?? '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('AI Base URL must use http or https.');
  return url.toString().replace(/\/$/, '');
}

export function getAiConfiguration(db, { includeApiKey = false } = {}) {
  const settings = getSettings(db);
  const configuredConcurrency = Number(settings.ai_max_concurrency);
  const savedApiKey = getSecret(db, 'ai_api_key');
  const configuration = {
    mode: settings.ai_processing_mode ?? 'off',
    baseUrl: settings.ai_base_url,
    model: settings.ai_model,
    maxConcurrency: Number.isInteger(configuredConcurrency) && configuredConcurrency > 0 ? configuredConcurrency : 10,
    timeoutSeconds: Math.min(Math.max(Number(settings.ai_request_timeout_seconds) || 120, 10), 600),
    abstractDisplayMode: settings.abstract_display_mode ?? 'original',
    apiKeyConfigured: Boolean(savedApiKey || AI_API_KEY),
  };
  if (includeApiKey) configuration.apiKey = savedApiKey || AI_API_KEY;
  return configuration;
}

function authorizationHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function requestBody(model, title, abstract) {
  return {
    model,
    messages: [
      {
        role: 'system',
        content: [
          '你是严谨的论文阅读助手。',
          '请忠实地把英文摘要翻译成中文，保留公式、缩写、模型名和数据集名。',
          '再用一个中文句子解释论文主要解决什么问题、采用什么方法；只能依据标题和摘要，不得补充外部事实。',
          '解释不得换行，建议不超过100个汉字。',
        ].join(''),
      },
      { role: 'user', content: `Title: ${title}\n\nAbstract: ${abstract}` },
    ],
    temperature: 0,
    max_tokens: 2_048,
    chat_template_kwargs: { enable_thinking: false },
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'paper_analysis',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            translation_zh: { type: 'string' },
            explanation_zh: { type: 'string' },
          },
          required: ['translation_zh', 'explanation_zh'],
        },
      },
    },
  };
}

async function callVllm(config, title, abstract, fetchImpl = fetch) {
  const response = await fetchImpl(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authorizationHeaders(config.apiKey) },
    body: JSON.stringify(requestBody(config.model, title, abstract)),
    signal: AbortSignal.timeout(config.timeoutSeconds * 1_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`AI service returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    error.statusCode = response.status;
    const retryAfter = response.headers?.get?.('retry-after');
    if (retryAfter && !Number.isNaN(Number(retryAfter))) error.retryAfterMs = Number(retryAfter) * 1_000;
    throw error;
  }
  const payload = await response.json();
  const choice = payload.choices?.[0];
  if (choice?.finish_reason !== 'stop' || !choice.message?.content) {
    throw new Error(`AI response was incomplete (${choice?.finish_reason ?? 'no content'}).`);
  }
  let content;
  try {
    content = JSON.parse(choice.message.content);
  } catch {
    throw new Error('AI response did not contain valid JSON.');
  }
  const translationZh = String(content.translation_zh ?? '').trim();
  const explanationZh = String(content.explanation_zh ?? '').trim();
  if (!translationZh || !explanationZh) throw new Error('AI response is missing required fields.');
  if (/\r|\n/.test(explanationZh) || explanationZh.length > 200) throw new Error('AI explanation is not a single concise sentence.');
  return {
    translationZh,
    explanationZh,
    inputTokens: Number(payload.usage?.prompt_tokens) || null,
    outputTokens: Number(payload.usage?.completion_tokens) || null,
  };
}

export async function testAiConnection(config, fetchImpl = fetch) {
  const startedAt = Date.now();
  const result = await callVllm(config, 'Connection test', 'We present a small method that improves efficiency.', fetchImpl);
  return { ok: true, latencyMs: Date.now() - startedAt, explanationZh: result.explanationZh };
}

function recoverInterruptedJobs(db) {
  db.prepare(`
    UPDATE paper_ai_analyses SET status = 'pending', started_at = NULL,
      next_attempt_at = NULL, last_error = 'Application restarted during processing.'
    WHERE status = 'running'
  `).run();
}

function claimNextJob(db, mode) {
  if (mode === 'off') return null;
  return transaction(db, () => {
    const triggerCondition = mode === 'manual' ? "AND paa.trigger = 'manual'" : '';
    const row = db.prepare(`
      SELECT paa.paper_id, paa.paper_version FROM paper_ai_analyses paa
      WHERE paa.status = 'pending' ${triggerCondition}
        AND (paa.next_attempt_at IS NULL OR paa.next_attempt_at <= ?)
      ORDER BY paa.priority DESC, paa.queued_at, paa.paper_id
      LIMIT 1
    `).get(new Date().toISOString());
    if (!row) return null;
    db.prepare(`
      UPDATE paper_ai_analyses SET status = 'running', started_at = ?, attempt_count = attempt_count + 1,
        next_attempt_at = NULL, last_error = NULL
      WHERE paper_id = ? AND paper_version = ? AND status = 'pending'
    `).run(new Date().toISOString(), row.paper_id, row.paper_version);
    return db.prepare(`
      SELECT paa.*, pv.title, pv.abstract FROM paper_ai_analyses paa
      JOIN paper_versions pv ON pv.paper_id = paa.paper_id AND pv.version = paa.paper_version
      WHERE paa.paper_id = ? AND paa.paper_version = ?
    `).get(row.paper_id, row.paper_version);
  });
}

function saveSuccess(db, job, config, result) {
  db.prepare(`
    UPDATE paper_ai_analyses SET status = 'succeeded', translation_zh = ?, explanation_zh = ?,
      provider = 'vllm-openai-compatible', model = ?, prompt_version = ?, last_error = NULL,
      completed_at = ?, next_attempt_at = NULL, input_tokens = ?, output_tokens = ?
    WHERE paper_id = ? AND paper_version = ? AND source_hash = ?
  `).run(result.translationZh, result.explanationZh, config.model, PROMPT_VERSION,
    new Date().toISOString(), result.inputTokens, result.outputTokens,
    job.paper_id, job.paper_version, job.source_hash);
}

function saveFailure(db, job, error) {
  const canRetry = job.attempt_count < MAX_ATTEMPTS && ![401, 403, 404].includes(error.statusCode);
  const nextAttempt = canRetry
    ? new Date(Date.now() + (error.retryAfterMs ?? RETRY_DELAYS_MS[Math.max(job.attempt_count - 1, 0)])).toISOString()
    : null;
  db.prepare(`
    UPDATE paper_ai_analyses SET status = ?, last_error = ?, completed_at = ?, next_attempt_at = ?
    WHERE paper_id = ? AND paper_version = ?
  `).run(canRetry ? 'pending' : 'failed', String(error.message).slice(0, 1_000),
    canRetry ? null : new Date().toISOString(), nextAttempt, job.paper_id, job.paper_version);
}

export function createAiCoordinator(db, options = {}) {
  recoverInterruptedJobs(db);
  if (getAiConfiguration(db).mode === 'auto') enqueueUnprocessedInboxAnalyses(db);
  const active = new Map();
  let timer = null;
  let stopped = false;
  let blockedError = null;

  const schedule = (delay = 0) => {
    if (stopped) return;
    if (timer) {
      if (delay > 0) return;
      clearTimeout(timer);
      timer = null;
    }
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, delay);
    timer.unref?.();
  };

  const run = async (job, config) => {
    try {
      const result = await callVllm(config, job.title, job.abstract, options.fetchImpl ?? fetch);
      saveSuccess(db, job, config, result);
    } catch (error) {
      saveFailure(db, job, error);
      if ([401, 403, 404].includes(error.statusCode)) blockedError = error.message;
    } finally {
      active.delete(`${job.paper_id}:v${job.paper_version}`);
      schedule();
    }
  };

  const pump = () => {
    if (stopped) return;
    const config = getAiConfiguration(db, { includeApiKey: true });
    while (!blockedError && config.mode !== 'off' && active.size < config.maxConcurrency) {
      const job = claimNextJob(db, config.mode);
      if (!job) break;
      const key = `${job.paper_id}:v${job.paper_version}`;
      active.set(key, run(job, config));
    }
    schedule(1_000);
  };

  schedule();
  return {
    kick() { schedule(); },
    configurationChanged() { blockedError = null; schedule(); },
    status() { return { ...getAiQueueStatus(db), active: active.size, blockedError, ...getAiConfiguration(db) }; },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
