import Gio from "gi://Gio";
import GLib from "gi://GLib";

declare const ARGV: string[];
const [hash] = ARGV;
const socket = GLib.getenv("SWAYSOCK");
if (!socket || !/^[0-9a-f]{64}$/.test(hash ?? ""))
  throw new Error("Sway routing readiness identity is missing");
const connection = new Gio.SocketClient({ timeout: 5 }).connect(
  new Gio.UnixSocketAddress({ path: socket }),
  null,
);
try {
  const peer = connection.get_socket().get_credentials();
  const uid = new Gio.Credentials().get_unix_user();
  if (peer.get_unix_user() !== uid)
    throw new Error("Sway IPC owner differs from this user");
  const pid = peer.get_unix_pid();
  const [, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
  const startTime = new TextDecoder().decode(bytes).split(") ")[1]?.split(" ")[19];
  const directory = `${GLib.get_user_runtime_dir()}/farstep`;
  if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
    throw new Error("Cannot create workspace readiness directory");
  const file = Gio.File.new_for_path(directory);
  const info = file.query_info(
    "standard::type,unix::uid,unix::mode",
    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
    null,
  );
  if (
    info.get_file_type() !== Gio.FileType.DIRECTORY ||
    info.get_attribute_uint32("unix::uid") !== uid ||
    (info.get_attribute_uint32("unix::mode") & 0o077) !== 0
  )
    throw new Error("Workspace readiness directory is not private and owned");
  file
    .get_child("sway-routing.json")
    .replace_contents(
      JSON.stringify({ hash, socket, pid, startTime }),
      null,
      false,
      Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
      null,
    );
} finally {
  connection.close(null);
}
