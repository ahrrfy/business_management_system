import {
  int,
  bigint,
  decimal,
  varchar,
  text,
  mediumtext,
  timestamp,
  mysqlEnum,
  mysqlTable,
  boolean,
  date,
  json,
  index,
  unique,
} from "drizzle-orm/mysql-core";

/**
 * ============================================================
 * نظام إدارة الأعمال — الرؤية العربية
 * مخطط قاعدة البيانات (MySQL / Drizzle)
 *
 * مبادئ التصميم:
 *  - تعدّد فروع: المخزون والحركات والمبيعات على مستوى الفرع.
 *  - منتج (أب) → متغيّرات (لون/قياس) → وحدات (قطعة/درزن/كرتون) → أسعار (وحدة×فئة).
 *  - المخزون يُحفظ بالوحدة الأساس على مستوى (متغيّر × فرع).
 *  - دفتر محاسبي مبسّط مترابط تلقائياً.
 *  - أوامر شغل للتخصيص وأشغال المطبعة.
 * ============================================================
 */

/* ============================ المستخدمون والمصادقة ============================ */

export const users = mysqlTable(
  "users",
  {
    id: int("id").autoincrement().primaryKey(),
    openId: varchar("openId", { length: 64 }).notNull().unique(),
    name: text("name"),
    // فريد (UNIQUE) لمنع سباق register المكرّر؛ يبقى nullable على مستوى DB (لمستخدمي
    // النظام/الاختبارات بلا بريد)، ووجوده مفروض في طبقة الخدمة (createUser/updateUser).
    email: varchar("email", { length: 320 }).unique(),
    // اسم المستخدم — معرّف دخول بديل للبريد (فريد، اختياري). يجب أن يملك المستخدم بريداً أو اسم
    // مستخدم على الأقل (مفروض في طبقة الخدمة createUser/updateUser). UNIQUE يسمح بتعدّد NULL.
    username: varchar("username", { length: 64 }).unique(),
    passwordHash: varchar("passwordHash", { length: 255 }),
    phone: varchar("phone", { length: 20 }),
    loginMethod: varchar("loginMethod", { length: 64 }).default("local"),
    // الأدوار العشرة — إضافة قيم enum آمنة بلا فقد بيانات (MySQL INSTANT).
    role: mysqlEnum("role", [
      "user", "admin", "manager", "cashier", "warehouse",
      "accountant", "print_operator", "sales_rep", "purchasing", "auditor",
    ]).default("user").notNull(),
    branchId: bigint("branchId", { mode: "number" }),
    isActive: boolean("isActive").default(true),
    // v3-add-screens: HR + جدول صلاحيات مخصّص. permissionsOverride: JSON ⇒ NULL=اتّبع قالب الدور.
    jobTitle: varchar("jobTitle", { length: 120 }),
    hiredAt: date("hiredAt"),
    permissionsOverride: json("permissionsOverride"),
    // دور مخصّص (من جدول roles) — null ⇒ دور مبني (enum أعلاه). عند ضبطه: يُحلّ في context
    // إلى role=baseRole + permissionsOverride مشتقّ من خريطة الدور، فتعمل كل البوّابات بلا تغيير.
    customRoleId: bigint("customRoleId", { mode: "number" }),
    // إلزام تغيير كلمة المرور عند أول دخول (مؤقتة صادرة من مدير).
    mustChangePassword: boolean("mustChangePassword").default(false).notNull(),
    // صلاحية الكلمة المؤقتة — null يعني لا انتهاء (كلمة مرور عادية).
    tempPasswordExpiresAt: timestamp("tempPasswordExpiresAt"),
    // إبطال الجلسات: أي JWT أُصدر قبل هذا الوقت يُرفض (تغيير كلمة مرور/طرد/تغيير دور).
    sessionsValidFrom: timestamp("sessionsValidFrom").defaultNow().notNull(),
    // قفل الحساب ضدّ التخمين (brute-force) — عدّاد الإخفاقات وزمن القفل المؤقّت.
    failedLoginAttempts: int("failedLoginAttempts").default(0).notNull(),
    lockedUntil: timestamp("lockedUntil"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
  },
  (table) => ({
    // البريد فريد (UNIQUE) ⇒ يُغني عن idx_user_email ويمنع سباق register المكرّر.
    roleIdx: index("idx_user_role").on(table.role),
  })
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * الأدوار المخصّصة (يصنعها المالك) — مرونة في تسمية الأدوار وتحديد صلاحياتها.
 * الأدوار المبنية العشرة تبقى في الكود (shared/permissions.ts) كقوالب ثابتة آمنة؛ هذا الجدول
 * للأدوار الإضافية فقط. `baseRole` = الفئة/المستوى للبوّابات الخشنة (cashier/warehouse/manager…)،
 * و`permissions` = خريطة الوحدات الكاملة للبوّابات الدقيقة. عند الإسناد لمستخدم: users.role=baseRole
 * + users.customRoleId=id، ويُحلّ في context إلى permissionsOverride مشتقّ ⇒ لا تغيير في requireModule.
 */
export const roles = mysqlTable(
  "roles",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    key: varchar("key", { length: 64 }).notNull().unique(),
    label: varchar("label", { length: 120 }).notNull(),
    description: text("description"),
    // الفئة الأساسية للبوّابات الخشنة — قيم enum الأدوار نفسها.
    baseRole: mysqlEnum("baseRole", [
      "user", "admin", "manager", "cashier", "warehouse",
      "accountant", "print_operator", "sales_rep", "purchasing", "auditor",
    ]).default("user").notNull(),
    // خريطة الصلاحيات الكاملة {moduleKey: FULL|READ|NONE}.
    permissions: json("permissions").notNull(),
    canSeeCost: boolean("canSeeCost").default(false).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  }
);

export type Role = typeof roles.$inferSelect;
export type InsertRole = typeof roles.$inferInsert;

/**
 * تتبّع الجلسات الفردية (لكل تسجيل دخول) — مكمِّل لا بديل لـ`users.sessionsValidFrom`
 * (الإبطال الجماعي القائم لكل الأجهزة). كل توكن JWT جديد (بعد هذه الميزة) يحمل `sid`
 * يشير لسطرٍ هنا؛ إبطال سطرٍ واحد (`revokedAt`) يطرد ذلك الجهاز تحديداً بلا مسّ البقية.
 * التوكنات الأقدم (بلا `sid`) تستمرّ بالعمل عبر الإبطال الجماعي فقط (بلا صفّ لها هنا —
 * انتقالٌ بلا انحدار، لن تظهر في شاشة العرض حتى يُعاد تسجيل دخولها).
 * شاشة العرض تُصفّي `createdAt >= users.sessionsValidFrom` فتُخفي جلسات ما قبل آخر إبطال
 * جماعي تلقائياً بلا حاجة لكتابة إضافية على مسارات تسجيل الخروج/تغيير كلمة المرور القائمة.
 */
export const userSessions = mysqlTable(
  "userSessions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id),
    userAgent: varchar("userAgent", { length: 255 }),
    ipAddress: varchar("ipAddress", { length: 45 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    revokedAt: timestamp("revokedAt"),
  },
  (table) => ({
    userIdx: index("idx_user_sessions_user").on(table.userId),
    activeIdx: index("idx_user_sessions_active").on(table.userId, table.revokedAt, table.expiresAt),
  })
);

export type UserSession = typeof userSessions.$inferSelect;
export type InsertUserSession = typeof userSessions.$inferInsert;

/* ============================ الفروع ============================ */

export const branches = mysqlTable(
  "branches",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    code: varchar("code", { length: 30 }).notNull().unique(),
    type: mysqlEnum("branchType", ["MAIN", "SALES"]).default("SALES").notNull(),
    address: text("address"),
    phone: varchar("phone", { length: 20 }),
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    codeIdx: index("idx_branch_code").on(table.code),
  })
);

export type Branch = typeof branches.$inferSelect;
export type InsertBranch = typeof branches.$inferInsert;

/* ============================ العملاء والموردون ============================ */

export const customers = mysqlTable(
  "customers",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    // v3-add-screens: نخزّن الهاتف بصيغة E.164 الدولية (مثل +9647701234567). 22 محرفاً = ‎+‎ + ١٥ رقماً + هامش.
    phone: varchar("phone", { length: 20 }),
    phone2: varchar("phone2", { length: 20 }),
    phone3: varchar("phone3", { length: 20 }),
    whatsapp: varchar("whatsapp", { length: 20 }),
    address: text("address"),
    city: varchar("city", { length: 100 }),
    district: varchar("district", { length: 100 }),
    customerType: mysqlEnum("customerType", ["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"]).default("فرد"),
    defaultPriceTier: mysqlEnum("defaultPriceTier", ["RETAIL", "WHOLESALE", "GOVERNMENT"]).default("RETAIL").notNull(),
    notes: text("notes"),
    creditLimit: decimal("creditLimit", { precision: 15, scale: 2 }),
    currentBalance: decimal("currentBalance", { precision: 15, scale: 2 }).default("0").notNull(),
    // import-integration: المعرّف القديم («الرقم» في ملفات النظام السابق) — مفتاح مطابقة الاستيراد.
    // UNIQUE يسمح بتعدّد NULL ⇒ حارس بنيوي ضدّ ازدواج الطرف برصيد عند استيراد متزامن.
    legacyCode: varchar("legacyCode", { length: 40 }),
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    // توسعة D2 (١/٧): عمود مولَّد STORED بتطبيع عربي، نفس نمط products.searchNorm (هَجرة 0039).
    // drizzle لا يَلمسه (read-only من JS) — مُعرَّف هنا للأنواع فقط.
    searchNorm: varchar("searchNorm", { length: 512 }),
  },
  (table) => ({
    nameIdx: index("idx_customer_name").on(table.name),
    phoneIdx: index("idx_customer_phone").on(table.phone),
    legacyUq: unique("uq_customer_legacy").on(table.legacyCode),
  })
);

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = typeof customers.$inferInsert;

/**
 * ملاحظات متابعة العملاء — سجلّ حرّ (مكالمة/وعد بالدفع/متابعة تسليم) لكل عميل، مع تاريخ
 * متابعة اختياري وحالة إنجاز. ليست جزءاً من الدفتر المالي (لا قيد محاسبي) — أداة عمل يومية
 * لفريق المبيعات/الكاشير. `followUpDate,isResolved` فهرس مركّب يخدم استعلام «تذكيرات اليوم»
 * (كل الفروع، غير مُنجَزة، تاريخ ≤ اليوم) بلا مسح جدولي.
 */
export const customerNotes = mysqlTable(
  "customerNotes",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    customerId: bigint("customerId", { mode: "number" }).notNull().references(() => customers.id),
    note: text("note").notNull(),
    followUpDate: date("followUpDate", { mode: "string" }),
    isResolved: boolean("isResolved").default(false).notNull(),
    createdBy: int("createdBy").notNull().references(() => users.id),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    customerIdx: index("idx_customer_notes_customer").on(table.customerId),
    followUpIdx: index("idx_customer_notes_followup").on(table.followUpDate, table.isResolved),
  })
);

export type CustomerNote = typeof customerNotes.$inferSelect;
export type InsertCustomerNote = typeof customerNotes.$inferInsert;

export const suppliers = mysqlTable(
  "suppliers",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    // v3-add-screens: ٣ أرقام دولية، البريد محتفظ به للبيانات التاريخية فقط (لن يُعرض في النموذج).
    phone: varchar("phone", { length: 20 }),
    phone2: varchar("phone2", { length: 20 }),
    phone3: varchar("phone3", { length: 20 }),
    email: varchar("email", { length: 320 }),
    whatsapp: varchar("whatsapp", { length: 20 }),
    address: text("address"),
    city: varchar("city", { length: 100 }),
    taxId: varchar("taxId", { length: 50 }),
    productTypes: text("productTypes"),
    paymentTerms: varchar("paymentTerms", { length: 100 }),
    // v3-add-screens: تصنيف المورّد + مدة التوريد + حد أدنى للطلب + تقييم نجوم 0..5 + IBAN/اسم البنك.
    supplierCategory: varchar("supplierCategory", { length: 40 }),
    leadTimeDays: int("leadTimeDays"),
    minOrderAmount: decimal("minOrderAmount", { precision: 15, scale: 2 }),
    // 0018: DB-level CHECK (rating BETWEEN 0 AND 5، يسمح بـNULL) أُضيف في migration 0018.
    rating: int("rating"),
    iban: varchar("iban", { length: 64 }),
    bankName: varchar("bankName", { length: 120 }),
    notes: text("notes"),
    currentBalance: decimal("currentBalance", { precision: 15, scale: 2 }).default("0").notNull(),
    // import-integration: المعرّف القديم («الرقم» في ملفات النظام السابق) — مفتاح مطابقة الاستيراد.
    // UNIQUE يسمح بتعدّد NULL ⇒ حارس بنيوي ضدّ ازدواج الطرف برصيد عند استيراد متزامن.
    legacyCode: varchar("legacyCode", { length: 40 }),
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    // توسعة D2 (١/٧): عمود مولَّد STORED بتطبيع عربي، نفس نمط products.searchNorm (هَجرة 0039).
    // drizzle لا يَلمسه (read-only من JS) — مُعرَّف هنا للأنواع فقط.
    searchNorm: varchar("searchNorm", { length: 512 }),
  },
  (table) => ({
    nameIdx: index("idx_supplier_name").on(table.name),
    phoneIdx: index("idx_supplier_phone").on(table.phone),
    legacyUq: unique("uq_supplier_legacy").on(table.legacyCode),
  })
);

export type Supplier = typeof suppliers.$inferSelect;
export type InsertSupplier = typeof suppliers.$inferInsert;

/* ============================ المنتجات والمتغيرات والوحدات والأسعار ============================ */

export const categories = mysqlTable("categories", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull().unique(),
  description: text("description"),
  isActive: boolean("isActive").default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Category = typeof categories.$inferSelect;
export type InsertCategory = typeof categories.$inferInsert;

/** المنتج الأب (قالب). متغيراته تحمل التكلفة والمخزون والأسعار. */
export const products = mysqlTable(
  "products",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    // v3-add-screens: اسم مركّب (نوع · ماركة · موديل) — يُجمَع في `name` كي تبقى الجداول/التقارير القديمة تعمل.
    productType: varchar("productType", { length: 80 }),
    brand: varchar("brand", { length: 80 }),
    modelName: varchar("modelName", { length: 80 }),
    description: text("description"),
    categoryId: bigint("categoryId", { mode: "number" }).references(() => categories.id),
    // النَّسَب: لدعم دمج المنتجات بحفظ التاريخ (أب/ابن) — مرحلة لاحقة.
    parentProductId: bigint("parentProductId", { mode: "number" }),
    isCustomizable: boolean("isCustomizable").default(false),
    // مُنتج خدمي: لا يَتتبَّع مَخزوناً (تَصميم، طِباعة بَسيطة، رُسوم). البَيع لا يُحرّك
    // branchStock ولا يَكتب inventoryMovements (يُتجاوَز في inventoryService.applyMovement).
    // التَحويل بين الفُروع مَمنوع. الإيراد يَدخل كَالعَادة، التَكلفة من productVariants.cost.
    isService: boolean("isService").default(false).notNull(),
    // توجيه الخدمة لنقطة خدمة العملاء (الاستقبال): خدمة طباعة (productType=PRINT_SERVICE) مفعَّلة هنا
    // تَظهر أيضاً في كاشير الاستقبال وتُباع عبر مسار createPrintSale المدقَّق (خصم المواد + COGS).
    showInReception: boolean("showInReception").default(false).notNull(),
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    // D2 (٣٠/٦): عمود مولَّد STORED بتطبيع عربي. يُنشَأ عبر هَجرة 0035 (GENERATED ALWAYS AS).
    // في CI: db:push يَكتب الجداول من schema.ts (هنا يَراه varchar عادي ⇒ يَكتبه عادياً)،
    // ثمَ db:migrate:extra يُسقطه ويُعيد كتابته كَـGENERATED. في الإنتاج: db:migrate:safe
    // يُطبّق 0035 مُباشرةً. drizzle لا يَلمسه (read-only من JS) — مُعرَّف هنا للأنواع فقط.
    searchNorm: varchar("searchNorm", { length: 512 }),
  },
  (table) => ({
    nameIdx: index("idx_product_name").on(table.name),
    categoryIdx: index("idx_product_category").on(table.categoryId),
    parentIdx: index("idx_product_parent").on(table.parentProductId),
  })
);

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

