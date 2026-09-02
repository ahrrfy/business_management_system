// محافظ المزوّدين مسبقي الدفع: رصيد الشركة لدى جهاز/حساب المزوّد لكل فرع.
// الإيداع والسحب والتسوية ليست هنا (شريحة لاحقة) — هذه الشاشة تُعرّف المحفظة وتعرض رصيدها.
import { PageHeader } from "@/components/PageHeader";
import { ListToolbar, RowActions } from "@/components/list";
import { DataTable } from "@/components/data-table/DataTable";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { D, fmtAr } from "@/lib/money";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { AlertTriangle, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import {
  WalletAdjustDialog, WalletMoveDialog, WalletReconcileDialog, WalletStatementDialog,
} from "./WalletOpsDialogs";

type WalletRow = RouterOutputs["digitalCards"]["wallets"]["list"][number];

export default function DigitalWallets() {
  const utils = trpc.useUtils();
  const list = trpc.digitalCards.wallets.list.useQuery();
  const providers = trpc.digitalCards.providers.list.useQuery();
  const branches = trpc.branches.list.useQuery();
  const rows = list.data ?? [];
  const [query, setQuery] = useState("");
  const visibleRows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return q ? rows.filter((w) => [w.name, w.code, w.providerName, w.branchName].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q))) : rows;
  }, [rows, query]);

  // المحافظ للمزوّدين مسبقي الدفع فقط — الخادم يرفض غيرهم، والواجهة لا تعرضهم أصلاً.
  const prepaidProviders = (providers.data ?? []).filter((p) => p.settlementMode === "PREPAID" && p.isActive);

  // حوارات عمليات الرصيد (ش٩) — كلٌّ يحمل المحفظة المستهدفة أو null.
  const [moving, setMoving] = useState<{ wallet: WalletRow; mode: "deposit" | "withdraw" } | null>(null);
  const [adjusting, setAdjusting] = useState<WalletRow | null>(null);
  const [reconciling, setReconciling] = useState<WalletRow | null>(null);
  const [viewing, setViewing] = useState<WalletRow | null>(null);

  const lowBalance = trpc.digitalCards.wallets.lowBalance.useQuery();

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [fProviderId, setFProviderId] = useState("");
  const [fBranchId, setFBranchId] = useState("");
  const [fCode, setFCode] = useState("");
  const [fName, setFName] = useState("");

  function invalidate() {
    void utils.digitalCards.wallets.list.invalidate();
  }

  const createMut = trpc.digitalCards.wallets.create.useMutation({
    onSuccess: () => { invalidate(); setFormOpen(false); notify.ok("أُضيفت المحفظة"); },
    onError: (e) => notify.err(e),
  });
  const updateMut = trpc.digitalCards.wallets.update.useMutation({
    onSuccess: () => { invalidate(); setFormOpen(false); notify.ok("حُفظت التعديلات"); },
    onError: (e) => notify.err(e),
  });
  const toggleMut = trpc.digitalCards.wallets.update.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => notify.err(e),
  });

  function openAdd() {
    setEditId(null);
    setFProviderId(""); setFBranchId(""); setFCode(""); setFName("");
    setFormOpen(true);
  }

  function openEdit(w: WalletRow) {
    setEditId(w.id);
    setFProviderId(String(w.providerId)); setFBranchId(String(w.branchId));
    setFCode(w.code); setFName(w.name);
    setFormOpen(true);
  }

  function submitForm() {
    const name = fName.trim();
    if (!name) return notify.err("اسم المحفظة مطلوب");
    if (editId != null) { updateMut.mutate({ id: editId, name }); return; }

    const providerId = Number(fProviderId);
    const branchId = Number(fBranchId);
    const code = fCode.trim();
    if (!providerId) return notify.err("اختر المزوّد");
    if (!branchId) return notify.err("اختر الفرع");
    if (!code) return notify.err("رمز المحفظة مطلوب");
    createMut.mutate({ providerId, branchId, code, name });
  }

  async function toggle(w: WalletRow) {
    if (w.isActive && (!D(w.currentBalance).isZero() || !D(w.reservedBalance).isZero())) {
      notify.err("لا يمكن تعطيل المحفظة قبل تصفير الرصيد وإنهاء كل الحجوزات");
      return;
    }
    if (w.isActive && !(await confirm({
      variant: "danger",
      title: "تعطيل المحفظة",
      description: `لن تُستخدم «${w.name}» في مبيعات جديدة. لا يُسمح بالتعطيل إلا بعد تصفير الرصيد والحجوزات وإنهاء الحركات المعلقة. متابعة؟`,
      confirmText: "تعطيل",
    }))) return;
    toggleMut.mutate({ id: w.id, isActive: !w.isActive });
  }

  // طباعة A4 بهوية المستند بدل window.print() (كان يطبع الشاشة بشريط الأدوات والقائمة الجانبية).
  // نفس صفوف الجدول المعروضة بعد البحث (visibleRows) ونفس أعمدته وتسمياتها وتنسيق أموالها
  // (fmtAr) — بلا استعلامٍ جديد ولا حسابٍ مغاير: «متاح للبيع» يُشتقّ هنا كما يُشتقّ في الخليّة.
  function printWallets() {
    printReportDoc({
      title: "أرصدة أجهزة المزوّدين",
      headerExtra: [
        { label: "عدد المحافظ", value: visibleRows.length.toLocaleString("ar-IQ-u-nu-latn") },
        { label: "البحث", value: query.trim() || "بلا بحث" },
      ],
      columns: [
        { key: "name", label: "المحفظة" },
        { key: "code", label: "الرمز" },
        { key: "provider", label: "المزوّد" },
        { key: "branch", label: "الفرع" },
        // ⚠️ مفاتيح الأعمدة المالية الثلاثة يجب أن تطابق كاشف المال في `docTableV2`
        // (/price|total|tax|amount|debit|credit|balance|remaining|paid/i) — هو ما يمنح الخليّة
        // عزلَ الاتّجاه (direction:ltr) وأرقاماً جدولية وثِخَناً. «reserved»/«available» لا
        // يطابقانه ⇒ عمودان من ثلاثة يفقدان معاملة المال على الورق بينما الشاشة تُعطي
        // meta:{kind:"money"} للثلاثة. اللاحقة «Balance» تُوائمهما مع الشاشة.
        { key: "balance", label: "الرصيد", align: "left" },
        { key: "reservedBalance", label: "معلّق لعمليات بيع", align: "left" },
        { key: "availableBalance", label: "متاح للبيع", align: "left" },
        { key: "status", label: "الحالة", align: "center" },
      ],
      rows: visibleRows.map((w) => ({
        name: w.name,
        code: w.code,
        provider: w.providerName,
        branch: w.branchName,
        balance: fmtAr(w.currentBalance),
        reservedBalance: fmtAr(w.reservedBalance),
        availableBalance: fmtAr(D(w.currentBalance).minus(D(w.reservedBalance)).toFixed(2)),
        status: w.isActive ? "مفعّلة" : "معطّلة",
      })),
      emptyText: "لا محافظ مطابقة.",
    });
  }

  const saving = createMut.isPending || updateMut.isPending;
  const editing = editId != null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="أرصدة أجهزة المزوّدين"
        description="يعرض ما دفعناه مسبقاً لكل جهاز مزوّد، وما عُلّق لعمليات بيع لم تكتمل، وما يمكن البيع به الآن."
        actions={
          <Button size="sm" onClick={openAdd} disabled={prepaidProviders.length === 0}>
            <Plus className="size-4" /> محفظة جديدة
          </Button>
        }
      />

      {(lowBalance.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center gap-2 text-sm font-medium">
            <AlertTriangle aria-hidden className="size-4" />
            محافظ رصيدها المتاح تحت حدّ التنبيه ({lowBalance.data?.length})
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 pb-4">
            {(lowBalance.data ?? []).map((l) => (
              <span key={l.walletId} className="rounded-md border px-3 py-1.5 text-sm">
                {l.walletName} — <span className="tabular-nums font-medium">{fmtAr(D(l.currentBalance).minus(D(l.reservedBalance)).toFixed(2))}</span>
                <span className="text-muted-foreground"> / الحدّ {fmtAr(l.threshold)}</span>
              </span>
            ))}
          </CardContent>
        </Card>
      )}

      {prepaidProviders.length === 0 && !providers.isLoading && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            لا مزوّدين مسبقي الدفع مفعّلين — المحافظ تخصّ نمط «مسبق الدفع» وحده. عرّف مزوّداً بهذا النمط من تبويب المزوّدين أوّلاً.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <ListToolbar
            title="قائمة المحافظ"
            count={visibleRows.length}
            loading={list.isLoading}
            search={{ value: query, onChange: setQuery, placeholder: "المحفظة، الرمز، المزوّد أو الفرع…" }}
            onResetFilters={() => setQuery("")}
            onRefresh={() => { void list.refetch(); void lowBalance.refetch(); }}
            refreshing={list.isFetching || lowBalance.isFetching}
            onPrint={printWallets}
            exportSpec={{
              filename: "محافظ-المزودين",
              rows: visibleRows,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "name", header: "المحفظة" }, { key: "code", header: "الرمز" },
                { key: "providerName", header: "المزوّد" }, { key: "branchName", header: "الفرع" },
                { key: "currentBalance", header: "الرصيد", money: true },
                { key: "reservedBalance", header: "المحجوز", money: true },
                { key: "isActive", header: "الحالة", map: (w) => w.isActive ? "مفعّلة" : "معطّلة" },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<WalletRow>
            data={visibleRows}
            loading={list.isLoading}
            errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => void list.refetch() }}
            /* البحث في ListToolbar أعلاه (يغذّي visibleRows) — بلا هذا يظهر حقلا بحثٍ متجاوران. */
            searchable={false}
            externalFiltersActive={query.trim() !== ""}
            getRowClassName={(w) => (w.isActive ? undefined : "opacity-60")}
            emptyText="لا محافظ بعد — أضِف محفظة لكل جهاز مزوّد في كل فرع."
            emptyFilteredState="لا محفظة تطابق البحث."
            columns={[
              { id: "name", header: "المحفظة", accessorFn: (w) => w.name, cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
              // kind: "code" يتكفّل بالخطّ الأحاديّ وعزل الاتّجاه ⇒ لا dir="ltr" ولا font-mono يدويّين.
              { id: "code", header: "الرمز", accessorFn: (w) => w.code, meta: { kind: "code" }, cell: ({ row }) => <span className="text-xs">{row.original.code}</span> },
              { id: "provider", header: "المزوّد", accessorFn: (w) => w.providerName, cell: ({ row }) => row.original.providerName },
              { id: "branch", header: "الفرع", accessorFn: (w) => w.branchName, cell: ({ row }) => <span className="text-muted-foreground">{row.original.branchName}</span> },
              { id: "balance", header: "الرصيد", accessorFn: (w) => fmtAr(w.currentBalance), meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.currentBalance) },
              {
                id: "reserved",
                header: "معلّق لعمليات بيع",
                accessorFn: (w) => fmtAr(w.reservedBalance),
                meta: { kind: "money" },
                cell: ({ row }) => <span className="text-muted-foreground">{fmtAr(row.original.reservedBalance)}</span>,
              },
              {
                id: "available",
                header: "متاح للبيع",
                accessorFn: (w) => fmtAr(D(w.currentBalance).minus(D(w.reservedBalance)).toFixed(2)),
                meta: { kind: "money" },
                cell: ({ row }) => (
                  <span className="font-medium">{fmtAr(D(row.original.currentBalance).minus(D(row.original.reservedBalance)).toFixed(2))}</span>
                ),
              },
              {
                id: "status",
                header: "الحالة",
                // التسمية المعروضة لا العلم الخامّ — «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
                accessorFn: (w) => (w.isActive ? "مفعّلة" : "معطّلة"),
                meta: { kind: "status" },
                cell: ({ row }) => (
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${row.original.isActive ? "badge-status-active" : "badge-stock-out"}`}>
                    {row.original.isActive ? "مفعّلة" : "معطّلة"}
                  </span>
                ),
              },
              {
                id: "actions",
                header: "إجراء",
                enableSorting: false,
                meta: { kind: "actions" },
                cell: ({ row }) => {
                  const w = row.original;
                  return (
                    <RowActions
                      actions={[
                        {
                          key: "deposit",
                          kind: "pay",
                          label: "تسجيل شحن رصيد",
                          disabled: !w.isActive,
                          disabledReason: "المحفظة معطّلة",
                          onSelect: () => setMoving({ wallet: w, mode: "deposit" }),
                          gate: { roles: ["manager"], module: "digital_cards", level: "FULL" },
                        },
                        {
                          key: "withdraw",
                          kind: "pay",
                          label: "تسجيل سحب رصيد",
                          disabled: !w.isActive,
                          disabledReason: "المحفظة معطّلة",
                          onSelect: () => setMoving({ wallet: w, mode: "withdraw" }),
                          gate: { roles: ["manager"], module: "digital_cards", level: "FULL" },
                        },
                        {
                          key: "statement",
                          kind: "view",
                          label: "كشف الحساب",
                          onSelect: () => setViewing(w),
                          gate: { roles: ["manager", "accountant", "auditor"], module: "digital_cards", level: "READ" },
                        },
                        {
                          key: "reconcile",
                          kind: "approve",
                          label: "مطابقة مع الجهاز",
                          disabled: !w.isActive,
                          disabledReason: "المحفظة معطّلة؛ كشف الحساب متاح للقراءة",
                          onSelect: () => setReconciling(w),
                          gate: { roles: ["manager"], module: "digital_cards", level: "FULL" },
                        },
                        {
                          key: "adjust",
                          kind: "approve",
                          label: "طلب تصحيح الرصيد",
                          disabled: !w.isActive,
                          disabledReason: "المحفظة معطّلة",
                          onSelect: () => setAdjusting(w),
                          gate: { roles: ["manager"], module: "digital_cards", level: "FULL" },
                        },
                        {
                          key: "edit",
                          kind: "edit",
                          label: "تعديل البيانات",
                          onSelect: () => openEdit(w),
                          gate: { roles: ["manager"], module: "digital_cards", level: "FULL" },
                        },
                        {
                          key: "toggle",
                          kind: "approve",
                          label: w.isActive ? "تعطيل" : "تفعيل",
                          variant: w.isActive ? "destructive" : "default",
                          disabled: toggleMut.isPending || (w.isActive && (!D(w.currentBalance).isZero() || !D(w.reservedBalance).isZero())),
                          disabledReason: toggleMut.isPending
                            ? "توجد عملية تحديث قيد التنفيذ"
                            : "صفّر الرصيد وأنهِ الحجوزات أولاً",
                          onSelect: () => void toggle(w),
                          gate: { roles: ["manager"], module: "digital_cards", level: "FULL" },
                        },
                      ]}
                    />
                  );
                },
              },
            ]}
          />
        </CardContent>
      </Card>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "تعديل محفظة" : "إضافة محفظة"}</DialogTitle>
            <DialogDescription>
              المزوّد والفرع والرمز لا تتغيّر بعد الإنشاء — الرصيد وحركاته مربوطة بها. الرمز فريد داخل (المزوّد × الفرع).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="dw-provider">المزوّد</label>
                <AppSelect
                  id="dw-provider"
                  value={fProviderId}
                  disabled={editing}
                  onValueChange={setFProviderId}
                >
                  <option value="">— اختر المزوّد —</option>
                  {prepaidProviders.map((p) => (
                    <option key={p.id} value={String(p.id)}>{p.supplierName}</option>
                  ))}
                </AppSelect>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="dw-branch">الفرع</label>
                <AppSelect
                  id="dw-branch"
                  value={fBranchId}
                  disabled={editing}
                  onValueChange={setFBranchId}
                >
                  <option value="">— اختر الفرع —</option>
                  {(branches.data ?? []).map((b) => (
                    <option key={b.id} value={String(b.id)}>{b.name}</option>
                  ))}
                </AppSelect>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">الرمز</label>
                <Input
                  value={fCode}
                  disabled={editing}
                  onChange={(e) => setFCode(e.target.value.toUpperCase())}
                  placeholder="DEV-1"
                  dir="ltr"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">الاسم</label>
                <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="جهاز الكاشير الرئيسي" dir="auto" autoFocus />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setFormOpen(false)}>إلغاء</Button>
            <Button size="sm" onClick={submitForm} disabled={saving}>
              {saving ? ACTION_LABELS.saving : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* عمليات الرصيد (ش٩) */}
      <WalletMoveDialog
        wallet={moving?.wallet ?? null}
        mode={moving?.mode ?? "deposit"}
        onClose={() => setMoving(null)}
      />
      <WalletAdjustDialog wallet={adjusting} onClose={() => setAdjusting(null)} />
      <WalletReconcileDialog wallet={reconciling} onClose={() => setReconciling(null)} />
      <WalletStatementDialog wallet={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
