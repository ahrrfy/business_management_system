/**
 * الكتالوج الافتراضي لفئات سندات القبض والصرف — **مصدر الحقيقة الوحيد**.
 *
 * لماذا هذا الملف؟ فئة السند إلزامية لسندات «أخرى» (partyType=OTHER) لأنّها هي التي تحدّد
 * الحساب المقابل في الدفتر (§٥ من CLAUDE.md: «لا دينار… ليس له مسار أو تبويب»). لكن الفئات
 * كانت تُبذَر في هجرة 0036 وحدها بلا حساب مقابل، ثمّ 0190 عيّنت ١٣ منها فقط وتركت ٤ بلا تعيين
 * ⇒ على سند القبض لم يبقَ صالحاً للاستعمال سوى فئتين («إيرادات متفرّقة» و«فوائد بنكية»)، وكل
 * ما عداهما يظهر معطّلاً «غير مهيأة محاسبياً». ومَن يبني قاعدته بـ`db:push` (مسار التطوير/CI)
 * لا يحصل على أي فئة إطلاقاً لأنّ البذر يعيش في SQL الهجرة لا في `schema.ts` ولا في `seed.ts`.
 *
 * الحلّ: كتالوج واحد بالـTypeScript يستهلكه ثلاثة مسارات فتستحيل الفجوة بينها:
 *  ١) هجرة `0202_voucher_category_defaults.sql` (الإنتاج) — اختبارٌ يُثبت تطابق نصّها مع هذا الملف.
 *  ٢) `ensureDefaultVoucherCategories` (server/services/voucher/defaults.ts) — تستدعيها البذرة
 *     `pnpm seed` وإجراء «استعادة الفئات الافتراضية» من الشاشة.
 *  ٣) الواجهة — لعرض ما ينقص وشرح البدائل للفئات المتقاعدة.
 *
 * قواعد ثابتة:
 *  - الاسم مفتاح التطابق (UNIQUE في DB، مطابقة غير حسّاسة للحالة بترتيب utf8mb4) ⇒ البذر
 *    idempotent بلا معرّفات ثابتة.
 *  - كل فئة هنا **لها حساب مقابل متوافق مع اتجاهها** (يحرسه اختبار وحدة + قيد CHECK في DB).
 *  - البذر لا يُعدّل فئةً موجودة: لا اسمها ولا اتجاهها ولا حسابها المقابل المعيَّن ولا ترتيبها —
 *    يملأ فقط ما كان NULL. تغيير فئةٍ مرتبطة بسندات ممنوعٌ أصلاً في الراوتر حفاظاً على أثر التدقيق.
 */
import type {
  VoucherCategoryDirection,
  VoucherCategoryPostingRole,
} from "./voucherCategoryAccounting";

export interface DefaultVoucherCategory {
  name: string;
  direction: VoucherCategoryDirection;
  postingRole: VoucherCategoryPostingRole;
  description: string;
  sortOrder: number;
}

/**
 * فئات الصرف (OUT) — مصروفات التشغيل اليومية لمطبعة/مكتبة في السوق العراقي،
 * مضافاً إليها حركات المالك والقروض والأمانات التي تخرج نقداً بلا فاتورة مشتريات.
 */