/** متغيّر المنتج (لون/قياس). المخزون يُحسب على مستواه بالوحدة الأساس. */
export const productVariants = mysqlTable(
  "productVariants",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productId: bigint("productId", { mode: "number" }).notNull().references(() => products.id, { onDelete: "cascade" }),
    sku: varchar("sku", { length: 60 }).notNull().unique(),
    variantName: varchar("variantName", { length: 255 }),
    color: varchar("color", { length: 60 }),
    size: varchar("size", { length: 60 }),
    // 0018: DB-level CHECK (costPrice >= 0) أُضيف في migration 0018.
    costPrice: decimal("costPrice", { precision: 15, scale: 2 }).default("0").notNull(),
    minStock: int("minStock").default(0),
    reorderPoint: int("reorderPoint").default(0),
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    productIdx: index("idx_variant_product").on(table.productId),
    skuIdx: index("idx_variant_sku").on(table.sku),
  })
);

export type ProductVariant = typeof productVariants.$inferSelect;
export type InsertProductVariant = typeof productVariants.$inferInsert;

/** وحدات القياس للمتغيّر (قطعة/درزن/كرتون) بمعامل تحويل وباركود مستقل. */
export const productUnits = mysqlTable(
  "productUnits",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id, { onDelete: "cascade" }),
    unitName: varchar("unitName", { length: 40 }).notNull(),
    // عدد الوحدات الأساس في هذه الوحدة (الأساس = 1، درزن = 12، كرتون = 144).
    conversionFactor: decimal("conversionFactor", { precision: 15, scale: 4 }).default("1").notNull(),
    barcode: varchar("barcode", { length: 64 }).unique(),
    isBaseUnit: boolean("isBaseUnit").default(false).notNull(),
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    variantIdx: index("idx_unit_variant").on(table.variantId),
    barcodeIdx: index("idx_unit_barcode").on(table.barcode),
  })
);

export type ProductUnit = typeof productUnits.$inferSelect;
export type InsertProductUnit = typeof productUnits.$inferInsert;

/** سعر صريح لكل (وحدة × فئة تسعير). */
export const productPrices = mysqlTable(
  "productPrices",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productUnitId: bigint("productUnitId", { mode: "number" }).notNull().references(() => productUnits.id, { onDelete: "cascade" }),
    priceTier: mysqlEnum("priceTier", ["RETAIL", "WHOLESALE", "GOVERNMENT"]).notNull(),
    price: decimal("price", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    unitTierUq: unique("uq_price_unit_tier").on(table.productUnitId, table.priceTier),
  })
);

export type ProductPrice = typeof productPrices.$inferSelect;
export type InsertProductPrice = typeof productPrices.$inferInsert;

/* ============================ المخزون لكل (متغيّر × فرع) ============================ */

/** رصيد المخزون بالوحدة الأساس لكل متغيّر في كل فرع. */
export const branchStock = mysqlTable(
  "branchStock",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id, { onDelete: "cascade" }),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    // DB-01: لا CHECK(quantity>=0) — خدمات الطباعة (allowNegative) تَدفع الرصيد سالباً عمداً (قرار عمل)؛
    // حارس البيع الزائد تطبيقيّ للبيع العاديّ. أُقصِي من 0018 لأنّ قيد القاعدة يَكسر بيع الطباعة.
    quantity: int("quantity").default(0).notNull(),
    // آخر جرد معتمد شمل هذا الصنف في هذا الفرع — يغذّي «آخر جرد» والجرد الدوري ABC.
    lastCountedAt: timestamp("lastCountedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    variantBranchUq: unique("uq_stock_variant_branch").on(table.variantId, table.branchId),
    branchIdx: index("idx_stock_branch").on(table.branchId),
    // S1 (٢٩/٦/٢٦): تنبيهات نقص المخزون (branchId+quantity) وكشف الجرد المتقادم (branchId+lastCountedAt). هجرة 0031.
    branchQtyIdx: index("idx_stock_branch_qty").on(table.branchId, table.quantity),
    branchCountedIdx: index("idx_stock_branch_counted").on(table.branchId, table.lastCountedAt),
  })
);

export type BranchStock = typeof branchStock.$inferSelect;
export type InsertBranchStock = typeof branchStock.$inferInsert;

/** سجل حركات المخزون (بالوحدة الأساس). التحويل بين الفروع = حركتان. */
export const inventoryMovements = mysqlTable(
  "inventoryMovements",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    movementType: mysqlEnum("movementType", ["IN", "OUT", "ADJUST", "RETURN", "TRANSFER_IN", "TRANSFER_OUT"]).notNull(),
    // الكمية بالوحدة الأساس (موجبة دائماً؛ الاتجاه من النوع).
    quantity: int("quantity").notNull(),
    referenceType: varchar("referenceType", { length: 24 }),
    referenceId: bigint("referenceId", { mode: "number" }),
    relatedBranchId: bigint("relatedBranchId", { mode: "number" }),
    notes: text("notes"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    variantIdx: index("idx_move_variant").on(table.variantId),
    branchIdx: index("idx_move_branch").on(table.branchId),
    typeIdx: index("idx_move_type").on(table.movementType),
    refIdx: index("idx_move_ref").on(table.referenceType, table.referenceId),
    dateIdx: index("idx_move_date").on(table.createdAt),
    // S1 (٢٩/٦/٢٦): حركات الفرع بالتاريخ (كاردكس/إعادة طلب) + تسوية الجرد لكل صنف. هجرة 0031.
    branchDateIdx: index("idx_move_branch_date").on(table.branchId, table.createdAt),
    branchVariantTypeIdx: index("idx_move_branch_variant_type").on(table.branchId, table.variantId, table.movementType),
  })
);

export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type InsertInventoryMovement = typeof inventoryMovements.$inferInsert;

/* ============================ ورديات الكاشير ============================ */

export const shifts = mysqlTable(
  "shifts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    userId: int("userId").notNull().references(() => users.id),
    openingBalance: decimal("openingBalance", { precision: 15, scale: 2 }).default("0").notNull(),
    expectedCash: decimal("expectedCash", { precision: 15, scale: 2 }),
    countedCash: decimal("countedCash", { precision: 15, scale: 2 }),
    variance: decimal("variance", { precision: 15, scale: 2 }),
    status: mysqlEnum("shiftStatus", ["OPEN", "CLOSED"]).default("OPEN").notNull(),
    // نوع الوردية: RETAIL (كاشير المبيعات) أو RECEPTION (خدمة الزبائن — درج/رصيد افتتاحي/عرابين
    // وZ-report مستقلّ). DEFAULT RETAIL ⇒ كل الورديات القائمة تجزئة. يدخل في openGuard ⇒ وردية
    // مفتوحة واحدة لكل (موظّف×فرع×نوع)، فيُمكن لموظّفٍ حملُ وردية تجزئة ووردية استقبال معاً.
    shiftType: mysqlEnum("shiftType", ["RETAIL", "RECEPTION"]).default("RETAIL").notNull(),
    // حارس ذرّي: «userId:branchId:shiftType» عند الفتح، NULL عند الإغلاق. UNIQUE يسمح بـNULL متعدّد
    // ⇒ وردية مفتوحة واحدة لكل (موظّف×فرع×نوع)؛ فتحٌ متزامن ثانٍ لنفس النوع يفشل بـER_DUP_ENTRY.
    openGuard: varchar("openGuard", { length: 64 }).unique("uq_shift_open_guard"),
    openedAt: timestamp("openedAt").defaultNow().notNull(),
    closedAt: timestamp("closedAt"),
    notes: text("notes"),
    // treasury-stage2: snapshot لعدّاد الفئات وقت الإغلاق (تدقيق فقط، بلا تأثير محاسبي).
    // يَخزّن {250: n, 500: n, ...} للفئات السبع لـIQD. nullable لتوافق ورديات تاريخية.
    countedBreakdown: json("countedBreakdown"),
  },
  (table) => ({
    branchIdx: index("idx_shift_branch").on(table.branchId),
    userIdx: index("idx_shift_user").on(table.userId),
    statusIdx: index("idx_shift_status").on(table.status),
  })
);

export type Shift = typeof shifts.$inferSelect;
export type InsertShift = typeof shifts.$inferInsert;

/* ============================ الفواتير والمبيعات ============================ */

export const invoices = mysqlTable(
  "invoices",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    invoiceNumber: varchar("invoiceNumber", { length: 50 }).notNull().unique(),
    sourceType: mysqlEnum("sourceType", ["POS", "ONLINE", "ORDER", "WORKORDER"]).notNull(),
    sourceId: varchar("sourceId", { length: 50 }),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    shiftId: bigint("shiftId", { mode: "number" }).references(() => shifts.id),
    customerId: bigint("customerId", { mode: "number" }).references(() => customers.id),
    priceTier: mysqlEnum("priceTier", ["RETAIL", "WHOLESALE", "GOVERNMENT"]).default("RETAIL").notNull(),
    invoiceDate: timestamp("invoiceDate").defaultNow().notNull(),
    dueDate: date("dueDate"),
    // 0018: DB-level CHECK (>= 0) أُضيف على subtotal/total/paidAmount في migration 0018.
    // (cashRoundingAdjustment موقَّع عمداً ⇒ مُستثنى.)
    subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    discountAmount: decimal("discountAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    costTotal: decimal("costTotal", { precision: 15, scale: 2 }).default("0").notNull(),
    // فرق تقريب النقد العراقي (±) للبيع النقدي الكامل؛ يُسجَّل أيضاً كقيد ADJUST ليتّسق الدفتر مع النقد المستلم.
    cashRoundingAdjustment: decimal("cashRoundingAdjustment", { precision: 15, scale: 2 }).default("0").notNull(),
    status: mysqlEnum("invoiceStatus", ["PENDING", "CONFIRMED", "PAID", "PARTIALLY_PAID", "CANCELLED", "RETURNED"]).default("PENDING").notNull(),
    paidAmount: decimal("paidAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    // returnedTotal: مجموع ما أُرجِع من إجمالي الفاتورة (تراكميّ عبر مرتجعات جزئية).
    // يُحدَّث في returnService مع كل مرتجع. يُستخدَم في reconcile و AR-aging لمنع
    // انحراف وهمي حين المرتجع الجزئي يخفّض currentBalance دون total/paidAmount.
    // AR الحقيقي للفاتورة = max(total − paidAmount − returnedTotal, 0).
    returnedTotal: decimal("returnedTotal", { precision: 15, scale: 2 }).default("0").notNull(),
    paymentMethod: varchar("paymentMethod", { length: 20 }),
    paymentDate: timestamp("paymentDate"),
    notes: text("notes"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_invoice_number").on(table.invoiceNumber),
    branchIdx: index("idx_invoice_branch").on(table.branchId),
    customerIdx: index("idx_invoice_customer").on(table.customerId),
    dateIdx: index("idx_invoice_date").on(table.invoiceDate),
    statusIdx: index("idx_invoice_status").on(table.status),
    sourceIdx: index("idx_invoice_source").on(table.sourceType),
    // G11 (١٩/٦/٢٦): composite indexes للتقارير الأكثر استعمالاً — AR aging و Daily Sales.
    statusCustomerIdx: index("idx_invoice_status_customer").on(table.status, table.customerId),
    // S1 (٢٩/٦/٢٦): أعمار الذمم/المبيعات اليومية لكل (فرع+حالة+تاريخ) + تعرّض الائتمان لكل (عميل+استحقاق+حالة). هجرة 0031.
    // (status-first مفيد للشمول الإيجابي IN — مُثبَت بالقياس: ٥× أسرع من (branch,date,status) لـAR aging.)
    branchStatusDateIdx: index("idx_invoice_branch_status_date").on(table.branchId, table.status, table.invoiceDate),
    // ملاحظة: idx_invoice_branch_date حُذف في 0033 — صار بادئةً مكرّرةً من idx_invoice_branch_date_status (S2).
    customerDueIdx: index("idx_invoice_customer_due").on(table.customerId, table.dueDate, table.status),
    // S2 (٢٩/٦/٢٦): فهارس مُغطّية بترتيب (التاريخ ثم الحالة) لتقارير المبيعات — مُثبَتة بالقياس (هجرة 0032).
    // الترتيب حاسم: invoiceStatus NOT IN نفيٌ غير-مساواة يكسر البادئة، فالتاريخ يجب أن يسبق الحالة.
    dateStatusIdx: index("idx_invoice_date_status").on(table.invoiceDate, table.status),
    branchDateStatusIdx: index("idx_invoice_branch_date_status").on(table.branchId, table.invoiceDate, table.status),
    sourceUq: unique("uq_invoice_source").on(table.sourceType, table.sourceId),
  })
);

export type Invoice = typeof invoices.$inferSelect;
export type InsertInvoice = typeof invoices.$inferInsert;

export const invoiceItems = mysqlTable(
  "invoiceItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    invoiceId: bigint("invoiceId", { mode: "number" }).notNull().references(() => invoices.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(() => productUnits.id),
    workOrderId: bigint("workOrderId", { mode: "number" }),
    // 0018: DB-level CHECK (>= 0) أُضيف على quantity/baseQuantity/unitPrice/total في migration 0018.
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    returnedBaseQuantity: int("returnedBaseQuantity").default(0).notNull(),
    // الكمية المُرتجعة التي أُعيدت للمخزون فعلاً (restock=true فقط). التالف/أمر الشغل لا يزيدها،
    // فتبقى تكلفته خسارةً في تقارير COGS التحليلية مطابِقةً لدفتر P&L (returnService يزيدها عند
    // restock فقط؛ والقيم التاريخية مُعبَّأة = returnedBaseQuantity في هجرة الإضافة لحفظ تطابق الماضي).
    returnedRestockedBaseQuantity: int("returnedRestockedBaseQuantity").default(0).notNull(),
    unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
    unitCost: decimal("unitCost", { precision: 15, scale: 2 }).default("0").notNull(),
    discountPercent: decimal("discountPercent", { precision: 5, scale: 2 }).default("0"),
    discountAmount: decimal("discountAmount", { precision: 15, scale: 2 }).default("0"),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    invoiceIdx: index("idx_item_invoice").on(table.invoiceId),
    variantIdx: index("idx_item_variant").on(table.variantId),
    productUnitIdx: index("idx_item_productUnit").on(table.productUnitId),
    // S1 (٢٩/٦/٢٦): مطابقة المرتجعات/COGS المتمحورة حول الصنف (variantId+invoiceId). هجرة 0031.
    variantInvoiceIdx: index("idx_item_variant_invoice").on(table.variantId, table.invoiceId),
  })
);

export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type InsertInvoiceItem = typeof invoiceItems.$inferInsert;

/* ============================ عروض الأسعار (Quotations) ============================ */

/** عرض سعر — مستند تفاوضي بلا أثر على المخزون أو الدفتر حتى يُحوَّل إلى فاتورة. */
export const quotations = mysqlTable(
  "quotations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    quoteNumber: varchar("quoteNumber", { length: 50 }).notNull().unique(),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    customerId: bigint("customerId", { mode: "number" }).references(() => customers.id),
    priceTier: mysqlEnum("quotePriceTier", ["RETAIL", "WHOLESALE", "GOVERNMENT"]).default("RETAIL").notNull(),
    quoteDate: timestamp("quoteDate").defaultNow().notNull(),
    validUntil: date("validUntil"),
    subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    discountAmount: decimal("discountAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    status: mysqlEnum("quoteStatus", ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "CONVERTED", "EXPIRED"]).default("DRAFT").notNull(),
    convertedInvoiceId: bigint("convertedInvoiceId", { mode: "number" }).references(() => invoices.id),
    notes: text("notes"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_quote_number").on(table.quoteNumber),
    branchIdx: index("idx_quote_branch").on(table.branchId),
    customerIdx: index("idx_quote_customer").on(table.customerId),
    statusIdx: index("idx_quote_status").on(table.status),
  })
);

export type Quotation = typeof quotations.$inferSelect;
export type InsertQuotation = typeof quotations.$inferInsert;

export const quotationItems = mysqlTable(
  "quotationItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    quotationId: bigint("quotationId", { mode: "number" }).notNull().references(() => quotations.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).notNull().references(() => productUnits.id),
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
    discountAmount: decimal("discountAmount", { precision: 15, scale: 2 }).default("0"),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    quoteIdx: index("idx_qitem_quote").on(table.quotationId),
    variantIdx: index("idx_qitem_variant").on(table.variantId),
  })
);

export type QuotationItem = typeof quotationItems.$inferSelect;
export type InsertQuotationItem = typeof quotationItems.$inferInsert;

/* ============================ المقبوضات والمدفوعات ============================ */

