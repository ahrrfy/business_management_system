import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { AnimatedReveal } from "@/components/AnimatedReveal";
import { ExperienceState } from "@/components/ExperienceState";
import { UnifiedScreenHeader } from "@/components/UnifiedScreenHeader";
import { colors, radius, space } from "@/constants/theme";
import { formatIqd } from "@/lib/format";
import { unlockLocalSession } from "@/lib/localSessionUnlock";
import { fetchRealApprovals, submitRealDecision } from "@/lib/operationsApi";
import { getNativeMobileCommandCenter } from "@/lib/secureTransport";

type ApprovalCategory = "STOCK" | "EXPENSE" | "DISCOUNT" | "LEAVE";
type ApprovalSeverity = "CRITICAL" | "WARNING" | "NORMAL";

type ApprovalItem = {
  id: string;
  category: ApprovalCategory;
  severity: ApprovalSeverity;
  title: string;
  applicant: string;
  branch: string;
  amountOrMetric: string;
  reason: string;
  createdAt: string;
  kind?: string;
  numericId?: number;
  expectedVersion?: number | null;
};

const categoryConfig: Record<ApprovalCategory, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  STOCK: { label: "تسوية مخزن", icon: "cube-outline" },
  EXPENSE: { label: "مصروفات", icon: "cash-outline" },
  DISCOUNT: { label: "خصم مبيعات", icon: "pricetag-outline" },
  LEAVE: { label: "إجازة موظف", icon: "calendar-outline" },
};

const severityConfig: Record<ApprovalSeverity, { label: string; color: string; bg: string }> = {
  CRITICAL: { label: "عاجل جداً", color: colors.danger, bg: "#FEEBEB" },
  WARNING: { label: "أولوية هامة", color: colors.warning, bg: "#FEF7E6" },
  NORMAL: { label: "اعتيادي", color: colors.info, bg: "#EEF3FB" },
};

