import { getDb } from "../db";
import { onlineOrders, customers } from "../../drizzle/schema";
import { and, gte, lte } from "drizzle-orm";

export interface SalesReportData {
  totalOrders: number;
  totalRevenue: number;
  averageOrderValue: number;
  pendingOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  dailySalesData: Array<{
    date: string;
    revenue: number;
    orders: number;
  }>;
  statusDistribution: Array<{
    status: string;
    count: number;
  }>;
  conversionRate: number;
  averageShippingCost: number;
  averageTaxAmount: number;
}

export async function generateSalesReport(
  startDate?: Date,
  endDate?: Date
): Promise<SalesReportData> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  // جلب جميع الطلبات
  let orders: any[] = [];

  if (startDate && endDate) {
    orders = await db
      .select()
      .from(onlineOrders)
      .where(
        and(
          gte(onlineOrders.orderDate, startDate),
          lte(onlineOrders.orderDate, endDate)
        )
      );
  } else {
    orders = await db.select().from(onlineOrders);
  }

  // حساب الإحصائيات الأساسية
  const totalOrders = orders.length;
  const totalRevenue = orders.reduce((sum, order: any) => sum + Number(order.total), 0);
  const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  const pendingOrders = orders.filter((o: any) => o.status === "PENDING").length;
  const completedOrders = orders.filter((o: any) => o.status === "DELIVERED").length;
  const cancelledOrders = orders.filter((o: any) => o.status === "CANCELLED").length;

  // بيانات المبيعات اليومية
  const dailySalesMap = new Map<string, { revenue: number; orders: number }>();
  orders.forEach((order: any) => {
    const date = new Date(order.orderDate).toLocaleDateString("ar-SA");
    const existing = dailySalesMap.get(date) || { revenue: 0, orders: 0 };
    dailySalesMap.set(date, {
      revenue: existing.revenue + Number(order.total),
      orders: existing.orders + 1,
    });
  });

  const dailySalesData = Array.from(dailySalesMap.entries()).map(([date, data]) => ({
    date,
    ...data,
  }));

  // توزيع الحالات
  const statusDistribution = [
    { status: "PENDING", count: pendingOrders },
    { status: "CONFIRMED", count: orders.filter((o: any) => o.status === "CONFIRMED").length },
    { status: "PROCESSING", count: orders.filter((o: any) => o.status === "PROCESSING").length },
    { status: "SHIPPED", count: orders.filter((o: any) => o.status === "SHIPPED").length },
    { status: "DELIVERED", count: completedOrders },
    { status: "CANCELLED", count: cancelledOrders },
  ].filter((d) => d.count > 0);

  // حساب معدل التحويل
  const conversionRate = totalOrders > 0 ? (completedOrders / totalOrders) * 100 : 0;

  // متوسط تكاليف الشحن والضريبة
  const averageShippingCost =
    totalOrders > 0
      ? orders.reduce((sum, order: any) => sum + Number(order.shippingCost), 0) / totalOrders
      : 0;
  const averageTaxAmount =
    totalOrders > 0
      ? orders.reduce((sum, order: any) => sum + Number(order.taxAmount), 0) / totalOrders
      : 0;

  return {
    totalOrders,
    totalRevenue,
    averageOrderValue,
    pendingOrders,
    completedOrders,
    cancelledOrders,
    dailySalesData,
    statusDistribution,
    conversionRate,
    averageShippingCost,
    averageTaxAmount,
  };
}

export async function getCustomerMetrics() {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const orders = await db.select().from(onlineOrders);

  const customerMap = new Map<number, { name: string; totalOrders: number; totalSpent: number }>();

  for (const order of orders) {
    const customerList = await db
      .select()
      .from(customers)
      .limit(1000);
    
    const customer = customerList.filter((c: any) => c.id === order.customerId);

    if (customer && customer.length > 0) {
      const cust = customer[0];
      const existing = customerMap.get(cust.id) || {
        name: cust.name,
        totalOrders: 0,
        totalSpent: 0,
      };

      customerMap.set((cust as any).id, {
        ...existing,
        totalOrders: existing.totalOrders + 1,
        totalSpent: existing.totalSpent + Number(order.total),
      });
    }
  }

  return Array.from(customerMap.entries())
    .map(([id, data]) => ({
      customerId: id,
      ...data,
    }))
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, 10);
}
