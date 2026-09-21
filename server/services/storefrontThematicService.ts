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
  categoryKeywords: string[];
  titleKeywords: string[];
  weight: number;
}

const THEMATIC_ARCHETYPES: readonly ThematicArchetype[] = [
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
    defaultFilterValue: "6", // بكجات وهدايا راقية
    categoryKeywords: ["بكجات وهدايا راقية", "تجهيزات ومستلزمات مكتبية"],
    titleKeywords: ["فاخر", "ملكي", "حامل", "ألمنيوم", "باركر", "هدية", "طقم", "صندوق هدايا"],
    weight: 20,
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
    defaultFilterValue: "3", // دفاتر ومذكرات
    categoryKeywords: ["دفاتر ومذكرات", "حقائب ومقالم مدرسية"],
    titleKeywords: ["دفتر", "سلك", "جامعي", "مدرسي", "تظليل", "حقيبة", "مقلمة", "طالب", "هندسة"],
    weight: 25,
  },
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
    defaultFilterValue: "2", // أقلام وأدوات كتابة
    categoryKeywords: ["أقلام وأدوات كتابة", "قرطاسية"],
    titleKeywords: ["حبر", "روترينغ", "باركر", "جيل", "رسم", "خط", "كراس", "مفكرة", "قلم"],
    weight: 18,
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
    categoryKeywords: ["بكجات وهدايا راقية"],
    titleKeywords: ["بكج", "عرض", "طقم", "باك", "مجموعة"],
    weight: 30,
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
    defaultFilterValue: "4", // تجهيزات ومستلزمات مكتبية
    categoryKeywords: ["تجهيزات ومستلزمات مكتبية"],
    titleKeywords: ["منظم", "كباسة", "خرامة", "تخطيط", "نوتبوك", "حامل", "شبكي"],
    weight: 15,
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
    categoryKeywords: ["دفاتر ومذكرات", "أقلام وأدوات كتابة"],
    titleKeywords: ["رسم", "كانسون", "مائي", "باستيل", "تلوين", "فني"],
    weight: 12,
  },
];

const THEMATIC_CACHE_TTL_MS = 5 * 60 * 1000; // 5 دقائق
const thematicCache = createTtlCache<string, ThematicCollectionCard[]>({ ttlMs: THEMATIC_CACHE_TTL_MS, maxEntries: 20 });

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

/** الخوارزمية الذكية: فحص الكتالوج وتوليد أفضل ٣ تشكيلات متوفرة */
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
      const matchedItems = allItems.filter((item) => {
        // مطابقة الفئة أو الكلمات المفتاحية بتطبيع عربي دقيق وموحد
        const normName = normalizeArabicSearch(item.productName);
        const normDesc = normalizeArabicSearch(item.description ?? "");
        const normCat = normalizeArabicSearch(item.category ?? "");

        const matchesCat = arch.categoryKeywords.some((ck) =>
          normCat.includes(normalizeArabicSearch(ck))
        );
        const matchesKeyword = arch.titleKeywords.some((tk) => {
          const normTk = normalizeArabicSearch(tk);
          return normName.includes(normTk) || normDesc.includes(normTk);
        });

        return matchesCat || matchesKeyword;
      });

      // المنتجات المتوفرة حالياً فقط
      const inStockItems = matchedItems.filter((i) => i.inStock);
      const inStockCount = inStockItems.length;

      // استبعاد النمط إذا لم يكن هناك أي منتج متوفر
      if (inStockCount === 0) {
        continue;
      }

      const onSaleCount = inStockItems.filter(
        (i) => i.salePrice != null && Number(i.salePrice) < Number(i.price)
      ).length;

      // حساب النقاط بحد تشبع للمخزون لمنع طغيان الأصناف الفردية مع وزن إضافي للعروض وهامش الربحية
      const saturationCount = Math.min(inStockCount, 12);
      const score = saturationCount * 12 + Math.min(inStockCount, 30) * 3 + onSaleCount * 18 + arch.weight;

      // تحديد الفلتر الأنسب
      let filterType: ThematicFilterType = arch.defaultFilterType;
      let filterValue: string = arch.defaultFilterValue;

      if (arch.id === "deals" && onSaleCount > 0) {
        filterType = "deal";
        filterValue = "deals";
      }

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
        filterType,
        filterValue,
        itemCount: inStockCount,
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
      return validCards;
    }
  }

  return computeAlgorithmicThematicCollections(branchId);
}
