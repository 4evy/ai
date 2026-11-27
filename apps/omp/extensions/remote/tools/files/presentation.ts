import type { OutputMeta } from "@oh-my-pi/pi-coding-agent/tools/output-meta-format";
import type {
  ToolPresenter,
  ToolResult,
  ToolView,
  ToolViewState,
} from "@oh-my-pi/pi-coding-agent/ui/tools/contract";
import { isRecord } from "@oh-my-pi/pi-utils";

export interface FileDetails {
  connectionId?: string;
  path?: string;
  resolvedPath?: string;
  displayTarget?: string;
  meta?: OutputMeta;
  sha256?: string | undefined;
  bytes?: number;
  fileSize?: number;
  isDirectory?: boolean;
  totalEntries?: number;
  offset?: number;
  truncated?: boolean;
}

interface RemoteFileArgs {
  content: unknown;
  path: string | undefined;
  oldText: unknown;
  newText: unknown;
}

function remoteArgs(input: unknown, details?: FileDetails): RemoteFileArgs {
  const args = isRecord(input) ? input : {};
  const path = details?.path ?? args.path;
  const connection = details?.connectionId ?? args.connection;
  // Qualified paths identify the remote machine in native file views
  const display =
    typeof path === "string"
      ? `${typeof connection === "string" ? connection : "SSH"}:${path}`
      : undefined;
  return {
    content: args.content,
    path:
      display === undefined
        ? undefined
        : `${display}${typeof args.selector === "string" ? `:${args.selector}` : ""}`,
    oldText: args.old_string,
    newText: args.new_string,
  };
}

// A qualified remote path is a display label, never a local file link
function withoutLocalLinks(view: ToolView | undefined): ToolView | undefined {
  if (!view) return undefined;
  const { head, term } = view;
  const edit = term?.edit;
  const { href: _href, ...localFreeHead } = head ?? {};
  return {
    ...view,
    ...(head ? { head: localFreeHead } : {}),
    ...(term
      ? {
          term: {
            ...term,
            link: undefined,
            ...(isRecord(edit) && Array.isArray(edit.cards)
              ? {
                  edit: {
                    ...edit,
                    cards: edit.cards.map((card) =>
                      isRecord(card) ? { ...card, link: undefined } : card,
                    ),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

export function remoteFilePresentation<D extends FileDetails>(
  presenter: ToolPresenter<RemoteFileArgs, D>,
): { presenter: ToolPresenter<unknown, D> } {
  const viewResult = (result: ToolResult<D>, args: unknown) => {
    const { details: original, ...rest } = result;
    if (!original) return rest;
    const path = remoteArgs(args, original).path;
    const details = { ...original };
    delete details.resolvedPath;
    if (path !== undefined) {
      details.path = path;
    }
    if (details.meta) {
      details.meta = { ...details.meta };
      delete details.meta.source;
    }
    return {
      ...rest,
      details,
    };
  };
  const optionsFor = (state: ToolViewState): ToolViewState => ({
    ...state,
    renderContext: { ...state.renderContext, editMode: "replace" },
  });
  return {
    presenter: {
      ...(presenter.merge === undefined ? {} : { merge: presenter.merge }),
      ...(presenter.inline === undefined ? {} : { inline: presenter.inline }),
      ...(presenter.streamsBody === undefined
        ? {}
        : { streamsBody: presenter.streamsBody }),
      call: (args, state) =>
        withoutLocalLinks(presenter.call?.(remoteArgs(args), optionsFor(state))),
      result: (result, state, args) =>
        withoutLocalLinks(
          presenter.result?.(
            viewResult(result, args),
            optionsFor(state),
            remoteArgs(args, result.details),
          ),
        ),
    },
  };
}
