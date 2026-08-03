/* ============================================================================
 * شاشة الترقيات وإنهاء الخدمات — وحدة الموارد البشرية (client/src/pages/Promotions.tsx)
 * تبويبان: «الترقيات» (جدول + اعتماد المعلّقة + نافذة ترقية) و«إنهاء الخدمات»
 * (جدول + إكمال المعلّق + نافذة إنهاء). الموظف يُختار من trpc.employees.list،
 * والمبالغ تُعرض بـ iqd(). الموجّه مركَّب تحت trpc.promotions.
 * ========================================================================== */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { RowActions } from "@/components/list/RowActions";
import { ListToolbar } from "@/components/list/ListToolbar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { EmpAvatar, iqd } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { WagePackageFields, wageValueFromEmployee, type WagePackageValue } from "@/components/form/WagePackageFields";
import { TERMINATION_TYPES } from "@shared/hr";
import { describeWageDiff, type WageProfileShape } from "@shared/wageDiff";
import { CheckCircle2, TrendingUp, UserMinus, Wallet } from "lucide-react";
import { useMemo, useState } from "react";

const today = () => new Date().toISOString().slice(0, 10);
const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const promoStatusCls: Record<string, string> = {
  approved: "badge-status-active",
  pending: "badge-status-pending",
};
const promoStatusLabel = (s: string) => (s === "approved" ? "معتمدة" : "قيد الاعتماد");
const termStatusCls: Record<string, string> = {
  completed: "badge-status-cancelled",
  pending: "badge-status-pending",
};
const termStatusLabel = (s: string) => (s === "completed" ? "مكتملة" : "قيد التنفيذ");

/**
 * تفصيل حزمة الأجر قبل/بعد — **شرطُ جدوى الاعتماد الثاني**: من يعتمد تغييراً أجرياً
 * دون رؤية قيمه القديمة والجديدة يُوقّع على ما لم يره، فتصير البوّابة إجراءً شكلياً
 * (مراجعة Codex P1 على PR #449 — كان الصفّ يعرض وسماً عامّاً «حزمة أجر» فحسب).
 */
function WageDiffList({ from, to }: { from: unknown; to: unknown }) {
  const rows = describeWageDiff(from as WageProfileShape | null, to as WageProfileShape | null);
  if (!rows.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-[11px]">
      {rows.map((r, i) => (
        <li key={`${r.key}-${i}`} className="flex flex-wrap items-baseline justify-end gap-1">
          <span className="text-muted-foreground">{r.label}:</span>
          <span className="tabular-nums line-through text-muted-foreground" dir="auto">{r.before}</span>
          <span aria-hidden>←</span>
          <span className="tabular-nums font-medium text-money-positive" dir="auto">{r.after}</span>
        </li>
      ))}
    </ul>
  );
}

function EmpCell({ name, color, photoUrl }: { name: string; color?: string | null; photoUrl?: string | null }) {
  return (
    <div className="flex items-center gap-2">
      <EmpAvatar name={name} color={color} photoUrl={photoUrl} sizePx={28} />
      <span className="text-[13px] font-medium">{name}</span>
    </div>
  );
}