const OUT_DEFAULTS: readonly DefaultVoucherCategory[] = [
  {
    name: "إيجار",
    direction: "OUT",
    postingRole: "RENT",
    description: "إيجار المحل أو المخزن أو المعرض",
    sortOrder: 10,
  },
  {
    name: "رواتب",
    direction: "OUT",
    postingRole: "SALARIES",
    description: "رواتب الموظفين الشهرية",
    sortOrder: 20,
  },
  {
    name: "أجور عمّال يومية",
    direction: "OUT",
    postingRole: "SALARIES",
    description: "أجور المياومة والعمل الإضافي المدفوعة نقداً",
    sortOrder: 25,
  },
  {
    name: "مكافآت وحوافز الموظفين",
    direction: "OUT",
    postingRole: "SALARIES",
    description: "مكافآت وحوافز خارج الراتب الأساسي",
    sortOrder: 28,
  },
  {
    name: "خدمات (ماء/كهرباء/إنترنت)",
    direction: "OUT",
    postingRole: "UTILITIES",
    description: "فواتير الماء والكهرباء والإنترنت والهاتف",
    sortOrder: 30,
  },
  {
    name: "اشتراك مولّدة كهرباء",
    direction: "OUT",
    postingRole: "UTILITIES",
    description: "اشتراك المولّدة الأهلية الشهري",
    sortOrder: 35,
  },
  {
    name: "صيانة وإصلاح",
    direction: "OUT",
    postingRole: "OPERATING_EXPENSE",
    description: "صيانة المكائن والأجهزة والمحل",
    sortOrder: 40,
  },
  {
    name: "مستلزمات طباعة (أحبار وتونر وورق)",
    direction: "OUT",
    postingRole: "OPERATING_EXPENSE",
    description: "مستهلكات الطباعة التي تُصرف مباشرةً بلا إدخال مخزني",
    sortOrder: 45,
  },
  {
    name: "مواصلات ووقود",
    direction: "OUT",
    postingRole: "OPERATING_EXPENSE",
    description: "وقود المركبات وأجور التنقّل",
    sortOrder: 50,
  },
  {
    name: "أجور توصيل ونقل",
    direction: "OUT",
    postingRole: "DELIVERY_EXPENSE",
    description: "أجور مندوبي التوصيل وشركات النقل",
    sortOrder: 55,
  },
  {
    name: "قرطاسية ونثريات",
    direction: "OUT",
    postingRole: "OPERATING_EXPENSE",
    description: "قرطاسية الإدارة والمصاريف النثرية الصغيرة",
    sortOrder: 60,
  },
  {
    name: "ضيافة ونظافة",
    direction: "OUT",
    postingRole: "OPERATING_EXPENSE",
    description: "ضيافة الزبائن ومواد النظافة",
    sortOrder: 65,
  },
  {
    name: "إعلانات وتسويق",
    direction: "OUT",
    postingRole: "OPERATING_EXPENSE",
    description: "إعلانات ولوحات ورعاية وتسويق رقمي",
    sortOrder: 70,
  },
  {
    name: "هدايا وترويج للزبائن",
    direction: "OUT",
    postingRole: "GIFTS_PROMO",
    description: "هدايا ترويجية للزبائن والمناسبات",
    sortOrder: 75,
  },
  {
    name: "تبرّعات ومساعدات",
    direction: "OUT",
    postingRole: "OTHER_EXPENSE",
    description: "تبرّعات ومساعدات اجتماعية",
    sortOrder: 80,
  },
  {
    name: "اشتراكات وتراخيص برامج",
    direction: "OUT",
    postingRole: "OPERATING_EXPENSE",
    description: "اشتراكات البرامج والتصاميم والخدمات السحابية",
    sortOrder: 85,
  },
  {
    name: "ضرائب ورسوم حكومية",
    direction: "OUT",
    postingRole: "OTHER_EXPENSE",
    description: "رسوم الدوائر الحكومية وإجازة العمل والضرائب",
    sortOrder: 90,
  },
  {
    name: "سحب شخصي/مالك",
    direction: "OUT",
    postingRole: "OWNER_CURRENT",
    description: "سحب المالك لحسابه الجاري (لا مصروف)",
    sortOrder: 100,
  },
  {
    name: "عُمولات وأتعاب",
    direction: "OUT",
    postingRole: "OPERATING_EXPENSE",
    description: "عمولات الوسطاء وأتعاب المحاسب والمحامي",
    sortOrder: 110,
  },
  {
    name: "مصاريف بنكية",
    direction: "OUT",
    postingRole: "OPERATING_EXPENSE",
    description: "رسوم الحوالات وعمولات البنك والمحافظ",
    sortOrder: 120,
  },
  {
    name: "تسديد قرض",
    direction: "OUT",
    postingRole: "LOAN_PAYABLE",
    description: "تسديد أقساط القروض (يُنقص التزام القرض لا مصروفاً)",
    sortOrder: 135,
  },
  {
    name: "ردّ أمانات وتأمينات",
    direction: "OUT",
    postingRole: "OTHER_LIABILITY",
    description: "إعادة أمانة أو تأمين محتجز إلى صاحبه",
    sortOrder: 145,
  },
  {
    name: "خسائر وتلف",
    direction: "OUT",
    postingRole: "LOSSES",
    description: "تلف أو ضياع أو خسارة تشغيلية مثبتة",
    sortOrder: 155,
  },
  {
    name: "نقص/عجز صندوق",
    direction: "OUT",
    postingRole: "LOSSES",
    description: "عجز نقدي مثبت بعد تسوية الدرج",
    sortOrder: 165,
  },
  {
    name: "مصروفات أخرى",
    direction: "OUT",
    postingRole: "OTHER_EXPENSE",
    description: "مصروف تشغيلي لا تشمله الفئات أعلاه",
    sortOrder: 175,
  },
];

/**
 * فئات القبض (IN) — كان هذا الجانب أفقر جانبٍ في النظام: فئتان صالحتان فقط بينما أدوار
 * القبض المتاحة خمسة (إيراد آخر/رأس مال/جاري المالك/قرض/أمانة). كل دورٍ صار له مدخلٌ واضح.
 */
