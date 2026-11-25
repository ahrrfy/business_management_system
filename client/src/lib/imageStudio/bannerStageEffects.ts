/**
 * bannerStageEffects — محرك العزل البصري النظيف (Studio Matte v3) والإخراج الهادئ بنمط Apple.
 *
 * يعالج جذرياً كافة مشاكل تفريغ خلفيات المنتجات الحقيقية:
 * 1. فيضان محكوم بالتدرج المكاني (Gradient-Gated BFS): يزيل الخلفية البيضاء وظل الأرضية القديم بنعومة
 *    دون التهام حواف المنتجات الفاتحة.
 * 2. حارس القلب الأبيض للعبوات (Core-Cavity Blister Guard): يكتشف العبوات والبطاقات نصف البيضاء
 *    (مثل بطاقات الأدوات الهندسية والملازم البيضاء) فيحفظ كامل بطاقتها داخل إطار Apple ناعم بلا أي تآكل.
 * 3. فتح ثقوب المقابض المغلقة (Handle-Aperture Knockout): يفرّغ البياض المحبوس داخل مقابض الحقائب
 *    وفتحات التعليق بشرط عدم وجود أي حبر/كتابة داخلها صوناً للنصوص 100%.
 * 4. تطهير الهالة البيضاء (Color Decontamination / Unpremultiply): يزيل الرمادي/الأبيض المتبقي في بكسلات
 *    الحواف المضادة للتعرج (Anti-Aliasing) لتندمج الحواف بنقاء تام على الخلفيات الفاتحة والداكنة معاً.
 */

import type {
  BannerCompositionStyle,
  BannerLightingMode,
  BannerStudioPalette,
} from "@shared/imageStudio/bannerStudioContract";

export interface CutoutProductSprite {
  source: CanvasImageSource;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  isCutout: boolean;
  vibrantRgb: [number, number, number] | null;
}

const MAX_CUTOUT_SPRITE_CACHE = 48;
const cutoutSpriteCache = new Map<string, CutoutProductSprite>();

function cacheCutoutSprite(key: string | null, sprite: CutoutProductSprite): CutoutProductSprite {
  if (!key) return sprite;
  if (cutoutSpriteCache.size >= MAX_CUTOUT_SPRITE_CACHE) {
    const oldest = cutoutSpriteCache.keys().next().value;
    if (oldest) cutoutSpriteCache.delete(oldest);
  }
  cutoutSpriteCache.set(key, sprite);
  return sprite;
}

/**
 * يستخرج مجسّم المنتج المفرّغ بدقة استوديو Apple (Studio Matte v3) مع تطهير الحواف وحراسة العبوات البيضاء
 * وذاكرة تخزين مؤقت فورية (LRU Sprite Cache) تجعل تعديل النصوص والإضاءة والمنظور لحظياً (< 8ms).
 */
