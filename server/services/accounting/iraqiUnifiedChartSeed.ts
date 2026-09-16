import type {
  ImportedStatutoryAccount,
  StatutoryAccountType,
} from "./statutoryAccounting";

/**
 * دليل النظام المحاسبي الموحد العراقي المعتمد للشركات والمنشآت التجارية والصناعية (المطابع والقرطاسية).
 * يبوب الحسابات هرمياً:
 *  1: الموجودات (الأصول)
 *  2: المطلوبات ومصادر التمويل (الالتزامات وحقوق الملكية)
 *  3: الاستخدامات (المصروفات والتكاليف)
 *  4: الموارد (الإيرادات)
 */
export const IRAQI_UNIFIED_PROFILE_KEY = "IRAQI_STATUTORY_UNIFIED";
export const IRAQI_UNIFIED_PROFILE_NAME = "دليل النظام المحاسبي الموحد العراقي — المطبعة والقرطاسية";
export const IRAQI_UNIFIED_AUTHORITY_REF = "النظام المحاسبي الموحد العراقي / ديوان الرقابة المالية ونقابة المحاسبين والمدققين العراقيين";

export const IRAQI_UNIFIED_ACCOUNTS: ImportedStatutoryAccount[] = [
  // ==========================================
  // 1. الموجودات (الأصول) — طبيعتها مدينة DEBIT
  // ==========================================
  {
    code: "1",
    name: "الموجودات",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: null,
    isPosting: false,
    sortOrder: 100,
    notes: "الموجودات الثابتة والمتداولة والجاهزة للنشاط",
  },
  {
    code: "11",
    name: "الموجودات الثابتة",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "1",
    isPosting: false,
    sortOrder: 110,
  },
  {
    code: "113",
    name: "آلات ومعدات الطباعة والتجليد",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "11",
    isPosting: true,
    sortOrder: 113,
  },
  {
    code: "115",
    name: "أجهزة مكاتب وحواسيب وأثاث",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "11",
    isPosting: true,
    sortOrder: 115,
  },
  {
    code: "118",
    name: "مجمع اندثار الموجودات الثابتة",
    type: "ASSET",
    normalBalance: "CREDIT",
    parentCode: "11",
    isPosting: true,
    sortOrder: 118,
    notes: "حساب مقابل أصول (طبيعة دائنة تخفض الموجودات)",
  },
  {
    code: "12",
    name: "مشروعات وإنتاج تحت التنفيذ",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "1",
    isPosting: true,
    sortOrder: 120,
    notes: "أوامر شغل الطباعة قيد التشغيل والمواد المحملة عليها",
  },
  {
    code: "13",
    name: "المخزون",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "1",
    isPosting: false,
    sortOrder: 130,
  },
  {
    code: "131",
    name: "مخزون بضائع بغرض البيع (القرطاسية والمكتبيات)",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "13",
    isPosting: true,
    sortOrder: 131,
  },
  {
    code: "132",
    name: "مخزون الخامات والمواد الأولية (ورق، أحبار، مستلزمات طباعة)",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "13",
    isPosting: true,
    sortOrder: 132,
  },
  {
    code: "135",
    name: "مخزون كروت الشحن والبطاقات الرقمية",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "13",
    isPosting: true,
    sortOrder: 135,
  },
  {
    code: "15",
    name: "المدينون",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "1",
    isPosting: false,
    sortOrder: 150,
  },
  {
    code: "151",
    name: "العملاء (مدينو النشاط التجاري)",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "15",
    isPosting: true,
    sortOrder: 151,
  },
  {
    code: "153",
    name: "سلف الموظفين",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "15",
    isPosting: true,
    sortOrder: 153,
  },
  {
    code: "158",
    name: "مدينون متنوعون",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "15",
    isPosting: false,
    sortOrder: 158,
  },
  {
    code: "1581",
    name: "عهدة جهات التوصيل (مبالغ COD قيد التحصيل)",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "158",
    isPosting: true,
    sortOrder: 1581,
    notes: "قرار المالك: ذمة وعهدة على المندوب فور التسليم للعميل",
  },
  {
    code: "1582",
    name: "ذمم صيرفات مدينة — دينار عراقي",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "158",
    isPosting: true,
    sortOrder: 1582,
  },
  {
    code: "1583",
    name: "ذمم صيرفات مدينة — دولار بالقيمة الدفترية",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "158",
    isPosting: true,
    sortOrder: 1583,
  },
  {
    code: "18",
    name: "النقود بالصناديق والمصارف والمحافظ",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "1",
    isPosting: false,
    sortOrder: 180,
  },
  {
    code: "181",
    name: "نقدية في الصندوق (أدراج الكاشير)",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "18",
    isPosting: true,
    sortOrder: 181,
  },
  {
    code: "182",
    name: "نقدية في الخزينة المركزية",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "18",
    isPosting: true,
    sortOrder: 182,
  },
  {
    code: "183",
    name: "نقدية لدى المصارف والبطاقات (حسابات جارية / POS بنكي)",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "18",
    isPosting: true,
    sortOrder: 183,
  },
  {
    code: "184",
    name: "نقدية بالمحافظ الرقمية (زين كاش، FIB، بطاقات دفع)",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "18",
    isPosting: true,
    sortOrder: 184,
  },
  {
    code: "1845",
    name: "رصيد اتصالات محصل",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "18",
    isPosting: true,
    sortOrder: 1845,
  },
  {
    code: "185",
    name: "محفظة الصيرفة — دينار عراقي",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "18",
    isPosting: true,
    sortOrder: 185,
  },
  {
    code: "186",
    name: "محفظة الصيرفة — دولار بالقيمة الدفترية",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "18",
    isPosting: true,
    sortOrder: 186,
  },
  {
    code: "187",
    name: "نقد أجنبي بالخزينة — دولار بالقيمة الدفترية",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "18",
    isPosting: true,
    sortOrder: 187,
  },
  {
    code: "188",
    name: "نقد في الطريق (تحويلات بين الفروع والصناديق)",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "18",
    isPosting: true,
    sortOrder: 188,
  },
  {
    code: "189",
    name: "شيكات برسم التحصيل",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "18",
    isPosting: true,
    sortOrder: 189,
  },
  {
    code: "19",
    name: "تسويات جارية بين الفروع",
    type: "ASSET",
    normalBalance: "DEBIT",
    parentCode: "1",
    isPosting: true,
    sortOrder: 190,
  },

  // ==========================================
  // 2. المطلوبات ومصادر التمويل — طبيعتها دائنة CREDIT
  // ==========================================
  {
    code: "2",
    name: "المطلوبات ومصادر التمويل",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: null,
    isPosting: false,
    sortOrder: 200,
    notes: "حقوق الملكية والالتزامات للغير",
  },
  {
    code: "21",
    name: "مصادر التمويل الداخلي (حقوق الملكية)",
    type: "EQUITY",
    normalBalance: "CREDIT",
    parentCode: null,
    isPosting: false,
    sortOrder: 210,
  },
  {
    code: "211",
    name: "رأس المال المدفوع",
    type: "EQUITY",
    normalBalance: "CREDIT",
    parentCode: "21",
    isPosting: true,
    sortOrder: 211,
  },
  {
    code: "216",
    name: "الفائض المتراكم (الأرباح المحتجزة / المدورة)",
    type: "EQUITY",
    normalBalance: "CREDIT",
    parentCode: "21",
    isPosting: true,
    sortOrder: 216,
  },
  {
    code: "219",
    name: "رأس المال / الرصيد الافتتاحي المقيد",
    type: "EQUITY",
    normalBalance: "CREDIT",
    parentCode: "21",
    isPosting: true,
    sortOrder: 219,
  },
  {
    code: "22",
    name: "الحسابات الجارية لأصحاب المنشأة",
    type: "EQUITY",
    normalBalance: "CREDIT",
    parentCode: null,
    isPosting: false,
    sortOrder: 220,
  },
  {
    code: "221",
    name: "جاري المالك (تمويلات وسحوبات)",
    type: "EQUITY",
    normalBalance: "CREDIT",
    parentCode: "22",
    isPosting: true,
    sortOrder: 221,
    notes: "قرار المالك: إثبات تمويلات الخزينة والمصروفات المسددة منه شخصياً",
  },
  {
    code: "24",
    name: "قروض وتسهيلات مستحقة",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "2",
    isPosting: true,
    sortOrder: 240,
  },
  {
    code: "26",
    name: "الدائنون",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "2",
    isPosting: false,
    sortOrder: 260,
  },
  {
    code: "261",
    name: "الموردون (دائنو النشاط التجاري)",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "26",
    isPosting: true,
    sortOrder: 261,
  },
  {
    code: "2615",
    name: "بضاعة مستلمة غير مفوترة (GRNI)",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "26",
    isPosting: true,
    sortOrder: 2615,
  },
  {
    code: "263",
    name: "أمانات للغير وحسابات وسيطة",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "26",
    isPosting: false,
    sortOrder: 263,
  },
  {
    code: "2631",
    name: "أمانات أجور التوصيل لجهات التوصيل",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "263",
    isPosting: true,
    sortOrder: 2631,
    notes: "قرار المالك: تمرير وسيطة للمندوب لا تمس إيرادات أو أرباح الشركة",
  },
  {
    code: "2632",
    name: "ذمم مودعي بضائع الأمانة (Consignment)",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "263",
    isPosting: true,
    sortOrder: 2632,
  },
  {
    code: "265",
    name: "الرواتب والأجور المستحقة غير المدفوعة",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "26",
    isPosting: true,
    sortOrder: 265,
  },
  {
    code: "266",
    name: "مستحقات ضريبية وحكومية",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "26",
    isPosting: false,
    sortOrder: 266,
  },
  {
    code: "2661",
    name: "ضريبة دخل الرواتب المستحقة للتحويل",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "266",
    isPosting: true,
    sortOrder: 2661,
  },
  {
    code: "2662",
    name: "هيئة التقاعد والضمان الاجتماعي للعمال",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "266",
    isPosting: true,
    sortOrder: 2662,
  },
  {
    code: "2669",
    name: "ضرائب ورسوم مستحقة أخرى",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "266",
    isPosting: true,
    sortOrder: 2669,
  },
  {
    code: "267",
    name: "مخصص مكافأة نهاية الخدمة للعمال والموظفين",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "26",
    isPosting: true,
    sortOrder: 267,
  },
  {
    code: "268",
    name: "دائنون متنوعون ومصروفات مستحقة",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "26",
    isPosting: true,
    sortOrder: 268,
  },
  {
    code: "2682",
    name: "ذمم صيرفات دائنة — دينار عراقي",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "26",
    isPosting: true,
    sortOrder: 2682,
  },
  {
    code: "2683",
    name: "ذمم صيرفات دائنة — دولار بالقيمة الدفترية",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "26",
    isPosting: true,
    sortOrder: 2683,
  },
  {
    code: "269",
    name: "التزامات أخرى متنوعة",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    parentCode: "2",
    isPosting: true,
    sortOrder: 269,
  },

  // ==========================================
  // 3. الاستخدامات (المصروفات) — طبيعتها مدينة DEBIT
  // ==========================================
  {
    code: "3",
    name: "الاستخدامات (المصروفات والتكاليف)",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: null,
    isPosting: false,
    sortOrder: 300,
  },
  {
    code: "31",
    name: "الرواتب والأجور والمزايا",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "3",
    isPosting: false,
    sortOrder: 310,
  },
  {
    code: "311",
    name: "الرواتب والأجور النقدية للموظفين",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "31",
    isPosting: true,
    sortOrder: 311,
  },
  {
    code: "315",
    name: "مساهمة المنشأة في الضمان الاجتماعي",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "31",
    isPosting: true,
    sortOrder: 315,
  },
  {
    code: "317",
    name: "مصروف مخصص نهاية الخدمة",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "31",
    isPosting: true,
    sortOrder: 317,
  },
  {
    code: "32",
    name: "المستلزمات السلعية وتكلفة المبيعات",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "3",
    isPosting: false,
    sortOrder: 320,
  },
  {
    code: "321",
    name: "تكلفة البضاعة المباعة (كلفة مبيعات القرطاسية)",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "32",
    isPosting: true,
    sortOrder: 321,
  },
  {
    code: "322",
    name: "فروقات أسعار مرتجعات المشتريات",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "32",
    isPosting: true,
    sortOrder: 322,
  },
  {
    code: "323",
    name: "مستلزمات مكتبية واستهلاك داخلي للقرطاسية والورق",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "32",
    isPosting: true,
    sortOrder: 323,
    notes: "قرار المالك: إثبات استهلاك الورق والمواد داخلياً كمصروف مستقل",
  },
  {
    code: "327",
    name: "تالف وهدر مواد الطباعة والورق والخسائر السلعية",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "32",
    isPosting: true,
    sortOrder: 327,
    notes: "قرار المالك: حساب مستقل للتوالف والهدر الرقابي",
  },
  {
    code: "328",
    name: "تسويات تقييم المخزون الدوري",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "32",
    isPosting: true,
    sortOrder: 328,
  },
  {
    code: "33",
    name: "المستلزمات الخدمية ومصروفات التشغيل",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "3",
    isPosting: false,
    sortOrder: 330,
  },
  {
    code: "331",
    name: "إيجار المحلات والمخازن",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "33",
    isPosting: true,
    sortOrder: 331,
  },
  {
    code: "332",
    name: "صيانة وتشغيل آلات الطباعة والأجهزة",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "33",
    isPosting: true,
    sortOrder: 332,
  },
  {
    code: "333",
    name: "كهرباء ومولدات ومياه ووقود",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "33",
    isPosting: true,
    sortOrder: 333,
  },
  {
    code: "335",
    name: "دعاية وإعلان وهدايا وترويج",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "33",
    isPosting: true,
    sortOrder: 335,
    notes: "قرار المالك: إثبات الهدايا الترويجية كبند رقابي مستقل",
  },
  {
    code: "336",
    name: "أجور ونقل التوصيل (المصروفات المباشرة إن وجدت)",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "33",
    isPosting: true,
    sortOrder: 336,
  },
  {
    code: "339",
    name: "مصروفات تشغيلية وإدارية عامة",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "33",
    isPosting: true,
    sortOrder: 339,
  },
  {
    code: "37",
    name: "الاندثار (استهلاك الموجودات الثابتة)",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "3",
    isPosting: true,
    sortOrder: 370,
  },
  {
    code: "38",
    name: "مصروفات وأعباء تحويلية وأخرى",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "3",
    isPosting: false,
    sortOrder: 380,
  },
  {
    code: "383",
    name: "فروق التقريب النقدي بالدينار العراقي",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "38",
    isPosting: true,
    sortOrder: 383,
  },
  {
    code: "384",
    name: "خسائر فروقات تصريف العملات",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "38",
    isPosting: true,
    sortOrder: 384,
  },
  {
    code: "385",
    name: "خسائر استبعاد الموجودات الثابتة",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "38",
    isPosting: true,
    sortOrder: 385,
  },
  {
    code: "39",
    name: "مصروفات أخرى متنوعة",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    parentCode: "3",
    isPosting: true,
    sortOrder: 390,
  },

  // ==========================================
  // 4. الموارد (الإيرادات) — طبيعتها دائنة CREDIT
  // ==========================================
  {
    code: "4",
    name: "الموارد (الإيرادات)",
    type: "REVENUE",
    normalBalance: "CREDIT",
    parentCode: null,
    isPosting: false,
    sortOrder: 400,
  },
  {
    code: "41",
    name: "إيراد النشاط الجاري",
    type: "REVENUE",
    normalBalance: "CREDIT",
    parentCode: "4",
    isPosting: false,
    sortOrder: 410,
  },
  {
    code: "411",
    name: "إيراد مبيعات القرطاسية والكتب والمكتبيات",
    type: "REVENUE",
    normalBalance: "CREDIT",
    parentCode: "41",
    isPosting: true,
    sortOrder: 411,
  },
  {
    code: "412",
    name: "إيراد خدمات المطبعة الرقمية والتصوير",
    type: "REVENUE",
    normalBalance: "CREDIT",
    parentCode: "41",
    isPosting: true,
    sortOrder: 412,
  },
  {
    code: "413",
    name: "إيراد خدمات الفلكس والطباعة العريضة",
    type: "REVENUE",
    normalBalance: "CREDIT",
    parentCode: "41",
    isPosting: true,
    sortOrder: 413,
  },
  {
    code: "414",
    name: "إيراد خدمات التوصيل",
    type: "REVENUE",
    normalBalance: "CREDIT",
    parentCode: "41",
    isPosting: true,
    sortOrder: 414,
  },
  {
    code: "415",
    name: "عمولات الصيرفة والتحويلات",
    type: "REVENUE",
    normalBalance: "CREDIT",
    parentCode: "41",
    isPosting: true,
    sortOrder: 415,
  },
  {
    code: "48",
    name: "إيرادات تحويلية ورأسمالية وأخرى",
    type: "REVENUE",
    normalBalance: "CREDIT",
    parentCode: "4",
    isPosting: false,
    sortOrder: 480,
  },
  {
    code: "483",
    name: "أرباح فروقات تصريف العملات",
    type: "REVENUE",
    normalBalance: "CREDIT",
    parentCode: "48",
    isPosting: true,
    sortOrder: 483,
  },
  {
    code: "485",
    name: "أرباح استبعاد الموجودات الثابتة",
    type: "REVENUE",
    normalBalance: "CREDIT",
    parentCode: "48",
    isPosting: true,
    sortOrder: 485,
  },
  {
    code: "49",
    name: "إيرادات متنوعة أخرى",
    type: "REVENUE",
    normalBalance: "CREDIT",
    parentCode: "4",
    isPosting: true,
    sortOrder: 490,
  },
];

