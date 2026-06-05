import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

export default function Suppliers() {
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
    city: "",
    country: "",
    taxId: "",
    paymentTerms: "",
  });

  const suppliersList = trpc.suppliers.list.useQuery({ limit: 50, offset: 0 });
  const searchResults = trpc.suppliers.search.useQuery(
    { query: searchQuery },
    { enabled: searchQuery.length > 0 }
  );
  const createMutation = trpc.suppliers.create.useMutation({
    onSuccess: () => {
      toast.success("تم إضافة المورد بنجاح");
      setDialogOpen(false);
      setForm({ name: "", email: "", phone: "", address: "", city: "", country: "", taxId: "", paymentTerms: "" });
      suppliersList.refetch();
    },
    onError: (err) => toast.error(err.message),
  });
  const deleteMutation = trpc.suppliers.delete.useMutation({
    onSuccess: () => {
      toast.success("تم حذف المورد");
      suppliersList.refetch();
    },
  });

  const displayedSuppliers = searchQuery.length > 0 ? searchResults.data || [] : suppliersList.data || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">الموردين</h1>
          <p className="text-muted-foreground">إدارة الموردين وبيانات التواصل</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 ml-2" />إضافة مورد</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>إضافة مورد جديد</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createMutation.mutate(form);
              }}
              className="space-y-4"
            >
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>اسم المورد *</Label>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                </div>
                <div>
                  <Label>البريد الإلكتروني</Label>
                  <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
                <div>
                  <Label>الهاتف</Label>
                  <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div>
                  <Label>المدينة</Label>
                  <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                </div>
                <div>
                  <Label>الدولة</Label>
                  <Input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
                </div>
                <div>
                  <Label>الرقم الضريبي</Label>
                  <Input value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} />
                </div>
              </div>
              <div>
                <Label>العنوان</Label>
                <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <div>
                <Label>شروط الدفع</Label>
                <Input value={form.paymentTerms} onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })} placeholder="مثال: 30 يوم" />
              </div>
              <Button type="submit" className="w-full" disabled={createMutation.isPending}>
                {createMutation.isPending ? "جاري الحفظ..." : "حفظ المورد"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="بحث عن مورد..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pr-9"
        />
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>الاسم</TableHead>
                <TableHead>الهاتف</TableHead>
                <TableHead>البريد</TableHead>
                <TableHead>المدينة</TableHead>
                <TableHead>شروط الدفع</TableHead>
                <TableHead>إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayedSuppliers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    لا يوجد موردين حالياً
                  </TableCell>
                </TableRow>
              ) : (
                displayedSuppliers.map((supplier: any) => (
                  <TableRow key={supplier.id}>
                    <TableCell className="font-medium">{supplier.name}</TableCell>
                    <TableCell>{supplier.phone || "-"}</TableCell>
                    <TableCell>{supplier.email || "-"}</TableCell>
                    <TableCell>{supplier.city || "-"}</TableCell>
                    <TableCell>{supplier.paymentTerms || "-"}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteMutation.mutate({ id: supplier.id })}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
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
