import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { fmt } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, Check, ClipboardList } from "lucide-react";
import { Link } from "wouter";

/* ═══════════ شاشة تدقيق التوافق المالي (admin فقط) ═══════════
   تستهلك reports.reconcile (adminProcedure) لكشف الانجراف الصامت بين
   الأرصدة المُشتقّة والمسجَّلة في ثلاثة محاور: ذمم العملاء، المخزون، الدفتر.
═══════════════════════════════════════════════════════════════ */

type Row = { entity: string; id: number; expected: string; actual: string; drift: string; note?: string };

export default function Reconcile() {
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  // الفحص ثقيل نسبياً (٣ استعلامات تجميعية) — لا يُطلَق إلا للمدير، وبلا إعادة جلب تلقائية.
  const recon = trpc.reports.reconcile.useQuery(undefined, {
    enabled: isAdmin,
    refetchOnWindowFocus: false,
  });

  // غير المدير: حاجز واضح (الخادم يرفضها أصلاً بـadminProcedure — هذا دفاع طبقي + رسالة لطيفة).
  if (me.data && !isAdmin) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        هذه الشاشة مخصّصة للمدير (admin) فقط.
      </div>
    );
  }

  const data = recon.data;
  const total = data
    ? data.customers.length + data.inventory.length + data.ledger.length
    : 0;
  const loading = me.isLoading || (isAdmin && recon.isLoading);

  return (
    <div className="space-y-4">
      <PageHeader
        title="تدقيق التوافق المالي"
        description="يكشف الانجراف الصامت بين الأرصدة المُشتقّة والمسجَّلة في ثلاثة محاور: ذمم العملاء، أرصدة المخزون، وقيود الأرباح في الدفتر. الأخضر = متوازن، الأحمر = انحراف يستوجب المراجعة. يُنصَح بتشغيله دورياً وقبل إقفال الفترات."
        actions={
          <div className="flex items-center gap-3">
            {data && (
              <span className="text-xs text-muted-foreground" dir="ltr">
                آخر فحص: {new Date(data.runAt).toLocaleString("ar-IQ-u-nu-latn")}
              </span>
            )}
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
            link={(id) => `/customers-statement?id=${id}`}
            linkLabel="كشف الحساب"
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
}: {
  title: string;
  desc: string;
  idLabel: string;
  rows: Row[];
  money?: boolean;
  link?: (id: number) => string;
  linkLabel?: string;
  action?: React.ReactNode;
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
                  <td className="p-2 font-medium tabular-nums" dir="ltr">
                    {r.id}
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
                      <Link href={link(r.id)}>
                        <Button variant="outline" size="sm">
                          {linkLabel}
                        </Button>
                      </Link>
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
