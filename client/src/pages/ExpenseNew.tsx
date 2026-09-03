import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { InferredBranchField } from "@/components/form/InferredField";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  ProductSearchPicker,
  type PurchaseRow,
} from "@/components/production/ProductSearchPicker";
import { PageHeader } from "@/components/PageHeader";
import { confirm } from "@/lib/confirm";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  EXPENSE_BUCKET_LABEL,
  type ExpenseBucket,
} from "@shared/expenseCategories";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Landmark } from "lucide-react";
import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import {
  expenseApprovalExecutionText,
  expenseExecutionMode,
} from "./expenseUiPolicy";

/**
 * مصروف جديد — v3 add-screens.
 *
 * تصميم:
 *  - الحقول الأساسية (الفرع/الفئة/المبلغ/الدفع/التاريخ) — كما كانت.
 *  - حقول جديدة: جهة الصرف (payee)، مركز التكلفة (costCenter)، مصروف متكرّر (toggle + دورية).
 *  - المتكرّر للوصف فقط — لا يُولّد قيوداً مستقبليّة هنا (ميزة لاحقة).
 */

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// حُذفت قائمة الدلاء الثابتة: المنتقي صار يقرأ الفئات المُدارة (جدول expenseCategories)
// ويعرض دلوَها من `EXPENSE_BUCKET_LABEL` المشترك — نسخةٌ واحدة بدل أربع نسخٍ تنجرف.

const METHODS: { value: string; label: string }[] = [
  { value: "CASH", label: "نقدي" },
  { value: "CARD", label: "بطاقة" },
  { value: "TRANSFER", label: "تحويل" },
  { value: "WALLET", label: "محفظة" },
];

const COST_CENTERS = [
  "المبيعات",
  "الإدارة والتشغيل",
  "التسويق",
  "الصيانة",
  "عام",
];
const FREQS: { value: string; label: string }[] = [
  { value: "DAILY", label: "يومي" },
  { value: "WEEKLY", label: "أسبوعي" },
  { value: "MONTHLY", label: "شهري" },
  { value: "QUARTERLY", label: "ربع سنوي" },
  { value: "YEARLY", label: "سنوي" },
];

let _itemKey = 1;
type StockLine = {
  key: number;
  variantId: number;
  productName: string;
  sku: string;
  costPriceBase: string;
  stockBase: number;
  units: PurchaseRow[];
  productUnitId: number;
  conversionFactor: string;
  qty: string;
};
function mkStockLine(v: PurchaseRow, units: PurchaseRow[]): StockLine {
  return {
    key: _itemKey++,
    variantId: v.variantId,
    productName: v.productName,
    sku: v.sku,
    costPriceBase: String(v.costPriceBase ?? "0"),
    stockBase: Number(v.stockBase ?? 0),
    units: units.length ? units : [v],
    productUnitId: v.productUnitId,
    conversionFactor: String(v.conversionFactor ?? "1"),
    qty: "1",
  };
}
function baseQtyOf(l: StockLine) {
  return D(l.qty).times(D(l.conversionFactor));
}
function stockLineValid(l: StockLine): boolean {
  const b = baseQtyOf(l);
  return b.gt(0) && b.isInteger();
}

const SOURCE_TABS: {
  value: "CASH" | "INTERNAL_USE" | "WASTAGE";
  label: string;
  hint: string;
}[] = [
  { value: "CASH", label: "نقدي", hint: "صرف نقد من الصندوق" },
  {
    value: "INTERNAL_USE",
    label: "نثرية (من المخزون)",
    hint: "استهلاك منتج داخلياً ⇒ مصروف بالكلفة",
  },
  {
    value: "WASTAGE",
    label: "تلف (من المخزون)",
    hint: "منتج تالف ⇒ خسارة بالكلفة",
  },
];

