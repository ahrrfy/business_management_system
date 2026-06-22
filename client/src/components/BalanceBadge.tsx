/**
 * مؤشر اتجاه الدين: "لنا عليه" أو "له علينا"
 *
 * منطق الاتجاه:
 *   customer: balance > 0 → لنا عليه (AR أصل)   balance < 0 → له علينا (دفعنا زيادة)
 *   supplier: balance > 0 → له علينا (AP التزام) balance < 0 → لنا عليه (دفعنا زيادة)
 */
import { fmtAr } from "@/lib/money";
import { cn } from "@/lib/utils";

const fmtNum = (n: number) => fmtAr(n);

export type BalanceEntity = "customer" | "supplier";

interface Direction {
  label: "لنا عليه" | "له علينا";
  colorCls: string;
}

export function getBalanceDirection(
  amount: number,
  entityType: BalanceEntity
): Direction | null {
  if (amount === 0) return null;
  const weHaveClaim =
    entityType === "customer" ? amount > 0 : amount < 0;
  return weHaveClaim
    ? { label: "لنا عليه", colorCls: "emerald" }
    : { label: "له علينا", colorCls: "rose" };
}

/**
 * نصّ رصيد مضغوط لعناصر <option> (لا تقبل عناصر React): « — لنا عليه ١٢٬٥٠٠ د.ع»
 * أو "" عند الصفر — يوحّد عرض الرصيد في كل قوائم اختيار العملاء/الموردين.
 */
export function balanceOptionText(
  amount: number | string | null | undefined,
  entityType: BalanceEntity
): string {
  const num = amount != null ? Number(amount) : 0;
  const dir = getBalanceDirection(num, entityType);
  if (!dir) return "";
  return ` — ${dir.label} ${fmtNum(Math.abs(num))} د.ع`;
}

/** Badge مضغوط للاستخدام في الرأس وبطاقات الملخص */
export function BalanceBadge({
  amount,
  entityType,
  className,
  showZero = false,
}: {
  amount: number | string | null | undefined;
  entityType: BalanceEntity;
  className?: string;
  showZero?: boolean;
}) {
  const num = amount != null ? Number(amount) : 0;

  if (num === 0) {
    if (!showZero) return null;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground",
          className
        )}
      >
        لا ذمم
      </span>
    );
  }

  const dir = getBalanceDirection(num, entityType);
  if (!dir) return null;
  const isEmerald = dir.colorCls === "emerald";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold",
        isEmerald ? "badge-status-active" : "badge-stock-out",
        className
      )}
    >
      <span>{dir.label}</span>
      <span dir="ltr" className="tabular-nums">
        {fmtNum(Math.abs(num))}
      </span>
      <span className="opacity-60 font-normal">د.ع</span>
    </span>
  );
}

/** خلية الجدول: رقم ملوّن + تسمية الاتجاه */
export function BalanceCell({
  amount,
  entityType,
}: {
  amount: number | string | null | undefined;
  entityType: BalanceEntity;
}) {
  const num = amount != null ? Number(amount) : 0;

  if (num === 0) {
    return (
      <span className="text-muted-foreground tabular-nums" dir="ltr">
        —
      </span>
    );
  }

  const dir = getBalanceDirection(num, entityType);
  const isEmerald = dir?.colorCls === "emerald";

  return (
    <span
      className={cn(
        "tabular-nums font-semibold",
        isEmerald ? "text-money-positive" : "text-money-negative"
      )}
      dir="ltr"
    >
      {fmtNum(Math.abs(num))}
      {dir && (
        <span className="me-1 text-[10px] font-normal opacity-70">
          {dir.label}
        </span>
      )}
    </span>
  );
}
