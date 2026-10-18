import xml from "./protocol.xml" with { type: "text" };
export const PATH = "/org/farstep/Workspaces";
export const SOURCE_HASH = "@SOURCE_HASH@";
export const XML = xml;

export type LaunchArguments = [
  string,
  string[],
  Record<string, string>,
  string,
  number[],
];
export type OpenArguments = [string, string, string, Record<string, string>];

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
