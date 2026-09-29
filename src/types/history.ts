import type { LaunchMode, LaunchResult } from './launch';

export type HistoryMessage = { id: string; role: string; text: string; timestamp: number | null };
export type UsageEvent = { id: string; model: string | null; timestamp: number | null; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; inputIncludesCache: boolean };
export type ScanStatus = { toolId: string; scannedAt: number; sourceCount: number; failedCount: number; incomplete: boolean; detail: string };
export type HistorySession = { id: string; toolId: string; nativeId: string | null; title: string; cwd: string | null; model: string | null; projectId: string | null; startedAt: number | null; updatedAt: number | null; favorite: boolean; partial: boolean; stale: boolean; messageCount: number; usageCount: number };
export type HistoryDetail = { session: HistorySession; messages: HistoryMessage[]; usage: UsageEvent[]; resumeReason: string | null };
export type HistoryFilter = { toolId?: string | null; model?: string | null; projectId?: string | null; search?: string | null; fromMs?: number | null; toMs?: number | null; favoriteOnly?: boolean };
export type HistoryPrice = { toolId: string; model: string; currency: string; inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number; cacheWritePerMillion: number; source: string; updatedAt: number };
export type UsageSummary = { sessionCount: number; usageSessions: number; unknownUsageSessions: number; partialSessions: number; staleSessions: number; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; inputIncludesCache: boolean | null; estimatedCost: number | null; currency: string | null; priceSources: string[]; scans: ScanStatus[] };
export type ResumeMode = LaunchMode;
export type ResumeResult = LaunchResult;
