import type { FolderTrust } from "../types";

/** Host gate: setup and project hooks stay off until Trust once or Trust this folder. */
export function hostHooksAllowed(trust: FolderTrust | undefined): boolean {
  return trust === "once" || trust === "folder";
}

export function hostHooksStatusLabel(trust: FolderTrust | undefined): string {
  switch (trust) {
    case "folder":
      return "This folder is trusted";
    case "once":
      return "Trusted until quit";
    case "denied":
      return "Denied — setup and project hooks stay off";
    default:
      return "Not decided — setup and project hooks stay off";
  }
}
