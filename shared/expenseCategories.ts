/**
 * فئات المصروفات — الدلو المحاسبيّ الثابت + الكتالوج المُدار فوقه.
 *
 * ## لماذا طبقتان؟
 * `expenses.expenseCategory` عمودٌ من نوع ENUM بثمانية بنود، وهو **يقود المحاسبة فعلياً**:
 * `expenseRole()` يشتقّ منه حساب الدفتر، وملفّ الترحيل يفرّق `PAYMENT_OUT_SALARY` عن
 * `PAYMENT_OUT_EXPENSE`، واستعلامات جاهزية إقفال الشهر تطابق `TRANSPORT`/`MAINTENANCE` نصّاً.
 * توسيع هذا الـENUM أو استبداله يمسّ الدفتر والتقارير والإقفال دفعةً واحدة.
 *
 * لذلك: يبقى الـENUM **دلواً محاسبياً ثابتاً** (٨ بنود، لا يزيد ولا ينقص)، ويُبنى فوقه جدول
 * `expenseCategories` **مُدار من الواجهة**: كل فئة تُعلن دلوها (`bucket`)، فيكتب المصروف
 * الفئةَ المختارة **ودلوَها معاً**. النتيجة: تصنيفٌ تشغيليّ دقيق للمالك (وقود/أحبار/مولّدة…)
 * بصفر تغييرٍ في الدفتر أو التقارير أو الإقفال — كل مصروفٍ يهبط في نفس الحساب الذي كان يهبط فيه.
 *
 * ## مصدر حقيقةٍ واحد للتسميات
 * خريطة تسمية الدلاء كانت مكرّرة **أربع مرّات** (شاشة المصروفات، شاشة الإضافة، تقرير الخزينة،
 * التقرير المالي) — أربع نسخٍ تنجرف حتماً. هنا نسخةٌ واحدة يستهلكها الجميع.
 */

/** الدلو المحاسبيّ — مرآةُ ENUM العمود `expenses.expenseCategory` حرفياً. */
export const EXPENSE_BUCKETS = [
  "RENT",
  "UTILITIES",
  "SUPPLIES",
  "SALARY",
  "TRANSPORT",
  "MAINTENANCE",
  "MARKETING",
  "OTHER",
] as const;

export type ExpenseBucket = (typeof EXPENSE_BUCKETS)[number];

/** تسمية الدلو بالعربية — المصدر الوحيد (كانت أربع نسخ متطابقة تنجرف). */
export const EXPENSE_BUCKET_LABEL: Readonly<Record<ExpenseBucket, string>> =
  Object.freeze({
    RENT: "إيجار",
    UTILITIES: "خدمات/فواتير",
    SUPPLIES: "لوازم",
    SALARY: "مرتبات",
    TRANSPORT: "مواصلات/شحن",
    MAINTENANCE: "صيانة",
    MARKETING: "تسويق",
    OTHER: "أخرى",
  });

export function isExpenseBucket(value: unknown): value is ExpenseBucket {
  return (
    typeof value === "string" &&
    (EXPENSE_BUCKETS as readonly string[]).includes(value)
  );
}

export function expenseBucketLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return isExpenseBucket(value) ? EXPENSE_BUCKET_LABEL[value] : value;
}

export interface DefaultExpenseCategory {
  name: string;
  bucket: ExpenseBucket;
  description: string;
  sortOrder: number;
  /**
   * فئةُ الدلو الاحتياطية: حين يصل طلبٌ قديم يحمل الدلو وحده (تطبيق أندرويد، مزامنة
   * أوفلاين، استيراد) نُسنِد المصروف إليها كي لا يبقى بلا فئةٍ مُدارة. واحدةٌ لكل دلو
   * بالضبط — يحرسه اختبار وحدة، والهجرة هي التي تضبطها (لا تُدار من الواجهة).
   */
  isBucketDefault?: true;
}

/**
 * الكتالوج الافتراضي — تصنيف تشغيليّ لمطبعة/مكتبة في السوق العراقي. الترتيب مقصود:
 * فئة الدلو الاحتياطية أولاً داخل كل دلو، ثم تفصيلاته.
 */
