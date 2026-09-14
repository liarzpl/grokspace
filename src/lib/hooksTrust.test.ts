import { describe, expect, it } from "vitest";

import type { FolderTrust } from "../types";
import { hostHooksAllowed, hostHooksStatusLabel } from "./hooksTrust";

const CASES: Array<[FolderTrust | undefined, boolean, string]> = [
  [undefined, false, "Not decided — setup and project hooks stay off"],
  ["unknown", false, "Not decided — setup and project hooks stay off"],
  ["denied", false, "Denied — setup and project hooks stay off"],
  ["once", true, "Trusted until quit"],
  ["folder", true, "This folder is trusted"],
];

describe("hostHooksAllowed / hostHooksStatusLabel", () => {
  it.each(CASES)("%s → allowed %s", (trust, allowed, label) => {
    expect(hostHooksAllowed(trust)).toBe(allowed);
    expect(hostHooksStatusLabel(trust)).toBe(label);
  });
});
