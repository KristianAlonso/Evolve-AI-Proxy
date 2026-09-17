// Entry point. Importing this module never starts a server — only running it directly does.
// This import-safety (ADRs A-001) lets the test suite `createApp()` in-process.

// MUST be first: populates process.env from app/.env before config.ts reads it at import time.
import './infrastructure/env.js';
import { createApp } from './presentation/app.js';
import env from './infrastructure/config.js';
import { paint } from './infrastructure/logger.js';
import type { ChatProvider } from './domain/provider/types.js';
import { OpenAICompatibleProvider } from './infrastructure/provider/openai-compatible-provider.js';

/** Start listening (used only when run directly: `node dist/index.js`). */
export async function main(provider?: ChatProvider): Promise<void> {
  const app = await createApp({
    provider,
    baseUrl: env.UPSTREAM_BASE_URL,
    apiKey: env.UPSTREAM_API_KEY,
  });

  try {
    await app.listen({ port: env.HTTP_PORT, host: env.HTTP_HOST });
  } catch (err) {
    const maybeEADDRINUSE = String(err).includes('EADDRINUSE');
    await app.ready(); // release resources either way
    if (maybeEADDRINUSE) {
      // A different process owns the port. It is the one serving requests — and the only one
      // whose console shows incoming-connection logs. Saying "listening" here (the old
      // behaviour) made new instances look healthy while silently logging nothing, so fail
      // loudly instead: the user must stop the other instance (usually a stale background
      // dev proxy) and start again.
      console.error(
        paint(
          `fatal: port ${env.HTTP_PORT} is already in use by another process. That instance is ` +
          `the one serving requests, so this console will NOT show incoming-connection logs. ` +
          `Stop the other process first, e.g. in PowerShell:\n` +
          `  Get-NetTCPConnection -LocalPort ${env.HTTP_PORT} -State Listen | ` +
          `  Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }`,
          'red',
        ),
      );
      process.exit(1);
    }
    throw err;
  }

  console.log(paint(`evolve_ai_proxy listening on http://${env.HTTP_HOST}:${env.HTTP_PORT}`, 'green'));
}

// Guard: run() only when executed directly, not on import (`require.main === module` for CJS,
// plus `import.meta.url` matching argv[1] for ESM). This is the key that makes tests safe.
const isMain =
  typeof require !== 'undefined'
    ? require.main === module
    : import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  main(new OpenAICompatibleProvider()).catch((err) => {
    console.error('fatal startup error:', err);
    process.exit(1);
  });
}

export default createApp;
