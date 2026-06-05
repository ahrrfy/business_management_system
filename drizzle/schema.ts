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
  foreignKey,
  primaryKey,
} from "drizzle-orm/mysql-core";

/**
 * ====================================
 * جداول المستخدمين والمصادقة
 * ====================================
 */

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 20 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin", "manager", "cashier", "warehouse"]).default("user").notNull(),
  isActive: boolean("isActive").default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
}, (table) => ({
  emailIdx: index("idx_email").on(table.email),
  roleIdx: index("idx_role").on(table.role),
}));

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * ====================================
 * جداول العملاء والموردين
 * ====================================
 */

export const customers = mysqlTable("customers", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 100 }),
  phone: varchar("phone", { length: 20 }),
  address: text("address"),
  city: varchar("city", { length: 100 }),
  country: varchar("country", { length: 100 }),
  taxId: varchar("taxId", { length: 50 }),
  creditLimit: decimal("creditLimit", { precision: 15, scale: 2 }).default("0"),
  currentBalance: decimal("currentBalance", { precision: 15, scale: 2 }).default("0"),
  customerType: mysqlEnum("customerType", ["INDIVIDUAL", "BUSINESS"]).default("INDIVIDUAL"),
  isActive: boolean("isActive").default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  nameIdx: index("idx_customer_name").on(table.name),
  phoneIdx: index("idx_customer_phone").on(table.phone),
  emailIdx: index("idx_customer_email").on(table.email),
  activeIdx: index("idx_customer_active").on(table.isActive),
}));

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = typeof customers.$inferInsert;

export const suppliers = mysqlTable("suppliers", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 100 }),
  phone: varchar("phone", { length: 20 }),
  address: text("address"),
  city: varchar("city", { length: 100 }),
  country: varchar("country", { length: 100 }),
  taxId: varchar("taxId", { length: 50 }),
  paymentTerms: varchar("paymentTerms", { length: 100 }),
  isActive: boolean("isActive").default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  nameIdx: index("idx_supplier_name").on(table.name),
  phoneIdx: index("idx_supplier_phone").on(table.phone),
}));

export type Supplier = typeof suppliers.$inferSelect;
export type InsertSupplier = typeof suppliers.$inferInsert;

/**
 * ====================================
 * جداول المنتجات والمخزون
 * ====================================
 */

export const categories = mysqlTable("categories", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull().unique(),
  description: text("description"),
  isActive: boolean("isActive").default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Category = typeof categories.$inferSelect;
export type InsertCategory = typeof categories.$inferInsert;

export const products = mysqlTable("products", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  sku: varchar("sku", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  categoryId: bigint("categoryId", { mode: "number" }).references(() => categories.id),
  costPrice: decimal("costPrice", { precision: 15, scale: 2 }).notNull(),
  salePrice: decimal("salePrice", { precision: 15, scale: 2 }).notNull(),
  wholesalePrice: decimal("wholesalePrice", { precision: 15, scale: 2 }),
  quantityOnHand: int("quantityOnHand").default(0).notNull(),
  quantityReserved: int("quantityReserved").default(0),
  minStock: int("minStock").default(10),
  maxStock: int("maxStock").default(1000),
  reorderPoint: int("reorderPoint").default(50),
  isActive: boolean("isActive").default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  skuIdx: index("idx_product_sku").on(table.sku),
  nameIdx: index("idx_product_name").on(table.name),
  categoryIdx: index("idx_product_category").on(table.categoryId),
  activeIdx: index("idx_product_active").on(table.isActive),
}));

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

export const inventoryMovements = mysqlTable("inventoryMovements", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  productId: bigint("productId", { mode: "number" }).notNull().references(() => products.id),
  movementType: mysqlEnum("movementType", ["IN", "OUT", "ADJUST", "RETURN"]).notNull(),
  quantity: int("quantity").notNull(),
  referenceType: varchar("referenceType", { length: 20 }),
  referenceId: bigint("referenceId", { mode: "number" }),
  notes: text("notes"),
  createdBy: int("createdBy").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  productIdx: index("idx_inventory_product").on(table.productId),
  typeIdx: index("idx_inventory_type").on(table.movementType),
  dateIdx: index("idx_inventory_date").on(table.createdAt),
}));

