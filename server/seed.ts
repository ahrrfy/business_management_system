import "dotenv/config";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { assetCustodyLog, assetMaintenance, branches, categories, employees, fixedAssets, productVariants, products, suppliers, users } from "../drizzle/schema";
import { isStrongPassword } from "../shared/const";
import { hashPassword } from "./auth/password";
import { getDb } from "./db";
import { createProduct } from "./services/catalogService";
import { setStock } from "./services/inventoryService";
import { withTx } from "./services/tx";
import { extractInsertId } from "./lib/insertId";

async function seed() {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is required to seed");

  // SEED_MODE=prod (عبر pnpm seed:prod): بذرة إنتاج نظيفة — مدير + فرعان + فئات أساس فقط،
  // بلا منتجات/مورد عيّنة. سلوك مستقلّ عن NODE_ENV (G17) كي لا تتسرّب عيّنات لقاعدة حقيقية.
  const isProd = process.env.SEED_MODE === "prod";
  if (isProd) {
    const pw = process.env.ADMIN_PASSWORD ?? "";
    // نرفض القيم المنشورة في المستودع (الافتراضية + قيمة القالب) — من ينسخ القالب بلا تحرير
    // سيُنشئ admin بكلمة معروفة علناً على نظام مكشوف للإنترنت.
    const published = new Set(["Admin@12345", "ضع-كلمة-قوية-هنا"]);
    if (pw.length < 10 || published.has(pw) || !isStrongPassword(pw)) {
      throw new Error(
        "بذرة الإنتاج تتطلّب ADMIN_PASSWORD قوية في .env: ≥١٠ أحرف تحوي حرفاً ورقماً، وليست القيمة الافتراضية ولا قيمة القالب."
      );
    }
  }

  // Branches — idempotent per-code so older DBs that only have MAIN backfill SALES.
  const targetBranches = [
    { name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" as const },
    { name: "فرع المبيعات", code: "SALES", type: "SALES" as const },
  ];
  for (const b of targetBranches) {
    const exists = (await db.select().from(branches).where(eq(branches.code, b.code)).limit(1))[0];
    if (!exists) {
      await db.insert(branches).values(b);
      console.log(`✓ seeded branch ${b.code}`);
    }
  }
  const mainBranch = (await db.select().from(branches).where(eq(branches.code, "MAIN")).limit(1))[0];

  if (!isProd) {
    // Sample supplier (so the purchase-order screen isn't empty on first run)
    const existingSuppliers = await db.select().from(suppliers).limit(1);
    if (!existingSuppliers.length) {
      await db.insert(suppliers).values({ name: "مورد القرطاسية العام", phone: "07700000000", city: "بغداد", paymentTerms: "آجل ٣٠ يوم" });
      console.log("✓ seeded sample supplier");
    } else {
      console.log("• suppliers already exist, skipping");
    }
  }

  // Admin user
  const email = process.env.ADMIN_EMAIL ?? "admin@alroya.local";
  const password = process.env.ADMIN_PASSWORD ?? "Admin@12345";
  let admin = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (!admin) {
    await db.insert(users).values({
      openId: `local_${nanoid()}`,
      email,
      // اسم مستخدم افتراضي للمدير ⇒ يمكنه الدخول بـ«admin» أو بالبريد (طلب المالك: «اما بريد او اسم»).
      username: process.env.ADMIN_USERNAME ?? "admin",
      name: "المدير العام",
      passwordHash: hashPassword(password),
      role: "admin",
      loginMethod: "local",
      branchId: mainBranch ? Number(mainBranch.id) : null,
      // AUTH-02: حدّ الإبطال أقدم بثانيتين من الإنشاء كي لا يُرفَض دخولٌ في نفس الثانية
      // (٢٠٠٠ms لتجاوز تقريب عمود TIMESTAMP لأقرب ثانية).
      sessionsValidFrom: new Date(Date.now() - 2000),
    });
    admin = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
    console.log(`✓ seeded admin user: ${email}`);
  } else {
    console.log(`• admin ${email} already exists, skipping`);
  }

  if (isProd) {
    // فئات الأساس فقط (idempotent بالاسم) — شاشات المنتج تحتاج فئة واحدة على الأقل، ولا عيّنات.
    for (const name of ["قرطاسية", "طباعة", "هدايا وتخرج", "تجهيزات مكتبية"]) {
      const exists = (await db.select().from(categories).where(eq(categories.name, name)).limit(1))[0];
      if (!exists) {
        await db.insert(categories).values({ name });
        console.log(`✓ seeded category ${name}`);
      }
    }
    console.log("✓ بذرة الإنتاج اكتملت: مدير + فرعان + فئات أساس (بلا عيّنات).");
    return;
  }

  // ===== موظفون + أصول ثابتة (عيّنة تطوير واقعية) — idempotent =====
  // عهدة الأصول تربط الموظف بأصله، فنبذر الموظفين (المسؤولين عن العهد) أولاً ثم نربط الأصول بهم.
  const assetEmployees = [
    { code: "EMP-1008", firstName: "علي حسن", lastName: "الجبوري", position: "مدير الموارد البشرية", department: "الموارد البشرية", branch: "MAIN", salary: "1500000", hireDate: "2018-03-01", email: "ali.jubouri@alroya.local", phone: "+9647700000008" },
    { code: "EMP-1019", firstName: "محمد عبد الرحمن", lastName: "العزاوي", position: "رئيس قسم الطباعة", department: "المطبعة", branch: "MAIN", salary: "1300000", hireDate: "2019-02-15", email: "m.azzawi@alroya.local", phone: "+9647700000019" },
    { code: "EMP-1027", firstName: "حيدر كاظم", lastName: "الربيعي", position: "أمين المخزن", department: "المخزن", branch: "MAIN", salary: "900000", hireDate: "2020-06-01", email: "h.rabiee@alroya.local", phone: "+9647700000027" },
    { code: "EMP-1031", firstName: "سيف الدين", lastName: "الكناني", position: "محاسب", department: "المحاسبة", branch: "MAIN", salary: "1100000", hireDate: "2021-09-10", email: "saif.accountant@alroya.local", phone: "+9647700000031" },
    { code: "EMP-1042", firstName: "عمر فاروق", lastName: "الدليمي", position: "موظف مبيعات", department: "المبيعات", branch: "MAIN", salary: "850000", hireDate: "2023-04-01", email: "omar.sales@alroya.local", phone: "+9647700000042" },
    { code: "EMP-1043", firstName: "زينب صباح", lastName: "التميمي", position: "مصمّمة جرافيك", department: "التصميم", branch: "MAIN", salary: "1000000", hireDate: "2022-07-20", email: "zainab.design@alroya.local", phone: "+9647700000043" },
    { code: "EMP-1052", firstName: "مصطفى وليد", lastName: "الحديثي", position: "موظف (سابق)", department: "عام", branch: "MAIN", salary: "800000", hireDate: "2017-05-01", email: "mustafa.former@alroya.local", phone: "+9647700000052" },
    { code: "EMP-1061", firstName: "نور الهدى", lastName: "الجنابي", position: "كاشير الفرع", department: "المبيعات", branch: "SALES", salary: "800000", hireDate: "2021-08-01", email: "noor.sales@alroya.local", phone: "+9647700000061" },
    { code: "EMP-1063", firstName: "كرار محمد", lastName: "الساعدي", position: "سائق توصيل", department: "التوصيل", branch: "MAIN", salary: "750000", hireDate: "2022-11-01", email: "karrar.driver@alroya.local", phone: "+9647700000063" },
  ];
  const empIdByCode = new Map<string, number>();
  for (const e of assetEmployees) {
    const br = (await db.select().from(branches).where(eq(branches.code, e.branch)).limit(1))[0];
    let row = (await db.select().from(employees).where(eq(employees.email, e.email)).limit(1))[0];
    if (!row) {
      await db.insert(employees).values({
        firstName: e.firstName, lastName: e.lastName, email: e.email, phone: e.phone,
        position: e.position, department: e.department, salary: e.salary,
        hireDate: e.hireDate, branchId: br ? Number(br.id) : null, isActive: true,
      });
      row = (await db.select().from(employees).where(eq(employees.email, e.email)).limit(1))[0];
    }
    empIdByCode.set(e.code, Number(row.id));
  }
  console.log(`✓ seeded ${assetEmployees.length} employees (asset custodians)`);

  const existingAssets = await db.select().from(fixedAssets).limit(1);
  if (!existingAssets.length) {
    const salesBranch = (await db.select().from(branches).where(eq(branches.code, "SALES")).limit(1))[0];
    const branchIdOf = (code: "MAIN" | "SALES") =>
      code === "SALES" ? (salesBranch ? Number(salesBranch.id) : Number(mainBranch!.id)) : Number(mainBranch!.id);

    type SeedAsset = {
      code: string; name: string; category: "computers" | "display" | "furniture" | "vehicles" | "printing" | "devices";
      brand: string | null; serial: string; branch: "MAIN" | "SALES"; location: string; custodian: string | null;
      purchaseDate: string; purchaseValue: string; salvageValue: string; life: number; method: "sl" | "db";
      condition: string; warrantyEnd: string | null; status: "active" | "maintenance" | "retired" | "disposed";
      disposalDate?: string; disposalValue?: string; disposalReason?: string;
      custody: { code: string; from: string; to: string | null; note?: string }[];
      maintenance: { date: string; type: string; cost: string; vendor: string; note: string }[];
    };
    const assetSeed: SeedAsset[] = [
      { code: "AST-1001", name: "لابتوب Dell Latitude 5440", category: "computers", brand: "Dell", serial: "DL5440-7781", branch: "MAIN", location: "مكتب إدارة المبيعات", custodian: "EMP-1042", purchaseDate: "2023-04-10", purchaseValue: "1850000", salvageValue: "150000", life: 4, method: "db", condition: "ممتاز", warrantyEnd: "2026-04-10", status: "active",
        custody: [{ code: "EMP-1042", from: "2023-04-12", to: null, note: "تسليم عند الاستلام الوظيفي" }],
        maintenance: [{ date: "2025-02-18", type: "تنظيف وصيانة دورية", cost: "25000", vendor: "الزاد للحاسبات", note: "تغيير معجون حراري وتنظيف مروحة" }] },
      { code: "AST-1002", name: "محطة عمل تصميم iMac 27\"", category: "computers", brand: "Apple", serial: "IMAC27-3392", branch: "MAIN", location: "قسم التصميم الجرافيكي", custodian: "EMP-1043", purchaseDate: "2022-08-01", purchaseValue: "4200000", salvageValue: "500000", life: 5, method: "sl", condition: "جيد", warrantyEnd: "2025-08-01", status: "active",
        custody: [{ code: "EMP-1043", from: "2022-08-03", to: null, note: "عهدة قسم التصميم" }],
        maintenance: [{ date: "2024-11-05", type: "ترقية ذاكرة", cost: "320000", vendor: "ماك ستور بغداد", note: "رفع الذاكرة إلى 32GB" }] },
      { code: "AST-1003", name: "شاشة تصميم احترافية 32\" 4K", category: "display", brand: "BenQ", serial: "BQ32UHD-1180", branch: "MAIN", location: "قسم التصميم الجرافيكي", custodian: "EMP-1043", purchaseDate: "2023-01-15", purchaseValue: "1350000", salvageValue: "100000", life: 5, method: "sl", condition: "ممتاز", warrantyEnd: "2026-01-15", status: "active",
        custody: [{ code: "EMP-1043", from: "2023-01-16", to: null }], maintenance: [] },
      { code: "AST-1004", name: "ماكنة طباعة أوفسيت GTO 52", category: "printing", brand: "Heidelberg", serial: "HDB-GTO52-9920", branch: "MAIN", location: "صالة الطباعة", custodian: "EMP-1019", purchaseDate: "2019-09-20", purchaseValue: "78000000", salvageValue: "8000000", life: 12, method: "sl", condition: "جيد", warrantyEnd: "2022-09-20", status: "active",
        custody: [{ code: "EMP-1019", from: "2019-09-25", to: null, note: "تحت إشراف رئيس قسم الطباعة" }],
        maintenance: [
          { date: "2025-12-10", type: "صيانة كبرى", cost: "1450000", vendor: "مكتب الشرق", note: "تغيير أسطوانات الحبر وضبط التزامن" },
          { date: "2024-06-22", type: "استبدال قطع", cost: "680000", vendor: "مكتب الشرق", note: "بكرات تغذية الورق" },
          { date: "2023-05-14", type: "صيانة دورية", cost: "250000", vendor: "فني داخلي", note: "تشحيم وضبط" },
        ] },
      { code: "AST-1005", name: "ماكنة قص وتجليد كهربائية", category: "printing", brand: "Polar", serial: "PLR-CUT-4471", branch: "MAIN", location: "صالة الطباعة", custodian: "EMP-1019", purchaseDate: "2021-03-05", purchaseValue: "9500000", salvageValue: "1000000", life: 10, method: "sl", condition: "يحتاج صيانة", warrantyEnd: "2023-03-05", status: "maintenance",
        custody: [{ code: "EMP-1019", from: "2021-03-08", to: null }],
        maintenance: [{ date: "2026-06-09", type: "عطل — قيد الإصلاح", cost: "0", vendor: "مكتب الشرق", note: "خلل في حساس السكين — بانتظار قطعة الغيار" }] },
      { code: "AST-1006", name: "سيّارة توصيل كيا K2700", category: "vehicles", brand: "Kia", serial: "KIA-K2700-2024", branch: "MAIN", location: "ساحة المرآب", custodian: "EMP-1063", purchaseDate: "2022-11-12", purchaseValue: "23500000", salvageValue: "6000000", life: 8, method: "db", condition: "جيد", warrantyEnd: "2025-11-12", status: "active",
        custody: [{ code: "EMP-1063", from: "2023-11-22", to: null, note: "سائق التوصيل المسؤول" }],
        maintenance: [
          { date: "2026-03-01", type: "تغيير زيت ومرشّحات", cost: "95000", vendor: "كراج الرافدين", note: "صيانة دورية 20,000 كم" },
          { date: "2025-09-18", type: "إطارات جديدة", cost: "520000", vendor: "محل الإطارات", note: "أربعة إطارات" },
        ] },
      { code: "AST-1007", name: "دراجة نارية توصيل هوندا", category: "vehicles", brand: "Honda", serial: "HND-125-7745", branch: "SALES", location: "مدخل فرع المبيعات", custodian: null, purchaseDate: "2024-02-20", purchaseValue: "3200000", salvageValue: "600000", life: 6, method: "sl", condition: "ممتاز", warrantyEnd: "2026-02-20", status: "active",
        custody: [], maintenance: [] },
      { code: "AST-1008", name: "جهاز بصمة — المدخل الرئيسي", category: "devices", brand: "ZKTeco", serial: "ZK-MB360-0001", branch: "MAIN", location: "بوابة الفرع الرئيسي", custodian: "EMP-1008", purchaseDate: "2021-06-01", purchaseValue: "420000", salvageValue: "40000", life: 5, method: "sl", condition: "جيد", warrantyEnd: "2023-06-01", status: "active",
        custody: [{ code: "EMP-1008", from: "2021-06-01", to: null, note: "تحت إدارة الموارد البشرية" }], maintenance: [] },
      { code: "AST-1009", name: "جهاز بصمة — فرع المبيعات", category: "devices", brand: "ZKTeco", serial: "ZK-MB360-0002", branch: "SALES", location: "مدخل فرع المبيعات", custodian: "EMP-1008", purchaseDate: "2022-09-10", purchaseValue: "380000", salvageValue: "40000", life: 5, method: "sl", condition: "جيد", warrantyEnd: "2024-09-10", status: "active",
        custody: [{ code: "EMP-1008", from: "2022-09-10", to: null }], maintenance: [] },
      { code: "AST-1010", name: "جهاز بصمة — باب المخزن", category: "devices", brand: "ZKTeco", serial: "ZK-F18-0003", branch: "MAIN", location: "مخزن البضاعة", custodian: "EMP-1027", purchaseDate: "2020-12-15", purchaseValue: "300000", salvageValue: "30000", life: 5, method: "sl", condition: "يحتاج صيانة", warrantyEnd: "2022-12-15", status: "maintenance",
        custody: [{ code: "EMP-1027", from: "2020-12-15", to: null }],
        maintenance: [{ date: "2026-06-12", type: "انقطاع اتصال متكرر", cost: "0", vendor: "فني داخلي", note: "فحص الشبكة والكيبل" }] },
      { code: "AST-1011", name: "طابعة ليزر ملوّنة A3", category: "printing", brand: "Canon", serial: "CN-IRC3226-5510", branch: "SALES", location: "مكتب فرع المبيعات", custodian: "EMP-1061", purchaseDate: "2023-07-25", purchaseValue: "5400000", salvageValue: "600000", life: 7, method: "sl", condition: "جيد", warrantyEnd: "2025-07-25", status: "active",
        custody: [{ code: "EMP-1061", from: "2023-07-26", to: null }],
        maintenance: [{ date: "2025-10-02", type: "استبدال أسطوانة", cost: "240000", vendor: "كانون العراق", note: "Drum unit" }] },
      { code: "AST-1012", name: "طقم أثاث مكتب الإدارة", category: "furniture", brand: null, serial: "FRN-EXEC-0090", branch: "MAIN", location: "مكتب الإدارة", custodian: "EMP-1008", purchaseDate: "2020-03-01", purchaseValue: "2800000", salvageValue: "200000", life: 10, method: "sl", condition: "جيد", warrantyEnd: null, status: "active",
        custody: [{ code: "EMP-1008", from: "2020-03-01", to: null, note: "أثاث ثابت للمكتب" }], maintenance: [] },
      { code: "AST-1013", name: "كاونتر كاشير + أدراج نقدية", category: "furniture", brand: null, serial: "FRN-POS-0112", branch: "SALES", location: "منطقة الكاشير", custodian: "EMP-1061", purchaseDate: "2021-08-14", purchaseValue: "1200000", salvageValue: "100000", life: 10, method: "sl", condition: "متوسط", warrantyEnd: null, status: "active",
        custody: [{ code: "EMP-1061", from: "2021-08-14", to: null }], maintenance: [] },
      { code: "AST-1014", name: "رافعة شوكية يدوية (عربة مخزن)", category: "vehicles", brand: "Toyota", serial: "TY-PALLET-3380", branch: "MAIN", location: "مخزن البضاعة", custodian: "EMP-1027", purchaseDate: "2021-05-30", purchaseValue: "2100000", salvageValue: "300000", life: 10, method: "sl", condition: "جيد", warrantyEnd: null, status: "active",
        custody: [{ code: "EMP-1027", from: "2021-05-30", to: null }], maintenance: [] },
      { code: "AST-1015", name: "لابتوب HP ProBook (محاسبة)", category: "computers", brand: "HP", serial: "HP-PB450-6612", branch: "MAIN", location: "قسم المحاسبة", custodian: "EMP-1031", purchaseDate: "2024-01-08", purchaseValue: "1650000", salvageValue: "150000", life: 4, method: "db", condition: "ممتاز", warrantyEnd: "2027-01-08", status: "active",
        custody: [{ code: "EMP-1031", from: "2024-01-09", to: null }], maintenance: [] },
      { code: "AST-1016", name: "لابتوب Lenovo قديم", category: "computers", brand: "Lenovo", serial: "LN-G50-1102", branch: "MAIN", location: "المخزن — أصول مُستبعَدة", custodian: null, purchaseDate: "2018-02-10", purchaseValue: "950000", salvageValue: "80000", life: 4, method: "sl", condition: "خردة", warrantyEnd: "2020-02-10", status: "disposed", disposalDate: "2025-12-01", disposalValue: "90000", disposalReason: "بيع كخردة",
        custody: [{ code: "EMP-1052", from: "2018-02-10", to: "2024-10-01", note: "أُعيدت قبل الاستبعاد" }], maintenance: [] },
      { code: "AST-1017", name: "مكيّف سبليت 2 طن — صالة الطباعة", category: "furniture", brand: "Gree", serial: "GR-AC24-0077", branch: "MAIN", location: "صالة الطباعة", custodian: "EMP-1019", purchaseDate: "2022-05-20", purchaseValue: "1450000", salvageValue: "150000", life: 8, method: "sl", condition: "خارج الخدمة", warrantyEnd: "2024-05-20", status: "retired", disposalDate: "2025-07-01", disposalReason: "عطل كومبريسر — الإصلاح غير مجدٍ، أُخرج من الخدمة",
        custody: [{ code: "EMP-1019", from: "2022-05-20", to: "2025-07-01" }],
        maintenance: [{ date: "2025-07-01", type: "عطل كومبريسر", cost: "0", vendor: "معرض التبريد", note: "تكلفة الإصلاح غير مجدية — أُخرج من الخدمة" }] },
    ];

    for (const a of assetSeed) {
      const [res] = await db.insert(fixedAssets).values({
        code: a.code, name: a.name, category: a.category, brand: a.brand, serial: a.serial,
        branchId: branchIdOf(a.branch), location: a.location,
        custodianId: a.custodian ? empIdByCode.get(a.custodian) ?? null : null,
        supplierId: null,
        purchaseDate: a.purchaseDate, purchaseValue: a.purchaseValue, salvageValue: a.salvageValue,
        usefulLifeYears: a.life, depreciationMethod: a.method, condition: a.condition, warrantyEnd: a.warrantyEnd,
        status: a.status, disposalDate: a.disposalDate ?? null, disposalValue: a.disposalValue ?? null, disposalReason: a.disposalReason ?? null,
      });
      const id = extractInsertId(res);
      for (const c of a.custody) {
        const eid = empIdByCode.get(c.code);
        if (eid) await db.insert(assetCustodyLog).values({ assetId: id, employeeId: eid, fromDate: c.from, toDate: c.to, note: c.note ?? null });
      }
      for (const m of a.maintenance) {
        await db.insert(assetMaintenance).values({ assetId: id, maintDate: m.date, type: m.type, cost: m.cost, vendor: m.vendor, note: m.note });
      }
    }
    console.log(`✓ seeded ${assetSeed.length} fixed assets with custody + maintenance`);
  } else {
    console.log("• fixed assets already exist, skipping asset seed");
  }

  // Sample catalog (only if empty)
  const existingProducts = await db.select().from(products).limit(1);
  if (existingProducts.length) {
    console.log("• products already exist, skipping catalog seed");
    return;
  }

  const actor = { userId: admin!.id, branchId: Number(mainBranch!.id) };
  const branchId = Number(mainBranch!.id);

  // DIM-MIG-05: إدراج idempotent (categories.name فريد) — كان الإدراج غير المشروط يَفشل لو سبق
  // بذر الفئة (بذر prod-style ثم dev، أو إعادة بذر) ⇒ تعطّل البذر التجريبي بـER_DUP_ENTRY.
  if (!(await db.select().from(categories).where(eq(categories.name, "قرطاسية")).limit(1))[0]) {
    await db.insert(categories).values({ name: "قرطاسية" });
  }
  const cat = (await db.select().from(categories).where(eq(categories.name, "قرطاسية")).limit(1))[0];

  const samples: Array<{ create: Parameters<typeof createProduct>[0]; openingStock: { sku: string; qty: number }[] }> = [
    {
      create: {
        name: "قلم جاف أزرق",
        categoryId: Number(cat.id),
        variants: [
          {
            sku: "PEN-BLUE",
            variantName: "أزرق",
            color: "أزرق",
            costPrice: "150.00",
            units: [
              { unitName: "قطعة", conversionFactor: "1", barcode: "6001000000017", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "250.00" }, { priceTier: "WHOLESALE", price: "220.00" }] },
              { unitName: "درزن", conversionFactor: "12", barcode: "6001000000024", prices: [{ priceTier: "RETAIL", price: "2800.00" }, { priceTier: "WHOLESALE", price: "2500.00" }] },
            ],
          },
        ],
      },
      openingStock: [{ sku: "PEN-BLUE", qty: 240 }],
    },
    {
      create: {
        name: "دفتر ٤٠ ورقة",
        categoryId: Number(cat.id),
        variants: [
          {
            sku: "NB-40",
            costPrice: "300.00",
            units: [
              { unitName: "قطعة", conversionFactor: "1", barcode: "6001000000031", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "500.00" }, { priceTier: "WHOLESALE", price: "450.00" }] },
            ],
          },
        ],
      },
      openingStock: [{ sku: "NB-40", qty: 120 }],
    },
    {
      create: {
        name: "درع زجاجي تكريم",
        categoryId: Number(cat.id),
        isCustomizable: true,
        variants: [
          {
            sku: "SHIELD-GLASS",
            costPrice: "5000.00",
            units: [
              { unitName: "قطعة", conversionFactor: "1", barcode: "6001000000048", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "15000.00" }] },
            ],
          },
        ],
      },
      openingStock: [{ sku: "SHIELD-GLASS", qty: 10 }],
    },
  ];

  for (const sp of samples) {
    await createProduct(sp.create, actor);
    for (const os of sp.openingStock) {
      const v = (await db.select().from(productVariants).where(eq(productVariants.sku, os.sku)).limit(1))[0];
      if (v) {
        await withTx((tx) =>
          setStock(tx, { variantId: Number(v.id), branchId, targetQuantity: os.qty, referenceType: "OPENING", notes: "رصيد افتتاحي", createdBy: actor.userId })
        );
      }
    }
  }
  console.log(`✓ seeded ${samples.length} sample products with units, prices and opening stock`);
}

seed()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("seed failed:", e);
    process.exit(1);
  });
