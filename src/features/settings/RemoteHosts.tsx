import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { Icon } from '../../components/Icon';
import { confirmAction } from '../../lib/confirm';
import { native, nativeAvailable } from '../../lib/native';
import type { RemoteTarget } from '../../types/remote';
import { Badge, Button, IconButton, Segmented } from '../../components/ui';
import styles from './RemoteHosts.module.css';

type AuthMethod = RemoteTarget['authMethod'];
type Draft = { id: string; name: string; host: string; port: string; user: string; authMethod: AuthMethod; password: string; identityFile: string; sshConfig: string; defaultPath: string };
type TestState = { state: 'running' } | { state: 'ok'; detail: string } | { state: 'failed'; detail: string };

const emptyDraft: Draft = { id: '', name: '', host: '', port: '22', user: 'root', authMethod: 'password', password: '', identityFile: '', sshConfig: '', defaultPath: '' };

function draftFrom(target: RemoteTarget): Draft {
  // A name equal to the address is the automatic default; keep it automatic while editing.
  return { id: target.id, name: target.name === target.host ? '' : target.name, host: target.host, port: String(target.port), user: target.user, authMethod: target.authMethod, password: '', identityFile: target.identityFile ?? '', sshConfig: target.sshConfig ?? '', defaultPath: target.defaultPath ?? '' };
}

function errorText(error: unknown, fallback: string) {
  if (typeof error === 'string') return error;
  const value = error as { message?: string; action?: string } | null;
  return [value?.message || fallback, value?.action].filter(Boolean).join(' · ');
}

function address(target: Pick<RemoteTarget, 'user' | 'host' | 'port'>) {
  return `${target.user}@${target.host}${target.port && target.port !== 22 ? `:${target.port}` : ''}`;
}

const notifyTargetsChanged = () => window.dispatchEvent(new Event('cliora:remote-targets-changed'));

