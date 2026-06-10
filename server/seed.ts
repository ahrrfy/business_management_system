import "dotenv/config";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { branches, categories, productVariants, products, suppliers, users } from "../drizzle/schema";
import { isStrongPassword } from "../shared/const";
import { hashPassword } from "./auth/password";
import { getDb } from "./db";
import { createProduct } from "./services/catalogService";
import { setStock } from "./services/inventoryService";
import { withTx } from "./services/tx";

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
      name: "المدير العام",
      passwordHash: hashPassword(password),
      role: "admin",
      loginMethod: "local",
      branchId: mainBranch ? Number(mainBranch.id) : null,
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

  // Sample catalog (only if empty)
  const existingProducts = await db.select().from(products).limit(1);
  if (existingProducts.length) {
    console.log("• products already exist, skipping catalog seed");
    return;
  }

  const actor = { userId: admin!.id, branchId: Number(mainBranch!.id) };
  const branchId = Number(mainBranch!.id);

  await db.insert(categories).values({ name: "قرطاسية" });
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
