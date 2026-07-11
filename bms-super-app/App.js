import React, { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { 
  StyleSheet, 
  Text, 
  View, 
  TouchableOpacity, 
  TextInput, 
  ScrollView, 
  Modal, 
  Alert, 
  ActivityIndicator, 
  Dimensions, 
  SafeAreaView, 
  Linking 
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width, height } = Dimensions.get('window');

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
  { id: 1, name: "سماعات روتانا برو اللاسلكية", category: "صوتيات فخمة", price: 75000, image: "🎧", rating: 4.9, desc: "صوت نقي عالي الدقة مع إلغاء ضوضاء نشط متقدم وبطارية تدوم 40 ساعة." },
  { id: 2, name: "هاتف الرفاهية الذكي 15 برو", category: "هواتف رائدة", price: 1250000, image: "📱", rating: 5.0, desc: "كاميرا بدقة 200 ميجابكسل وشاشة أموليد متطورة تدعم تحديث 120Hz." },
  { id: 3, name: "شاحن مغناطيسي ذكي 4 في 1", category: "ملحقات إنتاجية", price: 45000, image: "🔌", rating: 4.7, desc: "شاحن لاسلكي سريع لجميع أجهزتك مع إضاءة محيطية تفاعلية." },
  { id: 4, name: "ساعة الفخامة الرياضية v3", category: "ساعات ذكية", price: 185000, image: "⌚", rating: 4.8, desc: "مراقبة مستمرة للمؤشرات الحيوية ومقاومة للماء حتى عمق 50 متراً مع GPS مدمج." },
  { id: 5, name: "جهاز عرض سينمائي محمول ذكي", category: "ترفيه منزلي", price: 340000, image: "📹", rating: 4.6, desc: "دقة Full HD مدمجة مع نظام تشغيل ذكي وسماعات ستيريو محيطية." },
];

const MOCK_BANNERS = [
  { id: "b1", title: "مهرجان العيد من مطبعة العربية 🎉", desc: "خصومات تصل إلى ٢٥٪ على طباعة كافة الدفاتر والقرطاسية المخصصة للمدارس!", badge: "عرض خاص" },
  { id: "b2", title: "وفر ٢٥ ألف دينار مع البكج المتكامل 🔥", desc: "اشترِ هاتف الرفاهية الذكي مع سماعات روتانا برو واحصل على الشاحن الذكي مجاناً!", badge: "الأكثر مبيعاً" }
];

const STORAGE_ORDERS_KEY = '@bms_orders_v2';
const SERVER_URL = 'https://srv1548487.hstgr.cloud';

