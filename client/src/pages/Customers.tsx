import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { exportRows } from "@/lib/export";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";

const TYPE_OPTIONS = ["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"] as const;
const TIER_LABEL: Record<string, string> = {
  RETAIL: "مفرد",
  WHOLESALE: "جملة",
  GOVERNMENT: "حكومي",
};

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function fmt(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === "") return "—";
  return Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });
}

export default function Customers() {
  const utils = trpc.useUtils();
  const [q, setQ] = useState("");
  const [customerType, setCustomerType] = useState<"" | (typeof TYPE_OPTIONS)[number]>("");
  const [priceTier, setPriceTier] = useState<"" | "RETAIL" | "WHOLESALE" | "GOVERNMENT">("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
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

  function toggle(id: number, isActive: boolean) {
    if (isActive) {
      if (!confirm("تأكيد تعطيل العميل؟ لن يظهر في قوائم البيع.")) return;
      deactivate.mutate({ customerId: id });
    } else {
      activate.mutate({ customerId: id });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">العملاء</h1>
        <Link href="/customers/new"><Button>+ عميل جديد</Button></Link>
      </div>
      <p className="text-sm text-muted-foreground">
        إدارة العملاء (أفراد/تجّار/شركات/حكومي): إضافة، تعديل، تعطيل، بحث، ومتابعة الرصيد المفتوح.
      </p>

      <Card>
        <CardHeader><CardTitle className="text-base">الفلاتر والبحث</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <div className="space-y-1">
            <Label>بحث (اسم/هاتف/واتساب)</Label>
            <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="مثال: أحمد أو 0770..." />
          </div>
          <div className="space-y-1">
            <Label>النوع</Label>
            <select className={selectCls} value={customerType} onChange={(e) => { setCustomerType(e.target.value as any); setPage(0); }}>
              <option value="">الكل</option>
              {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label>فئة السعر</Label>
            <select className={selectCls} value={priceTier} onChange={(e) => { setPriceTier(e.target.value as any); setPage(0); }}>
              <option value="">الكل</option>
              <option value="RETAIL">مفرد</option>
              <option value="WHOLESALE">جملة</option>
              <option value="GOVERNMENT">حكومي</option>
            </select>
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
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {list.isLoading ? "جارٍ التحميل…" : `الإجمالي: ${total.toLocaleString("ar-IQ")} عميل`}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length === 0}
              onClick={() =>
                exportRows(rows, {
                  filename: "العملاء",
                  columns: [
                    { key: "name", header: "الاسم" },
                    { key: "customerType", header: "النوع" },
                    { key: "phone", header: "الهاتف" },
                    { key: "city", header: "المدينة", map: (r) => [r.city, r.district].filter(Boolean).join(" / ") || "" },
                    { key: "defaultPriceTier", header: "فئة السعر" },
                    { key: "creditLimit", header: "سقف الائتمان", map: (r) => Number(r.creditLimit ?? 0) },
                    { key: "currentBalance", header: "الرصيد الحالي", map: (r) => Number(r.currentBalance ?? 0) },
                    { key: "isActive", header: "نشط", map: (r) => (r.isActive ? "نعم" : "لا") },
                  ],
                })
              }
            >
              تصدير Excel
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">الاسم</th>
                <th className="p-2">النوع</th>
                <th className="p-2">الهاتف</th>
                <th className="p-2">المدينة/المنطقة</th>
                <th className="p-2">فئة السعر</th>
                <th className="p-2 text-left">سقف الائتمان</th>
                <th className="p-2 text-left">الرصيد الحالي</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const id = Number(c.id);
                const isActive = !!c.isActive;
                const balance = Number(c.currentBalance ?? "0");
                const balanceClass = balance > 0 ? "text-amber-700" : balance < 0 ? "text-emerald-700" : "text-muted-foreground";
                return (
                  <tr key={id} className={`border-t ${isActive ? "" : "opacity-60"}`}>
                    <td className="p-2 font-medium">{c.name}</td>
                    <td className="p-2 text-xs">{c.customerType ?? "—"}</td>
                    <td className="p-2 font-mono text-xs" dir="ltr">{c.phone ?? "—"}</td>
                    <td className="p-2 text-xs">{[c.city, c.district].filter(Boolean).join(" / ") || "—"}</td>
                    <td className="p-2 text-xs">{TIER_LABEL[c.defaultPriceTier] ?? c.defaultPriceTier}</td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(c.creditLimit)}</td>
                    <td className={`p-2 text-left tabular-nums ${balanceClass}`} dir="ltr">{fmt(c.currentBalance)}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                        {isActive ? "مفعّل" : "معطّل"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      <div className="flex gap-1 justify-center">
                        <Link href={`/customers/${id}/edit`}>
                          <Button variant="outline" size="sm">تعديل</Button>
                        </Link>
                        <Button
                          variant={isActive ? "ghost" : "outline"}
                          size="sm"
                          onClick={() => toggle(id, isActive)}
                          disabled={deactivate.isPending || activate.isPending}
                        >
                          {isActive ? "تعطيل" : "تفعيل"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!list.isLoading && rows.length === 0 && (
                <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">لا عملاء مطابقين. أضف عميلاً جديداً أو غيّر الفلاتر.</td></tr>
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
    </div>
  );
}
