// تبويب «المراجعة والتسويات» (ش٧ + ش٩).
//
// يجمع الحالتين اللتين لا تُغلقان نفسيهما تلقائياً فتحتاجان عيناً بشرية:
//  ١) نيّاتٌ صدرت كروتُها ولم تُثبَّت بفاتورة (انقطاع/إغلاق متصفّح لحظة البيع). الرصيد فيها
//     **محجوزٌ لا مخصوم** — الحجز يبقى عمداً حتى يقرّر المدير، فلا يضيع أثر كرتٍ صدر فعلاً.
//  ٢) مطابقات محافظ بفرقٍ مفتوح: المطابقة تسجّل الفرق ولا تُعدّل الرصيد أبداً؛ إغلاقه يكون
//     بتعديلٍ معتمَد (SOD) ثم ربطه بالمطابقة هنا.
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Brush, Link2, TriangleAlert } from "lucide-react";
import { useState } from "react";

type Reconciliation = RouterOutputs["digitalCards"]["wallets"]["reconciliations"][number];

export default function DigitalReview() {
  const utils = trpc.useUtils();

  const needsReview = trpc.digitalCards.sales.needsReview.useQuery();
  const variances = trpc.digitalCards.wallets.reconciliations.useQuery({ status: "VARIANCE_OPEN" });
  const [resolving, setResolving] = useState<Reconciliation | null>(null);

  const sweepMut = trpc.digitalCards.sales.expireStale.useMutation({
    onSuccess: (r) => {
      void utils.digitalCards.sales.needsReview.invalidate();
      void utils.digitalCards.wallets.list.invalidate();
      notify.ok(
        "اكتمل الكنس",
        `حُرّر حجز ${r.expired} نيّة لم يصدر منها كرت · ${r.needsReview} نيّة صدرت كروتها انتقلت للمراجعة (حجزها باقٍ)`,
      );
    },
    onError: (e) => notify.err(e),
  });

  const cancelMut = trpc.digitalCards.sales.cancelIntent.useMutation({
    // الخادم يقرّر المصير ولا يُحرَّر حجزُ نيّةٍ صدر كرتها أبداً (المال مستحقّ للمزوّد فعلاً).
    // نعرض ما حدث **حقيقةً** لا ما تمنّيناه — رسالةُ نجاحٍ كاذبة على شاشةٍ مالية أسوأ من لا رسالة.
    onSuccess: (r) => {
      void utils.digitalCards.sales.needsReview.invalidate();
      void utils.digitalCards.wallets.list.invalidate();
      if (r.outcome === "CANCELLED") {
        notify.ok("أُلغيت النيّة وحُرّر حجزها");
      } else {
        notify.warn(
          "النيّة تبقى تحت المراجعة",
          "صدر كرتٌ من هذه النيّة فعلاً، فحجز المحفظة لا يُحرَّر — قيمته مستحقّة للمزوّد. عالِجها بتثبيت البيع أو بتسوية مع المزوّد.",
        );
      }
    },
    onError: (e) => notify.err(e),
  });

  async function sweep() {
    if (!(await confirm({
      title: "كنس النيّات المتقادمة",
      description: "يحرّر حجز النيّات التي انقضت مهلتها ولم يصدر منها كرت، وينقل التي صدرت كروتها إلى طابور المراجعة دون تحرير حجزها. لا يُنشئ فواتير ولا يخصم رصيداً. متابعة؟",
      confirmText: "كنس",
    }))) return;
    sweepMut.mutate();
  }

  /**
   * `reserved` = حصص المزوّد المحجوزة (لا سعر البيع). الحجز **لا يُحرَّر** ما دام كرتٌ صدر —
   * فلا يَعِد النصّ بما لن يقع؛ يشرح الشرط ويترك القرار للخادم.
   */
  async function cancelIntent(id: number, reserved: string, issued: number) {
    if (!(await confirm({
      variant: "danger",
      title: "إلغاء النيّة",
      description: issued > 0
        ? `صدر ${issued} كرتاً من هذه النيّة، فحجز المحفظة (${fmtAr(reserved)}) يبقى كما هو — قيمته مستحقّة للمزوّد ولا تعود بالإلغاء. الإلغاء هنا يُثبّت أنها روجعت فقط. متابعة؟`
        : `سيعود ${fmtAr(reserved)} من رصيد المحفظة المحجوز إلى المتاح. افعل هذا فقط بعد التأكّد أن الكرت لم يُسلَّم للعميل.`,
      confirmText: "إلغاء النيّة",
    }))) return;
    cancelMut.mutate({ intentId: id, reason: "مراجعة إشرافية: الكرت لم يُسلَّم" });
  }

  const queue = needsReview.data ?? [];
  const openVariances = variances.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="المراجعة والتسويات"
        description="عمليات لا تُغلق نفسها: كروتٌ صدرت ولم تُثبَّت بفاتورة، وفروق مطابقة محافظ تنتظر تعديلاً معتمَداً."
        actions={
          <Button size="sm" variant="outline" disabled={sweepMut.isPending} onClick={() => void sweep()}>
            <Brush className="size-4" /> {sweepMut.isPending ? "جارٍ الكنس…" : "كنس النيّات المتقادمة"}
          </Button>
        }
      />

      <Card>
        <CardHeader className="flex flex-row items-center gap-2 text-sm font-medium">
          <TriangleAlert aria-hidden className="size-4" />
          كروتٌ صدرت بلا فاتورة ({queue.length})
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">النيّة</th>
                  <th className="p-2 text-start">الفرع</th>
                  <th className="p-2 text-start">قيمة البيع</th>
                  <th className="p-2 text-start">المحجوز</th>
                  <th className="p-2 text-start">صدر / الإجمالي</th>
                  <th className="p-2 text-start">أُنشئت</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-2 font-mono text-xs" dir="ltr">#{r.id}</td>
                    <td className="p-2 text-muted-foreground">{r.branchName}</td>
                    <td className="p-2 tabular-nums text-muted-foreground">{fmtAr(r.expectedTotal)}</td>
                    <td className="p-2 tabular-nums font-medium">{fmtAr(r.reservedAmount)}</td>
                    <td className="p-2 tabular-nums">
                      {Number(r.successCount)} / {Number(r.itemCount)}
                    </td>
                    <td className="p-2 text-muted-foreground">{fmtDate(r.createdAt)}</td>
                    <td className="p-2 text-center">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={cancelMut.isPending}
                        onClick={() => void cancelIntent(r.id, r.reservedAmount, Number(r.successCount))}
                      >
                        إلغاء النيّة
                      </Button>
                    </td>
                  </tr>
                ))}
                {needsReview.isLoading && <tr><td colSpan={7}><LoadingState /></td></tr>}
                {!needsReview.isLoading && queue.length === 0 && (
                  <TableEmptyRow colSpan={7} message="لا شيء للمراجعة — كل الكروت الصادرة مثبّتة بفواتيرها." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium">
          فروق مطابقة مفتوحة ({openVariances.length})
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">المحفظة</th>
                  <th className="p-2 text-start">الفرع</th>
                  <th className="p-2 text-start">اليوم</th>
                  <th className="p-2 text-start">المتوقَّع</th>
                  <th className="p-2 text-start">الفعليّ</th>
                  <th className="p-2 text-start">الفرق</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {openVariances.map((v) => (
                  <tr key={v.id} className="border-t">
                    <td className="p-2 font-medium">{v.walletName}</td>
                    <td className="p-2 text-muted-foreground">{v.branchName}</td>
                    <td className="p-2" dir="ltr">{v.businessDate}</td>
                    <td className="p-2 tabular-nums text-muted-foreground">{fmtAr(v.expectedBalance)}</td>
                    <td className="p-2 tabular-nums">{fmtAr(v.actualBalance)}</td>
                    <td className="p-2 tabular-nums font-medium text-destructive">{fmtAr(v.variance)}</td>
                    <td className="p-2 text-center">
                      <Button size="sm" variant="outline" onClick={() => setResolving(v)}>
                        <Link2 className="size-4" /> ربط بتعديل معتمَد
                      </Button>
                    </td>
                  </tr>
                ))}
                {variances.isLoading && <tr><td colSpan={7}><LoadingState /></td></tr>}
                {!variances.isLoading && openVariances.length === 0 && (
                  <TableEmptyRow colSpan={7} message="لا فروق مفتوحة — كل المطابقات مغلقة." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <ResolveVarianceDialog reconciliation={resolving} onClose={() => setResolving(null)} />
    </div>
  );
}

/** إغلاق فرق المطابقة: يربطه بتعديلٍ **معتمَد** على المحفظة نفسها — لا يُنشئ حركةً ولا يمسّ الرصيد. */
function ResolveVarianceDialog({
  reconciliation, onClose,
}: { reconciliation: Reconciliation | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [txId, setTxId] = useState<number | null>(null);

  const statement = trpc.digitalCards.wallets.statement.useQuery(
    { walletId: reconciliation?.walletId ?? 0 },
    { enabled: reconciliation != null },
  );

  const mut = trpc.digitalCards.wallets.resolveVariance.useMutation({
    onSuccess: () => {
      void utils.digitalCards.wallets.reconciliations.invalidate();
      setTxId(null);
      notify.ok("أُغلق الفرق", "الرصيد لم يتغيّر بهذا الإجراء — التعديل المعتمَد هو من غيّره.");
      onClose();
    },
    onError: (e) => notify.err(e),
  });

  // التعديلات النافذة وحدها: المعلَّق لم يُغيّر الرصيد بعد، والمرفوض لن يُغيّره أبداً.
  const adjustments = (statement.data ?? []).filter((t) => t.type === "ADJUSTMENT" && t.status === "ACTIVE");

  return (
    <Dialog open={reconciliation != null} onOpenChange={(o) => { if (!o) { setTxId(null); onClose(); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>إغلاق فرق المطابقة — {reconciliation?.walletName}</DialogTitle>
          <DialogDescription>
            الفرق يُغلَق بتعديل رصيدٍ <strong>معتمَد</strong> من مديرٍ آخر، لا بإغلاقٍ مباشر. إن لم يظهر تعديلٌ
            هنا فأنشئه أوّلاً من «طلب تعديل رصيد» في شاشة المحافظ، واعتمِدهُ، ثم عُد.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md bg-muted p-3 text-sm">
          فرق يوم <span dir="ltr">{reconciliation?.businessDate}</span>:{" "}
          <span className="font-bold tabular-nums">{fmtAr(reconciliation?.variance ?? "0")}</span>
        </div>

        <div className="space-y-2">
          {statement.isLoading && <LoadingState />}
          {!statement.isLoading && adjustments.length === 0 && (
            <p className="text-sm text-muted-foreground">
              لا تعديلات معتمَدة على هذه المحفظة بعد.
            </p>
          )}
          {adjustments.map((t) => (
            <label
              key={t.id}
              className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm ${txId === t.id ? "border-primary bg-accent" : ""}`}
            >
              <input
                type="radio"
                name="dcr-adjustment"
                className="size-4"
                checked={txId === t.id}
                onChange={() => setTxId(t.id)}
              />
              <span className="tabular-nums font-medium">
                {t.direction === "IN" ? "+" : "−"}{fmtAr(t.amount)}
              </span>
              <span className="text-muted-foreground truncate">{t.notes || "بلا ملاحظة"}</span>
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>إلغاء</Button>
          <Button
            size="sm"
            disabled={mut.isPending || txId == null}
            onClick={() => {
              if (!reconciliation || txId == null) return notify.err("اختر التعديل المعتمَد المقابل");
              mut.mutate({ reconciliationId: reconciliation.id, adjustmentTransactionId: txId });
            }}
          >
            {mut.isPending ? "جارٍ الإغلاق…" : "إغلاق الفرق"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
