// شجرة الحسابات — مصدر البذر (P0). مصدرُ الحقيقة للـTS: يستعمله اختبار الدفتر المزدوج (بذرٌ ذاتيّ
// في beforeEach). الإنتاج وقواعد db:migrate:apply يُبذَران بالهجرة 0115 (SQL ثابت مطابقٌ لهذه القائمة)
// — **أبقِ الاثنين متطابقين عند التعديل**. كل حساب يحمل systemRole يربطه بالمفهوم القائم (P1، محرّك
// القيود postingEngine.ts). الرؤوس الخمسة بلا systemRole (parentId=null).
export interface SeedAccount {
  id: number;
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  parentId: number | null;
  systemRole: string | null;
  sortOrder: number;
}

export const CHART_ACCOUNTS: SeedAccount[] = [
  { id: 1, code: "1000", name: "الأصول", type: "ASSET", parentId: null, systemRole: null, sortOrder: 10 },
  { id: 2, code: "1100", name: "الصندوق", type: "ASSET", parentId: 1, systemRole: "CASH", sortOrder: 11 },
  { id: 3, code: "1150", name: "البطاقة / البنك", type: "ASSET", parentId: 1, systemRole: "CARD_BANK", sortOrder: 12 },
  { id: 4, code: "1200", name: "المخزون", type: "ASSET", parentId: 1, systemRole: "INVENTORY", sortOrder: 13 },
  { id: 5, code: "1300", name: "ذمم العملاء (مدينون)", type: "ASSET", parentId: 1, systemRole: "AR", sortOrder: 14 },
  { id: 6, code: "1400", name: "سلف الموظفين", type: "ASSET", parentId: 1, systemRole: "EMPLOYEE_ADVANCES", sortOrder: 15 },
  { id: 7, code: "1500", name: "الأصول الثابتة", type: "ASSET", parentId: 1, systemRole: "FIXED_ASSETS", sortOrder: 16 },
  { id: 8, code: "2000", name: "الالتزامات", type: "LIABILITY", parentId: null, systemRole: null, sortOrder: 20 },
  { id: 9, code: "2100", name: "ذمم الموردين (دائنون)", type: "LIABILITY", parentId: 8, systemRole: "AP", sortOrder: 21 },
  { id: 10, code: "2200", name: "ذمم مودِعي الأمانة", type: "LIABILITY", parentId: 8, systemRole: "CONSIGNMENT_PAYABLE", sortOrder: 22 },
  { id: 11, code: "2300", name: "رواتب مستحقة", type: "LIABILITY", parentId: 8, systemRole: "ACCRUED_SALARY", sortOrder: 23 },
  { id: 12, code: "2900", name: "التزامات أخرى", type: "LIABILITY", parentId: 8, systemRole: "OTHER_LIABILITY", sortOrder: 29 },
  { id: 13, code: "3000", name: "حقوق الملكية", type: "EQUITY", parentId: null, systemRole: null, sortOrder: 30 },
  { id: 14, code: "3100", name: "رأس المال", type: "EQUITY", parentId: 13, systemRole: "CAPITAL", sortOrder: 31 },
  { id: 15, code: "3200", name: "الأرباح المحتجزة", type: "EQUITY", parentId: 13, systemRole: "RETAINED_EARNINGS", sortOrder: 32 },
  { id: 16, code: "3900", name: "رصيد افتتاحيّ", type: "EQUITY", parentId: 13, systemRole: "OPENING_EQUITY", sortOrder: 39 },
  { id: 17, code: "4000", name: "الإيرادات", type: "REVENUE", parentId: null, systemRole: null, sortOrder: 40 },
  { id: 18, code: "4100", name: "مبيعات القرطاسية والكتب", type: "REVENUE", parentId: 17, systemRole: "SALES_STATIONERY", sortOrder: 41 },
  { id: 19, code: "4200", name: "إيرادات المطبعة الرقمية", type: "REVENUE", parentId: 17, systemRole: "SALES_PRINT", sortOrder: 42 },
  { id: 20, code: "4300", name: "إيرادات الفلكس / الطباعة العريضة", type: "REVENUE", parentId: 17, systemRole: "SALES_FLEX", sortOrder: 43 },
  { id: 21, code: "4400", name: "إيرادات التوصيل", type: "REVENUE", parentId: 17, systemRole: "DELIVERY_REVENUE", sortOrder: 44 },
  { id: 22, code: "4500", name: "عمولات الصيرفة", type: "REVENUE", parentId: 17, systemRole: "EXCHANGE_COMMISSION", sortOrder: 45 },
  { id: 23, code: "4900", name: "إيرادات أخرى", type: "REVENUE", parentId: 17, systemRole: "OTHER_REVENUE", sortOrder: 49 },
  { id: 24, code: "5000", name: "المصروفات", type: "EXPENSE", parentId: null, systemRole: null, sortOrder: 50 },
  { id: 25, code: "5100", name: "تكلفة المبيعات", type: "EXPENSE", parentId: 24, systemRole: "COGS", sortOrder: 51 },
  { id: 26, code: "5200", name: "الرواتب والأجور", type: "EXPENSE", parentId: 24, systemRole: "SALARIES", sortOrder: 52 },
  { id: 27, code: "5300", name: "الإيجار", type: "EXPENSE", parentId: 24, systemRole: "RENT", sortOrder: 53 },
  { id: 28, code: "5400", name: "الكهرباء والخدمات", type: "EXPENSE", parentId: 24, systemRole: "UTILITIES", sortOrder: 54 },
  { id: 29, code: "5500", name: "مصروفات تشغيلية عامة", type: "EXPENSE", parentId: 24, systemRole: "OPERATING_EXPENSE", sortOrder: 55 },
  { id: 30, code: "5600", name: "خسائر (تالف / شحن غير مسترد / فروق)", type: "EXPENSE", parentId: 24, systemRole: "LOSSES", sortOrder: 56 },
  { id: 31, code: "5900", name: "مصروفات أخرى", type: "EXPENSE", parentId: 24, systemRole: "OTHER_EXPENSE", sortOrder: 59 },
];