export default function ApprovalsScreen() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"ALL" | ApprovalCategory>("ALL");
  const [selectedItem, setSelectedItem] = useState<ApprovalItem | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [rejectModalVisible, setRejectModalVisible] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const loadData = async () => {
    try {
      const realApprovals = await fetchRealApprovals();
      const cc = await getNativeMobileCommandCenter().catch(() => null);

      const combined: ApprovalItem[] = realApprovals.map((app) => ({
        id: `appr-${app.id}`,
        numericId: app.numericId,
        kind: app.kind,
        expectedVersion: app.expectedVersion,
        category: (app.type === "STOCK_ADJUSTMENT"
          ? "STOCK"
          : app.type === "EXPENSE"
          ? "EXPENSE"
          : app.type === "DISCOUNT"
          ? "DISCOUNT"
          : "LEAVE") as ApprovalCategory,
        severity: "WARNING" as ApprovalSeverity,
        title: app.title,
        applicant: app.requesterName,
        branch: app.branchName,
        amountOrMetric: app.amount ? formatIqd(app.amount) : "طلب إداري",
        reason: app.notes,
        createdAt: app.createdAt,
      }));

      if (cc?.decisions) {
        for (const d of cc.decisions) {
          combined.push({
            id: `dec-${d.id}`,
            category: d.id.includes("stock")
              ? "STOCK"
              : d.id.includes("expense") || d.id.includes("ap")
              ? "EXPENSE"
              : "DISCOUNT",
            severity: d.severity === "critical" ? "CRITICAL" : d.severity === "warning" ? "WARNING" : "NORMAL",
            title: d.title,
            applicant: "نظام الرقابة والقرارات التنفيذية",
            branch: "الفرع الرئيسي - المنصور",
            amountOrMetric: d.actionLabel,
            reason: `مؤشر تشغيلي حقيقي من قاعدة البيانات يتطلب قراراً إدارياً (${d.actionLabel}).`,
            createdAt: "اليوم",
          });
        }
      }

      setItems(combined);
    } catch (err) {
      console.error("Failed to load approvals:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const filteredItems = useMemo(() => {
    return items.filter((item) => filter === "ALL" || item.category === filter);
  }, [items, filter]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.selectionAsync();
    await loadData();
  };

  const handleApprove = async (item: ApprovalItem) => {
    setIsProcessing(true);
    try {
      await unlockLocalSession();
      if (item.kind && item.numericId) {
        await submitRealDecision({
          kind: item.kind,
          id: item.numericId,
          action: "APPROVE",
          expectedVersion: item.expectedVersion,
        });
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setSelectedItem(null);
      setFeedback(`تم اعتماد القرار بنجاح وتوثيق موافقة الإدارة: «${item.title}»`);
    } catch (err: any) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setFeedback(err?.message || "فشلت عملية المصادقة. أعد المحاولة ثانية.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRejectConfirm = async () => {
    if (!selectedItem) return;
    setIsProcessing(true);
    try {
      if (selectedItem.kind && selectedItem.numericId) {
        await submitRealDecision({
          kind: selectedItem.kind,
          id: selectedItem.numericId,
          action: "REJECT",
          reason: rejectReason.trim() || undefined,
          expectedVersion: selectedItem.expectedVersion,
        });
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      const title = selectedItem.title;
      setItems((prev) => prev.filter((i) => i.id !== selectedItem.id));
      setRejectModalVisible(false);
      setSelectedItem(null);
      setRejectReason("");
      setFeedback(`تم صرف النظر عن القرار: «${title}» وتسجيل الملاحظة.`);
    } catch (err: any) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setFeedback(err?.message || "فشلت عملية تسجيل الرفض. أعد المحاولة ثانية.");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <View style={styles.page}>
      <UnifiedScreenHeader
        badge={{ label: "مصادقة آمنة • متصل", variant: "brand" }}
        subtitle="قرارات واعتمادات العمليات المباشرة"
        title="صندوق اعتمادات وقرارات الإدارة"
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl onRefresh={onRefresh} refreshing={refreshing} tintColor={colors.brand} />
        }
      >
        <AnimatedReveal delay={50} style={styles.kpiContainer}>
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>القرارات المعلقة الآن</Text>
            <Text style={styles.kpiValue}>{items.length} قرارات حية</Text>
          </View>
          <View style={styles.kpiDivider} />
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>قرارات عاجلة</Text>
            <Text style={[styles.kpiValue, { color: "#FFB1B1" }]}>
              {items.filter((i) => i.severity === "CRITICAL").length} عاجلة
            </Text>
          </View>
        </AnimatedReveal>

        {feedback ? (
          <ExperienceState
            compact
            detail="سُجل الإجراء في سجل التدقيق المالي والإداري."
            state="success"
            title={feedback}
          />
        ) : null}

        <View style={styles.filterTabs}>
          {(
            [
              { key: "ALL", label: `الكل (${items.length})` },
              { key: "EXPENSE", label: "مصروفات وديون" },
              { key: "DISCOUNT", label: "مبيعات وذمم" },
              { key: "STOCK", label: "مخزون وتوريد" },
            ] as const
          ).map((tab) => (
            <Pressable
              accessibilityLabel={`تصفية حسب: ${tab.label}`}
              accessibilityRole="button"
              key={tab.key}
              onPress={() => {
                void Haptics.selectionAsync();
                setFilter(tab.key as any);
              }}
              style={[styles.filterTab, filter === tab.key && styles.filterTabActive]}
            >
              <Text style={[styles.filterTabText, filter === tab.key && styles.filterTabTextActive]}>
                {tab.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.brand} />
            <Text style={styles.loadingText}>جارٍ جلب قرارات واعتمادات الإدارة من قاعدة الإنتاج…</Text>
          </View>
        ) : filteredItems.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons color={colors.success} name="checkmark-done-circle-outline" size={54} />
            <Text style={styles.emptyStateTitle}>صندوق القرارات مكتمل</Text>
            <Text style={styles.emptyStateText}>
              لا توجد أي قرارات أو اعتمادات معلقة تتطلب اتخاذ إجراء حالياً
            </Text>
          </View>
        ) : (
          <View style={styles.approvalsList}>
            {filteredItems.map((item, idx) => {
              const sev = severityConfig[item.severity];
              const cat = categoryConfig[item.category];

              return (
                <AnimatedReveal delay={idx * 30} key={item.id}>
                  <Pressable
                    accessibilityLabel={`طلب: ${item.title}`}
                    accessibilityRole="button"
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setSelectedItem(item);
                    }}
                    style={({ pressed }) => [styles.approvalCard, pressed && styles.approvalCardPressed]}
                  >
                    <View style={styles.cardHeader}>
                      <View style={styles.categoryBadge}>
                        <Ionicons color={colors.brand} name={cat.icon} size={14} />
                        <Text style={styles.categoryText}>{cat.label}</Text>
                      </View>
                      <View style={[styles.severityBadge, { backgroundColor: sev.bg }]}>
                        <Text style={[styles.severityText, { color: sev.color }]}>{sev.label}</Text>
                      </View>
                    </View>

                    <Text style={styles.cardTitle}>{item.title}</Text>
                    <Text numberOfLines={2} style={styles.cardReason}>
                      {item.reason}
                    </Text>

                    <View style={styles.cardFooter}>
                      <View style={styles.applicantInfo}>
                        <Ionicons color={colors.mutedInk} name="person-outline" size={13} />
                        <Text style={styles.applicantText}>
                          {item.applicant} • {item.branch}
                        </Text>
                      </View>
                      <Text style={styles.amountMetric}>{item.amountOrMetric}</Text>
                    </View>
                  </Pressable>
                </AnimatedReveal>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Decision / Approval Modal */}
      <Modal
        animationType="slide"
        onRequestClose={() => setSelectedItem(null)}
        transparent
        visible={selectedItem !== null}
      >
        <Pressable onPress={() => setSelectedItem(null)} style={styles.modalOverlay}>
          <Pressable onPress={(e) => e.stopPropagation()} style={styles.modalSheet}>
            {selectedItem ? (
              <>
                <View style={styles.modalHeader}>
                  <Pressable
                    accessibilityLabel="إغلاق النافذة"
                    accessibilityRole="button"
                    onPress={() => setSelectedItem(null)}
                    style={styles.modalCloseButton}
                  >
                    <Ionicons color={colors.mutedInk} name="close" size={22} />
                  </Pressable>
                  <View style={styles.modalTitles}>
                    <Text style={styles.modalCategoryTitle}>
                      {categoryConfig[selectedItem.category].label} •{" "}
                      {severityConfig[selectedItem.severity].label}
                    </Text>
                    <Text numberOfLines={2} style={styles.modalMainTitle}>
                      {selectedItem.title}
                    </Text>
                  </View>
                </View>

                <View style={styles.modalMetricBox}>
                  <Text style={styles.modalMetricLabel}>القيمة / الإجراء المطلوب:</Text>
                  <Text style={styles.modalMetricValue}>{selectedItem.amountOrMetric}</Text>
                </View>

                <View style={styles.modalInfoCard}>
                  <View style={styles.modalInfoRow}>
                    <Text style={styles.modalInfoLabel}>الجهة المقدمة:</Text>
                    <Text style={styles.modalInfoVal}>{selectedItem.applicant}</Text>
                  </View>
                  <View style={styles.modalInfoRow}>
                    <Text style={styles.modalInfoLabel}>الفرع المعني:</Text>
                    <Text style={styles.modalInfoVal}>{selectedItem.branch}</Text>
                  </View>
                  <View style={styles.modalInfoRow}>
                    <Text style={styles.modalInfoLabel}>توقيت التقديم:</Text>
                    <Text style={styles.modalInfoVal}>{selectedItem.createdAt}</Text>
                  </View>
                  <View style={styles.reasonBox}>
                    <Text style={styles.reasonLabel}>مبررات الطلب والسياق التشغيلي:</Text>
                    <Text style={styles.reasonText}>{selectedItem.reason}</Text>
                  </View>
                </View>

                <View style={styles.actionsRow}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={isProcessing}
                    onPress={() => setRejectModalVisible(true)}
                    style={[styles.rejectBtn, isProcessing && styles.btnDisabled]}
                  >
                    <Ionicons color={colors.danger} name="close-circle-outline" size={18} />
                    <Text style={styles.rejectBtnText}>صرف النظر</Text>
                  </Pressable>

                  <Pressable
                    accessibilityRole="button"
                    disabled={isProcessing}
                    onPress={() => void handleApprove(selectedItem)}
                    style={[styles.approveBtn, isProcessing && styles.btnDisabled]}
                  >
                    {isProcessing ? (
                      <ActivityIndicator color={colors.surface} size="small" />
                    ) : (
                      <>
                        <Ionicons color={colors.surface} name="checkmark-circle-outline" size={18} />
                        <Text style={styles.approveBtnText}>اعتماد القرار رسمياً</Text>
                      </>
                    )}
                  </Pressable>
                </View>
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Reject Reason Modal */}
      <Modal
        animationType="fade"
        onRequestClose={() => setRejectModalVisible(false)}
        transparent
        visible={rejectModalVisible}
      >
        <Pressable onPress={() => setRejectModalVisible(false)} style={styles.modalOverlay}>
          <Pressable onPress={(e) => e.stopPropagation()} style={styles.rejectSheet}>
            <Text style={styles.rejectModalTitle}>تأكيد صرف النظر عن الطلب</Text>
            <Text style={styles.rejectModalSubtitle}>
              يمكنك كتابة ملاحظة أو سبب لصرف النظر لإدراجه في سجل التدقيق:
            </Text>

            <TextInput
              multiline
              numberOfLines={3}
              onChangeText={setRejectReason}
              placeholder="اكتب ملاحظة القرار (اختياري)..."
              placeholderTextColor={colors.mutedInk}
              style={styles.rejectInput}
              value={rejectReason}
            />

            <View style={styles.rejectActions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setRejectModalVisible(false)}
                style={styles.cancelRejectBtn}
              >
                <Text style={styles.cancelRejectText}>تراجع</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={handleRejectConfirm}
                style={styles.confirmRejectBtn}
              >
                <Text style={styles.confirmRejectText}>تأكيد القرار</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.canvas, flex: 1 },
  header: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderBottomColor: colors.outline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row-reverse",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  backButton: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  headerTitles: { flex: 1 },
  headerTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 16,
    textAlign: "right",
  },
  headerSubtitle: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    textAlign: "right",
  },
  headerAction: {
    alignItems: "center",
    backgroundColor: colors.brandSoft,
    borderRadius: radius.compact,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  content: { gap: space.md, padding: space.md, paddingBottom: 40 },
  kpiContainer: {
    backgroundColor: colors.brand,
    borderRadius: radius.card,
    flexDirection: "row-reverse",
    padding: space.md,
  },
  kpiBox: { alignItems: "center", flex: 1 },
  kpiLabel: { color: "#C3D3FB", fontFamily: "Cairo_600SemiBold", fontSize: 12 },
  kpiValue: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 18, marginTop: 2 },
  kpiDivider: { backgroundColor: "#ffffff25", width: 1 },
  filterTabs: {
    flexDirection: "row-reverse",
    gap: space.xs,
  },
  filterTab: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
  },
  filterTabActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  filterTabText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
  },
  filterTabTextActive: {
    color: colors.surface,
  },

  loadingContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 48,
    gap: space.sm,
  },
  loadingText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 13,
  },

  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 48,
    gap: space.xs,
  },
  emptyStateTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 16,
  },
  emptyStateText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 13,
    textAlign: "center",
  },

  approvalsList: { gap: space.sm },
  approvalCard: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: 1,
    padding: space.md,
    gap: space.xs,
  },
  approvalCardPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  cardHeader: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
  },
  categoryBadge: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.canvas,
    borderRadius: radius.compact,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  categoryText: {
    color: colors.brand,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
  },
  severityBadge: {
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  severityText: {
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
  },
  cardTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 15,
    textAlign: "right",
  },
  cardReason: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 13,
    lineHeight: 20,
    textAlign: "right",
  },
  cardFooter: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: space.xxs,
  },
  applicantInfo: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 4,
  },
  applicantText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
  },
  amountMetric: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },

  modalOverlay: {
    backgroundColor: "rgba(0,0,0,0.5)",
    flex: 1,
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    maxHeight: "85%",
    padding: space.md,
    gap: space.md,
  },
  modalHeader: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomColor: colors.outline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: space.sm,
  },
  modalTitles: { flex: 1, gap: 2 },
  modalCategoryTitle: {
    color: colors.brand,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
    textAlign: "right",
  },
  modalMainTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "right",
  },
  modalCloseButton: {
    alignItems: "center",
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  modalMetricBox: {
    backgroundColor: colors.brandSoft,
    borderRadius: radius.compact,
    padding: space.sm,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modalMetricLabel: {
    color: colors.brand,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
  },
  modalMetricValue: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 16,
  },
  modalInfoCard: {
    backgroundColor: colors.canvas,
    borderRadius: radius.compact,
    padding: space.sm,
    gap: space.xs,
  },
  modalInfoRow: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modalInfoLabel: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
  },
  modalInfoVal: {
    color: colors.ink,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
  },
  reasonBox: {
    borderTopColor: colors.outline,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 4,
    marginTop: space.xs,
    paddingTop: space.xs,
  },
  reasonLabel: {
    color: colors.ink,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
    textAlign: "right",
  },
  reasonText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 13,
    lineHeight: 22,
    textAlign: "right",
  },
  actionsRow: {
    flexDirection: "row-reverse",
    gap: space.sm,
    marginTop: space.xs,
  },
  rejectBtn: {
    alignItems: "center",
    backgroundColor: "#FEEBEB",
    borderColor: colors.danger,
    borderRadius: radius.field,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row-reverse",
    gap: 6,
    justifyContent: "center",
    minHeight: 48,
  },
  rejectBtnText: {
    color: colors.danger,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
  approveBtn: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.field,
    flex: 2,
    flexDirection: "row-reverse",
    gap: 6,
    justifyContent: "center",
    minHeight: 48,
  },
  approveBtnText: {
    color: colors.surface,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
  btnDisabled: { opacity: 0.6 },

  rejectSheet: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    marginHorizontal: space.md,
    marginBottom: "auto",
    marginTop: "auto",
    padding: space.md,
    gap: space.sm,
  },
  rejectModalTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 16,
    textAlign: "right",
  },
  rejectModalSubtitle: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 13,
    lineHeight: 20,
    textAlign: "right",
  },
  rejectInput: {
    backgroundColor: colors.canvas,
    borderColor: colors.outline,
    borderRadius: radius.field,
    borderWidth: 1,
    color: colors.ink,
    fontFamily: "Cairo_400Regular",
    fontSize: 14,
    minHeight: 80,
    padding: space.sm,
    textAlign: "right",
    textAlignVertical: "top",
  },
  rejectActions: {
    flexDirection: "row-reverse",
    gap: space.sm,
    marginTop: space.xs,
  },
  cancelRejectBtn: {
    alignItems: "center",
    backgroundColor: colors.canvas,
    borderRadius: radius.field,
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
  },
  cancelRejectText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 14,
  },
  confirmRejectBtn: {
    alignItems: "center",
    backgroundColor: colors.danger,
    borderRadius: radius.field,
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
  },
  confirmRejectText: {
    color: colors.surface,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
});