/** Add, edit, test and remove SSH hosts. One form, three required fields; the rest is optional. */
export function RemoteHosts() {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<RemoteTarget[]>([]);
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState(!nativeAvailable);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const testRequests = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const request of testRequests.current.values()) request.abort(); testRequests.current.clear(); };
  }, []);
  function cancelTest(id: string) {
    testRequests.current.get(id)?.abort();
    testRequests.current.delete(id);
    setTests(old => { const next = { ...old }; delete next[id]; return next; });
  }
  function edit(target: RemoteTarget) { cancelTest(target.id); setEditing(draftFrom(target)); }


  async function reload() {
    if (!nativeAvailable) return;
    try {
      const [list, passwords] = await Promise.all([native.listRemoteTargets(), native.listRemoteSavedPasswords().catch(() => [] as string[])]);
      setTargets(Array.isArray(list) ? list : []);
      setSaved(new Set(Array.isArray(passwords) ? passwords : []));
      setLoadError('');
    } catch { setLoadError(t('settings.remoteSsh.loadFailed')); }
    finally { setLoaded(true); }
  }
  useEffect(() => { void reload(); }, []);

  async function test(target: RemoteTarget) {
    if (target.authMethod === 'password' && !saved.has(target.id)) {
      setTests((old) => ({ ...old, [target.id]: { state: 'failed', detail: t('settings.remoteSsh.testNeedsPassword') } }));
      return;
    }
    cancelTest(target.id);
    const controller = new AbortController();
    testRequests.current.set(target.id, controller);
    const current = () => mounted.current && testRequests.current.get(target.id) === controller && !controller.signal.aborted;
    setTests((old) => ({ ...old, [target.id]: { state: 'running' } }));
    try {
      const result = await native.testRemoteTarget(target, null, { signal: controller.signal });
      if (!current()) return;
      setTests((old) => ({ ...old, [target.id]: { state: 'ok', detail: result.system?.trim() || t('settings.remoteSsh.ready') } }));
    } catch (error) {
      if (current()) setTests((old) => ({ ...old, [target.id]: { state: 'failed', detail: errorText(error, t('settings.remoteSsh.testFailed')) } }));
    } finally { if (testRequests.current.get(target.id) === controller) testRequests.current.delete(target.id); }
  }

  async function remove(target: RemoteTarget) {
    const accepted = await confirmAction(t('settings.remoteSsh.deleteMessage'), () => true, { title: t('settings.remoteSsh.deleteTitle', { name: target.name }), confirmLabel: t('settings.remoteSsh.delete'), destructive: true });
    if (!accepted) return;
    try {
      cancelTest(target.id);
      await native.deleteRemoteTarget(target.id);
      setTargets((items) => items.filter((item) => item.id !== target.id));
      notifyTargetsChanged();
    } catch (error) {
      setTests((old) => ({ ...old, [target.id]: { state: 'failed', detail: errorText(error, t('settings.remoteSsh.saveFailed')) } }));
    }
  }

  function onSaved(target: RemoteTarget, passwordSaved: boolean) {
    cancelTest(target.id);
    setTargets((items) => [...items.filter((item) => item.id !== target.id), target].sort((a, b) => a.name.localeCompare(b.name)));
    setSaved((old) => {
      const next = new Set(old);
      if (target.authMethod === 'password' && (passwordSaved || old.has(target.id))) next.add(target.id); else next.delete(target.id);
      return next;
    });
    setTests((old) => { const next = { ...old }; delete next[target.id]; return next; });
    setEditing(null);
    notifyTargetsChanged();
  }

  const adding = editing !== null && !editing.id;
  return <section className={styles.panel} id="remote-ssh-settings" aria-labelledby="remote-hosts-title">
    <header className={styles.head}>
      <div><h2 id="remote-hosts-title">{t('settings.remoteSsh.hostsTitle')}</h2><p>{t('settings.remoteSsh.hostsDescription')}</p></div>
      {targets.length > 0 && !adding && <Button variant="primary" icon={<Icon name="plus" size={14} />} onClick={() => setEditing({ ...emptyDraft })}>{t('settings.remoteSsh.addHost')}</Button>}
    </header>
    {loadError && <p className={styles.error} role="alert">{loadError}</p>}
    {adding && <HostEditor draft={editing} passwordSaved={false} onCancel={() => setEditing(null)} onSaved={onSaved} />}
    {loaded && !targets.length && !adding && <div className={styles.empty}>
      <span className={styles.emptyGlyph} aria-hidden="true"><Icon name="server" size={22} /></span>
      <strong>{t('settings.remoteSsh.emptyTitle')}</strong>
      <p>{t('settings.remoteSsh.emptyDetail')}</p>
      <Button variant="primary" icon={<Icon name="plus" size={14} />} onClick={() => setEditing({ ...emptyDraft })}>{t('settings.remoteSsh.addHost')}</Button>
    </div>}
    {targets.length > 0 && <ul className={styles.list} aria-label={t('settings.remoteSsh.hostsTitle')}>
      {targets.map((target) => {
        if (editing?.id === target.id) return <li key={target.id}><HostEditor draft={editing} passwordSaved={saved.has(target.id)} onCancel={() => setEditing(null)} onSaved={onSaved} /></li>;
        const status = tests[target.id];
        const passwordKnown = saved.has(target.id);
        return <li key={target.id} className={styles.host}>
          <span className={styles.hostGlyph} aria-hidden="true"><Icon name="server" size={16} /></span>
          <span className={styles.hostCopy}>
            <strong>{target.name}</strong>
            <span className={styles.hostMeta}>
              <code>{address(target)}</code>
              <Badge tone={target.authMethod === 'password' && !passwordKnown ? 'warning' : 'neutral'}><Icon name={target.authMethod === 'password' ? 'lock' : 'shield'} size={12} />{target.authMethod === 'key' ? t('settings.remoteSsh.keyBadge') : passwordKnown ? t('settings.remoteSsh.passwordSavedBadge') : t('settings.remoteSsh.passwordAskBadge')}</Badge>
              {target.defaultPath && <span className={styles.path} title={target.defaultPath}><Icon name="folder" size={12} />{target.defaultPath}</span>}
            </span>
            {status && status.state !== 'running' && <span className={styles.result} data-tone={status.state} role="status"><Icon name={status.state === 'ok' ? 'check' : 'alert'} size={12} />{status.state === 'ok' ? `${t('settings.remoteSsh.testOk')} · ${status.detail}` : status.detail}</span>}
          </span>
          <span className={styles.hostActions}>
            {status?.state === 'running' && <Button onClick={() => cancelTest(target.id)}>{t('settings.remoteSsh.cancelTest')}</Button>}
            <Button disabled={status?.state === 'running'} loading={status?.state === 'running'} icon={<Icon name="refresh" size={14} />} onClick={() => void test(target)}>{status?.state === 'running' ? t('settings.remoteSsh.testing') : t('settings.remoteSsh.test')}</Button>
            <IconButton aria-label={`${t('settings.remoteSsh.edit')} ${target.name}`} title={t('settings.remoteSsh.edit')} icon={<Icon name="pencil" size={15} />} onClick={() => edit(target)} />
            <IconButton className={styles.danger} aria-label={`${t('settings.remoteSsh.delete')} ${target.name}`} title={t('settings.remoteSsh.delete')} icon={<Icon name="trash" size={15} />} onClick={() => void remove(target)} />
          </span>
        </li>;
      })}
    </ul>}
  </section>;
}

