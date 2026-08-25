import type { AgentTimelineItem, ToolCallDetail } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-manager.js";

export type TimelineProjectionMode = "canonical" | "projected";

export interface TimelineSeqRange {
  startSeq: number;
  endSeq: number;
}

export type TimelineProjectionKind = "assistant_merge" | "reasoning_merge" | "tool_lifecycle";
export type TimelineLimitDirection = "tail" | "before" | "after";

export interface TimelineProjectionEntry {
  item: AgentTimelineItem;
  turnId?: string;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges: TimelineSeqRange[];
  collapsed: TimelineProjectionKind[];
}

type WorkingEntry = TimelineProjectionEntry;
interface ProjectedWindowSelection {
  projectedEntries: TimelineProjectionEntry[];
  selectedRows: AgentTimelineRow[];
  minSeq: number | null;
  maxSeq: number | null;
  totalProjected: number;
}

export interface ProjectedTimelinePageSelection {
  entries: TimelineProjectionEntry[];
  startSeq: number | null;
  endSeq: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
}

function appendSeqToRanges(ranges: TimelineSeqRange[], seq: number): TimelineSeqRange[] {
  if (ranges.length === 0) {
    return [{ startSeq: seq, endSeq: seq }];
  }

  const next = [...ranges];
  const last = next[next.length - 1];
  if (!last) {
    return [{ startSeq: seq, endSeq: seq }];
  }

  if (seq <= last.endSeq + 1) {
    last.endSeq = Math.max(last.endSeq, seq);
    return next;
  }

  next.push({ startSeq: seq, endSeq: seq });
  return next;
}

function mergeSeqRanges(
  existing: TimelineSeqRange[],
  incoming: TimelineSeqRange[],
): TimelineSeqRange[] {
  let merged = [...existing];
  for (const range of incoming) {
    for (let seq = range.startSeq; seq <= range.endSeq; seq += 1) {
      merged = appendSeqToRanges(merged, seq);
    }
  }
  return merged;
}

function mergeToolCallDetail(existing: ToolCallDetail, incoming: ToolCallDetail): ToolCallDetail {
  if (existing.type === "unknown" && incoming.type !== "unknown") {
    return incoming;
  }
  if (incoming.type === "unknown" && existing.type !== "unknown") {
    return existing;
  }
  return incoming;
}

function mergeToolCallItems(
  existing: Extract<AgentTimelineItem, { type: "tool_call" }>,
  incoming: Extract<AgentTimelineItem, { type: "tool_call" }>,
): Extract<AgentTimelineItem, { type: "tool_call" }> {
  const mergedDetail = mergeToolCallDetail(existing.detail, incoming.detail);
  const mergedMetadata =
    existing.metadata || incoming.metadata
      ? { ...existing.metadata, ...incoming.metadata }
      : undefined;

  const merged: Extract<AgentTimelineItem, { type: "tool_call" }> = {
    ...existing,
    ...incoming,
    detail: mergedDetail,
    metadata: mergedMetadata,
  };

  if (incoming.status === "failed") {
    merged.error = incoming.error;
  } else if (incoming.status === "completed" || incoming.status === "canceled") {
    merged.error = null;
  } else if (incoming.error !== undefined) {
    merged.error = incoming.error;
  }

  return merged;
}

function makeCanonicalEntry(row: AgentTimelineRow): WorkingEntry {
  return {
    item: row.item,
    ...(row.turnId ? { turnId: row.turnId } : {}),
    timestamp: row.timestamp,
    seqStart: row.seq,
    seqEnd: row.seq,
    sourceSeqRanges: [{ startSeq: row.seq, endSeq: row.seq }],
    collapsed: [],
  };
}

function makeCanonicalEntries(rows: readonly AgentTimelineRow[]): WorkingEntry[] {
  return rows.map(makeCanonicalEntry);
}

