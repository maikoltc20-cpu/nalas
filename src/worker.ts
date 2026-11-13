import { processDueOutboxRetries } from './server/modules/metaWebhook.ts';
import { runWithRuntimeContext, type WorkerExecContext } from './server/runtimeContext.ts';
import { webApp } from './server/webApp.ts';

interface StaticAssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  ASSETS?: StaticAssetsBinding;
  [key: string]: unknown;
}

interface WorkerScheduledController {
  cron: string;
  scheduledTime: number;
}

function toStringEnvMap(env: WorkerEnv): Record<string, string | undefined> {
  const map: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') {
      map[k] = v;
    }
  }
  return map;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: WorkerExecContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return runWithRuntimeContext(
        {
          env: toStringEnvMap(env),
          execCtx: ctx,
          isWorker: true,
        },
        () => webApp.fetch(request)
      );
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(
    _controller: WorkerScheduledController,
    env: WorkerEnv,
    ctx: WorkerExecContext
  ): Promise<void> {
    // Evitar despertar o consultar Neon cuando los envíos salientes están pausados
    if (env.META_OUTBOUND_ENABLED !== 'true') {
      return;
    }

    const task = runWithRuntimeContext(
      {
        env: toStringEnvMap(env),
        execCtx: ctx,
        isWorker: true,
      },
      () => processDueOutboxRetries(10)
    );
    ctx.waitUntil(
      Promise.resolve(task).catch((err) => {
        console.error('Scheduled outbox retry failed:', err);
      })
    );
  },
};