/**
 * خريطة الربط الإلزامية الكاملة بين الأدوار التشغيلية للنظام (`accounts.systemRole`)
 * ورموز دليل النظام المحاسبي الموحد العراقي (`statutoryAccounts.code`).
 * تغطي كل الـ 63 دوراً المسجلة في النظام بنسبة 100%.
 */
export const SYSTEM_ROLE_TO_IRAQI_UNIFIED_CODE: Record<string, string> = {
  // الموجودات
  CASH: "181", // الصندوق
  CARD_BANK: "183", // المصرف / البطاقات
  INVENTORY: "131", // المخزون
  AR: "151", // العملاء
  EMPLOYEE_ADVANCES: "153", // سلف الموظفين
  FIXED_ASSETS: "113", // الأصول الثابتة
  TREASURY_CASH: "182", // الخزينة
  CASH_IN_TRANSIT: "188", // نقد في الطريق
  DELIVERY_FLOAT: "1581", // عهدة المناديب (قرار المالك)
  EXCHANGE_WALLET_IQD: "185", // صيرفة دينار
  EXCHANGE_WALLET_USD: "186", // صيرفة دولار
  DIGITAL_WALLET: "184", // محافظ رقمية
  ACCUMULATED_DEPRECIATION: "118", // مجمع الاندثار
  FOREIGN_CASH_USD: "187", // نقد أجنبي بالخزينة
  CHECKS_RECEIVABLE: "189", // شيكات برسم التحصيل
  PAYMENT_WALLET: "184", // محافظ الدفع والتحصيل
  TELECOM_BALANCE: "1845", // رصيد اتصالات
  WORK_IN_PROGRESS: "12", // إنتاج تحت التشغيل
  INTERBRANCH_CLEARING: "19", // تسويات بين الفروع
  EXCHANGE_RECEIVABLE_IQD: "1582", // ذمم صيرفة مدينة د.ع
  EXCHANGE_RECEIVABLE_USD: "1583", // ذمم صيرفة مدينة دولار

  // المطلوبات وحقوق الملكية
  CAPITAL: "211", // رأس المال
  RETAINED_EARNINGS: "216", // الأرباح المحتجزة
  OPENING_EQUITY: "219", // رصيد افتتاحي
  OWNER_CURRENT: "221", // جاري المالك (قرار المالك)
  AP: "261", // الموردون
  GRNI: "2615", // بضاعة مستلمة غير مفوترة
  CONSIGNMENT_PAYABLE: "2632", // أمانات بضائع
  COURIER_PAYABLE: "2631", // أمانات أجور التوصيل (قرار المالك)
  ACCRUED_SALARY: "265", // رواتب مستحقة
  PAYROLL_TAX_PAYABLE: "2661", // ضريبة دخل رواتب
  SOCIAL_SECURITY_PAYABLE: "2662", // ضمان اجتماعي مستحق
  TAX_PAYABLE: "2669", // ضرائب ورسوم مستحقة
  EOS_PROVISION: "267", // مخصص نهاية الخدمة
  ACCRUED_EXPENSES: "268", // مصروفات مستحقة
  EXCHANGE_PAYABLE_IQD: "2682", // ذمم صيرفة دائنة د.ع
  EXCHANGE_PAYABLE_USD: "2683", // ذمم صيرفة دائنة دولار
  LOAN_PAYABLE: "24", // قروض مستحقة
  OTHER_LIABILITY: "269", // التزامات أخرى

  // المصروفات والاستخدامات
  COGS: "321", // تكلفة المبيعات
  SALARIES: "311", // الرواتب والأجور
  SOCIAL_SECURITY_EXPENSE: "315", // حصة الضمان الاجتماعي
  EOS_EXPENSE: "317", // مصروف مخصص نهاية الخدمة
  RENT: "331", // الإيجار
  UTILITIES: "333", // الكهرباء والخدمات
  OPERATING_EXPENSE: "339", // مصروفات تشغيلية
  LOSSES: "327", // تالف وهدر مواد وخسائر (قرار المالك)
  GIFTS_PROMO: "335", // هدايا وترويج (قرار المالك)
  DELIVERY_EXPENSE: "336", // مصروف التوصيل
  DEPRECIATION_EXPENSE: "37", // استهلاك الموجودات الثابتة
  ROUNDING_DIFF: "383", // فروق التقريب
  FX_LOSS: "384", // خسائر الصرف
  ASSET_DISPOSAL_LOSS: "385", // خسائر استبعاد أصول
  PURCHASE_PRICE_VARIANCE: "322", // فروقات مرتجع الشراء
  INVENTORY_REVALUATION: "328", // تسوية تقييم المخزون
  OTHER_EXPENSE: "39", // مصروفات أخرى

  // الإيرادات والموارد
  SALES_STATIONERY: "411", // مبيعات القرطاسية
  SALES_PRINT: "412", // إيراد المطبعة
  SALES_FLEX: "413", // إيراد الفلكس
  DELIVERY_REVENUE: "414", // إيراد التوصيل
  EXCHANGE_COMMISSION: "415", // عمولات الصيرفة
  FX_GAIN: "483", // أرباح الصرف
  ASSET_DISPOSAL_GAIN: "485", // أرباح استبعاد أصول
  OTHER_REVENUE: "49", // إيرادات أخرى
};