function mergeAdjacentTextEntry(output: WorkingEntry[], entry: WorkingEntry): boolean {
  const previous = output[output.length - 1];
  if (!previous || previous.seqEnd + 1 !== entry.seqStart || previous.turnId !== entry.turnId) {
    return false;
  }

  if (previous.item.type === "reasoning" && entry.item.type === "reasoning") {
    output[output.length - 1] = {
      ...previous,
      item: {
        type: "reasoning",
        text: `${previous.item.text}${entry.item.text}`,
      },
      timestamp: entry.timestamp,
      seqEnd: entry.seqEnd,
      sourceSeqRanges: mergeSeqRanges(previous.sourceSeqRanges, entry.sourceSeqRanges),
      collapsed: Array.from(
        new Set<TimelineProjectionKind>([
          ...previous.collapsed,
          ...entry.collapsed,
          "reasoning_merge",
        ]),
      ),
    };
    return true;
  }

  if (previous.item.type !== "assistant_message" || entry.item.type !== "assistant_message") {
    return false;
  }
  if (entry.item.messageId !== undefined && previous.item.messageId !== entry.item.messageId) {
    return false;
  }

  output[output.length - 1] = {
    ...previous,
    item: {
      type: "assistant_message",
      text: `${previous.item.text}${entry.item.text}`,
      ...(previous.item.messageId ? { messageId: previous.item.messageId } : {}),
    },
    timestamp: entry.timestamp,
    seqEnd: entry.seqEnd,
    sourceSeqRanges: mergeSeqRanges(previous.sourceSeqRanges, entry.sourceSeqRanges),
    collapsed: Array.from(
      new Set<TimelineProjectionKind>([
        ...previous.collapsed,
        ...entry.collapsed,
        "assistant_merge",
      ]),
    ),
  };
  return true;
}

function projectRowsInOnePass(rows: readonly AgentTimelineRow[]): WorkingEntry[] {
  const output: WorkingEntry[] = [];
  const toolIndexByCallId = new Map<string, number>();

  for (const row of rows) {
    const entry = makeCanonicalEntry(row);
    if (entry.item.type !== "tool_call") {
      if (!mergeAdjacentTextEntry(output, entry)) {
        output.push(entry);
      }
      continue;
    }

    const existingIndex = toolIndexByCallId.get(entry.item.callId);
    if (existingIndex === undefined) {
      toolIndexByCallId.set(entry.item.callId, output.length);
      output.push(entry);
      continue;
    }

    const existing = output[existingIndex];
    if (!existing || existing.item.type !== "tool_call" || existing.turnId !== entry.turnId) {
      output.push(entry);
      continue;
    }

    output[existingIndex] = {
      ...existing,
      item: mergeToolCallItems(existing.item, entry.item),
      timestamp: entry.timestamp,
      seqEnd: Math.max(existing.seqEnd, entry.seqEnd),
      sourceSeqRanges: mergeSeqRanges(existing.sourceSeqRanges, entry.sourceSeqRanges),
      collapsed: existing.collapsed.includes("tool_lifecycle")
        ? existing.collapsed
        : [...existing.collapsed, "tool_lifecycle"],
    };
  }

  return output;
}

export function projectTimelineRows(input: {
  rows: readonly AgentTimelineRow[];
  mode: TimelineProjectionMode;
}): TimelineProjectionEntry[] {
  return input.mode === "canonical"
    ? makeCanonicalEntries(input.rows)
    : projectRowsInOnePass(input.rows);
}

/**
 * Select a timeline window based on projected-entry count, then map it back to
 * contiguous canonical rows. This avoids cutting through merged assistant
 * chunks when callers request canonical rows with a bounded limit.
 */
export function selectTimelineWindowByProjectedLimit(input: {
  rows: readonly AgentTimelineRow[];
  direction: TimelineLimitDirection;
  limit: number;
}): ProjectedWindowSelection {
  const { rows, direction } = input;
  const limit = Math.max(0, Math.floor(input.limit));
  const projectedAll = projectRowsInOnePass(rows);

  if (projectedAll.length === 0) {
    return {
      projectedEntries: [],
      selectedRows: [],
      minSeq: null,
      maxSeq: null,
      totalProjected: projectedAll.length,
    };
  }

  let projectedEntries: typeof projectedAll;
  if (limit === 0 || limit >= projectedAll.length) {
    projectedEntries = projectedAll;
  } else if (direction === "after") {
    projectedEntries = projectedAll.slice(0, limit);
  } else {
    projectedEntries = projectedAll.slice(projectedAll.length - limit);
  }

  if (projectedEntries.length === 0) {
    return {
      projectedEntries: [],
      selectedRows: [],
      minSeq: null,
      maxSeq: null,
      totalProjected: projectedAll.length,
    };
  }

  const computeWindowBounds = (entries: readonly TimelineProjectionEntry[]) => {
    let minSeq = Number.POSITIVE_INFINITY;
    let maxSeq = Number.NEGATIVE_INFINITY;
    for (const entry of entries) {
      if (entry.seqStart < minSeq) {
        minSeq = entry.seqStart;
      }
      if (entry.seqEnd > maxSeq) {
        maxSeq = entry.seqEnd;
      }
    }
    return { minSeq, maxSeq };
  };

  let { minSeq, maxSeq } = computeWindowBounds(projectedEntries);
  let expandedEntries = projectedEntries;

  // Expand to include any projected entries that overlap the selected canonical
  // range. Tool lifecycle collapse can produce non-monotonic seqEnd values,
  // which would otherwise create cursor gaps.
  for (let iteration = 0; iteration < projectedAll.length + 1; iteration += 1) {
    const overlapping = projectedAll.filter(
      (entry) => entry.seqStart <= maxSeq && entry.seqEnd >= minSeq,
    );
    const nextBounds = computeWindowBounds(overlapping);
    if (
      overlapping.length === expandedEntries.length &&
      nextBounds.minSeq === minSeq &&
      nextBounds.maxSeq === maxSeq
    ) {
      expandedEntries = overlapping;
      break;
    }
    expandedEntries = overlapping;
    minSeq = nextBounds.minSeq;
    maxSeq = nextBounds.maxSeq;
  }

  const selectedRows = rows.filter((row) => row.seq >= minSeq && row.seq <= maxSeq);

  return {
    projectedEntries: expandedEntries,
    selectedRows,
    minSeq: Number.isFinite(minSeq) ? minSeq : null,
    maxSeq: Number.isFinite(maxSeq) ? maxSeq : null,
    totalProjected: projectedAll.length,
  };
}

