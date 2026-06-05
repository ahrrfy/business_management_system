import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Plus, Search, Edit, Trash2, Users } from "lucide-react";
import { toast } from "sonner";

export default function Customers() {
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [formData, setFormData] = useState({
    name: "", email: "", phone: "", address: "", city: "", country: "",
    taxId: "", creditLimit: 0, customerType: "INDIVIDUAL" as "INDIVIDUAL" | "BUSINESS",
  });

  const customersList = trpc.customers.list.useQuery({ limit: 50, offset: 0 });
  const searchResults = trpc.customers.search.useQuery(
    { query: searchQuery, limit: 50 },
    { enabled: searchQuery.length > 0 }
  );
  const createCustomer = trpc.customers.create.useMutation({
    onSuccess: () => {
      toast.success("تم إضافة العميل بنجاح");
      setShowAddDialog(false);
      customersList.refetch();
      setFormData({ name: "", email: "", phone: "", address: "", city: "", country: "", taxId: "", creditLimit: 0, customerType: "INDIVIDUAL" });
    },
    onError: (err) => toast.error(err.message),
  });
  const deleteCustomer = trpc.customers.delete.useMutation({
    onSuccess: () => { toast.success("تم حذف العميل"); customersList.refetch(); },
    onError: (err) => toast.error(err.message),
  });

  const displayed = searchQuery.length > 0 ? searchResults.data : customersList.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">إدارة العملاء</h1>
          <p className="text-muted-foreground mt-1">إضافة وتعديل بيانات العملاء</p>
        </div>
        <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 ml-2" />إضافة عميل</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>إضافة عميل جديد</DialogTitle></DialogHeader>
            <form onSubmit={(e) => { e.preventDefault(); createCustomer.mutate(formData); }} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div><Label>الاسم *</Label><Input value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="اسم العميل" /></div>
                <div><Label>الهاتف</Label><Input value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} placeholder="رقم الهاتف" /></div>
                <div><Label>البريد</Label><Input value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} placeholder="email@example.com" /></div>
                <div><Label>المدينة</Label><Input value={formData.city} onChange={(e) => setFormData({ ...formData, city: e.target.value })} placeholder="المدينة" /></div>
                <div className="col-span-2"><Label>العنوان</Label><Input value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} placeholder="العنوان الكامل" /></div>
                <div><Label>الرقم الضريبي</Label><Input value={formData.taxId} onChange={(e) => setFormData({ ...formData, taxId: e.target.value })} /></div>
                <div><Label>حد الائتمان</Label><Input type="number" value={formData.creditLimit} onChange={(e) => setFormData({ ...formData, creditLimit: parseFloat(e.target.value) || 0 })} /></div>
              </div>
              <Button type="submit" className="w-full" disabled={createCustomer.isPending}>
                {createCustomer.isPending ? "جاري الإضافة..." : "إضافة العميل"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="pt-4">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="البحث عن عميل..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pr-10" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" />قائمة العملاء ({(displayed as any[])?.length || 0})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">الاسم</TableHead>
                <TableHead className="text-right">الهاتف</TableHead>
                <TableHead className="text-right">البريد</TableHead>
                <TableHead className="text-right">المدينة</TableHead>
                <TableHead className="text-right">الرصيد</TableHead>
                <TableHead className="text-right">إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(displayed as any[])?.map((c: any) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.phone || "-"}</TableCell>
                  <TableCell>{c.email || "-"}</TableCell>
                  <TableCell>{c.city || "-"}</TableCell>
                  <TableCell>{c.currentBalance || "0"} ر.س</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => toast.info("ميزة التعديل قريباً")}><Edit className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="sm" onClick={() => deleteCustomer.mutate({ id: c.id })}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              )) || (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">لا يوجد عملاء بعد</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
