import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { isLocalDevPreviewBypassEnabled } from '../src/server/modules/auth.ts';
import { resetMemoryCacheForTests } from '../src/server/modules/persistence.ts';
import { createInitialStore } from '../src/server/modules/seed.ts';
import { mountApiMiddleware } from '../src/server/nodeExpressApp.ts';
import { runWithRuntimeContext } from '../src/server/runtimeContext.ts';
import { webApp } from '../src/server/webApp.ts';
import worker from '../src/worker.ts';

function startTestExpressApp(
  options?: Parameters<typeof mountApiMiddleware>[1]
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.set('trust proxy', 1);
  mountApiMiddleware(app, options);
  app.get('*', (_req, res) => {
    res
      .status(200)
      .type('text/html')
      .send('<!doctype html><html><body>SPA Fallback</body></html>');
  });

  const server: Server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('Unexpected server address');
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((resClose, rejClose) =>
            server.close((err) => (err ? rejClose(err) : resClose()))
          ),
      });
    });
  });
}

test('1) Acceso directo de desarrollo y sus controles de seguridad permanecen intactos', () => {
  const localDevAllowed = runWithRuntimeContext(
    { env: { NODE_ENV: 'development' }, isWorker: false },
    () => isLocalDevPreviewBypassEnabled()
  );
  assert.equal(localDevAllowed, true);

  const workerBlocked = runWithRuntimeContext(
    { env: { NODE_ENV: 'development' }, isWorker: true },
    () => isLocalDevPreviewBypassEnabled()
  );
  assert.equal(workerBlocked, false);

  const prodBlocked = runWithRuntimeContext(
    { env: { NODE_ENV: 'production' }, isWorker: false },
    () => isLocalDevPreviewBypassEnabled()
  );
  assert.equal(prodBlocked, false);

  const demoDisabledBlocked = runWithRuntimeContext(
    { env: { NODE_ENV: 'development', NALAS_DISABLE_DEMO_LOGIN: 'true' }, isWorker: false },
    () => isLocalDevPreviewBypassEnabled()
  );
  assert.equal(demoDisabledBlocked, false);

  const requireProdBlocked = runWithRuntimeContext(
    { env: { NODE_ENV: 'development', NALAS_REQUIRE_PROD_AUTH: 'true' }, isWorker: false },
    () => isLocalDevPreviewBypassEnabled()
  );
  assert.equal(requireProdBlocked, false);

  const cliInitBlocked = runWithRuntimeContext(
    { env: { NODE_ENV: 'development', NALAS_CLI_INIT: 'true' }, isWorker: false },
    () => isLocalDevPreviewBypassEnabled()
  );
  assert.equal(cliInitBlocked, false);
});

test('2) Express /api bridge: /api/auth/session y /api/bootstrap devuelven JSON incluso con cabeceras proxy múltiples y nunca caen en HTML', async () => {
  resetMemoryCacheForTests(createInitialStore());
  const srv = await startTestExpressApp({
    env: { NODE_ENV: 'development' },
  });

  try {
    const sessionRes = await fetch(`${srv.baseUrl}/api/auth/session`, {
      headers: {
        'x-forwarded-proto': 'https, http',
        'x-forwarded-host': 'ais-dev-demo.us-west2.run.app, internal-proxy.local',
      },
    });
    assert.equal(sessionRes.status, 200);
    assert.match(sessionRes.headers.get('content-type') || '', /application\/json/i);
    const sessionJson = (await sessionRes.json()) as {
      authenticated: boolean;
      devPreviewDirectAccess?: boolean;
      user: { id: string } | null;
    };
    assert.equal(sessionJson.authenticated, true);
    assert.equal(sessionJson.devPreviewDirectAccess, true);
    assert.equal(sessionJson.user?.id, 'user_michael');

    const bootstrapRes = await fetch(
      `${srv.baseUrl}/api/bootstrap?businessId=biz_nexo&environment=prueba`
    );
    assert.equal(bootstrapRes.status, 200);
    assert.match(bootstrapRes.headers.get('content-type') || '', /application\/json/i);
    const bootstrapJson = (await bootstrapRes.json()) as {
      actor: { businessId: string; accessError: string | null };
      scoped: unknown;
    };
    assert.equal(bootstrapJson.actor.businessId, 'biz_nexo');
    assert.equal(bootstrapJson.actor.accessError, null);
    assert.ok(bootstrapJson.scoped);

    for (const apiPath of ['/api', '/api/', '/api/auth/session/', '/api/ruta-inexistente']) {
      const notFoundRes = await fetch(`${srv.baseUrl}${apiPath}`);
      assert.equal(notFoundRes.status, 404, `Esperaba 404 para ${apiPath}`);
      assert.match(
        notFoundRes.headers.get('content-type') || '',
        /application\/json/i,
        `Content-Type no JSON en ${apiPath}`
      );
      const bodyText = await notFoundRes.text();
      assert.equal(bodyText.trimStart().startsWith('<'), false, `Devolvió HTML en ${apiPath}`);
      assert.ok(JSON.parse(bodyText).error);
    }

    const spaRes = await fetch(`${srv.baseUrl}/`);
    assert.equal(spaRes.status, 200);
    assert.match(spaRes.headers.get('content-type') || '', /text\/html/i);
  } finally {
    await srv.close();
    resetMemoryCacheForTests();
  }
});

