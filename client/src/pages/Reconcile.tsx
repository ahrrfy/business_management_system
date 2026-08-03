import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { fmt } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { trpc } from "@/lib/trpc";
import { exportSheets } from "@/lib/export";
import { AlertTriangle, Check, ClipboardList, FileDown } from "lucide-react";
import { Link } from "wouter";
import { RowActions } from "@/components/list";
import { useMemo } from "react";

/* ═══════════ شاشة تدقيق التوافق المالي (admin فقط) ═══════════
   تستهلك reports.reconcile (adminProcedure) لكشف الانجراف الصامت بين
   الأرصدة المُشتقّة والمسجَّلة في الذمم والعهد والمخزون والدفتر.
═══════════════════════════════════════════════════════════════ */

type Row = { entity: string; id: number; expected: string; actual: string; drift: string; note?: string };

export default function Reconcile() {
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  // الفحص ثقيل نسبياً — لا يُطلَق إلا للمدير، وبلا إعادة جلب تلقائية.
  const recon = trpc.reports.reconcile.useQuery(undefined, {
    enabled: isAdmin,
    refetchOnWindowFocus: false,
  });

  const data = recon.data;

  // أسماء الأطراف لعرضها بجانب المعرّفات الرقمية — تُجلَب فقط عند وجود انحرافات فعلية لهذا
  // المحور (لا داعٍ لجلب القوائم الكاملة عند عدم وجود صفوف تحتاجها). هذه الاستعلامات (وما
  // تحتها من useMemo) يجب أن تُستدعى في كل تصيير بلا شرط (قاعدة الخطاطيف) — لذا هي **قبل**
  // حاجز «غير المدير» أدناه لا بعده، رغم أنها لا تُفعَّل (enabled) إلا للمدير أصلاً.
  const customersQ = trpc.customers.list.useQuery(undefined, { enabled: isAdmin && !!data?.customers.length });
  const suppliersQ = trpc.suppliers.list.useQuery(undefined, { enabled: isAdmin && !!data?.suppliers.length });
  const partiesQ = trpc.delivery.listParties.useQuery({}, { enabled: isAdmin && !!data?.delivery.length });
  const customerNames = useMemo(() => new Map((customersQ.data ?? []).map((c) => [c.id, c.name])), [customersQ.data]);
  const supplierNames = useMemo(() => new Map((suppliersQ.data ?? []).map((s) => [s.id, s.name])), [suppliersQ.data]);
  const partyNames = useMemo(() => new Map((partiesQ.data ?? []).map((p) => [p.id, p.name])), [partiesQ.data]);

  // غير المدير: حاجز واضح (الخادم يرفضها أصلاً بـadminProcedure — هذا دفاع طبقي + رسالة لطيفة).
  if (me.data && !isAdmin) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        هذه الشاشة مخصّصة لمسؤول النظام فقط.
      </div>
    );
  }

  const total = data
    ? data.customers.length + data.suppliers.length + data.delivery.length + data.inventory.length + data.ledger.length
    : 0;
  const loading = me.isLoading || (isAdmin && recon.isLoading);

  // تصدير Excel — ورقة مستقلّة لكل محور بنفس بيانات الجدول المعروض (تشمل الأسماء حيث توفّرت).
  function exportAll() {
    if (!data) return;
    const sheet = (title: string, rows: Row[], names?: Map<number, string>) => ({
      sheetName: title,
      title: `تدقيق التوافق المالي — ${title}`,
      meta: [{ label: "تاريخ الفحص", value: fmtDateTime(data.runAt) }],
      columns: [
        { key: "id", header: "المعرّف" },
        ...(names ? [{ key: "name", header: "الاسم", map: (r: any) => names.get(r.id) ?? "—" }] : []),
        { key: "expected", header: "المتوقّع", money: true, map: (r: any) => Number(r.expected) },
        { key: "actual", header: "الفعلي", money: true, map: (r: any) => Number(r.actual) },
        { key: "drift", header: "الانحراف", money: true, map: (r: any) => Number(r.drift) },
        { key: "note", header: "ملاحظة", map: (r: any) => r.note ?? "" },
      ],
      rows: rows as any[],
    });
    exportSheets("تدقيق-التوافق-المالي", [
      sheet("ذمم العملاء", data.customers, customerNames),
      sheet("ذمم الموردين", data.suppliers, supplierNames),
      sheet("عهدة التوصيل", data.delivery, partyNames),
      sheet("أرصدة المخزون", data.inventory),
      sheet("قيود الدفتر", data.ledger),
    ]);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="تدقيق التوافق المالي"
        description="يكشف الانجراف الصامت في ذمم العملاء والموردين، عهدة تحصيلات التوصيل، المخزون والدفتر. الأخضر = متوازن، الأحمر = انحراف يستوجب المراجعة. لا يصحّح النظام أي فرق بصمت."
        actions={
          <div className="flex items-center gap-3">
            {data && (
              <span className="text-xs text-muted-foreground" dir="ltr">
                آخر فحص: <span dir="ltr" className="tabular-nums">{fmtDateTime(data.runAt)}</span>
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!data}
              onClick={exportAll}
              className="inline-flex items-center gap-1.5"
            >
              <FileDown aria-hidden className="size-4" />
              تصدير Excel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!isAdmin || recon.isFetching}
              onClick={() => recon.refetch()}
            >
              {recon.isFetching ? "جارٍ الفحص…" : "إعادة الفحص"}
            </Button>
          </div>
        }
      />

      {loading && <LoadingState />}

      {recon.error && (
        <ErrorState message={`تعذّر التدقيق: ${recon.error.message}`} onRetry={() => recon.refetch()} />
      )}

      {data && !recon.error && (
        <>
          <Card>
            <CardContent
              className={`p-6 text-center text-lg font-bold inline-flex items-center justify-center gap-2 w-full ${
                total === 0 ? "badge-status-active" : "badge-stock-out"
              }`}
            >
              {total === 0 ? (
                <>
                  <Check aria-hidden className="size-5" />
                  كل المحاور متوازنة — لا انحراف
                </>
              ) : (
                <>
                  <AlertTriangle aria-hidden className="size-5" />
                  {`${total} انحراف يستوجب المراجعة`}
                </>
              )}
            </CardContent>
          </Card>

          <DriftSection
            title="ذمم العملاء"
            desc="الفرق بين الرصيد المُشتقّ من الفواتير (إجمالي − مدفوع − مُرتجَع) والمسجَّل في currentBalance."
            idLabel="رقم العميل"
            money
            rows={data.customers}
            names={customerNames}
            link={(id) => `/customers-statement?id=${id}`}
            linkLabel="كشف الحساب"
          />

          <DriftSection
            title="ذمم الموردين"
            desc="الفرق بين الرصيد المُشتقّ من المشتريات والتسديدات والمسجَّل على المورد."
            idLabel="رقم المورد"
            money
            rows={data.suppliers}
            names={supplierNames}
            link={(id) => `/suppliers-statement?id=${id}`}
            linkLabel="كشف الحساب"
          />

          <DriftSection
            title="عهدة تحصيلات التوصيل"
            desc="الفرق بين مبالغ COD المسلّمة للمندوب والمبالغ المورّدة أو المشطوبة وبين رصيده المسجّل."
            idLabel="رقم جهة التوصيل"
            money
            rows={data.delivery}
            names={partyNames}
            link={() => "/delivery?tab=parties"}
            linkLabel="جهات التوصيل"
          />

          <DriftSection
            title="أرصدة المخزون"
            desc="رصيد سالب لمتغيّر في فرع — يجب ألّا يقلّ عن صفر."
            idLabel="رقم المتغيّر"
            rows={data.inventory}
            link={() => `/inventory`}
            linkLabel="المخزون"
            action={
              data.inventory.length > 0 ? (
                <Link
                  href={`/stocktakes/new?variants=${Array.from(new Set(data.inventory.map((r) => r.id))).join(",")}&name=${encodeURIComponent("جرد تحقّق — انحرافات التدقيق المالي")}`}
                >
                  <Button size="sm" className="inline-flex items-center gap-1.5"><ClipboardList aria-hidden className="size-4" />أنشئ جلسة جرد لهذه المنتجات</Button>
                </Link>
              ) : null
            }
          />

          <DriftSection
            title="قيود الدفتر"
            desc="قيود لا يتطابق فيها الربح مع (الإيراد − التكلفة)."
            idLabel="رقم القيد"
            money
            rows={data.ledger}
          />
        </>
      )}
    </div>
  );
}

