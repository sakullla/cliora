import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open as pickFile } from '@tauri-apps/plugin-dialog';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { Button, IconButton } from '../../components/ui';
import type { NewSecretExecutor, SecretExecutor, SecretGrant, SecretInstallation } from '../../types/secrets';
import { reveal } from '../../lib/reveal';
import styles from './PromptSecrets.module.css';

const presets = [
  {
    id: 'localCheck', icon: 'shield', executable: 'node', channel: 'stdin', envName: null,
    args: ['-e', "process.stdout.write(require('node:fs').readFileSync(0).length ? 'OK' : 'EMPTY')"],
  },
  {
    id: 'github', icon: 'globe', executable: 'gh', channel: 'env', envName: 'GH_TOKEN',
    args: ['api', '--hostname', 'github.com', 'user', '--jq', '.login'],
  },
] as const;

type Props = {
  availablePrograms: string[];
  alias: string;
  installations: SecretInstallation[];
  executors: SecretExecutor[];
  grants: SecretGrant[];
  busy: boolean;
  onGrant: (installationId: string, executor: string | NewSecretExecutor) => Promise<{ executorId: string; granted: boolean } | undefined>;
  onInsert: (grant: SecretGrant) => void;
  onRevoke: (grant: SecretGrant) => void;
  onClose: () => void;
};

/**
 * Script permissions for one secret: the actions already allowed, and a short picker for a
 * new one. Choosing an action is a click on a card; only "my own script" asks for a path.
 */
