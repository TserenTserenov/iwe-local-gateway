// see DP.SC.034 §metrics sources, WP-150 Ф8
// Записывает gateway-метрики в ~/.iwe/gateway-metrics.json после каждой операции.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const METRICS_PATH =
  process.env.IWE_METRICS_PATH ??
  path.join(os.homedir(), ".iwe", "gateway-metrics.json");

export interface GatewayMetrics {
  acquires_total: number;
  releases_total: number;
  collisions_total: number;
  active_locks: number;
  active_agents: number;
  lock_durations_ms: number[]; // last 100 completed lock durations
  updated_at: string;
}

const METRICS: GatewayMetrics = {
  acquires_total: 0,
  releases_total: 0,
  collisions_total: 0,
  active_locks: 0,
  active_agents: 0,
  lock_durations_ms: [],
  updated_at: new Date().toISOString(),
};

// Track acquire timestamps for duration calculation.
const acquiredAt = new Map<string, number>(); // key=canonicalFile

export const metrics = {
  recordAcquire(file: string): void {
    METRICS.acquires_total++;
    METRICS.active_locks++;
    acquiredAt.set(file, Date.now());
    flush();
  },
  recordCollision(): void {
    METRICS.collisions_total++;
    flush();
  },
  recordRelease(file: string): void {
    METRICS.releases_total++;
    // Guard: only decrement if we actually tracked this acquire.
    // Prevents double-decrement when explicit release + TTL expiry both fire.
    if (acquiredAt.has(file)) {
      METRICS.active_locks = Math.max(0, METRICS.active_locks - 1);
      const start = acquiredAt.get(file)!;
      acquiredAt.delete(file);
      METRICS.lock_durations_ms = [
        ...METRICS.lock_durations_ms.slice(-99),
        Date.now() - start,
      ];
    }
    flush();
  },
  setActiveLocks(n: number): void {
    METRICS.active_locks = n;
    flush();
  },
  setActiveAgents(n: number): void {
    METRICS.active_agents = n;
    flush();
  },
  snapshot(): Readonly<GatewayMetrics> {
    return { ...METRICS };
  },
};

function flush() {
  METRICS.updated_at = new Date().toISOString();
  try {
    fs.writeFileSync(METRICS_PATH, JSON.stringify(METRICS, null, 2), "utf8");
  } catch {
    /* non-fatal */
  }
}
