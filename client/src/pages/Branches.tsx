// شاشة إدارة الفروع (إضافة/تعديل/تعطيل) — للمدير العام فقط. لا حذف صلب — الفرع مرجع تاريخي لعشرات
// الجداول (فواتير/حركات مخزون/ورديات...)، فقط تعطيل منطقي يُخفيه من منتقيات العمليات الجديدة.
// التعطيل محروس خادمياً: يُرفض إن كان آخر فرع نشط أو لا يزال يحمل مخزوناً فعلياً.
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ListToolbar, RowActions } from "@/components/list";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "@/components/PageHeader";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { Plus } from "lucide-react";
import { useMemo, useRef, useState } from "react";

type BranchRow = RouterOutputs["branches"]["adminList"][number];
type BranchType = "MAIN" | "SALES";

const TYPE_LABEL: Record<string, string> = { MAIN: "رئيسي (كل الخدمات)", SALES: "مبيعات" };
// Codex P2 (٢٤/٨ على PR #760): النوعُ **تصنيفٌ إداريّ للتنظيم** لا حرّاسٌ خادميّ — بوّابات
// كاشيرَي الطباعة/الاستقبال تعتمد على الدور وصلاحيّة الوحدة والفرع المُسنَد فقط، لا تقرأ
// `branches.type`. نصفُ الاستعمالَ الشائع لا الحرمانَ التقنيّ.
const TYPE_TITLE: Record<string, string> = {
  MAIN: "الفرع الرئيسي — تصنيفٌ إداريّ للفرع الذي تُدار منه كل الخدمات (طباعة/استقبال/تجزئة/تحويلات/شراء)",
  SALES: "فرع مبيعات — تصنيفٌ إداريّ لفرع بيع تجزئة رئيسي (الوصول للخدمات محكومٌ بأدوار المستخدمين لا بنوع الفرع)",
};

