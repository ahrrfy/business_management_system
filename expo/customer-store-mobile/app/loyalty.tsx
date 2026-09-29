import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import {
  clearVerifiedCustomerSession,
  loadVerifiedCustomerSession,
  type VerifiedCustomerSession,
} from "@/lib/customer-session";
import {
  formatLatinNumber,
  getStorefrontCustomerBenefits,
  requestStorefrontFirstOrderCoupon,
  type StorefrontCustomerBenefits,
} from "@/lib/storefront-api";
import { storefrontDesign } from "@/lib/storefront-design";

export type LoyaltyTier = "BRONZE" | "SILVER" | "GOLD" | "VIP";

export type TierInfo = {
  tier: LoyaltyTier;
  nameAr: string;
  minPoints: number;
  pointsMultiplier: number;
  icon: keyof typeof MaterialIcons.glyphMap;
  color: string;
  bgLight: string;
  perks: string[];
};

export const LOYALTY_TIERS: Record<LoyaltyTier, TierInfo> = {
  BRONZE: {
    tier: "BRONZE",
    nameAr: "برونزي",
    minPoints: 0,
    pointsMultiplier: 1.0,
    icon: "workspace-premium",
    color: "#B45309",
    bgLight: "#FEF3C7",
    perks: ["تجميع نقاط عادي (1x)", "عروض ترويجية موسمية"],
  },
  SILVER: {
    tier: "SILVER",
    nameAr: "فضي",
    minPoints: 500,
    pointsMultiplier: 1.25,
    icon: "military-tech",
    color: "#64748B",
    bgLight: "#F1F5F9",
    perks: ["توصيل مجاني للطلبات فوق 25,000 د.ع", "تجميع نقاط 1.25x", "أولوية معالجة الطلبات"],
  },
  GOLD: {
    tier: "GOLD",
    nameAr: "ذهبي",
    minPoints: 1000,
    pointsMultiplier: 1.5,
    icon: "stars",
    color: "#D97706",
    bgLight: "#FFFBEB",
    perks: ["توصيل مجاني للطلبات فوق 15,000 د.ع", "تجميع نقاط 1.5x", "خصم 5% في يوم الميلاد", "دعم فني مخصص"],
  },
  VIP: {
    tier: "VIP",
    nameAr: "نخبة VIP",
    minPoints: 2500,
    pointsMultiplier: 2.0,
    icon: "diamond",
    color: "#075B4E",
    bgLight: "#ECFDF5",
    perks: ["توصيل مجاني لكافة الطلبات", "تجميع نقاط مضاعف 2x", "هدايا حصرية مع كل طلب", "مدير حساب شخصي"],
  },
};

export function resolveLoyaltyTier(points: number): TierInfo {
  const p = Math.max(0, Number(points) || 0);
  if (p >= LOYALTY_TIERS.VIP.minPoints) return LOYALTY_TIERS.VIP;
  if (p >= LOYALTY_TIERS.GOLD.minPoints) return LOYALTY_TIERS.GOLD;
  if (p >= LOYALTY_TIERS.SILVER.minPoints) return LOYALTY_TIERS.SILVER;
  return LOYALTY_TIERS.BRONZE;
}

export type LoyaltyProgress = {
  currentPoints: number;
  threshold: number;
  progressRatio: number;
  percentageText: string;
  pointsRemaining: number;
  isGoalReached: boolean;
};

