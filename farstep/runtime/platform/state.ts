import * as fs from "@ai/core/effect/fs/fs";
import * as posix from "./posix/state";
import * as windows from "./windows/state/state";

export const paths = process.platform === "win32" ? windows.paths : posix.paths;
export const privateDirectory =
  process.platform === "win32" ? windows.privateDirectory : posix.privateDirectory;
export const privateRead =
  process.platform === "win32" ? windows.privateRead : posix.privateRead;
export const atomicWrite =
  process.platform === "win32" ? windows.atomicWrite : fs.atomicWrite;
export const privateDirectoryEffect =
  process.platform === "win32"
    ? windows.privateDirectoryEffect
    : posix.privateDirectoryEffect;
export const privateReadEffect =
  process.platform === "win32" ? windows.privateReadEffect : posix.privateReadEffect;
export const atomicWriteEffect =
  process.platform === "win32" ? windows.atomicWriteEffect : fs.atomicWriteEffect;
