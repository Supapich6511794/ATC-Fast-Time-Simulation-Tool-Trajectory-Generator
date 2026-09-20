import { afterEach, describe, expect, it } from "vitest";

import { yieldToMain } from "@/lib/yieldToMain";

const realChannel = globalThis.MessageChannel;

afterEach(() => {
  globalThis.MessageChannel = realChannel;
});

describe("yieldToMain", () => {
  it("resolves, so a sliced loop can carry on", async () => {
    await expect(yieldToMain()).resolves.toBeUndefined();
  });

  it("hands control back rather than resuming inline", async () => {
    let inline = true;
    const p = yieldToMain();
    inline = false; // runs before the yield can possibly have resumed
    await p;
    expect(inline).toBe(false);
  });

  it("can be awaited over and over — a whole traffic day is dozens of slices", async () => {
    for (let i = 0; i < 300; i++) await yieldToMain();
  });

  it("falls back to a timer where there is no MessageChannel", async () => {
    // @ts-expect-error — simulating an environment without it
    globalThis.MessageChannel = undefined;
    await expect(yieldToMain()).resolves.toBeUndefined();
  });
});