function HostEditor({ draft: initial, passwordSaved, onCancel, onSaved }: { draft: Draft; passwordSaved: boolean; onCancel: () => void; onSaved: (target: RemoteTarget, passwordSaved: boolean) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initial);
  const [showPassword, setShowPassword] = useState(false);
  const [moreOpen, setMoreOpen] = useState(Boolean(initial.defaultPath || (initial.name && initial.name !== initial.host)));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('');
  const [result, setResult] = useState<TestState | null>(null);
  const hostRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const revision = useRef(0);
  const testRequest = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; testRequest.current?.abort(); }; }, []);
  function cancelTest() { testRequest.current?.abort(); testRequest.current = null; setBusy(''); setResult(null); }
  function close() { if (busy === 'save') return; testRequest.current?.abort(); onCancel(); }
  useEffect(() => { hostRef.current?.focus(); }, []);

  const port = Number(draft.port);
  const errors = {
    host: !draft.host.trim() || /[\s/\\]/.test(draft.host.trim()) ? t('settings.remoteSsh.hostRequired') : '',
    port: !Number.isInteger(port) || port < 1 || port > 65535 ? t('settings.remoteSsh.invalidPort') : '',
    user: !draft.user.trim() || /[\s/\\@]/.test(draft.user.trim()) ? t('settings.remoteSsh.userRequired') : '',
    password: draft.authMethod === 'password' && !passwordSaved && !draft.password ? t('settings.remoteSsh.passwordRequired') : '',
  };
  const valid = !errors.host && !errors.port && !errors.user;
  const set = (patch: Partial<Draft>) => { if (busy === 'save') return; revision.current++; if (testRequest.current) cancelTest(); setDraft((old) => ({ ...old, ...patch })); setResult(null); };

  function toTarget(): RemoteTarget {
    const host = draft.host.trim();
    return {
      id: draft.id, name: draft.name.trim() || host, host, port, user: draft.user.trim(), authMethod: draft.authMethod,
      identityFile: draft.authMethod === 'key' ? draft.identityFile.trim() || null : null,
      sshConfig: draft.sshConfig.trim() || null, defaultPath: draft.defaultPath.trim() || null,
      enabled: true, createdAt: 0, updatedAt: 0,
    };
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    setSubmitted(true);
    if (!valid || errors.password || busy) return;
    setBusy('save');
    try {
      const password = draft.authMethod === 'password' ? draft.password : '';
      const saved = await native.saveRemoteTarget(toTarget(), password || null);
      if (alive.current) onSaved(saved, Boolean(password));
    } catch (error) {
      if (alive.current) setResult({ state: 'failed', detail: errorText(error, t('settings.remoteSsh.saveFailed')) });
    } finally { if (alive.current) setBusy(''); }
  }

  async function test() {
    setSubmitted(true);
    if (!valid || busy) return;
    if (draft.authMethod === 'password' && !draft.password && !passwordSaved) { setResult({ state: 'failed', detail: t('settings.remoteSsh.testNeedsPassword') }); return; }
    const controller = new AbortController();
    const testedRevision = revision.current;
    testRequest.current = controller;
    const current = () => alive.current && !controller.signal.aborted && testRequest.current === controller && revision.current === testedRevision;
    setBusy('test');
    setResult({ state: 'running' });
    try {
      const probe = await native.testRemoteTarget(toTarget(), draft.authMethod === 'password' ? draft.password || null : null, { signal: controller.signal });
      if (!current()) return;
      setResult({ state: 'ok', detail: probe.system?.trim() || t('settings.remoteSsh.ready') });
    } catch (error) {
      if (current()) setResult({ state: 'failed', detail: errorText(error, t('settings.remoteSsh.testFailed')) });
    } finally { if (current()) { testRequest.current = null; setBusy(''); } }
  }

  async function pickKey() {
    try {
      const value = await open({ directory: false, multiple: false, title: t('settings.remoteSsh.pickIdentityFile') });
      if (typeof value === 'string') set({ identityFile: value });
    } catch { /* The dialog stays optional; typing a path works too. */ }
  }

  const field = (name: keyof typeof errors) => submitted && errors[name] ? errors[name] : '';
  return <form className={styles.editor} aria-label={draft.id ? t('settings.remoteSsh.editHost') : t('settings.remoteSsh.newHost')} onSubmit={(event) => void save(event)} noValidate onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
    <fieldset className={styles.fields} disabled={busy === 'save'}>
    <div className={styles.editorTitle}><Icon name="server" size={16} /><strong>{draft.id ? t('settings.remoteSsh.editHost') : t('settings.remoteSsh.newHost')}</strong></div>
    <div className={styles.grid}>
      <label className={styles.field} data-span="host">
        <span>{t('settings.remoteSsh.address')}</span>
        <input ref={hostRef} value={draft.host} placeholder={t('settings.remoteSsh.addressPlaceholder')} autoComplete="off" spellCheck={false} aria-invalid={Boolean(field('host')) || undefined} onChange={(event) => set({ host: event.target.value })} />
        {field('host') && <small className={styles.fieldError}>{field('host')}</small>}
      </label>
      <label className={styles.field} data-span="port">
        <span>{t('settings.remoteSsh.port')}</span>
        <input value={draft.port} inputMode="numeric" autoComplete="off" aria-invalid={Boolean(field('port')) || undefined} onChange={(event) => set({ port: event.target.value.replace(/[^\d]/g, '').slice(0, 5) })} />
        {field('port') && <small className={styles.fieldError}>{field('port')}</small>}
      </label>
      <label className={styles.field} data-span="user">
        <span>{t('settings.remoteSsh.user')}</span>
        <input value={draft.user} autoComplete="off" spellCheck={false} aria-invalid={Boolean(field('user')) || undefined} onChange={(event) => set({ user: event.target.value })} />
        {field('user') && <small className={styles.fieldError}>{field('user')}</small>}
      </label>
      <div className={styles.field} data-span="auth" role="group" aria-labelledby={`${formId}-auth`}>
        <span id={`${formId}-auth`}>{t('settings.remoteSsh.authMethod')}</span>
        <Segmented className={styles.segmented} label={t('settings.remoteSsh.authMethod')} value={draft.authMethod} onChange={(method) => set({ authMethod: method })}
          options={(['password', 'key'] as AuthMethod[]).map((method) => ({ value: method, label: <><Icon name={method === 'password' ? 'lock' : 'shield'} size={14} />{method === 'password' ? t('settings.remoteSsh.authPassword') : t('settings.remoteSsh.authKey')}</> }))} />
      </div>
      {draft.authMethod === 'password' ? <label className={styles.field} data-span="secret">
        <span>{t('settings.remoteSsh.password')}</span>
        <span className={styles.inputGroup}>
          <input type={showPassword ? 'text' : 'password'} value={draft.password} autoComplete="new-password" placeholder={passwordSaved ? t('settings.remoteSsh.passwordSaved') : t('settings.remoteSsh.passwordPlaceholder')} aria-invalid={Boolean(field('password')) || undefined} onChange={(event) => set({ password: event.target.value })} />
          <IconButton size="sm" className={styles.inline} aria-label={showPassword ? t('settings.remoteSsh.hidePassword') : t('settings.remoteSsh.showPassword')} icon={<Icon name={showPassword ? 'eyeOff' : 'eye'} size={15} />} onClick={() => setShowPassword((value) => !value)} />
        </span>
        {field('password') ? <small className={styles.fieldError}>{field('password')}</small> : <small className={styles.hint}><Icon name="lock" size={11} />{t('settings.remoteSsh.passwordNote')}</small>}
      </label> : <label className={styles.field} data-span="secret">
        <span>{t('settings.remoteSsh.keyFile')}</span>
        <span className={styles.inputGroup}>
          <input value={draft.identityFile} placeholder={t('settings.remoteSsh.keyFilePlaceholder')} autoComplete="off" spellCheck={false} onChange={(event) => set({ identityFile: event.target.value })} />
          {nativeAvailable && <Button variant="ghost" size="sm" className={styles.inline} onClick={() => void pickKey()}>{t('settings.remoteSsh.browse')}</Button>}
        </span>
      </label>}
    </div>
    <div className={styles.more}>
      <Button variant="ghost" size="sm" className={styles.moreToggle} aria-expanded={moreOpen} icon={<Icon name="chevronRight" size={13} />} onClick={() => setMoreOpen((value) => !value)}>{t('settings.remoteSsh.more')}</Button>
      {moreOpen && <div className={styles.grid}>
        <label className={styles.field} data-span="half">
          <span>{t('settings.remoteSsh.name')}</span>
          <input value={draft.name} placeholder={draft.host.trim() || t('settings.remoteSsh.namePlaceholder')} autoComplete="off" onChange={(event) => set({ name: event.target.value })} />
        </label>
        <label className={styles.field} data-span="half">
          <span>{t('settings.remoteSsh.path')}</span>
          <input value={draft.defaultPath} placeholder={t('settings.remoteSsh.pathPlaceholder')} autoComplete="off" spellCheck={false} onChange={(event) => set({ defaultPath: event.target.value })} />
        </label>
      </div>}
    </div>
    {result && <p className={styles.result} data-tone={result.state} role="status">{result.state === 'running' ? <span className="spinner" aria-hidden="true" /> : <Icon name={result.state === 'ok' ? 'check' : 'alert'} size={13} />}{result.state === 'running' ? t('settings.remoteSsh.testing') : result.state === 'ok' ? `${t('settings.remoteSsh.testOk')} · ${result.detail}` : result.detail}</p>}
    <div className={styles.footer}>
      <Button disabled={!!busy} loading={busy === 'test'} icon={<Icon name="refresh" size={14} />} onClick={() => void test()}>{t('settings.remoteSsh.test')}</Button>
      {busy === 'test' && <Button onClick={cancelTest}>{t('settings.remoteSsh.cancelTest')}</Button>}
      <span className={styles.footerGap} />
      <Button onClick={close}>{t('settings.remoteSsh.cancel')}</Button>
      <Button variant="primary" type="submit" data-dialog-save disabled={!!busy} loading={busy === 'save'}>{t('settings.remoteSsh.save')}</Button>
    </div>
    </fieldset>
  </form>;
}
