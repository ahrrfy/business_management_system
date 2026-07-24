// راسم ملصق الباركود الحراري — يرسم ملصقاً واحداً (اسم اختياري + Code128 + أرقام + صفّ سفليّ)
// على Canvas بمقاس الملصق المختار، ثم يحوّله نقطية ESC/POS. **نفس تقنية إيصال الكاشير**
// (receiptRaster): رسم على Canvas ⇒ عتبة سواد ⇒ GS v 0 ⇒ WebUSB.
//
// التخطيط الرأسيّ (أيّ جزءٍ يظهر وبأيّ حجم/ارتفاع) يأتي كلّه من `labelLayout.solveLabelLayout`
// — **المصدر نفسه الذي يستهلكه المسار المتّجه `labelDesign`** ⇒ ما يُطبع حرارياً يطابق المعاينة
// تماماً (§٥ «تصميم واحد على كل النواقل»). قبل هذا التوحيد كان هذا المسار يستعمل أرضياتٍ مختلفة
// (خطّ ١٢px، باركود ٣٦نقطة، صفّ سفليّ بموضعٍ ثابت) ⇒ **يتراكم** على الملصق الصغير بينما يَقُصّ
// المتّجه — تفاوتٌ يخرق وعد «ما تراه هو ما يُطبع».
//
// قيد العتبة في imageDataToRaster هو lum<128 ⇒ كل شيء يُرسم بأسود صافٍ (#000).
import { EscPos, imageDataToRaster, type Raster } from "./escpos";
import { productBarcodeSvg } from "./barcode";
import { fmtC } from "./brand";
import { attrsLineText, ellipsize, wrapTwoLines } from "./labelItem";
import { labelContentOf, PT_MM, solveLabelLayout } from "./labelLayout";
import { labelHeightDots, labelWidthDots, PRINT_DPMM, type LabelSize } from "./labelSize";

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
  /**
   * مكوّنات منظّمة للتخطيط الاحترافي (اسمٌ بارز + سطر «اللون · القياس · الوحدة» + رمز لون) —
   * يُستعمَل حين يتّسع المقاس؛ يتراجع الحلّال للاسم المدموج (`name`) على الملصقات الضيّقة بلا فقد معلومة.
   */
  attrs?: {
    baseName: string;
    tags: string[];
    colorHex?: string | null;
    unitName?: string | null;
  };
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
 * الكتل تُوضَع من الأعلى للأسفل بارتفاعات الحلّال، وتُوسَّط عمودياً إن بقي فائض ⇒ لا تراكب ولا قصّ.
 */
