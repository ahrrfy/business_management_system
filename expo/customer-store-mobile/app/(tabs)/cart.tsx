import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Image } from "expo-image";
import { router } from "expo-router";
import {
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useCart } from "@/lib/cart-context";
import { selectionDescription } from "@/lib/product-selection";
import {
  formatIqd,
  formatLatinNumber,
  productDiscountPercent,
  useStorefrontSettings,
} from "@/lib/storefront-api";
import { storefrontDesign } from "@/lib/storefront-design";
import type { Product } from "@/shared/storefront";

const IMPULSE_ADDONS: Product[] = [
  {
    id: "addon-highlighters",
    productId: 9901,
    productUnitId: 9901,
    title: "طقم أقلام تظليل باستيل",
    subtitle: "4 ألوان ناعمة",
    categoryId: "stationery",
    description: "أقلام تظليل لطيفة على الورق وسريعة الجفاف",
    icon: "brush",
    accent: "#FEF3C7",
    availability: "متوفر",
    price: "2500",
    inStock: true,
  },
  {
    id: "addon-stickynotes",
    productId: 9902,
    productUnitId: 9902,
    title: "أوراق ملاحظات لاصقة",
    subtitle: "100 ورقة ملونة",
    categoryId: "stationery",
    description: "مثالية لتنظيم الملاحظات وتحديد الصفحات",
    icon: "note",
    accent: "#E0F2FE",
    availability: "متوفر",
    price: "1500",
    inStock: true,
  },
  {
    id: "addon-correction",
    productId: 9903,
    productUnitId: 9903,
    title: "شريط تصحيح ياباني 12م",
    subtitle: "شريط أبيض فوري",
    categoryId: "stationery",
    description: "تغطية كاملة وجافة فورية بدون تلطيخ",
    icon: "edit",
    accent: "#FCE7F3",
    availability: "متوفر",
    price: "2000",
    inStock: true,
  },
  {
    id: "addon-pocketbook",
    productId: 9904,
    productUnitId: 9904,
    title: "دفتر جيب شبكي فاخر",
    subtitle: "80 ورقة مقوى",
    categoryId: "stationery",
    description: "غلاف مرن أنيق وورق عالي الجودة للتدوين السريع",
    icon: "menu-book",
    accent: "#DCFCE7",
    availability: "متوفر",
    price: "3000",
    inStock: true,
  },
];

