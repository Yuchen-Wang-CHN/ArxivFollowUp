import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDirectory = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIRECTORY = path.resolve(srcDirectory, '..');
export const PUBLIC_DIRECTORY = path.join(ROOT_DIRECTORY, 'public');
export const KATEX_DIRECTORY = path.join(ROOT_DIRECTORY, 'node_modules', 'katex', 'dist');
export const MARKED_FILE = path.join(ROOT_DIRECTORY, 'node_modules', 'marked', 'lib', 'marked.umd.js');
export const DOMPURIFY_FILE = path.join(ROOT_DIRECTORY, 'node_modules', 'dompurify', 'dist', 'purify.min.js');
const configuredDataDirectory = process.env.AFU_DATA_DIR ?? process.env.LOCALRSS_DATA_DIR;
export const DATA_DIRECTORY = configuredDataDirectory
  ? path.resolve(configuredDataDirectory)
  : path.join(ROOT_DIRECTORY, 'data');
const configuredDatabasePath = process.env.AFU_DATABASE_PATH ?? process.env.LOCALRSS_DATABASE_PATH;
const defaultDatabasePath = path.join(DATA_DIRECTORY, 'afu.db');
const legacyDatabasePath = path.join(DATA_DIRECTORY, 'localrss.db');
export const DATABASE_PATH = configuredDatabasePath
  ? path.resolve(configuredDatabasePath)
  : (!fs.existsSync(defaultDatabasePath) && fs.existsSync(legacyDatabasePath) ? legacyDatabasePath : defaultDatabasePath);
export const BACKUP_DIRECTORY = path.join(DATA_DIRECTORY, 'backups');
export const HOST = '127.0.0.1';
export const PORT = Number.parseInt(process.env.PORT ?? '43110', 10);
export const ARXIV_RSS_BASE_URL = 'https://rss.arxiv.org/rss/';
export const ARXIV_API_URL = 'https://export.arxiv.org/api/query';
export const ARXIV_TAXONOMY_URL = 'https://arxiv.org/category_taxonomy';
export const REQUEST_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 3_000;
export const SCHEMA_VERSION = 8;
export const AI_DEFAULT_BASE_URL = process.env.AFU_AI_BASE_URL ?? process.env.LOCALRSS_AI_BASE_URL ?? 'http://127.0.0.1:8000/v1';
export const AI_DEFAULT_MODEL = process.env.AFU_AI_MODEL ?? process.env.LOCALRSS_AI_MODEL ?? 'Qwen/Qwen3.8-27B-FP8';
export const AI_API_KEY = process.env.AFU_AI_API_KEY ?? process.env.LOCALRSS_AI_API_KEY ?? '';
export const EMBEDDING_DEFAULT_BASE_URL = process.env.AFU_EMBEDDING_BASE_URL ?? 'http://127.0.0.1:8001/v1';
export const EMBEDDING_DEFAULT_MODEL = process.env.AFU_EMBEDDING_MODEL ?? 'Qwen/Qwen3-Embedding-0.6B';
export const EMBEDDING_API_KEY = process.env.AFU_EMBEDDING_API_KEY ?? '';
