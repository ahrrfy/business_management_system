import { Bell, Share2, X, Smartphone, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";
import {
  autoResubscribeIfPermissionGranted,
  getPermissionState,
  isIosSafariBrowser,
  isPushSupported,
  isStandalonePwa,
  subscribeToPush,
} from "@/lib/push";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const DISMISSED_KEY = "alroya.push-prompt.dismissed-until";
const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

function isDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return false;
    const until = Number(raw);
    return Number.isFinite(until) && Date.now() < until;
  } catch {
    return false;
  }
}

function setDismissedPeriod(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now() + FIVE_DAYS_MS));
  } catch {
    // تجاهل أخطاء التخزين المحلي
  }
}

/**
 * مكوّن ذكي لطلب إذن إشعارات Web Push للموظفين بهيئة مطابقة للتطبيقات الأصلية:
 * 1. لمستخدمي Safari على iOS: يوجّههم لإضافة التطبيق إلى الشاشة الرئيسية لفتح إمكانية Push.
 * 2. لمستخدمي PWA المثبتين (أو متصفحات تدعم Push): يعرض بطاقة واضحة لتفعيل الإشعارات بنقرة واحدة رسمية.
 * 3. للأجهزة الممنوحة إذن مسبقاً: يضمن تسجيلها تلقائياً بالخلفية بدون إزعاج.
 */
export function PushNotificationPrompt({ className }: { className?: string }) {
  const [dismissed, setDismissed] = useState<boolean>(true);
  const [busy, setBusy] = useState(false);
  const [permState, setPermState] = useState<NotificationPermission | "unsupported">("unsupported");

  const pushKey = trpc.push.publicKey.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const myStatus = trpc.push.myStatus.useQuery(undefined, {
    staleTime: 60 * 1000,
  });
  const utils = trpc.useUtils();
  const subscribeMut = trpc.push.subscribe.useMutation({
    onSuccess: async () => {
      await utils.push.myStatus.invalidate();
      notify.ok("تم تفعيل إشعارات الهاتف بنجاح");
      setDismissed(true);
    },
    onError: (err) => {
      notify.err(err.message || "تعذّر تفعيل الإشعارات على هذا الجهاز");
    },
  });

  useEffect(() => {
    setPermState(getPermissionState());
    setDismissed(isDismissed());
  }, []);

  // المزامنة الهادئة: إن كان الإذن ممنوحاً مسبقاً على الجهاز لكنه غير مسجل بالخادم
  useEffect(() => {
    if (!pushKey.data?.enabled || !pushKey.data.publicKey) return;
    if (permState !== "granted") return;
    if (myStatus.data && myStatus.data.activeCount === 0) {
      void autoResubscribeIfPermissionGranted(pushKey.data.publicKey).then((sub) => {
        if (sub) {
          void subscribeMut.mutateAsync(sub);
        }
      });
    }
  }, [pushKey.data, permState, myStatus.data]);

  if (dismissed) return null;
  if (!pushKey.data?.enabled || !pushKey.data.publicKey) return null;

  // حالة مستخدم آيفون داخل Safari العادي (وليس من الشاشة الرئيسية)
  if (isIosSafariBrowser()) {
    return (
      <div
        role="region"
        aria-label="إرشاد تثبيت التطبيق وتفعيل الإشعارات"
        className={cn(
          "relative flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3 text-start text-xs leading-relaxed text-foreground shadow-xs transition",
          className,
        )}
      >
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Share2 className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-semibold text-primary">تفعيل إشعارات التطبيق على آيفون</p>
          <p className="text-muted-foreground">
            لتلقي إشعارات النظام كالبرامج الأصلية: اضغط زر المشاركة أسفل المتصفح ثم اختر «إضافة إلى الشاشة الرئيسية» وافتح التطبيق منها.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => {
            setDismissedPeriod();
            setDismissed(true);
          }}
          aria-label="إغلاق التنبيه"
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
    );
  }

  // حالة المتصفح لا يدعم Push أو تم حظره صراحةً
  if (!isPushSupported() || permState === "denied" || permState === "granted") {
    return null;
  }

  // حالة انتظار الإذن (default)
  async function handleEnablePush() {
    if (!pushKey.data?.publicKey) return;
    setBusy(true);
    try {
      const sub = await subscribeToPush(pushKey.data.publicKey);
      await subscribeMut.mutateAsync(sub);
      setPermState("granted");
    } catch (err) {
      setPermState(getPermissionState());
      const msg = err instanceof Error ? err.message : "تعذّر الحصول على إذن الإشعارات";
      notify.err(msg);
    } finally {
      setBusy(false);
    }
  }

  function handleDismiss() {
    setDismissedPeriod();
    setDismissed(true);
  }

  return (
    <div
      role="region"
      aria-label="تفعيل إشعارات الهاتف"
      className={cn(
        "relative flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-primary/30 bg-card p-3.5 shadow-sm transition",
        className,
      )}
    >
      <div className="flex items-start sm:items-center gap-3 min-w-0">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Bell className="size-5 animate-pulse" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-semibold text-sm">
            <span>تفعيل إشعارات الهاتف الفورية</span>
            {isStandalonePwa() && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.2 text-[10px] text-primary">
                <Smartphone className="size-2.5" aria-hidden />
                تطبيق مثبت
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            تلقّ تنبيهات أوامر الشغل، والموافقات المستعجلة، ومستجدات الحضور والرواتب فوراً على شاشة هاتفك.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
        <Button
          type="button"
          size="sm"
          onClick={handleEnablePush}
          disabled={busy}
          className="gap-1.5 font-medium"
        >
          <Check className="size-3.5" aria-hidden />
          <span>{busy ? "جارٍ التفعيل…" : "تفعيل الإشعارات الآن"}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          disabled={busy}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          لاحقاً
        </Button>
      </div>
    </div>
  );
}
