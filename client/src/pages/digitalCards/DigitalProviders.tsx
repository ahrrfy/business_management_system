// مزوّدو البطاقات الرقمية والاشتراكات — كل مزوّد يرثُ مورّداً قائماً في المنظومة (ذمّته وكشفه).
// نمط التسوية هو القرار المالي الحاكم: PREPAID (محفظة رصيد لدى المزوّد) أو POSTPAID (ذمّة دائنة).
import { PageHeader } from "@/components/PageHeader";
import { RowActions } from "@/components/list";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MoneyInput } from "@/components/form/MoneyInput";
import { EntityPicker } from "@/components/invoice/EntityPicker";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fmtAr } from "@/lib/money";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";

type ProviderRow = RouterOutputs["digitalCards"]["providers"]["list"][number];

const PROVIDER_TYPE: Record<string, string> = {
  TELECOM: "اتصالات",
  GLOBAL_CARDS: "بطاقات عالمية",
  EDUCATIONAL: "تعليمية",
  OTHER: "أخرى",
};
const SETTLEMENT_MODE: Record<string, string> = {
  PREPAID: "ندفع مقدماً ونبيع من رصيد الجهاز",
  POSTPAID: "نبيع أولاً ونسدد للمزوّد لاحقاً",
};
const SETTLEMENT_CYCLE: Record<string, string> = {
  DAILY: "يومي",
  WEEKLY: "أسبوعي",
  BIWEEKLY: "نصف شهري",
  MONTHLY: "شهري",
  ON_DEMAND: "عند الطلب",
};

const selectCls = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm";