const IN_DEFAULTS: readonly DefaultVoucherCategory[] = [
  {
    name: "إيرادات متفرّقة",
    direction: "IN",
    postingRole: "OTHER_REVENUE",
    description: "إيراد نقدي متفرّق خارج فواتير البيع",
    sortOrder: 140,
  },
  {
    name: "فوائد بنكية",
    direction: "IN",
    postingRole: "OTHER_REVENUE",
    description: "فوائد وأرباح حسابات بنكية",
    sortOrder: 150,
  },
  {
    name: "رأس مال — إيداع المالك",
    direction: "IN",
    postingRole: "CAPITAL",
    description: "زيادة رأس المال بإيداع من المالك (حقوق ملكية)",
    sortOrder: 210,
  },
  {
    name: "إيداع من المالك (حساب جاري)",
    direction: "IN",
    postingRole: "OWNER_CURRENT",
    description: "دعم نقدي مؤقّت من المالك يُردّ لاحقاً",
    sortOrder: 220,
  },
  {
    name: "قرض مستلم",
    direction: "IN",
    postingRole: "LOAN_PAYABLE",
    description: "قرض وارد ينشئ التزاماً يُسدَّد لاحقاً",
    sortOrder: 230,
  },
  {
    name: "أمانات وتأمينات مستلمة",
    direction: "IN",
    postingRole: "OTHER_LIABILITY",
    description: "مبلغ محتجز لصالح الغير له مسار خروجٍ دائماً",
    sortOrder: 240,
  },
  {
    name: "إيراد تأجير معدات أو خدمات",
    direction: "IN",
    postingRole: "OTHER_REVENUE",
    description: "تأجير ماكنة أو مساحة أو خدمة خارج المبيعات",
    sortOrder: 250,
  },
  {
    name: "بيع مخلفات وورق تالف",
    direction: "IN",
    postingRole: "OTHER_REVENUE",
    description: "بيع الكرتون والورق التالف والمخلفات",
    sortOrder: 260,
  },
  {
    name: "تعويضات ومطالبات مستلمة",
    direction: "IN",
    postingRole: "OTHER_REVENUE",
    description: "تعويض من مورّد أو شركة تأمين أو ناقل",
    sortOrder: 270,
  },
  {
    name: "استرداد مصروفات سابقة",
    direction: "IN",
    postingRole: "OTHER_REVENUE",
    description:
      "استرجاع مبلغ صُرف سابقاً (يُعترف إيراداً آخر بالمعالجة المبسّطة)",
    sortOrder: 280,
  },
];

/** الكتالوج الكامل بترتيب العرض (الصرف ثم القبض). */
export const DEFAULT_VOUCHER_CATEGORIES: readonly DefaultVoucherCategory[] =
  Object.freeze([...OUT_DEFAULTS, ...IN_DEFAULTS]);

/**
 * فئات 0036 التاريخية **الغامضة محاسبياً** — لا يجوز تخمين حسابٍ مقابل لها لأنّ كلاً منها
 * يخفي معاملتين مختلفتين على الأقل. تُعطَّل تلقائياً **إن لم تُستعمل في أي سند**، ويبقى
 * المستعمَل منها كما هو لتقرّره الإدارة من شاشة المعالجة (لا نُعيد تصنيف تاريخٍ صامتاً).
 */
export interface RetiredVoucherCategory {
  name: string;
  /** البديل المعتمد الذي يُوجَّه إليه المستخدم. */
  replacement: string;
}

export const RETIRED_VOUCHER_CATEGORIES: readonly RetiredVoucherCategory[] =
  Object.freeze([
    {
      name: "إيداع نقدي بنكي",
      replacement: "تحويل خزينة لا سند: استعمل «تحويلات نقدية» في محور الخزينة",
    },
    {
      name: "ردّ مَردودات/استرداد",
      replacement:
        "مرتجع بيع من شاشة الفاتورة، أو «استرداد مصروفات سابقة» للمبالغ المصروفة",
    },
    {
      name: "أخرى",
      replacement: "«مصروفات أخرى» للصرف و«إيرادات متفرّقة» للقبض",
    },
  ] satisfies RetiredVoucherCategory[]);

const RETIRED_NAMES = new Set(RETIRED_VOUCHER_CATEGORIES.map((c) => c.name));

/** هل هذا الاسم فئةٌ متقاعدة (غامضة) ينبغي توجيه المستخدم عنها إلى بديلها؟ */
export function retiredVoucherCategory(
  name: string | null | undefined,
): RetiredVoucherCategory | undefined {
  if (!name) return undefined;
  return RETIRED_VOUCHER_CATEGORIES.find((c) => c.name === name.trim());
}

export function isRetiredVoucherCategoryName(
  name: string | null | undefined,
): boolean {
  return !!name && RETIRED_NAMES.has(name.trim());
}

/** الفئات الافتراضية الصالحة لاتجاه سندٍ بعينه (BOTH يُقبل في الاتجاهين). */
export function defaultVoucherCategoriesFor(
  direction: "IN" | "OUT",
): readonly DefaultVoucherCategory[] {
  return DEFAULT_VOUCHER_CATEGORIES.filter(
    (c) => c.direction === "BOTH" || c.direction === direction,
  );
}
