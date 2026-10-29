import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SkillIssue, SkillManifest, SkillManifestField } from '../../types/resources';
import { Badge } from '../../components/ui';
import { Icon } from '../../components/Icon';
import doc from './DocumentWorkspace.module.css';
import styles from './SkillManifestView.module.css';

/** Values longer than this fold behind an expander; the full text stays one click away. */
const LONG_VALUE = 160;

export function skillIssueText(t: TFunction, issue: SkillIssue, directory: string) {
  return t(`tools.skills.issue.${issue.code}`, { limit: issue.limit ?? '', actual: issue.actual ?? '', directory });
}

/** Lines are split on `\n` like the backend; the body starts at `bodyLine`. */
export function skillBody(text: string, manifest: SkillManifest) {
  return manifest.bodyLine > 0 ? text.split('\n').slice(manifest.bodyLine).join('\n') : text;
}

/** Narrows an IPC reply; a missing or malformed reply falls back to the plain document view. */
export function isSkillManifest(value: unknown): value is SkillManifest {
  const item = value as SkillManifest | null;
  return !!item && typeof item === 'object' && Array.isArray(item.issues) && Array.isArray(item.metadata) && Array.isArray(item.allowedTools) && Array.isArray(item.extra) && typeof item.bodyLine === 'number';
}

function Value({ value }: { value: string }) {
  const { t } = useTranslation();
  if (value.length <= LONG_VALUE && !value.includes('\n')) return <>{value}</>;
  return <details className={styles.long}>
    <summary><span className={styles.preview}>{value.slice(0, LONG_VALUE).replace(/\s+/g, ' ')}…</span><span className={styles.more}>{t('tools.skills.valueExpand', { count: value.length })}</span><span className={styles.less}>{t('tools.skills.valueCollapse')}</span></summary>
    <span className={styles.full}>{value}</span>
  </details>;
}

/** Specification issues for one skill. Display only; nothing here blocks an action. */
export function SkillIssueList({ issues, directory }: { issues: SkillIssue[]; directory: string }) {
  const { t } = useTranslation();
  if (!issues.length) return null;
  return <section className={styles.issues} aria-label={t('tools.skills.issuesTitle')}>
    <strong><Icon name="alert" size={14} />{t('tools.skills.issuesTitle')}</strong>
    <ul>{issues.map(issue => <li key={issue.code}>{skillIssueText(t, issue, directory)}</li>)}</ul>
  </section>;
}

/**
 * SKILL.md fields read by the backend (Agent Skills specification): issues,
 * description, name, license, compatibility, metadata, allowed-tools and any
 * other top-level fields. Empty fields are not rendered.
 */
export function SkillManifestView({ manifest, directory, showDescription = true }: { manifest: SkillManifest; directory: string; showDescription?: boolean }) {
  const { t } = useTranslation();
  const rows: SkillManifestField[] = [];
  if (manifest.name) rows.push({ key: 'name', value: manifest.name });
  if (manifest.license) rows.push({ key: 'license', value: manifest.license });
  if (manifest.compatibility) rows.push({ key: 'compatibility', value: manifest.compatibility });
  for (const item of manifest.metadata) rows.push({ key: item.key ? `metadata.${item.key}` : 'metadata', value: item.value });
  for (const item of manifest.extra) rows.push(item);
  const tools = manifest.allowedTools;
  return <div className={styles.manifest}>
    <SkillIssueList issues={manifest.issues} directory={directory} />
    {showDescription && manifest.description && <p className={doc.lead}>{manifest.description}</p>}
    {(rows.length > 0 || tools.length > 0) && <dl className={doc.fieldCard} aria-label={t('tools.skills.fieldsLabel')}>
      {rows.map(item => <div key={item.key}><dt>{item.key}</dt><dd><Value value={item.value} /></dd></div>)}
      {tools.length > 0 && <div><dt className={styles.toolsKey}>allowed-tools<Badge tone="info">{t('tools.skills.experimental')}</Badge></dt><dd><ul className={styles.tools} aria-label="allowed-tools">{tools.map((tool, index) => <li key={`${index}:${tool}`}>{tool}</li>)}</ul></dd></div>}
    </dl>}
  </div>;
}
