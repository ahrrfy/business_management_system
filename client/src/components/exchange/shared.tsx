// مكوّنات وأدوات مشتركة لشاشات الصيرفة.
import { D, fmtAr } from "@/lib/money";

export const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export type ExchangeRow = {
  id: number;
  name: string;
  phone: string | null;
  balanceIqd: string;
  balanceUsd: string;
  usdCostRate: string;
  legacyCode: string | null;
  notes: string | null;
  isActive: boolean;
};

/** عرض رصيد بإشارة دلالية: موجب = «لنا» أخضر، سالب = «علينا» أحمر، صفر = متعادل. */
export function BalanceTag({ value, unit }: { value: string | number | null | undefined; unit: string }) {
  const d = D(value);
  if (d.isZero()) return <span className="text-muted-foreground">متعادل</span>;
  const positive = d.isPositive();
  return (
    <span className={positive ? "text-money-positive font-medium" : "text-money-negative font-medium"} dir="ltr">
      {fmtAr(d.abs().toFixed(2))} {unit}
      <span className="text-[11px] mr-1">{positive ? "(لنا)" : "(علينا)"}</span>
    </span>
  );
}

/** مُعرّف طلب فريد لكل عملية (idempotency) — يُعاد توليده لكل محاولة جديدة. */
export function newClientRequestId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export const isMoneyStr = (s: string) => /^\d+(\.\d{1,2})?$/.test(s);
export const isRateStr = (s: string) => /^\d+(\.\d{1,4})?$/.test(s);