function getTimelineBounds(
  rows: readonly AgentTimelineRow[],
): { minSeq: number; maxSeq: number } | null {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) {
    return null;
  }
  return { minSeq: first.seq, maxSeq: last.seq };
}

function firstSourceSeqInRange(
  entry: TimelineProjectionEntry,
  startSeq: number,
  endSeq: number,
): number | null {
  for (const range of entry.sourceSeqRanges) {
    const firstSeq = Math.max(range.startSeq, startSeq);
    if (firstSeq <= Math.min(range.endSeq, endSeq)) return firstSeq;
  }
  return null;
}

interface ProjectedEntryCandidate {
  entry: TimelineProjectionEntry;
  index: number;
  firstSourceSeq: number;
}

function selectProjectedEntriesAfter(input: {
  entries: readonly TimelineProjectionEntry[];
  rows: readonly AgentTimelineRow[];
  startSeq: number;
  maxSeq: number;
  limit: number;
}): { entries: TimelineProjectionEntry[]; endSeq: number | null } {
  const eligible = input.entries
    .map((entry, index) => ({
      entry,
      index,
      firstSourceSeq: firstSourceSeqInRange(entry, input.startSeq, input.maxSeq),
    }))
    .filter((candidate): candidate is ProjectedEntryCandidate => candidate.firstSourceSeq !== null)
    .sort((left, right) => left.firstSourceSeq - right.firstSourceSeq || left.index - right.index);
  const selected = input.limit === 0 ? eligible : eligible.slice(0, input.limit);
  const selectedEntries = selected
    .sort((left, right) => left.index - right.index)
    .map((candidate) => candidate.entry);
  if (selectedEntries.length === 0) return { entries: [], endSeq: null };

  const selectedRanges = selectedEntries
    .flatMap((entry) => entry.sourceSeqRanges)
    .sort((left, right) => left.startSeq - right.startSeq || left.endSeq - right.endSeq);
  // Wide projected entries can include future, discontiguous source ranges. The
  // page cursor advances only through source rows covered without a gap.
  let endSeq = input.startSeq - 1;
  let rangeIndex = 0;
  for (const row of input.rows) {
    if (row.seq < input.startSeq) continue;
    if (row.seq > input.maxSeq || row.seq !== endSeq + 1) break;
    while (selectedRanges[rangeIndex] && selectedRanges[rangeIndex].endSeq < row.seq) {
      rangeIndex += 1;
    }
    const range = selectedRanges[rangeIndex];
    if (!range || row.seq < range.startSeq || row.seq > range.endSeq) break;
    endSeq = row.seq;
  }

  return {
    entries: selectedEntries,
    endSeq: endSeq >= input.startSeq ? endSeq : null,
  };
}

function selectProjectedEntriesBefore(input: {
  entries: readonly TimelineProjectionEntry[];
  endSeq: number;
  limit: number;
}): { entries: TimelineProjectionEntry[]; startSeq: number | null; hasOlder: boolean } {
  // Older history follows projected display order. Lifecycle updates can move an
  // entry's seqEnd without moving its display anchor, so seqStart keeps the full
  // projected item on exactly one backward page.
  const eligible = input.entries.filter((entry) => entry.seqStart <= input.endSeq);
  const selected =
    input.limit === 0 || input.limit >= eligible.length
      ? eligible
      : eligible.slice(eligible.length - input.limit);

  return {
    entries: selected,
    startSeq: selected[0]?.seqStart ?? null,
    hasOlder: selected.length < eligible.length,
  };
}

