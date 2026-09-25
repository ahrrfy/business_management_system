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
import { fetchRealInventory, type RealInventoryItem } from "@/lib/operationsApi";

type StockStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";

const statusBadgeConfig: Record<StockStatus, { label: string; color: string; bg: string }> = {
  IN_STOCK: { label: "متوفر بالمخازن", color: colors.success, bg: "#EAF9EF" },
  LOW_STOCK: { label: "مخزون حرج", color: colors.warning, bg: "#FEF7E6" },
  OUT_OF_STOCK: { label: "نافد من الفرع", color: colors.danger, bg: "#FEEBEB" },
};

export default function InventoryScreen() {
  const [items, setItems] = useState<RealInventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"ALL" | StockStatus>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedItem, setSelectedItem] = useState<RealInventoryItem | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);

  const loadData = async (query?: string) => {
    try {
      const realData = await fetchRealInventory({ query, limit: 80 });
      setItems(realData);
    } catch (err) {
      console.error("Failed to load real inventory:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleSearch = (text: string) => {
    setSearchQuery(text);
    if (text.trim().length > 1) {
      void loadData(text.trim());
    } else if (text.trim().length === 0) {
      void loadData();
    }
  };

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchesFilter = filter === "ALL" || item.status === filter;
      const query = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !query ||
        item.name.toLowerCase().includes(query) ||
        item.barcode.includes(query) ||
        item.category.toLowerCase().includes(query);
      return matchesFilter && matchesSearch;
    });
  }, [items, filter, searchQuery]);

  const totalItemsCount = items.length;
  const criticalItemsCount = useMemo(() => {
    return items.filter((item) => item.status === "LOW_STOCK" || item.status === "OUT_OF_STOCK").length;
  }, [items]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.selectionAsync();
    await loadData(searchQuery.trim() || undefined);
  };

  const handleSelectItem = (item: RealInventoryItem) => {
    void Haptics.selectionAsync();
    setSelectedItem(item);
  };

  const copyBarcode = (barcode: string) => {
    setCopiedNotice(`تم نسخ الباركود ${barcode}`);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTimeout(() => setCopiedNotice(null), 2500);
  };

  return (
    <View style={styles.page}>
      <UnifiedScreenHeader
        badge={{ label: "قاعدة الإنتاج • متصل", variant: "success" }}
        subtitle="مخزون الفروع الحقيقي (المنصور والكرادة)"
        title="إدارة المخزون والأصناف"
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl onRefresh={onRefresh} refreshing={refreshing} tintColor={colors.brand} />
        }
      >
        <AnimatedReveal delay={50} style={styles.kpiContainer}>
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>الأصناف الحية المعروضة</Text>
            <Text style={styles.kpiValue}>{totalItemsCount} صنف</Text>
          </View>
          <View style={styles.kpiDivider} />
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>أصناف حرجة / نافدة</Text>
            <Text style={[styles.kpiValue, { color: criticalItemsCount > 0 ? "#FCA5A5" : colors.surface }]}>
              {criticalItemsCount} صنف
            </Text>
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
            accessibilityLabel="البحث في المخزون"
            onChangeText={handleSearch}
            placeholder="ابحث باسم الصنف، الباركود، أو التصنيف..."
            placeholderTextColor={colors.mutedInk}
            style={styles.searchInput}
            value={searchQuery}
          />
          {searchQuery ? (
            <Pressable
              accessibilityLabel="مسح البحث"
              accessibilityRole="button"
              onPress={() => handleSearch("")}
            >
              <Ionicons color={colors.mutedInk} name="close-circle" size={18} />
            </Pressable>
          ) : null}
        </View>

        <View style={styles.filterTabs}>
          {(
            [
              { key: "ALL", label: "الكل" },
              { key: "IN_STOCK", label: "متوفر" },
              { key: "LOW_STOCK", label: "حرج" },
              { key: "OUT_OF_STOCK", label: "نافد" },
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
            <Text style={styles.loadingText}>جارٍ جلب المخزون الحي من قاعدة الإنتاج…</Text>
          </View>
        ) : filteredItems.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons color={colors.mutedInk} name="cube-outline" size={48} />
            <Text style={styles.emptyStateTitle}>لا توجد أصناف مطابقة</Text>
            <Text style={styles.emptyStateText}>
              {searchQuery ? "جرّب كتابة كلمة بحث أخرى أو مسح الفلتر" : "لا توجد أصناف مسجلة في هذا التصنيف"}
            </Text>
          </View>
        ) : (
          <View style={styles.itemsList}>
            {filteredItems.map((item, idx) => {
              const cfg = statusBadgeConfig[item.status];
              return (
                <AnimatedReveal delay={idx * 25} key={item.id}>
                  <Pressable
                    accessibilityLabel={`${item.name}، الكمية المتاحة ${formatQuantity(item.branchMansourQty)}`}
                    accessibilityRole="button"
                    onPress={() => handleSelectItem(item)}
                    style={({ pressed }) => [styles.itemCard, pressed && styles.itemCardPressed]}
                  >
                    <View style={styles.cardHeader}>
                      <View style={[styles.statusBadge, { backgroundColor: cfg.bg }]}>
                        <View style={[styles.statusDot, { backgroundColor: cfg.color }]} />
                        <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
                      </View>
                      <View style={styles.categoryBadge}>
                        <Text style={styles.categoryText}>{item.category}</Text>
                      </View>
                    </View>

                    <Text numberOfLines={2} style={styles.itemName}>
                      {item.name}
                    </Text>

                    <View style={styles.metaRow}>
                      <View style={styles.barcodeWrap}>
                        <Ionicons color={colors.mutedInk} name="barcode-outline" size={14} />
                        <Text style={styles.barcodeText}>{item.barcode}</Text>
                      </View>
                      <Text style={styles.itemPrice}>{formatIqd(item.unitPrice)}</Text>
                    </View>

                    <View style={styles.stockRow}>
                      <View style={styles.branchStock}>
                        <Text style={styles.branchLabel}>فرع المنصور:</Text>
                        <Text
                          style={[
                            styles.branchQty,
                            item.branchMansourQty <= 0 && styles.qtyOut,
                            item.branchMansourQty > 0 &&
                              item.branchMansourQty <= item.reorderLevel &&
                              styles.qtyLow,
                          ]}
                        >
                          {formatQuantity(item.branchMansourQty)} {item.unit}
                        </Text>
                      </View>
                      <View style={styles.branchStock}>
                        <Text style={styles.branchLabel}>حد الطلب:</Text>
                        <Text style={styles.branchSubQty}>{formatQuantity(item.reorderLevel)} {item.unit}</Text>
                      </View>
                    </View>
                  </Pressable>
                </AnimatedReveal>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Item Detail Modal */}
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
                    <Text style={styles.modalCategory}>{selectedItem.category}</Text>
                    <Text numberOfLines={2} style={styles.modalTitle}>
                      {selectedItem.name}
                    </Text>
                  </View>
                </View>

                <View style={styles.modalDetails}>
                  <View style={styles.detailBox}>
                    <Text style={styles.detailLabel}>سعر البيع المعتمد</Text>
                    <Text style={styles.detailPrice}>{formatIqd(selectedItem.unitPrice)}</Text>
                  </View>

                  <View style={styles.detailBox}>
                    <Text style={styles.detailLabel}>الباركود التسلسلي</Text>
                    <Text style={styles.detailBarcode}>{selectedItem.barcode}</Text>
                  </View>
                </View>

                <View style={styles.branchSection}>
                  <Text style={styles.sectionTitle}>مخزون الفروع المعتمد</Text>
                  <View style={styles.branchList}>
                    <View style={styles.branchCard}>
                      <View style={styles.branchCardInfo}>
                        <Text style={styles.branchCardName}>الفرع الرئيسي - المنصور</Text>
                        <Text style={styles.branchCardSub}>مخزن المعرض ومستودع الطابق الأرضي</Text>
                      </View>
                      <Text
                        style={[
                          styles.branchCardQty,
                          selectedItem.branchMansourQty <= 0 && styles.qtyOut,
                          selectedItem.branchMansourQty > 0 &&
                            selectedItem.branchMansourQty <= selectedItem.reorderLevel &&
                            styles.qtyLow,
                        ]}
                      >
                        {selectedItem.branchMansourQty} {selectedItem.unit}
                      </Text>
                    </View>

                    <View style={styles.branchCard}>
                      <View style={styles.branchCardInfo}>
                        <Text style={styles.branchCardName}>حد إعادة الطلب الحرج</Text>
                        <Text style={styles.branchCardSub}>يطلق تنبيهاً عند وصول الرصيد له</Text>
                      </View>
                      <Text style={styles.branchCardQty}>
                        {formatQuantity(selectedItem.reorderLevel)} {selectedItem.unit}
                      </Text>
                    </View>
                  </View>
                </View>

                <View style={styles.modalActionsRow}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => copyBarcode(selectedItem.barcode)}
                    style={styles.modalActionSecondary}
                  >
                    <Ionicons name="copy-outline" size={18} color={colors.brand} />
                    <Text style={styles.modalActionSecondaryText}>نسخ الباركود</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setSelectedItem(null)}
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

  itemsList: { gap: space.sm },
  itemCard: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: 1,
    padding: space.md,
    gap: space.xs,
  },
  itemCardPressed: {
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
  categoryBadge: {
    backgroundColor: colors.canvas,
    borderRadius: radius.compact,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  categoryText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
  },
  itemName: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    lineHeight: 22,
    textAlign: "right",
  },
  metaRow: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 2,
  },
  barcodeWrap: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 4,
  },
  barcodeText: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
  },
  itemPrice: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 15,
  },
  stockRow: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.canvas,
    borderRadius: radius.compact,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    marginTop: space.xxs,
  },
  branchStock: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 6,
  },
  branchLabel: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
  },
  branchQty: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 13,
  },
  branchSubQty: {
    color: colors.mutedInk,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
  },
  qtyOut: { color: colors.danger },
  qtyLow: { color: colors.warning },

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
  modalCategory: {
    color: colors.brand,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 12,
    textAlign: "right",
  },
  modalTitle: {
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
  modalDetails: {
    flexDirection: "row-reverse",
    gap: space.sm,
  },
  detailBox: {
    backgroundColor: colors.canvas,
    borderRadius: radius.compact,
    flex: 1,
    padding: space.sm,
    gap: 2,
  },
  detailLabel: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    textAlign: "right",
  },
  detailPrice: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 16,
    textAlign: "right",
  },
  detailBarcode: {
    color: colors.ink,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
    textAlign: "right",
  },
  branchSection: { gap: space.xs },
  sectionTitle: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    textAlign: "right",
  },
  branchList: { gap: space.xs },
  branchCard: {
    backgroundColor: colors.canvas,
    borderRadius: radius.compact,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
    padding: space.sm,
  },
  branchCardInfo: { flex: 1, gap: 2 },
  branchCardName: {
    color: colors.ink,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 13,
    textAlign: "right",
  },
  branchCardSub: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    textAlign: "right",
  },
  branchCardQty: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
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
