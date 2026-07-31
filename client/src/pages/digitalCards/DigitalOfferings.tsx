// تعريف البطاقات والاشتراكات المعروضة للبيع. كل بطاقة تُنشئ منتجاً خدمياً تلقائياً (بلا مخزون)
// وتُربط بفرع أو أكثر. قواعد الهامش هنا تُستعمل لاحقاً لاشتقاق سعر اليوم — البطاقة لا تظهر
// في الكاشير قبل نشر سعر لها في شاشة أسعار اليوم.
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ListToolbar, RowActions } from "@/components/list";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MoneyInput } from "@/components/form/MoneyInput";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { fmtAr } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type OfferingRow = RouterOutputs["digitalCards"]["offerings"]["list"][number];
type OfferingType = OfferingRow["offeringType"];
type PricingMode = OfferingRow["pricingMode"];

const OFFERING_TYPE: Record<string, string> = {
  TELECOM_CARD: "كارت اتصالات",
  GLOBAL_CARD: "بطاقة عالمية",
  EDUCATIONAL_SUBSCRIPTION: "اشتراك تعليمي",
  OTHER: "أخرى",
};
const PRICING_MODE: Record<string, string> = {
  FIXED_MARGIN: "ربح ثابت",
  PERCENT_MARGIN: "نسبة من حصة المزوّد",
  FIXED_PLUS_PERCENT: "ثابت + نسبة",
  FIXED_SELL_PRICE: "سعر بيع محدّد إدارياً",
};

const selectCls = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm";

