import { readGuide } from "@ai/toolkit/guide/guide";
import { TERMINAL_KEYS } from "../../client/terminal/keys/keys";
import { MAX_FILE_BYTES } from "../../protocol/files/files";
import { DEFAULT_CAPTURE_BYTES } from "../../protocol/script/script";
import {
  SYSTEM_MAX_TIMEOUT_SECONDS,
  SYSTEM_OUTPUT_BYTES,
  SYSTEM_TIMEOUT_SECONDS,
} from "../../protocol/system";
import { JOB_ACTIONS } from "../jobs/actions";
import { REMOTE_TOOLS } from "../tools/names";
import { EXAMPLES } from "./examples";

export const TOPICS = {
  start: {
    tools: [
      REMOTE_TOOLS.run,
      REMOTE_TOOLS.batch,
      REMOTE_TOOLS.job,
      REMOTE_TOOLS.scratch,
      REMOTE_TOOLS.coordination,
    ],
    text: readGuide(new URL("./start.md", import.meta.url), {}, REMOTE_TOOLS),
  },
  coordination: {
    tools: [REMOTE_TOOLS.coordination],
    text: readGuide(
      new URL("./coordination.md", import.meta.url),
      EXAMPLES.coordination,
      REMOTE_TOOLS,
    ),
  },
  scratch: {
    tools: [
      REMOTE_TOOLS.scratch,
      REMOTE_TOOLS.run,
      REMOTE_TOOLS.job,
      REMOTE_TOOLS.read,
      REMOTE_TOOLS.write,
    ],
    text: readGuide(
      new URL("./scratch.md", import.meta.url),
      EXAMPLES.scratch,
      REMOTE_TOOLS,
    ),
  },
  connect: {
    tools: [REMOTE_TOOLS.connect],
    text: readGuide(
      new URL("./connect.md", import.meta.url),
      EXAMPLES.connect,
      REMOTE_TOOLS,
    ),
  },
  helper: {
    tools: [REMOTE_TOOLS.helper],
    text: readGuide(
      new URL("./helper.md", import.meta.url),
      EXAMPLES.helper,
      REMOTE_TOOLS,
    ),
  },
  run: {
    tools: [REMOTE_TOOLS.run, REMOTE_TOOLS.batch],
    text: readGuide(
      new URL("./run.md", import.meta.url),
      {
        captureMiB: String(DEFAULT_CAPTURE_BYTES / 1024 / 1024),
        ...EXAMPLES.run,
      },
      REMOTE_TOOLS,
    ),
  },
  jobs: {
    tools: [REMOTE_TOOLS.job],
    text: readGuide(
      new URL("./jobs.md", import.meta.url),
      {
        jobActions: Object.keys(JOB_ACTIONS)
          .map((action) => `\`${action}\``)
          .join(", "),
        ...EXAMPLES.jobs,
      },
      REMOTE_TOOLS,
    ),
  },
  interactive: {
    tools: [REMOTE_TOOLS.run, REMOTE_TOOLS.job],
    text: readGuide(
      new URL("./interactive.md", import.meta.url),
      {
        terminalKeys: TERMINAL_KEYS,
        ...EXAMPLES.interactive,
      },
      REMOTE_TOOLS,
    ),
  },
  sudo: {
    tools: [REMOTE_TOOLS.sudo, REMOTE_TOOLS.system],
    text: readGuide(
      new URL("./sudo.md", import.meta.url),
      {
        defaultSeconds: String(SYSTEM_TIMEOUT_SECONDS),
        maximumSeconds: String(SYSTEM_MAX_TIMEOUT_SECONDS),
        outputKiB: String(SYSTEM_OUTPUT_BYTES / 1024),
        ...EXAMPLES.sudo,
      },
      REMOTE_TOOLS,
    ),
  },
  desktop: {
    tools: [REMOTE_TOOLS.desktop],
    text: readGuide(
      new URL("./desktop.md", import.meta.url),
      EXAMPLES.desktop,
      REMOTE_TOOLS,
    ),
  },
  screenshots: {
    tools: [REMOTE_TOOLS.screenshot],
    text: readGuide(
      new URL("./screenshots.md", import.meta.url),
      EXAMPLES.screenshots,
      REMOTE_TOOLS,
    ),
  },
  input: {
    tools: [REMOTE_TOOLS.input],
    text: readGuide(
      new URL("./input.md", import.meta.url),
      EXAMPLES.input,
      REMOTE_TOOLS,
    ),
  },
  files: {
    tools: [
      REMOTE_TOOLS.read,
      REMOTE_TOOLS.write,
      REMOTE_TOOLS.edit,
      REMOTE_TOOLS.delete,
    ],
    text: readGuide(
      new URL("./files.md", import.meta.url),
      {
        fileMiB: String(MAX_FILE_BYTES / 1024 / 1024),
        ...EXAMPLES.files,
      },
      REMOTE_TOOLS,
    ),
  },
} as const;
