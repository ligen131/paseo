import { isDeepStrictEqual } from "node:util";

import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const EPOCH_TIMESTAMP = new Date(0).toISOString();
const RECONCILIATION_YIELD_INTERVAL = 256;

export interface ProviderHistoryTimelineEntry {
  item: AgentTimelineItem;
  timestamp?: string;
}

interface ReconciliationCandidate {
  row: AgentTimelineRow;
  canonicalIndex: number;
  used: boolean;
}

interface CandidateQueue {
  indexes: number[];
  cursor: number;
}

interface StructuralCandidateGroup {
  representative: AgentTimelineItem;
  queue: CandidateQueue;
}

interface MatchIndexes {
  identities: Map<string, CandidateQueue>;
  structures: Map<string, StructuralCandidateGroup[]>;
}

interface StructuralCount {
  canonical: number;
  provider: number;
}

interface MatchedCandidate {
  row: AgentTimelineRow;
  canonicalIndex: number;
  transferProviderIdentity: boolean;
}

interface EmissionState {
  emitted: Uint8Array;
  successors: number[];
}

/** Reconciles canonical metadata onto provider-ordered history without inventing membership. */
export async function reconcileProviderHistory(
  canonicalRows: readonly AgentTimelineRow[],
  providerEntries: readonly ProviderHistoryTimelineEntry[],
  options?: { mode?: "incomplete" | "force" },
): Promise<AgentTimelineRow[]> {
  if (providerEntries.length === 0) {
    return copyCanonicalRows(canonicalRows, options?.mode);
  }
  if (canonicalRows.length === 0) {
    return copyProviderEntries(providerEntries);
  }

  const remaining = canonicalRows.map((row, canonicalIndex) => ({
    row,
    canonicalIndex,
    used: false,
  }));
  const structuralCounts = new Map<string, StructuralCount>();
  const matchIndexes = await buildMatchIndexes(remaining, structuralCounts);
  await countProviderStructuralOccurrences(providerEntries, structuralCounts);
  const providerRows: Array<{
    entry: ProviderHistoryTimelineEntry;
    match: MatchedCandidate | null;
  }> = [];
  for (let index = 0; index < providerEntries.length; index += 1) {
    const entry = providerEntries[index]!;
    const match = takeMatch(
      remaining,
      matchIndexes,
      entry.item,
      structuralKey(entry.item),
      structuralCounts,
    );
    providerRows.push({ entry, match });
    if ((index + 1) % RECONCILIATION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }
  const rows: AgentTimelineRow[] = [];
  const emission = createEmissionState(remaining.length);

  for (let index = 0; index < providerRows.length; index += 1) {
    const { entry, match } = providerRows[index]!;
    if (match) {
      appendUnemittedCanonicalPrefix(rows, remaining, emission, match.canonicalIndex);
      rows.push(
        match.transferProviderIdentity ? mergeMatchedRow(match.row, entry) : { ...match.row },
      );
      markCanonicalEmitted(emission, match.canonicalIndex);
    } else {
      rows.push({
        seq: 0,
        timestamp: entry.timestamp ?? EPOCH_TIMESTAMP,
        item: entry.item,
      });
    }
    if ((index + 1) % RECONCILIATION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }

  if (options?.mode !== "force") {
    appendUnemittedCanonicalPrefix(rows, remaining, emission, remaining.length);
  }
  for (let index = 0; index < rows.length; index += 1) {
    rows[index]!.seq = index + 1;
    if ((index + 1) % RECONCILIATION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }
  return rows;
}

async function copyCanonicalRows(
  canonicalRows: readonly AgentTimelineRow[],
  mode: "incomplete" | "force" | undefined,
): Promise<AgentTimelineRow[]> {
  if (mode === "force") return [];

  const rows: AgentTimelineRow[] = [];
  for (let index = 0; index < canonicalRows.length; index += 1) {
    rows.push({ ...canonicalRows[index]!, seq: index + 1 });
    if ((index + 1) % RECONCILIATION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }
  return rows;
}

async function copyProviderEntries(
  providerEntries: readonly ProviderHistoryTimelineEntry[],
): Promise<AgentTimelineRow[]> {
  const rows: AgentTimelineRow[] = [];
  for (let index = 0; index < providerEntries.length; index += 1) {
    const entry = providerEntries[index]!;
    rows.push({
      seq: index + 1,
      timestamp: entry.timestamp ?? EPOCH_TIMESTAMP,
      item: entry.item,
    });
    if ((index + 1) % RECONCILIATION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }
  return rows;
}

async function buildMatchIndexes(
  candidates: readonly ReconciliationCandidate[],
  structuralCounts: Map<string, StructuralCount>,
): Promise<MatchIndexes> {
  const identities = new Map<string, CandidateQueue>();
  const structures = new Map<string, StructuralCandidateGroup[]>();
  let processedCandidates = 0;

  for (const candidate of candidates) {
    for (const identity of new Set(canonicalIdentities(candidate.row))) {
      appendQueueIndex(identities, identity, candidate.canonicalIndex);
    }

    const key = structuralKey(candidate.row.item);
    const count = structuralCounts.get(key) ?? { canonical: 0, provider: 0 };
    count.canonical += 1;
    structuralCounts.set(key, count);

    let groups = structures.get(key);
    if (!groups) {
      groups = [];
      structures.set(key, groups);
    }
    let group = groups.find((value) =>
      structurallyMatches(value.representative, candidate.row.item),
    );
    if (!group) {
      group = {
        representative: candidate.row.item,
        queue: { indexes: [], cursor: 0 },
      };
      groups.push(group);
    }
    group.queue.indexes.push(candidate.canonicalIndex);
    processedCandidates += 1;
    if (processedCandidates % RECONCILIATION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }

  return { identities, structures };
}

function appendQueueIndex(
  queues: Map<string, CandidateQueue>,
  key: string,
  canonicalIndex: number,
): void {
  let queue = queues.get(key);
  if (!queue) {
    queue = { indexes: [], cursor: 0 };
    queues.set(key, queue);
  }
  queue.indexes.push(canonicalIndex);
}

function takeMatch(
  candidates: ReconciliationCandidate[],
  indexes: MatchIndexes,
  provider: AgentTimelineItem,
  structuralKeyValue: string,
  structuralCounts: Map<string, StructuralCount>,
): MatchedCandidate | null {
  const strongIndex = findStrongMatchIndex(candidates, indexes.identities, provider);
  const canonicalIndex =
    strongIndex ??
    findStructuralMatchIndex(candidates, indexes.structures, provider, structuralKeyValue);
  if (canonicalIndex === null) return null;

  const candidate = candidates[canonicalIndex]!;
  candidate.used = true;
  const counts = structuralCounts.get(structuralKeyValue);
  return {
    row: candidate.row,
    canonicalIndex,
    transferProviderIdentity:
      strongIndex !== null || (counts?.canonical === 1 && counts.provider === 1),
  };
}

function findStrongMatchIndex(
  candidates: readonly ReconciliationCandidate[],
  identities: ReadonlyMap<string, CandidateQueue>,
  provider: AgentTimelineItem,
): number | null {
  let first: number | null = null;
  for (const identity of new Set(providerIdentities(provider))) {
    const queue = identities.get(identity);
    if (!queue) continue;
    const index = firstUnusedQueueIndex(queue, candidates);
    if (index !== null && (first === null || index < first)) {
      first = index;
    }
  }
  return first;
}

function findStructuralMatchIndex(
  candidates: readonly ReconciliationCandidate[],
  structures: ReadonlyMap<string, StructuralCandidateGroup[]>,
  provider: AgentTimelineItem,
  structuralKeyValue: string,
): number | null {
  const groups = structures.get(structuralKeyValue);
  if (!groups) return null;

  let first: number | null = null;
  for (const group of groups) {
    if (!structurallyMatches(group.representative, provider)) continue;
    const index = firstUnusedQueueIndex(group.queue, candidates);
    if (index !== null && (first === null || index < first)) {
      first = index;
    }
  }
  return first;
}

function firstUnusedQueueIndex(
  queue: CandidateQueue,
  candidates: readonly ReconciliationCandidate[],
): number | null {
  while (queue.cursor < queue.indexes.length) {
    const index = queue.indexes[queue.cursor]!;
    if (!candidates[index]!.used) return index;
    queue.cursor += 1;
  }
  return null;
}

function canonicalIdentities(row: AgentTimelineRow): string[] {
  if (row.item.type !== "user_message") return [];
  return [row.item.clientMessageId, row.item.messageId, row.providerMessageId].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function providerIdentities(item: AgentTimelineItem): string[] {
  if (item.type !== "user_message") return [];
  return [item.clientMessageId, item.messageId].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

async function countProviderStructuralOccurrences(
  providerEntries: readonly ProviderHistoryTimelineEntry[],
  counts: Map<string, StructuralCount>,
): Promise<void> {
  for (let index = 0; index < providerEntries.length; index += 1) {
    const key = structuralKey(providerEntries[index]!.item);
    const count = counts.get(key);
    if (count) count.provider += 1;
    if ((index + 1) % RECONCILIATION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }
}

function structuralKey(item: AgentTimelineItem): string {
  return item.type === "user_message"
    ? `user:${item.text}`
    : `${item.type}:${stableStringify(item)}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  const sorted: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    sorted[key] = sortJsonValue(entryValue);
  }
  return sorted;
}

function createEmissionState(length: number): EmissionState {
  return {
    emitted: new Uint8Array(length),
    successors: Array.from({ length: length + 1 }, (_, index) => index),
  };
}

function appendUnemittedCanonicalPrefix(
  rows: AgentTimelineRow[],
  candidates: readonly ReconciliationCandidate[],
  state: EmissionState,
  endIndex: number,
): void {
  let index = findNextUnemitted(state.successors, 0);
  while (index < endIndex) {
    rows.push({ ...candidates[index]!.row });
    markCanonicalEmitted(state, index);
    index = findNextUnemitted(state.successors, index);
  }
}

function markCanonicalEmitted(state: EmissionState, index: number): void {
  if (state.emitted[index] === 1) return;
  state.emitted[index] = 1;
  state.successors[index] = findNextUnemitted(state.successors, index + 1);
}

function findNextUnemitted(successors: number[], index: number): number {
  let root = index;
  while (successors[root] !== root) {
    root = successors[root]!;
  }
  while (successors[index] !== index) {
    const next = successors[index]!;
    successors[index] = root;
    index = next;
  }
  return root;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

function mergeMatchedRow(
  canonical: AgentTimelineRow,
  provider: ProviderHistoryTimelineEntry,
): AgentTimelineRow {
  return {
    ...canonical,
    item: mergeCanonicalIdentity(canonical.item, provider.item),
  };
}

function structurallyMatches(left: AgentTimelineItem, right: AgentTimelineItem): boolean {
  if (left.type === "user_message" && right.type === "user_message")
    return left.text === right.text;
  return isDeepStrictEqual(left, right);
}

function mergeCanonicalIdentity(
  canonical: AgentTimelineItem,
  provider: AgentTimelineItem,
): AgentTimelineItem {
  if (canonical.type !== "user_message" || provider.type !== "user_message") return provider;
  return {
    ...provider,
    ...(canonical.clientMessageId ? { clientMessageId: canonical.clientMessageId } : {}),
    ...(canonical.messageId ? { messageId: canonical.messageId } : {}),
  };
}
