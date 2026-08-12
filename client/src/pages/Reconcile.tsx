import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { MonthPicker, thisMonth } from "@/components/form/MonthPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { fmt } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { exportSheets } from "@/lib/export";
import { AlertTriangle, Check, CircleCheck, ClipboardList, Clock3, FileDown, ShieldCheck } from "lucide-react";
import { Link } from "wouter";
import { RowActions } from "@/components/list";
import { useMemo, useState } from "react";

/* ═══════════ شاشة تدقيق التوافق المالي (admin فقط) ═══════════
   تستهلك reports.reconcile (adminProcedure) لكشف الانجراف الصامت بين
   الأرصدة المُشتقّة والمسجَّلة في الذمم والعهد والمخزون والدفتر.
═══════════════════════════════════════════════════════════════ */

type Row = { entity: string; id: number; expected: string; actual: string; drift: string; note?: string };
type ReconcileData = RouterOutputs["reports"]["reconcile"];
type DoubleEntryData = ReconcileData["doubleEntry"];
type ActivationData = ReconcileData["activation"];

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function Reconcile() {
  const [month, setMonth] = useState(thisMonth());
  const [branchId, setBranchId] = useState<number | "">("");
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: isAdmin });
  // الفحص ثقيل نسبياً — لا يُطلَق إلا للمدير، وبلا إعادة جلب تلقائية.
  const recon = trpc.reports.reconcile.useQuery({
    month,
    branchId: branchId ? Number(branchId) : undefined,
  }, {
    enabled: isAdmin,
    refetchOnWindowFocus: false,
  });

  const setMode = trpc.reports.setDoubleEntryMode.useMutation({
    onSuccess: (result) => {
      notify.ok(result.mode === "SHADOW" ? "بدأ وضع الظل وسُجّل القرار في التدقيق." : "اعتمد الدفتر المزدوج بوضع ACTIVE.");
      void recon.refetch();
    },
    onError: (error) => notify.err(error),
  });

  const data = recon.data;

  // أسماء الأطراف لعرضها بجانب المعرّفات الرقمية — تُجلَب فقط عند وجود انحرافات فعلية لهذا
  // المحور (لا داعٍ لجلب القوائم الكاملة عند عدم وجود صفوف تحتاجها). هذه الاستعلامات (وما
  // تحتها من useMemo) يجب أن تُستدعى في كل تصيير بلا شرط (قاعدة الخطاطيف) — لذا هي **قبل**
  // حاجز «غير المدير» أدناه لا بعده، رغم أنها لا تُفعَّل (enabled) إلا للمدير أصلاً.
  const customersQ = trpc.customers.list.useQuery(undefined, { enabled: isAdmin && !!data?.customers.length });
  const suppliersQ = trpc.suppliers.list.useQuery(undefined, { enabled: isAdmin && !!data?.suppliers.length });
  const partiesQ = trpc.delivery.listParties.useQuery({}, { enabled: isAdmin && !!data?.delivery.length });
  const customerNames = useMemo(() => new Map((customersQ.data ?? []).map((c) => [c.id, c.name])), [customersQ.data]);
  const supplierNames = useMemo(() => new Map((suppliersQ.data ?? []).map((s) => [s.id, s.name])), [suppliersQ.data]);
  const partyNames = useMemo(() => new Map((partiesQ.data ?? []).map((p) => [p.id, p.name])), [partiesQ.data]);

  // غير المدير: حاجز واضح (الخادم يرفضها أصلاً بـadminProcedure — هذا دفاع طبقي + رسالة لطيفة).
  if (me.data && !isAdmin) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        هذه الشاشة مخصّصة لمسؤول النظام فقط.
      </div>
    );
  }

  const doubleEntryIssues = data
    ? data.doubleEntry.roles.filter((row) => row.drift !== "0.00").length
      + data.doubleEntry.gapCount
      + data.doubleEntry.missingCount
      + data.doubleEntry.extraCount
      + data.doubleEntry.scopeMismatchCount
      + data.doubleEntry.unreconstructableCount
    : 0;
  const total = data
    ? data.customers.length + data.suppliers.length + data.delivery.length + data.inventory.length + data.ledger.length + doubleEntryIssues
    : 0;
  const loading = me.isLoading || (isAdmin && recon.isLoading);

  // تصدير Excel — ورقة مستقلّة لكل محور بنفس بيانات الجدول المعروض (تشمل الأسماء حيث توفّرت).
  function exportAll() {
    if (!data) return;
    const sheet = (title: string, rows: Row[], names?: Map<number, string>) => ({
      sheetName: title,
      title: `تدقيق التوافق المالي — ${title}`,
      meta: [{ label: "تاريخ الفحص", value: fmtDateTime(data.runAt) }],
      columns: [
        { key: "id", header: "المعرّف" },
        ...(names ? [{ key: "name", header: "الاسم", map: (r: any) => names.get(r.id) ?? "—" }] : []),
        { key: "expected", header: "المتوقّع", money: true, map: (r: any) => Number(r.expected) },
        { key: "actual", header: "الفعلي", money: true, map: (r: any) => Number(r.actual) },
        { key: "drift", header: "الانحراف", money: true, map: (r: any) => Number(r.drift) },
        { key: "note", header: "ملاحظة", map: (r: any) => r.note ?? "" },
      ],
      rows: rows as any[],
    });
    exportSheets("تدقيق-التوافق-المالي", [
      sheet("ذمم العملاء", data.customers, customerNames),
      sheet("ذمم الموردين", data.suppliers, supplierNames),
      sheet("عهدة التوصيل", data.delivery, partyNames),
      sheet("أرصدة المخزون", data.inventory),
      sheet("قيود الدفتر", data.ledger),
      {
        sheetName: "الدفتر المزدوج",
        title: `مطابقة الدفتر المزدوج — ${data.doubleEntry.scope.month ?? "نافذة الظل"}`,
        meta: [
          { label: "النطاق", value: `${data.doubleEntry.scope.from} — ${data.doubleEntry.scope.to}` },
          { label: "الفرع", value: branchId ? branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId) : "كل الفروع" },
          { label: "الفجوات", value: String(data.doubleEntry.gapCount) },
          { label: "القيود المفقودة", value: String(data.doubleEntry.missingCount) },
          { label: "اختلاف النطاق", value: String(data.doubleEntry.scopeMismatchCount) },
          { label: "إجمالي الانحراف", value: data.doubleEntry.drift },
        ],
        columns: [
          { key: "role", header: "الدور المحاسبي" },
          { key: "expected", header: "المتوقّع", money: true, map: (r: any) => Number(r.expected) },
          { key: "actual", header: "الفعلي", money: true, map: (r: any) => Number(r.actual) },
          { key: "drift", header: "الانحراف", money: true, map: (r: any) => Number(r.drift) },
        ],
        rows: data.doubleEntry.roles,
      },
    ]);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="تدقيق التوافق المالي"
        description="يكشف الانجراف الصامت في ذمم العملاء والموردين، عهدة تحصيلات التوصيل، المخزون والدفتر. الأخضر = متوازن، الأحمر = انحراف يستوجب المراجعة. لا يصحّح النظام أي فرق بصمت."
        actions={
          <div className="flex items-center gap-3">
            {data && (
              <span className="text-xs text-muted-foreground" dir="ltr">
                آخر فحص: <span dir="ltr" className="tabular-nums">{fmtDateTime(data.runAt)}</span>
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!data}
              onClick={exportAll}
              className="inline-flex items-center gap-1.5"
            >
              <FileDown aria-hidden className="size-4" />
              تصدير Excel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!isAdmin || recon.isFetching}
              onClick={() => recon.refetch()}
            >
              {recon.isFetching ? "جارٍ الفحص…" : "إعادة الفحص"}
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">شهر المطابقة</label>
            <MonthPicker value={month} onChange={setMonth} ariaLabel="شهر مطابقة الدفتر المزدوج" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select
              className={selectCls}
              value={branchId}
              onChange={(event) => setBranchId(event.target.value ? Number(event.target.value) : "")}
            >
              <option value="">كل الفروع</option>
              {branches.data?.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>
          </div>
          <p className="max-w-xl text-xs text-muted-foreground">
            نطاق التقرير يتبع تاريخ القيد داخل الشهر والفرع المختارين. بوابة ACTIVE مستقلة وتفحص كل الأحداث منذ بدء الظل على جميع الفروع.
          </p>
        </CardContent>
      </Card>

      {loading && <LoadingState />}

      {recon.error && (
        <ErrorState message={`تعذّر التدقيق: ${recon.error.message}`} onRetry={() => recon.refetch()} />
      )}

      {data && !recon.error && (
        <>
          <DoubleEntryStatus
            reconciliation={data.doubleEntry}
            activation={data.activation}
            busy={setMode.isPending}
            onStartShadow={() => setMode.mutate({ target: "SHADOW" })}
            onActivate={() => setMode.mutate({ target: "ACTIVE" })}
          />

          <Card>
            <CardContent
              className={`p-6 text-center text-lg font-bold inline-flex items-center justify-center gap-2 w-full ${
                total === 0 ? "badge-status-active" : "badge-stock-out"
              }`}
            >
              {total === 0 ? (
                <>
                  <Check aria-hidden className="size-5" />
                  كل المحاور متوازنة — لا انحراف
                </>
              ) : (
                <>
                  <AlertTriangle aria-hidden className="size-5" />
                  {`${total} انحراف يستوجب المراجعة`}
                </>
              )}
            </CardContent>
          </Card>

          <DriftSection
            title="ذمم العملاء"
            desc="الفرق بين الرصيد المُشتقّ من الفواتير (إجمالي − مدفوع − مُرتجَع) والمسجَّل في currentBalance."
            idLabel="رقم العميل"
            money
            rows={data.customers}
            names={customerNames}
            link={(id) => `/customers-statement?id=${id}`}
            linkLabel="كشف الحساب"
          />

          <DriftSection
            title="ذمم الموردين"
            desc="الفرق بين الرصيد المُشتقّ من المشتريات والتسديدات والمسجَّل على المورد."
            idLabel="رقم المورد"
            money
            rows={data.suppliers}
            names={supplierNames}
            link={(id) => `/suppliers-statement?id=${id}`}
            linkLabel="كشف الحساب"
          />

          <DriftSection
            title="عهدة تحصيلات التوصيل"
            desc="الفرق بين مبالغ COD المسلّمة للمندوب والمبالغ المورّدة أو المشطوبة وبين رصيده المسجّل."
            idLabel="رقم جهة التوصيل"
            money
            rows={data.delivery}
            names={partyNames}
            link={() => "/delivery?tab=parties"}
            linkLabel="جهات التوصيل"
          />

          <DriftSection
            title="أرصدة المخزون"
            desc="رصيد سالب لمتغيّر في فرع — يجب ألّا يقلّ عن صفر."
            idLabel="رقم المتغيّر"
            rows={data.inventory}
            link={() => `/inventory`}
            linkLabel="المخزون"
            action={
              data.inventory.length > 0 ? (
                <Link
                  href={`/stocktakes/new?variants=${Array.from(new Set(data.inventory.map((r) => r.id))).join(",")}&name=${encodeURIComponent("جرد تحقّق — انحرافات التدقيق المالي")}`}
                >
                  <Button size="sm" className="inline-flex items-center gap-1.5"><ClipboardList aria-hidden className="size-4" />أنشئ جلسة جرد لهذه المنتجات</Button>
                </Link>
              ) : null
            }
          />

          <DriftSection
            title="قيود الدفتر"
            desc="قيود لا يتطابق فيها الربح مع (الإيراد − التكلفة)."
            idLabel="رقم القيد"
            money
            rows={data.ledger}
          />
        </>
      )}
    </div>
  );
}

