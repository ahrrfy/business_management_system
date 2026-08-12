import { Check, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/money";
import type { LastSaleSummary } from "./cartMath";

/** ش١ (§٨.٦) — نافذة الإيصال بعد الإتمام: الفكّة بخطٍّ ضخم + المستندات + إعادة الطباعة.
 *  نُقلت حرفياً من Reception.tsx (تفكيك §١٣ ش١) بصفر تغيير سلوكي. */
export function ReceiptOverlay({ lastSale, onReprint, onClose }: {
  lastSale: LastSaleSummary;
  onReprint: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/50 p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-sm space-y-3 rounded-2xl bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <span className="grid size-9 place-items-center rounded-full bg-money-positive/15 text-money-positive">
            <Check aria-hidden className="size-5" strokeWidth={3} />
          </span>
          <h3 className="text-lg font-extrabold">تمّ الطلب</h3>
        </div>
        {lastSale.changeStr && (
          <div className="rounded-xl border-2 border-money-positive/40 bg-money-positive/10 p-3 text-center">
            <div className="text-xs font-bold text-money-positive">الفكّة للزبون</div>
            <div className="text-4xl font-black tabular-nums text-money-positive" dir="ltr">{fmt(lastSale.changeStr)}</div>
          </div>
        )}
        {lastSale.creditStr && (
          <div className="rounded-xl border-2 border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-center">
            <div className="text-xs font-bold text-[var(--sem-warn)]">المتبقّي (آجل / عند الاستلام)</div>
            <div className="text-3xl font-black tabular-nums text-[var(--sem-warn)]" dir="ltr">{fmt(lastSale.creditStr)}</div>
          </div>
        )}
        <div className="space-y-1 rounded-lg border bg-muted/30 p-2.5 text-xs">
          {lastSale.invoiceNumbers.map((n) => (
            <div key={n} className="flex items-center justify-between">
              <span className="text-muted-foreground">فاتورة</span>
              <span className="font-bold tabular-nums" dir="ltr">{n}</span>
            </div>
          ))}
          {lastSale.workOrderNumbers.map((n) => (
            <div key={n} className="flex items-center justify-between">
              <span className="text-muted-foreground">طلب تخصيص</span>
              <span className="font-bold tabular-nums" dir="ltr">{n}</span>
            </div>
          ))}
          <div className="flex items-center justify-between border-t pt-1">
            <span className="text-muted-foreground">الإجمالي</span>
            <span className="font-extrabold tabular-nums" dir="ltr">{fmt(lastSale.totalStr)} د.ع</span>
          </div>
        </div>
        {lastSale.printFailures > 0 && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] font-bold text-destructive">
            تعذّرت طباعة {lastSale.printFailures} مستند — أعد الطباعة أدناه بعد فحص الطابعة.
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onReprint}>
            <Printer aria-hidden className="size-4 me-1" /> إعادة طباعة (F9)
          </Button>
          <Button className="flex-1" onClick={onClose}>
            طلب جديد (Esc)
          </Button>
        </div>
      </div>
    </div>
  );
}