function DriftSection({
  title,
  desc,
  idLabel,
  rows,
  money,
  link,
  linkLabel,
  action,
  names,
}: {
  title: string;
  desc: string;
  idLabel: string;
  rows: Row[];
  money?: boolean;
  link?: (id: number) => string;
  linkLabel?: string;
  action?: React.ReactNode;
  /** اسم الطرف (عميل/مورّد/جهة توصيل) بحسب المعرّف — يُعرض تحت الرقم إن تُوفِّر. */
  names?: Map<number, string>;
}) {
  const val = (s: string) => (money ? fmt(s) : s);
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-2 border-b p-3">
          <div>
            <h2 className="font-semibold">{title}</h2>
            <p className="text-xs text-muted-foreground">{desc}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {action}
            <span
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold inline-flex items-center gap-1 ${
                rows.length === 0 ? "badge-status-active" : "badge-stock-out"
              }`}
            >
              {rows.length === 0 ? (
                <>
                  <Check aria-hidden className="size-3.5" />
                  لا انحراف
                </>
              ) : (
                `${rows.length} انحراف`
              )}
            </span>
          </div>
        </div>
        {rows.length > 0 && (
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2">{idLabel}</th>
                <th className="p-2 text-right">المتوقّع</th>
                <th className="p-2 text-right">الفعلي</th>
                <th className="p-2 text-right">الانحراف</th>
                {link && <th className="p-2 text-center">إجراء</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                // المخزون: متغيّر سالب في فرعين يُنتج id مكرّراً (reconcileInventory يُسقط branchId) ⇒ مفتاح مركّب بالـindex.
                <tr key={`${title}-${r.id}-${i}`} className="border-t">
                  <td className="p-2 font-medium">
                    <div className="tabular-nums" dir="ltr">{r.id}</div>
                    {names && (
                      <div className="text-xs font-normal text-muted-foreground">{names.get(r.id) ?? "—"}</div>
                    )}
                  </td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">
                    {val(r.expected)}
                  </td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">
                    {val(r.actual)}
                  </td>
                  <td className="p-2 text-right font-semibold tabular-nums text-money-negative" dir="ltr">
                    {val(r.drift)}
                    {r.note && (
                      <span dir="rtl" className="mr-2 inline-block rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-bold text-amber-800">
                        {r.note}
                      </span>
                    )}
                  </td>
                  {link && (
                    <td className="p-2 text-center">
                      <RowActions
                        mode="inline"
                        actions={[{
                          key: "open",
                          kind: "view",
                          label: linkLabel,
                          href: link(r.id),
                          gate: { adminOnly: true },
                        }]}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </ScrollTableShell>
        )}
      </CardContent>
    </Card>
  );
}
