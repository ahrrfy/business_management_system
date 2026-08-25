/**
 * رسائل حالة القوائم الفارغة — **مصدر الحقيقة الوحيد** للتمييز بين حالتَين مختلفتَين تماماً
 * كانتا تُعرَضان بنفس النصّ:
 *
 *   • **NO_ROWS_YET**: القائمة فارغة أصلاً (لم يُنشَأ أيّ سجلّ بعد). ⇒ CTA: «أنشئ الأوّل».
 *   • **NO_MATCH_FILTER**: توجد سجلاّت لكن البحث/الفلتر لا يُطابق. ⇒ CTA: «امسح الفلاتر».
 *
 * كانت شاشات كثيرة تعرض «لا بيانات» في الحالتَين ⇒ الموظّف يظنّ الفلتر أفرغ القائمة، أو يظنّ
 * القائمةَ فارغةً والفلتر معتّمُها. الفرق يُحدَّد بـ`filtersActive` من المستدعي (بحث/فلاتر
 * غير فارغة).
 *
 * ملاحظة موقع: `shared/` كي يستهلكه الخادم أيضاً حين يبني تقارير/تصديرات فارغة (رسالةٌ عربية
 * موحّدة عبر النظام).
 */

export type EmptyStateReason = "NO_ROWS_YET" | "NO_MATCH_FILTER";

export type EmptyStateMessage = {
  /** رسالة رئيسية عربية. */
  title: string;
  /** توضيحٌ فرعيّ اختياريّ (سبب/توجيه). */
  description?: string;
};

/**
 * قواميس رسائل عربية لكل مجال (domain). الوحدة الأصغر هي "resource key".
 *
 * ⚠️ لا تتغيّر إلا بطلب صاحب النظام — هذه نصوصٌ يقرأها الموظّف يومياً وأيّ انجراف يُربكه.
 */
