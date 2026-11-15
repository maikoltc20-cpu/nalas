export const ALLOWED_META_SDK_ORIGINS = new Set([
  'https://www.facebook.com',
  'https://web.facebook.com',
  'https://business.facebook.com',
]);

export interface MetaSdkSessionEvent {
  event: string;
  wabaId?: string;
  phoneNumberId?: string;
  businessPortfolioId?: string;
  errorMessage?: string;
  errorId?: string;
  sessionId?: string;
  currentStep?: string;
  origin: string;
}

export interface MetaEmbeddedSignupLaunchResult {
  code?: string;
  loginStatus?: string;
  sessionEvent: MetaSdkSessionEvent | null;
}

interface FacebookLoginResponse {
  status?: string;
  authResponse?: {
    code?: string;
    accessToken?: string;
  } | null;
}

interface FacebookSdkInstance {
  init(params: {
    appId: string;
    cookie?: boolean;
    xfbml?: boolean;
    version: string;
  }): void;
  login(
    callback: (response: FacebookLoginResponse) => void,
    options: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: true;
      extras: {
        setup: Record<string, unknown>;
        version: 'v4';
        featureType: 'whatsapp_business_app_onboarding';
        sessionInfoVersion: '3';
      };
    }
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdkInstance;
    fbAsyncInit?: () => void;
  }
}

let sdkLoadPromise: Promise<FacebookSdkInstance> | null = null;
let initializedAppKey: string | null = null;

export function parseMetaEmbeddedSignupMessage(
  origin: string,
  rawData: unknown
): MetaSdkSessionEvent | null {
  if (!ALLOWED_META_SDK_ORIGINS.has(origin)) {
    return null;
  }

  let parsed: unknown = rawData;
  if (typeof rawData === 'string') {
    const trimmed = rawData.trim();
    if (!trimmed.startsWith('{')) {
      return null;
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.type !== 'WA_EMBEDDED_SIGNUP') {
    return null;
  }

  const eventName = typeof record.event === 'string' ? record.event.trim() : '';
  const data =
    record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : {};

  const messagingAccountIds = Array.isArray(data.messaging_account_ids)
    ? data.messaging_account_ids.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];

  return {
    event: eventName || 'UNKNOWN',
    wabaId:
      (typeof data.waba_id === 'string' && data.waba_id.trim()) ||
      messagingAccountIds[0] ||
      undefined,
    phoneNumberId:
      typeof data.phone_number_id === 'string' && data.phone_number_id.trim()
        ? data.phone_number_id.trim()
        : undefined,
    businessPortfolioId:
      typeof data.business_id === 'string' && data.business_id.trim()
        ? data.business_id.trim()
        : undefined,
    errorMessage:
      typeof data.error_message === 'string' && data.error_message.trim()
        ? data.error_message.trim()
        : undefined,
    errorId:
      typeof data.error_id === 'string' && data.error_id.trim()
        ? data.error_id.trim()
        : undefined,
    sessionId:
      typeof data.session_id === 'string' && data.session_id.trim()
        ? data.session_id.trim()
        : undefined,
    currentStep:
      typeof data.current_step === 'string' && data.current_step.trim()
        ? data.current_step.trim()
        : undefined,
    origin,
  };
}

