import { flattenLine } from "@oh-my-pi/pi-tui/render";
import { isClosedTodo, type TodoItem } from "@oh-my-pi/pi-tui/tools/todo";
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
