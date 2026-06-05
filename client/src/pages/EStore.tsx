import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ShoppingCart, Search, Filter, Heart, Star } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  image?: string;
}

export default function EStore() {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("popular");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [showCart, setShowCart] = useState(false);

  const products = trpc.products.list.useQuery({ limit: 100, offset: 0 });
  const filteredProducts = (products.data || []).filter(p =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  function addToCart(product: any) {
    const existingItem = cart.find(item => item.id === product.id);
    if (existingItem) {
      setCart(cart.map(item =>
        item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
      ));
    } else {
      setCart([...cart, {
        id: product.id,
        name: product.name,
        price: parseFloat(product.salePrice),
        quantity: 1,
      }]);
    }
    toast.success(`تم إضافة ${product.name} إلى السلة`);
  }

  function removeFromCart(productId: string) {
    setCart(cart.filter(item => item.id !== productId));
  }

  function updateQuantity(productId: string, quantity: number) {
    if (quantity <= 0) {
      removeFromCart(productId);
    } else {
      setCart(cart.map(item =>
        item.id === productId ? { ...item, quantity } : item
      ));
    }
  }

  const cartTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-800 text-white p-8 rounded-lg">
        <h1 className="text-4xl font-bold mb-2">متجرنا الإلكتروني</h1>
        <p className="text-blue-100">اكتشف أفضل المنتجات بأسعار تنافسية</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-3 space-y-6">
          {/* Search and Filter */}
          <Card>
            <CardContent className="pt-6">
              <div className="space-y-4">
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="ابحث عن المنتجات..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                  <Button variant="outline" size="icon">
                    <Filter className="h-4 w-4" />
                  </Button>
                </div>

                <div className="flex gap-2">
                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="popular">الأكثر شيوعاً</SelectItem>
                      <SelectItem value="price-low">السعر: الأقل أولاً</SelectItem>
                      <SelectItem value="price-high">السعر: الأعلى أولاً</SelectItem>
                      <SelectItem value="newest">الأحدث</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Products Grid */}
          {products.isLoading ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">جاري تحميل المنتجات...</p>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">لا توجد منتجات متطابقة</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredProducts.map((product: any) => (
                <Card key={product.id} className="overflow-hidden hover:shadow-lg transition-shadow">
                  <div className="bg-muted h-40 flex items-center justify-center relative">
                    <div className="text-center">
                      <p className="text-muted-foreground text-sm">{product.name}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute top-2 right-2"
                      onClick={() => toast.info("تم إضافة إلى المفضلة")}
                    >
                      <Heart className="h-4 w-4" />
                    </Button>
                  </div>
                  <CardContent className="pt-4">
                    <div className="space-y-3">
                      <div>
                        <h3 className="font-semibold text-right">{product.name}</h3>
                        <p className="text-sm text-muted-foreground text-right">{product.description}</p>
                      </div>

                      <div className="flex items-center justify-between">
                        <div className="flex gap-1">
                          {[...Array(5)].map((_, i) => (
                            <Star key={i} className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                          ))}
                        </div>
                        <Badge variant="secondary">متوفر</Badge>
                      </div>

                      <div className="flex items-center justify-between">
                        <div className="text-right">
                          <p className="text-2xl font-bold text-primary">
                            {parseFloat(product.salePrice).toLocaleString()} ر.س
                          </p>
                          {product.costPrice && (
                            <p className="text-xs text-muted-foreground line-through">
                              {parseFloat(product.costPrice).toLocaleString()} ر.س
                            </p>
                          )}
                        </div>
                      </div>

                      <Button
                        onClick={() => addToCart(product)}
                        className="w-full"
                      >
                        <ShoppingCart className="h-4 w-4 ml-2" />
                        أضف إلى السلة
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Sidebar - Shopping Cart */}
        <div className="space-y-4">
          <Card className="sticky top-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShoppingCart className="h-5 w-5" />
                سلة التسوق
              </CardTitle>
              <CardDescription>{cartCount} عنصر</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {cart.length === 0 ? (
                <p className="text-center text-muted-foreground text-sm py-4">السلة فارغة</p>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {cart.map(item => (
                    <div key={item.id} className="flex justify-between items-start gap-2 p-2 border rounded">
                      <div className="flex-1 text-right">
                        <p className="text-sm font-medium">{item.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {item.price.toLocaleString()} ر.س
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => updateQuantity(item.id, item.quantity - 1)}
                        >
                          −
                        </Button>
                        <span className="w-6 text-center text-sm">{item.quantity}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => updateQuantity(item.id, item.quantity + 1)}
                        >
                          +
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="border-t pt-3 space-y-2">
                <div className="flex justify-between text-sm">
                  <span>المجموع:</span>
                  <span className="font-bold">{cartTotal.toLocaleString()} ر.س</span>
                </div>
                <Button className="w-full" disabled={cart.length === 0}>
                  متابعة الدفع
                </Button>
                <Button variant="outline" className="w-full" onClick={() => setCart([])}>
                  مسح السلة
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
