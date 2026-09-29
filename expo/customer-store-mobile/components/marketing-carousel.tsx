import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Image } from "expo-image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";

import { marketingCarouselGeometry } from "@/lib/marketing-carousel-layout";
import type { StorefrontBanner, StorefrontOffer } from "@/lib/storefront-api";
import { storefrontDesign } from "@/lib/storefront-design";

type SlideTone = "evergreen" | "citrus" | "berry";

export type Slide = {
  id: string;
  kicker: string;
  title: string;
  subtitle: string;
  cta: string;
  imageUrl?: string | null;
  imageSource?: any;
  tone: SlideTone;
  source: StorefrontBanner | null;
  isFullBanner?: boolean;
};

const GAP = 12;
export const AUTOPLAY_DELAY_MS = 4500;

function toAssetUrl(value: string | null | undefined) {
  if (!value) return null;
  return value.startsWith("/") ? `https://alarabiya.online${value}` : value;
}

export const FALLBACK_BANNERS: Slide[] = [
  {
    id: "banner-school",
    kicker: "موسم المدارس والجامعات",
    title: "أقوى عروض العودة للدراسة - خصومات 60%",
    subtitle: "قرطاسية فاخرة وحقائب ودفاتر وأدوات هندسية متكاملة.",
    cta: "تسوق العروض",
    imageSource: require("@/assets/images/banner_back_to_school.jpg"),
    tone: "evergreen",
    source: null,
    isFullBanner: true,
  },
  {
    id: "banner-corporate",
    kicker: "تجهيز المكاتب والشركات",
    title: "تجهيزات الشركات والمؤسسات — خصومات الجملة 45%",
    subtitle: "مذكرات جلدية، طابعات ليزر، وأقلام حبر فاخرة بأسعار الجملة.",
    cta: "طلب عرض أسعار",
    imageSource: require("@/assets/images/banner_office_corp.jpg"),
    tone: "citrus",
    source: null,
    isFullBanner: true,
  },
  {
    id: "banner-art",
    kicker: "الفنون والطباعة الرقمية",
    title: "مهرجان الفنون والطباعة — تخفيضات حتى 50%",
    subtitle: "ألوان احترافية، كراسات رسم، وطباعة هدايا وتخرج مخصصة.",
    cta: "استكشف الفنون",
    imageSource: require("@/assets/images/banner_art_printing.jpg"),
    tone: "berry",
    source: null,
    isFullBanner: true,
  },
  {
    id: "banner-flyer",
    kicker: "المجلة الأسبوعية الرسمية",
    title: "مجلة عروض وتخفيضات الأسبوع الكبرى",
    subtitle: "أكثر من 150 منتجاً مخفضاً وتوصيل سريع لكافة المحافظات.",
    cta: "تصفح المجلة",
    imageSource: require("@/assets/images/promo_flyer_deals.jpg"),
    tone: "citrus",
    source: null,
    isFullBanner: true,
  },
];

function decorativeIcon(tone: SlideTone) {
  return tone === "citrus"
    ? "auto-stories"
    : tone === "berry"
      ? "redeem"
      : "edit-note";
}

