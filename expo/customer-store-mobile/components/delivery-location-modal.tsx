import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useState } from "react";
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { storefrontDesign } from "@/lib/storefront-design";

export const IRAQI_GOVERNORATES = [
  "بغداد",
  "البصرة",
  "أربيل",
  "النجف",
  "كربلاء",
  "نينوى",
  "كركوك",
  "السليمانية",
  "بابل",
  "الأنبار",
  "ديالى",
  "ذي قار",
  "واسط",
  "صلاح الدين",
  "المثنى",
  "ميسان",
  "دهوك",
  "القادسية",
] as const;

export type Governorate = (typeof IRAQI_GOVERNORATES)[number];

export type DeliveryLocation = {
  governorate: string;
  area: string;
  formatted: string;
};

export const BAGHDAD_AREAS = [
  "الكرادة",
  "المنصور",
  "زيونة",
  "الجادرية",
  "اليرموك",
  "الدورة",
  "الشعب",
  "حي الجامعة",
  "الكرخ",
  "الرصافة",
];

export const GOVERNORATE_AREAS: Record<string, string[]> = {
  "بغداد": BAGHDAD_AREAS,
  "البصرة": ["العشار", "الجزائر", "الجبيلة", "المعقل", "الطويسة", "البراضعية"],
  "أربيل": ["عنكاوا", "عينكاوة", "شورش", "بختياري", "الوزراء", "القلعة"],
  "النجف": ["النجف الأشرف", "الكوفة", "حي الغدير", "حي الأمير", "المشراق"],
  "كربلاء": ["كربلاء المقدسة", "حي الحسين", "حي العباس", "حي المعلمين", "الهندية"],
};

export function resolveDeliveryLocation(
  governorate?: string,
  area?: string,
): DeliveryLocation {
  const selectedGov =
    governorate && IRAQI_GOVERNORATES.includes(governorate as Governorate)
      ? governorate
      : "بغداد";
  const selectedArea = area && area.trim() ? area.trim() : "الكرادة";
  return {
    governorate: selectedGov,
    area: selectedArea,
    formatted: `التوصيل إلى: ${selectedGov} - ${selectedArea}`,
  };
}

type DeliveryLocationModalProps = {
  visible: boolean;
  onClose: () => void;
  currentLocation: DeliveryLocation;
  onSelectLocation: (loc: DeliveryLocation) => void;
};

