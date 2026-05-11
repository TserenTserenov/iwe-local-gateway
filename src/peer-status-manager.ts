// see DP.SC.035, DP.ROLE.039, WP-150 Ф7
// In-memory peer-status store + optional filesystem sync.
// Позволяет агентам объявить, что они делают, без file lock.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PeerStatus {
  agent_id: string;
  focus: string;              // что делает (файл или задача)
  intent: string;             // почему (контекст для другого агента)
  awaiting_decision: boolean; // заблокирован, ждёт пилота
  updated_at: string;         // ISO timestamp
}

const STATUS_DIR = path.join(os.homedir(), ".iwe", "peer-status");

export class PeerStatusManager {
  private readonly statuses = new Map<string, PeerStatus>();

  update(agentId: string, focus: string, intent: string, awaitingDecision = false): PeerStatus {
    const status: PeerStatus = {
      agent_id: agentId,
      focus,
      intent,
      awaiting_decision: awaitingDecision,
      updated_at: new Date().toISOString(),
    };
    this.statuses.set(agentId, status);
    // Best-effort persist to ~/.iwe/peer-status/<agentId>.json for external tools.
    try {
      fs.mkdirSync(STATUS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(STATUS_DIR, `${agentId}.json`),
        JSON.stringify(status, null, 2),
        "utf8",
      );
    } catch {
      /* non-fatal */
    }
    return status;
  }

  list(): PeerStatus[] {
    return [...this.statuses.values()];
  }

  remove(agentId: string): void {
    this.statuses.delete(agentId);
    try { fs.unlinkSync(path.join(STATUS_DIR, `${agentId}.json`)); } catch { /* ignore */ }
  }
}
