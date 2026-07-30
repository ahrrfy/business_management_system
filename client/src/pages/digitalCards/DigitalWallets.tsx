// محافظ المزوّدين مسبقي الدفع: رصيد الشركة لدى جهاز/حساب المزوّد لكل فرع.
// الإيداع والسحب والتسوية ليست هنا (شريحة لاحقة) — هذه الشاشة تُعرّف المحفظة وتعرض رصيدها.
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { RowActions } from "@/components/list";
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
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { D, fmtAr } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { AlertTriangle, Plus } from "lucide-react";
import { useState } from "react";
import {
  WalletAdjustDialog, WalletMoveDialog, WalletReconcileDialog, WalletStatementDialog,
} from "./WalletOpsDialogs";

type WalletRow = RouterOutputs["digitalCards"]["wallets"]["list"][number];

const selectCls = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm";

export default function DigitalWallets() {
  const utils = trpc.useUtils();
  const list = trpc.digitalCards.wallets.list.useQuery();
  const providers = trpc.digitalCards.providers.list.useQuery();
  const branches = trpc.branches.list.useQuery();
  const rows = list.data ?? [];

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
    if (w.isActive && !(await confirm({
      variant: "danger",
      title: "تعطيل المحفظة",
      description: `لن تُستهلك «${w.name}» في مبيعات جديدة. الرصيد الحالي ${fmtAr(w.currentBalance)} يبقى مسجّلاً كما هو. متابعة؟`,
      confirmText: "تعطيل",
    }))) return;
    toggleMut.mutate({ id: w.id, isActive: !w.isActive });
  }

  const saving = createMut.isPending || updateMut.isPending;
  const editing = editId != null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="محافظ المزوّدين"
        description="رصيدنا المدفوع مسبقاً لدى كل مزوّد في كل فرع. «المحجوز» رصيدٌ تحفظه عمليات بيع جارية لم تُثبَّت بعد، والمتاح = الرصيد − المحجوز. الإيداع والسحب من شاشة الحركات."
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
        <CardHeader className="text-sm text-muted-foreground">
          {list.isLoading ? "" : `${rows.length} محفظة`}
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">المحفظة</th>
                  <th className="p-2 text-start">الرمز</th>
                  <th className="p-2 text-start">المزوّد</th>
                  <th className="p-2 text-start">الفرع</th>
                  <th className="p-2 text-start">الرصيد</th>
                  <th className="p-2 text-start">المحجوز</th>
                  <th className="p-2 text-start">المتاح</th>
                  <th className="p-2 text-center">الحالة</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.id} className={`border-t ${w.isActive ? "" : "opacity-60"}`}>
                    <td className="p-2 font-medium">{w.name}</td>
                    <td className="p-2 font-mono text-xs" dir="ltr">{w.code}</td>
                    <td className="p-2">{w.providerName}</td>
                    <td className="p-2 text-muted-foreground">{w.branchName}</td>
                    <td className="p-2 tabular-nums">{fmtAr(w.currentBalance)}</td>
                    <td className="p-2 tabular-nums text-muted-foreground">{fmtAr(w.reservedBalance)}</td>
                    <td className="p-2 tabular-nums font-medium">
                      {fmtAr(D(w.currentBalance).minus(D(w.reservedBalance)).toFixed(2))}
                    </td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${w.isActive ? "badge-status-active" : "badge-stock-out"}`}>
                        {w.isActive ? "مفعّلة" : "معطّلة"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      <RowActions
                        actions={[
                          { key: "deposit", label: "إيداع رصيد", onSelect: () => setMoving({ wallet: w, mode: "deposit" }) },
                          { key: "withdraw", label: "سحب رصيد", onSelect: () => setMoving({ wallet: w, mode: "withdraw" }) },
                          { key: "statement", label: "كشف الحساب", onSelect: () => setViewing(w) },
                          { key: "reconcile", label: "مطابقة يومية", onSelect: () => setReconciling(w) },
                          { key: "adjust", label: "طلب تعديل رصيد", onSelect: () => setAdjusting(w) },
                          { key: "edit", label: "تعديل البيانات", onSelect: () => openEdit(w) },
                          {
                            key: "toggle",
                            label: w.isActive ? "تعطيل" : "تفعيل",
                            variant: w.isActive ? "destructive" : "default",
                            disabled: toggleMut.isPending,
                            onSelect: () => void toggle(w),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
                {list.isLoading && <tr><td colSpan={9}><LoadingState /></td></tr>}
                {!list.isLoading && rows.length === 0 && (
                  <TableEmptyRow colSpan={9} message="لا محافظ بعد — أضِف محفظة لكل جهاز مزوّد في كل فرع." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
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
                <select
                  id="dw-provider"
                  className={selectCls}
                  value={fProviderId}
                  disabled={editing}
                  onChange={(e) => setFProviderId(e.target.value)}
                >
                  <option value="">— اختر المزوّد —</option>
                  {prepaidProviders.map((p) => (
                    <option key={p.id} value={p.id}>{p.supplierName}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="dw-branch">الفرع</label>
                <select
                  id="dw-branch"
                  className={selectCls}
                  value={fBranchId}
                  disabled={editing}
                  onChange={(e) => setFBranchId(e.target.value)}
                >
                  <option value="">— اختر الفرع —</option>
                  {(branches.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
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
              {saving ? "جارٍ الحفظ…" : "حفظ"}
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
