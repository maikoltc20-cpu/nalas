import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { isPostgresConfigured } from './src/server/db/pgStore.ts';
import { getSessionSigningSecret } from './src/server/modules/auth.ts';
import { getDatabaseInitStatus } from './src/server/modules/dbInit.ts';
import { ensureMetaVerifyTokenInitialized } from './src/server/modules/metaWebhook.ts';
import { getStorageBackendInfo, initializePersistence } from './src/server/modules/persistence.ts';
import { mountApiMiddleware } from './src/server/nodeExpressApp.ts';

const app = express();
app.set('trust proxy', 1);

// Delegate all /api and /api/* requests to shared Web Standard router without HTML fallback
mountApiMiddleware(app);

// ---------------------------------------------------------------------------
// Start Server (Vite dev middleware in dev, static dist in production)
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;

async function start() {
  if (!isPostgresConfigured()) {
    if (process.env.NODE_ENV !== 'production') {
      await initializePersistence();
      await getSessionSigningSecret();
      await ensureMetaVerifyTokenInitialized();
    } else {
      console.error(
        'NALAS en modo producción sin DATABASE_URL configurado. Los endpoints de sesión devolverán diagnóstico JSON controlado hasta configurar PostgreSQL.'
      );
    }
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
    app.get('*', (req, res) => {
      if (req.path === '/api' || req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'Ruta API no encontrada.' });
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    const storage = getStorageBackendInfo();
    console.log(`NALAS server listening on http://0.0.0.0:${PORT} (storage: ${storage.backend})`);
  });
}

start();
