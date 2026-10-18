import Gio from "gi://Gio";
import GLib from "gi://GLib";

declare const ARGV: string[];
const [helper, resources] = ARGV;
if (!helper || !resources) throw new Error("Usage: nested/main.js HELPER RESOURCES");
const runtime = GLib.get_user_runtime_dir();
const directory = `${runtime}/farstep/nested-${GLib.uuid_string_random().slice(0, 12)}`;
if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
  throw new Error("Cannot create the private nested desktop directory");
const ready = `${directory}/ready.json`;
const ipc = `${runtime}/farstep/sway-${GLib.uuid_string_random().slice(0, 12)}.sock`;
if (new TextEncoder().encode(ipc).length > 107)
  throw new Error(
    "Nested desktop runtime directory exceeds the Unix socket path limit",
  );
const swayConfig = `${directory}/sway.conf`;
const routing = `${directory}/routing.conf`;
const [, routingBytes] = GLib.file_get_contents(`${resources}/native/workspaces.conf`);
GLib.file_set_contents(
  routing,
  new TextDecoder()
    .decode(routingBytes)
    .replaceAll("@PACKAGE@", GLib.path_get_dirname(GLib.path_get_dirname(resources))),
);
GLib.file_set_contents(
  swayConfig,
  [
    `include ${JSON.stringify(routing)}`,
    "xwayland disable",
    "output HEADLESS-1 mode 1280x720@60Hz scale 1",
    "output HEADLESS-1 background #202020 solid_color",
    'workspace "Farstep home"',
    `exec ${GLib.shell_quote(GLib.find_program_in_path("gjs") ?? "gjs")} -m ${GLib.shell_quote(`${resources}/nested/ready.js`)} ${GLib.shell_quote(ready)}`,
  ].join("\n"),
);

const children: Gio.Subprocess[] = [];
const running = new Set<Gio.Subprocess>();
let stopped = false;
let failed = false;
const loop = new GLib.MainLoop(null, false);
const shutdown = () => {
  if (stopped) return GLib.SOURCE_REMOVE;
  stopped = true;
  loop.quit();
  return GLib.SOURCE_REMOVE;
};
const spawn = (argv: string[], environment: Record<string, string> = {}) => {
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE });
  try {
    for (const [key, value] of Object.entries(environment))
      launcher.setenv(key, value, true);
    launcher.unsetenv("DISPLAY");
    launcher.unsetenv("WAYLAND_SOCKET");
    launcher.unsetenv("XDG_ACTIVATION_TOKEN");
    launcher.unsetenv("DESKTOP_STARTUP_ID");
    const child = launcher.spawnv(argv);
    children.push(child);
    running.add(child);
    child.wait_async(null, (_process, result) => {
      child.wait_finish(result);
      running.delete(child);
      if (!stopped) {
        failed = true;
        console.error(`Nested desktop process exited: ${argv[0]}`);
        shutdown();
      }
    });
    return child;
  } finally {
    launcher.close();
  }
};
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
const waitFor = async (ready: () => boolean, message: string, attempts = 100) => {
  for (let attempt = 0; !ready(); attempt++) {
    if (stopped || attempt === attempts) throw new Error(message);
    await sleep(50);
  }
};
const waitForExit = (child: Gio.Subprocess) =>
  new Promise<void>((resolve) => child.wait_async(null, () => resolve()));

const read = (path: string) => {
  const [, bytes] = GLib.file_get_contents(path);
  return new TextDecoder().decode(bytes);
};
const processStartTime = (pid: number) => {
  const startTime = read(`/proc/${pid}/stat`).split(") ")[1]?.split(" ")[19];
  if (!startTime) throw new Error("Cannot read nested supervisor process identity");
  return startTime;
};
const executable = (variable: string, name: string) => {
  const configured = GLib.getenv(variable);
  if (configured) return configured;
  const found = GLib.find_program_in_path(name);
  if (found) return found;
  for (const base of ["/usr/libexec", "/usr/lib"])
    if (GLib.file_test(`${base}/${name}`, GLib.FileTest.IS_EXECUTABLE))
      return `${base}/${name}`;
  throw new Error(`Nested desktop requires ${name}`);
};