export const receipts = mysqlTable(
  "receipts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(() => invoices.id),
    // ربط إيصال العربون بأمر الشغل قبل وجود فاتورة؛ يُربَط بالفاتورة عند التسليم.
    workOrderId: bigint("workOrderId", { mode: "number" }),
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    shiftId: bigint("shiftId", { mode: "number" }).references(() => shifts.id),
    direction: mysqlEnum("direction", ["IN", "OUT"]).default("IN").notNull(),
    // 0018: DB-level CHECK (amount >= 0) أُضيف في migration 0018 (المبلغ موجب؛ الاتجاه من `direction`).
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    paymentMethod: mysqlEnum("paymentMethod", ["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]).notNull(),
    /**
     * cash-treasury-mode (تدقيق ١٧/٦): فصل النقد إلى دلوَين دلالياً.
     *  - DRAWER: نقد درج كاشير ⇒ يَخصم/يُضيف إلى Z-report عبر shiftId.
     *  - TREASURY: نقد خزينة إدارية (admin/manager بلا وردية) ⇒ سجلّ مستقلّ، لا يَدخل
     *    تسوية الدرج، يَظهر في تقرير «المعاملات الإدارية + النقد اليتيم» مفصولاً.
     * الحقل اختياري NULL للسجلات غير النقدية (لا دلوَ لها) وللسجلات التاريخية قبل ١٧/٦.
     */
    cashBucket: mysqlEnum("cashBucket", ["DRAWER", "TREASURY"]),
    referenceNumber: varchar("referenceNumber", { length: 100 }),
    checkNumber: varchar("checkNumber", { length: 50 }),
    cardLastFour: varchar("cardLastFour", { length: 4 }),
    status: mysqlEnum("receiptStatus", ["PENDING", "COMPLETED", "FAILED", "REVERSED"]).default("COMPLETED").notNull(),
    // ── سندات قبض/صرف مستقلّة (B1): receipts بلا فاتورة بل بطرف خارجي (راتب، إيجار، …) ──
    voucherNumber: varchar("voucherNumber", { length: 50 }).unique(), // RV/PV-branchId-YYYYMMDD-NNNNN
    partyType: mysqlEnum("voucherPartyType", ["CUSTOMER", "SUPPLIER", "OTHER"]),
    partyId: bigint("partyId", { mode: "number" }), // CUSTOMER ⇒ customers.id، SUPPLIER ⇒ suppliers.id، OTHER ⇒ null
    description: text("description"), // وصف الغرض من السند
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    // vouchers-pro (٣٠/٦/٢٦): تَعزيزات تَدقيقية ومحاسبية للسندات المُستقلّة.
    voucherCategoryId: bigint("voucherCategoryId", { mode: "number" }),     // FK → voucherCategories (هَجرة 0036)
    counterpartyName: varchar("counterpartyName", { length: 200 }),         // اسم الطرف الحُرّ لسندات «أخرى» (راتب الموظف فلان…)
    voucherDate: date("voucherDate"),                                       // تاريخ السند الفعلي (قد يَختلف عن createdAt)
    attachmentUrl: text("attachmentUrl"),                                   // مَسار/URL مُستند مَرجعي (إيصال إيجار…)
    internalNote: text("internalNote"),                                     // مُلاحظة داخلية للتدقيق (لا تُطبع)
    signatureHash: varchar("signatureHash", { length: 64 }),                // SHA-256 hex لخَتم السند بَعد الاعتماد (سَلامة سجل تَدقيقي)
    approvalStatus: mysqlEnum("receiptApprovalStatus", ["APPROVED", "PENDING_APPROVAL", "REJECTED"]).default("APPROVED").notNull(),
    approvedBy: int("approvedBy"),                                          // FK → users (هَجرة 0036)؛ NULL إن لم يَستلزم موافقة
    approvedAt: timestamp("approvedAt"),                                    // وقت الاعتماد
  },
  (table) => ({
    invoiceIdx: index("idx_receipt_invoice").on(table.invoiceId),
    workOrderIdx: index("idx_receipt_wo").on(table.workOrderId),
    branchIdx: index("idx_receipt_branch").on(table.branchId),
    dateIdx: index("idx_receipt_date").on(table.createdAt),
    voucherIdx: index("idx_receipt_voucher").on(table.voucherNumber),
    partyIdx: index("idx_receipt_party").on(table.partyType, table.partyId),
    // G11 (١٩/٦/٢٦): فهرس shiftId حرج — Z-report لكل إغلاق وردية كان full scan على آلاف الإيصالات يومياً.
    shiftIdx: index("idx_receipt_shift").on(table.shiftId),
    // S0 (٢٩/٦/٢٦): فهرس أُنشئ في 0013 على عمود `bucketId` ثم أسقطه 0017 (حذف نظام دلاء النقد) ⇒ بقي مفقوداً.
    // يُعاد على `cashBucket` عبر هجرة 0030 اليدوية. (snapshot مجمَّد عند 0019 ⇒ لا db:generate — توثيق فقط.)
    bucketStatusIdx: index("idx_receipt_bucket_status").on(table.cashBucket, table.status),
    // S1 (٢٩/٦/٢٦): إغلاق Z-report (shiftId+تاريخ)، تسوية الخزينة لكل (فرع+دلو+تاريخ)، تتبّع دفعات الفاتورة. هجرة 0031.
    shiftDateIdx: index("idx_receipt_shift_date").on(table.shiftId, table.createdAt),
    bucketDateIdx: index("idx_receipt_bucket_date").on(table.cashBucket, table.createdAt),
    invoiceStatusIdx: index("idx_receipt_invoice_status").on(table.invoiceId, table.status),
    branchBucketDateIdx: index("idx_receipt_branch_bucket_date").on(table.branchId, table.cashBucket, table.createdAt),
  })
);

export type Receipt = typeof receipts.$inferSelect;
export type InsertReceipt = typeof receipts.$inferInsert;

/* ============================ فئات السندات (vouchers-pro ٣٠/٦) ============================
 * قائمة قابلة للإدارة من الواجهة (admin) — تُربط بـreceipts.voucherCategoryId.
 * direction يُحدّد قابلية الاستعمال: IN لسندات القبض فقط، OUT لسندات الصرف فقط، BOTH لكليهما.
 * لا تُحذف بل تُعطَّل (isActive=false) للحفاظ على ربط السندات التاريخية بفئاتها.
 */
export const voucherCategories = mysqlTable(
  "voucherCategories",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 100 }).notNull().unique(),
    direction: mysqlEnum("voucherCategoryDirection", ["IN", "OUT", "BOTH"]).default("BOTH").notNull(),
    description: varchar("description", { length: 300 }),
    isActive: boolean("isActive").default(true).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    activeIdx: index("idx_vchcat_active").on(table.isActive),
    dirIdx: index("idx_vchcat_dir").on(table.direction),
  })
);

export type VoucherCategory = typeof voucherCategories.$inferSelect;
export type InsertVoucherCategory = typeof voucherCategories.$inferInsert;

/* ============================ الدفتر المحاسبي المبسّط ============================ */

/** قيد محاسبي موحّد يُنشأ تلقائياً من العمليات (بيع/شراء/دفع/إرجاع). */
export const accountingEntries = mysqlTable(
  "accountingEntries",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // import-integration: OPENING = قيد ترسيخ الرصيد الافتتاحي المستورد من النظام القديم.
    // production-slice: INTERNAL_USE = نثرية داخلية (مصروف بالكلفة)، WASTAGE = تلف/هدر (خسارة بالكلفة) — كلاهما بلا نقد.
    // treasury-stage2 (٢١/٦): CASH_HANDOVER = تسليم وردية → خزينة (نقل بين دلوَين)، CASH_TRANSFER_OUT/IN = تحويل نقدي بين الفروع.
    // كلها لا تَدخل revenue/cost/profit (cash movements) — تُستثنى من تقارير الإيراد/الأرباح.
    // delivery-cod (٢٦/٦): DELIVERY_DISPATCH = إيقاف COD على عهدة جهة التوصيل (+float)،
    // DELIVERY_REMIT = خفض العهدة عند التوريد/التسوية/الإرجاع (−float)، DELIVERY_FEE = مصروف
    // أجرة التوصيل (cost-only، خصم الأجرة وتوريد الصافي)، DELIVERY_WRITEOFF = شطب عجز كمصروف.
    // DISPATCH/REMIT حركات عهدة لا تَمسّ revenue/cost (تُستثنى من تقارير الإيراد، كـCASH_*).
    // exchange-house (٣٠/٦): قيود الصيرفة — DEPOSIT/WITHDRAW/FX_BUY/SETTLE حركات أصل (revenue=cost=profit=0)؛
    // EXCHANGE_FEE = عمولة (مصروف P&L)؛ EXCHANGE_FX_DIFF = فرق صرف محقَّق (amount موقَّع، معزول عن إيراد البيع).
    entryType: mysqlEnum("entryType", ["SALE", "PURCHASE", "PAYMENT_IN", "PAYMENT_OUT", "RETURN", "ADJUST", "OPENING", "INTERNAL_USE", "WASTAGE", "CASH_HANDOVER", "CASH_TRANSFER_OUT", "CASH_TRANSFER_IN", "DELIVERY_DISPATCH", "DELIVERY_REMIT", "DELIVERY_FEE", "DELIVERY_WRITEOFF", "EXCHANGE_DEPOSIT", "EXCHANGE_WITHDRAW", "EXCHANGE_FX_BUY", "EXCHANGE_SETTLE", "EXCHANGE_FEE", "EXCHANGE_FX_DIFF"]).notNull(),
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(() => invoices.id),
    // F1 (تدقيق ٢/٧): أُضيف FK ⇒ purchaseOrderId يشير لأمر شراء موجود (تكامل مرجعيّ). الهجرة 0040.
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" }).references(() => purchaseOrders.id),
    receiptId: bigint("receiptId", { mode: "number" }).references(() => receipts.id),
    customerId: bigint("customerId", { mode: "number" }).references(() => customers.id),
    supplierId: bigint("supplierId", { mode: "number" }).references(() => suppliers.id),
    // delivery-cod: طرف جهة التوصيل لقيود العهدة DELIVERY_* — نظير customerId/supplierId.
    // يبقى بلا .references (طرف التوصيل قد يكون عميلاً أو مندوباً خارجياً — لا جدول أمّ وحيد). يُمكّن مطابقة العهدة بـGROUP BY.
    deliveryPartyId: bigint("deliveryPartyId", { mode: "number" }),
    // exchange-house: طرف الصيرفة لقيود EXCHANGE_*. F1 (تدقيق ٢/٧): أُضيف FK ⇒ يشير لصيرفة موجودة. الهجرة 0040.
    exchangeHouseId: bigint("exchangeHouseId", { mode: "number" }).references(() => exchangeHouses.id),
    revenue: decimal("revenue", { precision: 15, scale: 2 }).default("0").notNull(),
    cost: decimal("cost", { precision: 15, scale: 2 }).default("0").notNull(),
    profit: decimal("profit", { precision: 15, scale: 2 }).default("0").notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).default("0").notNull(),
    entryDate: date("entryDate").notNull(),
    notes: text("notes"),
    // حارس بنيوي ضدّ التكرار: مثل «SALE:<invoiceId>» ⇒ قيد SALE واحد لكل فاتورة على مستوى القاعدة.
    // UNIQUE يسمح بـNULL متعدّد، فالقيود التي تتكرّر مشروعاً (دفعات/مرتجعات) تتركه NULL.
    dedupeKey: varchar("dedupeKey", { length: 80 }).unique("uq_entry_dedupe"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    typeIdx: index("idx_entry_type").on(table.entryType),
    invoiceIdx: index("idx_entry_invoice").on(table.invoiceId),
    dateIdx: index("idx_entry_date").on(table.entryDate),
    supplierIdx: index("idx_entry_supplier").on(table.supplierId),
    customerIdx: index("idx_entry_customer").on(table.customerId),
    // G11 (١٩/٦/٢٦): فهرس branchId حرج — GL/P&L/الميزانية/كشوف الحساب تستعلم على branchId،
    // كان full scan على مليون قيد لكل تقرير.
    branchIdx: index("idx_entry_branch").on(table.branchId),
    deliveryPartyIdx: index("idx_entry_delivery_party").on(table.deliveryPartyId),
    // exchange-house: كشف حساب الصيرفة + تقارير العمولة/فرق الصرف لكل صيرفة بالتاريخ.
    exchangeIdx: index("idx_entry_exchange").on(table.exchangeHouseId),
    exchangeDateIdx: index("idx_entry_exchange_date").on(table.exchangeHouseId, table.entryDate),
    // S1 (٢٩/٦/٢٦): شريان GL/P&L — (فرع+نوع+تاريخ)؛ وكشوف حساب العميل/المورّد بالتاريخ. هجرة 0031.
    branchTypeDateIdx: index("idx_entry_branch_type_date").on(table.branchId, table.entryType, table.entryDate),
    customerDateIdx: index("idx_entry_customer_date").on(table.customerId, table.entryDate),
    supplierDateIdx: index("idx_entry_supplier_date").on(table.supplierId, table.entryDate),
  })
);

export type AccountingEntry = typeof accountingEntries.$inferSelect;
export type InsertAccountingEntry = typeof accountingEntries.$inferInsert;

/* ============================ المصروفات اليومية ============================ */

/**
 * مصروف نقدي يومي (إيجار/فواتير/مرتبات/مواصلات…). يُولّد:
 *  - receipt (direction=OUT) ⇒ يُخصم من صندوق الوردية إن كانت مفتوحة.
 *  - PAYMENT_OUT entry في الدفتر المحاسبي.
 * الإلغاء مسموح فقط ما دامت الوردية المرتبطة مفتوحة (أو بلا وردية).
 */
