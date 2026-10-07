import type { CommonInfluenceTarget } from '../../../types/configuration';
import i18n from '../../../i18n';

// 通用配置应用结果的去术语化映射：后端 status 值保持契约不变，这里只做 UI 呈现翻译。
// 未知值一律回退原文（detail + 原状态 / 原 scopeKey），不编造文案。
export function applyStatusCopy(status: string, detail: string | null): string {
  if (status === 'failed' && detail) return detail;
  if (status === 'written_for_next_session') return i18n.t('tools.apply.writtenForNextSession');
  return detail ? i18n.t('tools.apply.unknownWithDetail', { detail, status }) : status;
}

export function applyScopeCopy(scopeKey: string, targets: CommonInfluenceTarget[]): string {
  const target = targets.find(candidate => candidate.scopeKey === scopeKey);
  if (!target) return scopeKey;
  const scopeLabel = target.scope === 'global' ? i18n.t('tools.apply.global') : target.projectPath ?? scopeKey;
  return target.profileName ? `${target.profileName} · ${scopeLabel}` : scopeLabel;
}
