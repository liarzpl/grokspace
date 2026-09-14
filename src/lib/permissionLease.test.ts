import { beforeEach, describe, expect, it } from "vitest";

import type { PermissionOption, PermissionRequest } from "../types";
import {
  grantSessionLease,
  leaseCanAutoAnswer,
  leaseLabel,
  leaseMatches,
  matchSessionLease,
  proposedLease,
  resetSessionLeases,
  syncSessionLeases,
} from "./permissionLease";

function option(overrides: Partial<PermissionOption> = {}): PermissionOption {
  return { optionId: "allow-once", name: "Allow once", kind: "allow_once", ...overrides };
}

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 1,
    summary: "Edit src/auth.ts",
    options: [
      option(),
      option({ optionId: "reject", name: "Reject", kind: "reject_once" }),
    ],
    ...overrides,
  };
}

describe("proposedLease", () => {
  it("scopes an edit to the first path prefix", () => {
    expect(proposedLease("Edit src/auth.ts")).toEqual({ tool: "Edit", prefix: "src/" });
    expect(leaseLabel({ tool: "Edit", prefix: "src/" })).toBe("Edit src/**");
  });

  it("rejects * and any Bash", () => {
    expect(proposedLease("Edit *")).toBeNull();
    expect(proposedLease("Edit **")).toBeNull();
    expect(proposedLease("Edit src/**")).toBeNull();
    expect(proposedLease("Bash npm test")).toBeNull();
    expect(proposedLease("Run `git push`")).toBeNull();
    expect(proposedLease("execute ls")).toBeNull();
    expect(proposedLease("Write a file")).toBeNull();
  });
});

describe("session lease match", () => {
  beforeEach(() => {
    resetSessionLeases();
  });

  it("matches later prompts under the same prefix", () => {
    expect(grantSessionLease("s1", { tool: "Edit", prefix: "src/" })).toBe(true);

    expect(matchSessionLease("s1", "Edit src/lib/permissions.ts")?.prefix).toBe("src/");
    expect(matchSessionLease("s1", "Edit tests/app.test.ts")).toBeUndefined();
    expect(matchSessionLease("s1", "Write src/lib/permissions.ts")).toBeUndefined();
  });

  it("refuses to grant a star or Bash lease", () => {
    expect(grantSessionLease("s1", { tool: "Edit", prefix: "*" })).toBe(false);
    expect(grantSessionLease("s1", { tool: "Bash", prefix: "src/" })).toBe(false);
    expect(matchSessionLease("s1", "Edit src/auth.ts")).toBeUndefined();
  });

  it("clears on Stop and on Restart (new id)", () => {
    expect(grantSessionLease("s1", { tool: "Edit", prefix: "src/" })).toBe(true);

    syncSessionLeases([{ id: "s1", status: "stopped" }]);
    expect(matchSessionLease("s1", "Edit src/auth.ts")).toBeUndefined();

    expect(grantSessionLease("s1", { tool: "Edit", prefix: "src/" })).toBe(true);
    syncSessionLeases([{ id: "s2", status: "running" }]);
    expect(matchSessionLease("s1", "Edit src/auth.ts")).toBeUndefined();
    expect(matchSessionLease("s2", "Edit src/auth.ts")).toBeUndefined();
  });

  it("does not match a stopped id even before sync drops the row", () => {
    expect(grantSessionLease("s1", { tool: "Edit", prefix: "src/" })).toBe(true);
    expect(
      matchSessionLease("s1", "Edit src/auth.ts", [{ id: "s1", status: "stopped" }]),
    ).toBeUndefined();
  });
});

describe("role capability leases", () => {
  beforeEach(() => {
    resetSessionLeases();
  });

  it("lets a Coder lease match src/ and refuses Reviewer rm / merge / src writes", () => {
    expect(proposedLease("Edit src/auth.ts", "Coder")).toEqual({ tool: "Edit", prefix: "src/" });
    expect(grantSessionLease("coder", { tool: "Edit", prefix: "src/" }, "Coder")).toBe(true);
    expect(leaseMatches({ tool: "Edit", prefix: "src/" }, "Edit src/lib/a.ts", "Coder")).toBe(true);

    expect(proposedLease("Edit src/auth.ts", "Reviewer")).toBeNull();
    expect(grantSessionLease("rev", { tool: "Edit", prefix: "src/" }, "Reviewer")).toBe(false);
    expect(leaseMatches({ tool: "Edit", prefix: "src/" }, "Edit src/lib/a.ts", "Reviewer")).toBe(
      false,
    );
    expect(leaseMatches({ tool: "Edit", prefix: "src/" }, "Bash rm -rf /tmp", "Reviewer")).toBe(
      false,
    );
    expect(leaseMatches({ tool: "Edit", prefix: "src/" }, "git merge main", "Reviewer")).toBe(false);

    expect(grantSessionLease("open", { tool: "Edit", prefix: "src/" })).toBe(true);
    expect(
      matchSessionLease("open", "Edit src/auth.ts", [
        { id: "open", status: "running", role: "Reviewer" },
      ]),
    ).toBeUndefined();
    expect(
      matchSessionLease("open", "Edit src/auth.ts", [
        { id: "open", status: "running", role: "Coder" },
      ])?.prefix,
    ).toBe("src/");
  });
});

describe("leaseCanAutoAnswer", () => {
  it("requires the #26 allow_once kind and ignores allow_always", () => {
    expect(leaseCanAutoAnswer(request())).toBe(true);
    expect(
      leaseCanAutoAnswer(
        request({
          options: [
            option({ optionId: "always", name: "Always allow", kind: "allow_always" }),
            option({ optionId: "reject", name: "Reject", kind: "reject_once" }),
          ],
        }),
      ),
    ).toBe(false);
  });
});
