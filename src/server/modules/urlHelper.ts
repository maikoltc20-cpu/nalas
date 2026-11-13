import { getEnv } from '../runtimeContext.ts';

function makeConfigError(message: string, code: string): Error {
  const err = new Error(message) as Error & { statusCode?: number; code?: string };
  err.statusCode = 503;
  err.code = code;
  return err;
}

/**
 * Valida DATABASE_URL antes de pasarlo a @neondatabase/serverless para evitar
 * errores crudos como "Invalid URL string" y jamás exponer el secreto en mensajes.
 */
export function validateDatabaseUrl(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) {
    throw makeConfigError(
      'DATABASE_URL no configurado en los Secrets del servidor.',
      'MISSING_DATABASE_URL'
    );
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    trimmed.toLowerCase().startsWith('psql ')
  ) {
    throw makeConfigError(
      'El secreto DATABASE_URL contiene comillas o el prefijo "psql". Guardá únicamente la URL que comienza con postgresql://.',
      'INVALID_DATABASE_URL'
    );
  }

  if (/[\s\r\n]/.test(trimmed)) {
    throw makeConfigError(
      'El secreto DATABASE_URL contiene espacios o saltos de línea. Pegá la cadena en una sola línea sin espacios.',
      'INVALID_DATABASE_URL'
    );
  }

  if (!/^postgres(ql)?:\/\//i.test(trimmed)) {
    throw makeConfigError(
      'El secreto DATABASE_URL debe comenzar con postgresql:// o postgres://.',
      'INVALID_DATABASE_URL'
    );
  }

  const httpEquivalent = trimmed.replace(/^postgres(ql)?:\/\//i, 'http://');
  let parsed: URL;
  try {
    new URL(trimmed);
    parsed = new URL(httpEquivalent);
  } catch {
    throw makeConfigError(
      'El secreto DATABASE_URL no tiene un formato de URL válido (Invalid URL). Verificá que usuario, contraseña (codificada si tiene caracteres especiales como @, # o /), host -pooler y base de datos sean correctos.',
      'INVALID_DATABASE_URL'
    );
  }

  if (!parsed.hostname || parsed.hostname === '-' || !parsed.pathname || parsed.pathname === '/') {
    throw makeConfigError(
      'El secreto DATABASE_URL está incompleto: falta el host -pooler o el nombre de la base de datos.',
      'INVALID_DATABASE_URL'
    );
  }

  return trimmed;
}

export function translatePgConnectionError(err: unknown): Error {
  if (err instanceof Error && 'statusCode' in err && 'code' in err) {
    return err;
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (
    /invalid url/i.test(msg) ||
    /wrong url scheme/i.test(msg) ||
    /missing user, host or database/i.test(msg)
  ) {
    return makeConfigError(
      'No se pudo inicializar la conexión a PostgreSQL: el secreto DATABASE_URL tiene formato inválido (Invalid URL). Verificá que empiece con postgresql:// sin comillas, sin "psql" y con la contraseña correctamente codificada.',
      'INVALID_DATABASE_URL'
    );
  }
  return err instanceof Error ? err : new Error(msg || 'Error de conexión con PostgreSQL.');
}

/**
 * Resuelve el origen público HTTPS/HTTP del servidor sin lanzar "Invalid URL string"
 * cuando APP_URL falta, está vacío o tiene formato inválido.
 */
export function resolveSafeAppBaseUrl(requestOrOrigin?: Request | string): string {
  const configuredAppUrl = getEnv('APP_URL')?.trim();
  if (configuredAppUrl && configuredAppUrl !== 'MY_APP_URL') {
    if (
      (configuredAppUrl.startsWith('"') && configuredAppUrl.endsWith('"')) ||
      (configuredAppUrl.startsWith("'") && configuredAppUrl.endsWith("'")) ||
      /[\s\r\n]/.test(configuredAppUrl)
    ) {
      throw makeConfigError(
        'La variable APP_URL tiene comillas o espacios inválidos. Debe ser una URL limpia (ej. https://nalas-piloto.michael-997.workers.dev).',
        'INVALID_APP_URL'
      );
    }
    try {
      const parsed = new URL(configuredAppUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('Bad protocol');
      }
      return parsed.origin;
    } catch {
      throw makeConfigError(
        'La variable APP_URL no es una URL válida. Usá el formato completo https://<tu-dominio> (ej. https://nalas-piloto.michael-997.workers.dev).',
        'INVALID_APP_URL'
      );
    }
  }

  if (typeof requestOrOrigin === 'string') {
    const clean = requestOrOrigin.trim();
    if (clean) {
      try {
        return new URL(clean).origin;
      } catch {
        // Fallback below
      }
    }
  } else if (requestOrOrigin) {
    const forwardedProto = requestOrOrigin.headers
      .get('x-forwarded-proto')
      ?.split(',')[0]
      ?.trim();
    const forwardedHost = requestOrOrigin.headers
      .get('x-forwarded-host')
      ?.split(',')[0]
      ?.trim();
    const hostHeader = requestOrOrigin.headers.get('host')?.trim();

    if (forwardedHost || hostHeader) {
      const host = forwardedHost || hostHeader!;
      let proto = forwardedProto || 'https';
      try {
        proto = forwardedProto || new URL(requestOrOrigin.url).protocol.replace(':', '');
      } catch {
        // default https
      }
      try {
        return new URL(`${proto}://${host}`).origin;
      } catch {
        // Fallback below
      }
    }

    try {
      return new URL(requestOrOrigin.url).origin;
    } catch {
      // Fallback below
    }
  }

  return 'http://localhost:3000';
}
