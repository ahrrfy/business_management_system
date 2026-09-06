/**
 * محرك تحسين ومعالجة صور الاستوديو الاحترافي (Commercial Studio Enhancer)
 *
 * يوفر معالجة بصرية فائقة الدقة لبكسلات المنتج دون المساس بالهوية الأصلية أو تشويه النصوص:
 * 1. autoWhiteBalance: إزالة الصبغة الصفراء/الخضراء الناتجة عن إضاءة المصابيح الداخلية وإعادة البياض النقي.
 * 2. enhanceVibranceAndContrast: إبراز تشبيع الألوان وحيويتها وتوسيع التباين (S-Curve) لإزالة البهتان.
 * 3. applyUnsharpMask: فلتر حِدة يبرز نصوص الماركات، الخياطة، الأزرار، والملامس الدقيقة.
 * 4. findProductBoundingBox: اكتشاف الصندوق المحيط الفعلي للمنتج لتوسيته بدقة في منتصف الكادر.
 * 5. renderMultiTierStudioShadow: توليد نظام الظل الثلاثي (تماس أرضي داكن + ظل ناعم منتشر + انعكاس خفيف اختياري).
 */

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  hasContent: boolean;
}

export type StudioPreset = "PURE_WHITE" | "LUXURY_MIRROR" | "VIBRANT_COMMERCIAL";

export interface StudioEnhanceOptions {
  preset?: StudioPreset;
  whiteBalance?: boolean;
  vibrance?: number;
  contrast?: number;
  sharpness?: number;
  shadowIntensity?: number;
}

/**
 * يكتشف الصندوق المحيط الحقيقي للمنتج استناداً إلى قناة الشفافية (Alpha channel).
 * يتجاهل البكسلات الهامشية أو الغبار شبه الشفاف (alpha <= threshold).
 */
export function findProductBoundingBox(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold = 18,
): BoundingBox {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[rowOffset + x] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return { minX: 0, minY: 0, maxX: width, maxY: height, width, height, hasContent: false };
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    hasContent: true,
  };
}

/**
 * تصحيح توازن البياض التلقائي (Auto White Balance - Gray World with Damped Gains)
 * يزيل الاصفرار الشائع في تصوير الهواتف والمحلات ويعيد للأبيض والرمادي نقاءهما.
 */
export function autoWhiteBalance(imageData: ImageData): void {
  const data = imageData.data;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let count = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 64) continue; // تخطّ الشفاف/شبه الشفاف
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // تخطّ الظلال الشديدة والسطوع المحروق لحساب دقيق للمتوسط
    if (lum > 25 && lum < 235) {
      totalR += r;
      totalG += g;
      totalB += b;
      count++;
    }
  }

  if (count < 80) return;

  const avgR = totalR / count;
  const avgG = totalG / count;
  const avgB = totalB / count;
  const avgGray = (avgR + avgG + avgB) / 3;

  // معاملات كبح لمنع الإفراط في التصحيح
  const maxGain = 1.32;
  const minGain = 0.78;
  const gainR = Math.max(minGain, Math.min(maxGain, 1 + ((avgGray - avgR) / avgGray) * 0.65));
  const gainG = Math.max(minGain, Math.min(maxGain, 1 + ((avgGray - avgG) / avgGray) * 0.65));
  const gainB = Math.max(minGain, Math.min(maxGain, 1 + ((avgGray - avgB) / avgGray) * 0.65));

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = Math.min(255, Math.max(0, Math.round(data[i] * gainR)));
    data[i + 1] = Math.min(255, Math.max(0, Math.round(data[i + 1] * gainG)));
    data[i + 2] = Math.min(255, Math.max(0, Math.round(data[i + 2] * gainB)));
  }
}

/**
 * تعزيز الحيوية والتباين والعمق اللوني (Commercial Vibrance & S-Curve Contrast)
 * يزيل المظهر الباهت والرمادي دون حرق الإضاءة أو تشويه درجات الألوان الطبيعية.
 */
export function enhanceVibranceAndContrast(
  imageData: ImageData,
  options: { vibrance?: number; contrast?: number; shadowLift?: number } = {},
): void {
  const { vibrance = 0.24, contrast = 0.14, shadowLift = 0.08 } = options;
  const data = imageData.data;

  // منحنى تباين سلس (S-Curve)
  const factor = (259 * (contrast * 255 + 255)) / (255 * (259 - contrast * 255));

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;

    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    // ١. تطبيق التباين
    r = Math.min(255, Math.max(0, factor * (r - 128) + 128));
    g = Math.min(255, Math.max(0, factor * (g - 128) + 128));
    b = Math.min(255, Math.max(0, factor * (b - 128) + 128));

    // ٢. رفع خفيف لظلال المنتجات الداكنة (مثل الساعات وسماعات الأذن السوداء)
    if (shadowLift > 0) {
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      if (lum < 0.45) {
        const lift = (1 - lum / 0.45) * shadowLift * 28;
        r = Math.min(255, r + lift);
        g = Math.min(255, g + lift);
        b = Math.min(255, b + lift);
      }
    }

    // ٣. تعزيز الحيوية الذكي (Vibrance: يزيد الألوان الباهتة أكثر من المشبعة أصلاً)
    if (vibrance > 0) {
      const maxVal = Math.max(r, g, b);
      const minVal = Math.min(r, g, b);
      const sat = maxVal === 0 ? 0 : (maxVal - minVal) / maxVal;
      const amount = (1 - sat) * vibrance;
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = Math.min(255, Math.max(0, r + (r - gray) * amount));
      g = Math.min(255, Math.max(0, g + (g - gray) * amount));
      b = Math.min(255, Math.max(0, b + (b - gray) * amount));
    }

    data[i] = Math.round(r);
    data[i + 1] = Math.round(g);
    data[i + 2] = Math.round(b);
  }
}

