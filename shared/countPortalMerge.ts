// دمج حالة بوابة العدّ من جزأيها: الكتالوج الساكن + الحالة المتغيّرة.
//
// لماذا الفصل (مقاس على جلسة إنتاجية، ٣٤١٤ صنفاً/١٢٩٩ عدّة):
//   ساكن (أسماء+SKU)      ٤٢٨ﻙﺐ ┐
//   ساكن (وحدات+بدائل)    ٣٨٨ﻙﺐ ┘ = ٨٣٪ من الحمولة، لا يتغيّر خلال الجرد
//   متغيّر (العدّات)        ١٦٤ﻙﺐ   = ١٧٪، وهو وحده ما يتبدّل فعلاً
// فإعادة إرسال الكتالوج مع كل تغيّر عدّةٍ واحدة هدرٌ بنسبة ٨٣٪. الكتالوج يُرسَل مرّةً بوسمٍ
// خاص (`cv`) ويُخزَّن لدى العميل، ولا يتكرّر إلّا إن تبدّل.
//
// ⚠️ هذه الوحدة **مشتركة** بين الخادم (`getPortalState`) والعميل (`usePulsedCountState`) عمداً:
// أي دمجٍ مكرَّرٍ في الطرفين ينحرف مع الوقت فتظهر شاشة العادّ مختلفةً عمّا يراه الخادم.

/** وحدة قياس للصنف (قطعة/درزن/كرتون) بباركودها وبدائلها. */
export type PortalUnit = {
  unitName: string;
  /** عدد الوحدات الأساس في هذه الوحدة — معامل تحويل وليس مالاً. */
  factor: number;
  barcode: string | null;
  aliases: string[];
};

/** الجزء **الساكن** من الصنف: لا يتغيّر بالعدّ، يُخزَّن لدى العميل ولا يُعاد إرساله. */
export type PortalCatalogItem = {
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string;
  units: PortalUnit[];
};

/** الجزء **المتغيّر** لصنفٍ عُدَّ فعلاً. الأصناف غير المذكورة = لم تُعدّ (الافتراضي). */
export type PortalCountState = {
  variantId: number;
  counted: boolean;
  colleagueCounted: boolean;
  myCount: { qty: number; at: Date; unitBreakdown: string | null } | null;
  /** ختم إداري مرحلي فقط — بلا اسم المدير أو أي قيمة دفترية. */
  reviewApproved: boolean;
};

export type PortalItem = PortalCatalogItem & {
  isMine: boolean;
  counted: boolean;
  myCount: { qty: number; at: Date; unitBreakdown: string | null } | null;
  colleagueCounted: boolean;
  reviewApproved: boolean;
};

export type PortalDynamic = {
  session: {
    code: string;
    name: string;
    branchName: string;
    status: string;
    dupPolicy: string;
    blind: boolean;
    /** أسلوب العدّ: SCAN_REQUIRED تُلزم الواجهةَ فتحَ البطاقة بمسحٍ فقط؛ FREE = النقر الحر. */
    countMethod: string;
  };
  assignment: { id: number; name: string; zone: string | null; status: string };
  progress: { mine: { counted: number; total: number }; session: { counted: number; total: number } };
  recountTasks: { variantId: number; productName: string; variantName: string | null; reason: string }[];
  /** حالات العدّ للأصناف المعدودة فقط — الباقي يُشتقّ افتراضاً. */
  counts: PortalCountState[];
};

export type PortalState = Omit<PortalDynamic, "counts"> & { items: PortalItem[] };

/**
 * يعيد بناء الحالة الكاملة من الكتالوج + المتغيّر. نقيّة وحتمية (بلا I/O) كي تُشغَّل على
 * الطرفين بنفس النتيجة بالضبط. الترتيب من الكتالوج (ترتيب `stocktakeItems.id` من الخادم).
 */
export function mergePortalState(catalog: PortalCatalogItem[], dyn: PortalDynamic): PortalState {
  const byVariant = new Map<number, PortalCountState>();
  for (const c of dyn.counts) byVariant.set(Number(c.variantId), c);

  const items: PortalItem[] = catalog.map((it) => {
    const c = byVariant.get(Number(it.variantId));
    return {
      ...it,
      // قائمة الأصناف مشتركة عمداً — الملكية ليست بالصنف (نفس سلوك ما قبل الفصل).
      isMine: true,
      counted: c?.counted ?? false,
      myCount: c?.myCount ?? null,
      colleagueCounted: c?.colleagueCounted ?? false,
      reviewApproved: c?.reviewApproved ?? false,
    };
  });

  return {
    session: dyn.session,
    assignment: dyn.assignment,
    progress: dyn.progress,
    recountTasks: dyn.recountTasks,
    items,
  };
}