export async function labelToCanvas(
  item: LabelRenderItem,
  size: LabelSize,
  opts: LabelRenderOpts = {},
): Promise<HTMLCanvasElement | null> {
  if (typeof document === "undefined") return null;
  await ensureFonts();

  const L = solveLabelLayout(size, labelContentOf(item), { name: opts.showName, price: opts.showPrice });
  const W = labelWidthDots(size.widthMm);
  const H = labelHeightDots(size.heightMm);

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

  const MM = PRINT_DPMM; // 8 نقطة/مم
  const pt2px = (pt: number) => Math.max(1, Math.round(pt * PT_MM * MM)); // نقطة→بكسل @203dpi
  const PADX = Math.round(1.5 * MM); // هامش أفقيّ 1.5مم (يطابق المتّجه)

  // ارتفاعات الكتل (نقاط) من قرار الحلّال نفسه ⇒ تطابقٌ مع المعاينة المتّجهة.
  const nameH = L.name.show ? Math.round(L.name.heightMm * MM) : 0;
  const attrsH = L.attrs.show ? Math.round(L.attrs.heightMm * MM) : 0;
  const barH = L.barcode.show ? Math.max(1, Math.round(L.barcode.heightMm * MM)) : 0;
  const digitsH = L.digits.show ? Math.round(L.digits.heightMm * MM) : 0;
  const bottomH = L.bottom.show ? Math.round(L.bottom.heightMm * MM) : 0;
  const gap = Math.round(L.gapMm * MM);
  const blocks = [nameH > 0, attrsH > 0, barH > 0, digitsH > 0, bottomH > 0].filter(Boolean).length;
  const totalH = nameH + attrsH + barH + digitsH + bottomH + Math.max(0, blocks - 1) * gap;
  // توسيط عموديّ (الحلّال قد يترك فائضاً على الملصق الواسع)، بلا نزولٍ تحت الهامش العلويّ.
  let y = Math.max(Math.round(L.padYMm * MM), Math.round((H - totalH) / 2));

  // ───── ١) اسم المنتج — أساسٌ بارز (تخطيط منظّم) أو مدموج (حتى L.name.lines) ─────
  const nameText = L.name.structured && item.attrs ? item.attrs.baseName : String(item.name ?? "");
  if (L.name.show && nameH > 0) {
    const fs = pt2px(L.name.fsPt);
    ctx.font = `700 ${fs}px Cairo, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const maxW = W - PADX * 2;
    const measure = (s: string) => ctx.measureText(s).width;
    let lines = wrapTwoLines(nameText, maxW, measure);
    // الحلّال حجز `L.name.lines` سطراً ⇒ لا نتجاوزه (وإلّا تراكب مع الباركود على الملصق الضيّق).
    if (lines.length > L.name.lines) lines = [ellipsize(nameText, maxW, measure)];
    const lineStep = nameH / Math.max(1, lines.length);
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], W / 2, y + Math.round(i * lineStep));
    ctx.textBaseline = "alphabetic";
    y += nameH + gap;
  }

  // ───── ١ب) سطر الخصائص المنظّم: رمز لون (حلقة سوداء على الحراريّ الأحاديّ) + «اللون · القياس · الوحدة» ─────
  if (L.attrs.show && attrsH > 0 && item.attrs) {
    const a = item.attrs;
    ctx.font = `600 ${pt2px(L.attrs.fsPt)}px Cairo, sans-serif`;
    ctx.textBaseline = "middle";
    const line = attrsLineText(a);
    const hasHex = !!a.colorHex && /^#[0-9a-fA-F]{6}$/.test(a.colorHex);
    const r = Math.max(2, Math.round(attrsH * 0.3)); // نصف قطر رمز اللون
    const textW = line ? ctx.measureText(line).width : 0;
    const swW = hasHex ? r * 2 + 4 : 0;
    let cx = Math.round((W - (swW + textW)) / 2);
    const midY = y + Math.round(attrsH / 2);
    if (hasHex) {
      ctx.beginPath();
      ctx.arc(cx + r, midY, r, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#000";
      ctx.stroke();
      cx += swW;
    }
    if (line) {
      ctx.textAlign = "left";
      ctx.fillText(line, cx, midY);
    }
    ctx.textBaseline = "alphabetic";
    y += attrsH + gap;
  }

  // ───── ٢) الباركود (EAN أصليّ للأرقام الصالحة — أكثف؛ وإلا Code128) بأثخن قضبانٍ ممكنة ─────
  if (L.barcode.show && barH > 0) {
    try {
      const target = W - PADX * 2;
      // اختر أكبر moduleWidth صحيح (نقاط طابعة كاملة) يلائم العرض فعلياً.
      const mk = (mw: number) => productBarcodeSvg(item.barcode, { moduleWidth: mw, height: barH, showText: false });
      let mw = 1;
      while (mw < 6 && mk(mw + 1).widthPx <= target) mw++;
      const bcode = mk(mw);
      const img = await loadImage(svgToDataUrl(bcode.svg));
      if (img) {
        // لا نُصغّر القضبان دون 1 بكسل/وحدة (تصير غير قابلة للمسح): نرسمها بعرضها الطبيعيّ ضمن الملصق.
        const drawW = Math.min(bcode.widthPx, W - 2);
        const sm = ctx as unknown as { imageSmoothingEnabled: boolean };
        const prevSmooth = sm.imageSmoothingEnabled;
        sm.imageSmoothingEnabled = false;
        // إزاحة صحيحة (نقاط كاملة) — إزاحة كسرية تُعيد أخذ العيّنات فتُفسد نسب عرض القضبان.
        ctx.drawImage(img, Math.round((W - drawW) / 2), y, drawW, barH);
        sm.imageSmoothingEnabled = prevSmooth;
      }
    } catch {
      /* باركود غير قابل للترميز ⇒ فراغٌ مكانه (يبقى الاسم/السعر) */
    }
    y += barH + gap;
  }

  // ───── ٣) أرقام الباركود المقروءة (اختيارية — تُسقَط أوّلاً على الملصق الضيّق) ─────
  if (L.digits.show && digitsH > 0) {
    ctx.font = `600 ${pt2px(L.digits.fsPt)}px Cairo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(item.barcode, W / 2, y);
    ctx.textBaseline = "alphabetic";
    y += digitsH + gap;
  }

  // ───── ٤) صفّ سفليّ: [السعر + المشطوب] يساراً | [الرمز + الشارة] يميناً ─────
  // مطابقٌ لتخطيط `labelDesign` (§٥). السعر هو الحقل الحرج (يُبقى كاملاً)؛ يُقصّ الرمز بـ«…».
  if (L.bottom.show && bottomH > 0) {
    const b = L.bottom;
    const baseY = y + Math.round(bottomH * 0.82); // خطّ الأساس قرب أسفل الكتلة
    const priceFs = pt2px(b.priceFsPt);
    const secFs = pt2px(b.secFsPt);
    const priceText = b.showPrice && item.price != null && item.price !== "" ? fmtC(item.price) : "";
    const baseText = b.showPrice && item.basePrice != null && item.basePrice !== "" ? fmtC(item.basePrice) : "";
    const skuText = b.showSku && item.sku ? item.sku : "";
    const tierText = b.showTier && item.tierLabel ? item.tierLabel : "";

    // ① السعر (يسار) ثم السعر القديم مشطوباً على يمينه — يرى الزبون قيمة الخصم.
    let priceGroupW = 0;
    if (priceText) {
      ctx.font = `700 ${priceFs}px Cairo, sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText(priceText, PADX, baseY);
      priceGroupW = ctx.measureText(priceText).width;
    }
    if (baseText) {
      ctx.font = `600 ${secFs}px Cairo, sans-serif`;
      ctx.textAlign = "left";
      const x = PADX + priceGroupW + (priceText ? 4 : 0);
      const wtxt = ctx.measureText(baseText).width;
      ctx.fillText(baseText, x, baseY);
      // شطبٌ سميك (٢ نقطة) — شعرة `line-through` الافتراضية تختفي على 203dpi الحراري.
      ctx.fillRect(x, Math.round(baseY - secFs * 0.3), wtxt, 2);
      priceGroupW = x - PADX + wtxt;
    }

    // ② الرمز (أقصى اليمين) ثم شارة الفئة على يساره — نحجز عرض الشارة قبل قصّ الرمز.
    const tierW = tierText
      ? ((ctx.font = `800 ${secFs}px Cairo, sans-serif`), ctx.measureText(tierText).width + 6)
      : 0;
    let rightCursor = W - PADX;
    if (skuText) {
      ctx.font = `600 ${secFs}px Cairo, sans-serif`;
      const skuMaxW = W - PADX * 2 - priceGroupW - tierW - 8;
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
      // شارة مطموسة (أسود صافٍ + نصّ أبيض): عتبة lum<128 ⇒ الأسود يُطبع والأبيض يُترك ⇒ شارة معكوسة.
      const bx = rightCursor - tierW;
      ctx.fillStyle = "#000";
      ctx.fillRect(bx, baseY - secFs - 1, tierW, secFs + 4);
      ctx.fillStyle = "#fff";
      ctx.font = `800 ${secFs}px Cairo, sans-serif`;
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