export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type InsertInventoryMovement = typeof inventoryMovements.$inferInsert;

/**
 * ====================================
 * جداول الفواتير والمبيعات
 * ====================================
 */

export const invoices = mysqlTable("invoices", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  invoiceNumber: varchar("invoiceNumber", { length: 50 }).notNull().unique(),
  sourceType: mysqlEnum("sourceType", ["POS", "ONLINE", "ORDER"]).notNull(),
  sourceId: varchar("sourceId", { length: 50 }),
  customerId: bigint("customerId", { mode: "number" }).notNull().references(() => customers.id),
  invoiceDate: timestamp("invoiceDate").defaultNow().notNull(),
  dueDate: date("dueDate"),
  subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
  taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }).notNull(),
  discountAmount: decimal("discountAmount", { precision: 15, scale: 2 }).default("0"),
  total: decimal("total", { precision: 15, scale: 2 }).notNull(),
  status: mysqlEnum("status", ["PENDING", "CONFIRMED", "PAID", "PARTIALLY_PAID", "CANCELLED", "RETURNED"]).default("PENDING").notNull(),
  paidAmount: decimal("paidAmount", { precision: 15, scale: 2 }).default("0"),
  paymentMethod: varchar("paymentMethod", { length: 20 }),
  paymentDate: timestamp("paymentDate"),
  notes: text("notes"),
  createdBy: int("createdBy").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  syncedAt: timestamp("syncedAt"),
  syncedToServer: boolean("syncedToServer").default(false),
}, (table) => ({
  invoiceNumberIdx: index("idx_invoice_number").on(table.invoiceNumber),
  customerIdx: index("idx_invoice_customer").on(table.customerId),
  dateIdx: index("idx_invoice_date").on(table.invoiceDate),
  statusIdx: index("idx_invoice_status").on(table.status),
  sourceIdx: index("idx_invoice_source").on(table.sourceType),
  syncIdx: index("idx_invoice_synced").on(table.syncedToServer),
}));

export type Invoice = typeof invoices.$inferSelect;
export type InsertInvoice = typeof invoices.$inferInsert;

export const invoiceItems = mysqlTable("invoiceItems", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  invoiceId: bigint("invoiceId", { mode: "number" }).notNull().references(() => invoices.id, { onDelete: "cascade" }),
  productId: bigint("productId", { mode: "number" }).notNull().references(() => products.id),
  quantity: int("quantity").notNull(),
  unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
  discountPercent: decimal("discountPercent", { precision: 5, scale: 2 }).default("0"),
  discountAmount: decimal("discountAmount", { precision: 15, scale: 2 }).default("0"),
  taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }).default("0"),
  total: decimal("total", { precision: 15, scale: 2 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  invoiceIdx: index("idx_invoice_items_invoice").on(table.invoiceId),
  productIdx: index("idx_invoice_items_product").on(table.productId),
}));

export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type InsertInvoiceItem = typeof invoiceItems.$inferInsert;

/**
 * ====================================
 * جداول المقبوضات والدفعات
 * ====================================
 */

export const receipts = mysqlTable("receipts", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  invoiceId: bigint("invoiceId", { mode: "number" }).notNull().references(() => invoices.id),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  paymentMethod: mysqlEnum("paymentMethod", ["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]).notNull(),
  referenceNumber: varchar("referenceNumber", { length: 100 }),
  checkNumber: varchar("checkNumber", { length: 50 }),
  cardLastFour: varchar("cardLastFour", { length: 4 }),
  status: mysqlEnum("receiptStatus", ["PENDING", "COMPLETED", "FAILED", "REVERSED"]).default("COMPLETED"),
  createdBy: int("createdBy").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  invoiceIdx: index("idx_receipt_invoice").on(table.invoiceId),
  dateIdx: index("idx_receipt_date").on(table.createdAt),
  methodIdx: index("idx_receipt_method").on(table.paymentMethod),
}));

export type Receipt = typeof receipts.$inferSelect;
export type InsertReceipt = typeof receipts.$inferInsert;

/**
 * ====================================
 * جداول الحسابات والمالية
 * ====================================
 */

