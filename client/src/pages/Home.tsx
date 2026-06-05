import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import {
  ShoppingCart,
  Package,
  Users,
  DollarSign,
  TrendingUp,
  TrendingDown,
  Clock,
  AlertTriangle,
  Truck,
  FileText,
  UserCheck,
} from "lucide-react";

export default function Home() {
  const { user } = useAuth();
  const stats = trpc.dashboard.stats.useQuery();

  const data = stats.data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          مرحباً {user?.name || ""}
        </h1>
        <p className="text-muted-foreground mt-1">
          لوحة التحكم - ملخص العمليات اليومية
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              مبيعات اليوم
            </CardTitle>
            <ShoppingCart className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {(data?.dailySales || 0).toLocaleString()} ر.س
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {data?.dailyInvoiceCount || 0} فاتورة
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              مبيعات الشهر
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {(data?.monthlySales || 0).toLocaleString()} ر.س
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              المقبوضات: {(data?.monthlyReceipts || 0).toLocaleString()} ر.س
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              صافي الربح
            </CardTitle>
            {(data?.monthlyProfit || 0) >= 0 ? (
              <TrendingUp className="h-4 w-4 text-emerald-600" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-600" />
            )}
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${(data?.monthlyProfit || 0) >= 0 ? "text-emerald-600" : "text-red-600"}`}>
              {(data?.monthlyProfit || 0).toLocaleString()} ر.س
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              المدفوعات: {(data?.monthlyPayments || 0).toLocaleString()} ر.س
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              تنبيهات المخزون
            </CardTitle>
            <AlertTriangle className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {data?.lowStockProducts?.length || 0}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              منتجات تحت الحد الأدنى
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Counts Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card className="bg-blue-50 border-blue-200">
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <Package className="h-8 w-8 text-blue-600" />
            <div>
              <p className="text-2xl font-bold text-blue-900">{data?.productCount || 0}</p>
              <p className="text-xs text-blue-700">منتج</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-purple-50 border-purple-200">
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <Users className="h-8 w-8 text-purple-600" />
            <div>
              <p className="text-2xl font-bold text-purple-900">{data?.customerCount || 0}</p>
              <p className="text-xs text-purple-700">عميل</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-orange-50 border-orange-200">
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <Truck className="h-8 w-8 text-orange-600" />
            <div>
              <p className="text-2xl font-bold text-orange-900">{data?.supplierCount || 0}</p>
              <p className="text-xs text-orange-700">مورد</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-teal-50 border-teal-200">
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <UserCheck className="h-8 w-8 text-teal-600" />
            <div>
              <p className="text-2xl font-bold text-teal-900">{data?.employeeCount || 0}</p>
              <p className="text-xs text-teal-700">موظف</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions & Low Stock */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">الوصول السريع</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <a
                href="/pos"
                className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent transition-colors"
              >
                <ShoppingCart className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium">نقطة البيع</span>
              </a>
              <a
                href="/products"
                className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent transition-colors"
              >
                <Package className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium">المنتجات</span>
              </a>
              <a
                href="/customers"
                className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent transition-colors"
              >
                <Users className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium">العملاء</span>
              </a>
              <a
                href="/invoices"
                className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent transition-colors"
              >
                <FileText className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium">الفواتير</span>
              </a>
              <a
                href="/accounts"
                className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent transition-colors"
              >
                <DollarSign className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium">الحسابات</span>
              </a>
              <a
                href="/attendance"
                className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent transition-colors"
              >
                <Clock className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium">الحضور</span>
              </a>
            </div>
          </CardContent>
        </Card>

        {/* Low Stock Alert */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-600" />
              تنبيهات المخزون
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data?.lowStockProducts || data.lowStockProducts.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                لا توجد تنبيهات حالياً - المخزون في حالة جيدة
              </p>
            ) : (
              <div className="space-y-2 max-h-[200px] overflow-y-auto">
                {data.lowStockProducts.slice(0, 5).map((item: any) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between p-2 rounded border bg-red-50"
                  >
                    <span className="text-sm font-medium">{item.name}</span>
                    <span className="text-xs text-red-600 font-bold">
                      المتبقي: {item.quantityOnHand}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Invoices */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              آخر الفواتير
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data?.recentInvoices || data.recentInvoices.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                لا توجد فواتير بعد
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-right p-2 font-medium text-muted-foreground">رقم الفاتورة</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">المصدر</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">المبلغ</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">الحالة</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">التاريخ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentInvoices.map((inv: any) => (
                      <tr key={inv.id} className="border-b hover:bg-muted/50">
                        <td className="p-2 font-mono text-xs">{inv.invoiceNumber}</td>
                        <td className="p-2">
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            inv.sourceType === "POS" ? "bg-blue-100 text-blue-700" :
                            inv.sourceType === "ONLINE" ? "bg-green-100 text-green-700" :
                            "bg-gray-100 text-gray-700"
                          }`}>
                            {inv.sourceType === "POS" ? "نقطة بيع" : inv.sourceType === "ONLINE" ? "متجر" : "طلب"}
                          </span>
                        </td>
                        <td className="p-2 font-bold">{parseFloat(inv.total).toLocaleString()} ر.س</td>
                        <td className="p-2">
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            inv.status === "PAID" ? "bg-green-100 text-green-700" :
                            inv.status === "PENDING" ? "bg-yellow-100 text-yellow-700" :
                            inv.status === "CANCELLED" ? "bg-red-100 text-red-700" :
                            "bg-gray-100 text-gray-700"
                          }`}>
                            {inv.status === "PAID" ? "مدفوعة" :
                             inv.status === "PENDING" ? "معلقة" :
                             inv.status === "CANCELLED" ? "ملغاة" :
                             inv.status === "PARTIALLY_PAID" ? "جزئية" : inv.status}
                          </span>
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">
                          {new Date(inv.invoiceDate).toLocaleDateString("ar-SA")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