export const expenses = mysqlTable(
  "expenses",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    shiftId: bigint("shiftId", { mode: "number" }).references(() => shifts.id),
    expenseDate: date("expenseDate").notNull(),
    category: mysqlEnum("expenseCategory", [
      "RENT",
      "UTILITIES",
      "SUPPLIES",
      "SALARY",
      "TRANSPORT",
      "MAINTENANCE",
      "MARKETING",
      "OTHER",
    ]).default("OTHER").notNull(),
    // 0018: DB-level CHECK (amount >= 0) أُضيف في migration 0018.
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    paymentMethod: mysqlEnum("expensePaymentMethod", ["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]).default("CASH").notNull(),
    // cash-treasury-mode: مرآة receipts.cashBucket — DRAWER=درج كاشير، TREASURY=خزينة إدارية.
    cashBucket: mysqlEnum("expenseCashBucket", ["DRAWER", "TREASURY"]),
    // production-slice: مصدر الصرف — CASH=نقدي (الموجود، يخصم الصندوق)، STOCK=صرف من المخزون بالكلفة (نثرية/تلف، بلا صندوق).
    source: mysqlEnum("expenseSource", ["CASH", "STOCK"]).default("CASH").notNull(),
    // مع source=STOCK فقط: INTERNAL_USE=نثرية داخلية (مصروف)، WASTAGE=تلف (خسارة). NULL لـCASH.
    stockReason: mysqlEnum("expenseStockReason", ["INTERNAL_USE", "WASTAGE"]),
    description: text("description"),
    referenceNumber: varchar("referenceNumber", { length: 100 }),
    // v3-add-screens: جهة الصرف + مركز التكلفة + علم متكرّر + دورية التكرار.
    payee: varchar("payee", { length: 200 }),
    costCenter: varchar("costCenter", { length: 80 }),
    isRecurring: boolean("isRecurring").default(false),
    recurringFrequency: mysqlEnum("recurringFrequency", ["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]),
    receiptId: bigint("receiptId", { mode: "number" }).references(() => receipts.id),
    status: mysqlEnum("expenseStatus", ["ACTIVE", "CANCELLED"]).default("ACTIVE").notNull(),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    branchIdx: index("idx_expense_branch").on(table.branchId),
    dateIdx: index("idx_expense_date").on(table.expenseDate),
    categoryIdx: index("idx_expense_category").on(table.category),
    statusIdx: index("idx_expense_status").on(table.status),
  })
);

export type Expense = typeof expenses.$inferSelect;
export type InsertExpense = typeof expenses.$inferInsert;

/* ============================ تحويل نقدي بين الفروع ============================
 * treasury-stage2 (٢١/٦): نقل نقد من خزينة فرع إلى خزينة فرع آخر بتدفّق ثنائي ذرّي.
 * الإرسال يَكتب receipt OUT في فرع المُرسل ، الاستلام يَكتب receipt IN في فرع المستلم ،
 * كلاهما بـcashBucket=TREASURY. القيد المحاسبي CASH_TRANSFER_OUT/IN (مجموعهما = 0 على
 * مستوى الشركة). الإلغاء قبل الاستلام: receipt تعويضي + قيد معاكس. لا إلغاء بعد الاستلام.
 */
export const cashTransfers = mysqlTable(
  "cashTransfers",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    transferNumber: varchar("transferNumber", { length: 50 }).notNull().unique(), // CT-fromBranch-YYYYMMDD-NNNNN
    fromBranchId: bigint("fromBranchId", { mode: "number" }).notNull().references(() => branches.id),
    toBranchId: bigint("toBranchId", { mode: "number" }).notNull().references(() => branches.id),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(), // DB CHECK > 0 (migration manual)
    status: mysqlEnum("cashTransferStatus", ["IN_TRANSIT", "RECEIVED", "CANCELLED"]).default("IN_TRANSIT").notNull(),
    sentBy: int("sentBy").notNull().references(() => users.id),
    receivedBy: int("receivedBy").references(() => users.id),
    cancelledBy: int("cancelledBy").references(() => users.id),
    sentAt: timestamp("sentAt").defaultNow().notNull(),
    receivedAt: timestamp("receivedAt"),
    cancelledAt: timestamp("cancelledAt"),
    sentReceiptId: bigint("sentReceiptId", { mode: "number" }).references(() => receipts.id),
    receivedReceiptId: bigint("receivedReceiptId", { mode: "number" }).references(() => receipts.id),
    reversalReceiptId: bigint("reversalReceiptId", { mode: "number" }).references(() => receipts.id),
    notes: text("notes"),
    cancellationReason: text("cancellationReason"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    fromIdx: index("idx_xfer_from").on(table.fromBranchId, table.status),
    toIdx: index("idx_xfer_to").on(table.toBranchId, table.status),
    statusIdx: index("idx_xfer_status").on(table.status),
    sentAtIdx: index("idx_xfer_sent_at").on(table.sentAt),
  })
);

export type CashTransfer = typeof cashTransfers.$inferSelect;
export type InsertCashTransfer = typeof cashTransfers.$inferInsert;

/* ============================ أوامر الشغل / التخصيص / المطبعة ============================ */

export const workOrders = mysqlTable(
  "workOrders",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    orderNumber: varchar("orderNumber", { length: 50 }).notNull().unique(),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    customerId: bigint("customerId", { mode: "number" }).references(() => customers.id),
    // المنتج الأساس الخام (درع زجاجي/خشبي) — قد يكون null لخدمة طباعة صرفة.
    baseVariantId: bigint("baseVariantId", { mode: "number" }).references(() => productVariants.id),
    title: varchar("title", { length: 255 }).notNull(),
    customizationText: text("customizationText"),
    quantity: int("quantity").default(1).notNull(),
    materialsCost: decimal("materialsCost", { precision: 15, scale: 2 }).default("0").notNull(),
    laborCost: decimal("laborCost", { precision: 15, scale: 2 }).default("0").notNull(),
    salePrice: decimal("salePrice", { precision: 15, scale: 2 }).default("0").notNull(),
    // v3-add-screens: قناة الاستلام + معرّفها (handle).
    receptionChannel: mysqlEnum("receptionChannel", ["WALK_IN", "WHATSAPP", "INSTAGRAM", "TIKTOK", "PHONE", "OTHER"]).default("WALK_IN"),
    channelHandle: varchar("channelHandle", { length: 120 }),
    // v3-add-screens: أولوية، عربون، الدفع (نقدي/بطاقة) + المرجع + إيصال.
    priority: mysqlEnum("woPriority", ["LOW", "NORMAL", "URGENT"]).default("NORMAL"),
    deposit: decimal("deposit", { precision: 15, scale: 2 }).default("0"),
    paymentMethod: mysqlEnum("woPaymentMethod", ["CASH", "CARD"]).default("CASH"),
    paymentReference: varchar("paymentReference", { length: 100 }),
    // v3-add-screens(100%): TEXT لاستيعاب data URLs (≥100KB) عند الترميز المضمَّن.
    paymentReceiptUrl: text("paymentReceiptUrl"),
    // v3-add-screens: التوصيل.
    hasDelivery: boolean("hasDelivery").default(false),
    deliveryAddress: text("deliveryAddress"),
    deliveryCost: decimal("deliveryCost", { precision: 15, scale: 2 }).default("0"),
    status: mysqlEnum("workOrderStatus", ["RECEIVED", "IN_PROGRESS", "READY", "DELIVERED", "CANCELLED"]).default("RECEIVED").notNull(),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(() => invoices.id),
    assignedTo: int("assignedTo").references(() => users.id),
    dueDate: date("dueDate"),
    // تَتبّع زَمن التَنفيذ الفِعلي (شَريحة #4 backend gaps):
    // workStartedAt يُكتَب عند startWorkOrder، workSeconds يُحسَب عند markWorkOrderReady
    // (= TIMESTAMPDIFF(SECOND, workStartedAt, NOW())). يَستبدل اشتقاق المؤقّت من auditLogs.
    workStartedAt: timestamp("workStartedAt"),
    workSeconds: int("workSeconds"),
    deliveredAt: timestamp("deliveredAt"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_wo_number").on(table.orderNumber),
    branchIdx: index("idx_wo_branch").on(table.branchId),
    customerIdx: index("idx_wo_customer").on(table.customerId),
    statusIdx: index("idx_wo_status").on(table.status),
  })
);

export type WorkOrder = typeof workOrders.$inferSelect;
export type InsertWorkOrder = typeof workOrders.$inferInsert;

/** المواد المستهلكة من المخزون لأمر الشغل. */
export const workOrderMaterials = mysqlTable(
  "workOrderMaterials",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    workOrderId: bigint("workOrderId", { mode: "number" }).notNull().references(() => workOrders.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    baseQuantity: int("baseQuantity").notNull(),
    unitCost: decimal("unitCost", { precision: 15, scale: 2 }).default("0").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    woIdx: index("idx_wom_wo").on(table.workOrderId),
    variantIdx: index("idx_wom_variant").on(table.variantId),
  })
);

export type WorkOrderMaterial = typeof workOrderMaterials.$inferSelect;
export type InsertWorkOrderMaterial = typeof workOrderMaterials.$inferInsert;

/* ============================ أصناف نقطة البيع المصغّرة + مرفقات أمر الشغل (v3) ============================ */

/**
 * v3-add-screens: أصناف نقطة البيع المصغّرة داخل أمر الشغل
 * (منتجات جاهزة تُباع جنباً إلى جنب مع خدمات التخصيص). تكون لها أسعار البيع لا التكلفة.
 * المخزون لا يُخصم تلقائياً هنا — يُحوَّل لفاتورة عند التسليم وفق منطق billing الموجود.
 */
export const workOrderItems = mysqlTable(
  "workOrderItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    workOrderId: bigint("workOrderId", { mode: "number" }).notNull().references(() => workOrders.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(() => productUnits.id),
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
    discountAmount: decimal("discountAmount", { precision: 15, scale: 2 }).default("0"),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    woIdx: index("idx_woi_wo").on(table.workOrderId),
    variantIdx: index("idx_woi_variant").on(table.variantId),
  })
);

export type WorkOrderItem = typeof workOrderItems.$inferSelect;
export type InsertWorkOrderItem = typeof workOrderItems.$inferInsert;

/** v3-add-screens: صور نموذج العمل المطلوب (مرفقات سحب-وإفلات على أمر الشغل). */
export const workOrderImages = mysqlTable(
  "workOrderImages",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    workOrderId: bigint("workOrderId", { mode: "number" }).notNull().references(() => workOrders.id, { onDelete: "cascade" }),
    // import-integration: MEDIUMTEXT (~16MB) — TEXT (64KB) كان يكسر data URLs للصور بـ«قيمة أطول من المسموح».
    url: mediumtext("url").notNull(),
    caption: varchar("caption", { length: 255 }),
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    woIdx: index("idx_woimg_wo").on(table.workOrderId),
  })
);

export type WorkOrderImage = typeof workOrderImages.$inferSelect;
export type InsertWorkOrderImage = typeof workOrderImages.$inferInsert;

/** v3-add-screens: صور المنتج، أوّلها الرئيسية افتراضياً. */
export const productImages = mysqlTable(
  "productImages",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productId: bigint("productId", { mode: "number" }).notNull().references(() => products.id, { onDelete: "cascade" }),
    // product-variants: صورة لكل لون. NULL = صورة على مستوى المنتج (السلوك القديم)؛ قيمة = صورة هذا المتغيّر.
    variantId: bigint("variantId", { mode: "number" }).references(() => productVariants.id, { onDelete: "cascade" }),
    // import-integration: MEDIUMTEXT (~16MB) — TEXT (64KB) كان يكسر data URLs للصور بـ«قيمة أطول من المسموح».
    url: mediumtext("url").notNull(),
    isPrimary: boolean("isPrimary").default(false).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    prodIdx: index("idx_pimg_product").on(table.productId),
    variantIdx: index("idx_pimg_variant").on(table.variantId),
  })
);

export type ProductImage = typeof productImages.$inferSelect;
export type InsertProductImage = typeof productImages.$inferInsert;

/* ============================ المشتريات ============================ */

export const purchaseOrders = mysqlTable(
  "purchaseOrders",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    poNumber: varchar("poNumber", { length: 50 }).notNull().unique(),
    supplierId: bigint("supplierId", { mode: "number" }).notNull().references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    orderDate: timestamp("orderDate").defaultNow().notNull(),
    expectedDeliveryDate: date("expectedDeliveryDate"),
    subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    // 0018: DB-level CHECK (>= 0) أُضيف على total/paidAmount في migration 0018.
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    paidAmount: decimal("paidAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    status: mysqlEnum("poStatus", ["DRAFT", "SENT", "CONFIRMED", "RECEIVED", "CANCELLED"]).default("DRAFT").notNull(),
    // usd-po-reconcile: مطابقة سعر الشراء بالدولار (اختياري، إعلامي بحت — لا يمسّ total/paidAmount
    // الديناريَين ولا محرّك الحسابات). agreedCurrency=USD ⇒ usdTotal (كما في فاتورة المورد الفعلية)
    // + agreedRate (= total/usdTotal، سعر ضمني محسوب عند الإنشاء) يُخزَّنان للمقارنة لاحقاً بسعر
    // التسديد الفعلي عبر الصيرفة (لا ربط آلي — مطابقة بصرية بين شاشتَي أمر الشراء وكشف الصيرفة).
    agreedCurrency: mysqlEnum("poCurrency", ["IQD", "USD"]).default("IQD").notNull(),
    usdTotal: decimal("usdTotal", { precision: 15, scale: 2 }),
    agreedRate: decimal("agreedRate", { precision: 15, scale: 4 }),
    notes: text("notes"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_po_number").on(table.poNumber),
    supplierIdx: index("idx_po_supplier").on(table.supplierId),
    branchIdx: index("idx_po_branch").on(table.branchId),
    statusIdx: index("idx_po_status").on(table.status),
    // G11 (١٩/٦/٢٦): composite (supplierId, status) لـAP aging — تجميع المورّدين بفلتر الحالة.
    supplierStatusIdx: index("idx_po_supplier_status").on(table.supplierId, table.status),
  })
);

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type InsertPurchaseOrder = typeof purchaseOrders.$inferInsert;

export const purchaseOrderItems = mysqlTable(
  "purchaseOrderItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" }).notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(() => productUnits.id),
    // 0018: DB-level CHECK (>= 0) أُضيف على quantity/baseQuantity/unitPrice/total في migration 0018.
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    receivedBaseQuantity: int("receivedBaseQuantity").default(0),
    // receivedNet: مجموع ما قُيِّد فعلياً للبند عبر استلامات متعدّدة. عند الـreceive
    // الذي يُكمل الكمية، يُستعمل (total − receivedNet) كقيمة remainder بالضبط ⇒
    // مجموع AP/PURCHASE يطابق إجمالي الـPO تماماً (لا انجراف 0.01 IQD).
    receivedNet: decimal("receivedNet", { precision: 15, scale: 2 }).default("0").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    poIdx: index("idx_poi_po").on(table.purchaseOrderId),
    variantIdx: index("idx_poi_variant").on(table.variantId),
  })
);

export type PurchaseOrderItem = typeof purchaseOrderItems.$inferSelect;
export type InsertPurchaseOrderItem = typeof purchaseOrderItems.$inferInsert;

/* ============================ الطلبات الإلكترونية (الشحن/التتبع) ============================ */

export const onlineOrders = mysqlTable(
  "onlineOrders",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    orderNumber: varchar("orderNumber", { length: 50 }).notNull().unique(),
    customerId: bigint("customerId", { mode: "number" }).notNull().references(() => customers.id),
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(() => invoices.id),
    orderDate: timestamp("orderDate").defaultNow().notNull(),
    subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
    shippingCost: decimal("shippingCost", { precision: 15, scale: 2 }).default("0").notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    status: mysqlEnum("orderStatus", ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"]).default("PENDING").notNull(),
    shippingAddress: text("shippingAddress"),
    trackingNumber: varchar("trackingNumber", { length: 100 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_order_number").on(table.orderNumber),
    customerIdx: index("idx_order_customer").on(table.customerId),
    statusIdx: index("idx_order_status").on(table.status),
  })
);

export type OnlineOrder = typeof onlineOrders.$inferSelect;
export type InsertOnlineOrder = typeof onlineOrders.$inferInsert;

export const onlineOrderItems = mysqlTable(
  "onlineOrderItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    onlineOrderId: bigint("onlineOrderId", { mode: "number" }).notNull().references(() => onlineOrders.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(() => productUnits.id),
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    orderIdx: index("idx_ooi_order").on(table.onlineOrderId),
  })
);

export type OnlineOrderItem = typeof onlineOrderItems.$inferSelect;
export type InsertOnlineOrderItem = typeof onlineOrderItems.$inferInsert;

/* ============================ الموارد البشرية ============================ */

export const employees = mysqlTable(
  "employees",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").references(() => users.id),
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    firstName: varchar("firstName", { length: 100 }).notNull(),
    lastName: varchar("lastName", { length: 100 }).notNull(),
    email: varchar("email", { length: 100 }).unique(),
    phone: varchar("phone", { length: 20 }),
    position: varchar("position", { length: 100 }),
    department: varchar("department", { length: 100 }),
    salary: decimal("salary", { precision: 15, scale: 2 }), // الراتب الأساس (لذوي الراتب الشهري)
    hireDate: date("hireDate", { mode: "string" }),
    isActive: boolean("isActive").default(true),

    // —— HR v1: تفاصيل الموظف الكاملة (كلها اختيارية — هجرة إضافية آمنة) ——
    /** الاسم رباعي: firstName(الأول) + fatherName(الأب) + grandfatherName(الجد) + lastName(اللقب). */
    fatherName: varchar("fatherName", { length: 100 }),
    grandfatherName: varchar("grandfatherName", { length: 100 }),
    /** المدير المباشر (مرجع لموظف آخر — بلا قيد FB لتجنّب دورة تعريف ذاتية؛ يُتحقَّق في الخدمة). */
    managerId: bigint("managerId", { mode: "number" }),
    /** طريقة الأجر: شهري (راتب أساس + بدلات) أو بالساعة (سعر ساعة لكل يوم). */
    payType: mysqlEnum("payType", ["monthly", "hourly"]).default("monthly").notNull(),
    allowances: decimal("allowances", { precision: 15, scale: 2 }).default("0"),
    /** سعر الساعة لكل يوم لموظفي الساعة: {"الأحد":5000,...} (أجر اليوم = ساعات × سعر ذلك اليوم). */
    dayRates: json("dayRates"),
    /** حالة التوظيف (مستقلة عن isActive للحذف الناعم). */
    employmentStatus: mysqlEnum("employmentStatus", ["active", "leave", "terminated"]).default("active").notNull(),
    gender: varchar("gender", { length: 10 }),
    birthDate: date("birthDate", { mode: "string" }),
    maritalStatus: varchar("maritalStatus", { length: 20 }),
    nationality: varchar("nationality", { length: 50 }),
    governorate: varchar("governorate", { length: 80 }),
    district: varchar("district", { length: 120 }),
    addressLandmark: varchar("addressLandmark", { length: 255 }),
    // 0018: UNIQUE(nationalId) — يسمح بتعدّد NULL، يفرض التفرّد على القيم الفعلية فقط (حارس بنيوي ضدّ ازدواج الموظف).
    nationalId: varchar("nationalId", { length: 40 }),
    emergencyContactName: varchar("emergencyContactName", { length: 150 }),
    emergencyContactPhone: varchar("emergencyContactPhone", { length: 20 }),
    /** لون شارة/أفاتار الموظف في الواجهة. */
    colorTag: varchar("colorTag", { length: 20 }),
    /** صورة الموظف (base64 مضغوط أو مفتاح — مثل صور المنتجات). */
    photoUrl: mediumtext("photoUrl"),
    /** المؤهلات الدراسية: [{degree,major,school,year,gpa}]. */
    education: json("education"),
    annualLeaveBalance: int("annualLeaveBalance").default(0),
    sickLeaveBalance: int("sickLeaveBalance").default(0),
    terminationDate: date("terminationDate", { mode: "string" }),
    terminationReason: varchar("terminationReason", { length: 255 }),

    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    branchIdx: index("idx_emp_branch").on(table.branchId),
    activeIdx: index("idx_emp_active").on(table.isActive),
    statusIdx: index("idx_emp_status").on(table.employmentStatus),
    deptIdx: index("idx_emp_dept").on(table.department),
    // 0018: تفرّد الرقم الوطني (تعدّد NULL مسموح). أُضيف يدوياً في migration 0018.
    nationalIdUq: unique("uq_employee_national_id").on(table.nationalId),
    // 0021: علاقة واحد-لواحد بين الموظف وحساب النظام (تعدّد NULL مسموح ⇒ موظفو «بلا حساب» غير متأثرين).
    userIdUq: unique("uq_employee_user").on(table.userId),
  })
);