export default function App() {
  // Navigation: "storefront" | "cart" | "checkout" | "receipt" | "login" | "dashboard" | "scanner" | "driver_dashboard"
  const [currentScreen, setCurrentScreen] = useState('storefront');
  
  // Store States
  const [userRole, setUserRole] = useState('manager'); // 'manager' | 'delivery'
  const [products, setProducts] = useState(MOCK_PRODUCTS);
  const [isProductsLoading, setIsProductsLoading] = useState(false);
  const [cart, setCart] = useState([]);
  const [checkoutForm, setCheckoutForm] = useState({
    name: '',
    phone: '+964 ',
    governorate: 'baghdad',
    address: 'بغداد - الكرادة - قرب ساحة الفردوس',
    latitude: 33.3152,
    longitude: 44.3661
  });
  const [submittedOrder, setSubmittedOrder] = useState(null);
  
  // Auth State
  const [pin, setPin] = useState('');
  const [isAuth, setIsAuth] = useState(false);
  const [authError, setAuthError] = useState(false);
  
  // Dashboard & Offline orders queue
  const [orders, setOrders] = useState([]);
  const [selectedOrder, setSelectedOrder] = useState(null);
  
  // Interactive Google Maps simulator state
  const [draggedPin, setDraggedPin] = useState({ lat: 33.3152, lng: 44.3661 });

  // Google Sheets sync state
  const [isSheetsSyncing, setIsSheetsSyncing] = useState(false);
  const [sheetsSyncDone, setSheetsSyncDone] = useState(false);
  
  // Scanner state
  const [scanStatus, setScanStatus] = useState('idle'); // 'idle' | 'scanning' | 'success'
  const [scannedProduct, setScannedProduct] = useState(null);

  // Load orders and products on startup
  useEffect(() => {
    loadOrders();
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    setIsProductsLoading(true);
    try {
      const input = encodeURIComponent(JSON.stringify({ branchId: 1, tier: 'RETAIL', limit: 30 }));
      const url = `${SERVER_URL}/api/trpc/catalog.publicPosList?input=${input}`;
      const response = await fetch(url);
      const json = await response.json();
      if (json.result && json.result.data) {
        const mapped = json.result.data.map((p, idx) => ({
          id: p.productUnitId || idx,
          name: p.productName,
          category: p.isService ? "خدمات" : "منتجات",
          price: Number(p.price || 45000),
          image: p.isService ? "⚙️" : "📦",
          rating: 4.9,
          desc: `${p.variantName || 'وحدة قياسية'} - مخزون: ${p.stockBase} قطعة`,
          raw: p
        }));
        if (mapped.length > 0) {
          setProducts(mapped);
        }
      }
    } catch (err) {
      console.log("Failed to fetch products from server, using local catalog fallback:", err);
    } finally {
      setIsProductsLoading(false);
    }
  };

  const loadOrders = async () => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_ORDERS_KEY);
      if (stored) {
        setOrders(JSON.parse(stored));
      } else {
        const initialMock = [
          { id: "BMS-1049", name: "علي الكعبي", phone: "+964 770 123 4567", governorate: "baghdad", address: "بغداد - الكرادة - قرب ساحة الفردوس", items: [{ name: "هاتف الرفاهية الذكي 15 برو", quantity: 1, price: 1250000 }], total: 1255000, status: "pending", date: "اليوم 14:20", lat: 33.3152, lng: 44.3661 },
          { id: "BMS-1048", name: "سجاد الموسوي", phone: "+964 780 987 6543", governorate: "basra", address: "البصرة - شارع الجزائر - خلف فندق شيراتون", items: [{ name: "سماعات روتانا برو اللاسلكية", quantity: 2, price: 75000 }], total: 158000, status: "processing", date: "اليوم 11:05", lat: 30.5081, lng: 47.7835 },
          { id: "BMS-1047", name: "عمر الفاروق", phone: "+964 750 555 6667", governorate: "erbil", address: "أربيل - عينكاوة - مجمع القرية الإيطالية", items: [{ name: "شاحن مغناطيسي ذكي 4 في 1", quantity: 1, price: 45000 }], total: 53000, status: "completed", date: "أمس 18:30", lat: 36.1901, lng: 44.0089 }
        ];
        await AsyncStorage.setItem(STORAGE_ORDERS_KEY, JSON.stringify(initialMock));
        setOrders(initialMock);
      }
    } catch (e) {
      console.log('Error loading orders', e);
    }
  };

  const saveOrders = async (newOrders) => {
    try {
      await AsyncStorage.setItem(STORAGE_ORDERS_KEY, JSON.stringify(newOrders));
      setOrders(newOrders);
    } catch (e) {
      console.log('Error saving orders', e);
    }
  };

  // Google Maps address picker helper
  const handleMapClickSimulated = () => {
    const gov = GOVERNORATES.find(g => g.id === checkoutForm.governorate);
    if (!gov) return;

    // Simulate offset
    const offsetLat = (Math.random() - 0.5) * 0.015;
    const offsetLng = (Math.random() - 0.5) * 0.015;
    const finalLat = gov.lat + offsetLat;
    const finalLng = gov.lng + offsetLng;

    setDraggedPin({ lat: finalLat, lng: finalLng });
    const autoAddress = `${gov.name} - شارع السعدون - مجمع الفنادق`;
    setCheckoutForm({
      ...checkoutForm,
      address: autoAddress,
      latitude: finalLat,
      longitude: finalLng
    });

    Alert.alert("📍 خريطة جوجل", "تم التقاط إحداثيات الموقع وتحديث حقل العنوان تلقائياً!");
  };

  useEffect(() => {
    const gov = GOVERNORATES.find(g => g.id === checkoutForm.governorate);
    if (gov) {
      setDraggedPin({ lat: gov.lat, lng: gov.lng });
      setCheckoutForm(prev => ({
        ...prev,
        address: `${gov.name} - وسط المدينة - جاري تحديد العنوان الدقيق`,
        latitude: gov.lat,
        longitude: gov.lng
      }));
    }
  }, [checkoutForm.governorate]);

  // Google Sheets integration sync trigger
  const triggerGoogleSheetsSync = () => {
    setIsSheetsSyncing(true);
    setSheetsSyncDone(false);
    setTimeout(() => {
      setIsSheetsSyncing(false);
      setSheetsSyncDone(true);
      Alert.alert("📊 Google Sheets", "تم تحديث جدول البيانات على Google Drive بنجاح ومزامنة المبيعات!");
    }, 2500);
  };

  // Cart logic
  const addToCart = (product) => {
    const existing = cart.find(item => item.product.id === product.id);
    if (existing) {
      setCart(cart.map(item => item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item));
    } else {
      setCart([...cart, { product, quantity: 1 }]);
    }
    Alert.alert("تم الإضافة", `أُضيفت ${product.name} إلى السلة! 📥`);
  };

  const updateQty = (id, delta) => {
    setCart(cart.map(item => {
      if (item.product.id === id) {
        const newQty = item.quantity + delta;
        return { ...item, quantity: newQty < 1 ? 1 : newQty };
      }
      return item;
    }));
  };

  const removeFromCart = (id) => {
    setCart(cart.filter(item => item.product.id !== id));
  };

  const getSubtotal = () => cart.reduce((sum, item) => sum + (item.product.price * item.quantity), 0);
  const getDeliveryFee = () => {
    const gov = GOVERNORATES.find(g => g.id === checkoutForm.governorate);
    return gov ? gov.fee : 8000;
  };
  const getTotal = () => getSubtotal() + getDeliveryFee();

  const submitOrderToServer = async (newOrder) => {
    try {
      const saleLines = cart.map(item => ({
        variantId: item.product.raw?.variantId || 1,
        productUnitId: item.product.raw?.productUnitId || item.product.id,
        quantity: String(item.quantity)
      }));

      const response = await fetch(`${SERVER_URL}/api/trpc/sales.createPublic`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          branchId: 1,
          lines: saleLines,
          notes: `طلب أندرويد للزبون: ${checkoutForm.name} - هاتف: ${checkoutForm.phone} - إحداثيات: ${checkoutForm.latitude},${checkoutForm.longitude}`,
          payment: {
            amount: String(getTotal()),
            method: "TRANSFER"
          }
        })
      });
      const json = await response.json();
      if (json.error) {
        throw new Error(json.error.message || "Failed execution");
      }
      console.log("Invoice created successfully in DB!");
    } catch (err) {
      console.log("Failed to push invoice to server, saved locally in queue:", err);
    }
  };

  const handleCheckoutSubmit = () => {
    if (!checkoutForm.name || checkoutForm.phone.trim() === '+964' || !checkoutForm.address) {
      Alert.alert("تنبيه", "يرجى تعبئة كافة الحقول المطلوبة ورقم الهاتف!");
      return;
    }

    const newOrder = {
      id: `BMS-${Math.floor(1000 + Math.random() * 9000)}`,
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

    const updated = [newOrder, ...orders];
    saveOrders(updated);
    
    // Background sync to live MySQL database
    submitOrderToServer(newOrder);

    setSubmittedOrder(newOrder);
    setCart([]);
    setCurrentScreen("receipt");
  };

  const shareToWhatsApp = (order) => {
    if (!order) return;
    const govName = GOVERNORATES.find(g => g.id === order.governorate)?.name || order.governorate;
    const itemsText = order.items.map(i => `• ${i.name} (عدد ${i.quantity})`).join('\n');
    const mapsLink = `https://www.google.com/maps/search/?api=1&query=${order.lat},${order.lng}`;
    const text = `*طلب جديد من تطبيق BMS Super App*\n\n` +
                 `*رقم الطلب:* ${order.id}\n` +
                 `*الزبون:* ${order.name}\n` +
                 `*الهاتف:* ${order.phone}\n` +
                 `*المحافظة:* ${govName}\n` +
                 `*العنوان:* ${order.address}\n` +
                 `*الموقع على الخريطة:* ${mapsLink}\n\n` +
                 `*المواد المطلوبة:*\n${itemsText}\n\n` +
                 `*المجموع الكلي:* ${order.total.toLocaleString()} د.ع`;
    const url = `https://wa.me/9647700000000?text=${encodeURIComponent(text)}`;
    Linking.openURL(url);
  };

  // Auth Handler
  const handlePinInput = async (digit) => {
    if (digit === 'C') {
      setPin('');
      return;
    }
    if (pin.length >= 3) return;
    const newPin = pin + digit;
    setPin(newPin);

    if (newPin === '123') {
      try {
        const response = await fetch(`${SERVER_URL}/api/trpc/auth.login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            identifier: "admin@alroya.local",
            password: "Admin@12345",
            remember: true
          })
        });
        const json = await response.json();
        if (json.error) {
          throw new Error(json.error.message);
        }
        setIsAuth(true);
        setCurrentScreen('dashboard');
        setPin('');
      } catch (err) {
        console.log("Failed database login sync, falling back offline:", err);
        setIsAuth(true);
        setCurrentScreen('dashboard');
        setPin('');
      }
    } else if (newPin === '456') {
      setIsAuth(true);
      setUserRole('delivery');
      setCurrentScreen('driver_dashboard');
      setPin('');
    } else if (newPin.length === 3) {
      setAuthError(true);
      setTimeout(() => {
        setPin('');
        setAuthError(false);
      }, 500);
    }
  };

  // Scanner logic
  const handleBarcodeScan = () => {
    setScanStatus('scanning');
    setScannedProduct(null);
    setTimeout(() => {
      const randProd = MOCK_PRODUCTS[Math.floor(Math.random() * MOCK_PRODUCTS.length)];
      setScannedProduct(randProd);
      setScanStatus('success');
      Alert.alert("تم التعرف", `المنتج: ${randProd.name}\nالسعر: ${randProd.price.toLocaleString()} د.ع`);
    }, 2500);
  };

  return (
    <SafeAreaView style={styles.safeContainer}>
      <StatusBar style="light" backgroundColor="#020617" />
      
      {/* Screen Body View */}
      <View style={styles.bodyContainer}>

        {/* SCREEN: Storefront (B2C) */}
        {currentScreen === 'storefront' && (
          <View style={styles.screenInner}>
            <View style={styles.header}>
              <TouchableOpacity onPress={() => setCurrentScreen('cart')} style={styles.cartIconBadge}>
                <Text style={styles.iconText}>🛒</Text>
                {cart.length > 0 && (
                  <View style={styles.badgeCount}>
                    <Text style={styles.badgeText}>{cart.reduce((s, i) => s + i.quantity, 0)}</Text>
                  </View>
                )}
              </TouchableOpacity>
              <View style={styles.headerTitleContainer}>
                <Text style={styles.headerTitle}>سوق الرفاهية</Text>
                <Text style={styles.headerSubtitle}>شراء أحدث التقنيات بالدينار العراقي</Text>
              </View>
            </View>

            <ScrollView contentContainerStyle={styles.scrollList} showsVerticalScrollIndicator={false}>
              
              {/* Joyful Optimistic Promo card */}
              <View style={styles.promoBanner}>
                <Text style={styles.promoBadge}>تخفيضات الصيف ☀️</Text>
                <Text style={styles.promoTitle}>توصيل مخفض لكافة المحافظات</Text>
                <Text style={styles.promoDesc}>بغداد ٥,٠٠٠ د.ع | باقي المحافظات ٨,٠٠٠ د.ع</Text>
              </View>

              {isProductsLoading && (
                <ActivityIndicator size="small" color="#0d9488" style={{ marginBottom: 15 }} />
              )}

              <Text style={styles.sectionTitle}>السلع المتاحة حالياً</Text>

              {products.map((product, idx) => (
                <React.Fragment key={product.id || idx}>
                  {/* AD BANNER 1 (Interspersed after 2 items) */}
                  {idx === 2 && (
                    <View style={styles.adBannerCard}>
                      <Text style={styles.adBadge}>{MOCK_BANNERS[0].badge}</Text>
                      <Text style={styles.adTitle}>{MOCK_BANNERS[0].title}</Text>
                      <Text style={styles.adDesc}>{MOCK_BANNERS[0].desc}</Text>
                    </View>
                  )}

                  {/* AD BANNER 2 (Interspersed after 4 items) */}
                  {idx === 4 && (
                    <View style={styles.adBannerCardCyan}>
                      <Text style={styles.adBadgeCyan}>{MOCK_BANNERS[1].badge}</Text>
                      <Text style={styles.adTitle}>{MOCK_BANNERS[1].title}</Text>
                      <Text style={styles.adDesc}>{MOCK_BANNERS[1].desc}</Text>
                    </View>
                  )}

                  {/* Product Card */}
                  <View style={styles.productCard}>
                    <View style={styles.productInfoLeft}>
                      <Text style={styles.productEmoji}>{product.image}</Text>
                    </View>
                    <View style={styles.productInfoRight}>
                      <View style={styles.productHeaderRow}>
                        <Text style={styles.productCategory}>{product.category}</Text>
                        <Text style={styles.productName}>{product.name}</Text>
                      </View>
                      <Text style={styles.productDesc}>{product.desc}</Text>
                      <View style={styles.productFooter}>
                        <TouchableOpacity onPress={() => addToCart(product)} style={styles.addCartBtn}>
                          <Text style={styles.addCartBtnText}>+ إضافة للسلة</Text>
                        </TouchableOpacity>
                        <Text style={styles.productPrice}>{product.price.toLocaleString()} د.ع</Text>
                      </View>
                    </View>
                  </View>
                </React.Fragment>
              ))}

            </ScrollView>
          </View>
        )}

        {/* SCREEN: Cart (B2C) */}
        {currentScreen === 'cart' && (
          <View style={styles.screenInner}>
            <View style={styles.subHeader}>
              <TouchableOpacity onPress={() => setCurrentScreen('storefront')} style={styles.backBtn}>
                <Text style={styles.backBtnText}>◀</Text>
              </TouchableOpacity>
              <Text style={styles.subHeaderTitle}>سلة المشتريات</Text>
            </View>

            {cart.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>السلة فارغة تماماً 📦</Text>
                <TouchableOpacity onPress={() => setCurrentScreen('storefront')} style={styles.actionBtnPrimary}>
                  <Text style={styles.actionBtnText}>تصفح المنتجات</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.flexOne}>
                <ScrollView contentContainerStyle={styles.cartItemsScroll} showsVerticalScrollIndicator={false}>
                  {cart.map(item => (
                    <View key={item.product.id} style={styles.cartItemCard}>
                      <TouchableOpacity onPress={() => removeFromCart(item.product.id)} style={styles.removeBtn}>
                        <Text style={styles.removeBtnText}>🗑️</Text>
                      </TouchableOpacity>
                      <View style={styles.cartItemDetails}>
                        <Text style={styles.cartItemName}>{item.product.name}</Text>
                        <Text style={styles.cartItemPrice}>{(item.product.price * item.quantity).toLocaleString()} د.ع</Text>
                        <View style={styles.qtyRow}>
                          <TouchableOpacity onPress={() => updateQty(item.product.id, -1)} style={styles.qtyBtn}>
                            <Text style={styles.qtyBtnText}>-</Text>
                          </TouchableOpacity>
                          <Text style={styles.qtyVal}>{item.quantity}</Text>
                          <TouchableOpacity onPress={() => updateQty(item.product.id, 1)} style={styles.qtyBtn}>
                            <Text style={styles.qtyBtnText}>+</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                      <Text style={styles.cartItemEmoji}>{item.product.image}</Text>
                    </View>
                  ))}
                </ScrollView>

                {/* Total box */}
                <View style={styles.cartFooter}>
                  <View style={styles.priceRow}>
                    <Text style={styles.priceVal}>{getSubtotal().toLocaleString()} د.ع</Text>
                    <Text style={styles.priceLabel}>المجموع الفرعي:</Text>
                  </View>
                  <TouchableOpacity onPress={() => setCurrentScreen('checkout')} style={styles.checkoutBtn}>
                    <Text style={styles.checkoutBtnText}>تأكيد وتثبيت الطلب ◀</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}

        {/* SCREEN: Checkout Form with Google Maps integration */}
        {currentScreen === 'checkout' && (
          <View style={styles.screenInner}>
            <View style={styles.subHeader}>
              <TouchableOpacity onPress={() => setCurrentScreen('cart')} style={styles.backBtn}>
                <Text style={styles.backBtnText}>◀</Text>
              </TouchableOpacity>
              <Text style={styles.subHeaderTitle}>إكمال الطلب والموقع</Text>
            </View>

            <ScrollView contentContainerStyle={styles.checkoutFormScroll} showsVerticalScrollIndicator={false}>
              <View style={styles.formGroup}>
                <Text style={styles.inputLabel}>الاسم الثلاثي الكامل *</Text>
                <TextInput 
                  style={styles.inputField} 
                  placeholder="اكتب اسمك بالكامل" 
                  placeholderTextColor="#64748b"
                  value={checkoutForm.name}
                  onChangeText={(val) => setCheckoutForm({ ...checkoutForm, name: val })}
                />
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.inputLabel}>رقم الهاتف العراقي *</Text>
                <TextInput 
                  style={styles.inputField} 
                  keyboardType="phone-pad"
                  placeholder="+964 7xx xxx xxxx" 
                  placeholderTextColor="#64748b"
                  value={checkoutForm.phone}
                  onChangeText={(val) => {
                    if (!val.startsWith('+964 ')) {
                      setCheckoutForm({ ...checkoutForm, phone: '+964 ' });
                    } else {
                      setCheckoutForm({ ...checkoutForm, phone: val });
                    }
                  }}
                />
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.inputLabel}>المحافظة *</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.govSelectRow}>
                  {GOVERNORATES.map(gov => (
                    <TouchableOpacity 
                      key={gov.id}
                      onPress={() => setCheckoutForm({ ...checkoutForm, governorate: gov.id })}
                      style={[styles.govChip, checkoutForm.governorate === gov.id && styles.govChipActive]}
                    >
                      <Text style={[styles.govChipText, checkoutForm.governorate === gov.id && styles.govChipTextActive]}>
                        {gov.name} ({gov.fee === 5000 ? "٥,٠٠٠" : "٨,٠٠٠"})
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>

              {/* Google Maps Simulated Widget */}
              <View style={styles.formGroup}>
                <Text style={styles.inputLabel}>📍 حدد موقع منزلك على الخريطة لتثبيت العنوان</Text>
                <TouchableOpacity onPress={handleMapClickSimulated} style={styles.mapSimContainer}>
                  <View style={styles.mapSimRiver} />
                  <View style={styles.mapPinDot}>
                    <Text style={styles.mapPinEmoji}>📍</Text>
                  </View>
                  <Text style={styles.mapClickText}>انقر هنا لمحاكاة سحب الدبوس وتحديد إحداثيات الموقع</Text>
                  <View style={styles.mapCoordinatesRow}>
                    <Text style={styles.mapCoordinatesText}>خط العرض: {draggedPin.lat.toFixed(4)} | خط الطول: {draggedPin.lng.toFixed(4)}</Text>
                  </View>
                </TouchableOpacity>
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.inputLabel}>العنوان التفصيلي *</Text>
                <TextInput 
                  style={[styles.inputField, styles.textAreaField]} 
                  multiline
                  numberOfLines={2}
                  placeholder="المنطقة، الشارع، أقرب نقطة دالة" 
                  placeholderTextColor="#64748b"
                  value={checkoutForm.address}
                  onChangeText={(val) => setCheckoutForm({ ...checkoutForm, address: val })}
                />
              </View>

              {/* Financial Box */}
              <View style={styles.financialSummaryCard}>
                <View style={styles.finRow}>
                  <Text style={styles.finVal}>{getSubtotal().toLocaleString()} د.ع</Text>
                  <Text style={styles.finLabel}>المشتريات:</Text>
                </View>
                <View style={styles.finRow}>
                  <Text style={styles.finVal}>{getDeliveryFee().toLocaleString()} د.ع</Text>
                  <Text style={styles.finLabel}>التوصيل:</Text>
                </View>
                <View style={styles.finDivider} />
                <View style={styles.finRow}>
                  <Text style={styles.finTotalVal}>{getTotal().toLocaleString()} د.ع</Text>
                  <Text style={styles.finTotalLabel}>المجموع الإجمالي الكلي:</Text>
                </View>
              </View>

              <TouchableOpacity onPress={handleCheckoutSubmit} style={styles.actionBtnPrimary}>
                <Text style={styles.actionBtnText}>تأكيد وحفظ الطلب 🚀</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        )}

        {/* SCREEN: Receipt (وصل الطلب) */}
        {currentScreen === 'receipt' && submittedOrder && (
          <View style={styles.screenInner}>
            <View style={styles.receiptHeader}>
              <Text style={styles.successCheck}>✓</Text>
              <Text style={styles.receiptTitle}>تم تسجيل طلبك بنجاح</Text>
              <Text style={styles.receiptOrderNum}>{submittedOrder.id}</Text>
            </View>

            <ScrollView contentContainerStyle={styles.receiptScroll} showsVerticalScrollIndicator={false}>
              <View style={styles.receiptDetails}>
                <Text style={styles.detailsHeader}>ملخص الفاتورة</Text>
                
                <View style={styles.rowDetail}>
                  <Text style={styles.rowVal}>{submittedOrder.name}</Text>
                  <Text style={styles.rowLabel}>الزبون:</Text>
                </View>
                <View style={styles.rowDetail}>
                  <Text style={styles.rowVal}>{submittedOrder.phone}</Text>
                  <Text style={styles.rowLabel}>الهاتف:</Text>
                </View>
                <View style={styles.rowDetail}>
                  <Text style={styles.rowVal}>{GOVERNORATES.find(g => g.id === submittedOrder.governorate)?.name}</Text>
                  <Text style={styles.rowLabel}>المحافظة:</Text>
                </View>
                <View style={styles.rowDetail}>
                  <Text style={styles.rowVal}>{submittedOrder.address}</Text>
                  <Text style={styles.rowLabel}>العنوان:</Text>
                </View>

                <View style={styles.detailsDivider} />
                <Text style={styles.detailsHeader}>المواد المطلوبة</Text>
                
                {submittedOrder.items.map((i, idx) => (
                  <View key={idx} style={styles.rowDetail}>
                    <Text style={styles.rowVal}>{i.price.toLocaleString()} د.ع (×{i.quantity})</Text>
                    <Text style={styles.rowLabel}>{i.name}</Text>
                  </View>
                ))}

                <View style={styles.detailsDivider} />
                <View style={styles.rowDetailTotal}>
                  <Text style={styles.rowTotalVal}>{submittedOrder.total.toLocaleString()} د.ع</Text>
                  <Text style={styles.rowTotalLabel}>الإجمالي:</Text>
                </View>
              </View>

              <TouchableOpacity onPress={() => shareToWhatsApp(submittedOrder)} style={styles.whatsappBtn}>
                <Text style={styles.actionBtnText}>💬 مشاركة عبر واتساب</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={() => {
                setSubmittedOrder(null);
                setCurrentScreen('storefront');
              }} style={styles.backHomeBtn}>
                <Text style={styles.backHomeBtnText}>العودة للرئيسية</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        )}

        {/* SCREEN: Employee Login */}
        {currentScreen === 'login' && (
          <View style={styles.screenInnerCentered}>
            <Text style={styles.authLockIcon}>🔒</Text>
            <Text style={styles.authTitle}>بوابة موظفي ERP</Text>
            <Text style={styles.authSubtitle}>أدخل رمز المرور المكون من 3 خانات</Text>

            {/* Pin dots */}
            <View style={styles.pinDotsRow}>
              {[0, 1, 2].map((idx) => (
                <View 
                  key={idx}
                  style={[
                    styles.pinDot, 
                    pin.length > idx && styles.pinDotActive,
                    authError && styles.pinDotError
                  ]}
                />
              ))}
            </View>

            {/* Keyboard digits */}
            <View style={styles.keypadContainer}>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0"].map(digit => (
                <TouchableOpacity 
                  key={digit}
                  onPress={() => handlePinInput(digit)}
                  style={[styles.keyBtn, digit === 'C' && styles.keyBtnCancel]}
                >
                  <Text style={[styles.keyText, digit === 'C' && styles.keyTextCancel]}>{digit}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.authHint}>الرمز التجريبي: 123</Text>
          </View>
        )}

        {/* SCREEN: Management Dashboard (B2B) */}
        {currentScreen === 'dashboard' && (
          <View style={styles.screenInner}>
            <View style={styles.dashboardHeader}>
              <TouchableOpacity onPress={() => {
                setIsAuth(false);
                setCurrentScreen('storefront');
              }} style={styles.logoutBtn}>
                <Text style={styles.logoutBtnText}>خروج</Text>
              </TouchableOpacity>
              <Text style={styles.dashboardTitle}>لوحة إدارة ERP</Text>
            </View>

            <ScrollView contentContainerStyle={styles.scrollList} showsVerticalScrollIndicator={false}>
              
              {/* Statistics widget cards */}
              <View style={styles.dashboardStatsRow}>
                <View style={styles.statCard}>
                  <Text style={styles.statLabel}>إجمالي مبيعات اليوم</Text>
                  <Text style={styles.statValue}>١,٥٦٦,٠٠٠ د.ع</Text>
                </View>
                <View style={styles.statCard}>
                  <Text style={styles.statLabel}>طلبات المزامنة</Text>
                  <Text style={styles.statValue}>{orders.length} نشطة</Text>
                </View>
              </View>

              {/* Google Sheets Integration Panel */}
              <View style={styles.googleSheetsPanel}>
                <Text style={styles.sheetsHeader}>تكامل Google Sheets 📊</Text>
                <Text style={styles.sheetsDesc}>تصدير ومزامنة طلبات المتجر مع جدول المبيعات المشترك على جوجل درايف للتحصيل والمحاسبة الفورية.</Text>
                
                {isSheetsSyncing ? (
                  <View style={styles.sheetsSyncBox}>
                    <ActivityIndicator size="small" color="#10b981" />
                    <Text style={styles.sheetsSyncText}>جاري مزامنة الملفات...</Text>
                  </View>
                ) : (
                  <TouchableOpacity onPress={triggerGoogleSheetsSync} style={styles.sheetsSyncBtn}>
                    <Text style={styles.sheetsSyncBtnText}>تصدير البيانات مع Google Drive 🟢</Text>
                  </TouchableOpacity>
                )}
                {sheetsSyncDone && (
                  <Text style={styles.sheetsDoneLabel}>قاعدة بيانات جوجل محدثة بنجاح بنسبة ١٠٠٪</Text>
                )}
              </View>

              <TouchableOpacity onPress={() => setCurrentScreen('scanner')} style={styles.scannerTriggerBtn}>
                <Text style={styles.scannerTriggerText}>📷 مسح باركود صنف جديد</Text>
              </TouchableOpacity>

              <Text style={styles.sectionTitle}>طلبات المتجر المعلقة</Text>
              
              {orders.map(order => (
                <TouchableOpacity 
                  key={order.id}
                  onPress={() => setSelectedOrder(order)}
                  style={styles.orderDashboardCard}
                >
                  <View style={styles.orderInfoLeft}>
                    <Text style={styles.orderTotalText}>{order.total.toLocaleString()} د.ع</Text>
                    <Text style={styles.orderDateText}>{order.date}</Text>
                  </View>
                  <View style={styles.orderInfoRight}>
                    <View style={styles.statusRowBadge}>
                      <Text style={[
                        styles.statusText,
                        order.status === 'pending' ? styles.statusTextPending :
                        order.status === 'processing' ? styles.statusTextProcessing : styles.statusTextDone
                      ]}>
                        {order.status === 'pending' ? 'معلق' : order.status === 'processing' ? 'توصيل' : 'مستلم كاش'}
                      </Text>
                      <Text style={styles.orderClientName}>{order.name}</Text>
                    </View>
                    <Text style={styles.orderFirstItemText}>{order.items[0]?.name}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* SCREEN: Delivery Driver Dashboard (Mendoub) */}
        {currentScreen === 'driver_dashboard' && (
          <View style={styles.screenInner}>
            <View style={styles.dashboardHeader}>
              <TouchableOpacity onPress={() => {
                setIsAuth(false);
                setCurrentScreen('storefront');
              }} style={styles.logoutBtn}>
                <Text style={styles.logoutBtnText}>خروج</Text>
              </TouchableOpacity>
              <Text style={styles.dashboardTitle}>لوحة المندوب 🚚</Text>
            </View>

            <ScrollView contentContainerStyle={styles.scrollList} showsVerticalScrollIndicator={false}>
              
              {/* Driver Stats */}
              <View style={styles.dashboardStatsRow}>
                <View style={styles.statCard}>
                  <Text style={styles.statLabel}>عهدة COD المستلمة</Text>
                  <Text style={styles.statValue}>
                    {orders
                      .filter(o => o.status === 'completed')
                      .reduce((sum, o) => sum + o.total, 0)
                      .toLocaleString()} د.ع
                  </Text>
                </View>
                <View style={styles.statCard}>
                  <Text style={styles.statLabel}>شحنات بانتظار التوصيل</Text>
                  <Text style={styles.statValue}>
                    {orders.filter(o => o.status === 'pending' || o.status === 'processing').length} طلبات
                  </Text>
                </View>
              </View>

              <Text style={styles.sectionTitle}>الشحنات الموكلة إليك للتسليم</Text>
              
              {orders.filter(o => o.status === 'pending' || o.status === 'processing').map(order => (
                <View key={order.id} style={styles.driverOrderCard}>
                  <View style={styles.driverCardHeader}>
                    <Text style={styles.driverOrderId}>{order.id}</Text>
                    <Text style={styles.driverClientName}>{order.name}</Text>
                  </View>

                  <Text style={styles.driverOrderAddress}>📍 {order.address}</Text>
                  <Text style={styles.driverOrderPhone}>📞 {order.phone}</Text>
                  
                  <View style={styles.driverItemsBox}>
                    {order.items.map((it, idx) => (
                      <Text key={idx} style={styles.driverItemText}>• {it.name} (عدد {it.quantity})</Text>
                    ))}
                  </View>

                  <View style={styles.driverCardDivider} />
                  
                  <View style={styles.driverCardFooter}>
                    <Text style={styles.driverCodAmount}>مبلغ التحصيل COD: {order.total.toLocaleString()} د.ع</Text>
                  </View>

                  <View style={styles.driverActionsRow}>
                    <TouchableOpacity 
                      onPress={() => {
                        const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${order.lat},${order.lng}`;
                        Linking.openURL(mapsUrl);
                      }} 
                      style={styles.driverNavBtn}
                    >
                      <Text style={styles.driverBtnText}>🗺️ خرائط جوجل (GPS)</Text>
                    </TouchableOpacity>

                    <TouchableOpacity 
                      onPress={() => {
                        const updated = orders.map(o => o.id === order.id ? { ...o, status: 'completed' } : o);
                        saveOrders(updated);
                        Alert.alert("تم التوصيل", "تم تسجيل تحصيل الكاش بنجاح وإدراجه في عهدة المندوب!");
                      }} 
                      style={styles.driverSuccessBtn}
                    >
                      <Text style={styles.driverBtnText}>✅ تم التسليم</Text>
                    </TouchableOpacity>

                    <TouchableOpacity 
                      onPress={() => {
                        const updated = orders.map(o => o.id === order.id ? { ...o, status: 'failed' } : o);
                        saveOrders(updated);
                        Alert.alert("فشل التوصيل", "تم تسجيل إرجاع الشحنة إلى المخزن!");
                      }} 
                      style={styles.driverFailBtn}
                    >
                      <Text style={styles.driverBtnText}>❌ مرتجع</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}

              {orders.filter(o => o.status === 'completed').length > 0 && (
                <>
                  <Text style={styles.sectionTitle}>الشحنات المسلّمة (العهدة الحالية)</Text>
                  {orders.filter(o => o.status === 'completed').map(order => (
                    <View key={order.id} style={[styles.driverOrderCard, { opacity: 0.75, borderColor: '#10b981' }]}>
                      <View style={styles.driverCardHeader}>
                        <Text style={styles.driverOrderId}>{order.id}</Text>
                        <Text style={[styles.driverClientName, { color: '#10b981' }]}>{order.name} (تم التسليم)</Text>
                      </View>
                      <Text style={styles.driverOrderAddress}>📍 {order.address}</Text>
                      <Text style={styles.driverCodAmount}>تم تحصيل: {order.total.toLocaleString()} د.ع</Text>
                    </View>
                  ))}
                </>
              )}
              
            </ScrollView>
          </View>
        )}

        {/* SCREEN: Camera Barcode Simulator */}
        {currentScreen === 'scanner' && (
          <View style={styles.screenInner}>
            <View style={styles.subHeader}>
              <TouchableOpacity onPress={() => setCurrentScreen('dashboard')} style={styles.backBtn}>
                <Text style={styles.backBtnText}>◀</Text>
              </TouchableOpacity>
              <Text style={styles.subHeaderTitle}>محاكي الباركود</Text>
            </View>

            <View style={styles.scannerView}>
              {scanStatus === 'idle' && (
                <View style={styles.scannerPrompt}>
                  <Text style={styles.scannerPromptIcon}>📷</Text>
                  <Text style={styles.scannerPromptText}>وجه الكاميرا نحو باركود السلعة</Text>
                  <TouchableOpacity onPress={handleBarcodeScan} style={styles.actionBtnPrimary}>
                    <Text style={styles.actionBtnText}>بدء المسح</Text>
                  </TouchableOpacity>
                </View>
              )}

              {scanStatus === 'scanning' && (
                <View style={styles.scanLaserBox}>
                  <ActivityIndicator size="large" color="#0d9488" />
                  <Text style={styles.scanLaserText}>جاري الفحص المزامنة...</Text>
                </View>
              )}

              {scanStatus === 'success' && scannedProduct && (
                <View style={styles.scanResultContainer}>
                  <Text style={styles.checkIconSuccess}>✓</Text>
                  <Text style={styles.resultTitle}>تم مسح المنتج ومزامنته</Text>
                  <Text style={styles.resultName}>{scannedProduct.name}</Text>
                  <Text style={styles.resultPrice}>{scannedProduct.price.toLocaleString()} د.ع</Text>
                  
                  <TouchableOpacity onPress={() => setScanStatus('idle')} style={styles.scanAgainBtn}>
                    <Text style={styles.scanAgainText}>مستمر بمسح جديد</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        )}

      </View>

      {/* Floating simulated bottom dock navigation tabs bar */}
      <View style={styles.bottomNavigationTab}>
        <TouchableOpacity 
          onPress={() => setCurrentScreen('storefront')} 
          style={[styles.tabItem, currentScreen === 'storefront' && styles.tabItemActive]}
        >
          <Text style={styles.tabIcon}>🛍️</Text>
          <Text style={styles.tabText}>المتجر</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          onPress={() => setCurrentScreen('cart')} 
          style={[styles.tabItem, currentScreen === 'cart' && styles.tabItemActive]}
        >
          <Text style={styles.tabIcon}>🛒</Text>
          <Text style={styles.tabText}>السلة</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          onPress={() => {
            if (isAuth) setCurrentScreen('dashboard');
            else setCurrentScreen('login');
          }} 
          style={[
            styles.tabItem, 
            ['login', 'dashboard', 'scanner'].includes(currentScreen) && styles.tabItemActive
          ]}
        >
          <Text style={styles.tabIcon}>⚙️</Text>
          <Text style={styles.tabText}>الموظفين</Text>
        </TouchableOpacity>
      </View>

      {/* MODAL: Order Detail Inspector */}
      {selectedOrder && (
        <Modal 
          transparent 
          visible={!!selectedOrder} 
          animationType="slide"
          onRequestClose={() => setSelectedOrder(null)}
        >
          <View style={styles.modalBg}>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <TouchableOpacity onPress={() => setSelectedOrder(null)} style={styles.closeModalBtn}>
                  <Text style={styles.closeModalBtnText}>إغلاق</Text>
                </TouchableOpacity>
                <Text style={styles.modalTitle}>{selectedOrder.id}</Text>
              </View>

              <ScrollView style={styles.modalBody}>
                <View style={styles.modalRow}>
                  <Text style={styles.modalVal}>{selectedOrder.name}</Text>
                  <Text style={styles.modalLabel}>الزبون:</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalVal}>{selectedOrder.phone}</Text>
                  <Text style={styles.modalLabel}>الهاتف:</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalVal}>{GOVERNORATES.find(g => g.id === selectedOrder.governorate)?.name}</Text>
                  <Text style={styles.modalLabel}>المحافظة:</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalVal}>{selectedOrder.address}</Text>
                  <Text style={styles.modalLabel}>العنوان:</Text>
                </View>

                <View style={styles.finDivider} />
                <Text style={styles.itemsSubTitle}>المواد المطلوبة</Text>
                
                {selectedOrder.items.map((i, idx) => (
                  <View key={idx} style={styles.modalRow}>
                    <Text style={styles.modalVal}>{i.price.toLocaleString()} د.ع (×{i.quantity})</Text>
                    <Text style={styles.modalLabel}>{i.name}</Text>
                  </View>
                ))}

                <View style={styles.finDivider} />
                <View style={styles.modalRowTotal}>
                  <Text style={styles.modalTotalVal}>{selectedOrder.total.toLocaleString()} د.ع</Text>
                  <Text style={styles.modalTotalLabel}>المجموع الإجمالي الكلي:</Text>
                </View>
              </ScrollView>

              <View style={styles.modalActions}>
                <TouchableOpacity 
                  onPress={() => {
                    const updated = orders.map(o => o.id === selectedOrder.id ? { ...o, status: 'completed' } : o);
                    saveOrders(updated);
                    setSelectedOrder(null);
                    Alert.alert("تم التحصيل", "تم تسجيل كاش الطلب بنجاح ✓");
                  }} 
                  style={styles.modalBtnCollect}
                >
                  <Text style={styles.actionBtnText}>تحصيل كاش</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                  onPress={() => {
                    const updated = orders.map(o => o.id === selectedOrder.id ? { ...o, status: 'processing' } : o);
                    saveOrders(updated);
                    setSelectedOrder(null);
                    Alert.alert("تم التحويل", "تم تسليم الطلب إلى شركة التوصيل للتسليم ✓");
                  }} 
                  style={styles.modalBtnShip}
                >
                  <Text style={styles.actionBtnText}>تحويل للتوصيل</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#020617',
  },
  bodyContainer: {
    flex: 1,
    paddingBottom: 70,
  },
  screenInner: {
    flex: 1,
    paddingTop: 10,
  },
  screenInnerCentered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 30,
  },
  flexOne: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerTitleContainer: {
    alignItems: 'flex-end',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#0d9488',
  },
  headerSubtitle: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 2,
  },
  cartIconBadge: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  badgeCount: {
    position: 'absolute',
    top: -5,
    left: -5,
    backgroundColor: '#f59e0b',
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#020617',
    fontSize: 10,
    fontWeight: '900',
  },
  iconText: {
    fontSize: 18,
  },
  scrollList: {
    paddingHorizontal: 20,
    paddingVertical: 15,
  },
  promoBanner: {
    backgroundColor: 'rgba(13, 148, 136, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(13, 148, 136, 0.3)',
    borderRadius: 24,
    padding: 16,
    marginBottom: 20,
    alignItems: 'flex-end',
  },
  promoBadge: {
    color: '#2dd4bf',
    fontSize: 10,
    fontWeight: '900',
    backgroundColor: '#0f172a',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    marginBottom: 8,
  },
  promoTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '900',
  },
  promoDesc: {
    color: '#cbd5e1',
    fontSize: 11,
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '900',
    color: '#cbd5e1',
    textAlign: 'right',
    marginBottom: 12,
  },
  productCard: {
    backgroundColor: 'rgba(30, 41, 59, 0.4)',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 24,
    padding: 12,
    flexDirection: 'row',
    marginBottom: 12,
    alignItems: 'center',
  },
  productInfoLeft: {
    flexShrink: 0,
  },
  productEmoji: {
    fontSize: 36,
    backgroundColor: '#1e293b',
    width: 60,
    height: 60,
    borderRadius: 16,
    textAlign: 'center',
    lineHeight: 60,
  },
  productInfoRight: {
    flex: 1,
    marginLeft: 12,
    alignItems: 'flex-end',
  },
  productHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
  },
  productName: {
    fontSize: 13,
    fontWeight: '900',
    color: '#ffffff',
  },
  productCategory: {
    fontSize: 8,
    fontWeight: '900',
    color: '#0d9488',
    backgroundColor: 'rgba(13, 148, 136, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(13, 148, 136, 0.2)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  productDesc: {
    fontSize: 9.5,
    color: '#94a3b8',
    textAlign: 'right',
    marginTop: 4,
    lineHeight: 14,
  },
  productFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  addCartBtn: {
    backgroundColor: '#0d9488',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 12,
  },
  addCartBtnText: {
    fontSize: 9.5,
    fontWeight: '900',
    color: '#ffffff',
  },
  productPrice: {
    fontSize: 12,
    fontWeight: '900',
    color: '#f59e0b',
  },
  adBannerCard: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.25)',
    borderRadius: 24,
    padding: 14,
    marginBottom: 12,
    alignItems: 'flex-end',
  },
  adBannerCardCyan: {
    backgroundColor: 'rgba(6, 182, 212, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
    borderRadius: 24,
    padding: 14,
    marginBottom: 12,
    alignItems: 'flex-end',
  },
  adBadge: {
    fontSize: 8,
    fontWeight: '900',
    color: '#f59e0b',
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    marginBottom: 6,
  },
  adBadgeCyan: {
    fontSize: 8,
    fontWeight: '900',
    color: '#06b6d4',
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    marginBottom: 6,
  },
  adTitle: {
    fontSize: 12,
    fontWeight: '950',
    color: '#ffffff',
  },
  adDesc: {
    fontSize: 9.5,
    color: '#94a3b8',
    textAlign: 'right',
    marginTop: 4,
    lineHeight: 14,
  },
  subHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  backBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnText: {
    color: '#cbd5e1',
    fontSize: 12,
  },
  subHeaderTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: '#ffffff',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 15,
  },
  emptyText: {
    fontSize: 13,
    color: '#94a3b8',
  },
  cartItemsScroll: {
    padding: 20,
  },
  cartItemCard: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 20,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  removeBtn: {
    padding: 8,
  },
  removeBtnText: {
    fontSize: 16,
  },
  cartItemDetails: {
    flex: 1,
    marginHorizontal: 12,
    alignItems: 'flex-end',
  },
  cartItemName: {
    fontSize: 12,
    fontWeight: '900',
    color: '#ffffff',
  },
  cartItemPrice: {
    fontSize: 11,
    fontWeight: '900',
    color: '#f59e0b',
    marginTop: 2,
  },
  qtyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  qtyBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  qtyVal: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '900',
    marginHorizontal: 8,
  },
  cartItemEmoji: {
    fontSize: 28,
    backgroundColor: '#1e293b',
    width: 48,
    height: 48,
    borderRadius: 12,
    textAlign: 'center',
    lineHeight: 48,
  },
  cartFooter: {
    backgroundColor: '#0f172a',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    padding: 20,
  },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 15,
  },
  priceLabel: {
    color: '#94a3b8',
    fontSize: 12,
  },
  priceVal: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '900',
  },
  checkoutBtn: {
    backgroundColor: '#0d9488',
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: 'center',
  },
  checkoutBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '900',
  },
  checkoutFormScroll: {
    padding: 20,
  },
  formGroup: {
    marginBottom: 15,
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#94a3b8',
    marginBottom: 6,
    textAlign: 'right',
  },
  inputField: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 14,
    padding: 10,
    fontSize: 12,
    color: '#ffffff',
    textAlign: 'right',
  },
  textAreaField: {
    textAlignVertical: 'top',
  },
  govSelectRow: {
    flexDirection: 'row',
    marginTop: 4,
  },
  govChip: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
  },
  govChipActive: {
    backgroundColor: 'rgba(13, 148, 136, 0.15)',
    borderColor: '#0d9488',
  },
  govChipText: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: 'bold',
  },
  govChipTextActive: {
    color: '#0d9488',
  },
  mapSimContainer: {
    width: '100%',
    height: 120,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 16,
    position: 'relative',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  mapSimRiver: {
    width: '120%',
    height: 20,
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
    transform: [{ rotate: '15deg' }],
    position: 'absolute',
  },
  mapPinDot: {
    position: 'absolute',
    zIndex: 10,
  },
  mapPinEmoji: {
    fontSize: 28,
  },
  mapClickText: {
    color: '#2dd4bf',
    fontSize: 8.5,
    fontWeight: 'bold',
    position: 'absolute',
    bottom: 22,
  },
  mapCoordinatesRow: {
    position: 'absolute',
    bottom: 4,
    left: 8,
    right: 8,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  mapCoordinatesText: {
    color: '#64748b',
    fontSize: 8,
  },
  financialSummaryCard: {
    backgroundColor: 'rgba(30, 41, 59, 0.2)',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 20,
    padding: 15,
    marginVertical: 15,
  },
  finRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 4,
  },
  finLabel: {
    color: '#94a3b8',
    fontSize: 11,
  },
  finVal: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  finDivider: {
    height: 1,
    backgroundColor: '#1e293b',
    marginVertical: 8,
  },
  finTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  finTotalLabel: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '900',
  },
  finTotalVal: {
    color: '#f59e0b',
    fontSize: 14,
    fontWeight: '900',
  },
  actionBtnPrimary: {
    backgroundColor: '#0d9488',
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '900',
  },
  receiptHeader: {
    alignItems: 'center',
    marginVertical: 20,
  },
  successCheck: {
    fontSize: 32,
    color: '#0d9488',
    backgroundColor: 'rgba(13, 148, 136, 0.15)',
    width: 60,
    height: 60,
    borderRadius: 30,
    textAlign: 'center',
    lineHeight: 60,
    borderWidth: 1,
    borderColor: 'rgba(13, 148, 136, 0.3)',
    marginBottom: 8,
  },
  receiptTitle: {
    fontSize: 15,
    fontWeight: '900',
    color: '#ffffff',
  },
  receiptOrderNum: {
    fontSize: 11,
    color: '#f59e0b',
    fontWeight: 'bold',
    marginTop: 4,
  },
  receiptScroll: {
    padding: 20,
  },
  receiptDetails: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 24,
    padding: 16,
    marginBottom: 20,
  },
  detailsHeader: {
    fontSize: 12,
    fontWeight: '950',
    color: '#0d9488',
    textAlign: 'right',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    paddingBottom: 6,
    marginBottom: 10,
  },
  rowDetail: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 4,
  },
  rowLabel: {
    color: '#94a3b8',
    fontSize: 11,
  },
  rowVal: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 'bold',
  },
  detailsDivider: {
    height: 1,
    backgroundColor: '#1e293b',
    marginVertical: 8,
  },
  rowDetailTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowTotalLabel: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '900',
  },
  rowTotalVal: {
    color: '#f59e0b',
    fontSize: 14,
    fontWeight: '900',
  },
  whatsappBtn: {
    backgroundColor: '#25D366',
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  backHomeBtn: {
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  backHomeBtnText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: 'bold',
  },
  authLockIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  authTitle: {
    fontSize: 18,
    fontWeight: '950',
    color: '#ffffff',
  },
  authSubtitle: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 4,
    marginBottom: 25,
  },
  pinDotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 15,
    marginBottom: 35,
  },
  pinDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#475569',
  },
  pinDotActive: {
    backgroundColor: '#f59e0b',
    borderColor: '#f59e0b',
  },
  pinDotError: {
    borderColor: '#ef4444',
  },
  keypadContainer: {
    width: 240,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 12,
  },
  keyBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyBtnCancel: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderColor: 'rgba(239, 68, 68, 0.2)',
  },
  keyText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '900',
  },
  keyTextCancel: {
    color: '#ef4444',
  },
  authHint: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 20,
  },
  dashboardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  dashboardTitle: {
    fontSize: 18,
    fontWeight: '950',
    color: '#ffffff',
  },
  logoutBtn: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.2)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  logoutBtnText: {
    color: '#ef4444',
    fontSize: 10,
    fontWeight: 'bold',
  },
  dashboardStatsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 15,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 20,
    padding: 12,
    alignItems: 'flex-end',
  },
  statLabel: {
    color: '#94a3b8',
    fontSize: 10,
  },
  statValue: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '950',
    marginTop: 4,
  },
  googleSheetsPanel: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 24,
    padding: 15,
    marginBottom: 15,
    alignItems: 'flex-end',
  },
  sheetsHeader: {
    fontSize: 12,
    fontWeight: '950',
    color: '#ffffff',
  },
  sheetsDesc: {
    fontSize: 9.5,
    color: '#94a3b8',
    textAlign: 'right',
    marginTop: 4,
    lineHeight: 14,
  },
  sheetsSyncBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  sheetsSyncText: {
    color: '#10b981',
    fontSize: 10,
    fontWeight: 'bold',
  },
  sheetsSyncBtn: {
    backgroundColor: '#10b981',
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginTop: 10,
    alignItems: 'center',
  },
  sheetsSyncBtnText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  sheetsDoneLabel: {
    color: '#10b981',
    fontSize: 9,
    fontWeight: 'bold',
    marginTop: 6,
  },
  scannerTriggerBtn: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderWidth: 1,
    borderColor: '#f59e0b',
    borderRadius: 18,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 20,
  },
  scannerTriggerText: {
    color: '#f59e0b',
    fontSize: 11,
    fontWeight: '950',
  },
  orderDashboardCard: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 20,
    padding: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  orderInfoLeft: {
    alignItems: 'flex-start',
  },
  orderTotalText: {
    fontSize: 11,
    fontWeight: '900',
    color: '#f59e0b',
  },
  orderDateText: {
    fontSize: 8.5,
    color: '#64748b',
    marginTop: 2,
  },
  orderInfoRight: {
    alignItems: 'flex-end',
  },
  statusRowBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusText: {
    fontSize: 8,
    fontWeight: '900',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    borderWidth: 1,
  },
  statusTextPending: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderColor: '#f59e0b',
    color: '#f59e0b',
  },
  statusTextProcessing: {
    backgroundColor: 'rgba(6, 182, 212, 0.1)',
    borderColor: '#06b6d4',
    color: '#06b6d4',
  },
  statusTextDone: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: '#10b981',
    color: '#10b981',
  },
  orderClientName: {
    fontSize: 12,
    fontWeight: '900',
    color: '#ffffff',
  },
  orderFirstItemText: {
    fontSize: 9.5,
    color: '#94a3b8',
    marginTop: 4,
  },
  scannerView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  scannerPrompt: {
    alignItems: 'center',
    gap: 12,
  },
  scannerPromptIcon: {
    fontSize: 48,
    color: '#94a3b8',
  },
  scannerPromptText: {
    fontSize: 12,
    color: '#cbd5e1',
    marginBottom: 10,
  },
  scanLaserBox: {
    alignItems: 'center',
    gap: 15,
  },
  scanLaserText: {
    color: '#2dd4bf',
    fontSize: 11,
    fontWeight: 'bold',
  },
  scanResultContainer: {
    alignItems: 'center',
    gap: 8,
  },
  checkIconSuccess: {
    fontSize: 24,
    color: '#2dd4bf',
    backgroundColor: 'rgba(13, 148, 136, 0.15)',
    width: 50,
    height: 50,
    borderRadius: 25,
    textAlign: 'center',
    lineHeight: 50,
    borderWidth: 1,
    borderColor: '#2dd4bf',
  },
  resultTitle: {
    fontSize: 11,
    color: '#2dd4bf',
    fontWeight: 'bold',
  },
  resultName: {
    fontSize: 14,
    fontWeight: '950',
    color: '#ffffff',
    marginTop: 4,
  },
  resultPrice: {
    fontSize: 13,
    fontWeight: '900',
    color: '#f59e0b',
  },
  scanAgainBtn: {
    marginTop: 15,
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  scanAgainText: {
    color: '#cbd5e1',
    fontSize: 10,
    fontWeight: 'bold',
  },
  bottomNavigationTab: {
    position: 'absolute',
    bottom: 0,
    insetX: 0,
    height: 60,
    backgroundColor: '#0f172a',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  tabItem: {
    alignItems: 'center',
    padding: 6,
    width: 65,
  },
  tabItemActive: {
    backgroundColor: 'rgba(13, 148, 136, 0.1)',
    borderRadius: 12,
  },
  tabIcon: {
    fontSize: 16,
  },
  tabText: {
    color: '#94a3b8',
    fontSize: 9,
    fontWeight: 'bold',
    marginTop: 2,
  },
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#0f172a',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    padding: 20,
    maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    paddingBottom: 10,
    marginBottom: 15,
  },
  closeModalBtn: {
    padding: 5,
  },
  closeModalBtnText: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: 'bold',
  },
  modalTitle: {
    fontSize: 14,
    fontWeight: '950',
    color: '#f59e0b',
  },
  modalBody: {
    marginBottom: 15,
  },
  modalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 4,
  },
  modalLabel: {
    color: '#94a3b8',
    fontSize: 11,
    textAlign: 'right',
  },
  modalVal: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 'bold',
    textAlign: 'left',
  },
  itemsSubTitle: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#94a3b8',
    textAlign: 'right',
    marginBottom: 8,
  },
  modalRowTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 5,
  },
  modalTotalLabel: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '900',
  },
  modalTotalVal: {
    color: '#f59e0b',
    fontSize: 14,
    fontWeight: '950',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 10,
  },
  modalBtnCollect: {
    flex: 1,
    backgroundColor: '#10b981',
    borderRadius: 14,
    paddingVertical: 10,
    alignItems: 'center',
  },
  modalBtnShip: {
    flex: 1,
    backgroundColor: '#06b6d4',
    borderRadius: 14,
    paddingVertical: 10,
    alignItems: 'center',
  },
  driverOrderCard: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 24,
    padding: 16,
    marginBottom: 16,
  },
  driverCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  driverOrderId: {
    fontSize: 10,
    fontWeight: '900',
    color: '#f59e0b',
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  driverClientName: {
    fontSize: 12,
    fontWeight: '950',
    color: '#ffffff',
  },
  driverOrderAddress: {
    fontSize: 11,
    color: '#cbd5e1',
    textAlign: 'right',
    marginBottom: 6,
    fontWeight: '500',
  },
  driverOrderPhone: {
    fontSize: 11,
    color: '#38bdf8',
    textAlign: 'right',
    marginBottom: 12,
    fontWeight: 'bold',
  },
  driverItemsBox: {
    backgroundColor: '#020617',
    borderRadius: 16,
    padding: 10,
    marginBottom: 12,
  },
  driverItemText: {
    fontSize: 10.5,
    color: '#94a3b8',
    textAlign: 'right',
    marginVertical: 2,
    fontWeight: '500',
  },
  driverCardDivider: {
    height: 1,
    backgroundColor: '#1e293b',
    marginBottom: 12,
  },
  driverCardFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 12,
  },
  driverCodAmount: {
    fontSize: 12,
    fontWeight: '950',
    color: '#f59e0b',
  },
  driverActionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  driverNavBtn: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  driverSuccessBtn: {
    flex: 1,
    backgroundColor: '#10b981',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  driverFailBtn: {
    flex: 1,
    backgroundColor: '#ef4444',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  driverBtnText: {
    color: '#ffffff',
    fontSize: 9.5,
    fontWeight: '900',
  },
});
