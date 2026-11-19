import type { Component } from "@oh-my-pi/pi-tui";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { ObservableSession } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import type { TodoItem } from "@oh-my-pi/pi-tui/tools/todo";

export interface LiveHudTodoPhase {
  readonly name: string;
  readonly tasks: readonly Readonly<TodoItem>[];
}

/** Host snapshots for presentation only, never session mutation */
export interface LiveHudState {
  readonly phases: readonly LiveHudTodoPhase[];
  readonly activeDescriptions: readonly string[];
  readonly sessions: readonly Readonly<ObservableSession>[];
  readonly todoHidden: boolean;
  readonly todoExpanded: boolean;
  readonly agentsMode: "off" | "collapsed" | "full";
  readonly agentsExpanded: boolean;
  readonly shortcuts: {
    readonly agentsHub: string;
  };
}

export interface LiveTodoHud {
  readonly component: Component;
  readonly native: {
    readonly checklist: NativeNode;
    readonly fallback: NativeNode;
  };
}

export interface LiveSubagentHud {
  /** Stable presentation key, so unchanged observer updates need no repaint */
  readonly key: string;
  readonly component?: Component;
  readonly mergedWithTodo?: boolean;
}

/** Undefined results retain the host's stock presentation */
export interface LiveHudRenderer {
  readonly showWorkingTitle?: boolean;
  readonly compactTodoInStatus?: boolean;
  renderTodo?(state: LiveHudState): LiveTodoHud | undefined;
  renderSubagents?(state: LiveHudState): LiveSubagentHud | undefined;
}

let renderer: LiveHudRenderer | undefined;
const listeners = new Set<() => void>();

export function setLiveHudRenderer(next: LiveHudRenderer | undefined): void {
  if (renderer === next) return;
  renderer = next;
  for (const listener of listeners) listener();
}

export function getLiveHudRenderer(): LiveHudRenderer | undefined {
  return renderer;
}

export function onLiveHudRendererChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
