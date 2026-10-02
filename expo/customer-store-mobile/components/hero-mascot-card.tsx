import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from "react-native-svg";

type HeroMascotCardProps = {
  onShopPress?: () => void;
  onDealsPress?: () => void;
  greeting?: string;
  subtext?: string;
};

/**
 * 3D Cute Mascot Vector Illustration
 * A friendly, adorable book character with layered 3D volume, glossy eyes,
 * golden bookmark ribbon, scholar cap, and friendly smile.
 */
function CuteMascotSvg() {
  return (
    <Svg height="110" viewBox="0 0 110 110" width="110">
      <Defs>
        {/* Shadow under mascot */}
        <LinearGradient id="groundShadow" x1="0%" x2="100%" y1="0%" y2="0%">
          <Stop offset="0%" stopColor="#000000" stopOpacity="0" />
          <Stop offset="50%" stopColor="#000000" stopOpacity="0.25" />
          <Stop offset="100%" stopColor="#000000" stopOpacity="0" />
        </LinearGradient>

        {/* Book cover 3D Emerald gradient */}
        <LinearGradient id="coverGrad" x1="0%" x2="100%" y1="0%" y2="100%">
          <Stop offset="0%" stopColor="#34D399" />
          <Stop offset="40%" stopColor="#059669" />
          <Stop offset="100%" stopColor="#064E3B" />
        </LinearGradient>

        {/* Book spine 3D depth */}
        <LinearGradient id="spineGrad" x1="0%" x2="100%" y1="0%" y2="0%">
          <Stop offset="0%" stopColor="#064E3B" />
          <Stop offset="100%" stopColor="#047857" />
        </LinearGradient>

        {/* Pages 3D cream gradient */}
        <LinearGradient id="pageGrad" x1="0%" x2="0%" y1="0%" y2="100%">
          <Stop offset="0%" stopColor="#FFFBEB" />
          <Stop offset="50%" stopColor="#FEF3C7" />
          <Stop offset="100%" stopColor="#FDE68A" />
        </LinearGradient>

        {/* Gold bookmark ribbon */}
        <LinearGradient id="goldGrad" x1="0%" x2="100%" y1="0%" y2="100%">
          <Stop offset="0%" stopColor="#FDE68A" />
          <Stop offset="50%" stopColor="#F59E0B" />
          <Stop offset="100%" stopColor="#D97706" />
        </LinearGradient>

        {/* Cap gradient */}
        <LinearGradient id="capGrad" x1="0%" x2="100%" y1="0%" y2="100%">
          <Stop offset="0%" stopColor="#1E293B" />
          <Stop offset="100%" stopColor="#0F172A" />
        </LinearGradient>
      </Defs>

      {/* Ground drop shadow */}
      <Ellipse cx="55" cy="100" fill="url(#groundShadow)" rx="40" ry="6" />

      {/* Book Back Cover Depth */}
      <Rect
        fill="#064E3B"
        height="64"
        rx="12"
        width="60"
        x="24"
        y="30"
      />

      {/* Book Pages Layer (embossed cream edges) */}
      <Rect
        fill="url(#pageGrad)"
        height="60"
        rx="10"
        width="56"
        x="26"
        y="28"
      />
      {/* Page lines texture */}
      <Path
        d="M32 34 H76 M32 38 H76 M32 42 H76"
        opacity="0.3"
        stroke="#D97706"
        strokeWidth="0.8"
      />

      {/* Book Front Cover (emerald 3D pillowed clay) */}
      <Rect
        fill="url(#coverGrad)"
        height="62"
        rx="12"
        width="56"
        x="23"
        y="26"
      />
      {/* Cover Highlight sheen */}
      <Path
        d="M28 29 C40 27, 65 27, 74 29"
        opacity="0.4"
        stroke="#FFFFFF"
        strokeLinecap="round"
        strokeWidth="2"
      />

      {/* Spine rim */}
      <Rect
        fill="url(#spineGrad)"
        height="62"
        rx="5"
        width="10"
        x="21"
        y="26"
      />

      {/* Golden Bookmark Ribbon extending out */}
      <Path
        d="M48 24 L56 24 L56 46 L52 42 L48 46 Z"
        fill="url(#goldGrad)"
      />

      {/* Graduation / Scholar Cap */}
      <G>
        {/* Cap skull base */}
        <Ellipse cx="51" cy="23" fill="#0F172A" rx="14" ry="4" />
        {/* Diamond mortarboard */}
        <Path
          d="M51 12 L73 19 L51 26 L29 19 Z"
          fill="url(#capGrad)"
          stroke="#334155"
          strokeWidth="1"
        />
        {/* Gold button on mortarboard */}
        <Circle cx="51" cy="19" fill="url(#goldGrad)" r="2.5" />
        {/* Golden Tassel hanging */}
        <Path
          d="M51 19 Q66 22, 68 31"
          fill="none"
          stroke="#F59E0B"
          strokeWidth="1.5"
        />
        <Circle cx="68" cy="32" fill="#D97706" r="2" />
      </G>

      {/* Cute Face Features */}
      <G>
        {/* Left Eye */}
        <Circle cx="41" cy="50" fill="#0F172A" r="4.8" />
        <Circle cx="39.5" cy="48.5" fill="#FFFFFF" r="1.8" />
        <Circle cx="42.5" cy="52" fill="#FFFFFF" r="0.9" />

        {/* Right Eye */}
        <Circle cx="61" cy="50" fill="#0F172A" r="4.8" />
        <Circle cx="59.5" cy="48.5" fill="#FFFFFF" r="1.8" />
        <Circle cx="62.5" cy="52" fill="#FFFFFF" r="0.9" />

        {/* Rosy Cheeks (Blush) */}
        <Ellipse cx="34" cy="56" fill="#F43F5E" opacity="0.35" rx="3.5" ry="2" />
        <Ellipse cx="68" cy="56" fill="#F43F5E" opacity="0.35" rx="3.5" ry="2" />

        {/* Cute Smile */}
        <Path
          d="M47 56 Q51 61, 55 56"
          fill="none"
          stroke="#0F172A"
          strokeLinecap="round"
          strokeWidth="2"
        />
      </G>

      {/* Sparkles / Magic Stars */}
      <G>
        {/* Top Right Star */}
        <Path
          d="M86 16 L88 22 L94 24 L88 26 L86 32 L84 26 L78 24 L84 22 Z"
          fill="url(#goldGrad)"
          opacity="0.9"
        />
        {/* Bottom Left Star */}
        <Path
          d="M14 62 L15.5 66 L19.5 67 L15.5 68 L14 72 L12.5 68 L8.5 67 L12.5 66 Z"
          fill="url(#goldGrad)"
          opacity="0.8"
        />
        {/* Little Sparkle Dot */}
        <Circle cx="88" cy="45" fill="#FDE68A" opacity="0.75" r="2" />
      </G>
    </Svg>
  );
}

