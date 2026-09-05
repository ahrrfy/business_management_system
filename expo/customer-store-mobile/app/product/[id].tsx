import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, useWindowDimensions, View } from "react-native";

import { ProductReviews } from "@/components/product-reviews";
import { ScreenContainer } from "@/components/screen-container";
import { useCart } from "@/lib/cart-context";
import {
  activeCustomizationFields,
  cartLineKey,
  CUSTOMIZABLE_ORDERING_UNAVAILABLE_MESSAGE,
  DEFAULT_CUSTOMIZATION_VALUE_MAX_LENGTH,
  productOnlineOrderingIssue,
  validateProductSelection,
} from "@/lib/product-selection";
import { formatIqd, formatLatinNumber, productDiscountPercent, useStorefrontProduct } from "@/lib/storefront-api";
import type { StorefrontCustomizationField } from "@/shared/storefront";

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { addSelection, quantityFor } = useCart();
  const { width } = useWindowDimensions();
  const { product, loading, error } = useStorefrontProduct(Number(id));
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);
  const [selectedUnitId, setSelectedUnitId] = useState<number | null>(null);
  const [customizationValues, setCustomizationValues] = useState<Record<string, string>>({});
  const [selectionErrors, setSelectionErrors] = useState<string[]>([]);
  const [selectedImage, setSelectedImage] = useState(0);

  useEffect(() => {
    if (!product) return;
    const variant = product.variants?.find((candidate) => candidate.inStock) ?? product.variants?.[0];
    const unit = variant?.units.find((candidate) => candidate.inStock) ?? variant?.units[0];
    setSelectedVariantId(variant?.variantId ?? null);
    setSelectedUnitId(unit?.productUnitId ?? null);
    setCustomizationValues({});
    setSelectionErrors([]);
    setSelectedImage(0);
  }, [product]);

  const selectedVariant = product?.variants?.find((candidate) => candidate.variantId === selectedVariantId);
  const selectedUnit = selectedVariant?.units.find((candidate) => candidate.productUnitId === selectedUnitId);
  const gallery = useMemo(
    () => selectedVariant?.imageUrls.length ? selectedVariant.imageUrls : product?.imageUrls ?? [],
    [product?.imageUrls, selectedVariant?.imageUrls],
  );
  const galleryWidth = width - 32;

  if (loading) return <ScreenContainer className="items-center justify-center px-6" containerClassName="bg-background"><ActivityIndicator accessibilityLabel="جار تحميل المنتج" color="#0E806A" size="large" /><Text style={styles.stateText}>جار تحميل المنتج…</Text></ScreenContainer>;
  if (!product) return <ScreenContainer className="items-center justify-center px-6" containerClassName="bg-background"><MaterialIcons color="#A25A50" name="cloud-off" size={36} /><Text accessibilityRole="alert" style={styles.stateTitle}>{error ?? "المنتج غير متاح"}</Text><Text style={styles.stateText}>تحقق من الاتصال ثم عد إلى الكتالوج وحاول مجدداً.</Text><TouchableOpacity accessibilityRole="button" onPress={() => router.back()} style={styles.backSimple}><Text style={styles.backSimpleText}>العودة للمتجر</Text></TouchableOpacity></ScreenContainer>;

  const priceProduct = { ...product, price: selectedUnit?.price ?? product.price, salePrice: selectedUnit?.salePrice ?? product.salePrice };
  const discount = productDiscountPercent(priceProduct);
  const onlineOrderingIssue = productOnlineOrderingIssue(product);
  const validation = validateProductSelection(product, { variantId: selectedVariantId, productUnitId: selectedUnitId, customizationValues });
  const currentLineId = validation.details ? cartLineKey(product.productId ?? product.id, validation.details) : null;
  const quantity = currentLineId ? quantityFor(currentLineId) : 0;
  const activeFields = activeCustomizationFields(product, customizationValues);
  const addToCart = () => {
    const next = validateProductSelection(product, { variantId: selectedVariantId, productUnitId: selectedUnitId, customizationValues });
    setSelectionErrors(next.errors);
    if (!next.details) return;
    addSelection(product, next.details);
    setSelectionErrors([]);
  };

  return <ScreenContainer className="flex-1" containerClassName="bg-background"><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
    <View style={styles.topbar}><TouchableOpacity accessibilityLabel="العودة" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton}><MaterialIcons color="#0E806A" name="arrow-forward" size={23} /></TouchableOpacity><Text accessibilityRole="header" style={styles.topTitle}>تفاصيل المنتج</Text><TouchableOpacity accessibilityLabel="فتح سلة المشتريات" accessibilityRole="button" onPress={() => router.push("/cart" as never)} style={styles.iconButton}><MaterialIcons color="#0E806A" name="shopping-bag" size={21} /></TouchableOpacity></View>

    <View style={styles.galleryWrap}>{gallery.length ? <ScrollView accessibilityLabel="صور المنتج" horizontal onMomentumScrollEnd={(event) => setSelectedImage(Math.round(event.nativeEvent.contentOffset.x / galleryWidth))} pagingEnabled showsHorizontalScrollIndicator={false}>{gallery.map((uri) => <View key={uri} style={[styles.cover, { width: galleryWidth, backgroundColor: product.accent }]}><Image accessibilityLabel={`صورة ${product.title}`} cachePolicy="memory-disk" contentFit="contain" source={uri} style={styles.image} transition={160} /></View>)}</ScrollView> : <View style={[styles.cover, { width: galleryWidth, backgroundColor: product.accent }]}><MaterialIcons color="#0E806A" name={product.icon} size={96} /></View>}<Text style={styles.galleryLabel}>{gallery.length ? `صورة ${selectedImage + 1} من ${gallery.length}` : "لا توجد صورة معتمدة"}</Text></View>

    <View style={styles.card}><View style={styles.metaRow}><View style={[styles.status, (onlineOrderingIssue || !selectedUnit?.inStock) && styles.statusUnavailable]}><MaterialIcons color={onlineOrderingIssue || !selectedUnit?.inStock ? "#A25A50" : "#0E806A"} name={onlineOrderingIssue ? "info-outline" : selectedUnit?.inStock ? "check-circle" : "cancel"} size={15} /><Text style={[styles.statusText, (onlineOrderingIssue || !selectedUnit?.inStock) && styles.statusUnavailableText]}>{onlineOrderingIssue ? "غير متاح إلكترونياً" : selectedUnit?.inStock ? "متوفر" : "نافد"}</Text></View>{product.hasAlternatives && <Text style={styles.alternativeBadge}>بدائل متاحة</Text>}</View><Text accessibilityRole="header" style={styles.title}>{product.title}</Text><Text style={styles.brand}>{product.brand ?? product.subtitle}</Text><View style={styles.priceRow}><Text style={styles.price}>{formatIqd(selectedUnit?.salePrice ?? selectedUnit?.price ?? product.salePrice ?? product.price)}</Text>{discount != null && <Text style={styles.oldPrice}>{formatIqd(selectedUnit?.price ?? product.price)}</Text>}</View><Text style={styles.description}>{product.description}</Text></View>

    {onlineOrderingIssue ? <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.unavailableCard}><MaterialIcons color="#A25A50" name="info-outline" size={22} /><View style={styles.unavailableCopy}><Text style={styles.unavailableTitle}>طلب التخصيص متوقف إلكترونياً مؤقتاً</Text><Text style={styles.unavailableText}>{CUSTOMIZABLE_ORDERING_UNAVAILABLE_MESSAGE}</Text></View></View> : <View style={styles.card}><Text style={styles.sectionTitle}>{product.hasAlternatives ? "اختر البديل" : "اختر اللون أو القياس"}</Text><View style={styles.choices}>{(product.variants ?? []).map((variant) => <TouchableOpacity accessibilityLabel={`${variant.label}${variant.inStock ? "" : "، نافد"}`} accessibilityRole="radio" accessibilityState={{ checked: selectedVariantId === variant.variantId, disabled: !variant.inStock }} disabled={!variant.inStock} key={variant.variantId} onPress={() => { setSelectedVariantId(variant.variantId); setSelectedUnitId(variant.units.find((unit) => unit.inStock)?.productUnitId ?? null); setSelectedImage(0); setSelectionErrors([]); }} style={[styles.choice, selectedVariantId === variant.variantId && styles.choiceActive, !variant.inStock && styles.choiceDisabled]}>{variant.colorHex && <View style={[styles.swatch, { backgroundColor: variant.colorHex }]} />}<Text style={[styles.choiceText, selectedVariantId === variant.variantId && styles.choiceTextActive]}>{variant.label}</Text></TouchableOpacity>)}</View>
      {selectedVariant && <><Text style={styles.unitTitle}>وحدة البيع</Text><View style={styles.choices}>{selectedVariant.units.map((unit) => <TouchableOpacity accessibilityLabel={`${unit.unitName} بسعر ${formatIqd(unit.salePrice ?? unit.price)}${unit.inStock ? "" : "، نافدة"}`} accessibilityRole="radio" accessibilityState={{ checked: selectedUnitId === unit.productUnitId, disabled: !unit.inStock }} disabled={!unit.inStock} key={unit.productUnitId} onPress={() => { setSelectedUnitId(unit.productUnitId); setSelectionErrors([]); }} style={[styles.unitChoice, selectedUnitId === unit.productUnitId && styles.choiceActive, !unit.inStock && styles.choiceDisabled]}><Text style={[styles.choiceText, selectedUnitId === unit.productUnitId && styles.choiceTextActive]}>{unit.unitName}</Text><Text style={[styles.unitPrice, selectedUnitId === unit.productUnitId && styles.choiceTextActive]}>{formatIqd(unit.salePrice ?? unit.price)}</Text></TouchableOpacity>)}</View></>}
      {selectedUnit?.stockLeft != null && selectedUnit.stockLeft <= 5 && <Text accessibilityLiveRegion="polite" style={styles.stock}>المتبقي المعلن: {formatLatinNumber(selectedUnit.stockLeft)} فقط.</Text>}
    </View>}

    {!onlineOrderingIssue && product.customizationTemplate && <View style={styles.card}><Text style={styles.sectionTitle}>{product.customizationTemplate.title}</Text>{product.customizationTemplate.description && <Text style={styles.helpText}>{product.customizationTemplate.description}</Text>}{activeFields.map((field) => <CustomizationFieldInput field={field} key={field.fieldKey} onChange={(value) => { setCustomizationValues((current) => ({ ...current, [field.fieldKey]: value })); setSelectionErrors([]); }} value={customizationValues[field.fieldKey] ?? ""} />)}</View>}
    {product.bundleItems && product.bundleItems.length > 0 && <View style={styles.card}><Text style={styles.sectionTitle}>محتويات المجموعة</Text>{product.bundleItems.map((item) => <Text key={item.name} style={styles.bundleItem}>• {item.name} × {formatLatinNumber(item.quantity)}</Text>)}</View>}
    {selectionErrors.length > 0 && <View accessibilityLiveRegion="assertive" accessibilityRole="alert" style={styles.errorBox}>{selectionErrors.map((message) => <Text key={message} style={styles.errorText}>• {message}</Text>)}</View>}
    <View style={styles.trust}><MaterialIcons color="#0E806A" name="verified-user" size={20} /><Text style={styles.trustText}>يعاد فحص السعر والمخزون من نظام المكتبة قبل إرسال الطلب.</Text></View>
    <ProductReviews productId={product.productId ?? Number(product.id)} />
    {!onlineOrderingIssue && <TouchableOpacity accessibilityHint="يحفظ البديل والوحدة وبيانات التخصيص المختارة" accessibilityLabel={quantity ? `أضف نسخة أخرى، الكمية الحالية ${quantity}` : "أضف الاختيار إلى السلة"} accessibilityRole="button" disabled={!selectedUnit?.inStock} onPress={addToCart} style={[styles.addButton, !selectedUnit?.inStock && styles.addDisabled]}><Text style={styles.addButtonText}>{quantity ? `أضف أخرى • في السلة ${quantity}` : "أضف الاختيار إلى السلة"}</Text><MaterialIcons color="#FFFFFF" name="add-shopping-cart" size={20} /></TouchableOpacity>}
  </ScrollView></ScreenContainer>;
}

