import { join } from "node:path";
import { root, run, writeJson } from "./process";

export async function updateFlake(): Promise<void> {
  const path = join(root, "flake.lock");
  const lock = await Bun.file(path).json();
  const pin = lock.nodes.nixpkgs;
  if (
    pin?.original?.url !==
      "https://hydra.nixos.org/job/nixpkgs/unstable/tarball/latest/download/3/nixexprs.tar.zst" ||
    pin.locked?.url !== pin.original.url
  )
    return;
  const response = await fetch(pin.original.url, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  const location = response.headers.get("location");
  if (
    response.status !== 302 ||
    !location ||
    !/^https:\/\/hydra\.nixos\.org\/build\/\d+\/download\/3\/nixexprs\.tar\.zst$/.test(
      location,
    )
  )
    throw new Error("Hydra did not resolve the Nixpkgs input to an immutable build");
  const metadata = JSON.parse(
    await run(["nix", "flake", "metadata", "--json", "--no-write-lock-file", location]),
  );
  if (metadata.locked?.url !== location || !metadata.locked.narHash)
    throw new Error("Nix did not return a locked Hydra archive");
  pin.locked = metadata.locked;
  await writeJson(path, lock);
}
