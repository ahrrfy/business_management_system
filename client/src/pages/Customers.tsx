import { CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BalanceCell } from "@/components/BalanceBadge";
import { ImportDialog } from "@/components/import/ImportDialog";
import { ListToolbar, RowActions } from "@/components/list";
import { SelectionBar, useRowSelection } from "@/components/list/SelectionBar";
import { useClipboard } from "@/hooks/useClipboard";
import { confirm } from "@/lib/confirm";
import { formatCustomerCard, formatTableAsTSV } from "@/lib/copy/formatters";
import { CUSTOMER_FIELDS, CUSTOMER_IMPORT_META } from "@/lib/importFields";
import type { CustomerImportRow } from "@/lib/importTypes";
import { fmtAr as fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";

const TYPE_OPTIONS = ["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"] as const;
const TIER_LABEL: Record<string, string> = {
  RETAIL: "مفرد",
  WHOLESALE: "جملة",
  GOVERNMENT: "حكومي",
};

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** الرقم القديم (legacyCode) من صف القائمة — null إن فارغاً (العمود يظهر فقط حين توجد قيم).
 *  select القائمة في customerService يعيده ويُدخله البحث (شريحة تكامل الاستيراد). */
function legacyCodeOf(r: { legacyCode?: string | null }): string | null {
  const v = r.legacyCode;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export default function Customers() {
  const utils = trpc.useUtils();
  const [q, setQ] = useState("");
  const [customerType, setCustomerType] = useState<"" | (typeof TYPE_OPTIONS)[number]>("");
  const [priceTier, setPriceTier] = useState<"" | "RETAIL" | "WHOLESALE" | "GOVERNMENT">("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const importMut = trpc.imports.customers.useMutation();
  const limit = 50;

  const input = useMemo(
    () => ({
      q: q.trim() || undefined,
      customerType: customerType || undefined,
      priceTier: priceTier || undefined,
      includeInactive,
      limit,
      offset: page * limit,
    }),
    [q, customerType, priceTier, includeInactive, page],
  );

  const list = trpc.customers.search.useQuery(input);
  const deactivate = trpc.customers.deactivate.useMutation({
    onSuccess: () => {
      utils.customers.search.invalidate();
      utils.customers.list.invalidate();
      notify.ok("تم تعطيل العميل");
    },
    onError: (e) => notify.err(e),
  });
  const activate = trpc.customers.activate.useMutation({
    onSuccess: () => {
      utils.customers.search.invalidate();
      utils.customers.list.invalidate();
      notify.ok("تم تفعيل العميل");
    },
    onError: (e) => notify.err(e),
  });

  const total = list.data?.total ?? 0;
  const rows = list.data?.rows ?? [];
  const pages = Math.max(1, Math.ceil(total / limit));
  // عمود «الرقم القديم» يظهر فقط إن وُجدت قيم فعلية في الصفحة الحالية (مخفيّ إن فارغ).
  const hasLegacy = rows.some((r) => legacyCodeOf(r) !== null);

  // التحديد المُتعدِّد + النسخ الجماعي — TSV للصق في Excel، وملخّص واتساب لقائمة العملاء.
  const sel = useRowSelection<number>();
  const { copy } = useClipboard({ successMessage: null });
  const pageIds = useMemo(() => rows.map((r) => Number(r.id)), [rows]);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => sel.isSelected(id));
  const someOnPageSelected = pageIds.some((id) => sel.isSelected(id));
  const selectedRows = useMemo(
    () => rows.filter((r) => sel.isSelected(Number(r.id))),
    [rows, sel],
  );

  async function copySelectedAsTSV() {
    if (selectedRows.length === 0) return;
    // أعمدة مُطابِقة لعرض الجدول — تَنسيق Excel-friendly.
    const headers = [
      "الاسم",
      "الرقم القديم",
      "النوع",
      "الهاتف",
      "المدينة/المنطقة",
      "فئة السعر",
      "سقف الائتمان",
      "الرصيد الحالي",
      "نشط",
    ];
    const tsvRows = selectedRows.map((r) => ({
      "الاسم": r.name ?? "",
      "الرقم القديم": legacyCodeOf(r) ?? "",
      "النوع": r.customerType ?? "",
      "الهاتف": r.phone ?? "",
      "المدينة/المنطقة": [r.city, r.district].filter(Boolean).join(" / "),
      "فئة السعر": TIER_LABEL[r.defaultPriceTier] ?? r.defaultPriceTier ?? "",
      "سقف الائتمان": Number(r.creditLimit ?? 0),
      "الرصيد الحالي": Number(r.currentBalance ?? 0),
      "نشط": r.isActive ? "نعم" : "لا",
    }));
    const text = formatTableAsTSV(headers, tsvRows);
    const ok = await copy(text);
    if (ok) notify.ok(`تم نسخ ${selectedRows.length} عميلاً كَـTSV (الصق في Excel)`);
  }

  async function copySelectedAsWhatsAppSummary() {
    if (selectedRows.length === 0) return;
    // ملخّص قائمة: بطاقة لكل عميل مفصولة بسطر فارغ — قابلة للّصق في واتساب.
    const cards = selectedRows.map((r) =>
      formatCustomerCard({
        name: r.name ?? "",
        phone: r.phone,
        balance: r.currentBalance,
        legacyCode: legacyCodeOf(r),
      }),
    );
    const text = `قائمة العملاء (${selectedRows.length})\n\n${cards.join("\n\n")}`;
    const ok = await copy(text);
    if (ok) notify.ok(`تم نسخ ملخّص ${selectedRows.length} عميلاً لواتساب`);
  }

  async function toggle(id: number, isActive: boolean, name: string) {
    if (isActive) {
      if (!(await confirm({
        variant: "danger",
        title: "تعطيل العميل",
        description: `سيُستثنى «${name}» من قوائم البيع. الفواتير المسوّاة تبقى. هل تتابع؟`,
        confirmText: "تعطيل",
      }))) return;
      deactivate.mutate({ customerId: id });
    } else {
      activate.mutate({ customerId: id });
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">العملاء</h1>

      <ImportDialog<CustomerImportRow>
        open={importOpen}
        onOpenChange={setImportOpen}
        title="استيراد عملاء من Excel/CSV"
        entityName="عميل"
        fields={CUSTOMER_FIELDS}
        meta={CUSTOMER_IMPORT_META}
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
            utils.customers.list.invalidate();
            utils.customers.search.invalidate();
          }
        }}
      />
      <p className="text-sm text-muted-foreground">
        إدارة العملاء (أفراد/تجّار/شركات/حكومي): إضافة، تعديل، تعطيل، بحث، ومتابعة الرصيد المفتوح.
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
              placeholder: "بحث (اسم/هاتف/رقم قديم)",
            }}
            filters={
              <>
                <select
                  className={selectCls}
                  value={customerType}
                  onChange={(e) => { setCustomerType(e.target.value as any); setPage(0); }}
                  aria-label="النوع"
                >
                  <option value="">كل الأنواع</option>
                  {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select
                  className={selectCls}
                  value={priceTier}
                  onChange={(e) => { setPriceTier(e.target.value as any); setPage(0); }}
                  aria-label="فئة السعر"
                >
                  <option value="">كل الفئات</option>
                  <option value="RETAIL">مفرد</option>
                  <option value="WHOLESALE">جملة</option>
                  <option value="GOVERNMENT">حكومي</option>
                </select>
                <label className="flex items-center gap-2 h-8 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={includeInactive}
                    onChange={(e) => { setIncludeInactive(e.target.checked); setPage(0); }}
                  />
                  <span className="text-muted-foreground">عرض المعطّلين</span>
                </label>
              </>
            }
            exportSpec={{
              filename: "العملاء",
              rows,
              columns: [
                { key: "name", header: "الاسم" },
                { key: "legacyCode", header: "الرقم القديم", map: (r) => legacyCodeOf(r) ?? "" },
                { key: "customerType", header: "النوع" },
                { key: "phone", header: "الهاتف" },
                { key: "city", header: "المدينة", map: (r) => [r.city, r.district].filter(Boolean).join(" / ") || "" },
                { key: "defaultPriceTier", header: "فئة السعر" },
                { key: "creditLimit", header: "سقف الائتمان", map: (r) => Number(r.creditLimit ?? 0) },
                { key: "currentBalance", header: "الرصيد الحالي", map: (r) => Number(r.currentBalance ?? 0) },
                { key: "isActive", header: "نشط", map: (r) => (r.isActive ? "نعم" : "لا") },
              ],
            }}
            onImport={() => setImportOpen(true)}
            importLabel="استيراد Excel"
            add={{ href: "/customers/new", label: "عميل جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-end">
                <th className="p-2 w-8 text-center">
                  <input
                    type="checkbox"
                    className="size-4"
                    aria-label="تحديد كل العملاء في الصفحة"
                    checked={allOnPageSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allOnPageSelected && someOnPageSelected;
                    }}
                    onChange={(e) => sel.setMany(pageIds, e.target.checked)}
                  />
                </th>
                <th className="p-2">الاسم</th>
                {hasLegacy && <th className="p-2">الرقم القديم</th>}
                <th className="p-2">النوع</th>
                <th className="p-2">الهاتف</th>
                <th className="p-2">المدينة/المنطقة</th>
                <th className="p-2">فئة السعر</th>
                <th className="p-2 text-start">سقف الائتمان</th>
                <th className="p-2 text-start">الرصيد</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const id = Number(c.id);
                const isActive = !!c.isActive;
                return (
                  <tr key={id} className={`border-t ${isActive ? "" : "opacity-60"}`}>
                    <td className="p-2 text-center">
                      <input
                        type="checkbox"
                        className="size-4"
                        aria-label={`تحديد ${c.name ?? "العميل"}`}
                        checked={sel.isSelected(id)}
                        onChange={() => sel.toggle(id)}
                      />
                    </td>
                    <td className="p-2 font-medium">{c.name}</td>
                    {hasLegacy && (
                      <td className="p-2 text-xs tabular-nums text-muted-foreground" dir="ltr">
                        {legacyCodeOf(c) ?? "—"}
                      </td>
                    )}
                    <td className="p-2 text-xs">{c.customerType ?? "—"}</td>
                    <td className="p-2"><CopyInline value={c.phone} /></td>
                    <td className="p-2 text-xs">{[c.city, c.district].filter(Boolean).join(" / ") || "—"}</td>
                    <td className="p-2 text-xs">{TIER_LABEL[c.defaultPriceTier] ?? c.defaultPriceTier}</td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(c.creditLimit)}</td>
                    <td className="p-2 text-start">
                      <BalanceCell amount={c.currentBalance} entityType="customer" />
                    </td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                        {isActive ? "مفعّل" : "معطّل"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      {/* ٣ إجراءات ⇒ auto يحوّلها لقائمة ⋯ تلقائياً (إسقاط inline مقصود) */}
                      <RowActions
                        actions={[
                          { key: "edit", label: "تعديل", href: `/customers/${id}/edit` },
                          // كشف الحساب يقرأ ?id= من URL (نمط CustomerStatement)
                          { key: "stmt", label: "كشف حساب", href: `/customers-statement?id=${id}` },
                          {
                            key: "toggle",
                            label: isActive ? "تعطيل" : "تفعيل",
                            variant: isActive ? "destructive" : "default",
                            disabled: deactivate.isPending || activate.isPending,
                            onSelect: () => void toggle(id, isActive, c.name ?? ""),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {!list.isLoading && rows.length === 0 && (
                <tr><td colSpan={hasLegacy ? 11 : 10} className="p-6 text-center text-muted-foreground">لا عملاء مطابقين. أضف عميلاً جديداً أو غيّر الفلاتر.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            ← السابق
          </Button>
          <div className="text-muted-foreground">صفحة {page + 1} من {pages}</div>
          <Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
            التالي →
          </Button>
        </div>
      )}

      {/* شريط التحديد الجماعي: TSV لـExcel + ملخّص واتساب لقائمة العملاء. */}
      <SelectionBar
        count={sel.count}
        onClear={sel.clear}
        onExport={copySelectedAsTSV}
        exportLabel="نَسخ المُحَدَّد كَـTSV"
        onPrint={copySelectedAsWhatsAppSummary}
        printLabel="ملخّص واتساب"
      />
    </div>
  );
}