test('3) Express /api bridge: excepciones internas en /api devuelven JSON 500 y jamás <!DOCTYPE html> de Express', async () => {
  const srv = await startTestExpressApp({
    handler: async () => {
      throw new Error('Fallo simulado en router API');
    },
  });

  try {
    const res = await fetch(`${srv.baseUrl}/api/auth/session`);
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type') || '', /application\/json/i);
    const text = await res.text();
    assert.equal(text.trimStart().startsWith('<'), false);
    const parsed = JSON.parse(text) as { error: string };
    assert.match(parsed.error, /Fallo simulado en router API/);
  } finally {
    await srv.close();
  }
});

test('4) Sesión de desarrollo con fallo de almacenamiento devuelve diagnóstico JSON y no texto plano/HTML', async () => {
  resetMemoryCacheForTests();
  const res = await runWithRuntimeContext(
    {
      env: {
        NODE_ENV: 'development',
        NALAS_ALLOW_PG_IN_DEV: 'true',
        DATABASE_URL: 'postgresql://invalid-host-without-db',
      },
      isWorker: false,
    },
    () => webApp.fetch(new Request('http://localhost:3000/api/auth/session'))
  );

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/i);
  const body = (await res.json()) as {
    authenticated: boolean;
    authIssue: { code: string } | null;
  };
  assert.equal(body.authenticated, false);
  assert.ok(body.authIssue?.code);
});

test('5) Cloudflare Worker: rutas /api y /api/* siempre responden JSON y nunca caen en ASSETS SPA HTML', async () => {
  const fakeAssets = {
    async fetch() {
      return new Response('<!doctype html><html><body>SPA Asset</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  };
  const workerEnv = {
    ASSETS: fakeAssets,
    NODE_ENV: 'production',
    NALAS_DISABLE_DEMO_LOGIN: 'true',
  };
  const execCtx = { waitUntil() {} };

  const sessionRes = await worker.fetch(
    new Request('https://nalas-piloto.michael-997.workers.dev/api/auth/session'),
    workerEnv,
    execCtx
  );
  assert.equal(sessionRes.status, 200);
  assert.match(sessionRes.headers.get('content-type') || '', /application\/json/i);
  const sessionJson = (await sessionRes.json()) as {
    productionMode?: boolean;
    devPreviewDirectAccess?: boolean;
  };
  assert.equal(sessionJson.productionMode, true);
  assert.equal(Boolean(sessionJson.devPreviewDirectAccess), false);

  for (const apiPath of ['/api', '/api/', '/api/auth/session/', '/api/desconocida']) {
    const res = await worker.fetch(
      new Request(`https://nalas-piloto.michael-997.workers.dev${apiPath}`),
      workerEnv,
      execCtx
    );
    assert.ok(
      res.status === 401 || res.status === 404,
      `Esperaba 401 o 404 JSON en Worker para ${apiPath}, recibido ${res.status}`
    );
    assert.match(res.headers.get('content-type') || '', /application\/json/i);
    const bodyText = await res.text();
    assert.equal(bodyText.trimStart().startsWith('<'), false);
    assert.ok(JSON.parse(bodyText).error);
  }

  const spaRes = await worker.fetch(
    new Request('https://nalas-piloto.michael-997.workers.dev/atencion'),
    workerEnv,
    execCtx
  );
  assert.equal(spaRes.status, 200);
  assert.match(spaRes.headers.get('content-type') || '', /text\/html/i);
});
