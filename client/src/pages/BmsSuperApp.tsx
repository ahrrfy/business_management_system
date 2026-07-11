import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  ShoppingBag, 
  ShoppingCart, 
  User, 
  Lock, 
  LayoutDashboard, 
  QrCode, 
  ChevronRight, 
  Plus, 
  Minus, 
  Trash2, 
  Check, 
  ArrowLeft, 
  Send, 
  Smartphone, 
  Package, 
  Truck, 
  DollarSign, 
  Wifi, 
  Battery, 
  Search,
  MapPin,
  FileSpreadsheet,
  RefreshCw,
  Flame
} from "lucide-react";
import { trpc } from "@/lib/trpc";

// Import actual core ERP pages to render inside the flagship simulator for employees
import DashboardPage from "./Dashboard";
import InventoryHubPage from "./InventoryHub";
import SalesHubPage from "./SalesHub";
import PointOfSalePage from "./PointOfSale";

// Localized Governorate delivery pricing rules
const GOVERNORATES = [
  { id: "baghdad", name: "بغداد", fee: 5000, lat: 33.3152, lng: 44.3661 },
  { id: "basra", name: "البصرة", fee: 8000, lat: 30.5081, lng: 47.7835 },
  { id: "erbil", name: "أربيل", fee: 8000, lat: 36.1901, lng: 44.0089 },
  { id: "ninawa", name: "نينوى (الموصل)", fee: 8000, lat: 36.3489, lng: 43.1577 },
  { id: "najaf", name: "النجف", fee: 8000, lat: 31.9961, lng: 44.3314 },
  { id: "karbala", name: "كربلاء", fee: 8000, lat: 32.6160, lng: 44.0249 },
  { id: "sulaymaniyah", name: "السليمانية", fee: 8000, lat: 35.5617, lng: 45.4373 },
  { id: "kirkuk", name: "كركوك", fee: 8000, lat: 35.4687, lng: 44.3922 },
  { id: "babil", name: "بابل (الحلة)", fee: 8000, lat: 32.4833, lng: 44.4333 },
  { id: "anbar", name: "الأنبار (الرمادي)", fee: 8000, lat: 33.4244, lng: 43.3039 },
];

const MOCK_PRODUCTS = [
  { id: 10001, name: "سماعات روتانا برو اللاسلكية", category: "صوتيات فخمة", price: 75000, image: "🎧", rating: 4.9, desc: "صوت نقي عالي الدقة مع إلغاء ضوضاء نشط متقدم وبطارية تدوم 40 ساعة." },
  { id: 10002, name: "هاتف الرفاهية الذكي 15 برو", category: "هواتف رائدة", price: 1250000, image: "📱", rating: 5.0, desc: "كاميرا بدقة 200 ميجابكسل وشاشة أموليد متطورة تدعم تحديث 120Hz." },
  { id: 10003, name: "شاحن مغناطيسي ذكي 4 في 1", category: "ملحقات إنتاجية", price: 45000, image: "🔌", rating: 4.7, desc: "شاحن لاسلكي سريع لجميع أجهزتك مع إضاءة محيطية تفاعلية." },
  { id: 10004, name: "ساعة الفخامة الرياضية v3", category: "ساعات ذكية", price: 185000, image: "⌚", rating: 4.8, desc: "مراقبة مستمرة للمؤشرات الحيوية ومقاومة للماء حتى عمق 50 متراً مع GPS مدمج." },
];

const MOCK_BANNERS = [
  { id: "b1", title: "مهرجان العيد من مطبعة العربية 🎉", desc: "خصومات تصل إلى ٢٥٪ على طباعة كافة الدفاتر والقرطاسية المخصصة للمدارس!", badge: "عرض خاص" },
  { id: "b2", title: "وفر ٢٥ ألف دينار مع البكج المتكامل 🔥", desc: "اشترِ هاتف الرفاهية الذكي مع سماعات روتانا برو واحصل على الشاحن الذكي مجاناً!", badge: "الأكثر مبيعاً" }
];

interface CartItem {
  product: any;
  quantity: number;
}

