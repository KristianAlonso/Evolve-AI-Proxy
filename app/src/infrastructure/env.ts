// Environment bootstrap: load `.env` BEFORE any module reads `process.env`
// (config.ts evaluates the Env object at import time, so this module must be the
// FIRST import of the entry point — ESM evaluates imports in listed order).
//
// Search order (first existing file wins; later files never overwrite):
//   1. app/.env          (next to src/ — the canonical dev file)
//   2. <cwd>/.env        (deployment override)
//
// Real environment variables ALWAYS win over the file (dotenv default), so
// `UPSTREAM_API_KEY=sk-… npx tsx src/index.ts` still overrides the file.

import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const candidates = [
  join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), // app/.env
  join(process.cwd(), '.env'), // cwd
];

const dotenvResult = config({
  path: candidates.filter((p) => existsSync(p)),
  quiet: true,
});

export const ENV_FILE_LOADED = dotenvResult.parsed !== undefined;
