// تاريخ الموجات المطبَّقة + تفاصيل الموجة + **التراجع** + جسر ملصقات الرفّ.
//
// كان هذا الجدول عرضاً ميّتاً: أسماء وأرقام بلا فعل. وكانت الشاشة تقول للمدير «لا تراجع تلقائي —
// أنشئ موجة عكسية»، وهي نصيحةٌ **غير صحيحة رياضياً** (عكسُ رفعٍ ‎10٪ ليس تخفيضاً ‎10٪:
// ‎100 → ‎110 → ‎99). الأسعار السابقة محفوظةٌ كاملةً في `priceChangeLog.oldPrice` منذ اليوم الأول،
// فالتراجع كان **مبنياً في البيانات وغير مُتاحٍ في المنتَج**.
import { useState } from "react";
import { Eye, RotateCcw, Tag, Undo2 } from "lucide-react";
import {
  PRICE_CHANGE_LABELS,
  type PriceChangeType,
} from "@shared/priceWaveRule";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { priceTierLabel } from "@/lib/labels";
import { seedLabelQueue } from "@/lib/labelQueueSeed";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const th = "px-3 py-2 text-right font-medium whitespace-nowrap";
const td = "px-3 py-2 align-middle";

function changeLabel(t: string): string {
  if (t === "REVERT") return "تراجع (استعادة أسعار سابقة)";
  return PRICE_CHANGE_LABELS[t as PriceChangeType] ?? t;
}

