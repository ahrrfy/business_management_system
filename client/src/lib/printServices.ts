/**
 * أيقونات/علامات خدمات الطباعة — عرض فقط (مفاتيح SKU المبذورة في server/seedPrintPos.ts).
 * فصل العرض عن البيانات: السعر/الفئة من الخادم، والأيقونة هنا (لا تلوّث جدول المنتجات).
 */
const SERVICE_ICON: Record<string, string> = {
  "PSVC-CP-A4-BW": "📄", "PSVC-CP-A4-CLR": "🌈", "PSVC-CP-A3-BW": "📄", "PSVC-CP-A3-CLR": "🌈",
  "PSVC-CP-WA-BW": "💬", "PSVC-CP-WA-CLR": "💬",
  "PSVC-PH-ID": "🪪", "PSVC-PH-DOC": "🖼️", "PSVC-PH-10X15": "📷", "PSVC-PH-A4": "📸",
  "PSVC-ES-FORM": "📝", "PSVC-ES-BOOK": "📅", "PSVC-ES-UPLOAD": "☁️", "PSVC-ES-PAY": "💳",
  "PSVC-DS-TYPE": "⌨️", "PSVC-DS-EXCEL": "📊", "PSVC-DS-DESIGN": "🎨", "PSVC-DS-RESEARCH": "📑",
  "PSVC-FN-LAM": "🛡️", "PSVC-FN-BIND": "🌀", "PSVC-FN-CUT": "✂️",
};

/** خدمات سعرها يدوي (يُدخله الموظف لحظة البيع) — يُركّز حقل السعر تلقائياً وتظهر شارة. */
const CUSTOM_PRICE_SKUS = new Set(["PSVC-DS-EXCEL", "PSVC-DS-DESIGN"]);

const CATEGORY_ICON: Record<string, string> = {
  "استنساخ وطباعة": "📄", "طباعة صور": "🖼️", "خدمات إلكترونية": "🌐", "تنضيد وتصميم": "⌨️", "تغليف وإنهاء": "📎",
};

export const serviceIcon = (sku: string): string => SERVICE_ICON[sku] ?? "🧾";
export const isCustomPriceSku = (sku: string): boolean => CUSTOM_PRICE_SKUS.has(sku);
export const categoryIcon = (name: string | null | undefined): string => (name ? CATEGORY_ICON[name] : undefined) ?? "🗂️";
