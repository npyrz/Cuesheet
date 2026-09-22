import type { PendingMemory } from "@cuesheet/core";
import type { MemoryApproval } from "./api/client.js";

export interface MemoryDraft {
  id: string;
  title: string;
  body: string;
  tags: string;
  projects: string;
}

export function memoryDraft(memory: PendingMemory): MemoryDraft {
  return {
    id: memory.suggestedId ?? "",
    title: memory.title,
    body: memory.body,
    tags: memory.tags.join(", "),
    projects: memory.projects.join(", "),
  };
}

export function memoryApproval(draft: MemoryDraft): MemoryApproval {
  return {
    id: draft.id.trim(),
    title: draft.title.trim(),
    body: draft.body.trim(),
    tags: commaList(draft.tags),
    projects: commaList(draft.projects),
  };
}

export function commaList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== ""),
    ),
  ];
}