export function extractCutoutProductSprite(img: HTMLImageElement): CutoutProductSprite {
  const cacheKey = (img.currentSrc || img.src || "").trim() || null;
  if (cacheKey) {
    const cached = cutoutSpriteCache.get(cacheKey);
    if (cached) return cached;
  }

  const nw = img.naturalWidth || 1;
  const nh = img.naturalHeight || 1;
  const fallback: CutoutProductSprite = {
    source: img,
    sx: 0,
    sy: 0,
    sw: nw,
    sh: nh,
    isCutout: false,
    vibrantRgb: null,
  };
  if (typeof document === "undefined" || nw < 24 || nh < 24) return fallback;

  try {
    const maxDim = 600;
    const scale = Math.min(1, maxDim / Math.max(nw, nh));
    const w = Math.max(24, Math.round(nw * scale));
    const h = Math.max(24, Math.round(nh * scale));
    const n = w * h;

    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const octx = off.getContext("2d", { willReadFrequently: true });
    if (!octx) return fallback;
    octx.drawImage(img, 0, 0, w, h);
    const imageData = octx.getImageData(0, 0, w, h);
    const { data } = imageData;

    const luma = new Float32Array(n);
    const chroma = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      const idx = i * 4;
      const r = data[idx]!;
      const g = data[idx + 1]!;
      const b = data[idx + 2]!;
      luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
    }

    // 1. معايرة بياض خلفية الاستوديو من الحدود الأربعة
    let borderSamples = 0;
    let lightBorderSamples = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;

    const sampleBorder = (x: number, y: number) => {
      const p = y * w + x;
      borderSamples += 1;
      if (data[p * 4 + 3]! < 25 || (luma[p]! > 224 && chroma[p]! < 24)) {
        lightBorderSamples += 1;
        sumR += data[p * 4]!;
        sumG += data[p * 4 + 1]!;
        sumB += data[p * 4 + 2]!;
      }
    };

    for (let x = 0; x < w; x += 2) {
      sampleBorder(x, 0);
      sampleBorder(x, h - 1);
    }
    for (let y = 0; y < h; y += 2) {
      sampleBorder(0, y);
      sampleBorder(w - 1, y);
    }

    if (borderSamples === 0 || lightBorderSamples / borderSamples < 0.65) {
      return fallback;
    }

    const refR = sumR / lightBorderSamples;
    const refG = sumG / lightBorderSamples;
    const refB = sumB / lightBorderSamples;

    const distBg = new Float32Array(n);
    let rVib = 0;
    let gVib = 0;
    let bVib = 0;
    let vibCount = 0;

    for (let i = 0; i < n; i += 1) {
      const idx = i * 4;
      const r = data[idx]!;
      const g = data[idx + 1]!;
      const b = data[idx + 2]!;
      const dr = r - refR;
      const dg = g - refG;
      const db = b - refB;
      distBg[i] = Math.sqrt(dr * dr + dg * dg + db * db);
      if (chroma[i]! > 38 && luma[i]! > 42 && luma[i]! < 238) {
        rVib += r;
        gVib += g;
        bVib += b;
        vibCount += 1;
      }
    }

    const vibrantRgb: [number, number, number] | null =
      vibCount > 30
        ? [Math.round(rVib / vibCount), Math.round(gVib / vibCount), Math.round(bVib / vibCount)]
        : null;

    // 2. حساب خريطة التدرج الحدي (Luminance + Chroma Edge Gradient) لحماية حواف العلب والأقلام الفاتحة
    const grad = new Float32Array(n);
    for (let y = 1; y < h - 1; y += 1) {
      const row = y * w;
      for (let x = 1; x < w - 1; x += 1) {
        const p = row + x;
        const gx = Math.abs(luma[p + 1]! - luma[p - 1]!) * 0.5;
        const gy = Math.abs(luma[p + w]! - luma[p - w]!) * 0.5;
        const cgx = Math.abs(chroma[p + 1]! - chroma[p - 1]!) * 0.5;
        const cgy = Math.abs(chroma[p + w]! - chroma[p - w]!) * 0.5;
        grad[p] = Math.hypot(gx, gy) + Math.hypot(cgx, cgy) * 1.3;
      }
    }

    const isWalkableBg = (p: number): boolean => {
      if (data[p * 4 + 3]! < 25) return true;
      if (distBg[p]! <= 22 && chroma[p]! <= 16 && grad[p]! <= 26) return true;
      // إزالة ظل الأرضية الرمادي الناعم المدمج في صور الاستوديو دون المساس بحواف المجسم الحادة
      if (chroma[p]! <= 13 && luma[p]! >= 165 && grad[p]! <= 14.5) return true;
      return false;
    };

    const bg = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;

    const trySeed = (x: number, y: number) => {
      const p = y * w + x;
      if (!bg[p] && isWalkableBg(p)) {
        bg[p] = 1;
        queue[tail++] = p;
      }
    };

    for (let x = 0; x < w; x += 1) {
      trySeed(x, 0);
      trySeed(x, h - 1);
    }
    for (let y = 0; y < h; y += 1) {
      trySeed(0, y);
      trySeed(w - 1, y);
    }

    while (head < tail) {
      const p = queue[head++]!;
      const px = p % w;
      const py = (p - px) / w;
      if (px > 0 && !bg[p - 1] && isWalkableBg(p - 1)) {
        bg[p - 1] = 1;
        queue[tail++] = p - 1;
      }
      if (px + 1 < w && !bg[p + 1] && isWalkableBg(p + 1)) {
        bg[p + 1] = 1;
        queue[tail++] = p + 1;
      }
      if (py > 0 && !bg[p - w] && isWalkableBg(p - w)) {
        bg[p - w] = 1;
        queue[tail++] = p - w;
      }
      if (py + 1 < h && !bg[p + w] && isWalkableBg(p + w)) {
        bg[p + w] = 1;
        queue[tail++] = p + w;
      }
    }

    // تحديد الصندوق المحيط الفعلي للمنتج
    let fgMinX = w;
    let fgMaxX = 0;
    let fgMinY = h;
    let fgMaxY = 0;
    let fgCount = 0;
    for (let i = 0; i < n; i += 1) {
      if (!bg[i]) {
        fgCount += 1;
        const x = i % w;
        const y = (i - x) / w;
        if (x < fgMinX) fgMinX = x;
        if (x > fgMaxX) fgMaxX = x;
        if (y < fgMinY) fgMinY = y;
        if (y > fgMaxY) fgMaxY = y;
      }
    }

    const cropTrimmedCard = (): CutoutProductSprite => {
      const pad = 4;
      const tx0 = Math.max(0, fgMinX - pad);
      const ty0 = Math.max(0, fgMinY - pad);
      const tx1 = Math.min(w, fgMaxX + 1 + pad);
      const ty1 = Math.min(h, fgMaxY + 1 + pad);
      return {
        source: img,
        sx: Math.round((tx0 / w) * nw),
        sy: Math.round((ty0 / h) * nh),
        sw: Math.max(16, Math.round(((tx1 - tx0) / w) * nw)),
        sh: Math.max(16, Math.round(((ty1 - ty0) / h) * nh)),
        isCutout: false,
        vibrantRgb,
      };
    };

    if (fgCount / n < 0.015 || fgCount / n > 0.92 || fgMaxX <= fgMinX + 8 || fgMaxY <= fgMinY + 8) {
      return { ...fallback, vibrantRgb };
    }

    // 3. حارس القلب الأبيض للعبوات المستطيلة (Rectangular Blister-Card & Book Core Guard):
    // يميّز بين البطاقات المستطيلة نصف البيضاء (مثل Circle Cutter والملازم ذات الإطار المستقيم) وبين
    // الصور التي تضم عدة قطع دائرية منفصلة بينها فراغ أبيض (مثل مجموعة الأختام الملونة)، فلا يحبس القطع المنفصلة في مربع أبيض!
    const bw = fgMaxX - fgMinX + 1;
    const bh = fgMaxY - fgMinY + 1;
    const cx0 = fgMinX + Math.floor(bw * 0.14);
    const cx1 = fgMaxX - Math.floor(bw * 0.14);
    const cy0 = fgMinY + Math.floor(bh * 0.24);
    const cy1 = fgMaxY - Math.floor(bh * 0.1);
    if (cx1 > cx0 + 10 && cy1 > cy0 + 10) {
      const coreTotal = (cx1 - cx0) * (cy1 - cy0);
      let coreBg = 0;
      for (let yy = cy0; yy < cy1; yy += 1) {
        const row = yy * w;
        for (let xx = cx0; xx < cx1; xx += 1) {
          if (bg[row + xx]) coreBg += 1;
        }
      }
      if (coreBg / coreTotal > 0.12) {
        // فحص استقامة حدود البطاقة (هل تملأ الحواف المستقيمة 38%+ من ضلعين على الأقل كبطاقة/غلاف؟)
        let topEdgeFg = 0;
        let botEdgeFg = 0;
        for (let xx = fgMinX; xx <= fgMaxX; xx += 1) {
          if (!bg[fgMinY * w + xx] || !bg[Math.min(h - 1, fgMinY + 2) * w + xx]) topEdgeFg += 1;
          if (!bg[fgMaxY * w + xx] || !bg[Math.max(0, fgMaxY - 2) * w + xx]) botEdgeFg += 1;
        }
        let leftEdgeFg = 0;
        let rightEdgeFg = 0;
        for (let yy = fgMinY; yy <= fgMaxY; yy += 1) {
          if (!bg[yy * w + fgMinX] || !bg[yy * w + Math.min(w - 1, fgMinX + 2)]) leftEdgeFg += 1;
          if (!bg[yy * w + fgMaxX] || !bg[yy * w + Math.max(0, fgMaxX - 2)]) rightEdgeFg += 1;
        }
        const straightSides = [
          topEdgeFg / bw >= 0.38,
          botEdgeFg / bw >= 0.38,
          leftEdgeFg / bh >= 0.38,
          rightEdgeFg / bh >= 0.38,
        ].filter(Boolean).length;

        if (straightSides >= 2) {
          return cacheCutoutSprite(cacheKey, cropTrimmedCard());
        }
      }
    }

    // 4. تفريغ فتحات المقابض والتعليق المغلقة (Handle-Aperture Knockout) بشرط خلوّها التام من أي كتابة/حبر داخلي
    const compSeen = new Uint8Array(n);
    const minHole = Math.max(70, Math.floor(n * 0.00035));
    const maxHole = Math.floor(n * 0.06);
    const isPureHolePx = (p: number) =>
      !bg[p] && distBg[p]! <= 20 && chroma[p]! <= 12 && luma[p]! >= 240;

    for (let p0 = 0; p0 < n; p0 += 1) {
      if (!isPureHolePx(p0) || compSeen[p0]) continue;
      const pts: number[] = [];
      let hHead = 0;
      pts.push(p0);
      compSeen[p0] = 1;
      let minX = w;
      let maxX = 0;
      let minY = h;
      let maxY = 0;
      let borderLumaSum = 0;
      let borderCnt = 0;

      while (hHead < pts.length) {
        const cp = pts[hHead++]!;
        const cx = cp % w;
        const cy = (cp - cx) / w;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const nbs = [
          cx > 0 ? cp - 1 : -1,
          cx + 1 < w ? cp + 1 : -1,
          cy > 0 ? cp - w : -1,
          cy + 1 < h ? cp + w : -1,
        ];
        for (const np of nbs) {
          if (np < 0) continue;
          if (isPureHolePx(np)) {
            if (!compSeen[np]) {
              compSeen[np] = 1;
              pts.push(np);
            }
          } else {
            borderLumaSum += luma[np]!;
            borderCnt += 1;
          }
        }
      }

      if (pts.length >= minHole && pts.length <= maxHole && borderCnt > 0 && borderLumaSum / borderCnt < 215) {
        const x0 = Math.max(0, minX - 1);
        const y0 = Math.max(0, minY - 1);
        const x1 = Math.min(w - 1, maxX + 1);
        const y1 = Math.min(h - 1, maxY + 1);
        const sw = x1 - x0 + 1;
        const sh = y1 - y0 + 1;
        const subN = sw * sh;
        const holeSet = new Uint8Array(subN);
        for (const hp of pts) {
          const hx = hp % w;
          const hy = (hp - hx) / w;
          holeSet[(hy - y0) * sw + (hx - x0)] = 1;
        }
        const ext = new Uint8Array(subN);
        const eq = new Int32Array(subN);
        let eHead = 0;
        let eTail = 0;
        const pushExt = (sx: number, sy: number) => {
          const si = sy * sw + sx;
          if (!holeSet[si] && !ext[si]) {
            ext[si] = 1;
            eq[eTail++] = si;
          }
        };
        for (let bx = 0; bx < sw; bx += 1) {
          pushExt(bx, 0);
          pushExt(bx, sh - 1);
        }
        for (let by = 0; by < sh; by += 1) {
          pushExt(0, by);
          pushExt(sw - 1, by);
        }
        while (eHead < eTail) {
          const ei = eq[eHead++]!;
          const ex = ei % sw;
          const ey = (ei - ex) / sw;
          if (ex > 0) pushExt(ex - 1, ey);
          if (ex + 1 < sw) pushExt(ex + 1, ey);
          if (ey > 0) pushExt(ex, ey - 1);
          if (ey + 1 < sh) pushExt(ex, ey + 1);
        }
        let enclosedInk = 0;
        for (let si = 0; si < subN; si += 1) {
          if (!holeSet[si] && !ext[si]) {
            enclosedInk += 1;
            break;
          }
        }
        if (enclosedInk === 0) {
          for (const hp of pts) bg[hp] = 1;
        }
      }
    }

    // 5. حساب مسافة الحافة ونشر لون جسم المنتج الحقيقي لتطهير الهالة البيضاء (Color Decontamination)
    const distToBg = new Uint8Array(n);
    distToBg.fill(99);
    head = 0;
    tail = 0;
    for (let i = 0; i < n; i += 1) {
      if (bg[i]) {
        distToBg[i] = 0;
        queue[tail++] = i;
      }
    }
    while (head < tail) {
      const cp = queue[head++]!;
      const nd = distToBg[cp]! + 1;
      if (nd > 5) continue;
      const cx = cp % w;
      const cy = (cp - cx) / w;
      if (cx > 0 && distToBg[cp - 1]! > nd) {
        distToBg[cp - 1] = nd;
        queue[tail++] = cp - 1;
      }
      if (cx + 1 < w && distToBg[cp + 1]! > nd) {
        distToBg[cp + 1] = nd;
        queue[tail++] = cp + 1;
      }
      if (cy > 0 && distToBg[cp - w]! > nd) {
        distToBg[cp - w] = nd;
        queue[tail++] = cp - w;
      }
      if (cy + 1 < h && distToBg[cp + w]! > nd) {
        distToBg[cp + w] = nd;
        queue[tail++] = cp + w;
      }
    }

    const fgR = new Uint8Array(n);
    const fgG = new Uint8Array(n);
    const fgB = new Uint8Array(n);
    const seenInt = new Uint8Array(n);
    head = 0;
    tail = 0;
    for (let i = 0; i < n; i += 1) {
      fgR[i] = data[i * 4]!;
      fgG[i] = data[i * 4 + 1]!;
      fgB[i] = data[i * 4 + 2]!;
      if (distToBg[i]! >= 4) {
        seenInt[i] = 1;
        queue[tail++] = i;
      }
    }
    while (head < tail) {
      const cp = queue[head++]!;
      const cx = cp % w;
      const cy = (cp - cx) / w;
      const nbs = [
        cx > 0 ? cp - 1 : -1,
        cx + 1 < w ? cp + 1 : -1,
        cy > 0 ? cp - w : -1,
        cy + 1 < h ? cp + w : -1,
      ];
      for (const np of nbs) {
        if (np >= 0 && !seenInt[np] && distToBg[np]! >= 1) {
          seenInt[np] = 1;
          fgR[np] = fgR[cp]!;
          fgG[np] = fgG[cp]!;
          fgB[np] = fgB[cp]!;
          queue[tail++] = np;
        }
      }
    }

    // حارس المنتجات البيضاء بالكامل: إن كان محيط المنتج أبيض ضعيف التباين مع الخلفية، اعرضه ببطاقة Apple نقية
    let perimCnt = 0;
    let lowContrastCnt = 0;
    for (let i = 0; i < n; i += 1) {
      if (distToBg[i] === 1) {
        perimCnt += 1;
        const dr = fgR[i]! - refR;
        const dg = fgG[i]! - refG;
        const db = fgB[i]! - refB;
        if (Math.sqrt(dr * dr + dg * dg + db * db) < 36) lowContrastCnt += 1;
      }
    }
    if (perimCnt > 0 && lowContrastCnt / perimCnt > 0.25) {
      return cacheCutoutSprite(cacheKey, cropTrimmedCard());
    }

    for (let i = 0; i < n; i += 1) {
      const idx = i * 4;
      if (bg[i]) {
        data[idx + 3] = 0;
        continue;
      }
      const dStep = distToBg[i]!;
      if (dStep >= 1 && dStep <= 3) {
        const dr = fgR[i]! - refR;
        const dg = fgG[i]! - refG;
        const db = fgB[i]! - refB;
        const ic = Math.sqrt(dr * dr + dg * dg + db * db);
        if (ic >= 40) {
          let rawA = Math.min(1, Math.max(0, (distBg[i]! - 16) / Math.max(24, ic * 0.88)));
          if (dStep === 3) {
            rawA = Math.max(rawA, 0.85);
          } else if (dStep === 1) {
            rawA *= 0.65;
            if (rawA < 0.28) rawA = 0;
          }
          data[idx + 3] = Math.round(rawA * 255);
          if (rawA > 0.02) {
            const invA = Math.max(0.42, rawA);
            const ur = (data[idx]! - (1 - rawA) * refR) / invA;
            const ug = (data[idx + 1]! - (1 - rawA) * refG) / invA;
            const ub = (data[idx + 2]! - (1 - rawA) * refB) / invA;
            const blend = rawA < 0.72 ? 0.72 : 0.4;
            data[idx] = Math.max(0, Math.min(255, Math.round(ur * (1 - blend) + fgR[i]! * blend)));
            data[idx + 1] = Math.max(0, Math.min(255, Math.round(ug * (1 - blend) + fgG[i]! * blend)));
            data[idx + 2] = Math.max(0, Math.min(255, Math.round(ub * (1 - blend) + fgB[i]! * blend)));
          }
        } else if (dStep === 1) {
          data[idx + 3] = Math.min(data[idx + 3]!, 140);
        }
      }
    }

    octx.putImageData(imageData, 0, 0);
    const pad = 2;
    const tx0 = Math.max(0, fgMinX - pad);
    const ty0 = Math.max(0, fgMinY - pad);
    const tx1 = Math.min(w, fgMaxX + 1 + pad);
    const ty1 = Math.min(h, fgMaxY + 1 + pad);
    return cacheCutoutSprite(cacheKey, {
      source: off,
      sx: tx0,
      sy: ty0,
      sw: Math.max(16, tx1 - tx0),
      sh: Math.max(16, ty1 - ty0),
      isCutout: true,
      vibrantRgb,
    });
  } catch {
    return fallback;
  }
}