export type Employee = typeof employees.$inferSelect;
export type InsertEmployee = typeof employees.$inferInsert;

export const attendance = mysqlTable(
  "attendance",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    employeeId: bigint("employeeId", { mode: "number" }).notNull().references(() => employees.id),
    attendanceDate: date("attendanceDate", { mode: "string" }).notNull(),
    checkIn: timestamp("checkIn"),
    checkOut: timestamp("checkOut"),
    status: mysqlEnum("attendanceStatus", ["PRESENT", "ABSENT", "LATE", "LEAVE"]).notNull(),
    notes: text("notes"),
    // HR — نظام الساعات: ساعات اليوم + سعر الساعة (لقطة وقت التسجيل) + الأجر المحسوب + مصدر التسجيل.
    hours: decimal("hours", { precision: 6, scale: 2 }),
    hourlyRate: decimal("hourlyRate", { precision: 15, scale: 2 }),
    amount: decimal("amount", { precision: 15, scale: 2 }),
    source: varchar("source", { length: 20 }).default("fingerprint"), // fingerprint | manual
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    employeeIdx: index("idx_att_employee").on(table.employeeId),
    dateIdx: index("idx_att_date").on(table.attendanceDate),
    // مفتاح فريد ليوم/موظف: يضمن سجلّ حضور واحد لكل (موظف، تاريخ) فيمنع ازدواج
    // الصفوف الذي يضاعف ساعات/مبالغ مسيّر الرواتب (تكامل مالي). يدعم UPSERT الخدمة.
    employeeDateUq: unique("uq_att_employee_date").on(table.employeeId, table.attendanceDate),
  })
);

export type Attendance = typeof attendance.$inferSelect;
export type InsertAttendance = typeof attendance.$inferInsert;

/* ============================ الاستيراد والطباعة والتدقيق ============================ */

export const importBatches = mysqlTable(
  "importBatches",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    batchName: varchar("batchName", { length: 255 }).notNull(),
    importType: mysqlEnum("importType", ["PRODUCTS", "CUSTOMERS", "SUPPLIERS"]).notNull(),
    fileName: varchar("fileName", { length: 255 }),
    totalRows: int("totalRows"),
    successfulRows: int("successfulRows").default(0),
    failedRows: int("failedRows").default(0),
    status: mysqlEnum("batchStatus", ["PENDING", "PROCESSING", "COMPLETED", "FAILED"]).default("PENDING").notNull(),
    errorLog: json("errorLog"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  (table) => ({
    typeIdx: index("idx_import_type").on(table.importType),
  })
);

export type ImportBatch = typeof importBatches.$inferSelect;
export type InsertImportBatch = typeof importBatches.$inferInsert;

/**
 * مفاتيح الـ Idempotency للعمليات المالية الحسّاسة (دفعات، مرتجعات، استلام شراء).
 * النقر المزدوج/إعادة الإرسال بنفس clientRequestId يُعاد تشغيله بنتيجة العملية الأولى
 * بدل أن يكتب دفعة/استرداداً/استلاماً مكرّراً. مفتاح فريد على (operation, clientRequestId).
 */
export const idempotencyKeys = mysqlTable(
  "idempotencyKeys",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    operation: varchar("operation", { length: 40 }).notNull(), // مثل "sale.pay" / "sale.return" / "purchase.receive"
    clientRequestId: varchar("clientRequestId", { length: 64 }).notNull(),
    refId: bigint("refId", { mode: "number" }).notNull(), // المعرّف الناتج (إيصال/استرداد/استلام)
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    opKeyUq: unique("uq_idempotency_op_key").on(table.operation, table.clientRequestId),
  })
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;

export const printJobs = mysqlTable(
  "printJobs",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    jobType: mysqlEnum("printJobType", ["INVOICE", "SHIFT_REPORT", "OPENING_BALANCE", "RECEIPT", "WORK_ORDER"]).default("INVOICE").notNull(),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(() => invoices.id),
    referenceId: bigint("referenceId", { mode: "number" }),
    payload: json("payload"),
    status: mysqlEnum("printStatus", ["PENDING", "PRINTING", "PRINTED", "FAILED"]).default("PENDING").notNull(),
    attempts: int("attempts").default(0),
    maxAttempts: int("maxAttempts").default(3),
    errorMessage: text("errorMessage"),
    printedAt: timestamp("printedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    statusIdx: index("idx_print_status").on(table.status),
  })
);

export type PrintJob = typeof printJobs.$inferSelect;
export type InsertPrintJob = typeof printJobs.$inferInsert;

export const auditLogs = mysqlTable(
  "auditLogs",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").references(() => users.id),
    branchId: bigint("branchId", { mode: "number" }),
    action: varchar("action", { length: 100 }).notNull(),
    entityType: varchar("entityType", { length: 50 }).notNull(),
    entityId: varchar("entityId", { length: 50 }),
    oldValue: json("oldValue"),
    newValue: json("newValue"),
    ipAddress: varchar("ipAddress", { length: 45 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("idx_audit_user").on(table.userId),
    branchIdx: index("idx_audit_branch").on(table.branchId),
    actionIdx: index("idx_audit_action").on(table.action),
    dateIdx: index("idx_audit_date").on(table.createdAt),
    // S1 (٢٩/٦/٢٦): تتبّع نشاط المستخدم (userId+action+تاريخ) وسجلّ تغيّر الكيان (entityType+entityId+تاريخ). هجرة 0031.
    userActionDateIdx: index("idx_audit_user_action_date").on(table.userId, table.action, table.createdAt),
    entityIdx: index("idx_audit_entity").on(table.entityType, table.entityId, table.createdAt),
  })
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

/* ============================ الجرد والتسوية (Stocktake) ============================ */

/** جلسة جرد دورية: إنشاء (لقطة دفترية) → عدّ أعمى → مراجعة → اعتماد وتسوية ذرّية. */
export const stocktakeSessions = mysqlTable(
  "stocktakeSessions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    code: varchar("code", { length: 30 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    scopeType: mysqlEnum("scopeType", ["FULL", "MOVING", "CATEGORY", "MANUAL"]).notNull(),
    // وصف النطاق (JSON): { days?, categoryIds?, variantIds?, label }
    scopeDetail: text("scopeDetail"),
    status: mysqlEnum("stocktakeStatus", ["COUNTING", "REVIEW", "APPROVED", "CANCELLED"]).default("COUNTING").notNull(),
    // جرد أعمى: بوابة العدّ لا تستلم الرصيد الدفتري إطلاقاً.
    blind: boolean("blind").default(true).notNull(),
    // «ضمن الحد» = pct ≤ thresholdPct و |القيمة| ≤ thresholdValue.
    thresholdPct: decimal("thresholdPct", { precision: 5, scale: 2 }).default("5.00").notNull(),
    thresholdValue: decimal("thresholdValue", { precision: 15, scale: 2 }).default("25000.00").notNull(),
    // فرق واحد |قيمته| > dualThreshold ⇒ توقيعان من مستخدمَين مختلفَين.
    dualThreshold: decimal("dualThreshold", { precision: 15, scale: 2 }).default("150000.00").notNull(),
    directUnderThreshold: boolean("directUnderThreshold").default(true).notNull(),
    waNotify: boolean("waNotify").default(true).notNull(),
    dupPolicy: mysqlEnum("dupPolicy", ["VERIFY", "BLOCK"]).default("VERIFY").notNull(),
    notes: text("notes"),
    createdBy: int("createdBy").references(() => users.id),
    submittedAt: timestamp("submittedAt"),
    firstSignBy: int("firstSignBy").references(() => users.id),
    firstSignAt: timestamp("firstSignAt"),
    approvedBy: int("approvedBy").references(() => users.id),
    approvedAt: timestamp("approvedAt"),
    cancelledBy: int("cancelledBy").references(() => users.id),
    cancelledAt: timestamp("cancelledAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    statusIdx: index("idx_stocktake_status").on(table.status),
    branchIdx: index("idx_stocktake_branch").on(table.branchId),
  })
);

export type StocktakeSession = typeof stocktakeSessions.$inferSelect;
export type InsertStocktakeSession = typeof stocktakeSessions.$inferInsert;

/** تكليف عامل جرد (منطقة): رابط خارجي بـ PIN (hash) أو حساب داخلي. */
export const stocktakeAssignments = mysqlTable(
  "stocktakeAssignments",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sessionId: bigint("sessionId", { mode: "number" }).notNull().references(() => stocktakeSessions.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    method: mysqlEnum("method", ["PIN", "USER"]).notNull(),
    userId: int("userId").references(() => users.id),
    pinHash: varchar("pinHash", { length: 255 }),
    zone: varchar("zone", { length: 120 }),
    status: mysqlEnum("assignmentStatus", ["ACTIVE", "SUBMITTED"]).default("ACTIVE").notNull(),
    // قفل محاولات PIN الفاشلة (نمط قفل الحساب 5/15د).
    failedPinAttempts: int("failedPinAttempts").default(0).notNull(),
    lockedUntil: timestamp("lockedUntil"),
    lastActivityAt: timestamp("lastActivityAt"),
    submittedAt: timestamp("submittedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    sessionIdx: index("idx_stkassign_session").on(table.sessionId),
  })
);

export type StocktakeAssignment = typeof stocktakeAssignments.$inferSelect;
export type InsertStocktakeAssignment = typeof stocktakeAssignments.$inferInsert;

/** أصناف الجلسة: لقطة الرصيد الدفتري والتكلفة لحظة الإنشاء (جوهر الجرد الأعمى). */
export const stocktakeItems = mysqlTable(
  "stocktakeItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sessionId: bigint("sessionId", { mode: "number" }).notNull().references(() => stocktakeSessions.id, { onDelete: "cascade" }),
    assignmentId: bigint("assignmentId", { mode: "number" }).notNull().references(() => stocktakeAssignments.id),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    // الرصيد الدفتري بالوحدة الأساس لحظة بدء الجلسة — لا يصل لبوابة العدّ أبداً.
    expectedQty: int("expectedQty").notNull(),
    // تكلفة المتغيّر لحظة الإنشاء — تقييم الفرق يثبت عليها.
    unitCost: decimal("unitCost", { precision: 15, scale: 2 }).notNull(),
    // طلب إعادة العدّ: PENDING يحجب الاعتماد حتى يصل عدّ RECOUNT.
    recountStatus: mysqlEnum("recountStatus", ["PENDING", "DONE"]),
    recountRequestedBy: int("recountRequestedBy").references(() => users.id),
    recountReason: varchar("recountReason", { length: 255 }),
    recountRequestedAt: timestamp("recountRequestedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    sessionVariantUq: unique("uq_stkitem_session_variant").on(table.sessionId, table.variantId),
    sessionIdx: index("idx_stkitem_session").on(table.sessionId),
    assignmentIdx: index("idx_stkitem_assignment").on(table.assignmentId),
  })
);

export type StocktakeItem = typeof stocktakeItems.$inferSelect;
export type InsertStocktakeItem = typeof stocktakeItems.$inferInsert;

/** سجل العدّات: الأول + إعادة العدّ + التحقّقي (عدّ زميل بسياسة VERIFY) — كلها تبقى موثّقة. */
export const stocktakeCounts = mysqlTable(
  "stocktakeCounts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sessionId: bigint("sessionId", { mode: "number" }).notNull().references(() => stocktakeSessions.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    assignmentId: bigint("assignmentId", { mode: "number" }).notNull().references(() => stocktakeAssignments.id),
    kind: mysqlEnum("kind", ["FIRST", "RECOUNT", "VERIFY"]).notNull(),
    // بالوحدة الأساس (التحويل من وحدات الإدخال يتم قبل الحفظ).
    qty: int("qty").notNull(),
    // تفصيل الإدخال متعدد الوحدات (JSON): {"كرتون":2,"قطعة":5} — للتدقيق.
    unitBreakdown: text("unitBreakdown"),
    countedByName: varchar("countedByName", { length: 120 }).notNull(),
    countedByUserId: int("countedByUserId").references(() => users.id),
    countedAt: timestamp("countedAt").defaultNow().notNull(),
    // VERIFY مخالف للعدّ الأول ⇒ تعارض يحجب الاعتماد حتى الفصل.
    isConflict: boolean("isConflict").default(false).notNull(),
    resolvedBy: int("resolvedBy").references(() => users.id),
    resolvedPick: mysqlEnum("resolvedPick", ["FIRST", "VERIFY"]),
    resolvedAt: timestamp("resolvedAt"),
    // idempotency لمزامنة طابور الأوفلاين — تكرار نفس الطلب لا يكرّر العدّ.
    clientRequestId: varchar("clientRequestId", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    sessionVariantIdx: index("idx_stkcount_session_variant").on(table.sessionId, table.variantId),
    assignmentIdx: index("idx_stkcount_assignment").on(table.assignmentId),
    // S1 (٢٩/٦/٢٦): تحليل جولات الجرد لكل (جلسة+نوع العدّة+وقت العدّ). هجرة 0031.
    sessionKindDateIdx: index("idx_stkcount_session_kind_date").on(table.sessionId, table.kind, table.countedAt),
    requestUq: unique("uq_stkcount_request").on(table.sessionId, table.clientRequestId),
  })
);

export type StocktakeCount = typeof stocktakeCounts.$inferSelect;
export type InsertStocktakeCount = typeof stocktakeCounts.$inferInsert;

/** قرارات المراجعة: تسوية/إبقاء + سبب الفرق (تحليل الانكماش) — تُثبَّت قيمها النهائية عند الاعتماد. */
export const stocktakeDecisions = mysqlTable(
  "stocktakeDecisions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sessionId: bigint("sessionId", { mode: "number" }).notNull().references(() => stocktakeSessions.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    action: mysqlEnum("action", ["ADJUST", "KEEP"]).notNull(),
    // العدّ المصحَّح النهائي بالوحدة الأساس (يُعاد حسابه داخل معاملة الاعتماد).
    finalQty: int("finalQty"),
    // الفرق المُسوّى فعلياً وقيمته بتكلفة اللقطة — تُكتب عند الاعتماد.
    diffQty: int("diffQty"),
    value: decimal("value", { precision: 15, scale: 2 }),
    reason: mysqlEnum("reason", ["UNSPECIFIED", "DAMAGE", "LOSS_THEFT", "ENTRY_ERROR", "PRINT_WASTE"]).default("UNSPECIFIED").notNull(),
    note: text("note"),
    // NULL + autoApplied=true ⇒ تسوية تلقائية ضمن الحد.
    decidedBy: int("decidedBy").references(() => users.id),
    autoApplied: boolean("autoApplied").default(false).notNull(),
    decidedAt: timestamp("decidedAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    sessionVariantUq: unique("uq_stkdecision_session_variant").on(table.sessionId, table.variantId),
    sessionIdx: index("idx_stkdecision_session").on(table.sessionId),
  })
);

export type StocktakeDecision = typeof stocktakeDecisions.$inferSelect;
export type InsertStocktakeDecision = typeof stocktakeDecisions.$inferInsert;

/* ============================ أجهزة الكشك الخارجية (قارئ الأسعار) ============================ */

/**
 * جهاز كشك خارجي = شاشة قارئ أسعار مستقلّة تتصل بالنظام بـ**رمز جهاز للقراءة فقط**
 * (لا دخول مستخدم، لا بيانات اعتماد مدير على الجهاز). مبادئ الأمان:
 *  - **لا يُخزَّن الرمز الخام إطلاقاً**؛ فقط تجزئته `tokenHash` (sha256 hex) — تسريب القاعدة لا يكشف رمزاً صالحاً.
 *  - **مربوط بفرع واحد** (`branchId`): مصادقة الجهاز تفرض الفرع خادمياً ⇒ لا IDOR عبر فروع أخرى.
 *  - **قابل للإلغاء فوراً** (`isActive=false`): تعطيل الجهاز يُبطل رمزه على الخادم بلا لمس الجهاز.
 *  - نطاق الرمز = قراءة بنر الأسعار + بحث الباركود فقط (بيانات يراها أي زبون واقف في المتجر) — لا تكلفة ولا مخزون ولا أي إجراء مالي.
 */
