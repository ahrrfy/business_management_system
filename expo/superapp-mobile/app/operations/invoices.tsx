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
import { UnifiedScreenHeader } from "@/components/UnifiedScreenHeader";
import { colors, radius, space } from "@/constants/theme";
import { formatIqd, formatQuantity } from "@/lib/format";
import { fetchRealInvoiceDetails, fetchRealInvoices, getTodayBaghdadYmd, type RealInvoice } from "@/lib/operationsApi";

type InvoiceStatus = "PAID" | "PARTIALLY_PAID" | "PENDING" | "CANCELLED" | "RETURNED" | "SUPERSEDED";

const statusConfig: Record<InvoiceStatus, { label: string; tone: string; bg: string }> = {
  PAID: { label: "مسددة بالكامل", tone: colors.success, bg: "#EAF9EF" },
  PARTIALLY_PAID: { label: "مسددة جزئياً", tone: colors.info, bg: "#EEF3FB" },
  PENDING: { label: "أجل / معلقة", tone: colors.warning, bg: "#FEF7E6" },
  CANCELLED: { label: "ملغاة", tone: colors.danger, bg: "#FEEBEB" },
  RETURNED: { label: "مرتجعة", tone: colors.danger, bg: "#FEEBEB" },
  SUPERSEDED: { label: "مستبدلة", tone: colors.mutedInk, bg: "#F3F4F6" },
};

const paymentConfig: Record<string, string> = {
  CASH: "نقداً",
  CARD: "بطاقة مصرفية",
  WALLET: "محفظة إلكترونية",
  TRANSFER: "حوالة مصرفية",
  MIXED: "دفع مختلط",
  CREDIT: "حساب آجل",
};

