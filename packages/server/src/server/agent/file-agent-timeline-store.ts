import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineSnapshot,
  AgentTimelineSnapshotOptions,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";

const TimelineRowSchema: z.ZodType<AgentTimelineRow, unknown> = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  item: AgentTimelineItemPayloadSchema,
  turnId: z.string().optional(),
  providerMessageId: z.string().optional(),
});

const TimelineDocumentSchema = z.object({
  version: z.literal(1),
  epoch: z.string(),
  nextSeq: z.number().int().positive(),
  rows: z.array(TimelineRowSchema),
  // Documents written before history completeness existed are intentionally incomplete.
  historyComplete: z.boolean().optional().default(false),
});
const TimelineDocumentEnvelopeSchema = TimelineDocumentSchema.extend({
  rows: z.array(z.unknown()),
});

type TimelineDocument = z.infer<typeof TimelineDocumentSchema>;

export interface FileAgentTimelineStoreOptions {
  writeJson?: (filePath: string, value: TimelineDocument) => Promise<void>;
}

function shareRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row };
}

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row, item: structuredClone(row.item) };
}

function cloneDocument(document: TimelineDocument): TimelineDocument {
  return { ...document, rows: document.rows.map(shareRow) };
}

function assertDocumentInvariants(document: TimelineDocument): void {
  let previousSeq = 0;
  for (const row of document.rows) {
    if (row.seq <= previousSeq) {
      throw new Error("Timeline rows must have strictly increasing sequence numbers");
    }
    previousSeq = row.seq;
  }
  if (document.nextSeq <= previousSeq) {
    throw new Error("Timeline nextSeq must be greater than every row sequence number");
  }
}

function validateAndShareRow(value: unknown): AgentTimelineRow {
  const parsed = TimelineRowSchema.parse(value);
  // Zod clones successful parses. Keep the validated source item so one large
  // transcript does not remain resident as two equivalent object graphs.
  const source = value as { item: AgentTimelineItem };
  return {
    seq: parsed.seq,
    timestamp: parsed.timestamp,
    item: source.item,
    ...(parsed.turnId !== undefined ? { turnId: parsed.turnId } : {}),
    ...(parsed.providerMessageId !== undefined
      ? { providerMessageId: parsed.providerMessageId }
      : {}),
  };
}

function parseDocument(value: unknown): TimelineDocument {
  const envelope = TimelineDocumentEnvelopeSchema.parse(value);
  const rows = envelope.rows.map(validateAndShareRow);
  const document: TimelineDocument = { ...envelope, rows };
  assertDocumentInvariants(document);
  return document;
}

function emptyDocument(): TimelineDocument {
  return { version: 1, epoch: randomUUID(), nextSeq: 1, rows: [], historyComplete: false };
}

function fileNameForAgent(agentId: string): string {
  return `agent-${Buffer.from(agentId, "utf8").toString("base64url")}.json`;
}

const TIMELINE_WRITE_CHUNK_LENGTH = 1024 * 1024;

