import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Warehouse, AlertTriangle, ArrowDownUp, Plus, Package } from "lucide-react";
import { toast } from "sonner";

export default function Inventory() {
  const [showAddMovement, setShowAddMovement] = useState(false);
  const [movementForm, setMovementForm] = useState({
    productId: 0,
    movementType: "IN" as "IN" | "OUT" | "ADJUST" | "RETURN",
    quantity: 0,
    notes: "",
  });

  const products = trpc.products.list.useQuery({ limit: 100, offset: 0 });
  const movements = trpc.inventory.listMovements.useQuery({ limit: 50, offset: 0 });
  const inventorySummary = trpc.inventory.getSummary.useQuery();
  const lowStock = trpc.products.getLowStock.useQuery();

  const createMovement = trpc.inventory.createMovement.useMutation({
    onSuccess: () => {
      toast.success("تم إضافة حركة المخزون بنجاح");
      setShowAddMovement(false);
      setMovementForm({ productId: 0, movementType: "IN", quantity: 0, notes: "" });
      products.refetch();
      movements.refetch();
      inventorySummary.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const allProducts = (products.data as any[]) || [];
  const allMovements = (movements.data as any[]) || [];
  const lowStockItems = (lowStock.data as any[]) || [];
  const summary = inventorySummary.data || { totalProducts: 0, lowStockCount: 0, totalValue: 0 };

  const handleAddMovement = () => {
    if (!movementForm.productId || !movementForm.quantity) {
      toast.error("يرجى ملء جميع الحقول المطلوبة");
      return;
    }
    createMovement.mutate(movementForm);
  };

  const getMovementTypeLabel = (type: string) => {
    switch (type) {
      case "IN": return "إدخال";
      case "OUT": return "إخراج";
      case "ADJUST": return "تعديل";
      case "RETURN": return "مرتجع";
      default: return type;
    }
  };

  const getMovementTypeBadge = (type: string) => {
    switch (type) {
      case "IN": return <Badge className="bg-green-100 text-green-800">إدخال</Badge>;
      case "OUT": return <Badge variant="destructive">إخراج</Badge>;
      case "ADJUST": return <Badge variant="secondary">تعديل</Badge>;
      case "RETURN": return <Badge className="bg-blue-100 text-blue-800">مرتجع</Badge>;
      default: return <Badge>{type}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">إدارة المخزون</h1>
          <p className="text-muted-foreground mt-1">مراقبة المخزون وحركة المنتجات</p>
        </div>
        <Dialog open={showAddMovement} onOpenChange={setShowAddMovement}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 ml-2" />حركة مخزون جديدة</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>إضافة حركة مخزون</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-4">
              <div>
                <label className="text-sm font-medium mb-1 block">المنتج</label>
                <Select
                  value={movementForm.productId ? movementForm.productId.toString() : ""}
                  onValueChange={(v) => setMovementForm({ ...movementForm, productId: parseInt(v) })}
                >
                  <SelectTrigger><SelectValue placeholder="اختر المنتج" /></SelectTrigger>
                  <SelectContent>
                    {allProducts.map((p: any) => (
                      <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">نوع الحركة</label>
                <Select
                  value={movementForm.movementType}
                  onValueChange={(v) => setMovementForm({ ...movementForm, movementType: v as any })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IN">إدخال (شراء / إضافة)</SelectItem>
                    <SelectItem value="OUT">إخراج (بيع / سحب)</SelectItem>
                    <SelectItem value="ADJUST">تعديل (جرد)</SelectItem>
                    <SelectItem value="RETURN">مرتجع</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">الكمية</label>
                <Input
                  type="number"
                  min="1"
                  value={movementForm.quantity || ""}
                  onChange={(e) => setMovementForm({ ...movementForm, quantity: parseInt(e.target.value) || 0 })}
                  placeholder="أدخل الكمية"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">ملاحظات</label>
                <Input
                  value={movementForm.notes}
                  onChange={(e) => setMovementForm({ ...movementForm, notes: e.target.value })}
                  placeholder="ملاحظات (اختياري)"
                />
              </div>
              <Button onClick={handleAddMovement} className="w-full" disabled={createMovement.isPending}>
                {createMovement.isPending ? "جاري الحفظ..." : "حفظ الحركة"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">إجمالي المنتجات</CardTitle>
            <Package className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{summary.totalProducts}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">منتجات منخفضة المخزون</CardTitle>
            <AlertTriangle className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold text-red-600">{summary.lowStockCount}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">قيمة المخزون</CardTitle>
            <Warehouse className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {summary.totalValue.toLocaleString()} ر.س
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="stock" className="w-full">
        <TabsList>
          <TabsTrigger value="stock"><Warehouse className="h-4 w-4 ml-1" />حالة المخزون</TabsTrigger>
          <TabsTrigger value="movements"><ArrowDownUp className="h-4 w-4 ml-1" />حركات المخزون</TabsTrigger>
          <TabsTrigger value="lowstock"><AlertTriangle className="h-4 w-4 ml-1" />تنبيهات</TabsTrigger>
        </TabsList>

        <TabsContent value="stock">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">المنتج</TableHead>
                    <TableHead className="text-right">SKU</TableHead>
                    <TableHead className="text-right">الكمية المتاحة</TableHead>
                    <TableHead className="text-right">الحد الأدنى</TableHead>
                    <TableHead className="text-right">قيمة المخزون</TableHead>
                    <TableHead className="text-right">الحالة</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allProducts.length > 0 ? allProducts.map((p: any) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell>{p.sku}</TableCell>
                      <TableCell>{p.quantityOnHand}</TableCell>
                      <TableCell>{p.minStock}</TableCell>
                      <TableCell>{(parseFloat(p.costPrice || 0) * parseInt(p.quantityOnHand || 0)).toLocaleString()} ر.س</TableCell>
                      <TableCell>
                        {parseInt(p.quantityOnHand) <= parseInt(p.minStock) ? (
                          <Badge variant="destructive">منخفض</Badge>
                        ) : parseInt(p.quantityOnHand) <= parseInt(p.minStock) * 2 ? (
                          <Badge variant="secondary">تحذير</Badge>
                        ) : (
                          <Badge className="bg-green-100 text-green-800">متوفر</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  )) : (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">لا توجد منتجات في المخزون</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="movements">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">التاريخ</TableHead>
                    <TableHead className="text-right">رقم المنتج</TableHead>
                    <TableHead className="text-right">نوع الحركة</TableHead>
                    <TableHead className="text-right">الكمية</TableHead>
                    <TableHead className="text-right">ملاحظات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allMovements.length > 0 ? allMovements.map((m: any) => (
                    <TableRow key={m.id}>
                      <TableCell>{new Date(m.createdAt).toLocaleDateString("ar-SA")}</TableCell>
                      <TableCell>{m.productId}</TableCell>
                      <TableCell>{getMovementTypeBadge(m.movementType)}</TableCell>
                      <TableCell className="font-bold">{m.quantity}</TableCell>
                      <TableCell>{m.notes || "-"}</TableCell>
                    </TableRow>
                  )) : (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">لا توجد حركات مخزون</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="lowstock">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-red-600"><AlertTriangle className="h-5 w-5" />منتجات تحتاج إعادة طلب</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">المنتج</TableHead>
                    <TableHead className="text-right">SKU</TableHead>
                    <TableHead className="text-right">الكمية الحالية</TableHead>
                    <TableHead className="text-right">الحد الأدنى</TableHead>
                    <TableHead className="text-right">النقص</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lowStockItems.length > 0 ? lowStockItems.map((p: any) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell>{p.sku}</TableCell>
                      <TableCell className="text-red-600 font-bold">{p.quantityOnHand}</TableCell>
                      <TableCell>{p.minStock}</TableCell>
                      <TableCell className="text-red-600 font-bold">
                        {parseInt(p.minStock) - parseInt(p.quantityOnHand)} وحدة
                      </TableCell>
                    </TableRow>
                  )) : (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">جميع المنتجات بمستوى مخزون جيد</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
