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
    creditLimit: decimal("creditLimit", { precision: 15, scale: 2 }).default("0"),
    currentBalance: decimal("currentBalance", { precision: 15, scale: 2 }).default("0").notNull(),
    // import-integration: المعرّف القديم («الرقم» في ملفات النظام السابق) — مفتاح مطابقة الاستيراد.
    // UNIQUE يسمح بتعدّد NULL ⇒ حارس بنيوي ضدّ ازدواج الطرف برصيد عند استيراد متزامن.
    legacyCode: varchar("legacyCode", { length: 40 }),
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    nameIdx: index("idx_customer_name").on(table.name),
    phoneIdx: index("idx_customer_phone").on(table.phone),
    legacyUq: unique("uq_customer_legacy").on(table.legacyCode),
  })
);

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = typeof customers.$inferInsert;

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
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
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
    quantity: int("quantity").default(0).notNull(),
    // آخر جرد معتمد شمل هذا الصنف في هذا الفرع — يغذّي «آخر جرد» والجرد الدوري ABC.
    lastCountedAt: timestamp("lastCountedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    variantBranchUq: unique("uq_stock_variant_branch").on(table.variantId, table.branchId),
    branchIdx: index("idx_stock_branch").on(table.branchId),
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
    // حارس ذرّي: «userId:branchId» عند الفتح، NULL عند الإغلاق. UNIQUE يسمح بـNULL متعدّد
    // ⇒ وردية مفتوحة واحدة لكل (موظّف×فرع)؛ فتحٌ متزامن ثانٍ يفشل بـER_DUP_ENTRY.
    openGuard: varchar("openGuard", { length: 64 }).unique("uq_shift_open_guard"),
    openedAt: timestamp("openedAt").defaultNow().notNull(),
    closedAt: timestamp("closedAt"),
    notes: text("notes"),
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
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    returnedBaseQuantity: int("returnedBaseQuantity").default(0).notNull(),
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
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    paymentMethod: mysqlEnum("paymentMethod", ["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]).notNull(),
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
  },
  (table) => ({
    invoiceIdx: index("idx_receipt_invoice").on(table.invoiceId),
    workOrderIdx: index("idx_receipt_wo").on(table.workOrderId),
    branchIdx: index("idx_receipt_branch").on(table.branchId),
    dateIdx: index("idx_receipt_date").on(table.createdAt),
    voucherIdx: index("idx_receipt_voucher").on(table.voucherNumber),
    partyIdx: index("idx_receipt_party").on(table.partyType, table.partyId),
  })
);

export type Receipt = typeof receipts.$inferSelect;
export type InsertReceipt = typeof receipts.$inferInsert;

/* ============================ الدفتر المحاسبي المبسّط ============================ */

/** قيد محاسبي موحّد يُنشأ تلقائياً من العمليات (بيع/شراء/دفع/إرجاع). */
export const accountingEntries = mysqlTable(
  "accountingEntries",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // import-integration: OPENING = قيد ترسيخ الرصيد الافتتاحي المستورد من النظام القديم.
    // production-slice: INTERNAL_USE = نثرية داخلية (مصروف بالكلفة)، WASTAGE = تلف/هدر (خسارة بالكلفة) — كلاهما بلا نقد.
    entryType: mysqlEnum("entryType", ["SALE", "PURCHASE", "PAYMENT_IN", "PAYMENT_OUT", "RETURN", "ADJUST", "OPENING", "INTERNAL_USE", "WASTAGE"]).notNull(),
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(() => invoices.id),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" }),
    receiptId: bigint("receiptId", { mode: "number" }).references(() => receipts.id),
    customerId: bigint("customerId", { mode: "number" }).references(() => customers.id),
    supplierId: bigint("supplierId", { mode: "number" }).references(() => suppliers.id),
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
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    paymentMethod: mysqlEnum("expensePaymentMethod", ["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]).default("CASH").notNull(),
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
    // import-integration: MEDIUMTEXT (~16MB) — TEXT (64KB) كان يكسر data URLs للصور بـ«قيمة أطول من المسموح».
    url: mediumtext("url").notNull(),
    isPrimary: boolean("isPrimary").default(false).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    prodIdx: index("idx_pimg_product").on(table.productId),
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
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    paidAmount: decimal("paidAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    status: mysqlEnum("poStatus", ["DRAFT", "SENT", "CONFIRMED", "RECEIVED", "CANCELLED"]).default("DRAFT").notNull(),
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
  })
);

export type Employee = typeof employees.$inferSelect;
export type InsertEmployee = typeof employees.$inferInsert;

export const attendance = mysqlTable(
  "attendance",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    employeeId: bigint("employeeId", { mode: "number" }).notNull().references(() => employees.id),
    attendanceDate: date("attendanceDate").notNull(),
    checkIn: timestamp("checkIn"),
    checkOut: timestamp("checkOut"),
    status: mysqlEnum("attendanceStatus", ["PRESENT", "ABSENT", "LATE", "LEAVE"]).notNull(),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    employeeIdx: index("idx_att_employee").on(table.employeeId),
    dateIdx: index("idx_att_date").on(table.attendanceDate),
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
