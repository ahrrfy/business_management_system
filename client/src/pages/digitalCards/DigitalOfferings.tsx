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

const selectCls =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm";

function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function DigitalOfferings() {
  const utils = trpc.useUtils();
  const list = trpc.digitalCards.offerings.list.useQuery();
  const providers = trpc.digitalCards.providers.list.useQuery();
  const branches = trpc.branches.list.useQuery();
  const wallets = trpc.digitalCards.wallets.list.useQuery({ isActive: true });
  const rows = list.data ?? [];
  const [query, setQuery] = useState("");
  const visibleRows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return q
      ? rows.filter((o) =>
          [
            o.productName,
            o.supplierName,
            OFFERING_TYPE[o.offeringType],
            PRICING_MODE[o.pricingMode],
          ].some((v) =>
            String(v ?? "")
              .toLocaleLowerCase("ar")
              .includes(q),
          ),
        )
      : rows;
  }, [rows, query]);

  const activeProviders = (providers.data ?? []).filter((p) => p.isActive);

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [fProviderId, setFProviderId] = useState("");
  const [fName, setFName] = useState("");
  const [fType, setFType] = useState<OfferingType>("TELECOM_CARD");
  const [fRequiresStudent, setFRequiresStudent] = useState(false);
  const [fSubscriptionDays, setFSubscriptionDays] = useState("");
  const [fFaceValue, setFFaceValue] = useState("");
  const [fPricingMode, setFPricingMode] = useState<PricingMode>("FIXED_MARGIN");
  const [fFixedMargin, setFFixedMargin] = useState("0");
  const [fMarginPercent, setFMarginPercent] = useState("0");
  const [fMinimumMargin, setFMinimumMargin] = useState("0");
  const [fRoundingStep, setFRoundingStep] = useState("250");
  const [fBranchIds, setFBranchIds] = useState<number[]>([]);
  const [fWalletByBranch, setFWalletByBranch] = useState<Record<number, string>>({});
  const [fInitialCost, setFInitialCost] = useState("");
  const [fInitialSellPrice, setFInitialSellPrice] = useState("");

  function invalidate() {
    void utils.digitalCards.offerings.list.invalidate();
  }

  const createMut = trpc.digitalCards.offerings.create.useMutation({
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      notify.ok("أُضيفت البطاقة", "لن تظهر في الكاشير قبل نشر سعر لها.");
    },
    onError: (e) => notify.err(e),
  });
  const updateMut = trpc.digitalCards.offerings.update.useMutation({
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      notify.ok("حُفظت التعديلات");
    },
    onError: (e) => notify.err(e),
  });
  const toggleMut = trpc.digitalCards.offerings.toggle.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => notify.err(e),
  });
  const initialPriceMut = trpc.digitalCards.pricing.saveDraft.useMutation({
    onError: (e) => notify.err(e),
  });

  const detail = trpc.digitalCards.offerings.get.useQuery(
    { id: editId ?? 0 },
    { enabled: formOpen && editId != null },
  );

  function openAdd() {
    setEditId(null);
    setFProviderId("");
    setFName("");
    setFType("TELECOM_CARD");
    setFRequiresStudent(false);
    setFSubscriptionDays("");
    setFFaceValue("");
    setFPricingMode("FIXED_MARGIN");
    setFFixedMargin("0");
    setFMarginPercent("0");
    setFMinimumMargin("0");
    setFRoundingStep("250");
    setFBranchIds([]);
    setFWalletByBranch({});
    setFInitialCost("");
    setFInitialSellPrice("");
    setFormOpen(true);
  }

  function openEdit(o: OfferingRow) {
    setEditId(o.id);
    setFProviderId(String(o.providerId));
    setFName(o.productName);
    setFType(o.offeringType);
    setFRequiresStudent(o.requiresStudentData);
    setFSubscriptionDays(o.subscriptionDurationDays != null ? String(o.subscriptionDurationDays) : "");
    setFFaceValue(o.faceValue ?? "");
    setFPricingMode(o.pricingMode);
    setFFixedMargin(o.fixedMargin);
    setFMarginPercent(o.marginPercent);
    setFMinimumMargin(o.minimumMargin);
    setFRoundingStep(o.roundingStep);
    // الفروع تصل من استعلام التفاصيل (get) لأن قائمة العرض لا تحملها.
    setFBranchIds([]);
    setFWalletByBranch({});
    setFormOpen(true);
  }

  // فروع البطاقة تصل من استعلام التفاصيل (قائمة العرض لا تحملها) ⇒ تُزامَن عند وصولها.
  const detailForId = detail.data?.id;
  useEffect(() => {
    if (editId != null && detailForId === editId) {
      setFBranchIds(detail.data?.branches.map((b) => b.branchId) ?? []);
      setFWalletByBranch(Object.fromEntries(
        (detail.data?.branches ?? []).map((b) => [b.branchId, b.walletId != null ? String(b.walletId) : ""]),
      ));
    }
  }, [editId, detailForId, detail.data]);

  function toggleBranch(id: number) {
    setFBranchIds((prev) => {
      if (!prev.includes(id)) return [...prev, id];
      setFWalletByBranch((walletsByBranch) => {
        const next = { ...walletsByBranch };
        delete next[id];
        return next;
      });
      return prev.filter((x) => x !== id);
    });
  }

  function submitForm() {
    const name = fName.trim();
    if (!name) return notify.err("اسم البطاقة مطلوب");
    if (fBranchIds.length === 0)
      return notify.err("اختر فرعاً واحداً على الأقل");

    const selectedProvider = (providers.data ?? []).find((p) => p.id === Number(fProviderId));
    if (selectedProvider?.settlementMode === "PREPAID") {
      const missingWalletBranch = fBranchIds.find((branchId) => !Number(fWalletByBranch[branchId]));
      if (missingWalletBranch != null) {
        const branchName = (branches.data ?? []).find((b) => b.id === missingWalletBranch)?.name;
        return notify.err(`اختر محفظة المزوّد لفرع ${branchName ?? missingWalletBranch}`);
      }
    }

    const shared = {
      name,
      offeringType: fType,
      requiresStudentData: fRequiresStudent,
      subscriptionDurationDays:
        fType === "EDUCATIONAL_SUBSCRIPTION"
          ? Number(fSubscriptionDays) || null
          : null,
      faceValue: fFaceValue.trim() || null,
      pricingMode: fPricingMode,
      fixedMargin: fFixedMargin || "0",
      marginPercent: fMarginPercent || "0",
      minimumMargin: fMinimumMargin || "0",
      roundingStep: fRoundingStep || "250",
      branches: fBranchIds.map((branchId) => ({
        branchId,
        walletId: selectedProvider?.settlementMode === "PREPAID"
          ? Number(fWalletByBranch[branchId])
          : null,
      })),
    };

    if (fType === "EDUCATIONAL_SUBSCRIPTION" && !Number(fSubscriptionDays)) {
      return notify.err("أدخِل مدة الاشتراك بالأيام لكي ينشئ النظام عقد التجديد تلقائياً");
    }
    if (editId != null) {
      updateMut.mutate({ id: editId, ...shared });
      return;
    }
    const providerId = Number(fProviderId);
    if (!providerId) return notify.err("اختر المزوّد");
    if (!fInitialCost.trim() || !fInitialSellPrice.trim()) {
      return notify.err("أدخل تكلفة الشراء وسعر البيع الأول للبطاقة");
    }
    createMut.mutate(
      { providerId, ...shared },
      {
        onSuccess: async (created) => {
          try {
            await Promise.all(
              fBranchIds.map((branchId) =>
                initialPriceMut.mutateAsync({
                  branchId,
                  providerId,
                  businessDate: todayYmd(),
                  lines: [
                    {
                      offeringId: created.offeringId,
                      providerShare: fInitialCost,
                      sellPrice: fInitialSellPrice,
                    },
                  ],
                }),
              ),
            );
            void utils.digitalCards.pricing.getMorningSheet.invalidate();
            notify.ok(
              "حُفظت البطاقة وأسعارها كمسوّدة",
              "راجعها ثم ثبّتها وانشرها من شاشة أسعار اليوم.",
            );
          } catch {
            // يظهر خطأ الحفظ من mutation؛ تبقى البطاقة صالحة للتسعير لاحقاً.
          }
        },
      },
    );
  }

  async function toggle(o: OfferingRow) {
    if (
      o.isActive &&
      !(await confirm({
        variant: "danger",
        title: "تعطيل البطاقة",
        description: `لن تظهر «${o.productName}» في شبكة بطاقات الكاشير. المبيعات السابقة وأسعارها التاريخية تبقى كما هي. متابعة؟`,
        confirmText: "تعطيل",
      }))
    )
      return;
    toggleMut.mutate({ id: o.id, isActive: !o.isActive });
  }

  const saving =
    createMut.isPending || updateMut.isPending || initialPriceMut.isPending;
  const editing = editId != null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="البطاقات والاشتراكات"
        description="عرّف البطاقة باسمها ومزوّدها وسعرها الأول. تحفظ التكلفة وسعر البيع كسجل يومي مستقل، ولا تظهر البطاقة للكاشير قبل تثبيت السعر ونشره."
        actions={
          <Button
            size="sm"
            onClick={openAdd}
            disabled={activeProviders.length === 0}
          >
            <Plus className="size-4" /> بطاقة جديدة
          </Button>
        }
      />

      {activeProviders.length === 0 && !providers.isLoading && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            لا مزوّدين مفعّلين — عرّف مزوّداً من تبويب المزوّدين قبل إضافة
            بطاقات.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <ListToolbar
            title="قائمة البطاقات"
            count={visibleRows.length}
            loading={list.isLoading}
            search={{
              value: query,
              onChange: setQuery,
              placeholder: "البطاقة، المزوّد، النوع أو قاعدة التسعير…",
            }}
            onResetFilters={() => setQuery("")}
            onRefresh={() => void list.refetch()}
            refreshing={list.isFetching}
            onPrint={() => window.print()}
            exportSpec={{
              filename: "البطاقات-والاشتراكات",
              rows: visibleRows,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "productName", header: "البطاقة" },
                { key: "supplierName", header: "المزوّد" },
                {
                  key: "offeringType",
                  header: "النوع",
                  map: (o) => OFFERING_TYPE[o.offeringType] ?? o.offeringType,
                },
                { key: "faceValue", header: "القيمة الاسمية", money: true },
                {
                  key: "pricingMode",
                  header: "قاعدة التسعير",
                  map: (o) => PRICING_MODE[o.pricingMode] ?? o.pricingMode,
                },
                { key: "minimumMargin", header: "أقل هامش", money: true },
                {
                  key: "isActive",
                  header: "الحالة",
                  map: (o) => (o.isActive ? "مفعّلة" : "معطّلة"),
                },
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
                  <tr
                    key={o.id}
                    className={`border-t ${o.isActive ? "" : "opacity-60"}`}
                  >
                    <td className="p-2 font-medium">{o.productName}</td>
                    <td className="p-2">{o.supplierName}</td>
                    <td className="p-2 text-muted-foreground">
                      {OFFERING_TYPE[o.offeringType] ?? o.offeringType}
                    </td>
                    <td className="p-2 tabular-nums">
                      {o.faceValue ? fmtAr(o.faceValue) : "—"}
                    </td>
                    <td className="p-2 text-muted-foreground">
                      {PRICING_MODE[o.pricingMode] ?? o.pricingMode}
                    </td>
                    <td className="p-2 tabular-nums">
                      {fmtAr(o.minimumMargin)}
                    </td>
                    <td className="p-2 text-center">
                      {o.requiresStudentData ? "نعم" : "لا"}
                    </td>
                    <td className="p-2 text-center">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs ${o.isActive ? "badge-status-active" : "badge-stock-out"}`}
                      >
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
                            gate: {
                              roles: ["manager"],
                              module: "digital_cards",
                              level: "FULL",
                            },
                          },
                          {
                            key: "toggle",
                            kind: "approve",
                            label: o.isActive ? "تعطيل" : "تفعيل",
                            variant: o.isActive ? "destructive" : "default",
                            disabled: toggleMut.isPending,
                            disabledReason: "توجد عملية تحديث قيد التنفيذ",
                            onSelect: () => void toggle(o),
                            gate: {
                              roles: ["manager"],
                              module: "digital_cards",
                              level: "FULL",
                            },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
                {list.isLoading && (
                  <tr>
                    <td colSpan={9}>
                      <LoadingState />
                    </td>
                  </tr>
                )}
                {!list.isLoading && visibleRows.length === 0 && (
                  <TableEmptyRow
                    colSpan={9}
                    message="لا بطاقات بعد — عرّف أوّل بطاقة لمزوّد مفعّل."
                  />
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
              أدخِل بيانات البطاقة الأساسية ثم تكلفة الشراء وسعر البيع الأول
              بعبارات واضحة. الربح والقيود والمحفظة تُرحّل تلقائياً في الخلفية.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="do-provider">
                  المزوّد
                </label>
                <select
                  id="do-provider"
                  className={selectCls}
                  value={fProviderId}
                  disabled={editing}
                  onChange={(e) => { setFProviderId(e.target.value); setFWalletByBranch({}); }}
                >
                  <option value="">— اختر المزوّد —</option>
                  {activeProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.supplierName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="do-type">
                  النوع
                </label>
                <select
                  id="do-type"
                  className={selectCls}
                  value={fType}
                  onChange={(e) => {
                    const type = e.target.value as OfferingType;
                    setFType(type);
                    if (type === "EDUCATIONAL_SUBSCRIPTION") {
                      setFRequiresStudent(true);
                    }
                  }}
                >
                  {Object.entries(OFFERING_TYPE).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">اسم البطاقة</label>
              <Input
                value={fName}
                onChange={(e) => setFName(e.target.value)}
                placeholder="كارت آسياسيل ١٠ آلاف"
                dir="auto"
                autoFocus
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">
                  القيمة الاسمية (اختياري)
                </label>
                <MoneyInput
                  value={fFaceValue}
                  onChange={setFFaceValue}
                  ariaLabel="القيمة الاسمية"
                />
                <p className="text-xs text-muted-foreground">
                  القيمة المطبوعة على الكرت — للعرض والتمييز فقط، لا تُسعّر بها.
                </p>
              </div>
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                الأسعار تُحدّد مباشرةً من حقلي التكلفة وسعر البيع أدناه، دون
                قواعد تسعير أو تقريب معقّدة.
              </div>
            </div>

            {!editing && (
              <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
                <div>
                  <p className="font-medium">سعر اليوم الأول</p>
                  <p className="text-xs text-muted-foreground">
                    يُحفظ كمسوّدة لكل فرع محدد أدناه، ثم تثبّته وتنشره من «أسعار
                    اليوم».
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-sm font-medium">
                      تكلفة الشراء علينا
                    </label>
                    <MoneyInput
                      value={fInitialCost}
                      onChange={setFInitialCost}
                      ariaLabel="تكلفة الشراء علينا"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium">
                      سعر البيع للعميل
                    </label>
                    <MoneyInput
                      value={fInitialSellPrice}
                      onChange={setFInitialSellPrice}
                      ariaLabel="سعر البيع للعميل"
                    />
                  </div>
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={fRequiresStudent}
                disabled={fType === "EDUCATIONAL_SUBSCRIPTION"}
                onChange={(e) => setFRequiresStudent(e.target.checked)}
              />
              تتطلّب بيانات طالب عند البيع (اسم/هاتف الطالب وولي الأمر)
            </label>

            {fType === "EDUCATIONAL_SUBSCRIPTION" && (
              <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                <label className="text-sm font-medium" htmlFor="do-subscription-days">
                  مدة الاشتراك بالأيام
                </label>
                <Input
                  id="do-subscription-days"
                  type="number"
                  min={1}
                  max={3650}
                  value={fSubscriptionDays}
                  onChange={(e) => setFSubscriptionDays(e.target.value)}
                  placeholder="مثال: 30"
                  dir="ltr"
                />
                <p className="text-xs text-muted-foreground">
                  عند إتمام البيع ينشئ النظام اشتراكاً يبدأ تلقائياً ويظهر تاريخ انتهائه وتجديداته.
                </p>
              </div>
            )}

            <div className="space-y-1">
              <span className="text-sm font-medium">
                الفروع التي تُعرض فيها
              </span>
              <div className="space-y-2 rounded-md border p-3">
                {(branches.data ?? []).map((b) => (
                  <div key={b.id} className="grid items-center gap-2 sm:grid-cols-[minmax(10rem,1fr)_minmax(14rem,2fr)]">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={fBranchIds.includes(b.id)}
                        onChange={() => toggleBranch(b.id)}
                      />
                      {b.name}
                    </label>
                    {fBranchIds.includes(b.id) && (providers.data ?? []).find((p) => p.id === Number(fProviderId))?.settlementMode === "PREPAID" && (
                      <select
                        className={selectCls}
                        aria-label={`محفظة ${b.name}`}
                        value={fWalletByBranch[b.id] ?? ""}
                        onChange={(e) => setFWalletByBranch((prev) => ({ ...prev, [b.id]: e.target.value }))}
                      >
                        <option value="">— اختر محفظة هذا الفرع —</option>
                        {(wallets.data ?? [])
                          .filter((w) => w.providerId === Number(fProviderId) && w.branchId === b.id && w.isActive)
                          .map((w) => <option key={w.id} value={w.id}>{w.name} — المتاح {fmtAr(String(Number(w.currentBalance) - Number(w.reservedBalance)))}</option>)}
                      </select>
                    )}
                  </div>
                ))}
              </div>
              {(providers.data ?? []).find((p) => p.id === Number(fProviderId))?.settlementMode === "PREPAID" && (
                <p className="text-xs text-muted-foreground">اختر محفظة المزوّد في كل فرع؛ منها يُحجز ويُخصم رصيد البيع تلقائياً.</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFormOpen(false)}
            >
              إلغاء
            </Button>
            <Button size="sm" onClick={submitForm} disabled={saving}>
              {saving ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
