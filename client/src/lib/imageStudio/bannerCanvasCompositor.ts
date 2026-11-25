/**
 * bannerCanvasCompositor — محرك الإخراج الإعلاني متعدّد الطبقات بأسلوب الوكالات العالمية وApple.
 *
 * المزايا الجوهرية وحراسة الأمانة:
 * 1. حراسة بكسلات المنتج وكتابته 100% (Pixel-True Product Cutout Layering):
 *    في وضعَي الاستوديو الفوري (LOCAL_STUDIO) والمشهد الهجين السينمائي (HYBRID_STAGE)، تُرسم بكسلات
 *    صور المنتجات الأصلية المعتمدة كما هي دون أي إعادة رسم توليدي قد يحرّف شكل المنتج أو كتابة الغلاف.
 * 2. دمج وتكتيل حتى 5 منتجات متداخلة ثلاثية الأبعاد (Hero Ensemble / Podium / Cascade / Grid)
 *    مع تفريغ الحواف الخارجية البيضاء وظلال عمق متبادلة وهالة فصل حواف.
 * 3. ضبط الإضاءة والتدرج اللوني (Softbox · Spotlight · Golden Sunbeam · Rim Glow) وتلاشي لوني
 *    ناعم (Smooth S-Curve Color-Graded Scrim) يمنع الضباب الأبيض القاسي الذي يبهت البنر.
 * 4. فعاليات تصميمية تسويقية قابلة للتفعيل (منصة عرض 3D، أشعة وبوكيه، ختم السعر/العرض الدائري، وبطاقة نص زجاجية).
 */

import {
  BANNER_PLACEMENT_SPECS,
  BANNER_STUDIO_PRESETS,
  sanitizeBannerCopyText,
  type BannerCompositionStyle,
  type BannerCopyVariant,
  type BannerCreativeEffect,
  type BannerLightingMode,
  type BannerStudioPalette,
  type BannerStudioPresetId,
  type StudioBannerPlacement,
} from "@shared/imageStudio/bannerStudioContract";
import {
  draw3DPodiumStage,
  drawLightingAndAtmosphere,
  drawMergedProductEnsemble,
  drawPromoSealBadge,
  extractCutoutProductSprite,
  type CutoutProductSprite,
} from "./bannerStageEffects";

export type StudioVisualRenderMode = "LOCAL_STUDIO" | "HYBRID_STAGE" | "AI_FULL_SCENE";

export interface ComposeBannerInput {
  presetId: BannerStudioPresetId;
  placement: StudioBannerPlacement;
  sceneDataUrl?: string | null;
  visualMode?: StudioVisualRenderMode;
  productImageUrls?: string[];
  lightingMode?: BannerLightingMode;
  compositionStyle?: BannerCompositionStyle;
  productScale?: number;
  effects?: BannerCreativeEffect[];
  copy: BannerCopyVariant;
}

export interface BannerQualityCheck {
  contrastRatio: number;
  passesContrast: boolean;
  pixelFidelityGuaranteed: boolean;
  mergedProductCount: number;
  desktopBytes: number;
  mobileBytes: number;
  desktopDimensions: { width: number; height: number };
  mobileDimensions: { width: number; height: number };
}

export interface ComposedBannerPair {
  desktopDataUrl: string;
  mobileDataUrl: string;
  quality: BannerQualityCheck;
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").trim();
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const num = Number.parseInt(full, 16);
  if (!Number.isFinite(num)) return [29, 29, 31];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const chan = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/** يحسب نسبة التباين القياسية WCAG 2.1 بين لون النص ولون الخلفية الفعلي. */
export function computeHexContrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(parseHexRgb(hexA));
  const l2 = relativeLuminance(parseHexRgb(hexB));
  const bright = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return Math.round(((bright + 0.05) / (dark + 0.05)) * 100) / 100;
}

function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
}

async function waitForFontsBounded(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.ready) return;
  await Promise.race([
    document.fonts.ready.catch(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
  ]);
}

const MAX_HTML_IMG_CACHE = 48;
const htmlImgCache = new Map<string, HTMLImageElement>();

function loadHtmlImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src || typeof Image === "undefined") {
      resolve(null);
      return;
    }
    if (!src.startsWith("data:")) {
      const cached = htmlImgCache.get(src);
      if (cached && cached.complete && cached.naturalWidth > 0) {
        resolve(cached);
        return;
      }
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = window.setTimeout(() => resolve(null), 6000);
    img.onload = () => {
      window.clearTimeout(timer);
      if (!src.startsWith("data:")) {
        if (htmlImgCache.size >= MAX_HTML_IMG_CACHE) {
          const oldest = htmlImgCache.keys().next().value;
          if (oldest) htmlImgCache.delete(oldest);
        }
        htmlImgCache.set(src, img);
      }
      resolve(img);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    img.src = src;
  });
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function wrapRtlLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = words[0]!;
  for (let i = 1; i < words.length; i += 1) {
    const candidate = `${current} ${words[i]}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i]!;
      if (lines.length === maxLines - 1) {
        for (let j = i + 1; j < words.length; j += 1) {
          const nextTry = `${current} ${words[j]}`;
          if (ctx.measureText(nextTry).width <= maxWidth) current = nextTry;
          else break;
        }
        break;
      }
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  return lines.slice(0, maxLines);
}

function drawCoverImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  width: number,
  height: number,
) {
  const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
  const drawW = img.naturalWidth * scale;
  const drawH = img.naturalHeight * scale;
  const offsetX = (width - drawW) * 0.3;
  const offsetY = (height - drawH) * 0.5;
  ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
}

let cachedGrainCanvas: HTMLCanvasElement | null = null;
function getStudioFilmGrainPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (typeof document === "undefined") return null;
  if (!cachedGrainCanvas) {
    const tile = document.createElement("canvas");
    tile.width = 72;
    tile.height = 72;
    const tctx = tile.getContext("2d");
    if (tctx) {
      const imgData = tctx.createImageData(72, 72);
      let seed = 918273;
      for (let i = 0; i < imgData.data.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const v = (seed >>> 24) & 255;
        imgData.data[i] = v;
        imgData.data[i + 1] = v;
        imgData.data[i + 2] = v;
        imgData.data[i + 3] = 5;
      }
      tctx.putImageData(imgData, 0, 0);
    }
    cachedGrainCanvas = tile;
  }
  return ctx.createPattern(cachedGrainCanvas, "repeat");
}

function drawAgencyStudioStage(opts: {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  isMobile: boolean;
  palette: BannerStudioPalette;
  isDarkTheme: boolean;
  lightingMode: BannerLightingMode;
  compositionStyle: BannerCompositionStyle;
  productScale: number;
  effects: Set<BannerCreativeEffect>;
  productSprites: CutoutProductSprite[];
}) {
  const {
    ctx,
    width,
    height,
    isMobile,
    palette,
    isDarkTheme,
    lightingMode,
    compositionStyle,
    productScale,
    effects,
    productSprites,
  } = opts;

  // 1. سيكلوراما استوديو ثلاثية الأبعاد (3-Zone Commercial Camera Cyclorama + Perspective Horizon Plane)
  const horizonY = Math.round(height * 0.785);
  const wallGrad = ctx.createLinearGradient(width, 0, 0, horizonY);
  wallGrad.addColorStop(0, palette.bgStart);
  wallGrad.addColorStop(0.55, palette.bgMid);
  wallGrad.addColorStop(1, palette.bgEnd);
  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, 0, width, horizonY);

  // 2. سطح أرضية الاستوديو المصقول الممتد نحو عدسة الكاميرا (Polished Perspective Studio Floor)
  const floorGrad = ctx.createLinearGradient(0, horizonY, 0, height);
  floorGrad.addColorStop(0, palette.bgEnd);
  floorGrad.addColorStop(0.32, palette.bgMid);
  floorGrad.addColorStop(1, palette.bgStart);
  ctx.fillStyle = floorGrad;
  ctx.fillRect(0, horizonY, width, height - horizonY);

  // إضاءة بؤرية خلفية للكاميرا (Camera Key Backlight) تفصل المجسّمات عن جدار السيكلوراما بعمق سينمائي
  const keySpot = ctx.createRadialGradient(
    width * 0.268,
    height * 0.46,
    height * 0.04,
    width * 0.268,
    height * 0.48,
    width * 0.30,
  );
  keySpot.addColorStop(0, isDarkTheme ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.75)");
  keySpot.addColorStop(0.6, isDarkTheme ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.22)");
  keySpot.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = keySpot;
  ctx.fillRect(0, 0, width * 0.62, height);

  const horizonLine = ctx.createLinearGradient(0, horizonY, width * 0.64, horizonY);
  horizonLine.addColorStop(0, isDarkTheme ? "rgba(255,255,255,0.13)" : "rgba(15,23,42,0.07)");
  horizonLine.addColorStop(0.68, isDarkTheme ? "rgba(255,255,255,0.04)" : "rgba(15,23,42,0.025)");
  horizonLine.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = horizonLine;
  ctx.fillRect(0, horizonY, width * 0.64, 1.2);

  // 3. الإضاءة السينمائية المختارة + الهالة المستخلصة من لون المنتج
  const dominantVibrant = productSprites.find((s) => s.vibrantRgb)?.vibrantRgb ?? null;
  drawLightingAndAtmosphere({
    ctx,
    width,
    height,
    palette,
    isDarkTheme,
    lightingMode,
    withLightRays: effects.has("LIGHT_RAYS"),
    heroCenterX: width * 0.268,
    heroCenterY: height * 0.48,
    vibrantRgb: dominantVibrant,
  });

  // 4. منصة العرض المعمارية الموحّدة (عند تفعيل خيار المنصة الموحّدة خارج وضع المنصات الفردية المتدرجة)
  const showPodium =
    effects.has("PODIUM_3D") &&
    compositionStyle !== "PODIUM_SHOWCASE" &&
    compositionStyle !== "CLEAN_GRID" &&
    productSprites.length > 0;

  const podiumRadiusFrac =
    productSprites.length >= 4
      ? 0.242
      : productSprites.length === 3
        ? 0.22
        : productSprites.length === 2
          ? 0.195
          : 0.16;

  if (showPodium) {
    draw3DPodiumStage({
      ctx,
      centerX: width * 0.27,
      topY: height * 0.79,
      radiusX: width * podiumRadiusFrac,
      radiusY: height * 0.048,
      podiumHeight: height * 0.105,
      palette,
      isDarkTheme,
    });
  }

  // 5. دمج المنتجات الأصلية (1 إلى 5 منتجات) مع الحفاظ التام 100% على ملامحها وكتابتها
  drawMergedProductEnsemble({
    ctx,
    sprites: productSprites,
    width,
    height,
    isMobile,
    isDarkTheme,
    compositionStyle,
    productScaleBoost: productScale,
    hasPodium: showPodium,
  });
}

function renderSingleBannerCanvas(opts: {
  width: number;
  height: number;
  isMobile: boolean;
  palette: BannerStudioPalette;
  isDarkTheme: boolean;
  visualMode: StudioVisualRenderMode;
  sceneImg: HTMLImageElement | null;
  lightingMode: BannerLightingMode;
  compositionStyle: BannerCompositionStyle;
  productScale: number;
  effects: Set<BannerCreativeEffect>;
  productSprites: CutoutProductSprite[];
  copy: BannerCopyVariant;
}): string {
  const canvas = document.createElement("canvas");
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const {
    width,
    height,
    isMobile,
    palette,
    isDarkTheme,
    visualMode,
    sceneImg,
    lightingMode,
    compositionStyle,
    productScale,
    effects,
    productSprites,
    copy,
  } = opts;

  if (sceneImg && (visualMode === "HYBRID_STAGE" || visualMode === "AI_FULL_SCENE")) {
    // 1. رسم خلفية المشهد الفوتوغرافي بدون تغبيش أو بهتان أبيض على منطقة المنتجات اليسرى
    drawCoverImage(ctx, sceneImg, width, height);

    // 2. تلاشي لوني متدرج ناعم (Smooth S-Curve Color-Graded Scrim) في النصف الأيمن فقط لقراءة النص
    const scrim = ctx.createLinearGradient(width, 0, width * 0.42, 0);
    scrim.addColorStop(0, palette.scrimStartRgba);
    scrim.addColorStop(0.52, palette.scrimMidRgba);
    scrim.addColorStop(0.84, isDarkTheme ? "rgba(15, 23, 42, 0.24)" : "rgba(255, 255, 255, 0.22)");
    scrim.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, width, height);

    // 3. ربط ضوئي متجانس فوق المشهد (Light-Wrap & Rays)
    const dominantVibrant = productSprites.find((s) => s.vibrantRgb)?.vibrantRgb ?? null;
    drawLightingAndAtmosphere({
      ctx,
      width,
      height,
      palette,
      isDarkTheme,
      lightingMode,
      withLightRays: effects.has("LIGHT_RAYS"),
      heroCenterX: width * 0.235,
      heroCenterY: height * 0.49,
      vibrantRgb: dominantVibrant,
    });

    // 4. في الوضع الهجين (HYBRID_STAGE — الافتراضي لحارس الأمانة): نركّب بكسلات المنتجات الأصلية 100% فوق المشهد
    if (visualMode === "HYBRID_STAGE" && productSprites.length > 0) {
      const showPodium =
        effects.has("PODIUM_3D") && compositionStyle !== "CLEAN_GRID";
      const hybridRadiusFrac =
        productSprites.length >= 4
          ? 0.242
          : productSprites.length === 3
            ? 0.22
            : productSprites.length === 2
              ? 0.195
              : 0.16;
      if (showPodium) {
        draw3DPodiumStage({
          ctx,
          centerX: width * 0.27,
          topY: height * 0.79,
          radiusX: width * hybridRadiusFrac,
          radiusY: height * 0.048,
          podiumHeight: height * 0.105,
          palette,
          isDarkTheme,
        });
      }
      drawMergedProductEnsemble({
        ctx,
        sprites: productSprites,
        width,
        height,
        isMobile,
        isDarkTheme,
        compositionStyle,
        productScaleBoost: productScale,
        hasPodium: showPodium,
      });
    }
  } else {
    drawAgencyStudioStage({
      ctx,
      width,
      height,
      isMobile,
      palette,
      isDarkTheme,
      lightingMode,
      compositionStyle,
      productScale,
      effects,
      productSprites,
    });
  }

  // ملمس فوتوغرافي حبيبي خفيف جداً يمنح التدرجات طابع استوديو تصوير حقيقي غير رقمي
  const grain = getStudioFilmGrainPattern(ctx);
  if (grain) {
    ctx.save();
    ctx.fillStyle = grain;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  const eyebrow = sanitizeBannerCopyText(copy.eyebrow, 28);
  const headline = sanitizeBannerCopyText(copy.headline, 52) || "متجر المكتبة العربية";
  const subtitle = sanitizeBannerCopyText(copy.subtitle, 95);
  const ctaLabel = sanitizeBannerCopyText(copy.ctaLabel, 24);
  const priceBadge = copy.priceBadge ? sanitizeBannerCopyText(copy.priceBadge, 32) : null;

  // ختم السعر/العرض الدائري البارز بجوار منطقة المنتجات (Agency Floating Promo Seal)
  const showPromoSeal = effects.has("PROMO_SEAL") && Boolean(priceBadge);
  if (showPromoSeal && priceBadge) {
    drawPromoSealBadge({
      ctx,
      x: Math.round(width * (isMobile ? 0.41 : 0.405)),
      y: Math.round(height * 0.24),
      radius: Math.round(height * (isMobile ? 0.105 : 0.112)),
      badgeText: priceBadge,
      palette,
      isDarkTheme,
    });
  }

  // منطقة الكتابة التحريرية في اليمين (RTL Editorial Safe Zone — بمقاس خط مكبّر وواضح جداً لشاشات الهواتف)
  const padRight = Math.round(width * (isMobile ? 0.044 : 0.052));
  const rightEdge = width - padRight;
  const copyMaxWidth = Math.round(width * (isMobile ? 0.475 : 0.435));

  ctx.direction = "rtl";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";

  const badgeFontPx = Math.round(height * (isMobile ? 0.044 : 0.036));
  let headlineFontPx = Math.round(height * (isMobile ? 0.092 : 0.082));
  let subtitleFontPx = Math.round(height * (isMobile ? 0.046 : 0.039));
  const ctaFontPx = Math.round(height * (isMobile ? 0.050 : 0.042));

  ctx.font = `800 ${headlineFontPx}px Cairo, system-ui, sans-serif`;
  let headlineLines = wrapRtlLines(ctx, headline, copyMaxWidth, 2);
  if (headlineLines.length > 1 && headline.length > 28) {
    headlineFontPx = Math.round(headlineFontPx * 0.87);
    ctx.font = `800 ${headlineFontPx}px Cairo, system-ui, sans-serif`;
    headlineLines = wrapRtlLines(ctx, headline, copyMaxWidth, 2);
  }

  ctx.font = `500 ${subtitleFontPx}px Cairo, system-ui, sans-serif`;
  let subtitleLines = subtitle ? wrapRtlLines(ctx, subtitle, copyMaxWidth, 3) : [];
  if (subtitleLines.length > 2) {
    subtitleFontPx = Math.round(subtitleFontPx * 0.86);
    ctx.font = `500 ${subtitleFontPx}px Cairo, system-ui, sans-serif`;
    subtitleLines = wrapRtlLines(ctx, subtitle, copyMaxWidth, 2);
  }

  const inlinePriceBadge = showPromoSeal ? null : priceBadge;
  const badgeH = eyebrow || inlinePriceBadge ? Math.round(badgeFontPx * 1.9) : 0;
  const headlineLineH = Math.round(headlineFontPx * 1.24);
  const subtitleLineH = Math.round(subtitleFontPx * 1.46);
  const ctaH = ctaLabel ? Math.round(ctaFontPx * 2.15) : 0;

  const gapBadge = badgeH ? Math.round(height * 0.030) : 0;
  const gapSub = subtitleLines.length ? Math.round(height * 0.026) : 0;
  const gapCta = ctaH ? Math.round(height * 0.048) : 0;

  const totalBlockH =
    badgeH +
    gapBadge +
    headlineLines.length * headlineLineH +
    gapSub +
    subtitleLines.length * subtitleLineH +
    gapCta +
    ctaH;

  let cursorY = Math.max(Math.round(height * 0.09), Math.round((height - totalBlockH) / 2));

  // بطاقة النص الزجاجية التحريرية الاختيارية (Frosted Editorial Glass Card)
  if (effects.has("GLASS_CARD")) {
    const padX = Math.round(width * 0.026);
    const padY = Math.round(height * 0.048);
    const cardW = copyMaxWidth + padX * 2;
    const cardH = Math.min(height - Math.round(height * 0.08), totalBlockH + padY * 2);
    const cardX = rightEdge - copyMaxWidth - padX;
    const cardY = Math.max(Math.round(height * 0.04), cursorY - padY);

    ctx.save();
    ctx.shadowColor = isDarkTheme ? "rgba(0, 0, 0, 0.38)" : "rgba(15, 23, 42, 0.08)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = isDarkTheme ? "rgba(15, 23, 42, 0.56)" : "rgba(255, 255, 255, 0.76)";
    drawRoundedRect(ctx, cardX, cardY, cardW, cardH, Math.round(height * 0.045));
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = isDarkTheme ? "rgba(255, 255, 255, 0.16)" : "rgba(255, 255, 255, 0.92)";
    ctx.stroke();
    ctx.restore();
  }

  // 1. سطر الشارة التحريرية (Eyebrow Overline + Price Tag)
  if (badgeH > 0) {
    let pillRight = rightEdge;
    if (eyebrow) {
      ctx.font = `700 ${badgeFontPx}px Cairo, system-ui, sans-serif`;
      const textW = ctx.measureText(eyebrow).width;
      const pillW = Math.round(textW + badgeFontPx * 1.7);
      ctx.fillStyle = palette.badgeBgRgba;
      drawRoundedRect(ctx, pillRight - pillW, cursorY, pillW, badgeH, badgeH / 2);
      ctx.fill();
      ctx.fillStyle = palette.badgeTextHex;
      ctx.fillText(eyebrow, pillRight - Math.round(badgeFontPx * 0.85), cursorY + Math.round(badgeFontPx * 0.36));
      pillRight -= pillW + Math.round(badgeFontPx * 0.5);
    }
    if (inlinePriceBadge) {
      ctx.font = `800 ${badgeFontPx}px Cairo, system-ui, sans-serif`;
      const pTextW = ctx.measureText(inlinePriceBadge).width;
      const pPillW = Math.round(pTextW + badgeFontPx * 1.65);
      if (pillRight - pPillW > width * 0.38) {
        ctx.fillStyle = palette.accentHex;
        drawRoundedRect(ctx, pillRight - pPillW, cursorY, pPillW, badgeH, badgeH / 2);
        ctx.fill();
        ctx.fillStyle = palette.accentTextHex;
        ctx.fillText(
          inlinePriceBadge,
          pillRight - Math.round(badgeFontPx * 0.82),
          cursorY + Math.round(badgeFontPx * 0.36),
        );
      }
    }
    cursorY += badgeH + gapBadge;
  }

  // 2. العنوان الرئيسي بطباعة حادة عالية التباين
  ctx.font = `800 ${headlineFontPx}px Cairo, system-ui, sans-serif`;
  ctx.fillStyle = palette.textPrimaryHex;
  for (const line of headlineLines) {
    ctx.fillText(line, rightEdge, cursorY);
    cursorY += headlineLineH;
  }

  // 3. سطر القيمة التسويقية
  if (subtitleLines.length > 0) {
    cursorY += gapSub;
    ctx.font = `500 ${subtitleFontPx}px Cairo, system-ui, sans-serif`;
    ctx.fillStyle = palette.textSecondaryHex;
    for (const line of subtitleLines) {
      ctx.fillText(line, rightEdge, cursorY);
      cursorY += subtitleLineH;
    }
  }

  // 4. كبسولة الدعوة للشراء (Agency Capsule CTA)
  if (ctaH > 0) {
    cursorY += gapCta;
    const labelWithArrow = `${ctaLabel}  ←`;
    ctx.font = `800 ${ctaFontPx}px Cairo, system-ui, sans-serif`;
    const btnTextW = ctx.measureText(labelWithArrow).width;
    const btnW = Math.round(btnTextW + ctaFontPx * 2.25);

    ctx.save();
    ctx.shadowColor = isDarkTheme ? "rgba(0, 0, 0, 0.38)" : "rgba(15, 23, 42, 0.16)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = palette.accentHex;
    drawRoundedRect(ctx, rightEdge - btnW, cursorY, btnW, ctaH, ctaH / 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = palette.accentTextHex;
    ctx.fillText(labelWithArrow, rightEdge - Math.round(ctaFontPx * 1.12), cursorY + Math.round(ctaFontPx * 0.48));
  }

  return canvas.toDataURL("image/webp", 0.91);
}

/** يولّد نسختَي سطح المكتب والهاتف مع تقرير فحص التباين وحارس أمانة البكسلات بضغطة واحدة. */
export async function composeStudioBannerPair(input: ComposeBannerInput): Promise<ComposedBannerPair> {
  await waitForFontsBounded();
  const preset = BANNER_STUDIO_PRESETS[input.presetId] ?? BANNER_STUDIO_PRESETS.CLEAN_MINIMAL_APPLE;
  const spec = BANNER_PLACEMENT_SPECS[input.placement];
  const visualMode: StudioVisualRenderMode =
    input.visualMode ?? (input.sceneDataUrl ? "HYBRID_STAGE" : "LOCAL_STUDIO");
  const lightingMode: BannerLightingMode = input.lightingMode ?? "STUDIO_SOFTBOX";
  const compositionStyle: BannerCompositionStyle = input.compositionStyle ?? "HERO_ENSEMBLE";
  const productScale = Math.max(0.88, Math.min(1.24, input.productScale ?? 1.04));
  const effects = new Set<BannerCreativeEffect>(input.effects ?? []);

  const [sceneImg, ...loadedProducts] = await Promise.all([
    input.sceneDataUrl ? loadHtmlImage(input.sceneDataUrl) : Promise.resolve(null),
    ...(input.productImageUrls ?? []).slice(0, 5).map((url) => loadHtmlImage(url)),
  ]);
  const productSprites = loadedProducts
    .filter((img): img is HTMLImageElement => img != null)
    .map((img) => extractCutoutProductSprite(img));

  const desktopDataUrl = renderSingleBannerCanvas({
    width: spec.desktopWidth,
    height: spec.desktopHeight,
    isMobile: false,
    palette: preset.palette,
    isDarkTheme: preset.isDarkTheme,
    visualMode,
    sceneImg,
    lightingMode,
    compositionStyle,
    productScale,
    effects,
    productSprites,
    copy: input.copy,
  });

  const mobileDataUrl = renderSingleBannerCanvas({
    width: spec.mobileWidth,
    height: spec.mobileHeight,
    isMobile: true,
    palette: preset.palette,
    isDarkTheme: preset.isDarkTheme,
    visualMode,
    sceneImg,
    lightingMode,
    compositionStyle,
    productScale,
    effects,
    productSprites,
    copy: input.copy,
  });

  const contrastRatio = computeHexContrastRatio(preset.palette.bgStart, preset.palette.textPrimaryHex);
  const pixelFidelityGuaranteed = visualMode !== "AI_FULL_SCENE" || !sceneImg;

  return {
    desktopDataUrl,
    mobileDataUrl,
    quality: {
      contrastRatio,
      passesContrast: contrastRatio >= 4.5,
      pixelFidelityGuaranteed,
      mergedProductCount: productSprites.length,
      desktopBytes: estimateDataUrlBytes(desktopDataUrl),
      mobileBytes: estimateDataUrlBytes(mobileDataUrl),
      desktopDimensions: { width: spec.desktopWidth, height: spec.desktopHeight },
      mobileDimensions: { width: spec.mobileWidth, height: spec.mobileHeight },
    },
  };
}
