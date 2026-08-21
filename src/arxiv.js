import { XMLParser } from 'fast-xml-parser';
import { ARXIV_API_URL, ARXIV_RSS_BASE_URL, ARXIV_TAXONOMY_URL, REQUEST_INTERVAL_MS } from './config.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
  isArray: (_name, path) => path.endsWith('.channel.item') || path.endsWith('.item.category'),
});

const atomParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
  isArray: (_name, path) => path.endsWith('.feed.entry'),
});

let requestChain = Promise.resolve();
let lastRequestStartedAt = 0;

async function pacedFetch(url, options, fetchImpl = fetch) {
  if (fetchImpl !== fetch || REQUEST_INTERVAL_MS === 0) return fetchImpl(url, options);
  const request = requestChain.then(async () => {
    const waitMs = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - lastRequestStartedAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastRequestStartedAt = Date.now();
    return fetchImpl(url, options);
  });
  requestChain = request.catch(() => {});
  return request;
}

const FALLBACK_CATEGORIES = [
  ['cs.AI', 'Artificial Intelligence', 'cs', 'Computer Science'],
  ['cs.CL', 'Computation and Language', 'cs', 'Computer Science'],
  ['cs.CV', 'Computer Vision and Pattern Recognition', 'cs', 'Computer Science'],
  ['cs.LG', 'Machine Learning', 'cs', 'Computer Science'],
  ['cs.RO', 'Robotics', 'cs', 'Computer Science'],
  ['cs.CR', 'Cryptography and Security', 'cs', 'Computer Science'],
  ['stat.ML', 'Machine Learning', 'stat', 'Statistics'],
  ['math.OC', 'Optimization and Control', 'math', 'Mathematics'],
  ['eess.SY', 'Systems and Control', 'eess', 'Electrical Engineering and Systems Science'],
  ['quant-ph', 'Quantum Physics', 'physics', 'Physics'],
].map(([code, name, groupCode, groupName]) => ({ code, name, groupCode, groupName }));

export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'object') return value['#text'] ?? value['@_href'] ?? '';
  return String(value);
}

export function parseArxivIdentifier(value) {
  const source = textValue(value);
  const modern = source.match(/(?:arXiv:|\/abs\/|oai:arXiv\.org:)?(\d{4}\.\d{4,5})(?:v(\d+))?/i);
  if (modern) return { id: modern[1], version: Number(modern[2] ?? 1) };

  const legacy = source.match(/(?:arXiv:|\/abs\/|oai:arXiv\.org:)?([a-z][a-z0-9.-]*\/\d{7})(?:v(\d+))?/i);
  if (legacy) return { id: legacy[1], version: Number(legacy[2] ?? 1) };
  return null;
}

function descriptionParts(description, explicitAnnounceType) {
  const raw = textValue(description).trim();
  const match = raw.match(/^arXiv:\S+\s+Announce Type:\s*([^\s]+)\s+Abstract:\s*([\s\S]*)$/i);
  if (!match) return { abstract: raw.replace(/^Abstract:\s*/i, ''), announceType: textValue(explicitAnnounceType) || null };
  return { abstract: match[2].trim(), announceType: textValue(explicitAnnounceType) || match[1] };
}

function categoriesFromItem(item) {
  const categories = Array.isArray(item.category) ? item.category : item.category ? [item.category] : [];
  return [...new Set(categories.map((category) => normalizeWhitespace(textValue(category))).filter(Boolean))];
}

export function parseRss(xml) {
  const parsed = parser.parse(xml);
  const channel = parsed?.rss?.channel;
  if (!channel) throw new Error('The response is not a valid arXiv RSS feed.');
  const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
  const errors = [];
  const papers = [];

  items.forEach((item, index) => {
    try {
      const identifier = parseArxivIdentifier(item.guid) ?? parseArxivIdentifier(item.link) ?? parseArxivIdentifier(item.description);
      if (!identifier) throw new Error('Missing or invalid arXiv ID');
      const { abstract, announceType } = descriptionParts(item.description, item['arxiv:announce_type']);
      const announcedDate = new Date(textValue(item.pubDate));
      const categories = categoriesFromItem(item);
      const arxivUrl = normalizeWhitespace(textValue(item.link)) || `https://arxiv.org/abs/${identifier.id}`;
      papers.push({
        ...identifier,
        title: normalizeWhitespace(textValue(item.title)) || identifier.id,
        authors: normalizeWhitespace(textValue(item['dc:creator'])),
        abstract,
        categories,
        announcedAt: Number.isNaN(announcedDate.getTime()) ? null : announcedDate.toISOString(),
        arxivUrl,
        pdfUrl: `https://arxiv.org/pdf/${identifier.id}v${identifier.version}`,
        announceType: announceType || null,
      });
    } catch (error) {
      errors.push({ index, message: error.message });
    }
  });

  return {
    papers,
    errors,
    buildDate: textValue(channel.lastBuildDate) || null,
  };
}

