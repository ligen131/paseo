import { z } from "zod";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";

const ClaudeInformationalLevelSchema = z.enum(["info", "notice", "suggestion", "warning"]);

const ClaudeInformationalMessageSchema = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("informational"),
    content: z.string(),
    level: ClaudeInformationalLevelSchema,
    uuid: z.string().min(1),
    tool_use_id: z.string().min(1).optional(),
    prevent_continuation: z.boolean().optional(),
  })
  .passthrough();

const INFORMATIONAL_LABELS: Record<z.infer<typeof ClaudeInformationalLevelSchema>, string> = {
  info: "Claude information",
  notice: "Claude notice",
  suggestion: "Claude suggestion",
  warning: "Claude warning",
};

type ClaudeInformationalToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

export function mapClaudeInformationalToToolCall(
  message: unknown,
): ClaudeInformationalToolCallItem | null {
  const parsed = ClaudeInformationalMessageSchema.safeParse(message);
  if (!parsed.success) {
    return null;
  }

  const informational = parsed.data;
  // Keep the wire shape compatible with older apps; current apps project this source to a system row.
  return {
    type: "tool_call",
    callId: `claude_informational_${informational.uuid}`,
    name: "claude_informational",
    status: "completed",
    error: null,
    detail: {
      type: "plain_text",
      label: INFORMATIONAL_LABELS[informational.level],
      text: informational.content,
    },
    metadata: {
      synthetic: true,
      source: "claude_informational",
      level: informational.level,
      ...(informational.tool_use_id ? { toolUseId: informational.tool_use_id } : {}),
      ...(informational.prevent_continuation !== undefined
        ? { preventContinuation: informational.prevent_continuation }
        : {}),
    },
  };
}
