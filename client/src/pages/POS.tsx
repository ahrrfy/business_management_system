import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Trash2, Plus, ShoppingCart, DollarSign } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

/**
 * ====================================
 * شاشة نقطة البيع (POS)
 * ====================================
 * 
 * واجهة كاملة للبيع الفوري مع:
 * - إضافة المنتجات للسلة
 * - حساب الإجماليات تلقائياً
 * - معالجة الدفع
 * - طباعة الفاتورة
 */

interface CartItem {
  productId: number;
  productName: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export default function POSPage() {
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [customerId, setCustomerId] = useState<number>(1);
  const [paymentMethod, setPaymentMethod] = useState<string>("CASH");
  const [isProcessing, setIsProcessing] = useState(false);
  const [showPayment, setShowPayment] = useState(false);

  // استدعاء API لإنشاء الفاتورة
  const createInvoiceMutation = trpc.invoices.create.useMutation();
  const getDailyStatsMutation = trpc.invoices.getDailyStats.useQuery({});

  // حساب الإجماليات
  const subtotal = cartItems.reduce((sum, item) => sum + item.total, 0);
  const taxAmount = subtotal * 0.15; // 15% ضريبة
  const total = subtotal + taxAmount;

  /**
   * إضافة منتج للسلة
   */
  const addToCart = (
    productId: number,
    productName: string,
    unitPrice: number
  ) => {
    const existingItem = cartItems.find((item) => item.productId === productId);

    if (existingItem) {
      setCartItems(
        cartItems.map((item) =>
          item.productId === productId
            ? {
                ...item,
                quantity: item.quantity + 1,
                total: (item.quantity + 1) * item.unitPrice,
              }
            : item
        )
      );
    } else {
      setCartItems([
        ...cartItems,
        {
          productId,
          productName,
          quantity: 1,
          unitPrice,
          total: unitPrice,
        },
      ]);
    }

    toast.success(`تمت إضافة ${productName} للسلة`);
  };

  /**
   * تحديث كمية المنتج
   */
  const updateQuantity = (productId: number, quantity: number) => {
    if (quantity <= 0) {
      removeFromCart(productId);
      return;
    }

    setCartItems(
      cartItems.map((item) =>
        item.productId === productId
          ? {
              ...item,
              quantity,
              total: quantity * item.unitPrice,
            }
          : item
      )
    );
  };

  /**
   * حذف منتج من السلة
   */
  const removeFromCart = (productId: number) => {
    setCartItems(cartItems.filter((item) => item.productId !== productId));
    toast.success("تمت إزالة المنتج من السلة");
  };

  /**
   * إتمام البيع
   */
  const completeSale = async () => {
    if (cartItems.length === 0) {
      toast.error("السلة فارغة");
      return;
    }

    setIsProcessing(true);

    try {
      const result = await createInvoiceMutation.mutateAsync({
        customerId,
        sourceType: "POS",
        items: cartItems.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
        taxPercent: 15,
        paymentMethod,
      });

      toast.success(`تم إنشاء الفاتورة: ${result.data.invoiceNumber}`);

      // تنظيف السلة
      setCartItems([]);
      setShowPayment(false);

      // تحديث الإحصائيات
      getDailyStatsMutation.refetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : "حدث خطأ";
      toast.error(message);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* قائمة المنتجات */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShoppingCart className="w-5 h-5" />
                المنتجات المتاحة
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {/* عينة من المنتجات */}
                {[
                  {
                    id: 1,
                    name: "لابتوب Dell",
                    price: 5000,
                  },
                  {
                    id: 2,
                    name: "ماوس لاسلكي",
                    price: 150,
                  },
                  {
                    id: 3,
                    name: "لوحة مفاتيح",
                    price: 300,
                  },
                  {
                    id: 4,
                    name: "شاشة 24 بوصة",
                    price: 1200,
                  },
                  {
                    id: 5,
                    name: "كابل USB",
                    price: 50,
                  },
                  {
                    id: 6,
                    name: "سماعات رأس",
                    price: 400,
                  },
                ].map((product) => (
                  <div
                    key={product.id}
                    className="border rounded-lg p-4 hover:shadow-lg transition"
                  >
                    <h3 className="font-semibold text-sm mb-2">
                      {product.name}
                    </h3>
                    <p className="text-lg font-bold text-blue-600 mb-3">
                      {product.price.toLocaleString()} ر.س
                    </p>
                    <Button
                      onClick={() =>
                        addToCart(product.id, product.name, product.price)
                      }
                      className="w-full"
                      size="sm"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      إضافة
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* السلة والدفع */}
        <div>
          <Card className="sticky top-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShoppingCart className="w-5 h-5" />
                السلة ({cartItems.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* عناصر السلة */}
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {cartItems.length === 0 ? (
                  <p className="text-center text-gray-500 py-8">السلة فارغة</p>
                ) : (
                  cartItems.map((item) => (
                    <div
                      key={item.productId}
                      className="border rounded-lg p-3 space-y-2"
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-semibold text-sm">
                            {item.productName}
                          </p>
                          <p className="text-xs text-gray-500">
                            {item.unitPrice.toLocaleString()} ر.س
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeFromCart(item.productId)}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      </div>

                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min="1"
                          value={item.quantity}
                          onChange={(e) =>
                            updateQuantity(
                              item.productId,
                              parseInt(e.target.value) || 1
                            )
                          }
                          className="w-16 h-8"
                        />
                        <span className="text-sm font-semibold">
                          {item.total.toLocaleString()} ر.س
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* الإجماليات */}
              {cartItems.length > 0 && (
                <div className="border-t pt-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>المجموع الفرعي:</span>
                    <span>{subtotal.toLocaleString()} ر.س</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span>الضريبة (15%):</span>
                    <span>{taxAmount.toLocaleString()} ر.س</span>
                  </div>
                  <div className="flex justify-between text-lg font-bold border-t pt-2">
                    <span>الإجمالي:</span>
                    <span className="text-green-600">
                      {total.toLocaleString()} ر.س
                    </span>
                  </div>
                </div>
              )}

              {/* طريقة الدفع */}
              {cartItems.length > 0 && (
                <div className="space-y-2">
                  <label className="text-sm font-semibold">طريقة الدفع:</label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="w-full border rounded-lg p-2 text-sm"
                  >
                    <option value="CASH">نقداً</option>
                    <option value="CARD">بطاقة ائتمان</option>
                    <option value="CHECK">شيك</option>
                    <option value="TRANSFER">تحويل بنكي</option>
                  </select>
                </div>
              )}

              {/* زر الدفع */}
              <Button
                onClick={() => setShowPayment(true)}
                disabled={cartItems.length === 0 || isProcessing}
                className="w-full"
                size="lg"
              >
                <DollarSign className="w-5 h-5 mr-2" />
                {isProcessing ? "جاري المعالجة..." : "إتمام البيع"}
              </Button>

              {/* تأكيد الدفع */}
              {showPayment && (
                <div className="border-t pt-4 space-y-2">
                  <p className="text-sm text-gray-600">
                    هل أنت متأكد من إتمام البيع؟
                  </p>
                  <div className="flex gap-2">
                    <Button
                      onClick={completeSale}
                      disabled={isProcessing}
                      className="flex-1 bg-green-600 hover:bg-green-700"
                    >
                      نعم، أتمم البيع
                    </Button>
                    <Button
                      onClick={() => setShowPayment(false)}
                      variant="outline"
                      className="flex-1"
                    >
                      إلغاء
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
