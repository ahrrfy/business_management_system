import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Eye, Edit2, Trash2, Package, Truck, CheckCircle, XCircle, Clock } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

const statusConfig = {
  PENDING: { label: "قيد الانتظار", color: "bg-yellow-100 text-yellow-800", icon: Clock },
  CONFIRMED: { label: "مؤكد", color: "bg-blue-100 text-blue-800", icon: CheckCircle },
  PROCESSING: { label: "قيد المعالجة", color: "bg-purple-100 text-purple-800", icon: Package },
  SHIPPED: { label: "مشحون", color: "bg-indigo-100 text-indigo-800", icon: Truck },
  DELIVERED: { label: "تم التسليم", color: "bg-green-100 text-green-800", icon: CheckCircle },
  CANCELLED: { label: "ملغى", color: "bg-red-100 text-red-800", icon: XCircle },
};

export default function OnlineOrderManagement() {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [selectedOrder, setSelectedOrder] = useState<any>(null);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [isUpdateOpen, setIsUpdateOpen] = useState(false);
  const [newStatus, setNewStatus] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");

  // جلب الطلبات
  const { data: ordersData, isLoading, refetch } = trpc.onlineOrders.list.useQuery({
    limit: 100,
    offset: 0,
  });

  // تحديث حالة الطلب
  const updateStatusMutation = trpc.onlineOrders.updateStatus.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث حالة الطلب بنجاح");
      setIsUpdateOpen(false);
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "فشل في تحديث الطلب");
    },
  });

  // إلغاء الطلب
  const cancelMutation = trpc.onlineOrders.cancel.useMutation({
    onSuccess: () => {
      toast.success("تم إلغاء الطلب بنجاح");
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "فشل في إلغاء الطلب");
    },
  });

  const orders = ordersData?.orders || [];

  // تصفية الطلبات
  const filteredOrders = orders.filter((order: any) => {
    const matchesSearch =
      order.orderNumber.includes(searchTerm) ||
      order.customer?.name?.includes(searchTerm) ||
      order.customer?.email?.includes(searchTerm);

    const matchesStatus = statusFilter === "ALL" || order.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  function handleUpdateStatus() {
    if (!selectedOrder || !newStatus) {
      toast.error("يرجى اختيار حالة جديدة");
      return;
    }

    updateStatusMutation.mutate({
      orderId: selectedOrder.id,
      status: newStatus as any,
      trackingNumber: trackingNumber || undefined,
    });
  }

  function handleCancelOrder(orderId: number) {
    if (confirm("هل أنت متأكد من إلغاء هذا الطلب؟")) {
      cancelMutation.mutate(orderId);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-800 text-white p-8 rounded-lg">
        <h1 className="text-4xl font-bold mb-2">إدارة الطلبات الإلكترونية</h1>
        <p className="text-blue-100">إدارة وتتبع جميع الطلبات من المتجر الإلكتروني</p>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>البحث والتصفية</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="search">البحث برقم الطلب أو اسم العميل</Label>
              <Input
                id="search"
                placeholder="ابحث هنا..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="status">حالة الطلب</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger id="status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">جميع الحالات</SelectItem>
                  <SelectItem value="PENDING">قيد الانتظار</SelectItem>
                  <SelectItem value="CONFIRMED">مؤكد</SelectItem>
                  <SelectItem value="PROCESSING">قيد المعالجة</SelectItem>
                  <SelectItem value="SHIPPED">مشحون</SelectItem>
                  <SelectItem value="DELIVERED">تم التسليم</SelectItem>
                  <SelectItem value="CANCELLED">ملغى</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button onClick={() => refetch()} className="w-full">
                تحديث
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Orders Table */}
      <Card>
        <CardHeader>
          <CardTitle>قائمة الطلبات</CardTitle>
          <CardDescription>
            عدد الطلبات: {filteredOrders.length}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8">جاري تحميل الطلبات...</div>
          ) : filteredOrders.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">لا توجد طلبات</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>رقم الطلب</TableHead>
                    <TableHead>العميل</TableHead>
                    <TableHead>التاريخ</TableHead>
                    <TableHead>الإجمالي</TableHead>
                    <TableHead>الحالة</TableHead>
                    <TableHead>الإجراءات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredOrders.map((order: any) => {
                    const statusInfo = statusConfig[order.status as keyof typeof statusConfig];
                    const StatusIcon = statusInfo?.icon || Clock;

                    return (
                      <TableRow key={order.id}>
                        <TableCell className="font-medium">{order.orderNumber}</TableCell>
                        <TableCell>{order.customer?.name || "غير معروف"}</TableCell>
                        <TableCell>
                          {new Date(order.orderDate).toLocaleDateString("ar-SA")}
                        </TableCell>
                        <TableCell>{Number(order.total).toLocaleString()} ر.س</TableCell>
                        <TableCell>
                          <Badge className={statusInfo?.color}>
                            <StatusIcon className="h-3 w-3 ml-1" />
                            {statusInfo?.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            <Dialog open={isDetailsOpen && selectedOrder?.id === order.id} onOpenChange={setIsDetailsOpen}>
                              <DialogTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setSelectedOrder(order)}
                                >
                                  <Eye className="h-4 w-4" />
                                </Button>
                              </DialogTrigger>
                              <DialogContent className="max-w-2xl">
                                <DialogHeader>
                                  <DialogTitle>تفاصيل الطلب {order.orderNumber}</DialogTitle>
                                </DialogHeader>
                                <div className="space-y-4">
                                  <div className="grid grid-cols-2 gap-4">
                                    <div>
                                      <p className="text-sm text-muted-foreground">العميل</p>
                                      <p className="font-medium">{order.customer?.name}</p>
                                    </div>
                                    <div>
                                      <p className="text-sm text-muted-foreground">البريد الإلكتروني</p>
                                      <p className="font-medium">{order.customer?.email}</p>
                                    </div>
                                    <div>
                                      <p className="text-sm text-muted-foreground">التاريخ</p>
                                      <p className="font-medium">
                                        {new Date(order.orderDate).toLocaleDateString("ar-SA")}
                                      </p>
                                    </div>
                                    <div>
                                      <p className="text-sm text-muted-foreground">الحالة</p>
                                      <Badge className={statusConfig[order.status as keyof typeof statusConfig]?.color}>
                                        {statusConfig[order.status as keyof typeof statusConfig]?.label}
                                      </Badge>
                                    </div>
                                  </div>

                                  <div>
                                    <p className="text-sm text-muted-foreground mb-2">عنوان التسليم</p>
                                    <p className="font-medium">{order.shippingAddress}</p>
                                  </div>

                                  <div className="border-t pt-4">
                                    <p className="font-medium mb-2">ملخص الطلب</p>
                                    <div className="space-y-2 text-sm">
                                      <div className="flex justify-between">
                                        <span>المجموع الفرعي:</span>
                                        <span>{Number(order.subtotal).toLocaleString()} ر.س</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span>الشحن:</span>
                                        <span>{Number(order.shippingCost).toLocaleString()} ر.س</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span>الضريبة:</span>
                                        <span>{Number(order.taxAmount).toLocaleString()} ر.س</span>
                                      </div>
                                      <div className="flex justify-between font-bold border-t pt-2">
                                        <span>الإجمالي:</span>
                                        <span>{Number(order.total).toLocaleString()} ر.س</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </DialogContent>
                            </Dialog>

                            <Dialog open={isUpdateOpen && selectedOrder?.id === order.id} onOpenChange={setIsUpdateOpen}>
                              <DialogTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    setSelectedOrder(order);
                                    setNewStatus(order.status);
                                    setTrackingNumber(order.trackingNumber || "");
                                  }}
                                >
                                  <Edit2 className="h-4 w-4" />
                                </Button>
                              </DialogTrigger>
                              <DialogContent>
                                <DialogHeader>
                                  <DialogTitle>تحديث حالة الطلب</DialogTitle>
                                </DialogHeader>
                                <div className="space-y-4">
                                  <div>
                                    <Label htmlFor="new-status">الحالة الجديدة</Label>
                                    <Select value={newStatus} onValueChange={setNewStatus}>
                                      <SelectTrigger id="new-status">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="PENDING">قيد الانتظار</SelectItem>
                                        <SelectItem value="CONFIRMED">مؤكد</SelectItem>
                                        <SelectItem value="PROCESSING">قيد المعالجة</SelectItem>
                                        <SelectItem value="SHIPPED">مشحون</SelectItem>
                                        <SelectItem value="DELIVERED">تم التسليم</SelectItem>
                                        <SelectItem value="CANCELLED">ملغى</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>

                                  <div>
                                    <Label htmlFor="tracking">رقم التتبع (اختياري)</Label>
                                    <Input
                                      id="tracking"
                                      placeholder="أدخل رقم التتبع"
                                      value={trackingNumber}
                                      onChange={(e) => setTrackingNumber(e.target.value)}
                                    />
                                  </div>

                                  <Button
                                    onClick={handleUpdateStatus}
                                    disabled={updateStatusMutation.isPending}
                                    className="w-full"
                                  >
                                    {updateStatusMutation.isPending ? "جاري التحديث..." : "تحديث"}
                                  </Button>
                                </div>
                              </DialogContent>
                            </Dialog>

                            {order.status !== "DELIVERED" && order.status !== "CANCELLED" && (
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => handleCancelOrder(order.id)}
                                disabled={cancelMutation.isPending}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
