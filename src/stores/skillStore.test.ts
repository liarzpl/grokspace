import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SkillStatus } from "../types";

const skillStatus = vi.fn();
const installSkill = vi.fn();
const saveUserSkill = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: { skillStatus, installSkill, saveUserSkill },
  };
});

const { firstSkillError, skillCommandLabel, skillOf, SKILL_IDS, useSkillStore } =
  await import("./skillStore");

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

describe("refresh", () => {
  it("asks the backend again even when a status is already cached", async () => {
    skillStatus
      .mockResolvedValueOnce(status({ installed: false, current: false }))
      .mockResolvedValueOnce(status({ installed: true, current: true }));

    await useSkillStore.getState().load("graph");
    await useSkillStore.getState().refresh("graph");

    expect(skillStatus).toHaveBeenCalledTimes(2);
    expect(skillOf(useSkillStore.getState().byId, "graph").status?.installed).toBe(true);
  });

  it("re-reads every bundled skill in install order", async () => {
    const seen: string[] = [];
    skillStatus.mockImplementation(async (id: string) => {
      seen.push(id);
      return status({ installed: id !== "steps", current: id !== "steps" });
    });

    await useSkillStore.getState().refreshAll();

    expect(seen).toEqual(["graph", "memory", "steps"]);
    expect(skillOf(useSkillStore.getState().byId, "steps").status?.installed).toBe(false);
  });
});

describe("skillCommandLabel", () => {
  it("names missing versus installed for each bundled id", () => {
    const empty = { status: null, isInstalling: false, error: null };
    const missing = {
      status: status({ installed: false, current: false }),
      isInstalling: false,
      error: null,
    };
    const installed = {
      status: status({ installed: true, current: true }),
      isInstalling: false,
      error: null,
    };

    expect(SKILL_IDS).toEqual(["graph", "memory", "steps"]);
    for (const id of SKILL_IDS) {
      expect(skillCommandLabel(id, empty)).toBe(`Install or refresh the ${id} skill`);
      expect(skillCommandLabel(id, missing)).toBe(`Install the ${id} skill (missing)`);
      expect(skillCommandLabel(id, installed)).toBe(`Refresh the ${id} skill (installed)`);
    }
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

describe("saveUserSkill", () => {
  it("writes ~/.grokspace/skills and does not install into grok", async () => {
    saveUserSkill.mockResolvedValue({ name: "review-flow", path: "/home/dev/.grokspace/skills/review-flow" });
    const saved = await useSkillStore.getState().saveUserSkill("review-flow", "# recipe\n");
    expect(saveUserSkill).toHaveBeenCalledWith({ name: "review-flow", markdown: "# recipe\n" });
    expect(saved.path).toContain(".grokspace/skills/");
    expect(saved.path).not.toContain(".grok/skills");
    expect(installSkill).not.toHaveBeenCalled();
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
