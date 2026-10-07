import icon from '../../assets/tools/claude.svg';
import type { ToolUiAdapter, ModelMappingControl, ModelRoleValue } from '../contract';
import { ClaudeConfigurationEditor } from './ConfigurationEditor';
import i18n from '../../i18n';

const roles = [
  { id:'default', get label() { return i18n.t('tools.adapters.claude.roleDefault'); }, displayName:false, longContext:true, key:'ANTHROPIC_MODEL' },
  ...['SONNET','OPUS','FABLE','HAIKU'].map(role => ({id:role.toLowerCase(),label:role[0]+role.slice(1).toLowerCase(),displayName:true,longContext:role !== 'HAIKU',key:`ANTHROPIC_DEFAULT_${role}_MODEL`})),
  {id:'subagent',label:'Subagent',displayName:false,longContext:true,key:'CLAUDE_CODE_SUBAGENT_MODEL'},
];
function document(text: string): Record<string, unknown> {
  const parsed = text.trim() ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(i18n.t('tools.adapters.claude.errorJson'));
  if (parsed.env != null && (typeof parsed.env !== 'object' || Array.isArray(parsed.env))) throw new Error(i18n.t('tools.adapters.claude.errorEnv'));
  return parsed;
}
const modelMapping: ModelMappingControl = {
  roles, fileRole:'settings', primaryRole:'default',
  decodeModel: model => ({model:model.replace(/(?:\[1m\])+$/ig,''),name:'',longContext:/\[1m\]$/i.test(model)}),
  encodeModel: value => value.model.replace(/(?:\[1m\])+$/ig,'') + (value.longContext ? '[1m]' : ''),
  read(text) {
    try {
      const parsed = document(text); const env = (parsed.env ?? {}) as Record<string, unknown>;
      return Object.fromEntries(roles.map(role => { const raw = typeof env[role.key] === 'string' ? String(env[role.key]) : role.id === 'default' && typeof parsed.model === 'string' ? parsed.model : '';
        return [role.id,{model:raw.replace(/\[1m\]$/i,''),name:typeof env[role.key+'_NAME'] === 'string' ? String(env[role.key+'_NAME']) : '',longContext:/\[1m\]$/i.test(raw)}]; }));
    } catch { return {}; }
  },
  async update(text, id, value) {
    const role = roles.find(item => item.id === id); if (!role) throw new Error(i18n.t('tools.adapters.claude.errorUnknownRole'));
    const parsed = document(text); const env = { ...(parsed.env ?? {}) as Record<string, unknown> };
    const model = value.model.trim().replace(/(?:\[1m\])+$/ig,'');
    if (model) env[role.key] = model + (value.longContext ? '[1m]' : ''); else delete env[role.key];
    if (role.id === 'default') { if (model) parsed.model = env[role.key]; else delete parsed.model; }
    if (role.displayName) { if (value.name.trim()) env[role.key+'_NAME'] = value.name.trim(); else delete env[role.key+'_NAME']; }
    return JSON.stringify({ ...parsed,env },null,2);
  },
  async useModelForAll(text, model, longContext = false) {
    const values = this.read(text); let next = text;
    for (const role of roles) next = await this.update(next, role.id, { model, name: values[role.id]?.name ?? '', longContext: role.longContext && longContext } satisfies ModelRoleValue);
    return next;
  },
};

export const claudeUiAdapter: ToolUiAdapter = {
  icon: { light: icon, source: 'https://code.claude.com/docs/logo/light.svg' },
  id: 'claude_code',
  accounts: {
    get description() { return i18n.t('tools.adapters.claude.accounts.description'); },
    get nativeDescription() { return i18n.t('tools.adapters.claude.accounts.nativeDescription'); },
    get managedDescription() { return i18n.t('tools.adapters.claude.accounts.managedDescription'); },
    get defaultLabel() { return i18n.t('tools.adapters.claude.accounts.defaultLabel'); },
    methods: { get browser() { return i18n.t('tools.adapters.claude.accounts.methodBrowser'); } },
  },
  configuration: { Editor: ClaudeConfigurationEditor },
  officialUsage: { accountRequired: false, automaticRefresh: false },
  modelMapping,
  authEnvName: () => 'ANTHROPIC_API_KEY',
  get incompleteConnectionText() { return i18n.t('tools.adapters.claude.incompleteConnection'); },
};
