import type { CommonInfluenceTarget } from '../../../types/configuration';

// 通用配置应用结果的去术语化映射：后端 status 值保持契约不变，这里只做 UI 呈现翻译。
// 未知值一律回退原文（detail + 原状态 / 原 scopeKey），不编造文案。
const STATUS_COPY: Record<string, string> = {
  written_for_next_session: '已保存，下次会话生效',
};

export function applyStatusCopy(status: string, detail: string | null): string {
  if (status === 'failed' && detail) return detail;
  const known = STATUS_COPY[status];
  if (known) return known;
  return detail ? `${detail}（${status}）` : status;
}

export function applyScopeCopy(scopeKey: string, targets: CommonInfluenceTarget[]): string {
  const target = targets.find(candidate => candidate.scopeKey === scopeKey);
  if (!target) return scopeKey;
  const scopeLabel = target.scope === 'global' ? '全局' : target.projectPath ?? scopeKey;
  return target.profileName ? `${target.profileName} · ${scopeLabel}` : scopeLabel;
}