export function calculateLoyaltyProgress(points: number, threshold: number = 500): LoyaltyProgress {
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

const ACTIVE_COUPON_STORAGE_KEY = "alarabiya-active-coupon";

export default function LoyaltyScreen({ isTab = false }: { isTab?: boolean } = {}) {
  const [session, setSession] = useState<VerifiedCustomerSession | null | undefined>(undefined);
  const [benefits, setBenefits] = useState<StorefrontCustomerBenefits | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestingFirstOrderCoupon, setRequestingFirstOrderCoupon] = useState(false);
  const [activeCouponCode, setActiveCouponCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const current = await loadVerifiedCustomerSession();
    setSession(current);
    if (!current) {
      setBenefits(null);
      setLoading(false);
      return;
    }
    try {
      setBenefits(await getStorefrontCustomerBenefits(current.token));
    } catch (error) {
      await clearVerifiedCustomerSession();
      setSession(null);
      setBenefits(null);
      Alert.alert(
        "انتهت جلسة المزايا",
        error instanceof Error ? error.message : "أعد تحقق الهاتف لمتابعة رصيدك."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    AsyncStorage.getItem(ACTIVE_COUPON_STORAGE_KEY)
      .then((saved) => {
        if (saved) setActiveCouponCode(saved);
      })
      .catch(() => undefined);
  }, [load]);

  const requestFirstOrderCoupon = async () => {
    if (!session || requestingFirstOrderCoupon) return;
    setRequestingFirstOrderCoupon(true);
    try {
      const result = await requestStorefrontFirstOrderCoupon(session.token);
      Alert.alert(
        result.outcome === "ISSUED" ? "تم إصدار كوبونك" : "كوبونك جاهز",
        `رمز ${result.programName}: ${result.code}${result.validTo ? `\nصالح حتى ${new Date(result.validTo).toLocaleDateString("en-US")}` : ""}`
      );
      await load();
    } catch (error) {
      Alert.alert(
        "تعذر طلب الكوبون",
        error instanceof Error ? error.message : "أعد المحاولة لاحقاً."
      );
    } finally {
      setRequestingFirstOrderCoupon(false);
    }
  };

  const handleActivateCoupon = async (code: string) => {
    try {
      Clipboard.setString(code);
    } catch {
      // gracefully ignore clipboard platform differences
    }
    setActiveCouponCode(code);
    await AsyncStorage.setItem(ACTIVE_COUPON_STORAGE_KEY, code).catch(() => undefined);

    if (Platform.OS === "ios" || Platform.OS === "android") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const loyalty = benefits?.loyalty;
  const pointsNumber = useMemo(() => {
    const raw = Number(loyalty?.pointsBalance ?? 0);
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  }, [loyalty?.pointsBalance]);

  const currentTier = useMemo(() => resolveLoyaltyTier(pointsNumber), [pointsNumber]);

  const { nextTierThreshold, nextTierName } = useMemo(() => {
    if (pointsNumber < 500) {
      return { nextTierThreshold: 500, nextTierName: LOYALTY_TIERS.SILVER.nameAr };
    }
    if (pointsNumber < 1000) {
      return { nextTierThreshold: 1000, nextTierName: LOYALTY_TIERS.GOLD.nameAr };
    }
    if (pointsNumber < 2500) {
      return { nextTierThreshold: 2500, nextTierName: LOYALTY_TIERS.VIP.nameAr };
    }
    return { nextTierThreshold: 2500, nextTierName: LOYALTY_TIERS.VIP.nameAr };
  }, [pointsNumber]);

  const progress = useMemo(
    () => calculateLoyaltyProgress(pointsNumber, nextTierThreshold),
    [pointsNumber, nextTierThreshold]
  );

  if (loading) {
    return (
      <ScreenContainer className="items-center justify-center">
        <ActivityIndicator color="#075B4E" size="large" />
      </ScreenContainer>
    );
  }

  if (!session) {
    return (
      <ScreenContainer className="flex-1" containerClassName="bg-background">
        <View style={styles.empty}>
          {!isTab && (
            <TouchableOpacity
              accessibilityLabel="الرجوع للمتجر"
              accessibilityRole="button"
              onPress={() => router.back()}
              style={styles.emptyBack}
            >
              <MaterialIcons name="arrow-forward" size={20} color="#075B4E" />
              <Text style={styles.backButtonText}>الرجوع للمتجر</Text>
            </TouchableOpacity>
          )}
          <View style={styles.emptyIcon}>
            <MaterialIcons name="verified-user" size={35} color="#075B4E" />
          </View>
          <Text style={styles.emptyTitle}>فعّل رصيد الولاء والقسائم</Text>
          <Text style={styles.emptyText}>
            تحقق برقم هاتفك كي تظهر نقاطك والقسائم المخصصة لك ومزايا حسابك ومكافآت الولاء بشكل آمن.
          </Text>
          <TouchableOpacity
            style={styles.primary}
            onPress={() => router.push("/verify-phone" as never)}
          >
            <Text style={styles.primaryText}>تحقق من رقم الهاتف</Text>
          </TouchableOpacity>
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer className="flex-1" containerClassName="bg-background">
      <ScrollView
        contentContainerStyle={[
          styles.content,
          isTab ? styles.tabContent : styles.stackContent,
        ]}
        showsVerticalScrollIndicator={false}
      >
        {!isTab && (
          <TouchableOpacity
            accessibilityLabel="الرجوع للمتجر"
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <MaterialIcons name="arrow-forward" size={20} color="#075B4E" />
            <Text style={styles.backButtonText}>الرجوع للمتجر</Text>
          </TouchableOpacity>
        )}

        <View style={styles.header}>
          <Text style={styles.title}>مزايا حسابك ومكافآت الولاء</Text>
          <Text style={styles.sub}>
            الولاء والقسائم - مرحباً {benefits?.customer.name ?? session.customer.name}
          </Text>
        </View>

        {/* 3D Gold Coin & Interactive Points Card */}
        <View style={styles.balanceCard}>
          <View style={styles.balanceTop}>
            <View style={styles.balanceInfo}>
              <View style={styles.tierPill}>
                <MaterialIcons name={currentTier.icon} size={15} color="#FEF3C7" />
                <Text style={styles.tierPillText}>المستوى: {currentTier.nameAr}</Text>
              </View>
              <Text style={styles.balanceLabel}>رصيدك المتاح</Text>
              <View style={styles.balanceAmountRow}>
                <Text style={styles.balance}>{formatLatinNumber(pointsNumber)}</Text>
                <Text style={styles.points}>نقطة ولاء</Text>
              </View>
            </View>

            {/* 3D Coin Visual with rich gold depth, sheen, and sparkles */}
            <View style={styles.coinOuterGlow}>
              <View style={styles.sparkleTop}>
                <MaterialIcons name="auto-awesome" size={14} color="#FDE68A" />
              </View>
              <View style={styles.sparkleBottom}>
                <MaterialIcons name="auto-awesome" size={11} color="#FBBF24" />
              </View>
              <View style={styles.coinOuterRing}>
                <View style={styles.coinMiddleRim}>
                  <View style={styles.coinInnerEmboss}>
                    <MaterialIcons name="stars" size={26} color="#FFFFFF" />
                  </View>
                </View>
              </View>
            </View>
          </View>

          {/* Dynamic Points Progress Towards Next Tier */}
          <View style={styles.progressContainer}>
            <View style={styles.progressHeader}>
              <Text style={styles.progressLabel}>
                {progress.isGoalReached
                  ? "أعلى مستوى عضوية تم تحقيقه (VIP)"
                  : `التقدم نحو المستوى التالي (${nextTierName})`}
              </Text>
              <Text style={styles.progressFraction}>
                {formatLatinNumber(progress.currentPoints)} / {formatLatinNumber(progress.threshold)}
              </Text>
            </View>
            <View style={styles.progressBarTrack}>
              <View
                style={[
                  styles.progressBarFill,
                  { width: `${Math.max(4, Math.round(progress.progressRatio * 100))}%` },
                ]}
              />
            </View>
            <View style={styles.progressFooter}>
              <Text style={styles.progressPercent}>{progress.percentageText}</Text>
              <Text style={styles.progressHint}>
                {progress.isGoalReached
                  ? "تهانينا! أنت تتمتع بأقصى مزايا الولاء الحصرية."
                  : `متبقي ${formatLatinNumber(progress.pointsRemaining)} نقطة للوصول إلى مستوى ${nextTierName}`}
              </Text>
            </View>
          </View>

          {loyalty ? (
            <Text style={styles.rules}>
              كل نقطة تعادل {formatLatinNumber(loyalty.iqdDiscountPerPoint)} د.ع. يبدأ الاستبدال من {formatLatinNumber(loyalty.minRedeemPoints)} نقطة وبحد أقصى {formatLatinNumber(loyalty.maxRedeemPercent)}% من قيمة المنتجات.
            </Text>
          ) : (
            <Text style={styles.rules}>
              سيظهر رصيدك هنا بمجرد تفعيل برنامج الولاء من الداشبورد واستحقاق نقاط مكتملة.
            </Text>
          )}
        </View>

        {/* Verification Status Banner */}
        <View style={styles.verify}>
          <MaterialIcons name="verified" size={20} color="#16835D" />
          <Text style={styles.verifyText}>
            رقم الهاتف متحقق ومربوط بسجل العميل. تُحتسب النقاط بعد تسليم الطلب.
          </Text>
        </View>

        {/* Membership Tier Perks Cards */}
        <View style={tierPerksStyles.container}>
          <Text style={styles.section}>مزايا مستواك الحالي</Text>
          <View style={tierPerksStyles.grid}>
            {/* Card 1: توصيل مجاني */}
            <View style={tierPerksStyles.card}>
              <View style={tierPerksStyles.cardIconWrap}>
                <MaterialIcons name="local-shipping" size={22} color="#075B4E" />
              </View>
              <View style={tierPerksStyles.cardContent}>
                <View style={tierPerksStyles.cardHeaderRow}>
                  <Text style={tierPerksStyles.cardTitle}>توصيل مجاني</Text>
                  <View style={tierPerksStyles.badge}>
                    <Text style={tierPerksStyles.badgeText}>توفير تلقائي</Text>
                  </View>
                </View>
                <Text style={tierPerksStyles.cardDesc}>
                  توصيل مجاني للطلبات فوق الحد الأدنى المؤهل بحسب مستوى عضويتك النشطة.
                </Text>
              </View>
            </View>

            {/* Card 2: كوبونات خصم حصرية */}
            <View style={tierPerksStyles.card}>
              <View style={[tierPerksStyles.cardIconWrap, { backgroundColor: "#FEF3C7" }]}>
                <MaterialIcons name="confirmation-number" size={22} color="#B45309" />
              </View>
              <View style={tierPerksStyles.cardContent}>
                <View style={tierPerksStyles.cardHeaderRow}>
                  <Text style={tierPerksStyles.cardTitle}>كوبونات خصم حصرية</Text>
                  <View style={[tierPerksStyles.badge, { backgroundColor: "#FEF3C7" }]}>
                    <Text style={[tierPerksStyles.badgeText, { color: "#92400E" }]}>شهرياً</Text>
                  </View>
                </View>
                <Text style={tierPerksStyles.cardDesc}>
                  كوبونات وقسائم شراء دورية تُضاف إلى حسابك تلقائياً لخصم إضافي عند الدفع.
                </Text>
              </View>
            </View>

            {/* Card 3: نقاط مضاعفة 2x */}
            <View style={tierPerksStyles.card}>
              <View style={[tierPerksStyles.cardIconWrap, { backgroundColor: "#E0F2FE" }]}>
                <MaterialIcons name="bolt" size={22} color="#0284C7" />
              </View>
              <View style={tierPerksStyles.cardContent}>
                <View style={tierPerksStyles.cardHeaderRow}>
                  <Text style={tierPerksStyles.cardTitle}>نقاط مضاعفة 2x</Text>
                  <View style={[tierPerksStyles.badge, { backgroundColor: "#E0F2FE" }]}>
                    <Text style={[tierPerksStyles.badgeText, { color: "#0369A1" }]}>مكافأة 2x</Text>
                  </View>
                </View>
                <Text style={tierPerksStyles.cardDesc}>
                  مضاعفة نقاط الولاء حتى 2x على الأقسام والمنتجات الخاصة والمناسبات الترويجية.
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* All Membership Tiers Breakdown */}
        <View style={tierListStyles.container}>
          <Text style={styles.section}>مستويات العضوية في البرنامج</Text>
          <View style={tierListStyles.list}>
            {(Object.keys(LOYALTY_TIERS) as LoyaltyTier[]).map((tKey) => {
              const t = LOYALTY_TIERS[tKey];
              const isCurrent = currentTier.tier === t.tier;
              return (
                <View
                  key={t.tier}
                  style={[
                    tierListStyles.tierRow,
                    isCurrent && tierListStyles.tierRowActive,
                  ]}
                >
                  <View style={[tierListStyles.tierIcon, { backgroundColor: t.bgLight }]}>
                    <MaterialIcons name={t.icon} size={20} color={t.color} />
                  </View>
                  <View style={tierListStyles.tierInfo}>
                    <View style={tierListStyles.tierNameRow}>
                      <Text style={tierListStyles.tierName}>{t.nameAr}</Text>
                      {isCurrent ? (
                        <View style={tierListStyles.activeTag}>
                          <Text style={tierListStyles.activeTagText}>مستواك الحالي</Text>
                        </View>
                      ) : (
                        <Text style={tierListStyles.tierPointsThreshold}>
                          من {formatLatinNumber(t.minPoints)} نقطة
                        </Text>
                      )}
                    </View>
                    <Text style={tierListStyles.tierPerksText}>{t.perks.join(" • ")}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        </View>

        {/* First Order & Welcome Coupon Request Card */}
        <View style={firstOrderStyles.card}>
          <View style={firstOrderStyles.headerRow}>
            <MaterialIcons name="card-giftcard" size={20} color="#614914" />
            <Text style={firstOrderStyles.title}>كوبون الطلب الأول</Text>
            <View style={firstOrderStyles.pill}>
              <Text style={firstOrderStyles.pillText}>طلب كوبون الترحيب</Text>
            </View>
          </View>
          <Text style={firstOrderStyles.hint}>
            اطلبه بنفسك قبل إنشاء أول طلب. نتحقق من أهليتك ونصدره مرة واحدة فقط عند تفعيل الإدارة للبرنامج (طلب كوبون أول طلب للاستفادة من خصم إضافي).
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={requestingFirstOrderCoupon}
            onPress={() => void requestFirstOrderCoupon()}
            style={[
              firstOrderStyles.button,
              requestingFirstOrderCoupon && firstOrderStyles.buttonDisabled,
            ]}
          >
            {requestingFirstOrderCoupon ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <View style={firstOrderStyles.buttonInner}>
                <MaterialIcons name="auto-awesome" size={16} color="#FFFFFF" />
                <Text style={firstOrderStyles.buttonText}>طلب كوبون الطلب الأول</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* Savings Benefit Policy Card */}
        <View style={benefitPolicyStyles.card}>
          <View style={benefitPolicyStyles.heading}>
            <MaterialIcons name="local-offer" size={20} color="#614914" />
            <Text style={benefitPolicyStyles.title}>سياسة التوفير في الطلب</Text>
          </View>
          <Text style={benefitPolicyStyles.summary}>
            نطبّق منفعة سعرية واحدة فقط على المنتجات في كل طلب: سعر الجملة أو العرض أو الكوبون.
          </Text>
          <Text style={benefitPolicyStyles.detail}>
            عند اجتماعها، يُعتمد الأعلى توفيراً تلقائياً. عرض التوصيل مستقل عن هذه المنفعة.
          </Text>
        </View>

        {/* Customer Available Coupons with Direct Activation */}
        <Text style={styles.section}>القسائم الخاصة بك</Text>
        {benefits?.coupons.length ? (
          benefits.coupons.map((coupon) => {
            const isActivated = activeCouponCode === coupon.code;
            return (
              <View
                key={coupon.id}
                style={[styles.coupon, isActivated && styles.couponActivated]}
              >
                <View style={styles.couponMain}>
                  <View
                    style={[
                      styles.couponIconCircle,
                      isActivated && styles.couponIconCircleActive,
                    ]}
                  >
                    <MaterialIcons
                      name="local-offer"
                      size={20}
                      color={isActivated ? "#15865A" : "#8E6916"}
                    />
                  </View>
                  <View style={styles.couponInfo}>
                    <Text style={styles.couponName}>{coupon.name}</Text>
                    <View style={styles.couponCodeRow}>
                      <Text style={styles.couponCode}>{coupon.code}</Text>
                    </View>
                    <Text style={styles.couponDate}>
                      {coupon.validTo ? `حتى ${coupon.validTo}` : "صالحة حالياً"}
                    </Text>
                  </View>
                </View>

                {isActivated ? (
                  <View style={styles.activatedBadge}>
                    <MaterialIcons name="check-circle" size={17} color="#15865A" />
                    <Text style={styles.activatedText}>تم التفعيل بنجاح</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    accessibilityLabel={`تفعيل الكوبون ${coupon.code}`}
                    accessibilityRole="button"
                    activeOpacity={0.8}
                    onPress={() => void handleActivateCoupon(coupon.code)}
                    style={styles.activateButton}
                  >
                    <MaterialIcons name="flash-on" size={16} color="#FFFFFF" />
                    <Text style={styles.activateButtonText}>تفعيل الكوبون</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })
        ) : (
          <View style={styles.blank}>
            <Text style={styles.blankText}>لا توجد قسائم شخصية فعّالة حالياً.</Text>
          </View>
        )}

        {/* Points Ledger */}
        <Text style={styles.section}>سجل النقاط</Text>
        {loyalty?.ledger.length ? (
          loyalty.ledger.map((entry, index) => (
            <View key={`${entry.createdAt}-${index}`} style={styles.ledger}>
              <View>
                <Text style={styles.ledgerTitle}>{entry.note ?? entry.entryType}</Text>
                <Text style={styles.ledgerDate}>
                  {new Date(entry.createdAt).toLocaleDateString("en-US")}
                </Text>
              </View>
              <View style={styles.ledgerAmount}>
                <Text
                  style={[
                    styles.delta,
                    String(entry.pointsDelta).startsWith("-")
                      ? styles.negative
                      : styles.positive,
                  ]}
                >
                  {Number(entry.pointsDelta) > 0 ? "+" : ""}
                  {formatLatinNumber(entry.pointsDelta)}
                </Text>
                <Text style={styles.after}>
                  الرصيد {formatLatinNumber(entry.balanceAfter)}
                </Text>
              </View>
            </View>
          ))
        ) : (
          <View style={styles.blank}>
            <Text style={styles.blankText}>لم تسجل حركة نقاط حتى الآن.</Text>
          </View>
        )}

        {/* Reverify Phone Action */}
        <TouchableOpacity
          onPress={() => router.push("/verify-phone" as never)}
          style={styles.reverify}
        >
          <Text style={styles.reverifyText}>تغيير أو إعادة تحقق رقم الهاتف</Text>
        </TouchableOpacity>
      </ScrollView>
    </ScreenContainer>
  );
}

const tierPerksStyles = StyleSheet.create({
  container: { marginTop: 18 },
  grid: { gap: 10, marginTop: 10 },
  card: {
    alignItems: "flex-start",
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 12,
    padding: 13,
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  cardIconWrap: {
    alignItems: "center",
    backgroundColor: "#ECFDF5",
    borderRadius: 12,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  cardContent: { flex: 1 },
  cardHeaderRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  cardTitle: { color: "#0F172A", fontSize: 13, fontWeight: "900", textAlign: "right" },
  badge: {
    backgroundColor: "#ECFDF5",
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  badgeText: { color: "#065F46", fontSize: 10, fontWeight: "800" },
  cardDesc: { color: "#475569", fontSize: 11, lineHeight: 17, marginTop: 4, textAlign: "right" },
});

const tierListStyles = StyleSheet.create({
  container: { marginTop: 20 },
  list: { gap: 8, marginTop: 10 },
  tierRow: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 10,
    padding: 11,
  },
  tierRowActive: {
    backgroundColor: "#F0FDF4",
    borderColor: "#059669",
    borderWidth: 1.5,
  },
  tierIcon: {
    alignItems: "center",
    borderRadius: 10,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  tierInfo: { flex: 1 },
  tierNameRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  tierName: { color: "#0F172A", fontSize: 13, fontWeight: "900", textAlign: "right" },
  tierPointsThreshold: { color: "#64748B", fontSize: 10, fontWeight: "700" },
  activeTag: {
    backgroundColor: "#059669",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  activeTagText: { color: "#FFFFFF", fontSize: 9, fontWeight: "900" },
  tierPerksText: { color: "#64748B", fontSize: 10, lineHeight: 15, marginTop: 2, textAlign: "right" },
});

const benefitPolicyStyles = StyleSheet.create({
  card: {
    backgroundColor: "#FFF7E7",
    borderColor: "#F2DCAD",
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 14,
    padding: 14,
  },
  heading: { alignItems: "center", flexDirection: "row-reverse", gap: 7 },
  title: { color: "#614914", flex: 1, fontSize: 13, fontWeight: "900", textAlign: "right" },
  summary: { color: "#5D5234", fontSize: 12, lineHeight: 19, marginTop: 8, textAlign: "right" },
  detail: { color: "#746130", fontSize: 11, lineHeight: 18, marginTop: 4, textAlign: "right" },
});

const firstOrderStyles = StyleSheet.create({
  card: {
    backgroundColor: "#FFF7E7",
    borderColor: "#F2DCAD",
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 14,
    padding: 14,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 7,
  },
  title: { color: "#614914", fontSize: 13, fontWeight: "900", textAlign: "right" },
  pill: {
    backgroundColor: "#FEF3C7",
    borderRadius: 8,
    marginRight: "auto",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pillText: { color: "#92400E", fontSize: 10, fontWeight: "800" },
  hint: { color: "#746130", fontSize: 11, lineHeight: 18, marginTop: 6, textAlign: "right" },
  button: {
    alignItems: "center",
    backgroundColor: "#075B4E",
    borderRadius: 12,
    justifyContent: "center",
    marginTop: 11,
    minHeight: 42,
    paddingHorizontal: 14,
  },
  buttonInner: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: 6,
    justifyContent: "center",
  },
  buttonDisabled: { opacity: 0.65 },
  buttonText: { color: "#FFFFFF", fontSize: 12, fontWeight: "900" },
});

const styles = StyleSheet.create({
  content: { padding: 16 },
  stackContent: { paddingBottom: 34 },
  tabContent: { paddingBottom: 110 },
  header: { marginTop: 6 },
  backButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#E7F1EC",
    borderRadius: 10,
    flexDirection: "row-reverse",
    gap: 6,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  emptyBack: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row-reverse",
    gap: 6,
    marginBottom: 16,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  backButtonText: { color: "#075B4E", fontSize: 12, fontWeight: "800" },
  title: { color: "#19352D", fontSize: 22, fontWeight: "900", textAlign: "right" },
  sub: { color: "#687E74", fontSize: 12, marginTop: 4, textAlign: "right" },

  balanceCard: {
    backgroundColor: "#075B4E",
    borderRadius: 22,
    marginTop: 16,
    padding: 18,
    shadowColor: "#075B4E",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 4,
  },
  balanceTop: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
  },
  balanceInfo: { flex: 1 },
  tierPill: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    borderRadius: 12,
    flexDirection: "row-reverse",
    gap: 5,
    marginBottom: 6,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  tierPillText: { color: "#FEF3C7", fontSize: 11, fontWeight: "800" },
  balanceLabel: { color: "#CBE5DA", fontSize: 12, fontWeight: "800", textAlign: "right" },
  balanceAmountRow: {
    alignItems: "baseline",
    flexDirection: "row-reverse",
    gap: 8,
    marginTop: 4,
  },
  balance: { color: "#FFFFFF", fontSize: 34, fontWeight: "900" },
  points: { color: "#E8F1EC", fontSize: 12, fontWeight: "700" },

  /* 3D Coin Visual with rich gold depth, sheen, and sparkles */
  coinOuterGlow: {
    alignItems: "center",
    height: 76,
    justifyContent: "center",
    position: "relative",
    width: 76,
  },
  sparkleTop: {
    position: "absolute",
    right: -2,
    top: -2,
    zIndex: 2,
  },
  sparkleBottom: {
    bottom: -2,
    left: -2,
    position: "absolute",
    zIndex: 2,
  },
  coinOuterRing: {
    alignItems: "center",
    backgroundColor: "#D97706",
    borderColor: "#FEF3C7",
    borderRadius: 33,
    borderWidth: 1.5,
    elevation: 6,
    height: 66,
    justifyContent: "center",
    shadowColor: "#F59E0B",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    width: 66,
  },
  coinMiddleRim: {
    alignItems: "center",
    backgroundColor: "#F59E0B",
    borderColor: "#FDE68A",
    borderRadius: 27,
    borderWidth: 2,
    height: 54,
    justifyContent: "center",
    width: 54,
  },
  coinInnerEmboss: {
    alignItems: "center",
    backgroundColor: "#B45309",
    borderColor: "#FEF3C7",
    borderRadius: 20,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: 40,
  },

  /* Progress Bar Container */
  progressContainer: {
    backgroundColor: "rgba(0, 0, 0, 0.16)",
    borderRadius: 14,
    marginTop: 16,
    padding: 12,
  },
  progressHeader: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  progressLabel: { color: "#E8F1EC", fontSize: 11, fontWeight: "800", textAlign: "right" },
  progressFraction: { color: "#FDE68A", fontSize: 11, fontWeight: "900" },
  progressBarTrack: {
    backgroundColor: "rgba(255, 255, 255, 0.18)",
    borderRadius: 6,
    height: 9,
    overflow: "hidden",
    width: "100%",
  },
  progressBarFill: {
    backgroundColor: "#F59E0B",
    borderRadius: 6,
    height: "100%",
  },
  progressFooter: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginTop: 6,
  },
  progressPercent: { color: "#FDE68A", fontSize: 10, fontWeight: "900" },
  progressHint: { color: "#CBE5DA", flex: 1, fontSize: 10, textAlign: "right" },

  rules: {
    color: "#D4E8DF",
    fontSize: 11,
    lineHeight: 18,
    marginTop: 14,
    textAlign: "right",
  },
  verify: {
    alignItems: "flex-start",
    backgroundColor: "#EAF7F0",
    borderRadius: 14,
    flexDirection: "row-reverse",
    gap: 8,
    marginTop: 12,
    padding: 12,
  },
  verifyText: { color: "#346653", flex: 1, fontSize: 11, lineHeight: 17, textAlign: "right" },
  section: {
    color: "#2A443A",
    fontSize: 15,
    fontWeight: "900",
    marginTop: 22,
    textAlign: "right",
  },

  /* Coupon Cards */
  coupon: {
    alignItems: "center",
    backgroundColor: "#FFF7E7",
    borderColor: "#F2DCAD",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    marginTop: 10,
    padding: 13,
  },
  couponActivated: {
    backgroundColor: "#F0FDF4",
    borderColor: "#86EFAC",
  },
  couponMain: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row-reverse",
    gap: 10,
  },
  couponIconCircle: {
    alignItems: "center",
    backgroundColor: "#FEF3C7",
    borderRadius: 10,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  couponIconCircleActive: {
    backgroundColor: "#DCFCE7",
  },
  couponInfo: { flex: 1 },
  couponName: { color: "#614914", fontSize: 13, fontWeight: "900", textAlign: "right" },
  couponCodeRow: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "rgba(0, 0, 0, 0.04)",
    borderRadius: 6,
    marginVertical: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  couponCode: {
    color: "#8E6916",
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 1,
  },
  couponDate: { color: "#8D753B", fontSize: 10, textAlign: "right" },

  activateButton: {
    alignItems: "center",
    backgroundColor: "#075B4E",
    borderRadius: 10,
    flexDirection: "row-reverse",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  activateButtonText: { color: "#FFFFFF", fontSize: 11, fontWeight: "900" },

  activatedBadge: {
    alignItems: "center",
    backgroundColor: "#DCFCE7",
    borderColor: "#86EFAC",
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  activatedText: { color: "#15865A", fontSize: 11, fontWeight: "900" },

  blank: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E2EAE5",
    borderRadius: 15,
    borderWidth: 1,
    marginTop: 10,
    padding: 15,
  },
  blankText: { color: "#718279", fontSize: 12, textAlign: "right" },

  ledger: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderBottomColor: "#EDF0ED",
    borderBottomWidth: 1,
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingVertical: 13,
  },
  ledgerTitle: { color: "#29453A", fontSize: 12, fontWeight: "800", textAlign: "right" },
  ledgerDate: { color: "#839189", fontSize: 10, marginTop: 4, textAlign: "right" },
  ledgerAmount: { alignItems: "flex-end" },
  delta: { fontSize: 14, fontWeight: "900" },
  positive: { color: "#15865A" },
  negative: { color: "#C95A41" },
  after: { color: "#7B8A82", fontSize: 9, marginTop: 3 },
  reverify: { alignItems: "center", marginTop: 24, padding: 12 },
  reverifyText: { color: "#075B4E", fontSize: 12, fontWeight: "800" },

  empty: { alignItems: "center", flex: 1, justifyContent: "center", padding: 27 },
  emptyIcon: {
    alignItems: "center",
    backgroundColor: "#E7F1EC",
    borderRadius: 29,
    height: 58,
    justifyContent: "center",
    width: 58,
  },
  emptyTitle: { color: "#1C392F", fontSize: 21, fontWeight: "900", marginTop: 18, textAlign: "center" },
  emptyText: { color: "#6D8077", fontSize: 13, lineHeight: 22, marginTop: 8, textAlign: "center" },
  primary: {
    alignItems: "center",
    backgroundColor: "#075B4E",
    borderRadius: 15,
    justifyContent: "center",
    marginTop: 24,
    minHeight: 52,
    paddingHorizontal: 30,
  },
  primaryText: { color: "#FFFFFF", fontSize: 14, fontWeight: "900" },
});