export function HeroMascotCard({
  onShopPress,
  onDealsPress,
  greeting = "أهلاً بك في الرؤية العربية!",
  subtext = "وجهتك الأولى للقرطاسية الفاخرة — شلونك عيني! مسواكك يوصلك وين ما جنت بأسرع وقت، وعروض تفليش بأسعار الجملة.",
}: HeroMascotCardProps) {
  return (
    <View style={styles.container}>
      {/* Background glow layers */}
      <View style={styles.gradientCard}>
        <View style={styles.goldRim} />

        <View style={styles.cardContent}>
          {/* Text and Actions (RTL) */}
          <View style={styles.copyArea}>
            <View style={styles.badgeRow}>
              <View style={styles.tagBadge}>
                <MaterialIcons color="#F59E0B" name="verified" size={13} />
                <Text style={styles.tagText}>الرؤية العربية — مسواك أصيل</Text>
              </View>
            </View>

            <Text style={styles.headline}>{greeting}</Text>
            <Text numberOfLines={2} style={styles.subtext}>
              {subtext}
            </Text>

            <View style={styles.actionsRow}>
              <TouchableOpacity
                accessibilityLabel="تصفح العروض"
                activeOpacity={0.85}
                onPress={onDealsPress}
                style={styles.primaryBtn}
              >
                <MaterialIcons color="#064E3B" name="bolt" size={16} />
                <Text style={styles.primaryBtnText}>عروض تفليش اليوم</Text>
              </TouchableOpacity>

              <TouchableOpacity
                accessibilityLabel="استكشف الأقسام"
                activeOpacity={0.85}
                onPress={onShopPress}
                style={styles.secondaryBtn}
              >
                <Text style={styles.secondaryBtnText}>تصفح المسواك</Text>
                <MaterialIcons color="#FFFFFF" name="arrow-back" size={14} />
              </TouchableOpacity>
            </View>
          </View>

          {/* 3D Mascot Character */}
          <View style={styles.mascotArea}>
            <View style={styles.mascotHalo} />
            <CuteMascotSvg />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 14,
    width: "100%",
  },
  gradientCard: {
    backgroundColor: "#064E3B",
    borderColor: "rgba(245, 158, 11, 0.35)",
    borderRadius: 24,
    borderWidth: 1.5,
    overflow: "hidden",
    position: "relative",
    shadowColor: "#059669",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.22,
    shadowRadius: 18,
    elevation: 8,
  },
  goldRim: {
    backgroundColor: "rgba(245, 158, 11, 0.15)",
    height: 3,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  cardContent: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingBottom: 16,
    paddingHorizontal: 16,
    paddingTop: 18,
  },
  copyArea: {
    alignItems: "flex-end",
    flex: 1,
    paddingLeft: 6,
  },
  badgeRow: {
    flexDirection: "row-reverse",
    marginBottom: 6,
  },
  tagBadge: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    borderColor: "rgba(245, 158, 11, 0.4)",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2.5,
  },
  tagText: {
    color: "#FDE68A",
    fontFamily: "Cairo_700Bold",
    fontSize: 9.5,
  },
  headline: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 16.5,
    lineHeight: 25,
    textAlign: "right",
  },
  subtext: {
    color: "#D1FAE5",
    fontFamily: "Cairo_500Medium",
    fontSize: 10.5,
    lineHeight: 16,
    marginTop: 4,
    textAlign: "right",
  },
  actionsRow: {
    flexDirection: "row-reverse",
    gap: 8,
    marginTop: 12,
  },
  primaryBtn: {
    alignItems: "center",
    backgroundColor: "#FDE68A",
    borderRadius: 12,
    flexDirection: "row-reverse",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 2,
  },
  primaryBtnText: {
    color: "#064E3B",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 11,
  },
  secondaryBtn: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    borderColor: "rgba(255, 255, 255, 0.3)",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  secondaryBtnText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_700Bold",
    fontSize: 10.5,
  },
  mascotArea: {
    alignItems: "center",
    height: 110,
    justifyContent: "center",
    position: "relative",
    width: 100,
  },
  mascotHalo: {
    backgroundColor: "rgba(52, 211, 153, 0.25)",
    borderRadius: 45,
    height: 90,
    position: "absolute",
    width: 90,
  },
});
