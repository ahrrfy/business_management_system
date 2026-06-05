import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileDown, TrendingUp, Package, Users, ShoppingCart } from "lucide-react";
import { toast } from "sonner";

export default function Reports() {
  const accountsSummary = trpc.accounts.getSummary.useQuery();
  const hrSummary = trpc.hr.getSummary.useQuery();

  const exportCSV = (data: any[], filename: string) => {
    if (!data || data.length === 0) {
      toast.error("لا توجد بيانات للتصدير");
      return;
    }
    const headers = Object.keys(data[0]).join(",");
    const rows = data.map(row => Object.values(row).join(",")).join("\n");
    const csv = `\uFEFF${headers}\n${rows}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${filename}_${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    toast.success("تم تصدير التقرير بنجاح");
  };

  const accData = accountsSummary.data || { totalReceipts: 0, totalPayments: 0, netProfit: 0, totalRevenue: 0, totalCost: 0 };
  const hrData = hrSummary.data || { totalEmployees: 0, totalSalaries: 0, activeToday: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">التقارير</h1>
        <p className="text-muted-foreground mt-1">تقارير شاملة عن أداء النظام</p>
      </div>

      <Tabs defaultValue="financial" dir="rtl">
        <TabsList>
          <TabsTrigger value="financial">المالية</TabsTrigger>
          <TabsTrigger value="sales">المبيعات</TabsTrigger>
          <TabsTrigger value="inventory">المخزون</TabsTrigger>
          <TabsTrigger value="hr">الموارد البشرية</TabsTrigger>
        </TabsList>

        <TabsContent value="financial" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5" />
                  ملخص مالي
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between p-3 border rounded">
                  <span>إجمالي الإيرادات</span>
                  <span className="font-bold text-green-600">{Number(accData.totalRevenue).toLocaleString()} ر.س</span>
                </div>
                <div className="flex justify-between p-3 border rounded">
                  <span>إجمالي التكاليف</span>
                  <span className="font-bold text-red-600">{Number(accData.totalCost).toLocaleString()} ر.س</span>
                </div>
                <div className="flex justify-between p-3 border rounded">
                  <span>إجمالي المقبوضات</span>
                  <span className="font-bold text-blue-600">{Number(accData.totalReceipts).toLocaleString()} ر.س</span>
                </div>
                <div className="flex justify-between p-3 border rounded bg-accent">
                  <span className="font-bold">صافي الربح</span>
                  <span className={`font-bold text-lg ${Number(accData.netProfit) >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {Number(accData.netProfit).toLocaleString()} ر.س
                  </span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileDown className="h-5 w-5" />
                  تصدير التقارير
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => exportCSV([accData], "financial_summary")}
                >
                  <FileDown className="h-4 w-4 ml-2" />
                  تصدير الملخص المالي (CSV)
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => toast.info("تصدير PDF قريباً")}
                >
                  <FileDown className="h-4 w-4 ml-2" />
                  تصدير تقرير الأرباح والخسائر (PDF)
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => toast.info("تصدير Excel قريباً")}
                >
                  <FileDown className="h-4 w-4 ml-2" />
                  تصدير كشف الحساب (Excel)
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="sales" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShoppingCart className="h-5 w-5" />
                تقرير المبيعات
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 border rounded-lg text-center">
                  <p className="text-sm text-muted-foreground">إجمالي المبيعات</p>
                  <p className="text-2xl font-bold text-green-600">{Number(accData.totalRevenue).toLocaleString()} ر.س</p>
                </div>
                <div className="p-4 border rounded-lg text-center">
                  <p className="text-sm text-muted-foreground">إجمالي المقبوضات</p>
                  <p className="text-2xl font-bold text-blue-600">{Number(accData.totalReceipts).toLocaleString()} ر.س</p>
                </div>
                <div className="p-4 border rounded-lg text-center">
                  <p className="text-sm text-muted-foreground">صافي الربح</p>
                  <p className="text-2xl font-bold">{Number(accData.netProfit).toLocaleString()} ر.س</p>
                </div>
              </div>
              <div className="mt-4">
                <Button variant="outline" onClick={() => exportCSV([accData], "sales_report")}>
                  <FileDown className="h-4 w-4 ml-2" />تصدير تقرير المبيعات (CSV)
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="inventory" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                تقرير المخزون
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-center py-8 text-muted-foreground">
                <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>تقرير المخزون سيعرض بيانات المنتجات والكميات المتاحة</p>
                <Button variant="outline" className="mt-4" onClick={() => toast.info("تصدير تقرير المخزون قريباً")}>
                  <FileDown className="h-4 w-4 ml-2" />تصدير تقرير المخزون
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="hr" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                تقرير الموارد البشرية
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 border rounded-lg text-center">
                  <p className="text-sm text-muted-foreground">عدد الموظفين</p>
                  <p className="text-2xl font-bold">{(hrData as any).totalEmployees}</p>
                </div>
                <div className="p-4 border rounded-lg text-center">
                  <p className="text-sm text-muted-foreground">إجمالي الرواتب الشهرية</p>
                  <p className="text-2xl font-bold">{Number((hrData as any).totalSalaries).toLocaleString()} ر.س</p>
                </div>
                <div className="p-4 border rounded-lg text-center">
                  <p className="text-sm text-muted-foreground">الحاضرون اليوم</p>
                  <p className="text-2xl font-bold text-green-600">{(hrData as any).activeToday || 0}</p>
                </div>
              </div>
              <div className="mt-4">
                <Button variant="outline" onClick={() => exportCSV([hrData], "hr_report")}>
                  <FileDown className="h-4 w-4 ml-2" />تصدير تقرير الموارد البشرية (CSV)
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
