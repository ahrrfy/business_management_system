// شاشة إدارة الفروع (إضافة/تعديل/تعطيل) — للمدير العام فقط. لا حذف صلب — الفرع مرجع تاريخي لعشرات
// الجداول (فواتير/حركات مخزون/ورديات...)، فقط تعطيل منطقي يُخفيه من منتقيات العمليات الجديدة.
// التعطيل محروس خادمياً: يُرفض إن كان آخر فرع نشط أو لا يزال يحمل مخزوناً فعلياً.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RowActions } from "@/components/list";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Plus } from "lucide-react";
import { useState } from "react";

type BranchRow = RouterOutputs["branches"]["adminList"][number];
type BranchType = "MAIN" | "SALES";

const TYPE_LABEL: Record<string, string> = { MAIN: "رئيسي (كل الخدمات)", SALES: "مبيعات" };

export default function Branches() {
  const utils = trpc.useUtils();
  const list = trpc.branches.adminList.useQuery();
  const rows = list.data ?? [];

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [fName, setFName] = useState("");
  const [fCode, setFCode] = useState("");
  const [fType, setFType] = useState<BranchType>("SALES");
  const [fAddress, setFAddress] = useState("");
  const [fPhone, setFPhone] = useState("");

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
    setFormOpen(true);
  }
  function openEdit(b: BranchRow) {
    setEditId(b.id);
    setFName(b.name); setFCode(b.code); setFType(b.type); setFAddress(b.address ?? ""); setFPhone(b.phone ?? "");
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

  return (
    <div className="space-y-4">
      <PageHeader
        title="الفروع"
        description="فروع المنشأة (رئيسي/مبيعات) — لكل فرع مخزونه ومستخدموه. لا حذف صلب، فقط تعطيل؛ يُمنع تعطيل آخر فرع نشط أو فرع لا يزال يحمل مخزوناً."
        actions={<Button size="sm" onClick={openAdd}><Plus className="size-4" /> فرع جديد</Button>}
      />

      <Card>
        <CardHeader className="text-sm text-muted-foreground">
          {list.isLoading ? "" : `${rows.length} فرع`}
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">الاسم</th>
                  <th className="p-2">الرمز</th>
                  <th className="p-2">النوع</th>
                  <th className="p-2">العنوان</th>
                  <th className="p-2">الهاتف</th>
                  <th className="p-2 text-center">الحالة</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id} className={`border-t ${b.isActive ? "" : "opacity-60"}`}>
                    <td className="p-2 font-medium">{b.name}</td>
                    <td className="p-2 font-mono text-xs" dir="ltr">{b.code}</td>
                    <td className="p-2">{TYPE_LABEL[b.type] ?? b.type}</td>
                    <td className="p-2 text-muted-foreground">{b.address || "—"}</td>
                    <td className="p-2 text-xs" dir="ltr">{b.phone || "—"}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${b.isActive ? "badge-status-active" : "badge-stock-out"}`}>
                        {b.isActive ? "مفعّل" : "معطّل"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      <RowActions
                        actions={[
                          { key: "edit", label: "تعديل", onSelect: () => openEdit(b) },
                          {
                            key: "toggle",
                            label: b.isActive ? "تعطيل" : "تفعيل",
                            variant: b.isActive ? "destructive" : "default",
                            disabled: setActive.isPending,
                            onSelect: () => void toggle(b),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
                {list.isLoading && (
                  <tr><td colSpan={7}><LoadingState /></td></tr>
                )}
                {!list.isLoading && rows.length === 0 && (
                  <TableEmptyRow colSpan={7} message="لا فروع بعد — أضِف أوّل فرع." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
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
              <select
                value={fType}
                onChange={(e) => setFType(e.target.value as BranchType)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
              >
                <option value="SALES">مبيعات</option>
                <option value="MAIN">رئيسي (كل الخدمات)</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">العنوان (اختياري)</label>
              <Textarea rows={2} value={fAddress} onChange={(e) => setFAddress(e.target.value)} placeholder="العنوان التفصيلي…" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">الهاتف (اختياري)</label>
              <Input value={fPhone} onChange={(e) => setFPhone(e.target.value)} placeholder="07xxxxxxxxx" dir="ltr" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setFormOpen(false)}>إلغاء</Button>
            <Button size="sm" onClick={submitForm} disabled={createMut.isPending || updateMut.isPending}>
              {createMut.isPending || updateMut.isPending ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
