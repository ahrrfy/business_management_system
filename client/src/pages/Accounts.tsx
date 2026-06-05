import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DollarSign, TrendingUp, TrendingDown, Wallet } from "lucide-react";
import { trpc } from "@/lib/trpc";

export default function Accounts() {
  const summary = trpc.accounts.getSummary.useQuery();
  const receiptsList = trpc.accounts.listReceipts.useQuery({ limit: 50, offset: 0 });
  const entries = trpc.accounts.listEntries.useQuery({ limit: 50, offset: 0 });

  const summaryData = summary.data || { totalReceipts: 0, totalPayments: 0, netProfit: 0, totalRevenue: 0, totalCost: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">الحسابات والمالية</h1>
        <p className="text-muted-foreground mt-1">إدارة المدفوعات والمقبوضات والأرباح والخسائر</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">إجمالي المقبوضات</CardTitle>
            <TrendingUp className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold text-green-600">{Number(summaryData.totalReceipts).toLocaleString()} ر.س</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">إجمالي المدفوعات</CardTitle>
            <TrendingDown className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold text-red-600">{Number(summaryData.totalPayments).toLocaleString()} ر.س</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">إجمالي الإيرادات</CardTitle>
            <DollarSign className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{Number(summaryData.totalRevenue).toLocaleString()} ر.س</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">صافي الربح</CardTitle>
            <Wallet className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${Number(summaryData.netProfit) >= 0 ? "text-green-600" : "text-red-600"}`}>
              {Number(summaryData.netProfit).toLocaleString()} ر.س
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="receipts" dir="rtl">
        <TabsList>
          <TabsTrigger value="receipts">المقبوضات</TabsTrigger>
          <TabsTrigger value="entries">القيود المحاسبية</TabsTrigger>
          <TabsTrigger value="profit-loss">الأرباح والخسائر</TabsTrigger>
        </TabsList>

        <TabsContent value="receipts">
          <Card>
            <CardHeader><CardTitle>المقبوضات</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>رقم الفاتورة</TableHead>
                    <TableHead>المبلغ</TableHead>
                    <TableHead>طريقة الدفع</TableHead>
                    <TableHead>الحالة</TableHead>
                    <TableHead>التاريخ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(receiptsList.data || []).length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">لا توجد مقبوضات بعد</TableCell></TableRow>
                  ) : (
                    (receiptsList.data || []).map((r: any) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono">#{r.invoiceId}</TableCell>
                        <TableCell className="text-green-600 font-medium">{parseFloat(r.amount).toLocaleString()} ر.س</TableCell>
                        <TableCell>{r.paymentMethod}</TableCell>
                        <TableCell>{r.status || "مكتمل"}</TableCell>
                        <TableCell>{new Date(r.createdAt).toLocaleDateString("ar")}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="entries">
          <Card>
            <CardHeader><CardTitle>القيود المحاسبية</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>رقم الفاتورة</TableHead>
                    <TableHead>الإيرادات</TableHead>
                    <TableHead>التكلفة</TableHead>
                    <TableHead>الربح</TableHead>
                    <TableHead>التاريخ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(entries.data || []).length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">لا توجد قيود محاسبية</TableCell></TableRow>
                  ) : (
                    (entries.data || []).map((e: any) => (
                      <TableRow key={e.id}>
                        <TableCell className="font-mono">#{e.invoiceId}</TableCell>
                        <TableCell className="text-green-600">{parseFloat(e.revenue).toLocaleString()} ر.س</TableCell>
                        <TableCell className="text-red-600">{parseFloat(e.cost).toLocaleString()} ر.س</TableCell>
                        <TableCell className={parseFloat(e.profit) >= 0 ? "text-green-600 font-medium" : "text-red-600 font-medium"}>
                          {parseFloat(e.profit).toLocaleString()} ر.س
                        </TableCell>
                        <TableCell>{new Date(e.createdAt).toLocaleDateString("ar")}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="profit-loss">
          <Card>
            <CardHeader><CardTitle>تقرير الأرباح والخسائر</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex justify-between items-center p-4 border rounded-lg">
                  <span className="font-medium">إجمالي الإيرادات</span>
                  <span className="text-green-600 font-bold">{Number(summaryData.totalRevenue).toLocaleString()} ر.س</span>
                </div>
                <div className="flex justify-between items-center p-4 border rounded-lg">
                  <span className="font-medium">إجمالي التكاليف</span>
                  <span className="text-red-600 font-bold">{Number(summaryData.totalCost).toLocaleString()} ر.س</span>
                </div>
                <div className="flex justify-between items-center p-4 border rounded-lg">
                  <span className="font-medium">إجمالي المقبوضات</span>
                  <span className="text-blue-600 font-bold">{Number(summaryData.totalReceipts).toLocaleString()} ر.س</span>
                </div>
                <div className="flex justify-between items-center p-4 border rounded-lg bg-accent">
                  <span className="font-bold">صافي الربح / الخسارة</span>
                  <span className={`font-bold text-lg ${Number(summaryData.netProfit) >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {Number(summaryData.netProfit).toLocaleString()} ر.س
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
