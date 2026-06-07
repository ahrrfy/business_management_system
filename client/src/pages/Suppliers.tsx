import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";

function fmt(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === "") return "—";
  return Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });
}

export default function Suppliers() {
  const utils = trpc.useUtils();
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
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
  const deactivate = trpc.suppliers.deactivate.useMutation({ onSuccess: invalidate });
  const activate = trpc.suppliers.activate.useMutation({ onSuccess: invalidate });

  const total = list.data?.total ?? 0;
  const rows = list.data?.rows ?? [];
  const pages = Math.max(1, Math.ceil(total / limit));

  function toggle(id: number, isActive: boolean) {
    if (isActive) {
      if (!confirm("تأكيد تعطيل المورّد؟ لن يظهر في قوائم الشراء.")) return;
      deactivate.mutate({ supplierId: id });
    } else {
      activate.mutate({ supplierId: id });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">الموردون</h1>
        <Link href="/suppliers/new"><Button>+ مورّد جديد</Button></Link>
      </div>
      <p className="text-sm text-muted-foreground">
        إدارة الموردين: إضافة، تعديل، تعطيل، بحث، ومتابعة الرصيد الدائن المفتوح.
      </p>

      <Card>
        <CardHeader><CardTitle className="text-base">الفلاتر والبحث</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div className="space-y-1 md:col-span-2">
            <Label>بحث (اسم/هاتف/مدينة)</Label>
            <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="مثال: مكتبة الرشيد أو 0770..." />
          </div>
          <label className="flex items-center gap-2 h-9 text-sm">
            <input type="checkbox" className="size-4" checked={includeInactive} onChange={(e) => { setIncludeInactive(e.target.checked); setPage(0); }} />
            <span className="text-muted-foreground">عرض المعطّلين</span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">القائمة</CardTitle>
          <div className="text-xs text-muted-foreground">
            {list.isLoading ? "جارٍ التحميل…" : `الإجمالي: ${total.toLocaleString("ar-IQ")} مورّد`}
          </div>
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
                    <td className="p-2 font-mono text-xs" dir="ltr">{s.phone ?? "—"}</td>
                    <td className="p-2 text-xs">{s.city ?? "—"}</td>
                    <td className="p-2 text-xs">{s.paymentTerms ?? "—"}</td>
                    <td className={`p-2 text-left tabular-nums ${balanceClass}`} dir="ltr">{fmt(s.currentBalance)}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                        {isActive ? "مفعّل" : "معطّل"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      <div className="flex gap-1 justify-center">
                        <Link href={`/suppliers/${id}/edit`}>
                          <Button variant="outline" size="sm">تعديل</Button>
                        </Link>
                        <Button variant={isActive ? "ghost" : "outline"} size="sm" onClick={() => toggle(id, isActive)} disabled={deactivate.isPending || activate.isPending}>
                          {isActive ? "تعطيل" : "تفعيل"}
                        </Button>
                      </div>
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