export const accountingEntries = mysqlTable("accountingEntries", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  invoiceId: bigint("invoiceId", { mode: "number" }).references(() => invoices.id),
  revenue: decimal("revenue", { precision: 15, scale: 2 }).default("0"),
  cost: decimal("cost", { precision: 15, scale: 2 }).default("0"),
  profit: decimal("profit", { precision: 15, scale: 2 }).default("0"),
  taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }).default("0"),
  entryDate: date("entryDate").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  invoiceIdx: index("idx_accounting_invoice").on(table.invoiceId),
  dateIdx: index("idx_accounting_date").on(table.entryDate),
}));

export type AccountingEntry = typeof accountingEntries.$inferSelect;
export type InsertAccountingEntry = typeof accountingEntries.$inferInsert;

/**
 * ====================================
 * جداول الموارد البشرية
 * ====================================
 */

export const employees = mysqlTable("employees", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  userId: int("userId").references(() => users.id),
  firstName: varchar("firstName", { length: 100 }).notNull(),
  lastName: varchar("lastName", { length: 100 }).notNull(),
  email: varchar("email", { length: 100 }).notNull().unique(),
  phone: varchar("phone", { length: 20 }),
  position: varchar("position", { length: 100 }),
  department: varchar("department", { length: 100 }),
  salary: decimal("salary", { precision: 15, scale: 2 }),
  hireDate: date("hireDate"),
  isActive: boolean("isActive").default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  emailIdx: index("idx_employee_email").on(table.email),
  activeIdx: index("idx_employee_active").on(table.isActive),
}));

export type Employee = typeof employees.$inferSelect;
export type InsertEmployee = typeof employees.$inferInsert;

export const attendance = mysqlTable("attendance", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  employeeId: bigint("employeeId", { mode: "number" }).notNull().references(() => employees.id),
  attendanceDate: date("attendanceDate").notNull(),
  checkIn: timestamp("checkIn"),
  checkOut: timestamp("checkOut"),
  status: mysqlEnum("attendanceStatus", ["PRESENT", "ABSENT", "LATE", "LEAVE"]).notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  employeeIdx: index("idx_attendance_employee").on(table.employeeId),
  dateIdx: index("idx_attendance_date").on(table.attendanceDate),
}));

export type Attendance = typeof attendance.$inferSelect;
export type InsertAttendance = typeof attendance.$inferInsert;

/**
 * ====================================
 * جداول الطلبات والمشتريات
 * ====================================
 */

export const purchaseOrders = mysqlTable("purchaseOrders", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  poNumber: varchar("poNumber", { length: 50 }).notNull().unique(),
  supplierId: bigint("supplierId", { mode: "number" }).notNull().references(() => suppliers.id),
  orderDate: timestamp("orderDate").defaultNow().notNull(),
  expectedDeliveryDate: date("expectedDeliveryDate"),
  subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
  taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }).notNull(),
  total: decimal("total", { precision: 15, scale: 2 }).notNull(),
  status: mysqlEnum("poStatus", ["DRAFT", "SENT", "CONFIRMED", "RECEIVED", "CANCELLED"]).default("DRAFT"),
  createdBy: int("createdBy").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  poNumberIdx: index("idx_po_number").on(table.poNumber),
  supplierIdx: index("idx_po_supplier").on(table.supplierId),
  statusIdx: index("idx_po_status").on(table.status),
}));

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type InsertPurchaseOrder = typeof purchaseOrders.$inferInsert;

export const purchaseOrderItems = mysqlTable("purchaseOrderItems", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  purchaseOrderId: bigint("purchaseOrderId", { mode: "number" }).notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  productId: bigint("productId", { mode: "number" }).notNull().references(() => products.id),
  quantity: int("quantity").notNull(),
  unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
  total: decimal("total", { precision: 15, scale: 2 }).notNull(),
  receivedQuantity: int("receivedQuantity").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  poIdx: index("idx_poi_po").on(table.purchaseOrderId),
  productIdx: index("idx_poi_product").on(table.productId),
}));

export type PurchaseOrderItem = typeof purchaseOrderItems.$inferSelect;
export type InsertPurchaseOrderItem = typeof purchaseOrderItems.$inferInsert;

/**
 * ====================================
 * جداول الطلبات الإلكترونية
 * ====================================
 */