export async function fetchCategoryFeed(category, { etag, lastModified, fetchImpl = fetch } = {}) {
  if (!/^[a-z-]+(?:\.[A-Za-z-]+)?$/.test(category)) throw new Error('Invalid arXiv category.');
  const headers = {
    Accept: 'application/rss+xml, application/xml;q=0.9',
    'User-Agent': 'ArxivFollowUp/0.1 (personal local research tracker)',
  };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  const response = await pacedFetch(`${ARXIV_RSS_BASE_URL}${encodeURIComponent(category)}`, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  }, fetchImpl);
  if (response.status === 304) {
    return { notModified: true, etag, lastModified };
  }
  if (!response.ok) throw new Error(`arXiv RSS returned HTTP ${response.status}`);
  const xml = await response.text();
  return {
    ...parseRss(xml),
    notModified: false,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  };
}

function decodeHtml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

export function parseCategoryTaxonomy(html) {
  const headings = [...html.matchAll(/<h2[^>]+id="accordion-head-grp_([^"]+)"[^>]*>/gi)];
  const categories = [];
  headings.forEach((heading, index) => {
    const groupCode = heading[1];
    const block = html.slice(heading.index, headings[index + 1]?.index ?? html.length);
    const button = block.match(/<button[^>]*>([\s\S]*?)<\/button>/i);
    const groupName = normalizeWhitespace(decodeHtml((button?.[1] ?? groupCode).replace(/<[^>]+>/g, ' ')));
    for (const categoryMatch of block.matchAll(/<h4>\s*([^\s<]+)\s*<span>\(([^<]+)\)<\/span><\/h4>/gi)) {
      categories.push({
        code: decodeHtml(categoryMatch[1]),
        name: normalizeWhitespace(decodeHtml(categoryMatch[2])),
        groupCode,
        groupName,
      });
    }
  });
  if (categories.length < 20) throw new Error('Could not parse the arXiv category taxonomy.');
  return categories;
}

export async function fetchCategoryTaxonomy(fetchImpl = fetch) {
  const response = await pacedFetch(ARXIV_TAXONOMY_URL, {
    headers: { 'User-Agent': 'ArxivFollowUp/0.1 (personal local research tracker)' },
    signal: AbortSignal.timeout(20_000),
  }, fetchImpl);
  if (!response.ok) throw new Error(`arXiv taxonomy returned HTTP ${response.status}`);
  return parseCategoryTaxonomy(await response.text());
}

export function getFallbackCategories() {
  return FALLBACK_CATEGORIES;
}

export function parseApiMetadata(xml) {
  const parsed = atomParser.parse(xml);
  const entries = Array.isArray(parsed?.feed?.entry) ? parsed.feed.entry : parsed?.feed?.entry ? [parsed.feed.entry] : [];
  return entries.map((entry) => {
    const identifier = parseArxivIdentifier(entry.id);
    if (!identifier) return null;
    const published = new Date(textValue(entry.published));
    const updated = new Date(textValue(entry.updated));
    return {
      id: identifier.id,
      version: identifier.version,
      publishedAt: Number.isNaN(published.getTime()) ? null : published.toISOString(),
      updatedAt: Number.isNaN(updated.getTime()) ? null : updated.toISOString(),
    };
  }).filter(Boolean);
}

export async function fetchPaperMetadata(ids, { fetchImpl = fetch } = {}) {
  const normalizedIds = [...new Set(ids.map((id) => parseArxivIdentifier(id)?.id).filter(Boolean))];
  if (normalizedIds.length === 0) return [];
  if (normalizedIds.length > 100) throw new Error('Metadata requests are limited to 100 arXiv IDs per batch.');
  const url = new URL(ARXIV_API_URL);
  url.searchParams.set('id_list', normalizedIds.join(','));
  url.searchParams.set('max_results', String(normalizedIds.length));
  const response = await pacedFetch(url, {
    headers: {
      Accept: 'application/atom+xml, application/xml;q=0.9',
      'User-Agent': 'ArxivFollowUp/0.1 (personal local research tracker)',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  }, fetchImpl);
  if (!response.ok) throw new Error(`arXiv Metadata API returned HTTP ${response.status}`);
  return parseApiMetadata(await response.text());
}
