/* ============================================================================
 * شاشة الرواتب — وحدة الموارد البشرية (client/src/pages/Payroll.tsx)
 * مسيّر شهري بثلاث حالات (مسودة → معتمد → مدفوع). مُركَّب على trpc.payroll.
 *
 * المكوّنات: مؤشّرات (الإجمالي/الإضافي/الاستقطاع/الصافي) + اختيار المسيّر (أو الأحدث) +
 * جدول البنود (الموظف/نوع الأجر/الأساسي أو الساعات/المخصّصات/الإضافي/الاستقطاع/الصافي/الحالة +
 * زر القسيمة + تحرير الإضافي/الاستقطاع أثناء المسودة) + أزرار توليد/اعتماد/دفع/إلغاء حسب الحالة.
 * كل المبالغ تُعرَض عبر iqd() (الخادم هو المرجع الحسابي).
 * ========================================================================== */
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirm, confirmDelete } from "@/lib/confirm";
import { EmpAvatar, iqd } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { D, round2 } from "@/lib/money";
import { payrollStatusLabel, payTypeLabel } from "@shared/hr";
import { AlarmClock, Banknote, Check, FileText, Minus, Plus, Printer, Wallet, X } from "lucide-react";
import { useMemo, useState } from "react";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATUS_CLS: Record<string, string> = {
  draft: "badge-stock-low",
  approved: "badge-status-pending",
  paid: "badge-status-active",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${STATUS_CLS[status] ?? "bg-muted text-muted-foreground"}`}>
      {payrollStatusLabel(status)}
    </span>
  );
}

function StatCard({ label, value, sub, accent, icon }: { label: string; value: string; sub?: string; accent?: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-xs">{label}</div>
          <span style={{ color: accent }}>{icon}</span>
        </div>
        <div className="mt-1 text-2xl font-bold tabular-nums" dir="ltr" style={{ color: accent }}>{value}</div>
        {sub && <div className="text-muted-foreground text-xs mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** الشهر الحالي بصيغة YYYY-MM (افتراضي حقل توليد مسيّر جديد). */
const thisMonth = () => new Date().toISOString().slice(0, 7);

type RunItem = NonNullable<ReturnType<typeof useRunQuery>["data"]>["items"][number];

function useRunQuery(id: number | null) {
  return trpc.payroll.get.useQuery({ id: id ?? 0 }, { enabled: id != null && Number.isFinite(id) });
}

export default function Payroll() {
  const utils = trpc.useUtils();
  const runsQ = trpc.payroll.list.useQuery();
  const runs = runsQ.data ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // المسيّر المعروض: المُختار صراحةً، أو الأحدث (أول عنصر — مرتّب بالأحدث).
  const effectiveId = selectedId ?? (runs.length ? Number(runs[0].id) : null);
  const runQ = useRunQuery(effectiveId);
  const run = runQ.data ?? null;

  const [slip, setSlip] = useState<RunItem | null>(null);
  const [editItem, setEditItem] = useState<RunItem | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [genPeriod, setGenPeriod] = useState(thisMonth());

  const refresh = async () => {
    await Promise.all([utils.payroll.list.invalidate(), utils.payroll.get.invalidate()]);
  };

  const generate = trpc.payroll.generate.useMutation({
    onSuccess: async (r) => { notify.ok("تم توليد المسيّر"); setGenOpen(false); if (r?.id) setSelectedId(Number(r.id)); await refresh(); },
    onError: (e) => notify.err(e),
  });
  const approve = trpc.payroll.approve.useMutation({
    onSuccess: async () => { notify.ok("تم اعتماد المسيّر"); await refresh(); },
    onError: (e) => notify.err(e),
  });
  const pay = trpc.payroll.pay.useMutation({
    onSuccess: async () => { notify.ok("تم دفع المسيّر وقيد الرواتب"); await refresh(); },
    onError: (e) => notify.err(e),
  });
  const cancel = trpc.payroll.cancel.useMutation({
    onSuccess: async (r) => {
      notify.ok(r.status === "deleted" ? "تم حذف المسوّدة" : r.status === "draft" ? "أُعيد المسيّر إلى مسوّدة" : "تم عكس الدفع وإعادة المسيّر إلى معتمد");
      if (r.status === "deleted") setSelectedId(null);
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  const updateItemM = trpc.payroll.updateItem.useMutation({
    onSuccess: async () => { notify.ok("تم تحديث البند"); setEditItem(null); await refresh(); },
    onError: (e) => notify.err(e),
  });

  const items = run?.items ?? [];
  const isDraft = run?.status === "draft";
  const isApproved = run?.status === "approved";
  const isPaid = run?.status === "paid";
  const busy = generate.isPending || approve.isPending || pay.isPending || cancel.isPending;

  // مؤشّرات من رأس المسيّر (الخادم هو المرجع).
  const totals = useMemo(
    () => ({
      gross: run?.totalGross ?? "0",
      overtime: run?.totalOvertime ?? "0",
      deductions: run?.totalDeductions ?? "0",
      net: run?.totalNet ?? "0",
    }),
    [run],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="الرواتب"
        description="مسيّر الرواتب الشهري — يجمع الراتب الثابت وأجر الساعات والإضافي ويخصم السلف والغياب."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <select
              className={selectCls}
              value={effectiveId != null ? String(effectiveId) : ""}
              onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
              aria-label="المسيّر"
            >
              {runs.length === 0 && <option value="">لا مسيّرات</option>}
              {runs.map((r) => (
                <option key={r.id} value={String(r.id)}>
                  مسيّر {r.period} — {payrollStatusLabel(r.status)}
                </option>
              ))}
            </select>
            <Button onClick={() => setGenOpen(true)} disabled={busy}>
              <Plus className="size-4" /> توليد مسيّر
            </Button>
          </div>
        }
      />

      {/* المؤشّرات */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="الإجمالي (gross)" value={iqd(totals.gross)} sub="د.ع قبل الاستقطاع" icon={<Banknote className="size-4" />} />
        <StatCard label="العمل الإضافي" value={iqd(totals.overtime)} sub="د.ع" accent="var(--status-done, #059669)" icon={<AlarmClock className="size-4" />} />
        <StatCard label="الاستقطاعات" value={iqd(totals.deductions)} sub="سلف وغياب" accent="var(--money-negative, #dc2626)" icon={<Minus className="size-4" />} />
        <StatCard label="الصافي المستحق" value={iqd(totals.net)} sub={run ? `د.ع — مسيّر ${run.period}` : "د.ع"} accent="var(--status-active, #2563eb)" icon={<Wallet className="size-4" />} />
      </div>

      {/* أزرار دورة الحياة */}
      {run && (
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={run.status} />
          <span className="text-sm text-muted-foreground">مسيّر {run.period} — {run.employeeCount} موظف</span>
          <div className="flex-1" />
          {isDraft && (
            <>
              <Button variant="outline" size="sm" onClick={async () => { if (!(await confirm({ variant: "warning", title: `اعتماد مسيّر رواتب ${run.period}`, description: "اعتماد المسيّر يقفل تعديل البنود. متابعة؟", confirmText: "اعتماد" }))) return; approve.mutate({ id: Number(run.id) }); }} disabled={busy}>
                <Check className="size-4" /> اعتماد المسيّر
              </Button>
              <Button variant="outline" size="sm" className="text-destructive" onClick={async () => { if (!(await confirmDelete({ description: `حذف مسوّدة رواتب ${run.period} وكل بنودها (${run.employeeCount} موظف) نهائياً؟` }))) return; cancel.mutate({ id: Number(run.id) }); }} disabled={busy}>
                <X className="size-4" /> حذف المسوّدة
              </Button>
            </>
          )}
          {isApproved && (
            <>
              <Button size="sm" onClick={async () => { if (!(await confirm({ variant: "danger", title: `دفع مسيّر رواتب ${run.period}`, description: `سيُصرَف صافي ${iqd(totals.net)} د.ع لـ${run.employeeCount} موظف ويُقيَّد من الخزينة. صرف الرواتب من الخزينة لا يُعكَس بسهولة.`, confirmText: "دفع المسيّر", requireText: "دفع" }))) return; pay.mutate({ id: Number(run.id) }); }} disabled={busy}>
                <Wallet className="size-4" /> دفع المسيّر
              </Button>
              <Button variant="outline" size="sm" onClick={async () => { if (!(await confirm({ variant: "warning", title: `إعادة مسيّر رواتب ${run.period} إلى مسوّدة`, description: "إعادة المسيّر إلى مسوّدة لإعادة التعديل؟", confirmText: "إعادة" }))) return; cancel.mutate({ id: Number(run.id) }); }} disabled={busy}>
                إعادة لمسوّدة
              </Button>
            </>
          )}
          {isPaid && (
            <Button variant="outline" size="sm" className="text-destructive" onClick={async () => { if (!(await confirm({ variant: "danger", title: `عكس دفع مسيّر رواتب ${run.period}`, description: `عكس الدفع يقيّد قيوداً معاكسة بقيمة ${iqd(totals.net)} د.ع ويعيد المسيّر إلى «معتمد».`, confirmText: "عكس الدفع", requireText: "عكس" }))) return; cancel.mutate({ id: Number(run.id) }); }} disabled={busy}>
              <X className="size-4" /> عكس الدفع
            </Button>
          )}
        </div>
      )}

      {/* جدول البنود */}
      <Card>
        <CardHeader>
          <CardTitle>{run ? `مسيّر رواتب ${run.period} — ${items.length} موظف` : "مسيّر الرواتب"}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2.5">الموظف</th>
                  <th className="p-2.5 text-center">نوع الأجر</th>
                  <th className="p-2.5 text-right">الأساسي / الساعات</th>
                  <th className="p-2.5 text-right">مخصّصات</th>
                  <th className="p-2.5 text-right">إضافي</th>
                  <th className="p-2.5 text-right">استقطاع</th>
                  <th className="p-2.5 text-right">الصافي</th>
                  <th className="p-2.5 text-center">الحالة</th>
                  <th className="p-2.5 text-center"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => {
                  const monthly = p.payType === "monthly";
                  // الأساسي للشهري = الإجمالي − المخصّصات (gross = أساسي + مخصّصات).
                  const baseDisplay = monthly ? round2(D(p.gross).minus(D(p.allowances))).toFixed(2) : p.gross;
                  return (
                    <tr key={p.id} className="border-t hover:bg-accent/40">
                      <td className="p-2.5">
                        <div className="flex items-center gap-2.5">
                          <EmpAvatar name={p.employeeName} color={p.colorTag} photoUrl={p.photoUrl} sizePx={32} />
                          <div>
                            <div className="font-medium text-[13px]">{p.employeeName}</div>
                            {p.position && <div className="text-[11px] text-muted-foreground">{p.position}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="p-2.5 text-center">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${monthly ? "bg-primary/10 text-primary" : "badge-stock-low"}`}>
                          {payTypeLabel(p.payType)}
                        </span>
                      </td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">
                        {monthly ? iqd(baseDisplay) : `${iqd(p.gross)} (${p.hours ?? "0"} س)`}
                      </td>
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{monthly ? iqd(p.allowances) : "—"}</td>
                      <td className="p-2.5 text-right tabular-nums text-money-positive" dir="ltr">{D(p.overtime).gt(0) ? `+${iqd(p.overtime)}` : "—"}</td>
                      <td className="p-2.5 text-right tabular-nums text-money-negative" dir="ltr">{D(p.deductions).gt(0) ? `−${iqd(p.deductions)}` : "—"}</td>
                      <td className="p-2.5 text-right tabular-nums font-bold" dir="ltr">{iqd(p.net)}</td>
                      <td className="p-2.5 text-center"><StatusBadge status={run!.status} /></td>
                      <td className="p-2.5 text-center whitespace-nowrap">
                        <button onClick={() => setSlip(p)} className="text-xs text-primary font-medium hover:underline inline-flex items-center gap-1">
                          <FileText className="size-3.5" /> القسيمة
                        </button>
                        {isDraft && (
                          <button onClick={() => setEditItem(p)} className="text-xs text-muted-foreground font-medium hover:underline ms-3">
                            تعديل
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {items.length > 0 && (
                  <tr className="border-t-2 bg-muted/40 font-bold">
                    <td className="p-2.5" colSpan={2}>الإجمالي</td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">{iqd(totals.gross)}</td>
                    <td></td>
                    <td className="p-2.5 text-right tabular-nums text-money-positive" dir="ltr">+{iqd(totals.overtime)}</td>
                    <td className="p-2.5 text-right tabular-nums text-money-negative" dir="ltr">−{iqd(totals.deductions)}</td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">{iqd(totals.net)}</td>
                    <td colSpan={2}></td>
                  </tr>
                )}
                {!runQ.isLoading && items.length === 0 && (
                  <TableEmptyRow
                    colSpan={9}
                    message={runs.length === 0 ? "لا مسيّرات بعد. ولّد مسيّراً شهرياً للبدء." : "لا بنود في هذا المسيّر."}
                  />
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* حوار توليد مسيّر */}
      <Dialog open={genOpen} onOpenChange={(o) => !o && setGenOpen(false)}>
        <DialogContent>
          <DialogHeader><DialogTitle>توليد مسيّر رواتب</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <Label htmlFor="gen-period">الشهر (YYYY-MM)</Label>
              <Input id="gen-period" type="month" value={genPeriod} onChange={(e) => setGenPeriod(e.target.value)} dir="ltr" className="tabular-nums" />
            </div>
            <p className="text-xs text-muted-foreground">
              يُولَّد مسيّر مسوّدة لكل الموظفين غير منتهي الخدمة: الراتب الأساسي + المخصّصات للشهريين، ومجموع أجر الساعات للساعيين.
              الإضافي والاستقطاع صفر ابتداءً ويُحرَّران من زر «تعديل» قبل الاعتماد.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenOpen(false)}>إلغاء</Button>
            <Button onClick={() => generate.mutate({ period: genPeriod })} disabled={generate.isPending || !genPeriod}>
              {generate.isPending ? "جارٍ التوليد…" : "توليد"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار تحرير بند (أثناء المسودة) */}
      <EditItemDialog
        item={editItem}
        onClose={() => setEditItem(null)}
        onSave={(overtime, deductions, note) => editItem && updateItemM.mutate({ itemId: Number(editItem.id), overtime, deductions, note })}
        saving={updateItemM.isPending}
      />

      {/* قسيمة راتب */}
      <Dialog open={!!slip} onOpenChange={(o) => !o && setSlip(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>قسيمة راتب — {run?.period}</DialogTitle></DialogHeader>
          {slip && (
            <div>
              <div className="flex items-center gap-3 pb-3 border-b">
                <EmpAvatar name={slip.employeeName} color={slip.colorTag} photoUrl={slip.photoUrl} sizePx={44} />
                <div className="flex-1">
                  <div className="font-bold">{slip.employeeName}</div>
                  <div className="text-xs text-muted-foreground">{[slip.position, slip.department].filter(Boolean).join(" · ") || "—"}</div>
                </div>
                <div className="text-xs text-muted-foreground" dir="ltr">#{slip.employeeId}</div>
              </div>
              <div className="py-3 space-y-2 text-sm">
                {slip.payType === "hourly" && (
                  <div className="flex justify-between"><span className="text-muted-foreground">ساعات العمل</span><span className="tabular-nums">{slip.hours ?? "0"} ساعة</span></div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{slip.payType === "monthly" ? "الراتب الأساسي" : "أجر الساعات"}</span>
                  <span className="tabular-nums" dir="ltr">{iqd(slip.payType === "monthly" ? round2(D(slip.gross).minus(D(slip.allowances))).toFixed(2) : slip.gross)}</span>
                </div>
                {slip.payType === "monthly" && (
                  <div className="flex justify-between"><span className="text-muted-foreground">المخصّصات</span><span className="tabular-nums" dir="ltr">{iqd(slip.allowances)}</span></div>
                )}
                <div className="flex justify-between"><span className="text-muted-foreground">العمل الإضافي</span><span className="tabular-nums text-money-positive" dir="ltr">+{iqd(slip.overtime)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">الاستقطاعات (سلف/غياب)</span><span className="tabular-nums text-money-negative" dir="ltr">−{iqd(slip.deductions)}</span></div>
                {slip.note && <div className="flex justify-between"><span className="text-muted-foreground">ملاحظة</span><span>{slip.note}</span></div>}
              </div>
              <div className="flex justify-between items-center py-3 border-t-2">
                <span className="font-bold">الصافي المستحق</span>
                <span className="text-xl font-bold text-money-positive tabular-nums" dir="ltr">{iqd(slip.net)}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSlip(null)}>إغلاق</Button>
            <Button onClick={() => window.print()}><Printer className="size-4" /> طباعة</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditItemDialog({
  item,
  onClose,
  onSave,
  saving,
}: {
  item: RunItem | null;
  onClose: () => void;
  onSave: (overtime: string, deductions: string, note: string) => void;
  saving: boolean;
}) {
  const [overtime, setOvertime] = useState("0");
  const [deductions, setDeductions] = useState("0");
  const [note, setNote] = useState("");

  // تهيئة القيم عند فتح بند جديد.
  const itemId = item?.id ?? null;
  const [lastId, setLastId] = useState<number | null>(null);
  if (item && itemId !== lastId) {
    setLastId(Number(itemId));
    setOvertime(round2(D(item.overtime)).toFixed(2));
    setDeductions(round2(D(item.deductions)).toFixed(2));
    setNote(item.note ?? "");
  }

  const newNet = item ? round2(D(item.gross).plus(D(overtime || 0)).minus(D(deductions || 0))).toFixed(2) : "0";

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>تعديل بند — {item?.employeeName}</DialogTitle></DialogHeader>
        {item && (
          <div className="space-y-3 py-1">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">الإجمالي (gross)</span>
              <span className="tabular-nums font-medium" dir="ltr">{iqd(item.gross)}</span>
            </div>
            <div>
              <Label htmlFor="edit-ot">العمل الإضافي (د.ع)</Label>
              <Input id="edit-ot" inputMode="decimal" value={overtime} onChange={(e) => setOvertime(e.target.value)} dir="ltr" className="tabular-nums" />
            </div>
            <div>
              <Label htmlFor="edit-ded">الاستقطاع — سلف/غياب (د.ع)</Label>
              <Input id="edit-ded" inputMode="decimal" value={deductions} onChange={(e) => setDeductions(e.target.value)} dir="ltr" className="tabular-nums" />
            </div>
            <div>
              <Label htmlFor="edit-note">ملاحظة (اختياري)</Label>
              <Input id="edit-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} />
            </div>
            <div className="flex justify-between items-center pt-2 border-t">
              <span className="font-bold text-sm">الصافي بعد التعديل</span>
              <span className="text-lg font-bold tabular-nums" dir="ltr">{iqd(newNet)}</span>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button
            onClick={() => onSave(round2(D(overtime || 0)).toFixed(2), round2(D(deductions || 0)).toFixed(2), note)}
            disabled={saving}
          >
            {saving ? "جارٍ الحفظ…" : "حفظ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