export async function loadFacebookSdk(
  appId: string,
  graphVersion: string
): Promise<FacebookSdkInstance> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('El SDK de Meta solo puede ejecutarse en el navegador.');
  }

  const initKey = `${appId}:${graphVersion}`;
  if (window.FB) {
    if (initializedAppKey !== initKey) {
      window.FB.init({
        appId,
        cookie: true,
        xfbml: true,
        version: graphVersion,
      });
      initializedAppKey = initKey;
    }
    return window.FB;
  }

  if (!sdkLoadPromise) {
    sdkLoadPromise = new Promise<FacebookSdkInstance>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          sdkLoadPromise = null;
          reject(
            new Error(
              'Tiempo de espera agotado al cargar el SDK JavaScript de Meta (connect.facebook.net/en_US/sdk.js). Verificá que no esté bloqueado por el navegador o extensión.'
            )
          );
        }
      }, 15000);

      const finishWithFb = () => {
        if (settled) return;
        if (!window.FB) {
          settled = true;
          window.clearTimeout(timeout);
          sdkLoadPromise = null;
          reject(new Error('El SDK de Meta cargó sin inicializar window.FB.'));
          return;
        }
        try {
          window.FB.init({
            appId,
            cookie: true,
            xfbml: true,
            version: graphVersion,
          });
          initializedAppKey = initKey;
          settled = true;
          window.clearTimeout(timeout);
          resolve(window.FB);
        } catch (err) {
          settled = true;
          window.clearTimeout(timeout);
          sdkLoadPromise = null;
          reject(
            err instanceof Error
              ? err
              : new Error('No se pudo inicializar Facebook JavaScript SDK.')
          );
        }
      };

      const prevAsyncInit = window.fbAsyncInit;
      window.fbAsyncInit = () => {
        if (typeof prevAsyncInit === 'function') {
          prevAsyncInit();
        }
        finishWithFb();
      };

      const existingScript = document.getElementById('facebook-jssdk') as HTMLScriptElement | null;
      if (existingScript) {
        if (window.FB) {
          finishWithFb();
        }
        existingScript.addEventListener('error', () => {
          if (!settled) {
            settled = true;
            window.clearTimeout(timeout);
            sdkLoadPromise = null;
            reject(
              new Error(
                'No se pudo descargar https://connect.facebook.net/en_US/sdk.js desde Meta.'
              )
            );
          }
        });
        return;
      }

      const script = document.createElement('script');
      script.id = 'facebook-jssdk';
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      script.src = 'https://connect.facebook.net/en_US/sdk.js';
      script.onerror = () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          sdkLoadPromise = null;
          reject(
            new Error(
              'No se pudo descargar https://connect.facebook.net/en_US/sdk.js desde Meta.'
            )
          );
        }
      };
      document.head.appendChild(script);
    });
  }

  return sdkLoadPromise;
}

export async function launchMetaEmbeddedSignup(params: {
  appId: string;
  configId: string;
  graphVersion: string;
}): Promise<MetaEmbeddedSignupLaunchResult> {
  const fb = await loadFacebookSdk(params.appId, params.graphVersion);

  return new Promise<MetaEmbeddedSignupLaunchResult>((resolve) => {
    let latestSessionEvent: MetaSdkSessionEvent | null = null;
    let loginCallbackDone = false;
    let authCode: string | undefined;
    let loginStatus: string | undefined;
    let resolved = false;
    let settleTimer: number | undefined;

    const cleanupAndResolve = () => {
      if (resolved) return;
      resolved = true;
      if (settleTimer !== undefined) {
        window.clearTimeout(settleTimer);
      }
      window.removeEventListener('message', onWindowMessage);
      resolve({
        code: authCode,
        loginStatus,
        sessionEvent: latestSessionEvent,
      });
    };

    const trySettle = () => {
      if (!loginCallbackDone) return;
      if (latestSessionEvent) {
        cleanupAndResolve();
        return;
      }
      if (settleTimer === undefined) {
        settleTimer = window.setTimeout(
          cleanupAndResolve,
          authCode ? 2500 : 400
        );
      }
    };

    const onWindowMessage = (event: MessageEvent) => {
      const parsed = parseMetaEmbeddedSignupMessage(event.origin, event.data);
      if (!parsed) return;
      latestSessionEvent = parsed;
      if (loginCallbackDone) {
        cleanupAndResolve();
      }
    };

    window.addEventListener('message', onWindowMessage);

    fb.login(
      (response) => {
        loginCallbackDone = true;
        loginStatus = response?.status;
        authCode = response?.authResponse?.code?.trim() || undefined;
        trySettle();
      },
      {
        config_id: params.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {},
          version: 'v4',
          featureType: 'whatsapp_business_app_onboarding',
          sessionInfoVersion: '3',
        },
      }
    );
  });
}
