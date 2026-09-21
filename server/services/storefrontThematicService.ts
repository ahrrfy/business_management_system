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

interface ThematicArchetype {
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
  preferredCategories: string[];
  requireSaleOrBundle?: boolean;
}

const THEMATIC_ARCHETYPES: readonly ThematicArchetype[] = [
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
    minRelevanceThreshold: 20,
    positiveKeywords: [
      { word: "روترينغ", weight: 45 },
      { word: "رابيدوغراف", weight: 45 },
      { word: "تحبير", weight: 40 },
      { word: "حبر", weight: 30 },
      { word: "خط", weight: 35 },
      { word: "باركر", weight: 30 },
      { word: "كاليجرافي", weight: 40 },
      { word: "مخطوط", weight: 40 },
      { word: "محبرة", weight: 40 },
      { word: "ريشة", weight: 35 },
      { word: "قلم توقيع", weight: 30 },
      { word: "جيل", weight: 20 },
      { word: "سيغنو", weight: 25 },
      { word: "يوني بول", weight: 20 },
      { word: "مفكرة جلدية", weight: 20 },
    ],
    negativeKeywords: [
      "مدرسي", "طالب", "تظليل", "فسفوري", "هايلايت", "ممحاة", "براية", "مقلمة",
      "حقيبة ظهر", "صلصال", "تلوين اطفال", "خرامة", "كباسة", "حامل كمبيوتر", "درع زجاجي"
    ],
    preferredCategories: ["أقلام وأدوات كتابة"],
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
    minRelevanceThreshold: 20,
    positiveKeywords: [
      { word: "ملكي", weight: 40 },
      { word: "فاخر", weight: 35 },
      { word: "صندوق هدايا", weight: 40 },
      { word: "حامل كمبيوتر", weight: 35 },
      { word: "ألمنيوم", weight: 30 },
      { word: "طقم منظم مكتب", weight: 40 },
      { word: "منظم مكتب معدني", weight: 40 },
      { word: "درع زجاجي", weight: 30 },
      { word: "باركر", weight: 25 },
      { word: "مفكرة جلدية", weight: 25 },
      { word: "تخطيط مهام", weight: 20 },
      { word: "كباسة مكتبية معدنية", weight: 20 },
      { word: "خرامة أوراق معدنية", weight: 20 },
    ],
    negativeKeywords: [
      "مدرسي", "طالب", "روضة", "اطفال", "حقيبة ظهر", "مقلمة", "تلوين", "رسم مائي",
      "كانسون", "علبة هندسة", "دفتر ٤٠"
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
    minRelevanceThreshold: 20,
    positiveKeywords: [
      { word: "جامعي", weight: 40 },
      { word: "مدرسي", weight: 35 },
      { word: "طالب", weight: 40 },
      { word: "دفاتر سلك", weight: 40 },
      { word: "دفتر سلك", weight: 40 },
      { word: "دفتر", weight: 20 },
      { word: "تظليل", weight: 40 },
      { word: "باستيل", weight: 20 },
      { word: "ستيدلر", weight: 20 },
      { word: "حقيبة ظهر", weight: 40 },
      { word: "مقلمة", weight: 40 },
      { word: "علبة هندسة", weight: 40 },
      { word: "قلم رصاص ميكانيكي", weight: 25 },
    ],
    negativeKeywords: [
      "ملكي فاخر", "صندوق هدايا مكتبي", "درع زجاجي", "حامل كمبيوتر"
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
    minRelevanceThreshold: 15,
    requireSaleOrBundle: true,
    positiveKeywords: [
      { word: "بكج", weight: 45 },
      { word: "باك", weight: 40 },
      { word: "طقم", weight: 30 },
      { word: "مجموعة", weight: 30 },
      { word: "عرض", weight: 30 },
      { word: "توفير", weight: 35 },
    ],
    negativeKeywords: [],
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
    minRelevanceThreshold: 20,
    positiveKeywords: [
      { word: "منظم مكتب", weight: 40 },
      { word: "شبكي", weight: 40 },
      { word: "كباسة", weight: 40 },
      { word: "خرامة", weight: 40 },
      { word: "تخطيط مهام", weight: 40 },
      { word: "حامل كمبيوتر", weight: 35 },
      { word: "نوتبوك", weight: 20 },
      { word: "مكتبي", weight: 20 },
      { word: "معدني", weight: 20 },
    ],
    negativeKeywords: [
      "مدرسي", "حقيبة ظهر", "مقلمة", "تلوين", "كانسون", "رسم مائي", "علبة هندسة", "درع زجاجي"
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
    minRelevanceThreshold: 20,
    positiveKeywords: [
      { word: "رسم", weight: 45 },
      { word: "كانسون", weight: 45 },
      { word: "مائي", weight: 40 },
      { word: "فني", weight: 35 },
      { word: "باستيل", weight: 35 },
      { word: "تحبير هندسي", weight: 40 },
      { word: "روترينغ", weight: 35 },
      { word: "تلوين", weight: 25 },
      { word: "ستيدلر", weight: 20 },
      { word: "قلم رصاص ميكانيكي", weight: 25 },
      { word: "كراس", weight: 25 },
    ],
    negativeKeywords: [
      "كباسة", "خرامة", "حامل كمبيوتر", "درع زجاجي", "صندوق هدايا مكتبي", "حقيبة ظهر مدرسية"
    ],
    preferredCategories: ["دفاتر ومذكرات", "أقلام وأدوات كتابة"],
  },
];

const THEMATIC_CACHE_TTL_MS = 5 * 60 * 1000; // 5 دقائق
const thematicCache = createTtlCache<string, ThematicCollectionCard[]>({ ttlMs: THEMATIC_CACHE_TTL_MS, maxEntries: 20 });

function calculateProductRelevance(
  item: {
    productName: string;
    description?: string | null;
    category?: string | null;
    salePrice?: string | null;
    price?: string | null;
    isBundle?: boolean;
    imageUrl?: string | null;
  },
  arch: ThematicArchetype
): number {
  const normName = normalizeArabicSearch(item.productName || "");
  const normDesc = normalizeArabicSearch(item.description || "");
  const normCat = normalizeArabicSearch(item.category || "");
  const fullText = `${normName} ${normDesc}`;

  // 1. فحص الاستبعادات الصارمة أولاً
  for (const neg of arch.negativeKeywords) {
    const normNeg = normalizeArabicSearch(neg);
    if (fullText.includes(normNeg)) {
      return -100;
    }
  }

  // 2. شرط العروض والبكجات الحقيقية
  if (arch.requireSaleOrBundle) {
    const hasDiscount = item.salePrice != null && Number(item.salePrice) < Number(item.price);
    const isBundle = item.isBundle === true || normName.includes("بكج") || normName.includes("عرض") || normName.includes("طقم") || normName.includes("باك");
    if (!hasDiscount && !isBundle) {
      return -100;
    }
  }

  let score = 0;

  // 3. الكلمات المفتاحية الإيجابية الموزونة
  for (const pos of arch.positiveKeywords) {
    const normPos = normalizeArabicSearch(pos.word);
    if (fullText.includes(normPos)) {
      score += pos.weight;
    }
  }

  // 4. الفئات الداعمة المفضلة
  for (const cat of arch.preferredCategories) {
    if (normCat.includes(normalizeArabicSearch(cat))) {
      score += 15;
    }
  }

  // 5. نقاط تفضيلية للعروض ووجود الصورة
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
