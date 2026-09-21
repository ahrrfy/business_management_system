/**
 * storefrontThematicService — محرك التشكيلات التحريرية الذكية والمؤتمتة لمتجر الرؤية العربية.
 *
 * الخوارزمية الذكية:
 * ١. تحلل الكتالوج الفعلي والمخزون الحي لفرع المتجر الإلكتروني.
 * ٢. تصنف المنتجات إلى أنماط دلالية وتسويقية (Executive, Academic, Calligraphy, Deals, Productivity, Creative).
 * ٣. تحسب نقاط الجاذبية والمعدل التنافسي لكل نمط بالاعتماد على:
 *    - عدد المنتجات المتوفرة فعلياً (inStock)
 *    - عمق الخصومات الفعالة (onSale)
 *    - الشريحة السعرية والطلب الموسمي
 * ٤. تستبعد تماماً أي نمط ليس له رصيد متوفر (قاعدة صفر تشكيلات فارغة).
 * ٥. تختار أفضل ٣ تشكيلات بأعلى نقاط وتصيغ نصوص الإجراء وشارات الحالة مع العدد الحقيقي للأصناف.
 * ٦. تدعم الوضع التلقائي الذكي (Auto Mode) والوضع التحريري المخصص (Custom Mode) عبر storeSettings.
 */

