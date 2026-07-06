// شاشة «خطط العمولات» — تبويب في hub الموارد البشرية (وحدة الأهداف والعمولات، S1).
//
// الخطة: نمط شرائح (بنسبة تحقيق الهدف أو بمبلغ المبيعات) + نسبة تُطبَّق على كامل الأساس
// + مكافأة مقطوعة اختيارية. لا حذف صلب — تعطيل فقط (أسطر التشغيلات التاريخية تُشير إليها).
// الإسناد: خطة مفتوحة واحدة لكل موظف؛ الإسناد الجديد يُغلق السابق آلياً (الخادم يوثّقه).
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RowActions } from "@/components/list";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { iqd } from "@/lib/hr/ui";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Plus, Trash2, Users } from "lucide-react";
import { useState } from "react";

type PlanRow = RouterOutputs["commissions"]["plans"]["list"][number];
type BoardRow = RouterOutputs["commissions"]["plans"]["assignmentBoard"][number];
type TierMode = "TARGET_PCT" | "AMOUNT_SLAB";

const MODE_LABEL: Record<TierMode, string> = {
  TARGET_PCT: "بنسبة تحقيق الهدف",
  AMOUNT_SLAB: "بمبلغ المبيعات",
};

/** عرض نسبة بلا أصفار ذيلية (٢٫٥٠٠٠ ← ٢٫٥) — للعرض فقط، لا حساب مالي هنا. */
function pct(v: string | number): string {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

type TierDraft = { threshold: string; ratePct: string; fixedBonus: string };

const EMPTY_TIER: TierDraft = { threshold: "0", ratePct: "", fixedBonus: "0" };

function tierSummary(p: PlanRow): string {
  return p.tiers
    .map((t) => {
      const th = p.tierMode === "TARGET_PCT" ? `${pct(t.threshold)}٪` : iqd(t.threshold);
      const bonus = Number(t.fixedBonus) > 0 ? ` + ${iqd(t.fixedBonus)}` : "";
      return `من ${th} ← ${pct(t.ratePct)}٪${bonus}`;
    })
    .join(" | ");
}

export default function CommissionPlans() {
  const utils = trpc.useUtils();
  const list = trpc.commissions.plans.list.useQuery();
  const rows = list.data ?? [];

  /* ── حوار الخطة (إنشاء/تعديل) ── */
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [fName, setFName] = useState("");
  const [fMode, setFMode] = useState<TierMode>("TARGET_PCT");
  const [fTiers, setFTiers] = useState<TierDraft[]>([{ ...EMPTY_TIER }]);
  const [fNotes, setFNotes] = useState("");

  /* ── حوار الإسنادات ── */
  const [assignOpen, setAssignOpen] = useState(false);
  const board = trpc.commissions.plans.assignmentBoard.useQuery(undefined, { enabled: assignOpen });
  const [draftPlan, setDraftPlan] = useState<Record<number, string>>({});
  const [draftFrom, setDraftFrom] = useState<Record<number, string>>({});

  function invalidate() {
    void utils.commissions.plans.list.invalidate();
    void utils.commissions.plans.assignmentBoard.invalidate();
  }

  const createMut = trpc.commissions.plans.create.useMutation({
    onSuccess: () => { invalidate(); setFormOpen(false); notify.ok("أُنشئت الخطة"); },
    onError: (e) => notify.err(e),
  });
  const updateMut = trpc.commissions.plans.update.useMutation({
    onSuccess: () => { invalidate(); setFormOpen(false); notify.ok("حُفظت التعديلات"); },
    onError: (e) => notify.err(e),
  });
  const setActiveMut = trpc.commissions.plans.setActive.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => notify.err(e),
  });
  const assignMut = trpc.commissions.plans.assign.useMutation({
    onSuccess: (res) => {
      invalidate();
      notify.ok(res.closedPrevious ? "أُسندت الخطة وأُغلق الإسناد السابق آلياً" : "أُسندت الخطة");
    },
    onError: (e) => notify.err(e),
  });
  const endMut = trpc.commissions.plans.endAssignment.useMutation({
    onSuccess: () => { invalidate(); notify.ok("أُنهي الإسناد"); },
    onError: (e) => notify.err(e),
  });

  function openAdd() {
    setEditId(null);
    setFName("");
    setFMode("TARGET_PCT");
    setFTiers([
      { threshold: "70", ratePct: "1", fixedBonus: "0" },
      { threshold: "100", ratePct: "2", fixedBonus: "0" },
    ]);
    setFNotes("");
    setFormOpen(true);
  }

  function openEdit(p: PlanRow) {
    setEditId(p.id);
    setFName(p.name);
    setFMode(p.tierMode);
    setFTiers(p.tiers.map((t) => ({ threshold: pct(t.threshold), ratePct: pct(t.ratePct), fixedBonus: pct(t.fixedBonus) })));
    setFNotes(p.notes ?? "");
    setFormOpen(true);
  }

  function setTier(i: number, key: keyof TierDraft, value: string) {
    setFTiers((prev) => prev.map((t, idx) => (idx === i ? { ...t, [key]: value } : t)));
  }

  function submitForm() {
    const name = fName.trim();
    if (!name) return notify.err("اسم الخطة مطلوب");
    if (fTiers.length === 0) return notify.err("شريحة واحدة على الأقل");
    for (let i = 0; i < fTiers.length; i++) {
      const t = fTiers[i];
      if (!/^\d+(\.\d{1,2})?$/.test(t.threshold.trim())) return notify.err(`عتبة الشريحة ${i + 1} غير صالحة`);
      if (!/^\d+(\.\d{1,4})?$/.test(t.ratePct.trim())) return notify.err(`نسبة الشريحة ${i + 1} غير صالحة`);
      if (!/^\d+(\.\d{1,2})?$/.test(t.fixedBonus.trim() || "0")) return notify.err(`مكافأة الشريحة ${i + 1} غير صالحة`);
      if (i > 0 && Number(t.threshold) <= Number(fTiers[i - 1].threshold)) {
        return notify.err("العتبات يجب أن تكون تصاعدية بلا تكرار");
      }
    }
    const payload = {
      name,
      tierMode: fMode,
      tiers: fTiers.map((t) => ({
        threshold: t.threshold.trim(),
        ratePct: t.ratePct.trim(),
        fixedBonus: t.fixedBonus.trim() || "0",
      })),
      notes: fNotes.trim() || null,
    };
    if (editId == null) createMut.mutate(payload);
    else updateMut.mutate({ planId: editId, ...payload });
  }

  async function toggleActive(p: PlanRow) {
    if (p.isActive) {
      const ok = await confirm({
        variant: "warning",
        title: "تعطيل الخطة",
        description:
          p.openAssignments > 0
            ? `الخطة مُسنَدة حالياً لـ${p.openAssignments} موظف — تعطيلها لا يُنهي الإسنادات، لكن المحرّك سيستمرّ باحتسابها لهم حتى تُنهيها أو تُسند بديلاً. متابعة؟`
            : "لن تظهر الخطة في منتقيات الإسناد الجديدة. متابعة؟",
        confirmText: "تعطيل",
      });
      if (!ok) return;
    }
    setActiveMut.mutate({ planId: p.id, isActive: !p.isActive });
  }

  function assignRow(r: BoardRow) {
    const planId = Number(draftPlan[r.employeeId] ?? "");
    const effectiveFrom = draftFrom[r.employeeId] ?? thisMonth();
    if (!planId) return notify.err("اختر خطة أولاً");
    assignMut.mutate({ employeeId: r.employeeId, planId, effectiveFrom });
  }

  async function endRow(r: BoardRow) {
    if (!r.assignment) return;
    const ok = await confirm({
      variant: "warning",
      title: "إنهاء الإسناد",
      description: `سيُنهى إسناد «${r.assignment.planName}» للموظف ${r.employeeName} بنهاية الشهر الحالي — لن يُحتسَب له بعد ذلك حتى تُسند خطة جديدة. متابعة؟`,
      confirmText: "إنهاء",
    });
    if (!ok) return;
    endMut.mutate({ assignmentId: r.assignment.id, effectiveTo: thisMonth() });
  }

  const activePlans = rows.filter((p) => p.isActive);

  return (
    <div className="space-y-4">
      <PageHeader
        title="خطط العمولات"
        description="لكل خطة شرائح تصاعدية: بلوغ العتبة يمنح نسبتها على كامل صافي المبيعات (بعد خصم المرتجعات) + مكافأة اختيارية. النِّسَب لا تتناقص مع صعود العتبات — بنيوياً."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}>
              <Users className="size-4" /> الإسنادات
            </Button>
            <Button size="sm" onClick={openAdd}>
              <Plus className="size-4" /> خطة جديدة
            </Button>
          </div>
        }
      />

      <Card>
        <CardHeader className="text-sm text-muted-foreground">
          {list.isLoading ? "" : `${rows.length} خطة`}
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">الاسم</th>
                  <th className="p-2">النمط</th>
                  <th className="p-2">الشرائح</th>
                  <th className="p-2 text-center">مُسنَدة لـ</th>
                  <th className="p-2 text-center">الحالة</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className={`border-t ${p.isActive ? "" : "opacity-60"}`}>
                    <td className="p-2 font-medium">
                      {p.name}
                      {p.notes ? <div className="text-xs text-muted-foreground">{p.notes}</div> : null}
                    </td>
                    <td className="p-2 whitespace-nowrap">{MODE_LABEL[p.tierMode]}</td>
                    <td className="p-2 text-xs text-muted-foreground">{tierSummary(p)}</td>
                    <td className="p-2 text-center tabular-nums">{p.openAssignments}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${p.isActive ? "badge-status-active" : "badge-stock-out"}`}>
                        {p.isActive ? "فعّالة" : "معطّلة"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      <RowActions
                        actions={[
                          { key: "edit", label: "تعديل", onSelect: () => openEdit(p) },
                          {
                            key: "toggle",
                            label: p.isActive ? "تعطيل" : "تفعيل",
                            variant: p.isActive ? "destructive" : "default",
                            disabled: setActiveMut.isPending,
                            onSelect: () => void toggleActive(p),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
                {list.isLoading && (
                  <tr><td colSpan={6}><LoadingState /></td></tr>
                )}
                {!list.isLoading && rows.length === 0 && (
                  <TableEmptyRow colSpan={6} message="لا خطط عمولات بعد — أنشئ أول خطة ثم أسندها للموظفين." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {/* ── حوار إنشاء/تعديل خطة ── */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editId == null ? "خطة عمولات جديدة" : "تعديل خطة العمولات"}</DialogTitle>
            <DialogDescription>
              {fMode === "TARGET_PCT"
                ? "العتبة = نسبة تحقيق الهدف الشهري (٧٠ تعني ٧٠٪ من الهدف). بلوغها يمنح النسبة على كامل صافي المبيعات."
                : "العتبة = صافي مبيعات شهري بالدينار. بلوغها يمنح النسبة على كامل صافي المبيعات."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">اسم الخطة</label>
                <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="خطة مبيعات الكاشير" dir="auto" autoFocus />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">نمط الشرائح</label>
                <select
                  value={fMode}
                  onChange={(e) => setFMode(e.target.value as TierMode)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
                >
                  <option value="TARGET_PCT">بنسبة تحقيق الهدف (يتطلب هدفاً شهرياً)</option>
                  <option value="AMOUNT_SLAB">بمبلغ المبيعات (بلا هدف)</option>
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">الشرائح (تصاعدية)</label>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setFTiers((prev) => [...prev, { ...EMPTY_TIER, threshold: "" }])}
                  disabled={fTiers.length >= 12}
                >
                  <Plus className="size-3.5" /> شريحة
                </Button>
              </div>
              <div className="space-y-2">
                {fTiers.map((t, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">
                        {fMode === "TARGET_PCT" ? "من إنجاز ٪" : "من مبيعات (د.ع)"}
                      </label>
                      <Input value={t.threshold} onChange={(e) => setTier(i, "threshold", e.target.value)} dir="ltr" inputMode="decimal" className="tabular-nums" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">النسبة ٪</label>
                      <Input value={t.ratePct} onChange={(e) => setTier(i, "ratePct", e.target.value)} dir="ltr" inputMode="decimal" className="tabular-nums" placeholder="2" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">مكافأة مقطوعة (د.ع)</label>
                      <Input value={t.fixedBonus} onChange={(e) => setTier(i, "fixedBonus", e.target.value)} dir="ltr" inputMode="decimal" className="tabular-nums" />
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive"
                      aria-label={`حذف الشريحة ${i + 1}`}
                      onClick={() => setFTiers((prev) => prev.filter((_, idx) => idx !== i))}
                      disabled={fTiers.length <= 1}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                النسبة تُطبَّق على كامل صافي المبيعات عند بلوغ العتبة — والنِّسَب والمكافآت لا تتناقص مع صعود العتبات.
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">ملاحظات (اختياري)</label>
              <Textarea rows={2} value={fNotes} onChange={(e) => setFNotes(e.target.value)} maxLength={255} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setFormOpen(false)}>إلغاء</Button>
            <Button size="sm" onClick={submitForm} disabled={createMut.isPending || updateMut.isPending}>
              {createMut.isPending || updateMut.isPending ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── حوار الإسنادات ── */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>إسناد الخطط للموظفين</DialogTitle>
            <DialogDescription>
              خطة مفتوحة واحدة لكل موظف — الإسناد الجديد يُغلق السابق آلياً بنهاية الشهر الذي قبله. يظهر هنا فقط الموظفون المرتبطون بحساب مستخدم (نسبة المبيعات تتبع الحساب).
            </DialogDescription>
          </DialogHeader>
          <ScrollTableShell maxHeightClass="max-h-[55vh]">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">الموظف</th>
                  <th className="p-2">الفرع</th>
                  <th className="p-2">الخطة الحالية</th>
                  <th className="p-2">إسناد جديد</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {(board.data ?? []).map((r) => (
                  <tr key={r.employeeId} className="border-t">
                    <td className="p-2">
                      <div className="font-medium">{r.employeeName}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.position || "—"}
                        {r.employmentStatus === "leave" ? " · في إجازة" : ""}
                      </div>
                    </td>
                    <td className="p-2 text-muted-foreground">{r.branchName || "—"}</td>
                    <td className="p-2">
                      {r.assignment ? (
                        <div>
                          <div>{r.assignment.planName}</div>
                          <div className="text-xs text-muted-foreground" dir="ltr">{r.assignment.effectiveFrom} ←</div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">بلا خطة</span>
                      )}
                    </td>
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        <select
                          value={draftPlan[r.employeeId] ?? ""}
                          onChange={(e) => setDraftPlan((prev) => ({ ...prev, [r.employeeId]: e.target.value }))}
                          className="h-8 w-40 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm"
                          aria-label={`خطة ${r.employeeName}`}
                        >
                          <option value="">اختر خطة…</option>
                          {activePlans.map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                        <Input
                          type="month"
                          dir="ltr"
                          className="h-8 w-36 text-xs tabular-nums"
                          value={draftFrom[r.employeeId] ?? thisMonth()}
                          onChange={(e) => setDraftFrom((prev) => ({ ...prev, [r.employeeId]: e.target.value }))}
                          aria-label={`بداية إسناد ${r.employeeName}`}
                        />
                      </div>
                    </td>
                    <td className="p-2 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Button size="sm" variant="outline" disabled={assignMut.isPending} onClick={() => assignRow(r)}>
                          إسناد
                        </Button>
                        {r.assignment && (
                          <Button size="sm" variant="ghost" className="text-destructive" disabled={endMut.isPending} onClick={() => void endRow(r)}>
                            إنهاء
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {board.isLoading && (
                  <tr><td colSpan={5}><LoadingState /></td></tr>
                )}
                {!board.isLoading && (board.data ?? []).length === 0 && (
                  <TableEmptyRow colSpan={5} message="لا موظفين مرتبطين بحسابات مستخدمين — اربط الموظف بحسابه من شاشة الموظف أولاً." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAssignOpen(false)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
