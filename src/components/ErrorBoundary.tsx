import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Production React has no overlay: a render throw unmounts the tree and leaves
 * the window's background colour. That is exactly "components flash, then a
 * blank canvas". Catching here keeps the chrome on screen and names the error.
 *
 * Colours are inline so this still paints if the stylesheet never applied.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
    this.setState({ stack: info.componentStack ?? null });
  }

  render() {
    if (this.state.error === null) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          boxSizing: "border-box",
          display: "flex",
          minHeight: 0,
          flex: 1,
          flexDirection: "column",
          justifyContent: "center",
          padding: 24,
          color: "#e8ebf2",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
          fontSize: 13,
        }}
      >
        <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>GrokSpace hit an error</p>
        <p
          style={{
            margin: "8px 0 0",
            maxWidth: 36 * 13,
            lineHeight: 1.5,
            color: "#8c95a6",
            whiteSpace: "pre-wrap",
          }}
        >
          {this.state.error.message}
        </p>
        {this.state.stack !== null && (
          <pre
            style={{
              margin: "12px 0 0",
              maxWidth: 52 * 13,
              maxHeight: 12 * 16,
              overflow: "auto",
              padding: 12,
              borderRadius: 6,
              background: "#101319",
              color: "#5b6474",
              fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
              fontSize: 11,
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
            }}
          >
            {this.state.stack.trim()}
          </pre>
        )}
        <button
          type="button"
          onClick={() => this.setState({ error: null, stack: null })}
          style={{
            alignSelf: "flex-start",
            marginTop: 16,
            padding: "6px 12px",
            border: 0,
            borderRadius: 6,
            background: "#6d8cff",
            color: "#0b0d12",
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
