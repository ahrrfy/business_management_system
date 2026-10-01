import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  RadialGradient,
  Stop,
} from "react-native-svg";

import { formatLatinNumber } from "@/lib/storefront-api";

export type LoyaltyProgress = {
  currentPoints: number;
  threshold: number;
  progressRatio: number;
  percentageText: string;
  pointsRemaining: number;
  isGoalReached: boolean;
};

export function calculateLoyaltyProgress(
  points: number,
  threshold: number = 500,
): LoyaltyProgress {
  const sanitizedPoints = Math.max(0, Number.isFinite(points) ? points : 0);
  const safeThreshold = Math.max(1, threshold);
  const ratio = Math.min(1, sanitizedPoints / safeThreshold);
  return {
    currentPoints: sanitizedPoints,
    threshold: safeThreshold,
    progressRatio: ratio,
    percentageText: `${Math.round(ratio * 100)}%`,
    pointsRemaining: Math.max(0, safeThreshold - sanitizedPoints),
    isGoalReached: sanitizedPoints >= safeThreshold,
  };
}

/**
 * 3D Golden Coin SVG Illustration
 * Features multi-stop metallic gradients, rim bevels, and center star emblem.
 */
function GoldCoin3DSvg() {
  return (
    <Svg height="56" viewBox="0 0 56 56" width="56">
      <Defs>
        <RadialGradient cx="35%" cy="30%" id="coinBase" r="65%">
          <Stop offset="0%" stopColor="#FEF3C7" />
          <Stop offset="45%" stopColor="#F59E0B" />
          <Stop offset="85%" stopColor="#D97706" />
          <Stop offset="100%" stopColor="#92400E" />
        </RadialGradient>
        <LinearGradient id="coinRim" x1="0%" x2="100%" y1="0%" y2="100%">
          <Stop offset="0%" stopColor="#FFFBEB" />
          <Stop offset="50%" stopColor="#F59E0B" />
          <Stop offset="100%" stopColor="#78350F" />
        </LinearGradient>
        <LinearGradient id="starGrad" x1="0%" x2="0%" y1="0%" y2="100%">
          <Stop offset="0%" stopColor="#FFFFFF" />
          <Stop offset="60%" stopColor="#FEF3C7" />
          <Stop offset="100%" stopColor="#FDE68A" />
        </LinearGradient>
      </Defs>

      {/* Shadow */}
      <Circle cx="28" cy="30" fill="rgba(146, 64, 14, 0.25)" r="25" />

      {/* Outer Coin Edge Rim */}
      <Circle
        cx="28"
        cy="28"
        fill="url(#coinRim)"
        r="24"
      />

      {/* Inner Recessed Face */}
      <Circle
        cx="28"
        cy="28"
        fill="url(#coinBase)"
        r="20"
        stroke="#FEF3C7"
        strokeOpacity="0.6"
        strokeWidth="1"
      />

      {/* Center 3D Star Emblem */}
      <Path
        d="M28 17 L30.5 24 L37.5 24.5 L32 29 L34 36 L28 32 L22 36 L24 29 L18.5 24.5 L25.5 24 Z"
        fill="url(#starGrad)"
        stroke="#D97706"
        strokeWidth="0.75"
      />

      {/* Specular Sheen Arc */}
      <Path
        d="M16 22 A 16 16 0 0 1 36 14"
        fill="none"
        opacity="0.65"
        stroke="#FFFFFF"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </Svg>
  );
}

type LoyaltyProgressCardProps = {
  currentPoints?: number;
  threshold?: number;
  onPress?: () => void;
};