export const onlineOrders = mysqlTable("onlineOrders", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  orderNumber: varchar("orderNumber", { length: 50 }).notNull().unique(),
  customerId: bigint("customerId", { mode: "number" }).notNull().references(() => customers.id),
  orderDate: timestamp("orderDate").defaultNow().notNull(),
  subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
  shippingCost: decimal("shippingCost", { precision: 15, scale: 2 }).default("0"),
  taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }).notNull(),
  total: decimal("total", { precision: 15, scale: 2 }).notNull(),
  status: mysqlEnum("orderStatus", ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"]).default("PENDING"),
  shippingAddress: text("shippingAddress"),
  trackingNumber: varchar("trackingNumber", { length: 100 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  orderNumberIdx: index("idx_order_number").on(table.orderNumber),
  customerIdx: index("idx_order_customer").on(table.customerId),
  statusIdx: index("idx_order_status").on(table.status),
  dateIdx: index("idx_order_date").on(table.orderDate),
}));

export type OnlineOrder = typeof onlineOrders.$inferSelect;
export type InsertOnlineOrder = typeof onlineOrders.$inferInsert;

export const onlineOrderItems = mysqlTable("onlineOrderItems", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  onlineOrderId: bigint("onlineOrderId", { mode: "number" }).notNull().references(() => onlineOrders.id, { onDelete: "cascade" }),
  productId: bigint("productId", { mode: "number" }).notNull().references(() => products.id),
  quantity: int("quantity").notNull(),
  unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
  total: decimal("total", { precision: 15, scale: 2 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  orderIdx: index("idx_oo_order").on(table.onlineOrderId),
  productIdx: index("idx_oo_product").on(table.productId),
}));

export type OnlineOrderItem = typeof onlineOrderItems.$inferSelect;
export type InsertOnlineOrderItem = typeof onlineOrderItems.$inferInsert;

/**
 * ====================================
 * جداول الاستيراد والتصدير
 * ====================================
 */

export const importBatches = mysqlTable("importBatches", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  batchName: varchar("batchName", { length: 255 }).notNull(),
  importType: mysqlEnum("importType", ["PRODUCTS", "CUSTOMERS", "SUPPLIERS"]).notNull(),
  fileName: varchar("fileName", { length: 255 }),
  totalRows: int("totalRows"),
  successfulRows: int("successfulRows").default(0),
  failedRows: int("failedRows").default(0),
  status: mysqlEnum("batchStatus", ["PENDING", "PROCESSING", "COMPLETED", "FAILED"]).default("PENDING"),
  errorLog: json("errorLog"),
  createdBy: int("createdBy").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
}, (table) => ({
  typeIdx: index("idx_import_type").on(table.importType),
  statusIdx: index("idx_import_status").on(table.status),
}));

export type ImportBatch = typeof importBatches.$inferSelect;
export type InsertImportBatch = typeof importBatches.$inferInsert;

/**
 * ====================================
 * جداول الطباعة
 * ====================================
 */

export const printJobs = mysqlTable("printJobs", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  invoiceId: bigint("invoiceId", { mode: "number" }).notNull().references(() => invoices.id),
  status: mysqlEnum("printStatus", ["PENDING", "PRINTING", "PRINTED", "FAILED"]).default("PENDING"),
  attempts: int("attempts").default(0),
  maxAttempts: int("maxAttempts").default(3),
  errorMessage: text("errorMessage"),
  printedAt: timestamp("printedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  invoiceIdx: index("idx_print_invoice").on(table.invoiceId),
  statusIdx: index("idx_print_status").on(table.status),
}));

export type PrintJob = typeof printJobs.$inferSelect;
export type InsertPrintJob = typeof printJobs.$inferInsert;

/**
 * ====================================
 * جداول السجلات والتدقيق
 * ====================================
 */

export const auditLogs = mysqlTable("auditLogs", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  userId: int("userId").references(() => users.id),
  action: varchar("action", { length: 100 }).notNull(),
  entityType: varchar("entityType", { length: 50 }).notNull(),
  entityId: varchar("entityId", { length: 50 }),
  oldValue: json("oldValue"),
  newValue: json("newValue"),
  ipAddress: varchar("ipAddress", { length: 45 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userIdx: index("idx_audit_user").on(table.userId),
  actionIdx: index("idx_audit_action").on(table.action),
  dateIdx: index("idx_audit_date").on(table.createdAt),
}));

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;
