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

import type { StorefrontBanner, StorefrontOffer } from "@/lib/storefront-api";
import { storefrontDesign } from "@/lib/storefront-design";

type SlideTone = "evergreen" | "citrus" | "berry";

type Slide = {
  id: string;
  kicker: string;
  title: string;
  subtitle: string;
  cta: string;
  imageUrl?: string | null;
  tone: SlideTone;
  source: StorefrontBanner | null;
};

const GAP = 12;
const AUTOPLAY_DELAY_MS = 5600;

function toAssetUrl(value: string | null | undefined) {
  if (!value) return null;
  return value.startsWith("/") ? `https://alarabiya.online${value}` : value;
}

function offerSlide(offer: StorefrontOffer, index: number): Slide {
  const amount = Number(offer.discountAmount);
  const percent = Number(offer.discountPercent);
  const saving =
    offer.type === "PERCENT" && percent > 0
      ? `${percent}%`
      : amount > 0
        ? `${new Intl.NumberFormat("en-US").format(amount)} د.ع`
        : "سعر خاص";

  return {
    id: `offer-${offer.id}`,
    kicker: `عرض فعّال · ${saving}`,
    title: offer.name,
    subtitle: "يُطبّق وفق شروط العرض المعلنة عند إتمام السلة.",
    cta: "استكشف المنتجات",
    tone: (["evergreen", "citrus", "berry"] as SlideTone[])[index % 3],
    source: null,
  };
}

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
  const cardWidth = Math.min(Math.max(width - 32, 304), 520);
  const horizontalInset = Math.max(16, (width - cardWidth) / 2);
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
      }));
    }
    if (offers.length) return offers.slice(0, 4).map(offerSlide);

    return [
      {
        id: "library-welcome",
        kicker: "المكتبة العربية · كل يوم",
        title: "رتّب احتياجاتك في طلب واحد",
        subtitle: "قرطاسية، طباعة وتجهيزات عملية للأفراد والجهات.",
        cta: "ابدأ من المنتجات",
        tone: "evergreen",
        source: null,
      },
    ];
  }, [banners, offers]);

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
    <View>
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
            activeOpacity={0.94}
            onPress={() => onPress(item.source)}
            style={[
              styles.card,
              item.tone === "citrus"
                ? styles.citrus
                : item.tone === "berry"
                  ? styles.berry
                  : styles.evergreen,
              { width: cardWidth },
            ]}
          >
            {item.imageUrl ? (
              <>
                <Image
                  cachePolicy="memory-disk"
                  contentFit="cover"
                  source={item.imageUrl}
                  style={styles.backgroundImage}
                  transition={0}
                />
                <View style={styles.imageScrim} />
              </>
            ) : (
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
            )}
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
          </TouchableOpacity>
        )}
      />
      {slides.length > 1 && (
        <View style={styles.pagination}>
          {slides.map((slide, index) => (
            <View
              key={slide.id}
              style={[styles.dot, index === activeIndex && styles.activeDot]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: GAP },
  card: {
    borderRadius: 30,
    height: 282,
    overflow: "hidden",
    shadowColor: "#0B2922",
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.16,
    shadowRadius: 22,
  },
  evergreen: { backgroundColor: storefrontDesign.semantic.brandStrong },
  citrus: { backgroundColor: storefrontDesign.semantic.highlight },
  berry: { backgroundColor: "#B85768" },
  backgroundImage: { height: "100%", position: "absolute", width: "100%" },
  imageScrim: {
    backgroundColor: "rgba(12, 35, 30, 0.50)",
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
    paddingHorizontal: 24,
    paddingVertical: 22,
    width: "74%",
  },
  kicker: {
    alignItems: "center",
    alignSelf: "flex-end",
    backgroundColor: "rgba(255,255,255,0.16)",
    borderColor: "rgba(255,255,255,0.28)",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row-reverse",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  kickerDot: {
    backgroundColor: storefrontDesign.semantic.highlight,
    borderRadius: 99,
    height: 6,
    width: 6,
  },
  kickerText: {
    color: storefrontDesign.primitive.white,
    fontFamily: "Cairo_700Bold",
    fontSize: 10,
    textAlign: "right",
  },
  citrusKicker: {
    backgroundColor: "rgba(7,83,69,0.12)",
    borderColor: "rgba(7,83,69,0.16)",
  },
  citrusKickerText: { color: storefrontDesign.semantic.brandStrong },
  title: {
    color: storefrontDesign.primitive.white,
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 27,
    lineHeight: 39,
    marginTop: 10,
    textAlign: "right",
  },
  citrusTitle: { color: storefrontDesign.semantic.brandStrong },
  subtitle: {
    color: "rgba(255,255,255,0.86)",
    fontFamily: "Cairo_400Regular",
    fontSize: 12,
    lineHeight: 20,
    marginTop: 5,
    textAlign: "right",
  },
  citrusSubtitle: { color: "#38534C" },
  cta: {
    alignItems: "center",
    alignSelf: "flex-end",
    backgroundColor: storefrontDesign.primitive.white,
    borderRadius: 14,
    flexDirection: "row",
    gap: 7,
    marginTop: 15,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  ctaText: {
    color: storefrontDesign.semantic.brandStrong,
    fontFamily: "Cairo_800ExtraBold",
    fontSize: 11,
  },
  paperArt: {
    bottom: -22,
    height: 238,
    left: -18,
    position: "absolute",
    width: 188,
  },
  artCircle: {
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 120,
    height: 220,
    left: -38,
    position: "absolute",
    top: -18,
    width: 220,
  },
  artBackSheet: {
    backgroundColor: "rgba(255,255,255,0.14)",
    borderColor: "rgba(255,255,255,0.26)",
    borderRadius: 22,
    borderWidth: 1,
    height: 146,
    left: 38,
    position: "absolute",
    top: 48,
    transform: [{ rotate: "-13deg" }],
    width: 106,
  },
  artSheet: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.22)",
    borderColor: "rgba(255,255,255,0.40)",
    borderRadius: 25,
    borderWidth: 1,
    height: 164,
    justifyContent: "center",
    left: 64,
    position: "absolute",
    top: 31,
    transform: [{ rotate: "8deg" }],
    width: 126,
  },
  artRule: {
    backgroundColor: "rgba(255,255,255,0.70)",
    borderRadius: 4,
    height: 4,
    marginTop: 12,
    width: 55,
  },
  artRuleShort: { marginTop: 7, width: 35 },
  pagination: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    marginTop: 13,
  },
  dot: { backgroundColor: "#CBD6D0", borderRadius: 10, height: 6, width: 6 },
  activeDot: {
    backgroundColor: storefrontDesign.semantic.brandStrong,
    width: 26,
  },
});