export default function ExpenseNew() {
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();

  // الفرعُ مُستنتَجٌ من الجلسة عبر `<InferredBranchField>` أدناه: بدء الحالة `null` **مقصود**
  // — لا نختار فرعاً عن الشاشة قبل أن يصل استنتاجُ الخادم؛ نمطُ `?? 1` هو ما يحرسه
  // `check:branch` وهو ما نُخرج هذه الشاشةَ منه هنا.
  const [branchId, setBranchId] = useState<number | null>(null);
  // الفئة المُدارة (0203) هي ما يختاره المستخدم، والدلو المحاسبيّ يُشتقّ منها هنا وعلى الخادم
  // معاً — لا يُرسِل هذا النموذج دلواً يخالف الفئة أبداً.
  const expenseCategories = trpc.expenses.categories.list.useQuery({
    includeInactive: false,
  });
  const [expenseCategoryId, setExpenseCategoryId] = useState<number | "">("");
  const selectedCategory = (expenseCategories.data ?? []).find(
    (c) => c.id === expenseCategoryId,
  );
  const category = selectedCategory?.bucket ?? "OTHER";
  // أول فئة فعّالة تُنتقى تلقائياً كي لا يقف المستخدم أمام حقلٍ إلزاميّ فارغ.
  useEffect(() => {
    const first = (expenseCategories.data ?? [])[0];
    if (expenseCategoryId === "" && first) setExpenseCategoryId(first.id);
  }, [expenseCategories.data, expenseCategoryId]);
  // فئات مجمَّعة تحت دلوها — المستخدم يرى التصنيف الدقيق وأثره المحاسبيّ في آنٍ واحد.
  const categoryGroups = useMemo(() => {
    type CategoryRow = RouterOutputs["expenses"]["categories"]["list"][number];
    const groups = new Map<ExpenseBucket, CategoryRow[]>();
    for (const c of expenseCategories.data ?? []) {
      const list = groups.get(c.bucket) ?? [];
      list.push(c);
      groups.set(c.bucket, list);
    }
    return Array.from(groups.entries());
  }, [expenseCategories.data]);
  /** تبويبات الصرف من المخزون تُثبّت الدلو؛ ننتقي أول فئةٍ فعّالة تحته بدل ضبط الدلو مباشرةً. */
  function selectFirstCategoryOfBucket(target: ExpenseBucket) {
    const match = (expenseCategories.data ?? []).find((c) => c.bucket === target);
    if (match) setExpenseCategoryId(match.id);
  }
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [cashSource, setCashSource] = useState<"OWN_DRAWER" | "TREASURY">(
    "OWN_DRAWER",
  );
  const [expenseDate, setExpenseDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [description, setDescription] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [payee, setPayee] = useState("");
  const [costCenter, setCostCenter] = useState("الإدارة والتشغيل");
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringFrequency, setRecurringFrequency] = useState("MONTHLY");
  const [error, setError] = useState("");
  // idempotency: مفتاح ثابت للنموذج — يمنع ازدواج الصرف عند النقر المزدوج/إعادة الشبكة. يتجدّد بعد نجاح كل تسجيل.
  const [clientRequestId, setClientRequestId] = useState(() =>
    crypto.randomUUID(),
  );

  // production-slice: مصدر الصرف — نقدي أو صرف من المخزون (نثرية/تلف).
  const [source, setSource] = useState<"CASH" | "INTERNAL_USE" | "WASTAGE">(
    "CASH",
  );
  const isStock = source !== "CASH";
  const canCreateStockExpense =
    me.data?.role === "admin" || me.data?.role === "manager";
  const sourceTabs = canCreateStockExpense
    ? SOURCE_TABS
    : SOURCE_TABS.slice(0, 1);
  const [items, setItems] = useState<StockLine[]>([]);
  const itemsTotal = useMemo(
    () =>
      items.reduce(
        (acc, l) => acc.plus(round2(D(l.costPriceBase).times(baseQtyOf(l)))),
        D(0),
      ),
    [items],
  );

  // ⛔ لا `?? 1` هنا: قبل استنتاج الفرعِ من الجلسة، القيمةُ `null` وتقف الاستعلاماتُ التي
  //    تحتاجها. `<InferredBranchField>` أدناه يُسند `branchId` أوّل ما يصل الاستنتاج.
  const effectiveBranch: number | null = branchId;
  const openShift = trpc.shifts.current.useQuery(
    { branchId: effectiveBranch ?? 0 },
    { enabled: effectiveBranch != null },
  );
  const executionMode = expenseExecutionMode({
    source,
    amount,
    paymentMethod,
    cashSource,
  });

  // مصدر النقد قرار صريح. عند غياب وردية للفاعل لا نترك اختيار درج غير صالح معلّقاً.
  useEffect(() => {
    if (!openShift.isLoading && !openShift.data) setCashSource("TREASURY");
  }, [effectiveBranch, openShift.data, openShift.isLoading]);

  const create = trpc.expenses.create.useMutation({
    onSuccess: async (result) => {
      setClientRequestId(crypto.randomUUID());
      await utils.expenses.list.invalidate();
      notify.ok(
        "status" in result && result.status === "PENDING_APPROVAL"
          ? "تم رفع طلب المصروف للمالك بلا صرف مالي حتى الاعتماد"
          : "تم تسجيل المصروف وتنفيذه",
      );
      navigate("/expenses");
    },
    onError: (e) => {
      setError(e.message);
      notify.err(e);
    },
  });

  async function submit() {
    setError("");
    if (effectiveBranch == null || effectiveBranch <= 0) {
      return setError(
        "لا فرعَ نشط · لم تصل جلستُك بعد أو حسابك بلا فرعٍ مُسنَد · انتظر إتمام التحميل أو راجع المدير.",
      );
    }
    if (expenseCategoryId === "") {
      document.getElementById("expense-category")?.focus();
      return setError(
        (expenseCategories.data ?? []).length === 0
          ? "لا فئات مصروفات مهيأة — استعِدها من «الخزينة ← فئات المصروفات»."
          : "اختر فئة المصروف.",
      );
    }

    // production-slice: صرف من المخزون (نثرية/تلف) — يُخصَم بالكلفة بلا صندوق.
    if (isStock) {
      if (items.length === 0) return setError("أضِف منتجاً واحداً على الأقل.");
      for (const l of items)
        if (!stockLineValid(l))
          return setError(
            `كمية «${l.productName}» يجب أن تُنتج عدداً صحيحاً موجباً.`,
          );
      const ok = await confirm({
        variant: "danger",
        title:
          source === "WASTAGE"
            ? "تسجيل تلف من المخزون"
            : "تسجيل نثرية من المخزون",
        description: `سيُخصَم ${items.length} منتج من المخزون ويُسجَّل ${source === "WASTAGE" ? "خسارةً" : "مصروفاً"} بقيمة ${fmt(itemsTotal.toString())} د.ع (لا يلمس الصندوق النقدي). متابعة؟`,
        confirmText: source === "WASTAGE" ? "تسجيل التلف" : "تسجيل النثرية",
      });
      if (!ok) return;
      create.mutate({
        branchId: Number(effectiveBranch),
        expenseDate: expenseDate || undefined,
        category: category as any,
        expenseCategoryId: Number(expenseCategoryId),
        amount: "0",
        paymentMethod: "CASH",
        source: "STOCK",
        stockReason: source,
        items: items.map((l) => ({
          variantId: l.variantId,
          productUnitId: l.productUnitId,
          quantity: D(l.qty).toFixed(4),
        })),
        description: description.trim() || null,
        clientRequestId,
      });
      return;
    }

    // نقدي (CASH).
    if (!amount.trim() || D(amount).lte(0)) {
      document.getElementById("expense-amount")?.focus();
      return setError("المبلغ مطلوب وموجب.");
    }
    if (category === "OTHER" && !description.trim())
      return setError("وصف المصروف مطلوب لفئة «أخرى».");

    if (executionMode === "DRAWER_IMMEDIATE" && !openShift.data) {
      return setError(
        "النثرية النقدية الصغيرة تُصرف من درج ورديتك فقط. افتح وردية ممولة أو حوّلها إلى طلب اعتماد خزينة.",
      );
    }
    if (executionMode === "PENDING_OWNER_APPROVAL") {
      const ok = await confirm({
        variant: "warning",
        title: "رفع طلب اعتماد مصروف",
        description: `سيُحفظ طلب ${fmt(D(amount).toFixed(2))} د.ع بلا أي خصم أو قيد مالي. يستطيع مالك نشط آخر فقط اعتماده. ${expenseApprovalExecutionText(paymentMethod)}`,
        confirmText: "رفع طلب الاعتماد",
      });
      if (!ok) return;
    }

    create.mutate({
      branchId: Number(effectiveBranch),
      shiftId:
        executionMode === "DRAWER_IMMEDIATE" && openShift.data?.id
          ? Number(openShift.data.id)
          : null,
      cashSource: paymentMethod === "CASH" ? cashSource : null,
      expenseDate: expenseDate || undefined,
      category: category as any,
      expenseCategoryId: Number(expenseCategoryId),
      amount: D(amount).toFixed(2),
      paymentMethod: paymentMethod as any,
      description: description.trim() || null,
      referenceNumber: referenceNumber.trim() || null,
      payee: payee.trim() || null,
      costCenter: costCenter || null,
      isRecurring,
      recurringFrequency: isRecurring ? (recurringFrequency as any) : null,
      clientRequestId,
    });
  }

  // اختصار Ctrl+S للحفظ (Esc متروك عمداً — النموذج مكتظّ بقوائم اختيار أصلية يُغلقها Esc)،
  // وحارس فقدان البيانات عند وجود إدخال فعليّ فقط (تجنّب تحذير كاذب).
  useSaveShortcuts({ onSave: submit, enabled: !create.isPending });
  useUnsavedGuard(
    amount.trim() !== "" ||
      description.trim() !== "" ||
      payee.trim() !== "" ||
      referenceNumber.trim() !== "" ||
      items.length > 0,
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="مصروف جديد"
        backHref="/expenses"
        backLabel="رجوع للمصروفات"
      />

      {/* مصدر الصرف: نقدي أو صرف من المخزون (نثرية/تلف) */}
      <Card>
        <CardContent className="pt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {sourceTabs.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => {
                  setSource(t.value);
                  setError("");
                  if (t.value === "INTERNAL_USE") selectFirstCategoryOfBucket("SUPPLIES");
                  if (t.value === "WASTAGE") selectFirstCategoryOfBucket("OTHER");
                }}
                className={cn(
                  "rounded-full px-4 py-1.5 text-sm border transition",
                  source === t.value
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-transparent hover:bg-accent",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {sourceTabs.find((t) => t.value === source)?.hint}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">بيانات المصروف</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
          <div className="space-y-1 md:col-span-2 lg:col-span-1">
            {/* الفرعُ استنتاجٌ خادميّ لا سؤالٌ للشاشة — `<InferredBranchField>` يعرض «فرعُك
                المُسنَد» ويكشف زرَّ «تغيير» للأدمن/المالك فقط، ولا يقع على «الفرع ١» صامتاً
                (حارس `check:branch`). التسمية العارية «الفرع *» تُبقي التوقّع البصريّ للمستخدم. */}
            <InferredBranchField
              label="الفرع *"
              value={branchId}
              onChange={(next) => setBranchId(next)}
              disabled={create.isPending}
            />
            {(() => {
              if (openShift.data) {
                return (
                  <p className="text-xs text-money-positive">
                    لديك وردية مفتوحة #{Number(openShift.data.id)} — المصروف
                    النقدي دون 500,000 د.ع يمكن تنفيذه فوراً من درجها.
                  </p>
                );
              }
              if (!isStock && paymentMethod === "CASH") {
                return (
                  <p className="inline-flex items-center gap-1 text-xs text-[var(--status-pending)]">
                    <Landmark aria-hidden className="size-4" />
                    <span>
                      لا وردية مفتوحة؛ اختر «طلب اعتماد الخزينة» ليُحفظ الطلب
                      بلا صرف، أو{" "}
                      <Link href="/shifts" className="underline">
                        افتح وردية
                      </Link>
                      .
                    </span>
                  </p>
                );
              }
              return (
                <p className="text-xs text-muted-foreground">
                  الطريقة غير النقدية تُرفع لاعتماد المالك ولا تمس درج الوردية
                  أو الخزينة النقدية.
                </p>
              );
            })()}
          </div>
          <div className="space-y-1">
            <Label>التاريخ *</Label>
            <Input
              type="date"
              dir="ltr"
              value={expenseDate}
              onChange={(e) => setExpenseDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="expense-category">الفئة *</Label>
            <AppSelect
              id="expense-category"
              className="h-9"
              value={expenseCategoryId === "" ? "" : String(expenseCategoryId)}
              onValueChange={(value) =>
                setExpenseCategoryId(
                  value === "" ? "" : Number(value),
                )
              }
            >
              <option value="">— اختر فئة المصروف —</option>
              {categoryGroups.map(([groupBucket, groupRows]) => (
                <optgroup key={groupBucket} label={EXPENSE_BUCKET_LABEL[groupBucket]}>
                  {groupRows.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </AppSelect>
            <p className="text-[11px] text-muted-foreground">
              {selectedCategory
                ? `الحساب المحاسبي: ${EXPENSE_BUCKET_LABEL[selectedCategory.bucket]}`
                : "الفئة تحدّد الحساب المحاسبي الذي يهبط فيه المصروف."}{" "}
              <Link href="/treasury?tab=expense-categories" className="underline">
                إدارة الفئات
              </Link>
            </p>
          </div>
          {!isStock && (
            <>
              <div className="space-y-1">
                <Label>طريقة الدفع *</Label>
                <AppSelect
                  className="h-9"
                  value={paymentMethod}
                  onValueChange={(value) => setPaymentMethod(value)}
                >
                  {METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </AppSelect>
              </div>
              {paymentMethod === "CASH" && (
                <div className="space-y-2 md:col-span-2 lg:col-span-3">
                  <Label>مصدر النقد *</Label>
                  <div
                    className="grid gap-2 md:grid-cols-2"
                    role="radiogroup"
                    aria-label="مصدر النقد للمصروف"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={cashSource === "OWN_DRAWER"}
                      disabled={!openShift.data}
                      onClick={() => setCashSource("OWN_DRAWER")}
                      className={cn(
                        "rounded-xl border p-3 text-start transition",
                        cashSource === "OWN_DRAWER"
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "hover:bg-muted/50",
                        !openShift.data && "cursor-not-allowed opacity-50",
                      )}
                    >
                      <span className="block text-sm font-bold">
                        درج ورديتي
                        {openShift.data ? ` #${Number(openShift.data.id)}` : ""}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        يظهر المصروف في معادلة إغلاق ورديتك ويُنقص النقد المتوقع
                        فيها.
                      </span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={cashSource === "TREASURY"}
                      onClick={() => setCashSource("TREASURY")}
                      className={cn(
                        "rounded-xl border p-3 text-start transition",
                        cashSource === "TREASURY"
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "hover:bg-muted/50",
                      )}
                    >
                      <span className="inline-flex items-center gap-1.5 text-sm font-bold">
                        <Landmark aria-hidden className="size-4" /> طلب اعتماد
                        الخزينة
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        يُحفظ بلا صرف أو قيد، ثم ينفذه مالك آخر من خزينة الفرع
                        عند الاعتماد.
                      </span>
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    مسجّل العملية:{" "}
                    <strong className="text-foreground">
                      {me.data?.name ?? `مستخدم #${me.data?.id ?? "—"}`}
                    </strong>
                    . المنشئ لا يستطيع اعتماد طلبه بنفسه.
                  </p>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="expense-amount">المبلغ *</Label>
                <MoneyInput
                  id="expense-amount"
                  value={amount}
                  onChange={setAmount}
                  placeholder="0"
                />
                <p className="text-[11px] text-muted-foreground">
                  النقدي فقط دون 500,000 د.ع من درج ورديتك يُنفذ فوراً؛ الحد وما
                  فوقه وجميع الطرق غير النقدية تتحول إلى طلب اعتماد المالك.
                </p>
              </div>
            </>
          )}
          <div className="space-y-1">
            <Label>رقم مرجعي (اختياري)</Label>
            <Input
              dir="ltr"
              value={referenceNumber}
              onChange={(e) => setReferenceNumber(e.target.value)}
              placeholder="فاتورة/إيصال"
            />
          </div>
          <div className="space-y-1 md:col-span-2 lg:col-span-3">
            <Label>الوصف{category === "OTHER" ? " *" : " (اختياري)"}</Label>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="تفصيل المصروف…"
            />
          </div>
        </CardContent>
      </Card>

      {/* منتجات الصرف من المخزون (نثرية/تلف) */}
      {isStock && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              المنتجات المُستهلَكة من المخزون
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ProductSearchPicker
              branchId={Number(effectiveBranch)}
              placeholder="ابحث عن منتج…"
              onPick={(v, u) => setItems((p) => [...p, mkStockLine(v, u)])}
            />
            {items.map((l) => {
              const base = baseQtyOf(l);
              const valid = stockLineValid(l);
              const over = base.gt(l.stockBase);
              return (
                <div
                  key={l.key}
                  className="grid grid-cols-12 gap-2 items-center border rounded-md p-2"
                >
                  <div className="col-span-4">
                    <div className="font-medium text-sm">{l.productName}</div>
                    <div
                      className="text-xs text-muted-foreground font-mono"
                      dir="ltr"
                    >
                      {l.sku}
                    </div>
                  </div>
                  <div className="col-span-3">
                    <AppSelect
                      className="h-9"
                      value={String(l.productUnitId)}
                      onValueChange={(value) => {
                        const u = l.units.find(
                          (x) => x.productUnitId === Number(value),
                        );
                        setItems((p) =>
                          p.map((x) =>
                            x.key === l.key
                              ? {
                                  ...x,
                                  productUnitId: Number(value),
                                  conversionFactor: String(
                                    u?.conversionFactor ?? "1",
                                  ),
                                }
                              : x,
                          ),
                        );
                      }}
                    >
                      {l.units.map((u) => (
                        <option key={u.productUnitId} value={u.productUnitId}>
                          {u.unitName}
                          {u.isBaseUnit
                            ? " (أساس)"
                            : ` × ${u.conversionFactor}`}
                        </option>
                      ))}
                    </AppSelect>
                  </div>
                  <div className="col-span-2">
                    <Input
                      dir="ltr"
                      value={l.qty}
                      onChange={(e) =>
                        setItems((p) =>
                          p.map((x) =>
                            x.key === l.key ? { ...x, qty: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </div>
                  <div
                    className="col-span-2 text-left text-sm tabular-nums"
                    dir="ltr"
                  >
                    {fmt(round2(D(l.costPriceBase).times(base)).toString())}
                  </div>
                  <div className="col-span-1 text-left">
                    <button
                      type="button"
                      className="text-destructive text-sm"
                      onClick={() =>
                        setItems((p) => p.filter((x) => x.key !== l.key))
                      }
                    >
                      حذف
                    </button>
                  </div>
                  {!valid && (
                    <div className="col-span-12 text-xs text-destructive">
                      الكمية يجب أن تُنتج عدداً صحيحاً موجباً.
                    </div>
                  )}
                  {over && (
                    <div className="col-span-12 text-xs text-stock-low">
                      المتاح {Number(l.stockBase).toLocaleString("en-US")} فقط —
                      سيُرفض إن لم يكفِ.
                    </div>
                  )}
                </div>
              );
            })}
            {items.length === 0 && (
              <p className="text-xs text-muted-foreground">
                لم تُضف منتجات بعد.
              </p>
            )}
            <div className="flex justify-end text-sm">
              <span className="text-muted-foreground">
                سيُسجَّل {source === "WASTAGE" ? "خسارةً" : "مصروفاً"}:&nbsp;
              </span>
              <span
                className="font-bold text-money-negative tabular-nums"
                dir="ltr"
              >
                {fmt(itemsTotal.toString())}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {!isStock && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                جهة الصرف ومركز التكلفة
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="payee">جهة الصرف</Label>
                <Input
                  id="payee"
                  value={payee}
                  onChange={(e) => setPayee(e.target.value)}
                  placeholder="مثال: شركة الكهرباء، صاحب العقار"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cc">مركز التكلفة</Label>
                <AppSelect
                  id="cc"
                  className="h-9"
                  value={costCenter}
                  onValueChange={(value) => setCostCenter(value)}
                >
                  {COST_CENTERS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </AppSelect>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">مصروف متكرّر</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3">
                <Switch
                  checked={isRecurring}
                  onCheckedChange={setIsRecurring}
                  id="recurring"
                />
                <Label htmlFor="recurring" className="cursor-pointer">
                  {isRecurring ? "نعم — مصروف متكرّر" : "لا — مرة واحدة"}
                </Label>
              </div>
              <div
                className={cn(
                  "grid grid-cols-1 md:grid-cols-2 gap-4 transition-opacity",
                  isRecurring
                    ? "opacity-100"
                    : "opacity-50 pointer-events-none",
                )}
              >
                <div className="space-y-1">
                  <Label htmlFor="freq">الدورية</Label>
                  <AppSelect
                    id="freq"
                    className="h-9"
                    value={recurringFrequency}
                    onValueChange={(value) => setRecurringFrequency(value)}
                  >
                    {FREQS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </AppSelect>
                  <p className="text-[11px] text-muted-foreground">
                    للتوثيق الآن — الإصدارات المستقبلية ستولّد قيوداً تلقائياً.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {(() => {
        const cashNeedsShift =
          !isStock &&
          executionMode === "DRAWER_IMMEDIATE" &&
          !openShift.data &&
          !openShift.isLoading;
        return (
          <div className="flex gap-2">
            <Button
              onClick={submit}
              disabled={create.isPending || cashNeedsShift}
              title={
                cashNeedsShift
                  ? "الصرف النقدي الصغير يتطلب وردية المنشئ"
                  : undefined
              }
            >
              {create.isPending
                ? ACTION_LABELS.saving
                : executionMode === "PENDING_OWNER_APPROVAL"
                  ? "رفع طلب الاعتماد"
                  : "حفظ وتنفيذ المصروف"}
            </Button>
            <Link href="/expenses">
              <Button variant="outline">إلغاء</Button>
            </Link>
          </div>
        );
      })()}
    </div>
  );
}
