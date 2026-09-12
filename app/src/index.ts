// Entry point. Importing this module never starts a server — only running it directly does.
// This import-safety (ADRs A-001) lets the test suite `createApp()` in-process.

// MUST be first: populates process.env from app/.env before config.ts reads it at import time.
import './env.js';
import { createApp } from './routes.js';
import env from './config.js';
import type { ChatProvider } from './provider/types.js';
import { OpenAICompatibleProvider } from './provider/openai-compatible-provider.js';

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
    // On address-in-use the server is already listening; retry once for fast re-invocation.
    const maybeEADDRINUSE = String(err).includes('EADDRINUSE');
    await app.ready();
    if (!maybeEADDRINUSE) throw err;
  }

  console.log(`evolve_ai_proxy listening on http://${env.HTTP_HOST}:${env.HTTP_PORT}`);
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
