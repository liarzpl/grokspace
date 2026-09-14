import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ErrorBoundary from "./ErrorBoundary";

function Boom({ armed }: { armed: boolean }) {
  if (armed) throw new Error("pane exploded");
  return <p>all good</p>;
}

/**
 * The throw lives in a child so "Try again" can remount a tree that no longer
 * blows up. Disarm sits *outside* the boundary: a render throw replaces the
 * children, so a button next to Boom would disappear with it.
 */
function Recoverable() {
  const [armed, setArmed] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setArmed(false)}>
        disarm
      </button>
      <ErrorBoundary>
        <Boom armed={armed} />
      </ErrorBoundary>
    </>
  );
}

describe("ErrorBoundary", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    consoleError.mockClear();
  });

  afterEach(() => {
    consoleError.mockClear();
  });

  it("renders children while nothing has thrown", () => {
    render(
      <ErrorBoundary>
        <p>workspace</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("names the error and can recover", async () => {
    const user = userEvent.setup();
    render(<Recoverable />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("GrokSpace hit an error");
    expect(alert).toHaveTextContent("pane exploded");

    await user.click(screen.getByRole("button", { name: "disarm" }));
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("all good")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
