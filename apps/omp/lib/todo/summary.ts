import {
  isClosedTodo,
  type TodoItem,
} from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import { flattenLine } from "@oh-my-pi/pi-tui/text/sanitize";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspChecklistItem, TspChecklistPhase } from "@oh-my-pi/pi-wire";

export interface TodoSummary {
  total: number;
  closed: number;
  current: string | undefined;
}

type SummarizedTodo = Pick<TodoItem, "content" | "status">;

/** Counts and current work shared by the compact HUD and transcript result */
export function summarizeTodos(
  phases: readonly { readonly tasks: readonly SummarizedTodo[] }[],
  isMatched: (task: SummarizedTodo) => boolean = () => false,
): TodoSummary {
  let total = 0;
  let closed = 0;
  let active: SummarizedTodo | undefined;
  let pending: SummarizedTodo | undefined;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      total++;
      if (isClosedTodo(task)) closed++;
      if (
        !active &&
        (task.status === "in_progress" ||
          (task.status === "pending" && isMatched(task)))
      )
        active = task;
      if (!pending && task.status === "pending") pending = task;
    }
  }
  const current = active ?? pending;
  return {
    total,
    closed,
    current: current ? flattenLine(sanitizeText(current.content)) : undefined,
  };
}

const CHECKLIST_STATUS: Record<TodoItem["status"], TspChecklistItem["status"]> = {
  pending: "pending",
  in_progress: "active",
  completed: "done",
  abandoned: "dropped",
};

/** Include the latest note in each checklist item and fold closed phases */
export function checklistWithNotes(
  phases: readonly { readonly name: string; readonly tasks: readonly TodoItem[] }[],
  isMatched: (task: TodoItem) => boolean = () => false,
): TspChecklistPhase[] {
  return phases.map((phase, p) => ({
    id: `p${p}`,
    title: replaceTabs(sanitizeText(phase.name)),
    items: phase.tasks.map((task, t) => {
      const note = task.notes?.at(-1);
      return {
        id: `p${p}.${t}`,
        text: replaceTabs(sanitizeText(task.content)),
        status:
          task.status === "pending" && isMatched(task)
            ? "active"
            : CHECKLIST_STATUS[task.status],
        ...(note !== undefined && { note: replaceTabs(sanitizeText(note)) }),
      };
    }),
    collapsed: phase.tasks.length > 0 && phase.tasks.every(isClosedTodo),
  }));
}
