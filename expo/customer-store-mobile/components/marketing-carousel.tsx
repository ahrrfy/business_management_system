import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Image } from "expo-image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, type NativeScrollEvent, type NativeSyntheticEvent, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from "react-native";

import type { StorefrontBanner, StorefrontOffer } from "@/lib/storefront-api";

type Slide = {
  id: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  cta: string;
  imageUrl?: string | null;
  accent: "teal" | "gold" | "coral" | "ink";
  source: StorefrontBanner | null;
};

const SLIDE_GAP = 12;
const AUTOPLAY_DELAY_MS = 4800;

function toAssetUrl(value: string | null | undefined) {
  if (!value) return null;
  return value.startsWith("/") ? `https://alarabiya.online${value}` : value;
}

function offerCopy(offer: StorefrontOffer): { eyebrow: string; title: string; subtitle: string } {
  const amount = Number(offer.discountAmount);
  const percent = Number(offer.discountPercent);
  const value = offer.type === "PERCENT" && percent > 0 ? `${percent}%` : amount > 0 ? `${new Intl.NumberFormat("en-US").format(amount)} د.ع` : "سعر خاص";
  return {
    eyebrow: "عرض فعّال من المكتبة",
    title: offer.name,
    subtitle: `${value} وفق شروط العرض المعلنة في السلة`,
  };
}

export function MarketingCarousel({ banners, offers, onPress }: { banners: StorefrontBanner[]; offers: StorefrontOffer[]; onPress: (banner: StorefrontBanner | null) => void }) {
  const { width } = useWindowDimensions();
  const slides = useMemo<Slide[]>(() => {
    const heroBanners = banners.filter((banner) => banner.placement === "HERO");
    if (heroBanners.length) {
      return heroBanners.map((banner, index) => ({
        id: `banner-${banner.id}-${index}`,
        eyebrow: banner.ctaLabel ? "مختارات مكتبة العربية" : "من مكتبة العربية",
        title: banner.title,
        subtitle: banner.subtitle ?? "اكتشف تفاصيل العرض والمنتجات المشمولة.",
        cta: banner.ctaLabel ?? "اكتشف الآن",
        imageUrl: toAssetUrl(banner.mobileImageUrl ?? banner.imageUrl),
        accent: index % 3 === 0 ? "teal" : index % 3 === 1 ? "gold" : "coral",
        source: banner,
      }));
    }
    if (offers.length) {
      return offers.slice(0, 4).map((offer, index) => {
        const copy = offerCopy(offer);
        return { id: `offer-${offer.id}`, ...copy, cta: "تصفح المنتجات", accent: index % 3 === 0 ? "teal" : index % 3 === 1 ? "gold" : "coral", source: null };
      });
    }
    return [{ id: "library-welcome", eyebrow: "كل ما تحتاجه في مكان واحد", title: "اكتشف عالم القراءة والتعلّم", subtitle: "منتجات مختارة وأسعار محدثة مباشرة من مكتبة العربية.", cta: "تسوق الآن", accent: "teal", source: null }];
  }, [banners, offers]);
  const cardWidth = Math.min(Math.max(width - 32, 320), 480);
  const sideInset = Math.max(16, (width - cardWidth) / 2);
  const snapInterval = cardWidth + SLIDE_GAP;
  const listRef = useRef<FlatList<Slide>>(null);
  const activeIndexRef = useRef(0);
  const isInteractingRef = useRef(false);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const updateActiveSlide = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nextIndex = Math.max(0, Math.min(slides.length - 1, Math.round(event.nativeEvent.contentOffset.x / snapInterval)));
    activeIndexRef.current = nextIndex;
    setActiveIndex(nextIndex);
  }, [slides.length, snapInterval]);

  const pauseForInteraction = useCallback(() => {
    isInteractingRef.current = true;
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
  }, []);

  const resumeAfterInteraction = useCallback(() => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => {
      isInteractingRef.current = false;
    }, 1200);
  }, []);

  useEffect(() => {
    activeIndexRef.current = 0;
    setActiveIndex(0);
    listRef.current?.scrollToOffset({ animated: false, offset: 0 });
  }, [snapInterval, slides.length]);

  useEffect(() => {
    if (slides.length < 2) return;
    const timer = setInterval(() => {
      if (isInteractingRef.current) return;
      const nextIndex = (activeIndexRef.current + 1) % slides.length;
      listRef.current?.scrollToOffset({ animated: true, offset: nextIndex * snapInterval });
      activeIndexRef.current = nextIndex;
      setActiveIndex(nextIndex);
    }, AUTOPLAY_DELAY_MS);
    return () => clearInterval(timer);
  }, [slides.length, snapInterval]);

  useEffect(() => () => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
  }, []);

  return <View>
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
      contentContainerStyle={[styles.content, { paddingHorizontal: sideInset }]}
      getItemLayout={(_, index) => ({ index, length: snapInterval, offset: index * snapInterval })}
      onScrollBeginDrag={pauseForInteraction}
      onScrollEndDrag={resumeAfterInteraction}
      onMomentumScrollEnd={(event) => { updateActiveSlide(event); resumeAfterInteraction(); }}
      renderItem={({ item }) => <TouchableOpacity activeOpacity={0.92} onPress={() => onPress(item.source)} style={[styles.card, item.accent === "gold" ? styles.gold : item.accent === "coral" ? styles.coral : item.accent === "ink" ? styles.ink : styles.teal, { width: cardWidth }]}>
        {item.imageUrl ? <Image cachePolicy="memory-disk" contentFit="cover" source={item.imageUrl} style={styles.backgroundImage} transition={0} /> : <View style={styles.art}><MaterialIcons color={item.accent === "gold" ? "#0E806A" : "#FFF1C6"} name="auto-stories" size={72} /><View style={styles.artCircle} /></View>}
        <View style={styles.overlay} />
        <View style={styles.copy}><View style={styles.eyebrowPill}><MaterialIcons color="#FFF2CB" name="stars" size={13} /><Text style={styles.eyebrow}>{item.eyebrow}</Text></View><Text numberOfLines={2} style={styles.title}>{item.title}</Text><Text numberOfLines={2} style={styles.subtitle}>{item.subtitle}</Text><View style={styles.cta}><Text style={styles.ctaText}>{item.cta}</Text><MaterialIcons color="#FFFFFF" name="arrow-back" size={17} /></View></View>
      </TouchableOpacity>}
    />
    {slides.length > 1 && <View style={styles.pagination}>{slides.map((slide, index) => <View key={slide.id} style={[styles.dot, index === activeIndex && styles.activeDot]} />)}</View>}
  </View>;
}

