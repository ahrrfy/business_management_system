// راسم ملصق الباركود الحراري — يرسم ملصقاً واحداً (اسم اختياري + Code128 + SKU + سعر)
// على Canvas بمقاس الملصق المختار، ثم يحوّله نقطية ESC/POS. **نفس تقنية إيصال الكاشير**
// (receiptRaster) بالضبط: رسم على Canvas ⇒ عتبة سواد ⇒ GS v 0 ⇒ WebUSB. الفرق الوحيد
// أنّ العرض 58مم (≤384 نقطة) والتصميم ملصق مبسّط بلا زخارف.
//
// قيد العتبة في imageDataToRaster هو lum<128 ⇒ كل شيء يُرسم بأسود صافٍ (#000).
//
// خطوة التقدّم بين الملصقات = ارتفاع النقطية نفسه (نخبز الـpitch في الارتفاع المختار)؛
// أوامر GS v 0 المتتالية تُطبع متلاصقة بلا مسافة ⇒ pitch = مجموع الارتفاعات (حتميّ).
import { EscPos, imageDataToRaster, type Raster } from "./escpos";
import { code128Svg } from "./barcode";
import { fmtC } from "./brand";
import { wrapTwoLines } from "./labelItem";
import { labelHeightDots, labelWidthDots, type LabelSize } from "./labelSize";

export interface LabelRenderItem {
  /** اسم العرض الكامل — يشمل اللون/القياس/الوحدة مدموجةً (انظر `labelName`). */
  name?: string;
  sku?: string;
  /** السعر المطبوع فعلاً: سعر العرض الساري إن وُجد، وإلا سعر الفئة. */
  price?: string | number | null;
  /** السعر قبل خصم العرض — يُطبع مشطوباً بجانب `price`. غيابه ⇒ لا عرض. */
  basePrice?: string | number | null;
  /** شارة فئة السعر («جملة»/«حكومي») — تُترك فارغةً للمفرد فلا تُطبع. */
  tierLabel?: string;
  barcode: string;
}

export interface LabelRenderOpts {
  showName?: boolean;
  showPrice?: boolean;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // تدهور سلس — يُطبع الملصق بلا الباركود
    img.src = src;
  });
}

