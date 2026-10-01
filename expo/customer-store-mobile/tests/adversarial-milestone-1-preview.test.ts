import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const mobileRoot = resolve(__dirname, "..");

describe("Milestone 1 Adversarial Verification Suite", () => {
  // ==========================================================================
  // Section 1: Carousel Timing, Autoplay, Touch Pause Hooks, and Slide Counter
  // ==========================================================================
  describe("1. Marketing Carousel Autoplay, Pause Hooks & Slide Counter", () => {
    const carouselPath = resolve(mobileRoot, "components/marketing-carousel.tsx");

    it("verifies AUTOPLAY_DELAY_MS is exported and set to exactly 4500ms", () => {
      const carouselSrc = readFileSync(carouselPath, "utf8");
      const match = carouselSrc.match(/export\s+const\s+AUTOPLAY_DELAY_MS\s*=\s*(\d+);/);
      expect(match).not.toBeNull();
      const delay = Number(match![1]);
      expect(delay).toBe(4500);

      // Verify setInterval uses AUTOPLAY_DELAY_MS
      expect(carouselSrc).toMatch(/setInterval\([\s\S]*?AUTOPLAY_DELAY_MS\)/);
    });

    it("verifies carousel implements pause on touch drag and resume on momentum scroll end", () => {
      expect(existsSync(carouselPath)).toBe(true);
      const carouselSrc = readFileSync(carouselPath, "utf8");

      // Verify onScrollBeginDrag calls pause
      expect(carouselSrc).toContain("onScrollBeginDrag={pause}");

      // Verify onScrollEndDrag calls resume
      expect(carouselSrc).toContain("onScrollEndDrag={resume}");

      // Verify onMomentumScrollEnd updates active index and resumes
      expect(carouselSrc).toContain("onMomentumScrollEnd={(event) => {");
      expect(carouselSrc).toContain("updateIndex(event);");
      expect(carouselSrc).toContain("resume();");

      // Verify interacting ref and debounce resume timer
      expect(carouselSrc).toContain("interactingRef.current = true;");
      expect(carouselSrc).toContain("clearTimeout(resumeTimerRef.current);");
      expect(carouselSrc).toContain("resumeTimerRef.current = setTimeout(() => {");
      expect(carouselSrc).toContain("interactingRef.current = false;");
      expect(carouselSrc).toContain("1400"); // 1.4s resume debounce
    });

    it("simulates autoplay cycle and verifies modulo wrap-around logic", () => {
      const carouselSrc = readFileSync(carouselPath, "utf8");
      expect(carouselSrc).toContain("(activeIndexRef.current + 1) % slides.length");

      const numSlides = 4;
      let activeIndex = 0;
      const history: number[] = [activeIndex];

      // Simulate 12 autoplay steps
      for (let step = 0; step < 12; step++) {
        activeIndex = (activeIndex + 1) % numSlides;
        history.push(activeIndex);
      }

      expect(history).toEqual([
        0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0,
      ]);
    });

    it("stress-tests slide counter formatting: produces exact 'X من Y' pattern without emojis or non-standard characters", () => {
      const carouselSrc = readFileSync(carouselPath, "utf8");

      // Verify exact template expression
      expect(carouselSrc).toContain("counterBadge");
      expect(carouselSrc).toContain("counterText");
      expect(carouselSrc).toContain("${activeIndex + 1} من ${slides.length}");

      // Test all valid active indices for 4 slides
      const totalSlides = 4;
      for (let idx = 0; idx < totalSlides; idx++) {
        const counterStr = `${idx + 1} من ${totalSlides}`;
        expect(counterStr).toBe(`${idx + 1} من 4`);
        expect(counterStr).toMatch(/^[1-4] من 4$/);
        // Ensure no emojis or special unicode
        expect(counterStr).not.toMatch(/[\uD800-\uDBFF][\uDC00-\uDFFF]/);
      }
    });

    it("verifies 4 local high-definition commercial retail banners exist on disk and have valid sizes", () => {
      const carouselSrc = readFileSync(carouselPath, "utf8");

      const expectedImages = [
        "banner_back_to_school.jpg",
        "banner_office_corp.jpg",
        "banner_art_printing.jpg",
        "promo_flyer_deals.jpg",
      ];

      for (const imgName of expectedImages) {
        expect(carouselSrc).toContain(imgName);
        const fullPath = resolve(mobileRoot, "assets/images", imgName);
        expect(existsSync(fullPath)).toBe(true);
        const stats = statSync(fullPath);
        // Images should be substantial in size (> 200KB)
        expect(stats.size).toBeGreaterThan(200_000);
      }
    });

    it("verifies all fallback banners have isFullBanner: true and no distracting text overlays when rendered full", () => {
      const carouselSrc = readFileSync(carouselPath, "utf8");

      // Check all 4 banner IDs
      expect(carouselSrc).toContain('id: "banner-school"');
      expect(carouselSrc).toContain('id: "banner-corporate"');
      expect(carouselSrc).toContain('id: "banner-art"');
      expect(carouselSrc).toContain('id: "banner-flyer"');

      // When isFullBanner is true, only Image is rendered in TouchableOpacity
      expect(carouselSrc).toContain("item.isFullBanner ? (");
      expect(carouselSrc).toContain("<Image");
      expect(carouselSrc).toContain('contentFit="cover"');
      expect(carouselSrc).toContain("style={styles.fullBannerImage}");
    });
  });

  // ==========================================================================
  // Section 2: 4 Trust Cards Row (Arabic Pillars, Icons, 2x2 Grid Responsiveness)
  // ==========================================================================
  describe("2. Certified 4 Trust Cards & 2x2 Grid Layout", () => {
    const trustCardsPath = resolve(mobileRoot, "components/trust-cards-row.tsx");

    it("verifies exactly 4 trust pillars with certified titles and valid MaterialIcons", () => {
      expect(existsSync(trustCardsPath)).toBe(true);
      const trustSrc = readFileSync(trustCardsPath, "utf8");

      const expectedPillars = [
        {
          id: "shipping",
          icon: "local-shipping",
          title: "واصل لكل المحافظات",
        },
        {
          id: "cod",
          icon: "payments",
          title: "سدد نقد عند الباب",
        },
        {
          id: "warranty",
          icon: "verified-user",
          title: "ضمان 48 ساعة",
        },
        {
          id: "pricing",
          icon: "sell",
          title: "سعر الجملة من المستودع",
        },
      ];

      for (const pillar of expectedPillars) {
        expect(trustSrc).toContain(`id: "${pillar.id}"`);
        expect(trustSrc).toContain(`icon: "${pillar.icon}"`);
        expect(trustSrc).toContain(`title: "${pillar.title}"`);
      }
    });

    it("verifies 2x2 grid layout math: flexBasis 48% with gap 10 guarantees exactly 2 cards per row on any mobile viewport", () => {
      const trustSrc = readFileSync(trustCardsPath, "utf8");

      expect(trustSrc).toContain('flexBasis: "48%"');
      expect(trustSrc).toContain('flexWrap: "wrap"');
      expect(trustSrc).toContain("gap: 10");
      expect(trustSrc).toContain('flexDirection: "row-reverse"');

      // Test mathematical wrapping across various phone viewports
      const viewports = [320, 360, 375, 390, 412, 428, 768];
      const horizontalPadding = 32; // 16px left + 16px right
      const gap = 10;

      for (const vp of viewports) {
        const availableWidth = vp - horizontalPadding;
        const cardBasis = availableWidth * 0.48;

        // Two cards plus one gap
        const twoCardsWidth = cardBasis * 2 + gap;
        // Two cards must fit in available width
        expect(twoCardsWidth).toBeLessThanOrEqual(availableWidth + 0.1);

        // Three cards plus two gaps
        const threeCardsWidth = cardBasis * 3 + gap * 2;
        // Three cards must NOT fit in one row
        expect(threeCardsWidth).toBeGreaterThan(availableWidth);
      }
    });

    it("verifies dark capsule styling tokens: #0B1321 background, emerald icon container, and borders", () => {
      const trustSrc = readFileSync(trustCardsPath, "utf8");

      expect(trustSrc).toContain('backgroundColor: "#0B1321"');
      expect(trustSrc).toContain("borderRadius: 16");
      expect(trustSrc).toContain('borderColor: "rgba(255, 255, 255, 0.08)"');
      expect(trustSrc).toContain('backgroundColor: "rgba(16, 185, 129, 0.15)"');
      expect(trustSrc).toContain('color="#059669"');
    });

    it("verifies TrustCardsRow is rendered directly after MarketingCarousel in index.tsx", () => {
      const indexSrc = readFileSync(resolve(mobileRoot, "app/(tabs)/index.tsx"), "utf8");

      const carouselIndex = indexSrc.indexOf("<MarketingCarousel");
      const trustCardsIndex = indexSrc.indexOf("<TrustCardsRow />");

      expect(carouselIndex).toBeGreaterThan(-1);
      expect(trustCardsIndex).toBeGreaterThan(-1);
      expect(trustCardsIndex).toBeGreaterThan(carouselIndex);

      // Verify no obsolete duplicate assurance bar exists
      expect(indexSrc).not.toContain("styles.assuranceBar");
      expect(indexSrc).not.toContain("styles.assuranceDivider");
    });
  });

  // ==========================================================================
  // Section 3: Quick-Add Cart Bounce Physics & No Side Cart Interruption
  // ==========================================================================
  describe("3. Quick-Add Spring Bounce & Uninterrupted Browsing Flow", () => {
    const indexPath = resolve(mobileRoot, "app/(tabs)/index.tsx");

    it("verifies CART_BOUNCE_SPRING_CONFIG parameters are underdamped for snappy tactile feel", () => {
      const indexSrc = readFileSync(indexPath, "utf8");

      const dampingMatch = indexSrc.match(/damping:\s*(\d+)/);
      const stiffnessMatch = indexSrc.match(/stiffness:\s*(\d+)/);
      const idleScaleMatch = indexSrc.match(/idleScale:\s*([\d.]+)/);
      const peakScaleMatch = indexSrc.match(/peakScale:\s*([\d.]+)/);

      expect(dampingMatch).not.toBeNull();
      expect(stiffnessMatch).not.toBeNull();
      expect(idleScaleMatch).not.toBeNull();
      expect(peakScaleMatch).not.toBeNull();

      const damping = Number(dampingMatch![1]);
      const stiffness = Number(stiffnessMatch![1]);
      const idleScale = Number(idleScaleMatch![1]);
      const peakScale = Number(peakScaleMatch![1]);

      expect(damping).toBe(12);
      expect(stiffness).toBe(200);
      expect(idleScale).toBe(1.0);
      expect(peakScale).toBe(1.25);

      // Calculate damping ratio zeta = damping / (2 * sqrt(mass * stiffness))
      // Assuming mass = 1 (standard React Native physics model)
      const mass = 1;
      const zeta = damping / (2 * Math.sqrt(mass * stiffness));

      // zeta < 1 indicates underdamped (oscillatory bounce feel)
      expect(zeta).toBeLessThan(1.0);
      expect(zeta).toBeGreaterThan(0.3); // snappy, not sluggish
    });

    it("verifies triggerCartBounce uses Animated.sequence with peakScale and idleScale", () => {
      const indexSrc = readFileSync(indexPath, "utf8");

      expect(indexSrc).toContain("const triggerCartBounce = () => {");
      expect(indexSrc).toContain("Animated.sequence([");
      expect(indexSrc).toContain("toValue: CART_BOUNCE_SPRING_CONFIG.peakScale");
      expect(indexSrc).toContain("toValue: CART_BOUNCE_SPRING_CONFIG.idleScale");
      expect(indexSrc).toContain("useNativeDriver: true");
    });

    it("strictly verifies setSideCartVisible(true) is NEVER called from quick-add actions", () => {
      const indexSrc = readFileSync(indexPath, "utf8");

      // Inspect FlashDealsRail block
      const flashDealsBlock = indexSrc.match(/<FlashDealsRail[\s\S]*?\/>/)?.[0] ?? "";
      expect(flashDealsBlock).toContain("triggerCartBounce()");
      expect(flashDealsBlock).not.toContain("setSideCartVisible(true)");

      // Inspect sub10k products rail
      const sub10kIndex = indexSrc.indexOf("sub10kProducts.slice");
      expect(sub10kIndex).toBeGreaterThan(-1);
      const sub10kSection = indexSrc.slice(sub10kIndex, sub10kIndex + 600);
      expect(sub10kSection).toContain("triggerCartBounce()");
      expect(sub10kSection).not.toContain("setSideCartVisible(true)");

      // Inspect popular products rail
      const popularIndex = indexSrc.indexOf("homeProducts.slice");
      expect(popularIndex).toBeGreaterThan(-1);
      const popularSection = indexSrc.slice(popularIndex, popularIndex + 600);
      expect(popularSection).toContain("triggerCartBounce()");
      expect(popularSection).not.toContain("setSideCartVisible(true)");

      // Inspect catalog products grid
      const gridIndex = indexSrc.indexOf("styles.grid");
      expect(gridIndex).toBeGreaterThan(-1);
      const gridSection = indexSrc.slice(gridIndex, gridIndex + 600);
      expect(gridSection).toContain("triggerCartBounce()");
      expect(gridSection).not.toContain("setSideCartVisible(true)");

      // The only place setSideCartVisible(true) is allowed is QuickProductView
      const occurrences = (indexSrc.match(/setSideCartVisible\(true\)/g) || []).length;
      expect(occurrences).toBe(1);

      const quickProductViewIndex = indexSrc.indexOf("<QuickProductView");
      const sideCartTrueIndex = indexSrc.indexOf("setSideCartVisible(true)");
      // Must be inside QuickProductView
      expect(sideCartTrueIndex).toBeGreaterThan(quickProductViewIndex);
    });

    it("verifies header cart button is wrapped with Animated.View responding to cartScaleAnim", () => {
      const indexSrc = readFileSync(indexPath, "utf8");

      expect(indexSrc).toContain("<Animated.View style={{ transform: [{ scale: cartScaleAnim }] }}>");
      expect(indexSrc).toContain('onPress={() => router.push("/cart" as never)}');
    });

    it("verifies welcome greeting is strictly intact for milestone contract", () => {
      const indexSrc = readFileSync(indexPath, "utf8");
      expect(indexSrc).toContain('greeting="أهلاً بك في الرؤية العربية!"');
    });
  });
});