export default function CartScreen() {
  const { addProduct, decrement, increment, isRestoring, lines, remove } = useCart();
  const settings = useStorefrontSettings();
  const estimatedSubtotal = lines.reduce(
    (sum, line) =>
      sum +
      Number(
        line.selectionDetails.unitSalePrice ??
          line.selectionDetails.unitPrice ??
          0,
      ) *
        line.quantity,
    0,
  );
  const savedAmount = lines.reduce(
    (sum, line) =>
      sum +
      Math.max(
        0,
        Number(line.selectionDetails.unitPrice ?? 0) -
          Number(
            line.selectionDetails.unitSalePrice ??
              line.selectionDetails.unitPrice ??
              0,
          ),
      ) *
        line.quantity,
    0,
  );
  const freeShippingThreshold = Number(settings?.freeShippingThreshold ?? 0);
  const shippingProgress =
    freeShippingThreshold > 0
      ? Math.min(1, estimatedSubtotal / freeShippingThreshold)
      : 0;
  const shippingRemaining = Math.max(
    0,
    freeShippingThreshold - estimatedSubtotal,
  );
  const totalItemCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  const shareCartViaWhatsApp = async () => {
    if (lines.length === 0) return;
    const rawNumber = settings?.whatsappNumber?.replace(/\D/g, "") || "";
    let message = "مرحباً مكتبة العربية، أود مراجعة هذه السلة والطلب عبركم:\n";
    lines.forEach((line, index) => {
      const price = line.selectionDetails.unitSalePrice ?? line.selectionDetails.unitPrice;
      message += `${index + 1}. ${line.product.title} (${selectionDescription(line.selectionDetails)}) - الكمية: ${line.quantity} ${price ? `- السعر: ${formatIqd(price)}` : ""}\n`;
    });
    message += `الإجمالي التقديري: ${formatIqd(estimatedSubtotal)}\nالدفع: عند الاستلام.`;
    const url = rawNumber
      ? `https://wa.me/${rawNumber}?text=${encodeURIComponent(message)}`
      : `https://wa.me/?text=${encodeURIComponent(message)}`;
    try {
      const can = await Linking.canOpenURL(url);
      if (can) await Linking.openURL(url);
      else Alert.alert("واتساب", "تأكد من وجود تطبيق واتساب على جهازك لمشاركة السلة.");
    } catch {
      Alert.alert("واتساب", "تعذر فتح تطبيق واتساب حالياً.");
    }
  };

  if (isRestoring)
    return (
      <ScreenContainer className="px-4" containerClassName="bg-background">
        <Text style={styles.title}>سلة المشتريات</Text>
        <View style={styles.empty}>
          <View style={styles.emptyIcon}>
            <MaterialIcons color="#0C5A4B" name="sync" size={38} />
          </View>
          <Text style={styles.emptyTitle}>جار استعادة سلتك…</Text>
        </View>
      </ScreenContainer>
    );
  if (!lines.length)
    return (
      <ScreenContainer className="px-4" containerClassName="bg-background">
        <ScrollView contentContainerStyle={styles.emptyScroll}>
          <Text style={styles.title}>سلة المشتريات</Text>
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <MaterialIcons color="#0C5A4B" name="shopping-bag" size={39} />
            </View>
            <Text style={styles.emptyTitle}>السلة تنتظر اختياراتك</Text>
            <Text style={styles.emptyText}>
              استكشف الكتب والقرطاسية وأضف ما تحتاجه، وستبقى اختياراتك محفوظة.
            </Text>
            <TouchableOpacity
              activeOpacity={0.88}
              onPress={() => router.push("/categories" as never)}
              style={styles.browse}
            >
              <Text style={styles.browseText}>ابدأ التسوق</Text>
              <MaterialIcons color="#FFFFFF" name="arrow-back" size={18} />
            </TouchableOpacity>
          </View>
        </ScrollView>
      </ScreenContainer>
    );
  return (
    <ScreenContainer className="flex-1" containerClassName="bg-background">
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>سلة المشتريات</Text>
            <Text style={styles.subtitle}>
              {formatLatinNumber(lines.length)} اختيارات جاهزة للمراجعة
            </Text>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            activeOpacity={0.8}
            onPress={() => router.push("/categories" as never)}
            style={styles.continueButton}
          >
            <MaterialIcons
              color={storefrontDesign.semantic.brandStrong}
              name="add"
              size={18}
            />
            <Text style={styles.continueText}>إضافة منتجات</Text>
          </TouchableOpacity>
        </View>
        {freeShippingThreshold > 0 && (
          <View style={styles.shippingCard}>
            <View style={styles.shippingTop}>
              <View>
                <Text style={styles.shippingTitle}>
                  {shippingRemaining > 0
                    ? "اقتربت من التوصيل المجاني"
                    : "أصبح طلبك مؤهلاً للتوصيل المجاني"}
                </Text>
                <Text style={styles.shippingHint}>
                  {shippingRemaining > 0
                    ? `متبقي ${formatIqd(shippingRemaining)}`
                    : "تم احتساب الميزة في السلة"}
                </Text>
              </View>
              <View style={styles.shippingIcon}>
                <MaterialIcons
                  color={storefrontDesign.semantic.brandStrong}
                  name="local-shipping"
                  size={20}
                />
              </View>
            </View>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressValue,
                  { width: `${shippingProgress * 100}%` },
                ]}
              />
            </View>
          </View>
        )}

        {/* سد فجوة التوصيل المجاني إذا كان الفارق 5000 دينار أو أقل */}
        {freeShippingThreshold > 0 && shippingRemaining > 0 && shippingRemaining <= 5000 && (
          <View style={styles.gapFillerCard}>
            <View style={styles.gapFillerHeader}>
              <View style={styles.gapFillerBadge}>
                <MaterialIcons color="#15803D" name="offline-bolt" size={16} />
                <Text style={styles.gapFillerBadgeText}>وفر أجور الشحن</Text>
              </View>
              <Text style={styles.gapFillerRemaining}>
                متبقي {formatIqd(shippingRemaining)} فقط
              </Text>
            </View>
            <Text style={styles.gapFillerTitle}>
              سد فجوة التوصيل المجاني بأصناف مفيدة
            </Text>
            <Text style={styles.gapFillerSubtitle}>
              بدلاً من دفع أجور التوصيل، أضف أحد هذه الأصناف واحصل على شحن مجاني
            </Text>

            <ScrollView
              contentContainerStyle={styles.gapFillerList}
              horizontal
              showsHorizontalScrollIndicator={false}
            >
              {IMPULSE_ADDONS.map((addon) => (
                <View key={addon.id} style={styles.gapFillerItem}>
                  <View style={[styles.gapFillerIconBox, { backgroundColor: addon.accent }]}>
                    <MaterialIcons
                      color={storefrontDesign.semantic.brandStrong}
                      name={addon.icon}
                      size={22}
                    />
                  </View>
                  <Text numberOfLines={1} style={styles.gapFillerItemTitle}>
                    {addon.title}
                  </Text>
                  <Text style={styles.gapFillerItemPrice}>
                    {formatIqd(Number(addon.price ?? 0))}
                  </Text>
                  <TouchableOpacity
                    accessibilityHint="يضيف الصنف فورياً لسلتك للتأهل للشحن المجاني"
                    accessibilityLabel={`أضف ${addon.title} للسلة`}
                    accessibilityRole="button"
                    activeOpacity={0.82}
                    onPress={() => addProduct(addon)}
                    style={styles.gapFillerAddBtn}
                  >
                    <MaterialIcons color="#FFFFFF" name="add" size={16} />
                    <Text style={styles.gapFillerAddBtnText}>أضف</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        {/* مؤشر خصم الجملة لسلة التسوق */}
        <View style={totalItemCount >= 12 ? styles.wholesaleQualifiedCard : styles.wholesaleProgressCard}>
          <MaterialIcons
            color={totalItemCount >= 12 ? "#15803D" : "#B45309"}
            name={totalItemCount >= 12 ? "verified" : "store"}
            size={18}
          />
          <View style={styles.wholesaleTextWrap}>
            <Text style={totalItemCount >= 12 ? styles.wholesaleQualifiedTitle : styles.wholesaleProgressTitle}>
              {totalItemCount >= 12
                ? "مؤهل لخصم الجملة (أكثر من 12 قطعة في السلة)"
                : `خصم الجملة يبدأ من 12 قطعة (لديك ${formatLatinNumber(totalItemCount)})`}
            </Text>
            <Text style={styles.wholesaleProgressDesc}>
              {totalItemCount >= 12
                ? "تم تفعيل تسعير الجملة المخفض على طلبك وسيتم تأكيده في الفاتورة النهائية."
                : `أضف ${formatLatinNumber(12 - totalItemCount)} قطع إضافية لتفعيل أسعار الجملة ووفر حتى 25% على طلبك.`}
            </Text>
          </View>
        </View>

        <View style={styles.lines}>
          {lines.map((line) => {
            const originalPrice = line.selectionDetails.unitPrice;
            const salePrice = line.selectionDetails.unitSalePrice;
            const discount = productDiscountPercent({
              ...line.product,
              price: originalPrice,
              salePrice,
            });
            return (
              <View key={line.lineId} style={styles.line}>
                <View
                  style={[
                    styles.productVisual,
                    { backgroundColor: line.product.accent },
                  ]}
                >
                  {line.selectionDetails.imageUrl ? (
                    <Image
                      contentFit="cover"
                      source={line.selectionDetails.imageUrl}
                      style={styles.productImage}
                    />
                  ) : (
                    <MaterialIcons
                      color={storefrontDesign.semantic.brandStrong}
                      name={line.product.icon}
                      size={29}
                    />
                  )}
                </View>
                <View style={styles.lineMain}>
                  <View style={styles.lineTop}>
                    <View style={styles.lineText}>
                      <Text numberOfLines={1} style={styles.lineTitle}>
                        {line.product.title}
                      </Text>
                      <Text numberOfLines={3} style={styles.lineSub}>
                        {selectionDescription(line.selectionDetails)}
                      </Text>
                    </View>
                    <TouchableOpacity
                      accessibilityLabel={`حذف ${line.product.title}`}
                      accessibilityRole="button"
                      activeOpacity={0.8}
                      onPress={() =>
                        Alert.alert(
                          "حذف من السلة",
                          `هل تريد حذف ${line.product.title}؟`,
                          [
                            { text: "إلغاء", style: "cancel" },
                            {
                              text: "حذف",
                              style: "destructive",
                              onPress: () => remove(line.lineId),
                            },
                          ],
                        )
                      }
                      style={styles.delete}
                    >
                      <MaterialIcons
                        color="#B64B24"
                        name="delete-outline"
                        size={20}
                      />
                    </TouchableOpacity>
                  </View>
                  <View style={styles.lineBottom}>
                    <View>
                      <Text style={styles.linePrice}>
                        {formatIqd(salePrice ?? originalPrice)}
                      </Text>
                      {discount != null && (
                        <Text style={styles.oldPrice}>
                          {formatIqd(originalPrice)}
                        </Text>
                      )}
                    </View>
                    <View style={styles.controls}>
                      <TouchableOpacity
                        accessibilityLabel={`زيادة كمية ${line.product.title}`}
                        accessibilityRole="button"
                        accessibilityState={{
                          disabled: line.quantity >= line.maxQuantity,
                        }}
                        activeOpacity={0.82}
                        disabled={line.quantity >= line.maxQuantity}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        onPress={() => increment(line.lineId)}
                        style={[
                          styles.control,
                          line.quantity >= line.maxQuantity &&
                            styles.controlDisabled,
                        ]}
                      >
                        <MaterialIcons
                          color={storefrontDesign.semantic.brandStrong}
                          name="add"
                          size={20}
                        />
                      </TouchableOpacity>
                      <Text
                        style={styles.quantity}
                        accessibilityLabel={`الكمية ${formatLatinNumber(line.quantity)}`}
                      >
                        {formatLatinNumber(line.quantity)}
                      </Text>
                      <TouchableOpacity
                        accessibilityLabel={`إنقاص كمية ${line.product.title}`}
                        accessibilityRole="button"
                        activeOpacity={0.82}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        onPress={() => decrement(line.lineId)}
                        style={styles.control}
                      >
                        <MaterialIcons
                          color={storefrontDesign.semantic.brandStrong}
                          name="remove"
                          size={20}
                        />
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
        <View style={styles.summary}>
          <Text style={styles.summaryTitle}>ملخص الطلب</Text>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryValue}>
              {formatIqd(estimatedSubtotal)}
            </Text>
            <Text style={styles.summaryLabel}>إجمالي المنتجات</Text>
          </View>
          {savedAmount > 0 && (
            <View style={styles.summaryRow}>
              <Text style={styles.savings}>{formatIqd(savedAmount)}</Text>
              <Text style={styles.summaryLabel}>التوفير الحالي</Text>
            </View>
          )}
          <View style={styles.divider} />
          <View style={styles.summaryRow}>
            <Text style={styles.total}>{formatIqd(estimatedSubtotal)}</Text>
            <Text style={styles.totalLabel}>الإجمالي المبدئي</Text>
          </View>
          <Text style={styles.summaryNote}>
            تظهر رسوم التوصيل والإجمالي النهائي بوضوح بعد اختيار المحافظة في
            الخطوة التالية.
          </Text>
        </View>
        <View style={styles.trust}>
          <MaterialIcons color="#0C5A4B" name="verified-user" size={20} />
          <Text style={styles.trustText}>
            السعر النهائي يعاد احتسابه من نظام مكتبة العربية قبل تأكيد الطلب.
          </Text>
        </View>
        <TouchableOpacity
          accessibilityLabel="تابع لإتمام الطلب"
          accessibilityRole="button"
          activeOpacity={0.88}
          onPress={() => router.push("/checkout" as never)}
          style={styles.checkout}
        >
          <Text style={styles.checkoutText}>تابع لإتمام الطلب (الدفع عند الاستلام)</Text>
          <MaterialIcons color="#FFFFFF" name="arrow-back" size={20} />
        </TouchableOpacity>

        <TouchableOpacity
          accessibilityLabel="مشاركة السلة عبر واتساب"
          accessibilityRole="button"
          activeOpacity={0.88}
          onPress={shareCartViaWhatsApp}
          style={styles.shareWhatsAppBtn}
        >
          <MaterialIcons color="#157347" name="chat" size={18} />
          <Text style={styles.shareWhatsAppText}>مشاركة السلة عبر واتساب</Text>
        </TouchableOpacity>

        <Text style={styles.footerNote}>
          لن يتم إنشاء أي طلب قبل مراجعة بياناتك وتأكيده.
        </Text>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 108 },
  emptyScroll: { flexGrow: 1, paddingTop: 7 },
  header: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingTop: 7,
  },
  title: {
    color: "#161A22",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 25,
    textAlign: "right",
  },
  subtitle: {
    color: "#737B88",
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    marginTop: 2,
    textAlign: "right",
  },
  continueButton: {
    alignItems: "center",
    backgroundColor: "#ECFDF5",
    borderColor: "#A7F3D0",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  continueText: {
    color: "#059669",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 10,
  },
  shippingCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 20,
    borderWidth: 1,
    marginTop: 18,
    padding: 16,
    shadowColor: "#0F172A",
    shadowOpacity: 0.03,
    shadowRadius: 8,
    elevation: 1,
  },
  shippingTop: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  shippingIcon: {
    alignItems: "center",
    backgroundColor: "#ECFDF5",
    borderRadius: 14,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  shippingTitle: {
    color: "#0F172A",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 13,
    textAlign: "right",
  },
  shippingHint: {
    color: "#059669",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
    marginTop: 3,
    textAlign: "right",
  },
  progressTrack: {
    backgroundColor: "#F1F5F9",
    borderRadius: 10,
    height: 8,
    marginTop: 12,
    overflow: "hidden",
  },
  progressValue: {
    backgroundColor: "#059669",
    borderRadius: 10,
    height: "100%",
  },
  lines: { gap: 11, marginTop: 16 },
  line: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E7EF",
    borderRadius: 22,
    borderWidth: 1,
    flexDirection: "row-reverse",
    padding: 11,
  },
  productVisual: {
    alignItems: "center",
    borderRadius: 15,
    height: 74,
    justifyContent: "center",
    overflow: "hidden",
    width: 66,
  },
  productImage: { height: "100%", width: "100%" },
  lineMain: { flex: 1, marginRight: 10 },
  lineTop: {
    alignItems: "flex-start",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  lineText: { flex: 1 },
  lineTitle: {
    color: "#161A22",
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    textAlign: "right",
  },
  lineSub: {
    color: "#737B88",
    fontFamily: "Cairo_400Regular",
    fontSize: 10,
    marginTop: 4,
    textAlign: "right",
  },
  delete: { marginRight: 7, padding: 2 },
  lineBottom: {
    alignItems: "flex-end",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginTop: 10,
  },
  linePrice: {
    color: "#059669",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 15,
    textAlign: "right",
  },
  oldPrice: {
    color: "#A6AFBA",
    fontFamily: "Cairo_400Regular",
    fontSize: 10,
    marginTop: 2,
    textAlign: "right",
    textDecorationLine: "line-through",
  },
  controls: {
    alignItems: "center",
    backgroundColor: "#F8FAFC",
    borderColor: "#E2E8F0",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    padding: 2,
  },
  control: {
    alignItems: "center",
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  quantity: {
    color: "#0F172A",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 14,
    minWidth: 28,
    textAlign: "center",
  },
  controlDisabled: { opacity: 0.35 },
  summary: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 24,
    borderWidth: 1,
    marginTop: 20,
    padding: 18,
    shadowColor: "#0F172A",
    shadowOpacity: 0.03,
    shadowRadius: 10,
    elevation: 1,
  },
  summaryTitle: {
    color: "#0F172A",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 16,
    marginBottom: 12,
    textAlign: "right",
  },
  summaryRow: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginTop: 10,
  },
  summaryLabel: {
    color: "#64748B",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
  },
  summaryValue: { color: "#0F172A", fontFamily: "Cairo_700Bold", fontSize: 14 },
  savings: { color: "#059669", fontFamily: "Cairo_800ExtraBold", fontSize: 14 },
  divider: { backgroundColor: "#E2E8F0", height: 1, marginTop: 14 },
  total: {
    color: "#059669",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 20,
    marginTop: 4,
  },
  totalLabel: {
    color: "#0F172A",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 15,
    marginTop: 6,
  },
  summaryNote: {
    color: "#6D817A",
    fontFamily: "Cairo_400Regular",
    fontSize: 10,
    lineHeight: 16,
    marginTop: 12,
    textAlign: "right",
  },
  trust: {
    alignItems: "flex-start",
    backgroundColor: "#E7F4FE",
    borderRadius: 18,
    flexDirection: "row-reverse",
    gap: 8,
    marginTop: 12,
    padding: 12,
  },
  trustText: {
    color: "#526070",
    flex: 1,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
    lineHeight: 18,
    textAlign: "right",
  },
  checkout: {
    alignItems: "center",
    backgroundColor: "#FF5A36",
    borderRadius: 18,
    flexDirection: "row",
    gap: 8,
    height: 54,
    justifyContent: "center",
    marginTop: 18,
    shadowColor: "#FF5A36",
    shadowOpacity: 0.28,
    shadowRadius: 10,
    elevation: 4,
  },
  checkoutText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 15,
  },
  footerNote: {
    color: "#737B88",
    fontFamily: "Cairo_400Regular",
    fontSize: 10,
    marginTop: 9,
    textAlign: "center",
  },
  empty: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#EEE3D7",
    borderRadius: 23,
    borderWidth: 1,
    marginTop: 40,
    padding: 29,
  },
  emptyIcon: {
    alignItems: "center",
    backgroundColor: "#E8F5EF",
    borderRadius: 28,
    height: 76,
    justifyContent: "center",
    width: 76,
  },
  emptyTitle: {
    color: "#183D36",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 18,
    marginTop: 16,
    textAlign: "center",
  },
  emptyText: {
    color: "#677B73",
    fontFamily: "Cairo_400Regular",
    fontSize: 13,
    lineHeight: 21,
    marginTop: 7,
    textAlign: "center",
  },
  browse: {
    alignItems: "center",
    backgroundColor: storefrontDesign.semantic.brandStrong,
    borderRadius: 14,
    flexDirection: "row",
    gap: 8,
    marginTop: 19,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  browseText: { color: "#FFFFFF", fontFamily: "Cairo_700Bold", fontSize: 13 },
  shareWhatsAppBtn: {
    alignItems: "center",
    backgroundColor: "#F0FDF4",
    borderColor: "#BBF7D0",
    borderRadius: 16,
    borderWidth: 1.5,
    flexDirection: "row-reverse",
    gap: 8,
    justifyContent: "center",
    marginTop: 12,
    paddingVertical: 13,
  },
  shareWhatsAppText: {
    color: "#166534",
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
  },
  gapFillerCard: {
    backgroundColor: "#F0FDF4",
    borderColor: "#BBF7D0",
    borderRadius: 20,
    borderWidth: 1.5,
    marginTop: 14,
    padding: 14,
    gap: 6,
  },
  gapFillerHeader: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  gapFillerBadge: {
    alignItems: "center",
    backgroundColor: "#DCFCE7",
    borderRadius: 8,
    flexDirection: "row-reverse",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  gapFillerBadgeText: {
    color: "#166534",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
  },
  gapFillerRemaining: {
    color: "#15803D",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 12,
  },
  gapFillerTitle: {
    color: "#14532D",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 13,
    textAlign: "right",
  },
  gapFillerSubtitle: {
    color: "#166534",
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    lineHeight: 17,
    textAlign: "right",
  },
  gapFillerList: {
    flexDirection: "row-reverse",
    gap: 10,
    paddingTop: 8,
    paddingBottom: 4,
  },
  gapFillerItem: {
    backgroundColor: "#FFFFFF",
    borderColor: "#DCFCE7",
    borderRadius: 14,
    borderWidth: 1,
    padding: 10,
    width: 140,
    alignItems: "center",
    gap: 4,
  },
  gapFillerIconBox: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  gapFillerItemTitle: {
    color: "#1E293B",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
    textAlign: "center",
  },
  gapFillerItemPrice: {
    color: "#15803D",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 12,
  },
  gapFillerAddBtn: {
    alignItems: "center",
    backgroundColor: "#15803D",
    borderRadius: 8,
    flexDirection: "row-reverse",
    gap: 2,
    justifyContent: "center",
    marginTop: 4,
    paddingHorizontal: 12,
    paddingVertical: 5,
    width: "100%",
  },
  gapFillerAddBtnText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
  },
  wholesaleProgressCard: {
    alignItems: "flex-start",
    backgroundColor: "#FFFBEB",
    borderColor: "#FDE68A",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 8,
    marginTop: 14,
    padding: 12,
  },
  wholesaleQualifiedCard: {
    alignItems: "flex-start",
    backgroundColor: "#F0FDF4",
    borderColor: "#BBF7D0",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 8,
    marginTop: 14,
    padding: 12,
  },
  wholesaleTextWrap: {
    flex: 1,
    gap: 2,
  },
  wholesaleProgressTitle: {
    color: "#92400E",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
    textAlign: "right",
  },
  wholesaleQualifiedTitle: {
    color: "#166534",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
    textAlign: "right",
  },
  wholesaleProgressDesc: {
    color: "#78350F",
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    lineHeight: 17,
    textAlign: "right",
  },
});
