import { CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BalanceCell } from "@/components/BalanceBadge";
import { ImportDialog } from "@/components/import/ImportDialog";
import { ListToolbar, RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { SUPPLIER_FIELDS, SUPPLIER_IMPORT_META } from "@/lib/importFields";
import type { SupplierImportRow } from "@/lib/importTypes";
import { fmtAr as fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";

/** الرقم القديم (legacyCode) من صف القائمة — null إن فارغاً (العمود يظهر فقط حين توجد قيم).
 *  select القائمة في supplierService يعيده ويُدخله البحث (شريحة تكامل الاستيراد). */
function legacyCodeOf(r: { legacyCode?: string | null }): string | null {
  const v = r.legacyCode;
  return typeof v === "string" && v.trim() !== "" ? v : null;
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
  // عمود «الرقم القديم» يظهر فقط إن وُجدت قيم فعلية في الصفحة الحالية (مخفيّ إن فارغ).
  const hasLegacy = rows.some((r) => legacyCodeOf(r) !== null);

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
      <PageHeader
        title="الموردون"
        description="إدارة الموردين: إضافة، تعديل، تعطيل، بحث، ومتابعة الرصيد الدائن المفتوح."
      />

      <ImportDialog<SupplierImportRow>
        open={importOpen}
        onOpenChange={setImportOpen}
        title="استيراد موردين من Excel/CSV"
        entityName="مورّد"
        fields={SUPPLIER_FIELDS}
        meta={SUPPLIER_IMPORT_META}
        onImport={async (rows, ctx) => {
          // خيارات الحوار (dryRun/usdRate/skipFailed/balanceSign) تُمرَّر للخادم فعلياً —
          // كائن مبنيّ لا literal كي تبقى الأنواع سليمة قبل توسعة مخطط الراوتر (W3) وبعدها.
          const options = { onExisting: "skip" as const, ...(ctx.options ?? {}) };
          const res = await importMut.mutateAsync({
            rows: rows.map((r) => ({ ...r, rowNumber: r.rowNumber })),
            options,
          });
          return res;
        }}
        onDone={(s) => {
          // الإبطال متى كُتب شيء فعلاً: ملف متعدد الدفعات قد يتوقّف عند دفعة فاشلة بعد دفعات
          // التزمت (committed المُدمَج = false) بينما القائمة تغيّرت في القاعدة فعلاً.
          if (s.created > 0 || s.updated > 0) {
            if (s.committed) notify.ok(`تم: ${s.created} مُنشأ، ${s.updated} مُحدَّث، ${s.skipped} متخطّى`);
            invalidate();
          }
        }}
      />

      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={total}
            loading={list.isLoading}
            search={{
              value: q,
              onChange: (v) => { setQ(v); setPage(0); },
              placeholder: "بحث (اسم/هاتف/مدينة/رقم قديم)",
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
                { key: "legacyCode", header: "الرقم القديم", map: (r) => legacyCodeOf(r) ?? "" },
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
              <tr className="text-end">
                <th className="p-2">الاسم</th>
                {hasLegacy && <th className="p-2">الرقم القديم</th>}
                <th className="p-2">الهاتف</th>
                <th className="p-2">المدينة</th>
                <th className="p-2">شروط الدفع</th>
                <th className="p-2 text-start">الرصيد</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const id = Number(s.id);
                const isActive = !!s.isActive;
                return (
                  <tr key={id} className={`border-t ${isActive ? "" : "opacity-60"}`}>
                    <td className="p-2 font-medium">{s.name}</td>
                    {hasLegacy && (
                      <td className="p-2 text-xs tabular-nums text-muted-foreground" dir="ltr">
                        {legacyCodeOf(s) ?? "—"}
                      </td>
                    )}
                    <td className="p-2"><CopyInline value={s.phone} /></td>
                    <td className="p-2 text-xs">{s.city ?? "—"}</td>
                    <td className="p-2 text-xs">{s.paymentTerms ?? "—"}</td>
                    <td className="p-2 text-start">
                      <BalanceCell amount={s.currentBalance} entityType="supplier" />
                    </td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "badge-status-active" : "badge-stock-out"}`}>
                        {isActive ? "مفعّل" : "معطّل"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      {/* ٤ إجراءات ⇒ auto يحوّلها لقائمة ⋯ تلقائياً (إسقاط inline مقصود) */}
                      <RowActions
                        actions={[
                          { key: "edit", label: "تعديل", href: `/suppliers/${id}/edit` },
                          // كشف الحساب يقرأ ?id= من URL (نمط SupplierStatement)
                          { key: "stmt", label: "كشف حساب", href: `/suppliers-statement?id=${id}` },
                          { key: "pay", label: "سند صرف له", href: "/vouchers/payment/new" },
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
                <TableEmptyRow colSpan={hasLegacy ? 8 : 7} message="لا موردين مطابقين. أضف مورّداً جديداً أو غيّر البحث." />
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
