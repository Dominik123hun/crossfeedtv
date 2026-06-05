/**
 * Tiny in-memory sliding-window rate limiter (no dependencies).
 *
 * Keyed by an arbitrary string (e.g. client IP). Inactive keys drop out of the
 * map automatically as their window empties, so memory stays bounded to active
 * keys within the window.
 *
 * NOTE: this is per-process. For a multi-instance deployment, move this to a
 * shared store (Redis) or the load balancer — see SECURITY.md.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Record an attempt for `key`; returns true if it is allowed (under the limit). */
  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Drop empty/expired keys to keep the map small (safe to call periodically). */
  prune(): void {
    const now = Date.now();
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}