export default function Branches() {
  const utils = trpc.useUtils();
  const list = trpc.branches.adminList.useQuery();
  const rows = list.data ?? [];
  const [query, setQuery] = useState("");
  const visibleRows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return q ? rows.filter((b) => [b.name, b.code, b.address, b.phone, TYPE_LABEL[b.type]].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q))) : rows;
  }, [rows, query]);

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [fName, setFName] = useState("");
  const [fCode, setFCode] = useState("");
  const [fType, setFType] = useState<BranchType>("SALES");
  const [fAddress, setFAddress] = useState("");
  const [fPhone, setFPhone] = useState("");

  // خط أساس الحوار عند فتحه (إضافة=فارغ، تعديل=قيم الفرع الأصلية) — يقارَن بالحالة الحالية
  // لتحديد وجود تعديلات غير محفوظة، فيُحذَّر منها عند إغلاق الحوار بنقرة خارجية/Esc بدل إغلاقه صامتاً.
  const formBaselineRef = useRef({ name: "", code: "", type: "SALES" as BranchType, address: "", phone: "" });
  const isFormDirty =
    fName !== formBaselineRef.current.name ||
    fCode !== formBaselineRef.current.code ||
    fType !== formBaselineRef.current.type ||
    fAddress !== formBaselineRef.current.address ||
    fPhone !== formBaselineRef.current.phone;
  useUnsavedGuard(formOpen && isFormDirty);
  const closeGuardBusyRef = useRef(false);
  async function requestFormClose() {
    if (!isFormDirty) { setFormOpen(false); return; }
    if (closeGuardBusyRef.current) return;
    closeGuardBusyRef.current = true;
    try {
      const ok = await confirm({
        variant: "warning",
        title: "إغلاق النموذج",
        description: "توجد تعديلات غير محفوظة على الفرع — ستُفقد عند الإغلاق. هل تتابع؟",
        confirmText: "إغلاق بلا حفظ",
        cancelText: "بقاء",
      });
      if (ok) setFormOpen(false);
    } finally {
      closeGuardBusyRef.current = false;
    }
  }

  function invalidateAll() {
    void utils.branches.adminList.invalidate();
    void utils.branches.list.invalidate();
  }

  const createMut = trpc.branches.create.useMutation({
    onSuccess: () => { invalidateAll(); setFormOpen(false); notify.ok("أُضيف الفرع"); },
    onError: (e) => notify.err(e),
  });
  const updateMut = trpc.branches.update.useMutation({
    onSuccess: () => { invalidateAll(); setFormOpen(false); notify.ok("تُحفظت التعديلات"); },
    onError: (e) => notify.err(e),
  });
  const setActive = trpc.branches.setActive.useMutation({
    onSuccess: () => invalidateAll(),
    onError: (e) => notify.err(e),
  });

  function openAdd() {
    setEditId(null);
    setFName(""); setFCode(""); setFType("SALES"); setFAddress(""); setFPhone("");
    formBaselineRef.current = { name: "", code: "", type: "SALES", address: "", phone: "" };
    setFormOpen(true);
  }
  function openEdit(b: BranchRow) {
    setEditId(b.id);
    setFName(b.name); setFCode(b.code); setFType(b.type); setFAddress(b.address ?? ""); setFPhone(b.phone ?? "");
    formBaselineRef.current = { name: b.name, code: b.code, type: b.type, address: b.address ?? "", phone: b.phone ?? "" };
    setFormOpen(true);
  }
  function submitForm() {
    const name = fName.trim();
    const code = fCode.trim();
    if (!name) return notify.err("اسم الفرع مطلوب");
    if (!code) return notify.err("رمز الفرع مطلوب");
    const payload = { name, code, type: fType, address: fAddress.trim() || null, phone: fPhone.trim() || null };
    if (editId == null) createMut.mutate(payload);
    else updateMut.mutate({ id: editId, ...payload });
  }

  async function toggle(b: BranchRow) {
    if (b.isActive) {
      if (!(await confirm({
        variant: "danger",
        title: "تعطيل الفرع",
        description: `لن يظهر «${b.name}» في منتقيات العمليات الجديدة (بيع/تحويل/شراء). يُرفض التعطيل تلقائياً إن كان آخر فرع نشط أو لا يزال يحمل مخزوناً. متابعة؟`,
        confirmText: "تعطيل",
      }))) return;
    }
    setActive.mutate({ id: b.id, isActive: !b.isActive });
  }

  // طباعة A4 بهوية المستند بدل window.print() (كان يطبع الشاشة بشريط الأدوات والقائمة الجانبية).
  // نفس صفوف الجدول المعروضة (visibleRows بعد البحث) ونفس أعمدته — بلا استعلامٍ جديد.
  function printBranches() {
    printReportDoc({
      title: "قائمة الفروع",
      headerExtra: [
        { label: "عدد الفروع", value: visibleRows.length.toLocaleString("ar-IQ-u-nu-latn") },
        { label: "البحث", value: query.trim() || "بلا بحث" },
      ],
      columns: [
        { key: "name", label: "الاسم" },
        { key: "code", label: "الرمز" },
        { key: "type", label: "النوع" },
        { key: "address", label: "العنوان" },
        { key: "phone", label: "الهاتف" },
        { key: "isActive", label: "الحالة", align: "center" },
      ],
      rows: visibleRows.map((b) => ({
        name: b.name,
        code: b.code,
        type: TYPE_LABEL[b.type] ?? b.type,
        address: b.address || "—",
        phone: b.phone || "—",
        isActive: b.isActive ? "مفعّل" : "معطّل",
      })),
      emptyText: "لا فروع مطابقة.",
    });
  }

  // الأعمدة تُبنى داخل العَرض لأنّها تُغلِق على `openEdit`/`toggle` وحالة `setActive.isPending`.
  const columns: ColumnDef<BranchRow, unknown>[] = [
    { id: "name", header: "الاسم", accessorFn: (b) => b.name, cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    { id: "code", header: "الرمز", accessorFn: (b) => b.code, meta: { kind: "code", width: "id" }, cell: ({ row }) => row.original.code },
    {
      id: "type",
      header: "النوع",
      accessorFn: (b) => TYPE_LABEL[b.type] ?? b.type,
      cell: ({ row }) => (
        /* استباقاً لـCodex #764: `Popover` بدل `Tooltip` — يفتح بالنقر/التاب/Enter/Space
           فيصلُ لمستعمِلي اللمس أيضاً (Radix Tooltip يفشل على اللمس لأنّ pointer-down
           يُخفي focus-open). زرٌّ دلاليّاً بدل span، بـ`aria-label` لقارئ الشاشة. */
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`ما معنى «${TYPE_LABEL[row.original.type] ?? row.original.type}»؟`}
              className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2 outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm text-start"
            >
              {TYPE_LABEL[row.original.type] ?? row.original.type}
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" className="max-w-xs text-xs">
            {TYPE_TITLE[row.original.type] ?? TYPE_LABEL[row.original.type] ?? row.original.type}
          </PopoverContent>
        </Popover>
      ),
    },
    {
      id: "address",
      header: "العنوان",
      accessorFn: (b) => b.address || "—",
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.address || "—"}</span>,
    },
    {
      id: "phone",
      header: "الهاتف",
      accessorFn: (b) => b.phone || "—",
      meta: { kind: "phone" },
      cell: ({ row }) => <span className="text-xs">{row.original.phone || "—"}</span>,
    },
    {
      id: "isActive",
      header: "الحالة",
      accessorFn: (b) => (b.isActive ? "مفعّل" : "معطّل"),
      meta: { kind: "status" },
      cell: ({ row }) => (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={row.original.isActive ? "شرح: الفرع مفعّل" : "شرح: الفرع معطّل"}
              className={`inline-block cursor-help rounded-full px-2 py-0.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring hover:opacity-80 ${row.original.isActive ? "badge-status-active" : "badge-stock-out"}`}
            >
              {row.original.isActive ? "مفعّل" : "معطّل"}
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" className="max-w-xs text-xs">
            {row.original.isActive
              ? "الفرع نشط — يظهر في منتقيات العمليات الجديدة."
              : "الفرع معطّل — مستثنى من المنتقيات؛ العمليات التاريخية المرتبطة به تبقى بلا مسّ."}
          </PopoverContent>
        </Popover>
      ),
    },
    {
      id: "actions",
      header: "إجراء",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => (
        <RowActions
          actions={[
            {
              key: "edit",
              kind: "edit",
              label: "تعديل",
              onSelect: () => openEdit(row.original),
              gate: { adminOnly: true },
            },
            {
              key: "toggle",
              kind: "approve",
              label: row.original.isActive ? "تعطيل" : "تفعيل",
              variant: row.original.isActive ? "destructive" : "default",
              disabled: setActive.isPending,
              disabledReason: "توجد عملية تحديث قيد التنفيذ",
              onSelect: () => void toggle(row.original),
              gate: { adminOnly: true },
            },
          ]}
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="الفروع"
        description="فروع المنشأة (رئيسي/مبيعات) — لكل فرع مخزونه ومستخدموه. لا حذف صلب، فقط تعطيل؛ يُمنع تعطيل آخر فرع نشط أو فرع لا يزال يحمل مخزوناً."
        actions={<Button size="sm" onClick={openAdd}><Plus className="size-4" /> فرع جديد</Button>}
      />

      <Card>
        <CardHeader>
          <ListToolbar
            title="قائمة الفروع"
            count={visibleRows.length}
            loading={list.isLoading}
            // Codex P2 (٢٤/٨): لا `autoFocus` هنا — الصفحةُ تبويبٌ داخل AdminHub. `autoFocus` يسرق
            // التركيزَ من زرّ التبويب فور التركيب فيكسر ملاحةَ الأسهم بين التبويبات لمستعمِلي
            // لوحة المفاتيح. الشاشات المستقلّة (Suppliers/Employees/…) تحتفظ به.
            search={{ value: query, onChange: setQuery, placeholder: "اسم الفرع، الرمز، العنوان أو الهاتف…" }}
            onResetFilters={() => setQuery("")}
            onRefresh={() => void list.refetch()}
            refreshing={list.isFetching}
            onPrint={printBranches}
            exportSpec={{
              filename: "الفروع",
              rows: visibleRows,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "name", header: "الاسم" }, { key: "code", header: "الرمز" },
                { key: "type", header: "النوع", map: (b) => TYPE_LABEL[b.type] ?? b.type },
                { key: "address", header: "العنوان" }, { key: "phone", header: "الهاتف" },
                { key: "isActive", header: "الحالة", map: (b) => b.isActive ? "مفعّل" : "معطّل" },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<BranchRow>
            columns={columns}
            data={visibleRows}
            /* البحث في ListToolbar أعلاه (يغذّي visibleRows) — بلا هذا يظهر حقلا بحثٍ متجاوران. */
            searchable={false}
            externalFiltersActive={query.trim() !== ""}
            loading={list.isLoading}
            errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => void list.refetch() }}
            getRowClassName={(b) => (b.isActive ? undefined : "opacity-60")}
            emptyText="لا فروع بعد — أضِف أوّل فرع بزرّ «فرع جديد» أعلاه."
            emptyFilteredState={
              <div className="space-y-2">
                <div>لا فروع مطابقة للبحث «{query}».</div>
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  مسح البحث
                </Button>
              </div>
            }
          />
        </CardContent>
      </Card>

      <Dialog open={formOpen} onOpenChange={(open) => { if (open) setFormOpen(true); else void requestFormClose(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId == null ? "إضافة فرع" : "تعديل فرع"}</DialogTitle>
            <DialogDescription>الرمز فريد، بأحرف/أرقام إنجليزية أو (-/_) فقط — مثال: SALES-2.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">اسم الفرع</label>
                <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="فرع الكرادة" dir="auto" autoFocus />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">الرمز</label>
                <Input value={fCode} onChange={(e) => setFCode(e.target.value.toUpperCase())} placeholder="SALES-2" dir="ltr" className="font-mono" />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">النوع</label>
              <AppSelect
                value={fType}
                onValueChange={(next) => setFType(next as BranchType)}
                className="h-9 border-input px-3 text-sm"
              >
                <option value="SALES">مبيعات</option>
                <option value="MAIN">رئيسي (كل الخدمات)</option>
              </AppSelect>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">العنوان (اختياري)</label>
              <Textarea rows={2} value={fAddress} onChange={(e) => setFAddress(e.target.value)} placeholder="العنوان التفصيلي…" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">الهاتف (اختياري)</label>
              <IntlPhoneInput value={fPhone} onChange={setFPhone} ariaLabel="هاتف الفرع" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => void requestFormClose()}>إلغاء</Button>
            <Button size="sm" onClick={submitForm} disabled={createMut.isPending || updateMut.isPending}>
              {createMut.isPending || updateMut.isPending ? ACTION_LABELS.saving : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
