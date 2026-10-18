import { join } from "node:path";

export async function systemLocations() {
  if (process.platform === "win32") {
    const { powershell } = await import("../platform/windows/state/state");
    const owner = await powershell(
      "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    );
    if (!/^S-1-[0-9-]+$/u.test(owner)) throw new Error("Invalid Windows account SID");
    const programData = process.env.ProgramData;
    if (!programData) throw new Error("ProgramData is missing");
    return {
      owner,
      uid: null,
      endpoint: `\\\\.\\pipe\\farstep-system-${owner}`,
      executable: join(
        programData,
        "Farstep",
        `service-${owner}`,
        "farstep-service.exe",
      ),
    };
  }
  const uid = process.getuid?.();
  if (!uid || !["linux", "darwin"].includes(process.platform))
    throw new Error(
      "Farstep system access requires a non-root Linux, macOS or Windows account",
    );
  const directory =
    process.platform === "darwin"
      ? `/Library/PrivilegedHelperTools/org.farstep.service-${uid}`
      : `/var/lib/farstep/service-${uid}`;
  return {
    owner: String(uid),
    uid,
    endpoint: `/var/run/farstep-system-${uid}.sock`,
    executable: join(directory, "farstep-service"),
  };
}
