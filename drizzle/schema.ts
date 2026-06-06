import {
  int,
  bigint,
  decimal,
  varchar,
  text,
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
    email: varchar("email", { length: 320 }),
    passwordHash: varchar("passwordHash", { length: 255 }),
    phone: varchar("phone", { length: 20 }),
    loginMethod: varchar("loginMethod", { length: 64 }).default("local"),
    role: mysqlEnum("role", ["user", "admin", "manager", "cashier", "warehouse"]).default("user").notNull(),
    branchId: bigint("branchId", { mode: "number" }),
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
  },
  (table) => ({
    emailIdx: index("idx_user_email").on(table.email),
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
    phone: varchar("phone", { length: 20 }),
    whatsapp: varchar("whatsapp", { length: 20 }),
    address: text("address"),
    city: varchar("city", { length: 100 }),
    district: varchar("district", { length: 100 }),
    customerType: mysqlEnum("customerType", ["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"]).default("فرد"),
    defaultPriceTier: mysqlEnum("defaultPriceTier", ["RETAIL", "WHOLESALE", "GOVERNMENT"]).default("RETAIL").notNull(),
    notes: text("notes"),
    creditLimit: decimal("creditLimit", { precision: 15, scale: 2 }).default("0"),
    currentBalance: decimal("currentBalance", { precision: 15, scale: 2 }).default("0").notNull(),
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    nameIdx: index("idx_customer_name").on(table.name),
    phoneIdx: index("idx_customer_phone").on(table.phone),
  })
);

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = typeof customers.$inferInsert;

export const suppliers = mysqlTable(
  "suppliers",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 20 }),
    email: varchar("email", { length: 320 }),
    whatsapp: varchar("whatsapp", { length: 20 }),
    address: text("address"),
    city: varchar("city", { length: 100 }),
    taxId: varchar("taxId", { length: 50 }),
    productTypes: text("productTypes"),
    paymentTerms: varchar("paymentTerms", { length: 100 }),
    notes: text("notes"),
    currentBalance: decimal("currentBalance", { precision: 15, scale: 2 }).default("0").notNull(),
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    nameIdx: index("idx_supplier_name").on(table.name),
    phoneIdx: index("idx_supplier_phone").on(table.phone),
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
    status: mysqlEnum("invoiceStatus", ["PENDING", "CONFIRMED", "PAID", "PARTIALLY_PAID", "CANCELLED", "RETURNED"]).default("PENDING").notNull(),
    paidAmount: decimal("paidAmount", { precision: 15, scale: 2 }).default("0").notNull(),
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
  })
);

export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type InsertInvoiceItem = typeof invoiceItems.$inferInsert;

/* ============================ المقبوضات والمدفوعات ============================ */

export const receipts = mysqlTable(
  "receipts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(() => invoices.id),
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    shiftId: bigint("shiftId", { mode: "number" }).references(() => shifts.id),
    direction: mysqlEnum("direction", ["IN", "OUT"]).default("IN").notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    paymentMethod: mysqlEnum("paymentMethod", ["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]).notNull(),
    referenceNumber: varchar("referenceNumber", { length: 100 }),
    checkNumber: varchar("checkNumber", { length: 50 }),
    cardLastFour: varchar("cardLastFour", { length: 4 }),
    status: mysqlEnum("receiptStatus", ["PENDING", "COMPLETED", "FAILED", "REVERSED"]).default("COMPLETED").notNull(),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    invoiceIdx: index("idx_receipt_invoice").on(table.invoiceId),
    dateIdx: index("idx_receipt_date").on(table.createdAt),
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
    entryType: mysqlEnum("entryType", ["SALE", "PURCHASE", "PAYMENT_IN", "PAYMENT_OUT", "RETURN", "ADJUST"]).notNull(),
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
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    typeIdx: index("idx_entry_type").on(table.entryType),
    invoiceIdx: index("idx_entry_invoice").on(table.invoiceId),
    dateIdx: index("idx_entry_date").on(table.entryDate),
  })
);

export type AccountingEntry = typeof accountingEntries.$inferSelect;
export type InsertAccountingEntry = typeof accountingEntries.$inferInsert;

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
  })
);

export type WorkOrderMaterial = typeof workOrderMaterials.$inferSelect;
export type InsertWorkOrderMaterial = typeof workOrderMaterials.$inferInsert;

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
    salary: decimal("salary", { precision: 15, scale: 2 }),
    hireDate: date("hireDate"),
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    branchIdx: index("idx_emp_branch").on(table.branchId),
    activeIdx: index("idx_emp_active").on(table.isActive),
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
    actionIdx: index("idx_audit_action").on(table.action),
    dateIdx: index("idx_audit_date").on(table.createdAt),
  })
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;
