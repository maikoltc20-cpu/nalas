import type { HumanHandoffConfig } from './types';

export const DEFAULT_HUMAN_HANDOFF_CONFIG: HumanHandoffConfig = {
  buttonLabel: 'Pedir atención humana',
  requestConfirmationMessage:
    'Hemos enviado una solicitud de atención prioritaria para que seas contactado.',
  askNamePrompt: '¿Cómo te llamás?',
  askPhonePrompt:
    '¿Podés compartirnos tu número telefónico, incluyendo el código de país?',
  finalConfirmationMessage:
    '¡Gracias! Nuestro equipo te contactará al número que nos compartiste.',
};

export function resolveHumanHandoffConfig(
  cfg?: Partial<HumanHandoffConfig> | null
): HumanHandoffConfig {
  const clean = (val: unknown, fallback: string): string => {
    if (typeof val !== 'string') return fallback;
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  };

  return {
    buttonLabel: clean(cfg?.buttonLabel, DEFAULT_HUMAN_HANDOFF_CONFIG.buttonLabel),
    requestConfirmationMessage: clean(
      cfg?.requestConfirmationMessage,
      DEFAULT_HUMAN_HANDOFF_CONFIG.requestConfirmationMessage
    ),
    askNamePrompt: clean(cfg?.askNamePrompt, DEFAULT_HUMAN_HANDOFF_CONFIG.askNamePrompt),
    askPhonePrompt: clean(cfg?.askPhonePrompt, DEFAULT_HUMAN_HANDOFF_CONFIG.askPhonePrompt),
    finalConfirmationMessage: clean(
      cfg?.finalConfirmationMessage,
      DEFAULT_HUMAN_HANDOFF_CONFIG.finalConfirmationMessage
    ),
  };
}

export function normalizeInternationalPhone(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Ignore plain email addresses without phone digits
  if (trimmed.includes('@') && !/\+?\d[\d\s\-()]{7,18}\d/.test(trimmed)) {
    return null;
  }
  const candidateMatch = trimmed.match(/(\+?\d[\d\s\-()]{7,18}\d)/);
  if (!candidateMatch) return null;
  let stripped = candidateMatch[1].replace(/[\s\-()]/g, '');
  if (stripped.startsWith('00')) {
    stripped = `+${stripped.slice(2)}`;
  }
  const digitsOnly = stripped.startsWith('+') ? stripped.slice(1) : stripped;
  if (!/^[1-9]\d{8,14}$/.test(digitsOnly)) {
    return null;
  }
  return `+${digitsOnly}`;
}

export function isValidEmailAddress(raw?: string | null): boolean {
  if (!raw || typeof raw !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

export function hasValidContactName(name?: string | null): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;
  const lower = trimmed.toLowerCase();
  if (
    lower === 'nombre pendiente' ||
    lower === 'visitante' ||
    lower === 'visitante sin nombre' ||
    lower === 'cliente sin nombre'
  ) {
    return false;
  }
  if (normalizeInternationalPhone(trimmed)) return false;
  if (/^\+?\d[\d\s\-()]{5,}$/.test(trimmed)) return false;
  return /\p{L}/u.test(trimmed);
}
