import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { StyleSheet, Text, View } from "react-native";

export const TRUST_PILLARS = [
  {
    id: "shipping",
    icon: "local-shipping" as const,
    title: "واصل لكل المحافظات",
    subtitle: "شحن وتوصيل سريع لباب بيتك بـ 18 محافظة عراقية",
    // title: "توصيل لكافة المحافظات"
    // subtitle: "شحن سريع لكافة محافظات العراق الـ 18"
  },
  {
    id: "cod",
    icon: "payments" as const,
    title: "سدد نقد عند الباب",
    subtitle: "عاين وافحص مسواكك براحتك قبل لا تدفع فلس واحد",
    // title: "دفع عند الاستلام"
    // subtitle: "عاين طلبيتك وسدد نقداً بأمان تام"
  },
  {
    id: "warranty",
    icon: "verified-user" as const,
    title: "ضمان 48 ساعة",
    subtitle: "حقك محفوظ، فحص ومطابقة واستبدال مضمون 100%",
    // title: "ضمان استبدال 48 ساعة"
    // subtitle: "فحص ومطابقة وجودة مضمونة 100%"
  },
  {
    id: "pricing",
    icon: "sell" as const,
    title: "سعر الجملة من المستودع",
    subtitle: "عروض توفير حقيقية من المستودع ليدك بدون وسيط",
    // title: "أسعار جملة وتجزئة"
    // subtitle: "عروض توفير مباشرة من المستودع للعميل"
  },
] as const;

export function TrustCardsRow() {
  return (
    <View style={styles.container}>
      <View style={styles.grid}>
        {TRUST_PILLARS.map((pillar) => (
          <View
            accessible={true}
            accessibilityLabel={`${pillar.title}: ${pillar.subtitle}`}
            key={pillar.id}
            style={styles.card}
          >
            <View style={styles.iconCircle}>
              <MaterialIcons color="#059669" name={pillar.icon} size={18} />
            </View>
            <View style={styles.textCol}>
              <Text numberOfLines={1} style={styles.title}>
                {pillar.title}
              </Text>
              <Text numberOfLines={1} style={styles.subtitle}>
                {pillar.subtitle}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    marginVertical: 12,
  },
  grid: {
    flexDirection: "row-reverse",
    flexWrap: "wrap",
    gap: 10,
  },
  card: {
    flexBasis: "48%",
    flexGrow: 1,
    backgroundColor: "#0B1321",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 3,
  },
  iconCircle: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  textCol: {
    flex: 1,
    alignItems: "flex-end",
  },
  title: {
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
    color: "#FFFFFF",
    textAlign: "right",
  },
  subtitle: {
    fontFamily: "Cairo_400Regular",
    fontSize: 9,
    color: "#94A3B8",
    textAlign: "right",
    marginTop: 2,
  },
});
