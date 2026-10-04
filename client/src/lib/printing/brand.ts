// ثوابت العلامة التجارية لمكتبة العربية — مشتركة بين كل قوالب الطباعة
// المصدر البصري: تسليم «مطبوعات مكتبة العربية» ٥/٧/٢٦ (README + dc.html) — عالية الدقة.
import { COMPANY_IDENTITY } from "@shared/companyIdentity";

/**
 * علامة الألوان — قيم HEX نهائية من تسليم التصميم (README).
 * الحبر أسود خالص لكل النصوص. الأخضر رمز هوية فقط. الأحمر للمتبقي/الدَين. الكهرماني للخصم/الضريبة/الجزئي.
 * الأسماء القديمة (green/greenDark/orange…) مُبقاة كأسماء مستعارة لتوافق الملفات المُشيَّدة قبل ٥/٧ مع
 * سلوكها البصري السابق. الأسماء الجديدة تحمل الرقم الحرفي من التسليم.
 */
export const BRAND = {
  // ── أخضر العلامة (من README §الشيفرة/الشوارد) ───────────────────────
  green: "#0D6B52", // نص/حدود
  greenDark: "#0D3B2E", // خلفية شريط الإجمالي ورأس الجدول
  greenDeep: "#0D3B2E", // اسم مستعار
  greenLight: "#CFE7DE",
  greenPale: "#F0F9F5",
  greenMist: "#F0F9F5",
  greenAccentText: "#CFE7DE", // نص أخضر فاتح داخل شريط الإجمالي الداكن

  // ── نص ── (كل النصوص أسود بطلب صريح من العميل) ─────────────────────
  text: "#000000",
  textSec: "#000000",
  textMuted: "#000000",
  textFaint: "#4E5148", // رمادي فاتح لعبارات الفوتر/التنبيه الفرعي فقط
  ink: "#1C1F1D", // «شبه أسود» للاستدارات وحدود الجداول الخارجية

  // ── تنبيه أحمر (متبقّي/دين) ────────────────────────────────────────
  alert: "#8A1F11",
  alertBg: "#FDECEA",
  alertBorder: "#F0C4BD",

  // ── كهرماني (خصم/ضريبة/حالة جزئية) ────────────────────────────────
  orange: "#92400E",
  orangeLight: "#FDECEA", // للأمانة: التصميم لا يستعمل خلفية كهرمانية، فقط حدود دائرية
  orangePale: "#FCFAF6",
  orangeDark: "#92400E",

  // ── حدود وخلفيات محايدة ───────────────────────────────────────────
  border: "#E7E7E2",
  borderDk: "#6B6E66", // حدود الجداول الداخلية (1.5px)
  borderLight: "#EEEEE9", // خطوط بيانات متقطّعة داخل بطاقات الميتا
  borderMist: "#E2E2DD", // إطار الزخرفة الداخلي على بُعد 24px
  borderLogo: "#D6D6CF",

  // خلفيات
  bg: "#FCFCFA",
  bgWarm: "#FAFAF7",
  zebra: "#F6F6F2", // تناوب صفوف الجدول
  page: "#EAE9E4", // خلفية شاشة المعاينة (خارج الورقة)
  paper: "#FFFFFF",

  white: "#FFFFFF",
};

/**
 * بيانات المنشأة — انتقل مصدر الحقيقة إلى shared/companyIdentity.ts ليشترك فيه الخادم
 * (PDF المستندات الرسمية كان بلا عنوان/هواتف) والعميل. القيم القانونية (ضريبي/سجل/إجازة)
 * قيم افتراضية بانتظار تحديث المالك؛ كل استدعاء طباعة يمكنه تجاوزها عبر `companySettings`.
 */
export const CO = COMPANY_IDENTITY;

/** الأرقام المعروضة في إيصال نقطة البيع (الأقسام الأربعة الأولى) — مصدر واحد للقالب HTML والراسم الحراري */
export const RECEIPT_PHONES = CO.phones.slice(0, 4);

/** HTML-escape helper */
export const esc = (s: unknown): string =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

/** Format number with English locale (comma-separated) */
export const fmt = (n: string | number | null | undefined): string =>
  n == null || n === "" ? "—" : Number(n).toLocaleString("en-US");

/** Format currency in IQD */
export const fmtC = (n: string | number | null | undefined): string =>
  n == null || n === "" ? "—" : `${fmt(n)} د.ع`;

/** Absolute logo URL for use in print windows */
export function logoUrl(): string {
  return typeof window !== "undefined"
    ? `${window.location.origin}/logo.png`
    : "/logo.png";
}

/** Open a print window with given HTML. يعيد false إن حُجبت النافذة المنبثقة (ليُبلَّغ المستخدم). */
let reservedPrintWindow: Window | null = null;

/**
 * Reserve the popup synchronously from the user's "save and print" click.
 * The approved template consumes it after the asynchronous save/navigation.
 */