export function selectProjectedTimelinePage(input: {
  rows: readonly AgentTimelineRow[];
  bounds?: { minSeq: number; maxSeq: number };
  direction: TimelineLimitDirection;
  cursorSeq?: number;
  limit?: number;
}): ProjectedTimelinePageSelection {
  const limit = input.limit === undefined ? 0 : Math.max(0, Math.floor(input.limit));
  const bounds = input.bounds ?? getTimelineBounds(input.rows);
  if (!bounds) {
    return {
      entries: [],
      startSeq: null,
      endSeq: null,
      hasOlder: false,
      hasNewer: false,
    };
  }

  if (input.direction === "tail") {
    const selected = selectTimelineWindowByProjectedLimit({
      rows: input.rows,
      direction: "tail",
      limit,
    });
    return {
      entries: selected.projectedEntries,
      startSeq: selected.minSeq,
      endSeq: selected.maxSeq,
      hasOlder: selected.minSeq !== null && selected.minSeq > bounds.minSeq,
      hasNewer: false,
    };
  }

  const projectedAll = projectTimelineRows({ rows: input.rows, mode: "projected" });
  if (projectedAll.length === 0) {
    if (input.direction === "after") {
      const cursorSeq = input.cursorSeq ?? bounds.minSeq - 1;
      return {
        entries: [],
        startSeq: null,
        endSeq: null,
        hasOlder: cursorSeq >= bounds.minSeq,
        hasNewer: cursorSeq < bounds.maxSeq,
      };
    }
    const cursorSeq = input.cursorSeq ?? bounds.maxSeq + 1;
    return {
      entries: [],
      startSeq: null,
      endSeq: null,
      hasOlder: cursorSeq > bounds.minSeq,
      hasNewer: cursorSeq <= bounds.maxSeq,
    };
  }

  if (input.direction === "after") {
    const cursorSeq = input.cursorSeq ?? bounds.minSeq - 1;
    const startSeq = Math.max(bounds.minSeq, cursorSeq + 1);
    const selected = selectProjectedEntriesAfter({
      entries: projectedAll,
      rows: input.rows,
      startSeq,
      maxSeq: bounds.maxSeq,
      limit,
    });
    return {
      entries: selected.entries,
      startSeq: selected.endSeq === null ? null : startSeq,
      endSeq: selected.endSeq,
      hasOlder: startSeq > bounds.minSeq,
      hasNewer: selected.endSeq !== null && selected.endSeq < bounds.maxSeq,
    };
  }

  const cursorSeq = input.cursorSeq ?? bounds.maxSeq + 1;
  const endSeq = Math.min(bounds.maxSeq, cursorSeq - 1);
  if (endSeq < bounds.minSeq) {
    return {
      entries: [],
      startSeq: null,
      endSeq: null,
      hasOlder: false,
      hasNewer: endSeq < bounds.maxSeq,
    };
  }

  const selected = selectProjectedEntriesBefore({ entries: projectedAll, endSeq, limit });
  return {
    entries: selected.entries,
    startSeq: selected.startSeq,
    endSeq,
    hasOlder: selected.hasOlder,
    hasNewer: endSeq < bounds.maxSeq,
  };
}

/**
 * Apply a projected-count limit to a flat AgentTimelineItem[] without seq metadata.
 * Used by callers that only have items in hand (e.g. MCP tools reading
 * `agentManager.getTimeline`). Index position is treated as canonical seq.
 */
export interface ProjectedItemSelection {
  items: AgentTimelineItem[];
  totalProjected: number;
  shownProjected: number;
}

export function selectItemsByProjectedLimit(input: {
  items: readonly AgentTimelineItem[];
  direction: TimelineLimitDirection;
  limit: number;
}): ProjectedItemSelection {
  const rows: AgentTimelineRow[] = input.items.map((item, index) => ({
    seq: index + 1,
    timestamp: "",
    item,
  }));
  const window = selectTimelineWindowByProjectedLimit({
    rows,
    direction: input.direction,
    limit: input.limit,
  });
  return {
    items: window.selectedRows.map((row) => row.item),
    totalProjected: window.totalProjected,
    shownProjected: window.projectedEntries.length,
  };
}
