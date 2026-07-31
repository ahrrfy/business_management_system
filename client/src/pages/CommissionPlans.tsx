// شاشة «خطط العمولات» — تبويب في hub الموارد البشرية (وحدة الأهداف والعمولات، S1).
//
// الخطة: نمط شرائح (بنسبة تحقيق الهدف أو بمبلغ المبيعات) + نسبة تُطبَّق على كامل الأساس
// + مكافأة مقطوعة اختيارية. لا حذف صلب — تعطيل فقط (أسطر التشغيلات التاريخية تُشير إليها).
// الإسناد: خطة مفتوحة واحدة لكل موظف؛ الإسناد الجديد يُغلق السابق آلياً (الخادم يوثّقه).
//
// لغة الواجهة مبسَّطة عمداً (٣١/٧): «شريحة»→«مستوى»، «عتبة»→«حدّ»، «نمط»→«طريقة الاحتساب»،
// «إسناد»→«ربط». المصطلحات التقنية تبقى في الكود والخادم — الشاشة تخاطب مستخدم المتجر.
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
import { CommissionGuide } from "@/components/commissions/CommissionGuide";
import { TierPlayground } from "@/components/commissions/TierPlayground";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { iqd } from "@/lib/hr/ui";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { Plus, Trash2, Users } from "lucide-react";
import { useState } from "react";

type PlanRow = RouterOutputs["commissions"]["plans"]["list"][number];
type BoardRow = RouterOutputs["commissions"]["plans"]["assignmentBoard"][number];
type TierMode = "TARGET_PCT" | "AMOUNT_SLAB";

const MODE_LABEL: Record<TierMode, string> = {
  TARGET_PCT: "حسب نسبة تحقيق الهدف",
  AMOUNT_SLAB: "حسب مبلغ المبيعات",
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
      const th = p.tierMode === "TARGET_PCT" ? `${pct(t.threshold)}٪ من هدفه` : `${iqd(t.threshold)} د.ع`;
      const bonus = Number(t.fixedBonus) > 0 ? ` + مكافأة ${iqd(t.fixedBonus)}` : "";
      return `إذا بلغ ${th} ← ${pct(t.ratePct)}٪${bonus}`;
    })
    .join("  ·  ");
}

