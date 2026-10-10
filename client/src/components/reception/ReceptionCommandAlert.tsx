import { useState, useEffect, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  Clock,
  Flame,
  MessageSquare,
  ShieldAlert,
  Sparkles,
  UserCheck,
  ChevronDown,
  ChevronUp,
  X,
  PhoneCall,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmployeeEarningsWidget } from "./EmployeeEarningsWidget";
import { cn } from "@/lib/utils";

interface ReceptionCommandAlertProps {
  branchId?: number;
  className?: string;
}

export function ReceptionCommandAlert({ branchId, className }: ReceptionCommandAlertProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showUpsellGuide, setShowUpsellGuide] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<number>(15 * 60); // 15-minute SLA countdown loop

  const meQ = trpc.auth.me.useQuery();
  const countsQ = trpc.storeAdmin.orders.counts.useQuery(undefined, {
    refetchInterval: 15_000,
  });

  const me = meQ.data;
  const pendingOrders = countsQ.data?.PENDING ?? 0;
  const processingOrders = countsQ.data?.PROCESSING ?? 0;
  const totalActionable = pendingOrders + processingOrders;

  // مؤقت التنازلي للاستجابة السريعة (SLA 15 دقيقة)
  useEffect(() => {
    const timer = setInterval(() => {
      setTimeRemaining((prev) => (prev > 0 ? prev - 1 : 15 * 60));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const minutes = Math.floor(timeRemaining / 60);
  const seconds = timeRemaining % 60;
  const formattedCountdown = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  const isUrgent = pendingOrders > 0;

  if (totalActionable === 0 && !isUrgent) {
    return (
      <div
        className={cn(
          "flex items-center justify-between rounded-xl border border-border/60 bg-muted/30 px-3.5 py-2 text-xs text-muted-foreground",
          className,
        )}
      >
        <div className="flex items-center gap-2">
          <CheckCircle2 aria-hidden className="size-4 text-[var(--sem-pos)]" />
          <span className="font-bold text-foreground">
            طابور الطلبات مكتمل — لا توجد طلبات متجر أو مسودات معلقة بحاجة للتدخل الفوري.
          </span>
        </div>
        <EmployeeEarningsWidget compact />
      </div>
    );
  }

  return (
    <>
      <div
        role="region"
        aria-label="تكليف مهام خدمة العملاء والتجهيز"
        className={cn(
          "relative overflow-hidden rounded-2xl border-2 transition-all shadow-md",
          isUrgent
            ? "border-[var(--sem-warn)] bg-gradient-to-r from-[var(--sem-warn-bg)] via-card to-card"
            : "border-primary/30 bg-card",
          className,
        )}
      >
        {/* شريط الإشعار العلوي الصارم */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2 bg-background/50">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "flex size-6 items-center justify-center rounded-full font-black text-xs animate-pulse",
                isUrgent ? "bg-[var(--sem-warn)] text-background" : "bg-primary text-primary-foreground",
              )}
            >
              <Flame aria-hidden className="size-3.5" />
            </div>
            <h2 className="text-xs sm:text-sm font-black text-foreground tracking-tight">
              أمر تكليف رسمي ملزم: تجهيز طلبات العملاء وتحقيق المبيعات
            </h2>
          </div>

          <div className="flex items-center gap-2">
            {/* مؤقت SLA */}
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-black tabular-nums border",
                timeRemaining < 300
                  ? "border-[var(--sem-neg)] bg-[var(--sem-neg-bg)] text-[var(--sem-neg)] animate-pulse"
                  : "border-border bg-card text-foreground",
              )}
              title="المهلة القصوى للتواصل وتثبيت الطلب الجديد"
            >
              <Clock aria-hidden="true" className="size-3.5" />
              <span>مؤقت الاستجابة (SLA):</span>
              <span dir="ltr">{formattedCountdown}</span>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCollapsed(!collapsed)}
              className="h-7 w-7 p-0"
              aria-label={collapsed ? "توسيع التكليف" : "طي التكليف"}
            >
              {collapsed ? (
                <ChevronDown aria-hidden className="size-4" />
              ) : (
                <ChevronUp aria-hidden className="size-4" />
              )}
            </Button>
          </div>
        </div>

        {/* جسم التكليف */}
        {!collapsed && (
          <div className="p-4 space-y-3.5">
            <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr] items-center">
              {/* رسالة التكليف والإلزام */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-md bg-[var(--sem-warn)]/15 px-2 py-0.5 text-xs font-black text-[var(--sem-warn)]">
                    <AlertTriangle aria-hidden className="size-3.5" />
                    لديك {pendingOrders.toLocaleString("ar-IQ-u-nu-latn")} طلب وارد جديد بحاجة لتأكيد فوري
                  </span>
                  {processingOrders > 0 && (
                    <span className="text-xs text-muted-foreground font-semibold">
                      + {processingOrders.toLocaleString("ar-IQ-u-nu-latn")} قيد التجهيز
                    </span>
                  )}
                </div>

                <p className="text-xs text-foreground font-medium leading-relaxed">
                  يُمنع التكاسل أو تأجيل الطلبات أو إلغاؤها بحجة عدم الرد دون استنفاد محاولات الاتصال الثلاثة.
                  الهدف الأساسي هو إتمام البيع، اقتراح بدائل للمنتجات النافذة، وزيادة قيمة الطلب عبر العروض التكميلية.
                </p>

                {/* أزرار الإجراءات السريعة لزيادة المبيعات */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 text-xs font-bold border-primary/40 hover:bg-primary/10 text-primary"
                    onClick={() => setShowUpsellGuide(true)}
                  >
                    <Sparkles aria-hidden className="size-3.5 text-primary" />
                    دليل إنقاذ المبيعات وزيادة السلة (Upsell)
                  </Button>

                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground bg-muted/40 px-2 py-1 rounded-md">
                    <ShieldAlert aria-hidden className="size-3 text-muted-foreground" />
                    <span>إلغاء الطلب يتطلب موافقة المشرف وتوثيق 3 اتصالات رسمية</span>
                  </div>
                </div>
              </div>

              {/* بطاقة عمولة الموظف والأداء */}
              <div>
                <EmployeeEarningsWidget />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* نافذة دليل إنقاذ المبيعات وزيادة السلة */}
      {showUpsellGuide && (
        <div
          className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-label="دليل إنقاذ المبيعات وزيادة سلة الشراء"
          onClick={() => setShowUpsellGuide(false)}
        >
          <div
            className="w-full max-w-lg space-y-4 rounded-2xl bg-card p-5 shadow-2xl border border-border"
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
          >
            <div className="flex items-center justify-between border-b pb-3">
              <div className="flex items-center gap-2 text-foreground font-black text-sm">
                <Sparkles aria-hidden className="size-4 text-primary" />
                <span>دليل البائع المحترف — إنقاذ الطلبات وزيادة السلة</span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setShowUpsellGuide(false)}
              >
                <X aria-hidden className="size-4" />
              </Button>
            </div>

            <div className="space-y-3 text-xs leading-relaxed">
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
                <h3 className="font-bold text-primary mb-1 flex items-center gap-1.5">
                  <PhoneCall aria-hidden className="size-3.5" />
                  ١. العميل متردد بسبب كلفة التوصيل:
                </h3>
                <p className="text-muted-foreground">
                  «أهلاً بحضرتك، إذا أضفت منتجاً بسيطاً لتصل السلة إلى 50,000 د.ع أو أكثر، سنمنحك توصيلاً مجانياً فورياً للطلب بالكامل!»
                </p>
              </div>

              <div className="rounded-xl border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)]/40 p-3">
                <h3 className="font-bold text-[var(--sem-warn)] mb-1 flex items-center gap-1.5">
                  <AlertTriangle aria-hidden className="size-3.5" />
                  ٢. المنتج المطلوب نفد من المخزون:
                </h3>
                <p className="text-muted-foreground">
                  «النسخة الحالية نفدت بسبب الطلب العالي، لكن لدينا بديل بجودة ممتازة وسعر مناسب، أو يمكننا حجز دفعة جديدة لك مع هدية خاصة.»
                </p>
              </div>

              <div className="rounded-xl border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)]/40 p-3">
                <h3 className="font-bold text-[var(--sem-pos)] mb-1 flex items-center gap-1.5">
                  <MessageSquare aria-hidden className="size-3.5" />
                  ٣. رسالة واتساب التثبيت الفوري:
                </h3>
                <p className="text-muted-foreground">
                  «مرحباً بك! طلبك رقم #... وصل وجارٍ تجهيزه بعناية. هل تود إضافة بطاقة إهداء أو ورق تغليف فاخر قبل شحنه مع المندوب؟»
                </p>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button
                type="button"
                size="sm"
                className="font-bold"
                onClick={() => setShowUpsellGuide(false)}
              >
                فهمت التوجيه وسأطبقه الآن
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
