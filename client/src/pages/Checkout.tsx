import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowRight, CreditCard, Truck, Package, Check } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { useCart } from "@/contexts/CartContext";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";

interface ShippingInfo {
  fullName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  postalCode: string;
}

interface PaymentInfo {
  method: "credit_card" | "bank_transfer" | "cash_on_delivery";
  cardNumber?: string;
  cardHolder?: string;
  expiryDate?: string;
  cvv?: string;
}

export default function Checkout() {
  const [, setLocation] = useLocation();
  const { items: cartItems, clearCart } = useCart();
  const { user } = useAuth();
  const [step, setStep] = useState<"shipping" | "payment" | "review" | "confirmation">("shipping");
  const [shippingInfo, setShippingInfo] = useState<ShippingInfo>({
    fullName: user?.name || "",
    email: user?.email || "",
    phone: "",
    address: "",
    city: "",
    postalCode: "",
  });
  const [paymentInfo, setPaymentInfo] = useState<PaymentInfo>({
    method: "cash_on_delivery",
  });
  const [orderId, setOrderId] = useState<number | null>(null);

  // إنشاء طلب
  const createOrderMutation = trpc.onlineOrders.create.useMutation({
    onSuccess: (data) => {
      toast.success("تم إنشاء الطلب بنجاح!");
      setOrderId(data.orderId);
      clearCart();
      setStep("confirmation");
    },
    onError: (error) => {
      toast.error(error.message || "فشل في إنشاء الطلب");
    },
  });

  // جلب العملاء للبحث
  const { data: customersData } = trpc.customers.list.useQuery({ limit: 1000, offset: 0 });
  const customers = customersData || [];

  if (cartItems.length === 0 && step !== "confirmation") {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground mb-4">السلة فارغة</p>
            <Button onClick={() => setLocation("/estore")}>
              العودة إلى المتجر
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const subtotal = cartItems.reduce((sum, item) => sum + item.total, 0);
  const shippingCost = 50;
  const taxAmount = subtotal * 0.15;
  const total = subtotal + shippingCost + taxAmount;

  function handleShippingNext() {
    if (!shippingInfo.fullName || !shippingInfo.email || !shippingInfo.phone || !shippingInfo.address) {
      toast.error("يرجى ملء جميع حقول الشحن");
      return;
    }
    setStep("payment");
  }

  function handlePaymentNext() {
    if (paymentInfo.method === "credit_card") {
      if (!paymentInfo.cardNumber || !paymentInfo.cardHolder || !paymentInfo.expiryDate || !paymentInfo.cvv) {
        toast.error("يرجى ملء بيانات البطاقة");
        return;
      }
    }
    setStep("review");
  }

  function handleConfirmOrder() {
    const customer = customers.find((c: any) => c.email === shippingInfo.email);
    const customerId = customer?.id || 1;

    createOrderMutation.mutate({
      customerId,
      items: cartItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
      shippingAddress: `${shippingInfo.address}, ${shippingInfo.city}`,
      shippingCost,
      taxAmount,
    });
  }

  if (step === "confirmation" && orderId) {
    return (
      <div className="space-y-6">
        <Card className="border-green-200 bg-green-50">
          <CardContent className="py-12 text-center">
            <div className="flex justify-center mb-4">
              <div className="bg-green-100 p-4 rounded-full">
                <Check className="h-8 w-8 text-green-600" />
              </div>
            </div>
            <h2 className="text-2xl font-bold text-green-800 mb-2">تم إنشاء الطلب بنجاح!</h2>
            <p className="text-green-700 mb-4">رقم الطلب: <span className="font-bold">ORD-{orderId}</span></p>
            <p className="text-muted-foreground mb-6">سيتم إرسال تأكيد الطلب إلى بريدك الإلكتروني</p>
            <div className="flex gap-3 justify-center">
              <Button onClick={() => setLocation("/online-orders")}>
                تتبع الطلب
              </Button>
              <Button variant="outline" onClick={() => setLocation("/estore")}>
                العودة إلى المتجر
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-800 text-white p-8 rounded-lg">
        <h1 className="text-4xl font-bold mb-2">إتمام الطلب</h1>
        <p className="text-blue-100">أكمل عملية الشراء بسهولة</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Steps */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex justify-between mb-8">
                {["shipping", "payment", "review"].map((s, i) => (
                  <div key={s} className="flex items-center flex-1">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center font-bold ${
                        step === s || (["shipping", "payment", "review"].indexOf(step) > i)
                          ? "bg-blue-600 text-white"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {i + 1}
                    </div>
                    {i < 2 && (
                      <div
                        className={`flex-1 h-1 mx-2 ${
                          ["shipping", "payment", "review"].indexOf(step) > i ? "bg-blue-600" : "bg-muted"
                        }`}
                      />
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Shipping Step */}
          {step === "shipping" && (
            <Card>
              <CardHeader>
                <CardTitle>معلومات الشحن</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="fullName">الاسم الكامل</Label>
                    <Input
                      id="fullName"
                      value={shippingInfo.fullName}
                      onChange={(e) => setShippingInfo({ ...shippingInfo, fullName: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="email">البريد الإلكتروني</Label>
                    <Input
                      id="email"
                      type="email"
                      value={shippingInfo.email}
                      onChange={(e) => setShippingInfo({ ...shippingInfo, email: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="phone">رقم الهاتف</Label>
                    <Input
                      id="phone"
                      value={shippingInfo.phone}
                      onChange={(e) => setShippingInfo({ ...shippingInfo, phone: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="city">المدينة</Label>
                    <Input
                      id="city"
                      value={shippingInfo.city}
                      onChange={(e) => setShippingInfo({ ...shippingInfo, city: e.target.value })}
                    />
                  </div>
                </div>

                <div>
                  <Label htmlFor="address">العنوان</Label>
                  <Textarea
                    id="address"
                    value={shippingInfo.address}
                    onChange={(e) => setShippingInfo({ ...shippingInfo, address: e.target.value })}
                  />
                </div>

                <div>
                  <Label htmlFor="postalCode">الرمز البريدي</Label>
                  <Input
                    id="postalCode"
                    value={shippingInfo.postalCode}
                    onChange={(e) => setShippingInfo({ ...shippingInfo, postalCode: e.target.value })}
                  />
                </div>

                <Button onClick={handleShippingNext} className="w-full">
                  التالي: الدفع
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Payment Step */}
          {step === "payment" && (
            <Card>
              <CardHeader>
                <CardTitle>طريقة الدفع</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <label className="flex items-center p-4 border rounded-lg cursor-pointer hover:bg-muted">
                    <input
                      type="radio"
                      name="payment"
                      value="cash_on_delivery"
                      checked={paymentInfo.method === "cash_on_delivery"}
                      onChange={(e) => setPaymentInfo({ ...paymentInfo, method: e.target.value as any })}
                      className="ml-3"
                    />
                    <span className="font-medium">الدفع عند الاستلام</span>
                  </label>

                  <label className="flex items-center p-4 border rounded-lg cursor-pointer hover:bg-muted">
                    <input
                      type="radio"
                      name="payment"
                      value="credit_card"
                      checked={paymentInfo.method === "credit_card"}
                      onChange={(e) => setPaymentInfo({ ...paymentInfo, method: e.target.value as any })}
                      className="ml-3"
                    />
                    <span className="font-medium">بطاقة ائتمان</span>
                  </label>

                  <label className="flex items-center p-4 border rounded-lg cursor-pointer hover:bg-muted">
                    <input
                      type="radio"
                      name="payment"
                      value="bank_transfer"
                      checked={paymentInfo.method === "bank_transfer"}
                      onChange={(e) => setPaymentInfo({ ...paymentInfo, method: e.target.value as any })}
                      className="ml-3"
                    />
                    <span className="font-medium">تحويل بنكي</span>
                  </label>
                </div>

                {paymentInfo.method === "credit_card" && (
                  <div className="space-y-4 pt-4 border-t">
                    <div>
                      <Label htmlFor="cardNumber">رقم البطاقة</Label>
                      <Input
                        id="cardNumber"
                        placeholder="1234 5678 9012 3456"
                        value={paymentInfo.cardNumber || ""}
                        onChange={(e) => setPaymentInfo({ ...paymentInfo, cardNumber: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label htmlFor="cardHolder">اسم حامل البطاقة</Label>
                      <Input
                        id="cardHolder"
                        value={paymentInfo.cardHolder || ""}
                        onChange={(e) => setPaymentInfo({ ...paymentInfo, cardHolder: e.target.value })}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="expiryDate">تاريخ الانتهاء</Label>
                        <Input
                          id="expiryDate"
                          placeholder="MM/YY"
                          value={paymentInfo.expiryDate || ""}
                          onChange={(e) => setPaymentInfo({ ...paymentInfo, expiryDate: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label htmlFor="cvv">CVV</Label>
                        <Input
                          id="cvv"
                          placeholder="123"
                          value={paymentInfo.cvv || ""}
                          onChange={(e) => setPaymentInfo({ ...paymentInfo, cvv: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setStep("shipping")} className="flex-1">
                    السابق
                  </Button>
                  <Button onClick={handlePaymentNext} className="flex-1">
                    التالي: المراجعة
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Review Step */}
          {step === "review" && (
            <Card>
              <CardHeader>
                <CardTitle>مراجعة الطلب</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h3 className="font-semibold mb-2">معلومات الشحن</h3>
                  <p className="text-sm text-muted-foreground">
                    {shippingInfo.fullName} - {shippingInfo.email}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {shippingInfo.address}, {shippingInfo.city}
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">طريقة الدفع</h3>
                  <p className="text-sm text-muted-foreground">
                    {paymentInfo.method === "cash_on_delivery"
                      ? "الدفع عند الاستلام"
                      : paymentInfo.method === "credit_card"
                      ? "بطاقة ائتمان"
                      : "تحويل بنكي"}
                  </p>
                </div>

                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setStep("payment")} className="flex-1">
                    السابق
                  </Button>
                  <Button
                    onClick={handleConfirmOrder}
                    disabled={createOrderMutation.isPending}
                    className="flex-1 bg-green-600 hover:bg-green-700"
                  >
                    {createOrderMutation.isPending ? "جاري الإنشاء..." : "تأكيد الطلب"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Order Summary */}
        <div className="lg:col-span-1">
          <Card className="sticky top-4">
            <CardHeader>
              <CardTitle>ملخص الطلب</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {cartItems.map((item) => (
                  <div key={item.productId} className="flex justify-between text-sm">
                    <span>{item.productName}</span>
                    <span>{item.total.toLocaleString()} ر.س</span>
                  </div>
                ))}
              </div>

              <div className="border-t pt-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span>المجموع الفرعي:</span>
                  <span>{subtotal.toLocaleString()} ر.س</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>الشحن:</span>
                  <span>{shippingCost.toLocaleString()} ر.س</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>الضريبة (15%):</span>
                  <span>{taxAmount.toLocaleString()} ر.س</span>
                </div>
                <div className="flex justify-between font-bold text-lg border-t pt-2">
                  <span>الإجمالي:</span>
                  <span className="text-blue-600">{total.toLocaleString()} ر.س</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