export default function InvoicesScreen() {
  const [invoices, setInvoices] = useState<RealInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"ALL" | InvoiceStatus>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState<RealInvoice | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);

  const loadData = async () => {
    try {
      const realData = await fetchRealInvoices({ limit: 60 });
      setInvoices(realData);
    } catch (err) {
      console.error("Failed to load real invoices:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const filteredInvoices = useMemo(() => {
    return invoices.filter((inv) => {
      const matchesFilter = filter === "ALL" || inv.status === filter;
      const query = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !query ||
        inv.invoiceNumber.toLowerCase().includes(query) ||
        inv.customerName.toLowerCase().includes(query) ||
        inv.branchName.toLowerCase().includes(query) ||
        (inv.salespersonName && inv.salespersonName.toLowerCase().includes(query));
      return matchesFilter && matchesSearch;
    });
  }, [invoices, filter, searchQuery]);

  const todaySales = useMemo(() => {
    const todayYmd = getTodayBaghdadYmd();
    return invoices
      .filter(
        (inv) =>
          (inv.status === "PAID" || inv.status === "PARTIALLY_PAID") &&
          inv.invoiceDateYmd === todayYmd,
      )
      .reduce((sum, inv) => sum + inv.paidAmount, 0);
  }, [invoices]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.selectionAsync();
    await loadData();
  };

  const handleSelectInvoice = async (inv: RealInvoice) => {
    void Haptics.selectionAsync();
    setSelectedInvoice(inv);
    setDetailsLoading(true);
    try {
      const details = await fetchRealInvoiceDetails(Number(inv.id));
      if (details?.items && details.items.length > 0) {
        setSelectedInvoice((prev) =>
          prev && prev.id === inv.id
            ? { ...prev, items: details.items, itemCount: details.items.length }
            : prev,
        );
      }
    } catch (e) {
      console.error("Failed to load invoice items:", e);
    } finally {
      setDetailsLoading(false);
    }
  };

  const copyInvoiceNumber = (num: string) => {
    setCopiedNotice(`تم نسخ رقم الفاتورة ${num}`);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTimeout(() => setCopiedNotice(null), 2500);
  };

  return (
    <View style={styles.page}>
      <UnifiedScreenHeader
        badge={{ label: "قاعدة الإنتاج • متصل", variant: "success" }}
        subtitle="سجل المبيعات والمدفوعات اللحظي"
        title="سجل الفواتير والمبيعات"
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl onRefresh={onRefresh} refreshing={refreshing} tintColor={colors.brand} />
        }
      >
        <AnimatedReveal delay={50} style={styles.kpiContainer}>
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>مبيعات اليوم المحصلة</Text>
            <Text style={styles.kpiValue}>{formatIqd(todaySales)}</Text>
          </View>
          <View style={styles.kpiDivider} />
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>عدد الفواتير المنزلة</Text>
            <Text style={styles.kpiValue}>{invoices.length} فاتورة حقيقية</Text>
          </View>
        </AnimatedReveal>

        {copiedNotice && (
          <View style={styles.copiedBanner}>
            <Ionicons name="checkmark-circle" size={16} color={colors.brand} />
            <Text style={styles.copiedBannerText}>{copiedNotice}</Text>
          </View>
        )}

        <View style={styles.searchBar}>
          <Ionicons color={colors.mutedInk} name="search-outline" size={20} />
          <TextInput
            accessibilityLabel="البحث في الفواتير"
            onChangeText={setSearchQuery}
            placeholder="ابحث برقم الفاتورة، اسم العميل، البائع، أو الفرع..."
            placeholderTextColor={colors.mutedInk}
            style={styles.searchInput}
            value={searchQuery}
          />
          {searchQuery ? (
            <Pressable
              accessibilityLabel="مسح البحث"
              accessibilityRole="button"
              onPress={() => setSearchQuery("")}
            >
              <Ionicons color={colors.mutedInk} name="close-circle" size={18} />
            </Pressable>
          ) : null}
        </View>

        <View style={styles.filterTabs}>
          {(
            [
              { key: "ALL", label: "الكل" },
              { key: "PAID", label: "مسددة" },
              { key: "PENDING", label: "معلقة / آجل" },
              { key: "CANCELLED", label: "ملغاة" },
            ] as const
          ).map((tab) => (
            <Pressable
              accessibilityLabel={`تصفية حسب: ${tab.label}`}
              accessibilityRole="button"
              key={tab.key}
              onPress={() => {
                void Haptics.selectionAsync();
                setFilter(tab.key);
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
            <Text style={styles.loadingText}>جارٍ جلب الفواتير الحية من قاعدة بيانات الإنتاج…</Text>
          </View>
        ) : filteredInvoices.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons color={colors.mutedInk} name="document-text-outline" size={48} />
            <Text style={styles.emptyStateTitle}>لا توجد فواتير مطابقة</Text>
            <Text style={styles.emptyStateText}>
              {searchQuery ? "جرّب تغيير كلمات البحث أو مسح الفلتر" : "لا توجد أي فواتير مسجلة في هذا القسم"}
            </Text>
          </View>
        ) : (
          <View style={styles.invoicesList}>
            {filteredInvoices.map((inv, idx) => {
              const cfg = statusConfig[inv.status];
              return (
                <AnimatedReveal delay={idx * 30} key={inv.id}>
                  <Pressable
                    accessibilityLabel={`فاتورة رقم ${inv.invoiceNumber} بقيمة ${inv.amount} دينار`}
                    accessibilityRole="button"
                    onPress={() => handleSelectInvoice(inv)}
                    style={({ pressed }) => [styles.invoiceCard, pressed && styles.invoiceCardPressed]}
                  >
                    <View style={styles.cardHeader}>
                      <View style={[styles.statusBadge, { backgroundColor: cfg.bg }]}>
                        <View style={[styles.statusDot, { backgroundColor: cfg.tone }]} />
                        <Text style={[styles.statusText, { color: cfg.tone }]}>{cfg.label}</Text>
                      </View>
                      <Text style={styles.invoiceNumber}>#{inv.invoiceNumber}</Text>
                    </View>

                    <View style={styles.cardBody}>
                      <View style={styles.infoRow}>
                        <Text style={styles.customerName}>{inv.customerName}</Text>
                        <Text style={styles.invoiceAmount}>{formatIqd(inv.amount)}</Text>
                      </View>

                      <View style={styles.metaRow}>
                        <View style={styles.metaItem}>
                          <Ionicons color={colors.mutedInk} name="business-outline" size={13} />
                          <Text style={styles.metaText}>{inv.branchName}</Text>
                        </View>
                        {inv.salespersonName && (
                          <View style={styles.metaItem}>
                            <Ionicons color={colors.mutedInk} name="person-outline" size={13} />
                            <Text style={styles.metaText}>{inv.salespersonName}</Text>
                          </View>
                        )}
                        <View style={styles.metaItem}>
                          <Ionicons color={colors.mutedInk} name="time-outline" size={13} />
                          <Text style={styles.metaText}>{inv.createdAt}</Text>
                        </View>
                        <View style={styles.metaItem}>
                          <Ionicons color={colors.mutedInk} name="wallet-outline" size={13} />
                          <Text style={styles.metaText}>{paymentConfig[inv.paymentMethod]}</Text>
                        </View>
                      </View>
                    </View>
                  </Pressable>
                </AnimatedReveal>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Invoice Detail Modal */}
      <Modal
        animationType="slide"
        onRequestClose={() => setSelectedInvoice(null)}
        transparent
        visible={selectedInvoice !== null}
      >
        <Pressable onPress={() => setSelectedInvoice(null)} style={styles.modalOverlay}>
          <Pressable onPress={(e) => e.stopPropagation()} style={styles.modalSheet}>
            {selectedInvoice ? (
              <>
                <View style={styles.modalHeader}>
                  <Pressable
                    accessibilityLabel="إغلاق النافذة"
                    accessibilityRole="button"
                    onPress={() => setSelectedInvoice(null)}
                    style={styles.modalCloseButton}
                  >
                    <Ionicons color={colors.mutedInk} name="close" size={22} />
                  </Pressable>
                  <View style={styles.modalTitles}>
                    <Text style={styles.modalTitle}>تفاصيل الفاتورة #{selectedInvoice.invoiceNumber}</Text>
                    <Text style={styles.modalSubtitle}>{selectedInvoice.branchName}</Text>
                  </View>
                </View>

                <View style={styles.modalSummary}>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryLabel}>العميل</Text>
                    <Text style={styles.summaryValue}>{selectedInvoice.customerName}</Text>
                    {selectedInvoice.customerPhone && (
                      <Text style={styles.summarySub}>{selectedInvoice.customerPhone}</Text>
                    )}
                  </View>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryLabel}>التاريخ والوقت</Text>
                    <Text style={styles.summaryValue}>{selectedInvoice.createdAt}</Text>
                  </View>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryLabel}>طريقة السداد</Text>
                    <Text style={styles.summaryValue}>{paymentConfig[selectedInvoice.paymentMethod]}</Text>
                  </View>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryLabel}>حالة الفاتورة</Text>
                    <Text
                      style={[
                        styles.summaryValue,
                        { color: statusConfig[selectedInvoice.status].tone },
                      ]}
                    >
                      {statusConfig[selectedInvoice.status].label}
                    </Text>
                  </View>
                </View>

                <View style={styles.itemsHeader}>
                  <Text style={styles.itemsTitle}>بنود ومواد الفاتورة</Text>
                  {detailsLoading ? <ActivityIndicator color={colors.brand} size="small" /> : null}
                </View>

                <ScrollView style={styles.itemsList}>
                  {selectedInvoice.items.map((item, i) => (
                    <View key={i} style={styles.itemRow}>
                      <View style={styles.itemInfo}>
                        <Text style={styles.itemName}>{item.name}</Text>
                        <Text style={styles.itemMeta}>
                          {formatQuantity(item.qty)} × {formatIqd(item.unitPrice)}
                        </Text>
                      </View>
                      <Text style={styles.itemTotal}>{formatIqd(item.total)}</Text>
                    </View>
                  ))}
                </ScrollView>

                <View style={styles.totalSection}>
                  <Text style={styles.totalLabel}>المبلغ الصافي الإجمالي:</Text>
                  <Text style={styles.totalValue}>{formatIqd(selectedInvoice.amount)}</Text>
                </View>

                {/* Modal Action Buttons */}
                <View style={styles.modalActionsRow}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => copyInvoiceNumber(selectedInvoice.invoiceNumber)}
                    style={styles.modalActionSecondary}
                  >
                    <Ionicons name="copy-outline" size={18} color={colors.brand} />
                    <Text style={styles.modalActionSecondaryText}>نسخ رقم الفاتورة</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setSelectedInvoice(null)}
                    style={styles.modalActionPrimary}
                  >
                    <Text style={styles.modalActionPrimaryText}>إغلاق</Text>
                  </Pressable>
                </View>
              </>
            ) : null}
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

  copiedBanner: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#0E806A15",
    borderWidth: 1,
    borderColor: "#0E806A40",
    borderRadius: radius.compact,
    padding: space.sm,
  },
  copiedBannerText: {
    color: colors.brand,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
  },

  searchBar: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.field,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: space.xs,
    paddingHorizontal: space.sm,
  },
  searchInput: {
    color: colors.ink,
    flex: 1,
    fontFamily: "Cairo_400Regular",
    fontSize: 14,
    minHeight: 44,
    textAlign: "right",
  },
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

  invoicesList: { gap: space.sm },
  invoiceCard: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: 1,
    padding: space.md,
    gap: space.xs,
  },
  invoiceCardPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  cardHeader: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
  },
  invoiceNumber: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
  statusBadge: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
  },
  cardBody: { gap: space.xxs },
  infoRow: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
  },
  customerName: {
    color: colors.ink,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 15,
  },
  invoiceAmount: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 16,
  },
  metaRow: {
    flexDirection: "row-reverse",
    flexWrap: "wrap",
    gap: space.sm,
    marginTop: space.xxs,
  },
  metaItem: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 4,
  },
  metaText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
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
    alignItems: "center",
    borderBottomColor: colors.outline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: space.sm,
  },
  modalTitles: { flex: 1 },
  modalTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 16,
    textAlign: "right",
  },
  modalSubtitle: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    textAlign: "right",
  },
  modalCloseButton: {
    alignItems: "center",
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  modalSummary: {
    flexDirection: "row-reverse",
    flexWrap: "wrap",
    gap: space.sm,
    backgroundColor: colors.canvas,
    borderRadius: radius.compact,
    padding: space.sm,
  },
  summaryItem: {
    width: "48%",
    gap: 2,
  },
  summaryLabel: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    textAlign: "right",
  },
  summaryValue: {
    color: colors.ink,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
    textAlign: "right",
  },
  summarySub: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    textAlign: "right",
  },
  itemsHeader: {
    borderBottomColor: colors.outline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: space.xxs,
  },
  itemsTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    textAlign: "right",
  },
  itemsList: { maxHeight: 200 },
  itemRow: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: space.xs,
    borderBottomColor: colors.outline,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  itemInfo: { flex: 1, gap: 2 },
  itemName: {
    color: colors.ink,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
    textAlign: "right",
  },
  itemMeta: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    textAlign: "right",
  },
  itemTotal: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
  totalSection: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.brandSoft,
    borderRadius: radius.compact,
    padding: space.sm,
  },
  totalLabel: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
  totalValue: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 18,
  },
  modalActionsRow: {
    flexDirection: "row-reverse",
    gap: space.sm,
    marginTop: space.xs,
  },
  modalActionPrimary: {
    flex: 1,
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.field,
    justifyContent: "center",
    minHeight: 46,
  },
  modalActionPrimaryText: {
    color: "#FFF",
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
  modalActionSecondary: {
    flex: 1,
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.surface,
    borderColor: colors.brand,
    borderWidth: 1,
    borderRadius: radius.field,
    justifyContent: "center",
    minHeight: 46,
  },
  modalActionSecondaryText: {
    color: colors.brand,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 14,
  },
});
