import { AsyncLocalStorage } from 'node:async_hooks';

export type RuntimeEnvMap = Record<string, string | undefined>;

export interface WorkerExecContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface RuntimeContextValue {
  env: RuntimeEnvMap;
  execCtx?: WorkerExecContext;
  isWorker: boolean;
}

const runtimeAls = new AsyncLocalStorage<RuntimeContextValue>();

export function runWithRuntimeContext<T>(
  ctx: RuntimeContextValue,
  fn: () => Promise<T> | T
): Promise<T> | T {
  return runtimeAls.run(ctx, fn);
}

export function isWorkerRuntime(): boolean {
  const store = runtimeAls.getStore();
  if (store) return store.isWorker;
  return typeof process === 'undefined' || !process.versions?.node;
}

export function getEnv(key: string): string | undefined {
  const store = runtimeAls.getStore();
  if (store && key in store.env) {
    return store.env[key];
  }
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key];
  }
  return undefined;
}

export function scheduleBackgroundTask(promise: Promise<unknown>): void {
  const store = runtimeAls.getStore();
  if (store?.execCtx) {
    store.execCtx.waitUntil(
      promise.catch((err) => {
        console.error('Background task error:', err);
      })
    );
    return;
  }
  promise.catch((err) => {
    console.error('Background task error:', err);
  });
}
