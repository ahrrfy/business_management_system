import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { AnimatedReveal } from "@/components/AnimatedReveal";
import { UnifiedScreenHeader } from "@/components/UnifiedScreenHeader";
import { colors, radius, space } from "@/constants/theme";
import { formatIqd } from "@/lib/format";
import { fetchRealTreasuryOverview, type RealTreasuryOverview } from "@/lib/operationsApi";

export default function TreasuryScreen() {
  const [data, setData] = useState<RealTreasuryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<"ALL" | "BRANCHES" | "DRAWERS">("ALL");

  const loadData = useCallback(async () => {
    try {
      const overview = await fetchRealTreasuryOverview();
      setData(overview);
    } catch (err) {
      console.error("Failed to load treasury data:", err);
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

  return (
    <View style={styles.container}>
      <UnifiedScreenHeader
        badge={{ label: "الخزينة الموحدة • إنتاج", variant: "brand" }}
        rightAction={{
          icon: "refresh-outline",
          label: "تحديث الأرصدة",
          onPress: onRefresh,
        }}
        subtitle="متابعة السيولة النقدية والورديات والأدراج"
        title="إدارة الخزينة والسيولة"
      />

      {loading && !data ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={colors.brand} size="large" />
          <Text style={styles.loadingText}>جارٍ احتساب السيولة النقدية وأرصدة الصناديق...</Text>
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
          {/* Main Liquidity Hero Card */}
          <AnimatedReveal>
            <View style={styles.heroCard}>
              <View style={styles.heroHeader}>
                <View style={styles.heroIconBox}>
                  <Ionicons color={colors.accent} name="wallet-outline" size={24} />
                </View>
                <View style={styles.heroTitles}>
                  <Text style={styles.heroLabel}>إجمالي السيولة النقدية الحالية</Text>
                  <Text style={styles.heroAmount}>{formatIqd(data?.totalLiquidCash ?? 0)}</Text>
                </View>
              </View>

              <View style={styles.heroDivider} />

              <View style={styles.heroStatsRow}>
                <View style={styles.statCol}>
                  <Text style={styles.statLabel}>رصيد الخزائن المركزية</Text>
                  <Text style={styles.statValue}>{formatIqd(data?.treasuryBalance ?? 0)}</Text>
                </View>
                <View style={styles.statColBorder} />
                <View style={styles.statCol}>
                  <Text style={styles.statLabel}>النقد في أدراج الكاشيرات</Text>
                  <Text style={styles.statValue}>{formatIqd(data?.drawerBalance ?? 0)}</Text>
                </View>
              </View>
            </View>
          </AnimatedReveal>

          {/* Daily Cash Flow Bar */}
          <AnimatedReveal delay={50}>
            <View style={styles.flowCard}>
              <Text style={styles.cardTitle}>حركة التدفق النقدي لليوم</Text>
              <View style={styles.flowGrid}>
                <View style={[styles.flowBox, styles.flowBoxInflow]}>
                  <View style={styles.flowIconBoxGreen}>
                    <Ionicons color={colors.success} name="arrow-down-outline" size={18} />
                  </View>
                  <View style={styles.flowContent}>
                    <Text style={styles.flowLabel}>المقبوضات</Text>
                    <Text style={styles.flowValueGreen}>+{formatIqd(data?.todayReceipts ?? 0)}</Text>
                  </View>
                </View>

                <View style={[styles.flowBox, styles.flowBoxOutflow]}>
                  <View style={styles.flowIconBoxRed}>
                    <Ionicons color={colors.danger} name="arrow-up-outline" size={18} />
                  </View>
                  <View style={styles.flowContent}>
                    <Text style={styles.flowLabel}>المصروفات</Text>
                    <Text style={styles.flowValueRed}>-{formatIqd(data?.todayExpenses ?? 0)}</Text>
                  </View>
                </View>
              </View>

              <View style={styles.netFlowRow}>
                <Text style={styles.netFlowLabel}>صافي التدفق النقدي اليومي:</Text>
                <Text style={[styles.netFlowValue, (data?.netTodayCashFlow ?? 0) >= 0 ? styles.positiveText : styles.negativeText]}>
                  {formatIqd(data?.netTodayCashFlow ?? 0)}
                </Text>
              </View>
            </View>
          </AnimatedReveal>

          {/* Tabs Filter */}
          <View style={styles.filterRow}>
            <Pressable
              onPress={() => {
                void Haptics.selectionAsync();
                setActiveTab("ALL");
              }}
              style={[styles.filterTab, activeTab === "ALL" && styles.filterTabActive]}
            >
              <Text style={[styles.filterTabText, activeTab === "ALL" && styles.filterTabTextActive]}>
                نظرة شاملة
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                void Haptics.selectionAsync();
                setActiveTab("BRANCHES");
              }}
              style={[styles.filterTab, activeTab === "BRANCHES" && styles.filterTabActive]}
            >
              <Text style={[styles.filterTabText, activeTab === "BRANCHES" && styles.filterTabTextActive]}>
                خزائن الفروع ({data?.branchTreasuries.length ?? 0})
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                void Haptics.selectionAsync();
                setActiveTab("DRAWERS");
              }}
              style={[styles.filterTab, activeTab === "DRAWERS" && styles.filterTabActive]}
            >
              <Text style={[styles.filterTabText, activeTab === "DRAWERS" && styles.filterTabTextActive]}>
                الأدراج النشطة ({data?.openShiftsCount ?? 0})
              </Text>
            </Pressable>
          </View>

          {/* Branch Treasuries Breakdown */}
          {activeTab === "ALL" || activeTab === "BRANCHES" ? (
            <AnimatedReveal delay={100}>
              <View style={styles.sectionBox}>
                <View style={styles.sectionHeaderRow}>
                  <Ionicons color={colors.brand} name="business-outline" size={18} />
                  <Text style={styles.sectionHeaderTitle}>أرصدة الخزائن حسب الفرع</Text>
                </View>
                {data?.branchTreasuries.map((branch, idx) => (
                  <View key={branch.branchId || idx} style={styles.itemRow}>
                    <View style={styles.itemInfo}>
                      <Text style={styles.itemTitle}>{branch.branchName}</Text>
                      <Text style={styles.itemSubtitle}>خزينة مركزية معتمدة</Text>
                    </View>
                    <Text style={styles.itemAmount}>{formatIqd(branch.balance)}</Text>
                  </View>
                ))}
              </View>
            </AnimatedReveal>
          ) : null}

          {/* Active Cash Drawers */}
          {activeTab === "ALL" || activeTab === "DRAWERS" ? (
            <AnimatedReveal delay={150}>
              <View style={styles.sectionBox}>
                <View style={styles.sectionHeaderRow}>
                  <Ionicons color={colors.accent} name="cash-outline" size={18} />
                  <Text style={styles.sectionHeaderTitle}>أدراج الكاشيرات وورديات اليوم</Text>
                </View>
                {data?.activeDrawers.map((drawer, idx) => (
                  <View key={drawer.shiftId || idx} style={styles.itemRow}>
                    <View style={styles.drawerIconBox}>
                      <Ionicons color={colors.brand} name="person" size={16} />
                    </View>
                    <View style={styles.itemInfo}>
                      <Text style={styles.itemTitle}>{drawer.cashierName}</Text>
                      <Text style={styles.itemSubtitle}>
                        وردية #{drawer.shiftId} • {drawer.branchName}
                      </Text>
                    </View>
                    <View style={styles.itemAmountCol}>
                      <Text style={styles.itemAmount}>{formatIqd(drawer.expectedCash)}</Text>
                      <Text style={styles.itemAmountLabel}>نقد في الدرج</Text>
                    </View>
                  </View>
                ))}
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
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: "#0E806A33",
    padding: space.lg,
  },
  heroHeader: {
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
  flowCard: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: 1,
    padding: space.md,
    gap: space.sm,
  },
  cardTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 15,
    textAlign: "right",
  },
  flowGrid: {
    flexDirection: "row-reverse",
    gap: space.sm,
  },
  flowBox: {
    borderRadius: radius.field,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row-reverse",
    gap: space.xs,
    padding: space.sm,
    alignItems: "center",
  },
  flowBoxInflow: {
    backgroundColor: colors.successSoft,
    borderColor: "#A7F3D0",
  },
  flowBoxOutflow: {
    backgroundColor: colors.dangerSoft,
    borderColor: "#FECACA",
  },
  flowIconBoxGreen: {
    backgroundColor: "#D1FAE5",
    borderRadius: radius.compact,
    height: 32,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  flowIconBoxRed: {
    backgroundColor: "#FEE2E2",
    borderRadius: radius.compact,
    height: 32,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  flowContent: {
    flex: 1,
  },
  flowLabel: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    textAlign: "right",
  },
  flowValueGreen: {
    color: colors.success,
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
    textAlign: "right",
  },
  flowValueRed: {
    color: colors.danger,
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
    textAlign: "right",
  },
  netFlowRow: {
    alignItems: "center",
    borderTopColor: colors.outline,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingTop: space.xs,
  },
  netFlowLabel: {
    color: colors.mutedInk,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
  },
  netFlowValue: {
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
  },
  positiveText: {
    color: colors.success,
  },
  negativeText: {
    color: colors.danger,
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
  sectionBox: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: 1,
    overflow: "hidden",
  },
  sectionHeaderRow: {
    alignItems: "center",
    backgroundColor: colors.surfaceMuted,
    borderBottomColor: colors.outline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row-reverse",
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  sectionHeaderTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    textAlign: "right",
  },
  itemRow: {
    alignItems: "center",
    borderBottomColor: colors.outline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row-reverse",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  drawerIconBox: {
    alignItems: "center",
    backgroundColor: colors.brandSoft,
    borderRadius: radius.pill,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  itemInfo: {
    flex: 1,
    gap: 2,
  },
  itemTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
    textAlign: "right",
  },
  itemSubtitle: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    textAlign: "right",
  },
  itemAmount: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    textAlign: "left",
  },
  itemAmountCol: {
    alignItems: "flex-end",
  },
  itemAmountLabel: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 10,
  },
});
