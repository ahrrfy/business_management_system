import { Link } from "wouter";
import { Truck, ArrowLeft, CheckCircle2, AlertTriangle, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/money";
import { trpc } from "@/lib/trpc";

export function DeliveryCustodyCard() {
  const board = trpc.delivery.partyBoard.useQuery(undefined, {
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const rows = board.data ?? [];
  const couriersWithCash = rows.filter(
    (r) => Number(r.deliveredUnremitted?.amount || 0) > 0 || Number(r.cashInHandLedger || 0) > 0
  );
  const totalUnremittedCash = rows.reduce(
    (acc, r) => acc + Number(r.deliveredUnremitted?.amount || 0),
    0
  );
  const totalStaleParcels = rows.reduce(
    (acc, r) => acc + (r.staleOpenParcels || 0),
    0
  );

  if (board.isLoading) {
    return (
      <div className="flex items-center justify-between rounded-md border bg-card p-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <Truck className="size-4 animate-pulse text-muted-foreground" />
          جارٍ فحص عهد وأمانات التوصيل لدى المناديب…
        </span>
      </div>
    );
  }

  if (board.isError) {
    return null;
  }

  const isClear = totalUnremittedCash <= 0 && couriersWithCash.length === 0;

  return (
    <div
      className={`relative overflow-hidden rounded-lg border p-4 transition-colors ${
        isClear
          ? "border-[var(--sem-pos)]/20 bg-[var(--sem-pos-bg)]/30"
          : "border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)]/20"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={`flex size-10 items-center justify-center rounded-lg ${
              isClear
                ? "bg-[var(--sem-pos)]/10 text-[var(--sem-pos)]"
                : "bg-[var(--sem-warn)]/10 text-[var(--sem-warn)]"
            }`}
          >
            {isClear ? (
              <CheckCircle2 className="size-5" />
            ) : (
              <Truck className="size-5" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-foreground">
                عهد ونقد التوصيل لدى المناديب
              </h3>
              {!isClear && (
                <span className="rounded-full bg-[var(--sem-warn)]/15 px-2 py-0.5 text-[11px] font-bold text-[var(--sem-warn)]">
                  {couriersWithCash.length} مناديب
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {isClear
                ? "كافة عهد التوصيل مصفّرة — لا يوجد نقد معلّق في الشارع."
                : "نقد طرود مُسلّمة بانتظار التوريد والإقفال في درج الوردية."}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {!isClear && (
            <div className="text-end">
              <span className="block text-[11px] text-muted-foreground">
                المبلغ المعلّق للتحصيل
              </span>
              <span
                className="text-base font-black tabular-nums text-foreground"
                dir="ltr"
              >
                {fmt(totalUnremittedCash)} د.ع
              </span>
            </div>
          )}

          <Button
            asChild
            size="sm"
            variant={isClear ? "outline" : "default"}
            className="gap-1.5 text-xs font-semibold"
          >
            <Link href="/delivery">
              <Wallet className="size-3.5" />
              {isClear ? "لوحة التوصيل" : "تسوية وتصفير العهد"}
              <ArrowLeft className="size-3" />
            </Link>
          </Button>
        </div>
      </div>

      {totalStaleParcels > 0 && (
        <div className="mt-3 flex items-center gap-1.5 rounded-md border border-[var(--sem-warn)]/20 bg-[var(--sem-warn-bg)]/40 px-2.5 py-1 text-[11px] text-[var(--sem-warn)] font-medium">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>
            تنبيه رقابي: يوجد {totalStaleParcels} طرد متأخر تجاوز مهلة التسليم المحددة.
          </span>
        </div>
      )}
    </div>
  );
}
