import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, CheckCircle } from "lucide-react";
import { toast } from "sonner";

export default function Purchases() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({
    supplierId: "",
    productId: "",
    quantity: "",
    unitPrice: "",
  });

  const purchasesList = trpc.purchases.list.useQuery({ limit: 50, offset: 0 });
  const suppliersList = trpc.suppliers.list.useQuery({ limit: 100, offset: 0 });
  const productsList = trpc.products.list.useQuery({ limit: 100, offset: 0 });

  const createMutation = trpc.purchases.create.useMutation({
    onSuccess: (data) => {
      toast.success(`تم إنشاء أمر الشراء ${data.poNumber}`);
      setDialogOpen(false);
      setForm({ supplierId: "", productId: "", quantity: "", unitPrice: "" });
      purchasesList.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const receiveMutation = trpc.purchases.receive.useMutation({
    onSuccess: () => {
      toast.success("تم استلام الطلب وتحديث المخزون");
      purchasesList.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const getStatusBadge = (status: string) => {
    const map: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
      DRAFT: { label: "مسودة", variant: "secondary" },
      SENT: { label: "مرسل", variant: "outline" },
      CONFIRMED: { label: "مؤكد", variant: "default" },
      RECEIVED: { label: "مستلم", variant: "default" },
      CANCELLED: { label: "ملغي", variant: "destructive" },
    };
    const s = map[status] || { label: status, variant: "secondary" as const };
    return <Badge variant={s.variant}>{s.label}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">المشتريات</h1>
          <p className="text-muted-foreground">إدارة أوامر الشراء من الموردين</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 ml-2" />أمر شراء جديد</Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>إنشاء أمر شراء</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createMutation.mutate({
                  supplierId: parseInt(form.supplierId),
                  items: [{
                    productId: parseInt(form.productId),
                    quantity: parseInt(form.quantity),
                    unitPrice: parseFloat(form.unitPrice),
                  }],
                });
              }}
              className="space-y-4"
            >
              <div>
                <Label>المورد *</Label>
                <select
                  className="w-full border rounded-md p-2 mt-1"
                  value={form.supplierId}
                  onChange={(e) => setForm({ ...form, supplierId: e.target.value })}
                  required
                >
                  <option value="">اختر مورد</option>
                  {(suppliersList.data || []).map((s: any) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>المنتج *</Label>
                <select
                  className="w-full border rounded-md p-2 mt-1"
                  value={form.productId}
                  onChange={(e) => setForm({ ...form, productId: e.target.value })}
                  required
                >
                  <option value="">اختر منتج</option>
                  {(productsList.data || []).map((p: any) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>الكمية *</Label>
                  <Input type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} required min="1" />
                </div>
                <div>
                  <Label>سعر الوحدة *</Label>
                  <Input type="number" step="0.01" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} required min="0.01" />
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={createMutation.isPending}>
                {createMutation.isPending ? "جاري الإنشاء..." : "إنشاء أمر الشراء"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>رقم الأمر</TableHead>
                <TableHead>المورد</TableHead>
                <TableHead>المبلغ</TableHead>
                <TableHead>الحالة</TableHead>
                <TableHead>التاريخ</TableHead>
                <TableHead>إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(purchasesList.data || []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    لا توجد أوامر شراء
                  </TableCell>
                </TableRow>
              ) : (
                (purchasesList.data || []).map((po: any) => (
                  <TableRow key={po.id}>
                    <TableCell className="font-mono text-sm">{po.poNumber}</TableCell>
                    <TableCell>{po.supplierId}</TableCell>
                    <TableCell>{parseFloat(po.total).toLocaleString()} ر.س</TableCell>
                    <TableCell>{getStatusBadge(po.status)}</TableCell>
                    <TableCell>{new Date(po.orderDate).toLocaleDateString("ar")}</TableCell>
                    <TableCell>
                      {po.status !== "RECEIVED" && po.status !== "CANCELLED" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => receiveMutation.mutate({ orderId: po.id })}
                        >
                          <CheckCircle className="h-4 w-4 text-green-600 ml-1" />
                          استلام
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