export const kioskDevices = mysqlTable(
  "kioskDevices",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    // اسم وصفي يضعه المدير («شاشة المدخل»، «كاونتر القرطاسية»…).
    label: varchar("label", { length: 120 }).notNull(),
    // sha256(token) بالست عشري — البحث يكون بالتجزئة لا بالرمز الخام.
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique("uq_kiosk_token_hash"),
    // بادئة الرمز (مثل kde_ab12cd) للعرض/التمييز في لوحة الإدارة — ليست سرّاً.
    tokenPrefix: varchar("tokenPrefix", { length: 16 }).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    // آخر ظهور/مصادقة ناجحة + الـIP — مراقبة بسيطة لاكتشاف سوء الاستخدام.
    lastSeenAt: timestamp("lastSeenAt"),
    lastSeenIp: varchar("lastSeenIp", { length: 64 }),
    revokedAt: timestamp("revokedAt"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    branchIdx: index("idx_kiosk_branch").on(table.branchId),
    activeIdx: index("idx_kiosk_active").on(table.isActive),
  })
);

export type KioskDevice = typeof kioskDevices.$inferSelect;
export type InsertKioskDevice = typeof kioskDevices.$inferInsert;

/* ============================ الإنتاج / التحويل + الوصفات ============================ */

/**
 * وصفة/معيار إنتاج: تعريف ثابت لمنتج متكرّر (ملزمة/كتاب) ⇒ يملأ نموذج الإنتاج تلقائياً.
 * المكوّنات تُعرّف **لكل وحدة ناتج أساس واحدة**؛ عند إنتاج كمية Q تُضرب فيها (تحجيم).
 */
export const productionRecipes = mysqlTable(
  "productionRecipes",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 150 }).notNull().unique("uq_recipe_name"),
    outputVariantId: bigint("outputVariantId", { mode: "number" }).notNull().references(() => productVariants.id),
    outputProductUnitId: bigint("outputProductUnitId", { mode: "number" }).notNull().references(() => productUnits.id),
    // عمالة/تشغيل لكل وحدة ناتج أساس (اختياري) — تُضاف لكلفة المنتج، بلا قيد محاسبي منفصل.
    laborPerOutputBase: decimal("laborPerOutputBase", { precision: 15, scale: 2 }).default("0").notNull(),
    // الهدر المعياري المتوقّع في التشغيل (كسر 0–1، مثل 0.05 = 5%): يُمتَص ضمنه في كلفة الوحدة السليمة؛
    // ما يتجاوزه = هدر غير طبيعي يُسجَّل خسارة منفصلة (قيد WASTAGE) لا يضخّم كلفة السليم.
    wasteStdPct: decimal("wasteStdPct", { precision: 5, scale: 2 }).default("0").notNull(),
    notes: text("notes"),
    isActive: boolean("isActive").default(true).notNull(),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    outputIdx: index("idx_recipe_output").on(table.outputVariantId),
    activeIdx: index("idx_recipe_active").on(table.isActive),
  })
);

export type ProductionRecipe = typeof productionRecipes.$inferSelect;
export type InsertProductionRecipe = typeof productionRecipes.$inferInsert;

/** مكوّنات الوصفة: استهلاك بالوحدة الأساس لكل وحدة ناتج أساس واحدة (مثلاً 30 ورقة/ملزمة). */
export const productionRecipeLines = mysqlTable(
  "productionRecipeLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    recipeId: bigint("recipeId", { mode: "number" }).notNull().references(() => productionRecipes.id, { onDelete: "cascade" }),
    inputVariantId: bigint("inputVariantId", { mode: "number" }).notNull().references(() => productVariants.id),
    inputProductUnitId: bigint("inputProductUnitId", { mode: "number" }).references(() => productUnits.id),
    // استهلاك بالوحدة الأساس لكل وحدة ناتج أساس واحدة (يُضرب في كمية الإنتاج Q).
    qtyPerOutputBase: decimal("qtyPerOutputBase", { precision: 15, scale: 4 }).notNull(),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    recipeIdx: index("idx_recipeline_recipe").on(table.recipeId),
    inputIdx: index("idx_recipeline_input").on(table.inputVariantId),
  })
);

export type ProductionRecipeLine = typeof productionRecipeLines.$inferSelect;
export type InsertProductionRecipeLine = typeof productionRecipeLines.$inferInsert;

/**
 * مستند إنتاج/تحويل: يستهلك مدخلات (ورق…) ويُنتج مخرجات (دفتر/كتاب/كيس) ذرّياً.
 * **لا قيد محاسبي** (تحويل أصل↔أصل محايد)؛ القيمة محفوظة بحركتَي المخزون + WAVG على كلفة المخرَج.
 */
export const productionOrders = mysqlTable(
  "productionOrders",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    docNumber: varchar("docNumber", { length: 50 }).notNull().unique("uq_production_docnum"),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    status: mysqlEnum("productionStatus", ["CONFIRMED", "CANCELLED"]).default("CONFIRMED").notNull(),
    materialsCost: decimal("materialsCost", { precision: 15, scale: 2 }).default("0").notNull(),
    laborCost: decimal("laborCost", { precision: 15, scale: 2 }).default("0").notNull(),
    totalCost: decimal("totalCost", { precision: 15, scale: 2 }).default("0").notNull(),
    // إنتاجية التشغيل (تُملأ بمسار «التشغيل بوصفة»؛ NULL للمستندات اليدوية/القديمة):
    // batchQty = ما بدأ التشغيل (يقود استهلاك المواد)، goodQty = batchQty − scrapQty (السليم الناتج)،
    // scrapQty = التالف الكلي، abnormalLoss = خسارة الهدر غير الطبيعي (قيد WASTAGE، لا تُمتَص في كلفة السليم).
    batchQty: int("batchQty"),
    goodQty: int("goodQty"),
    scrapQty: int("scrapQty").default(0).notNull(),
    abnormalLoss: decimal("abnormalLoss", { precision: 15, scale: 2 }).default("0").notNull(),
    // لقطة الهدر المعياري وقت التشغيل (من الوصفة) — المستند ثابت فلا يتأثّر بتعديل الوصفة لاحقاً.
    wasteStdPct: decimal("wasteStdPct", { precision: 5, scale: 2 }).default("0").notNull(),
    notes: text("notes"),
    linkedWorkOrderId: bigint("linkedWorkOrderId", { mode: "number" }).references(() => workOrders.id),
    linkedRecipeId: bigint("linkedRecipeId", { mode: "number" }).references(() => productionRecipes.id),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_production_number").on(table.docNumber),
    branchIdx: index("idx_production_branch").on(table.branchId),
    statusIdx: index("idx_production_status").on(table.status),
  })
);

export type ProductionOrder = typeof productionOrders.$inferSelect;
export type InsertProductionOrder = typeof productionOrders.$inferInsert;

/** أسطر مستند الإنتاج: INPUT=مُستهلَك (حركة OUT)، OUTPUT=مُنتَج (حركة IN). الكمية الأساس عدد صحيح. */
export const productionLines = mysqlTable(
  "productionLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productionOrderId: bigint("productionOrderId", { mode: "number" }).notNull().references(() => productionOrders.id, { onDelete: "cascade" }),
    direction: mysqlEnum("productionLineDirection", ["INPUT", "OUTPUT"]).notNull(),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(() => productUnits.id),
    quantity: decimal("quantity", { precision: 15, scale: 4 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    unitCost: decimal("unitCost", { precision: 15, scale: 2 }).default("0").notNull(),
    lineCost: decimal("lineCost", { precision: 15, scale: 2 }).default("0").notNull(),
    // OUTPUT فقط: الحصّة المُمتصّة من كلفة الإنتاج الكلية (Σ = totalCost تماماً). NULL للمدخلات.
    allocatedCost: decimal("allocatedCost", { precision: 15, scale: 2 }),
    // OUTPUT فقط: نسبة توزيع يدوية اختيارية (NULL ⇒ تناسبي بالكمية الأساس).
    manualSharePct: decimal("manualSharePct", { precision: 9, scale: 4 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    orderIdx: index("idx_productionline_order").on(table.productionOrderId),
    variantIdx: index("idx_productionline_variant").on(table.variantId),
    directionIdx: index("idx_productionline_direction").on(table.direction),
  })
);

export type ProductionLine = typeof productionLines.$inferSelect;
export type InsertProductionLine = typeof productionLines.$inferInsert;

/** أصناف مصروف «صرف من المخزون» (نثرية/تلف): المُستهلَك من المخزون بكلفته (مرتبط بـexpenses.source=STOCK). */
export const expenseStockItems = mysqlTable(
  "expenseStockItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    expenseId: bigint("expenseId", { mode: "number" }).notNull().references(() => expenses.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(() => productUnits.id),
    quantity: decimal("quantity", { precision: 15, scale: 4 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    unitCost: decimal("unitCost", { precision: 15, scale: 2 }).default("0").notNull(),
    lineCost: decimal("lineCost", { precision: 15, scale: 2 }).default("0").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    expenseIdx: index("idx_expitem_expense").on(table.expenseId),
    variantIdx: index("idx_expitem_variant").on(table.variantId),
  })
);

export type ExpenseStockItem = typeof expenseStockItems.$inferSelect;
export type InsertExpenseStockItem = typeof expenseStockItems.$inferInsert;

/* ============================ الأصول الثابتة (Fixed Assets) ============================
 * سجلّ أصول ثابتة + عهدة على الموظف + إهلاك (قسط ثابت/متناقص يُحسب عند القراءة) + صيانة + مستندات.
 * كل المبالغ decimal(15,2). الإهلاك لا يُخزَّن (يتغيّر بمرور الزمن) — يُحسب في assetsService. */

export const fixedAssets = mysqlTable(
  "fixedAssets",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** رمز الأصل المعروض (AST-1001). يُولَّد تسلسلياً في الخدمة. */
    code: varchar("code", { length: 30 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    category: mysqlEnum("assetCategory", [
      "computers", "display", "furniture", "vehicles", "printing", "devices",
    ]).notNull(),
    brand: varchar("brand", { length: 120 }),
    serial: varchar("serial", { length: 120 }),
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    location: varchar("location", { length: 255 }),

    /** الموظف صاحب العهدة الحالية (NULL = أصل عام/غير مُسلَّم). */
    custodianId: bigint("custodianId", { mode: "number" }).references(() => employees.id),
    supplierId: bigint("supplierId", { mode: "number" }).references(() => suppliers.id),

    purchaseDate: date("purchaseDate", { mode: "string" }).notNull(),
    purchaseValue: decimal("purchaseValue", { precision: 15, scale: 2 }).notNull(),
    salvageValue: decimal("salvageValue", { precision: 15, scale: 2 }).default("0").notNull(),
    /** العمر الإنتاجي بالسنوات. */
    usefulLifeYears: int("usefulLifeYears").notNull(),
    /** sl = القسط الثابت، db = القسط المتناقص المضاعف. */
    depreciationMethod: mysqlEnum("depreciationMethod", ["sl", "db"]).default("sl").notNull(),
    /** FI-02: الإهلاك المتراكم المُرحَّل للدفتر — يَتتبّع computeDepreciation عبر الترحيل الشهري؛
     *  الميزانية تَقرأ NBV = purchaseValue − هذا العمود. */
    accumulatedDepreciation: decimal("accumulatedDepreciation", { precision: 15, scale: 2 }).default("0").notNull(),

    condition: varchar("condition", { length: 60 }),
    warrantyEnd: date("warrantyEnd", { mode: "string" }),

    status: mysqlEnum("assetStatus", [
      "active",       // بالخدمة
      "maintenance",  // في الصيانة
      "retired",      // خارج الخدمة (بانتظار قرار)
      "disposed",     // مُستبعَد (بيع/خردة)
    ]).default("active").notNull(),

    /** الإخراج/الاستبعاد. */
    disposalDate: date("disposalDate", { mode: "string" }),
    disposalValue: decimal("disposalValue", { precision: 15, scale: 2 }),
    disposalReason: varchar("disposalReason", { length: 255 }),

    /** ربط اختياري بجهاز بصمة (kioskDevices) في وحدة الموارد البشرية. */
    linkedDeviceId: bigint("linkedDeviceId", { mode: "number" }).references(() => kioskDevices.id),

    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    codeIdx: index("idx_asset_code").on(t.code),
    statusIdx: index("idx_asset_status").on(t.status),
    custodianIdx: index("idx_asset_custodian").on(t.custodianId),
    branchIdx: index("idx_asset_branch").on(t.branchId),
    categoryIdx: index("idx_asset_category").on(t.category),
  })
);
export type FixedAsset = typeof fixedAssets.$inferSelect;
export type InsertFixedAsset = typeof fixedAssets.$inferInsert;

/* سلسلة العهدة — كل صفّ فترة عهدة لموظف (toDate=NULL ⇒ العهدة الجارية). */
export const assetCustodyLog = mysqlTable(
  "assetCustodyLog",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    assetId: bigint("assetId", { mode: "number" }).notNull().references(() => fixedAssets.id),
    employeeId: bigint("employeeId", { mode: "number" }).notNull().references(() => employees.id),
    fromDate: date("fromDate", { mode: "string" }).notNull(),
    /** NULL = العهدة الحالية (لم تُعَد بعد). */
    toDate: date("toDate", { mode: "string" }),
    note: text("note"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    assetIdx: index("idx_custody_asset").on(t.assetId),
    employeeIdx: index("idx_custody_employee").on(t.employeeId),
  })
);
export type AssetCustody = typeof assetCustodyLog.$inferSelect;
export type InsertAssetCustody = typeof assetCustodyLog.$inferInsert;

/* سجلّ الصيانة لكل أصل + تكلفتها. */
export const assetMaintenance = mysqlTable(
  "assetMaintenance",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    assetId: bigint("assetId", { mode: "number" }).notNull().references(() => fixedAssets.id),
    maintDate: date("maintDate", { mode: "string" }).notNull(),
    type: varchar("type", { length: 255 }).notNull(),
    vendor: varchar("vendor", { length: 255 }),
    cost: decimal("cost", { precision: 15, scale: 2 }).default("0").notNull(),
    note: text("note"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    assetIdx: index("idx_maint_asset").on(t.assetId),
    dateIdx: index("idx_maint_date").on(t.maintDate),
  })
);
export type AssetMaintenance = typeof assetMaintenance.$inferSelect;
export type InsertAssetMaintenance = typeof assetMaintenance.$inferInsert;

/* مستندات الأصل (فاتورة شراء/كفالة/محضر استبعاد…) — مفتاح S3 اختياري. */
export const assetDocuments = mysqlTable(
  "assetDocuments",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    assetId: bigint("assetId", { mode: "number" }).notNull().references(() => fixedAssets.id),
    title: varchar("title", { length: 255 }).notNull(),
    /** مفتاح S3 (النظام يستعمل @aws-sdk/client-s3 مسبقاً). */
    fileKey: varchar("fileKey", { length: 512 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ assetIdx: index("idx_doc_asset").on(t.assetId) })
);
export type AssetDocument = typeof assetDocuments.$inferSelect;
export type InsertAssetDocument = typeof assetDocuments.$inferInsert;

/* ============================ الموارد البشرية — الرواتب/الإجازات/التوظيف/البصمة/الترقيات ============================ */

/* مسيّر الرواتب الشهري (مسودة → معتمد → مدفوع). عند «الدفع» تُرحَّل قيود مصروف رواتب للدفتر (خزينة، لا وردية). */
export const payrollRuns = mysqlTable(
  "payrollRuns",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    period: varchar("period", { length: 7 }).notNull(), // YYYY-MM
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    status: mysqlEnum("payrollStatus", ["draft", "approved", "paid"]).default("draft").notNull(),
    employeeCount: int("employeeCount").default(0).notNull(),
    totalGross: decimal("totalGross", { precision: 15, scale: 2 }).default("0").notNull(),
    totalOvertime: decimal("totalOvertime", { precision: 15, scale: 2 }).default("0").notNull(),
    totalDeductions: decimal("totalDeductions", { precision: 15, scale: 2 }).default("0").notNull(),
    totalNet: decimal("totalNet", { precision: 15, scale: 2 }).default("0").notNull(),
    notes: text("notes"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    approvedAt: timestamp("approvedAt"),
    // SOD-01/02: مُعتمِد ودافع المسيّر — لإنفاذ «صانع≠مدقّق» وإثبات الهوية في السجلّ المالي الثابت
    // (كان الاعتماد/الدفع لا يُسجّلان مَن نفّذهما ⇒ تعذّر إثبات وجود مُعتمِد مستقلّ).
    approvedBy: int("approvedBy").references(() => users.id),
    paidBy: int("paidBy").references(() => users.id),
    paidAt: timestamp("paidAt"),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    // HR-PAY-01 (تدقيق ٢٠/٦/٢٦): UNIQUE(period) — نموذج «مسيّر واحد شهريّاً لكل الشركة» (قرار المالك).
    // كان (period,branchId) [G12] يُتيح مسيّراً لكل فرع بينما generatePayroll يُحمّل كل موظّفي الشركة
    // ⇒ فرعان يولّدان مسيّرين كلٌّ يدفع لكل موظّف (دفع مزدوج). التفرّد بالشهر وحده يَمنعه ذرّياً
    // (الفحص المسبق غير قافل؛ القيد الفريد هو الحارس + الراوتر يُحوّل ER_DUP_ENTRY إلى CONFLICT).
    periodUq: unique("uq_payroll_period").on(t.period),
    statusIdx: index("idx_payroll_status").on(t.status),
  })
);
export type PayrollRun = typeof payrollRuns.$inferSelect;
export type InsertPayrollRun = typeof payrollRuns.$inferInsert;