/** يرسم إضاءة استوديو Apple الهادئة (إضاءة ناعمة منتشرة بلا أشعة صاخبة أو تشويش بصري). */
export function drawLightingAndAtmosphere(opts: {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  palette: BannerStudioPalette;
  isDarkTheme: boolean;
  lightingMode: BannerLightingMode;
  withLightRays: boolean;
  heroCenterX: number;
  heroCenterY: number;
  vibrantRgb: [number, number, number] | null;
}) {
  const {
    ctx,
    width,
    height,
    palette,
    isDarkTheme,
    lightingMode,
    withLightRays,
    heroCenterX,
    heroCenterY,
    vibrantRgb,
  } = opts;

  const subtleTint = vibrantRgb
    ? `rgba(${vibrantRgb[0]}, ${vibrantRgb[1]}, ${vibrantRgb[2]}, ${isDarkTheme ? 0.18 : 0.08})`
    : palette.glowRgba;

  // 1. إضاءة استوديو خلفية ناعمة جداً بأسلوب Apple Store
  ctx.save();
  const auraRadius = Math.max(width * 0.34, height * 0.72);
  const aura = ctx.createRadialGradient(heroCenterX, heroCenterY, 12, heroCenterX, heroCenterY, auraRadius);
  aura.addColorStop(0, lightingMode === "NEON_RIM_GLOW" ? subtleTint : palette.glowRgba);
  aura.addColorStop(0.58, subtleTint);
  aura.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = aura;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  // 2. تركيز ضوئي علوي هادئ (Soft Overhead Key Light)
  if (lightingMode === "DRAMATIC_SPOTLIGHT") {
    ctx.save();
    const keyGrad = ctx.createRadialGradient(
      heroCenterX,
      height * 0.12,
      height * 0.05,
      heroCenterX,
      height * 0.52,
      width * 0.34,
    );
    keyGrad.addColorStop(0, isDarkTheme ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.78)");
    keyGrad.addColorStop(0.65, isDarkTheme ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.22)");
    keyGrad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = keyGrad;
    ctx.fillRect(0, 0, width * 0.65, height);
    ctx.restore();
  }

  // 3. إضاءة نافذة نهارية قطرية هادئة (Natural Architectural Window Falloff)
  if (lightingMode === "GOLDEN_SUNBEAM" || withLightRays) {
    ctx.save();
    const beam = ctx.createLinearGradient(0, 0, width * 0.48, height * 0.92);
    beam.addColorStop(
      0,
      lightingMode === "GOLDEN_SUNBEAM"
        ? isDarkTheme
          ? "rgba(253, 230, 138, 0.09)"
          : "rgba(254, 243, 199, 0.48)"
        : isDarkTheme
          ? "rgba(255, 255, 255, 0.07)"
          : "rgba(255, 255, 255, 0.65)",
    );
    beam.addColorStop(0.6, "rgba(255,255,255,0.04)");
    beam.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = beam;
    ctx.fillRect(0, 0, width * 0.6, height);
    ctx.restore();
  }
}

