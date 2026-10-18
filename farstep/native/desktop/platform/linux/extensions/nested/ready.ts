import Gio from "gi://Gio";
import GLib from "gi://GLib";

declare const ARGV: string[];
const [destination] = ARGV;
const display = GLib.getenv("WAYLAND_DISPLAY");
const socket = GLib.getenv("SWAYSOCK");
if (!destination || !display || !socket)
  throw new Error("Nested Sway startup environment is incomplete");
Gio.File.new_for_path(destination).replace_contents(
  JSON.stringify({ display, socket }),
  null,
  false,
  Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
  null,
);
