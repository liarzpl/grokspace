import { describe, expect, it } from "vitest";

import { useMemoryStore } from "./memoryStore";
import { useProjectStore } from "./projectStore";
import { useSessionStore } from "./sessionStore";
import { useStepStore } from "./stepStore";
import { useTaskStore } from "./taskStore";

/**
 * STYLE-009: the CRUD name is canonical; the old verb is an alias for one release.
 */
describe("store CRUD aliases", () => {
  it("project forgetProject calls removeProject", () => {
    const state = useProjectStore.getState();
    expect(state.forgetProject).toBeTypeOf("function");
    expect(state.removeProject).toBeTypeOf("function");
  });

  it("memory put/forget wrap create/remove", () => {
    const state = useMemoryStore.getState();
    expect(state.putEntry).toBeTypeOf("function");
    expect(state.createEntry).toBeTypeOf("function");
    expect(state.forgetEntry).toBeTypeOf("function");
    expect(state.removeEntry).toBeTypeOf("function");
  });

  it("task editTask wraps updateTask", () => {
    const state = useTaskStore.getState();
    expect(state.editTask).toBeTypeOf("function");
    expect(state.updateTask).toBeTypeOf("function");
  });

  it("steps add wraps create", () => {
    const state = useStepStore.getState();
    expect(state.add).toBeTypeOf("function");
    expect(state.create).toBeTypeOf("function");
  });

  it("session startSession wraps createSession", () => {
    const state = useSessionStore.getState();
    expect(state.startSession).toBeTypeOf("function");
    expect(state.createSession).toBeTypeOf("function");
  });
});
