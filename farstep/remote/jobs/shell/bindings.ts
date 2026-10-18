import { recordSchema } from "@ai/core/schema/input";
import { quotePosixArgument } from "@ai/core/shell/shell";
import * as v from "valibot";
import { identifierSchema, textSchema } from "./values";

export const MAX_ENVIRONMENT_VARIABLES = 64;
export const MAX_ENVIRONMENT_VALUE_LENGTH = 32768;

const environmentValueSchema = v.nullable(
  v.pipe(textSchema, v.maxLength(MAX_ENVIRONMENT_VALUE_LENGTH)),
);
export const environmentSchema = v.pipe(
  recordSchema(identifierSchema, environmentValueSchema),
  v.maxEntries(
    MAX_ENVIRONMENT_VARIABLES,
    `At most ${MAX_ENVIRONMENT_VARIABLES} variables are allowed`,
  ),
);

function clearBinding(name: string, shell: "bash" | "zsh"): string {
  v.parse(identifierSchema, name);
  const commands: string[] = [];
  if (shell === "bash") {
    // Unsetting a nameref directly would unset its target, not its attributes
    commands.push(
      `if [[ $(builtin declare -p ${name} 2>/dev/null) == 'declare -'*n*' '* ]]; then builtin unset -n ${name} || exit $?; fi`,
    );
  }
  commands.push(`builtin unset -v ${name} || exit $?`);
  return commands.join("\n");
}

export function assignBinding(
  name: string,
  expression: string,
  shell: "bash" | "zsh",
  options: { array?: boolean; exported?: boolean } = {},
): string {
  const commands = [clearBinding(name, shell)];
  if (shell === "zsh") {
    // Special parameters retain types after unset; fail before arithmetic evaluation
    commands.push(`builtin typeset +i +F +E +a +A +l +u +L +R +Z ${name} || exit $?`);
  }
  if (options.array) commands.push(`builtin typeset -a ${name} || exit $?`);
  commands.push(`${name}=${options.array ? `(${expression})` : expression} || exit $?`);
  if (options.exported) commands.push(`builtin export ${name} || exit $?`);
  return commands.join("\n");
}

export function compileEnvironment(input: unknown, shell: "bash" | "zsh"): string[] {
  return Object.entries(v.parse(environmentSchema, input)).map(([name, value]) =>
    value === null
      ? clearBinding(name, shell)
      : assignBinding(name, quotePosixArgument(value), shell, { exported: true }),
  );
}
