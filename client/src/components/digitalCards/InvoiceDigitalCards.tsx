// بطاقات رقمية داخل فاتورة بيع + مسار العكس (ش١٢).
//
// لماذا هنا لا في شاشة مستقلّة: المرتجع العام **يرفض** البنود الرقمية (حارس في returnService)،
// فلو لم يكن للعكس مدخلٌ من الفاتورة نفسها لبقي المدير أمام فاتورةٍ لا يستطيع معالجتها.
// المدخل في مكان القرار الطبيعيّ: الفاتورة التي بين يديه.
//
// حالتان لا ثالثة (§١٥):
//  • عكسٌ مؤكَّد — المزوّد أعاد الحصة ⇒ الصافي صفريّ (إيراد يزول، حصة تعود، محفظة/ذمّة تنعكس).
//  • ردّ خسارة — لم يُعِدها ⇒ الإيراد يزول والحصة تبقى تكلفةً ⇒ خسارةٌ ظاهرةٌ بمقدار الحصة.
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { digitalSaleReferenceLabel } from "@shared/digitalSale";
import { RotateCcw } from "lucide-react";
import { useState } from "react";

const FULFILLMENT: Record<string, string> = {
  ISSUED: "صادر",
  REVERSED: "معكوس",
  LOSS: "خسارة مُقيَّدة",
};

const SETTLEMENT: Record<string, string> = {
  PREPAID: "مسبق الدفع",
  POSTPAID: "آجل",
};