export function DeliveryLocationModal({
  visible,
  onClose,
  currentLocation,
  onSelectLocation,
}: DeliveryLocationModalProps) {
  const [selectedGov, setSelectedGov] = useState<string>(
    currentLocation.governorate,
  );
  const [selectedArea, setSelectedArea] = useState<string>(
    currentLocation.area,
  );
  const [customArea, setCustomArea] = useState<string>("");
  const [filterGov, setFilterGov] = useState<string>("");

  const filteredGovs = IRAQI_GOVERNORATES.filter((gov) =>
    filterGov.trim() ? gov.includes(filterGov.trim()) : true,
  );

  const handleApply = () => {
    const finalArea =
      customArea.trim() ||
      selectedArea ||
      (selectedGov === "بغداد" ? "الكرادة" : "المركز");
    const loc = resolveDeliveryLocation(selectedGov, finalArea);
    onSelectLocation(loc);
    onClose();
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      transparent
      visible={visible}
    >
      <View style={styles.backdrop}>
        <TouchableOpacity
          activeOpacity={1}
          onPress={onClose}
          style={styles.dismissOverlay}
        />
        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <TouchableOpacity
              accessibilityLabel="إغلاق"
              onPress={onClose}
              style={styles.closeButton}
            >
              <MaterialIcons color="#64748B" name="close" size={20} />
            </TouchableOpacity>
            <View style={styles.headerCopy}>
              <View style={styles.headerTitleRow}>
                <MaterialIcons
                  color={storefrontDesign.semantic.brand}
                  name="location-on"
                  size={20}
                />
                <Text accessibilityLabel="اختر موقع التوصيل" style={styles.title}>
                  وين تحب نوصل مسواكك؟
                </Text>
              </View>
              <Text style={styles.subtitle}>
                حدد المحافظة والمنطقة لنوصل مسواكك لباب بيتك بأسرع وقت
              </Text>
            </View>
          </View>

          <View style={styles.searchBox}>
            <MaterialIcons color="#94A3B8" name="search" size={18} />
            <TextInput
              onChangeText={setFilterGov}
              placeholder="ابحث عن المحافظة…"
              placeholderTextColor="#94A3B8"
              style={styles.searchInput}
              textAlign="right"
              value={filterGov}
            />
          </View>

          <Text style={styles.sectionLabel}>المحافظات العراقية</Text>
          <ScrollView
            contentContainerStyle={styles.govScroll}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {filteredGovs.map((gov) => {
              const isSelected = selectedGov === gov;
              return (
                <TouchableOpacity
                  activeOpacity={0.8}
                  key={gov}
                  onPress={() => setSelectedGov(gov)}
                  style={[styles.govChip, isSelected && styles.govChipActive]}
                >
                  <Text
                    style={[
                      styles.govChipText,
                      isSelected && styles.govChipTextActive,
                    ]}
                  >
                    {gov}
                  </Text>
                  {isSelected && (
                    <MaterialIcons
                      color={storefrontDesign.primitive.white}
                      name="check"
                      size={14}
                    />
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {GOVERNORATE_AREAS[selectedGov] && (
            <>
              <Text style={styles.sectionLabel}>المناطق والأحياء الشائعة في {selectedGov}</Text>
              <View style={styles.areaWrap}>
                {GOVERNORATE_AREAS[selectedGov].map((area) => {
                  const isSelected = selectedArea === area && !customArea;
                  return (
                    <TouchableOpacity
                      activeOpacity={0.8}
                      key={area}
                      onPress={() => {
                        setSelectedArea(area);
                        setCustomArea("");
                      }}
                      style={[
                        styles.areaChip,
                        isSelected && styles.areaChipActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.areaChipText,
                          isSelected && styles.areaChipTextActive,
                        ]}
                      >
                        {area}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}

          <Text style={styles.sectionLabel}>أو اكتب اسم منطقتك / الحي</Text>
          <TextInput
            onChangeText={setCustomArea}
            placeholder="مثال: الكرخ - حي الجامعة، زقاق 12"
            placeholderTextColor="#94A3B8"
            style={styles.areaInput}
            textAlign="right"
            value={customArea}
          />

          <View style={styles.deliveryPromise}>
            <MaterialIcons
              color={storefrontDesign.semantic.brand}
              name="local-shipping"
              size={18}
            />
            <Text style={styles.deliveryPromiseText}>
              توصيل طيارة لباب بيتك بـ 18 محافظة عراقية وسدد نقد عند الباب
            </Text>
          </View>

          <TouchableOpacity
            activeOpacity={0.88}
            onPress={handleApply}
            style={styles.applyButton}
          >
            <Text style={styles.applyButtonText}>
              تأكيد موقع التوصيل (
              {selectedGov} - {customArea.trim() || selectedArea || "المركز"})
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(15, 23, 42, 0.55)",
    flex: 1,
    justifyContent: "flex-end",
  },
  dismissOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    maxHeight: "85%",
    paddingBottom: 28,
    paddingHorizontal: 18,
    paddingTop: 10,
    shadowColor: "#000000",
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 8,
  },
  handle: {
    alignSelf: "center",
    backgroundColor: "#E2E8F0",
    borderRadius: 3,
    height: 4,
    marginBottom: 12,
    width: 44,
  },
  header: {
    alignItems: "flex-start",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  headerCopy: {
    alignItems: "flex-end",
    flex: 1,
  },
  headerTitleRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 6,
  },
  title: {
    color: "#0F172A",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 16,
  },
  subtitle: {
    color: "#64748B",
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    marginTop: 2,
    textAlign: "right",
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: "#F1F5F9",
    borderRadius: 16,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  searchBox: {
    alignItems: "center",
    backgroundColor: "#F8FAFC",
    borderColor: "#E2E8F0",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row-reverse",
    height: 40,
    marginBottom: 12,
    paddingHorizontal: 12,
  },
  searchInput: {
    color: "#0F172A",
    flex: 1,
    fontFamily: "Cairo_500Medium",
    fontSize: 12,
    marginRight: 6,
  },
  sectionLabel: {
    color: "#334155",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
    marginBottom: 6,
    marginTop: 6,
    textAlign: "right",
  },
  govScroll: {
    flexDirection: "row-reverse",
    gap: 8,
    paddingBottom: 4,
  },
  govChip: {
    alignItems: "center",
    backgroundColor: "#F1F5F9",
    borderColor: "#E2E8F0",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  govChipActive: {
    backgroundColor: storefrontDesign.semantic.brand,
    borderColor: storefrontDesign.semantic.brand,
  },
  govChipText: {
    color: "#334155",
    fontFamily: "Cairo_700Bold",
    fontSize: 12,
  },
  govChipTextActive: {
    color: "#FFFFFF",
  },
  areaWrap: {
    flexDirection: "row-reverse",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 6,
  },
  areaChip: {
    backgroundColor: "#F8FAFC",
    borderColor: "#E2E8F0",
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  areaChipActive: {
    backgroundColor: "#ECFDF5",
    borderColor: "#10B981",
  },
  areaChipText: {
    color: "#475569",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 11,
  },
  areaChipTextActive: {
    color: "#065F46",
    fontFamily: "Cairo_700Bold",
  },
  areaInput: {
    backgroundColor: "#F8FAFC",
    borderColor: "#E2E8F0",
    borderRadius: 12,
    borderWidth: 1,
    color: "#0F172A",
    fontFamily: "Cairo_500Medium",
    fontSize: 12,
    height: 42,
    paddingHorizontal: 12,
  },
  deliveryPromise: {
    alignItems: "center",
    backgroundColor: "#ECFDF5",
    borderColor: "#A7F3D0",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  deliveryPromiseText: {
    color: "#065F46",
    flex: 1,
    fontFamily: "Cairo_600SemiBold",
    fontSize: 10.5,
    textAlign: "right",
  },
  applyButton: {
    alignItems: "center",
    backgroundColor: storefrontDesign.semantic.brand,
    borderRadius: 16,
    height: 46,
    justifyContent: "center",
    marginTop: 14,
    shadowColor: storefrontDesign.semantic.brand,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  applyButtonText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 13,
  },
});
