// see DP.SC.034, DP.IWE.005, WP-150 Ф6
// In-memory pessimistic lock manager для координации write-операций
// между peer-агентами в одной VS Code сессии.

import path from "node:path";
import os from "node:os";

export interface Lock {
  file: string;
  holder: string;
  acquiredAt: string; // ISO timestamp
  ttlMs: number;
  expiresAt: number; // epoch ms
}

export interface LockAcquireResult {
  ok: true;
  lock: Lock;
}

export interface LockCollisionResult {
  ok: false;
  reason: "collision";
  holder: Lock;
}

export interface LockReleaseResult {
  ok: boolean;
  released: boolean;
  reason?: "not_held_by_caller" | "no_such_lock";
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes, see DP.IWE.005 §9 Q1

export class LockManager {
  private readonly locks = new Map<string, Lock>();

  // Fired when a lock is silently dropped by TTL expiry (not by explicit release).
  // Consumers (e.g. metrics) use this to keep derived counters consistent.
  onExpiry?: (canonicalFile: string) => void;

  /**
   * Канонизация пути для устранения /., trailing slash и home expansion.
   * Lock на `~/foo` и `/Users/x/foo` должен быть одним lock'ом.
   */
  private canonicalize(file: string): string {
    let p = file;
    if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
    return path.resolve(p);
  }

  private pruneExpired(now: number = Date.now()): void {
    for (const [key, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        this.locks.delete(key);
        this.onExpiry?.(key);
      }
    }
  }

  acquire(
    file: string,
    holder: string,
    ttlMs: number = DEFAULT_TTL_MS,
  ): LockAcquireResult | LockCollisionResult {
    const now = Date.now();
    this.pruneExpired(now);
    const key = this.canonicalize(file);
    const existing = this.locks.get(key);
    if (existing && existing.holder !== holder) {
      return { ok: false, reason: "collision", holder: existing };
    }
    // Re-acquire by same holder intentionally refreshes TTL (heartbeat pattern).
    const lock: Lock = {
      file: key,
      holder,
      acquiredAt: new Date(now).toISOString(),
      ttlMs,
      expiresAt: now + ttlMs,
    };
    this.locks.set(key, lock);
    return { ok: true, lock };
  }

  release(file: string, holder: string): LockReleaseResult {
    const key = this.canonicalize(file);
    const existing = this.locks.get(key);
    if (!existing) return { ok: true, released: false, reason: "no_such_lock" };
    if (existing.holder !== holder) {
      return { ok: false, released: false, reason: "not_held_by_caller" };
    }
    this.locks.delete(key);
    return { ok: true, released: true };
  }

  status(): { locks: Lock[]; now: string } {
    this.pruneExpired();
    return {
      locks: [...this.locks.values()],
      now: new Date().toISOString(),
    };
  }

  // Test helper — не для прод-кода. Сбрасывает всё состояние.
  clear(): void {
    this.locks.clear();
  }
}
