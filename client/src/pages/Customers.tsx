import { CopyInline } from "@/components/CopyButton";
import { FILTER_LABELS } from "@shared/uiContracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BalanceCell } from "@/components/BalanceBadge";
import { ImportDialog } from "@/components/import/ImportDialog";
import { FilterField, ListToolbar, RowActions } from "@/components/list";
import { SelectionBar, useRowSelection } from "@/components/list/SelectionBar";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { useFocusHighlight } from "@/components/search/useFocusHighlight";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { OperationsSummary } from "@/components/operations/OperationsSummary";
import { CustomerFollowUpDialog, type FollowUpValue } from "@/components/customers/CustomerFollowUpDialog";
import { Badge } from "@/components/ui/badge";
import { useClipboard } from "@/hooks/useClipboard";
import { confirm } from "@/lib/confirm";
import { formatCustomerCard, formatTableAsTSV } from "@/lib/copy/formatters";
import { CUSTOMER_FIELDS, CUSTOMER_IMPORT_META } from "@/lib/importFields";
import type { CustomerImportRow } from "@/lib/importTypes";
import { fmtAr as fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { buildOperationalContactMessage } from "@/lib/whatsapp";
import { selectClsSm } from "@/lib/ui/formStyles";

// صفّ نتيجة البحث — صريح لأنّ الإجراء يُعيد اتحاداً (تقنيع التكلفة) يُفشل استدلال T في fetchAllPaged.
type CustomerRow = RouterOutputs["customers"]["search"]["rows"][number];
type OperationsRow = RouterOutputs["customers"]["operations"]["rows"][number];
type DisplayRow = CustomerRow | OperationsRow;

const TYPE_OPTIONS = ["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"] as const;
const TIER_LABEL: Record<string, string> = {
  RETAIL: "مفرد",
  WHOLESALE: "جملة",
  GOVERNMENT: "حكومي",
};


const COLLECTION_STATUS: Record<string, { label: string; variant: "neutral" | "success" | "danger" | "warning" | "info" | "secondary" }> = {
  CREDIT: { label: "رصيد دائن", variant: "success" },
  CLEAR: { label: "مسوّى", variant: "neutral" },
  OVER_LIMIT: { label: "تجاوز الحد", variant: "danger" },
  PROMISE_BROKEN: { label: "أخلف الوعد", variant: "danger" },
  PROMISE_DUE: { label: "وعد اليوم", variant: "warning" },
  PROMISE_FUTURE: { label: "وعد قادم", variant: "secondary" },
  SEVERELY_OVERDUE: { label: "متأخر بشدة", variant: "danger" },
  OVERDUE: { label: "متأخر", variant: "warning" },
  DUE_SOON: { label: "يستحق قريباً", variant: "info" },
  REGULAR: { label: "منتظم", variant: "success" },
};

function isOperationsRow(row: DisplayRow): row is OperationsRow {
  return "collectionStatus" in row;
}

/** الرقم القديم (legacyCode) من صف القائمة — null إن فارغاً (العمود يظهر فقط حين توجد قيم).
 *  select القائمة في customerService يعيده ويُدخله البحث (شريحة تكامل الاستيراد). */
function legacyCodeOf(r: { legacyCode?: string | null }): string | null {
  const v = r.legacyCode;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export default function Customers() {
  const utils = trpc.useUtils();
  // للكاشير يُحجب سقف الائتمان خادمياً (maskCustomerSensitive ⇒ null) — فـnull عنده ليس «بلا حدّ»
  // بل «مخفي»؛ لذا لا نعرض «بلا حدّ» إلا للمدير/الإدمن حيث null=ائتمان غير محدود فعلاً.
  const me = trpc.auth.me.useQuery();
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";
  const canCreateTasks = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? null) as PermissionMap | null,
    "tasks",
    "FULL",
    ["cashier", "manager", "sales_rep", "print_operator"],
  );
  // ٢٤/٨ (Codex P2 على PR #744): كشف الحساب تحت `reports=READ` — البقيّة يُعاد توجيهها بلا نتيجة.
  const canOpenStatement = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? null) as PermissionMap | null,
    "reports",
    "READ",
    ["admin", "manager", "accountant", "auditor"],
  );
  // فلاتر الشاشة محفوظة في الرابط (useUrlFilters) — تعيش مع فتح التفاصيل والرجوع، وقابلة للمشاركة.
  // كل القيم نصوص (اتفاقية useUrlFilters)؛ نشتقّ الأنواع الفعلية أدناه ونُعرّف مُغلِّفات setters
  // بتوقيع مطابق لِـuseState القديم كي تبقى كل مواقع الاستدعاء أدناه بلا تغيير.
  const [f, setF, resetAllFilters] = useUrlFilters({
    q: "",
    type: "",
    tier: "",
    city: "",
    inactive: "",
    balance: "",
    collection: "",
    credit: "",
    inactivity: "",
    sort: "NAME",
    page: "0",
  });
  const q = f.q;
  const customerType = f.type as "" | (typeof TYPE_OPTIONS)[number];
  const priceTier = f.tier as "" | "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  const city = f.city;
  const includeInactive = f.inactive === "1";
  const balanceFilter = f.balance as "" | "RECEIVABLE" | "CREDIT" | "ZERO";
  const collectionFilter = f.collection as "" | "OVERDUE" | "PROMISE_DUE" | "PROMISE_FUTURE" | "NO_FOLLOWUP";
  const creditFilter = f.credit as "" | "CASH_ONLY" | "NEAR_LIMIT" | "OVER_LIMIT" | "UNLIMITED";
  const inactivityDays = (f.inactivity ? Number(f.inactivity) : "") as "" | 30 | 60 | 90;
  const sort = f.sort as "NAME" | "BALANCE_DESC" | "OLDEST_DUE" | "LAST_PURCHASE";
  const page = Number(f.page) || 0;
  function setQ(v: string) { setF({ q: v }); }
  function setCustomerType(v: string) { setF({ type: v }); }
  function setPriceTier(v: string) { setF({ tier: v }); }
  function setCity(v: string) { setF({ city: v }); }
  function setIncludeInactive(v: boolean) { setF({ inactive: v ? "1" : "" }); }
  function setBalanceFilter(v: string) { setF({ balance: v }); }
  function setCollectionFilter(v: string) { setF({ collection: v }); }
  function setCreditFilter(v: string) { setF({ credit: v }); }
  function setInactivityDays(v: number | "") { setF({ inactivity: v ? String(v) : "" }); }
  function setSort(v: string) { setF({ sort: v }); }
  function setPage(updater: number | ((p: number) => number)) {
    const next = typeof updater === "function" ? updater(page) : updater;
    setF({ page: String(Math.max(0, next)) });
  }
  const hasAnyFilter = !!(
    q || customerType || priceTier || city || includeInactive ||
    balanceFilter || collectionFilter || creditFilter || inactivityDays || sort !== "NAME"
  );

  const [importOpen, setImportOpen] = useState(false);
  const [followTarget, setFollowTarget] = useState<DisplayRow | null>(null);
  const importMut = trpc.imports.customers.useMutation();
  const limit = 50;

  // فرع مهام المتابعة (follow-up): الأدمن/المدير بلا فرع مُسنَد يختار الفرع صراحةً بدل التثبيت
  // الصامت على الفرع ١ (نمط PR #288 محظور — §٤ ق١١). لا يمسّ مستخدماً له فرع (يبقى فرعه).
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const needsBranchChoice = isElevated && me.data != null && me.data.branchId == null;
  const branchesQ = trpc.branches.list.useQuery(undefined, { enabled: needsBranchChoice });
  const effectiveFollowUpBranchId = me.data?.branchId != null ? Number(me.data.branchId) : pickedBranch;

  // الميل الأخير للبحث الشامل: عند الوصول بـ?q=&focus= نبذر البحث (يُحمِّل العميل) ثمّ نُبرز صفّه.
  const { seedQuery, rowProps } = useFocusHighlight();
  useEffect(() => {
    if (seedQuery) { setQ(seedQuery); setPage(0); }
  }, [seedQuery]);

  const input = useMemo(
    () => ({
      q: q.trim() || undefined,
      customerType: customerType || undefined,
      priceTier: priceTier || undefined,
      // city مدعومة في customers.search فقط — للمستخدم غير المرتفع (basicList أدناه). تُتجاهَل
      // خادمياً في customers.operations (لا تكسر شيئاً)، فنُخفي عنصر الواجهة المقابل للمرتفعين.
      city: city.trim() || undefined,
      includeInactive,
      limit,
      offset: page * limit,
    }),
    [q, customerType, priceTier, city, includeInactive, page],
  );

  const operationsInput = useMemo(
    () => ({
      ...input,
      balance: balanceFilter || undefined,
      collection: collectionFilter || undefined,
      credit: creditFilter || undefined,
      inactivityDays: inactivityDays || undefined,
      sort,
    }),
    [input, balanceFilter, collectionFilter, creditFilter, inactivityDays, sort],
  );
  const basicList = trpc.customers.search.useQuery(input, { enabled: !isElevated });
  const operations = trpc.customers.operations.useQuery(operationsInput, { enabled: isElevated });
  const list = isElevated ? operations : basicList;
  const invalidateCustomers = () => {
    void utils.customers.search.invalidate();
    void utils.customers.list.invalidate();
    void utils.customers.operations.invalidate();
  };
  const deactivate = trpc.customers.deactivate.useMutation({
    onSuccess: () => {
      invalidateCustomers();
      notify.ok("تم تعطيل العميل");
    },
    onError: (e) => notify.err(e),
  });
  const activate = trpc.customers.activate.useMutation({
    onSuccess: () => {
      invalidateCustomers();
      notify.ok("تم تفعيل العميل");
    },
    onError: (e) => notify.err(e),
  });
  // الحذف النهائيّ: customers.delete = managerProcedure (أدمن/مدير) — لتنظيف أخطاء الإدخال الأوّليّ،
  // والحارس الخادميّ يرفض أيّ عميلٍ له نشاط (فواتير/أوامر شغل/…) فيوجّه للتعطيل.
  const del = trpc.customers.delete.useMutation({
    onSuccess: () => {
      invalidateCustomers();
      notify.ok("تم حذف العميل نهائياً");
    },
    onError: (e) => notify.err(e),
  });
  const createNote = trpc.customerNotes.create.useMutation();
  const createTask = trpc.tasks.create.useMutation();

  const total = list.data?.total ?? 0;
  const rows = (list.data?.rows ?? []) as DisplayRow[];
  const summary = operations.data?.summary;
  const pages = Math.max(1, Math.ceil(total / limit));
  // عمود «الرقم القديم» يظهر فقط إن وُجدت قيم فعلية في الصفحة الحالية (مخفيّ إن فارغ).
  const hasLegacy = rows.some((r) => legacyCodeOf(r) !== null);

  // التحديد المُتعدِّد + النسخ الجماعي — TSV للصق في Excel، وملخّص واتساب لقائمة العملاء.
  const sel = useRowSelection<number>();
  const { copy } = useClipboard({ successMessage: null });
  const pageIds = useMemo(() => rows.map((r) => Number(r.id)), [rows]);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => sel.isSelected(id));
  const someOnPageSelected = pageIds.some((id) => sel.isSelected(id));
  const selectedRows = useMemo(
    () => rows.filter((r) => sel.isSelected(Number(r.id))),
    [rows, sel],
  );

  async function copySelectedAsTSV() {
    if (selectedRows.length === 0) return;
    // أعمدة مُطابِقة لعرض الجدول — تَنسيق Excel-friendly.
    const headers = [
      "الاسم",
      "الرقم القديم",
      "النوع",
      "الهاتف",
      "المدينة/المنطقة",
      "فئة السعر",
      "سقف الائتمان",
      "الرصيد الحالي",
      "نشط",
    ];
    const tsvRows = selectedRows.map((r) => ({
      "الاسم": r.name ?? "",
      "الرقم القديم": legacyCodeOf(r) ?? "",
      "النوع": r.customerType ?? "",
      "الهاتف": r.phone ?? "",
      "المدينة/المنطقة": [r.city, r.district].filter(Boolean).join(" / "),
      "فئة السعر": TIER_LABEL[r.defaultPriceTier] ?? r.defaultPriceTier ?? "",
      // للمدير null=«بلا حدّ» (لا يُعرَض كصفر)؛ للكاشير null=محجوب فيبقى كالسابق.
      "سقف الائتمان": isElevated && r.creditLimit == null ? "بلا حدّ" : Number(r.creditLimit ?? 0),
      "الرصيد الحالي": Number(r.currentBalance ?? 0),
      "نشط": r.isActive ? "نعم" : "لا",
    }));
    const text = formatTableAsTSV(headers, tsvRows);
    const ok = await copy(text);
    if (ok) notify.ok(`تم نسخ ${selectedRows.length} عميلاً كَـTSV (الصق في Excel)`);
  }

  async function copySelectedAsWhatsAppSummary() {
    if (selectedRows.length === 0) return;
    // ملخّص قائمة: بطاقة لكل عميل مفصولة بسطر فارغ — قابلة للّصق في واتساب.
    const cards = selectedRows.map((r) =>
      formatCustomerCard({
        name: r.name ?? "",
        phone: r.phone,
        balance: r.currentBalance,
        legacyCode: legacyCodeOf(r),
      }),
    );
    const text = `قائمة العملاء (${selectedRows.length})\n\n${cards.join("\n\n")}`;
    const ok = await copy(text);
    if (ok) notify.ok(`تم نسخ ملخّص ${selectedRows.length} عميلاً لواتساب`);
  }

  function printSelectedCollectionList() {
    if (selectedRows.length === 0) return;
    const totalBalance = selectedRows.reduce((sum, row) => sum + Math.max(0, Number(row.currentBalance ?? 0)), 0);
    const opened = printReportDoc({
      title: "قائمة متابعة التحصيل",
      headerExtra: [
        { label: "عدد العملاء", value: String(selectedRows.length) },
        { label: "النطاق", value: "المحدد من شاشة العملاء" },
      ],
      note: "قائمة تشغيلية للمتابعة؛ الرصيد الحالي لا يساوي المتأخرات إلا بعد الرجوع إلى تاريخ استحقاق الفواتير.",
      columns: [
        { key: "name", label: "العميل" },
        { key: "phone", label: "الهاتف" },
        { key: "balance", label: "الرصيد", align: "left" },
        { key: "status", label: "حالة التحصيل" },
      ],
      rows: selectedRows.map((row) => ({
        name: row.name ?? "—",
        phone: row.phone ?? "—",
        balance: `${fmt(row.currentBalance)} د.ع`,
        status: isOperationsRow(row) ? (COLLECTION_STATUS[row.collectionStatus]?.label ?? row.collectionStatus) : "—",
      })),
      summary: [{ label: "إجمالي المطلوب متابعته", value: `${fmt(totalBalance)} د.ع`, bold: true, large: true }],
    });
    if (!opened) notify.err("حجب المتصفح نافذة الطباعة");
  }

  async function saveFollowUp(value: FollowUpValue) {
    if (!followTarget) return;
    if (effectiveFollowUpBranchId == null) {
      notify.err("اختر الفرع أولاً قبل تسجيل المتابعة");
      return;
    }
    try {
      await createNote.mutateAsync({
        customerId: Number(followTarget.id),
        note: value.note,
        followUpDate: value.followUpDate,
        branchId: effectiveFollowUpBranchId,
      });
      if (value.createTask) {
        if (!canCreateTasks) throw new Error("ليست لديك صلاحية إنشاء المهام");
        await createTask.mutateAsync({
          branchId: effectiveFollowUpBranchId,
          kind: "FOLLOW_UP",
          title: `متابعة تحصيل — ${followTarget.name}`,
          description: value.note,
          priority: value.taskPriority,
          customerId: Number(followTarget.id),
          sourceChannel: "PHONE",
          dueAt: value.followUpDate ? `${value.followUpDate}T09:00:00Z` : null,
        });
      }
      await Promise.all([
        utils.customerNotes.list.invalidate({ customerId: Number(followTarget.id) }),
        utils.customerNotes.dueToday.invalidate(),
        utils.tasks.list.invalidate(),
        utils.customers.operations.invalidate(),
      ]);
      notify.ok(value.createTask ? "حُفظت المتابعة وأُنشئت المهمة" : "حُفظت المتابعة");
      setFollowTarget(null);
    } catch (error) {
      notify.err(error);
    }
  }

  async function createBulkFollowUpTasks() {
    if (!canCreateTasks || selectedRows.length === 0) return;
    if (effectiveFollowUpBranchId == null) {
      notify.err("اختر الفرع أولاً قبل إنشاء مهام المتابعة");
      return;
    }
    const ok = await confirm({
      title: "إنشاء مهام متابعة",
      description: `سيتم إنشاء مهمة متابعة مرتبطة لكل عميل من العملاء المحددين (${selectedRows.length}).`,
      confirmText: "إنشاء المهام",
    });
    if (!ok) return;
    try {
      await Promise.all(
        selectedRows.map((row) =>
          createTask.mutateAsync({
            branchId: effectiveFollowUpBranchId,
            kind: "FOLLOW_UP",
            title: `متابعة تحصيل — ${row.name}`,
            description: `متابعة جماعية من شاشة العملاء. الرصيد الحالي: ${fmt(row.currentBalance)} د.ع`,
            priority: "NORMAL",
            customerId: Number(row.id),
            sourceChannel: "OTHER",
          }),
        ),
      );
      await utils.tasks.list.invalidate();
      notify.ok(`تم إنشاء ${selectedRows.length} مهمة متابعة`);
      sel.clear();
    } catch (error) {
      notify.err(error);
    }
  }

  function resetOperationalFilters() {
    setBalanceFilter("");
    setCollectionFilter("");
    setCreditFilter("");
    setInactivityDays("");
    setSort("NAME");
    setPage(0);
  }

  async function toggle(id: number, isActive: boolean, name: string) {
    if (isActive) {
      if (!(await confirm({
        variant: "danger",
        title: "تعطيل العميل",
        description: `سيُستثنى «${name}» من قوائم البيع. الفواتير المسوّاة تبقى. هل تتابع؟`,
        confirmText: "تعطيل",
      }))) return;
      deactivate.mutate({ customerId: id });
    } else {
      activate.mutate({ customerId: id });
    }
  }

  async function remove(id: number, name: string) {
    if (!(await confirm({
      variant: "danger",
      title: "حذف العميل نهائياً",
      description: `سيُحذف «${name}» نهائياً مع رصيده الافتتاحي — لا يمكن التراجع. الحذف مسموح فقط لعميلٍ بلا أي نشاط (فواتير/أوامر شغل/طلبات…)؛ إن كان له نشاط استعمل «تعطيل» بدلاً منه.`,
      confirmText: "حذف نهائي",
    }))) return;
    del.mutate({ customerId: id });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="العملاء"
        description="إدارة العملاء (أفراد/تجّار/شركات/حكومي): إضافة، تعديل، تعطيل، بحث، ومتابعة الرصيد المفتوح."
      />

      {/* الأدمن/المدير بلا فرع مُسنَد يختار الفرع صراحةً قبل تسجيل متابعة/إنشاء مهمة (نمط PR #288). */}
      {needsBranchChoice && effectiveFollowUpBranchId == null && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)] p-2 text-sm text-[var(--sem-warn)]">
          <span>اختر الفرع لإسناد ملاحظات/مهام المتابعة إليه:</span>
          <AppSelect
            className="h-8 w-48"
            value=""
            onValueChange={(v) => setPickedBranch(v ? Number(v) : null)}
            aria-label="فرع مهام المتابعة"
            placeholder="— اختر الفرع —"
          >
            {(branchesQ.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </AppSelect>
        </div>
      )}

      <ImportDialog<CustomerImportRow>
        open={importOpen}
        onOpenChange={setImportOpen}
        title="استيراد عملاء من Excel/CSV"
        entityName="عميل"
        fields={CUSTOMER_FIELDS}
        meta={CUSTOMER_IMPORT_META}
        onImport={async (rows, ctx) => {
          // خيارات الحوار (dryRun/usdRate/skipFailed/balanceSign) تُمرَّر للخادم فعلياً —
          // كائن مبنيّ لا literal كي تبقى الأنواع سليمة قبل توسعة مخطط الراوتر (W3) وبعدها.
          const options = { onExisting: "skip" as const, ...(ctx.options ?? {}) };
          const res = await importMut.mutateAsync({
            rows: rows.map((r) => ({ ...r, rowNumber: r.rowNumber })),
            options,
          });
          return res;
        }}
        onDone={(s) => {
          // الإبطال متى كُتب شيء فعلاً: ملف متعدد الدفعات قد يتوقّف عند دفعة فاشلة بعد دفعات
          // التزمت (committed المُدمَج = false) بينما القائمة تغيّرت في القاعدة فعلاً.
          if (s.created > 0 || s.updated > 0) {
            if (s.committed) notify.ok(`تم: ${s.created} مُنشأ، ${s.updated} مُحدَّث، ${s.skipped} متخطّى`);
            utils.customers.list.invalidate();
            utils.customers.search.invalidate();
            utils.customers.operations.invalidate();
          }
        }}
      />

      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={total}
            loading={list.isLoading}
            search={{
              value: q,
              onChange: (v) => { setQ(v); setPage(0); },
              placeholder: "بحث (اسم/هاتف/رقم قديم)",
              // ٢٤/٨ (تدقيق): البحث الفوريّ عن عميل هو غالب الاستعمال — تركيزٌ تلقائيّ يمنع
              // ضياع الحرف الأوّل عند فتح الشاشة.
              autoFocus: true,
            }}
            filters={
              <>
                {/* E (١٢/٨): تسميات صريحة بدل placeholder — يختفي عند الاختيار فيضيع معنى الحقل.
                    شكوى المالك الأصلية «الفلاتر مبعثرة» تسبب رئيسيّ لها هو غياب التسميات. */}
                <FilterField label="النوع">
                  <select
                    className={selectClsSm}
                    value={customerType}
                    onChange={(e) => { setCustomerType(e.target.value as any); setPage(0); }}
                  >
                    <option value="">كل الأنواع</option>
                    {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </FilterField>
                <FilterField label="فئة السعر">
                  <select
                    className={selectClsSm}
                    value={priceTier}
                    onChange={(e) => { setPriceTier(e.target.value as any); setPage(0); }}
                  >
                    <option value="">كل الفئات</option>
                    <option value="RETAIL">مفرد</option>
                    <option value="WHOLESALE">جملة</option>
                    <option value="GOVERNMENT">حكومي</option>
                  </select>
                </FilterField>
                {/* فلتر مدينة — مدعوم خادمياً في customers.search فقط (المستخدم غير المرتفع)؛
                    لوحة العمليات (operations) للمرتفعين لا تدعمه فنُخفيه عنهم بدل عرض فلتر معطَّل. */}
                {!isElevated && (
                  <FilterField label="المدينة">
                    <Input
                      value={city}
                      onChange={(e) => { setCity(e.target.value); setPage(0); }}
                      placeholder="اكتب اسم المدينة…"
                      className="h-8 w-32"
                    />
                  </FilterField>
                )}
                {isElevated && (
                  <>
                    <FilterField label="حالة الرصيد">
                      <select className={selectClsSm} value={balanceFilter} onChange={(e) => { setBalanceFilter(e.target.value as typeof balanceFilter); setPage(0); }}>
                        <option value="">كل الأرصدة</option>
                        <option value="RECEIVABLE">لنا عليهم</option>
                        <option value="CREDIT">لهم علينا</option>
                        <option value="ZERO">رصيد صفر</option>
                      </select>
                    </FilterField>
                    <FilterField label="حالة التحصيل">
                      <select className={selectClsSm} value={collectionFilter} onChange={(e) => { setCollectionFilter(e.target.value as typeof collectionFilter); setPage(0); }}>
                        <option value="">كل حالات التحصيل</option>
                        <option value="OVERDUE">فواتير متأخرة</option>
                        <option value="PROMISE_DUE">وعد مستحق/متأخر</option>
                        <option value="PROMISE_FUTURE">وعد قادم</option>
                        <option value="NO_FOLLOWUP">بلا متابعة</option>
                      </select>
                    </FilterField>
                    <FilterField label="الحالة الائتمانية">
                      <select className={selectClsSm} value={creditFilter} onChange={(e) => { setCreditFilter(e.target.value as typeof creditFilter); setPage(0); }}>
                        <option value="">كل الحالات الائتمانية</option>
                        <option value="CASH_ONLY">نقدي فقط</option>
                        <option value="NEAR_LIMIT">بلغ 80% من الحد</option>
                        <option value="OVER_LIMIT">تجاوز الحد</option>
                        <option value="UNLIMITED">بلا حد</option>
                      </select>
                    </FilterField>
                    <FilterField label="نشاط الشراء">
                      <select className={selectClsSm} value={inactivityDays} onChange={(e) => { setInactivityDays(e.target.value ? Number(e.target.value) as 30 | 60 | 90 : ""); setPage(0); }}>
                        <option value="">كل نشاطات الشراء</option>
                        <option value="30">لم يشترِ منذ 30 يوماً</option>
                        <option value="60">لم يشترِ منذ 60 يوماً</option>
                        <option value="90">لم يشترِ منذ 90 يوماً</option>
                      </select>
                    </FilterField>
                    <FilterField label="الترتيب">
                      <select className={selectClsSm} value={sort} onChange={(e) => { setSort(e.target.value as typeof sort); setPage(0); }}>
                        <option value="NAME">ترتيب بالاسم</option>
                        <option value="BALANCE_DESC">أعلى مديونية</option>
                        <option value="OLDEST_DUE">أقدم استحقاق</option>
                        <option value="LAST_PURCHASE">الأطول بلا شراء</option>
                      </select>
                    </FilterField>
                    {(balanceFilter || collectionFilter || creditFilter || inactivityDays || sort !== "NAME") && (
                      <Button type="button" variant="ghost" size="sm" onClick={resetOperationalFilters}>مسح فلاتر التشغيل</Button>
                    )}
                  </>
                )}
                <FilterField label="خيارات">
                  <label className="flex items-center gap-2 h-8 text-sm">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={includeInactive}
                      onChange={(e) => { setIncludeInactive(e.target.checked); setPage(0); }}
                    />
                    <span className="text-muted-foreground">عرض المعطّلين</span>
                  </label>
                </FilterField>
                {hasAnyFilter && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => resetAllFilters()}>{FILTER_LABELS.reset}</Button>
                )}
              </>
            }
            exportSpec={{
              filename: "العملاء",
              rows,
              // تصدير شامل: يجلب كل النتائج المطابقة للفلاتر الحالية (لا الصفحة المعروضة فقط).
              // نفس مدخلات الاستعلام بدون limit/offset — يُمرّرهما fetchAllPaged.
              fetchAll: () =>
                fetchAllPaged<DisplayRow>(
                  (offset, limit) =>
                    isElevated
                      ? utils.customers.operations
                          .fetch({ ...operationsInput, limit, offset })
                          .then((r) => ({ rows: (r.rows ?? []) as DisplayRow[], total: r.total }))
                      : utils.customers.search
                          .fetch({
                            q: q.trim() || undefined,
                            customerType: customerType || undefined,
                            priceTier: priceTier || undefined,
                            city: city.trim() || undefined,
                            includeInactive,
                            limit,
                            offset,
                          })
                          .then((r) => ({ rows: (r.rows ?? []) as DisplayRow[], total: r.total })),
                  { pageSize: 500 },
                ),
              columns: [
                { key: "name", header: "الاسم" },
                { key: "legacyCode", header: "الرقم القديم", map: (r) => legacyCodeOf(r) ?? "" },
                { key: "customerType", header: "النوع" },
                { key: "phone", header: "الهاتف" },
                { key: "city", header: "المدينة", map: (r) => [r.city, r.district].filter(Boolean).join(" / ") || "" },
                { key: "defaultPriceTier", header: "فئة السعر" },
                { key: "creditLimit", header: "سقف الائتمان", map: (r) => (isElevated && r.creditLimit == null ? "بلا حدّ" : Number(r.creditLimit ?? 0)) },
                { key: "currentBalance", header: "الرصيد الحالي", map: (r) => Number(r.currentBalance ?? 0) },
                { key: "isActive", header: "نشط", map: (r) => (r.isActive ? "نعم" : "لا") },
              ],
            }}
            // imports.customers = managerProcedure خادمياً — زرّ الاستيراد للمدير/الأدمن فقط.
            onImport={isElevated ? () => setImportOpen(true) : undefined}
            importLabel="استيراد Excel"
            add={{ href: "/customers/new", label: "عميل جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 w-8 text-center">
                  <input
                    type="checkbox"
                    className="size-4"
                    aria-label="تحديد كل العملاء في الصفحة"
                    checked={allOnPageSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allOnPageSelected && someOnPageSelected;
                    }}
                    onChange={(e) => sel.setMany(pageIds, e.target.checked)}
                  />
                </th>
                <th className="p-2">الاسم</th>
                {hasLegacy && <th className="p-2">الرقم القديم</th>}
                <th className="p-2">النوع</th>
                <th className="p-2">الهاتف</th>
                <th className="p-2">المدينة/المنطقة</th>
                <th className="p-2">فئة السعر</th>
                <th className="p-2 text-right">سقف الائتمان</th>
                <th className="p-2 text-start">الرصيد</th>
                {isElevated && <th className="p-2 text-center">حالة التحصيل</th>}
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const id = Number(c.id);
                const isActive = !!c.isActive;
                const fr = rowProps(id);
                return (
                  <tr key={id} ref={fr.ref} className={`border-t ${isActive ? "" : "opacity-60"} ${fr.className}`}>
                    <td className="p-2 text-center">
                      <input
                        type="checkbox"
                        className="size-4"
                        aria-label={`تحديد ${c.name ?? "العميل"}`}
                        checked={sel.isSelected(id)}
                        onChange={() => sel.toggle(id)}
                      />
                    </td>
                    <td className="p-2 font-medium">
                      {/* ٢٤/٨ (تدقيق): اسمُ العميل رابطٌ لكشف حسابه — يوفّر خطوةً يومية. للأدوار بلا
                          `reports:READ` نعرضه نصاً — كشف الحساب مقصور خادميّاً على المرتفعين. */}
                      {canOpenStatement ? (
                        <Link href={`/customers-statement?id=${id}`} className="text-primary hover:underline" title="فتح كشف حساب العميل">
                          {c.name}
                        </Link>
                      ) : (
                        c.name
                      )}
                    </td>
                    {hasLegacy && (
                      <td className="p-2 text-xs tabular-nums text-muted-foreground" dir="ltr">
                        {legacyCodeOf(c) ?? "—"}
                      </td>
                    )}
                    <td className="p-2 text-xs">{c.customerType ?? "—"}</td>
                    <td className="p-2"><CopyInline value={c.phone} /></td>
                    <td className="p-2 text-xs">{[c.city, c.district].filter(Boolean).join(" / ") || "—"}</td>
                    <td className="p-2 text-xs">{TIER_LABEL[c.defaultPriceTier] ?? c.defaultPriceTier}</td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">{isElevated && c.creditLimit == null ? "بلا حدّ" : fmt(c.creditLimit)}</td>
                    <td className="p-2 text-start">
                      <BalanceCell amount={c.currentBalance} entityType="customer" />
                    </td>
                    {isElevated && (
                      <td className="p-2 text-center">
                        {isOperationsRow(c) ? (
                          <div className="flex flex-col items-center gap-1">
                            <Badge variant={COLLECTION_STATUS[c.collectionStatus]?.variant ?? "neutral"}>
                              {COLLECTION_STATUS[c.collectionStatus]?.label ?? c.collectionStatus}
                            </Badge>
                            {c.daysOverdue > 0 && <span className="text-[10px] text-muted-foreground">{c.daysOverdue} يوم</span>}
                            {c.openTasks > 0 && <span className="text-[10px] text-muted-foreground">{c.openTasks} مهمة مفتوحة</span>}
                          </div>
                        ) : "—"}
                      </td>
                    )}
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "badge-status-active" : "badge-stock-out"}`}>
                        {isActive ? "مفعّل" : "معطّل"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      {/* ٣ إجراءات ⇒ auto يحوّلها لقائمة ⋯ تلقائياً (إسقاط inline مقصود) */}
                      <RowActions
                        contact={{
                          phone: c.phone,
                          whatsapp: (c as { whatsapp?: string | null }).whatsapp,
                          alternativePhones: [
                            (c as { phone2?: string | null }).phone2,
                            (c as { phone3?: string | null }).phone3,
                          ],
                          label: `واتساب ${c.name}`,
                          message: buildOperationalContactMessage({
                            partyName: c.name,
                            entityLabel: "حساب العميل",
                            nextAction: "نتواصل معكم لمتابعة طلبكم أو حسابكم. يرجى الرد عند الملاءمة.",
                          }),
                          gate: { module: "crm", level: "READ" },
                        }}
                        actions={[
                          {
                            key: "edit",
                            kind: "edit",
                            label: "تعديل",
                            href: `/customers/${id}/edit`,
                            gate: { roles: ["manager"], module: "crm", level: "FULL" },
                          },
                          // كشف الحساب يقرأ ?id= من URL (نمط CustomerStatement)
                          {
                            key: "stmt",
                            kind: "view",
                            label: "كشف حساب",
                            href: `/customers-statement?id=${id}`,
                            gate: { module: "crm", level: "READ" },
                          },
                          {
                            key: "receipt",
                            kind: "pay",
                            label: "تسجيل دفعة",
                            href: `/vouchers/receipt/new?customerId=${id}`,
                            hidden: !isElevated,
                            gate: { roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                          },
                          {
                            key: "follow",
                            kind: "create",
                            label: "تسجيل متابعة",
                            hidden: !isElevated,
                            onSelect: () => setFollowTarget(c),
                            gate: { roles: ["manager"], module: "crm", level: "FULL" },
                          },
                          {
                            key: "notes",
                            kind: "view",
                            label: "سجل المتابعة",
                            href: `/crm?tab=followups&id=${id}`,
                            gate: { module: "crm", level: "READ" },
                          },
                          {
                            key: "reminder",
                            kind: "create",
                            label: "تذكير واتساب",
                            href: "/ar-reminders",
                            hidden: !isElevated,
                            gate: { roles: ["manager", "accountant"], module: "collections", level: "FULL" },
                          },
                          {
                            key: "toggle",
                            kind: "approve",
                            label: isActive ? "تعطيل" : "تفعيل",
                            variant: isActive ? "destructive" : "default",
                            disabled: deactivate.isPending || activate.isPending,
                            disabledReason: "توجد عملية تحديث قيد التنفيذ",
                            onSelect: () => void toggle(id, isActive, c.name ?? ""),
                            gate: { roles: ["manager"], module: "crm", level: "FULL" },
                          },
                          {
                            key: "delete",
                            kind: "delete",
                            label: "حذف نهائي",
                            variant: "destructive",
                            disabled: del.isPending,
                            disabledReason: "توجد عملية حذف قيد التنفيذ",
                            hidden: !isElevated,
                            onSelect: () => void remove(id, c.name ?? ""),
                            gate: { managerOnly: true },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {!list.isLoading && rows.length === 0 && (
                <tr>
                  {/* ٢٤/٨ (تدقيق): بدل نصٍّ جامد، إن كانت هناك فلاتر مفعَّلة نعرض زرّ «مسح كل الفلاتر»
                      داخل الرسالة نفسها — لا حاجةَ لتتبّع الفلاتر أعلى الصفحة عند خطأ فلترة. */}
                  <td colSpan={(hasLegacy ? 11 : 10) + (isElevated ? 1 : 0)} className="p-6 text-center text-sm text-muted-foreground">
                    <div className="flex flex-col items-center gap-2">
                      <span>لا عملاء مطابقين.</span>
                      {hasAnyFilter ? (
                        <Button type="button" variant="outline" size="sm" onClick={() => { resetAllFilters(); setPage(0); }}>
                          {FILTER_LABELS.reset}
                        </Button>
                      ) : (
                        <span className="text-xs">أضِف عميلاً جديداً أو غيّر البحث.</span>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {/* ٢٤/٨ (Codex P2): إجماليّ العملاء ظاهرٌ **دائماً** خارج شرط `pages > 1` — الشركات
          الصغيرة (≤٥٠ عميل) كانت لا ترى أيّ عدّاد لأنّ الترقيم يختفي في الصفحة الواحدة. */}
      {rows.length > 0 && (
        <div className="flex items-center justify-between text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={pages <= 1 || page <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            style={{ visibility: pages > 1 ? "visible" : "hidden" }}
          >
            ← السابق
          </Button>
          <div className="text-muted-foreground">
            {pages > 1 && <>صفحة {page + 1} من {pages} · </>}
            <span className="tabular-nums">{total.toLocaleString("en-US")}</span> عميل
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={pages <= 1 || page >= pages - 1}
            onClick={() => setPage((p) => p + 1)}
            style={{ visibility: pages > 1 ? "visible" : "hidden" }}
          >
            التالي →
          </Button>
        </div>
      )}

      {isElevated && (
        <OperationsSummary
          title="ملخص العملاء والتحصيل"
          subtitle="جميع الصفحات وفق البحث والفلاتر الحالية. المتأخرات محسوبة من الاستحقاقات، ولا تساوي الرصيد الإجمالي بالضرورة."
          loading={operations.isLoading}
          metrics={[
            {
              key: "total",
              label: "إجمالي العملاء",
              value: (summary?.total ?? 0).toLocaleString("ar-IQ-u-nu-latn"),
              detail: `${summary?.active ?? 0} مفعّل · ${summary?.inactive ?? 0} معطّل`,
              onClick: resetOperationalFilters,
            },
            {
              key: "receivable",
              label: "لنا عليهم",
              value: `${fmt(summary?.receivable ?? 0)} د.ع`,
              detail: `${summary?.debtors ?? 0} عميلاً`,
              tone: "danger",
              active: balanceFilter === "RECEIVABLE",
              onClick: () => { setBalanceFilter(balanceFilter === "RECEIVABLE" ? "" : "RECEIVABLE"); setPage(0); },
            },
            {
              key: "credit",
              label: "لهم علينا",
              value: `${fmt(summary?.customerCredit ?? 0)} د.ع`,
              detail: `${summary?.creditors ?? 0} عميلاً`,
              tone: "success",
              active: balanceFilter === "CREDIT",
              onClick: () => { setBalanceFilter(balanceFilter === "CREDIT" ? "" : "CREDIT"); setPage(0); },
            },
            {
              key: "net",
              label: Number(summary?.net ?? 0) === 0 ? "الصافي متعادل" : Number(summary?.net ?? 0) > 0 ? "صافي لنا" : "صافي علينا",
              value: `${fmt(Math.abs(Number(summary?.net ?? 0)))} د.ع`,
              detail: `${summary?.cashOnly ?? 0} نقدي فقط · ${summary?.unlimited ?? 0} بلا حد`,
              tone: Number(summary?.net ?? 0) === 0 ? "neutral" : Number(summary?.net ?? 0) > 0 ? "danger" : "success",
            },
            {
              key: "overdue",
              label: "متأخرات واجبة التحصيل",
              value: `${fmt(summary?.overdueAmount ?? 0)} د.ع`,
              detail: `${summary?.overdueCustomers ?? 0} عميلاً متأخراً`,
              tone: "warning",
              active: collectionFilter === "OVERDUE",
              onClick: () => { setCollectionFilter(collectionFilter === "OVERDUE" ? "" : "OVERDUE"); setPage(0); },
            },
            {
              key: "limits",
              label: "تجاوزوا الحد الائتماني",
              value: (summary?.overLimit ?? 0).toLocaleString("ar-IQ-u-nu-latn"),
              detail: `${summary?.nearLimit ?? 0} بلغوا 80%`,
              tone: "danger",
              active: creditFilter === "OVER_LIMIT",
              onClick: () => { setCreditFilter(creditFilter === "OVER_LIMIT" ? "" : "OVER_LIMIT"); setPage(0); },
            },
          ]}
          footer={
            <div className="space-y-3 border-t pt-3">
              <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <button type="button" className="rounded-md border p-2 text-start hover:bg-accent" onClick={() => { setCollectionFilter("PROMISE_DUE"); setPage(0); }}>
                  <strong className="block">وعود مستحقة أو مخلفة</strong>
                  <span className="text-muted-foreground">{summary?.promiseDue ?? 0} اليوم · {summary?.promiseBroken ?? 0} مخلفة</span>
                </button>
                <div className="rounded-md border p-2">
                  <strong className="block">أعلى مديونية</strong>
                  <span className="text-muted-foreground">
                    {summary?.highestDebtor ? `${summary.highestDebtor.customerName} · ${fmt(summary.highestDebtor.amount)} د.ع` : "لا توجد مديونية"}
                  </span>
                </div>
                <div className="rounded-md border p-2">
                  <strong className="block">تركّز أكبر 5 عملاء</strong>
                  <span className="text-muted-foreground">{summary?.topFiveConcentrationPct ?? 0}% من إجمالي الذمم</span>
                </div>
                <button type="button" className="rounded-md border p-2 text-start hover:bg-accent" onClick={() => { setInactivityDays(30); setPage(0); }}>
                  <strong className="block">لم يشتروا منذ 30 يوماً</strong>
                  <span className="text-muted-foreground">{summary?.noRecentPurchase30 ?? 0} عميلاً</span>
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link href="/ar-reminders"><Button size="sm">برنامج التحصيل اليوم</Button></Link>
                <Link href="/crm?tab=aging"><Button size="sm" variant="outline">أعمار الذمم</Button></Link>
                <Link href="/crm?tab=followups"><Button size="sm" variant="outline">سجل المتابعات</Button></Link>
                <Link href="/tasks?tab=list&overdue=1"><Button size="sm" variant="outline">المهام المتأخرة</Button></Link>
              </div>
              {(summary?.collectorActivity30d?.length ?? 0) > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium">نشاط فريق التحصيل خلال 30 يوماً</summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {summary!.collectorActivity30d.map((person) => (
                      <div key={person.userId} className="rounded-md border p-2">
                        <strong>{person.userName}</strong>
                        <p className="text-muted-foreground">{person.sent} تذكيراً · {person.promisesRecorded} وعداً مسجلاً</p>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          }
        />
      )}

      <CustomerFollowUpDialog
        open={followTarget != null}
        onOpenChange={(open) => { if (!open) setFollowTarget(null); }}
        customerName={followTarget?.name ?? ""}
        defaultAmount={followTarget?.currentBalance ?? null}
        submitting={createNote.isPending || createTask.isPending}
        onSubmit={(value) => void saveFollowUp(value)}
      />

      {/* شريط التحديد الجماعي: TSV لـExcel + ملخّص واتساب لقائمة العملاء. */}
      <SelectionBar
        count={sel.count}
        onClear={sel.clear}
        onExport={copySelectedAsTSV}
        exportLabel="نَسخ المُحَدَّد كَـTSV"
        onPrint={printSelectedCollectionList}
        printLabel="طباعة قائمة التحصيل"
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => void copySelectedAsWhatsAppSummary()}>
              معاينة واتساب
            </Button>
            {canCreateTasks && (
              <Button size="sm" variant="outline" onClick={() => void createBulkFollowUpTasks()} disabled={createTask.isPending}>
                إنشاء مهام متابعة
              </Button>
            )}
          </>
        }
      />
    </div>
  );
}
