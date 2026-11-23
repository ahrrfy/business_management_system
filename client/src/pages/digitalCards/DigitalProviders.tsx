import { useDigitalGiftOperationAccess } from "@/lib/digitalGiftOperationAccess";
// مزوّدو البطاقات الرقمية والاشتراكات — كل مزوّد يرثُ مورّداً قائماً في المنظومة (ذمّته وكشفه).
// نمط التسوية هو القرار المالي الحاكم: PREPAID (محفظة رصيد لدى المزوّد) أو POSTPAID (ذمّة دائنة).
import { ACTION_LABELS } from "@shared/actionLabels";
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
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import {
  DigitalCardThumbnail,
  resolveImageFormSubmission,
  toExistingImageItems,
} from "@/components/digitalCards/DigitalCardImage";
import { AppSelect } from "@/components/ui/AppSelect";
import { EntityPicker } from "@/components/invoice/EntityPicker";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fmtAr } from "@/lib/money";
import { Layers, Plus } from "lucide-react";
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

export default function DigitalProviders() {
  const digitalAccess = useDigitalGiftOperationAccess();
  const utils = trpc.useUtils();
  const list = digitalAccess.query("digitalCards.providers.list", trpc.digitalCards.providers.list.useQuery(undefined, { enabled: digitalAccess.can("digitalCards.providers.list") }));
  const rows = list.data ?? [];

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [fSupplierId, setFSupplierId] = useState("");
  const [fType, setFType] = useState("TELECOM");
  const [fMode, setFMode] = useState("PREPAID");
  const [fCycle, setFCycle] = useState("ON_DEMAND");
  const [fThreshold, setFThreshold] = useState("0");
  const [fNotes, setFNotes] = useState("");
  const [fLogoImages, setFLogoImages] = useState<ImageItem[]>([]);

  function invalidate() {
    void utils.digitalCards.providers.list.invalidate();
    void utils.digitalCards.offerings.list.invalidate();
    void utils.digitalCards.offerings.get.invalidate();
    void utils.digitalCards.pos.listCards.invalidate();
    void utils.digitalCards.pos.confirmCard.invalidate();
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
  const applyLogoMut = trpc.digitalCards.providers.applyLogoToOfferings.useMutation({
    onSuccess: (res) => {
      invalidate();
      notify.ok(
        "تم تعميم الشعار على كروت المزوّد",
        res.updatedCount > 0
          ? `أُعيد ضبط ${res.updatedCount} كرتاً لوراثة شعار المزوّد.`
          : "جميع كروت المزوّد ترث الشعار بالفعل.",
      );
    },
    onError: (e) => notify.err(e),
  });

  function openAdd() {
    setEditId(null);
    setFSupplierId(""); setFType("TELECOM"); setFMode("PREPAID");
    setFCycle("ON_DEMAND"); setFThreshold("0"); setFNotes("");
    setFLogoImages([]);
    setFormOpen(true);
  }

  function openEdit(p: ProviderRow) {
    setEditId(p.id);
    setFSupplierId(String(p.supplierId));
    setFType(p.providerType); setFMode(p.settlementMode);
    setFCycle(p.settlementCycle);
    setFThreshold(p.lowBalanceThreshold); setFNotes(p.notes ?? "");
    setFLogoImages(toExistingImageItems(p.logoUrl));
    setFormOpen(true);
  }

  function submitForm() {
    if (!digitalAccess.can(`digitalCards.providers.${editId != null ? "update" : "create"}`)) return;
    const notes = fNotes.trim() || null;
    const logoUrl = resolveImageFormSubmission(fLogoImages);
    if (editId != null) {
      updateMut.mutate({
        id: editId,
        providerType: fType as ProviderRow["providerType"],
        settlementCycle: fCycle as ProviderRow["settlementCycle"],
        lowBalanceThreshold: fThreshold || "0",
        ...(logoUrl !== undefined ? { logoUrl } : {}),
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
      ...(logoUrl ? { logoUrl } : {}),
      notes,
    });
  }

  async function handleApplyLogoToOfferings(opts: {
    providerId: number;
    supplierName: string;
    pendingDataUrl?: string;
  }) {
    if (!digitalAccess.can("digitalCards.providers.applyLogoToOfferings")) return;
    const confirmed = await confirm({
      variant: "danger",
      title: "تعميم الشعار على كل كروت المزوّد",
      description: `سيتم إلغاء أيّ صورٍ مخصّصة لجميع كروت «${opts.supplierName}» وإعادتها لوراثة شعار المزوّد تلقائياً. متابعة؟`,
      confirmText: "تعميم الشعار",
    });
    if (!confirmed) return;
    applyLogoMut.mutate(
      opts.pendingDataUrl
        ? { providerId: opts.providerId, logoUrl: opts.pendingDataUrl }
        : { providerId: opts.providerId },
    );
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

  const saving = createMut.isPending || updateMut.isPending || applyLogoMut.isPending;
  const editing = editId != null;
  const editingProvider = editing ? rows.find((p) => p.id === editId) : undefined;

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
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <DigitalCardThumbnail
              src={row.original.logoUrl}
              alt={row.original.supplierName}
              fallback="provider"
              className="size-9 shrink-0"
            />
            <span className="font-medium">{row.original.supplierName}</span>
          </div>
        ),
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
                  hidden: !digitalAccess.can("digitalCards.providers.update"),
                  gate: digitalAccess.canonical ? undefined : { roles: ["manager"], module: "digital_cards", level: "FULL" },
                },
                {
                  key: "applyLogo",
                  kind: "approve",
                  label: "تعميم الشعار على كل كروت المزوّد",
                  disabled: !p.hasLogo || applyLogoMut.isPending,
                  disabledReason: !p.hasLogo
                    ? "ارفع شعاراً للمزوّد أوّلاً"
                    : "توجد عملية تحديث قيد التنفيذ",
                  onSelect: () =>
                    void handleApplyLogoToOfferings({
                      providerId: p.id,
                      supplierName: p.supplierName,
                    }),
                  hidden: !digitalAccess.can("digitalCards.providers.applyLogoToOfferings"),
                  gate: digitalAccess.canonical ? undefined : { roles: ["manager"], module: "digital_cards", level: "FULL" },
                },
                {
                  key: "toggle",
                  kind: "approve",
                  label: p.isActive ? "تعطيل" : "تفعيل",
                  variant: p.isActive ? "destructive" : "default",
                  disabled: toggleMut.isPending,
                  disabledReason: "توجد عملية تحديث قيد التنفيذ",
                  onSelect: () => void toggle(p),
                  hidden: !digitalAccess.can("digitalCards.providers.toggle"),
                  gate: digitalAccess.canonical ? undefined : { roles: ["manager"], module: "digital_cards", level: "FULL" },
                },
              ]}
            />
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toggleMut.isPending, applyLogoMut.isPending, digitalAccess],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="شركات ومزوّدو البطاقات"
        description="حدد الشركة التي تصدر الكروت، وكيف ندفع لها: من رصيد مشحون مسبقاً أو كدين مستحق بعد البيع. النظام ينشئ الأثر المالي الصحيح تلقائياً."
        actions={<Button size="sm" onClick={openAdd} disabled={!digitalAccess.can("digitalCards.providers.create")}><Plus className="size-4" /> مزوّد جديد</Button>}
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
        <DialogContent className="max-h-[85vh] overflow-y-auto">
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
                <AppSelect id="dc-type" value={fType} onValueChange={setFType}>
                  {Object.entries(PROVIDER_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </AppSelect>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="dc-mode">كيف ندفع لهذا المزوّد؟</label>
                <AppSelect id="dc-mode" value={fMode} disabled={editing} onValueChange={setFMode}>
                  {Object.entries(SETTLEMENT_MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </AppSelect>
                {editing && <p className="text-xs text-muted-foreground">لا يتغير بعد الإنشاء لأنه يحدد هل يخصم البيع من رصيد الجهاز أم يسجّل مبلغاً مستحقاً للمزوّد.</p>}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="dc-cycle">متى نسدد للمزوّد؟</label>
                <AppSelect id="dc-cycle" value={fCycle} onValueChange={setFCycle}>
                  {Object.entries(SETTLEMENT_CYCLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </AppSelect>
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

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-sm font-medium">شعار المزوّد (اختياري)</label>
                {editing && digitalAccess.can("digitalCards.providers.applyLogoToOfferings") && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={fLogoImages.length === 0 || saving}
                    onClick={() => {
                      if (editId == null) return;
                      void handleApplyLogoToOfferings({
                        providerId: editId,
                        supplierName: editingProvider?.supplierName ?? "المزوّد",
                        pendingDataUrl: fLogoImages[0]?.dataUrl || undefined,
                      });
                    }}
                  >
                    <Layers aria-hidden className="size-3.5" />
                    تعميم الشعار على كل كروت المزوّد
                  </Button>
                )}
              </div>
              <ImageUploader
                value={fLogoImages}
                onChange={setFLogoImages}
                maxItems={1}
                singlePrimary={false}
                hint="PNG · JPG · WEBP — ترث الكروت هذا الشعار تلقائياً ما لم تُخصَّص لها صورة"
              />
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">ملاحظات (اختياري)</label>
              <Textarea rows={2} value={fNotes} onChange={(e) => setFNotes(e.target.value)} placeholder="شروط الاتفاقية، جهة الاتصال…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setFormOpen(false)}>إلغاء</Button>
            <Button size="sm" onClick={submitForm} disabled={!digitalAccess.can(`digitalCards.providers.${editing ? "update" : "create"}`) || saving}>
              {saving ? ACTION_LABELS.saving : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
