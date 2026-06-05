import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileText, Eye, CreditCard, Search } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export default function InvoicesPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<number | null>(null);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentInvoiceId, setPaymentInvoiceId] = useState<number | null>(null);

  const invoicesList = trpc.invoices.list.useQuery({ limit: 50, offset: 0 });
  const invoiceDetails = trpc.invoices.getDetails.useQuery(
    { invoiceId: selectedInvoiceId! },
    { enabled: !!selectedInvoiceId }
  );
  const processPayment = trpc.invoices.processPayment.useMutation({
    onSuccess: () => {
      toast.success("تم تسجيل الدفعة بنجاح");
      invoicesList.refetch();
      setPaymentDialogOpen(false);
      setPaymentAmount("");
    },
    onError: (err) => toast.error(err.message),
  });

  const invoices = invoicesList.data?.data || [];

  const filteredInvoices = searchQuery
    ? (invoices as any[]).filter(
        (inv: any) =>
          inv.invoiceNumber?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : (invoices as any[]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "PAID":
        return <Badge className="bg-green-100 text-green-800">مدفوعة</Badge>;
      case "PARTIAL":
        return <Badge className="bg-yellow-100 text-yellow-800">جزئي</Badge>;
      case "PENDING":
        return <Badge className="bg-orange-100 text-orange-800">معلقة</Badge>;
      case "CANCELLED":
        return <Badge className="bg-red-100 text-red-800">ملغاة</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const handlePayment = () => {
    if (!paymentInvoiceId || !paymentAmount) return;
    processPayment.mutate({
      invoiceId: paymentInvoiceId,
      amount: parseFloat(paymentAmount),
      paymentMethod: "CASH",
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">الفواتير</h1>
          <p className="text-muted-foreground mt-1">إدارة جميع فواتير المبيعات</p>
        </div>
      </div>

      {/* شريط البحث */}
      <div className="relative max-w-md">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="ابحث برقم الفاتورة..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pr-10"
        />
      </div>

      {/* جدول الفواتير */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            قائمة الفواتير ({filteredInvoices.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {invoicesList.isLoading ? (
            <p className="text-center py-8 text-muted-foreground">جاري التحميل...</p>
          ) : filteredInvoices.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">
              لا توجد فواتير بعد
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">رقم الفاتورة</TableHead>
                  <TableHead className="text-right">التاريخ</TableHead>
                  <TableHead className="text-right">المصدر</TableHead>
                  <TableHead className="text-right">الإجمالي</TableHead>
                  <TableHead className="text-right">المدفوع</TableHead>
                  <TableHead className="text-right">الحالة</TableHead>
                  <TableHead className="text-right">إجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredInvoices.map((inv: any) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-mono text-sm">
                      {inv.invoiceNumber}
                    </TableCell>
                    <TableCell>
                      {new Date(inv.invoiceDate).toLocaleDateString("ar-SA")}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {inv.sourceType === "POS"
                          ? "نقطة بيع"
                          : inv.sourceType === "ONLINE"
                          ? "متجر"
                          : "طلب"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-bold">
                      {parseFloat(inv.total).toLocaleString()} ر.س
                    </TableCell>
                    <TableCell>
                      {parseFloat(inv.paidAmount || "0").toLocaleString()} ر.س
                    </TableCell>
                    <TableCell>{getStatusBadge(inv.status)}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedInvoiceId(inv.id)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {inv.status !== "PAID" && inv.status !== "CANCELLED" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setPaymentInvoiceId(inv.id);
                              const remaining =
                                parseFloat(inv.total) -
                                parseFloat(inv.paidAmount || "0");
                              setPaymentAmount(remaining.toString());
                              setPaymentDialogOpen(true);
                            }}
                          >
                            <CreditCard className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* نافذة تفاصيل الفاتورة */}
      <Dialog
        open={!!selectedInvoiceId}
        onOpenChange={() => setSelectedInvoiceId(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>تفاصيل الفاتورة</DialogTitle>
          </DialogHeader>
          {invoiceDetails.isLoading ? (
            <p className="text-center py-4">جاري التحميل...</p>
          ) : invoiceDetails.data?.data ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">رقم الفاتورة:</span>
                  <p className="font-bold">
                    {invoiceDetails.data.data.invoiceNumber}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">التاريخ:</span>
                  <p>
                    {new Date(
                      invoiceDetails.data.data.invoiceDate
                    ).toLocaleDateString("ar-SA")}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">الإجمالي:</span>
                  <p className="font-bold text-primary">
                    {parseFloat(
                      invoiceDetails.data.data.total
                    ).toLocaleString()}{" "}
                    ر.س
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">الحالة:</span>
                  <p>{getStatusBadge(invoiceDetails.data.data.status)}</p>
                </div>
              </div>
              {invoiceDetails.data.data.items?.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-2">العناصر:</h4>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">المنتج</TableHead>
                        <TableHead className="text-right">الكمية</TableHead>
                        <TableHead className="text-right">السعر</TableHead>
                        <TableHead className="text-right">الإجمالي</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invoiceDetails.data.data.items.map(
                        (item: any, idx: number) => (
                          <TableRow key={idx}>
                            <TableCell>{item.productId}</TableCell>
                            <TableCell>{item.quantity}</TableCell>
                            <TableCell>
                              {parseFloat(item.unitPrice).toLocaleString()}
                            </TableCell>
                            <TableCell>
                              {parseFloat(item.total).toLocaleString()}
                            </TableCell>
                          </TableRow>
                        )
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* نافذة تسجيل الدفع */}
      <Dialog open={paymentDialogOpen} onOpenChange={setPaymentDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>تسجيل دفعة</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">المبلغ</label>
              <Input
                type="number"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                placeholder="أدخل المبلغ"
              />
            </div>
            <Button onClick={handlePayment} className="w-full">
              تأكيد الدفع
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