const MESSAGES: Record<string, Record<EmptyStateReason, EmptyStateMessage>> = {
  invoices: {
    NO_ROWS_YET: {
      title: "لا فواتير بعد",
      description: "أنشئ أوّل فاتورة بيع من الكاشير أو من زرّ الإنشاء.",
    },
    NO_MATCH_FILTER: {
      title: "لا فواتير مطابقة للبحث",
      description: "امسح الفلاتر أو غيّر نطاق البحث لرؤية النتائج.",
    },
  },
  customers: {
    NO_ROWS_YET: {
      title: "لا عملاء بعد",
      description: "أضف أوّل عميل ليظهر في قوائم البيع.",
    },
    NO_MATCH_FILTER: {
      title: "لا عملاء مطابقين للبحث",
      description: "امسح الفلاتر أو غيّر نطاق البحث لرؤية النتائج.",
    },
  },
  suppliers: {
    NO_ROWS_YET: {
      title: "لا مورّدين بعد",
      description: "أضف أوّل مورّد ليظهر في قوائم الشراء.",
    },
    NO_MATCH_FILTER: {
      title: "لا مورّدين مطابقين للبحث",
      description: "امسح الفلاتر أو غيّر نطاق البحث لرؤية النتائج.",
    },
  },
  products: {
    NO_ROWS_YET: {
      title: "لا منتجات بعد",
      description: "أضف أوّل منتج ليظهر في الكاشير والقوائم.",
    },
    NO_MATCH_FILTER: {
      title: "لا منتجات مطابقة للبحث",
      description: "امسح الفلاتر أو غيّر نطاق البحث لرؤية النتائج.",
    },
  },
  purchases: {
    NO_ROWS_YET: {
      title: "لا أوامر شراء بعد",
      description: "أنشئ أوّل أمر شراء لبدء تتبّع المستحقّ للمورّدين.",
    },
    NO_MATCH_FILTER: {
      title: "لا أوامر شراء مطابقة للبحث",
      description: "امسح الفلاتر أو غيّر نطاق البحث لرؤية النتائج.",
    },
  },
  workOrders: {
    NO_ROWS_YET: {
      title: "لا أوامر شغل بعد",
      description: "أنشئ أوّل طلب خدمة من كاشير الاستقبال.",
    },
    NO_MATCH_FILTER: {
      title: "لا أوامر شغل مطابقة للبحث",
      description: "امسح الفلاتر أو غيّر نطاق البحث لرؤية النتائج.",
    },
  },
  vouchers: {
    NO_ROWS_YET: {
      title: "لا سندات بعد",
      description: "أنشئ أوّل سند قبض/صرف.",
    },
    NO_MATCH_FILTER: {
      title: "لا سندات مطابقة للبحث",
      description: "امسح الفلاتر أو غيّر نطاق البحث لرؤية النتائج.",
    },
  },
  transfers: {
    NO_ROWS_YET: {
      title: "لا تحويلات مخزون بعد",
      description: "أنشئ أوّل تحويلٍ بين فرعَين.",
    },
    NO_MATCH_FILTER: {
      title: "لا تحويلات مطابقة للبحث",
      description: "امسح الفلاتر أو غيّر نطاق البحث لرؤية النتائج.",
    },
  },
  assets: {
    NO_ROWS_YET: {
      title: "لا أصول ثابتة بعد",
      description: "سجّل أوّل أصل لبدء تتبّع الإهلاك.",
    },
    NO_MATCH_FILTER: {
      title: "لا أصول مطابقة للبحث",
      description: "امسح الفلاتر أو غيّر نطاق البحث لرؤية النتائج.",
    },
  },
  employees: {
    NO_ROWS_YET: {
      title: "لا موظّفين بعد",
      description: "أضف أوّل موظّفٍ من قائمة الموارد البشرية.",
    },
    NO_MATCH_FILTER: {
      title: "لا موظّفين مطابقين للبحث",
      description: "امسح الفلاتر أو غيّر نطاق البحث لرؤية النتائج.",
    },
  },
  contractPrices: {
    NO_ROWS_YET: {
      title: "لا أسعار عقد بعد",
      description: "أضف سعر عقد لعميلٍ ومنتجٍ محدَّدَين.",
    },
    NO_MATCH_FILTER: {
      title: "لا أسعار عقد مطابقة للبحث",
      description: "امسح الفلاتر أو غيّر نطاق البحث لرؤية النتائج.",
    },
  },
  consignmentSettlements: {
    NO_ROWS_YET: {
      title: "لا تسويات أمانة بعد",
      description: "تُنشأ التسوية عندما يكون لمُودِعٍ رصيدٌ مستحقّ.",
    },
    NO_MATCH_FILTER: {
      title: "لا تسويات مطابقة للبحث",
      description: "امسح الفلاتر أو غيّر نطاق البحث لرؤية النتائج.",
    },
  },
  generic: {
    NO_ROWS_YET: {
      title: "لا سجلّات بعد",
      description: "أنشئ أوّل سجلٍّ ليظهر هنا.",
    },
    NO_MATCH_FILTER: {
      title: "لا سجلّات مطابقة للبحث",
      description: "امسح الفلاتر أو غيّر نطاق البحث لرؤية النتائج.",
    },
  },
};

/**
 * تُرجع رسالة الحالة الفارغة المناسبة. إن كان `resourceKey` غير معروف، يُستعمل `generic`
 * بلا throw (لا تحطيم UI بسبب مفتاحٍ جديد).
 *
 * @param resourceKey - مفتاح المجال (invoices/customers/…)، انظر MESSAGES.
 * @param reason - سبب الفراغ: NO_ROWS_YET أو NO_MATCH_FILTER.
 */
export function emptyStateMessage(
  resourceKey: string,
  reason: EmptyStateReason,
): EmptyStateMessage {
  return MESSAGES[resourceKey]?.[reason] ?? MESSAGES.generic[reason];
}

/**
 * مساعدٌ لاختصار قرار المستدعي: يستقبل نشاط الفلاتر ويُرجع الرسالة الصحيحة.
 *
 * ```tsx
 * const msg = pickEmptyMessage("invoices", filtersActive);
 * ```
 */
export function pickEmptyMessage(
  resourceKey: string,
  filtersActive: boolean,
): EmptyStateMessage {
  return emptyStateMessage(resourceKey, filtersActive ? "NO_MATCH_FILTER" : "NO_ROWS_YET");
}

/** كل المفاتيح المسجَّلة — للاختبار النصّيّ (كل مفتاح يجب أن يحمل الحالتَين). */
export const EMPTY_STATE_RESOURCE_KEYS = Object.keys(MESSAGES);
