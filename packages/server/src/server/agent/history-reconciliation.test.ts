import { describe, expect, test } from "vitest";

import { reconcileProviderHistory } from "./history-reconciliation.js";

const user = (text: string, id?: string) => ({
  type: "user_message" as const,
  text,
  ...(id ? { clientMessageId: id } : {}),
});

describe("reconcileProviderHistory", () => {
  test("puts missing provider prefix before a newer durable suffix while preserving suffix metadata", async () => {
    const rows = await reconcileProviderHistory(
      [
        {
          seq: 2,
          timestamp: "2026-01-02T00:00:00.000Z",
          item: user("suffix", "suffix"),
          turnId: "turn-1",
          providerMessageId: "p-suffix",
        },
      ],
      [
        { item: user("prefix"), timestamp: "2026-01-01T00:00:00.000Z" },
        { item: user("suffix"), timestamp: "2026-01-02T00:00:00.000Z" },
      ],
    );
    expect(rows).toMatchObject([
      { seq: 1, item: { text: "prefix" } },
      {
        seq: 2,
        turnId: "turn-1",
        providerMessageId: "p-suffix",
        item: { text: "suffix", clientMessageId: "suffix" },
      },
    ]);
  });

  test("pairs repeated identical user text by ordered occurrence", async () => {
    const rows = await reconcileProviderHistory(
      [
        {
          seq: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: user("same", "one"),
          turnId: "turn-1",
        },
        {
          seq: 2,
          timestamp: "2026-01-02T00:00:00.000Z",
          item: user("same", "two"),
          turnId: "turn-2",
        },
      ],
      [{ item: user("same") }, { item: user("same") }],
    );
    expect(
      rows.map((row) => [
        row.item.type === "user_message" ? row.item.clientMessageId : null,
        row.turnId,
      ]),
    ).toEqual([
      ["one", "turn-1"],
      ["two", "turn-2"],
    ]);
  });

  test("retains a canonical suffix when provider history is lagging", async () => {
    const rows = await reconcileProviderHistory(
      [
        {
          seq: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: user("initial", "initial"),
          turnId: "turn-1",
        },
        {
          seq: 2,
          timestamp: "2026-01-02T00:00:00.000Z",
          item: user("hello", "hello"),
          turnId: "turn-1",
        },
      ],
      [{ item: user("initial") }],
    );

    expect(rows).toMatchObject([
      { seq: 1, item: { text: "initial", clientMessageId: "initial" }, turnId: "turn-1" },
      { seq: 2, item: { text: "hello", clientMessageId: "hello" }, turnId: "turn-1" },
    ]);
  });

  test("does not transfer provider identity between ambiguous repeated prompts", async () => {
    const rows = await reconcileProviderHistory(
      [
        {
          seq: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: user("same", "one"),
          turnId: "turn-1",
        },
        {
          seq: 2,
          timestamp: "2026-01-02T00:00:00.000Z",
          item: user("same", "two"),
          turnId: "turn-2",
        },
      ],
      [{ item: { type: "user_message", text: "same", messageId: "provider-two" } }],
    );

    expect(rows).toMatchObject([
      { item: { clientMessageId: "one" }, turnId: "turn-1" },
      { item: { clientMessageId: "two" }, turnId: "turn-2" },
    ]);
    expect(rows.some((row) => row.providerMessageId === "provider-two")).toBe(false);
  });

  test("does not invent turn membership for provider-only rows", async () => {
    expect(
      (
        await reconcileProviderHistory(
          [],
          [{ item: { type: "assistant_message", text: "provider" } }],
        )
      )[0]?.turnId,
    ).toBeUndefined();
  });

  test("clears unmatched rows for an authoritative forced history", async () => {
    expect(
      await reconcileProviderHistory(
        [{ seq: 1, timestamp: "now", item: user("old", "old"), turnId: "turn-1" }],
        [],
        { mode: "force" },
      ),
    ).toEqual([]);
  });

  test("matches structurally equal items regardless of object key order", async () => {
    const rows = await reconcileProviderHistory(
      [
        {
          seq: 1,
          timestamp: "now",
          item: { type: "assistant_message", text: "same", messageId: "assistant-id" },
          turnId: "turn-1",
        },
      ],
      [
        {
          item: { messageId: "assistant-id", text: "same", type: "assistant_message" },
        },
      ],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turnId: "turn-1" });
  });

  test("reconciles large ordered histories without rescanning the canonical prefix", async () => {
    const count = 20_000;
    const canonical = Array.from({ length: count }, (_, index) => ({
      seq: index + 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      item: user(`message-${index}`, `client-${index}`),
      turnId: `turn-${index}`,
    }));
    const provider = Array.from({ length: count }, (_, index) => ({
      item: user(`message-${index}`),
    }));
    let immediateRan = false;
    setImmediate(() => {
      immediateRan = true;
    });

    const rows = await reconcileProviderHistory(canonical, provider);

    expect(immediateRan).toBe(true);
    expect(rows).toHaveLength(count);
    expect(rows[0]).toMatchObject({
      seq: 1,
      turnId: "turn-0",
      item: { clientMessageId: "client-0" },
    });
    expect(rows[count - 1]).toMatchObject({
      seq: count,
      turnId: `turn-${count - 1}`,
      item: { clientMessageId: `client-${count - 1}` },
    });
  });
});
