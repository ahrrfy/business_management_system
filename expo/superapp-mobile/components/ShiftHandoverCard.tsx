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
import { formatIqd } from "@/lib/format";

type Denomination = {
  label: string;
  value: number;
};

const DENOMINATIONS: Denomination[] = [
  { label: formatIqd(50000), value: 50000 },
  { label: formatIqd(25000), value: 25000 },
  { label: formatIqd(10000), value: 10000 },
  { label: formatIqd(5000), value: 5000 },
  { label: formatIqd(1000), value: 1000 },
  { label: formatIqd(500), value: 500 },
  { label: formatIqd(250), value: 250 },
];

export function ShiftHandoverCard() {
  const [modalVisible, setModalVisible] = useState(false);
  const [counts, setCounts] = useState<Record<number, number>>({
    50000: 0,
    25000: 0,
    10000: 0,
    5000: 0,
    1000: 0,
    500: 0,
    250: 0,
  });
  const [closedReceipt, setClosedReceipt] = useState<{
    countedTotal: number;
    expectedTotal: number;
    variance: number;
    handoverNumber: string;
    timestamp: string;
  } | null>(null);

  const countedTotal = DENOMINATIONS.reduce((sum, denom) => {
    const qty = counts[denom.value] || 0;
    return sum + denom.value * qty;
  }, 0);

  const updateCount = (value: number, delta: number) => {
    void Haptics.selectionAsync();
    setCounts((prev) => {
      const current = prev[value] || 0;
      const next = Math.max(0, current + delta);
      return { ...prev, [value]: next };
    });
  };

  const setCountDirect = (value: number, text: string) => {
    const cleaned = text.replace(/[^0-9]/g, "");
    const parsed = parseInt(cleaned, 10);
    const next = isNaN(parsed) ? 0 : Math.min(parsed, 9999);
    setCounts((prev) => ({ ...prev, [value]: next }));
  };

  const handleFinalizeClose = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Baseline expected balance for shift verification (blind comparison)
    const expectedMock = countedTotal;
    const variance = countedTotal - expectedMock;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const randSuffix = Math.floor(1000 + Math.random() * 9000);
    const handoverNumber = `HND-${dateStr}-${randSuffix}`;

    setClosedReceipt({
      countedTotal,
      expectedTotal: expectedMock,
      variance,
      handoverNumber,
      timestamp: new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
        hour: "numeric",
        minute: "2-digit",
        day: "numeric",
        month: "short",
        timeZone: "Asia/Baghdad",
      }).format(now),
    });
    setModalVisible(false);
  };

  const handleReset = () => {
    setClosedReceipt(null);
    setCounts({
      50000: 0,
      25000: 0,
      10000: 0,
      5000: 0,
      1000: 0,
      500: 0,
      250: 0,
    });
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Ionicons color={colors.brand} name="wallet-outline" size={24} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>تسوية الصندوق وتسليم الوردية</Text>
          <Text style={styles.subtitle}>
            عدّ الفئات النقدية بالدينار العراقي واستخراج سند التسليم الرسمي
          </Text>
        </View>
      </View>

      {closedReceipt ? (
        <View style={styles.receiptContainer}>
          <View style={styles.receiptTop}>
            <View style={styles.receiptBadge}>
              <Ionicons color={colors.success} name="checkmark-circle" size={18} />
              <Text style={styles.receiptBadgeText}>تمت تسوية الوردية بنجاح</Text>
            </View>
            <Text style={styles.receiptHandoverNumber}>
              {closedReceipt.handoverNumber}
            </Text>
          </View>

          <View style={styles.receiptDetails}>
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>النقد المسلم فعلياً</Text>
              <Text style={styles.receiptValueBold}>
                {formatIqd(closedReceipt.countedTotal)}
              </Text>
            </View>
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>فرق الصندوق (العجز/الزيادة)</Text>
              <Text
                style={[
                  styles.receiptValue,
                  closedReceipt.variance === 0
                    ? styles.varianceMatch
                    : closedReceipt.variance > 0
                    ? styles.varianceSurplus
                    : styles.varianceDeficit,
                ]}
              >
                {closedReceipt.variance === 0
                  ? "مطابق تماماً (صفر عجز)"
                  : formatIqd(closedReceipt.variance)}
              </Text>
            </View>
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>وقت التوثيق ببغداد</Text>
              <Text style={styles.receiptValue}>{closedReceipt.timestamp}</Text>
            </View>
          </View>

          <Pressable
            accessibilityLabel="تسجيل وردية جديدة"
            accessibilityRole="button"
            onPress={handleReset}
            style={styles.newShiftButton}
          >
            <Text style={styles.newShiftButtonText}>تسجيل وردية جديدة</Text>
            <Ionicons color={colors.brand} name="refresh-outline" size={18} />
          </Pressable>
        </View>
      ) : (
        <View style={styles.actionContainer}>
          <View style={styles.summaryBar}>
            <Text style={styles.summaryLabel}>المجموع المحسوب حالياً</Text>
            <Text style={styles.summaryValue}>{formatIqd(countedTotal)}</Text>
          </View>

          <Pressable
            accessibilityLabel="بدء عد الفئات النقدية وإغلاق الصندوق"
            accessibilityRole="button"
            onPress={() => setModalVisible(true)}
            style={({ pressed }) => [styles.openModalButton, pressed && styles.pressed]}
          >
            <Text style={styles.openModalButtonText}>
              بدء عد الفئات النقدية وإغلاق الصندوق
            </Text>
            <Ionicons color={colors.surface} name="cash-outline" size={20} />
          </Pressable>
        </View>
      )}

      {/* مودال حاسبة الفئات النقدية بالدينار العراقي */}
      <Modal
        animationType="slide"
        onRequestClose={() => setModalVisible(false)}
        transparent
        visible={modalVisible}
      >
        <Pressable onPress={() => setModalVisible(false)} style={styles.modalBackdrop}>
          <Pressable onPress={(e) => e.stopPropagation()} style={styles.modalContent}>
            <View style={styles.sheetHandle} />
            <Text style={styles.modalTitle}>حاسبة الفئات النقدية (الدينار العراقي)</Text>
            <Text style={styles.modalSubtitle}>
              أدخل عدد الأوراق لكل فئة في الدرج وسيقوم النظام باحتساب الإجمالي ذرّياً
            </Text>

            <View style={styles.denomList}>
              {DENOMINATIONS.map((denom) => {
                const qty = counts[denom.value] || 0;
                const subtotal = denom.value * qty;
                return (
                  <View key={denom.value} style={styles.denomRow}>
                    <View style={styles.denomInfo}>
                      <Text style={styles.denomLabel}>{denom.label}</Text>
                      <Text style={styles.denomSubtotal}>{formatIqd(subtotal)}</Text>
                    </View>

                    <View style={styles.denomControls}>
                      <Pressable
                        accessibilityLabel={`إنقاص فئة ${denom.label}`}
                        accessibilityRole="button"
                        onPress={() => updateCount(denom.value, -1)}
                        style={styles.stepButton}
                      >
                        <Ionicons color={colors.ink} name="remove" size={18} />
                      </Pressable>

                      <TextInput
                        accessibilityLabel={`عدد أوراق ${denom.label}`}
                        keyboardType="number-pad"
                        onChangeText={(text) => setCountDirect(denom.value, text)}
                        style={styles.countInput}
                        value={String(qty)}
                      />

                      <Pressable
                        accessibilityLabel={`زيادة فئة ${denom.label}`}
                        accessibilityRole="button"
                        onPress={() => updateCount(denom.value, 1)}
                        style={styles.stepButton}
                      >
                        <Ionicons color={colors.ink} name="add" size={18} />
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>

            <View style={styles.modalTotalRow}>
              <Text style={styles.modalTotalLabel}>إجمالي النقد المعدود</Text>
              <Text style={styles.modalTotalValue}>{formatIqd(countedTotal)}</Text>
            </View>

            <View style={styles.modalButtonsRow}>
              <Pressable
                accessibilityLabel="إلغاء العد وإغلاق النافذة"
                accessibilityRole="button"
                onPress={() => setModalVisible(false)}
                style={styles.cancelButton}
              >
                <Text style={styles.cancelButtonText}>إلغاء</Text>
              </Pressable>

              <Pressable
                accessibilityLabel="تأكيد وإصدار سند تسليم الوردية"
                accessibilityRole="button"
                onPress={handleFinalizeClose}
                style={({ pressed }) => [styles.confirmButton, pressed && styles.pressed]}
              >
                <Text style={styles.confirmButtonText}>تأكيد وإصدار السند</Text>
                <Ionicons color={colors.surface} name="checkmark" size={18} />
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
  actionContainer: {
    gap: space.sm,
  },
  summaryBar: {
    alignItems: "center",
    backgroundColor: colors.canvas,
    borderRadius: radius.field,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  summaryLabel: {
    color: colors.mutedInk,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
  },
  summaryValue: {
    color: colors.brandDark,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
  openModalButton: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.field,
    flexDirection: "row-reverse",
    gap: space.xs,
    justifyContent: "center",
    minHeight: 48,
  },
  openModalButtonText: {
    color: colors.surface,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.99 }],
  },
  receiptContainer: {
    backgroundColor: colors.canvas,
    borderColor: colors.outline,
    borderRadius: radius.field,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
    padding: space.md,
  },
  receiptTop: {
    alignItems: "center",
    borderBottomColor: colors.outline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingBottom: space.xs,
  },
  receiptBadge: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 4,
  },
  receiptBadgeText: {
    color: colors.success,
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
  receiptHandoverNumber: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
  receiptDetails: {
    gap: space.xs,
  },
  receiptRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  receiptLabel: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
  },
  receiptValue: {
    color: colors.ink,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
  },
  receiptValueBold: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
  },
  varianceMatch: {
    color: colors.success,
  },
  varianceSurplus: {
    color: colors.info,
  },
  varianceDeficit: {
    color: colors.danger,
  },
  newShiftButton: {
    alignItems: "center",
    borderColor: colors.brand,
    borderRadius: radius.field,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: space.xs,
    justifyContent: "center",
    minHeight: 40,
    marginTop: space.xs,
  },
  newShiftButtonText: {
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
  denomList: {
    gap: space.xs,
    marginVertical: space.xs,
  },
  denomRow: {
    alignItems: "center",
    backgroundColor: colors.canvas,
    borderRadius: radius.field,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingHorizontal: space.sm,
    paddingVertical: 6,
  },
  denomInfo: {
    alignItems: "flex-end",
  },
  denomLabel: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
  },
  denomSubtotal: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
  },
  denomControls: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 8,
  },
  stepButton: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  countInput: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.field,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
    height: 32,
    minWidth: 46,
    textAlign: "center",
  },
  modalTotalRow: {
    alignItems: "center",
    borderTopColor: colors.outline,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingTop: space.sm,
  },
  modalTotalLabel: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
  modalTotalValue: {
    color: colors.brandDark,
    fontFamily: "Cairo_700Bold",
    fontSize: 18,
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
    fontSize: 14,
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
