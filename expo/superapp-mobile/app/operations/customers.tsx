import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
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
import { formatIqd } from "@/lib/format";
import { fetchRealCustomers, type RealCustomer } from "@/lib/operationsApi";

export default function CustomersScreen() {
  const [customers, setCustomers] = useState<RealCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"ALL" | "DEBTORS" | "CLEAR">("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<RealCustomer | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadData = async () => {
    try {
      const realData = await fetchRealCustomers();
      setCustomers(realData);
    } catch (err) {
      console.error("Failed to load real customers:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const filteredCustomers = useMemo(() => {
    return customers.filter((cust) => {
      let matchesFilter = true;
      if (filter === "DEBTORS") matchesFilter = cust.balance > 0;
      else if (filter === "CLEAR") matchesFilter = cust.balance <= 0;

      const query = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !query ||
        cust.name.toLowerCase().includes(query) ||
        cust.phone.includes(query) ||
        (cust.city && cust.city.toLowerCase().includes(query));

      return matchesFilter && matchesSearch;
    });
  }, [customers, filter, searchQuery]);

  const totalReceivables = useMemo(() => {
    return customers.reduce((sum, c) => sum + (c.balance > 0 ? c.balance : 0), 0);
  }, [customers]);

  const debtorsCount = useMemo(() => {
    return customers.filter((c) => c.balance > 0).length;
  }, [customers]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.selectionAsync();
    await loadData();
  };

  const handleSelectCustomer = (c: RealCustomer) => {
    void Haptics.selectionAsync();
    setSelectedCustomer(c);
  };

  const makeCall = async (phone: string) => {
    const cleaned = phone.replace(/[^0-9+]/g, "");
    if (!cleaned) return;
    try {
      await Linking.openURL(`tel:${cleaned}`);
    } catch {
      setNotice(`تعذر فتح تطبيق الهاتف للرقم: ${phone}`);
      setTimeout(() => setNotice(null), 3000);
    }
  };

  const openWhatsApp = async (phone: string) => {
    const cleaned = phone.replace(/[^0-9]/g, "");
    if (!cleaned) return;
    try {
      await Linking.openURL(`https://wa.me/${cleaned}`);
    } catch {
      setNotice(`تعذر فتح واتساب للرقم: ${phone}`);
      setTimeout(() => setNotice(null), 3000);
    }
  };

  const copyPhone = (phone: string) => {
    setNotice(`تم نسخ رقم الهاتف ${phone}`);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTimeout(() => setNotice(null), 2500);
  };

  return (
    <View style={styles.page}>
      <UnifiedScreenHeader
        badge={{ label: "قاعدة الإنتاج • متصل", variant: "success" }}
        subtitle="سجل العملاء والذمم والاتصال السريع"
        title="دليل العملاء والذمم المدينة"
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl onRefresh={onRefresh} refreshing={refreshing} tintColor={colors.brand} />
        }
      >
        <AnimatedReveal delay={50} style={styles.kpiContainer}>
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>إجمالي الذمم المدينة</Text>
            <Text style={styles.kpiValue}>{formatIqd(totalReceivables)}</Text>
          </View>
          <View style={styles.kpiDivider} />
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>عملاء مدينون</Text>
            <Text style={[styles.kpiValue, { color: debtorsCount > 0 ? "#FCA5A5" : colors.surface }]}>
              {debtorsCount} عميل
            </Text>
          </View>
        </AnimatedReveal>

        {notice && (
          <View style={styles.noticeBanner}>
            <Ionicons name="information-circle" size={16} color={colors.brand} />
            <Text style={styles.noticeBannerText}>{notice}</Text>
          </View>
        )}

        <View style={styles.searchBar}>
          <Ionicons color={colors.mutedInk} name="search-outline" size={20} />
          <TextInput
            accessibilityLabel="البحث في العملاء"
            onChangeText={setSearchQuery}
            placeholder="ابحث باسم العميل أو رقم الهاتف أو المدينة..."
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
              { key: "ALL", label: `الكل (${customers.length})` },
              { key: "DEBTORS", label: `مدينون (${debtorsCount})` },
              { key: "CLEAR", label: `خالص الذمة (${customers.length - debtorsCount})` },
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
            <Text style={styles.loadingText}>جارٍ جلب العملاء والذمم من قاعدة الإنتاج…</Text>
          </View>
        ) : filteredCustomers.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons color={colors.mutedInk} name="people-outline" size={48} />
            <Text style={styles.emptyStateTitle}>لا يوجد عملاء مطابقون</Text>
            <Text style={styles.emptyStateText}>
              {searchQuery ? "جرّب تغيير كلمات البحث أو مسح الفلتر" : "لا توجد سجلات عملاء في هذا القسم"}
            </Text>
          </View>
        ) : (
          <View style={styles.customersList}>
            {filteredCustomers.map((cust, idx) => {
              const isDebtor = cust.balance > 0;
              return (
                <AnimatedReveal delay={idx * 25} key={cust.id}>
                  <Pressable
                    accessibilityLabel={`${cust.name}، الرصيد: ${cust.balance} دينار`}
                    accessibilityRole="button"
                    onPress={() => handleSelectCustomer(cust)}
                    style={({ pressed }) => [styles.customerCard, pressed && styles.customerCardPressed]}
                  >
                    <View style={styles.cardHeader}>
                      <View
                        style={[
                          styles.statusBadge,
                          { backgroundColor: isDebtor ? "#FEEBEB" : "#EAF9EF" },
                        ]}
                      >
                        <View
                          style={[
                            styles.statusDot,
                            { backgroundColor: isDebtor ? colors.danger : colors.success },
                          ]}
                        />
                        <Text
                          style={[
                            styles.statusText,
                            { color: isDebtor ? colors.danger : colors.success },
                          ]}
                        >
                          {isDebtor ? "مدين للشركة" : "خالص الذمة"}
                        </Text>
                      </View>
                      <Text style={styles.customerTypeBadge}>{cust.type}</Text>
                    </View>

                    <View style={styles.cardMain}>
                      <Text style={styles.customerName}>{cust.name}</Text>
                      <Text
                        style={[
                          styles.customerBalance,
                          isDebtor ? styles.balanceDebtor : styles.balanceClear,
                        ]}
                      >
                        {formatIqd(cust.balance)}
                      </Text>
                    </View>

                    <View style={styles.cardFooter}>
                      <View style={styles.phoneWrap}>
                        <Ionicons color={colors.mutedInk} name="call-outline" size={13} />
                        <Text style={styles.phoneText}>{cust.phone}</Text>
                      </View>
                      <View style={styles.tierWrap}>
                        <Ionicons color={colors.mutedInk} name="pricetag-outline" size={13} />
                        <Text style={styles.tierText}>فئة السعر: {cust.priceTier}</Text>
                      </View>
                    </View>
                  </Pressable>
                </AnimatedReveal>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Customer Detail Modal */}
      <Modal
        animationType="slide"
        onRequestClose={() => setSelectedCustomer(null)}
        transparent
        visible={selectedCustomer !== null}
      >
        <Pressable onPress={() => setSelectedCustomer(null)} style={styles.modalOverlay}>
          <Pressable onPress={(e) => e.stopPropagation()} style={styles.modalSheet}>
            {selectedCustomer ? (
              <>
                <View style={styles.modalHeader}>
                  <Pressable
                    accessibilityLabel="إغلاق النافذة"
                    accessibilityRole="button"
                    onPress={() => setSelectedCustomer(null)}
                    style={styles.modalCloseButton}
                  >
                    <Ionicons color={colors.mutedInk} name="close" size={22} />
                  </Pressable>
                  <View style={styles.modalTitles}>
                    <Text style={styles.modalType}>{selectedCustomer.type}</Text>
                    <Text numberOfLines={2} style={styles.modalTitle}>
                      {selectedCustomer.name}
                    </Text>
                  </View>
                </View>

                <View style={styles.modalBalanceBox}>
                  <Text style={styles.modalBalanceLabel}>الرصيد المالي الحالي:</Text>
                  <Text
                    style={[
                      styles.modalBalanceValue,
                      selectedCustomer.balance > 0 ? styles.balanceDebtor : styles.balanceClear,
                    ]}
                  >
                    {formatIqd(selectedCustomer.balance)}
                  </Text>
                  <Text style={styles.modalBalanceSub}>
                    {selectedCustomer.balance > 0
                      ? "المبلغ مطلوب من العميل لصالح الشركة"
                      : "لا توجد مستحقات مالية على هذا العميل"}
                  </Text>
                </View>

                <View style={styles.contactActions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => makeCall(selectedCustomer.phone)}
                    style={styles.contactBtn}
                  >
                    <Ionicons name="call" size={18} color="#FFF" />
                    <Text style={styles.contactBtnText}>اتصال هاتفي</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => openWhatsApp(selectedCustomer.phone)}
                    style={[styles.contactBtn, styles.whatsappBtn]}
                  >
                    <Ionicons name="logo-whatsapp" size={18} color="#FFF" />
                    <Text style={styles.contactBtnText}>واتساب</Text>
                  </Pressable>
                </View>

                <View style={styles.detailsList}>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>رقم الهاتف:</Text>
                    <Pressable onPress={() => copyPhone(selectedCustomer.phone)} style={styles.copyPhoneBtn}>
                      <Ionicons name="copy-outline" size={14} color={colors.brand} />
                      <Text style={styles.detailValue}>{selectedCustomer.phone}</Text>
                    </Pressable>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>فئة السعر المعتمدة:</Text>
                    <Text style={styles.detailValue}>{selectedCustomer.priceTier}</Text>
                  </View>
                  {selectedCustomer.city && (
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>المدينة / المنطقة:</Text>
                      <Text style={styles.detailValue}>
                        {selectedCustomer.city} {selectedCustomer.district ? `— ${selectedCustomer.district}` : ""}
                      </Text>
                    </View>
                  )}
                </View>

                <Pressable
                  accessibilityRole="button"
                  onPress={() => setSelectedCustomer(null)}
                  style={styles.closeBtn}
                >
                  <Text style={styles.closeBtnText}>إغلاق</Text>
                </Pressable>
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

  noticeBanner: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#0E806A15",
    borderWidth: 1,
    borderColor: "#0E806A40",
    borderRadius: radius.compact,
    padding: space.sm,
  },
  noticeBannerText: {
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

  customersList: { gap: space.sm },
  customerCard: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: 1,
    padding: space.md,
    gap: space.xs,
  },
  customerCardPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  cardHeader: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
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
  customerTypeBadge: {
    color: colors.mutedInk,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
  },
  cardMain: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
  },
  customerName: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 15,
    flex: 1,
    textAlign: "right",
  },
  customerBalance: {
    fontFamily: "Cairo_700Bold",
    fontSize: 16,
  },
  balanceDebtor: { color: colors.danger },
  balanceClear: { color: colors.success },
  cardFooter: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: space.xxs,
  },
  phoneWrap: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 4,
  },
  phoneText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
  },
  tierWrap: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 4,
  },
  tierText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
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
  modalType: {
    color: colors.brand,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
    textAlign: "right",
  },
  modalTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 17,
    lineHeight: 24,
    textAlign: "right",
  },
  modalCloseButton: {
    alignItems: "center",
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  modalBalanceBox: {
    backgroundColor: colors.canvas,
    borderRadius: radius.compact,
    padding: space.md,
    alignItems: "center",
    gap: 4,
  },
  modalBalanceLabel: {
    color: colors.mutedInk,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
  },
  modalBalanceValue: {
    fontFamily: "Cairo_700Bold",
    fontSize: 22,
  },
  modalBalanceSub: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    textAlign: "center",
  },
  contactActions: {
    flexDirection: "row-reverse",
    gap: space.sm,
  },
  contactBtn: {
    flex: 1,
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.brand,
    borderRadius: radius.field,
    minHeight: 46,
  },
  whatsappBtn: {
    backgroundColor: "#16A34A",
  },
  contactBtnText: {
    color: "#FFF",
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
  detailsList: {
    gap: space.xs,
    backgroundColor: colors.canvas,
    borderRadius: radius.compact,
    padding: space.sm,
  },
  detailRow: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  detailLabel: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 13,
  },
  detailValue: {
    color: colors.ink,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
  },
  copyPhoneBtn: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 4,
  },
  closeBtn: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderWidth: 1,
    borderRadius: radius.field,
    justifyContent: "center",
    minHeight: 46,
  },
  closeBtnText: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
});
