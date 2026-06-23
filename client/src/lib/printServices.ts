/**
 * أيقونات/علامات خدمات الطباعة — عرض فقط (مفاتيح SKU المبذورة في server/seedPrintPos.ts).
 * فصل العرض عن البيانات: السعر/الفئة من الخادم، والأيقونة هنا (لا تلوّث جدول المنتجات).
 * تعيد مُكَوّن Lucide ⇒ مُتَّسِق عَبر كل المَنَصّات (لا إيموجي مَنصّي).
 */
import {
  FileText, Palette, MessageSquare, IdCard, Image as ImageIcon, Camera,
  FilePen, CalendarDays, Cloud, CreditCard, Keyboard, BarChart3, FileStack,
  Shield, RotateCw, Scissors, Receipt, Copy, Globe, Paperclip, FolderOpen,
  type LucideIcon,
} from "lucide-react";

const SERVICE_ICON: Record<string, LucideIcon> = {
  "PSVC-CP-A4-BW":  FileText,  "PSVC-CP-A4-CLR":  Palette,    "PSVC-CP-A3-BW": FileText,  "PSVC-CP-A3-CLR": Palette,
  "PSVC-CP-WA-BW":  MessageSquare, "PSVC-CP-WA-CLR": MessageSquare,
  "PSVC-PH-ID":     IdCard,    "PSVC-PH-DOC":     ImageIcon,  "PSVC-PH-10X15": Camera,    "PSVC-PH-A4":     Camera,
  "PSVC-ES-FORM":   FilePen,   "PSVC-ES-BOOK":    CalendarDays, "PSVC-ES-UPLOAD": Cloud,  "PSVC-ES-PAY":    CreditCard,
  "PSVC-DS-TYPE":   Keyboard,  "PSVC-DS-EXCEL":   BarChart3,  "PSVC-DS-DESIGN": Palette,  "PSVC-DS-RESEARCH": FileStack,
  "PSVC-FN-LAM":    Shield,    "PSVC-FN-BIND":    RotateCw,   "PSVC-FN-CUT":   Scissors,
};

/** خدمات سعرها يدوي (يُدخله الموظف لحظة البيع) — يُركّز حقل السعر تلقائياً وتظهر شارة. */
const CUSTOM_PRICE_SKUS = new Set(["PSVC-DS-EXCEL", "PSVC-DS-DESIGN"]);

const CATEGORY_ICON: Record<string, LucideIcon> = {
  "استنساخ وطباعة": Copy,
  "طباعة صور": ImageIcon,
  "خدمات إلكترونية": Globe,
  "تنضيد وتصميم": Keyboard,
  "تغليف وإنهاء": Paperclip,
};

export const serviceIcon = (sku: string): LucideIcon => SERVICE_ICON[sku] ?? Receipt;
export const isCustomPriceSku = (sku: string): boolean => CUSTOM_PRICE_SKUS.has(sku);
export const categoryIcon = (name: string | null | undefined): LucideIcon => (name ? CATEGORY_ICON[name] : undefined) ?? FolderOpen;
