import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Users, Banknote, Calendar, Trash2 } from "lucide-react";
import { toast } from "sonner";

export default function HR() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    position: "",
    department: "",
    salary: "",
    phone: "",
    email: "",
  });

  const hrSummary = trpc.hr.getSummary.useQuery();
  const employeesList = trpc.hr.listEmployees.useQuery({ limit: 100, offset: 0 });

  const createMutation = trpc.hr.createEmployee.useMutation({
    onSuccess: () => {
      toast.success("تم إضافة الموظف بنجاح");
      setDialogOpen(false);
      setForm({ firstName: "", lastName: "", position: "", department: "", salary: "", phone: "", email: "" });
      employeesList.refetch();
      hrSummary.refetch();
    },
    onError: (err: any) => toast.error(err.message),
  });

  const deleteMutation = trpc.hr.deleteEmployee.useMutation({
    onSuccess: () => {
      toast.success("تم حذف الموظف");
      employeesList.refetch();
      hrSummary.refetch();
    },
    onError: (err: any) => toast.error(err.message),
  });

  const summaryData = hrSummary.data || { totalEmployees: 0, totalSalaries: 0, activeToday: 0 };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">الموارد البشرية</h1>
          <p className="text-muted-foreground mt-1">إدارة الموظفين والرواتب والحضور</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 ml-2" />إضافة موظف</Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>إضافة موظف جديد</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createMutation.mutate({
                  firstName: form.firstName,
                  lastName: form.lastName,
                  email: form.email,
                  salary: parseFloat(form.salary),
                  phone: form.phone || undefined,
                  position: form.position || undefined,
                  department: form.department || undefined,
                });
              }}
              className="space-y-4"
            >
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>الاسم الأول *</Label>
                  <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
                </div>
                <div>
                  <Label>الاسم الأخير *</Label>
                  <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
                </div>
              </div>
              <div>
                <Label>المنصب</Label>
                <Input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
              </div>
              <div>
                <Label>القسم</Label>
                <Input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
              </div>
              <div>
                <Label>الراتب *</Label>
                <Input type="number" step="0.01" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} required min="0" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>الهاتف</Label>
                  <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div>
                  <Label>البريد</Label>
                  <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={createMutation.isPending}>
                {createMutation.isPending ? "جاري الإضافة..." : "إضافة الموظف"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">عدد الموظفين</CardTitle>
            <Users className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{summaryData.totalEmployees}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">إجمالي الرواتب</CardTitle>
            <Banknote className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{Number(summaryData.totalSalaries).toLocaleString()} ر.س</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">الحاضرون اليوم</CardTitle>
            <Calendar className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold text-green-600">{(summaryData as any).presentToday || (summaryData as any).activeToday || 0}</div></CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="employees" dir="rtl">
        <TabsList>
          <TabsTrigger value="employees">الموظفين</TabsTrigger>
          <TabsTrigger value="attendance">الحضور</TabsTrigger>
        </TabsList>

        <TabsContent value="employees">
          <Card>
            <CardHeader><CardTitle>قائمة الموظفين</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>الاسم</TableHead>
                    <TableHead>المنصب</TableHead>
                    <TableHead>القسم</TableHead>
                    <TableHead>الراتب</TableHead>
                    <TableHead>الحالة</TableHead>
                    <TableHead>إجراءات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(employeesList.data || []).length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">لا يوجد موظفين بعد</TableCell></TableRow>
                  ) : (
                    (employeesList.data || []).map((emp: any) => (
                      <TableRow key={emp.id}>
                        <TableCell className="font-medium">{emp.firstName} {emp.lastName}</TableCell>
                        <TableCell>{emp.position}</TableCell>
                        <TableCell>{emp.department || "-"}</TableCell>
                        <TableCell>{parseFloat(emp.salary).toLocaleString()} ر.س</TableCell>
                        <TableCell>
                          <Badge variant={emp.status === "ACTIVE" ? "default" : "secondary"}>
                            {emp.status === "ACTIVE" ? "نشط" : "غير نشط"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              if (confirm("هل أنت متأكد من حذف هذا الموظف؟")) {
                                deleteMutation.mutate({ id: emp.id });
                              }
                            }}
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
        </TabsContent>

        <TabsContent value="attendance">
          <Card>
            <CardHeader><CardTitle>سجل الحضور والانصراف</CardTitle></CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-center py-8">
                انتقل إلى <a href="/attendance" className="text-primary underline">صفحة الحضور</a> لتسجيل البصمة ومتابعة الحضور
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