/**
 * فلتر الحِدة التلقائي (Unsharp Mask Sharpening)
 * يبرز نصوص الماركات، الخياطة، الأزرار، والملامس دون إحداث تشويش.
 */
export function applyUnsharpMask(
  imageData: ImageData,
  width: number,
  height: number,
  amount = 0.32,
): void {
  if (amount <= 0 || width < 3 || height < 3) return;
  const src = new Uint8ClampedArray(imageData.data);
  const dst = imageData.data;

  for (let y = 1; y < height - 1; y++) {
    const rowOffset = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = (rowOffset + x) * 4;
      if (src[idx + 3] < 30) continue; // تخطّ الشفاف

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const nOffset = (rowOffset + dy * width + x) * 4;
        sumR += src[nOffset - 4] + src[nOffset] + src[nOffset + 4];
        sumG += src[nOffset - 3] + src[nOffset + 1] + src[nOffset + 5];
        sumB += src[nOffset - 2] + src[nOffset + 2] + src[nOffset + 6];
      }
      const blurR = sumR / 9;
      const blurG = sumG / 9;
      const blurB = sumB / 9;

      const diffR = src[idx] - blurR;
      const diffG = src[idx + 1] - blurG;
      const diffB = src[idx + 2] - blurB;

      dst[idx] = Math.min(255, Math.max(0, Math.round(src[idx] + diffR * amount)));
      dst[idx + 1] = Math.min(255, Math.max(0, Math.round(src[idx + 1] + diffG * amount)));
      dst[idx + 2] = Math.min(255, Math.max(0, Math.round(src[idx + 2] + diffB * amount)));
    }
  }
}

/**
 * يرسم نظام الظلال الاحترافي متعدد الطبقات:
 * ١. ظل التماس الأرضي (Contact Shadow): خط داكن رفيع يربط قاعدة المنتج بالأرضية ليمنعه من الطوفان.
 * ٢. الظل الناعم المنتشر (Diffuse Softbox Shadow): انتشار ناعم متلاشٍ يمنح بعداً واقعياً وإضاءة استوديو متكاملة.
 * ٣. انعكاس أرضي اختياري (Ground Reflection): للمنتجات الفخمة كالساعات والسماعات.
 */
export function renderMultiTierStudioShadow(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  canvasSize: number,
  options: {
    preset?: StudioPreset;
    intensity?: number;
    withReflection?: boolean;
    sourceElement?: CanvasImageSource;
    cropRect?: { sx: number; sy: number; sw: number; sh: number };
  } = {},
): void {
  const {
    preset = "PURE_WHITE",
    intensity = 1.0,
    withReflection = preset === "LUXURY_MIRROR",
    sourceElement,
    cropRect,
  } = options;

  const bottomY = rect.y + rect.height;
  const centerX = rect.x + rect.width / 2;

  // أ. انعكاس أرضي ناعم (لنمط الفخامة والساعات)
  if (withReflection && sourceElement && cropRect) {
    ctx.save();
    const reflectH = Math.min(rect.height * 0.22, canvasSize * 0.12);
    const grad = ctx.createLinearGradient(0, bottomY, 0, bottomY + reflectH);
    grad.addColorStop(0, "rgba(255, 255, 255, 0.12)");
    grad.addColorStop(0.35, "rgba(255, 255, 255, 0.05)");
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");

    ctx.save();
    // قلب عمودي تحت المنتج مباشرة
    ctx.translate(0, bottomY * 2);
    ctx.scale(1, -1);
    ctx.globalAlpha = 0.16 * intensity;
    ctx.drawImage(
      sourceElement,
      cropRect.sx,
      cropRect.sy + cropRect.sh - cropRect.sh * 0.25,
      cropRect.sw,
      cropRect.sh * 0.25,
      rect.x,
      bottomY - rect.height * 0.25,
      rect.width,
      rect.height * 0.25,
    );
    ctx.restore();

    // قناع تلاشي فوق الانعكاس
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = grad;
    ctx.fillRect(rect.x - 20, bottomY, rect.width + 40, reflectH + 10);
    ctx.restore();
  }

  // ب. الظل الناعم المنتشر (Diffuse Softbox Shadow)
  ctx.save();
  const diffuseRx = rect.width * 0.42;
  const diffuseRy = Math.max(8, rect.width * 0.06);
  const diffuseCy = bottomY + canvasSize * 0.008 + diffuseRy * 0.5;

  ctx.filter = `blur(${Math.max(4, Math.round(canvasSize * 0.022))}px)`;
  ctx.globalAlpha = Math.min(0.35, 0.16 * intensity);
  ctx.fillStyle = "#1e2430"; // لون ظل ناعم غني ليس رمادياً ميتاً
  ctx.beginPath();
  ctx.ellipse(centerX, diffuseCy, diffuseRx, diffuseRy, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ج. ظل التماس الأرضي الداكن (Contact Occlusion Shadow)
  ctx.save();
  const contactRx = rect.width * 0.36;
  const contactRy = Math.max(3, rect.width * 0.022);
  const contactCy = bottomY + Math.max(1, contactRy * 0.3);

  ctx.filter = `blur(${Math.max(2, Math.round(canvasSize * 0.006))}px)`;
  ctx.globalAlpha = Math.min(0.65, 0.42 * intensity);
  ctx.fillStyle = "#0a0c10"; // تماس داكن قوي يثبّت المنتج بالأرض
  ctx.beginPath();
  ctx.ellipse(centerX, contactCy, contactRx, contactRy, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
