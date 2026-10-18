import { dirname, join } from "node:path";
import { attempt, run } from "@ai/core/effect/effect";
import { exec } from "@oh-my-pi/pi-utils/ptree";
import { Effect } from "effect";
import { paths } from "#farstep/runtime/state";
export const commandEffect = Effect.fnUntraced(function* (
  argv: string[],
  allowFailure: boolean,
) {
  const runtime = dirname(paths().runtime);
  if (argv[0] === "systemctl") {
    const packagePath = process.env.FARSTEP_PACKAGE_PATH;
    const actionIndex = argv.findIndex(
      (argument, index) => index > 0 && !argument.startsWith("-"),
    );
    argv = [
      packagePath ? join(packagePath, "bin/farstep-desktop") : "farstep-desktop",
      "systemd",
      ...argv
        .slice(1)
        .flatMap((argument, index) =>
          index + 1 === actionIndex &&
          [
            "show-environment",
            "is-active",
            "is-enabled",
            "daemon-reload",
            "try-restart",
          ].includes(argument)
            ? argument.split("-")
            : [argument],
        ),
    ];
  }
  const {
    exitCode: code,
    stdout,
    stderr,
  } = yield* attempt(
    (signal) =>
      exec(argv, {
        signal,
        allowNonZero: true,
        stderr: "full",
        env: {
          ...process.env,
          XDG_RUNTIME_DIR: runtime,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtime, "bus")}`,
        },
      }),
    { awaitOnInterrupt: true },
  );
  if (code !== 0 && !allowFailure)
    return yield* Effect.fail(
      new Error(`${argv[0]} ${argv[1] ?? ""} failed (${code}): ${stderr.trim()}`),
    );
  return { code, stdout, stderr };
});

export function command(argv: string[], allowFailure = false) {
  return run(commandEffect(argv, allowFailure));
}
