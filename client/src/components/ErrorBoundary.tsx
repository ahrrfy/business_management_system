import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-8 text-center">
            <p className="text-2xl font-bold text-destructive">حدث خطأ غير متوقع</p>
            <p className="text-muted-foreground max-w-md">{this.state.error.message}</p>
            <button
              className="px-4 py-2 rounded bg-primary text-primary-foreground text-sm"
              onClick={() => this.setState({ error: null })}
            >
              إعادة المحاولة
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
