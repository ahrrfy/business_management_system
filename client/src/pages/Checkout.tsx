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

interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

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
  const [step, setStep] = useState<"shipping" | "payment" | "review" | "confirmation">("shipping");
  const [shippingInfo, setShippingInfo] = useState<ShippingInfo>({
    fullName: "",
    email: "",
    phone: "",
    address: "",
    city: "",
    postalCode: "",
  });
  const [paymentInfo, setPaymentInfo] = useState<PaymentInfo>({
    method: "credit_card",
  });

  // Mock cart data
  const cartItems: CartItem[] = [
    { id: "1", name: "منتج 1", price: 100, quantity: 2 },
    { id: "2", name: "منتج 2", price: 150, quantity: 1 },
  ];

  const subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const shipping = subtotal > 500 ? 0 : 50;
  const tax = (subtotal + shipping) * 0.15;
  const total = subtotal + shipping + tax;

  function handleShippingSubmit() {
    if (!shippingInfo.fullName || !shippingInfo.email || !shippingInfo.phone || !shippingInfo.address) {
      toast.error("يرجى ملء جميع الحقول المطلوبة");
      return;
    }
    setStep("payment");
    toast.success("تم حفظ معلومات الشحن");
  }

  function handlePaymentSubmit() {
    if (paymentInfo.method === "credit_card") {
      if (!paymentInfo.cardNumber || !paymentInfo.cardHolder || !paymentInfo.expiryDate || !paymentInfo.cvv) {
        toast.error("يرجى ملء بيانات البطاقة الائتمانية");
        return;
      }
    }
    setStep("review");
    toast.success("تم حفظ معلومات الدفع");
  }

  function handleConfirmOrder() {
    setStep("confirmation");
    toast.success("تم تأكيد الطلب بنجاح!");
    setTimeout(() => {
      setLocation("/estore");
    }, 3000);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-800 text-white p-8 rounded-lg">
        <h1 className="text-4xl font-bold mb-2">إتمام الشراء</h1>
        <p className="text-blue-100">أكمل عملية الشراء بسهولة وأمان</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2">
          {/* Steps Indicator */}
          <div className="flex gap-4 mb-8">
            <div className={`flex-1 text-center ${step === "shipping" ? "text-primary" : "text-muted-foreground"}`}>
              <div className={`w-10 h-10 rounded-full flex items-center justify-center mx-auto mb-2 ${
                step === "shipping" ? "bg-primary text-white" : "bg-muted"
              }`}>
                <Truck className="h-5 w-5" />
              </div>
              <p className="text-sm font-medium">الشحن</p>
            </div>
            <div className={`flex-1 text-center ${step === "payment" ? "text-primary" : "text-muted-foreground"}`}>
              <div className={`w-10 h-10 rounded-full flex items-center justify-center mx-auto mb-2 ${
                step === "payment" ? "bg-primary text-white" : "bg-muted"
              }`}>
                <CreditCard className="h-5 w-5" />
              </div>
              <p className="text-sm font-medium">الدفع</p>
            </div>
            <div className={`flex-1 text-center ${step === "review" ? "text-primary" : "text-muted-foreground"}`}>
              <div className={`w-10 h-10 rounded-full flex items-center justify-center mx-auto mb-2 ${
                step === "review" ? "bg-primary text-white" : "bg-muted"
              }`}>
                <Package className="h-5 w-5" />
              </div>
              <p className="text-sm font-medium">المراجعة</p>
            </div>
          </div>

          {/* Shipping Step */}
          {step === "shipping" && (
            <Card>
              <CardHeader>
                <CardTitle>معلومات الشحن</CardTitle>
                <CardDescription>أدخل عنوان التسليم</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="fullName">الاسم الكامل</Label>
                    <Input
                      id="fullName"
                      value={shippingInfo.fullName}
                      onChange={(e) => setShippingInfo({ ...shippingInfo, fullName: e.target.value })}
                      placeholder="أحمد محمد"
                    />
                  </div>
                  <div>
                    <Label htmlFor="email">البريد الإلكتروني</Label>
                    <Input
                      id="email"
                      type="email"
                      value={shippingInfo.email}
                      onChange={(e) => setShippingInfo({ ...shippingInfo, email: e.target.value })}
                      placeholder="example@email.com"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="phone">رقم الهاتف</Label>
                    <Input
                      id="phone"
                      value={shippingInfo.phone}
                      onChange={(e) => setShippingInfo({ ...shippingInfo, phone: e.target.value })}
                      placeholder="0501234567"
                    />
                  </div>
                  <div>
                    <Label htmlFor="city">المدينة</Label>
                    <Input
                      id="city"
                      value={shippingInfo.city}
                      onChange={(e) => setShippingInfo({ ...shippingInfo, city: e.target.value })}
                      placeholder="الرياض"
                    />
                  </div>
                </div>

                <div>
                  <Label htmlFor="address">العنوان</Label>
                  <Textarea
                    id="address"
                    value={shippingInfo.address}
                    onChange={(e) => setShippingInfo({ ...shippingInfo, address: e.target.value })}
                    placeholder="الشارع والحي والمنطقة"
                    rows={3}
                  />
                </div>

                <div>
                  <Label htmlFor="postalCode">الرمز البريدي</Label>
                  <Input
                    id="postalCode"
                    value={shippingInfo.postalCode}
                    onChange={(e) => setShippingInfo({ ...shippingInfo, postalCode: e.target.value })}
                    placeholder="12345"
                  />
                </div>

                <Button onClick={handleShippingSubmit} className="w-full">
                  متابعة إلى الدفع
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Payment Step */}
          {step === "payment" && (
            <Card>
              <CardHeader>
                <CardTitle>طريقة الدفع</CardTitle>
                <CardDescription>اختر طريقة الدفع المفضلة</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Tabs value={paymentInfo.method} onValueChange={(value: any) => setPaymentInfo({ ...paymentInfo, method: value })}>
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="credit_card">بطاقة ائتمانية</TabsTrigger>
                    <TabsTrigger value="bank_transfer">تحويل بنكي</TabsTrigger>
                    <TabsTrigger value="cash_on_delivery">الدفع عند الاستلام</TabsTrigger>
                  </TabsList>

                  <TabsContent value="credit_card" className="space-y-4">
                    <div>
                      <Label htmlFor="cardNumber">رقم البطاقة</Label>
                      <Input
                        id="cardNumber"
                        value={paymentInfo.cardNumber || ""}
                        onChange={(e) => setPaymentInfo({ ...paymentInfo, cardNumber: e.target.value })}
                        placeholder="1234 5678 9012 3456"
                      />
                    </div>
                    <div>
                      <Label htmlFor="cardHolder">اسم صاحب البطاقة</Label>
                      <Input
                        id="cardHolder"
                        value={paymentInfo.cardHolder || ""}
                        onChange={(e) => setPaymentInfo({ ...paymentInfo, cardHolder: e.target.value })}
                        placeholder="أحمد محمد"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="expiryDate">تاريخ الانتهاء</Label>
                        <Input
                          id="expiryDate"
                          value={paymentInfo.expiryDate || ""}
                          onChange={(e) => setPaymentInfo({ ...paymentInfo, expiryDate: e.target.value })}
                          placeholder="MM/YY"
                        />
                      </div>
                      <div>
                        <Label htmlFor="cvv">CVV</Label>
                        <Input
                          id="cvv"
                          value={paymentInfo.cvv || ""}
                          onChange={(e) => setPaymentInfo({ ...paymentInfo, cvv: e.target.value })}
                          placeholder="123"
                        />
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="bank_transfer" className="space-y-4">
                    <p className="text-sm text-muted-foreground">سيتم إرسال تفاصيل التحويل البنكي إلى بريدك الإلكتروني</p>
                  </TabsContent>

                  <TabsContent value="cash_on_delivery" className="space-y-4">
                    <p className="text-sm text-muted-foreground">ستتمكن من الدفع عند استلام الطلب</p>
                  </TabsContent>
                </Tabs>

                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setStep("shipping")} className="flex-1">
                    <ArrowRight className="h-4 w-4 ml-2" />
                    رجوع
                  </Button>
                  <Button onClick={handlePaymentSubmit} className="flex-1">
                    متابعة إلى المراجعة
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
                <CardDescription>تحقق من جميع التفاصيل قبل تأكيد الطلب</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <h3 className="font-semibold">معلومات الشحن</h3>
                  <p className="text-sm text-muted-foreground">{shippingInfo.fullName}</p>
                  <p className="text-sm text-muted-foreground">{shippingInfo.address}</p>
                  <p className="text-sm text-muted-foreground">{shippingInfo.city}</p>
                </div>

                <div className="border-t pt-4">
                  <h3 className="font-semibold mb-2">طريقة الدفع</h3>
                  <p className="text-sm text-muted-foreground">
                    {paymentInfo.method === "credit_card" && "بطاقة ائتمانية"}
                    {paymentInfo.method === "bank_transfer" && "تحويل بنكي"}
                    {paymentInfo.method === "cash_on_delivery" && "الدفع عند الاستلام"}
                  </p>
                </div>

                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setStep("payment")} className="flex-1">
                    <ArrowRight className="h-4 w-4 ml-2" />
                    رجوع
                  </Button>
                  <Button onClick={handleConfirmOrder} className="flex-1">
                    تأكيد الطلب
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Confirmation Step */}
          {step === "confirmation" && (
            <Card className="text-center">
              <CardContent className="pt-8 pb-8">
                <div className="flex justify-center mb-4">
                  <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center">
                    <Check className="h-8 w-8 text-green-600" />
                  </div>
                </div>
                <h2 className="text-2xl font-bold mb-2">تم تأكيد الطلب بنجاح!</h2>
                <p className="text-muted-foreground mb-4">رقم الطلب: #12345</p>
                <p className="text-sm text-muted-foreground">سيتم إعادة توجيهك إلى المتجر في لحظات...</p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Order Summary Sidebar */}
        <div>
          <Card className="sticky top-4">
            <CardHeader>
              <CardTitle>ملخص الطلب</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {cartItems.map(item => (
                  <div key={item.id} className="flex justify-between text-sm">
                    <span>{item.name} × {item.quantity}</span>
                    <span>{(item.price * item.quantity).toLocaleString()} ر.س</span>
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
                  <span className={shipping === 0 ? "text-green-600" : ""}>
                    {shipping === 0 ? "مجاني" : `${shipping.toLocaleString()} ر.س`}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>الضريبة (15%):</span>
                  <span>{tax.toLocaleString()} ر.س</span>
                </div>
                <div className="border-t pt-2 flex justify-between font-bold">
                  <span>المجموع:</span>
                  <span className="text-primary">{total.toLocaleString()} ر.س</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