export default function DigitalOfferings() {
  const utils = trpc.useUtils();
  const list = trpc.digitalCards.offerings.list.useQuery();
  const providers = trpc.digitalCards.providers.list.useQuery();
  const branches = trpc.branches.list.useQuery();
  const rows = list.data ?? [];
  const [query, setQuery] = useState("");
  const visibleRows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return q ? rows.filter((o) => [o.productName, o.supplierName, OFFERING_TYPE[o.offeringType], PRICING_MODE[o.pricingMode]].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q))) : rows;
  }, [rows, query]);

  const activeProviders = (providers.data ?? []).filter((p) => p.isActive);

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [fProviderId, setFProviderId] = useState("");
  const [fName, setFName] = useState("");
  const [fType, setFType] = useState<OfferingType>("TELECOM_CARD");
  const [fRequiresStudent, setFRequiresStudent] = useState(false);
  const [fFaceValue, setFFaceValue] = useState("");
  const [fPricingMode, setFPricingMode] = useState<PricingMode>("FIXED_MARGIN");
  const [fFixedMargin, setFFixedMargin] = useState("0");
  const [fMarginPercent, setFMarginPercent] = useState("0");
  const [fMinimumMargin, setFMinimumMargin] = useState("0");
  const [fRoundingStep, setFRoundingStep] = useState("250");
  const [fBranchIds, setFBranchIds] = useState<number[]>([]);

  function invalidate() {
    void utils.digitalCards.offerings.list.invalidate();
  }

  const createMut = trpc.digitalCards.offerings.create.useMutation({
    onSuccess: () => { invalidate(); setFormOpen(false); notify.ok("أُضيفت البطاقة", "لن تظهر في الكاشير قبل نشر سعر لها."); },
    onError: (e) => notify.err(e),
  });
  const updateMut = trpc.digitalCards.offerings.update.useMutation({
    onSuccess: () => { invalidate(); setFormOpen(false); notify.ok("حُفظت التعديلات"); },
    onError: (e) => notify.err(e),
  });
  const toggleMut = trpc.digitalCards.offerings.toggle.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => notify.err(e),
  });

  const detail = trpc.digitalCards.offerings.get.useQuery(
    { id: editId ?? 0 },
    { enabled: formOpen && editId != null },
  );

  function openAdd() {
    setEditId(null);
    setFProviderId(""); setFName(""); setFType("TELECOM_CARD"); setFRequiresStudent(false);
    setFFaceValue(""); setFPricingMode("FIXED_MARGIN");
    setFFixedMargin("0"); setFMarginPercent("0"); setFMinimumMargin("0"); setFRoundingStep("250");
    setFBranchIds([]);
    setFormOpen(true);
  }

  function openEdit(o: OfferingRow) {
    setEditId(o.id);
    setFProviderId(String(o.providerId));
    setFName(o.productName); setFType(o.offeringType);
    setFRequiresStudent(o.requiresStudentData);
    setFFaceValue(o.faceValue ?? "");
    setFPricingMode(o.pricingMode);
    setFFixedMargin(o.fixedMargin); setFMarginPercent(o.marginPercent);
    setFMinimumMargin(o.minimumMargin); setFRoundingStep(o.roundingStep);
    // الفروع تصل من استعلام التفاصيل (get) لأن قائمة العرض لا تحملها.
    setFBranchIds([]);
    setFormOpen(true);
  }

  // فروع البطاقة تصل من استعلام التفاصيل (قائمة العرض لا تحملها) ⇒ تُزامَن عند وصولها.
  const detailForId = detail.data?.id;
  useEffect(() => {
    if (editId != null && detailForId === editId) {
      setFBranchIds(detail.data?.branches.map((b) => b.branchId) ?? []);
    }
  }, [editId, detailForId, detail.data]);

  function toggleBranch(id: number) {
    setFBranchIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function submitForm() {
    const name = fName.trim();
    if (!name) return notify.err("اسم البطاقة مطلوب");
    if (fBranchIds.length === 0) return notify.err("اختر فرعاً واحداً على الأقل");

    const shared = {
      name,
      offeringType: fType,
      requiresStudentData: fRequiresStudent,
      faceValue: fFaceValue.trim() || null,
      pricingMode: fPricingMode,
      fixedMargin: fFixedMargin || "0",
      marginPercent: fMarginPercent || "0",
      minimumMargin: fMinimumMargin || "0",
      roundingStep: fRoundingStep || "250",
      branches: fBranchIds.map((branchId) => ({ branchId })),
    };

    if (editId != null) { updateMut.mutate({ id: editId, ...shared }); return; }
    const providerId = Number(fProviderId);
    if (!providerId) return notify.err("اختر المزوّد");
    createMut.mutate({ providerId, ...shared });
  }

  async function toggle(o: OfferingRow) {
    if (o.isActive && !(await confirm({
      variant: "danger",
      title: "تعطيل البطاقة",
      description: `لن تظهر «${o.productName}» في شبكة بطاقات الكاشير. المبيعات السابقة وأسعارها التاريخية تبقى كما هي. متابعة؟`,
      confirmText: "تعطيل",
    }))) return;
    toggleMut.mutate({ id: o.id, isActive: !o.isActive });
  }

  const saving = createMut.isPending || updateMut.isPending;
  const editing = editId != null;
  const showFixed = fPricingMode === "FIXED_MARGIN" || fPricingMode === "FIXED_PLUS_PERCENT";
  const showPercent = fPricingMode === "PERCENT_MARGIN" || fPricingMode === "FIXED_PLUS_PERCENT";

  return (
    <div className="space-y-4">
      <PageHeader
        title="البطاقات والاشتراكات"
        description="تعريف ما يُباع: كل بطاقة تُنشئ منتجاً خدمياً بلا مخزون وتُربط بفروعها. قواعد الهامش هنا تشتقّ سعر اليوم — والبطاقة لا تظهر للكاشير قبل نشر سعر لها."
        actions={
          <Button size="sm" onClick={openAdd} disabled={activeProviders.length === 0}>
            <Plus className="size-4" /> بطاقة جديدة
          </Button>
        }
      />

      {activeProviders.length === 0 && !providers.isLoading && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            لا مزوّدين مفعّلين — عرّف مزوّداً من تبويب المزوّدين قبل إضافة بطاقات.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <ListToolbar
            title="قائمة البطاقات"
            count={visibleRows.length}
            loading={list.isLoading}
            search={{ value: query, onChange: setQuery, placeholder: "البطاقة، المزوّد، النوع أو قاعدة التسعير…" }}
            onResetFilters={() => setQuery("")}
            onRefresh={() => void list.refetch()}
            refreshing={list.isFetching}
            onPrint={() => window.print()}
            exportSpec={{
              filename: "البطاقات-والاشتراكات",
              rows: visibleRows,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "productName", header: "البطاقة" }, { key: "supplierName", header: "المزوّد" },
                { key: "offeringType", header: "النوع", map: (o) => OFFERING_TYPE[o.offeringType] ?? o.offeringType },
                { key: "faceValue", header: "القيمة الاسمية", money: true },
                { key: "pricingMode", header: "قاعدة التسعير", map: (o) => PRICING_MODE[o.pricingMode] ?? o.pricingMode },
                { key: "minimumMargin", header: "أقل هامش", money: true },
                { key: "isActive", header: "الحالة", map: (o) => o.isActive ? "مفعّلة" : "معطّلة" },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">البطاقة</th>
                  <th className="p-2 text-start">المزوّد</th>
                  <th className="p-2 text-start">النوع</th>
                  <th className="p-2 text-start">القيمة الاسمية</th>
                  <th className="p-2 text-start">قاعدة التسعير</th>
                  <th className="p-2 text-start">أقلّ هامش</th>
                  <th className="p-2 text-center">بيانات طالب</th>
                  <th className="p-2 text-center">الحالة</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((o) => (
                  <tr key={o.id} className={`border-t ${o.isActive ? "" : "opacity-60"}`}>
                    <td className="p-2 font-medium">{o.productName}</td>
                    <td className="p-2">{o.supplierName}</td>
                    <td className="p-2 text-muted-foreground">{OFFERING_TYPE[o.offeringType] ?? o.offeringType}</td>
                    <td className="p-2 tabular-nums">{o.faceValue ? fmtAr(o.faceValue) : "—"}</td>
                    <td className="p-2 text-muted-foreground">{PRICING_MODE[o.pricingMode] ?? o.pricingMode}</td>
                    <td className="p-2 tabular-nums">{fmtAr(o.minimumMargin)}</td>
                    <td className="p-2 text-center">{o.requiresStudentData ? "نعم" : "لا"}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${o.isActive ? "badge-status-active" : "badge-stock-out"}`}>
                        {o.isActive ? "مفعّلة" : "معطّلة"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      <RowActions
                        actions={[
                          {
                            key: "edit",
                            kind: "edit",
                            label: "تعديل",
                            onSelect: () => openEdit(o),
                            gate: { roles: ["manager"], module: "digital_cards", level: "FULL" },
                          },
                          {
                            key: "toggle",
                            kind: "approve",
                            label: o.isActive ? "تعطيل" : "تفعيل",
                            variant: o.isActive ? "destructive" : "default",
                            disabled: toggleMut.isPending,
                            disabledReason: "توجد عملية تحديث قيد التنفيذ",
                            onSelect: () => void toggle(o),
                            gate: { roles: ["manager"], module: "digital_cards", level: "FULL" },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
                {list.isLoading && <tr><td colSpan={9}><LoadingState /></td></tr>}
                {!list.isLoading && visibleRows.length === 0 && (
                  <TableEmptyRow colSpan={9} message="لا بطاقات بعد — عرّف أوّل بطاقة لمزوّد مفعّل." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "تعديل بطاقة" : "إضافة بطاقة"}</DialogTitle>
            <DialogDescription>
              المزوّد لا يتغيّر بعد الإنشاء. الهوامش هنا قواعدُ اشتقاق لا أسعارٌ نافذة — السعر يُنشر يومياً من شاشة أسعار اليوم.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="do-provider">المزوّد</label>
                <select
                  id="do-provider"
                  className={selectCls}
                  value={fProviderId}
                  disabled={editing}
                  onChange={(e) => setFProviderId(e.target.value)}
                >
                  <option value="">— اختر المزوّد —</option>
                  {activeProviders.map((p) => (
                    <option key={p.id} value={p.id}>{p.supplierName}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="do-type">النوع</label>
                <select
                  id="do-type"
                  className={selectCls}
                  value={fType}
                  onChange={(e) => setFType(e.target.value as OfferingType)}
                >
                  {Object.entries(OFFERING_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">اسم البطاقة</label>
              <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="كارت آسياسيل ١٠ آلاف" dir="auto" autoFocus />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">القيمة الاسمية (اختياري)</label>
                <MoneyInput value={fFaceValue} onChange={setFFaceValue} ariaLabel="القيمة الاسمية" />
                <p className="text-xs text-muted-foreground">القيمة المطبوعة على الكرت — للعرض والتمييز فقط، لا تُسعّر بها.</p>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="do-pricing">قاعدة التسعير</label>
                <select
                  id="do-pricing"
                  className={selectCls}
                  value={fPricingMode}
                  onChange={(e) => setFPricingMode(e.target.value as PricingMode)}
                >
                  {Object.entries(PRICING_MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {showFixed && (
                <div className="space-y-1">
                  <label className="text-sm font-medium">الربح الثابت</label>
                  <MoneyInput value={fFixedMargin} onChange={setFFixedMargin} ariaLabel="الربح الثابت" />
                </div>
              )}
              {showPercent && (
                <div className="space-y-1">
                  <label className="text-sm font-medium">نسبة الربح ٪</label>
                  <MoneyInput value={fMarginPercent} onChange={setFMarginPercent} ariaLabel="نسبة الربح" />
                </div>
              )}
              <div className="space-y-1">
                <label className="text-sm font-medium">أقلّ هامش مقبول</label>
                <MoneyInput value={fMinimumMargin} onChange={setFMinimumMargin} ariaLabel="أقلّ هامش مقبول" />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">خطوة التقريب</label>
                <MoneyInput value={fRoundingStep} onChange={setFRoundingStep} ariaLabel="خطوة التقريب" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              السعر يُقرَّب لأعلى إلى مضاعف خطوة التقريب (٢٥٠ د.ع افتراضاً)، ويُرفض نشره إن نزل الهامش عن أقلّ هامش مقبول.
            </p>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={fRequiresStudent}
                onChange={(e) => setFRequiresStudent(e.target.checked)}
              />
              تتطلّب بيانات طالب عند البيع (اسم/هاتف الطالب وولي الأمر)
            </label>

            <div className="space-y-1">
              <span className="text-sm font-medium">الفروع التي تُعرض فيها</span>
              <div className="flex flex-wrap gap-3 rounded-md border p-3">
                {(branches.data ?? []).map((b) => (
                  <label key={b.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={fBranchIds.includes(b.id)}
                      onChange={() => toggleBranch(b.id)}
                    />
                    {b.name}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setFormOpen(false)}>إلغاء</Button>
            <Button size="sm" onClick={submitForm} disabled={saving}>
              {saving ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
