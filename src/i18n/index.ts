import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCommon from './locales/zh/common';
import zhSettings from './locales/zh/settings';
import enCommon from './locales/en/common';
import enSettings from './locales/en/settings';

export const supportedLanguages = ['zh', 'en'] as const;
export type AppLanguage = (typeof supportedLanguages)[number];

export const LANGUAGE_STORAGE_KEY = 'cliora:language';

function readStoredLanguage(): AppLanguage | null {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return stored === 'zh' || stored === 'en' ? stored : null;
  } catch {
    return null;
  }
}

export function detectLanguage(): AppLanguage {
  const stored = readStoredLanguage();
  if (stored) return stored;
  const system = typeof navigator === 'undefined' ? '' : navigator.language ?? '';
  return system.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function setLanguage(language: AppLanguage): void {
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* Session-only fallback keeps the switch usable. */ }
  void i18n.changeLanguage(language);
}

void i18n.use(initReactI18next).init({
  lng: detectLanguage(),
  fallbackLng: 'zh',
  resources: {
    zh: { translation: { common: zhCommon, settings: zhSettings } },
    en: { translation: { common: enCommon, settings: enSettings } },
  },
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

export default i18n;