/* بند مسيّر لكل موظف (لقطة الأجر وقت توليد المسيّر). */
export const payrollItems = mysqlTable(
  "payrollItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    runId: bigint("runId", { mode: "number" }).notNull().references(() => payrollRuns.id),
    employeeId: bigint("employeeId", { mode: "number" }).notNull().references(() => employees.id),
    payType: varchar("payType", { length: 10 }).notNull(), // monthly | hourly
    hours: decimal("hours", { precision: 8, scale: 2 }),
    gross: decimal("gross", { precision: 15, scale: 2 }).default("0").notNull(),
    allowances: decimal("allowances", { precision: 15, scale: 2 }).default("0").notNull(),
    overtime: decimal("overtime", { precision: 15, scale: 2 }).default("0").notNull(),
    deductions: decimal("deductions", { precision: 15, scale: 2 }).default("0").notNull(),
    net: decimal("net", { precision: 15, scale: 2 }).default("0").notNull(),
    note: varchar("note", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    runIdx: index("idx_payitem_run").on(t.runId),
    empIdx: index("idx_payitem_emp").on(t.employeeId),
  })
);
export type PayrollItem = typeof payrollItems.$inferSelect;
export type InsertPayrollItem = typeof payrollItems.$inferInsert;

/* طلبات الإجازات (تخصم من رصيد الموظف عند الموافقة على المدفوعة منها). */
export const leaveRequests = mysqlTable(
  "leaveRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    employeeId: bigint("employeeId", { mode: "number" }).notNull().references(() => employees.id),
    leaveType: varchar("leaveType", { length: 30 }).notNull(), // سنوية | مرضية | أمومة | بدون راتب
    paid: boolean("paid").default(true).notNull(),
    fromDate: date("fromDate", { mode: "string" }).notNull(),
    toDate: date("toDate", { mode: "string" }).notNull(),
    days: int("days").notNull(),
    status: mysqlEnum("leaveStatus", ["pending", "approved", "rejected"]).default("pending").notNull(),
    reason: text("reason"),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    decidedBy: int("decidedBy").references(() => users.id),
    decidedAt: timestamp("decidedAt"),
  },
  (t) => ({
    empIdx: index("idx_leave_emp").on(t.employeeId),
    statusIdx: index("idx_leave_status").on(t.status),
  })
);
export type LeaveRequest = typeof leaveRequests.$inferSelect;
export type InsertLeaveRequest = typeof leaveRequests.$inferInsert;

/* الوظائف الشاغرة — معرض التوظيف العام (/apply): يُنشئها فريق HR، يُنشَر منها ما هو مفتوح للتقديم. */
export const jobVacancies = mysqlTable(
  "jobVacancies",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    department: varchar("department", { length: 120 }),
    employmentType: varchar("employmentType", { length: 30 }).default("full_time").notNull(),
    location: varchar("location", { length: 200 }),
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    // سطرٌ تشويقي قصير يظهر على البطاقة قبل التفاصيل.
    summary: varchar("summary", { length: 400 }),
    description: text("description"),
    requirements: text("requirements"),
    // عدد الشواغر المتاحة لهذه الوظيفة (لأغراض العرض الداخلي فقط).
    openings: int("openings").default(1).notNull(),
    // صورة الوظيفة (data URL مضغوط) — MEDIUMTEXT يتّسع لها بهامش واسع كصور المنتجات.
    imageUrl: mediumtext("imageUrl"),
    isPublished: boolean("isPublished").default(false).notNull(),
    // ترتيب يدوي للعرض على المعرض (الأصغر أولاً).
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({ pubIdx: index("idx_vacancy_published").on(t.isPublished) })
);
export type JobVacancy = typeof jobVacancies.$inferSelect;
export type InsertJobVacancy = typeof jobVacancies.$inferInsert;

/* المتقدّمون للوظائف (رابط خارجي عام + استمارة ورقية تُدخَل يدوياً) + مسار مراحل. */
export const jobApplicants = mysqlTable(
  "jobApplicants",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    jobTitle: varchar("jobTitle", { length: 150 }),
    // ربط اختياري بالوظيفة الشاغرة التي قدّم المتقدّم عليها (إن قدّم عبر بطاقة في المعرض).
    vacancyId: bigint("vacancyId", { mode: "number" }).references(() => jobVacancies.id),
    source: varchar("source", { length: 20 }).default("external").notNull(), // external | paper | archive
    stage: mysqlEnum("applicantStage", ["new", "review", "interview", "accepted", "rejected", "archived"]).default("new").notNull(),
    appliedDate: date("appliedDate", { mode: "string" }),
    phone: varchar("phone", { length: 20 }),
    email: varchar("email", { length: 120 }),
    experience: varchar("experience", { length: 120 }),
    education: varchar("education", { length: 200 }),
    // 0018: DB-level CHECK (rating BETWEEN 0 AND 5، يسمح بـNULL) أُضيف في migration 0018.
    rating: int("rating").default(0),
    notes: text("notes"),
    cvFileKey: varchar("cvFileKey", { length: 512 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ stageIdx: index("idx_applicant_stage").on(t.stage) })
);
export type JobApplicant = typeof jobApplicants.$inferSelect;
export type InsertJobApplicant = typeof jobApplicants.$inferInsert;

/* أجهزة البصمة (الموارد البشرية) + شاشة الهجرة من المزوّد المدفوع إلى خادم الرؤية. */
export const hrFingerprintDevices = mysqlTable(
  "hrFingerprintDevices",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    model: varchar("model", { length: 120 }),
    location: varchar("location", { length: 200 }),
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    deviceCode: varchar("deviceCode", { length: 60 }),
    ip: varchar("ip", { length: 64 }),
    port: int("port"),
    /** الخادم الحالي الذي يرفع له الجهاز (المزوّد المدفوع قبل الهجرة، خادم الرؤية بعدها). */
    serverHost: varchar("serverHost", { length: 120 }),
    serverPort: int("serverPort"),
    migrated: boolean("migrated").default(false).notNull(),
    status: varchar("status", { length: 12 }).default("offline"), // online | offline
    usersCount: int("usersCount").default(0),
    recordsCount: int("recordsCount").default(0),
    firmware: varchar("firmware", { length: 60 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({ migratedIdx: index("idx_fpdev_migrated").on(t.migrated) })
);
export type HrFingerprintDevice = typeof hrFingerprintDevices.$inferSelect;
export type InsertHrFingerprintDevice = typeof hrFingerprintDevices.$inferInsert;

/* الترقيات (اعتمادها يحدّث مسمّى/راتب الموظف). */
export const employeePromotions = mysqlTable(
  "employeePromotions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    employeeId: bigint("employeeId", { mode: "number" }).notNull().references(() => employees.id),
    fromTitle: varchar("fromTitle", { length: 150 }),
    toTitle: varchar("toTitle", { length: 150 }).notNull(),
    fromSalary: decimal("fromSalary", { precision: 15, scale: 2 }),
    toSalary: decimal("toSalary", { precision: 15, scale: 2 }),
    effectiveDate: date("effectiveDate", { mode: "string" }).notNull(),
    reason: varchar("reason", { length: 255 }),
    status: mysqlEnum("promotionStatus", ["pending", "approved"]).default("pending").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    approvedAt: timestamp("approvedAt"),
    approvedBy: int("approvedBy").references(() => users.id),
  },
  (t) => ({ empIdx: index("idx_promo_emp").on(t.employeeId) })
);
export type EmployeePromotion = typeof employeePromotions.$inferSelect;
export type InsertEmployeePromotion = typeof employeePromotions.$inferInsert;

/* إنهاء الخدمات (إكماله يضع الموظف «منتهي الخدمة» + تاريخ + تسوية). */
export const employeeTerminations = mysqlTable(
  "employeeTerminations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    employeeId: bigint("employeeId", { mode: "number" }).notNull().references(() => employees.id),
    terminationType: varchar("terminationType", { length: 30 }).notNull(), // انتهاء عقد | استقالة | فصل
    lastDay: date("lastDay", { mode: "string" }).notNull(),
    settlement: decimal("settlement", { precision: 15, scale: 2 }).default("0").notNull(),
    reason: varchar("reason", { length: 255 }),
    status: mysqlEnum("terminationStatus", ["pending", "completed"]).default("pending").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ empIdx: index("idx_term_emp").on(t.employeeId) })
);
export type EmployeeTermination = typeof employeeTerminations.$inferSelect;
export type InsertEmployeeTermination = typeof employeeTerminations.$inferInsert;

/* ============================================================
 * المرحلة ٦: إقفال مالي + موافقات ائتمان + رولوفر سنوي
 * ============================================================ */

/** فترات مالية مُقفَلة — يمنع كتابة قيود تاريخية صامتاً.
 * المنطق: قيد بـentryDate ≤ cutoffDate من أحدث صفّ status=LOCKED ⇒ مرفوض.
 * مدير العمليات يضع cutoff عند الإقفال الشهري/السنوي. حذف صفّ = فتح الفترة. */
export const financialPeriods = mysqlTable(
  "financialPeriods",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    cutoffDate: date("cutoffDate", { mode: "string" }).notNull(),
    status: mysqlEnum("periodStatus", ["LOCKED", "ARCHIVED"]).default("LOCKED").notNull(),
    notes: varchar("notes", { length: 255 }),
    lockedBy: int("lockedBy").notNull().references(() => users.id),
    lockedAt: timestamp("lockedAt").defaultNow().notNull(),
  },
  (t) => ({
    cutoffIdx: index("idx_period_cutoff").on(t.cutoffDate),
    statusIdx: index("idx_period_status").on(t.status),
  })
);
export type FinancialPeriod = typeof financialPeriods.$inferSelect;
export type InsertFinancialPeriod = typeof financialPeriods.$inferInsert;

/** موافقات ائتمان مُسبَقة — يُقيِّد creditApproved بـ(customer, maxAmount, expiresAt).
 * المنطق: المدير يُنشئ صفّاً بـ(customerId, maxAmount, expiresAt). الكاشير يمرّر approvalId
 * في sale؛ الخدمة تتحقّق: customer مطابق، unpaid ≤ maxAmount، now ≤ expiresAt، consumedAt IS NULL.
 * بعد الاستهلاك consumedAt + consumedByInvoiceId مُسجَّلان ⇒ لا تُستعمل ثانية. */
export const creditApprovals = mysqlTable(
  "creditApprovals",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    customerId: bigint("customerId", { mode: "number" }).notNull().references(() => customers.id),
    maxAmount: decimal("maxAmount", { precision: 15, scale: 2 }).notNull(),
    approvedBy: int("approvedBy").notNull().references(() => users.id),
    approvedAt: timestamp("approvedAt").defaultNow().notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    consumedByInvoiceId: bigint("consumedByInvoiceId", { mode: "number" }).references(() => invoices.id),
    notes: varchar("notes", { length: 255 }),
  },
  (t) => ({
    customerExpiryIdx: index("idx_capp_customer").on(t.customerId, t.expiresAt),
  })
);
export type CreditApproval = typeof creditApprovals.$inferSelect;
export type InsertCreditApproval = typeof creditApprovals.$inferInsert;

/** لقطات إقفال سنوية — للأرشفة + رولوفر retained earnings.
 * يُربط بـAccountingEntry من نوع ADJUST يحمل rollover P&L → opening balance للسنة الجديدة. */
export const yearEndSnapshots = mysqlTable(
  "yearEndSnapshots",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    year: int("year").notNull(),
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    closedAt: timestamp("closedAt").defaultNow().notNull(),
    closedBy: int("closedBy").notNull().references(() => users.id),
    totalRevenue: decimal("totalRevenue", { precision: 15, scale: 2 }).notNull(),
    totalCogs: decimal("totalCogs", { precision: 15, scale: 2 }).notNull(),
    totalExpenses: decimal("totalExpenses", { precision: 15, scale: 2 }).notNull(),
    netProfit: decimal("netProfit", { precision: 15, scale: 2 }).notNull(),
    retainedEarningsEntryId: bigint("retainedEarningsEntryId", { mode: "number" }).references(() => accountingEntries.id),
    snapshotData: text("snapshotData"),
  },
  (t) => ({
    yearBranchUq: unique("uq_year_branch").on(t.year, t.branchId),
  })
);
export type YearEndSnapshot = typeof yearEndSnapshots.$inferSelect;
export type InsertYearEndSnapshot = typeof yearEndSnapshots.$inferInsert;

/* ============================ صَندوق الوارد المُوحَّد — قَنوات + محادثات + رَسائل (شَريحة #5) ============================
 *
 * المَنطق: كل قَناة (WhatsApp/Instagram/متجر/هاتف/حُضوري) تَصبّ في «محادثة» واحدة لِلعَميل.
 * المُحادثة = مَوضوع مفتوح بَين خِدمة العُملاء وزَبون عبر قَناة مُحدَّدة. تَجمع رَسائل IN (مِن العَميل)
 * و OUT (مِن مُوظَّفنا). تَدخل بَطريقَين:
 *
 *   ١) Webhook مِن مَنصّة القَناة (WhatsApp Business API/Instagram Graph/متجر) ⇒ يَكتب رِسالة IN جَديدة
 *      أو يُحدّث محادثة قائمة (مُطابقة بـchannel + channelHandle).
 *   ٢) إدخال يَدوي مِن مُوظَّف (اتصال هاتفي/حُضوري/مَلاحظات) ⇒ نَفس الجَدول، direction=IN/OUT/NOTE.
 *
 * الرَبط بِأَوامر الشَغل: محادثة قَد تُرتبط بِأَمر شَغل لِتَتبّع تَفاصيل العَمل تَحتها. مَن يَفتح مُحادثة
 * عَميل في الاستقبال ويَختار «أمر شَغل» ⇒ نُسجّل linkedWorkOrderId.
 */

/** المحادثات — مَوضوع مفتوح مع عَميل عبر قَناة. */
export const conversations = mysqlTable(
  "conversations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    channel: mysqlEnum("convChannel", ["WHATSAPP", "INSTAGRAM", "TIKTOK", "STORE", "PHONE", "WALK_IN", "OTHER"]).notNull(),
    // مُعَرّف العَميل على القَناة الأَصلية (رَقم هاتف لِواتساب، username لانستغرام، ...).
    // فَريد لكل (channel + branch) لِمَنع تَكرار المحادثة لنفس الزَبون.
    channelHandle: varchar("channelHandle", { length: 120 }).notNull(),
    // رَبط للسجلّ العميل في نِظامنا (إن وُجد) — قد يَكون null لِرسالة أَولى مِن مَجهول.
    customerId: bigint("customerId", { mode: "number" }).references(() => customers.id),
    // اسم مَعروض (مُلتَقَط مِن منصّة القَناة لو لم نَعرفه بَعد).
    displayName: varchar("displayName", { length: 200 }),
    // أَمر شَغل مَربوط (لو الزَبون يَسأل عن أمر جاري) — اِختياري.
    linkedWorkOrderId: bigint("linkedWorkOrderId", { mode: "number" }).references(() => workOrders.id),
    // عَدّاد غَير مَقروء + آخِر رِسالة لِفَرز الـinbox بِسُرعة بَلا scan رَسائل.
    unreadCount: int("unreadCount").default(0).notNull(),
    lastMessageAt: timestamp("lastMessageAt"),
    lastMessagePreview: varchar("lastMessagePreview", { length: 280 }),
    // OPEN = نَشِط، ARCHIVED = مُؤرشَف يَدوياً، CLOSED = بَعد تَسليم أَمر شَغل.
    status: mysqlEnum("convStatus", ["OPEN", "ARCHIVED", "CLOSED"]).default("OPEN").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    branchIdx: index("idx_conv_branch").on(t.branchId, t.status, t.lastMessageAt),
    customerIdx: index("idx_conv_customer").on(t.customerId),
    // مُحادثة فَريدة لكل (قَناة + handle + فَرع) ⇒ webhook مُكَرّر لا يُكرّر السجلّ.
    chHandleUq: unique("uq_conv_channel_handle").on(t.channel, t.channelHandle, t.branchId),
  })
);
export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;

