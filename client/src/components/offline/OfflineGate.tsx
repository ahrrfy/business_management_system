import { Button } from "@/components/ui/button";
import { useConnectivity } from "@/lib/offline/connectivity";
import { RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * شاشة «تعذّر الاتصال بالخادم» أثناء التحقق من الجلسة (إقلاع التطبيق والاتصال مقطوع).
 * قبل الشريحة ١ كان فشل جلب auth.me الشبكي يُعامل كغياب جلسة فيُرمى المستخدم لشاشة الدخول —
 * الآن يبقى هنا وتُستأنف الجلسة تلقائياً فور عودة الاتصال (يُخطرنا مسبار connectivity).
 */
export function AuthConnectionError({ onRetry }: { onRetry: () => void }) {
  const state = useConnectivity();
  const prevState = useRef(state);
  useEffect(() => {
    // إعادة الجلب عند الانتقال الفعلي إلى online فقط — لا عند كل إعادة رسم (منع حلقة refetch).
    if (state === "online" && prevState.current !== "online") onRetry();
    prevState.current = state;
  }, [state, onRetry]);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <WifiOff aria-hidden className="size-10 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-lg font-semibold">تعذّر الاتصال بالخادم</p>
        <p className="text-sm text-muted-foreground">
          تحقّق من اتصال الإنترنت — ستُستأنف الجلسة تلقائياً فور عودة الاتصال.
        </p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        <RefreshCw aria-hidden className="size-4" />
        إعادة المحاولة
      </Button>
    </div>
  );
}

/**
 * حارس الشاشات الأونلاينية (داخل Shell): من فتح شاشةً والاتصال مقطوع يرى رسالة صادقة بدل
 * استعلامات تدور ثم تفشل بأشكال متفرقة. أمّا من انقطع اتصاله وهو داخل شاشة محمَّلة فلا نطمس
 * بياناتها المعروضة — الشريط العلوي يكفي إعلاماً.
 * التنفيذ مزلاج أحادي الاتجاه: يُفتح عند أول لحظة اتصال ويبقى مفتوحاً (انقطاع لاحق لا يُخفي الشاشة).
 */
export function OnlineGate({ children }: { children: React.ReactNode }) {
  const state = useConnectivity();
  const [unblocked, setUnblocked] = useState(state === "online" || state === "syncing");
  useEffect(() => {
    if (state === "online" || state === "syncing") setUnblocked(true);
  }, [state]);
  if (!unblocked) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <WifiOff aria-hidden className="size-10 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-lg font-semibold">هذه الشاشة تتطلب اتصالاً بالخادم</p>
          <p className="text-sm text-muted-foreground">
            ستُحمَّل تلقائياً فور عودة الاتصال.
          </p>
        </div>
        <RefreshCw aria-hidden className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <>{children}</>;
}
