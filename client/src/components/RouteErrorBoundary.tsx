// حدّ خطأ حول الصفحات — يمنع الشاشة البيضاء عند خطأ غير متوقّع، ويعرض fallback عربياً
// هادئاً مع زر إعادة المحاولة + رقم مرجعي، ويُبلّغ Sentry (إن فُعِّل).
import { Button } from "@/components/ui/button";
import { nanoid } from "nanoid";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

function Fallback({ error, resetErrorBoundary }: FallbackProps) {
  const ref = (error as { _ref?: string })?._ref ?? "—";
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6" dir="rtl">
      <div className="max-w-md text-center space-y-4">
        <div className="text-4xl">⚠️</div>
        <h2 className="text-xl font-bold">حدث خطأ غير متوقّع</h2>
        <p className="text-sm text-muted-foreground">
          نعتذر — حدث خلل في هذه الشاشة. بياناتك سليمة. جرّب إعادة المحاولة، وإن تكرّر فاذكر الرقم المرجعي للدعم.
        </p>
        <p className="text-xs font-mono text-muted-foreground" dir="ltr">REF: {ref}</p>
        <div className="flex gap-2 justify-center">
          <Button onClick={resetErrorBoundary}>إعادة المحاولة</Button>
          <Button variant="outline" onClick={() => (window.location.href = "/")}>الرئيسية</Button>
        </div>
      </div>
    </div>
  );
}

function onError(error: unknown) {
  // وسم بمرجع + إبلاغ Sentry إن كان محمّلاً (lazy، لا أثر إن غير مفعّل).
  const ref = nanoid(8);
  if (error && typeof error === "object") (error as { _ref?: string })._ref = ref;
  const w = window as unknown as { Sentry?: { captureException?: (e: unknown, c?: unknown) => void } };
  try {
    w.Sentry?.captureException?.(error, { tags: { ref } });
  } catch {
    /* تجاهل */
  }
  // سجلّ محلي للتشخيص.
  console.error(`[RouteError ${ref}]`, error);
}

export function RouteErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary FallbackComponent={Fallback} onError={onError}>
      {children}
    </ErrorBoundary>
  );
}
