import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Trash2,
  Plus,
  Minus,
  ShoppingCart,
  CreditCard,
  Banknote,
  Search,
  Printer,
  RotateCcw,
  CheckCircle2,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

interface CartItem {
  productId: number;
  productName: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  maxStock: number;
  total: number;
}

export default function POSPage() {
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<string>("CASH");
  const [isProcessing, setIsProcessing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSuccess, setShowSuccess] = useState(false);
  const [lastInvoice, setLastInvoice] = useState<string>("");

  // جلب المنتجات الحقيقية من قاعدة البيانات
  const products = trpc.products.list.useQuery({ limit: 200, offset: 0 });
  const searchResults = trpc.products.search.useQuery(
    { query: searchQuery, limit: 50 },
    { enabled: searchQuery.length > 1 }
  );

  // إنشاء الفاتورة
  const createInvoice = trpc.invoices.create.useMutation();

  // المنتجات المعروضة (بحث أو كل المنتجات)
  const displayedProducts = useMemo(() => {
    const source = searchQuery.length > 1 ? searchResults.data : products.data;
    return (source as any[]) || [];
  }, [searchQuery, searchResults.data, products.data]);

  // حساب الإجماليات
  const subtotal = cartItems.reduce((sum, item) => sum + item.total, 0);
  const taxRate = 0.15;
  const taxAmount = Math.round(subtotal * taxRate * 100) / 100;
  const total = subtotal + taxAmount;

  // إضافة منتج للسلة
  const addToCart = (product: any) => {
    const existing = cartItems.find((item) => item.productId === product.id);
    const currentQty = existing ? existing.quantity : 0;
    const available = parseInt(product.quantityOnHand || "0");

    if (currentQty >= available) {
      toast.error(`لا يوجد مخزون كافٍ (المتاح: ${available})`);
      return;
    }

    if (existing) {
      setCartItems(
        cartItems.map((item) =>
          item.productId === product.id
            ? {
                ...item,
                quantity: item.quantity + 1,
                total: (item.quantity + 1) * item.unitPrice,
              }
            : item
        )
      );
    } else {
      const price = parseFloat(product.salePrice || "0");
      setCartItems([
        ...cartItems,
        {
          productId: product.id,
          productName: product.name,
          sku: product.sku || "",
          quantity: 1,
          unitPrice: price,
          maxStock: available,
          total: price,
        },
      ]);
    }
  };

  // تحديث الكمية
  const updateQuantity = (productId: number, delta: number) => {
    setCartItems(
      cartItems
        .map((item) => {
          if (item.productId !== productId) return item;
          const newQty = item.quantity + delta;
          if (newQty <= 0) return null;
          if (newQty > item.maxStock) {
            toast.error("لا يوجد مخزون كافٍ");
            return item;
          }
          return { ...item, quantity: newQty, total: newQty * item.unitPrice };
        })
        .filter(Boolean) as CartItem[]
    );
  };

  // حذف من السلة
  const removeFromCart = (productId: number) => {
    setCartItems(cartItems.filter((item) => item.productId !== productId));
  };

  // تنظيف السلة
  const clearCart = () => {
    setCartItems([]);
    setShowSuccess(false);
  };

  // إتمام البيع
  const completeSale = async () => {
    if (cartItems.length === 0) {
      toast.error("السلة فارغة");
      return;
    }

    setIsProcessing(true);
    try {
      const result = await createInvoice.mutateAsync({
        customerId: 1, // عميل نقدي افتراضي
        sourceType: "POS",
        items: cartItems.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
        taxPercent: 15,
        paymentMethod,
      });

      setLastInvoice(result.data.invoiceNumber);
      setShowSuccess(true);
      setCartItems([]);
      products.refetch();
      toast.success(`تم إنشاء الفاتورة: ${result.data.invoiceNumber}`);
    } catch (error: any) {
      toast.error(error.message || "حدث خطأ أثناء إنشاء الفاتورة");
    } finally {
      setIsProcessing(false);
    }
  };

  // طباعة الفاتورة (يفتح نافذة الطباعة)
  const printReceipt = () => {
    window.print();
    toast.success("جاري الطباعة...");
  };

  // عرض رسالة النجاح
  if (showSuccess) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="w-full max-w-md text-center">
          <CardContent className="pt-8 pb-8 space-y-4">
            <CheckCircle2 className="h-16 w-16 text-green-600 mx-auto" />
            <h2 className="text-2xl font-bold text-green-700">تم البيع بنجاح!</h2>
            <p className="text-muted-foreground">
              رقم الفاتورة: <span className="font-bold">{lastInvoice}</span>
            </p>
            <p className="text-lg font-bold">
              الإجمالي: {total.toLocaleString()} ر.س
            </p>
            <div className="flex gap-3 justify-center pt-4">
              <Button onClick={printReceipt} variant="outline">
                <Printer className="h-4 w-4 ml-2" />
                طباعة الإيصال
              </Button>
              <Button onClick={clearCart}>
                <RotateCcw className="h-4 w-4 ml-2" />
                بيع جديد
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-4rem)] flex gap-4">
      {/* قسم المنتجات - الجانب الأيمن */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* شريط البحث */}
        <div className="mb-4">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="ابحث بالاسم أو رقم المنتج..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pr-10 h-12 text-base"
              autoFocus
            />
          </div>
        </div>

        {/* شبكة المنتجات */}
        <div className="flex-1 overflow-y-auto">
          {products.isLoading ? (
            <div className="flex items-center justify-center h-40">
              <p className="text-muted-foreground">جاري تحميل المنتجات...</p>
            </div>
          ) : displayedProducts.length === 0 ? (
            <div className="flex items-center justify-center h-40">
              <p className="text-muted-foreground">
                {searchQuery ? "لا توجد نتائج" : "لا توجد منتجات - أضف منتجات أولاً"}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
              {displayedProducts.map((product: any) => {
                const available = parseInt(product.quantityOnHand || "0");
                const inCart = cartItems.find((i) => i.productId === product.id);
                const isOutOfStock = available <= 0;

                return (
                  <button
                    key={product.id}
                    onClick={() => !isOutOfStock && addToCart(product)}
                    disabled={isOutOfStock}
                    className={`text-right border rounded-xl p-4 transition-all ${
                      isOutOfStock
                        ? "opacity-50 cursor-not-allowed bg-gray-50"
                        : "hover:shadow-md hover:border-primary/50 active:scale-[0.97] cursor-pointer"
                    } ${inCart ? "border-primary bg-primary/5" : ""}`}
                  >
                    <div className="space-y-2">
                      <h3 className="font-semibold text-sm leading-tight line-clamp-2">
                        {product.name}
                      </h3>
                      <p className="text-xs text-muted-foreground">{product.sku}</p>
                      <p className="text-lg font-bold text-primary">
                        {parseFloat(product.salePrice || "0").toLocaleString()} ر.س
                      </p>
                      <div className="flex items-center justify-between">
                        <Badge
                          variant={isOutOfStock ? "destructive" : "secondary"}
                          className="text-[10px]"
                        >
                          {isOutOfStock ? "نفد" : `متاح: ${available}`}
                        </Badge>
                        {inCart && (
                          <Badge className="bg-primary text-[10px]">
                            في السلة: {inCart.quantity}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* قسم السلة - الجانب الأيسر */}
      <div className="w-[380px] flex flex-col border-r pr-4">
        <Card className="flex-1 flex flex-col">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShoppingCart className="h-5 w-5" />
                <span>السلة ({cartItems.length})</span>
              </div>
              {cartItems.length > 0 && (
                <Button variant="ghost" size="sm" onClick={clearCart}>
                  <RotateCcw className="h-4 w-4" />
                </Button>
              )}
            </CardTitle>
          </CardHeader>

          <CardContent className="flex-1 flex flex-col overflow-hidden">
            {/* عناصر السلة */}
            <div className="flex-1 overflow-y-auto space-y-2 mb-4">
              {cartItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <ShoppingCart className="h-12 w-12 mb-3 opacity-30" />
                  <p className="text-sm">السلة فارغة</p>
                  <p className="text-xs mt-1">اضغط على المنتج لإضافته</p>
                </div>
              ) : (
                cartItems.map((item) => (
                  <div
                    key={item.productId}
                    className="flex items-center gap-3 p-3 rounded-lg border bg-card"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {item.productName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {item.unitPrice.toLocaleString()} ر.س × {item.quantity}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => updateQuantity(item.productId, -1)}
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <span className="w-8 text-center text-sm font-bold">
                        {item.quantity}
                      </span>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => updateQuantity(item.productId, 1)}
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                    <div className="text-left min-w-[70px]">
                      <p className="font-bold text-sm">
                        {item.total.toLocaleString()}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => removeFromCart(item.productId)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>

            {/* الإجماليات والدفع */}
            {cartItems.length > 0 && (
              <div className="border-t pt-4 space-y-3">
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">المجموع الفرعي</span>
                    <span>{subtotal.toLocaleString()} ر.س</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">الضريبة (15%)</span>
                    <span>{taxAmount.toLocaleString()} ر.س</span>
                  </div>
                  <div className="flex justify-between text-lg font-bold pt-2 border-t">
                    <span>الإجمالي</span>
                    <span className="text-primary">
                      {total.toLocaleString()} ر.س
                    </span>
                  </div>
                </div>

                {/* طريقة الدفع */}
                <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                  <SelectTrigger>
                    <SelectValue placeholder="طريقة الدفع" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CASH">
                      <div className="flex items-center gap-2">
                        <Banknote className="h-4 w-4" />
                        نقداً
                      </div>
                    </SelectItem>
                    <SelectItem value="CARD">
                      <div className="flex items-center gap-2">
                        <CreditCard className="h-4 w-4" />
                        بطاقة
                      </div>
                    </SelectItem>
                    <SelectItem value="TRANSFER">
                      <div className="flex items-center gap-2">
                        <CreditCard className="h-4 w-4" />
                        تحويل بنكي
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>

                {/* زر إتمام البيع */}
                <Button
                  onClick={completeSale}
                  disabled={isProcessing}
                  className="w-full h-12 text-base font-bold"
                  size="lg"
                >
                  {isProcessing ? (
                    "جاري المعالجة..."
                  ) : (
                    <>
                      <CheckCircle2 className="h-5 w-5 ml-2" />
                      إتمام البيع - {total.toLocaleString()} ر.س
                    </>
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
