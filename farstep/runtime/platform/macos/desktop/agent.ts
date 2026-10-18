import { Record as Records, Struct } from "effect";
import { build, parse } from "plist";
import * as v from "valibot";

export const label = "org.farstep.desktop";
const marker = "<!-- Farstep desktop -->";
const agentSchema = v.object({
  Label: v.literal(label),
  ProgramArguments: v.tuple([v.string(), v.literal("daemon")]),
});

export function ownsAgent(text: string, executables: readonly string[]): boolean {
  if (!text.includes(marker)) return false;
  try {
    const agent = v.parse(agentSchema, parse(text));
    return executables.includes(agent.ProgramArguments[0]);
  } catch {
    return false;
  }
}

export function buildAgent(
  executable: string,
  log: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const variables = Records.filter(
    Struct.pick(environment, ["HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]),
    (value): value is string => Boolean(value),
  );
  return `${build({
    Label: label,
    ProgramArguments: [executable, "daemon"],
    EnvironmentVariables: variables,
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: "Interactive",
    StandardErrorPath: log,
  }).replace("?>", `?>\n${marker}`)}\n`;
}