export default function Promotions() {
  const [tab, setTab] = useState("promotions");
  const [query, setQuery] = useState("");
  const utils = trpc.useUtils();

  const promotions = trpc.promotions.listPromotions.useQuery();
  const terminations = trpc.promotions.listTerminations.useQuery();
  const employees = trpc.employees.list.useQuery({ status: "active", limit: 200 });
  const activeEmps = employees.data?.rows ?? [];

  /* ===== نافذة الترقية ===== */
  const [promoOpen, setPromoOpen] = useState(false);
  const [pEmp, setPEmp] = useState("");
  const [pToTitle, setPToTitle] = useState("");
  const [pToSalary, setPToSalary] = useState("");
  const [pDate, setPDate] = useState(today());
  const [pReason, setPReason] = useState("");
  const selectedEmp = useMemo(() => activeEmps.find((e) => String(e.id) === pEmp), [activeEmps, pEmp]);

  /*
   * حزمة الأجر (0143): الترقية هي **المسار الوحيد** لتغيير أيّ حقلٍ حاملٍ للأجر بعد
   * التعيين لغير الأدمن — الراتب والبدلات وجدول الدوام وأسعار ساعات الأيام والإعفاء
   * من الحضور. كانت تحمل الراتب وحده، فبقيت البقية تُعدَّل من شاشة الموظف بفاعلٍ واحد.
   * القيم تُملأ من حالة الموظف المختار عبر نفس المُطبِّع الذي يستعمله نموذج الموظف.
   */
  const [pWageOn, setPWageOn] = useState(false);
  const [pWage, setPWage] = useState<WagePackageValue>(() => wageValueFromEmployee(null));

  const resetPromo = () => { setPEmp(""); setPToTitle(""); setPToSalary(""); setPDate(today()); setPReason(""); setPWageOn(false); setPWage(wageValueFromEmployee(null)); };
  const createPromo = trpc.promotions.createPromotion.useMutation({
    onSuccess: async () => { notify.ok("سُجّلت الترقية (قيد الاعتماد)"); setPromoOpen(false); resetPromo(); await utils.promotions.listPromotions.invalidate(); },
    onError: (e) => notify.err(e),
  });
  const approvePromo = trpc.promotions.approvePromotion.useMutation({
    onSuccess: async () => { notify.ok("اعتُمدت الترقية وحُدّث الموظف"); await Promise.all([utils.promotions.listPromotions.invalidate(), utils.employees.list.invalidate()]); },
    onError: (e) => notify.err(e),
  });

  const submitPromo = () => {
    if (!pEmp) return notify.warn("اختر الموظف");
    // المسمّى لم يعد إلزامياً: تغييرٌ أجريٌّ بحت (جدول/أسعار) يبقي المسمّى الحاليّ —
    // لكن طلباً بلا مسمّى ولا حزمةٍ ولا راتبٍ لا يغيّر شيئاً فلا يُستهلَك عليه اعتماد.
    if (!pToTitle.trim() && !pWageOn && !pToSalary.trim()) {
      return notify.warn("حدّد مسمّى جديداً أو فعّل «تغيير حزمة الأجر»");
    }
    if (pWageOn && pWage.payType === "monthly" && !pWage.salary.trim()) {
      return notify.warn("الراتب الأساس مطلوب لذوي الراتب الشهري");
    }
    createPromo.mutate({
      employeeId: Number(pEmp),
      toTitle: pToTitle.trim() || undefined,
      // الراتب المستقلّ يُهمَل عند تفعيل الحزمة — الحزمة تحمله فلا مصدران متعارضان.
      toSalary: pWageOn ? undefined : pToSalary.trim() || undefined,
      effectiveDate: pDate,
      reason: pReason.trim() || undefined,
      wage: pWageOn
        ? {
            payType: pWage.payType,
            salary: pWage.payType === "monthly" ? pWage.salary.trim() || null : null,
            allowances: pWage.allowances.trim() || "0",
            attendanceExempt: pWage.payType === "monthly" && pWage.attendanceExempt,
            dayRates: pWage.payType === "hourly" ? pWage.dayRates : undefined,
            workSchedule: pWage.schedule,
          }
        : undefined,
    });
  };

  /* ===== نافذة إنهاء الخدمة ===== */
  const [termOpen, setTermOpen] = useState(false);
  const [tEmp, setTEmp] = useState("");
  const [tType, setTType] = useState<string>(TERMINATION_TYPES[0]);
  const [tLastDay, setTLastDay] = useState(today());
  const [tSettlement, setTSettlement] = useState("");
  const [tReason, setTReason] = useState("");

  const resetTerm = () => { setTEmp(""); setTType(TERMINATION_TYPES[0]); setTLastDay(today()); setTSettlement(""); setTReason(""); };
  const createTerm = trpc.promotions.createTermination.useMutation({
    onSuccess: async () => { notify.ok("سُجّل إجراء إنهاء الخدمة (قيد التنفيذ)"); setTermOpen(false); resetTerm(); await utils.promotions.listTerminations.invalidate(); },
    onError: (e) => notify.err(e),
  });
  const completeTerm = trpc.promotions.completeTermination.useMutation({
    onSuccess: async (data) => {
      if (data?.settlementVoucher) {
        // تسوية المستحقات صارت سند صرفٍ مُعلَّق يعتمده مديرٌ آخر (فصل مهام #٦) — أبلِغ المستخدم بوجهة الفعل.
        notify.ok(`اكتمل إنهاء الخدمة. تسوية المستحقات صُدِّرت كسند صرف مُعلَّق (${data.settlementVoucher.voucherNumber}) — يعتمده مديرٌ آخر من شاشة السندات.`);
      } else {
        notify.ok("اكتمل إنهاء الخدمة وأُنهيت خدمة الموظف");
      }
      await Promise.all([utils.promotions.listTerminations.invalidate(), utils.employees.list.invalidate()]);
    },
    onError: (e) => notify.err(e),
  });

  const submitTerm = () => {
    if (!tEmp) return notify.warn("اختر الموظف");
    createTerm.mutate({
      employeeId: Number(tEmp),
      terminationType: tType as (typeof TERMINATION_TYPES)[number],
      lastDay: tLastDay,
      settlement: tSettlement.trim() || undefined,
      reason: tReason.trim() || undefined,
    });
  };

  const promoRows = promotions.data ?? [];
  const termRows = terminations.data ?? [];
  const filteredPromos = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return q ? promoRows.filter((p) => [p.employeeName, p.fromTitle, p.toTitle, p.reason, promoStatusLabel(p.status)].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q))) : promoRows;
  }, [promoRows, query]);
  const filteredTerms = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return q ? termRows.filter((t) => [t.employeeName, t.terminationType, t.reason, termStatusLabel(t.status)].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q))) : termRows;
  }, [termRows, query]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="الترقيات وإنهاء الخدمات"
        description="ترقيات المسمّى والراتب، وإجراءات إنهاء الخدمة مع التسوية النهائية للمستحقات."
        actions={
          tab === "promotions" ? (
            <Button onClick={() => setPromoOpen(true)}><TrendingUp className="size-4 ml-1" /> ترقية موظف</Button>
          ) : (
            <Button className="bg-destructive text-white hover:bg-destructive/90" onClick={() => setTermOpen(true)}><UserMinus className="size-4 ml-1" /> إنهاء خدمة</Button>
          )
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="promotions">الترقيات ({promoRows.length})</TabsTrigger>
          <TabsTrigger value="terminations">إنهاء الخدمات ({termRows.length})</TabsTrigger>
        </TabsList>

        {/* ===== الترقيات ===== */}
        <TabsContent value="promotions">
          <Card>
            <CardHeader>
              <ListToolbar
                title="سجل الترقيات"
                count={filteredPromos.length}
                loading={promotions.isLoading}
                search={{ value: query, onChange: setQuery, placeholder: "الموظف، المسمّى، السبب أو الحالة…" }}
                onResetFilters={() => setQuery("")}
                onRefresh={() => void promotions.refetch()}
                refreshing={promotions.isFetching}
                onPrint={() => window.print()}
                exportSpec={{
                  filename: "ترقيات-الموظفين",
                  rows: filteredPromos,
                  formats: ["xlsx", "csv"],
                  columns: [
                    { key: "employeeName", header: "الموظف" }, { key: "fromTitle", header: "من مسمّى" },
                    { key: "toTitle", header: "إلى مسمّى" }, { key: "fromSalary", header: "الراتب السابق", money: true },
                    { key: "toSalary", header: "الراتب الجديد", money: true }, { key: "effectiveDate", header: "التاريخ" },
                    { key: "reason", header: "السبب" }, { key: "status", header: "الحالة", map: (p) => promoStatusLabel(p.status) },
                  ],
                }}
              />
            </CardHeader>
            <CardContent className="p-0">
              <ScrollTableShell bordered={false}>
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-2">الموظف</th>
                      <th className="p-2">من مسمّى</th>
                      <th className="p-2">إلى مسمّى</th>
                      <th className="p-2 text-right">تغيّر الراتب</th>
                      <th className="p-2 text-center">التاريخ</th>
                      <th className="p-2">السبب</th>
                      <th className="p-2 text-center">الحالة</th>
                      <th className="p-2 text-center">إجراء</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPromos.map((p) => (
                      <tr key={p.id} className="border-t hover:bg-accent/40">
                        <td className="p-2"><EmpCell name={p.employeeName} color={p.colorTag} photoUrl={p.photoUrl} /></td>
                        <td className="p-2 text-xs text-muted-foreground">{p.fromTitle ?? "—"}</td>
                        {/* مسمّى فارغ = تغييرٌ أجريٌّ بحت لا ترقيةَ مسمّى. */}
                        <td className="p-2 text-[13px] font-medium">{p.toTitle || "—"}</td>
                        <td className="p-2 text-right tabular-nums text-xs" dir="ltr">
                          <span className="text-muted-foreground">{iqd(p.fromSalary)}</span> → <span className="font-medium text-money-positive">{p.toSalary != null ? iqd(p.toSalary) : "—"}</span>
                          {/* «الراتب لم يتغيّر» لا يعني «الأجر لم يتغيّر»: الجدول وأسعار الساعات
                              تُغيّر المدفوع فعلياً، فيلزم أن يراها المعتمِد قبل الاعتماد. */}
                          {p.toWage != null && (
                            <div dir="rtl">
                              <span className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                                <Wallet aria-hidden className="size-3" /> حزمة أجر
                              </span>
                              <WageDiffList from={p.fromWage} to={p.toWage} />
                            </div>
                          )}
                        </td>
                        <td className="p-2 text-center text-xs tabular-nums" dir="ltr">{p.effectiveDate}</td>
                        <td className="p-2 text-xs">{p.reason ?? "—"}</td>
                        <td className="p-2 text-center"><span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${promoStatusCls[p.status] ?? "bg-muted text-muted-foreground"}`}>{promoStatusLabel(p.status)}</span></td>
                        <td className="p-2 text-center">
                          {p.status === "pending" ? (
                            <RowActions
                              mode="inline"
                              actions={[{
                                key: "approve",
                                kind: "approve",
                                label: "اعتماد",
                                gate: { module: "hr", level: "FULL" },
                                disabled: approvePromo.isPending,
                                disabledReason: "جارٍ اعتماد الترقية",
                                onSelect: async () => {
                                  // الحوار يسرد التغييرات بقيمها لا بوصفٍ عامّ — المعتمِد يقرّ ما يراه.
                                  const diff = describeWageDiff(p.fromWage as WageProfileShape | null, p.toWage as WageProfileShape | null);
                                  const wageNote = diff.length
                                    ? `\n\nتغييرات حزمة الأجر:\n${diff.map((r) => `• ${r.label}: ${r.before} ← ${r.after}`).join("\n")}`
                                    : "";
                                  const titleNote = p.toTitle ? ` إلى «${p.toTitle}»` : "";
                                  if (!(await confirm({ variant: "warning", title: "اعتماد الترقية", description: `اعتماد طلب «${p.employeeName}»${titleNote} يحدّث بيانات الموظف المالية.${wageNote}`, confirmText: "اعتماد" }))) return;
                                  approvePromo.mutate({ id: p.id });
                                },
                              }]}
                            />
                          ) : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    ))}
                    {promotions.isLoading && (
                      <tr><td colSpan={8}><LoadingState /></td></tr>
                    )}
                    {promotions.isError && (
                      <tr><td colSpan={8}><ErrorState message="تعذّر تحميل الترقيات." onRetry={() => promotions.refetch()} /></td></tr>
                    )}
                    {!promotions.isLoading && !promotions.isError && filteredPromos.length === 0 && (
                      <TableEmptyRow colSpan={8} message="لا ترقيات مسجّلة بعد." />
                    )}
                  </tbody>
                </table>
              </ScrollTableShell>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ===== إنهاء الخدمات ===== */}
        <TabsContent value="terminations">
          {terminations.isError ? (
            <Card><CardContent className="p-0">
              <ErrorState message="تعذّر تحميل إنهاءات الخدمة." onRetry={() => terminations.refetch()} />
            </CardContent></Card>
          ) : !terminations.isLoading && termRows.length === 0 ? (
            <Card><CardContent className="py-10 text-center text-muted-foreground">
              <CheckCircle2 className="size-8 mx-auto mb-2 opacity-50" />
              <div>لا إجراءات إنهاء خدمة.</div>
            </CardContent></Card>
          ) : (
            <Card>
              <CardHeader>
                <ListToolbar
                  title="سجل إنهاء الخدمات"
                  count={filteredTerms.length}
                  loading={terminations.isLoading}
                  search={{ value: query, onChange: setQuery, placeholder: "الموظف، نوع الإنهاء، السبب أو الحالة…" }}
                  onResetFilters={() => setQuery("")}
                  onRefresh={() => void terminations.refetch()}
                  refreshing={terminations.isFetching}
                  onPrint={() => window.print()}
                  exportSpec={{
                    filename: "إنهاء-الخدمات",
                    rows: filteredTerms,
                    formats: ["xlsx", "csv"],
                    columns: [
                      { key: "employeeName", header: "الموظف" }, { key: "terminationType", header: "نوع الإنهاء" },
                      { key: "lastDay", header: "آخر يوم" }, { key: "settlement", header: "التسوية", money: true },
                      { key: "reason", header: "السبب" }, { key: "status", header: "الحالة", map: (t) => termStatusLabel(t.status) },
                    ],
                  }}
                />
              </CardHeader>
              <CardContent className="p-0">
                <ScrollTableShell bordered={false}>
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="p-2">الموظف</th>
                        <th className="p-2">نوع الإنهاء</th>
                        <th className="p-2 text-center">آخر يوم عمل</th>
                        <th className="p-2 text-right">التسوية النهائية</th>
                        <th className="p-2">السبب</th>
                        <th className="p-2 text-center">الحالة</th>
                        <th className="p-2 text-center">إجراء</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTerms.map((t) => (
                        <tr key={t.id} className="border-t hover:bg-accent/40">
                          <td className="p-2"><EmpCell name={t.employeeName} color={t.colorTag} photoUrl={t.photoUrl} /></td>
                          <td className="p-2 text-[13px]">{t.terminationType}</td>
                          <td className="p-2 text-center text-xs tabular-nums" dir="ltr">{t.lastDay}</td>
                          <td className="p-2 text-right tabular-nums font-medium" dir="ltr">{iqd(t.settlement)}</td>
                          <td className="p-2 text-xs text-muted-foreground">{t.reason ?? "—"}</td>
                          <td className="p-2 text-center"><span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${termStatusCls[t.status] ?? "bg-muted text-muted-foreground"}`}>{termStatusLabel(t.status)}</span></td>
                          <td className="p-2 text-center">
                            {t.status === "pending" ? (
                              <RowActions
                                mode="inline"
                                actions={[{
                                  key: "complete",
                                  kind: "approve",
                                  label: "إكمال",
                                  gate: { module: "hr", level: "FULL" },
                                  disabled: completeTerm.isPending,
                                  disabledReason: "جارٍ إكمال إنهاء الخدمة",
                                  onSelect: async () => {
                                    if (!(await confirm({ variant: "danger", title: "إكمال إنهاء الخدمة", description: `إنهاء خدمة «${t.employeeName}» نهائي، سيُستثنى الموظف من المسيّرات. اكتب «إنهاء الخدمة» للتأكيد.`, confirmText: "إنهاء الخدمة", requireText: "إنهاء الخدمة" }))) return;
                                    completeTerm.mutate({ id: t.id });
                                  },
                                }]}
                              />
                            ) : <span className="text-xs text-muted-foreground">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollTableShell>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* ===== نافذة الترقية ===== */}
      <Dialog open={promoOpen} onOpenChange={(o) => { setPromoOpen(o); if (!o) resetPromo(); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>ترقية / تغيير أجر</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="p-emp">الموظف</Label>
              <select
                id="p-emp"
                className={selectCls}
                value={pEmp}
                onChange={(e) => {
                  setPEmp(e.target.value);
                  // تعبئة الحزمة من حالة الموظف الحالية: الطلب يُخزَّن **هدفاً كاملاً**،
                  // فبدءُ التحرير من قيمه الفعلية يمنع تصفير جدولٍ لم يُقصَد تغييره.
                  setPWage(wageValueFromEmployee(activeEmps.find((x) => String(x.id) === e.target.value) ?? null));
                }}
              >
                <option value="">— اختر موظفاً —</option>
                {activeEmps.map((e) => <option key={e.id} value={String(e.id)}>{e.fullName}{e.position ? ` — ${e.position}` : ""}</option>)}
              </select>
              {selectedEmp && (
                <div className="text-xs text-muted-foreground" dir="ltr">
                  المسمّى الحالي: <span dir="rtl">{selectedEmp.position ?? "—"}</span> · الراتب الحالي: <span className="tabular-nums">{iqd(selectedEmp.salary)}</span>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label htmlFor="p-title">المسمّى الجديد</Label><Input id="p-title" value={pToTitle} onChange={(e) => setPToTitle(e.target.value)} placeholder="اتركه فارغاً ليبقى كما هو" /></div>
              {!pWageOn && (
                <div className="space-y-1"><Label htmlFor="p-salary">الراتب الجديد (د.ع)</Label><MoneyInput id="p-salary" value={pToSalary} onChange={setPToSalary} decimals={0} placeholder="1,100,000" /></div>
              )}
            </div>

            {/* حزمة الأجر — المسار المزدوج الاعتماد لتغيير ما لا تسمح به شاشة الموظف. */}
            <div className="rounded-md border p-3 space-y-3">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="size-4 mt-0.5" checked={pWageOn} disabled={!pEmp} onChange={(ev) => setPWageOn(ev.target.checked)} />
                <span>
                  <span className="font-medium flex items-center gap-1"><Wallet aria-hidden className="size-4" /> تغيير حزمة الأجر</span>
                  <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    الراتب والبدلات وجدول الدوام وأسعار ساعات الأيام والإعفاء من الحضور — كلُّها تُغيَّر من هنا
                    فقط (باعتماد مديرٍ آخر)، لأنها تحدّد المبلغ المدفوع فعلياً لا الراتب وحده.
                    {!pEmp && <span className="block mt-0.5">اختر الموظف أولاً لتُملأ حزمته الحالية.</span>}
                  </span>
                </span>
              </label>
              {pWageOn && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t pt-3">
                  <div className="space-y-1">
                    <Label htmlFor="p-paytype">طريقة الأجر</Label>
                    <select id="p-paytype" className={selectCls} value={pWage.payType} onChange={(ev) => setPWage((w) => ({ ...w, payType: ev.target.value as "monthly" | "hourly" }))}>
                      <option value="monthly">راتب شهري</option>
                      <option value="hourly">بالساعة</option>
                    </select>
                  </div>
                  <div className="hidden md:block" aria-hidden />
                  <div className="hidden md:block" aria-hidden />
                  <WagePackageFields value={pWage} onChange={(patch) => setPWage((w) => ({ ...w, ...patch }))} />
                </div>
              )}
            </div>

            <div className="space-y-1"><Label htmlFor="p-date">تاريخ النفاذ</Label><Input id="p-date" type="date" dir="ltr" value={pDate} onChange={(e) => setPDate(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="p-reason">سبب الترقية / التغيير</Label><Textarea id="p-reason" rows={2} value={pReason} onChange={(e) => setPReason(e.target.value)} placeholder="أداء متميز، إكمال فترة تدريب، تعديل جدول دوام…" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPromoOpen(false)}>إلغاء</Button>
            <Button disabled={createPromo.isPending} onClick={submitPromo}>{createPromo.isPending ? "جارٍ…" : "حفظ الترقية"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== نافذة إنهاء الخدمة ===== */}
      <Dialog open={termOpen} onOpenChange={(o) => { setTermOpen(o); if (!o) resetTerm(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>إنهاء خدمة موظف</DialogTitle></DialogHeader>
          <div className="rounded-md p-3 mb-1 text-xs flex items-start gap-2 bg-destructive/10 text-destructive">
            <UserMinus className="size-4 mt-0.5 shrink-0" />
            <span>إجراء حسّاس: عند الإكمال يُستثنى الموظف من المسيّرات ويُحسب رصيده النهائي. تبقى سجلّاته للأرشيف.</span>
          </div>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="t-emp">الموظف</Label>
              <select id="t-emp" className={selectCls} value={tEmp} onChange={(e) => setTEmp(e.target.value)}>
                <option value="">— اختر موظفاً —</option>
                {activeEmps.map((e) => <option key={e.id} value={String(e.id)}>{e.fullName}{e.position ? ` — ${e.position}` : ""}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="t-type">نوع الإنهاء</Label>
                <select id="t-type" className={selectCls} value={tType} onChange={(e) => setTType(e.target.value)}>
                  {TERMINATION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="space-y-1"><Label htmlFor="t-lastday">آخر يوم عمل</Label><Input id="t-lastday" type="date" dir="ltr" value={tLastDay} onChange={(e) => setTLastDay(e.target.value)} /></div>
            </div>
            <div className="space-y-1"><Label htmlFor="t-settle">التسوية النهائية للمستحقات (د.ع)</Label><MoneyInput id="t-settle" value={tSettlement} onChange={setTSettlement} decimals={0} placeholder="رصيد إجازات + مكافأة نهاية خدمة" /></div>
            <div className="space-y-1"><Label htmlFor="t-reason">السبب / ملاحظات</Label><Textarea id="t-reason" rows={2} value={tReason} onChange={(e) => setTReason(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTermOpen(false)}>إلغاء</Button>
            <Button className="bg-destructive text-white hover:bg-destructive/90" disabled={createTerm.isPending} onClick={submitTerm}>{createTerm.isPending ? "جارٍ…" : "حفظ إجراء الإنهاء"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