export default function DigitalProviders() {
  const utils = trpc.useUtils();
  const list = trpc.digitalCards.providers.list.useQuery();
  const rows = list.data ?? [];

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [fSupplierId, setFSupplierId] = useState("");
  const [fType, setFType] = useState("TELECOM");
  const [fMode, setFMode] = useState("PREPAID");
  const [fCycle, setFCycle] = useState("ON_DEMAND");
  const [fThreshold, setFThreshold] = useState("0");
  const [fNotes, setFNotes] = useState("");

  function invalidate() {
    void utils.digitalCards.providers.list.invalidate();
    void utils.digitalCards.wallets.list.invalidate();
  }

  const createMut = trpc.digitalCards.providers.create.useMutation({
    onSuccess: () => { invalidate(); setFormOpen(false); notify.ok("أُضيف المزوّد"); },
    onError: (e) => notify.err(e),
  });
  const updateMut = trpc.digitalCards.providers.update.useMutation({
    onSuccess: () => { invalidate(); setFormOpen(false); notify.ok("حُفظت التعديلات"); },
    onError: (e) => notify.err(e),
  });
  const toggleMut = trpc.digitalCards.providers.toggle.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => notify.err(e),
  });

  function openAdd() {
    setEditId(null);
    setFSupplierId(""); setFType("TELECOM"); setFMode("PREPAID");
    setFCycle("ON_DEMAND"); setFThreshold("0"); setFNotes("");
    setFormOpen(true);
  }

  function openEdit(p: ProviderRow) {
    setEditId(p.id);
    setFSupplierId(String(p.supplierId));
    setFType(p.providerType); setFMode(p.settlementMode);
    setFCycle(p.settlementCycle);
    setFThreshold(p.lowBalanceThreshold); setFNotes(p.notes ?? "");
    setFormOpen(true);
  }

  function submitForm() {
    const notes = fNotes.trim() || null;
    if (editId != null) {
      updateMut.mutate({
        id: editId,
        providerType: fType as ProviderRow["providerType"],
        settlementCycle: fCycle as ProviderRow["settlementCycle"],
        lowBalanceThreshold: fThreshold || "0",
        notes,
      });
      return;
    }
    const supplierId = Number(fSupplierId);
    if (!supplierId) return notify.err("اختر المورّد المرتبط بالمزوّد");
    createMut.mutate({
      supplierId,
      providerType: fType as ProviderRow["providerType"],
      settlementMode: fMode as ProviderRow["settlementMode"],
      recognitionMode: "PRINCIPAL_GROSS",
      referencePolicy: "REQUIRED",
      settlementCycle: fCycle as ProviderRow["settlementCycle"],
      lowBalanceThreshold: fThreshold || "0",
      notes,
    });
  }

  async function toggle(p: ProviderRow) {
    if (p.isActive && !(await confirm({
      variant: "danger",
      title: "تعطيل المزوّد",
      description: `لن تظهر بطاقات «${p.supplierName}» للبيع، ولن يُقبل نشر أسعار جديدة لها. الأرصدة والذمم القائمة تبقى كما هي. متابعة؟`,
      confirmText: "تعطيل",
    }))) return;
    toggleMut.mutate({ id: p.id, isActive: !p.isActive });
  }

  const saving = createMut.isPending || updateMut.isPending;
  const editing = editId != null;

  /*
   * أعمدة القائمة — داخل المكوّن لأنّها تستدعي `openEdit`/`toggle` وتقرأ حالة الطفرة.
   * كلّ عمودٍ ذي قيمة يحمل `accessorFn` بالتسمية العربية المعروضة لا الرمز الخامّ،
   * فـ«نسخ القيمة» يُخرج ما يقرأه المستعمِل. وبوّابات الصلاحية على الإجراءات كما كانت.
   */
  const columns = useMemo<ColumnDef<ProviderRow, unknown>[]>(
    () => [
      {
        id: "supplier",
        header: "المورّد",
        accessorFn: (p) => p.supplierName,
        meta: { width: "wide" },
        cell: ({ row }) => <span className="font-medium">{row.original.supplierName}</span>,
      },
      {
        id: "providerType",
        header: "النوع",
        accessorFn: (p) => PROVIDER_TYPE[p.providerType] ?? p.providerType,
        cell: ({ row }) => PROVIDER_TYPE[row.original.providerType] ?? row.original.providerType,
      },
      {
        id: "settlementMode",
        header: "طريقة دفعنا للمزوّد",
        accessorFn: (p) => SETTLEMENT_MODE[p.settlementMode] ?? p.settlementMode,
        meta: { width: "wide", wrap: true },
        cell: ({ row }) => SETTLEMENT_MODE[row.original.settlementMode] ?? row.original.settlementMode,
      },
      {
        id: "settlementCycle",
        header: "موعد السداد",
        accessorFn: (p) => SETTLEMENT_CYCLE[p.settlementCycle] ?? p.settlementCycle,
        cell: ({ row }) => (
          <span className="text-muted-foreground">{SETTLEMENT_CYCLE[row.original.settlementCycle] ?? row.original.settlementCycle}</span>
        ),
      },
      {
        id: "lowBalanceThreshold",
        header: "حدّ الرصيد المنخفض",
        accessorFn: (p) => fmtAr(p.lowBalanceThreshold),
        meta: { kind: "money" },
        cell: ({ row }) => fmtAr(row.original.lowBalanceThreshold),
      },
      {
        id: "status",
        header: "الحالة",
        accessorFn: (p) => (p.isActive ? "مفعّل" : "معطّل"),
        meta: { kind: "status" },
        cell: ({ row }) => (
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${row.original.isActive ? "badge-status-active" : "badge-stock-out"}`}>
            {row.original.isActive ? "مفعّل" : "معطّل"}
          </span>
        ),
      },
      {
        id: "actions",
        header: "إجراء",
        meta: { kind: "actions" },
        cell: ({ row }) => {
          const p = row.original;
          return (
            <RowActions
              actions={[
                {
                  key: "edit",
                  kind: "edit",
                  label: "تعديل",
                  onSelect: () => openEdit(p),
                  gate: { roles: ["manager"], module: "digital_cards", level: "FULL" },
                },
                {
                  key: "toggle",
                  kind: "approve",
                  label: p.isActive ? "تعطيل" : "تفعيل",
                  variant: p.isActive ? "destructive" : "default",
                  disabled: toggleMut.isPending,
                  disabledReason: "توجد عملية تحديث قيد التنفيذ",
                  onSelect: () => void toggle(p),
                  gate: { roles: ["manager"], module: "digital_cards", level: "FULL" },
                },
              ]}
            />
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toggleMut.isPending],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="شركات ومزوّدو البطاقات"
        description="حدد الشركة التي تصدر الكروت، وكيف ندفع لها: من رصيد مشحون مسبقاً أو كدين مستحق بعد البيع. النظام ينشئ الأثر المالي الصحيح تلقائياً."
        actions={<Button size="sm" onClick={openAdd}><Plus className="size-4" /> مزوّد جديد</Button>}
      />

      <Card>
        <CardHeader className="text-sm text-muted-foreground">
          {list.isLoading ? "" : `${rows.length} مزوّد`}
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<ProviderRow>
            columns={columns}
            data={rows}
            searchPlaceholder="بحث بالمورّد أو النوع…"
            loading={list.isLoading}
            errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => void list.refetch() }}
            getRowClassName={(p) => (p.isActive ? undefined : "opacity-60")}
            emptyText="لا مزوّدين بعد — أضِف أوّل مزوّد بربطه بمورّد قائم."
          />
        </CardContent>
      </Card>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "تعديل مزوّد" : "إضافة مزوّد"}</DialogTitle>
            <DialogDescription>
              المورّد لا يتغيّر بعد الإنشاء — هو مرجع الذمّة والكشف. أنشئ المورّد من شاشة الموردين أوّلاً إن لم يكن موجوداً.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="dc-supplier">المورّد المرتبط</label>
              <EntityPicker
                id="dc-supplier"
                type="PURCHASE"
                selectedId={fSupplierId ? Number(fSupplierId) : null}
                disabled={editing}
                onSelect={(id) => setFSupplierId(id == null ? "" : String(id))}
                placeholder="— ابحث واختر المورّد —"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="dc-type">نوع المزوّد</label>
                <select id="dc-type" className={selectCls} value={fType} onChange={(e) => setFType(e.target.value)}>
                  {Object.entries(PROVIDER_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="dc-mode">كيف ندفع لهذا المزوّد؟</label>
                <select id="dc-mode" className={selectCls} value={fMode} disabled={editing} onChange={(e) => setFMode(e.target.value)}>
                  {Object.entries(SETTLEMENT_MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                {editing && <p className="text-xs text-muted-foreground">لا يتغير بعد الإنشاء لأنه يحدد هل يخصم البيع من رصيد الجهاز أم يسجّل مبلغاً مستحقاً للمزوّد.</p>}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="dc-cycle">متى نسدد للمزوّد؟</label>
                <select id="dc-cycle" className={selectCls} value={fCycle} onChange={(e) => setFCycle(e.target.value)}>
                  {Object.entries(SETTLEMENT_CYCLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                رقم العملية أو الاشتراك يُحفظ إلزامياً عند كل بيع للمطابقة وحفظ الحقوق.
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">حدّ التنبيه للرصيد المنخفض</label>
              <MoneyInput value={fThreshold} onChange={setFThreshold} ariaLabel="حدّ التنبيه للرصيد المنخفض" />
              <p className="text-xs text-muted-foreground">يُنبّه حين ينزل رصيد محفظة هذا المزوّد تحت هذا المبلغ. صفر = بلا تنبيه.</p>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">ملاحظات (اختياري)</label>
              <Textarea rows={2} value={fNotes} onChange={(e) => setFNotes(e.target.value)} placeholder="شروط الاتفاقية، جهة الاتصال…" />
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
