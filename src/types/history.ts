import type { LaunchMode, LaunchResult } from './launch';

export type HistoryMessage = { id: string; role: string; text: string; timestamp: number | null; timestampSource?: 'native' | 'turn' | 'session' | 'unknown'; kind?: 'conversation' | 'project_context' | 'environment_context' };
export type UsageEvent = { requestCount?: number | null; id: string; model: string | null; timestamp: number | null; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; inputIncludesCache: boolean };
export type ScanStatus = { toolId: string; scannedAt: number; sourceCount: number; failedCount: number; incomplete: boolean; detail: string };
export type HistorySession = { id: string; toolId: string; nativeId: string | null; title: string; cwd: string | null; model: string | null; projectId: string | null; startedAt: number | null; updatedAt: number | null; favorite: boolean; partial: boolean; stale: boolean; messageCount: number; usageCount: number };
export type HistoryDetail = { session: HistorySession; messages: HistoryMessage[]; usage: UsageEvent[]; totals: UsageTotals; resumeReason: string | null };
export type HistoryFilter = { toolId?: string | null; model?: string | null; projectId?: string | null; search?: string | null; fromMs?: number | null; toMs?: number | null; favoriteOnly?: boolean; tools?: string[] | null };
export type HistoryPrice = { toolId: string; model: string; currency: string; inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number; cacheWritePerMillion: number; source: string; updatedAt: number };
/** Disjoint token buckets: `input` is fresh prompt tokens, never including cache. */
export type UsageTotals = { requests: number; usageRecords: number; unknownRequestRecords: number; sessions: number; input: number; cacheRead: number; cacheWrite: number; output: number; total: number; cost: number | null; unpricedTokens: number };
export type UsageBucket = { start: number; end: number; totals: UsageTotals };
export type UsageGroup = { key: string; label: string; toolId: string | null; model: string | null; projectId: string | null; priced: boolean; totals: UsageTotals };
export type SessionUsage = { id: string; toolId: string; title: string; model: string | null; updatedAt: number | null; totals: UsageTotals };
export type UsageReport = {
  generatedAt: number; from: number | null; to: number | null; bucket: 'hour' | 'day' | 'month'; currency: string;
  totals: UsageTotals; previous: { from: number; to: number; totals: UsageTotals } | null; timeline: UsageBucket[];
  byModel: UsageGroup[]; byTool: UsageGroup[]; byProject: UsageGroup[]; topSessions: SessionUsage[]; models: string[];
  untimedRequests: number; duplicateRequests: number; partialSessions: number; staleSessions: number; mixedCurrency: boolean;
  latestEventAt: number | null; priceSources: string[]; scans: ScanStatus[];
};
export type ResumeMode = LaunchMode;
export type ResumeResult = LaunchResult;
