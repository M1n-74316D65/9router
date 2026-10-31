/**
 * Unit tests for open-sse/services/claudeAgentSlots.js (FIFO concurrency cap for Claude CLI turns).
 */

import { describe, it, expect } from "vitest";
import { acquireClaudeSlot, releaseClaudeSlot } from "../../open-sse/services/claudeAgentSlots.js";
import { CLAUDE_CLI_MAX_CONCURRENT } from "../../open-sse/config/claudeAgentConstants.js";

describe("acquireClaudeSlot", () => {
  it("admits up to the cap immediately and queues the rest FIFO", async () => {
    const held = [];
    for (let i = 0; i < CLAUDE_CLI_MAX_CONCURRENT; i++) held.push(await acquireClaudeSlot());

    const order = [];
    const first = acquireClaudeSlot().then(() => order.push("first"));
    const second = acquireClaudeSlot().then(() => order.push("second"));
    await Promise.resolve();
    expect(order).toEqual([]);

    releaseClaudeSlot();
    await first;
    expect(order).toEqual(["first"]);
    releaseClaudeSlot();
    await second;
    expect(order).toEqual(["first", "second"]);

    // Balance the remaining holders so other tests start from an empty pool.
    for (let i = 0; i < CLAUDE_CLI_MAX_CONCURRENT; i++) releaseClaudeSlot();
  });

  it("rejects a queued waiter when its client aborts, without taking a slot", async () => {
    const held = [];
    for (let i = 0; i < CLAUDE_CLI_MAX_CONCURRENT; i++) held.push(await acquireClaudeSlot());

    const controller = new AbortController();
    const waiter = acquireClaudeSlot(controller.signal);
    controller.abort();
    await expect(waiter).rejects.toThrow("while waiting");

    releaseClaudeSlot();
    // Slot count is intact: a new acquire is admitted right away.
    const next = await acquireClaudeSlot();
    expect(typeof next).toBe("function");
    releaseClaudeSlot();
    for (let i = 0; i < CLAUDE_CLI_MAX_CONCURRENT - 1; i++) releaseClaudeSlot();
  });

  it("refuses an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireClaudeSlot(controller.signal)).rejects.toThrow("before a Claude CLI slot");
  });
});
