import { bigint, boolean, int, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * مخطّط قاعدة التحكّم (erp_control) — سجلّ الشركات لتعدّد الشركات بعزل قاعدة فعلي.
 *
 * منفصل تماماً عن `drizzle/schema.ts` (مخطّط كل شركة) عمداً: هذا الجدول لا ينتمي لأي
 * شركة بعينها، بل هو الفهرس الذي يحدّد أي قاعدة بيانات تخصّ أي شركة. لا تُدرجه ضمن
 * drizzle-kit generate/push لمخطّط الشركات — هذا مخطّط مستقلّ يُطبَّق يدوياً عبر
 * `scripts/bootstrap-control-db.mjs` (جدول واحد صغير نادر التغيّر لا يحتاج آلة هجرات كاملة).
 *
 * `dbPasswordEncrypted` مشفّرة بـ`cryptoService.encryptSecret` (AES-256-GCM، نفس آلية
 * أسرار التكاملات) — لا كلمات مرور صريحة في هذه القاعدة.
 */
export const companies = mysqlTable("companies", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  // رمز الشركة (slug) — يُدخله المستخدم في شاشة الدخول لتحديد قاعدته قبل التحقّق من هويته.
  code: varchar("code", { length: 40 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  dbHost: varchar("dbHost", { length: 255 }).notNull(),
  dbPort: int("dbPort").notNull(),
  dbName: varchar("dbName", { length: 100 }).notNull(),
  dbUser: varchar("dbUser", { length: 100 }).notNull(),
  dbPasswordEncrypted: varchar("dbPasswordEncrypted", { length: 500 }).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Company = typeof companies.$inferSelect;
export type InsertCompany = typeof companies.$inferInsert;

/**
 * مدراء المنصّة — منفصلون تماماً عن `users` (أدوار أي شركة). حساب هنا لا ينتمي لأي
 * شركة، ولا يُنشأ من الواجهة (بوّابة بيضة-ودجاجة) بل عبر `scripts/platform-admin-new.mjs`
 * فقط. جلستهم كوكي/JWT منفصلان تماماً عن جلسة مستخدمي الشركات (راجع
 * `server/tenancy/platformAuth.ts`) — تسجيل الدخول كمدير منصّة لا يمنح أي وصول لبيانات
 * أي شركة، فقط لعرض/تفعيل/تعطيل سجلّاتها في قاعدة التحكّم.
 */
export const platformAdmins = mysqlTable("platformAdmins", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  passwordHash: varchar("passwordHash", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type PlatformAdmin = typeof platformAdmins.$inferSelect;
export type InsertPlatformAdmin = typeof platformAdmins.$inferInsert;