/** يرسم منصة عرض Apple معمارية نحيفة ونظيفة (Minimal Architectural Display Plinth) بلا براميل داكنة. */
export function draw3DPodiumStage(opts: {
  ctx: CanvasRenderingContext2D;
  centerX: number;
  topY: number;
  radiusX: number;
  radiusY: number;
  podiumHeight: number;
  palette: BannerStudioPalette;
  isDarkTheme: boolean;
}) {
  const { ctx, centerX, topY, radiusX, radiusY, isDarkTheme } = opts;
  const slimHeight = Math.max(14, Math.round(opts.podiumHeight * 0.44));

  ctx.save();
  // 1. ظل تماس منتشر ناعم أسفل المنصة النحيفة
  const baseShadow = ctx.createRadialGradient(
    centerX,
    topY + slimHeight + radiusY * 0.15,
    radiusX * 0.18,
    centerX,
    topY + slimHeight + radiusY * 0.15,
    radiusX * 1.18,
  );
  baseShadow.addColorStop(0, isDarkTheme ? "rgba(0,0,0,0.52)" : "rgba(15,23,42,0.11)");
  baseShadow.addColorStop(0.65, isDarkTheme ? "rgba(0,0,0,0.16)" : "rgba(15,23,42,0.03)");
  baseShadow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = baseShadow;
  ctx.save();
  ctx.translate(centerX, topY + slimHeight + radiusY * 0.12);
  ctx.scale(1, 0.2);
  ctx.beginPath();
  ctx.arc(0, 0, radiusX * 1.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 2. حافة المنصة المعمارية المصقولة بأسلوب طاولات Apple (Anodized Aluminum / Matte Alabaster Slab)
  ctx.beginPath();
  ctx.ellipse(centerX, topY, radiusX, radiusY * 0.72, 0, Math.PI, 0, true);
  ctx.lineTo(centerX + radiusX, topY + slimHeight);
  ctx.ellipse(centerX, topY + slimHeight, radiusX, radiusY * 0.72, 0, 0, Math.PI, false);
  ctx.closePath();

  const bodyGrad = ctx.createLinearGradient(centerX - radiusX, topY, centerX + radiusX, topY);
  if (isDarkTheme) {
    bodyGrad.addColorStop(0, "#1c1c1e");
    bodyGrad.addColorStop(0.38, "#2c2c2e");
    bodyGrad.addColorStop(0.7, "#242426");
    bodyGrad.addColorStop(1, "#18181a");
  } else {
    bodyGrad.addColorStop(0, "#e5e5ea");
    bodyGrad.addColorStop(0.36, "#ffffff");
    bodyGrad.addColorStop(0.72, "#ededf2");
    bodyGrad.addColorStop(1, "#dedee5");
  }
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  // 3. السطح العلوي النقي للمنصة
  ctx.beginPath();
  ctx.ellipse(centerX, topY, radiusX, radiusY * 0.72, 0, 0, Math.PI * 2);
  ctx.fillStyle = isDarkTheme ? "#2c2c2e" : "#fbfbfd";
  ctx.fill();

  ctx.strokeStyle = isDarkTheme ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.95)";
  ctx.lineWidth = 1.25;
  ctx.stroke();
  ctx.restore();
}

