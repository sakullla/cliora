import type { AcpAttachment, AcpAvailableCommand, AcpConfigOption, AcpElicitationField, AcpElicitationSchema, AcpSessionConfig } from '../../../types/acp';

/** The host's own image limits (ADR-7); checked here first so the person learns
 *  why before anything is sent, and checked again by the host. */
export const ACP_IMAGE_LIMIT = 8;
export const ACP_IMAGE_BYTES = 5 * 1024 * 1024;
export const ACP_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;

/** One attachment waiting in the composer's tray. Image bytes stay here until the
 *  prompt is sent; the snapshot only ever holds labels. */
export type ComposerAttachment =
  /** `source`: the dropped file's path, so the same drop is not read twice. */
  | { id: string; type: 'image'; name: string; mimeType: string; dataBase64: string; size: number; source?: string }
  | { id: string; type: 'file'; name: string; path: string };

export function attachmentPayload(items: ComposerAttachment[]): AcpAttachment[] {
  return items.map((item) => item.type === 'image'
    ? { type: 'image', mimeType: item.mimeType, dataBase64: item.dataBase64 }
    : { type: 'file', path: item.path });
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.test(path);
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The `/command` being typed: only at the very start of the draft, before the
 *  first blank, with the caret inside it. */
export function slashQuery(draft: string, caret: number): string | null {
  if (!draft.startsWith('/') || caret < 1) return null;
  const head = draft.slice(0, caret);
  if (/\s/.test(head)) return null;
  return head.slice(1);
}

/** Declared commands that match what was typed after `/`: name prefixes first,
 *  then names and descriptions that contain it. */
export function matchCommands(commands: AcpAvailableCommand[], query: string): AcpAvailableCommand[] {
  const needle = query.toLowerCase();
  if (!needle) return commands.slice(0, 50);
  const prefix: AcpAvailableCommand[] = [];
  const inside: AcpAvailableCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) prefix.push(command);
    else if (name.includes(needle) || command.description.toLowerCase().includes(needle)) inside.push(command);
  }
  return [...prefix, ...inside].slice(0, 50);
}

/** The `@reference` the caret sits in: an `@` at the start or after a blank, then
 *  no blank up to the caret. `start` is the index of the `@`. */
export function mentionQuery(draft: string, caret: number): { start: number; query: string } | null {
  const head = draft.slice(0, caret);
  const at = head.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(head[at - 1])) return null;
  const query = head.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** Replace the `@query` at `start` (up to the caret) with `@path `. */
export function insertMention(draft: string, start: number, caret: number, path: string): { text: string; caret: number } {
  const quoted = /\s/.test(path) ? `"${path}"` : path;
  const before = draft.slice(0, start);
  const after = draft.slice(caret).replace(/^\S*/, '');
  const inserted = `@${quoted} `;
  return { text: before + inserted + after.replace(/^ /, ''), caret: before.length + inserted.length };
}

/** Earlier prompts for the up and down keys, oldest first, without repeats in a row. */
export function promptHistory(timelineUserTexts: string[], sent: string[]): string[] {
  const entries: string[] = [];
  for (const text of [...timelineUserTexts, ...sent.filter((item) => !timelineUserTexts.includes(item))]) {
    const value = text.trim();
    if (value && entries[entries.length - 1] !== value) entries.push(value);
  }
  return entries.slice(-100);
}

/** One setting a selector shows: the mode, a legacy model list, or a declared option. */
export type AcpSetting = {
  key: string;
  /** What acp_set_mode or acp_set_config addresses. */
  target: { kind: 'mode' } | { kind: 'config'; configId: string };
  name: string;
  description: string | null;
  category: string | null;
  type: 'select' | 'boolean';
  value: string | boolean;
  options: Array<{ value: string; name: string; description: string | null; group: string | null }>;
};

const CATEGORY_ORDER = ['mode', 'model', 'thought_level'];

function categoryRank(category: string | null): number {
  const index = category ? CATEGORY_ORDER.indexOf(category) : -1;
  return index < 0 ? CATEGORY_ORDER.length : index;
}

/**
 * The selectors the agent declared, in a stable order: the mode, then models (the
 * legacy list and options of the model category side by side), then thought level,
 * then everything else. A setting the agent did not declare has no selector.
 */
export function acpSettings(config: AcpSessionConfig | null | undefined, legacyModelId: string, labels: { mode: string; model: string }): AcpSetting[] {
  if (!config) return [];
  const settings: AcpSetting[] = [];
  const modes = config.modes;
  if (modes && modes.availableModes.length > 0) {
    settings.push({
      key: 'mode', target: { kind: 'mode' }, name: labels.mode, description: null, category: 'mode', type: 'select', value: modes.currentModeId,
      options: modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name || mode.id, description: mode.description, group: null })),
    });
  }
  const models = config.models;
  if (models && models.availableModels.length > 0) {
    settings.push({
      key: `config:${legacyModelId}`, target: { kind: 'config', configId: legacyModelId }, name: labels.model, description: null, category: 'model', type: 'select', value: models.currentModelId,
      options: models.availableModels.map((model) => ({ value: model.modelId, name: model.name || model.modelId, description: model.description, group: null })),
    });
  }
  const options = (config.options ?? []).filter((option: AcpConfigOption) => option.type === 'boolean' || option.options.length > 0);
  for (const option of options) {
    settings.push({
      key: `config:${option.id}`, target: { kind: 'config', configId: option.id }, name: option.name || option.id, description: option.description, category: option.category,
      type: option.type, value: option.currentValue, options: option.options,
    });
  }
  return settings
    .map((setting, index) => ({ setting, index }))
    .sort((a, b) => categoryRank(a.setting.category) - categoryRank(b.setting.category) || a.index - b.index)
    .map((entry) => entry.setting);
}