export function InvoiceDigitalCards({ invoiceId }: { invoiceId: number }) {
  const me = trpc.auth.me.useQuery();
  const role = (me.data?.role ?? "") as RoleKey;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;

  // مرآة `digitalCardsAdminReadProcedure` بالضبط (manager/accountant/auditor + منح صريح).
  const canRead = !!me.data?.role &&
    moduleAccessAllowed(role, override, "digital_cards", "READ", ["manager", "accountant", "auditor"]);
  // مرآة `digitalCardsManagerProcedure` (moduleProcedure(["manager"],…,"FULL")) — العكس قرارٌ مديريّ.
  const canReverse = !!me.data?.role &&
    moduleAccessAllowed(role, override, "digital_cards", "FULL", ["manager"]);

  const details = trpc.digitalCards.sales.saleDetails.useQuery(
    { invoiceId },
    { enabled: Number.isFinite(invoiceId) && canRead, retry: false },
  );

  const [reversing, setReversing] = useState(false);

  const rows = details.data ?? [];
  // فاتورة بلا كروت: لا تُعرض البطاقة أصلاً كي لا تتغيّر شاشة الفواتير العادية.
  if (!canRead || (!details.isLoading && rows.length === 0)) return null;

  const anyReversible = rows.some((r) => r.fulfillmentStatus === "ISSUED");

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between gap-2">
            <span>البطاقات الرقمية</span>
            {canReverse && anyReversible && (
              <Button size="sm" variant="outline" onClick={() => setReversing(true)}>
                <RotateCcw className="size-4" /> عكس بطاقة
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">البطاقة / الاشتراك</th>
                  <th className="p-2 text-start">التسوية</th>
                  <th className="p-2 text-start">سعر البيع</th>
                  <th className="p-2 text-start">حصة المزوّد</th>
                  <th className="p-2 text-start">الربح</th>
                  <th className="p-2 text-start">رقم العملية / الاشتراك</th>
                  <th className="p-2 text-start">الطالب</th>
                  <th className="p-2 text-start">هاتف الطالب</th>
                  <th className="p-2 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-2 font-medium">{r.offeringName}</td>
                    <td className="p-2 text-muted-foreground">{SETTLEMENT[r.settlementMode] ?? r.settlementMode}</td>
                    <td className="p-2 tabular-nums font-medium">{fmtAr(r.sellPrice)}</td>
                    <td className="p-2 tabular-nums text-muted-foreground">{fmtAr(r.providerShare)}</td>
                    <td className="p-2 tabular-nums">{fmtAr(r.profit)}</td>
                    <td className="p-2">
                      <span className="block text-xs text-muted-foreground">{digitalSaleReferenceLabel(r.offeringType)}</span>
                      <strong className="font-mono text-sm" dir="ltr">{r.providerReference || "—"}</strong>
                    </td>
                    <td className="p-2">{r.studentName || "—"}</td>
                    <td className="p-2 font-mono text-xs" dir="ltr">{r.studentPhone || "—"}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                        r.fulfillmentStatus === "ISSUED" ? "badge-status-active" : "badge-status-neutral"
                      }`}>
                        {FULFILLMENT[r.fulfillmentStatus] ?? r.fulfillmentStatus}
                      </span>
                    </td>
                  </tr>
                ))}
                {details.isLoading && <tr><td colSpan={9}><LoadingState /></td></tr>}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {canReverse && (
        <ReversalDialog open={reversing} invoiceId={invoiceId} onClose={() => setReversing(false)} />
      )}
    </>
  );
}

function ReversalDialog({
  open, invoiceId, onClose,
}: { open: boolean; invoiceId: number; onClose: () => void }) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const [selected, setSelected] = useState<number[]>([]);
  const [reason, setReason] = useState("");

  const q = trpc.digitalCards.reversal.reversible.useQuery({ invoiceId }, { enabled: open });

  function done(msg: string, detail?: string) {
    void utils.digitalCards.sales.saleDetails.invalidate({ invoiceId });
    void utils.digitalCards.reversal.reversible.invalidate({ invoiceId });
    void utils.sales.get.invalidate({ invoiceId });
    setSelected([]); setReason("");
    notify.ok(msg, detail);
    onClose();
  }

  const approveMut = trpc.digitalCards.reversal.approve.useMutation({
    onSuccess: () => done("تمّ العكس المؤكَّد", "الإيراد والحصة زالا معاً — صافي أثر الفاتورة صفر."),
    onError: (e) => notify.err(e),
  });
  const requestLossMut = trpc.digitalCards.reversal.requestLossRefund.useMutation({
    onSuccess: (r) => done(
      "سُجّل طلب ردّ الخسارة",
      `${fmtAr(r.refund)} تنتظر اعتماد مديرٍ آخر — لم يُردَّ مالٌ بعد ولم تُسجَّل خسارة.`,
    ),
    onError: (e) => notify.err(e),
  });
  const lossMut = trpc.digitalCards.reversal.lossRefund.useMutation({
    onSuccess: () => done("اعتُمد ردّ الخسارة", "الإيراد زال وبقيت حصة المزوّد تكلفةً على المكتبة."),
    onError: (e) => notify.err(e),
  });
  const rejectLossMut = trpc.digitalCards.reversal.rejectLossRefund.useMutation({
    onSuccess: () => done("رُفض طلب ردّ الخسارة", "عادت البطاقات كما كانت بلا أثرٍ ماليّ."),
    onError: (e) => notify.err(e),
  });

  // المعكوس/المردود نهائياً لا يُعرَض؛ والمعلّق يُعرَض ليُعتمَد أو يُرفَض.
  const rows = (q.data ?? []).filter(
    (r) => r.fulfillmentStatus === "ISSUED" || r.fulfillmentStatus === "LOSS_REFUND_PENDING",
  );
  const pendingRows = rows.filter((r) => r.fulfillmentStatus === "LOSS_REFUND_PENDING");
  const issuedRows = rows.filter((r) => r.fulfillmentStatus === "ISSUED");
  const busy = approveMut.isPending || lossMut.isPending || requestLossMut.isPending || rejectLossMut.isPending;

  const selectedPending = pendingRows.filter((r) => selected.includes(r.id));
  const selectedIssued = issuedRows.filter((r) => selected.includes(r.id));
  /** مرآة حارس الخادم: لا يعتمد الطلبَ مَن قدّمه (admin مُستثنى). */
  const ownPendingSelected = selectedPending.length > 0 &&
    me.data?.role !== "admin" &&
    selectedPending.every((r) => Number(r.lossRefundRequestedBy) === Number(me.data?.id));

  function submit(kind: "approve" | "requestLoss") {
    if (!selectedIssued.length) return notify.err("اختر بطاقةً صادرة واحدة على الأقل");
    if (reason.trim().length < 3) return notify.err("اكتب سبباً واضحاً");
    const detailIds = selectedIssued.map((r) => r.id);
    if (kind === "approve") approveMut.mutate({ invoiceId, detailIds, reason: reason.trim() });
    else requestLossMut.mutate({ invoiceId, detailIds, reason: reason.trim() });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>عكس بطاقة رقمية</DialogTitle>
          <DialogDescription>
            المرتجع العام لا يقبل البنود الرقمية — الكرت المُصدَر لا يعود للمخزون. اختر البطاقات
            ثم حدّد: هل أعاد المزوّد حصته أم لا؟ الفرق بين الخيارين هو من يتحمّل الحصة.
          </DialogDescription>
        </DialogHeader>

        <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 text-center w-10"><span className="sr-only">اختيار</span></th>
                <th className="p-2 text-start">سعر البيع</th>
                <th className="p-2 text-start">مرجع التنفيذ</th>
                <th className="p-2 text-start">الطالب</th>
                <th className="p-2 text-start">التسوية</th>
                <th className="p-2 text-center">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2 text-center">
                    <input
                      type="checkbox"
                      className="size-4"
                      aria-label={`اختيار البطاقة ${r.providerReference ?? r.id}`}
                      checked={selected.includes(r.id)}
                      onChange={(e) =>
                        setSelected((prev) =>
                          e.target.checked ? [...prev, r.id] : prev.filter((x) => x !== r.id),
                        )
                      }
                    />
                  </td>
                  <td className="p-2 tabular-nums font-medium">{fmtAr(r.sellPrice)}</td>
                  <td className="p-2 font-mono text-xs" dir="ltr">{r.providerReference || "—"}</td>
                  <td className="p-2">{r.studentName || "—"}</td>
                  <td className="p-2 text-muted-foreground">{SETTLEMENT[r.settlementMode] ?? r.settlementMode}</td>
                  <td className="p-2 text-center">
                    {r.fulfillmentStatus === "LOSS_REFUND_PENDING" ? (
                      <span className="inline-block rounded-full px-2 py-0.5 text-xs badge-status-pending" title={r.lossRefundReason ?? undefined}>
                        ردُّ خسارةٍ بانتظار الاعتماد
                      </span>
                    ) : (
                      <span className="inline-block rounded-full px-2 py-0.5 text-xs badge-status-neutral">صادر</span>
                    )}
                  </td>
                </tr>
              ))}
              {q.isLoading && <tr><td colSpan={6}><LoadingState /></td></tr>}
              {!q.isLoading && rows.length === 0 && (
                <TableEmptyRow colSpan={6} message="لا بطاقات قابلة للعكس في هذه الفاتورة." />
              )}
            </tbody>
          </table>
        </ScrollTableShell>

        {selectedIssued.length > 0 && (
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="dcr-reason">السبب (إلزامي)</label>
            <Input
              id="dcr-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="كرت لم يصل العميل، شحن على رقم خاطئ…"
              dir="auto"
            />
          </div>
        )}

        {selectedPending.length > 0 && (
          <p className="rounded-md bg-muted p-3 text-sm">
            {selectedPending.length} بطاقة عليها طلب ردّ خسارةٍ معلّق. الاعتماد يردّ المال
            <strong> ويسجّل الخسارة</strong> فعلاً؛ والرفض يعيدها كما كانت.
            {ownPendingSelected && (
              <span className="block pt-1 text-destructive">
                لا تعتمد طلباً قدّمتَه بنفسك — يلزم مديرٌ آخر.
              </span>
            )}
          </p>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" size="sm" onClick={onClose}>إلغاء</Button>

          {selectedPending.length > 0 ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || ownPendingSelected}
                onClick={() => rejectLossMut.mutate({ invoiceId, detailIds: selectedPending.map((r) => r.id) })}
              >
                رفض الطلب
              </Button>
              <Button
                size="sm"
                disabled={busy || ownPendingSelected}
                onClick={() => lossMut.mutate({ invoiceId, detailIds: selectedPending.map((r) => r.id) })}
              >
                {busy ? "جارٍ التنفيذ…" : "اعتماد ردّ الخسارة"}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || selectedIssued.length === 0}
                onClick={() => submit("requestLoss")}
              >
                لم يُعِد الحصة — طلب ردّ خسارة
              </Button>
              <Button
                size="sm"
                disabled={busy || selectedIssued.length === 0}
                onClick={() => submit("approve")}
              >
                {busy ? "جارٍ التنفيذ…" : "المزوّد أعاد الحصة (عكس مؤكَّد)"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
