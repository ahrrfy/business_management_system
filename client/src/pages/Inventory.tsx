import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const MTYPE: Record<string, string> = {
  IN: "وارد",
  OUT: "صادر",
  ADJUST: "تسوية",
  RETURN: "مرتجع",
  TRANSFER_IN: "تحويل وارد",
  TRANSFER_OUT: "تحويل صادر",
};

export default function Inventory() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const rows = trpc.inventory.movements.useQuery({ branchId, limit: 200 });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">حركات المخزون</h1>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">التاريخ</th>
                <th className="p-2">المتغيّر</th>
                <th className="p-2">النوع</th>
                <th className="p-2 text-center">الكمية (أساس)</th>
                <th className="p-2">المرجع</th>
              </tr>
            </thead>
            <tbody>
              {(rows.data ?? []).map((m) => (
                <tr key={m.id} className="border-t">
                  <td className="p-2">{new Date(m.createdAt).toLocaleString("ar-IQ")}</td>
                  <td className="p-2">#{m.variantId}</td>
                  <td className="p-2">{MTYPE[m.movementType] ?? m.movementType}</td>
                  <td className="p-2 text-center">{m.quantity}</td>
                  <td className="p-2 text-muted-foreground text-xs">{m.referenceType ?? "—"}{m.referenceId ? ` #${m.referenceId}` : ""}</td>
                </tr>
              ))}
              {rows.data && rows.data.length === 0 && (
                <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">لا حركات مخزون بعد.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
