import { describe, it, expect, beforeEach } from "vitest";
import { LockManager } from "../src/lock-manager.js";

describe("LockManager", () => {
  let lm: LockManager;
  beforeEach(() => {
    lm = new LockManager();
  });

  it("acquire returns lock on free file", () => {
    const r = lm.acquire("/tmp/foo.py", "claude");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lock.holder).toBe("claude");
      expect(r.lock.file).toBe("/tmp/foo.py");
    }
  });

  it("second acquire by different holder → collision", () => {
    lm.acquire("/tmp/foo.py", "claude");
    const r = lm.acquire("/tmp/foo.py", "kimikode");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.holder.holder).toBe("claude");
  });

  it("re-acquire by same holder is idempotent (success)", () => {
    lm.acquire("/tmp/foo.py", "claude");
    const r = lm.acquire("/tmp/foo.py", "claude");
    expect(r.ok).toBe(true);
  });

  it("release by holder works", () => {
    lm.acquire("/tmp/foo.py", "claude");
    const r = lm.release("/tmp/foo.py", "claude");
    expect(r.ok).toBe(true);
    expect(r.released).toBe(true);
  });

  it("release by non-holder → not_held_by_caller", () => {
    lm.acquire("/tmp/foo.py", "claude");
    const r = lm.release("/tmp/foo.py", "kimikode");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not_held_by_caller");
  });

  it("after release, other holder can acquire", () => {
    lm.acquire("/tmp/foo.py", "claude");
    lm.release("/tmp/foo.py", "claude");
    const r = lm.acquire("/tmp/foo.py", "kimikode");
    expect(r.ok).toBe(true);
  });

  it("status returns active locks", () => {
    lm.acquire("/tmp/foo.py", "claude");
    lm.acquire("/tmp/bar.py", "kimikode");
    const s = lm.status();
    expect(s.locks).toHaveLength(2);
  });

  it("path canonicalization: same file via ~ and absolute", () => {
    const home = process.env.HOME ?? "/tmp";
    const r1 = lm.acquire(`${home}/x.py`, "claude");
    expect(r1.ok).toBe(true);
    const r2 = lm.acquire("~/x.py", "kimikode");
    expect(r2.ok).toBe(false);
  });

  it("expired lock auto-pruned on next acquire", async () => {
    lm.acquire("/tmp/foo.py", "claude", 10); // 10ms TTL
    await new Promise((r) => setTimeout(r, 20));
    const r = lm.acquire("/tmp/foo.py", "kimikode");
    expect(r.ok).toBe(true);
  });

  it("status() prunes expired locks without acquire", async () => {
    lm.acquire("/tmp/foo.py", "claude", 10); // 10ms TTL
    await new Promise((r) => setTimeout(r, 20));
    const s = lm.status();
    expect(s.locks).toHaveLength(0);
  });

  it("release of non-existent lock returns ok:true released:false", () => {
    const r = lm.release("/tmp/never-locked.py", "claude");
    expect(r.ok).toBe(true);
    expect(r.released).toBe(false);
    expect(r.reason).toBe("no_such_lock");
  });

  it("I14: TTL-takeover by a different holder fires onTtlTakeover with both identities", async () => {
    const takeovers: Array<{ file: string; from: string; to: string }> = [];
    lm.onTtlTakeover = (file, previousHolder, newHolder) =>
      takeovers.push({ file, from: previousHolder.holder, to: newHolder });

    lm.acquire("/tmp/foo.py", "claude", 10); // 10ms TTL
    await new Promise((r) => setTimeout(r, 20));
    lm.acquire("/tmp/foo.py", "kimikode");

    expect(takeovers).toHaveLength(1);
    expect(takeovers[0].from).toBe("claude");
    expect(takeovers[0].to).toBe("kimikode");
  });

  it("I14: same-holder heartbeat re-acquire is NOT a takeover", () => {
    const takeovers: unknown[] = [];
    lm.onTtlTakeover = (...args) => takeovers.push(args);

    lm.acquire("/tmp/foo.py", "claude");
    lm.acquire("/tmp/foo.py", "claude"); // heartbeat refresh, same holder

    expect(takeovers).toHaveLength(0);
  });

  it("I14: fresh acquire on a never-locked file is NOT a takeover", () => {
    const takeovers: unknown[] = [];
    lm.onTtlTakeover = (...args) => takeovers.push(args);

    lm.acquire("/tmp/never-locked.py", "claude");

    expect(takeovers).toHaveLength(0);
  });
});
