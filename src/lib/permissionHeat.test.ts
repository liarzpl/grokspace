import { describe, expect, it } from "vitest";

import { heatBadgeLabel } from "./permissionHeat";

describe("heatBadgeLabel", () => {
  it("is a count, not a trust colour", () => {
    expect(heatBadgeLabel(0)).toBe("");
    expect(heatBadgeLabel(1)).toBe("1 permission answer");
    expect(heatBadgeLabel(2)).toBe("2 permission answers");
    expect(heatBadgeLabel(2)).not.toMatch(/allow|deny|trusted|always/i);
  });
});
