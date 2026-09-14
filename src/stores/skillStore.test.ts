import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SkillStatus } from "../types";

const skillStatus = vi.fn();
const installSkill = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: { skillStatus, installSkill },
  };
});

const { firstSkillError, skillOf, useSkillStore } = await import("./skillStore");

const initial = useSkillStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useSkillStore.setState(initial, true);
});

const status = (overrides: Partial<SkillStatus> = {}): SkillStatus => ({
  path: "/home/dev/.grok/skills/grokspace-graph",
  installed: true,
  current: true,
  ...overrides,
});

describe("load", () => {
  it("asks the backend once however many panes want to know", async () => {
    skillStatus.mockResolvedValue(status({ installed: false, current: false }));

    await useSkillStore.getState().load("graph");
    await useSkillStore.getState().load("graph");

    expect(skillStatus).toHaveBeenCalledTimes(1);
    expect(skillStatus).toHaveBeenCalledWith("graph");
    expect(skillOf(useSkillStore.getState().byId, "graph").status?.installed).toBe(false);
  });

  it("stays quiet when the backend cannot answer", async () => {
    skillStatus.mockRejectedValue("no home directory");

    await useSkillStore.getState().load("memory");

    expect(skillOf(useSkillStore.getState().byId, "memory").status).toBeNull();
    expect(skillOf(useSkillStore.getState().byId, "memory").error).toBeNull();
  });
});

describe("install", () => {
  it("takes the status the install reports back", async () => {
    useSkillStore.setState({
      byId: {
        ...useSkillStore.getState().byId,
        steps: {
          status: status({ installed: false, current: false }),
          isInstalling: false,
          error: null,
        },
      },
    });
    installSkill.mockResolvedValue(status());

    await useSkillStore.getState().install("steps");

    const slot = skillOf(useSkillStore.getState().byId, "steps");
    expect(installSkill).toHaveBeenCalledWith("steps");
    expect(slot.status?.current).toBe(true);
    expect(slot.isInstalling).toBe(false);
  });

  it("leaves the button usable when the install fails", async () => {
    const before = status({ installed: false, current: false });
    useSkillStore.setState({
      byId: {
        ...useSkillStore.getState().byId,
        graph: { status: before, isInstalling: false, error: null },
      },
    });
    installSkill.mockRejectedValue("permission denied");

    await useSkillStore.getState().install("graph");

    const slot = skillOf(useSkillStore.getState().byId, "graph");
    expect(slot.status).toEqual(before);
    expect(slot.isInstalling).toBe(false);
    expect(slot.error).toBe("permission denied");
  });
});

describe("firstSkillError", () => {
  it("returns the first slot that has one", () => {
    const byId = useSkillStore.getState().byId;
    expect(firstSkillError(byId)).toBeNull();
    expect(
      firstSkillError({
        ...byId,
        memory: { ...byId.memory, error: "disk full" },
      }),
    ).toBe("disk full");
  });
});
