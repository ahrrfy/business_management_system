import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import { cn } from "@/lib/utils";
import { RefreshCw, WifiOff } from "lucide-react";
import { useLocation } from "wouter";

// مسارات علنية موجَّهة للزبائن (متجر/كشك/بوابة عدّ/توظيف) — لا نعرض شريط حالة داخلياً فوقها.
const PUBLIC_PREFIXES = ["/store", "/kiosk", "/count", "/apply"];

/**
 * شريط حالة الاتصال العام — الشريحة ١ من خطة الأوفلاين. يُركَّب مرة واحدة في App (لا في AppLayout)
 * كي يظهر أيضاً على شاشات ملء الشاشة (نقطة البيع، قارئ الأسعار، الدخول).
 * الطبقة z-[150]: فوق النوافذ اليدوية z-[100] (انقطاع الاتصال يهمّ من بداخلها أيضاً) وتحت
 * حوار التأكيد العام z-[200] — وفق قانون طبقات النوافذ (PR #122).
 */
export function OfflineBanner() {
  const state = useConnectivity();
  const [loc] = useLocation();
  if (state === "online") return null;
  if (PUBLIC_PREFIXES.some((p) => loc === p || loc.startsWith(p + "/"))) return null;

  const syncing = state === "syncing";
  const reconnecting = state === "reconnecting";
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed inset-x-0 top-0 z-[150] flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-semibold shadow-sm",
        syncing ? "bg-sky-600 text-white" : "bg-amber-500 text-amber-950",
      )}
    >
      {syncing || reconnecting ? (
        <RefreshCw aria-hidden className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <WifiOff aria-hidden className="size-3.5 shrink-0" />
      )}
      <span>
        {syncing
          ? "عاد الاتصال — جارٍ مزامنة العمليات المحلية…"
          : reconnecting
            ? "جارٍ التحقق من عودة الاتصال…"
            : "انقطع الاتصال بالخادم — الشاشات التي تتطلب اتصالاً غير متاحة حتى عودته"}
      </span>
    </div>
  );
}