export function LoyaltyProgressCard({
  currentPoints = 250,
  threshold = 500,
  onPress,
}: LoyaltyProgressCardProps) {
  const progress = calculateLoyaltyProgress(currentPoints, threshold);

  const handlePress = () => {
    if (onPress) {
      onPress();
    } else {
      router.push("/perks" as never);
    }
  };

  return (
    <TouchableOpacity
      accessibilityHint="ينقلك إلى شاشة مكافآت ونقاط الولاء"
      accessibilityLabel={`نقاط الولاء: ${formatLatinNumber(progress.currentPoints)} من ${formatLatinNumber(progress.threshold)} نقطة`}
      accessibilityRole="button"
      activeOpacity={0.88}
      onPress={handlePress}
      style={styles.card}
    >
      {/* Top golden ambient accent */}
      <View style={styles.goldRim} />

      <View style={styles.topRow}>
        <View style={styles.copy}>
          <View style={styles.badgeRow}>
            <View style={styles.badge}>
              <MaterialIcons color="#D97706" name="stars" size={13} />
              <Text style={styles.badgeText}>برنامج مكافآت الرؤية</Text>
            </View>
            <View style={styles.percentagePill}>
              <Text style={styles.percentageText}>
                {progress.percentageText}
              </Text>
            </View>
          </View>

          {/* Canonical Points String: "250 / 500 نقطة للخصم القادم" */}
          <Text style={styles.pointsHeadline}>
            {formatLatinNumber(progress.currentPoints)} /{" "}
            {formatLatinNumber(progress.threshold)} نقطة للخصم القادم
          </Text>

          <Text style={styles.subtext}>
            {progress.isGoalReached
              ? "مبارك! وصلت لهدف الخصم، فعّل قسيمتك الآن"
              : `اجمع ${formatLatinNumber(progress.pointsRemaining)} نقطة إضافية لفتح قسيمة خصم فوري`}
          </Text>
        </View>

        {/* 3D Coin Visual */}
        <View style={styles.coinWrap}>
          <GoldCoin3DSvg />
        </View>
      </View>

      {/* Dynamic Animated Progress Bar */}
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            { width: `${Math.round(progress.progressRatio * 100)}%` },
          ]}
        />
      </View>

      {/* Footer Navigation CTA */}
      <View style={styles.footer}>
        <View style={styles.footerPerk}>
          <MaterialIcons color="#059669" name="card-giftcard" size={15} />
          <Text style={styles.footerPerkText}>مكافآت وتوصيل مجاني للمتميزين</Text>
        </View>
        <View style={styles.ctaLink}>
          <Text style={styles.ctaLinkText}>استكشف مزاياك</Text>
          <MaterialIcons color="#D97706" name="arrow-back" size={14} />
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#FFFFFF",
    borderColor: "#FDE68A",
    borderRadius: 22,
    borderWidth: 1.5,
    marginVertical: 12,
    overflow: "hidden",
    padding: 16,
    position: "relative",
    shadowColor: "#F59E0B",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 3,
  },
  goldRim: {
    backgroundColor: "#F59E0B",
    height: 3,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  topRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  copy: {
    alignItems: "flex-end",
    flex: 1,
    paddingLeft: 12,
  },
  badgeRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 8,
    marginBottom: 4,
  },
  badge: {
    alignItems: "center",
    backgroundColor: "#FEF3C7",
    borderColor: "#FDE68A",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    color: "#92400E",
    fontFamily: "Cairo_700Bold",
    fontSize: 9.5,
  },
  percentagePill: {
    backgroundColor: "#059669",
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1.5,
  },
  percentageText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 9,
  },
  pointsHeadline: {
    color: "#0F172A",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 14.5,
    lineHeight: 22,
    textAlign: "right",
  },
  subtext: {
    color: "#64748B",
    fontFamily: "Cairo_500Medium",
    fontSize: 10.5,
    marginTop: 2,
    textAlign: "right",
  },
  coinWrap: {
    alignItems: "center",
    height: 56,
    justifyContent: "center",
    width: 56,
  },
  progressTrack: {
    backgroundColor: "#F1F5F9",
    borderRadius: 8,
    height: 8,
    marginVertical: 12,
    overflow: "hidden",
    width: "100%",
  },
  progressFill: {
    backgroundColor: "#F59E0B",
    borderRadius: 8,
    height: "100%",
  },
  footer: {
    alignItems: "center",
    borderTopColor: "#F8FAFC",
    borderTopWidth: 1,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingTop: 8,
  },
  footerPerk: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 4,
  },
  footerPerkText: {
    color: "#065F46",
    fontFamily: "Cairo_600SemiBold",
    fontSize: 10,
  },
  ctaLink: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 2,
  },
  ctaLinkText: {
    color: "#D97706",
    fontFamily: "Cairo_700Bold",
    fontSize: 10.5,
  },
});
