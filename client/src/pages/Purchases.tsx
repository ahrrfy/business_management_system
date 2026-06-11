import { CopyInline } from "@/components/CopyButton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ListToolbar, RowActions } from "@/components/list";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";

const fmt = (s: string | number | null | undefined) =>
  s == null || s === "" ? "—" : Number(s).toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });

const PO_STATUS: Record<string, string> = {
  DRAFT: "مسودّة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};

export default function Purchases() {
  const [q, setQ] = useState("");
  const query = trpc.purchases.list.useQuery({ limit: 200 });
  const all = query.data ?? [];

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return all;
    return all.filter((p) => {
      const hay = `${p.poNumber ?? ""} ${p.supplierName ?? ""} ${PO_STATUS[p.status] ?? p.status ?? ""}`.toLowerCase();
      return hay.includes(term);
    });
  }, [all, q]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">المشتريات</h1>
      <p className="text-sm text-muted-foreground">أوامر الشراء وحالتها. أنشئ أمراً ثم استلمه ليُضاف للمخزون وتُسجَّل الذمم.</p>
      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={rows.length}
            loading={query.isLoading}
            search={{
              value: q,
              onChange: setQ,
              placeholder: "بحث (رقم الأمر/المورد/الحالة)",
            }}
            exportSpec={{
              filename: "المشتريات",
              rows,
              columns: [
                { key: "poNumber", header: "رقم الأمر" },
                { key: "supplierName", header: "المورد" },
                { key: "orderDate", header: "التاريخ", map: (r) => new Date(r.orderDate).toLocaleString("ar-IQ-u-nu-latn") },
                { key: "total", header: "الإجمالي", map: (r) => Number(r.total ?? 0) },
                { key: "paidAmount", header: "المدفوع", map: (r) => Number(r.paidAmount ?? 0) },
                { key: "status", header: "الحالة", map: (r) => PO_STATUS[r.status] ?? r.status },
              ],
            }}
            add={{ href: "/purchases/new", label: "أمر شراء جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">رقم الأمر</th>
                <th className="p-2">المورد</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2 text-left">الإجمالي</th>
                <th className="p-2 text-left">المدفوع</th>
                <th className="p-2">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const terminal = p.status === "RECEIVED" || p.status === "CANCELLED";
                return (
                  <tr key={p.id} className="border-t">
                    <td className="p-2"><CopyInline value={p.poNumber} /></td>
                    <td className="p-2">{p.supplierName ?? "—"}</td>
                    <td className="p-2">{new Date(p.orderDate).toLocaleString("ar-IQ-u-nu-latn")}</td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(p.total)}</td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(p.paidAmount)}</td>
                    <td className="p-2">{PO_STATUS[p.status] ?? p.status}</td>
                    <td className="p-2 text-center">
                      <RowActions
                        mode="inline"
                        actions={[
                          {
                            key: "receive",
                            label: terminal ? "عرض" : "استلام",
                            href: `/purchases/${p.id}/receive`,
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {!query.isLoading && rows.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا أوامر شراء بعد.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
