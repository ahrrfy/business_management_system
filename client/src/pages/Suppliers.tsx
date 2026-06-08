import { CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ImportDialog } from "@/components/import/ImportDialog";
import { ListToolbar, RowActions } from "@/components/list";
import { confirm } from "@/lib/confirm";
import { SUPPLIER_FIELDS } from "@/lib/importFields";
import type { SupplierImportRow } from "@/lib/importTypes";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";

function fmt(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === "") return "—";
  return Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });
}

export default function Suppliers() {
  const utils = trpc.useUtils();
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const importMut = trpc.imports.suppliers.useMutation();
  const limit = 50;

  const input = useMemo(
    () => ({ q: q.trim() || undefined, includeInactive, limit, offset: page * limit }),
    [q, includeInactive, page],
  );

  const list = trpc.suppliers.search.useQuery(input);
  const invalidate = () => {
    utils.suppliers.search.invalidate();
    utils.suppliers.list.invalidate();
  };
  const deactivate = trpc.suppliers.deactivate.useMutation({
    onSuccess: () => { invalidate(); notify.ok("تم تعطيل المورّد"); },
    onError: (e) => notify.err(e),
  });
  const activate = trpc.suppliers.activate.useMutation({
    onSuccess: () => { invalidate(); notify.ok("تم تفعيل المورّد"); },
    onError: (e) => notify.err(e),
  });

  const total = list.data?.total ?? 0;
  const rows = list.data?.rows ?? [];
  const pages = Math.max(1, Math.ceil(total / limit));

  async function toggle(id: number, isActive: boolean, name: string) {
    if (isActive) {
      if (!(await confirm({
        variant: "danger",
        title: "تعطيل المورّد",
        description: `سيُستثنى «${name}» من قوائم الشراء. أوامر الشراء المسوّاة تبقى. هل تتابع؟`,
        confirmText: "تعطيل",
      }))) return;
      deactivate.mutate({ supplierId: id });
    } else {
      activate.mutate({ supplierId: id });
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">الموردون</h1>

      <ImportDialog<SupplierImportRow>
        open={importOpen}
        onOpenChange={setImportOpen}
        title="استيراد موردين من Excel/CSV"
        entityName="مورّد"
        fields={SUPPLIER_FIELDS}
        onImport={async (rows) => {
          const res = await importMut.mutateAsync({
            rows: rows.map((r) => ({ ...r, rowNumber: r.rowNumber })),
            options: { onExisting: "skip" },
          });
          return res;
        }}
        onDone={(s) => {
          if (s.committed && (s.created > 0 || s.updated > 0)) {
            notify.ok(`تم: ${s.created} مُنشأ، ${s.updated} مُحدَّث، ${s.skipped} متخطّى`);
            invalidate();
          }
        }}
      />
      <p className="text-sm text-muted-foreground">
        إدارة الموردين: إضافة، تعديل، تعطيل، بحث، ومتابعة الرصيد الدائن المفتوح.
      </p>

      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={total}
            loading={list.isLoading}
            search={{
              value: q,
              onChange: (v) => { setQ(v); setPage(0); },
              placeholder: "بحث (اسم/هاتف/مدينة)",
            }}
            filters={
              <label className="flex items-center gap-2 h-8 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={includeInactive}
                  onChange={(e) => { setIncludeInactive(e.target.checked); setPage(0); }}
                />
                <span className="text-muted-foreground">عرض المعطّلين</span>
              </label>
            }
            exportSpec={{
              filename: "الموردون",
              rows,
              columns: [
                { key: "name", header: "الاسم" },
                { key: "phone", header: "الهاتف" },
                { key: "city", header: "المدينة" },
                { key: "paymentTerms", header: "شروط الدفع" },
                { key: "currentBalance", header: "الرصيد الحالي", map: (r) => Number(r.currentBalance ?? 0) },
                { key: "isActive", header: "نشط", map: (r) => (r.isActive ? "نعم" : "لا") },
              ],
            }}
            onImport={() => setImportOpen(true)}
            importLabel="استيراد Excel"
            add={{ href: "/suppliers/new", label: "مورّد جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">الاسم</th>
                <th className="p-2">الهاتف</th>
                <th className="p-2">المدينة</th>
                <th className="p-2">شروط الدفع</th>
                <th className="p-2 text-left">الرصيد الحالي</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const id = Number(s.id);
                const isActive = !!s.isActive;
                const balance = Number(s.currentBalance ?? "0");
                const balanceClass = balance > 0 ? "text-amber-700" : balance < 0 ? "text-emerald-700" : "text-muted-foreground";
                return (
                  <tr key={id} className={`border-t ${isActive ? "" : "opacity-60"}`}>
                    <td className="p-2 font-medium">{s.name}</td>
                    <td className="p-2"><CopyInline value={s.phone} /></td>
                    <td className="p-2 text-xs">{s.city ?? "—"}</td>
                    <td className="p-2 text-xs">{s.paymentTerms ?? "—"}</td>
                    <td className={`p-2 text-left tabular-nums ${balanceClass}`} dir="ltr">{fmt(s.currentBalance)}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                        {isActive ? "مفعّل" : "معطّل"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      <RowActions
                        mode="inline"
                        actions={[
                          { key: "edit", label: "تعديل", href: `/suppliers/${id}/edit` },
                          {
                            key: "toggle",
                            label: isActive ? "تعطيل" : "تفعيل",
                            variant: isActive ? "destructive" : "default",
                            disabled: deactivate.isPending || activate.isPending,
                            onSelect: () => void toggle(id, isActive, s.name ?? ""),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {!list.isLoading && rows.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا موردين مطابقين. أضف مورّداً جديداً أو غيّر البحث.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← السابق</Button>
          <div className="text-muted-foreground">صفحة {page + 1} من {pages}</div>
          <Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>التالي →</Button>
        </div>
      )}
    </div>
  );
}
