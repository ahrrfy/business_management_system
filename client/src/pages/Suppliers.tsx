import { CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BalanceCell } from "@/components/BalanceBadge";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { ImportDialog } from "@/components/import/ImportDialog";
import { FilterField, ListToolbar, RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, TableEmptyRow } from "@/components/PageState";
import { OperationsSummary } from "@/components/operations/OperationsSummary";
import { confirm } from "@/lib/confirm";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { SUPPLIER_FIELDS, SUPPLIER_IMPORT_META } from "@/lib/importFields";
import type { SupplierImportRow } from "@/lib/importTypes";
import { fmtAr as fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { buildOperationalContactMessage } from "@/lib/whatsapp";

/** نوع صفّ المورّد صريحاً — يتجنّب فشل استدلال T بسبب اتحاد تقنيع التكلفة (maskSupplierSensitive). */
type Row = RouterOutputs["suppliers"]["search"]["rows"][number];

/** الرقم القديم (legacyCode) من صف القائمة — null إن فارغاً (العمود يظهر فقط حين توجد قيم).
 *  select القائمة في supplierService يعيده ويُدخله البحث (شريحة تكامل الاستيراد). */
function legacyCodeOf(r: { legacyCode?: string | null }): string | null {
  const v = r.legacyCode;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export default function Suppliers() {
  const utils = trpc.useUtils();
  // مرآة بوّابة الخادم: أفعال الكتابة (إضافة/تعديل/تعطيل/تفعيل) على
  // suppliersManagerProcedure(["manager","warehouse","purchasing"], suppliers, FULL) — server/trpc.ts.
  // بنفس دالة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية) ⇒ لا تباعُد (نمط InvoiceDetail).
  const me = trpc.auth.me.useQuery();
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";
  const canWrite = !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "suppliers", "FULL", ["manager", "warehouse", "purchasing"]);
  // الاستيراد بوّابته أضيق: imports.suppliers = managerProcedure (المدير فأعلى) — server/routers/imports.ts.
  const canImport = me.data?.role === "admin" || me.data?.role === "manager";
  // الحذف النهائيّ: suppliers.delete = managerProcedure (أدمن/مدير) — عمليةٌ لا رجعة فيها لتنظيف
  // أخطاء الإدخال الأوّليّ، والحارس الخادميّ يرفض أيّ مورّدٍ له حركة (يوجّه للتعطيل).
  const canDelete = me.data?.role === "admin" || me.data?.role === "manager";
  // رابطُ اسم المورّد ⇒ كشف الحساب. تبويب `statement` في SuppliersHub مُحصَّنٌ صراحةً بـ
  // `managerOnly: true` ولا يحترم `permissionsOverride` (نمط ٢٤/٨ في Purchases). البوّابةُ
  // الصحيحة الوحيدة هي الدور الصريح لا `moduleAccessAllowed("reports","READ")` — التمرير
  // بالـoverride يُظهر رابطاً يُدفَع خارج التبويب صامتاً.
  const canOpenStatement = isElevated;
  // فلاتر في querystring — تعيش مع فتح تفاصيل المورّد والرجوع، ويمكن مشاركتها رابطاً.
  const [filters, setFilters, resetFilters] = useUrlFilters({ q: "", inactive: "", kind: "", page: "0" });
  // تصحيح قيم URL (Codex P2): querystring يمكن أن يحمل قيماً باطلة (مشاركة/تعديل يدوي) ⇒
  // fall-back للافتراضي بدل تمرير قيمة تكسر عقد الخادم (Zod schema يرفضها فيُفشِل list كاملاً).
  const q = filters.q;
  const includeInactive = filters.inactive === "1";
  // بضاعة الأمانة (٢٠/٧): فلتر نوع الطرف — الكل / موردون اعتياديون / مودِعو أمانة.
  const kind: "" | "REGULAR" | "CONSIGNOR" =
    filters.kind === "REGULAR" || filters.kind === "CONSIGNOR" ? filters.kind : "";
  const pageNum = Number(filters.page);
  const page = Number.isFinite(pageNum) && pageNum >= 0 ? Math.floor(pageNum) : 0;
  const setQ = (v: string) => setFilters({ q: v, page: "0" });
  const setIncludeInactive = (v: boolean) => setFilters({ inactive: v ? "1" : "", page: "0" });
  const setKind = (v: "" | "REGULAR" | "CONSIGNOR") => setFilters({ kind: v, page: "0" });
  const setPage = (updater: number | ((p: number) => number)) =>
    setFilters({ page: String(typeof updater === "function" ? updater(page) : updater) });
  const [importOpen, setImportOpen] = useState(false);
  const importMut = trpc.imports.suppliers.useMutation();
  const limit = 50;

  const input = useMemo(
    () => ({ q: q.trim() || undefined, includeInactive, kind: kind || undefined, limit, offset: page * limit }),
    [q, includeInactive, kind, page],
  );

  const list = trpc.suppliers.search.useQuery(input);
  const summary = trpc.suppliers.summary.useQuery(
    { q: q.trim() || undefined, includeInactive, kind: kind || undefined },
    { enabled: isElevated },
  );
  const invalidate = () => {
    utils.suppliers.search.invalidate();
    utils.suppliers.list.invalidate();
    utils.suppliers.summary.invalidate();
  };
  const deactivate = trpc.suppliers.deactivate.useMutation({
    onSuccess: () => { invalidate(); notify.ok("تم تعطيل المورّد"); },
    onError: (e) => notify.err(e),
  });
  const activate = trpc.suppliers.activate.useMutation({
    onSuccess: () => { invalidate(); notify.ok("تم تفعيل المورّد"); },
    onError: (e) => notify.err(e),
  });
  const del = trpc.suppliers.delete.useMutation({
    onSuccess: () => { invalidate(); notify.ok("تم حذف المورّد نهائياً"); },
    onError: (e) => notify.err(e),
  });

  const total = list.data?.total ?? 0;
  const rows = list.data?.rows ?? [];
  const pages = Math.max(1, Math.ceil(total / limit));
  // Codex P2 (٢٤/٨، PR #751): رابطٌ مُشارَك بـ`page=9` مع نتائج تقلّصت إلى صفحةٍ واحدة كان يُنتج
  // «251–100 من 100» ويُخفي جدولاً بينما `total > 0`. نُصحّح URL إلى آخر صفحةٍ صالحة (لا 0) —
  // 0 يفقد سياق «كان مُشاركاً في نهاية القائمة»، والأخيرةُ الصالحة أقرب لنيّة الرابط. الشرطُ
  // مُقيَّدٌ بـ`list.data`: أثناء التحميل الأوّل نتركُ الحال بلا مسّ (`total=0` كذبة عابرة).
  useEffect(() => {
    if (list.data && page >= pages) setPage(Math.max(0, pages - 1));
  }, [list.data, page, pages]);
  // للعرضِ في هذا التمرير قبل ما يستقرّ الـURL: نستعمل نسخةً محبوسة داخل [0, pages-1].
  const displayPage = Math.min(page, Math.max(0, pages - 1));
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

  async function remove(id: number, name: string) {
    if (!(await confirm({
      variant: "danger",
      title: "حذف المورّد نهائياً",
      description: `سيُحذف «${name}» نهائياً مع رصيده الافتتاحي — لا يمكن التراجع. الحذف مسموح فقط لمورّدٍ بلا أي حركة (أوامر شراء/دفعات/أصول…)؛ إن كان له حركة استعمل «تعطيل» بدلاً منه.`,
      confirmText: "حذف نهائي",
    }))) return;
    del.mutate({ supplierId: id });
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
              onChange: setQ,
              placeholder: "بحث (اسم/هاتف/مدينة/رقم قديم)",
              // ٢٤/٨ (Codex P2 على PR #760): لا `autoFocus` — الصفحةُ تبويبٌ داخل SuppliersHub،
              // فالتركيزُ التلقائيّ يسرق التركيزَ من زرّ التبويب فينكسر ملاحةُ الأسهم بين التبويبات.
            }}
            activeFilterCount={[kind, includeInactive ? "1" : ""].filter(Boolean).length}
            onResetFilters={resetFilters}
            filters={
              <>
                {/* FilterField يُظهر التسمية بصرياً — aria-label على radiogroup لا يُرى (نمط PR #559/#566). */}
                <FilterField label="نوع الطرف" asGroup>
                  <div className="flex items-center gap-1" role="radiogroup" aria-label="نوع الطرف">
                    {([
                      { v: "", label: "الكل" },
                      { v: "REGULAR", label: "موردون" },
                      { v: "CONSIGNOR", label: "مودِعو أمانة" },
                    ] as const).map((t) => (
                      <button
                        key={t.v}
                        type="button"
                        role="radio"
                        aria-checked={kind === t.v}
                        onClick={() => setKind(t.v)}
                        className={`h-8 rounded-md border px-2.5 text-xs transition-colors ${
                          kind === t.v
                            ? t.v === "CONSIGNOR" ? "border-amber-400 bg-amber-50 text-amber-900" : "border-primary bg-primary/10 text-foreground"
                            : "border-input text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </FilterField>
                <label className="flex items-center gap-2 h-8 text-sm self-end">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={includeInactive}
                    onChange={(e) => setIncludeInactive(e.target.checked)}
                  />
                  <span className="text-muted-foreground">عرض المعطّلين</span>
                </label>
              </>
            }
            exportSpec={{
              filename: "الموردون",
              rows,
              // تصدير شامل: يجلب كل النتائج المطابقة للفلاتر الحالية (لا الصفحة المعروضة فقط).
              fetchAll: () =>
                fetchAllPaged<Row>(
                  (offset, lim) =>
                    utils.suppliers.search
                      .fetch({ q: q.trim() || undefined, includeInactive, kind: kind || undefined, limit: lim, offset })
                      .then((r) => ({ rows: r.rows, total: r.total })),
                  { pageSize: 500 },
                ),
              columns: [
                { key: "name", header: "الاسم" },
                { key: "legacyCode", header: "الرقم القديم", map: (r) => legacyCodeOf(r) ?? "" },
                { key: "phone", header: "الهاتف" },
                { key: "city", header: "المدينة" },
                { key: "paymentTerms", header: "شروط الدفع" },
                { key: "currentBalance", header: "الرصيد الحالي", map: (r) => Number(r.currentBalance ?? 0) },
                { key: "currentBalanceUsd", header: "الرصيد الدولاري", map: (r) => Number(r.currentBalanceUsd ?? 0) },
                { key: "isActive", header: "نشط", map: (r) => (r.isActive ? "نعم" : "لا") },
              ],
            }}
            onImport={canImport ? () => setImportOpen(true) : undefined}
            importLabel="استيراد Excel"
            add={canWrite ? { href: "/suppliers/new", label: "مورّد جديد" } : undefined}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2">الاسم</th>
                {hasLegacy && <th className="p-2">الرقم القديم</th>}
                <th className="p-2">الهاتف</th>
                <th className="p-2">المدينة</th>
                <th className="p-2">شروط الدفع</th>
                <th className="p-2 text-start">الرصيد</th>
                <th className="p-2 text-start">الرصيد $</th>
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
                    <td className="p-2 font-medium">
                      {canOpenStatement ? (
                        <Link
                          href={`/suppliers-statement?id=${id}`}
                          className="text-primary hover:underline"
                          title="فتح كشف الحساب"
                        >
                          {s.name}
                        </Link>
                      ) : (
                        s.name
                      )}
                      {(s as { supplierKind?: string }).supplierKind === "CONSIGNOR" && (
                        <span
                          className="mr-1.5 inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 align-middle text-[10px] font-bold text-amber-800"
                          title="مودِعُ أمانة — بضاعتُه ملكُه، حصّتُه في تكلفة السطر"
                        >
                          أمانة
                        </span>
                      )}
                    </td>
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
                    <td className="p-2 text-start font-medium tabular-nums" dir="ltr">
                      {Number(s.currentBalanceUsd ?? 0) !== 0 ? `$${fmt(s.currentBalanceUsd)}` : "—"}
                    </td>
                    <td className="p-2 text-center">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "badge-status-active" : "badge-stock-out"}`}
                        title={isActive ? "نشط — يظهر في قوائم الشراء" : "معطّل — مستثنى من قوائم الشراء (أوامر الشراء المسوّاة تبقى)"}
                      >
                        {isActive ? "مفعّل" : "معطّل"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      {/* ٤ إجراءات ⇒ auto يحوّلها لقائمة ⋯ تلقائياً (إسقاط inline مقصود) */}
                      <RowActions
                        contact={{
                          phone: s.phone,
                          whatsapp: (s as { whatsapp?: string | null }).whatsapp,
                          alternativePhones: [
                            (s as { phone2?: string | null }).phone2,
                            (s as { phone3?: string | null }).phone3,
                          ],
                          label: `واتساب ${s.name}`,
                          message: buildOperationalContactMessage({
                            partyName: s.name,
                            entityLabel: "حساب المورّد",
                            nextAction: "نتواصل معكم لمتابعة طلب شراء أو تسوية الحساب. يرجى الرد عند الملاءمة.",
                          }),
                          gate: { module: "suppliers", level: "READ" },
                        }}
                        actions={[
                          {
                            key: "edit",
                            kind: "edit",
                            label: "تعديل",
                            href: `/suppliers/${id}/edit`,
                            hidden: !canWrite,
                            gate: { roles: ["manager", "warehouse", "purchasing"], module: "suppliers", level: "FULL" },
                          },
                          // كشف الحساب يقرأ ?id= من URL (نمط SupplierStatement)
                          {
                            key: "stmt",
                            kind: "view",
                            label: "كشف حساب",
                            href: `/suppliers-statement?id=${id}`,
                            gate: { module: "suppliers", level: "READ" },
                          },
                          {
                            key: "pay",
                            kind: "pay",
                            label: "سند صرف له",
                            href: "/vouchers/payment/new",
                            gate: { roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                          },
                          {
                            key: "toggle",
                            kind: "approve",
                            label: isActive ? "تعطيل" : "تفعيل",
                            variant: isActive ? "destructive" : "default",
                            disabled: deactivate.isPending || activate.isPending,
                            disabledReason: "توجد عملية تحديث قيد التنفيذ",
                            hidden: !canWrite,
                            onSelect: () => void toggle(id, isActive, s.name ?? ""),
                            gate: { roles: ["manager", "warehouse", "purchasing"], module: "suppliers", level: "FULL" },
                          },
                          {
                            key: "delete",
                            kind: "delete",
                            label: "حذف نهائي",
                            variant: "destructive",
                            disabled: del.isPending,
                            disabledReason: "توجد عملية حذف قيد التنفيذ",
                            hidden: !canDelete,
                            onSelect: () => void remove(id, s.name ?? ""),
                            gate: { managerOnly: true },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {list.isError && !list.isLoading && (
                <tr>
                  <td colSpan={hasLegacy ? 8 : 7}>
                    <ErrorState message={list.error?.message} onRetry={() => void list.refetch()} />
                  </td>
                </tr>
              )}
              {!list.isLoading && !list.isError && rows.length === 0 && (
                <TableEmptyRow
                  colSpan={hasLegacy ? 8 : 7}
                  message={
                    q || kind || includeInactive ? (
                      <div className="space-y-2">
                        <div>لا موردين مطابقين للفلاتر الحالية.</div>
                        <Button variant="outline" size="sm" onClick={resetFilters}>
                          مسح الفلاتر
                        </Button>
                      </div>
                    ) : (
                      "لا موردين بعد. أضف أوّل مورّد بزرّ «مورّد جديد» أعلاه."
                    )
                  }
                />
              )}
            </tbody>
          </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="text-muted-foreground">
            {pages > 1 ? (
              <>يعرض {(displayPage * limit + 1).toLocaleString("ar-IQ-u-nu-latn")}–
                {Math.min((displayPage + 1) * limit, total).toLocaleString("ar-IQ-u-nu-latn")} من
                {" "}
                {total.toLocaleString("ar-IQ-u-nu-latn")} مورّد</>
            ) : (
              <>الإجمالي: {total.toLocaleString("ar-IQ-u-nu-latn")} مورّد</>
            )}
          </div>
          {pages > 1 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={displayPage <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← السابق</Button>
              <div className="text-muted-foreground">صفحة {displayPage + 1} من {pages}</div>
              <Button variant="outline" size="sm" disabled={displayPage >= pages - 1} onClick={() => setPage((p) => p + 1)}>التالي →</Button>
            </div>
          )}
        </div>
      )}

      {isElevated && (
        <OperationsSummary
          title={kind === "CONSIGNOR" ? "ملخص مودعي الأمانة" : "ملخص نتائج الموردين"}
          subtitle="جميع الصفحات وفق البحث والفلاتر الحالية — الدينار والدولار محسوبان كلٌّ على حدة."
          loading={summary.isLoading}
          metrics={[
            {
              key: "total",
              label: "إجمالي الموردين",
              value: (summary.data?.total ?? 0).toLocaleString("ar-IQ-u-nu-latn"),
              detail: `${summary.data?.active ?? 0} مفعّل · ${summary.data?.inactive ?? 0} معطّل`,
            },
            {
              key: "payable",
              label: "لهم علينا",
              value: `${fmt(summary.data?.payableIqd ?? 0)} د.ع`,
              detail: `${summary.data?.nonZeroBalances ?? 0} أصحاب أرصدة`,
              tone: "danger",
            },
            {
              key: "receivable",
              label: "لنا عليهم",
              value: `${fmt(summary.data?.receivableIqd ?? 0)} د.ع`,
              tone: "success",
            },
            {
              key: "net",
              label: Number(summary.data?.netIqd ?? 0) === 0 ? "الصافي متعادل" : Number(summary.data?.netIqd ?? 0) > 0 ? "صافي علينا" : "صافي لنا",
              value: `${fmt(Math.abs(Number(summary.data?.netIqd ?? 0)))} د.ع`,
              tone: Number(summary.data?.netIqd ?? 0) === 0 ? "neutral" : Number(summary.data?.netIqd ?? 0) > 0 ? "danger" : "success",
            },
            {
              key: "usd",
              label: "الرصيد الدولاري",
              value: `$${fmt(summary.data?.payableUsd ?? 0)} علينا`,
              detail: `$${fmt(summary.data?.receivableUsd ?? 0)} لنا`,
              tone: "info",
            },
            {
              key: "highest",
              label: "أعلى التزام",
              value: summary.data?.highestPayable ? `${fmt(summary.data.highestPayable.amount)} د.ع` : "—",
              detail: summary.data?.highestPayable?.supplierName ?? "لا توجد أرصدة مستحقة",
              tone: "warning",
              onClick: summary.data?.highestPayable
                ? () => setQ(summary.data!.highestPayable!.supplierName)
                : undefined,
            },
          ]}
          footer={
            <p className="text-xs text-muted-foreground">
              التوزيع: {summary.data?.regular ?? 0} مورد اعتيادي · {summary.data?.consignors ?? 0} مودع أمانة.
            </p>
          }
        />
      )}
    </div>
  );
}
