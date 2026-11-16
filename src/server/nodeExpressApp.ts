import express from 'express';
import { runWithRuntimeContext } from './runtimeContext.ts';
import { webApp } from './webApp.ts';

function firstHeaderValue(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const first = raw.split(',')[0]?.trim();
  return first || undefined;
}

export function buildWebRequestUrlFromExpress(req: express.Request): string {
  const rawProto = firstHeaderValue(req.header('x-forwarded-proto')) || req.protocol || 'http';
  const proto = rawProto === 'https' || rawProto === 'http' ? rawProto : 'http';
  const rawHost =
    firstHeaderValue(req.header('x-forwarded-host')) ||
    req.header('host')?.trim() ||
    'localhost:3000';
  const host = /^[\w.\-:[\]]+$/.test(rawHost) ? rawHost : 'localhost:3000';
  const pathWithQuery = req.originalUrl.startsWith('/') ? req.originalUrl : `/${req.originalUrl}`;
  return `${proto}://${host}${pathWithQuery}`;
}

export type ApiRequestHandler = (req: Request) => Promise<Response>;

export function mountApiMiddleware(
  app: express.Express,
  options?: {
    handler?: ApiRequestHandler;
    env?: Record<string, string | undefined>;
  }
): void {
  const handler = options?.handler ?? ((webRequest: Request) => webApp.fetch(webRequest));
  const env = options?.env ?? process.env;

  // Delegate all /api and /api/* requests to the Web Standard router
  app.use('/api', async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        await new Promise<void>((resolve, reject) => {
          req.on('data', (chunk: Buffer) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          );
          req.on('end', () => resolve());
          req.on('error', (err) => reject(err));
        });
      }
      const rawBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const fullUrl = buildWebRequestUrlFromExpress(req);

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
        body: rawBody
          ? new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength)
          : undefined,
      });

      const webResponse = await runWithRuntimeContext(
        { env, isWorker: false },
        () => handler(webRequest)
      );

      res.status(webResponse.status);
      const setCookies =
        typeof webResponse.headers.getSetCookie === 'function'
          ? webResponse.headers.getSetCookie()
          : [];
      webResponse.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') return;
        res.setHeader(key, value);
      });
      if (setCookies.length > 0) {
        res.setHeader('Set-Cookie', setCookies);
      } else {
        const singleCookie = webResponse.headers.get('set-cookie');
        if (singleCookie) {
          res.setHeader('Set-Cookie', singleCookie);
        }
      }
      const respBuf = Buffer.from(await webResponse.arrayBuffer());
      res.send(respBuf);
    } catch (err) {
      console.error('[api-bridge] Unhandled error in Express /api bridge:', err);
      if (!res.headersSent) {
        const status =
          typeof (err as { statusCode?: number })?.statusCode === 'number'
            ? (err as { statusCode: number }).statusCode
            : 500;
        const message =
          err instanceof Error ? err.message : 'Error interno procesando la petición API.';
        res.status(status).json({ error: message });
      }
    }
  });

  // Safety net: /api and /api/* must never fall through to Vite/SPA HTML or Express HTML error pages
  app.use('/api', (_req, res) => {
    if (!res.headersSent) {
      res.status(404).json({ error: 'Ruta API no encontrada.' });
    }
  });

  app.use(
    '/api',
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (res.headersSent) return;
      const rawStatus =
        (err as { statusCode?: number; status?: number })?.statusCode ??
        (err as { status?: number })?.status;
      const status =
        typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
      const message =
        err instanceof Error ? err.message : 'Error interno procesando la petición API.';
      res.status(status).json({ error: message });
    }
  );
}
