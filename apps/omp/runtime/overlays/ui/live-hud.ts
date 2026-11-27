import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/task/session-observer-registry";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import { type Accessor, type JSXNode, signal } from "@oh-my-pi/pi-tui";

export interface LiveHudAgents {
  readonly sessions: readonly ObservableSession[];
  readonly agentsMode: "off" | "collapsed" | "full";
  readonly agentsExpanded: boolean;
  readonly agentsHubKey: string;
}

/** Host snapshots for presentation only, never session mutation */
export interface LiveHudState extends LiveHudAgents {
  readonly phases: readonly TodoPhase[];
  readonly activeDescriptions: readonly string[];
  readonly todoHidden: boolean;
  readonly todoExpanded: boolean;
}

export interface LiveHudPresentation {
  readonly todo?: JSXNode;
  readonly checklist?: JSXNode;
  /** Null suppresses the stock list when the agents share the todo row */
  readonly subagents?: Exclude<JSXNode, undefined>;
}

/** Undefined results retain the host's stock presentation */
export interface LiveHudRenderer {
  readonly showWorkingTitle?: boolean;
  readonly compactTodoInStatus?: boolean;
  render(state: LiveHudState): LiveHudPresentation | undefined;
}

const renderer = signal<LiveHudRenderer | undefined>(undefined);

export const getLiveHudRenderer: Accessor<LiveHudRenderer | undefined> = renderer;

export function setLiveHudRenderer(next: LiveHudRenderer | undefined): void {
  renderer.set(next);
}

const activeDescriptions = signal<readonly string[]>([]);

export const getLiveHudTodoDescriptions: Accessor<readonly string[]> =
  activeDescriptions;

export function setLiveHudTodoDescriptions(descriptions: readonly string[]): void {
  const current = activeDescriptions.peek();
  if (
    current.length === descriptions.length &&
    current.every((text, i) => text === descriptions[i])
  )
    return;
  activeDescriptions.set(descriptions);
}
