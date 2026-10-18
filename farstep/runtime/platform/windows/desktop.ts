import { powershell } from "./state/state";

export async function desktopEndpoint() {
  const sid = await powershell(
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  );
  if (!/^S-1-[0-9-]+$/u.test(sid)) throw new Error("Invalid Windows account SID");
  return `\\\\.\\pipe\\farstep-desktop-${sid}`;
}