function svgToDataUrl(svg: string): string {
  try {
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  } catch {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
}

async function ensureFonts(): Promise<void> {
  try {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    const sample = "مكتبة العربية 0123 IQD";
    await Promise.all(
      ["600 16px Cairo", "700 18px Cairo"].map((f) => fonts.load(f, sample).catch(() => undefined)),
    );
  } catch {
    /* تدهور سلس — يُرسم بالخط المتاح */
  }
}

/**
 * يرسم ملصقاً واحداً على Canvas بمقاس الملصق (نقاطاً). يعيد اللوحة أو null خارج المتصفّح.
 * التخطيط عمودياً: [اسم اختياري حتى سطرين] ← [قضبان Code128] ← [أرقام الباركود] ← [SKU+فئة يمين | سعر يسار].
 */
export async function labelToCanvas(
  item: LabelRenderItem,
  size: LabelSize,
  opts: LabelRenderOpts = {},
): Promise<HTMLCanvasElement | null> {
  if (typeof document === "undefined") return null;
  await ensureFonts();

  const W = labelWidthDots(size.widthMm);
  const H = labelHeightDots(size.heightMm);
  const PAD = 6;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#000";
  (ctx as unknown as { direction: string }).direction = "rtl";
  ctx.textBaseline = "alphabetic";

  const showName = opts.showName !== false && !!item.name;
  const showPrice = opts.showPrice !== false;
  const priceText = showPrice && item.price != null && item.price !== "" ? fmtC(item.price) : "";
  const baseText = showPrice && item.basePrice != null && item.basePrice !== "" ? fmtC(item.basePrice) : "";
  const skuText = item.sku ?? "";
  const tierText = item.tierLabel ?? "";
  const hasBottom = !!skuText || !!priceText || !!tierText;

  let y = PAD;

  // ───── ١) اسم المنتج (اختياري، حتى سطرين ثم قصّ …) ─────
  // يلتفّ سطرين مطابقةً للتصميم المتّجه (`labelDesign` بـ`-webkit-line-clamp:2`) وللمعاينة الحيّة —
  // §٥: تصميم واحد على كل النواقل. القصّ سطرٍ واحد هنا كان يبتر الاسم على الطابعة الحرارية بينما
  // تُظهره المعاينة كاملاً بسطرين (خرق وعد «ما تراه هو ما يُطبع» — أمسكته المراجعة العدائية).
  const nameFs = Math.min(18, Math.max(12, Math.round(H * 0.09)));
  if (showName) {
    ctx.font = `700 ${nameFs}px Cairo, sans-serif`;
    ctx.textAlign = "center";
    const maxW = W - PAD * 2;
    const lines = wrapTwoLines(String(item.name), maxW, (s) => ctx.measureText(s).width);
    for (const line of lines) {
      y += nameFs;
      ctx.fillText(line, W / 2, y);
      y += 2;
    }
    y += 2;
  }

  // ───── ٣) صفّ سفليّ (SKU + سعر) — نحجز ارتفاعه أولاً ─────
  const bottomFs = Math.min(16, Math.max(11, Math.round(H * 0.085)));
  const bottomH = hasBottom ? bottomFs + 4 : 0;

  // ───── ٢) باركود Code128 يملأ ما تبقّى ─────
  const barTextH = 14; // أرقام الباركود القابلة للقراءة تحت القضبان
  const barH = Math.max(36, H - y - bottomH - barTextH - PAD);
  try {
    const target = W - PAD * 2;
    // اختر أكبر moduleWidth صحيح يلائم العرض **فعلياً**: عرض Code128 ليس خطّياً مع moduleWidth
    // (منطقة الهدوء ثابتة)، فنزيد mw ما دام العرض الفعلي ≤ المتاح بدل قسمةٍ تقديرية.
    let mw = 1;
    while (mw < 6 && code128Svg(item.barcode, { moduleWidth: mw + 1, height: barH, showText: false }).widthPx <= target) {
      mw++;
    }
    const bc = code128Svg(item.barcode, { moduleWidth: mw, height: barH, showText: false });
    const img = await loadImage(svgToDataUrl(bc.svg));
    if (img) {
      // **لا نُصغّر القضبان دون 1 بكسل/وحدة** (تصير غير قابلة للمسح): نرسمها بعرضها الطبيعي
      // ما دام ضمن عرض الملصق (نستعمل العرض الكامل لا target فقط)، ونُطفئ التنعيم لحدّة القضبان.
      // التصغير القسري ملاذٌ أخير فقط حين يتجاوز الباركود عرض الملصق كلّه.
      const drawW = Math.min(bc.widthPx, W - 2);
      const sm = ctx as unknown as { imageSmoothingEnabled: boolean };
      const prevSmooth = sm.imageSmoothingEnabled;
      sm.imageSmoothingEnabled = false;
      ctx.drawImage(img, (W - drawW) / 2, y, drawW, barH);
      sm.imageSmoothingEnabled = prevSmooth;
    }
    y += barH + 2;
    ctx.font = "600 12px Cairo, monospace";
    ctx.textAlign = "center";
    ctx.fillText(item.barcode, W / 2, y + 10);
    y += barTextH;
  } catch {
    // باركود غير قابل للترميز ⇒ ملصق بلا قضبان (يبقى الاسم/السعر)
    y += barH + barTextH;
  }

  // ───── الصفّ السفليّ فعلياً ─────
  // مطابقٌ لتخطيط `labelDesign.ts` (§٥ تصميم واحد على كل النواقل): مجموعتان —
  // [السعر + السعر القديم مشطوباً] يساراً | [شارة الفئة + الرمز] يميناً.
  // السعر هو الحقل الحرج (يُبقى كاملاً)؛ يُقصّ SKU بـ«…» ليلائم ما تبقّى ⇒ لا تداخل على الملصقات الضيّقة.
  if (hasBottom) {
    const baseY = H - PAD;
    const gap = 8;
    const smallFs = Math.max(9, Math.round(bottomFs * 0.62));

    // ① السعر (يسار) ثم السعر القديم مشطوباً على يمينه — يرى الزبون قيمة الخصم.
    let priceGroupW = 0;
    if (priceText) {
      ctx.font = `700 ${bottomFs}px Cairo, sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText(priceText, PAD, baseY);
      priceGroupW = ctx.measureText(priceText).width;
    }
    if (baseText) {
      ctx.font = `600 ${smallFs}px Cairo, sans-serif`;
      ctx.textAlign = "left";
      const x = PAD + priceGroupW + (priceText ? 4 : 0);
      const w = ctx.measureText(baseText).width;
      ctx.fillText(baseText, x, baseY);
      // شطبٌ سميك (٢ نقطة) — شعرة `line-through` الافتراضية تختفي على 203dpi الحراري.
      ctx.fillRect(x, Math.round(baseY - smallFs * 0.3), w, 2);
      priceGroupW = x - PAD + w;
    }

    // ② الرمز (أقصى اليمين) ثم شارة الفئة على يساره — نحجز عرض الشارة قبل قصّ الرمز.
    const tierW = tierText
      ? (ctx.font = `800 ${smallFs}px Cairo, sans-serif`, ctx.measureText(tierText).width + 6)
      : 0;
    let rightCursor = W - PAD;
    if (skuText) {
      ctx.font = `600 ${bottomFs}px Cairo, sans-serif`;
      const skuMaxW = W - PAD * 2 - priceGroupW - tierW - gap;
      let sku = skuText;
      if (ctx.measureText(sku).width > skuMaxW) {
        while (sku.length > 1 && ctx.measureText(sku + "…").width > skuMaxW) sku = sku.slice(0, -1);
        sku = sku + "…";
      }
      ctx.textAlign = "right";
      ctx.fillText(sku, rightCursor, baseY);
      rightCursor -= ctx.measureText(sku).width + 4;
    }
    if (tierText) {
      // شارة مطموسة (أسود صافٍ + نصّ أبيض): عتبة `imageDataToRaster` هي lum<128 ⇒ الأسود
      // يُطبع والأبيض يُترك ⇒ تخرج الشارة معكوسةً كما في التصميم المتّجه، بلا إطارٍ رفيع يضيع.
      const bx = rightCursor - tierW;
      ctx.fillStyle = "#000";
      ctx.fillRect(bx, baseY - smallFs - 1, tierW, smallFs + 4);
      ctx.fillStyle = "#fff";
      ctx.font = `800 ${smallFs}px Cairo, sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText(tierText, bx + 3, baseY);
      ctx.fillStyle = "#000";
    }
  }

  return canvas;
}

/** ملصق واحد نقطيةً ESC/POS. null خارج المتصفّح. */
export async function labelToRaster(
  item: LabelRenderItem,
  size: LabelSize,
  opts: LabelRenderOpts = {},
): Promise<Raster | null> {
  const canvas = await labelToCanvas(item, size, opts);
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return imageDataToRaster({ width: canvas.width, height: canvas.height, data: img.data });
}

/**
 * يبني بايتات ESC/POS لكل الملصقات (ملصق تلو الآخر، بلا قطع). يعيد null إن تعذّر الرسم
 * (بلا DOM) أو لم يُرسَم أيّ ملصق.
 */
export async function buildLabelBytes(
  items: LabelRenderItem[],
  size: LabelSize,
  opts: LabelRenderOpts = {},
): Promise<Uint8Array | null> {
  if (typeof document === "undefined") return null;
  const pos = new EscPos().init();
  let drawn = 0;
  for (const it of items) {
    const raster = await labelToRaster(it, size, opts);
    if (raster) {
      pos.raster(raster);
      drawn++;
    }
  }
  if (!drawn) return null;
  // تقدّم بسيط بعد آخر ملصق ليصل خطّ القصّ/التقشير (لا قطع — طابعة الملصقات بلا سكّين).
  pos.feed(2);
  return pos.bytes();
}
