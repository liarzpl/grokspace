import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { GraphNode } from "../../lib/graph";
import ArtifactPathList, { ArtifactPreview } from "./ArtifactPathList";
import NodeInspector from "./NodeInspector";

vi.mock("../../lib/api", () => ({
  errorMessage: (error: unknown) => String(error),
  api: { fileDiff: vi.fn(), revealArtifact: vi.fn() },
}));

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "brief",
    type: "agent",
    label: "Brief",
    status: "completed",
    position: { x: 0, y: 0 },
    data: { artifactPath: ".grokspace/graphs/artifacts/brief.md" },
    ...overrides,
  };
}

describe("ArtifactPreview allow-list", () => {
  it("renders markdown as escaped text, not HTML", () => {
    const { container } = render(
      <ArtifactPreview
        path="notes.md"
        text={'# Hello <script>alert("xss")</script><img src=x onerror=alert(1)>'}
      />,
    );

    expect(screen.getByTestId("artifact-preview-markdown")).toHaveTextContent(/# Hello/);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not render an HTML artifact as HTML", () => {
    const { container } = render(
      <ArtifactPreview
        path="payload.html"
        text={'<img src=x onerror="alert(1)"><script>alert(1)</script>'}
      />,
    );

    expect(screen.getByTestId("artifact-preview-none")).toHaveTextContent("No preview");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("previews an image only from a data: URL, never raw HTML", () => {
    const { rerender, container } = render(
      <ArtifactPreview path="shot.png" text={'<img src=x onerror="alert(1)">'} />,
    );

    expect(screen.getByTestId("artifact-preview-image")).toHaveTextContent("Image");
    expect(container.querySelector("img")).toBeNull();

    rerender(<ArtifactPreview path="shot.png" imageSrc="data:image/png;base64,aaaa" />);
    expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,aaaa");
  });
});

describe("ArtifactPathList", () => {
  it("lists claimed paths and offers Diff and Finder", async () => {
    const user = userEvent.setup();
    const onOpenDiff = vi.fn();
    const onReveal = vi.fn();

    render(
      <ArtifactPathList
        paths={[".grokspace/graphs/artifacts/brief.md", "src/auth.rs"]}
        onOpenDiff={onOpenDiff}
        onReveal={onReveal}
        previewText="# Brief"
      />,
    );

    expect(screen.getByText("src/auth.rs")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Diff" }));
    expect(onOpenDiff).toHaveBeenCalledWith(".grokspace/graphs/artifacts/brief.md");
    await user.click(screen.getByRole("button", { name: "Finder" }));
    expect(onReveal).toHaveBeenCalledWith(".grokspace/graphs/artifacts/brief.md");
  });
});

describe("NodeInspector artifacts", () => {
  it("lists this node's file plus other claimed paths", async () => {
    const user = userEvent.setup();
    const onOpenArtifact = vi.fn();
    render(
      <NodeInspector
        node={node()}
        onClose={() => {}}
        onOpenArtifact={onOpenArtifact}
        onRevealArtifact={vi.fn()}
        claimedPaths={["src/auth.rs"]}
      />,
    );
    expect(screen.getByText("src/auth.rs")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Diff" }));
    expect(onOpenArtifact).toHaveBeenCalledWith(".grokspace/graphs/artifacts/brief.md");
  });

  it("does not preview an HTML artifact as HTML", () => {
    const { container } = render(
      <NodeInspector node={node({ data: { artifactPath: "payload.html" } })} onClose={() => {}} />,
    );
    expect(screen.getByTestId("artifact-preview-none")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
  });

  it("forks from the selected node", async () => {
    const user = userEvent.setup();
    const onFork = vi.fn();
    render(<NodeInspector node={node()} onClose={() => {}} onFork={onFork} />);
    await user.click(screen.getByRole("button", { name: "Fork from here" }));
    expect(onFork).toHaveBeenCalledTimes(1);
  });

  it("keeps a trailing-slash directory as a label", () => {
    render(
      <NodeInspector
        node={node({ data: { artifactPath: ".grokspace/graphs/artifacts/drafts/" } })}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId("artifact-path-list")).not.toBeInTheDocument();
    expect(screen.getByText(".grokspace/graphs/artifacts/drafts/")).toBeInTheDocument();
  });
});