/**
 * يحوّل مجسّم المنتج (أو بطاقته المفرّغة الهوامش) إلى لوحة استوديو موحّدة ثم يطبّق عليها
 * إسقاط منظور كاميرا ثلاثي الأبعاد حقيقي حول المحور الرأسي (32-Slice Projective Y-Axis Perspective)
 * لمحاكاة دوران الأجنحة نحو بؤرة العدسة ونقطة التلاشي تماماً كعدسات التصوير الإعلاني الاحترافي.
 */
function buildPerspectiveProductCanvas(opts: {
  sprite: CutoutProductSprite;
  targetW: number;
  targetH: number;
  turnDeg: number;
  isDarkTheme: boolean;
}): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const { sprite, targetW, targetH, turnDeg, isDarkTheme } = opts;
  const baseW = Math.max(20, Math.round(targetW));
  const baseH = Math.max(20, Math.round(targetH));

  // 1. تجهيز لوحة المنتج الأساسية بدقة عالية (مع إطار Apple ناعم إن كان ذا بطاقة بيضاء داخلية)
  const flatCanvas = document.createElement("canvas");
  if (sprite.isCutout) {
    flatCanvas.width = baseW;
    flatCanvas.height = baseH;
    const fctx = flatCanvas.getContext("2d");
    if (!fctx) return null;
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = "high";
    fctx.drawImage(sprite.source, sprite.sx, sprite.sy, sprite.sw, sprite.sh, 0, 0, baseW, baseH);
  } else {
    const pad = Math.max(6, Math.round(Math.min(baseW, baseH) * 0.04));
    const cw = baseW + pad * 2;
    const ch = baseH + pad * 2;
    const r = Math.round(Math.min(cw, ch) * 0.08);
    flatCanvas.width = cw;
    flatCanvas.height = ch;
    const fctx = flatCanvas.getContext("2d");
    if (!fctx) return null;
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = "high";
    fctx.fillStyle = "#ffffff";
    fctx.beginPath();
    fctx.roundRect(0, 0, cw, ch, r);
    fctx.fill();
    fctx.save();
    fctx.beginPath();
    fctx.roundRect(pad, pad, baseW, baseH, Math.max(4, r - Math.round(pad * 0.6)));
    fctx.clip();
    fctx.drawImage(sprite.source, sprite.sx, sprite.sy, sprite.sw, sprite.sh, pad, pad, baseW, baseH);
    fctx.restore();
    fctx.lineWidth = 1.4;
    fctx.strokeStyle = isDarkTheme ? "rgba(255,255,255,0.28)" : "rgba(15,23,42,0.09)";
    fctx.beginPath();
    fctx.roundRect(0.7, 0.7, cw - 1.4, ch - 1.4, r);
    fctx.stroke();
  }

  if (Math.abs(turnDeg) < 0.6) {
    return flatCanvas;
  }

  // 2. إسقاط المنظور البصري ثلاثي الأبعاد عبر 32 شريحة رأسية متدرجة التقارب نحو نقطة التلاشي
  const rad = (turnDeg * Math.PI) / 180;
  const srcW = flatCanvas.width;
  const srcH = flatCanvas.height;
  const projW = Math.max(18, Math.round(srcW * Math.cos(rad)));
  const taper = Math.sin(Math.abs(rad)) * 0.27;
  const padY = Math.round(srcH * taper * 0.55) + 3;

  const perspCanvas = document.createElement("canvas");
  perspCanvas.width = projW;
  perspCanvas.height = srcH + padY * 2;
  const pctx = perspCanvas.getContext("2d");
  if (!pctx) return flatCanvas;
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = "high";

  const slices = 32;
  for (let s = 0; s < slices; s += 1) {
    const u0 = s / slices;
    const u1 = (s + 1) / slices;
    const um = (u0 + u1) * 0.5;
    const depthT = turnDeg > 0 ? um : 1 - um;
    const scaleY = 1 - taper * (depthT - 0.5);
    const sliceH = Math.max(4, srcH * scaleY);

    const sx0 = u0 * srcW;
    const swSlice = Math.max(1, (u1 - u0) * srcW);
    const dx0 = Math.round(u0 * projW);
    const dx1 = Math.max(dx0 + 1, Math.round(u1 * projW));
    const dyTop = padY + (srcH - sliceH) * 0.68;

    pctx.drawImage(flatCanvas, sx0, 0, swSlice, srcH, dx0, dyTop, dx1 - dx0 + 0.45, sliceH);
  }

  return perspCanvas;
}