const ROLE_LABELS: Record<string, string> = {
  AR: "ذمم العملاء",
  AP: "ذمم الموردين",
  CASH: "النقد",
  CARD_BANK: "البطاقة / البنك",
  INVENTORY: "المخزون",
  SALES_STATIONERY: "إيراد القرطاسية",
  SALES_PRINT: "إيراد الطباعة",
  SALES_FLEX: "إيراد الفلكس",
  DELIVERY_REVENUE: "إيراد التوصيل",
  COGS: "تكلفة البضاعة المباعة",
  OPENING_EQUITY: "حقوق الرصيد الافتتاحي",
};

function DoubleEntryStatus({
  reconciliation,
  activation,
  busy,
  onStartShadow,
  onActivate,
}: {
  reconciliation: DoubleEntryData;
  activation: ActivationData;
  busy: boolean;
  onStartShadow: () => void;
  onActivate: () => void;
}) {
  const modeLabel = activation.mode === "OFF" ? "متوقف" : activation.mode === "SHADOW" ? "ظل" : "فعّال";
  const modeClass = activation.mode === "ACTIVE"
    ? "badge-status-active"
    : activation.mode === "SHADOW"
      ? "badge-status-pending"
      : "badge-status-cancelled";
  const monthlyIssueCount = reconciliation.roles.filter((row) => row.drift !== "0.00").length
    + reconciliation.gapCount
    + reconciliation.missingCount
    + reconciliation.extraCount
    + reconciliation.scopeMismatchCount
    + reconciliation.unreconstructableCount;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="inline-flex items-center gap-2">
            <ShieldCheck aria-hidden className="size-4" />
            حالة الدفتر المزدوج وبوابة ACTIVE
          </span>
          <span className={`rounded-full px-3 py-1 text-xs ${modeClass}`}>الوضع: {modeLabel}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <GateMetric
            label="مدة الظل"
            value={`${activation.shadowDays}/${activation.requiredShadowDays} يوم`}
            ok={activation.shadowDays >= activation.requiredShadowDays}
          />
          <GateMetric
            label="خرائط القيود"
            value={`${activation.mappedTypes}/${activation.requiredMappedTypes}`}
            ok={activation.mappedTypes === activation.requiredMappedTypes && activation.unmappedEntryTypes.length === 0}
          />
          <GateMetric
            label="فجوات نافذة الظل"
            value={String(activation.gapCount + activation.missingCount + activation.scopeMismatchCount + activation.unreconstructableCount)}
            ok={activation.gapCount + activation.missingCount + activation.scopeMismatchCount + activation.unreconstructableCount === 0}
          />
          <GateMetric
            label="انحراف نافذة الظل"
            value={fmt(activation.drift)}
            ok={activation.drift === "0.00" && activation.journalImbalance === "0.00"}
          />
        </div>

        {activation.mode === "ACTIVE" ? (
          <div className="badge-status-active flex items-center gap-2 rounded-md p-3 text-sm font-semibold">
            <CircleCheck aria-hidden className="size-4" />
            تم اعتماد ACTIVE بعد اجتياز البوابة. يستمر التقرير في عرض أي فجوات أو انحرافات لاحقة.
          </div>
        ) : activation.blockers.length > 0 ? (
          <div className="space-y-2 rounded-md border p-3">
            <div className="inline-flex items-center gap-2 font-semibold">
              <AlertTriangle aria-hidden className="size-4 text-destructive" />
              موانع التفعيل
            </div>
            {activation.blockers.map((item) => (
              <div key={item.key} className="flex items-start gap-2 text-sm">
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div>
                  <div className="font-medium">{item.label}</div>
                  <div className="text-xs text-muted-foreground">{item.detail}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="badge-status-active flex items-center gap-2 rounded-md p-3 text-sm font-semibold">
            <CircleCheck aria-hidden className="size-4" />
            اجتازت البوابة كل الشروط: 30 يوماً، صفر فجوات، انحراف صفر، و31/31 خريطة.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {activation.mode === "OFF" && (
            <Button disabled={busy} onClick={onStartShadow}>
              <Clock3 aria-hidden className="size-4" />
              بدء وضع الظل
            </Button>
          )}
          {activation.mode === "SHADOW" && (
            <Button
              disabled={busy || !activation.ok}
              onClick={onActivate}
              title={!activation.ok ? activation.blockers.map((item) => item.label).join("، ") : undefined}
            >
              <ShieldCheck aria-hidden className="size-4" />
              اعتماد ACTIVE عبر البوابة
            </Button>
          )}
          {activation.mode === "ACTIVE" && (
            <span className="inline-flex items-center gap-2 text-sm font-semibold">
              <Check aria-hidden className="size-4" />
              الدفتر المزدوج مُعتمد.
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            التحكم محصور بمالك النظام/المدير العام، وكل انتقال يُكتب في سجل التدقيق داخل المعاملة نفسها.
          </span>
        </div>

        <div className="border-t pt-4">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="font-semibold">مطابقة الشهر المختار</h3>
              <p className="text-xs text-muted-foreground">
                {reconciliation.scope.from} — {reconciliation.scope.to} · {reconciliation.sourceEntryCount} حدثاً مصدرياً · {reconciliation.journalEntryCount} رأس يومية
              </p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${monthlyIssueCount === 0 ? "badge-status-active" : "badge-stock-out"}`}>
              {monthlyIssueCount === 0 ? "مطابق" : `${monthlyIssueCount} مانعاً/انحرافاً`}
            </span>
          </div>

          {reconciliation.roles.length > 0 ? (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2">الدور المحاسبي</th>
                    <th className="p-2 text-right">المتوقّع</th>
                    <th className="p-2 text-right">الفعلي</th>
                    <th className="p-2 text-right">الانحراف</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliation.roles.map((row) => (
                    <tr key={row.role} className="border-t">
                      <td className="p-2 font-medium">
                        {ROLE_LABELS[row.role] ?? row.role}
                        <div className="text-[11px] font-normal text-muted-foreground" dir="ltr">{row.role}</div>
                      </td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(row.expected)}</td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(row.actual)}</td>
                      <td className={row.drift === "0.00" ? "p-2 text-right tabular-nums" : "p-2 text-right tabular-nums font-semibold text-money-negative"} dir="ltr">
                        {fmt(row.drift)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTableShell>
          ) : (
            <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">لا أحداث مالية في هذا النطاق.</p>
          )}

          {(reconciliation.gapCount > 0
            || reconciliation.missingCount > 0
            || reconciliation.extraCount > 0
            || reconciliation.scopeMismatchCount > 0
            || reconciliation.unreconstructableCount > 0) && (
            <div className="mt-2 text-xs text-muted-foreground">
              الفجوات: {reconciliation.gapCount} · المفقودة: {reconciliation.missingCount} · الزائدة: {reconciliation.extraCount} · اختلاف النطاق: {reconciliation.scopeMismatchCount} · غير القابلة لإعادة المطابقة: {reconciliation.unreconstructableCount}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function GateMetric({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center gap-2 font-semibold tabular-nums">
        {ok ? <Check aria-hidden className="size-4" /> : <AlertTriangle aria-hidden className="size-4 text-destructive" />}
        <span dir="ltr">{value}</span>
      </div>
    </div>
  );
}

function DriftSection({
  title,
  desc,
  idLabel,
  rows,
  money,
  link,
  linkLabel,
  action,
  names,
}: {
  title: string;
  desc: string;
  idLabel: string;
  rows: Row[];
  money?: boolean;
  link?: (id: number) => string;
  linkLabel?: string;
  action?: React.ReactNode;
  /** اسم الطرف (عميل/مورّد/جهة توصيل) بحسب المعرّف — يُعرض تحت الرقم إن تُوفِّر. */
  names?: Map<number, string>;
}) {
  const val = (s: string) => (money ? fmt(s) : s);
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-2 border-b p-3">
          <div>
            <h2 className="font-semibold">{title}</h2>
            <p className="text-xs text-muted-foreground">{desc}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {action}
            <span
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold inline-flex items-center gap-1 ${
                rows.length === 0 ? "badge-status-active" : "badge-stock-out"
              }`}
            >
              {rows.length === 0 ? (
                <>
                  <Check aria-hidden className="size-3.5" />
                  لا انحراف
                </>
              ) : (
                `${rows.length} انحراف`
              )}
            </span>
          </div>
        </div>
        {rows.length > 0 && (
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2">{idLabel}</th>
                <th className="p-2 text-right">المتوقّع</th>
                <th className="p-2 text-right">الفعلي</th>
                <th className="p-2 text-right">الانحراف</th>
                {link && <th className="p-2 text-center">إجراء</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                // المخزون: متغيّر سالب في فرعين يُنتج id مكرّراً (reconcileInventory يُسقط branchId) ⇒ مفتاح مركّب بالـindex.
                <tr key={`${title}-${r.id}-${i}`} className="border-t">
                  <td className="p-2 font-medium">
                    <div className="tabular-nums" dir="ltr">{r.id}</div>
                    {names && (
                      <div className="text-xs font-normal text-muted-foreground">{names.get(r.id) ?? "—"}</div>
                    )}
                  </td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">
                    {val(r.expected)}
                  </td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">
                    {val(r.actual)}
                  </td>
                  <td className="p-2 text-right font-semibold tabular-nums text-money-negative" dir="ltr">
                    {val(r.drift)}
                    {r.note && (
                      <span dir="rtl" className="mr-2 inline-block rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-bold text-amber-800">
                        {r.note}
                      </span>
                    )}
                  </td>
                  {link && (
                    <td className="p-2 text-center">
                      <RowActions
                        mode="inline"
                        actions={[{
                          key: "open",
                          kind: "view",
                          label: linkLabel,
                          href: link(r.id),
                          gate: { adminOnly: true },
                        }]}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </ScrollTableShell>
        )}
      </CardContent>
    </Card>
  );
}
