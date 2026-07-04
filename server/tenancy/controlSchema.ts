import { bigint, boolean, int, json, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

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

/**
 * F4 (تدقيق ٢/٧) — سجلّ تدقيق مدير المنصّة: «من فعل ماذا، متى، على أي شركة، بأي نتيجة، من أين».
 * يعيش في قاعدة التحكّم (erp_control) لا في قاعدة أي شركة، لأن أفعاله عبر-الشركات (تعطيل شركة) والفاعل
 * مدير منصّة لا ينتمي لأي شركة (auditLogs مُخصَّص لكل شركة فلا يناسب). append-only يُكتب عبر
 * getControlDb() (لا getDb()). **تطابق يدويّ مزدوج:** أي تعديل عمود يُطبَّق هنا وفي
 * scripts/bootstrap-control-db.mjs معاً (لا مولّد يربطهما — وضع مخطّط التحكّم المقصود).
 */
export const platformAuditLogs = mysqlTable("platformAuditLogs", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  // معرّف المدير الفاعل — nullable: محاولة دخول فاشلة ببريدٍ غير مطابق لا معرّف لها.
  platformAdminId: bigint("platformAdminId", { mode: "number" }),
  // البريد كما وصل الطلب (خصوصاً للدخول الفاشل) — لقطة نصية لا FK.
  actorEmail: varchar("actorEmail", { length: 320 }),
  // "login" | "logout" | "company.setActive" | "company.requestCreate" (نطاق platform_admin ضمنيّ).
  action: varchar("action", { length: 64 }).notNull(),
  // نتيجة الفعل — يميّز محاولة الدخول الناجحة من الفاشلة في نفس الجدول.
  success: boolean("success").default(true).notNull(),
  // الشركة المتأثّرة (لأفعال companies.* فقط) — يشير لـcompanies.id بلا FK كي لا يمنع حذف شركة طمسَ أثرها.
  companyId: bigint("companyId", { mode: "number" }),
  // تفاصيل بنيوية إضافية (مثل { isActive:false } لـsetActive).
  details: json("details"),
  // IP إن توفّر (أول x-forwarded-for، وإلا req.ip) — قد يكون null.
  ipAddress: varchar("ipAddress", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PlatformAuditLog = typeof platformAuditLogs.$inferSelect;
export type InsertPlatformAuditLog = typeof platformAuditLogs.$inferInsert;

/**
 * طلبات توفير شركة جديدة عبر الويب — طابور بين شاشة `/platform-admin` (تكتب طلباً
 * فقط، صلاحيات محدودة) و`scripts/company-provision-worker.mjs` (عملية منفصلة تماماً
 * بصلاحيات مرتفعة: docker exec + كلمة سرّ MySQL الجذر + تشغيل عمليات فرعية) — راجع
 * تعليق أعلى platformAdminRouter.ts. **خادم الويب الحيّ لا ينفّذ التوفير الفعلي أبداً.**
 *
 * `tempPasswordEncrypted`: كلمة مرور مدير الشركة الحالية، تُولَّد عشوائياً وتُشفَّر فور
 * إنشاء الطلب (نفس مفتاح `INTEGRATIONS_ENCRYPTION_KEY`) وتُعرَض للمشغّل **مرّة واحدة** في
 * استجابة الطلب — العامل يفكّ تشفيرها عند التنفيذ ثم **يمسحها فوراً** (NULL) بعد النجاح.
 * إعادة محاولة بعد فشل = **طلب جديد** بكلمة مرور جديدة كلياً (لا إعادة استعمال الصفّ
 * الفاشل) — `server/seed.ts` (`ADMIN_MUST_CHANGE_PASSWORD`) يُزامن كلمة مرور المدير
 * الموجود فعلاً إلى القيمة الجديدة إن كانت المحاولة السابقة قد أنشأته جزئياً قبل الفشل
 * (مراجعة عدائية ٣/٧: بلا هذه المزامنة، كلمة المرور المعروضة للمشغّل بعد نجاح إعادة
 * المحاولة لا تطابق الفعلية أبداً — قفل مدير الشركة خارج حسابه).
 *
 * `activeCode`: عمود مولَّد STORED (bootstrap-control-db.mjs) = الرمز فقط أثناء
 * PENDING/PROCESSING، NULL غير ذلك — فهرس فريد عليه يمنع **بقيدٍ حقيقي في DB** (لا فحصٍ
 * تطبيقيّ قابل للسباق) وجود أكثر من طلبٍ نشطٍ واحد بنفس الرمز في آنٍ واحد (مراجعة عدائية
 * ٣/٧: كانت createProvisionRequest عرضة لسباق TOCTOU حقيقي أدّى لتوفير مزدوج قد يُفسد
 * كلمة مرور قاعدة شركة حيّة). لا تُدخِله عند الإدراج — القاعدة تحسبه تلقائياً.
 */
export const companyProvisionRequests = mysqlTable("companyProvisionRequests", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  code: varchar("code", { length: 40 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  adminEmail: varchar("adminEmail", { length: 320 }).notNull(),
  adminUsername: varchar("adminUsername", { length: 64 }).notNull(),
  demo: boolean("demo").default(false).notNull(),
  tempPasswordEncrypted: varchar("tempPasswordEncrypted", { length: 500 }),
  status: mysqlEnum("status", ["PENDING", "PROCESSING", "DONE", "FAILED"]).default("PENDING").notNull(),
  resultCompanyId: bigint("resultCompanyId", { mode: "number" }),
  errorMessage: text("errorMessage"),
  requestedByAdminId: bigint("requestedByAdminId", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  // مولَّد بالكامل من DB (راجع التعليق أعلاه) — لا يُكتَب من التطبيق أبداً.
  activeCode: varchar("activeCode", { length: 40 }),
});

export type CompanyProvisionRequest = typeof companyProvisionRequests.$inferSelect;
export type InsertCompanyProvisionRequest = typeof companyProvisionRequests.$inferInsert;
