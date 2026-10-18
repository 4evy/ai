import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { assertNativeApplication } from "./applications";

const PRIVATE_SESSION_VARIABLES = [
  "DISPLAY",
  "XDG_ACTIVATION_TOKEN",
  "DESKTOP_STARTUP_ID",
  "WAYLAND_SOCKET",
] as const;

const WAYLAND_ENVIRONMENT = {
  GDK_BACKEND: "wayland",
  QT_QPA_PLATFORM: "wayland",
  MOZ_ENABLE_WAYLAND: "1",
};

export function prepareLaunch(
  id: string,
  used: boolean,
  argv: string[],
  environment: Record<string, string>,
  cwd: string,
  invocation: Gio.DBusMethodInvocation,
  fds: number[],
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ||
    used ||
    argv.length === 0
  )
    throw new Error("Invalid or reused workspace lease");
  assertNativeApplication(argv);
  const helper = workspaceHelper(environment);
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE });
  try {
    configure(launcher, environment, cwd);
    transferDescriptors(launcher, invocation, fds);
    return { launcher, arguments: [helper, "workspace", "child", id, "--", ...argv] };
  } catch (error) {
    launcher.close();
    throw error;
  }
}

function workspaceHelper(environment: Record<string, string>): string {
  const helper = environment.FARSTEP_WORKSPACE_HELPER;
  if (
    !helper ||
    !GLib.path_is_absolute(helper) ||
    !GLib.file_test(helper, GLib.FileTest.IS_EXECUTABLE)
  )
    throw new Error("Rust workspace helper executable is required");
  return helper;
}

function configure(
  launcher: Gio.SubprocessLauncher,
  environment: Record<string, string>,
  cwd: string,
): void {
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error("Invalid environment variable");
    launcher.setenv(key, value, true);
  }
  for (const key of PRIVATE_SESSION_VARIABLES) launcher.unsetenv(key);
  for (const [key, value] of Object.entries(WAYLAND_ENVIRONMENT))
    launcher.setenv(key, value, true);
  if (cwd) launcher.set_cwd(cwd);
}

function transferDescriptors(
  launcher: Gio.SubprocessLauncher,
  invocation: Gio.DBusMethodInvocation,
  fds: number[],
): void {
  if (fds.length) {
    if (fds.length !== 3)
      throw new Error("Expected stdin, stdout and stderr descriptors");
    const list = invocation.get_message().get_unix_fd_list();
    if (!list) throw new Error("Missing file descriptors");
    for (const [index, fd] of fds.entries()) launcher.take_fd(list.get(fd), index);
  }
}
