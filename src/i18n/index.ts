import { translationResources } from './catalog';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

export const supportedLanguages = ['zh', 'en'] as const;
export type AppLanguage = (typeof supportedLanguages)[number];

export const LANGUAGE_STORAGE_KEY = 'cliora:language';

export function readStoredLanguage(): AppLanguage | null {
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

type LanguagePersist = (language: AppLanguage) => void;
let languagePersist: LanguagePersist | null = null;

export function bindLanguagePersist(listener: LanguagePersist): void {
  languagePersist = listener;
}

export function applyStoredLanguage(language: AppLanguage): void {
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* Session-only fallback keeps the switch usable. */ }
  if (i18n.language !== language) void i18n.changeLanguage(language);
}

export function setLanguage(language: AppLanguage): void {
  applyStoredLanguage(language);
  languagePersist?.(language);
}

void i18n.use(initReactI18next).init({
  lng: detectLanguage(),
  fallbackLng: 'zh',
  resources: translationResources,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

export default i18n;