import { eq } from "drizzle-orm";
import { storeSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { resolveStorefrontBranchId, storefrontCatalog } from "./storefrontService";
import { createTtlCache } from "../lib/ttlCache";
import { withTx } from "./tx";
import { normalizeArabicSearch } from "../../shared/storefrontSearchNormalize";

export type ThematicFilterType = "category" | "keyword" | "deal";

export interface ThematicCollectionCard {
  id: string;
  tag: string;
  title: string;
  description: string;
  cta: string;
  bgGradient: string;
  borderColor: string;
  iconName: "Briefcase" | "GraduationCap" | "PenTool" | "Tag" | "LayoutGrid" | "Palette" | "BookOpen" | "Sparkles";
  filterType: ThematicFilterType;
  filterValue: string;
  itemCount: number;
  productIds?: number[];
  sampleProductNames?: string[];
  score?: number;
}

export interface ThematicCollectionsConfig {
  mode: "AUTO" | "CUSTOM";
  customCards?: ThematicCollectionCard[];
  updatedAt?: string;
}

export interface ThematicArchetype {
  id: string;
  tag: string;
  title: string;
  description: string;
  ctaPrefix: string;
  bgGradient: string;
  borderColor: string;
  iconName: ThematicCollectionCard["iconName"];
  defaultFilterType: ThematicFilterType;
  defaultFilterValue: string;
  baseWeight: number;
  minRelevanceThreshold: number;
  positiveKeywords: Array<{ word: string; weight: number }>;
  negativeKeywords: string[];
  negativeCategories?: string[];
  preferredCategories: string[];
  requireSaleOrBundle?: boolean;
}

export const THEMATIC_ARCHETYPES: readonly ThematicArchetype[] = [
  {
    id: "calligraphy",
    tag: "مختارات النخبة",
    title: "أناقة الحرف وهواة الحبر العربي",
    description: "أقلام حبر سائل ألمانية، دفاتر مخطوطات، ومحابر كلاسيكية صُممت لعشاق التفاصيل والخط الأصيل.",
    ctaPrefix: "تصفح أدوات الخط",
    bgGradient: "from-amber-950/80 via-slate-900 to-slate-950",
    borderColor: "border-amber-500/30 hover:border-amber-500/60",
    iconName: "PenTool",
    defaultFilterType: "category",
    defaultFilterValue: "2",
    baseWeight: 28,
    minRelevanceThreshold: 40,
    positiveKeywords: [
      { word: "حبر خط", weight: 50 },
      { word: "حبر عربي", weight: 50 },
      { word: "حبر صيني", weight: 50 },
      { word: "حبر سائل", weight: 45 },
      { word: "قلم حبر", weight: 45 },
      { word: "حبر قلم", weight: 45 },
      { word: "قلم خط", weight: 45 },
      { word: "ريشة خط", weight: 45 },
      { word: "سيت قلم ريشة", weight: 45 },
      { word: "قلم ريشة", weight: 45 },
      { word: "قلم حبر زجاجي", weight: 45 },
      { word: "طقم تحبير هندسي", weight: 45 },
      { word: "محبرة", weight: 45 },
      { word: "روترينغ", weight: 45 },
      { word: "رابيدوغراف", weight: 45 },
      { word: "كاليجرافي", weight: 45 },
      { word: "مخطوطات", weight: 40 },
      { word: "مخطوط", weight: 40 },
      { word: "قلم تحبير", weight: 40 },
      { word: "تحبير هندسي", weight: 40 },
      { word: "باركر", weight: 30 },
      { word: "ريشة", weight: 25 },
      { word: "قلم توقيع", weight: 25 },
      { word: "سيغنو", weight: 20 },
      { word: "يوني بول", weight: 20 },
    ],
    negativeKeywords: [
      "طابعة", "طابعات", "طابعه", "ايبسون", "ابسون", "epson", "كانون", "canon", "اتش بي", "hp", "براذر", "brother",
      "تونر", "toner", "انك جيت", "inkjet", "سولفنت", "solvent", "فلات بد", "flatbed", "uv", "vivid", "فيفيد", "جوكر",
      "ختم", "أختام", "اختام", "ستمبة", "ستمبه", "colop", "shiny", "حبر سحري", "بصمة", "بصمات",
      "سبورة", "سبوره", "مساحة حبر", "فرشة حبر", "تصحيح", "مصحح", "whiteout", "correction",
      "مدرسي", "طالب", "تظليل", "فسفوري", "هايلايت", "ممحاة", "براية", "مقلمة",
      "حقيبة ظهر", "صلصال", "تلوين اطفال", "خرامة", "كباسة", "حامل كمبيوتر", "درع زجاجي"
    ],
    negativeCategories: [
      "التجهيزات الالكترونية والكهربائية",
      "الاختام التجارية والشخصية والشركات",
      "المواد الخام",
      "السبورات بكافة احجامها وملحقاتها",
      "مستهلكات الطباعة",
      "استنساخ وطباعة",
    ],
    preferredCategories: ["أقلام وأدوات كتابة", "اقلام الحبر"],
  },
  {
    id: "executive",
    tag: "إصدار الإهداء الفاخر",
    title: "تجهيزات المكاتب القيادية والأعمال",
    description: "علب هدايا ملكية متكاملة، حوامل حواسيب ألمنيوم، وأقلام توقيع رسمية تليق بأفخم المكاتب.",
    ctaPrefix: "مختارات المكاتب",
    bgGradient: "from-emerald-950/80 via-slate-900 to-slate-950",
    borderColor: "border-emerald-500/30 hover:border-emerald-500/60",
    iconName: "Briefcase",
    defaultFilterType: "category",
    defaultFilterValue: "6",
    baseWeight: 26,
    minRelevanceThreshold: 30,
    positiveKeywords: [
      { word: "طقم منظم مكتب", weight: 45 },
      { word: "منظم مكتب معدني", weight: 45 },
      { word: "صندوق هدايا", weight: 40 },
      { word: "ملكي", weight: 40 },
      { word: "فاخر", weight: 35 },
      { word: "حامل كمبيوتر", weight: 35 },
      { word: "ألمنيوم", weight: 30 },
      { word: "درع زجاجي", weight: 30 },
      { word: "باركر", weight: 25 },
      { word: "مفكرة جلدية", weight: 25 },
      { word: "تخطيط مهام", weight: 20 },
      { word: "كباسة مكتبية معدنية", weight: 20 },
      { word: "خرامة أوراق معدنية", weight: 20 },
    ],
    negativeKeywords: [
      "مدرسي", "طالب", "روضة", "اطفال", "أطفال", "حقيبة ظهر", "مقلمة", "تلوين", "رسم مائي",
      "كانسون", "علبة هندسة", "دفتر 40", "دفتر ٤٠", "باكيت", "لعبة", "العاب", "ألعاب"
    ],
    preferredCategories: ["تجهيزات ومستلزمات مكتبية", "بكجات وهدايا راقية"],
  },
  {
    id: "academic",
    tag: "الأعلى طلباً للموسم",
    title: "حقيبة التفوق الأكاديمي والجامعي",
    description: "دفاتر سلك فاخرة، أقلام تظليل مقاومة للنزف، ومنظمات مدمجة تُعينك على إتقان مهامك ومحاضراتك.",
    ctaPrefix: "تجهيزات الدراسة",
    bgGradient: "from-blue-950/80 via-slate-900 to-slate-950",
    borderColor: "border-blue-500/30 hover:border-blue-500/60",
    iconName: "GraduationCap",
    defaultFilterType: "category",
    defaultFilterValue: "3",
    baseWeight: 30,
    minRelevanceThreshold: 30,
    positiveKeywords: [
      { word: "دفاتر سلك", weight: 45 },
      { word: "دفتر سلك", weight: 45 },
      { word: "علبة هندسة", weight: 45 },
      { word: "طقم أقلام تظليل", weight: 45 },
      { word: "حقيبة ظهر", weight: 40 },
      { word: "مقلمة", weight: 40 },
      { word: "جامعي", weight: 40 },
      { word: "مدرسي", weight: 35 },
      { word: "طالب", weight: 35 },
      { word: "تظليل", weight: 35 },
      { word: "دفتر", weight: 25 },
      { word: "قلم رصاص ميكانيكي", weight: 25 },
      { word: "باستيل", weight: 20 },
      { word: "ستيدلر", weight: 20 },
    ],
    negativeKeywords: [
      "ملكي فاخر", "صندوق هدايا مكتبي", "درع زجاجي", "حامل كمبيوتر",
      "اطفال", "أطفال", "روضة", "صلصال", "العاب", "لعبة", "اونو",
      "طابعة", "حبر طابعة", "ستمبة", "ختم"
    ],
    preferredCategories: ["دفاتر ومذكرات", "حقائب ومقالم مدرسية"],
  },
  {
    id: "deals",
    tag: "توفير موسمي خاص",
    title: "بكجات التوفير والمجموعات المتكاملة",
    description: "حزم شاملة وعروض ترويجية بخصومات حقيقية تمنحك أقصى قيمة وأعلى توفير على تشكيلاتك المفضلة.",
    ctaPrefix: "اكتشف العروض",
    bgGradient: "from-orange-950/80 via-slate-900 to-slate-950",
    borderColor: "border-orange-500/30 hover:border-orange-500/60",
    iconName: "Tag",
    defaultFilterType: "deal",
    defaultFilterValue: "deals",
    baseWeight: 35,
    minRelevanceThreshold: 35,
    requireSaleOrBundle: true,
    positiveKeywords: [
      { word: "بكج", weight: 45 },
      { word: "باقة", weight: 45 },
      { word: "طقم متكامل", weight: 40 },
      { word: "مجموعة متكاملة", weight: 40 },
      { word: "شنطة متكاملة", weight: 40 },
      { word: "حقيبة متكاملة", weight: 40 },
      { word: "سيت متكامل", weight: 40 },
      { word: "عرض توفير", weight: 35 },
      { word: "بكج توفير", weight: 35 },
      { word: "باك", weight: 30 },
      { word: "طقم", weight: 25 },
      { word: "مجموعة", weight: 25 },
      { word: "توفير", weight: 25 },
    ],
    negativeKeywords: [
      "باكيت", "باكت", "درزن",
      "اطفال", "أطفال", "طفل", "كيدز", "kids", "panter kids", "panter", "تلوين اطفال", "بخ تلوين",
      "لعبة", "العاب", "ألعاب", "بزل", "اونو", "ورق لعب", "بوكر", "حية ودرج", "ليدو", "دومينو", "كارتات", "صلصال", "سلايم",
      "طابعة", "حبر طابعة", "ستمبة", "ختم", "أختام"
    ],
    negativeCategories: [
      "تجهيزات الالعاب",
      "العاب الذكاء",
    ],
    preferredCategories: ["بكجات وهدايا راقية"],
  },
  {
    id: "productivity",
    tag: "إنجاز يومي متكامل",
    title: "تنظيم مساحة العمل والإنتاجية المكتبية",
    description: "منظمات شبكية، حوامل مرنة، وكباسات معدنية تضمن ترتيباً مثالياً لمكتبك وسرعة إنجازك اليومي.",
    ctaPrefix: "أدوات الإنتاجية",
    bgGradient: "from-teal-950/80 via-slate-900 to-slate-950",
    borderColor: "border-teal-500/30 hover:border-teal-500/60",
    iconName: "LayoutGrid",
    defaultFilterType: "category",
    defaultFilterValue: "4",
    baseWeight: 22,
    minRelevanceThreshold: 30,
    positiveKeywords: [
      { word: "طقم منظم مكتب", weight: 45 },
      { word: "منظم مكتب", weight: 40 },
      { word: "كباسة مكتبية", weight: 40 },
      { word: "خرامة أوراق", weight: 40 },
      { word: "تخطيط مهام", weight: 40 },
      { word: "شبكي", weight: 40 },
      { word: "كباسة", weight: 35 },
      { word: "خرامة", weight: 35 },
      { word: "حامل كمبيوتر", weight: 35 },
      { word: "نوتبوك", weight: 20 },
      { word: "مكتبي", weight: 20 },
      { word: "معدني", weight: 20 },
    ],
    negativeKeywords: [
      "مدرسي", "حقيبة ظهر", "مقلمة", "تلوين", "كانسون", "رسم مائي", "علبة هندسة", "درع زجاجي",
      "العاب", "لعبة", "اطفال", "أطفال", "صلصال", "طابعة", "حبر طابعة"
    ],
    preferredCategories: ["تجهيزات ومستلزمات مكتبية"],
  },
  {
    id: "creative",
    tag: "إلهام وفنون راقية",
    title: "مرسم المبدعين ومستلزمات الفنون",
    description: "كراسات رسم مائية عالية الكثافة، ألوان باستيل ناعمة، وأقلام تلوين هندسية لأصحاب الذوق الفني.",
    ctaPrefix: "تصفح أدوات الرسم",
    bgGradient: "from-rose-950/80 via-slate-900 to-slate-950",
    borderColor: "border-rose-500/30 hover:border-rose-500/60",
    iconName: "Palette",
    defaultFilterType: "keyword",
    defaultFilterValue: "رسم",
    baseWeight: 20,
    minRelevanceThreshold: 30,
    positiveKeywords: [
      { word: "تحبير هندسي", weight: 45 },
      { word: "رسم مائي", weight: 45 },
      { word: "كراس رسم", weight: 45 },
      { word: "كانسون", weight: 45 },
      { word: "رسم", weight: 40 },
      { word: "مائي", weight: 40 },
      { word: "باستيل", weight: 35 },
      { word: "فني", weight: 35 },
      { word: "روترينغ", weight: 35 },
      { word: "تلوين", weight: 25 },
      { word: "ستيدلر", weight: 20 },
      { word: "قلم رصاص ميكانيكي", weight: 25 },
      { word: "كراس", weight: 25 },
    ],
    negativeKeywords: [
      "اطفال", "أطفال", "طفل", "طفلة", "روضة", "روضه", "تمهيدي", "صغار", "بيبي", "baby",
      "كيدز", "kids", "kid", "panter kids", "panter", "العاب", "ألعاب", "لعبة", "بازل",
      "تلوين اطفال", "بخ تلوين", "بخاخ تلوين", "الوان اصابع", "صلصال", "سلايم",
      "كباسة", "خرامة", "حامل كمبيوتر", "درع زجاجي", "صندوق هدايا مكتبي", "حقيبة ظهر مدرسية",
      "طابعة", "حبر طابعة", "ستمبة", "ختم", "أختام"
    ],
    preferredCategories: ["دفاتر ومذكرات", "أقلام وأدوات كتابة", "مستلزمات وادوات الرسم والفن"],
  },
];

const THEMATIC_CACHE_TTL_MS = 5 * 60 * 1000; // 5 دقائق
const thematicCache = createTtlCache<string, ThematicCollectionCard[]>({ ttlMs: THEMATIC_CACHE_TTL_MS, maxEntries: 20 });

/** توحيد الأرقام المشرقية (٠-٩) إلى أرقام لاتينية (0-9) */
function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

/**
 * تطبيع دلالي موحّد للنصوص: توحيد الأحرف العربية والأرقام وعزل الرموز والواصلات
 * بمسافات لضمان دقة استخراج الرموز (Tokens) وحدود الكلمات.
 */
export function normalizeThematicText(text: string): string {
  if (!text) return "";
  let norm = normalizeArabicSearch(text);
  norm = normalizeDigits(norm);
  norm = norm.replace(/[\/\\()\[\]{}*+\-_:;,."'`!?<>~#@%^&=]/g, " ");
  return norm.replace(/\s+/g, " ").trim();
}

/** استخراج مجموعة الرموز والكلمات المستقلة من النص */
export function extractWordTokens(normText: string): Set<string> {
  if (!normText) return new Set();
  return new Set(normText.split(/\s+/).filter(Boolean));
}

/** فحص وجود كلمة كاملة كرمز مستقل (Word Boundary Token Match) */
export function hasWordToken(tokens: Set<string>, targetWord: string): boolean {
  const normTarget = normalizeThematicText(targetWord);
  return tokens.has(normTarget);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * فحص وجود عبارة أو تركيب مركب أو كلمة مفردة بحدود كلمات صريحة
 * لا يبتلع الكلمات المشابهة جزئياً (مثال: «باك» لا تطابق «باكيت» ولا «شباك»).
 */
export function hasPhrase(normText: string, phrase: string): boolean {
  const normPhrase = normalizeThematicText(phrase);
  if (!normPhrase) return false;
  const parts = normPhrase.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length === 1) {
    return extractWordTokens(normText).has(parts[0]);
  }
  const pattern = new RegExp(`(^|\\s)${parts.map(escapeRegExp).join("\\s+")}($|\\s)`);
  return pattern.test(normText);
}

const TOY_AND_GAME_TERMS = [
  "لعبة", "العاب", "ألعاب", "بزل", "اونو", "ورق لعب", "بوكر", "حية ودرج", "ليدو", "دومينو", "كارتات", "صلصال", "سلايم",
  "اطفال", "أطفال", "طفل", "طفلة", "روضة", "روضه", "صغار", "بيبي", "baby", "كيدز", "kids", "kid", "panter kids", "panter",
  "تلوين اطفال", "بخ تلوين", "بخاخ تلوين"
];

const PACKET_AND_SINGLE_UNITS = [
  "باكيت", "باكت", "درزن"
];

const BUNDLE_POSITIVE_PHRASES = [
  "طقم متكامل", "مجموعة متكاملة", "شنطة متكاملة", "حقيبة متكاملة", "سيت متكامل", "عرض توفير", "بكج توفير"
];

const BUNDLE_POSITIVE_TOKENS = [
  "بكج", "باقة"
];

/**
 * التحقق الدلالي من كون الصنف حزمة ترويجية حقيقية (Bundle) وليس عبوة تجزئة مفردة:
 * ١. يستبعد قطعياً وحدات وعبارات التجزئة الفردية («باكيت»، «باكت»، «درزن»).
 * ٢. يستبعد قطعياً ألعاب الأطفال والتسلية والورق.
 * ٣. يقبل الحزم الصريحة: إما isBundle===true، أو توكنز الباقة/البكج، أو التراكيب المركبة («طقم متكامل»، «مجموعة متكاملة»).
 */
export function isQualifiedBundle(item: {
  productName: string;
  category?: string | null;
  unitName?: string | null;
  isBundle?: boolean;
}): boolean {
  const normName = normalizeThematicText(item.productName || "");
  const normCat = normalizeThematicText(item.category || "");
  const normUnit = normalizeThematicText(item.unitName || "");
  const nameTokens = extractWordTokens(normName);

  // ١. استبعاد فوري لألعاب الأطفال والتسلية وفئاتها
  for (const toy of TOY_AND_GAME_TERMS) {
    if (hasPhrase(normName, toy) || hasPhrase(normCat, toy)) {
      return false;
    }
  }

  // ٢. استبعاد عبوات التجزئة الفردية ووحدات الباكيت والدرزن
  for (const unit of PACKET_AND_SINGLE_UNITS) {
    if (hasWordToken(nameTokens, unit) || normUnit === normalizeThematicText(unit)) {
      return false;
    }
  }

  // ٣. التحقق الإيجابي: الحزم المعتمدة نظامياً
  if (item.isBundle === true) {
    return true;
  }

  // توكنز البكجات الصريحة
  for (const tok of BUNDLE_POSITIVE_TOKENS) {
    if (hasWordToken(nameTokens, tok) || normUnit === normalizeThematicText(tok)) {
      return true;
    }
  }

  // التراكيب العبارية الصريحة
  for (const phrase of BUNDLE_POSITIVE_PHRASES) {
    if (hasPhrase(normName, phrase)) {
      return true;
    }
  }

  // توكن "باك" المنفصل (يُقبل فقط كتوكن مستقل متى ما اقترن بدلالة حزمة متعددة ولا يطابق باكيت)
  if (hasWordToken(nameTokens, "باك")) {
    if (hasPhrase(normName, "مجموعة") || hasPhrase(normName, "دفاتر") || hasPhrase(normName, "اقلام") || normUnit === "باقة" || normUnit === "باقه") {
      return true;
    }
  }

  return false;
}

/**
 * احتساب درجة الملاءمة الدلالية لصنف معين بالنسبة لنمط تحريري:
 * - فحص الاستبعاد الفئوي أولاً (Negative Categories).
 * - فحص الكلمات والعبارات المستبعدة بحدود الكلمات (Whole-Token / Phrase Boundaries).
 * - اشتراط حزمة حقيقية لنمط deals واستبعاد ألعاب التسلية وعبوات التجزئة.
 * - احتساب أوزان التراكيب الصريحة والكلمات المفتاحية الموزونة.
 */
export function calculateProductRelevance(
  item: {
    productName: string;
    description?: string | null;
    category?: string | null;
    salePrice?: string | null;
    price?: string | null;
    isBundle?: boolean;
    imageUrl?: string | null;
    unitName?: string | null;
  },
  arch: ThematicArchetype
): number {
  const normName = normalizeThematicText(item.productName || "");
  const normDesc = normalizeThematicText(item.description || "");
  const normCat = normalizeThematicText(item.category || "");
  const fullText = `${normName} ${normDesc}`.trim();

  // ١. فحص الاستبعاد الفئوي الصارم أولاً
  if (arch.negativeCategories && arch.negativeCategories.length > 0) {
    for (const negCat of arch.negativeCategories) {
      if (hasPhrase(normCat, negCat)) {
        return -100;
      }
    }
  }

  // ٢. فحص الاستبعادات الصارمة للكلمات والعبارات
  for (const neg of arch.negativeKeywords) {
    if (hasPhrase(fullText, neg) || hasPhrase(normCat, neg)) {
      return -100;
    }
  }

  // ٣. شرط العروض والبكجات الحقيقية
  if (arch.requireSaleOrBundle) {
    const hasDiscount = item.salePrice != null && Number(item.salePrice) < Number(item.price);
    const bundlePass = isQualifiedBundle(item);

    if (!bundlePass && !hasDiscount) {
      return -100;
    }

    // حتى مع وجود خصم، نمنع ألعاب التسلية وعبوات الباكيت الفردية من تصدر كرت البكجات
    if (!bundlePass) {
      const nameTokens = extractWordTokens(normName);
      const isSinglePacketOrToy =
        PACKET_AND_SINGLE_UNITS.some((u) => hasWordToken(nameTokens, u) || item.unitName === u) ||
        TOY_AND_GAME_TERMS.some((t) => hasPhrase(normName, t) || hasPhrase(normCat, t));
      if (isSinglePacketOrToy) {
        return -100;
      }
    }
  }

  let score = 0;

  // ٤. مطابقة الكلمات والتراكيب الإيجابية بحدود الكلمات الصارمة
  for (const pos of arch.positiveKeywords) {
    if (hasPhrase(fullText, pos.word)) {
      score += pos.weight;
    }
  }

  // ٥. الفئات الداعمة المفضلة
  for (const cat of arch.preferredCategories) {
    if (hasPhrase(normCat, cat)) {
      score += 15;
    }
  }

  // ٦. نقاط تفضيلية للعروض ووجود الصورة
  if (item.salePrice != null && Number(item.salePrice) < Number(item.price)) {
    score += 10;
  }
  if (item.imageUrl) {
    score += 5;
  }

  return score;
}

/** قراءة الإعدادات الحالية من قاعدة البيانات */
export async function getThematicCollectionsConfig(): Promise<ThematicCollectionsConfig> {
  const db = getDb();
  if (!db) return { mode: "AUTO" };

  const rows = await db
    .select({ config: storeSettings.thematicCollectionsConfig })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1))
    .limit(1);

  const raw = rows[0]?.config;
  if (!raw) return { mode: "AUTO" };

  try {
    const parsed = JSON.parse(raw) as ThematicCollectionsConfig;
    return {
      mode: parsed.mode === "CUSTOM" ? "CUSTOM" : "AUTO",
      customCards: Array.isArray(parsed.customCards) ? parsed.customCards : undefined,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return { mode: "AUTO" };
  }
}

/** تحديث إعدادات التشكيلات التحريرية من لوحة الإدارة */
export async function updateThematicCollectionsConfig(
  input: ThematicCollectionsConfig,
  userId?: number
): Promise<{ ok: boolean }> {
  return withTx(async (tx) => {
    const serialized = JSON.stringify({
      mode: input.mode,
      customCards: input.customCards,
      updatedAt: new Date().toISOString(),
    });

    await tx
      .update(storeSettings)
      .set({
        thematicCollectionsConfig: serialized,
        updatedBy: userId ?? null,
      })
      .where(eq(storeSettings.id, 1));

    // إبطال الكاش فورياً بعد التحديث
    thematicCache.clear();
    return { ok: true };
  }, { gate: "NONE" });
}

/** الخوارزمية الذكية: فحص الكتالوج وتوليد أفضل ٣ تشكيلات متوفرة برصيد حقيقي ومعرفات دقيقة */
export async function computeAlgorithmicThematicCollections(
  branchId?: number | null
): Promise<ThematicCollectionCard[]> {
  const resolvedBranchId = await resolveStorefrontBranchId(branchId ?? undefined);
  const cacheKey = `thematic_branch_${resolvedBranchId}`;

  return thematicCache.get(cacheKey, async () => {
    // جلب كافة المنتجات المنشورة في الكتالوج
    const catalogPage = await storefrontCatalog({
      branchId: resolvedBranchId,
      limit: 120,
      availability: "ALL",
    });

    const allItems = catalogPage.items;
    if (allItems.length === 0) {
      return [];
    }

    // مصفوفة تقييم الأنماط
    const evaluatedArchetypes: ThematicCollectionCard[] = [];

    for (const arch of THEMATIC_ARCHETYPES) {
      // احتساب الصلة الحبيبية الدقيقة لكل منتج
      const matchedWithScores = allItems
        .map((item) => ({
          item,
          relevance: calculateProductRelevance(item, arch),
        }))
        .filter((entry) => entry.relevance >= arch.minRelevanceThreshold && entry.item.inStock);

      // ترتيب المنتجات داخل التشكيلة تنازلياً حسب درجة الصلة الدلالية وجودة العرض
      matchedWithScores.sort((a, b) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance;
        const aSale = a.item.salePrice != null ? 1 : 0;
        const bSale = b.item.salePrice != null ? 1 : 0;
        return bSale - aSale;
      });

      const inStockItems = matchedWithScores.map((e) => e.item);
      const inStockCount = inStockItems.length;

      // قاعدة استبعاد التشكيلات الصفرية (Zero-Empty Policy)
      if (inStockCount === 0) {
        continue;
      }

      const onSaleCount = inStockItems.filter(
        (i) => i.salePrice != null && Number(i.salePrice) < Number(i.price)
      ).length;

      // حساب النقاط بحد تشبع للمخزون مع وزن نوعي ومكافأة للعروض
      const saturationCount = Math.min(inStockCount, 12);
      const avgRelevance = Math.round(
        matchedWithScores.reduce((sum, e) => sum + e.relevance, 0) / inStockCount
      );
      const score = saturationCount * 10 + Math.min(inStockCount, 30) * 2 + onSaleCount * 15 + avgRelevance + arch.baseWeight;

      // صياغة نص الإجراء المتضمن لعدد المنتجات
      const cta = `${arch.ctaPrefix} (${inStockCount})`;

      evaluatedArchetypes.push({
        id: arch.id,
        tag: onSaleCount > 0 ? `عروض خاصة (${onSaleCount})` : arch.tag,
        title: arch.title,
        description: arch.description,
        cta,
        bgGradient: arch.bgGradient,
        borderColor: arch.borderColor,
        iconName: arch.iconName,
        filterType: arch.defaultFilterType,
        filterValue: arch.defaultFilterValue,
        itemCount: inStockCount,
        productIds: inStockItems.map((i) => i.productId),
        sampleProductNames: inStockItems.slice(0, 3).map((i) => i.productName),
        score,
      });
    }

    // ترتيب الأنماط تنازلياً حسب النقاط واختيار أفضل ٣
    evaluatedArchetypes.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return evaluatedArchetypes.slice(0, 3);
  });
}

/** استرجاع التشكيلات الفعالة لواجهة المتجر (يراعي وضع AUTO أو CUSTOM) */
export async function getStorefrontThematicCollections(
  branchId?: number | null
): Promise<ThematicCollectionCard[]> {
  const config = await getThematicCollectionsConfig();

  if (config.mode === "CUSTOM" && config.customCards && config.customCards.length > 0) {
    // تصفية أي بطاقات مخصصة ليس بها رصيد حقيقي لحماية قاعدة صفر تشكيلات فارغة
    const validCards = config.customCards.filter((c) => (c.itemCount ?? 0) > 0);
    if (validCards.length > 0) {
      return validCards.map((c) => ({ ...c, productIds: c.productIds ?? [] }));
    }
  }

  return computeAlgorithmicThematicCollections(branchId);
}