export function MarketingCarousel({
  banners,
  offers,
  onPress,
}: {
  banners: StorefrontBanner[];
  offers: StorefrontOffer[];
  onPress: (banner: StorefrontBanner | null) => void;
}) {
  const { width } = useWindowDimensions();
  const { cardWidth, sideInset: horizontalInset } = marketingCarouselGeometry(width);
  const snapInterval = cardWidth + GAP;
  const slides = useMemo<Slide[]>(() => {
    const heroBanners = banners.filter((banner) => banner.placement === "HERO");
    if (heroBanners.length) {
      return heroBanners.map((banner, index) => ({
        id: `banner-${banner.id}`,
        kicker: banner.ctaLabel ? "اختيار هذا الأسبوع" : "مختارات المكتبة",
        title: banner.title,
        subtitle: banner.subtitle ?? "منتجات عملية لمدرستك ومكتبك ومشاريعك.",
        cta: banner.ctaLabel ?? "اكتشف الآن",
        imageUrl: toAssetUrl(banner.mobileImageUrl ?? banner.imageUrl),
        tone: (["evergreen", "citrus", "berry"] as SlideTone[])[index % 3],
        source: banner,
        isFullBanner: Boolean(banner.mobileImageUrl ?? banner.imageUrl),
      }));
    }

    // Prioritize 4 local high-definition commercial ad banners displayed full-width
    // in pure commercial retail style without distracting overlay text
    return FALLBACK_BANNERS;
  }, [banners]);

  const listRef = useRef<FlatList<Slide>>(null);
  const activeIndexRef = useRef(0);
  const interactingRef = useRef(false);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const updateIndex = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const index = Math.max(
        0,
        Math.min(
          slides.length - 1,
          Math.round(event.nativeEvent.contentOffset.x / snapInterval),
        ),
      );
      activeIndexRef.current = index;
      setActiveIndex(index);
    },
    [slides.length, snapInterval],
  );

  const pause = useCallback(() => {
    interactingRef.current = true;
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
  }, []);

  const resume = useCallback(() => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => {
      interactingRef.current = false;
    }, 1400);
  }, []);

  useEffect(() => {
    activeIndexRef.current = 0;
    setActiveIndex(0);
    listRef.current?.scrollToOffset({ animated: false, offset: 0 });
  }, [snapInterval, slides.length]);

  useEffect(() => {
    if (slides.length < 2) return;
    const timer = setInterval(() => {
      if (interactingRef.current) return;
      const next = (activeIndexRef.current + 1) % slides.length;
      listRef.current?.scrollToOffset({
        animated: true,
        offset: next * snapInterval,
      });
      activeIndexRef.current = next;
      setActiveIndex(next);
    }, AUTOPLAY_DELAY_MS);
    return () => clearInterval(timer);
  }, [slides.length, snapInterval]);

  useEffect(
    () => () => {
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    },
    [],
  );

  return (
    <View style={styles.wrapper}>
      <FlatList
        ref={listRef}
        data={slides}
        horizontal
        keyExtractor={(item) => item.id}
        showsHorizontalScrollIndicator={false}
        snapToInterval={snapInterval}
        snapToAlignment="start"
        disableIntervalMomentum
        decelerationRate="fast"
        contentContainerStyle={[
          styles.content,
          { paddingHorizontal: horizontalInset },
        ]}
        getItemLayout={(_, index) => ({
          index,
          length: snapInterval,
          offset: index * snapInterval,
        })}
        onScrollBeginDrag={pause}
        onScrollEndDrag={resume}
        onMomentumScrollEnd={(event) => {
          updateIndex(event);
          resume();
        }}
        renderItem={({ item }) => (
          <TouchableOpacity
            accessibilityLabel={item.title}
            accessibilityRole="button"
            activeOpacity={0.92}
            onPress={() => onPress(item.source)}
            style={[
              item.isFullBanner
                ? [styles.fullBannerCard, { width: cardWidth }]
                : [
                    styles.card,
                    item.tone === "citrus"
                      ? styles.citrus
                      : item.tone === "berry"
                        ? styles.berry
                        : styles.evergreen,
                    { width: cardWidth },
                  ],
            ]}
          >
            {item.isFullBanner ? (
              <Image
                cachePolicy="memory-disk"
                contentFit="cover"
                source={item.imageSource ?? item.imageUrl}
                style={styles.fullBannerImage}
                transition={150}
              />
            ) : item.imageUrl ? (
              <>
                <Image
                  cachePolicy="memory-disk"
                  contentFit="cover"
                  source={item.imageUrl}
                  style={styles.backgroundImage}
                  transition={0}
                />
                <View style={styles.imageScrim} />
                <View style={styles.copy}>
                  <View
                    style={[
                      styles.kicker,
                      item.tone === "citrus" && styles.citrusKicker,
                    ]}
                  >
                    <View style={styles.kickerDot} />
                    <Text
                      style={[
                        styles.kickerText,
                        item.tone === "citrus" && styles.citrusKickerText,
                      ]}
                    >
                      {item.kicker}
                    </Text>
                  </View>
                  <Text
                    numberOfLines={2}
                    style={[
                      styles.title,
                      item.tone === "citrus" && styles.citrusTitle,
                    ]}
                  >
                    {item.title}
                  </Text>
                  <Text
                    numberOfLines={2}
                    style={[
                      styles.subtitle,
                      item.tone === "citrus" && styles.citrusSubtitle,
                    ]}
                  >
                    {item.subtitle}
                  </Text>
                  <View style={styles.cta}>
                    <Text style={styles.ctaText}>{item.cta}</Text>
                    <MaterialIcons
                      color={storefrontDesign.semantic.brandStrong}
                      name="arrow-back"
                      size={18}
                    />
                  </View>
                </View>
              </>
            ) : (
              <>
                <View pointerEvents="none" style={styles.paperArt}>
                  <View style={styles.artCircle} />
                  <View style={styles.artBackSheet} />
                  <View style={styles.artSheet}>
                    <MaterialIcons
                      color={
                        item.tone === "citrus"
                          ? storefrontDesign.semantic.brandStrong
                          : storefrontDesign.primitive.white
                      }
                      name={decorativeIcon(item.tone)}
                      size={54}
                    />
                    <View style={styles.artRule} />
                    <View style={[styles.artRule, styles.artRuleShort]} />
                  </View>
                </View>
                <View style={styles.copy}>
                  <View
                    style={[
                      styles.kicker,
                      item.tone === "citrus" && styles.citrusKicker,
                    ]}
                  >
                    <View style={styles.kickerDot} />
                    <Text
                      style={[
                        styles.kickerText,
                        item.tone === "citrus" && styles.citrusKickerText,
                      ]}
                    >
                      {item.kicker}
                    </Text>
                  </View>
                  <Text
                    numberOfLines={2}
                    style={[
                      styles.title,
                      item.tone === "citrus" && styles.citrusTitle,
                    ]}
                  >
                    {item.title}
                  </Text>
                  <Text
                    numberOfLines={2}
                    style={[
                      styles.subtitle,
                      item.tone === "citrus" && styles.citrusSubtitle,
                    ]}
                  >
                    {item.subtitle}
                  </Text>
                  <View style={styles.cta}>
                    <Text style={styles.ctaText}>{item.cta}</Text>
                    <MaterialIcons
                      color={storefrontDesign.semantic.brandStrong}
                      name="arrow-back"
                      size={18}
                    />
                  </View>
                </View>
              </>
            )}
          </TouchableOpacity>
        )}
      />
      {slides.length > 1 && (
        <View style={styles.pagination}>
          <View style={styles.counterBadge}>
            <Text style={styles.counterText}>
              {`${activeIndex + 1} من ${slides.length}`}
            </Text>
          </View>
          <View style={styles.dotsRow}>
            {slides.map((slide, index) => (
              <View
                key={slide.id}
                style={[styles.dot, index === activeIndex && styles.activeDot]}
              />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: 4,
  },
  content: { gap: GAP },
  fullBannerCard: {
    height: 195,
    borderRadius: 20,
    backgroundColor: "#0A111E",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    overflow: "hidden",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.16,
    shadowRadius: 14,
    elevation: 5,
  },
  fullBannerImage: {
    width: "100%",
    height: "100%",
    borderRadius: 20,
  },
  card: {
    borderRadius: 24,
    height: 230,
    overflow: "hidden",
    shadowColor: "#183D36",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.12,
    shadowRadius: 18,
    elevation: 6,
  },
  evergreen: { backgroundColor: "#065F46" },
  citrus: { backgroundColor: "#B45309" },
  berry: { backgroundColor: "#BE123C" },
  backgroundImage: { height: "100%", position: "absolute", width: "100%" },
  imageScrim: {
    backgroundColor: "rgba(15, 23, 42, 0.46)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  copy: {
    alignItems: "flex-end",
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 22,
    paddingVertical: 18,
    width: "75%",
  },
  kicker: {
    alignItems: "center",
    alignSelf: "flex-end",
    backgroundColor: "rgba(255, 255, 255, 0.22)",
    borderColor: "rgba(255, 255, 255, 0.40)",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  kickerDot: {
    backgroundColor: "#34D399",
    borderRadius: 99,
    height: 6,
    width: 6,
  },
  kickerText: {
    color: "#FFFFFF",
    fontFamily: "Cairo_700Bold",
    fontSize: 10,
    textAlign: "right",
  },
  citrusKicker: {
    backgroundColor: "rgba(255, 255, 255, 0.22)",
    borderColor: "rgba(255, 255, 255, 0.40)",
  },
  citrusKickerText: { color: "#FFFFFF" },
  title: {
    color: "#FFFFFF",
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 22,
    lineHeight: 32,
    marginTop: 8,
    textAlign: "right",
  },
  citrusTitle: { color: "#FFFFFF" },
  subtitle: {
    color: "rgba(255, 255, 255, 0.90)",
    fontFamily: "Cairo_400Regular",
    fontSize: 11,
    lineHeight: 18,
    marginTop: 4,
    textAlign: "right",
  },
  citrusSubtitle: { color: "rgba(255, 255, 255, 0.90)" },
  cta: {
    alignItems: "center",
    alignSelf: "flex-end",
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    flexDirection: "row-reverse",
    gap: 6,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 8,
    shadowColor: "#000000",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 3,
  },
  ctaText: {
    color: "#183D36",
    fontFamily: "Cairo_700Bold",
    fontSize: 11,
  },
  paperArt: {
    bottom: -20,
    height: 220,
    left: -15,
    position: "absolute",
    width: 180,
  },
  artCircle: {
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    borderRadius: 110,
    height: 200,
    left: -30,
    position: "absolute",
    top: -15,
    width: 200,
  },
  artBackSheet: {
    backgroundColor: "rgba(255, 255, 255, 0.14)",
    borderColor: "rgba(255, 255, 255, 0.26)",
    borderRadius: 20,
    borderWidth: 1,
    height: 135,
    left: 35,
    position: "absolute",
    top: 42,
    transform: [{ rotate: "-13deg" }],
    width: 100,
  },
  artSheet: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.22)",
    borderColor: "rgba(255, 255, 255, 0.38)",
    borderRadius: 22,
    borderWidth: 1,
    height: 150,
    justifyContent: "center",
    left: 58,
    position: "absolute",
    top: 28,
    transform: [{ rotate: "8deg" }],
    width: 118,
  },
  artRule: {
    backgroundColor: "rgba(255, 255, 255, 0.70)",
    borderRadius: 4,
    height: 4,
    marginTop: 10,
    width: 50,
  },
  artRuleShort: { marginTop: 6, width: 32 },
  pagination: {
    alignItems: "center",
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    marginTop: 10,
  },
  dotsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  counterBadge: {
    backgroundColor: "#F1F5F9",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  counterText: {
    fontFamily: "Cairo_700Bold",
    fontSize: 10,
    color: "#64748B",
  },
  dot: { backgroundColor: "#CBD5E1", borderRadius: 10, height: 5, width: 5 },
  activeDot: {
    backgroundColor: "#059669",
    borderRadius: 99,
    height: 5,
    width: 22,
  },
});
