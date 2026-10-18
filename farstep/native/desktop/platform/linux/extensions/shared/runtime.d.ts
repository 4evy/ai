declare module "gi://GLibUnix" {
  import type GLib from "gi://GLib";

  const GLibUnix: {
    signal_add(priority: number, signal: number, callback: GLib.SourceFunc): number;
  };
  export default GLibUnix;
}
