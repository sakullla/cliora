/** Small presentation caches: expired values are removed on access/write, oldest entries first. */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, { value: V; expires: number }>();
  private readonly capacity: number;
  private readonly ttl: number;

  constructor(capacity: number, ttl = Infinity) {
    this.capacity = Math.max(1, capacity);
    this.ttl = ttl;
  }

  get size(): number { this.prune(); return this.entries.size; }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) { this.entries.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    this.prune();
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + this.ttl });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }

  delete(key: K): void { this.entries.delete(key); }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
  }
}
