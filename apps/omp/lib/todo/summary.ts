import { flattenLine } from "@oh-my-pi/pi-tui/render";
import {
  isClosedTodo,
  type TodoItem,
  type TodoPhase,
} from "@oh-my-pi/pi-tui/tools/todo";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Counts and current work shared by the compact HUD and transcript result */
export function summarizeTodos(
  phases: readonly TodoPhase[],
  isMatched: (task: TodoItem) => boolean = () => false,
): { total: number; closed: number; blocked: number; current: string | undefined } {
  let total = 0;
  let closed = 0;
  let blocked = 0;
  let active: TodoItem | undefined;
  let pending: TodoItem | undefined;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      total++;
      if (isClosedTodo(task)) closed++;
      if (task.status === "blocked") blocked++;
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
    blocked,
    current: current ? flattenLine(sanitizeText(current.content)) : undefined,
  };
}
