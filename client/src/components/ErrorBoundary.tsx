import { Component, type ErrorInfo, type ReactNode } from "react";
import { nanoid } from "nanoid";
import { captureClientException } from "@/sentry";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
  ref: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, ref: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, ref: nanoid(8) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const ref = this.state.ref ?? nanoid(8);
    captureClientException(error, {
      ref,
      surface: "app-root",
      componentStack: info.componentStack ?? undefined,
    });
    if (import.meta.env.DEV) console.error(`[ErrorBoundary ${ref}]`, error, info.componentStack);
    else console.error(`[ErrorBoundary ${ref}]`);
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-8 text-center">
            <p className="text-2xl font-bold text-destructive">حدث خطأ غير متوقع</p>
            <p className="text-muted-foreground max-w-md">
              تعذّر فتح هذه الشاشة. أعد المحاولة، وإن تكرر الخلل أرسل الرقم المرجعي للدعم.
            </p>
            <p className="text-xs font-mono text-muted-foreground" dir="ltr">
              REF: {this.state.ref ?? "—"}
            </p>
            <button
              className="px-4 py-2 rounded bg-primary text-primary-foreground text-sm"
              onClick={() => this.setState({ error: null, ref: null })}
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