function CustomizationFieldInput({ field, onChange, value }: { field: StorefrontCustomizationField; onChange: (value: string) => void; value: string }) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{field.label}{field.isRequired ? " *" : ""}</Text>{field.fieldType === "FILE" ? <View style={styles.fileUnavailable}><MaterialIcons color="#A56B10" name="upload-file" size={19} /><Text style={styles.fileUnavailableText}>رفع الملفات غير متاح حتى تجهّز المكتبة قناة رفع آمنة.</Text></View> : field.fieldType === "SELECT" || field.fieldType === "SWATCH" ? <View style={styles.choices}>{field.options.map((option) => <TouchableOpacity accessibilityRole="radio" accessibilityState={{ checked: value === option.value }} key={option.value} onPress={() => onChange(option.value)} style={[styles.choice, value === option.value && styles.choiceActive]}>{field.fieldType === "SWATCH" && /^#[0-9A-F]{6}$/i.test(option.value) && <View style={[styles.swatch, { backgroundColor: option.value }]} />}<Text style={[styles.choiceText, value === option.value && styles.choiceTextActive]}>{option.label}</Text></TouchableOpacity>)}</View> : <TextInput accessibilityLabel={field.label} keyboardType={field.fieldType === "NUMBER" ? "numeric" : "default"} maxLength={field.maxLength ?? DEFAULT_CUSTOMIZATION_VALUE_MAX_LENGTH} multiline={field.fieldType === "TEXTAREA"} onChangeText={onChange} placeholder={`اكتب ${field.label}`} placeholderTextColor="#81908A" style={[styles.input, field.fieldType === "TEXTAREA" && styles.textarea]} textAlign="right" value={value} />}</View>;
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 38 }, topbar: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between", marginBottom: 14 }, iconButton: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#EEE3D7", borderRadius: 14, borderWidth: 1, height: 44, justifyContent: "center", width: 44 }, topTitle: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 17 }, galleryWrap: { backgroundColor: "#FFFFFF", borderColor: "#EEE3D7", borderRadius: 22, borderWidth: 1, overflow: "hidden" }, cover: { alignItems: "center", height: 300, justifyContent: "center" }, image: { height: "100%", width: "100%" }, galleryLabel: { color: "#6D817A", fontFamily: "Cairo_600SemiBold", fontSize: 10, padding: 9, textAlign: "center" },
  card: { backgroundColor: "#FFFFFF", borderColor: "#EEE3D7", borderRadius: 20, borderWidth: 1, marginTop: 13, padding: 15 }, metaRow: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between" }, status: { alignItems: "center", backgroundColor: "#E8F5EF", borderRadius: 10, flexDirection: "row-reverse", gap: 4, paddingHorizontal: 8, paddingVertical: 5 }, statusUnavailable: { backgroundColor: "#FFF0EC" }, statusText: { color: "#0E806A", fontFamily: "Cairo_700Bold", fontSize: 10 }, statusUnavailableText: { color: "#A25A50" }, alternativeBadge: { backgroundColor: "#FFF0E2", borderRadius: 9, color: "#8A5A15", fontFamily: "Cairo_700Bold", fontSize: 10, overflow: "hidden", paddingHorizontal: 8, paddingVertical: 5 },
  title: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 23, marginTop: 13, textAlign: "right" }, brand: { color: "#6D817A", fontFamily: "Cairo_400Regular", fontSize: 12, marginTop: 4, textAlign: "right" }, priceRow: { alignItems: "baseline", flexDirection: "row-reverse", gap: 9, marginTop: 12 }, price: { color: "#0E806A", fontFamily: "Cairo_800ExtraBold", fontSize: 22 }, oldPrice: { color: "#94A19C", fontFamily: "Cairo_400Regular", fontSize: 12, textDecorationLine: "line-through" }, description: { color: "#435E55", fontFamily: "Cairo_400Regular", fontSize: 13, lineHeight: 23, marginTop: 13, textAlign: "right" },
  sectionTitle: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 16, textAlign: "right" }, unitTitle: { color: "#315A50", fontFamily: "Cairo_700Bold", fontSize: 12, marginTop: 15, textAlign: "right" }, choices: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 8, marginTop: 10 }, choice: { alignItems: "center", backgroundColor: "#F7F7F4", borderColor: "#DDE5DF", borderRadius: 12, borderWidth: 1, flexDirection: "row-reverse", gap: 6, minHeight: 44, paddingHorizontal: 11, paddingVertical: 8 }, unitChoice: { backgroundColor: "#F7F7F4", borderColor: "#DDE5DF", borderRadius: 12, borderWidth: 1, minHeight: 54, paddingHorizontal: 12, paddingVertical: 7 }, choiceActive: { backgroundColor: "#0E806A", borderColor: "#0E806A" }, choiceDisabled: { opacity: 0.38 }, choiceText: { color: "#315A50", fontFamily: "Cairo_700Bold", fontSize: 11 }, choiceTextActive: { color: "#FFFFFF" }, unitPrice: { color: "#5E736B", fontFamily: "Cairo_600SemiBold", fontSize: 9, marginTop: 2, textAlign: "center" }, swatch: { borderColor: "#FFFFFF", borderRadius: 10, borderWidth: 2, height: 20, width: 20 }, stock: { color: "#9A6314", fontFamily: "Cairo_700Bold", fontSize: 11, marginTop: 11, textAlign: "right" },
  helpText: { color: "#61736C", fontFamily: "Cairo_400Regular", fontSize: 11, lineHeight: 18, marginTop: 5, textAlign: "right" }, field: { marginTop: 14 }, fieldLabel: { color: "#315A50", fontFamily: "Cairo_700Bold", fontSize: 12, textAlign: "right" }, input: { backgroundColor: "#F7F8F6", borderColor: "#DDE5DF", borderRadius: 12, borderWidth: 1, color: "#183D36", fontFamily: "Cairo_400Regular", marginTop: 7, minHeight: 48, paddingHorizontal: 12 }, textarea: { minHeight: 96, paddingTop: 12, textAlignVertical: "top" }, fileUnavailable: { alignItems: "flex-start", backgroundColor: "#FFF7E8", borderRadius: 12, flexDirection: "row-reverse", gap: 7, marginTop: 7, padding: 11 }, fileUnavailableText: { color: "#785923", flex: 1, fontFamily: "Cairo_600SemiBold", fontSize: 10, lineHeight: 17, textAlign: "right" }, bundleItem: { color: "#435E55", fontFamily: "Cairo_600SemiBold", fontSize: 12, marginTop: 7, textAlign: "right" },
  errorBox: { backgroundColor: "#FFF0EC", borderColor: "#F0C8BE", borderRadius: 15, borderWidth: 1, marginTop: 13, padding: 12 }, errorText: { color: "#9A3F31", fontFamily: "Cairo_700Bold", fontSize: 11, lineHeight: 19, textAlign: "right" }, trust: { alignItems: "flex-start", backgroundColor: "#E8F5EF", borderRadius: 15, flexDirection: "row-reverse", gap: 8, marginTop: 13, padding: 12 }, trustText: { color: "#315A50", flex: 1, fontFamily: "Cairo_600SemiBold", fontSize: 11, lineHeight: 18, textAlign: "right" }, addButton: { alignItems: "center", backgroundColor: "#0E806A", borderRadius: 17, flexDirection: "row", gap: 8, height: 58, justifyContent: "center", marginTop: 17 }, addDisabled: { backgroundColor: "#AAB8B2" }, addButtonText: { color: "#FFFFFF", fontFamily: "Cairo_800ExtraBold", fontSize: 14 },
  unavailableCard: { alignItems: "flex-start", backgroundColor: "#FFF0EC", borderColor: "#F0C8BE", borderRadius: 18, borderWidth: 1, flexDirection: "row-reverse", gap: 10, marginTop: 13, padding: 14 }, unavailableCopy: { flex: 1 }, unavailableTitle: { color: "#8D3D31", fontFamily: "Cairo_800ExtraBold", fontSize: 14, textAlign: "right" }, unavailableText: { color: "#74443C", fontFamily: "Cairo_600SemiBold", fontSize: 11, lineHeight: 19, marginTop: 4, textAlign: "right" },
  stateTitle: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 16, marginTop: 12, textAlign: "center" }, stateText: { color: "#61736C", fontFamily: "Cairo_400Regular", fontSize: 12, marginTop: 8, textAlign: "center" }, backSimple: { backgroundColor: "#0E806A", borderRadius: 13, marginTop: 16, paddingHorizontal: 16, paddingVertical: 11 }, backSimpleText: { color: "#FFFFFF", fontFamily: "Cairo_700Bold", fontSize: 12 },
});