const styles = StyleSheet.create({
  content: { gap: SLIDE_GAP },
  card: { borderRadius: 24, elevation: 4, height: 222, overflow: "hidden", shadowColor: "#173A33", shadowOpacity: 0.12, shadowRadius: 12 },
  teal: { backgroundColor: "#0E806A" }, gold: { backgroundColor: "#F3B85A" }, coral: { backgroundColor: "#F05D53" }, ink: { backgroundColor: "#32796C" },
  backgroundImage: { height: "100%", position: "absolute", width: "100%" },
  overlay: { backgroundColor: "rgba(11,58,47,0.28)", bottom: 0, left: 0, position: "absolute", right: 0, top: 0 },
  copy: { alignItems: "flex-end", flex: 1, justifyContent: "center", paddingHorizontal: 22, paddingVertical: 20 },
  eyebrowPill: { alignItems: "center", alignSelf: "flex-end", backgroundColor: "rgba(0,0,0,0.16)", borderColor: "rgba(255,255,255,0.22)", borderRadius: 20, borderWidth: 1, flexDirection: "row-reverse", gap: 5, paddingHorizontal: 9, paddingVertical: 5 },
  eyebrow: { color: "#FFF8E6", fontFamily: "Cairo_700Bold", fontSize: 11, textAlign: "right" },
  title: { color: "#FFFFFF", fontFamily: "Cairo_800ExtraBold", fontSize: 26, lineHeight: 36, marginTop: 9, textAlign: "right" },
  subtitle: { color: "#F8FFFC", fontFamily: "Cairo_400Regular", fontSize: 13, lineHeight: 21, marginTop: 7, maxWidth: "76%", textAlign: "right" },
  cta: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.20)", borderColor: "rgba(255,255,255,0.40)", borderRadius: 12, borderWidth: 1, flexDirection: "row", gap: 6, marginTop: 16, paddingHorizontal: 13, paddingVertical: 10 },
  ctaText: { color: "#FFFFFF", fontFamily: "Cairo_700Bold", fontSize: 12 },
  art: { alignItems: "center", bottom: -22, justifyContent: "center", left: -13, position: "absolute" },
  artCircle: { borderColor: "rgba(255,255,255,0.16)", borderRadius: 72, borderWidth: 1, height: 144, position: "absolute", width: 144 },
  pagination: { alignItems: "center", flexDirection: "row", gap: 6, justifyContent: "center", marginTop: 11 },
  dot: { backgroundColor: "#D7CBBE", borderRadius: 4, height: 6, width: 6 },
  activeDot: { backgroundColor: "#0E806A", width: 20 },
});
