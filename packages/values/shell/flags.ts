export function shellFlags(
  shell: "bash" | "zsh",
  login: boolean | undefined,
): string[] {
  const flags =
    shell === "bash"
      ? login
        ? ["--login"]
        : ["--noprofile", "--norc"]
      : login
        ? ["-l"]
        : ["-f"];
  return flags;
}
