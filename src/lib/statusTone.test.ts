import { describe, expect, it } from "vitest";

import { SESSION_STATUS_TONE, sessionStatusTone, statusDotClass } from "./statusTone";
import {
  choiceOptionClass,
  CHOICE_ACTIVE_CLASS,
  CHOICE_IDLE_CLASS,
  QUIET_BUTTON_CLASS,
  TEXT_BUTTON_CLASS,
  TEXT_BUTTON_PRIMARY_CLASS,
  textButtonClass,
} from "./ui";

describe("sessionStatusTone", () => {
  it("covers every SessionStatus with a token fill", () => {
    expect(Object.keys(SESSION_STATUS_TONE).sort()).toEqual(
      ["idle", "needs_input", "running", "stopped"].sort(),
    );
    expect(sessionStatusTone("idle")).toBe("bg-success");
    expect(sessionStatusTone("running")).toBe("bg-accent");
    expect(sessionStatusTone("needs_input")).toBe("bg-warning");
    expect(sessionStatusTone("stopped")).toBe("bg-line-strong");
  });

  it("builds the StatusDot class from the same map", () => {
    expect(statusDotClass("running")).toBe("size-1.5 shrink-0 rounded-full bg-accent");
  });
});

describe("button recipes", () => {
  it("keeps the quiet chrome at 10px faint ink", () => {
    expect(QUIET_BUTTON_CLASS).toContain("text-[10px]");
    expect(QUIET_BUTTON_CLASS).toContain("text-ink-faint");
  });

  it("picks the accent fill only when primary", () => {
    expect(textButtonClass()).toBe(TEXT_BUTTON_CLASS);
    expect(textButtonClass(false)).toBe(TEXT_BUTTON_CLASS);
    expect(textButtonClass(true)).toBe(TEXT_BUTTON_PRIMARY_CLASS);
    expect(TEXT_BUTTON_PRIMARY_CLASS).toContain("bg-accent");
  });

  it("marks the selected Choice option", () => {
    expect(choiceOptionClass(true)).toContain(CHOICE_ACTIVE_CLASS);
    expect(choiceOptionClass(false)).toContain(CHOICE_IDLE_CLASS);
  });
});
