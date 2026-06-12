import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmt } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";

/* ═══════════ شاشة تدقيق التوافق المالي (admin فقط) ═══════════
   تستهلك reports.reconcile (adminProcedure) لكشف الانجراف الصامت بين
   الأرصدة المُشتقّة والمسجَّلة في ثلاثة محاور: ذمم العملاء، المخزون، الدفتر.
═══════════════════════════════════════════════════════════════ */

type Row = { entity: string; id: number; expected: string; actual: string; drift: string };

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
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">تدقيق التوافق المالي</h1>
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
      </div>

      <p className="text-sm text-muted-foreground">
        يكشف الانجراف الصامت بين الأرصدة المُشتقّة والمسجَّلة في ثلاثة محاور: ذمم العملاء، أرصدة
        المخزون، وقيود الأرباح في الدفتر. الأخضر = متوازن، الأحمر = انحراف يستوجب المراجعة. يُنصَح
        بتشغيله دورياً وقبل إقفال الفترات.
      </p>

      {loading && (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">جارٍ التدقيق…</CardContent>
        </Card>
      )}

      {recon.error && (
        <Card>
          <CardContent className="p-6 text-center text-rose-600">
            تعذّر التدقيق: {recon.error.message}
          </CardContent>
        </Card>
      )}

      {data && !recon.error && (
        <>
          <Card>
            <CardContent
              className={`p-6 text-center text-lg font-bold ${
                total === 0 ? "text-emerald-700" : "text-rose-700"
              }`}
            >
              {total === 0
                ? "✓ كل المحاور متوازنة — لا انحراف"
                : `⚠ ${total} انحراف يستوجب المراجعة`}
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
                  <Button size="sm">📋 أنشئ جلسة جرد لهذه الأصناف</Button>
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
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
                rows.length === 0
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-rose-50 text-rose-700"
              }`}
            >
              {rows.length === 0 ? "✓ لا انحراف" : `${rows.length} انحراف`}
            </span>
          </div>
        </div>
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">{idLabel}</th>
                <th className="p-2 text-left">المتوقّع</th>
                <th className="p-2 text-left">الفعلي</th>
                <th className="p-2 text-left">الانحراف</th>
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
                  <td className="p-2 text-left tabular-nums" dir="ltr">
                    {val(r.expected)}
                  </td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">
                    {val(r.actual)}
                  </td>
                  <td className="p-2 text-left font-semibold tabular-nums text-rose-700" dir="ltr">
                    {val(r.drift)}
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
        )}
      </CardContent>
    </Card>
  );
}
