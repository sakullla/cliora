// Pure resource catalog shared by the runtime and contract tests. No browser initialization.
import zhPrompts from './locales/zh/prompts.ts';
import enPrompts from './locales/en/prompts.ts';
import zhWorkspaces from './locales/zh/workspaces.ts';
import enWorkspaces from './locales/en/workspaces.ts';
import zhCommon from './locales/zh/common.ts';
import zhHome from './locales/zh/home.ts';
import zhTools from './locales/zh/tools.ts';
import zhLibrary from './locales/zh/library.ts';
import zhRecords from './locales/zh/records.ts';
import zhSettings from './locales/zh/settings.ts';
import zhSessions from './locales/zh/sessions.ts';
import enCommon from './locales/en/common.ts';
import enHome from './locales/en/home.ts';
import enTools from './locales/en/tools.ts';
import enLibrary from './locales/en/library.ts';
import enRecords from './locales/en/records.ts';
import enSettings from './locales/en/settings.ts';
import enSessions from './locales/en/sessions.ts';

export const translationResources = {
    zh: { translation: { common: zhCommon, home: zhHome, tools: zhTools, library: zhLibrary, records: zhRecords, settings: zhSettings, sessions: zhSessions, workspaces: zhWorkspaces, prompts: zhPrompts } },
    en: { translation: { common: enCommon, home: enHome, tools: enTools, library: enLibrary, records: enRecords, settings: enSettings, sessions: enSessions, workspaces: enWorkspaces, prompts: enPrompts } },
  };