export function SecretScriptAccess({ availablePrograms, alias, installations, executors, grants, busy, onGrant, onInsert, onRevoke, onClose }: Props) {
  const { t } = useTranslation();
  const live = installations.filter(item => !item.revoked);
  const local = installations.filter(item => item.kind === 'cli' && !item.targetId);
  const [targetOverride, setTarget] = useState('');
  const target = targetOverride || local.find(item => !item.revoked)?.id || '';
  const [adding, setAdding] = useState(false);
  const [script, setScript] = useState<string>('localCheck');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [channel, setChannel] = useState<'stdin' | 'env'>('stdin');
  const [envName, setEnvName] = useState('');
  const [pickError, setPickError] = useState(false);
  const autoCreate = !local.length;
  const selected = live.find(item => item.id === target);
  const recipient = selected?.label ?? t('library.secrets.broker.defaultCliLabel');
  const existing = executors.find(item => item.id === script);
  const preset = presets.find(item => item.id === script);
  const matchingPreset = preset && executors.find(item => item.executable === preset.executable && item.channel === preset.channel && item.envName === preset.envName
    && !item.cwd && item.args.length === preset.args.length && item.args.every((arg, index) => arg === preset.args[index]));
  const grantExecutorId = matchingPreset?.id ?? existing?.id;
  const granted = grants.some(grant => grant.installationId === target && grant.executorId === grantExecutorId);
  const missingProgram = preset && !availablePrograms.includes(preset.executable) ? preset.executable : null;
  const targetReady = !!selected || (!target && autoCreate);
  const customReady = !script && !!path.trim() && (channel === 'stdin' || !!envName.trim());
  const ready = !missingProgram && targetReady && (!!preset || !!existing || customReady);
  const choosing = !grants.length || adding;

  async function save() {
    if (!ready || busy || granted) return;
    const executor = grantExecutorId ?? (preset ? {
      label: t(`library.secrets.broker.${preset.id}`),
      executable: preset.executable, args: [...preset.args], channel: preset.channel, envName: preset.envName,
      description: '', cwd: null,
    } : {
      executable: path.trim(),
      label: name.trim() || path.trim().split(/[\\/]/).pop() || path.trim(),
      args: args.split('\n').filter(Boolean),
      description: '',
      cwd: cwd.trim() || null,
      channel,
      envName: channel === 'env' ? envName.trim() : null,
    });
    // Keep a successfully registered script selected even if the subsequent grant fails.
    const saved = await onGrant(target, executor);
    if (saved?.executorId) setScript(saved.executorId);
    if (saved?.granted) setAdding(false);
  }

  async function chooseFile() {
    setPickError(false);
    try {
      const file = await pickFile({ multiple: false, directory: false });
      if (typeof file === 'string') setPath(file);
    } catch { setPickError(true); }
  }

  const choices: Array<{ key: string; value: string; icon: IconName; title: string; detail: string; pressed: boolean }> = [
    ...presets.map(item => ({ key: item.id, value: item.id, icon: item.icon as IconName, title: t(`library.secrets.broker.${item.id}`), detail: t(`library.secrets.broker.${item.id}Short`), pressed: script === item.id })),
    { key: 'custom', value: '', icon: 'terminal', title: t('library.secrets.broker.newScript'), detail: t('library.secrets.broker.newScriptShort'), pressed: !script },
    ...(executors.length ? [{ key: 'saved', value: executors[0].id, icon: 'archive' as IconName, title: t('library.secrets.broker.executors'), detail: t('library.secrets.broker.savedShort'), pressed: !!existing }] : []),
  ];

  return <div ref={reveal} className={styles.sheet} data-secret-grant-form>
    <div className={styles.sheetHead}>
      <div>
        <strong>{t('library.secrets.broker.panelTitle', { name: alias })}</strong>
        <span className={styles.muted}>{t('library.secrets.broker.panelHint')}</span>
      </div>
      <IconButton size="sm" aria-label={t('library.secrets.broker.close')} disabled={busy} icon={<Icon name="close" size={13} />} onClick={onClose} />
    </div>

    {grants.length > 0 && <ul className={styles.grants}>
      {grants.map(grant => <li className={styles.grantRow} key={grant.installationId + grant.executorId} data-secret-grant-row>
        <span className={styles.grantIcon} aria-hidden="true"><Icon name="check" size={12} /></span>
        <span className={styles.grantText}>
          <strong>{grant.executorLabel}</strong>
          <span>{t('library.secrets.broker.via', { name: installations.find(item => item.id === grant.installationId)?.label ?? grant.installationId.slice(0, 8) })}</span>
        </span>
        <Button size="sm" disabled={busy} data-secret-grant-insert icon={<Icon name="plus" size={12} />} onClick={() => onInsert(grant)}>{t('library.secrets.broker.addToPrompt')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} data-secret-grant-revoke onClick={() => onRevoke(grant)}>{t('library.secrets.broker.revokeGrant')}</Button>
      </li>)}
    </ul>}

    {!choosing ? <div className={styles.footer}>
      <span className={styles.footerNote} />
      <div className={styles.footerActions}>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{t('library.secrets.done')}</Button>
        <Button size="sm" disabled={busy} icon={<Icon name="plus" size={12} />} onClick={() => { setScript('localCheck'); setAdding(true); }}>{t('library.secrets.broker.addAction')}</Button>
      </div>
    </div> : <>
      <fieldset className={styles.choices} disabled={busy}>
        <legend>{t('library.secrets.broker.script')}</legend>
        {choices.map(choice => <button key={choice.key} type="button" className={styles.choice} data-secret-preset={choice.key} aria-pressed={choice.pressed} onClick={() => setScript(choice.value)}>
          <Icon name={choice.icon} size={14} />
          <strong>{choice.title}</strong>
          <span>{choice.detail}</span>
        </button>)}
      </fieldset>
      {missingProgram && <p role="status" className={styles.alert}>{t('library.secrets.missingProgram', { name: missingProgram })}</p>}
      {preset && <p className={styles.callout}><Icon name="info" size={13} /><span>{t(`library.secrets.broker.${preset.id}Hint`)}</span></p>}

      <div className={styles.grid2}>
        {existing && <label className={styles.field}>{t('library.secrets.broker.executors')}
          <select data-secret-grant-executor value={script} disabled={busy} onChange={event => setScript(event.target.value)}>
            {executors.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>}
        {(live.length > 1 || (!local.some(item => !item.revoked) && live.length > 0)) && <label className={styles.field}>{t('library.secrets.broker.selectInstallation')}
          <select data-secret-grant-installation value={target} disabled={busy} onChange={event => setTarget(event.target.value)}>
            {!local.some(item => !item.revoked) && <option value="" disabled={!autoCreate}>{autoCreate ? 'local-cli' : t('library.secrets.broker.selectInstallation')}</option>}
            {live.map(item => <option key={item.id} value={item.id}>{item.label} · {item.id.slice(0, 8)}</option>)}
          </select>
        </label>}
        {!script && <div className={styles.field}><label htmlFor="secret-script-path">{t('library.secrets.broker.executable')}</label>
          <span className={styles.picker}><input id="secret-script-path" data-secret-executor-executable value={path} disabled={busy} placeholder={t('library.secrets.broker.executablePlaceholder')} onChange={event => setPath(event.target.value)} /><Button size="sm" disabled={busy} icon={<Icon name="folder" size={12} />} onClick={() => void chooseFile()}>{t('library.secrets.broker.chooseFile')}</Button></span>
        </div>}
      </div>

      {!script && pickError && <p className={styles.alert} role="alert"><Icon name="alert" size={14} /><span>{t('library.secrets.broker.pickFailed')}</span></p>}
      {!script && <details className={styles.details}>
        <summary>{t('library.secrets.broker.scriptOptions')}</summary>
        <div className={styles.grid2}>
          <label className={styles.field}>{t('library.secrets.broker.executorLabel')}<input maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
          <label className={styles.field}>{t('library.secrets.broker.channelLabel')}
            <select value={channel} disabled={busy} onChange={event => setChannel(event.target.value === 'env' ? 'env' : 'stdin')}>
              <option value="stdin">{t('library.secrets.broker.channel.stdin')}</option>
              <option value="env">{t('library.secrets.broker.channel.env')}</option>
            </select>
          </label>
          {channel === 'env' && <label className={styles.field}>{t('library.secrets.broker.envName')}<input value={envName} disabled={busy} placeholder={t('library.secrets.broker.envNamePlaceholder')} onChange={event => setEnvName(event.target.value)} /></label>}
          <label className={styles.field}>{t('library.secrets.broker.args')}<textarea rows={2} value={args} disabled={busy} onChange={event => setArgs(event.target.value)} /></label>
          <label className={styles.field}>{t('library.secrets.broker.cwd')}<input value={cwd} disabled={busy} onChange={event => setCwd(event.target.value)} /></label>
        </div>
      </details>}
      {existing && <details className={styles.details}><summary>{t('library.secrets.broker.scriptDetails')}</summary><code className={styles.code}>{[existing.executable, ...existing.args].join(' ')}</code></details>}

      <div className={styles.footer}>
        <span className={styles.footerNote}><Icon name="shield" size={12} />{!selected && !autoCreate ? t('library.secrets.broker.restoreFirst') : t('library.secrets.broker.grantHint', { name: recipient })}</span>
        <div className={styles.footerActions}>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (adding) setAdding(false); else onClose(); }}>{t('library.secrets.cancel')}</Button>
          <Button size="sm" variant="primary" data-secret-grant-save disabled={!ready || granted || busy} icon={<Icon name="check" size={12} />} onClick={() => void save()}>{t(granted ? 'library.secrets.broker.alreadyGranted' : 'library.secrets.broker.grantSave')}</Button>
        </div>
      </div>
    </>}
  </div>;
}