export const DEFAULT_EXPENSE_CATEGORIES: readonly DefaultExpenseCategory[] =
  Object.freeze([
    // إيجار
    {
      name: "إيجار المحل والمخزن",
      bucket: "RENT",
      description: "إيجار المعرض أو المخزن أو الورشة",
      sortOrder: 10,
      isBucketDefault: true,
    },
    {
      name: "إيجار سكن ومرافق",
      bucket: "RENT",
      description: "إيجار سكن الموظفين أو مرافق مساندة",
      sortOrder: 15,
    },
    // خدمات/فواتير
    {
      name: "خدمات وفواتير (ماء وكهرباء وإنترنت)",
      bucket: "UTILITIES",
      description: "فواتير الماء والكهرباء الوطنية والإنترنت",
      sortOrder: 20,
      isBucketDefault: true,
    },
    {
      name: "اشتراك مولّدة كهرباء",
      bucket: "UTILITIES",
      description: "اشتراك المولّدة الأهلية الشهري",
      sortOrder: 25,
    },
    {
      name: "هاتف واتصالات",
      bucket: "UTILITIES",
      description: "أرصدة الهاتف وخطوط الاتصال",
      sortOrder: 30,
    },
    // لوازم
    {
      name: "لوازم ومستهلكات",
      bucket: "SUPPLIES",
      description: "لوازم تشغيلية عامة تُصرف مباشرةً بلا إدخال مخزني",
      sortOrder: 40,
      isBucketDefault: true,
    },
    {
      name: "مستلزمات طباعة (أحبار وتونر وورق)",
      bucket: "SUPPLIES",
      description: "مستهلكات المطبعة التي لا تدخل المخزن",
      sortOrder: 45,
    },
    {
      name: "قرطاسية إدارية",
      bucket: "SUPPLIES",
      description: "قرطاسية الإدارة والدفاتر والنماذج",
      sortOrder: 50,
    },
    {
      name: "مواد نظافة وضيافة",
      bucket: "SUPPLIES",
      description: "مواد التنظيف وضيافة الزبائن",
      sortOrder: 55,
    },
    {
      name: "أكياس ومواد تغليف",
      bucket: "SUPPLIES",
      description: "أكياس وكراتين ومواد تغليف الطلبات",
      sortOrder: 60,
    },
    // مرتبات
    {
      name: "مرتبات الموظفين",
      bucket: "SALARY",
      description: "الرواتب الشهرية المدفوعة نقداً خارج مسير الأجور",
      sortOrder: 70,
      isBucketDefault: true,
    },
    {
      name: "أجور عمّال يومية",
      bucket: "SALARY",
      description: "أجور المياومة والعمل الإضافي",
      sortOrder: 75,
    },
    {
      name: "مكافآت وحوافز",
      bucket: "SALARY",
      description: "مكافآت وحوافز خارج الراتب الأساسي",
      sortOrder: 80,
    },
    // مواصلات/شحن
    {
      name: "مواصلات وشحن",
      bucket: "TRANSPORT",
      description: "أجور التنقّل والشحن الداخلي",
      sortOrder: 90,
      isBucketDefault: true,
    },
    {
      name: "وقود ومحروقات",
      bucket: "TRANSPORT",
      description: "وقود المركبات والمولّدة",
      sortOrder: 95,
    },
    {
      name: "أجور توصيل الطلبات",
      bucket: "TRANSPORT",
      description: "أجور مندوبي التوصيل وشركات النقل",
      sortOrder: 100,
    },
    // صيانة
    {
      name: "صيانة وإصلاح",
      bucket: "MAINTENANCE",
      description: "صيانة عامة للمحل والأثاث والأجهزة",
      sortOrder: 110,
      isBucketDefault: true,
    },
    {
      name: "صيانة مكائن الطباعة",
      bucket: "MAINTENANCE",
      description: "صيانة وقطع غيار مكائن الطباعة والقصّ",
      sortOrder: 115,
    },
    {
      name: "صيانة مركبات",
      bucket: "MAINTENANCE",
      description: "صيانة سيارات التوصيل والدرّاجات",
      sortOrder: 120,
    },
    // تسويق
    {
      name: "تسويق وإعلان",
      bucket: "MARKETING",
      description: "حملات التسويق والإعلان الرقمي واللوحات",
      sortOrder: 130,
      isBucketDefault: true,
    },
    {
      name: "طباعة مواد دعائية",
      bucket: "MARKETING",
      description: "بروشورات وكروت وستاندات دعائية للمكتبة",
      sortOrder: 135,
    },
    {
      name: "رعاية ومناسبات",
      bucket: "MARKETING",
      description: "رعاية فعاليات ومعارض ومناسبات التخرّج",
      sortOrder: 140,
    },
    // أخرى
    {
      name: "مصروفات أخرى",
      bucket: "OTHER",
      description: "مصروف لا تشمله الفئات أعلاه",
      sortOrder: 150,
      isBucketDefault: true,
    },
    {
      name: "رسوم حكومية وإجازات",
      bucket: "OTHER",
      description: "رسوم الدوائر الحكومية وإجازة العمل",
      sortOrder: 155,
    },
    {
      name: "عمولات وأتعاب مهنية",
      bucket: "OTHER",
      description: "أتعاب المحاسب والمحامي وعمولات الوسطاء",
      sortOrder: 160,
    },
    {
      name: "مصاريف بنكية وحوالات",
      bucket: "OTHER",
      description: "رسوم الحوالات وعمولات البنك والمحافظ",
      sortOrder: 165,
    },
    {
      name: "تبرّعات ومساعدات",
      bucket: "OTHER",
      description: "تبرّعات ومساعدات اجتماعية",
      sortOrder: 170,
    },
  ] satisfies DefaultExpenseCategory[]);

/** فئة الدلو الاحتياطية من الكتالوج (للتحقّق والبذر — لا تُقرأ من DB). */
export function defaultCategoryNameForBucket(bucket: ExpenseBucket): string {
  const found = DEFAULT_EXPENSE_CATEGORIES.find(
    (category) => category.bucket === bucket && category.isBucketDefault,
  );
  // الكتالوج مضمونٌ باختبار وحدة أن يغطّي كل دلو بواحدةٍ بالضبط.
  return found!.name;
}

/** فئات الكتالوج التابعة لدلوٍ بعينه، بترتيب العرض. */
export function defaultExpenseCategoriesForBucket(
  bucket: ExpenseBucket,
): readonly DefaultExpenseCategory[] {
  return DEFAULT_EXPENSE_CATEGORIES.filter(
    (category) => category.bucket === bucket,
  );
}