/** The value shown for a select: the declared choice's name, else the raw value. */
export function settingLabel(setting: AcpSetting, value: string | boolean): string {
  if (setting.type === 'boolean') return String(value);
  return setting.options.find((option) => option.value === value)?.name ?? String(value);
}

/* ---------- Elicitation forms ---------- */

export type FormValue = string | boolean | string[];
export type FormErrors = Record<string, { key: string; values?: Record<string, unknown> }>;

export function fieldChoices(field: AcpElicitationField | NonNullable<AcpElicitationField['items']>): Array<{ value: string; title: string }> {
  if (Array.isArray(field.oneOf) && field.oneOf.length) return field.oneOf.map((choice) => ({ value: String(choice.const), title: choice.title || String(choice.const) }));
  if (Array.isArray(field.anyOf) && field.anyOf.length) return field.anyOf.map((choice) => ({ value: String(choice.const), title: choice.title || String(choice.const) }));
  if (Array.isArray(field.enum)) return field.enum.map((value) => ({ value: String(value), title: String(value) }));
  return [];
}

/** The starting values: each field's declared default, else empty. */
export function initialFormValues(schema: AcpElicitationSchema): Record<string, FormValue> {
  const values: Record<string, FormValue> = {};
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const fallback = field.default;
    if (field.type === 'boolean') values[name] = typeof fallback === 'boolean' ? fallback : false;
    else if (field.type === 'array') values[name] = Array.isArray(fallback) ? fallback.map(String) : [];
    else values[name] = fallback == null ? '' : String(fallback);
  }
  return values;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validFormat(format: string | undefined, value: string): string | null {
  switch (format) {
    case 'email': return EMAIL.test(value) ? null : 'sessions.acpFormErrorEmail';
    case 'uri': {
      try { new URL(value); return null; } catch { return 'sessions.acpFormErrorUri'; }
    }
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? null : 'sessions.acpFormErrorDate';
    case 'date-time': return !Number.isNaN(Date.parse(value)) ? null : 'sessions.acpFormErrorDate';
    default: return null;
  }
}

/**
 * Check the values against the restricted schema. Returns the errors by field and,
 * when there are none, the content to accept with: empty optional fields are left
 * out, numbers are numbers.
 */
export function validateForm(schema: AcpElicitationSchema, values: Record<string, FormValue>): { errors: FormErrors; content: Record<string, unknown> | null } {
  const errors: FormErrors = {};
  const content: Record<string, unknown> = {};
  const required = new Set(schema.required ?? []);
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const value = values[name];
    if (field.type === 'boolean') {
      content[name] = value === true;
      continue;
    }
    if (field.type === 'array') {
      const list = Array.isArray(value) ? value : [];
      if (!list.length) {
        if (required.has(name)) errors[name] = { key: 'sessions.acpFormErrorRequired' };
        else if (field.minItems) errors[name] = { key: 'sessions.acpFormErrorMinItems', values: { count: field.minItems } };
        continue;
      }
      if (field.minItems != null && list.length < field.minItems) { errors[name] = { key: 'sessions.acpFormErrorMinItems', values: { count: field.minItems } }; continue; }
      if (field.maxItems != null && list.length > field.maxItems) { errors[name] = { key: 'sessions.acpFormErrorMaxItems', values: { count: field.maxItems } }; continue; }
      content[name] = list;
      continue;
    }
    const text = typeof value === 'string' ? value : '';
    if (!text.trim()) {
      if (required.has(name)) errors[name] = { key: 'sessions.acpFormErrorRequired' };
      continue;
    }
    if (field.type === 'number' || field.type === 'integer') {
      const number = Number(text.trim());
      if (!Number.isFinite(number)) { errors[name] = { key: 'sessions.acpFormErrorNumber' }; continue; }
      if (field.type === 'integer' && !Number.isInteger(number)) { errors[name] = { key: 'sessions.acpFormErrorInteger' }; continue; }
      if (field.minimum != null && number < field.minimum) { errors[name] = { key: 'sessions.acpFormErrorMinimum', values: { value: field.minimum } }; continue; }
      if (field.maximum != null && number > field.maximum) { errors[name] = { key: 'sessions.acpFormErrorMaximum', values: { value: field.maximum } }; continue; }
      content[name] = number;
      continue;
    }
    const choices = fieldChoices(field);
    if (choices.length && !choices.some((choice) => choice.value === text)) { errors[name] = { key: 'sessions.acpFormErrorRequired' }; continue; }
    if (field.minLength != null && [...text].length < field.minLength) { errors[name] = { key: 'sessions.acpFormErrorMinLength', values: { count: field.minLength } }; continue; }
    if (field.maxLength != null && [...text].length > field.maxLength) { errors[name] = { key: 'sessions.acpFormErrorMaxLength', values: { count: field.maxLength } }; continue; }
    const format = validFormat(field.format, text.trim());
    if (format) { errors[name] = { key: format }; continue; }
    content[name] = text;
  }
  return { errors, content: Object.keys(errors).length ? null : content };
}

/** Read a picked or pasted file as base64 without the data-URL prefix. */
export function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? '');
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}
