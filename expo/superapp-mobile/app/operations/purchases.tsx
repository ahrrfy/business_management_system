import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
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
import {
  fetchRealPurchases,
  fetchRealSuppliers,
  type RealPurchaseOrder,
  type RealSupplier,
} from "@/lib/operationsApi";

export default function PurchasesScreen() {
  const [purchases, setPurchases] = useState<RealPurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<RealSupplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<"ORDERS" | "SUPPLIERS">("ORDERS");
  const [searchQuery, setSearchQuery] = useState("");

  const loadData = useCallback(async () => {
    try {
      const [pList, sList] = await Promise.all([
        fetchRealPurchases(),
        fetchRealSuppliers(),
      ]);
      setPurchases(pList);
      setSuppliers(sList);
    } catch (err) {
      console.error("Failed to load purchases data:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const onRefresh = () => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void loadData();
  };

  const totalAp = useMemo(() => {
    return suppliers.reduce((sum, s) => sum + Math.max(0, s.currentBalance), 0);
  }, [suppliers]);

  const filteredOrders = useMemo(() => {
    if (!searchQuery.trim()) return purchases;
    const q = searchQuery.trim().toLowerCase();
    return purchases.filter(
      (po) =>
        po.poNumber.toLowerCase().includes(q) ||
        po.supplierName.toLowerCase().includes(q),
    );
  }, [purchases, searchQuery]);

  const filteredSuppliers = useMemo(() => {
    if (!searchQuery.trim()) return suppliers;
    const q = searchQuery.trim().toLowerCase();
    return suppliers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.phone && s.phone.includes(q)),
    );
  }, [suppliers, searchQuery]);

  const callPhone = (phone?: string) => {
    if (!phone) return;
    void Haptics.selectionAsync();
    void Linking.openURL(`tel:${phone}`);
  };

  const openWhatsApp = (phone?: string) => {
    if (!phone) return;
    void Haptics.selectionAsync();
    const cleanPhone = phone.replace(/[^0-9]/g, "");
    void Linking.openURL(`https://wa.me/${cleanPhone}`);
  };

  return (
    <View style={styles.container}>
      <UnifiedScreenHeader
        badge={{ label: "المشتريات • إنتاج", variant: "brand" }}
        rightAction={{
          icon: "refresh-outline",
          label: "تحديث المشتريات",
          onPress: onRefresh,
        }}
        subtitle="أوامر الشراء ومستحقات الموردين (AP)"
        title="إدارة المشتريات والموردين"
      />

      {loading && purchases.length === 0 ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={colors.brand} size="large" />
          <Text style={styles.loadingText}>جارٍ تحميل سجل المشتريات وحسابات الموردين...</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              colors={[colors.brand]}
              onRefresh={onRefresh}
              refreshing={refreshing}
              tintColor={colors.brand}
            />
          }
          style={styles.scrollArea}
        >
          {/* Executive AP KPI Banner */}
          <AnimatedReveal>
            <View style={styles.heroCard}>
              <View style={styles.heroTop}>
                <View style={styles.heroIconBox}>
                  <Ionicons color={colors.accent} name="business-outline" size={24} />
                </View>
                <View style={styles.heroTitles}>
                  <Text style={styles.heroLabel}>إجمالي مستحقات الموردين (ذمم دائنة AP)</Text>
                  <Text style={styles.heroAmount}>{formatIqd(totalAp)}</Text>
                </View>
              </View>

              <View style={styles.heroDivider} />

              <View style={styles.heroStatsRow}>
                <View style={styles.statCol}>
                  <Text style={styles.statLabel}>إجمالي الموردين المعتمدين</Text>
                  <Text style={styles.statValue}>{suppliers.length} مورد</Text>
                </View>
                <View style={styles.statColBorder} />
                <View style={styles.statCol}>
                  <Text style={styles.statLabel}>أوامر الشراء المسجلة</Text>
                  <Text style={styles.statValue}>{purchases.length} أمر شراء</Text>
                </View>
              </View>
            </View>
          </AnimatedReveal>

          {/* Search Input */}
          <View style={styles.searchBox}>
            <Ionicons color={colors.mutedInk} name="search-outline" size={20} />
            <TextInput
              onChangeText={setSearchQuery}
              placeholder="ابحث برقم الأمر أو اسم المورد..."
              placeholderTextColor={colors.mutedInk}
              style={styles.searchInput}
              value={searchQuery}
            />
            {searchQuery.length > 0 ? (
              <Pressable
                onPress={() => setSearchQuery("")}
                style={styles.clearSearchBtn}
              >
                <Ionicons color={colors.mutedInk} name="close-circle" size={18} />
              </Pressable>
            ) : null}
          </View>

          {/* Tab Selector */}
          <View style={styles.filterRow}>
            <Pressable
              onPress={() => {
                void Haptics.selectionAsync();
                setActiveTab("ORDERS");
              }}
              style={[styles.filterTab, activeTab === "ORDERS" && styles.filterTabActive]}
            >
              <Text style={[styles.filterTabText, activeTab === "ORDERS" && styles.filterTabTextActive]}>
                أوامر الشراء ({filteredOrders.length})
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                void Haptics.selectionAsync();
                setActiveTab("SUPPLIERS");
              }}
              style={[styles.filterTab, activeTab === "SUPPLIERS" && styles.filterTabActive]}
            >
              <Text style={[styles.filterTabText, activeTab === "SUPPLIERS" && styles.filterTabTextActive]}>
                دليل الموردين ({filteredSuppliers.length})
              </Text>
            </Pressable>
          </View>

          {/* Orders List */}
          {activeTab === "ORDERS" ? (
            <AnimatedReveal delay={50}>
              <View style={styles.cardsList}>
                {filteredOrders.length === 0 ? (
                  <View style={styles.emptyCard}>
                    <Ionicons color={colors.mutedInk} name="document-text-outline" size={32} />
                    <Text style={styles.emptyText}>لا توجد أوامر شراء مطابقة للبحث</Text>
                  </View>
                ) : (
                  filteredOrders.map((po) => (
                    <View key={po.id} style={styles.orderCard}>
                      <View style={styles.orderHeader}>
                        <View style={styles.orderBadge}>
                          <Text style={styles.orderBadgeText}>{po.poNumber}</Text>
                        </View>
                        <Text style={styles.orderDate}>{po.orderDate}</Text>
                      </View>

                      <View style={styles.orderBody}>
                        <Text style={styles.supplierTitle}>{po.supplierName}</Text>
                        <View style={styles.priceRow}>
                          <Text style={styles.orderTotal}>{formatIqd(po.total)}</Text>
                          <View
                            style={[
                              styles.statusPill,
                              po.status === "RECEIVED" ? styles.statusPillGreen : styles.statusPillOrange,
                            ]}
                          >
                            <Text
                              style={[
                                styles.statusPillText,
                                po.status === "RECEIVED" ? styles.statusTextGreen : styles.statusTextOrange,
                              ]}
                            >
                              {po.status === "RECEIVED"
                                ? "مستلم في المستودع"
                                : po.status === "CONFIRMED"
                                ? "مؤكد قيد التوريد"
                                : "مسودة"}
                            </Text>
                          </View>
                        </View>
                      </View>
                    </View>
                  ))
                )}
              </View>
            </AnimatedReveal>
          ) : null}

          {/* Suppliers List */}
          {activeTab === "SUPPLIERS" ? (
            <AnimatedReveal delay={50}>
              <View style={styles.cardsList}>
                {filteredSuppliers.length === 0 ? (
                  <View style={styles.emptyCard}>
                    <Ionicons color={colors.mutedInk} name="people-outline" size={32} />
                    <Text style={styles.emptyText}>لا يوجد موردون مطابقون للبحث</Text>
                  </View>
                ) : (
                  filteredSuppliers.map((supplier) => (
                    <View key={supplier.id} style={styles.supplierCard}>
                      <View style={styles.supplierTopRow}>
                        <View style={styles.supplierAvatar}>
                          <Text style={styles.supplierAvatarText}>
                            {supplier.name.slice(0, 1)}
                          </Text>
                        </View>
                        <View style={styles.supplierInfoCol}>
                          <Text style={styles.supplierNameText}>{supplier.name}</Text>
                          <Text style={styles.supplierPhoneText}>{supplier.phone}</Text>
                        </View>
                        <View style={styles.supplierBalanceCol}>
                          <Text style={styles.supplierBalanceText}>
                            {formatIqd(supplier.currentBalance)}
                          </Text>
                          <Text style={styles.supplierBalanceLabel}>
                            {supplier.currentBalance > 0 ? "مستحق له" : "مسدد"}
                          </Text>
                        </View>
                      </View>

                      <View style={styles.supplierActionsRow}>
                        <Pressable
                          onPress={() => callPhone(supplier.phone)}
                          style={styles.actionBtnOutline}
                        >
                          <Ionicons color={colors.brand} name="call-outline" size={16} />
                          <Text style={styles.actionBtnOutlineText}>اتصال هاتف</Text>
                        </Pressable>

                        <Pressable
                          onPress={() => openWhatsApp(supplier.phone)}
                          style={styles.actionBtnWhatsApp}
                        >
                          <Ionicons color="#25D366" name="logo-whatsapp" size={16} />
                          <Text style={styles.actionBtnWhatsAppText}>مراسلة وتنسيق</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))
                )}
              </View>
            </AnimatedReveal>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.canvas,
    flex: 1,
  },
  loadingBox: {
    alignItems: "center",
    flex: 1,
    gap: space.md,
    justifyContent: "center",
    padding: space.xl,
  },
  loadingText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 14,
    textAlign: "center",
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    gap: space.md,
    padding: space.md,
    paddingBottom: 40,
  },
  heroCard: {
    backgroundColor: colors.brandDark,
    borderColor: "#0E806A33",
    borderRadius: radius.card,
    borderWidth: 1,
    padding: space.lg,
  },
  heroTop: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: space.md,
  },
  heroIconBox: {
    alignItems: "center",
    backgroundColor: "#0E806A33",
    borderRadius: radius.field,
    height: 48,
    justifyContent: "center",
    width: 48,
  },
  heroTitles: {
    flex: 1,
    gap: 2,
  },
  heroLabel: {
    color: colors.accent,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
    textAlign: "right",
  },
  heroAmount: {
    color: colors.surface,
    fontFamily: "Cairo_700Bold",
    fontSize: 26,
    lineHeight: 36,
    textAlign: "right",
  },
  heroDivider: {
    backgroundColor: "#FFFFFF1A",
    height: StyleSheet.hairlineWidth,
    marginVertical: space.md,
  },
  heroStatsRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  statCol: {
    flex: 1,
    gap: 2,
  },
  statColBorder: {
    backgroundColor: "#FFFFFF1A",
    height: 36,
    width: StyleSheet.hairlineWidth,
  },
  statLabel: {
    color: "#C5D8D3",
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    textAlign: "right",
  },
  statValue: {
    color: colors.surface,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    textAlign: "right",
  },
  searchBox: {
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
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
    minHeight: 44,
    textAlign: "right",
  },
  clearSearchBtn: {
    padding: 4,
  },
  filterRow: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.field,
    flexDirection: "row-reverse",
    gap: 4,
    padding: 4,
  },
  filterTab: {
    alignItems: "center",
    borderRadius: radius.compact,
    flex: 1,
    justifyContent: "center",
    minHeight: 36,
  },
  filterTabActive: {
    backgroundColor: colors.surface,
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
  },
  filterTabText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
  },
  filterTabTextActive: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
  },
  cardsList: {
    gap: space.sm,
  },
  emptyCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: 1,
    gap: space.xs,
    padding: space.xl,
  },
  emptyText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
  },
  orderCard: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: 1,
    gap: space.xs,
    padding: space.md,
  },
  orderHeader: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  orderBadge: {
    backgroundColor: colors.brandSoft,
    borderRadius: radius.compact,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  orderBadgeText: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
  orderDate: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
  },
  orderBody: {
    gap: 4,
  },
  supplierTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    textAlign: "right",
  },
  priceRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  orderTotal: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 15,
  },
  statusPill: {
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  statusPillGreen: {
    backgroundColor: colors.successSoft,
  },
  statusPillOrange: {
    backgroundColor: colors.warningSoft,
  },
  statusPillText: {
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
  },
  statusTextGreen: {
    color: colors.success,
  },
  statusTextOrange: {
    color: colors.warning,
  },
  supplierCard: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: 1,
    gap: space.sm,
    padding: space.md,
  },
  supplierTopRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: space.sm,
  },
  supplierAvatar: {
    alignItems: "center",
    backgroundColor: colors.brandSoft,
    borderRadius: radius.pill,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  supplierAvatarText: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 16,
  },
  supplierInfoCol: {
    flex: 1,
    gap: 2,
  },
  supplierNameText: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    textAlign: "right",
  },
  supplierPhoneText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    textAlign: "right",
  },
  supplierBalanceCol: {
    alignItems: "flex-end",
    gap: 2,
  },
  supplierBalanceText: {
    color: colors.danger,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
  supplierBalanceLabel: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 10,
  },
  supplierActionsRow: {
    borderTopColor: colors.outline,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row-reverse",
    gap: space.sm,
    paddingTop: space.xs,
  },
  actionBtnOutline: {
    alignItems: "center",
    borderColor: colors.outline,
    borderRadius: radius.compact,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row-reverse",
    gap: 6,
    justifyContent: "center",
    minHeight: 36,
  },
  actionBtnOutlineText: {
    color: colors.ink,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
  },
  actionBtnWhatsApp: {
    alignItems: "center",
    backgroundColor: "#F0FDF4",
    borderColor: "#BBF7D0",
    borderRadius: radius.compact,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row-reverse",
    gap: 6,
    justifyContent: "center",
    minHeight: 36,
  },
  actionBtnWhatsAppText: {
    color: "#166534",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
  },
});