/** يرسم انعكاساً مرآوياً متلاشياً حقيقياً للمنتج على سطح طاولة الاستوديو المصقولة (Studio Floor Mirror Reflection). */
function drawFloorMirrorReflection(opts: {
  ctx: CanvasRenderingContext2D;
  perspCanvas: HTMLCanvasElement;
  x: number;
  contactY: number;
  opacity: number;
}) {
  if (typeof document === "undefined") return;
  const { ctx, perspCanvas, x, contactY, opacity } = opts;
  const w = perspCanvas.width;
  const reflH = Math.max(14, Math.round(perspCanvas.height * 0.27));

  const rCanvas = document.createElement("canvas");
  rCanvas.width = w;
  rCanvas.height = reflH;
  const rctx = rCanvas.getContext("2d");
  if (!rctx) return;

  rctx.save();
  rctx.filter = "blur(2px)";
  rctx.translate(0, reflH);
  rctx.scale(1, -reflH / perspCanvas.height);
  rctx.drawImage(perspCanvas, 0, 0);
  rctx.restore();

  rctx.save();
  rctx.globalCompositeOperation = "destination-in";
  const fade = rctx.createLinearGradient(0, 0, 0, reflH);
  fade.addColorStop(0, `rgba(0, 0, 0, ${opacity})`);
  fade.addColorStop(0.45, `rgba(0, 0, 0, ${opacity * 0.35})`);
  fade.addColorStop(1, "rgba(0, 0, 0, 0)");
  rctx.fillStyle = fade;
  rctx.fillRect(0, 0, w, reflH);
  rctx.restore();

  ctx.drawImage(rCanvas, x, contactY - 4);
}

/** يرسم منصة مستطيلة معمارية مصقولة بحواف دائرية تحت منتج منفرد في وضع المسرح المتدرّج (Stepped Riser Block). */
function drawSteppedArchitecturalRiser(opts: {
  ctx: CanvasRenderingContext2D;
  cx: number;
  topY: number;
  riserW: number;
  riserH: number;
  isDarkTheme: boolean;
}) {
  const { ctx, cx, topY, riserW, riserH, isDarkTheme } = opts;
  const x0 = Math.round(cx - riserW / 2);
  const r = Math.min(12, Math.round(riserH * 0.35));

  ctx.save();
  const sh = ctx.createRadialGradient(cx, topY + riserH + 3, riserW * 0.1, cx, topY + riserH + 3, riserW * 0.62);
  sh.addColorStop(0, isDarkTheme ? "rgba(0,0,0,0.55)" : "rgba(15,23,42,0.16)");
  sh.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = sh;
  ctx.save();
  ctx.translate(cx, topY + riserH + 2);
  ctx.scale(1, 0.16);
  ctx.beginPath();
  ctx.arc(0, 0, riserW * 0.62, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const grad = ctx.createLinearGradient(x0, topY, x0 + riserW, topY + riserH);
  if (isDarkTheme) {
    grad.addColorStop(0, "#24262b");
    grad.addColorStop(0.45, "#32353d");
    grad.addColorStop(1, "#1c1e22");
  } else {
    grad.addColorStop(0, "#e6e8ef");
    grad.addColorStop(0.42, "#ffffff");
    grad.addColorStop(1, "#dfe2ec");
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(x0, topY, riserW, riserH, [r, r, 4, 4]);
  ctx.fill();

  ctx.strokeStyle = isDarkTheme ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.96)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x0 + r, topY + 0.8);
  ctx.lineTo(x0 + riserW - r, topY + 0.8);
  ctx.stroke();
  ctx.restore();
}

/**
 * محرك توزيع الكاميرا والمنظور الترويجي العالمي (Global-Agency 3D Perspective Camera Staging):
 * - يحاكي عدسة استوديو احترافية (50mm–85mm) بزاوية أفق منخفضة تمنح المنتج البطل هيبة تسويقية في المقدمة،
 *   وتدير المنتجات المرافقة بزاوية منظور ثلاثي الأبعاد حقيقي (Projective Foreshortening) نحو مركز الكادر.
 * - يطبق عزل عدسة بصري خفيف (Shallow Optical DoF) على الأجنحة الخلفية وانعكاساً مرآوياً على سطح الطاولة.
 * - يمنع تقزيم المنتجات العريضة عبر التوزيع الهرمي المتدرج في العمق (2-Plane Amphitheater Staging).
 */
