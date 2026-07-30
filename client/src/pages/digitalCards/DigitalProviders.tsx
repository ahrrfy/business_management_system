// مزوّدو البطاقات الرقمية والاشتراكات — كل مزوّد يرثُ مورّداً قائماً في المنظومة (ذمّته وكشفه).
// نمط التسوية هو القرار المالي الحاكم: PREPAID (محفظة رصيد لدى المزوّد) أو POSTPAID (ذمّة دائنة).
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { RowActions } from "@/components/list";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
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
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fmtAr } from "@/lib/money";
import { Plus } from "lucide-react";
import { useState } from "react";

type ProviderRow = RouterOutputs["digitalCards"]["providers"]["list"][number];

const PROVIDER_TYPE: Record<string, string> = {
  TELECOM: "اتصالات",
  GLOBAL_CARDS: "بطاقات عالمية",
  EDUCATIONAL: "تعليمية",
  OTHER: "أخرى",
};
const SETTLEMENT_MODE: Record<string, string> = {
  PREPAID: "مسبق الدفع (محفظة)",
  POSTPAID: "آجل (ذمّة)",
};
const REFERENCE_POLICY: Record<string, string> = {
  REQUIRED: "إلزامي",
  OPTIONAL: "اختياري",
  NONE: "بلا مرجع",
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
  const suppliers = trpc.suppliers.list.useQuery();
  const rows = list.data ?? [];

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [fSupplierId, setFSupplierId] = useState("");
  const [fType, setFType] = useState("TELECOM");
  const [fMode, setFMode] = useState("PREPAID");
  const [fRefPolicy, setFRefPolicy] = useState("OPTIONAL");
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
    setFRefPolicy("OPTIONAL"); setFCycle("ON_DEMAND"); setFThreshold("0"); setFNotes("");
    setFormOpen(true);
  }

  function openEdit(p: ProviderRow) {
    setEditId(p.id);
    setFSupplierId(String(p.supplierId));
    setFType(p.providerType); setFMode(p.settlementMode);
    setFRefPolicy(p.referencePolicy); setFCycle(p.settlementCycle);
    setFThreshold(p.lowBalanceThreshold); setFNotes(p.notes ?? "");
    setFormOpen(true);
  }

  function submitForm() {
    const notes = fNotes.trim() || null;
    if (editId != null) {
      updateMut.mutate({
        id: editId,
        providerType: fType as ProviderRow["providerType"],
        settlementMode: fMode as ProviderRow["settlementMode"],
        referencePolicy: fRefPolicy as ProviderRow["referencePolicy"],
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
      referencePolicy: fRefPolicy as ProviderRow["referencePolicy"],
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

  return (
    <div className="space-y-4">
      <PageHeader
        title="مزوّدو البطاقات"
        description="كل مزوّد يرتبط بمورّد واحد في المنظومة فترثُ الوحدة كشفَ حسابه وذمّته. نمط التسوية يحدّد المسار المالي: مسبق الدفع يستهلك من محفظة الجهاز، والآجل يرفع ذمّة المورّد لحظة البيع."
        actions={<Button size="sm" onClick={openAdd}><Plus className="size-4" /> مزوّد جديد</Button>}
      />

      <Card>
        <CardHeader className="text-sm text-muted-foreground">
          {list.isLoading ? "" : `${rows.length} مزوّد`}
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">المورّد</th>
                  <th className="p-2 text-start">النوع</th>
                  <th className="p-2 text-start">نمط التسوية</th>
                  <th className="p-2 text-start">المرجع</th>
                  <th className="p-2 text-start">دورية التسوية</th>
                  <th className="p-2 text-start">حدّ الرصيد المنخفض</th>
                  <th className="p-2 text-center">الحالة</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className={`border-t ${p.isActive ? "" : "opacity-60"}`}>
                    <td className="p-2 font-medium">{p.supplierName}</td>
                    <td className="p-2">{PROVIDER_TYPE[p.providerType] ?? p.providerType}</td>
                    <td className="p-2">{SETTLEMENT_MODE[p.settlementMode] ?? p.settlementMode}</td>
                    <td className="p-2 text-muted-foreground">{REFERENCE_POLICY[p.referencePolicy] ?? p.referencePolicy}</td>
                    <td className="p-2 text-muted-foreground">{SETTLEMENT_CYCLE[p.settlementCycle] ?? p.settlementCycle}</td>
                    <td className="p-2 tabular-nums">{fmtAr(p.lowBalanceThreshold)}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${p.isActive ? "badge-status-active" : "badge-stock-out"}`}>
                        {p.isActive ? "مفعّل" : "معطّل"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      <RowActions
                        actions={[
                          { key: "edit", label: "تعديل", onSelect: () => openEdit(p) },
                          {
                            key: "toggle",
                            label: p.isActive ? "تعطيل" : "تفعيل",
                            variant: p.isActive ? "destructive" : "default",
                            disabled: toggleMut.isPending,
                            onSelect: () => void toggle(p),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
                {list.isLoading && <tr><td colSpan={8}><LoadingState /></td></tr>}
                {!list.isLoading && rows.length === 0 && (
                  <TableEmptyRow colSpan={8} message="لا مزوّدين بعد — أضِف أوّل مزوّد بربطه بمورّد قائم." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
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
              <select
                id="dc-supplier"
                className={selectCls}
                value={fSupplierId}
                disabled={editing}
                onChange={(e) => setFSupplierId(e.target.value)}
              >
                <option value="">— اختر المورّد —</option>
                {(suppliers.data ?? []).map((sup) => (
                  <option key={sup.id} value={sup.id}>{sup.name}</option>
                ))}
              </select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="dc-type">نوع المزوّد</label>
                <select id="dc-type" className={selectCls} value={fType} onChange={(e) => setFType(e.target.value)}>
                  {Object.entries(PROVIDER_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="dc-mode">نمط التسوية</label>
                <select id="dc-mode" className={selectCls} value={fMode} onChange={(e) => setFMode(e.target.value)}>
                  {Object.entries(SETTLEMENT_MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="dc-ref">مرجع التنفيذ لدى المزوّد</label>
                <select id="dc-ref" className={selectCls} value={fRefPolicy} onChange={(e) => setFRefPolicy(e.target.value)}>
                  {Object.entries(REFERENCE_POLICY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="dc-cycle">دورية التسوية</label>
                <select id="dc-cycle" className={selectCls} value={fCycle} onChange={(e) => setFCycle(e.target.value)}>
                  {Object.entries(SETTLEMENT_CYCLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
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