let broker: Gio.Subprocess | undefined;
let published = false;
const endpoint = `${runtime}/farstep/nested.json`;
const signals = await import("gi://GLibUnix");
for (const signal of [2, 15])
  signals.default.signal_add(GLib.PRIORITY_DEFAULT, signal, shutdown);
const supervisor = GLib.getenv("FARSTEP_NESTED_SUPERVISOR");
if (supervisor) {
  const pid = new Gio.Credentials().get_unix_pid();
  Gio.File.new_for_path(supervisor).replace_contents(
    JSON.stringify({
      pid,
      startTime: processStartTime(pid),
    }),
    null,
    false,
    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
    null,
  );
}
try {
  spawn([executable("FARSTEP_NESTED_SWAY", "sway"), "--config", swayConfig], {
    WLR_BACKENDS: "headless",
    WLR_RENDERER: "pixman",
    WLR_HEADLESS_OUTPUTS: "1",
    SWAYSOCK: ipc,
    XDG_CURRENT_DESKTOP: "sway",
  });
  await waitFor(
    () => GLib.file_test(ready, GLib.FileTest.IS_REGULAR),
    "Nested Sway did not start",
  );
  const { display, socket } = JSON.parse(read(ready)) as {
    display: string;
    socket: string;
  };
  const environment = {
    WAYLAND_DISPLAY: display,
    SWAYSOCK: socket,
    XDG_CURRENT_DESKTOP: "sway",
    FARSTEP_NESTED_DESKTOP: "cosmic",
    FARSTEP_WORKSPACE_RULES: routing,
    GST_REGISTRY_1_0: `${directory}/gstreamer-registry.bin`,
  };
  broker = spawn(["gjs", "-m", `${resources}/native/broker.js`], environment);
  await waitFor(
    () =>
      (
        Gio.DBus.session
          .call_sync(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "NameHasOwner",
            new GLib.Variant("(s)", ["org.farstep.Workspaces"]),
            new GLib.VariantType("(b)"),
            Gio.DBusCallFlags.NONE,
            1000,
            null,
          )
          .deep_unpack() as [boolean]
      )[0],
    "Nested workspace broker did not start",
    99,
  );
  const daemonReady = `${directory}/daemon-ready`;
  spawn([helper, "daemon"], { ...environment, FARSTEP_NESTED_READY: daemonReady });
  await waitFor(
    () => GLib.file_test(daemonReady, GLib.FileTest.IS_REGULAR),
    "Nested desktop helper did not start",
  );
  const pid = new Gio.Credentials().get_unix_pid();
  const startTime = processStartTime(pid);
  Gio.File.new_for_path(endpoint).replace_contents(
    JSON.stringify({
      pid,
      startTime,
      address: GLib.getenv("DBUS_SESSION_BUS_ADDRESS"),
      display,
      socket,
    }),
    null,
    false,
    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
    null,
  );
  published = true;
  if (!stopped) loop.run();
} finally {
  stopped = true;
  // Stop owned application scopes before removing their compositor
  if (broker && running.has(broker)) {
    broker.send_signal(15);
    const deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
      broker?.force_exit();
      return GLib.SOURCE_REMOVE;
    });
    await waitForExit(broker);
    if (GLib.MainContext.default().find_source_by_id(deadline))
      GLib.source_remove(deadline);
  }
  for (const child of running) child.send_signal(15);
  const deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
    for (const child of running) child.force_exit();
    return GLib.SOURCE_REMOVE;
  });
  await Promise.all(children.map(waitForExit));
  if (GLib.MainContext.default().find_source_by_id(deadline))
    GLib.source_remove(deadline);
  if (published && GLib.file_test(endpoint, GLib.FileTest.IS_REGULAR)) {
    const owner = JSON.parse(read(endpoint)) as { pid: number };
    if (owner.pid === new Gio.Credentials().get_unix_pid())
      Gio.File.new_for_path(endpoint).delete(null);
  }
  const remove = Gio.Subprocess.new(
    ["rm", "-rf", "--", directory],
    Gio.SubprocessFlags.NONE,
  );
  remove.wait(null);
}
if (failed) throw new Error("Nested desktop stopped unexpectedly");