export function drawMergedProductEnsemble(opts: {
  ctx: CanvasRenderingContext2D;
  sprites: CutoutProductSprite[];
  width: number;
  height: number;
  isMobile?: boolean;
  isDarkTheme: boolean;
  compositionStyle: BannerCompositionStyle;
  productScaleBoost: number;
  hasPodium: boolean;
}) {
  const {
    ctx,
    sprites,
    width,
    height,
    isMobile = false,
    isDarkTheme,
    compositionStyle,
    productScaleBoost,
    hasPodium,
  } = opts;
  const count = Math.min(sprites.length, isMobile ? 4 : 5);
  if (count === 0) return;

  const scaleMult = Math.max(0.9, Math.min(1.22, productScaleBoost));

  interface CameraSlot {
    idx: number;
    cx: number;
    contactY: number;
    floatGapY: number;
    targetW: number;
    targetH: number;
    turnDeg: number;
    rollRad: number;
    dofBlurPx: number;
    zOrder: number;
    riserH: number;
  }

  let slots: CameraSlot[] = [];

  if (compositionStyle === "CLEAN_GRID" && count >= 4) {
    const gridCoords = [
      { cx: width * 0.145, cy: height * 0.29, turn: 6 },
      { cx: width * 0.35, cy: height * 0.29, turn: -6 },
      { cx: width * 0.145, cy: height * 0.71, turn: 6 },
      { cx: width * 0.35, cy: height * 0.71, turn: -6 },
    ];
    slots = gridCoords.map((g, i) => {
      const sp = sprites[i]!;
      const fit = Math.min((width * 0.175 * scaleMult) / sp.sw, (height * 0.37 * scaleMult) / sp.sh);
      const th = sp.sh * fit;
      return {
        idx: i,
        cx: g.cx,
        contactY: g.cy + th * 0.5,
        floatGapY: 0,
        targetW: sp.sw * fit,
        targetH: th,
        turnDeg: g.turn,
        rollRad: 0,
        dofBlurPx: 0,
        zOrder: i + 1,
        riserH: 0,
      };
    });
  } else if (count === 1) {
    const sp = sprites[0]!;
    const fit = Math.min((width * 0.37 * scaleMult) / sp.sw, (height * 0.80 * scaleMult) / sp.sh);
    slots = [
      {
        idx: 0,
        cx: width * 0.265,
        contactY: hasPodium ? height * 0.82 : height * 0.895,
        floatGapY: 0,
        targetW: sp.sw * fit,
        targetH: sp.sh * fit,
        turnDeg: -4,
        rollRad: 0,
        dofBlurPx: 0,
        zOrder: 5,
        riserH: 0,
      },
    ];
  } else {
    const isCascade = compositionStyle === "DYNAMIC_CASCADE";
    const isSteppedStage = compositionStyle === "PODIUM_SHOWCASE";

    const camRig: Record<
      number,
      {
        hFrac: number;
        wFrac: number;
        minHFrac: number;
        baseYFrac: number;
        turn: number;
        roll: number;
        dof: number;
        z: number;
        floatFrac: number;
        riserFrac: number;
      }
    > = {
      0: {
        hFrac: 0.77,
        wFrac: count >= 4 ? 0.255 : 0.285,
        minHFrac: 0.52,
        baseYFrac: hasPodium ? 0.835 : 0.905,
        turn: 0,
        roll: isCascade ? -0.025 : 0,
        dof: 0,
        z: 5,
        floatFrac: isCascade ? 0.032 : 0,
        riserFrac: isSteppedStage ? 0.068 : 0,
      },
      1: {
        hFrac: 0.70,
        wFrac: 0.205,
        minHFrac: 0.44,
        baseYFrac: hasPodium ? 0.79 : 0.848,
        turn: isCascade ? 16 : 14,
        roll: isCascade ? -0.045 : 0,
        dof: 0,
        z: 3,
        floatFrac: isCascade ? 0.055 : 0,
        riserFrac: isSteppedStage ? 0.048 : 0,
      },
      2: {
        hFrac: 0.70,
        wFrac: 0.205,
        minHFrac: 0.44,
        baseYFrac: hasPodium ? 0.79 : 0.848,
        turn: isCascade ? -16 : -14,
        roll: isCascade ? 0.045 : 0,
        dof: 0,
        z: 4,
        floatFrac: isCascade ? 0.05 : 0,
        riserFrac: isSteppedStage ? 0.048 : 0,
      },
      3: {
        hFrac: 0.61,
        wFrac: 0.165,
        minHFrac: 0.38,
        baseYFrac: hasPodium ? 0.745 : 0.792,
        turn: 20,
        roll: isCascade ? -0.06 : 0,
        dof: 0.85,
        z: 1,
        floatFrac: isCascade ? 0.075 : 0,
        riserFrac: isSteppedStage ? 0.034 : 0,
      },
      4: {
        hFrac: 0.61,
        wFrac: 0.165,
        minHFrac: 0.38,
        baseYFrac: hasPodium ? 0.745 : 0.792,
        turn: -20,
        roll: isCascade ? 0.06 : 0,
        dof: 0.85,
        z: 2,
        floatFrac: isCascade ? 0.075 : 0,
        riserFrac: isSteppedStage ? 0.034 : 0,
      },
    };

    const computeSize = (idx: number) => {
      const sp = sprites[idx]!;
      const r = camRig[idx]!;
      const maxH = height * r.hFrac * scaleMult;
      const maxW = width * r.wFrac * scaleMult;
      let fit = Math.min(maxW / sp.sw, maxH / sp.sh);
      const minH = height * r.minHFrac;
      if (sp.sh * fit < minH && sp.sw * (minH / sp.sh) <= width * 0.30) {
        fit = minH / sp.sh;
      }
      const tw = sp.sw * fit;
      const th = sp.sh * fit;
      const projW = tw * Math.cos((Math.abs(r.turn) * Math.PI) / 180);
      return { tw, th, projW, r };
    };

    const s0 = computeSize(0);
    const stageLeft = width * (isMobile ? 0.026 : 0.032);
    const stageRight = width * (isMobile ? 0.465 : 0.515);
    const heroCx = count === 2 ? width * (isMobile ? 0.275 : 0.305) : width * (isMobile ? 0.245 : 0.268);

    const built: CameraSlot[] = [
      {
        idx: 0,
        cx: heroCx,
        contactY: height * s0.r.baseYFrac,
        floatGapY: height * s0.r.floatFrac,
        targetW: s0.tw,
        targetH: s0.th,
        turnDeg: s0.r.turn,
        rollRad: s0.r.roll,
        dofBlurPx: s0.r.dof,
        zOrder: s0.r.z,
        riserH: height * s0.r.riserFrac,
      },
    ];

    let s1EdgeLeft = heroCx - s0.projW * 0.5;
    let s2EdgeRight = heroCx + s0.projW * 0.5;

    if (count >= 2) {
      const s1 = computeSize(1);
      const step1 = Math.max(width * 0.075, s0.projW * 0.42 + s1.projW * 0.36);
      const cx1 = Math.max(stageLeft + s1.projW * 0.48, heroCx - step1);
      s1EdgeLeft = cx1 - s1.projW * 0.5;
      built.push({
        idx: 1,
        cx: cx1,
        contactY: height * s1.r.baseYFrac,
        floatGapY: height * s1.r.floatFrac,
        targetW: s1.tw,
        targetH: s1.th,
        turnDeg: s1.r.turn,
        rollRad: s1.r.roll,
        dofBlurPx: s1.r.dof,
        zOrder: s1.r.z,
        riserH: height * s1.r.riserFrac,
      });
    }

    if (count >= 3) {
      const s2 = computeSize(2);
      const step2 = Math.max(width * 0.075, s0.projW * 0.42 + s2.projW * 0.36);
      const cx2 = Math.min(stageRight - s2.projW * 0.48, heroCx + step2);
      s2EdgeRight = cx2 + s2.projW * 0.5;
      built.push({
        idx: 2,
        cx: cx2,
        contactY: height * s2.r.baseYFrac,
        floatGapY: height * s2.r.floatFrac,
        targetW: s2.tw,
        targetH: s2.th,
        turnDeg: s2.r.turn,
        rollRad: s2.r.roll,
        dofBlurPx: s2.r.dof,
        zOrder: s2.r.z,
        riserH: height * s2.r.riserFrac,
      });
    }

    if (count >= 4) {
      const s3 = computeSize(3);
      const outerRoomLeft = s1EdgeLeft - stageLeft;
      const elevate3 = outerRoomLeft < s3.projW * 0.42;
      const cx3 = elevate3
        ? Math.max(stageLeft + s3.projW * 0.52, (heroCx + s1EdgeLeft) * 0.5)
        : Math.max(stageLeft + s3.projW * 0.46, s1EdgeLeft - s3.projW * 0.22);
      built.push({
        idx: 3,
        cx: cx3,
        contactY: elevate3 ? height * (s3.r.baseYFrac - 0.085) : height * s3.r.baseYFrac,
        floatGapY: height * s3.r.floatFrac,
        targetW: s3.tw,
        targetH: s3.th,
        turnDeg: s3.r.turn,
        rollRad: s3.r.roll,
        dofBlurPx: s3.r.dof,
        zOrder: s3.r.z,
        riserH: elevate3 ? 0 : height * s3.r.riserFrac,
      });
    }

    if (count >= 5) {
      const s4 = computeSize(4);
      const outerRoomRight = stageRight - s2EdgeRight;
      const elevate4 = outerRoomRight < s4.projW * 0.42;
      const cx4 = elevate4
        ? Math.min(stageRight - s4.projW * 0.52, (heroCx + s2EdgeRight) * 0.5)
        : Math.min(stageRight - s4.projW * 0.46, s2EdgeRight + s4.projW * 0.22);
      built.push({
        idx: 4,
        cx: cx4,
        contactY: elevate4 ? height * (s4.r.baseYFrac - 0.085) : height * s4.r.baseYFrac,
        floatGapY: height * s4.r.floatFrac,
        targetW: s4.tw,
        targetH: s4.th,
        turnDeg: s4.r.turn,
        rollRad: s4.r.roll,
        dofBlurPx: s4.r.dof,
        zOrder: s4.r.z,
        riserH: elevate4 ? 0 : height * s4.r.riserFrac,
      });
    }

    const minLeft = Math.min(...built.map((b) => b.cx - b.targetW * 0.46));
    const maxRight = Math.max(...built.map((b) => b.cx + b.targetW * 0.46));
    const desiredCenter = width * (isMobile ? 0.245 : 0.268);
    const currentCenter = (minLeft + maxRight) * 0.5;
    const shiftX = Math.max(
      stageLeft - minLeft,
      Math.min(stageRight - maxRight, desiredCenter - currentCenter),
    );
    slots = built.map((b) => ({ ...b, cx: b.cx + shiftX }));
  }

  const stageCenter = width * (isMobile ? 0.245 : 0.268);
  slots.sort((a, b) => a.zOrder - b.zOrder);

  for (const slot of slots) {
    const sprite = sprites[slot.idx];
    if (!sprite) continue;

    const perspCanvas = buildPerspectiveProductCanvas({
      sprite,
      targetW: slot.targetW,
      targetH: slot.targetH,
      turnDeg: slot.turnDeg,
      isDarkTheme,
    });
    if (!perspCanvas) continue;

    const pw = perspCanvas.width;
    const ph = perspCanvas.height;
    const productBottomY = slot.contactY - slot.riserH - slot.floatGapY;
    const drawX = Math.round(slot.cx - pw / 2);
    const drawY = Math.round(productBottomY - ph);

    if (slot.riserH > 4) {
      drawSteppedArchitecturalRiser({
        ctx,
        cx: slot.cx,
        topY: slot.contactY - slot.riserH,
        riserW: Math.max(pw * 1.08, width * 0.085),
        riserH: slot.riserH,
        isDarkTheme,
      });
    }

    if (!hasPodium && slot.riserH === 0) {
      drawFloorMirrorReflection({
        ctx,
        perspCanvas,
        x: drawX,
        contactY: slot.contactY,
        opacity: slot.idx === 0 ? (isDarkTheme ? 0.22 : 0.17) : isDarkTheme ? 0.14 : 0.11,
      });
    }

    ctx.save();
    const shadowScale = slot.floatGapY > 0 ? 0.82 : 1;
    const shadowRx = Math.max(pw * 0.54 * shadowScale, height * 0.04);
    const shadowGrad = ctx.createRadialGradient(
      slot.cx,
      slot.contactY - slot.riserH,
      shadowRx * 0.06,
      slot.cx,
      slot.contactY - slot.riserH,
      shadowRx,
    );
    const umbraAlpha = slot.floatGapY > 0 ? (isDarkTheme ? 0.42 : 0.14) : isDarkTheme ? 0.64 : 0.23;
    shadowGrad.addColorStop(0, `rgba(15, 23, 42, ${umbraAlpha})`);
    shadowGrad.addColorStop(0.52, `rgba(15, 23, 42, ${umbraAlpha * 0.32})`);
    shadowGrad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = shadowGrad;
    ctx.save();
    ctx.translate(slot.cx, slot.contactY - slot.riserH);
    ctx.scale(1, 0.17);
    ctx.beginPath();
    ctx.arc(0, 0, shadowRx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.restore();

    ctx.save();
    ctx.translate(slot.cx, drawY + ph / 2);
    if (slot.rollRad !== 0) ctx.rotate(slot.rollRad);
    if (slot.dofBlurPx > 0) {
      ctx.filter = `blur(${slot.dofBlurPx}px)`;
    }

    const lateralShadowX =
      slot.idx === 0 ? 0 : slot.cx < stageCenter ? Math.round(height * 0.015) : -Math.round(height * 0.015);

    ctx.shadowColor = isDarkTheme ? "rgba(0,0,0,0.58)" : "rgba(15,23,42,0.22)";
    ctx.shadowBlur = Math.round(height * 0.045);
    ctx.shadowOffsetX = lateralShadowX;
    ctx.shadowOffsetY = Math.round(height * 0.018);
    ctx.drawImage(perspCanvas, -pw / 2, -ph / 2);

    ctx.shadowColor = isDarkTheme ? "rgba(255,255,255,0.36)" : "rgba(255,255,255,0.92)";
    ctx.shadowBlur = 1.5;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = -1;
    ctx.drawImage(perspCanvas, -pw / 2, -ph / 2);

    ctx.restore();
  }
}

/** يرسم كبسولة السعر/العرض الزجاجية الأنيقة بنمط Apple (Frosted Glass Price Pill — بلا ملصقات دائرية صاخبة). */
export function drawPromoSealBadge(opts: {
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  radius: number;
  badgeText: string;
  palette: BannerStudioPalette;
  isDarkTheme: boolean;
}) {
  const { ctx, x, y, radius, badgeText, palette, isDarkTheme } = opts;
  if (!badgeText) return;

  ctx.save();
  const fontPx = Math.round(radius * 0.34);
  ctx.font = `800 ${fontPx}px Cairo, system-ui, sans-serif`;
  const textW = ctx.measureText(badgeText).width;
  const pillW = Math.round(textW + fontPx * 1.9);
  const pillH = Math.round(fontPx * 2.05);
  const px = Math.round(x - pillW / 2);
  const py = Math.round(y - pillH / 2);

  ctx.shadowColor = isDarkTheme ? "rgba(0,0,0,0.38)" : "rgba(15,23,42,0.10)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 5;

  ctx.fillStyle = isDarkTheme ? "rgba(29, 29, 31, 0.86)" : "rgba(255, 255, 255, 0.92)";
  ctx.beginPath();
  ctx.roundRect(px, py, pillW, pillH, pillH / 2);
  ctx.fill();

  ctx.shadowColor = "transparent";
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = isDarkTheme ? "rgba(255,255,255,0.20)" : "rgba(30, 58, 138, 0.14)";
  ctx.stroke();

  ctx.direction = "rtl";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = isDarkTheme ? "#f5f5f7" : palette.badgeTextHex;
  ctx.fillText(badgeText, x, y + 1);
  ctx.restore();
}
