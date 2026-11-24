import { flattenLine } from "@oh-my-pi/pi-tui/render";
import { replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import {
  isClosedTodo,
  type TodoItem,
  todoChecklistPhases,
} from "@oh-my-pi/pi-tui/tools/todo";
import { sanitizeText } from "@oh-my-pi/pi-utils";

export interface TodoSummary {
  total: number;
  closed: number;
  current: string | undefined;
}

/** Counts and current work shared by the compact HUD and transcript result */
export function summarizeTodos(
  phases: readonly { readonly tasks: readonly TodoItem[] }[],
  isMatched: (task: TodoItem) => boolean = () => false,
): TodoSummary {
  let total = 0;
  let closed = 0;
  let active: TodoItem | undefined;
  let pending: TodoItem | undefined;
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

/** Add the latest note to each item in OMP's native checklist */
export function checklistWithNotes(
  phases: Parameters<typeof todoChecklistPhases>[0],
  isMatched?: Parameters<typeof todoChecklistPhases>[1],
) {
  const checklist = todoChecklistPhases(phases, isMatched);
  for (const [p, phase] of checklist.entries()) {
    for (const [t, item] of phase.items.entries()) {
      // The native builder emits exactly one item per task in source order
      const note = phases[p]?.tasks[t]?.notes?.at(-1);
      if (note !== undefined) item.note = replaceTabs(sanitizeText(note));
    }
  }
  return checklist;
}