/** رَسائل المحادثة — IN مِن الزَبون، OUT مِن مُوظَّفنا، NOTE مُلاحظة داخِلية. */
export const conversationMessages = mysqlTable(
  "conversationMessages",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    conversationId: bigint("conversationId", { mode: "number" }).notNull().references(() => conversations.id, { onDelete: "cascade" }),
    direction: mysqlEnum("msgDirection", ["IN", "OUT", "NOTE"]).notNull(),
    // النَصّ الكامل (TEXT لاستيعاب رَسائل طَويلة + لو رَسالة مَيديا فقط = caption).
    body: text("body"),
    // URL لمَلف الوسائط (صورة/صوت/PDF) — لو الرَسالة وَسائط.
    mediaUrl: text("mediaUrl"),
    mediaType: varchar("mediaType", { length: 40 }), // image/jpeg، application/pdf، audio/ogg، ...
    // مُعَرّف الرَسالة عند المُزوّد (لـwebhook dedup + إعادة الإرسال بَدل تَكرار).
    externalId: varchar("externalId", { length: 200 }),
    // مَن أَرسل OUT/NOTE — null لِـIN (مِن الزَبون).
    authorUserId: int("authorUserId").references(() => users.id),
    // حالة التَوصيل لِـOUT (لِواتساب: sent/delivered/read).
    deliveryStatus: mysqlEnum("msgDelivery", ["PENDING", "SENT", "DELIVERED", "READ", "FAILED"]),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    convIdx: index("idx_msg_conv").on(t.conversationId, t.createdAt),
    // مُعَرّف خارِجي فَريد لِمَنع كَتابة مُكَرَّرة عند webhook retries.
    externalUq: unique("uq_msg_external").on(t.externalId),
  })
);
export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type InsertConversationMessage = typeof conversationMessages.$inferInsert;

/* ============================ تَكاملات القَنوات الخارِجية (شَريحة #6) ============================
 *
 * المَنطق: بَدل تَخزين secrets في .env (يَلزم SSH للسيرفر عند كل تَغيير)، نُخَزّنها مُشَفَّرة في DB.
 * المُفتاح الرَئيسي وَحده في .env كـ INTEGRATIONS_ENCRYPTION_KEY (32 bytes hex/base64).
 *
 * التَشفير: AES-256-GCM (مَع 12-byte IV عَشوائي لكل قِيمة + 16-byte auth tag) ⇒
 *   مَلف backup مَكشوف بَلا المُفتاح = صَفر مَعلومات (semantic security).
 *
 * RBAC: adminProcedure فَقط — لا الكاشير ولا المُدير يَرى/يُعَدّل tokens.
 * Audit: كل upsert/delete/decrypt-for-use يُكتَب في auditLogs.
 * Multi-branch: مُفتاح فَريد (branchId, channel) ⇒ WhatsApp مُختلف لكل فَرع.
 */

export const channelIntegrations = mysqlTable(
  "channelIntegrations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    channel: mysqlEnum("intChannel", ["WHATSAPP", "INSTAGRAM", "STORE"]).notNull(),
    // مَعلومات عامة (بَلا تَشفير، آمنة لِلعَرض).
    displayName: varchar("displayName", { length: 120 }),
    // phoneNumberId لِـWhatsApp (مَعلومة، ليست secret).
    phoneNumberId: varchar("phoneNumberId", { length: 80 }),
    // verifyToken لِـMeta webhook handshake — مُشَفَّر.
    encryptedVerifyToken: text("encryptedVerifyToken"),
    // appSecret لِـHMAC verify لِـwebhooks — مُشَفَّر.
    encryptedAppSecret: text("encryptedAppSecret"),
    // accessToken لإرسال رَسائل OUT (WhatsApp Cloud API) — مُشَفَّر.
    encryptedAccessToken: text("encryptedAccessToken"),
    // حالة الاتصال — يُحدّث عبر زر «تَحقّق».
    status: mysqlEnum("intStatus", ["PENDING", "ACTIVE", "FAILED", "DISABLED"]).default("PENDING").notNull(),
    lastVerifiedAt: timestamp("lastVerifiedAt"),
    // نَتيجة آخر تَحقّق (إن فَشل): سَبب مَقروء لِلعَرض في الشاشة.
    lastError: varchar("lastError", { length: 500 }),
    updatedBy: int("updatedBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    // قَناة واحدة لكل فَرع — لا تَكرار. تَغيير tokens = تَحديث نَفس السجلّ.
    branchChannelUq: unique("uq_int_branch_channel").on(t.branchId, t.channel),
    statusIdx: index("idx_int_status").on(t.status),
  })
);
export type ChannelIntegration = typeof channelIntegrations.$inferSelect;
export type InsertChannelIntegration = typeof channelIntegrations.$inferInsert;

/* ============================ التوصيل (COD) — جهات التوصيل والعهد والترحيل ============================ */

/** جهة توصيل: مندوب فرد أو شركة توصيل. كيان بيانات (لا مستخدم نظام). currentBalance = عهدة COD القائمة. */
export const deliveryParties = mysqlTable(
  "deliveryParties",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    partyType: mysqlEnum("deliveryPartyKind", ["INDIVIDUAL", "COMPANY"]).default("INDIVIDUAL").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 20 }),
    phone2: varchar("phone2", { length: 20 }),
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    nationalId: varchar("nationalId", { length: 40 }),
    vehicleInfo: varchar("vehicleInfo", { length: 120 }),
    // أجرة توصيل افتراضية ثابتة لكل طلب (D7) — تُملأ في حوار التعيين ويُمكن تعديلها.
    defaultFee: decimal("defaultFee", { precision: 15, scale: 2 }).default("0").notNull(),
    // عهدة COD القائمة (موجب = الجهة مدينة بنقدٍ مطلوب تحصيله/تحصَّل ولم يُورَّد). نظير customers.currentBalance.
    currentBalance: decimal("currentBalance", { precision: 15, scale: 2 }).default("0").notNull(),
    floatLimit: decimal("floatLimit", { precision: 15, scale: 2 }),
    notes: text("notes"),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    nameIdx: index("idx_delivery_party_name").on(table.name),
    branchIdx: index("idx_delivery_party_branch").on(table.branchId),
    activeIdx: index("idx_delivery_party_active").on(table.isActive),
  }),
);
export type DeliveryParty = typeof deliveryParties.$inferSelect;
export type InsertDeliveryParty = typeof deliveryParties.$inferInsert;

/* ============================ الصيرفة (الصرّاف / مكتب التحويل) — exchange-house (٣٠/٦) ============================
 * طرف مالي وسيط: نُودِع لديه نقداً، ونُسدّد عبره الموردين، ونحفظ رصيداً لنا — بمحفظتين (دينار + دولار).
 * اتفاقية الإشارة: موجب = الصيرفة مدينة لنا (أموالنا محفوظة لديها) — نظير deliveryParties (عهدة)،
 * **معاكسة عمداً** لاتفاقية suppliers (موجب = نحن مدينون). كل تغيير رصيد عبر adjustExchangeBalance* حصراً،
 * تحت قفل صفّ FOR UPDATE. محفظة الدولار تُقيَّم بمتوسط كلفة مرجّح (usdCostRate, WAVG) = أساس فرق الصرف المحقَّق.
 */
export const exchangeHouses = mysqlTable(
  "exchangeHouses",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 20 }),
    phone2: varchar("phone2", { length: 20 }),
    // محفظتان مستقلّتان (موجب = لنا عندها). تُحدَّثان ذرّياً تحت قفل صفّ FOR UPDATE.
    balanceIqd: decimal("balanceIqd", { precision: 15, scale: 2 }).default("0").notNull(),
    balanceUsd: decimal("balanceUsd", { precision: 15, scale: 2 }).default("0").notNull(),
    // متوسط كلفة الدينار للدولار الواحد (WAVG) — يُحدَّث عند شراء الدولار؛ أساس تقييم المحفظة وفرق الصرف.
    usdCostRate: decimal("usdCostRate", { precision: 15, scale: 4 }).default("0").notNull(),
    legacyCode: varchar("legacyCode", { length: 40 }),
    notes: text("notes"),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    nameIdx: index("idx_exchange_name").on(table.name),
    activeIdx: index("idx_exchange_active").on(table.isActive),
    legacyUq: unique("uq_exchange_legacy").on(table.legacyCode),
  }),
);
export type ExchangeHouse = typeof exchangeHouses.$inferSelect;
export type InsertExchangeHouse = typeof exchangeHouses.$inferInsert;

/** سجلّ عمليات الصيرفة (إيداع/سحب/شراء دولار/تسديد مورد/افتتاحي) — نظير cashTransfers/deliveryConsignments.
 *  مصدر تفصيل العملية ثنائية العملة وكشف الحساب؛ الرصيد الحقيقي في exchangeHouses، والقيد المحاسبي (IQD) في accountingEntries. */
export const exchangeTransactions = mysqlTable(
  "exchangeTransactions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    txnNumber: varchar("txnNumber", { length: 50 }).notNull().unique(), // EX-{branch}-{YYYYMMDD}-{seq}
    exchangeHouseId: bigint("exchangeHouseId", { mode: "number" }).notNull().references(() => exchangeHouses.id),
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    type: mysqlEnum("exchangeTxnType", ["DEPOSIT", "WITHDRAW", "FX_BUY", "SETTLE", "OPENING"]).notNull(),
    currency: mysqlEnum("exchangeTxnCurrency", ["IQD", "USD"]).default("IQD").notNull(),
    // مبلغ الدينار (إيداع/سحب/الدين المُسوّى) ومبلغ الدولار (شراء/تسديد بالدولار) — كلٌّ بعملته.
    iqdAmount: decimal("iqdAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    usdAmount: decimal("usdAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    exchangeRate: decimal("exchangeRate", { precision: 15, scale: 4 }).default("0").notNull(),
    commission: decimal("commission", { precision: 15, scale: 2 }).default("0").notNull(), // بعملة المحفظة
    commissionIqd: decimal("commissionIqd", { precision: 15, scale: 2 }).default("0").notNull(),
    fxDiff: decimal("fxDiff", { precision: 15, scale: 2 }).default("0").notNull(), // مكسب(+)/خسارة(−) صرف محقَّق
    supplierId: bigint("supplierId", { mode: "number" }).references(() => suppliers.id),
    // لقطة الرصيد بعد العملية (تدقيق + رصيد جارٍ في كشف الحساب).
    balanceIqdAfter: decimal("balanceIqdAfter", { precision: 15, scale: 2 }).default("0").notNull(),
    balanceUsdAfter: decimal("balanceUsdAfter", { precision: 15, scale: 2 }).default("0").notNull(),
    receiptId: bigint("receiptId", { mode: "number" }).references(() => receipts.id),
    status: mysqlEnum("exchangeTxnStatus", ["ACTIVE", "REVERSED"]).default("ACTIVE").notNull(),
    notes: text("notes"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_exchange_txn_number").on(table.txnNumber),
    houseIdx: index("idx_exchange_txn_house").on(table.exchangeHouseId, table.createdAt),
    supplierIdx: index("idx_exchange_txn_supplier").on(table.supplierId),
    typeIdx: index("idx_exchange_txn_type").on(table.type),
  }),
);
export type ExchangeTransaction = typeof exchangeTransactions.$inferSelect;
export type InsertExchangeTransaction = typeof exchangeTransactions.$inferInsert;

/** دفعة ترحيل: تسوية تحصيلات جهة التوصيل (خصم الأجرة وتوريد الصافي — D8). */
export const deliveryRemittances = mysqlTable(
  "deliveryRemittances",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    remittanceNumber: varchar("remittanceNumber", { length: 50 }).notNull().unique(), // DR-{branch}-{YYYYMMDD}-{seq}
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    partyId: bigint("partyId", { mode: "number" }).notNull().references(() => deliveryParties.id),
    // الوردية التي استلمت صافي النقد (RECEPTION/RETAIL) — يُحدَّد عبر shiftIdForCashTx.
    shiftId: bigint("shiftId", { mode: "number" }).references(() => shifts.id),
    collectedTotal: decimal("collectedTotal", { precision: 15, scale: 2 }).notNull(), // Σ المُحصَّل (COD)
    feesTotal: decimal("feesTotal", { precision: 15, scale: 2 }).default("0").notNull(), // Σ الأجور (مستحقات الجهة)
    netRemitted: decimal("netRemitted", { precision: 15, scale: 2 }).notNull(), // collectedTotal − feesTotal
    shortfallTotal: decimal("shortfallTotal", { precision: 15, scale: 2 }).default("0").notNull(), // عجز يبقى عهدة (D4)
    // إيصالا الدرج: IN=collectedTotal (نقد كامل) + OUT=feesTotal (مصروف توصيل) ⇒ صافي الدرج = netRemitted.
    receiptInId: bigint("receiptInId", { mode: "number" }).references(() => receipts.id),
    receiptOutId: bigint("receiptOutId", { mode: "number" }).references(() => receipts.id),
    status: mysqlEnum("deliveryRemittanceStatus", ["BALANCED", "SHORT", "OVER"]).notNull(),
    receivedBy: int("receivedBy").references(() => users.id),
    receivedAt: timestamp("receivedAt").defaultNow().notNull(),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_delivery_remit_number").on(table.remittanceNumber),
    partyIdx: index("idx_delivery_remit_party").on(table.partyId),
    branchIdx: index("idx_delivery_remit_branch").on(table.branchId),
    shiftIdx: index("idx_delivery_remit_shift").on(table.shiftId),
  }),
);
export type DeliveryRemittance = typeof deliveryRemittances.$inferSelect;
export type InsertDeliveryRemittance = typeof deliveryRemittances.$inferInsert;

/** إرسالية: طردٌ خرج مع جهة التوصيل بمبلغ COD. سطر العهدة الذي يربط الفاتورة↔الجهة↔الترحيل. */
export const deliveryConsignments = mysqlTable(
  "deliveryConsignments",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    consignmentNumber: varchar("consignmentNumber", { length: 50 }).notNull().unique(), // CN-{branch}-{YYYYMMDD}-{seq}
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    partyId: bigint("partyId", { mode: "number" }).notNull().references(() => deliveryParties.id),
    invoiceId: bigint("invoiceId", { mode: "number" }).notNull().references(() => invoices.id),
    workOrderId: bigint("workOrderId", { mode: "number" }),
    // العميل النهائي (المستلم). الفاتورة نفسها customerId=NULL (الطرف المقابل = جهة التوصيل، عهدة لا AR).
    endCustomerId: bigint("endCustomerId", { mode: "number" }).references(() => customers.id),
    codAmount: decimal("codAmount", { precision: 15, scale: 2 }).notNull(), // المطلوب تحصيله = total − deposit
    collectedAmount: decimal("collectedAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    deliveryFee: decimal("deliveryFee", { precision: 15, scale: 2 }).default("0").notNull(), // أجرة ثابتة لكل طلب (D7)
    recipientName: varchar("recipientName", { length: 255 }),
    recipientPhone: varchar("recipientPhone", { length: 20 }),
    deliveryAddress: text("deliveryAddress"),
    status: mysqlEnum("consignmentStatus", ["DISPATCHED", "DELIVERED", "PARTIAL", "RETURNED", "WRITTEN_OFF"]).default("DISPATCHED").notNull(),
    remittanceId: bigint("remittanceId", { mode: "number" }).references(() => deliveryRemittances.id),
    dispatchedBy: int("dispatchedBy").references(() => users.id),
    dispatchedAt: timestamp("dispatchedAt").defaultNow().notNull(),
    settledAt: timestamp("settledAt"),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_consignment_number").on(table.consignmentNumber),
    partyStatusIdx: index("idx_consignment_party_status").on(table.partyId, table.status),
    branchIdx: index("idx_consignment_branch").on(table.branchId),
    remittanceIdx: index("idx_consignment_remittance").on(table.remittanceId),
    // حارس بنيوي: فاتورة واحدة ⇒ إرسالية واحدة (لا ازدواج عهدة على نفس البيع).
    invoiceUq: unique("uq_consignment_invoice").on(table.invoiceId),
  }),
);
export type DeliveryConsignment = typeof deliveryConsignments.$inferSelect;
export type InsertDeliveryConsignment = typeof deliveryConsignments.$inferInsert;

/** إعدادات الضريبة (صفّ singleton واحد id=1): افتراضي تفعيل الضريبة على الفاتورة الجديدة +
 *  نسبتها + الرقم الضريبي للشركة (يُطبَع على الفاتورة). العراق VAT=0% افتراضياً — enabledByDefault
 *  يبقى false ما لم يُفعِّله المدير صراحةً. يُنشَأ الصفّ كسولاً (get-or-create) عند أول قراءة. */
export const taxSettings = mysqlTable("taxSettings", {
  id: int("id").autoincrement().primaryKey(),
  enabledByDefault: boolean("enabledByDefault").default(false).notNull(),
  defaultTaxRatePercent: decimal("defaultTaxRatePercent", { precision: 5, scale: 2 }).default("0").notNull(),
  taxRegistrationNumber: varchar("taxRegistrationNumber", { length: 50 }),
  updatedBy: int("updatedBy").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type TaxSettings = typeof taxSettings.$inferSelect;
export type InsertTaxSettings = typeof taxSettings.$inferInsert;
