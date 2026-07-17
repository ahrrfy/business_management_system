/* ============================================================================
 * شاشة سلف الموظفين — تبويب في hub الموارد البشرية (بند 12ج).
 *
 * قائمة السلف بفلاتر (الحالة/الموظف) + الأرصدة المتبقية + منح سلفة بحوار (سند صرف حقيقي
 * من الخزينة عبر createVoucher) + إلغاء (متاح فقط قبل أي خصم — remaining == amount).
 * الخصم التلقائي يظهر في مسيّر الرواتب (عمود الاستقطاع: «منه سلفة») عند التوليد.
 * ========================================================================== */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { confirm } from "@/lib/confirm";
import { EmpAvatar, iqd } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { D } from "@/lib/money";
import { HandCoins, Plus, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATUS_LABEL: Record<string, string> = { ACTIVE: "نشطة", SETTLED: "مسوّاة", CANCELLED: "ملغاة" };
const STATUS_CLS: Record<string, string> = {
  ACTIVE: "badge-status-pending",
  SETTLED: "badge-status-active",
  CANCELLED: "bg-muted text-muted-foreground",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${STATUS_CLS[status] ?? "bg-muted text-muted-foreground"}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export default function EmployeeAdvances() {
  const utils = trpc.useUtils();
  const [status, setStatus] = useState<"" | "ACTIVE" | "SETTLED" | "CANCELLED">("ACTIVE");
  const [q, setQ] = useState("");
  const [grantOpen, setGrantOpen] = useState(false);

  const listQ = trpc.payroll.advancesList.useQuery(status ? { status } : undefined);
  const rows = listQ.data ?? [];

  const filtered = useMemo(() => {
    const t = q.trim();
    if (!t) return rows;
    return rows.filter((r) => r.employeeName.includes(t) || (r.voucherNumber ?? "").includes(t));
  }, [rows, q]);

  const totals = useMemo(() => {
    let remaining = D(0);
    let amount = D(0);
    for (const r of filtered) {
      amount = amount.plus(D(r.amount));
      if (r.status === "ACTIVE") remaining = remaining.plus(D(r.remaining));
    }
    return { amount: amount.toFixed(2), remaining: remaining.toFixed(2) };
  }, [filtered]);

  const refresh = () => utils.payroll.advancesList.invalidate();

  const cancelM = trpc.payroll.advanceCancel.useMutation({
    onSuccess: async (res) => {
      notify.ok(res.voucherNotice);
      await refresh();
    },
    onError: (e) => notify.err(e),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="سلف الموظفين"
        description="تُمنح السلفة بسند صرف حقيقي من الخزينة وتُخصم تلقائياً من مسيّرات الرواتب حتى التسوية."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="حالة السلفة">
              <option value="">كل الحالات</option>
              <option value="ACTIVE">نشطة</option>
              <option value="SETTLED">مسوّاة</option>
              <option value="CANCELLED">ملغاة</option>
            </select>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث باسم الموظف أو رقم السند…" className="h-8 w-56" aria-label="بحث" />
            <Button onClick={() => setGrantOpen(true)}>
              <Plus className="size-4" aria-hidden /> منح سلفة
            </Button>
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HandCoins className="size-4 text-primary" aria-hidden />
            {listQ.isLoading ? "سلف الموظفين" : `${filtered.length} سلفة — إجمالي ${iqd(totals.amount)} د.ع، المتبقّي النشط ${iqd(totals.remaining)} د.ع`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2.5">الموظف</th>
                  <th className="p-2.5">الفرع</th>
                  <th className="p-2.5 text-right">المبلغ</th>
                  <th className="p-2.5 text-right">المتبقّي</th>
                  <th className="p-2.5 text-right">الخصم الشهري</th>
                  <th className="p-2.5 text-center">سند الصرف</th>
                  <th className="p-2.5 text-center">التاريخ</th>
                  <th className="p-2.5 text-center">الحالة</th>
                  <th className="p-2.5 text-center"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const cancellable = r.status === "ACTIVE" && D(r.remaining).eq(D(r.amount));
                  return (
                    <tr key={r.id} className="border-t hover:bg-accent/40">
                      <td className="p-2.5">
                        <div className="flex items-center gap-2.5">
                          <EmpAvatar name={r.employeeName} sizePx={30} />
                          <div>
                            <div className="font-medium text-[13px]">{r.employeeName}</div>
                            {(r.position || r.note) && (
                              <div className="text-[11px] text-muted-foreground">{[r.position, r.note].filter(Boolean).join(" · ")}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="p-2.5 text-muted-foreground">{r.branchName ?? "—"}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{iqd(r.amount)}</td>
                      <td className="p-2.5 text-right tabular-nums font-bold" dir="ltr">
                        <span className={D(r.remaining).gt(0) && r.status === "ACTIVE" ? "text-money-negative" : ""}>{iqd(r.remaining)}</span>
                      </td>
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">
                        {r.monthlyDeduction != null ? iqd(r.monthlyDeduction) : "أقصى الممكن"}
                      </td>
                      <td className="p-2.5 text-center text-xs tabular-nums" dir="ltr">{r.voucherNumber ?? "—"}</td>
                      <td className="p-2.5 text-center text-xs text-muted-foreground tabular-nums" dir="ltr">
                        {r.grantedAt ? new Date(r.grantedAt).toLocaleDateString("ar-IQ-u-nu-latn") : "—"}
                      </td>
                      <td className="p-2.5 text-center"><StatusBadge status={r.status} /></td>
                      <td className="p-2.5 text-center">
                        {cancellable && (
                          <button
                            className="text-xs text-destructive font-medium hover:underline inline-flex items-center gap-1"
                            onClick={async () => {
                              const ok = await confirm({
                                variant: "danger",
                                title: `إلغاء سلفة ${r.employeeName}`,
                                description: `تُلغى السلفة (${iqd(r.amount)} د.ع) قبل أي خصم. سند الصرف الأصلي ${r.voucherNumber ?? ""} لا يُعكَس آلياً — إرجاع النقد للخزينة يكون بإلغاء السند من شاشة السندات.`,
                                confirmText: "إلغاء السلفة",
                              });
                              if (ok) cancelM.mutate({ advanceId: Number(r.id) });
                            }}
                            disabled={cancelM.isPending}
                          >
                            <X className="size-3.5" aria-hidden /> إلغاء
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {listQ.isLoading && (
                  <tr><td colSpan={9}><LoadingState /></td></tr>
                )}
                {!listQ.isLoading && filtered.length === 0 && (
                  <TableEmptyRow colSpan={9} message={rows.length === 0 ? "لا سلف بعد. امنح سلفة للبدء — تُخصم تلقائياً من الرواتب." : "لا نتائج مطابقة للبحث."} />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <GrantDialog open={grantOpen} onClose={() => setGrantOpen(false)} onDone={refresh} />
    </div>
  );
}

function GrantDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [employeeId, setEmployeeId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [monthly, setMonthly] = useState("");
  const [note, setNote] = useState("");
  const [attachmentImages, setAttachmentImages] = useState<ImageItem[]>([]);
  const attachmentUrl = attachmentImages[0]?.dataUrl ?? "";

  const empsQ = trpc.employees.list.useQuery({ status: "active", limit: 200 }, { enabled: open });
  const emps = empsQ.data?.rows ?? [];
  const selected = emps.find((e) => String(e.id) === employeeId);

  const balQ = trpc.payroll.advanceBalance.useQuery(
    { employeeId: Number(employeeId) },
    { enabled: open && !!employeeId },
  );

  // عتبتا السندات (الخادم هو المرجع؛ القيم هنا للتنبيه المسبق فقط).
  const thresholdsQ = trpc.payroll.advanceThresholds.useQuery(undefined, { enabled: open });
  const approvalThreshold = thresholdsQ.data?.approval ?? 1_000_000;
  const attachmentThreshold = thresholdsQ.data?.attachment ?? 250_000;
  const amountNum = Number(amount || 0);
  const overApproval = amountNum >= approvalThreshold;
  const needsAttachment = amountNum > 0 && amountNum >= attachmentThreshold;

  // idempotency (تدقيق ١٧/٧): مفتاح ثابت لكل محاولة منح — يُبقى عند الفشل (إعادة المحاولة idempotent
  // فلا صرف نقدي مزدوج) ويتجدّد بعد النجاح فقط.
  const reqIdRef = useRef<string>(crypto.randomUUID());
  const grantM = trpc.payroll.advanceGrant.useMutation({
    onSuccess: (res) => {
      reqIdRef.current = crypto.randomUUID();
      notify.ok(`مُنحت السلفة وصدر سند الصرف ${res.voucherNumber}`);
      setEmployeeId(""); setAmount(""); setMonthly(""); setNote(""); setAttachmentImages([]);
      onClose();
      onDone();
    },
    onError: (e) => notify.err(e),
  });

  const canSave =
    !!employeeId && !!amount && D(amount || 0).gt(0) && !overApproval && (!needsAttachment || !!attachmentUrl) && !grantM.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>منح سلفة موظف</DialogTitle></DialogHeader>
        <div className="space-y-3 py-1">
          <div>
            <Label htmlFor="adv-emp">الموظف</Label>
            <select id="adv-emp" className={`${selectCls} w-full h-9`} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">اختر موظفاً…</option>
              {emps.map((e) => (
                <option key={e.id} value={String(e.id)}>
                  {e.fullName}{e.branchName ? ` — ${e.branchName}` : ""}
                </option>
              ))}
            </select>
            {!!employeeId && balQ.data && Number(balQ.data.balance) > 0 && (
              <p className="text-xs text-money-negative mt-1">
                عليه سلف نشطة متبقّيها {iqd(balQ.data.balance)} د.ع ({balQ.data.activeCount} سلفة) — الخصم بالأقدم أولاً.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="adv-amount">المبلغ (د.ع)</Label>
            <MoneyInput id="adv-amount" value={amount} onChange={setAmount} decimals={0} placeholder="0" ariaLabel="مبلغ السلفة" />
            <p className="text-xs text-muted-foreground mt-1">يصدر سند صرف نقدي حقيقي من الخزينة فوراً باسم الموظف (فئة «رواتب»).</p>
            {overApproval && (
              <p className="text-xs text-money-negative mt-1" role="alert">
                المبلغ يبلغ عتبة الاعتماد الثنائي للسندات ({approvalThreshold.toLocaleString("ar-IQ-u-nu-latn")} د.ع) — للمبالغ الكبيرة أصدر سند صرف من شاشة السندات (يمرّ بالاعتماد) أو قسّم السلفة.
              </p>
            )}
          </div>
          <div>
            <Label>مُرفق سند الصرف {needsAttachment ? "(إلزامي لهذا المبلغ)" : "(اختياري)"}</Label>
            <ImageUploader
              value={attachmentImages}
              onChange={setAttachmentImages}
              maxItems={1}
              maxSizeMB={2}
              singlePrimary={false}
              hint={`صورة إيصال الاستلام/التعهّد — إلزامية للمبالغ ${attachmentThreshold.toLocaleString("ar-IQ-u-nu-latn")} د.ع فما فوق.`}
            />
          </div>
          <div>
            <Label htmlFor="adv-monthly">الخصم الشهري (اختياري)</Label>
            <MoneyInput id="adv-monthly" value={monthly} onChange={setMonthly} decimals={0} placeholder="فارغ = خصم أقصى الممكن من كل راتب" ariaLabel="الخصم الشهري" />
          </div>
          <div>
            <Label htmlFor="adv-note">ملاحظة (اختياري)</Label>
            <Input id="adv-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button
            onClick={() => {
              if (!selected) return;
              grantM.mutate({
                employeeId: Number(selected.id),
                branchId: Number(selected.branchId ?? 1),
                amount: D(amount).toFixed(2),
                monthlyDeduction: monthly.trim() ? D(monthly).toFixed(2) : null,
                note: note.trim() || null,
                attachmentUrl: attachmentUrl || null,
                clientRequestId: reqIdRef.current,
              });
            }}
            disabled={!canSave}
          >
            {grantM.isPending ? "جارٍ المنح…" : "منح وإصدار السند"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
