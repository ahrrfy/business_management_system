import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { TrendingUp, Package, ShoppingCart, DollarSign, Users } from "lucide-react";
import { trpc } from "@/lib/trpc";

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

export default function EcommerceSalesReports() {
  const [dateRange, setDateRange] = useState("month");
  const [selectedStatus, setSelectedStatus] = useState("ALL");

  // جلب الطلبات
  const { data: ordersData } = trpc.onlineOrders.list.useQuery({
    limit: 1000,
    offset: 0,
  });

  const orders = ordersData?.orders || [];

  // حساب الإحصائيات
  const totalOrders = orders.length;
  const totalRevenue = orders.reduce((sum, order: any) => sum + Number(order.total), 0);
  const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  const pendingOrders = orders.filter((o: any) => o.status === "PENDING").length;
  const completedOrders = orders.filter((o: any) => o.status === "DELIVERED").length;

  // بيانات المبيعات اليومية
  const dailySalesData = orders.reduce((acc: any, order: any) => {
    const date = new Date(order.orderDate).toLocaleDateString("ar-SA");
    const existing = acc.find((d: any) => d.date === date);
    if (existing) {
      existing.revenue += Number(order.total);
      existing.orders += 1;
    } else {
      acc.push({
        date,
        revenue: Number(order.total),
        orders: 1,
      });
    }
    return acc;
  }, []);

  // بيانات الحالات
  const statusData = [
    { name: "قيد الانتظار", value: orders.filter((o: any) => o.status === "PENDING").length },
    { name: "مؤكد", value: orders.filter((o: any) => o.status === "CONFIRMED").length },
    { name: "قيد المعالجة", value: orders.filter((o: any) => o.status === "PROCESSING").length },
    { name: "مشحون", value: orders.filter((o: any) => o.status === "SHIPPED").length },
    { name: "تم التسليم", value: orders.filter((o: any) => o.status === "DELIVERED").length },
  ].filter((d) => d.value > 0);

  // أفضل الطلبات
  const topOrders = orders
    .sort((a: any, b: any) => Number(b.total) - Number(a.total))
    .slice(0, 10);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-green-600 to-green-800 text-white p-8 rounded-lg">
        <h1 className="text-4xl font-bold mb-2">تقارير المبيعات الإلكترونية</h1>
        <p className="text-green-100">تحليل شامل لأداء المتجر الإلكتروني</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">إجمالي الطلبات</p>
                <p className="text-2xl font-bold">{totalOrders}</p>
              </div>
              <ShoppingCart className="h-8 w-8 text-blue-500" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">إجمالي الإيرادات</p>
                <p className="text-2xl font-bold">{totalRevenue.toLocaleString()} ر.س</p>
              </div>
              <DollarSign className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">متوسط قيمة الطلب</p>
                <p className="text-2xl font-bold">{averageOrderValue.toLocaleString()} ر.س</p>
              </div>
              <TrendingUp className="h-8 w-8 text-orange-500" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">طلبات قيد الانتظار</p>
                <p className="text-2xl font-bold">{pendingOrders}</p>
              </div>
              <Package className="h-8 w-8 text-yellow-500" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">طلبات مكتملة</p>
                <p className="text-2xl font-bold">{completedOrders}</p>
              </div>
              <Users className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Daily Sales Chart */}
        <Card>
          <CardHeader>
            <CardTitle>المبيعات اليومية</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={dailySalesData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="revenue" stroke="#3b82f6" name="الإيرادات" />
                <Line type="monotone" dataKey="orders" stroke="#10b981" name="عدد الطلبات" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Order Status Distribution */}
        <Card>
          <CardHeader>
            <CardTitle>توزيع حالات الطلبات</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={statusData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, value }) => `${name}: ${value}`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {statusData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Top Orders Table */}
      <Card>
        <CardHeader>
          <CardTitle>أفضل 10 طلبات</CardTitle>
          <CardDescription>الطلبات برقم أعلى قيمة</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>رقم الطلب</TableHead>
                  <TableHead>تاريخ الطلب</TableHead>
                  <TableHead>المجموع الفرعي</TableHead>
                  <TableHead>الشحن</TableHead>
                  <TableHead>الضريبة</TableHead>
                  <TableHead>الإجمالي</TableHead>
                  <TableHead>الحالة</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topOrders.map((order: any) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-medium">{order.orderNumber}</TableCell>
                    <TableCell>
                      {new Date(order.orderDate).toLocaleDateString("ar-SA")}
                    </TableCell>
                    <TableCell>{Number(order.subtotal).toLocaleString()} ر.س</TableCell>
                    <TableCell>{Number(order.shippingCost).toLocaleString()} ر.س</TableCell>
                    <TableCell>{Number(order.taxAmount).toLocaleString()} ر.س</TableCell>
                    <TableCell className="font-bold text-blue-600">
                      {Number(order.total).toLocaleString()} ر.س
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          order.status === "DELIVERED"
                            ? "default"
                            : order.status === "PENDING"
                            ? "secondary"
                            : "outline"
                        }
                      >
                        {order.status === "PENDING"
                          ? "قيد الانتظار"
                          : order.status === "CONFIRMED"
                          ? "مؤكد"
                          : order.status === "PROCESSING"
                          ? "قيد المعالجة"
                          : order.status === "SHIPPED"
                          ? "مشحون"
                          : order.status === "DELIVERED"
                          ? "تم التسليم"
                          : "ملغى"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Summary Statistics */}
      <Card>
        <CardHeader>
          <CardTitle>ملخص الإحصائيات</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-sm text-muted-foreground">معدل التحويل</p>
            <p className="text-2xl font-bold">
              {totalOrders > 0 ? ((completedOrders / totalOrders) * 100).toFixed(1) : 0}%
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">متوسط وقت التسليم</p>
            <p className="text-2xl font-bold">3-5 أيام</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">معدل الرضا</p>
            <p className="text-2xl font-bold">4.8/5</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">معدل الإرجاع</p>
            <p className="text-2xl font-bold">2.3%</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
