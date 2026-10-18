import GLib from "gi://GLib";
import { runBroker } from "../shared/broker";
import { ManagedLeases } from "../shared/leases/leases";
import { HyprlandRouter } from "./hyprland";
import { NiriRouter } from "./niri";
import { SwayRouter } from "./sway";

const desktop = (GLib.getenv("XDG_CURRENT_DESKTOP") ?? "").toLowerCase().split(":");
const routers = [
  ["sway", () => new SwayRouter()],
  ["niri", () => new NiriRouter()],
] as const;
const createRouter =
  routers.find(([name]) => desktop.includes(name))?.[1] ?? (() => new HyprlandRouter());
await runBroker(
  (manager) => new ManagedLeases(manager, createRouter()),
  undefined,
  true,
);