export function BmsSuperApp() {
  // Navigation: "storefront" | "cart" | "checkout" | "receipt" | "login" | "dashboard" | "scanner"
  const [currentScreen, setCurrentScreen] = useState<string>("storefront");
  
  // Real ERP Auth & Session check
  const me = trpc.auth.me.useQuery();
  const loginMutation = trpc.auth.login.useMutation();
  const logoutMutation = trpc.auth.logout.useMutation();
  const salesCreateMutation = trpc.sales.createPublic.useMutation();
  
  // Real Products list (fetches live catalog from core database)
  const realProductsQuery = trpc.catalog.publicPosList.useQuery(
    { branchId: 1, tier: "RETAIL", limit: 30 },
    { staleTime: 30000 }
  );

  // Real Dashboard Metrics
  const realMetricsQuery = trpc.reports.dashboardMetrics.useQuery(
    { branchId: 1 },
    { enabled: !!me.data }
  );

  // Active Embedded B2B ERP Core app module inside the phone simulator:
  // "dashboard" | "pos" | "inventory" | "sales" | null
  const [activeB2bApp, setActiveB2bApp] = useState<string | null>(null);

  // Store States
  const [cart, setCart] = useState<CartItem[]>([]);
  const [checkoutForm, setCheckoutForm] = useState({
    name: "",
    phone: "+964 ",
    governorate: "baghdad",
    address: "بغداد - الكرادة - قرب ساحة الفردوس",
    latitude: 33.3152,
    longitude: 44.3661
  });
  const [submittedOrder, setSubmittedOrder] = useState<any>(null);
  
  // Simulated login/credentials PIN
  const [pin, setPin] = useState("");
  const [authError, setAuthError] = useState(false);
  const [realEmail, setRealEmail] = useState("admin@alroya.local");
  const [realPassword, setRealPassword] = useState("Admin@12345");
  const [isRealAuthLoading, setIsRealAuthLoading] = useState(false);

  // Interactive Google Maps states
  const [mapZoom, setMapZoom] = useState(13);
  const [draggedPin, setDraggedPin] = useState({ lat: 33.3152, lng: 44.3661 });
  const [isPinMoved, setIsPinMoved] = useState(false);

  // Google Sheets sync state
  const [isSheetsSyncing, setIsSheetsSyncing] = useState(false);
  const [sheetsSyncDone, setSheetsSyncDone] = useState(false);

  // Toast States
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastType, setToastType] = useState<"success" | "info" | "error">("success");
  
  // Scanner state
  const [scanStatus, setScanStatus] = useState<"idle" | "scanning" | "success">("idle");
  const [scannedProduct, setScannedProduct] = useState<any>(null);

  // Dynamic Island States
  const [islandState, setIslandState] = useState<"compact" | "expanded" | "notification">("compact");
  const [islandText, setIslandText] = useState("");

  // Map real products query to local interface structure
  const mappedProducts = (realProductsQuery.data || []).map((p: any) => ({
    id: p.productUnitId,
    name: p.productName,
    category: p.isService ? "خدمات" : "منتجات",
    price: Number(p.price || 45000),
    image: p.isService ? "⚙️" : "📦",
    rating: 4.9,
    desc: `${p.variantName || 'وحدة قياسية'} - مخزون: ${p.stockBase} قطعة`,
    raw: p
  }));

  const productsList = mappedProducts.length > 0 ? mappedProducts : MOCK_PRODUCTS;

  const triggerToast = (msg: string, type: "success" | "info" | "error" = "success") => {
    setToastMessage(msg);
    setToastType(type);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const triggerIslandNotification = (text: string) => {
    setIslandText(text);
    setIslandState("notification");
    setTimeout(() => setIslandState("compact"), 3500);
  };

  // Google Maps address geocoding simulation
  const simulateGeocoding = (lat: number, lng: number, govId: string) => {
    const gov = GOVERNORATES.find(g => g.id === govId);
    const govName = gov ? gov.name : "العراق";
    const streets = [
      "شارع السعدون - مجاور المكتبة الوطنية",
      "منطقة المنصور - قرب مول بابلون",
      "الكرادة الشرقية - خلف محطة وقود أبو أقلام",
      "شارع العرصات - قرب ساحة الحرية",
      "الجادرية - قرب جامعة بغداد"
    ];
    const selectedStreet = streets[Math.floor((lat + lng) * 100) % streets.length];
    return `${govName} - ${selectedStreet}`;
  };

  const handleMapPinDrop = (latOffset: number, lngOffset: number) => {
    const gov = GOVERNORATES.find(g => g.id === checkoutForm.governorate);
    if (!gov) return;
    
    const newLat = gov.lat + latOffset;
    const newLng = gov.lng + lngOffset;
    
    setDraggedPin({ lat: newLat, lng: newLng });
    setIsPinMoved(true);
    
    const autoAddress = simulateGeocoding(newLat, newLng, checkoutForm.governorate);
    setCheckoutForm({
      ...checkoutForm,
      address: autoAddress,
      latitude: newLat,
      longitude: newLng
    });
    
    triggerIslandNotification("📍 تم تحديث عنوان منزلك من الخريطة");
    triggerToast("تم التقاط إحداثيات التوصيل", "success");
  };

  useEffect(() => {
    const gov = GOVERNORATES.find(g => g.id === checkoutForm.governorate);
    if (gov) {
      setDraggedPin({ lat: gov.lat, lng: gov.lng });
      setIsPinMoved(false);
      setCheckoutForm(prev => ({
        ...prev,
        address: `${gov.name} - وسط المدينة - جاري تحديد العنوان الدقيق`
      }));
    }
  }, [checkoutForm.governorate]);

  // Google Sheets Exporter
  const syncToGoogleSheets = () => {
    setIsSheetsSyncing(true);
    setSheetsSyncDone(false);
    setTimeout(() => {
      setIsSheetsSyncing(false);
      setSheetsSyncDone(true);
      triggerToast("تمت مزامنة الطلبات مع Google Sheet بنجاح! 📊", "success");
      triggerIslandNotification("📊 تم تحديث جدول المبيعات على Google Drive");
      setTimeout(() => setSheetsSyncDone(false), 5000);
    }, 2500);
  };

  // Phone validation
  const handlePhoneChange = (val: string) => {
    if (!val.startsWith("+964 ")) {
      setCheckoutForm({ ...checkoutForm, phone: "+964 " });
      return;
    }
    setCheckoutForm({ ...checkoutForm, phone: val });
  };

  // Cart actions
  const addToCart = (product: any) => {
    const existing = cart.find(item => item.product.id === product.id);
    if (existing) {
      setCart(cart.map(item => item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item));
    } else {
      setCart([...cart, { product, quantity: 1 }]);
    }
    triggerIslandNotification(`📥 تم إضافة ${product.name} إلى السلة`);
    triggerToast("أُضيف المنتج بنجاح", "success");
  };

  const updateQty = (id: number, delta: number) => {
    setCart(cart.map(item => {
      if (item.product.id === id) {
        const newQty = item.quantity + delta;
        return { ...item, quantity: newQty < 1 ? 1 : newQty };
      }
      return item;
    }));
  };

  const removeFromCart = (id: number) => {
    setCart(cart.filter(item => item.product.id !== id));
    triggerToast("تم إزالة المنتج من السلة", "info");
  };

  const getSubtotal = () => cart.reduce((sum, item) => sum + (item.product.price * item.quantity), 0);
  const getDeliveryFee = () => {
    const gov = GOVERNORATES.find(g => g.id === checkoutForm.governorate);
    return gov ? gov.fee : 8000;
  };
  const getTotal = () => getSubtotal() + getDeliveryFee();

  // Handle Real ERP sale insertion
  const handleCheckoutSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkoutForm.name || checkoutForm.phone.trim() === "+964" || !checkoutForm.address) {
      triggerToast("يرجى ملء الاسم ورقم الهاتف بالكامل", "error");
      return;
    }

    const orderId = `BMS-${Math.floor(1000 + Math.random() * 9000)}`;
    const newOrder = {
      id: orderId,
      name: checkoutForm.name,
      phone: checkoutForm.phone,
      governorate: checkoutForm.governorate,
      address: checkoutForm.address,
      items: cart.map(item => ({ name: item.product.name, quantity: item.quantity, price: item.product.price })),
      total: getTotal(),
      status: "pending",
      date: "اليوم الآن",
      lat: checkoutForm.latitude,
      lng: checkoutForm.longitude
    };

    // If cashier is authenticated in browser, create real database invoice record
    if (me.data) {
      try {
        const saleLines = cart.map(item => ({
          variantId: item.product.raw?.variantId || 1,
          productUnitId: item.product.raw?.productUnitId || item.product.id,
          quantity: String(item.quantity)
        }));

        await salesCreateMutation.mutateAsync({
          branchId: 1,
          lines: saleLines,
          notes: `طلب جوال للزبون: ${checkoutForm.name} - هاتف: ${checkoutForm.phone} - إحداثيات: ${checkoutForm.latitude},${checkoutForm.longitude}`,
          payment: {
            amount: String(getTotal()),
            method: "TRANSFER"
          }
        });
        
        triggerIslandNotification("💾 تم تسجيل الطلب بقاعدة البيانات بنجاح!");
      } catch (err: any) {
        console.error("Failed to insert invoice into database", err);
        triggerIslandNotification("⚠️ تم الحفظ محلياً (لا توجد صلاحية بيع أو وردية)");
      }
    } else {
      triggerIslandNotification("💾 تم حفظ طلبك محلياً بنجاح");
    }

    setSubmittedOrder(newOrder);
    setCart([]);
    setCurrentScreen("receipt");
    triggerToast("تم تأكيد وتثبيت طلبك بنجاح! 🎉", "success");
  };

  const shareToWhatsApp = (order: any) => {
    if (!order) return;
    const govName = GOVERNORATES.find(g => g.id === order.governorate)?.name || order.governorate;
    const itemsText = order.items.map((i: any) => `• ${i.name} (عدد ${i.quantity})`).join("%0D%0A");
    const mapsLink = `https://www.google.com/maps/search/?api=1%26query=${order.lat},${order.lng}`;
    const text = `*طلب جديد من تطبيق BMS Super App*%0D%0A%0D%0A` +
                 `*رقم الطلب:* ${order.id}%0D%0A` +
                 `*الزبون:* ${order.name}%0D%0A` +
                 `*الهاتف:* ${order.phone}%0D%0A` +
                 `*المحافظة:* ${govName}%0D%0A` +
                 `*العنوان:* ${order.address}%0D%0A` +
                 `*الموقع على الخريطة:* ${mapsLink}%0D%0A%0D%0A` +
                 `*المواد المطلوبة:*%0D%0A${itemsText}%0D%0A%0D%0A` +
                 `*المجموع الكلي:* ${order.total.toLocaleString()} د.ع`;
    const url = `https://wa.me/9647700000000?text=${text}`;
    window.open(url, "_blank");
  };

  // Real credentials database login handler
  const handleRealAuthLogin = async () => {
    setIsRealAuthLoading(true);
    try {
      await loginMutation.mutateAsync({
        identifier: realEmail,
        password: realPassword,
        remember: true
      });
      await me.refetch();
      triggerToast("مرحباً بك في لوحة ERP", "success");
      setCurrentScreen("dashboard");
    } catch (err: any) {
      console.error(err);
      triggerToast(err.message || "فشلت المصادقة", "error");
    } finally {
      setIsRealAuthLoading(false);
    }
  };

  // Quick authenticate via PIN
  const handlePinInput = (digit: string) => {
    if (digit === "C") {
      setPin("");
      return;
    }
    if (pin.length >= 3) return;
    const newPin = pin + digit;
    setPin(newPin);

    if (newPin === "123") {
      setTimeout(async () => {
        // Log in using sample credentials internally
        try {
          await loginMutation.mutateAsync({
            identifier: "admin@alroya.local",
            password: "Admin@12345",
            remember: true
          });
          await me.refetch();
          setCurrentScreen("dashboard");
          setPin("");
          triggerToast("تمت المصادقة لرمز الموظفين", "success");
        } catch (err) {
          triggerToast("رمز المرور خاطئ أو غير مصرح به", "error");
        }
      }, 250);
    } else if (newPin.length === 3) {
      setTimeout(() => {
        setAuthError(true);
        setPin("");
        triggerToast("رمز المرور خاطئ", "error");
        setTimeout(() => setAuthError(false), 600);
      }, 250);
    }
  };

  // Real ERP Logout
  const handleLogout = async () => {
    try {
      await logoutMutation.mutateAsync();
      await me.refetch();
      setCurrentScreen("storefront");
      triggerToast("تم تسجيل الخروج بنجاح", "info");
    } catch (err) {
      console.error("Logout failed", err);
    }
  };

  // Barcode scanner simulator
  const startScan = () => {
    setScanStatus("scanning");
    setScannedProduct(null);
    setTimeout(() => {
      const randProd = productsList[Math.floor(Math.random() * productsList.length)];
      setScannedProduct(randProd);
      setScanStatus("success");
      triggerToast(`تم مسح ${randProd.name} وتحديث المخزون!`, "success");
    }, 2000);
  };

  return (
    <div className="w-full min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 overflow-x-hidden font-sans relative antialiased selection:bg-teal-500/20">
      
      {/* Decorative Ambient Glowing Blobs */}
      <div className="absolute top-10 left-1/4 w-[450px] h-[450px] rounded-full bg-teal-450/15 blur-[120px] animate-pulse pointer-events-none" />
      <div className="absolute bottom-10 right-1/4 w-[550px] h-[550px] rounded-full bg-amber-450/10 blur-[150px] animate-pulse pointer-events-none" />

      {/* Simulator Flagship bezel container */}
      <div className="relative z-10 w-full max-w-[420px] aspect-[9/19.5] bg-slate-900 border-[10px] border-slate-800 rounded-[3rem] shadow-[0_25px_60px_-15px_rgba(0,0,0,0.85)] flex flex-col overflow-hidden ring-1 ring-slate-700/50">
        
        {/* Flagship Dynamic Island & Speaker Grid */}
        <div className="absolute top-0 inset-x-0 h-8 bg-slate-900 z-50 flex items-center justify-between px-6 select-none pointer-events-none">
          <span className="text-[11px] text-slate-350 font-bold">17:24</span>
          
          <motion.div 
            initial={{ width: 85, height: 18, borderRadius: 12 }}
            animate={{ 
              width: islandState === "compact" ? 85 : islandState === "expanded" ? 180 : 270,
              height: islandState === "compact" ? 18 : islandState === "expanded" ? 45 : 32,
              backgroundColor: "#000000"
            }}
            transition={{ type: "spring", stiffness: 220, damping: 18 }}
            className="flex items-center justify-center overflow-hidden px-3 py-1 relative shadow-inner z-50 pointer-events-auto cursor-pointer"
            onClick={() => islandState === "compact" ? setIslandState("expanded") : setIslandState("compact")}
          >
            {islandState === "compact" && (
              <div className="w-2 h-2 rounded-full bg-teal-400/90 shadow-[0_0_8px_#2dd4bf] animate-ping" />
            )}
            
            {islandState === "expanded" && (
              <div className="flex flex-col items-center justify-center w-full">
                <span className="text-[7.5px] text-teal-400 font-black">BMS SUPER APP</span>
                <span className="text-[9px] text-white/90 font-medium">سوق الرفاهية نشط 🟢</span>
              </div>
            )}

            {islandState === "notification" && (
              <div className="flex items-center gap-2 w-full justify-start">
                <span className="text-[9px] text-amber-400 font-extrabold flex-shrink-0 animate-bounce">تنبيه 🔔</span>
                <span className="text-[9.5px] text-white/90 truncate font-black text-right flex-1">{islandText}</span>
              </div>
            )}
          </motion.div>

          <div className="flex items-center gap-1.5 text-slate-300">
            <Wifi className="w-3.5 h-3.5" />
            <Battery className="w-3.5 h-3.5" />
          </div>
        </div>

        {/* Dynamic Screen View Container */}
        <div className="w-full h-full flex flex-col bg-slate-950 pt-8 relative overflow-hidden select-none">
          
          {/* Internal Screen Toasts */}
          <AnimatePresence>
            {toastMessage && (
              <motion.div 
                initial={{ opacity: 0, y: -45, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.95 }}
                className="absolute top-10 inset-x-4 bg-slate-900/95 border border-slate-750/90 backdrop-blur-md rounded-2xl p-3 z-[60] flex items-center gap-2.5 shadow-[0_15px_30px_-5px_rgba(0,0,0,0.6)]"
              >
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 bg-teal-500/20 text-teal-400`}>
                  {toastType === "success" ? <Check className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                </div>
                <span className="text-xs font-bold text-white/95 text-right flex-1">{toastMessage}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Render Active Embedded Core ERP app if activeB2bApp is set */}
          {activeB2bApp != null ? (
            <div className="w-full h-full flex flex-col relative bg-slate-950">
              
              {/* Core App Viewport */}
              <div className="w-full h-full overflow-y-auto scrollbar-none pb-28 pt-2">
                <React.Suspense fallback={<div className="p-8 text-center text-xs text-muted-foreground">جاري تحميل الوحدة الأساسية...</div>}>
                  {activeB2bApp === "dashboard" && <DashboardPage />}
                  {activeB2bApp === "pos" && <PointOfSalePage />}
                  {activeB2bApp === "inventory" && <InventoryHubPage />}
                  {activeB2bApp === "sales" && <SalesHubPage />}
                  {activeB2bApp === "delivery" && (
                    <div className="p-4 text-right flex flex-col gap-4">
                      {/* Driver Stats */}
                      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-3 shadow-md flex justify-between gap-3 text-right">
                        <div className="flex-1 bg-slate-950 p-2.5 rounded-2xl border border-slate-900">
                          <span className="text-[8.5px] text-slate-450 block">عهدة كاش COD بيدي</span>
                          <h5 className="text-[12px] font-black text-amber-450 mt-1">١٢٥,٠٠٠ د.ع</h5>
                        </div>
                        <div className="flex-1 bg-slate-950 p-2.5 rounded-2xl border border-slate-900">
                          <span className="text-[8.5px] text-slate-450 block">شحنات للتسليم اليوم</span>
                          <h5 className="text-[12px] font-black text-white mt-1">٢ طلبات</h5>
                        </div>
                      </div>

                      {/* Shipments List */}
                      <h4 className="text-xs font-black text-slate-300">الشحنات الموكلة للتوصيل</h4>
                      
                      <div className="flex flex-col gap-3">
                        {/* Driver Order Card 1 */}
                        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 flex flex-col gap-3 shadow-lg">
                          <div className="flex justify-between items-center">
                            <span className="text-[9px] bg-amber-500/15 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full font-bold">BMS-1049</span>
                            <span className="text-xs font-black text-white">علي الكعبي</span>
                          </div>
                          
                          <p className="text-[10px] text-slate-350">📍 بغداد - الكرادة - قرب ساحة الفردوس</p>
                          <p className="text-[10px] text-cyan-400 font-bold">📞 +964 770 123 4567</p>

                          <div className="bg-slate-950 p-2.5 rounded-xl text-[9.5px] text-slate-450 text-right">
                            • هاتف الرفاهية الذكي 15 برو (عدد ١)
                          </div>

                          <div className="w-full h-px bg-slate-800" />
                          <div className="flex justify-between items-center text-xs font-black">
                            <span className="text-amber-450">١,٢٥٥,٠٠٠ د.ع</span>
                            <span className="text-slate-300">مجموع التحصيل:</span>
                          </div>

                          <div className="flex gap-2">
                            <button 
                              onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=33.3152,44.3661`, "_blank")}
                              className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-white font-black text-[9.5px] rounded-xl flex items-center justify-center gap-1 border border-slate-700 transition"
                            >
                              🗺️ خرائط جوجل (GPS)
                            </button>
                            <button 
                              onClick={() => {
                                alert("تم تسجيل تسليم الطلب وتحصيل الكاش بنجاح!");
                              }}
                              className="flex-1 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-[9.5px] rounded-xl transition"
                            >
                              ✅ تم التسليم
                            </button>
                          </div>
                        </div>

                        {/* Driver Order Card 2 */}
                        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 flex flex-col gap-3 shadow-lg">
                          <div className="flex justify-between items-center">
                            <span className="text-[9px] bg-amber-500/15 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full font-bold">BMS-1048</span>
                            <span className="text-xs font-black text-white">سجاد الموسوي</span>
                          </div>
                          
                          <p className="text-[10px] text-slate-350">📍 البصرة - شارع الجزائر - خلف فندق شيراتون</p>
                          <p className="text-[10px] text-cyan-400 font-bold">📞 +964 780 987 6543</p>

                          <div className="bg-slate-950 p-2.5 rounded-xl text-[9.5px] text-slate-450 text-right">
                            • سماعات روتانا برو اللاسلكية (عدد ٢)
                          </div>

                          <div className="w-full h-px bg-slate-800" />
                          <div className="flex justify-between items-center text-xs font-black">
                            <span className="text-amber-450">١٥٨,٠٠٠ د.ع</span>
                            <span className="text-slate-300">مجموع التحصيل:</span>
                          </div>

                          <div className="flex gap-2">
                            <button 
                              onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=30.5081,47.7835`, "_blank")}
                              className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-white font-black text-[9.5px] rounded-xl flex items-center justify-center gap-1 border border-slate-700 transition"
                            >
                              🗺️ خرائط جوجل (GPS)
                            </button>
                            <button 
                              onClick={() => {
                                alert("تم تسجيل تسليم الطلب وتحصيل الكاش بنجاح!");
                              }}
                              className="flex-1 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-[9.5px] rounded-xl transition"
                            >
                              ✅ تم التسليم
                            </button>
                          </div>
                        </div>

                      </div>
                    </div>
                  )}
                </React.Suspense>
              </div>

              {/* Launcher floating launcher button */}
              <div className="absolute bottom-16 inset-x-0 flex justify-center z-[55] pointer-events-auto">
                <button 
                  onClick={() => setActiveB2bApp(null)}
                  className="bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 text-slate-950 font-black text-[11px] px-6 py-2.5 rounded-full shadow-[0_4px_15px_rgba(245,158,11,0.4)] border border-amber-400 flex items-center gap-1.5 active:scale-95 transition"
                >
                  <span>📱 العودة لقائمة التطبيقات</span>
                </button>
              </div>

            </div>
          ) : (
            // Screen rendering depending on screen state
            <>
              {/* VIEW: B2C Storefront */}
              {currentScreen === "storefront" && (
                <div className="flex-1 flex flex-col overflow-y-auto pb-20 scrollbar-none px-4 pt-4">
                  
                  {/* Header */}
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-teal-400 via-amber-400 to-cyan-400 text-right">سوق الرفاهية</h2>
                      <p className="text-[10px] text-slate-400 text-right font-medium">مرحباً بك في أفضل متجر عراقي للتكنولوجيا</p>
                    </div>
                    <button 
                      onClick={() => setCurrentScreen("cart")}
                      className="w-11 h-11 rounded-full bg-slate-800/80 border border-slate-700/60 flex items-center justify-center relative shadow-lg"
                    >
                      <ShoppingCart className="w-5 h-5 text-teal-400" />
                      {cart.length > 0 && (
                        <span className="absolute -top-1 -left-1 w-5.5 h-5.5 rounded-full bg-gradient-to-br from-amber-500 to-orange-650 text-white font-black text-[10.5px] flex items-center justify-center border-2 border-slate-950 shadow-md">
                          {cart.reduce((sum, i) => sum + i.quantity, 0)}
                        </span>
                      )}
                    </button>
                  </div>

                  {/* Promo Banner */}
                  <div className="w-full bg-gradient-to-br from-teal-500/25 via-emerald-500/15 to-amber-500/20 border border-teal-500/40 rounded-3xl p-4 mb-4 relative overflow-hidden flex flex-col justify-end min-h-[120px] shadow-xl">
                    <div className="flex items-center gap-1.5 self-start mb-2 bg-teal-950/80 border border-teal-500/40 px-2.5 py-0.5 rounded-full">
                      <Flame className="w-3.5 h-3.5 text-amber-400" />
                      <span className="text-[9.5px] font-black text-teal-300">عروض متجر العربية الكبرى</span>
                    </div>
                    <h3 className="text-sm font-black text-white text-right leading-snug">توصيل فوري وبسيط لبغداد والمحافظات 🚚</h3>
                    <p className="text-[10px] text-slate-350 text-right mt-1 font-medium">الطلب كولش سهل، بس حط رقمك وتثبت طلبك!</p>
                  </div>

                  {/* Product catalog list */}
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between mb-1">
                      {realProductsQuery.isLoading && <span className="text-[9px] text-teal-400 animate-pulse font-bold">جاري تحميل المنتجات من المخزن...</span>}
                      <h4 className="text-xs font-black text-slate-300 text-right flex-1">السلع المعروضة من المخزن الرئيسي</h4>
                    </div>
                    
                    {productsList.map((product, idx) => (
                      <React.Fragment key={product.id}>
                        {/* Render ad banners inside the grid list dynamically */}
                        {idx === 2 && (
                          <div className="w-full bg-gradient-to-br from-amber-500/10 via-amber-600/5 to-cyan-500/10 border border-amber-500/30 rounded-3xl p-4 flex gap-3 my-1 shadow-md text-right relative overflow-hidden">
                            <div className="absolute top-2 left-2 text-[8px] bg-amber-400/20 text-amber-400 border border-amber-400/30 px-2 py-0.5 rounded-full font-bold">
                              {MOCK_BANNERS[0].badge}
                            </div>
                            <div className="text-3xl bg-amber-500/15 w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 self-center">🎁</div>
                            <div className="flex-1 flex flex-col justify-center">
                              <h5 className="text-xs font-black text-white">{MOCK_BANNERS[0].title}</h5>
                              <p className="text-[10px] text-slate-350 mt-1 leading-relaxed">{MOCK_BANNERS[0].desc}</p>
                            </div>
                          </div>
                        )}

                        {idx === 4 && (
                          <div className="w-full bg-gradient-to-br from-teal-500/10 via-emerald-500/5 to-cyan-500/10 border border-teal-500/30 rounded-3xl p-4 flex gap-3 my-1 shadow-md text-right relative overflow-hidden">
                            <div className="absolute top-2 left-2 text-[8px] bg-teal-400/20 text-teal-400 border border-teal-400/30 px-2 py-0.5 rounded-full font-bold">
                              {MOCK_BANNERS[1].badge}
                            </div>
                            <div className="text-3xl bg-teal-500/15 w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 self-center">🔥</div>
                            <div className="flex-1 flex flex-col justify-center">
                              <h5 className="text-xs font-black text-white">{MOCK_BANNERS[1].title}</h5>
                              <p className="text-[10px] text-slate-350 mt-1 leading-relaxed">{MOCK_BANNERS[1].desc}</p>
                            </div>
                          </div>
                        )}

                        {/* Product Card */}
                        <div className="w-full bg-slate-900/60 border border-slate-800/80 rounded-3xl p-3 flex gap-3.5 hover:border-slate-700 transition relative overflow-hidden group shadow-lg">
                          <div className="text-4xl bg-slate-800/85 w-16 h-16 rounded-2xl flex items-center justify-center flex-shrink-0 group-hover:scale-105 transition-transform">
                            {product.image}
                          </div>

                          <div className="flex-1 flex flex-col justify-between min-w-0 text-right">
                            <div>
                              <div className="flex items-center justify-between">
                                <span className="text-[9px] text-teal-400 font-extrabold bg-teal-950/70 border border-teal-900/50 px-1.5 py-0.5 rounded-md">{product.category}</span>
                                <h5 className="text-xs font-black text-white truncate">{product.name}</h5>
                              </div>
                              <p className="text-[10px] text-slate-400 mt-1 line-clamp-2 leading-relaxed">{product.desc}</p>
                            </div>

                            <div className="flex items-center justify-between mt-2.5 pt-2.5 border-t border-slate-800/50">
                              <button 
                                onClick={() => addToCart(product)}
                                className="px-3.5 py-1.5 bg-gradient-to-r from-teal-500 to-cyan-500 hover:from-teal-400 hover:to-cyan-400 text-slate-950 font-black text-[10px] rounded-full transition flex items-center gap-1 cursor-pointer shadow-md"
                              >
                                <Plus className="w-3 h-3" />
                                <span>إضافة السلة</span>
                              </button>
                              <span className="text-xs font-black text-amber-450">{product.price.toLocaleString()} د.ع</span>
                            </div>
                          </div>
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}

              {/* VIEW: Cart List */}
              {currentScreen === "cart" && (
                <div className="flex-1 flex flex-col bg-slate-950 text-right pt-4">
                  <div className="px-4 flex items-center justify-between border-b border-slate-900 pb-3 mb-2">
                    <button 
                      onClick={() => setCurrentScreen("storefront")}
                      className="w-9 h-9 rounded-full bg-slate-900 border border-slate-800/80 flex items-center justify-center hover:bg-slate-800 transition"
                    >
                      <ArrowLeft className="w-4 h-4 text-slate-350" />
                    </button>
                    <h3 className="text-sm font-black text-white">سلة التسوّق</h3>
                  </div>

                  <div className="flex-1 overflow-y-auto px-4 py-2 flex flex-col gap-3 scrollbar-none">
                    {cart.length === 0 ? (
                      <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
                        <div className="w-16 h-16 rounded-full bg-slate-900 flex items-center justify-center text-slate-650 border border-slate-800">
                          <ShoppingCart className="w-7 h-7 text-slate-500" />
                        </div>
                        <p className="text-xs text-slate-400 font-medium">سلتك فارغة حالياً، أضف بعض المنتجات!</p>
                        <button 
                          onClick={() => setCurrentScreen("storefront")}
                          className="px-5 py-2.5 bg-gradient-to-r from-teal-500 to-cyan-500 text-slate-950 font-black text-xs rounded-full hover:from-teal-400 hover:to-cyan-400 transition shadow-lg cursor-pointer"
                        >
                          تصفّح المنتجات
                        </button>
                      </div>
                    ) : (
                      cart.map(item => (
                        <div 
                          key={item.product.id}
                          className="bg-slate-900 border border-slate-850/80 rounded-2xl p-3 flex items-center gap-3 shadow-md"
                        >
                          <button 
                            onClick={() => removeFromCart(item.product.id)}
                            className="text-slate-500 hover:text-red-400 transition p-1 cursor-pointer"
                          >
                            <Trash2 className="w-4.5 h-4.5" />
                          </button>

                          <div className="flex-1 min-w-0">
                            <h5 className="text-xs font-black text-white truncate">{item.product.name}</h5>
                            <p className="text-[10px] text-amber-450 font-black mt-0.5">{(item.product.price * item.quantity).toLocaleString()} د.ع</p>
                            
                            <div className="flex items-center gap-2 mt-2 justify-end">
                              <button 
                                onClick={() => updateQty(item.product.id, -1)}
                                className="w-5.5 h-5.5 rounded-full bg-slate-800 flex items-center justify-center text-slate-300 font-bold border border-slate-700 cursor-pointer"
                              >
                                <Minus className="w-3.5 h-3.5" />
                              </button>
                              <span className="text-xs font-black text-white px-2">{item.quantity}</span>
                              <button 
                                onClick={() => updateQty(item.product.id, 1)}
                                className="w-5.5 h-5.5 rounded-full bg-slate-800 flex items-center justify-center text-slate-300 font-bold border border-slate-700 cursor-pointer"
                              >
                                <Plus className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          <div className="text-3xl w-12 h-12 bg-slate-800 rounded-xl flex items-center justify-center flex-shrink-0">
                            {item.product.image}
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {cart.length > 0 && (
                    <div className="bg-slate-900 border-t border-slate-850 p-4 flex flex-col gap-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-white">{getSubtotal().toLocaleString()} د.ع</span>
                        <span className="text-slate-405 font-medium">مجموع المنتجات:</span>
                      </div>
                      <button 
                        onClick={() => setCurrentScreen("checkout")}
                        className="w-full py-3 bg-gradient-to-r from-teal-500 to-cyan-500 hover:from-teal-400 hover:to-cyan-400 text-slate-950 font-black text-xs rounded-2xl transition shadow-lg flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <span>الذهاب لتأكيد وتثبيت الطلب</span>
                        <ChevronRight className="w-4.5 h-4.5" />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* VIEW: Checkout */}
              {currentScreen === "checkout" && (
                <div className="flex-1 flex flex-col bg-slate-950 text-right pt-4 px-4 overflow-y-auto pb-20 scrollbar-none">
                  <div className="flex items-center justify-between border-b border-slate-900 pb-3 mb-4 flex-shrink-0">
                    <button 
                      onClick={() => setCurrentScreen("cart")}
                      className="w-9 h-9 rounded-full bg-slate-900 border border-slate-800/80 flex items-center justify-center hover:bg-slate-800 transition"
                    >
                      <ArrowLeft className="w-4 h-4 text-slate-350" />
                    </button>
                    <h3 className="text-sm font-black text-white">تثبيت الطلب الفوري</h3>
                  </div>

                  <form onSubmit={handleCheckoutSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-bold text-slate-400">الاسم الثلاثي بالكامل *</label>
                      <input 
                        type="text" 
                        required
                        placeholder="مثال: علي محمد الكعبي"
                        value={checkoutForm.name}
                        onChange={(e) => setCheckoutForm({ ...checkoutForm, name: e.target.value })}
                        className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-white placeholder-slate-650 text-right focus:border-teal-500/50 outline-none font-medium"
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-bold text-slate-400">رقم الهاتف العراقي (ترميز دولي تلقائي) *</label>
                      <input 
                        type="text" 
                        required
                        placeholder="+964 7xx xxx xxxx"
                        value={checkoutForm.phone}
                        onChange={(e) => handlePhoneChange(e.target.value)}
                        className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-white placeholder-slate-650 text-right focus:border-teal-500/50 outline-none font-bold"
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-bold text-slate-400">المحافظة العراقية *</label>
                      <select 
                        value={checkoutForm.governorate}
                        onChange={(e) => setCheckoutForm({ ...checkoutForm, governorate: e.target.value })}
                        className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-white text-right focus:border-teal-500/50 outline-none font-bold cursor-pointer"
                      >
                        {GOVERNORATES.map(gov => (
                          <option key={gov.id} value={gov.id}>
                            {gov.name} (أجور توصيل: {gov.fee === 5000 ? "٥,٠٠٠" : "٨,٠٠٠"} د.ع)
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Google Maps Container */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-bold text-slate-400 flex items-center justify-end gap-1">
                        <span>حدد موقع بيتك على الخريطة لتثبيت العنوان</span>
                        <MapPin className="w-3.5 h-3.5 text-teal-400" />
                      </label>
                      
                      <div className="w-full aspect-[16/10] bg-slate-900 border border-slate-800 rounded-2xl relative overflow-hidden flex flex-col justify-between shadow-inner">
                        <div className="absolute inset-0 bg-slate-950 opacity-20 bg-[linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:20px_20px]" />
                        <div className="absolute top-1/3 left-0 right-1/4 h-6 bg-cyan-950/40 blur-sm transform rotate-12 flex-shrink-0" />
                        
                        <div className="absolute top-2 right-2 flex flex-col gap-1 z-10">
                          <button type="button" onClick={() => setMapZoom(prev => prev + 1)} className="w-6 h-6 rounded bg-slate-800/90 border border-slate-700 flex items-center justify-center text-xs text-white font-black hover:bg-slate-700">+</button>
                          <button type="button" onClick={() => setMapZoom(prev => prev - 1)} className="w-6 h-6 rounded bg-slate-800/90 border border-slate-700 flex items-center justify-center text-xs text-white font-black hover:bg-slate-700">-</button>
                        </div>

                        <div className="absolute top-2 left-2 bg-slate-950/80 border border-slate-800 px-2 py-0.5 rounded text-[8px] text-slate-450 z-10">
                          Google Maps (تفاعلي)
                        </div>

                        <div className="absolute inset-0 flex items-center justify-center">
                          <button type="button" onClick={() => handleMapPinDrop(0.015, -0.02)} className="absolute top-10 left-10 w-2 h-2 rounded-full bg-slate-500/20" />
                          <button type="button" onClick={() => handleMapPinDrop(-0.02, 0.01)} className="absolute bottom-12 right-16 w-2 h-2 rounded-full bg-slate-500/20" />

                          <motion.div 
                            animate={{ y: isPinMoved ? [0, -15, 0] : 0 }}
                            transition={{ duration: 0.5 }}
                            className="relative z-20 flex flex-col items-center cursor-pointer"
                            onClick={() => handleMapPinDrop((Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.02)}
                          >
                            <MapPin className="w-8 h-8 text-rose-500 filter drop-shadow-[0_4px_8px_rgba(0,0,0,0.5)] fill-rose-500/40" />
                            <div className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping absolute bottom-0" />
                          </motion.div>
                        </div>

                        <div className="w-full bg-slate-950/90 border-t border-slate-850 px-3 py-1.5 flex items-center justify-between text-[8.5px] z-10">
                          <span className="text-slate-450">خط العرض: {draggedPin.lat.toFixed(4)}, خط الطول: {draggedPin.lng.toFixed(4)}</span>
                          <span className="text-teal-400 font-bold">📍 انقر على الخريطة لتثبيت موقع منزلك</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-bold text-slate-400">العنوان بالتفصيل *</label>
                      <textarea 
                        rows={2}
                        required
                        placeholder="مثال: الكرادة، قرب ساحة التحريات، زقاق ١٢، دار ٥"
                        value={checkoutForm.address}
                        onChange={(e) => setCheckoutForm({ ...checkoutForm, address: e.target.value })}
                        className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-650 text-right focus:border-teal-500/50 outline-none resize-none font-medium"
                      />
                    </div>

                    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 flex flex-col gap-2 shadow-inner">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-white">{getSubtotal().toLocaleString()} د.ع</span>
                        <span className="text-slate-400">مجموع المشتريات:</span>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-teal-400 font-bold">{getDeliveryFee().toLocaleString()} د.ع</span>
                        <span className="text-slate-400">أجور التوصيل المحددة:</span>
                      </div>
                      <div className="w-full h-px bg-slate-800 my-1" />
                      <div className="flex items-center justify-between text-sm font-black">
                        <span className="text-amber-450">{getTotal().toLocaleString()} د.ع</span>
                        <span className="text-white">المجموع الإجمالي الكلي:</span>
                      </div>
                    </div>

                    <button 
                      type="submit"
                      className="w-full py-3 bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 hover:from-amber-400 hover:to-orange-500 text-slate-950 font-black text-xs rounded-2xl transition shadow-lg mt-2 cursor-pointer animate-pulse"
                    >
                      تثبيت وإرسال الطلب الفوري 🚀
                    </button>
                  </form>
                </div>
              )}

              {/* VIEW: Receipt */}
              {currentScreen === "receipt" && submittedOrder && (
                <div className="flex-1 flex flex-col bg-slate-950 text-right pt-4 px-4 overflow-y-auto pb-20 scrollbar-none">
                  <div className="flex flex-col items-center text-center gap-2 mb-6">
                    <div className="w-12 h-12 rounded-full bg-teal-500/20 text-teal-400 flex items-center justify-center border border-teal-500/40">
                      <Check className="w-6 h-6 animate-bounce" />
                    </div>
                    <h3 className="text-base font-black text-white">وصل الطلب الفوري</h3>
                    <p className="text-[10px] text-slate-400 font-medium">تم تسجيل وتثبيت طلبك بنجاح! شاركه الآن مع الإدارة على واتساب</p>
                  </div>

                  <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 flex flex-col gap-3 relative shadow-xl">
                    <div className="absolute top-3 left-3 text-[9px] bg-amber-500/15 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full font-bold">
                      {submittedOrder.id}
                    </div>
                    
                    <h4 className="text-xs font-extrabold text-slate-300 border-b border-slate-800 pb-2 mb-1">بيانات التسليم</h4>
                    <div className="flex flex-col gap-1.5 text-xs">
                      <div className="flex justify-between">
                        <span className="text-white font-bold">{submittedOrder.name}</span>
                        <span className="text-slate-450">اسم الزبون:</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-white font-bold">{submittedOrder.phone}</span>
                        <span className="text-slate-450">رقم الهاتف:</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-white font-bold">{submittedOrder.address}</span>
                        <span className="text-slate-450">العنوان بالتفصيل:</span>
                      </div>
                    </div>

                    <h4 className="text-xs font-extrabold text-slate-300 border-b border-slate-800 pb-2 mt-2 mb-1">المواد المطلوبة</h4>
                    <div className="flex flex-col gap-2">
                      {submittedOrder.items.map((item: any, idx: number) => (
                        <div key={idx} className="flex justify-between text-xs">
                          <span className="text-white font-bold">{item.price.toLocaleString()} د.ع (×{item.quantity})</span>
                          <span className="text-slate-300 text-right truncate max-w-[185px]">{item.name}</span>
                        </div>
                      ))}
                    </div>

                    <div className="w-full h-px bg-slate-800 my-2" />
                    
                    <div className="flex justify-between text-sm font-black">
                      <span className="text-amber-400">{submittedOrder.total.toLocaleString()} د.ع</span>
                      <span className="text-white">المجموع الكلي:</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2.5 mt-6">
                    <button 
                      onClick={() => shareToWhatsApp(submittedOrder)}
                      className="w-full py-3.5 bg-[#25D366] text-slate-950 font-black text-xs rounded-2xl transition shadow-lg flex items-center justify-center gap-1.5 cursor-pointer text-center"
                    >
                      <Send className="w-4 h-4" />
                      <span>إرسال الطلب عبر واتساب للإدارة</span>
                    </button>

                    <button 
                      onClick={() => {
                        setSubmittedOrder(null);
                        setCurrentScreen("storefront");
                      }}
                      className="w-full py-3 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs rounded-2xl transition border border-slate-700"
                    >
                      العودة لمواصلة التسوّق
                    </button>
                  </div>
                </div>
              )}

              {/* VIEW: Employee Login Gate (Hooks to real auth database sessions) */}
              {currentScreen === "login" && (
                <div className="flex-1 flex flex-col bg-slate-950 pt-6 px-5 text-right justify-center">
                  <div className="w-14 h-14 rounded-3xl bg-amber-500/10 text-amber-500 border border-amber-500/20 flex items-center justify-center mx-auto mb-3">
                    <Lock className="w-6 h-6" />
                  </div>
                  <h3 className="text-base font-black text-white text-center">بوابة موظفي ERP الأساسية</h3>
                  <p className="text-[10px] text-slate-400 text-center mb-6">تسجيل الدخول يربطك مباشرة بالنظام الأساسي للرؤية العربية</p>

                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-[9.5px] font-bold text-slate-455">البريد الإلكتروني للعمل</label>
                      <input 
                        type="email" 
                        value={realEmail}
                        onChange={(e) => setRealEmail(e.target.value)}
                        className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-650 text-right outline-none"
                        placeholder="username@alroya.local"
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[9.5px] font-bold text-slate-455">كلمة المرور</label>
                      <input 
                        type="password" 
                        value={realPassword}
                        onChange={(e) => setRealPassword(e.target.value)}
                        className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-650 text-right outline-none font-mono"
                        placeholder="••••••••"
                      />
                    </div>

                    {isRealAuthLoading ? (
                      <div className="w-full py-2.5 bg-amber-600/40 rounded-xl flex items-center justify-center">
                        <RefreshCw className="w-4 h-4 text-amber-400 animate-spin" />
                      </div>
                    ) : (
                      <button 
                        onClick={handleRealAuthLogin}
                        className="w-full py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 text-slate-950 font-black text-xs rounded-xl transition shadow-lg mt-2 active:scale-95"
                      >
                        تسجيل الدخول للنظام الأساسي 🔑
                      </button>
                    )}
                  </div>
                  
                  {/* PIN Alternative fallback grid */}
                  <div className="w-full border-t border-slate-900 mt-6 pt-4 flex flex-col items-center">
                    <span className="text-[9px] text-slate-500 mb-2">أو الدخول التجريبي السريع بالرمز</span>
                    <div className="flex justify-center gap-3 mb-3">
                      {[0, 1, 2].map((idx) => (
                        <div key={idx} className={`w-3.5 h-3.5 rounded-full border ${pin.length > idx ? "bg-amber-400 border-amber-400" : "border-slate-800"}`} />
                      ))}
                    </div>
                    <div className="grid grid-cols-3 gap-2 max-w-[200px] mx-auto">
                      {["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0"].map((digit) => (
                        <button 
                          key={digit}
                          onClick={() => handlePinInput(digit)}
                          className="w-10 h-10 rounded-full bg-slate-900 border border-slate-850 text-xs font-bold text-white hover:bg-slate-850 transition"
                        >
                          {digit}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* VIEW: ERP Launcher Dashboard (B2B Employee view) */}
              {currentScreen === "dashboard" && (
                <div className="flex-1 flex flex-col bg-slate-950 text-right pt-4 px-4 overflow-y-auto pb-20 scrollbar-none">
                  
                  {/* Header */}
                  <div className="flex items-center justify-between mb-4 border-b border-slate-900 pb-3">
                    <button 
                      onClick={handleLogout}
                      className="text-xs text-red-400 bg-red-950/40 border border-red-900/30 px-3 py-1 rounded-full font-bold cursor-pointer"
                    >
                      خروج
                    </button>
                    <div className="flex items-center gap-2">
                      <div>
                        <h3 className="text-xs font-black text-white">نظام إدارة الأعمال (BMS)</h3>
                        <p className="text-[9px] text-slate-400">{me.data?.username || "حساب موظف"} ({me.data?.role || "مبيعات"})</p>
                      </div>
                      <LayoutDashboard className="w-5 h-5 text-amber-500 animate-pulse" />
                    </div>
                  </div>

                  {/* Real Live Database Metrics telemetry dashboard */}
                  <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-3.5 mb-4 shadow-md text-right relative overflow-hidden">
                    <div className="absolute top-2 left-2 text-[9px] bg-teal-500/10 text-teal-400 px-2 py-0.5 rounded border border-teal-500/25">مباشر 🟢</div>
                    <h4 className="text-[11px] font-black text-slate-350">مؤشرات الأداء الأساسية (Live DB)</h4>
                    
                    <div className="grid grid-cols-2 gap-3 mt-3">
                      <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-900">
                        <span className="text-[8px] text-slate-450">مبيعات اليوم الكلية</span>
                        <h5 className="text-[11.5px] font-extrabold text-amber-450 mt-1">
                          {realMetricsQuery.data?.salesPulse?.yesterday != null 
                            ? `${Number(realMetricsQuery.data?.salesPulse?.yesterday || 0).toLocaleString()} د.ع` 
                            : "١,٥٦٦,٠٠٠ د.ع"}
                        </h5>
                      </div>
                      
                      <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-900">
                        <span className="text-[8px] text-slate-450">تنبيهات المخزون الناقص</span>
                        <h5 className="text-[11.5px] font-extrabold text-white mt-1">
                          {realMetricsQuery.data?.lowStockCount ?? 0} أصناف
                        </h5>
                      </div>
                    </div>
                  </div>

                  {/* Core ERP Modules App Launcher (Embedded view launchers) */}
                  <h4 className="text-xs font-black text-slate-350 mb-2">تشغيل تطبيقات النظام الأساسي</h4>
                  
                  <div className="grid grid-cols-2 gap-3 mb-6">
                    
                    {/* Launch Dashboard Page */}
                    <button 
                      onClick={() => setActiveB2bApp("dashboard")}
                      className="bg-slate-900 border border-slate-850 hover:border-amber-400 p-4 rounded-3xl flex flex-col items-center justify-center text-center gap-2 transition shadow-lg active:scale-95 group"
                    >
                      <span className="text-2xl bg-amber-500/10 text-amber-400 p-2.5 rounded-2xl group-hover:scale-105 transition-transform">📊</span>
                      <span className="text-xs font-black text-white">لوحة الإحصائيات</span>
                      <span className="text-[8.5px] text-slate-450 font-medium">التقارير وهامش الربح</span>
                    </button>

                    {/* Launch Point of Sale Page */}
                    <button 
                      onClick={() => setActiveB2bApp("pos")}
                      className="bg-slate-900 border border-slate-850 hover:border-amber-400 p-4 rounded-3xl flex flex-col items-center justify-center text-center gap-2 transition shadow-lg active:scale-95 group"
                    >
                      <span className="text-2xl bg-teal-500/10 text-teal-400 p-2.5 rounded-2xl group-hover:scale-105 transition-transform">💻</span>
                      <span className="text-xs font-black text-white">نقطة الكاشير POS</span>
                      <span className="text-[8.5px] text-slate-450 font-medium">البيع والطباعة المباشرة</span>
                    </button>

                    {/* Launch Inventory Hub */}
                    <button 
                      onClick={() => setActiveB2bApp("inventory")}
                      className="bg-slate-900 border border-slate-850 hover:border-amber-400 p-4 rounded-3xl flex flex-col items-center justify-center text-center gap-2 transition shadow-lg active:scale-95 group"
                    >
                      <span className="text-2xl bg-cyan-500/10 text-cyan-400 p-2.5 rounded-2xl group-hover:scale-105 transition-transform">📦</span>
                      <span className="text-xs font-black text-white">إدارة المخزن</span>
                      <span className="text-[8.5px] text-slate-450 font-medium">الأصناف والجرد والباركود</span>
                    </button>

                    {/* Launch Sales Hub */}
                    <button 
                      onClick={() => setActiveB2bApp("sales")}
                      className="bg-slate-900 border border-slate-850 hover:border-amber-400 p-4 rounded-3xl flex flex-col items-center justify-center text-center gap-2 transition shadow-lg active:scale-95 group"
                    >
                      <span className="text-2xl bg-rose-500/10 text-rose-450 p-2.5 rounded-2xl group-hover:scale-105 transition-transform">🧾</span>
                      <span className="text-xs font-black text-white">الفواتير والمبيعات</span>
                      <span className="text-[8.5px] text-slate-450 font-medium">كشوفات الحساب والديون</span>
                    </button>

                    {/* Launch Delivery Driver Portal */}
                    <button 
                      onClick={() => setActiveB2bApp("delivery")}
                      className="bg-slate-900 border border-slate-850 hover:border-amber-400 p-4 rounded-3xl flex flex-col items-center justify-center text-center gap-2 transition shadow-lg active:scale-95 group col-span-2"
                    >
                      <span className="text-2xl bg-amber-500/10 text-amber-400 p-2.5 rounded-2xl group-hover:scale-105 transition-transform">🚚</span>
                      <span className="text-xs font-black text-white">بوابة مندوب التوصيل (Driver)</span>
                      <span className="text-[8.5px] text-slate-450 font-medium">الطلبات الموكلة، تحصيل عهدة COD، وخرائط جوجل للتوجيه</span>
                    </button>

                  </div>

                  {/* Google Sheets Integration Exporter */}
                  <div className="bg-slate-900 border border-slate-850 p-4 rounded-3xl mb-4 shadow-lg text-right relative overflow-hidden">
                    <div className="absolute top-2 left-2">
                      <FileSpreadsheet className="w-5 h-5 text-emerald-400" />
                    </div>
                    
                    <h4 className="text-xs font-black text-white">تكامل Google Sheets 📊</h4>
                    <p className="text-[9.5px] text-slate-400 mt-1 leading-relaxed">
                      تصدير ومزامنة طلبات المتجر مع جدول المبيعات المشترك على جوجل درايف للتحصيل والمحاسبة الفورية.
                    </p>

                    <div className="mt-3">
                      {isSheetsSyncing ? (
                        <div className="flex items-center justify-center gap-2 py-2 bg-emerald-950/40 border border-emerald-900/30 rounded-xl">
                          <RefreshCw className="w-4 h-4 text-emerald-400 animate-spin" />
                          <span className="text-[10px] text-emerald-400 font-bold">جاري رفع الأسطر للجدول...</span>
                        </div>
                      ) : (
                        <button 
                          onClick={syncToGoogleSheets}
                          className="w-full py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-[10px] rounded-xl flex items-center justify-center gap-1.5 transition cursor-pointer shadow-md"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>تصدير ومزامنة البيانات مع Google Drive</span>
                        </button>
                      )}

                      {sheetsSyncDone && (
                        <div className="mt-2 text-center text-[9px] text-emerald-400 font-bold bg-emerald-950/20 py-1.5 rounded-lg border border-emerald-900/20">
                          قاعدة بيانات جوجل محدثة بنجاح بنسبة ١٠٠٪ 🟢
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Barcode scanner launcher */}
                  <button 
                    onClick={() => setCurrentScreen("scanner")}
                    className="w-full py-3.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black text-xs rounded-2xl transition shadow-lg flex items-center justify-center gap-1.5 cursor-pointer mb-2"
                  >
                    <QrCode className="w-4 h-4" />
                    <span>مسح باركود صنف جديد (سكانر)</span>
                  </button>

                </div>
              )}

              {/* VIEW: Scanner */}
              {currentScreen === "scanner" && (
                <div className="flex-1 flex flex-col bg-slate-950 text-right pt-4 px-4 overflow-y-auto pb-20 scrollbar-none justify-between">
                  <div className="flex items-center justify-between border-b border-slate-900 pb-3 mb-2 flex-shrink-0">
                    <button 
                      onClick={() => setCurrentScreen("dashboard")}
                      className="w-8 h-8 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center hover:bg-slate-800 transition"
                    >
                      <ArrowLeft className="w-4 h-4 text-slate-300" />
                    </button>
                    <h3 className="text-sm font-black text-white">محاكي قارئ الباركود</h3>
                  </div>

                  <div className="w-full aspect-[4/3] bg-slate-900 border-2 border-dashed border-slate-700 rounded-3xl relative overflow-hidden flex flex-col items-center justify-center my-auto shadow-2xl">
                    {scanStatus === "idle" && (
                      <div className="flex flex-col items-center gap-3 p-4 text-center">
                        <QrCode className="w-12 h-12 text-slate-500 animate-pulse" />
                        <p className="text-xs text-slate-400 font-medium">وجه الكاميرا نحو باركود المنتج لمزامنته</p>
                        <button 
                          onClick={startScan}
                          className="px-4 py-2 bg-amber-500 text-slate-950 font-black text-xs rounded-full hover:bg-amber-400 transition cursor-pointer"
                        >
                          بدء عملية المسح الفوري
                        </button>
                      </div>
                    )}

                    {scanStatus === "scanning" && (
                      <div className="w-full h-full relative flex items-center justify-center">
                        <div className="absolute inset-x-0 h-0.5 bg-red-500 shadow-[0_0_12px_#ef4444] animate-[scanLine_2s_infinite]" />
                        <div className="border-2 border-teal-500/40 w-48 h-28 rounded-2xl flex items-center justify-center">
                          <span className="text-[10px] text-teal-400 font-bold bg-slate-950/80 border border-teal-900 px-3 py-1 rounded-full animate-pulse">جاري المسح والربط...</span>
                        </div>
                      </div>
                    )}

                    {scanStatus === "success" && scannedProduct && (
                      <div className="w-full h-full bg-slate-900/95 flex flex-col items-center justify-center p-4 text-center gap-2 animate-[fadeIn_0.3s_ease]">
                        <div className="w-10 h-10 rounded-full bg-teal-500/20 text-teal-400 flex items-center justify-center border border-teal-500/40 mb-1">
                          <Check className="w-5 h-5" />
                        </div>
                        <span className="text-[10px] text-teal-400 font-bold font-black">تم التعرف والمزامنة! ✅</span>
                        <h4 className="text-xs font-black text-white mt-1">{scannedProduct.name}</h4>
                        <p className="text-xs text-amber-400 font-black">{scannedProduct.price.toLocaleString()} د.ع</p>
                        
                        <button 
                          onClick={() => setScanStatus("idle")}
                          className="mt-2.5 px-4 py-1.5 bg-slate-800 text-white font-bold text-[10px] rounded-full border border-slate-700 hover:bg-slate-750 cursor-pointer"
                        >
                          مسح منتج آخر
                        </button>
                      </div>
                    )}

                    <div className="absolute top-4 right-4 w-6 h-6 border-t-4 border-r-4 border-teal-500 rounded-tr-lg" />
                    <div className="absolute top-4 left-4 w-6 h-6 border-t-4 border-l-4 border-teal-500 rounded-tl-lg" />
                    <div className="absolute bottom-4 right-4 w-6 h-6 border-b-4 border-r-4 border-teal-500 rounded-br-lg" />
                    <div className="absolute bottom-4 left-4 w-6 h-6 border-b-4 border-l-4 border-teal-500 rounded-tl-lg" />
                  </div>

                  <div className="bg-slate-900 border border-slate-850 p-4 rounded-2xl flex-shrink-0 mt-4 shadow-md">
                    <h4 className="text-xs font-black text-slate-300 mb-1">تفاصيل قاعدة البيانات والمزامنة</h4>
                    <p className="text-[9.5px] text-slate-400 leading-relaxed font-medium">
                      محاكي الكود يرتبط مباشرة بنظام الأصناف للرؤية العربية لتسجيل الباركود وحركة الصنف بشكل فوري.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Bottom simulated flagship phone navigation dock */}
          {activeB2bApp == null && (
            <div className="absolute bottom-4 inset-x-4 h-14 bg-slate-900/70 border border-slate-800/80 backdrop-blur-md rounded-2xl z-40 flex items-center justify-around px-3 shadow-[0_8px_32px_rgba(0,0,0,0.55)]">
              <button 
                onClick={() => {
                  setCurrentScreen("storefront");
                }}
                className={`flex flex-col items-center justify-center w-12 h-12 rounded-xl transition ${
                  currentScreen === "storefront" ? "text-teal-400 bg-teal-500/10" : "text-slate-400 hover:text-white"
                }`}
              >
                <ShoppingBag className="w-5 h-5" />
                <span className="text-[8.5px] font-bold mt-1">المتجر</span>
              </button>

              <button 
                onClick={() => {
                  setCurrentScreen("cart");
                }}
                className={`flex flex-col items-center justify-center w-12 h-12 rounded-xl transition relative ${
                  currentScreen === "cart" ? "text-teal-400 bg-teal-500/10" : "text-slate-400 hover:text-white"
                }`}
              >
                <ShoppingCart className="w-5 h-5" />
                <span className="text-[8.5px] font-bold mt-1">السلة</span>
                {cart.length > 0 && (
                  <span className="absolute top-1.5 right-2 w-2 h-2 rounded-full bg-teal-400 shadow-[0_0_6px_#2dd4bf]" />
                )}
              </button>

              <button 
                onClick={() => {
                  if (me.data) {
                    setCurrentScreen("dashboard");
                  } else {
                    setCurrentScreen("login");
                  }
                }}
                className={`flex flex-col items-center justify-center w-12 h-12 rounded-xl transition ${
                  ["login", "dashboard", "scanner"].includes(currentScreen) ? "text-amber-400 bg-amber-500/10" : "text-slate-400 hover:text-white"
                }`}
              >
                <User className="w-5 h-5" />
                <span className="text-[8.5px] font-bold mt-1">الموظفين</span>
              </button>
            </div>
          )}

          {/* Bottom simulated navigation pill */}
          <div className="absolute bottom-1 inset-x-0 h-1.5 flex justify-center items-center pointer-events-none">
            <div className="w-24 h-1 bg-slate-700/60 rounded-full" />
          </div>

        </div>

      </div>

      {/* Simulator Details Info Card Footer */}
      <div className="mt-8 max-w-[420px] w-full bg-slate-900/60 border border-slate-800/80 rounded-3xl p-5 text-right relative overflow-hidden backdrop-blur-sm shadow-xl">
        <div className="absolute top-0 right-0 w-24 h-24 bg-teal-500/5 rounded-full blur-xl pointer-events-none" />
        
        <h4 className="text-xs font-black text-white flex items-center justify-end gap-1.5">
          <span>محاكي الجوال والتكامل الفوري</span>
          <Smartphone className="w-4 h-4 text-teal-400 animate-pulse" />
        </h4>
        
        <p className="text-[11px] text-slate-400 mt-2 leading-relaxed font-medium">
          هذا الماكيت التفاعلي متصل بنظام إدارة أعمال الرؤية العربية الأساسي، ليس فقط لعرض المنتجات من المخازن وتثبيت الفواتير، بل لتشغيل صفحات النظام الأساسي (لوحة التحكم، POS الكاشير، الجرد، والمبيعات) داخل واجهة الجوال بالكامل!
        </p>
      </div>

      {/* Global CSS Inject for Scan laser animation */}
      <style>{`
        @keyframes scanLine {
          0% { top: 0%; }
          50% { top: 100%; }
          100% { top: 0%; }
        }
        .scrollbar-none::-webkit-scrollbar {
          display: none;
        }
        .scrollbar-none {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>

    </div>
  );
}
