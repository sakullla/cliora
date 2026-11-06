/** One base64 output event; offset identifies its first native stream byte. */
export type OutputChunk = { data: string; offset?: number };

/** A bounded tail for terminals without a writer. Native replay owns recovery. */
export class PendingTerminalOutput {
  private readonly entries = new Map<string, { chunks: OutputChunk[]; bytes: number }>();
  private retainedBytes = 0;
  private readonly maxSessions: number;
  private readonly maxBytes: number;
  private readonly maxSessionBytes: number;
  private readonly maxSessionChunks: number;

  constructor(
    maxSessions = 32,
    maxBytes = 4 * 1024 * 1024,
    maxSessionBytes = 512 * 1024,
    maxSessionChunks = 256,
  ) {
    this.maxSessions = maxSessions;
    this.maxBytes = maxBytes;
    this.maxSessionBytes = maxSessionBytes;
    this.maxSessionChunks = maxSessionChunks;
  }

  get size(): number { return this.entries.size; }
  get byteLength(): number { return this.retainedBytes; }

  push(sessionId: string, chunk: OutputChunk): void {
    const bytes = chunk.data.length;
    if (!bytes || bytes > this.maxSessionBytes || bytes > this.maxBytes) return;
    const entry = this.entries.get(sessionId) ?? { chunks: [], bytes: 0 };
    this.entries.delete(sessionId);
    entry.chunks.push(chunk);
    entry.bytes += bytes;
    this.retainedBytes += bytes;
    while (entry.bytes > this.maxSessionBytes || entry.chunks.length > this.maxSessionChunks) {
      const removed = entry.chunks.shift()!;
      entry.bytes -= removed.data.length;
      this.retainedBytes -= removed.data.length;
    }
    this.entries.set(sessionId, entry);
    while (this.entries.size > this.maxSessions || this.retainedBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  drain(sessionId: string): OutputChunk[] {
    const chunks = this.entries.get(sessionId)?.chunks ?? [];
    this.delete(sessionId);
    return chunks;
  }

  delete(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.retainedBytes -= entry.bytes;
    this.entries.delete(sessionId);
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }
}