export function WaveHistory({
  onError,
  onInfo,
}: {
  onError: (m: string) => void;
  onInfo: (m: string) => void;
}) {
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  // ترقيم تاريخ الموجات: يبدأ بـ٥٠ ويتوسّع بزرّ «تحميل المزيد» (السقف الخادمي ٢٠٠).
  const [historyLimit, setHistoryLimit] = useState(50);
  const wavesQ = trpc.priceWaves.list.useQuery({ limit: historyLimit });
  const [detailsWaveId, setDetailsWaveId] = useState<number | null>(null);
  const detailsQ = trpc.priceWaves.waveDetails.useQuery(
    { waveId: detailsWaveId! },
    { enabled: detailsWaveId != null },
  );

  const revertM = trpc.priceWaves.revert.useMutation();

  const waves = wavesQ.data ?? [];

  async function runRevert(
    wave: { id: number; name: string; totalRows: number },
    force: boolean,
  ): Promise<void> {
    const res = await revertM.mutateAsync({ waveId: wave.id, force });
    await utils.priceWaves.list.invalidate();
    await utils.priceWaves.waveDetails.invalidate();
    // التراجع تغييرُ أسعارٍ كالموجة تماماً ⇒ الكتالوج المخزَّن صار قديماً.
    await utils.catalog.invalidate();
    onError("");
    onInfo(
      `تمّت الاستعادة: ${res.restoredRows} صفّاً عاد لسعره السابق (موجة تراجع #${res.waveId})` +
        (res.conflicts.length
          ? ` — تُرك ${res.conflicts.length} صفّاً تغيّر بعد الموجة.`
          : "."),
    );
  }

  /**
   * التراجع بخطوةٍ واحدة في الحالة النظيفة، وبخطوتين حين يكون هناك تعارض: الخادم يرفض أوّلاً
   * ويشرح **كم صفّاً تغيّر بعد الموجة**، ثم يقرّر المدير صراحةً استعادة الباقي. لا استعادةَ
   * صامتة تمحو تغييراً أحدث، ولا طريقٌ مسدود بلا بديل.
   */
  async function doRevert(wave: {
    id: number;
    name: string;
    totalRows: number;
  }) {
    const ok = await confirm({
      variant: "warning",
      title: "التراجع عن موجة تسعير",
      description: `سيعود ${wave.totalRows} صفّاً إلى سعره قبل موجة «${wave.name}». تُوثَّق الاستعادة كموجة تراجع، ولا يُمحى تاريخ الموجة الأصلية.`,
      confirmText: "تراجع",
    });
    if (!ok) return;
    try {
      await runRevert(wave, false);
    } catch (e: any) {
      const message = String(e?.message ?? "تعذّر التراجع");
      if (e?.data?.code !== "CONFLICT") {
        onError(message);
        return;
      }
      const proceed = await confirm({
        variant: "warning",
        title: "بعض الصفوف تغيّرت بعد هذه الموجة",
        description: `${message} استعادتها تمحو تغييراً أحدث منها.`,
        confirmText: "استعِد الباقي",
      });
      if (!proceed) return;
      try {
        await runRevert(wave, true);
      } catch (e2: any) {
        onError(String(e2?.message ?? "تعذّر التراجع"));
      }
    }
  }

  function printLabelsFor(
    waveId: number,
    rows: Array<{ productUnitId: number; priceTier: string }>,
    waveName: string,
  ) {
    // ملصق الرفّ يحمل سعر فئةٍ واحدة. موجةٌ مسّت أكثر من فئة ⇒ نطبع «المفرد» إن كان ضمنها
    // (وهو سعر الرفّ)، وإلّا فئةَ الموجة الوحيدة. الخلط كان يطبع أسعار المفرد لموجة جملةٍ صرفة.
    const tiers = Array.from(new Set(rows.map((r) => r.priceTier)));
    const tier = (tiers.includes("RETAIL") ? "RETAIL" : tiers[0]) as
      | "RETAIL"
      | "WHOLESALE"
      | "GOVERNMENT";
    const scoped = rows.filter((r) => r.priceTier === tier);
    const n = seedLabelQueue(
      scoped.map((r) => r.productUnitId),
      {
        tier,
        note:
          `أسعارها تغيّرت بموجة «${waveName}» #${waveId}` +
          (tiers.length > 1 ? ` (فئة ${priceTierLabel(tier)} وحدها)` : ""),
      },
    );
    if (!n) {
      onError(
        "تعذّر تجهيز قائمة الملصقات — أضِف الأصناف يدوياً من تبويب الملصقات.",
      );
      return;
    }
    onInfo(
      `جُهِّز ${n} صنفاً لطباعة الملصقات — انتقل إلى تبويب «ملصقات الباركود».`,
    );
    setDetailsWaveId(null);
    // نفس صفحة المخزون، تبويبٌ آخر — انتقالٌ داخل الـSPA بلا إعادة تحميل.
    navigate("/inventory?tab=barcodes");
  }

  const detailRows = detailsQ.data ?? [];
  const detailWave = waves.find((w) => Number(w.id) === detailsWaveId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          تاريخ الموجات المطبَّقة ({waves.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {waves.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            لا موجات بعد.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className={th}>التاريخ</th>
                  <th className={th}>الاسم</th>
                  <th className={th}>نوع التغيير</th>
                  <th className={th}>القيمة</th>
                  <th className={th}>الصفوف</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {waves.map((w: any) => {
                  const isRevert = w.changeType === "REVERT";
                  const canRevert = !isRevert && !w.isReverted;
                  return (
                    <tr
                      key={w.id}
                      className={cn("border-t", w.isReverted && "opacity-60")}
                    >
                      <td
                        className={cn(
                          td,
                          "whitespace-nowrap text-xs text-muted-foreground tabular-nums",
                        )}
                        dir="ltr"
                      >
                        {fmtDateTime(w.appliedAt)}
                      </td>
                      <td className={cn(td, "font-medium")}>
                        {w.name}
                        {isRevert && w.revertsWaveId != null && (
                          <Badge variant="outline" className="mr-1 text-[10px]">
                            <Undo2 aria-hidden className="size-3" />
                            تراجع عن #{w.revertsWaveId}
                          </Badge>
                        )}
                        {w.isReverted && (
                          <Badge
                            variant="secondary"
                            className="mr-1 text-[10px]"
                          >
                            مُتراجَعٌ عنها
                          </Badge>
                        )}
                      </td>
                      <td className={td}>{changeLabel(w.changeType)}</td>
                      <td className={cn(td, "tabular-nums")} dir="ltr">
                        {isRevert ? "—" : nf.format(Number(w.changeValue))}
                      </td>
                      <td className={cn(td, "tabular-nums")} dir="ltr">
                        {w.totalRows}
                      </td>
                      <td className={cn(td, "text-left")}>
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDetailsWaveId(Number(w.id))}
                          >
                            <Eye aria-hidden className="size-3.5" />
                            تفاصيل
                          </Button>
                          {canRevert && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={revertM.isPending}
                              onClick={() =>
                                void doRevert({
                                  id: Number(w.id),
                                  name: w.name,
                                  totalRows: w.totalRows,
                                })
                              }
                              title="استعادة الأسعار التي كانت قبل هذه الموجة"
                            >
                              <RotateCcw aria-hidden className="size-3.5" />
                              تراجع
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {waves.length >= historyLimit && historyLimit < 200 && (
          <div className="flex justify-center pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setHistoryLimit((v) => Math.min(200, v + 50))}
              disabled={wavesQ.isFetching}
            >
              {wavesQ.isFetching ? "جارٍ التحميل…" : "تحميل المزيد"}
            </Button>
          </div>
        )}

        <Dialog
          open={detailsWaveId != null}
          onOpenChange={(open) => !open && setDetailsWaveId(null)}
        >
          <DialogContent className="max-w-4xl">
            <DialogHeader>
              <DialogTitle>
                تفاصيل موجة التسعير{detailWave ? ` — ${detailWave.name}` : ""}
              </DialogTitle>
              <DialogDescription>
                كل صفٍّ تغيَّر ضمن هذه الموجة — السعر قبل وبعد لكل منتج/وحدة/فئة
                سعر.
                {detailRows.length > 0 &&
                  " سعرٌ تغيّر يعني ملصق رفٍّ صار يكذب — اطبع الملصقات من الزرّ أدناه."}
              </DialogDescription>
            </DialogHeader>
            {detailsQ.isLoading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                جارٍ التحميل…
              </div>
            ) : detailRows.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                لا صفوف مسجَّلة لهذه الموجة.
              </div>
            ) : (
              <div className="max-h-96 overflow-auto rounded-md border">
                <table className="w-full min-w-[44rem] text-sm">
                  <thead className="sticky top-0 bg-muted/95 text-xs text-muted-foreground backdrop-blur">
                    <tr>
                      <th className={th}>المنتج</th>
                      <th className={th}>SKU</th>
                      <th className={th}>الوحدة</th>
                      <th className={th}>فئة السعر</th>
                      <th className={th}>السعر القديم</th>
                      <th className={th}>السعر الجديد</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailRows.map((r) => (
                      <tr key={r.id} className="border-t">
                        <td className={td}>{r.productName ?? "—"}</td>
                        <td className={cn(td, "text-xs text-muted-foreground")}>
                          {r.sku ?? "—"}
                        </td>
                        <td className={td}>{r.unitName ?? "—"}</td>
                        <td className={td}>
                          {priceTierLabel(r.priceTier as string)}
                        </td>
                        <td className={cn(td, "tabular-nums")} dir="ltr">
                          {r.oldPrice == null
                            ? "—"
                            : nf.format(Number(r.oldPrice))}
                        </td>
                        <td
                          className={cn(td, "font-semibold tabular-nums")}
                          dir="ltr"
                        >
                          {nf.format(Number(r.newPrice))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <DialogFooter className="gap-2 sm:justify-between">
              <div className="flex flex-wrap gap-2">
                {detailRows.length > 0 && detailsWaveId != null && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      printLabelsFor(
                        detailsWaveId,
                        detailRows,
                        detailWave?.name ?? "",
                      )
                    }
                  >
                    <Tag aria-hidden className="size-4" />
                    طباعة ملصقات الأصناف المتأثّرة ({detailRows.length})
                  </Button>
                )}
                {detailWave &&
                  detailWave.changeType !== "REVERT" &&
                  !detailWave.isReverted && (
                    <Button
                      variant="outline"
                      disabled={revertM.isPending}
                      onClick={() =>
                        void doRevert({
                          id: Number(detailWave.id),
                          name: detailWave.name,
                          totalRows: detailWave.totalRows,
                        })
                      }
                    >
                      <RotateCcw aria-hidden className="size-4" />
                      تراجع عن هذه الموجة
                    </Button>
                  )}
              </div>
              <Button variant="outline" onClick={() => setDetailsWaveId(null)}>
                إغلاق
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