async function writeTimelineDocumentAtomic(
  filePath: string,
  document: TimelineDocument,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    let chunk = `{
  "version": 1,
  "epoch": ${JSON.stringify(document.epoch)},
  "nextSeq": ${document.nextSeq},
  "rows": [`;
    for (let index = 0; index < document.rows.length; index += 1) {
      const row = JSON.stringify(document.rows[index]!);
      const entry = `${index === 0 ? "\n" : ",\n"}    ${row}`;
      if (chunk.length > 0 && chunk.length + entry.length > TIMELINE_WRITE_CHUNK_LENGTH) {
        await handle.writeFile(chunk, "utf8");
        chunk = "";
      }
      chunk += entry;
    }
    chunk += `
  ],
  "historyComplete": ${document.historyComplete}
}
`;
    await handle.writeFile(chunk, "utf8");
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

function selectRows(
  document: TimelineDocument,
  options?: AgentTimelineFetchOptions,
): AgentTimelineFetchResult {
  const memory = new InMemoryAgentTimelineStore();
  memory.initialize("timeline", document);
  return memory.fetch("timeline", options);
}

/** Durable canonical timeline rows, isolated as one atomic document per agent. */
export class FileAgentTimelineStore implements AgentTimelineStore {
  private readonly documents = new Map<string, TimelineDocument>();
  private readonly loading = new Map<string, Promise<TimelineDocument>>();
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly writeJson: (filePath: string, value: TimelineDocument) => Promise<void>;

  constructor(
    private readonly directory: string,
    options?: FileAgentTimelineStoreOptions,
  ) {
    this.writeJson = options?.writeJson ?? writeTimelineDocumentAtomic;
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; turnId?: string },
  ): Promise<AgentTimelineRow> {
    return this.mutate(agentId, (document) => {
      const row = TimelineRowSchema.parse({
        seq: document.nextSeq,
        timestamp: options?.timestamp ?? new Date().toISOString(),
        item,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
      });
      document.rows.push(row);
      document.nextSeq += 1;
      return cloneRow(row);
    });
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    return selectRows(await this.getDocument(agentId), options);
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    return (await this.getDocument(agentId)).rows.at(-1)?.seq ?? 0;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    return (await this.getDocument(agentId)).rows.map(cloneRow);
  }

  async getCommittedSnapshot(
    agentId: string,
    options?: AgentTimelineSnapshotOptions,
  ): Promise<AgentTimelineSnapshot> {
    const document = await this.getDocument(agentId);
    return {
      rows: document.rows.map(options?.shareItems ? shareRow : cloneRow),
      historyComplete: document.historyComplete,
    };
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const item = (await this.getDocument(agentId)).rows.at(-1)?.item;
    return item ? structuredClone(item) : null;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const rows = (await this.getDocument(agentId)).rows;
    const chunks: string[] = [];
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const item = rows[index]!.item;
      if (item.type !== "assistant_message") {
        if (chunks.length > 0) break;
        continue;
      }
      chunks.push(item.text);
    }
    return chunks.length > 0 ? chunks.toReversed().join("") : null;
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.runMutation(agentId, async () => {
      await fs.rm(this.filePath(agentId), { force: true });
      this.documents.delete(agentId);
    });
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    await this.runMutation(agentId, async () => {
      const current = await this.getDocument(agentId);
      const proposed = cloneDocument(current);
      let changed = false;
      for (const row of rows) {
        const validated = validateAndShareRow(row);
        const existing = proposed.rows.find((candidate) => candidate.seq === validated.seq);
        if (existing) {
          if (!isDeepStrictEqual(existing, validated)) {
            throw new Error(`Conflicting timeline row sequence ${validated.seq}`);
          }
          continue;
        }
        proposed.rows.push(validated);
        changed = true;
      }
      if (!changed) return;
      proposed.rows.sort((left, right) => left.seq - right.seq);
      const maxSeq = proposed.rows.at(-1)?.seq ?? 0;
      proposed.nextSeq = Math.max(proposed.nextSeq, maxSeq + 1);
      assertDocumentInvariants(proposed);
      await this.writeJson(this.filePath(agentId), proposed);
      this.documents.set(agentId, proposed);
    });
  }

  async replaceCommittedSnapshot(agentId: string, snapshot: AgentTimelineSnapshot): Promise<void> {
    await this.runMutation(agentId, async () => {
      const current = await this.getDocument(agentId);
      const rows = snapshot.rows.map(validateAndShareRow);
      const nextSeq = (rows.at(-1)?.seq ?? 0) + 1;
      const proposed: TimelineDocument = {
        version: 1,
        epoch: current.epoch,
        nextSeq,
        rows,
        historyComplete: snapshot.historyComplete,
      };
      assertDocumentInvariants(proposed);
      await this.writeJson(this.filePath(agentId), proposed);
      this.documents.set(agentId, proposed);
    });
  }

  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    await this.mutate(agentId, (document) => {
      const parsed = TimelineRowSchema.parse(row);
      const index = document.rows.findIndex((candidate) => candidate.seq === parsed.seq);
      if (index < 0) {
        throw new Error(`Cannot update missing timeline row sequence ${parsed.seq}`);
      }
      document.rows[index] = parsed;
    });
  }

  private async mutate<T>(
    agentId: string,
    mutation: (document: TimelineDocument) => T,
  ): Promise<T> {
    return this.runMutation(agentId, async () => {
      const current = await this.getDocument(agentId);
      const proposed = cloneDocument(current);
      const result = mutation(proposed);
      assertDocumentInvariants(proposed);
      await this.writeJson(this.filePath(agentId), proposed);
      this.documents.set(agentId, proposed);
      return result;
    });
  }

  private async getDocument(agentId: string): Promise<TimelineDocument> {
    const cached = this.documents.get(agentId);
    if (cached) return cached;
    let load = this.loading.get(agentId);
    if (!load) {
      load = this.loadDocument(agentId);
      this.loading.set(agentId, load);
    }
    try {
      const document = await load;
      this.documents.set(agentId, document);
      return document;
    } finally {
      if (this.loading.get(agentId) === load) this.loading.delete(agentId);
    }
  }

  private async loadDocument(agentId: string): Promise<TimelineDocument> {
    try {
      return parseDocument(JSON.parse(await fs.readFile(this.filePath(agentId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
      throw error;
    }
  }

  private async runMutation<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(agentId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.mutationTails.set(agentId, tail);
    void tail.finally(() => {
      if (this.mutationTails.get(agentId) === tail) this.mutationTails.delete(agentId);
    });
    return result;
  }

  private filePath(agentId: string): string {
    return path.join(this.directory, fileNameForAgent(agentId));
  }
}
