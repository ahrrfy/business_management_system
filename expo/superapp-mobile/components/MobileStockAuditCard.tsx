import { useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { colors, radius, space } from "@/constants/theme";
import { formatQuantity } from "@/lib/format";

type AuditItem = {
  barcode: string;
  name: string;
  expectedQty: number;
  countedQty: number;
  unit: string;
};

const SAMPLE_SHELF_ITEMS: AuditItem[] = [
  { barcode: "6281001001", name: "دفتر ملاحظات سلك A5", expectedQty: 48, countedQty: 48, unit: "قطعة" },
  { barcode: "6281001002", name: "قلم جاف أزرق 0.7 ملم", expectedQty: 120, countedQty: 114, unit: "قطعة" },
  { barcode: "6281001003", name: "طقم ألوان خشبية 24 لون", expectedQty: 15, countedQty: 15, unit: "طقم" },
  { barcode: "6281001004", name: "ملزمة حسابات تجليد ليزري", expectedQty: 30, countedQty: 32, unit: "ملزمة" },
];

export function MobileStockAuditCard() {
  const [items, setItems] = useState<AuditItem[]>(SAMPLE_SHELF_ITEMS);
  const [barcodeInput, setBarcodeInput] = useState("");
  const [adjustmentSubmitted, setAdjustmentSubmitted] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);

  const matchedCount = items.filter((i) => i.countedQty === i.expectedQty).length;
  const varianceCount = items.filter((i) => i.countedQty !== i.expectedQty).length;

  const handleQuickScan = () => {
    const clean = barcodeInput.trim();
    if (!clean) return;
    void Haptics.selectionAsync();

    // Check if barcode matches existing item
    const existingIndex = items.findIndex((i) => i.barcode === clean);
    if (existingIndex >= 0) {
      setItems((prev) => {
        const next = [...prev];
        next[existingIndex] = {
          ...next[existingIndex],
          countedQty: next[existingIndex].countedQty + 1,
        };
        return next;
      });
    } else {
      // Add newly discovered barcode
      setItems((prev) => [
        {
          barcode: clean,
          name: `صنف ممسوح (${clean.slice(-4)})`,
          expectedQty: 0,
          countedQty: 1,
          unit: "قطعة",
        },
        ...prev,
      ]);
    }
    setBarcodeInput("");
  };

  const handleIncrement = (index: number) => {
    void Haptics.selectionAsync();
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], countedQty: next[index].countedQty + 1 };
      return next;
    });
  };

  const handleDecrement = (index: number) => {
    void Haptics.selectionAsync();
    setItems((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        countedQty: Math.max(0, next[index].countedQty - 1),
      };
      return next;
    });
  };

  const handleSubmitAudit = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const randSuffix = Math.floor(100 + Math.random() * 900);
    const reqNumber = `SAR-${dateStr}-${randSuffix}`;

    setAdjustmentSubmitted(reqNumber);
    setModalVisible(false);
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Ionicons color={colors.brand} name="barcode-outline" size={24} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>جرد المخزون الفوري بالباركود</Text>
          <Text style={styles.subtitle}>
            مطابقة رصيد الرفوف مع الخادم وإنشاء طلبات التسوية المعلقة (SOD-04)
          </Text>
        </View>
      </View>

      {adjustmentSubmitted ? (
        <View style={styles.submittedContainer}>
          <View style={styles.submittedTop}>
            <Ionicons color={colors.success} name="checkmark-done-circle" size={20} />
            <Text style={styles.submittedTitle}>تم رفع طلب التسوية للمدير المالي</Text>
          </View>
          <Text style={styles.submittedSubtitle}>
            رقم الطلب الرقابي: {adjustmentSubmitted}
          </Text>
          <Text style={styles.submittedNotice}>
            وفق قواعد الفصل الرقابي (SOD-04)، تم تسجيل الفروقات كطلب تسوية معلق لاعتماده من الإدارة دون تعديل الرصيد منفرداً.
          </Text>
          <Pressable
            accessibilityLabel="بدء جلسة جرد رف جديد"
            accessibilityRole="button"
            onPress={() => setAdjustmentSubmitted(null)}
            style={styles.newAuditButton}
          >
            <Text style={styles.newAuditButtonText}>بدء جلسة جرد رف جديد</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.body}>
          {/* شريط الإحصاء السريع */}
          <View style={styles.statsStrip}>
            <View style={styles.statItem}>
              <Text style={styles.statLabel}>أصناف مطابقة</Text>
              <Text style={[styles.statValue, styles.statMatch]}>{matchedCount}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statLabel}>أصناف بها فروقات</Text>
              <Text style={[styles.statValue, varianceCount > 0 ? styles.statDiff : styles.statMatch]}>
                {varianceCount}
              </Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statLabel}>إجمالي المفحوص</Text>
              <Text style={styles.statValue}>{items.length}</Text>
            </View>
          </View>

          {/* حقل المسح السريع بالباركود */}
          <View style={styles.scanRow}>
            <TextInput
              accessibilityLabel="إدخال أو مسح الباركود"
              onChangeText={setBarcodeInput}
              onSubmitEditing={handleQuickScan}
              placeholder="امسح أو اكتب الباركود…"
              placeholderTextColor={colors.mutedInk}
              style={styles.barcodeInput}
              value={barcodeInput}
            />
            <Pressable
              accessibilityLabel="تثبيت مسح الباركود"
              accessibilityRole="button"
              onPress={handleQuickScan}
              style={styles.scanButton}
            >
              <Ionicons color={colors.surface} name="scan" size={18} />
              <Text style={styles.scanButtonText}>مسح</Text>
            </Pressable>
          </View>

          {/* زر فتح قائمة مراجعة الجرد */}
          <Pressable
            accessibilityLabel="مراجعة الأصناف وتأكيد الجرد"
            accessibilityRole="button"
            onPress={() => setModalVisible(true)}
            style={({ pressed }) => [styles.reviewButton, pressed && styles.pressed]}
          >
            <Text style={styles.reviewButtonText}>مراجعة الأصناف وتأكيد الجرد</Text>
            <Ionicons color={colors.surface} name="clipboard-outline" size={18} />
          </Pressable>
        </View>
      )}

      {/* مودال تفاصيل مطابقة الجرد الميداني */}
      <Modal
        animationType="slide"
        onRequestClose={() => setModalVisible(false)}
        transparent
        visible={modalVisible}
      >
        <Pressable onPress={() => setModalVisible(false)} style={styles.modalBackdrop}>
          <Pressable onPress={(e) => e.stopPropagation()} style={styles.modalContent}>
            <View style={styles.sheetHandle} />
            <Text style={styles.modalTitle}>جدول مطابقة الرف مع الخادم</Text>
            <Text style={styles.modalSubtitle}>
              راجع الكميات المجرودة بدقة قبل رفع طلب التسوية الرقابي
            </Text>

            <View style={styles.itemsList}>
              {items.map((item, idx) => {
                const diff = item.countedQty - item.expectedQty;
                return (
                  <View key={item.barcode} style={styles.itemRow}>
                    <View style={styles.itemInfo}>
                      <Text style={styles.itemName}>{item.name}</Text>
                      <Text style={styles.itemBarcode}>
                        باركود: {item.barcode} · المسجل: {formatQuantity(item.expectedQty)} {item.unit}
                      </Text>
                      <Text
                        style={[
                          styles.itemDiff,
                          diff === 0 ? styles.diffMatch : diff > 0 ? styles.diffSurplus : styles.diffDeficit,
                        ]}
                      >
                        {diff === 0
                          ? "مطابق تماماً"
                          : diff > 0
                          ? `زيادة (+${formatQuantity(diff)} ${item.unit})`
                          : `عجز (${formatQuantity(diff)} ${item.unit})`}
                      </Text>
                    </View>

                    <View style={styles.itemControls}>
                      <Pressable
                        accessibilityLabel="إنقاص"
                        accessibilityRole="button"
                        onPress={() => handleDecrement(idx)}
                        style={styles.stepButton}
                      >
                        <Ionicons color={colors.ink} name="remove" size={16} />
                      </Pressable>
                      <Text style={styles.itemCountText}>{formatQuantity(item.countedQty)}</Text>
                      <Pressable
                        accessibilityLabel="زيادة"
                        accessibilityRole="button"
                        onPress={() => handleIncrement(idx)}
                        style={styles.stepButton}
                      >
                        <Ionicons color={colors.ink} name="add" size={16} />
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>

            <View style={styles.modalButtonsRow}>
              <Pressable
                accessibilityLabel="إلغاء وإغلاق جدول المطابقة"
                accessibilityRole="button"
                onPress={() => setModalVisible(false)}
                style={styles.cancelButton}
              >
                <Text style={styles.cancelButtonText}>إلغاء</Text>
              </Pressable>

              <Pressable
                accessibilityLabel="رفع طلب تسوية الجرد للإدارة"
                accessibilityRole="button"
                onPress={handleSubmitAudit}
                style={({ pressed }) => [styles.confirmButton, pressed && styles.pressed]}
              >
                <Text style={styles.confirmButtonText}>رفع طلب التسوية (SOD-04)</Text>
                <Ionicons color={colors.surface} name="cloud-upload-outline" size={18} />
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space.md,
    padding: space.md,
  },
  header: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: space.sm,
  },
  headerIcon: {
    alignItems: "center",
    backgroundColor: colors.brandSoft,
    borderRadius: radius.field,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 16,
    textAlign: "right",
  },
  subtitle: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    lineHeight: 18,
    textAlign: "right",
  },
  body: {
    gap: space.sm,
  },
  statsStrip: {
    alignItems: "center",
    backgroundColor: colors.canvas,
    borderRadius: radius.field,
    flexDirection: "row-reverse",
    justifyContent: "space-around",
    paddingVertical: space.xs,
  },
  statItem: {
    alignItems: "center",
    gap: 2,
  },
  statLabel: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
  },
  statValue: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
  statMatch: {
    color: colors.success,
  },
  statDiff: {
    color: colors.danger,
  },
  statDivider: {
    backgroundColor: colors.outline,
    height: 24,
    width: StyleSheet.hairlineWidth,
  },
  scanRow: {
    flexDirection: "row-reverse",
    gap: space.xs,
  },
  barcodeInput: {
    backgroundColor: colors.canvas,
    borderColor: colors.outline,
    borderRadius: radius.field,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.ink,
    flex: 1,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
    paddingHorizontal: space.sm,
    paddingVertical: 8,
    textAlign: "right",
  },
  scanButton: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.field,
    flexDirection: "row-reverse",
    gap: 4,
    justifyContent: "center",
    paddingHorizontal: space.md,
  },
  scanButtonText: {
    color: colors.surface,
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
  },
  reviewButton: {
    alignItems: "center",
    backgroundColor: colors.brandDark,
    borderRadius: radius.field,
    flexDirection: "row-reverse",
    gap: space.xs,
    justifyContent: "center",
    minHeight: 46,
  },
  reviewButtonText: {
    color: colors.surface,
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
  },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.99 }],
  },
  submittedContainer: {
    backgroundColor: colors.canvas,
    borderColor: colors.outline,
    borderRadius: radius.field,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space.xs,
    padding: space.md,
  },
  submittedTop: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 6,
  },
  submittedTitle: {
    color: colors.success,
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
  },
  submittedSubtitle: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
  submittedNotice: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    lineHeight: 17,
    marginTop: 4,
    textAlign: "right",
  },
  newAuditButton: {
    alignItems: "center",
    borderColor: colors.brand,
    borderRadius: radius.field,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 38,
    marginTop: space.xs,
  },
  newAuditButtonText: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
  modalBackdrop: {
    alignItems: "center",
    backgroundColor: colors.scrim,
    flex: 1,
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    gap: space.sm,
    maxHeight: "85%",
    padding: space.lg,
    width: "100%",
  },
  sheetHandle: {
    alignSelf: "center",
    backgroundColor: colors.outline,
    borderRadius: radius.pill,
    height: 4,
    marginBottom: space.xs,
    width: 44,
  },
  modalTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 18,
    textAlign: "right",
  },
  modalSubtitle: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    lineHeight: 18,
    textAlign: "right",
  },
  itemsList: {
    gap: space.xs,
    marginVertical: space.xs,
  },
  itemRow: {
    alignItems: "center",
    backgroundColor: colors.canvas,
    borderRadius: radius.field,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingHorizontal: space.sm,
    paddingVertical: 8,
  },
  itemInfo: {
    alignItems: "flex-end",
    flex: 1,
    gap: 2,
    paddingLeft: space.xs,
  },
  itemName: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
    textAlign: "right",
  },
  itemBarcode: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    textAlign: "right",
  },
  itemDiff: {
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
  },
  diffMatch: {
    color: colors.success,
  },
  diffSurplus: {
    color: colors.info,
  },
  diffDeficit: {
    color: colors.danger,
  },
  itemControls: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 6,
  },
  stepButton: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  itemCountText: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
    minWidth: 32,
    textAlign: "center",
  },
  modalButtonsRow: {
    flexDirection: "row-reverse",
    gap: space.sm,
    marginTop: space.xs,
  },
  confirmButton: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.field,
    flex: 1.5,
    flexDirection: "row-reverse",
    gap: space.xs,
    justifyContent: "center",
    minHeight: 48,
  },
  confirmButtonText: {
    color: colors.surface,
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
  },
  cancelButton: {
    alignItems: "center",
    borderColor: colors.outline,
    borderRadius: radius.field,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 48,
  },
  cancelButtonText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
  },
});
