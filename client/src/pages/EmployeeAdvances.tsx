/* ============================================================================
 * شاشة سلف الموظفين — تبويب في hub الموارد البشرية (بند 12ج).
 *
 * قائمة السلف بفلاتر (الحالة/الموظف) + الأرصدة المتبقية + منح سلفة بحوار (سند صرف حقيقي
 * من الخزينة عبر createVoucher) + إلغاء (متاح فقط قبل أي خصم — remaining == amount).
 * الخصم التلقائي يظهر في مسيّر الرواتب (عمود الاستقطاع: «منه سلفة») عند التوليد.
 * ========================================================================== */
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { FilterField, ListToolbar } from "@/components/list";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { EmpAvatar, iqd } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { D } from "@/lib/money";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { HandCoins, Plus, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { EmployeeAdvanceRepaymentPanel } from "@/components/hr/EmployeeAdvanceRepaymentPanel";
import { toExcelMoney } from "@/lib/payrollAccrual";
import { selectClsSm } from "@/lib/ui/formStyles";


const STATUS_LABEL: Record<string, string> = { ACTIVE: "نشطة", SETTLED: "مسوّاة", CANCELLED: "ملغاة" };
const STATUS_CLS: Record<string, string> = {
  ACTIVE: "badge-status-pending",
  SETTLED: "badge-status-active",
  CANCELLED: "bg-muted text-muted-foreground",
};
const STATUS_TITLE: Record<string, string> = {
  ACTIVE: "نشطة — تُخصم تلقائياً من كل مسيّر راتب حتى تصفير المتبقّي",
  // Codex P2 (٢٤/٨): مسارُ التسوية ليس واحداً — لوحةُ سدادٍ يدويّ (تحت الجدول) تعتمد ⇒
  // remaining=0 وSETTLED دون أيّ خصمٍ من راتب. لا نُلبس مدقّقاً/HR قصّةً مالية ليست بالضرورة صحيحة.
  SETTLED: "مسوّاة — استُوفي المبلغ كاملاً (خصماً من الرواتب أو سداداً مباشراً)",
  CANCELLED: "ملغاة — أُلغيت قبل بدء الخصم (سند الصرف لم يُعكَس آلياً)",
};

/** صفُّ سلفة موظّف — مشتقٌّ من عقد `payroll.advancesList` فلا ينجرف عن الخادم. */
type AdvanceRow = RouterOutputs["payroll"]["advancesList"][number];

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${STATUS_CLS[status] ?? "bg-muted text-muted-foreground"}`}
      title={STATUS_TITLE[status] ?? undefined}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export default function EmployeeAdvances() {
  const utils = trpc.useUtils();
  // مرآة الخادم: `payroll.advanceGrant` و`payroll.advanceCancel` = `hrWrite` (hr:FULL) —
  // server/routers/payrollRouter.ts:522/547. إخفاءُ زرّ «منح سلفة» على من لا يستطيع الحفظ (بدل
  // فتحِ حوارٍ يُرفض عند submit).
  const me = trpc.auth.me.useQuery();
  const canGrant = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? null) as PermissionMap | null,
    "hr",
    "FULL",
    ["manager"],
  );
  const [status, setStatus] = useState<"" | "ACTIVE" | "SETTLED" | "CANCELLED">("ACTIVE");
  const [empFilter, setEmpFilter] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [q, setQ] = useState("");
  const [grantOpen, setGrantOpen] = useState(false);

  const empOpts = trpc.employees.formOptions.useQuery();
  const branchesQ = trpc.branches.list.useQuery();

  const listInput = useMemo(
    () => ({
      status: (status || undefined) as "ACTIVE" | "SETTLED" | "CANCELLED" | undefined,
      employeeId: empFilter ? Number(empFilter) : undefined,
      branchId: branchFilter ? Number(branchFilter) : undefined,
    }),
    [status, empFilter, branchFilter],
  );
  const listQ = trpc.payroll.advancesList.useQuery(listInput);
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

  // أعمدة الجدول — تقرأ صلاحية المنح وحالة طفرة الإلغاء، فتُبنى في جسم المكوّن.
  const columns: ColumnDef<AdvanceRow, unknown>[] = [
    {
      id: "employee",
      header: "الموظف",
      accessorFn: (r) => r.employeeName,
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => (
        <div className="flex items-center gap-2.5">
          <EmpAvatar name={row.original.employeeName} sizePx={30} />
          <div>
            <div className="font-medium text-[13px]">{row.original.employeeName}</div>
            {(row.original.position || row.original.note) && (
              <div className="text-[11px] text-muted-foreground">{[row.original.position, row.original.note].filter(Boolean).join(" · ")}</div>
            )}
          </div>
        </div>
      ),
    },
    {
      id: "branch",
      header: "الفرع",
      accessorFn: (r) => r.branchName ?? "—",
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.branchName ?? "—"}</span>,
    },
    { id: "amount", header: "المبلغ", accessorFn: (r) => iqd(r.amount), meta: { kind: "money" }, cell: ({ row }) => iqd(row.original.amount) },
    {
      id: "remaining",
      header: "المتبقّي",
      accessorFn: (r) => iqd(r.remaining),
      meta: { kind: "money" },
      cell: ({ row }) => (
        <span className={`font-bold ${D(row.original.remaining).gt(0) && row.original.status === "ACTIVE" ? "text-money-negative" : ""}`}>
          {iqd(row.original.remaining)}
        </span>
      ),
    },
    {
      id: "monthlyDeduction",
      header: "الخصم الشهري",
      accessorFn: (r) => (r.monthlyDeduction != null ? iqd(r.monthlyDeduction) : "أقصى الممكن"),
      meta: { kind: "money" },
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.monthlyDeduction != null ? iqd(row.original.monthlyDeduction) : "أقصى الممكن"}</span>
      ),
    },
    {
      id: "voucherNumber",
      header: "سند الصرف",
      accessorFn: (r) => r.voucherNumber ?? "—",
      meta: { kind: "code", align: "center" },
      cell: ({ row }) => <span className="text-xs">{row.original.voucherNumber ?? "—"}</span>,
    },
    {
      id: "grantedAt",
      header: "التاريخ",
      accessorFn: (r) => fmtDate(r.grantedAt),
      meta: { kind: "date" },
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{fmtDate(row.original.grantedAt)}</span>,
    },
    {
      id: "status",
      header: "الحالة",
      accessorFn: (r) => STATUS_LABEL[r.status] ?? r.status,
      meta: { kind: "status" },
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => {
        const r = row.original;
        const cancellable = canGrant && r.status === "ACTIVE" && D(r.remaining).eq(D(r.amount));
        // سلفةٌ نشطة بدأ الخصم فيها: نُظهر «—» بتوضيح — لا نتركها فارغة صامتاً.
        const partiallyDeducted = r.status === "ACTIVE" && !D(r.remaining).eq(D(r.amount));
        if (cancellable) {
          return (
            <button
              className="text-xs text-destructive font-medium hover:underline inline-flex items-center gap-1"
              onClick={async () => {
                /*
                 * النصّ يطابق ما يفعله الخادم فعلياً — لا العكس. cancelAdvance (advancesService.ts)
                 * ترفض حين يكون سند الصرف سارياً (الحالة المعتادة لسلفةٍ صُرفت نقداً بسند فعليّ)،
                 * وتنجح مباشرةً فقط حين لا سريان له (بلا سندٍ أصلاً، أو معكوس/مرفوض مسبقاً). كان
                 * النصّ السابق يَعِد بالعكس: «تُلغى السلفة الآن، ثمّ ألغِ السند بنفسك لاحقاً» — وعداً
                 * لا يتحقّق في الحالة الشائعة، ورسالة الرفض الفعلية تصل المستخدم متناقضةً معه.
                 */
                const ok = await confirm({
                  variant: "danger",
                  title: `إلغاء سلفة ${r.employeeName}`,
                  description: r.voucherNumber
                    ? `تُلغى السلفة (${iqd(r.amount)} د.ع) مباشرةً فقط إن كان سند صرفها ${r.voucherNumber} غير سارٍ (معكوس أو مرفوض مسبقاً). إن كان السند سارياً (الحالة المعتادة لسلفةٍ صُرفت نقداً)، تُرفض المحاولة وتُطالَب بإلغاء السند ${r.voucherNumber} أولاً من شاشة السندات — يعتمده مراجعٌ آخر، وعندها تُلغى هذه السلفة تلقائياً معه.`
                    : `تُلغى السلفة (${iqd(r.amount)} د.ع) قبل أي خصم — لا سند صرفٍ مرتبط بها.`,
                  confirmText: "إلغاء السلفة",
                });
                if (ok) cancelM.mutate({ advanceId: Number(r.id) });
              }}
              disabled={cancelM.isPending}
            >
              <X className="size-3.5" aria-hidden /> إلغاء
            </button>
          );
        }
        if (partiallyDeducted) {
          return (
            <span
              className="text-xs text-muted-foreground"
              // Codex P1 (٢٤/٨): «سلفة معاكسة» نصيحةٌ ضارّة — grantAdvance يقبل موجباً فقط
              // ⇒ يُنشئ سنداً نقدياً OUT جديداً فيزيد الدين. المسار الصحيح: لوحةُ السداد
              // اليدويّ تحت الجدول (EmployeeAdvanceRepaymentPanel) أو الخصمُ المستمرّ.
              title="لا يُلغى بعد بدء الخصم — يُكمَل الاستيفاء بالخصم الشهريّ من الرواتب، أو بسداد يدويّ من لوحة السداد أسفل الجدول"
            >
              —
            </span>
          );
        }
        return null;
      },
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="سلف الموظفين"
        description="تُمنح السلفة بسند صرف حقيقي من الخزينة وتُخصم تلقائياً من مسيّرات الرواتب حتى التسوية."
        actions={
          canGrant ? (
            <Button onClick={() => setGrantOpen(true)}>
              <Plus className="size-4" aria-hidden /> منح سلفة
            </Button>
          ) : undefined
        }
      />

      <Card>
        <CardHeader>
          <ListToolbar
            title={
              <span className="flex items-center gap-2 text-base font-semibold">
                <HandCoins className="size-4 text-primary" aria-hidden />
                سلف الموظفين
              </span>
            }
            count={filtered.length}
            loading={listQ.isLoading}
            // ٢٤/٨ (Codex P2 على PR #760): لا `autoFocus` — الصفحةُ تبويبٌ داخل HrHub.
            search={{ value: q, onChange: setQ, placeholder: "بحث باسم الموظف أو رقم السند…" }}
            activeFilterCount={(status ? 1 : 0) + (empFilter ? 1 : 0) + (branchFilter ? 1 : 0)}
            onResetFilters={() => { setQ(""); setStatus(""); setEmpFilter(""); setBranchFilter(""); }}
            onRefresh={() => void refresh()}
            refreshing={listQ.isFetching}
            exportSpec={{
              filename: "سلف-الموظفين",
              rows: filtered,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "employeeName", header: "الموظف" }, { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
                { key: "amount", header: "المبلغ", map: (r) => toExcelMoney(r.amount) },
                { key: "remaining", header: "المتبقّي", map: (r) => toExcelMoney(r.remaining) },
                { key: "monthlyDeduction", header: "الخصم الشهري", map: (r) => (r.monthlyDeduction != null ? toExcelMoney(r.monthlyDeduction) : "") },
                { key: "voucherNumber", header: "سند الصرف", map: (r) => r.voucherNumber ?? "" },
                { key: "grantedAt", header: "التاريخ", map: (r) => fmtDate(r.grantedAt) },
                { key: "status", header: "الحالة", map: (r) => STATUS_LABEL[r.status] ?? r.status },
              ],
            }}
            filters={<div className="flex items-end gap-2 flex-wrap">
              <FilterField label="الحالة">
                <AppSelect className="h-9" value={status} onValueChange={(next) => setStatus(next as typeof status)} aria-label="حالة السلفة">
                  <option value="">كل الحالات</option>
                  <option value="ACTIVE">نشطة</option>
                  <option value="SETTLED">مسوّاة</option>
                  <option value="CANCELLED">ملغاة</option>
                </AppSelect>
              </FilterField>
              <FilterField label="الموظف">
                <AppSelect className="h-9" value={empFilter} onValueChange={(next) => setEmpFilter(next)} aria-label="الموظف">
                  <option value="">كل الموظفين</option>
                  {(empOpts.data?.managers ?? []).map((m) => <option key={m.id} value={String(m.id)}>{m.name}</option>)}
                </AppSelect>
              </FilterField>
              <FilterField label="الفرع">
                <AppSelect className="h-9" value={branchFilter} onValueChange={(next) => setBranchFilter(next)} aria-label="الفرع">
                  <option value="">كل الفروع</option>
                  {(branchesQ.data ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
                </AppSelect>
              </FilterField>
            </div>}
          />
          <div className="text-xs text-muted-foreground mt-1">
            {listQ.isLoading ? "" : `إجمالي ${iqd(totals.amount)} د.ع، المتبقّي النشط ${iqd(totals.remaining)} د.ع`}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* البحث في ListToolbar أعلاه (يغذّي `filtered`) ⇒ `searchable={false}` وإلّا ظهر حقلا بحث.
              و`externalFiltersActive` = «للقائمة الأصل صفوفٌ لكن المعروض فارغ» ⇒ الفراغُ سببه
              البحث لا خلوّ السجلّ — نفس تمييز الرسالتين في الجدول الخامّ. */}
          <DataTable<AdvanceRow>
            columns={columns}
            data={filtered}
            searchable={false}
            externalFiltersActive={rows.length > 0}
            /* ٢/٩ — استعادةُ سلوك الجدول الخامّ: كان يعرض **كلّ** صفوف `filtered` داخل
               `ScrollTableShell` (تمريرٌ داخليّ بترويسةٍ لاصقة) بلا ترقيمٍ إطلاقاً. وبالتحويل
               وَرِث افتراضَ `DataTable` (٥٠ صفّاً/صفحة) فصارت السلفُ بعد الخمسين خلف صفحةٍ
               ثانية — ترقيمٌ لم تطلبه الشاشة ويُربك قارئها: العدُّ والمجاميع في الترويسة
               محسوبان على `filtered` كاملةً، فصفحةٌ جزئيّة تحت مجموعٍ كلّيّ تُوحي أنّ المعروض
               هو المحسوب. و`bounded` الافتراضيّة تُبقي التمرير الداخليّ نفسه، فلا تنمو الصفحة.
               نفس اختيار أشقّائها في هذه الموجة (`Leaves` و`Payroll`). */
            pageSize={Infinity}
            loading={listQ.isLoading}
            errorState={{ isError: listQ.isError, message: listQ.error?.message, onRetry: () => void listQ.refetch() }}
            emptyState="لا سلف بعد. امنح سلفة للبدء — تُخصم تلقائياً من الرواتب."
            emptyFilteredState="لا نتائج مطابقة للبحث."
          />
        </CardContent>
      </Card>

      <EmployeeAdvanceRepaymentPanel />

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

  // عَتبة الاعتماد (الخادم هو المرجع؛ القيمة هنا للتنبيه المسبق فقط). لا عَتبة مُرفق — المُرفق اختياريّ (٣١/٧).
  const thresholdsQ = trpc.payroll.advanceThresholds.useQuery(undefined, { enabled: open });
  const approvalThreshold = thresholdsQ.data?.approval ?? 1_000_000;
  const overApproval = D(amount || 0).gte(D(approvalThreshold));

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
    !!employeeId && !!amount && D(amount || 0).gt(0) && !overApproval && !grantM.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>منح سلفة موظف</DialogTitle></DialogHeader>
        <div className="space-y-3 py-1">
          <div>
            <Label htmlFor="adv-emp">الموظف</Label>
            <AppSelect id="adv-emp" className={`${selectClsSm} w-full h-9`} value={employeeId} onValueChange={(next) => setEmployeeId(next)}>
              <option value="">اختر موظفاً…</option>
              {emps.map((e) => (
                <option key={e.id} value={String(e.id)}>
                  {e.fullName}{e.branchName ? ` — ${e.branchName}` : ""}
                </option>
              ))}
            </AppSelect>
            {!!employeeId && balQ.data && D(balQ.data.balance).gt(0) && (
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
            <Label>مُرفق سند الصرف (اختياري)</Label>
            <ImageUploader
              value={attachmentImages}
              onChange={setAttachmentImages}
              maxItems={1}
              maxSizeMB={2}
              singlePrimary={false}
              hint="صورة إيصال الاستلام/التعهّد — اختيارية."
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
