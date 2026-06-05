import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Edit, Trash2, Package } from "lucide-react";
import { toast } from "sonner";

export default function Products() {
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    sku: "",
    description: "",
    costPrice: 0,
    salePrice: 0,
    wholesalePrice: 0,
    quantityOnHand: 0,
    minStock: 5,
    maxStock: 100,
    reorderPoint: 10,
  });

  const products = trpc.products.list.useQuery({ limit: 50, offset: 0 });
  const searchResults = trpc.products.search.useQuery(
    { query: searchQuery, limit: 50 },
    { enabled: searchQuery.length > 0 }
  );
  const createProduct = trpc.products.create.useMutation({
    onSuccess: () => {
      toast.success("تم إضافة المنتج بنجاح");
      setShowAddDialog(false);
      products.refetch();
      resetForm();
    },
    onError: (err) => toast.error(err.message),
  });
  const deleteProduct = trpc.products.delete.useMutation({
    onSuccess: () => {
      toast.success("تم حذف المنتج");
      products.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const displayedProducts = searchQuery.length > 0 ? searchResults.data : products.data;

  function resetForm() {
    setFormData({
      name: "",
      sku: "",
      description: "",
      costPrice: 0,
      salePrice: 0,
      wholesalePrice: 0,
      quantityOnHand: 0,
      minStock: 5,
      maxStock: 100,
      reorderPoint: 10,
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formData.name || !formData.sku) {
      toast.error("يرجى ملء الحقول المطلوبة");
      return;
    }
    createProduct.mutate(formData);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">إدارة المنتجات</h1>
          <p className="text-muted-foreground mt-1">
            إضافة وتعديل وحذف المنتجات
          </p>
        </div>
        <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 ml-2" />
              إضافة منتج
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>إضافة منتج جديد</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>اسم المنتج *</Label>
                  <Input
                    value={formData.name}
                    onChange={(e) =>
                      setFormData({ ...formData, name: e.target.value })
                    }
                    placeholder="اسم المنتج"
                  />
                </div>
                <div>
                  <Label>رقم المنتج (SKU) *</Label>
                  <Input
                    value={formData.sku}
                    onChange={(e) =>
                      setFormData({ ...formData, sku: e.target.value })
                    }
                    placeholder="SKU-001"
                  />
                </div>
                <div>
                  <Label>سعر التكلفة</Label>
                  <Input
                    type="number"
                    value={formData.costPrice}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        costPrice: parseFloat(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <div>
                  <Label>سعر البيع</Label>
                  <Input
                    type="number"
                    value={formData.salePrice}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        salePrice: parseFloat(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <div>
                  <Label>الكمية</Label>
                  <Input
                    type="number"
                    value={formData.quantityOnHand}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        quantityOnHand: parseInt(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <div>
                  <Label>الحد الأدنى</Label>
                  <Input
                    type="number"
                    value={formData.minStock}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        minStock: parseInt(e.target.value) || 0,
                      })
                    }
                  />
                </div>
              </div>
              <div>
                <Label>الوصف</Label>
                <Input
                  value={formData.description}
                  onChange={(e) =>
                    setFormData({ ...formData, description: e.target.value })
                  }
                  placeholder="وصف المنتج (اختياري)"
                />
              </div>
              <Button type="submit" className="w-full" disabled={createProduct.isPending}>
                {createProduct.isPending ? "جاري الإضافة..." : "إضافة المنتج"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="pt-4">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="البحث عن منتج..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pr-10"
            />
          </div>
        </CardContent>
      </Card>

      {/* Products Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            قائمة المنتجات ({(displayedProducts as any[])?.length || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">المنتج</TableHead>
                <TableHead className="text-right">SKU</TableHead>
                <TableHead className="text-right">سعر التكلفة</TableHead>
                <TableHead className="text-right">سعر البيع</TableHead>
                <TableHead className="text-right">الكمية</TableHead>
                <TableHead className="text-right">الحالة</TableHead>
                <TableHead className="text-right">إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(displayedProducts as any[])?.map((product: any) => (
                <TableRow key={product.id}>
                  <TableCell className="font-medium">{product.name}</TableCell>
                  <TableCell>{product.sku}</TableCell>
                  <TableCell>{product.costPrice} ر.س</TableCell>
                  <TableCell>{product.salePrice} ر.س</TableCell>
                  <TableCell>{product.quantityOnHand}</TableCell>
                  <TableCell>
                    {parseInt(product.quantityOnHand) <= parseInt(product.minStock) ? (
                      <Badge variant="destructive">منخفض</Badge>
                    ) : (
                      <Badge variant="secondary">متوفر</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toast.info("ميزة التعديل قريباً")}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteProduct.mutate({ id: product.id })}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )) || (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    لا توجد منتجات بعد. أضف منتجاً جديداً للبدء.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
