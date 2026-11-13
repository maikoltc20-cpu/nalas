import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { isPostgresConfigured } from './src/server/db/pgStore.ts';
import { getSessionSigningSecret } from './src/server/modules/auth.ts';
import { getDatabaseInitStatus } from './src/server/modules/dbInit.ts';
import { ensureMetaVerifyTokenInitialized } from './src/server/modules/metaWebhook.ts';
import { getStorageBackendInfo, initializePersistence } from './src/server/modules/persistence.ts';
import { runWithRuntimeContext } from './src/server/runtimeContext.ts';
import { webApp } from './src/server/webApp.ts';

const app = express();
app.set('trust proxy', 1);

// Delegate all /api/* requests to shared Web Standard router (identical behavior to Cloudflare Workers)
app.use('/api', async (req, res, next) => {
  try {
    const chunks: Buffer[] = [];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        req.on('end', () => resolve());
        req.on('error', (err) => reject(err));
      });
    }
    const rawBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const proto = req.header('x-forwarded-proto') || req.protocol || 'http';
    const host = req.header('x-forwarded-host') || req.header('host') || 'localhost:3000';
    const fullUrl = `${proto}://${host}${req.originalUrl}`;

    const headers = new Headers();
    for (const [key, val] of Object.entries(req.headers)) {
      if (typeof val === 'string') {
        headers.set(key, val);
      } else if (Array.isArray(val)) {
        for (const item of val) headers.append(key, item);
      }
    }

    const webRequest = new Request(fullUrl, {
      method: req.method,
      headers,
      body: rawBody ? new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength) : undefined,
    });

    const webResponse = await runWithRuntimeContext(
      { env: process.env, isWorker: false },
      () => webApp.fetch(webRequest)
    );

    res.status(webResponse.status);
    webResponse.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const respBuf = Buffer.from(await webResponse.arrayBuffer());
    res.send(respBuf);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Start Server (Vite dev middleware in dev, static dist in production)
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;

async function start() {
  if (!isPostgresConfigured()) {
    await initializePersistence();
    await getSessionSigningSecret();
    await ensureMetaVerifyTokenInitialized();
  } else {
    const status = await getDatabaseInitStatus().catch(() => null);
    if (status && !status.initialized) {
      console.log('NALAS PostgreSQL pendiente de inicialización controlada (POST /api/system/initialize o npm run db:init).');
    }
  }
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    const storage = getStorageBackendInfo();
    console.log(`NALAS server listening on http://0.0.0.0:${PORT} (storage: ${storage.backend})`);
  });
}

start();