export function reservePrintWindow(opts = "width=900,height=1100"): boolean {
  if (typeof window === "undefined") return false;
  if (reservedPrintWindow && !reservedPrintWindow.closed)
    reservedPrintWindow.close();
  reservedPrintWindow = window.open("", "_blank", opts);
  if (!reservedPrintWindow) return false;
  reservedPrintWindow.document.write(
    '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>جاري تجهيز المستند</title></head>' +
      '<body style="font-family:Arial,sans-serif;display:grid;place-items:center;min-height:90vh;color:#555">' +
      "<p>جاري حفظ المستند وتجهيز قالب الطباعة المعتمد…</p></body></html>",
  );
  reservedPrintWindow.document.close();
  return true;
}

export function releaseReservedPrintWindow(): void {
  if (reservedPrintWindow && !reservedPrintWindow.closed)
    reservedPrintWindow.close();
  reservedPrintWindow = null;
}

export function openPrintWindow(
  html: string,
  opts = "width=900,height=1100",
): boolean {
  if (typeof window === "undefined") return false;
  const w =
    reservedPrintWindow && !reservedPrintWindow.closed
      ? reservedPrintWindow
      : window.open("", "_blank", opts);
  reservedPrintWindow = null;
  if (!w) return false; // نافذة منبثقة محجوبة ⇒ لم تُفتح الطباعة
  w.document.open();
  w.document.write(html);
  w.document.close();

  // تحصين دفاعي مباشر (Defense-in-Depth):
  // بما أن النافذة فُتحت محلياً من نفس الأصل (about:blank)، يربط المتصل الأحداث برمجياً مباشرة على DOM
  // لضمان استجابة أزرار الشريط (طباعة، حفظ PDF، إغلاق) بنسبة 100% حتى لو عطلت سياسة المتصفح الأحداث المضمنة.
  try {
    const bindToolbar = () => {
      try {
        const doc = w.document;
        if (!doc) return;
        const printBtn = doc.getElementById("doc-btn-print");
        if (printBtn && !(printBtn as any).__bound) {
          (printBtn as any).__bound = true;
          printBtn.addEventListener("click", () => {
            if (typeof (w as any).printDoc === "function") {
              (w as any).printDoc();
            } else {
              w.focus();
              w.print();
            }
          });
        }
        const saveBtn = doc.getElementById("doc-btn-save-pdf");
        if (saveBtn && !(saveBtn as any).__bound) {
          (saveBtn as any).__bound = true;
          saveBtn.addEventListener("click", () => {
            if (typeof (w as any).saveDocAsPdf === "function") {
              (w as any).saveDocAsPdf();
            } else {
              w.print();
            }
          });
        }
        const closeBtn = doc.getElementById("doc-btn-close");
        if (closeBtn && !(closeBtn as any).__bound) {
          (closeBtn as any).__bound = true;
          closeBtn.addEventListener("click", () => {
            if (typeof (w as any).closeDocPreview === "function") {
              (w as any).closeDocPreview();
            } else {
              try {
                w.close();
              } catch {}
            }
          });
        }
      } catch {}
    };
    bindToolbar();
    // تكرار المحاولة لضمان الربط حتى لو استغرق بناء الـ DOM وقتاً في المتصفح
    [50, 150, 300, 600, 1200].forEach((ms) => {
      window.setTimeout(bindToolbar, ms);
    });
  } catch {}

  return true;
}

if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    // حماية ضد Cross-Origin Message Injection: قبول الرسائل من نفس الأصل فقط
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === "CLOSE_PRINT_WINDOW") {
      try {
        if (
          event.source &&
          typeof (event.source as Window).close === "function"
        ) {
          (event.source as Window).close();
        }
      } catch {}
    }
  });
}

/**
 * خط Cairo مستضاف محلياً لقوالب الطباعة (بلا Google Fonts CDN) ⇒ تطبع المستندات بالخط الصحيح **بلا إنترنت**.
 * الملفات في client/public/fonts/ تُخدَم من خادم التطبيق؛ نستعمل أصلاً مطلقاً (origin) لأن نافذة الطباعة
 * تُفتح كـabout:blank فلا تُحلّ المسارات النسبية. لكل وزن: وجهٌ لاتيني (افتراضي) + وجهٌ عربي (بنطاق يونيكود).
 */
export const FONT_ORIGIN =
  typeof window !== "undefined" ? window.location.origin : "";
const CAIRO_ARABIC_RANGE =
  "U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0898-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC";
export const CAIRO_FONT = `<style>${[400, 500, 600, 700, 800, 900]
  .map(
    (w) =>
      `@font-face{font-family:'Cairo';font-style:normal;font-weight:${w};font-display:swap;src:url('${FONT_ORIGIN}/fonts/cairo-latin-${w}-normal.woff2') format('woff2')}` +
      `@font-face{font-family:'Cairo';font-style:normal;font-weight:${w};font-display:swap;src:url('${FONT_ORIGIN}/fonts/cairo-arabic-${w}-normal.woff2') format('woff2');unicode-range:${CAIRO_ARABIC_RANGE}}`,
  )
  .join("")}</style>`;

/**
 * الرابط الإنتاجي الثابت للمتجر الإلكتروني لتضمينه في رمز الاستجابة السريعة (QR) على الإيصالات
 * المطبوعة للزبائن — دائماً الدومين الإنتاجي العام (alarabiya.online/store) حتى وإن طُبع من كاشير محلي.
 */
export const STOREFRONT_URL = "https://alarabiya.online/store";
