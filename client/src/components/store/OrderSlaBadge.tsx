import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Clock, Flame, Timer } from "lucide-react";

interface OrderSlaBadgeProps {
  createdAt: Date | string;
  status: string;
  reservationExpiresAt?: Date | string | null;
  fulfillmentDurationMinutes?: number | null;
}

export function OrderSlaBadge({
  createdAt,
  status,
  reservationExpiresAt,
  fulfillmentDurationMinutes,
}: OrderSlaBadgeProps) {
  const [, setTick] = useState(0);

  // تحديث تلقائي كل دقيقة لحساب الفارق الزمني الحي
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  const createdDate = new Date(createdAt);
  const createdTime = createdDate.getTime();
  if (isNaN(createdTime)) {
    return <span className="text-[11px] text-muted-foreground">—</span>;
  }

  const now = Date.now();
  const diffMinutes = Math.max(0, Math.floor((now - createdTime) / 60000));

  // إذا تم التجهيز مسبقاً
  if (fulfillmentDurationMinutes != null && fulfillmentDurationMinutes >= 0) {
    const durationLabel =
      fulfillmentDurationMinutes === 0
        ? "جُهّز في أقل من دقيقة"
        : `جُهّز في ${fulfillmentDurationMinutes} دقيقة`;
    return (
      <div
        className="inline-flex items-center gap-1 rounded-md border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--sem-pos)]"
        title={durationLabel}
      >
        <CheckCircle2 className="size-3 shrink-0" aria-hidden />
        <span>{durationLabel}</span>
      </div>
    );
  }

  // إذا انتهى الطلب أو أُلغي
  if (status === "DELIVERED" || status === "CANCELLED" || status === "SHIPPED") {
    const hours = Math.floor(diffMinutes / 60);
    const timeLabel = hours > 24 ? `${Math.floor(hours / 24)} يوم` : hours > 0 ? `${hours} ساعة` : `${diffMinutes} د`;
    return (
      <span className="text-[11px] text-muted-foreground" title={createdDate.toLocaleString("ar-IQ-u-nu-latn")}>
        منذ {timeLabel}
      </span>
    );
  }

  // حساب المتبقي من مهلة حجز المخزون
  let expiryLabel: string | null = null;
  let isExpired = false;

  if (reservationExpiresAt) {
    const expiryTime = new Date(reservationExpiresAt).getTime();
    if (!isNaN(expiryTime)) {
      const diffMs = expiryTime - now;
      if (diffMs <= 0) {
        isExpired = true;
        expiryLabel = "انتهت مهلة حجز المخزون!";
      } else {
        const remainingHours = Math.floor(diffMs / 3600000);
        const remainingMins = Math.floor((diffMs % 3600000) / 60000);
        expiryLabel =
          remainingHours > 0
            ? `باقي ${remainingHours} س للإلغاء`
            : `باقي ${Math.max(1, remainingMins)} د للإلغاء`;
      }
    }
  } else if (status === "PENDING") {
    const remainingMins = Math.max(0, 24 * 60 - diffMinutes);
    if (remainingMins <= 0) {
      isExpired = true;
      expiryLabel = "تجاوزت مهلة الـ 24 ساعة!";
    } else {
      const remainingHours = Math.floor(remainingMins / 60);
      expiryLabel =
        remainingHours > 0
          ? `حجز المخزون: باقي ${remainingHours} س`
          : `حجز المخزون: باقي ${remainingMins} د`;
    }
  }

  // تصنيف درجة الإلحاح الزمني
  if (diffMinutes < 15) {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span className="inline-flex items-center gap-1 rounded-md border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--sem-pos)]" title="طلب جديد وصل تواً">
          <Clock className="size-3 shrink-0" aria-hidden />
          <span>جديد (منذ {diffMinutes} د)</span>
        </span>
        {expiryLabel && (
          <span className={`text-[10px] ${isExpired ? "font-bold text-[var(--sem-neg)]" : "text-muted-foreground"}`}>
            {expiryLabel}
          </span>
        )}
      </div>
    );
  }

  if (diffMinutes < 45) {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span className="inline-flex items-center gap-1 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--sem-warn)]" title="طلب بحاجة لمتابعة وتثبيت">
          <Timer className="size-3 shrink-0" aria-hidden />
          <span>متأخر (منذ {diffMinutes} د)</span>
        </span>
        {expiryLabel && (
          <span className={`text-[10px] ${isExpired ? "font-bold text-[var(--sem-neg)]" : "text-muted-foreground"}`}>
            {expiryLabel}
          </span>
        )}
      </div>
    );
  }

  // عاجل جداً — أكثر من 45 دقيقة
  const hours = Math.floor(diffMinutes / 60);
  const displayTime = hours > 0 ? `${hours} س و ${diffMinutes % 60} د` : `${diffMinutes} دقيقة`;

  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="inline-flex items-center gap-1 rounded-md border border-[var(--sem-neg)]/50 bg-[var(--sem-neg-bg)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--sem-neg)] animate-pulse" title="طلب حرج مهمل لأكثر من 45 دقيقة!">
        <Flame className="size-3 shrink-0" aria-hidden />
        <span>عاجل! منذ {displayTime}</span>
      </span>
      {expiryLabel && (
        <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-[var(--sem-neg)]">
          <AlertCircle className="size-2.5 shrink-0" aria-hidden />
          {expiryLabel}
        </span>
      )}
    </div>
  );
}
