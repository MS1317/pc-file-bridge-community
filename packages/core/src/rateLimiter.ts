interface BucketEntry {
  count: number;
  windowStart: number;
}

export interface RateLimiterOptions {
  /** Max requests per window */
  maxRequests: number;
  /** Window size in milliseconds */
  windowMs: number;
}

/**
 * Simple in-memory sliding-window rate limiter.
 * Keyed by an arbitrary string (e.g. IP or token prefix).
 * No external dependencies, no Redis.
 */
export class RateLimiter {
  private buckets = new Map<string, BucketEntry>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(opts: RateLimiterOptions = { maxRequests: 120, windowMs: 60_000 }) {
    this.maxRequests = opts.maxRequests;
    this.windowMs = opts.windowMs;
  }

  /** Returns true if the key is within limits, false if rate-limited. */
  check(key: string): boolean {
    const now = Date.now();
    const entry = this.buckets.get(key);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= this.maxRequests) {
      return false;
    }

    entry.count += 1;
    return true;
  }

  /** Milliseconds until the current window resets for a key. */
  retryAfterMs(key: string): number {
    const entry = this.buckets.get(key);
    if (!entry) return 0;
    const elapsed = Date.now() - entry.windowStart;
    return Math.max(0, this.windowMs - elapsed);
  }

  /** Prune stale buckets to avoid unbounded memory growth. */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.buckets) {
      if (now - entry.windowStart >= this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}
