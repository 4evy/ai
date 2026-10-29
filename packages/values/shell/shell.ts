// POSIX single quotes preserve every byte except NUL, which argv cannot carry
export function quotePosixArgument(value: string): string {
  if (value.includes("\0")) throw new Error("Shell arguments cannot contain NUL");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