export default function CommissionPlans() {
  const utils = trpc.useUtils();
  const list = trpc.commissions.plans.list.useQuery();
  const rows = list.data ?? [];

  // بوّابة عرض مطابقة للخادم: الكتابة commissionsManagerProcedure(["manager"],"commissions","FULL")
  // — نفس دالة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية) ⇒ لا تباعُد. القراءة (accountant/auditor) بلا أزرار كتابة.
  const me = trpc.auth.me.useQuery();
  const canWrite = !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "commissions", "FULL", ["manager"]);

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
      notify.ok(res.closedPrevious ? "رُبط الموظف بالخطة، وأُوقفت خطته السابقة آلياً" : "رُبط الموظف بالخطة");
    },
    onError: (e) => notify.err(e),
  });
  const endMut = trpc.commissions.plans.endAssignment.useMutation({
    onSuccess: () => { invalidate(); notify.ok("فُكّ ربط الموظف بالخطة"); },
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
    if (fTiers.length === 0) return notify.err("أضف مستوى واحداً على الأقل");
    for (let i = 0; i < fTiers.length; i++) {
      const t = fTiers[i];
      if (!/^\d+(\.\d{1,2})?$/.test(t.threshold.trim())) return notify.err(`حدّ المستوى ${i + 1} غير صالح`);
      if (!/^\d+(\.\d{1,4})?$/.test(t.ratePct.trim())) return notify.err(`نسبة المستوى ${i + 1} غير صالحة`);
      if (!/^\d+(\.\d{1,2})?$/.test(t.fixedBonus.trim() || "0")) return notify.err(`مكافأة المستوى ${i + 1} غير صالحة`);
      if (i > 0 && Number(t.threshold) <= Number(fTiers[i - 1].threshold)) {
        return notify.err("حدود المستويات يجب أن تتصاعد بلا تكرار — رتّبها من الأدنى إلى الأعلى");
      }
      // مرآة حارس الرتابة الخادمي (plans.ts:validateTiers) — رسالة مبكرة بلغة المستخدم
      // بدل رفضٍ بعد رحلة للخادم. الخادم يبقى الحاكم.
      if (i > 0 && Number(t.ratePct) < Number(fTiers[i - 1].ratePct)) {
        return notify.err(`نسبة المستوى ${i + 1} أقل من نسبة المستوى ${i} — لا يصحّ أن يقلّ ربح الموظف كلّما باع أكثر`);
      }
      if (i > 0 && Number(t.fixedBonus || "0") < Number(fTiers[i - 1].fixedBonus || "0")) {
        return notify.err(`مكافأة المستوى ${i + 1} أقل من مكافأة المستوى ${i} — لا يصحّ أن تقلّ المكافأة كلّما باع أكثر`);
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
            ? `الخطة مربوطة حالياً بـ${p.openAssignments} موظف — تعطيلها لا يفكّ الربط، وسيستمرّ النظام باحتسابها لهم حتى تفكّ ربطهم أو تربطهم بخطة بديلة. متابعة؟`
            : "لن تظهر الخطة عند ربط موظفين جدد. متابعة؟",
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
      title: "فكّ ربط الموظف بالخطة",
      description: `سيتوقّف العمل بخطة «${r.assignment.planName}» للموظف ${r.employeeName} بنهاية الشهر الحالي — لن تُحتسَب له عمولة بعد ذلك حتى تربطه بخطة جديدة. متابعة؟`,
      confirmText: "فكّ الربط",
    });
    if (!ok) return;
    endMut.mutate({ assignmentId: r.assignment.id, effectiveTo: thisMonth() });
  }

  const activePlans = rows.filter((p) => p.isActive);

  return (
    <div className="space-y-4">
      <PageHeader
        title="خطط العمولات"
        description="الخطة تحدّد كم يستحق البائع مقابل مبيعاته. لكل خطة مستويات مرتّبة من الأدنى إلى الأعلى: بلوغ حدّ المستوى يمنح نسبته على كامل مبيعات الموظف المحتسَبة + مكافأة ثابتة اختيارية."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}>
              <Users className="size-4" /> ربط الموظفين بالخطط
            </Button>
            {canWrite && (
              <Button size="sm" onClick={openAdd}>
                <Plus className="size-4" /> خطة جديدة
              </Button>
            )}
          </div>
        }
      />

      <CommissionGuide />

      <Card>
        <CardHeader className="text-sm text-muted-foreground">
          {list.isLoading ? "" : `${rows.length} خطة`}
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">اسم الخطة</th>
                  <th className="p-2">طريقة الاحتساب</th>
                  <th className="p-2">المستويات</th>
                  <th className="p-2 text-center whitespace-nowrap">عدد الموظفين</th>
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
                      {canWrite && (
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
                      )}
                    </td>
                  </tr>
                ))}
                {list.isLoading && (
                  <tr><td colSpan={6}><LoadingState /></td></tr>
                )}
                {!list.isLoading && rows.length === 0 && (
                  <TableEmptyRow colSpan={6} message="لا خطط عمولات بعد — أنشئ أول خطة ثم اربط بها الموظفين." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {/* ── حوار إنشاء/تعديل خطة ── */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[92dvh] grid-rows-[auto_minmax(0,1fr)_auto]">
          <DialogHeader>
            <DialogTitle>{editId == null ? "خطة عمولات جديدة" : "تعديل خطة العمولات"}</DialogTitle>
            <DialogDescription>
              {fMode === "TARGET_PCT"
                ? "الحدّ هنا نسبة من الهدف الشهري: ٧٠ تعني «إذا حقّق ٧٠٪ من هدفه». عند بلوغه يأخذ نسبة ذلك المستوى من كامل مبيعاته المحتسَبة."
                : "الحدّ هنا مبلغ مبيعات بالدينار: عند بلوغه يأخذ الموظف نسبة ذلك المستوى من كامل مبيعاته المحتسَبة."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 overflow-y-auto pe-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">اسم الخطة</label>
                <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="خطة مبيعات الكاشير" dir="auto" autoFocus />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">طريقة الاحتساب</label>
                <select
                  value={fMode}
                  onChange={(e) => setFMode(e.target.value as TierMode)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
                >
                  <option value="TARGET_PCT">حسب نسبة تحقيق الهدف — يلزم تحديد هدف شهري لكل موظف</option>
                  <option value="AMOUNT_SLAB">حسب مبلغ المبيعات — بلا حاجة إلى هدف</option>
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm font-medium">المستويات — من الأدنى إلى الأعلى</label>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setFTiers((prev) => [...prev, { ...EMPTY_TIER, threshold: "" }])}
                  disabled={fTiers.length >= 12}
                >
                  <Plus className="size-3.5" /> إضافة مستوى
                </Button>
              </div>

              <div className="rounded-md border p-2">
                {/* ترويسة واحدة بدل تكرار التسميات على كل سطر — أوضح وأوفر للمساحة. */}
                <div className="grid grid-cols-[2rem_1fr_1fr_1fr_2.25rem] items-end gap-2 pb-1 text-xs text-muted-foreground">
                  <span />
                  <span>{fMode === "TARGET_PCT" ? "إذا حقّق من هدفه (٪)" : "إذا بلغت مبيعاته (د.ع)"}</span>
                  <span>فله نسبة (٪)</span>
                  <span>+ مكافأة ثابتة (د.ع)</span>
                  <span />
                </div>
                <div className="space-y-2">
                  {fTiers.map((t, i) => (
                    <div key={i} className="grid grid-cols-[2rem_1fr_1fr_1fr_2.25rem] items-center gap-2">
                      <span className="text-center text-xs font-medium text-muted-foreground tabular-nums">{i + 1}</span>
                      <Input
                        value={t.threshold}
                        onChange={(e) => setTier(i, "threshold", e.target.value)}
                        dir="ltr"
                        inputMode="decimal"
                        className="tabular-nums"
                        aria-label={`حدّ المستوى ${i + 1}`}
                      />
                      <Input
                        value={t.ratePct}
                        onChange={(e) => setTier(i, "ratePct", e.target.value)}
                        dir="ltr"
                        inputMode="decimal"
                        className="tabular-nums"
                        placeholder="2"
                        aria-label={`نسبة المستوى ${i + 1}`}
                      />
                      <Input
                        value={t.fixedBonus}
                        onChange={(e) => setTier(i, "fixedBonus", e.target.value)}
                        dir="ltr"
                        inputMode="decimal"
                        className="tabular-nums"
                        aria-label={`مكافأة المستوى ${i + 1}`}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-destructive"
                        aria-label={`حذف المستوى ${i + 1}`}
                        onClick={() => setFTiers((prev) => prev.filter((_, idx) => idx !== i))}
                        disabled={fTiers.length <= 1}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                النسبة تُضرب في كامل المبلغ المحتسَب عليه (لا في الجزء الزائد عن الحدّ فقط). ولا يقبل النظام أن تقلّ نسبة مستوى أعلى — ولا مكافأته — عن مستوى أدنى منه، حتى لا يخسر الموظف ببيعه أكثر.
              </p>
            </div>

            <TierPlayground tierMode={fMode} tiers={fTiers} />

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
        {/* عرضٌ واسع + صفٌّ بلا التفاف: الحوار السابق (3xl) كان يقصّ عمودَي «الخطة الجديدة»
            و«إجراء» خلف تمرير أفقيّ فلا يرى المستخدم زرّ الربط أصلاً. */}
        <DialogContent className="sm:max-w-6xl w-[min(1200px,96vw)] max-h-[92dvh] grid-rows-[auto_minmax(0,1fr)_auto]">
          <DialogHeader>
            <DialogTitle>ربط الموظفين بخطط العمولات</DialogTitle>
            <DialogDescription>
              لكل موظف خطة واحدة فعّالة — وربطه بخطة جديدة يوقف خطته السابقة آلياً بنهاية الشهر الذي قبلها.
              يظهر هنا الموظفون المرتبطون بحساب مستخدم فقط، لأنّ المبيعات تُنسَب إلى الحساب الذي أصدر الفاتورة.
            </DialogDescription>
          </DialogHeader>
          <ScrollTableShell maxHeightClass="max-h-full" className="h-full">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">الموظف</th>
                  <th className="p-2 text-start">الفرع</th>
                  <th className="p-2 text-start">خطته الحالية</th>
                  <th className="p-2 text-start">الخطة الجديدة</th>
                  <th className="p-2 text-start whitespace-nowrap">تبدأ من شهر</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {(board.data ?? []).map((r) => (
                  <tr key={r.employeeId} className="border-t">
                    <td className="p-2">
                      <div className="font-medium whitespace-nowrap">{r.employeeName}</div>
                      <div className="text-xs text-muted-foreground whitespace-nowrap">
                        {r.position || "—"}
                        {r.employmentStatus === "leave" ? " · في إجازة" : ""}
                      </div>
                    </td>
                    <td className="p-2 text-muted-foreground whitespace-nowrap">{r.branchName || "—"}</td>
                    <td className="p-2">
                      {r.assignment ? (
                        <div>
                          <div className="whitespace-nowrap">{r.assignment.planName}</div>
                          <div className="text-xs text-muted-foreground whitespace-nowrap">
                            منذ <span dir="ltr" className="tabular-nums">{r.assignment.effectiveFrom}</span>
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground whitespace-nowrap">بلا خطة</span>
                      )}
                    </td>
                    <td className="p-2">
                      {canWrite ? (
                        <select
                          value={draftPlan[r.employeeId] ?? ""}
                          onChange={(e) => setDraftPlan((prev) => ({ ...prev, [r.employeeId]: e.target.value }))}
                          className="h-8 w-44 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm"
                          aria-label={`خطة ${r.employeeName}`}
                        >
                          <option value="">اختر خطة…</option>
                          {activePlans.map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="p-2">
                      {canWrite ? (
                        <Input
                          type="month"
                          dir="ltr"
                          className="h-8 w-36 text-xs tabular-nums"
                          value={draftFrom[r.employeeId] ?? thisMonth()}
                          onChange={(e) => setDraftFrom((prev) => ({ ...prev, [r.employeeId]: e.target.value }))}
                          aria-label={`أول شهر يعمل فيه ${r.employeeName} بالخطة`}
                        />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="p-2 text-center">
                      {canWrite && (
                        <div className="flex items-center justify-center gap-1 whitespace-nowrap">
                          <Button size="sm" variant="outline" disabled={assignMut.isPending} onClick={() => assignRow(r)}>
                            ربط
                          </Button>
                          {r.assignment && (
                            <Button size="sm" variant="ghost" className="text-destructive" disabled={endMut.isPending} onClick={() => void endRow(r)}>
                              فكّ الربط
                            </Button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {board.isLoading && (
                  <tr><td colSpan={6}><LoadingState /></td></tr>
                )}
                {!board.isLoading && (board.data ?? []).length === 0 && (
                  <TableEmptyRow colSpan={6} message="لا موظفين مرتبطين بحسابات مستخدمين — اربط الموظف بحسابه من شاشة الموظف أولاً." />
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
