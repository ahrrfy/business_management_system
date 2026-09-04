import {
  int,
  bigint,
  tinyint,
  char,
  decimal,
  varchar,
  text,
  mediumtext,
  timestamp,
  mysqlEnum,
  mysqlTable,
  boolean,
  date,
  datetime,
  json,
  index,
  unique,
  primaryKey,
  foreignKey,
  check,
  customType,
  type AnyMySqlColumn,
} from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import type { DigitalCheckoutSnapshot } from "../shared/digitalSale";

/** Raw binary storage for small, validated documents that must travel with DB backups. */
const mediumblob = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "mediumblob",
  fromDriver: (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value)),
});

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
    // الأدوار — إضافة قيم enum آمنة بلا فقد بيانات (MySQL INSTANT). courier (١٢/٧): مندوب توصيل
    // ذاتي الخدمة (شاشة «توصيلاتي») — هجرة 0068.
    role: mysqlEnum("role", [
      "user",
      "admin",
      "manager",
      "cashier",
      "warehouse",
      "accountant",
      "print_operator",
      "sales_rep",
      "purchasing",
      "auditor",
      "courier",
    ])
      .default("user")
      .notNull(),
    branchId: bigint("branchId", { mode: "number" }),
    isActive: boolean("isActive").default(true),
    /**
     * انتهاء صلاحية الحساب — للحسابات المؤقّتة (مصوّر حملةٍ بلا حساب دائم مثلاً).
     * `null` = حسابٌ دائم بلا انتهاء (كل الحسابات القائمة). يُفرَض **مركزياً في الجلسة**
     * لا في كل شاشة: حسابٌ منتهٍ يسقط من أوّل طلبٍ حتى لو كانت جلسته مفتوحة.
     */
    accessExpiresAt: timestamp("accessExpiresAt"),
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
    // زمن آخر إخفاق — يمنح العدّاد نافذة زمنية (١٥د): إخفاق أقدم من النافذة يبدأ عدّاً
    // جديداً بدل التراكم الأبدي (٤ أخطاء اليوم + خطأ بعد أسبوع كانت = قفل).
    lastFailedLoginAt: timestamp("lastFailedLoginAt"),
    // المصادقة الثنائية TOTP (RFC 6238) — السرّ base32 مشفَّر AES-256-GCM عبر cryptoService
    // (صيغة v1:iv:tag:ct). وجود سرّ مع totpEnabledAt=null ⇒ تسجيل معلّق لم يُؤكَّد برمز بعد
    // (لا يُفرض عند الدخول). totpLastUsedStep = آخر خطوة زمنية قُبل رمزها (منع replay ±1).
    isOwner: boolean("isOwner").default(false).notNull(),
    totpSecretEncrypted: varchar("totpSecretEncrypted", { length: 255 }),
    totpEnabledAt: timestamp("totpEnabledAt"),
    totpLastUsedStep: bigint("totpLastUsedStep", { mode: "number" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
  },
  (table) => ({
    // البريد فريد (UNIQUE) ⇒ يُغني عن idx_user_email ويمنع سباق register المكرّر.
    roleIdx: index("idx_user_role").on(table.role),
  }),
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
export const roles = mysqlTable("roles", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  key: varchar("key", { length: 64 }).notNull().unique(),
  label: varchar("label", { length: 120 }).notNull(),
  description: text("description"),
  // الفئة الأساسية للبوّابات الخشنة — قيم enum الأدوار نفسها (يجب مطابقة users.role).
  baseRole: mysqlEnum("baseRole", [
    "user",
    "admin",
    "manager",
    "cashier",
    "warehouse",
    "accountant",
    "print_operator",
    "sales_rep",
    "purchasing",
    "auditor",
    "courier",
  ])
    .default("user")
    .notNull(),
  // خريطة الصلاحيات الكاملة {moduleKey: FULL|READ|NONE}.
  permissions: json("permissions").notNull(),
  canSeeCost: boolean("canSeeCost").default(false).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  // RBAC ش٣: الأدوار القياسية المبذورة محميّة من الحذف/تغيير الفئة (قابلة للتحرير المُدقَّق).
  isSystem: boolean("isSystem").default(false).notNull(),
  // تلميح عرض لقسم POS (RETAIL/PRINT_SERVICES/RECEPTION) — الحقيقة مشتقّة من الخريطة (deriveStation).
  station: varchar("station", { length: 20 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Role = typeof roles.$inferSelect;
export type InsertRole = typeof roles.$inferInsert;

/**
 * RBAC ش٦ — فروع الدور الصريحة (نطاق متعدّد القيم). **أساسٌ خاملٌ مؤجَّل التفعيل**: غير موصولٍ بأي
 * مخنق إنفاذ بعد ⇒ جدولٌ فارغ = صفر أثر (كل الأدوار بسلوكها الحاليّ). التفعيل حملةٌ واعية تحوّل مخانق
 * العزل الـ٧٣ إلى فحص عضوية `IN(allowedBranchIds)` — قرار المالك.
 */
export const roleBranches = mysqlTable(
  "roleBranches",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    roleId: bigint("roleId", { mode: "number" })
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ uqRoleBranch: unique("uq_role_branch").on(t.roleId, t.branchId) }),
);
export type RoleBranch = typeof roleBranches.$inferSelect;

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
    userId: int("userId")
      .notNull()
      .references(() => users.id),
    userAgent: varchar("userAgent", { length: 255 }),
    ipAddress: varchar("ipAddress", { length: 45 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    revokedAt: timestamp("revokedAt"),
  },
  (table) => ({
    userIdx: index("idx_user_sessions_user").on(table.userId),
    activeIdx: index("idx_user_sessions_active").on(
      table.userId,
      table.revokedAt,
      table.expiresAt,
    ),
    // مسحٌ زمنيّ عامّ (غير مقيَّد بمستخدم) يستعمله جسر أجهزة الحضور كل ٣٠ث لاشتقاق عناوين
    // «شبكات العمل» الحيّة؛ الفهارس الأخرى تبدأ بـuserId فلا تخدمه (0171).
    lastSeenIdx: index("idx_user_sessions_last_seen").on(table.lastSeenAt),
  }),
);

export type UserSession = typeof userSessions.$inferSelect;
export type InsertUserSession = typeof userSessions.$inferInsert;

/**
 * رموز إعادة تعيين كلمة المرور التي يصدرها الأدمن للمستخدم. لا يُخزَّن الرمز الخام مطلقاً:
 * `lookupId` معرّف بحث عشوائي غير سري، و`tokenHash` هو SHA-256 للرمز الكامل. يتيح معرّف
 * البحث العثور على الصف وعدّ المحاولات الخاطئة دون البحث بالبريد أو تخزين أي جزء سري.
 */
export const passwordResetTokens = mysqlTable(
  "passwordResetTokens",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lookupId: char("lookupId", { length: 16 }).notNull().unique(),
    tokenHash: char("tokenHash", { length: 64 }).notNull().unique(),
    failedAttempts: int("failedAttempts").default(0).notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    invalidatedAt: timestamp("invalidatedAt"),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userActiveIdx: index("idx_password_reset_user_active").on(
      table.userId,
      table.consumedAt,
      table.invalidatedAt,
      table.expiresAt,
    ),
  }),
);

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;

/**
 * رموز استرداد المصادقة الثنائية — ١٠ رموز أحادية الاستخدام تُعرَض للمستخدم مرّة واحدة
 * عند تفعيل 2FA، وتُخزَّن مُجزّأة scrypt (نفس صيغة server/auth/password.ts). بديل فقدان
 * الهاتف بلا OTP/SMS مكلف: رمزٌ واحد يدخل به المستخدم ثم يُعلَّم usedAt (لا يُعاد استخدامه).
 */
export const userRecoveryCodes = mysqlTable(
  "userRecoveryCodes",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id),
    codeHash: varchar("codeHash", { length: 255 }).notNull(),
    usedAt: timestamp("usedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("idx_recovery_codes_user").on(table.userId),
  }),
);

export type UserRecoveryCode = typeof userRecoveryCodes.$inferSelect;

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
  }),
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
    customerType: mysqlEnum("customerType", [
      "فرد",
      "تاجر",
      "مؤسسة",
      "شركة",
      "حكومي",
    ]).default("فرد"),
    defaultPriceTier: mysqlEnum("defaultPriceTier", [
      "RETAIL",
      "WHOLESALE",
      "GOVERNMENT",
    ])
      .default("RETAIL")
      .notNull(),
    notes: text("notes"),
    creditLimit: decimal("creditLimit", { precision: 15, scale: 2 }),
    currentBalance: decimal("currentBalance", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // import-integration: المعرّف القديم («الرقم» في ملفات النظام السابق) — مفتاح مطابقة الاستيراد.
    // UNIQUE يسمح بتعدّد NULL ⇒ حارس بنيوي ضدّ ازدواج الطرف برصيد عند استيراد متزامن.
    legacyCode: varchar("legacyCode", { length: 40 }),
    // dup-detect (٦/٧): مفتاح idempotency للإنشاء — UUID من نموذج الإضافة، UNIQUE يمنع صفاً
    // ثانياً عند إعادة الإرسال (نقر مزدوج/إعادة محاولة شبكة). NULL متعدّد للمسارات القديمة. هجرة 0051.
    clientRequestId: varchar("clientRequestId", { length: 64 }),
    isActive: boolean("isActive").default(true),
    // بنك جهات الاتصال (S3، هجرة 0108): موافقة/رفض تسويق واتساب — UNKNOWN افتراضياً حتى تصريح
    // العميل، أو التقاط كلمة إلغاء اشتراك تلقائي من الوارد (waConsentSource='AUTO_KEYWORD')،
    // أو تسجيل يدوي من الموظف لاحقاً.
    waConsent: mysqlEnum("waConsent", ["UNKNOWN", "OPTED_IN", "OPTED_OUT"])
      .default("UNKNOWN")
      .notNull(),
    waConsentAt: timestamp("waConsentAt"),
    waConsentSource: varchar("waConsentSource", { length: 40 }),
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
    clientRequestUq: unique("uq_customer_client_request").on(
      table.clientRequestId,
    ),
    // gap-audit low (٥/٧): فهرس يدعم مسار aging المجمَّع بلا فرع (WHERE isActive=TRUE). هجرة 0053.
    activeIdx: index("idx_customer_active").on(table.isActive),
  }),
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
    customerId: bigint("customerId", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    note: text("note").notNull(),
    followUpDate: date("followUpDate", { mode: "string" }),
    isResolved: boolean("isResolved").default(false).notNull(),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    customerIdx: index("idx_customer_notes_customer").on(table.customerId),
    followUpIdx: index("idx_customer_notes_followup").on(
      table.followUpDate,
      table.isResolved,
    ),
  }),
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
    currentBalance: decimal("currentBalance", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // ذمم الشراء الدولارية: الرصيد الأصلي المستحق بالدولار. يبقى currentBalance هو القيمة
    // الدفترية بالدينار، بينما هذا الحقل يُطفأ بمبلغ الدولار الذي وصل فعلياً إلى المورد.
    currentBalanceUsd: decimal("currentBalanceUsd", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // import-integration: المعرّف القديم («الرقم» في ملفات النظام السابق) — مفتاح مطابقة الاستيراد.
    // UNIQUE يسمح بتعدّد NULL ⇒ حارس بنيوي ضدّ ازدواج الطرف برصيد عند استيراد متزامن.
    legacyCode: varchar("legacyCode", { length: 40 }),
    // مفتاح idempotency للإنشاء — UUID من نموذج الإضافة، UNIQUE يمنع صفاً ثانياً عند إعادة
    // الإرسال (نقر مزدوج/إعادة محاولة شبكة). NULL متعدّد للمسارات القديمة. هجرة 0090 (نظير 0051).
    clientRequestId: varchar("clientRequestId", { length: 64 }),
    // بضاعة الأمانة (٢٠/٧، هجرة 0091): نوع الطرف. CONSIGNOR = مودِع أمانة — لا دين عند الاستلام،
    // المستحق ينشأ لحظة البيع فقط. يرث كل بنى المورّد (كشف/سندات/واتساب/كاشف ازدواج/رصيد افتتاحي)
    // بصفر تعديل — دلالة currentBalance تبقى AP (موجب = علينا له). راجع docs/consignment-design-2026-07-20.md.
    supplierKind: mysqlEnum("supplierKind", ["REGULAR", "CONSIGNOR"])
      .default("REGULAR")
      .notNull(),
    // حقول اتفاقية المودِع (تظهر لنوع CONSIGNOR فقط): دورية التسوية + مدة البضاعة المتروكة/تجميد الغائب
    // (افتراضي ١٢ شهراً بقرار المالك) + عتبة تسوية فورية اختيارية + ملاحظات + صورة الاتفاقية الموقَّعة.
    settlementCycle: varchar("settlementCycle", { length: 20 }).default(
      "MONTHLY",
    ),
    abandonedAfterMonths: int("abandonedAfterMonths").default(12),
    autoSettleThreshold: decimal("autoSettleThreshold", {
      precision: 15,
      scale: 2,
    }),
    agreementNotes: text("agreementNotes"),
    agreementAttachmentUrl: mediumtext("agreementAttachmentUrl"),
    isActive: boolean("isActive").default(true),
    // بنك جهات الاتصال (S3، هجرة 0108): نظير customers.waConsent — موافقة/رفض تسويق واتساب
    // للمورّد (محادثات B2B).
    waConsent: mysqlEnum("waConsent", ["UNKNOWN", "OPTED_IN", "OPTED_OUT"])
      .default("UNKNOWN")
      .notNull(),
    waConsentAt: timestamp("waConsentAt"),
    waConsentSource: varchar("waConsentSource", { length: 40 }),
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
    clientRequestUq: unique("uq_supplier_client_request").on(
      table.clientRequestId,
    ),
    // فلتر شاشة الموردين «مودِعو أمانة» + استعلامات الوحدة.
    kindIdx: index("idx_supplier_kind").on(table.supplierKind, table.isActive),
  }),
);

export type Supplier = typeof suppliers.$inferSelect;
export type InsertSupplier = typeof suppliers.$inferInsert;

/* ============================ بضاعة الأمانة: السندات (ش٢، هجرة 0092) ============================ */

/** سند حركة أمانة (إيداع/سحب/استبدال) — نهائيّ فور ترحيله (بلا status ولا حذف؛ التصحيح بسند معاكس).
 *  راجع docs/consignment-design-2026-07-20.md §٧. (productVariants مُعرَّف أدناه — مرجع كسول.) */
export const consignmentNotes = mysqlTable(
  "consignmentNotes",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // CSN-{branchId}-{YYYYMMDD}-{seq5} بنمط nextInvoiceNumber (GET_LOCK) + قيد فريد.
    noteNumber: varchar("noteNumber", { length: 32 }).notNull(),
    noteType: mysqlEnum("noteType", [
      "DEPOSIT",
      "WITHDRAW",
      "EXCHANGE",
    ]).notNull(),
    consignorId: bigint("consignorId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    // idempotency (نمط 0090/0051): UUID لكل فتح نموذج ⇒ إعادة الإرسال تعيد السند نفسه.
    clientRequestId: varchar("clientRequestId", { length: 64 }),
    notes: text("notes"),
    // مرفق صورة السند الموقَّع (إلزاميّ خادمياً للسحب/الاستبدال) — نمط receipts.attachmentUrl (0047).
    attachmentUrl: mediumtext("attachmentUrl"),
    createdBy: bigint("createdBy", { mode: "number" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    numberUq: unique("uq_consign_note_number").on(t.noteNumber),
    requestUq: unique("uq_consign_note_request").on(t.clientRequestId),
    consignorIdx: index("idx_cn_consignor").on(t.consignorId, t.createdAt),
    branchIdx: index("idx_cn_branch").on(t.branchId, t.createdAt),
  }),
);
export type ConsignmentNote = typeof consignmentNotes.$inferSelect;

/** أسطر سند الأمانة — lineDirection يميّز الاتجاه (الاستبدال: أسطر OUT مسحوبة + أسطر IN مودَعة). */
export const consignmentNoteLines = mysqlTable(
  "consignmentNoteLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    noteId: bigint("noteId", { mode: "number" })
      .notNull()
      .references(() => consignmentNotes.id, { onDelete: "cascade" }),
    lineDirection: mysqlEnum("lineDirection", ["IN", "OUT"]).notNull(),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).notNull(),
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    // لقطة حصة الوحدة الأساس لحظة السند — توثيقيّة للطباعة فقط (الالتزام الفعلي يُلتقَط لحظة البيع في ش٣).
    unitShareSnapshot: decimal("unitShareSnapshot", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    notes: text("notes"),
  },
  (t) => ({
    noteIdx: index("idx_cnl_note").on(t.noteId),
    variantIdx: index("idx_cnl_variant").on(t.variantId),
  }),
);
export type ConsignmentNoteLine = typeof consignmentNoteLines.$inferSelect;

/* ============================ المنتجات والمتغيرات والوحدات والأسعار ============================ */

export const categories = mysqlTable(
  "categories",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 255 }).notNull().unique(),
    description: text("description"),
    isActive: boolean("isActive").default(true),
    // لوحة hPanel للمتجر (١٢/٧، هجرة 0071): ترتيب عرض القسم في المتجر + إظهار/إخفاؤه من واجهة الزبون.
    sortOrder: int("sortOrder").default(0).notNull(),
    showInStore: boolean("showInStore").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    // أقسام فرعية (٢٩/٧، هجرة 0122): مرجع ذاتي بلا قيد FK (نمط accounts.parentId — تفادي علّة
    // اسم قيد FK الذاتي التلقائي >٦٤ محرفاً على MySQL 8.4، راجع ذاكرة db-push-broken-mysql84).
    // عمق مقيَّد بمستويين فقط (فئة رئيسية ← فئة فرعية) — يُفرض خدمياً في categoryService، لا هنا.
    parentId: bigint("parentId", { mode: "number" }),
  },
  (table) => ({
    parentIdx: index("idx_category_parent").on(table.parentId),
  }),
);

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
    // product-content-governance (0250): محتوى دائم منفصل لكل قناة. تبقى الحقول القديمة للتوافق.
    internalName: varchar("internalName", { length: 255 }),
    storeTitle: varchar("storeTitle", { length: 255 }),
    seoTitle: varchar("seoTitle", { length: 255 }),
    shortTitle: varchar("shortTitle", { length: 160 }),
    posLabel: varchar("posLabel", { length: 120 }),
    invoiceLabel: varchar("invoiceLabel", { length: 255 }),
    marketingCopy: text("marketingCopy"),
    categoryId: bigint("categoryId", { mode: "number" }).references(
      () => categories.id,
    ),
    // النَّسَب: لدعم دمج المنتجات بحفظ التاريخ (أب/ابن) — مرحلة لاحقة.
    parentProductId: bigint("parentProductId", { mode: "number" }),
    isCustomizable: boolean("isCustomizable").default(false),
    // مُنتج خدمي: لا يَتتبَّع مَخزوناً (تَصميم، طِباعة بَسيطة، رُسوم). البَيع لا يُحرّك
    // branchStock ولا يَكتب inventoryMovements (يُتجاوَز في inventoryService.applyMovement).
    // التَحويل بين الفُروع مَمنوع. الإيراد يَدخل كَالعَادة، التَكلفة من productVariants.cost.
    isService: boolean("isService").default(false).notNull(),
    // «يُباع بالطلب» (هجرة 0318، ٣١/٨/٢٦) — بيعٌ قبل التوريد لصنفٍ **مخزنيّ** يُغذَّى لاحقاً.
    // الحالة الحاكمة (بلاغ المالك): عملُ طباعةٍ نبيعه للزبون ثمّ نُوفّره — إمّا **شراءً جاهزاً
    // من مطبعة أخرى** (فاتورة شراء ترفع الرصيد وتسجّل المورّد وذمّته والتكلفة بـWAVG)، أو
    // **إنتاجاً داخلياً** بوصفة الصنف. الطريقان قائمان ويعملان؛ الناقص وحده كان السماح بالبيع
    // **قبل** التغذية — فيظهر «نافذ» ويُرفض، والفاتورة لا تُنشأ.
    //
    // فالرصيد السالب هنا **ليس عطباً بل عدّاد التزام**: عدد الأعمال المُباعة ولم تُورَّد بعد،
    // ويعود صفراً حتماً بأوّل شراءٍ أو إنتاجٍ يُغطّيها. ولذلك يُعفى هذا الصنف من حارس النفاد
    // إعفاءً **دائماً** — لا بنافذة «وضع الافتتاح» ولا بشرط `openedAt IS NULL` (كلاهما ينكسر
    // بعد أوّل استلامٍ يَسِم الصنف مُفتتَحاً، فتعود الشاشة تقول «نافذ» في الدورة الثانية).
    //
    // ⛔ ثلاثة استثناءات بنيويّة (CHECK أدناه): الخدمة (بلا رصيد أصلاً ⇒ لا معنى للسالب) ·
    // البكج (رصيده رصيد مكوّناته) · الأمانة (سالبُها يُلفّق التزاماً لمودِعٍ لم يُودِع — §٥-ج).
    allowBackorder: boolean("allowBackorder").default(false).notNull(),
    // توجيه الخدمة لنقطة خدمة العملاء (الاستقبال): خدمة طباعة (productType=PRINT_SERVICE) مفعَّلة هنا
    // تَظهر أيضاً في كاشير الاستقبال وتُباع عبر مسار createPrintSale المدقَّق (خصم المواد + COGS).
    showInReception: boolean("showInReception").default(false).notNull(),
    // 0262 (٢٤/٨): تعيينٌ صريحٌ للظهور في شبكة «خدمات الطباعة» — مرآةً لـshowInReception.
    // قبله كان listPrintServices يُصفّي بـ`productType='PRINT_SERVICE'` STRICT ⇒ كلّ خدمةٍ
    // مُنشأةٍ بلا هذا النوع (قبل توفّر التبديل، أو مُستوردة، أو عبر مسارٍ آخر) تختفي من
    // الشبكة رغم كونها `isService=true`. الآن الظهور قرارٌ مستقلّ يديره المدير للمنتج.
    showInPrintPos: boolean("showInPrintPos").default(false).notNull(),
    // bundles (٧/٧/٢٦): منتج مركّب (باندل/بكج) — بلا رصيد مخزنيّ خاص به؛ سعره مستقلّ يضعه المدير،
    // وتكلفته تُحسب لحظة البيع من مجموع تكاليف مكوّناته (WAVG الحيّ)، والمخزون يُخصَم من كل مكوّن.
    // النَسْت مَمنوع (مكوّن البكج لا يكون بكجاً) — يُفرض خادمياً في bundleService.
    isBundle: boolean("isBundle").default(false).notNull(),
    // بضاعة الأمانة (٢٠/٧، هجرة 0091): وسم المنتج + مودِعه. الحصة تسكن productVariants.costPrice
    // (قرار المالك) ⇒ الربح=الهامش وحجب canSeeCost مجاناً. الالتزام للمودِع ينشأ لحظة البيع فقط.
    // تلازم إلزاميّ: isConsignment=true ⇔ consignorId != NULL (suppliers.supplierKind='CONSIGNOR').
    isConsignment: boolean("isConsignment").default(false).notNull(),
    consignorId: bigint("consignorId", { mode: "number" }).references(
      () => suppliers.id,
    ),
    isActive: boolean("isActive").default(true),
    // لوحة hPanel للمتجر (١٢/٧، هجرة 0072): تمييز المنتج (يتصدّر) + إظهاره/إخفاؤه من واجهة المتجر.
    isFeatured: boolean("isFeatured").default(false).notNull(),
    showInStore: boolean("showInStore").default(true).notNull(),
    // توصيات السلة الهجينة: العلاقات اليدوية تبقى مستقلة، وهذا المفتاح يسمح بملء الفراغ من نفس التصنيف.
    allowAutoCartRecommendations: boolean("allowAutoCartRecommendations")
      .default(true)
      .notNull(),
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
    internalNameIdx: index("idx_product_internal_name").on(table.internalName),
    storeTitleIdx: index("idx_product_store_title").on(table.storeTitle),
    categoryIdx: index("idx_product_category").on(table.categoryId),
    parentIdx: index("idx_product_parent").on(table.parentProductId),
    // bundles: كشف سريع للمنتجات المركّبة (لوحة إدارة البكج، فلترة POS).
    bundleIdx: index("idx_product_is_bundle").on(table.isBundle),
    // بضاعة الأمانة: كشف أصناف مودِع بعينه (سند الإيداع، التقارير، حارس التعطيل).
    consignorIdx: index("idx_product_consignor").on(table.consignorId),
    // شاشة «المطلوب توريده» تصفّي بها قبل ضمّ الرصيد السالب.
    backorderIdx: index("idx_product_allow_backorder").on(table.allowBackorder),
    // الاستثناءات بنيويّةً لا بالنيّة: الوسم بلا معنى على خدمة/بكج (لا رصيد ذاتيّ لهما)،
    // وخطِرٌ على الأمانة (بيعُ ما لم يُودَع يُنشئ التزاماً كاذباً للمودِع).
    backorderStockedOnlyCheck: check(
      "chk_product_backorder_stocked_only",
      sql`(${table.allowBackorder} = 0 OR (${table.isService} = 0 AND ${table.isBundle} = 0 AND ${table.isConsignment} = 0))`,
    ),
  }),
);

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

export type ProductChannelContent = {
  internalName?: string | null;
  storeTitle?: string | null;
  seoTitle?: string | null;
  shortTitle?: string | null;
  posLabel?: string | null;
  invoiceLabel?: string | null;
  marketingCopy?: string | null;
  description?: string | null;
};

export type ProductContentValidationSnapshot = {
  ok: boolean;
  blockers: string[];
  warnings: string[];
};

/** مسودة AI غير منشورة؛ مصدرها حقائق مجمّدة وبصمة تمنع اعتماد اقتراح قديم. */
export const productContentDrafts = mysqlTable(
  "productContentDrafts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productId: bigint("productId", { mode: "number" }).references(
      () => products.id,
      { onDelete: "set null" },
    ),
    sourceFacts: json("sourceFacts").$type<Record<string, unknown>>().notNull(),
    sourceFactsHash: varchar("sourceFactsHash", { length: 64 }).notNull(),
    content: json("content").$type<ProductChannelContent>().notNull(),
    validation: json("validation")
      .$type<ProductContentValidationSnapshot>()
      .notNull(),
    status: mysqlEnum("status", [
      "DRAFT",
      "APPROVED",
      "REJECTED",
      "APPLIED",
      "SUPERSEDED",
    ])
      .default("DRAFT")
      .notNull(),
    promptVersion: varchar("promptVersion", { length: 40 }).notNull(),
    model: varchar("model", { length: 120 }).notNull(),
    createdBy: int("createdBy").references(() => users.id),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    appliedAt: timestamp("appliedAt"),
    decisionNote: text("decisionNote"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    productStatusIdx: index("idx_pcd_product_status").on(
      table.productId,
      table.status,
      table.createdAt,
    ),
    factsHashIdx: index("idx_pcd_facts_hash").on(table.sourceFactsHash),
    createdByIdx: index("idx_pcd_created_by").on(
      table.createdBy,
      table.createdAt,
    ),
  }),
);

export type ProductContentDraft = typeof productContentDrafts.$inferSelect;
export type InsertProductContentDraft =
  typeof productContentDrafts.$inferInsert;

/** سجل append-only لقرارات اعتماد محتوى المنتج، بالإضافة إلى auditLogs العام. */
export const productContentApprovalEvents = mysqlTable(
  "productContentApprovalEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    draftId: bigint("draftId", { mode: "number" }).references(
      () => productContentDrafts.id,
      { onDelete: "set null" },
    ),
    productId: bigint("productId", { mode: "number" }).references(
      () => products.id,
      { onDelete: "set null" },
    ),
    action: mysqlEnum("action", [
      "SUBMITTED",
      "APPROVED",
      "REJECTED",
      "APPLIED",
      "SUPERSEDED",
    ]).notNull(),
    actorUserId: int("actorUserId").references(() => users.id),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
      { onDelete: "set null" },
    ),
    sourceFactsHash: varchar("sourceFactsHash", { length: 64 }),
    beforeContent: json("beforeContent").$type<ProductChannelContent | null>(),
    afterContent: json("afterContent").$type<ProductChannelContent | null>(),
    note: text("note"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    draftIdx: index("idx_pcae_draft").on(table.draftId, table.createdAt),
    productIdx: index("idx_pcae_product").on(table.productId, table.createdAt),
    actorIdx: index("idx_pcae_actor").on(table.actorUserId, table.createdAt),
    branchIdx: index("idx_pcae_branch").on(table.branchId, table.createdAt),
  }),
);

export type ProductContentApprovalEvent =
  typeof productContentApprovalEvents.$inferSelect;
export type InsertProductContentApprovalEvent =
  typeof productContentApprovalEvents.$inferInsert;

export type ProductCustomizationOption = {
  value: string;
  label: string;
  priceDelta?: string;
};

export type ProductCustomizationDependency = {
  fieldKey: string;
  operator: "equals" | "notEquals";
  value: string | string[];
};

/** قالب تخصيص واحد اختياري لكل منتج — يحدد نوع النموذج وعنوانه وحالته. */
export const productCustomizationTemplates = mysqlTable(
  "productCustomizationTemplates",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productId: bigint("productId", { mode: "number" }).notNull(),
    kind: mysqlEnum("kind", ["PRINT", "GIFT", "GENERAL"])
      .default("GENERAL")
      .notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    description: text("description"),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    productIdx: index("idx_custom_template_product").on(table.productId),
    productUnique: unique("uq_custom_template_product").on(table.productId),
    productFk: foreignKey({
      columns: [table.productId],
      foreignColumns: [products.id],
      name: "fk_custom_template_product",
    }).onDelete("cascade"),
  }),
);

export type ProductCustomizationTemplate =
  typeof productCustomizationTemplates.$inferSelect;
export type InsertProductCustomizationTemplate =
  typeof productCustomizationTemplates.$inferInsert;

/** حقول قالب التخصيص — الخيارات والتبعيات تُخزّن كـJSON صغير مُتحقق منه خادمياً. */
export const productCustomizationFields = mysqlTable(
  "productCustomizationFields",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    templateId: bigint("templateId", { mode: "number" }).notNull(),
    fieldKey: varchar("fieldKey", { length: 80 }).notNull(),
    label: varchar("label", { length: 160 }).notNull(),
    fieldType: mysqlEnum("fieldType", [
      "TEXT",
      "TEXTAREA",
      "SELECT",
      "FILE",
      "NUMBER",
      "SWATCH",
    ]).notNull(),
    isRequired: boolean("isRequired").default(false).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    maxLength: int("maxLength"),
    optionsJson: json("optionsJson").$type<ProductCustomizationOption[]>(),
    dependencyJson: json(
      "dependencyJson",
    ).$type<ProductCustomizationDependency | null>(),
    priceDelta: decimal("priceDelta", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    templateIdx: index("idx_custom_field_template_sort").on(
      table.templateId,
      table.sortOrder,
    ),
    keyUnique: unique("uq_custom_field_template_key").on(
      table.templateId,
      table.fieldKey,
    ),
    templateFk: foreignKey({
      columns: [table.templateId],
      foreignColumns: [productCustomizationTemplates.id],
      name: "fk_custom_field_template",
    }).onDelete("cascade"),
  }),
);

export type ProductCustomizationField =
  typeof productCustomizationFields.$inferSelect;
export type InsertProductCustomizationField =
  typeof productCustomizationFields.$inferInsert;

/** متغيّر المنتج (لون/قياس). المخزون يُحسب على مستواه بالوحدة الأساس. */
export const productVariants = mysqlTable(
  "productVariants",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productId: bigint("productId", { mode: "number" })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    sku: varchar("sku", { length: 60 }).notNull(),
    variantName: varchar("variantName", { length: 255 }),
    // نوع المتغيّر (وثيقة «الجرد بالباركود» ٢٢/٨، م٣): VARIANT = تنويعة لون/قياس من نفس المنتج؛
    // ALTERNATIVE = منتجٌ حقيقيٌّ مستقل (ماركة/منشأ مختلف) يُباع تحت الاسم الجامع نفسه لكن له
    // مخزونه وتكلفته وباركوده وسعره كاملاً. الافتراض VARIANT (توافق: كل القائم تنويعات).
    // اسمُ البديل يُحمَل في variantName (إلزاميّ للبدائل)، ولا بديلَ بلا باركود (يُفرَض في الكتابة).
    variantKind: mysqlEnum("variantKind", ["VARIANT", "ALTERNATIVE"])
      .default("VARIANT")
      .notNull(),
    color: varchar("color", { length: 60 }),
    // بنك الألوان (colorHex): لون العرض الحقيقي «#RRGGBB» — اختيار صريح من المستخدم؛ إن null
    // يُستنتَج تلقائياً من اسم اللون عبر @shared/colorBank. هجرة 0080. (9 خانات تتّسع لـ#RRGGBBAA مستقبلاً.)
    colorHex: varchar("colorHex", { length: 9 }),
    size: varchar("size", { length: 60 }),
    // 0018: DB-level CHECK (costPrice >= 0) أُضيف في migration 0018.
    costPrice: decimal("costPrice", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    minStock: int("minStock").default(0),
    reorderPoint: int("reorderPoint").default(0),
    // هدف مخزون موسم المدارس (بالوحدة الأساس، عبر كل الفروع) — تجهيز ذروة أيلول. هجرة 0098.
    // seasonTarget > 0 يَسِم المتغيّر كصنفٍ موسميّ (مدرسيّ)؛ 0 = غير موسميّ (نمط reorderPoint > 0).
    seasonTarget: int("seasonTarget").default(0),
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    productIdx: index("idx_variant_product").on(table.productId),
    skuIdx: index("idx_variant_sku").on(table.sku),
  }),
);

export type ProductVariant = typeof productVariants.$inferSelect;
export type InsertProductVariant = typeof productVariants.$inferInsert;

/** وحدات القياس للمتغيّر (قطعة/درزن/كرتون) بمعامل تحويل وباركود مستقل. */
export const productUnits = mysqlTable(
  "productUnits",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    unitName: varchar("unitName", { length: 40 }).notNull(),
    // عدد الوحدات الأساس في هذه الوحدة (الأساس = 1، درزن = 12، كرتون = 144).
    conversionFactor: decimal("conversionFactor", { precision: 15, scale: 4 })
      .default("1")
      .notNull(),
    barcode: varchar("barcode", { length: 64 }).unique(),
    isBaseUnit: boolean("isBaseUnit").default(false).notNull(),
    // قناة البيع مستقلة عن وحدة المخزون: قد يكون الأساس «ورقة» بينما المتجر يبيع «بند/كارتون».
    isStoreSaleUnit: boolean("isStoreSaleUnit").default(false).notNull(),
    isActive: boolean("isActive").default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    variantIdx: index("idx_unit_variant").on(table.variantId),
    barcodeIdx: index("idx_unit_barcode").on(table.barcode),
  }),
);

export type ProductUnit = typeof productUnits.$inferSelect;
export type InsertProductUnit = typeof productUnits.$inferInsert;

/** باركودات بديلة (aliases) لوحدة المنتج — نفس السلعة/التكلفة/السعر/المخزون بعدّة باركودات.
 *  استخدام: نفس القلم بأشكال خارجية مختلفة، دفعات استيراد بترميز مختلف، الخ.
 *  التفرّد بين الأساسيّ والبديل يُنفَّذ تطبيقياً في `checkBarcodesTaken` (يفحص الجدولَين). */
export const productUnitBarcodes = mysqlTable(
  "productUnitBarcodes",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productUnitId: bigint("productUnitId", { mode: "number" })
      .notNull()
      .references(() => productUnits.id, { onDelete: "cascade" }),
    barcode: varchar("barcode", { length: 64 }).notNull(),
    note: varchar("note", { length: 255 }),
    // `users.id` هو INT — يجب أن يطابق الـFK عمود الأب حرفياً وإلا فشل db:push بـERR 3780.
    createdBy: int("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    barcodeUq: unique("uq_unit_barcode_alias").on(table.barcode),
    unitIdx: index("idx_alias_unit").on(table.productUnitId),
  }),
);

export type ProductUnitBarcode = typeof productUnitBarcodes.$inferSelect;
export type InsertProductUnitBarcode = typeof productUnitBarcodes.$inferInsert;

/** سعر صريح لكل (وحدة × فئة تسعير). */
export const productPrices = mysqlTable(
  "productPrices",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productUnitId: bigint("productUnitId", { mode: "number" })
      .notNull()
      .references(() => productUnits.id, { onDelete: "cascade" }),
    priceTier: mysqlEnum("priceTier", [
      "RETAIL",
      "WHOLESALE",
      "GOVERNMENT",
    ]).notNull(),
    price: decimal("price", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    unitTierUq: unique("uq_price_unit_tier").on(
      table.productUnitId,
      table.priceTier,
    ),
  }),
);

export type ProductPrice = typeof productPrices.$inferSelect;
export type InsertProductPrice = typeof productPrices.$inferInsert;

/* ============================ مكوّنات البكج (باندل) ============================ */

/**
 * bundles (٧/٧/٢٦): كل صفٍّ = مكوّن واحد من مكوّنات بكجٍ ما.
 * البكج = متغيّر منتجٍ يحمل `products.isBundle=true`. المكوّنات متغيّرات منتجات **بسيطة** (`isBundle=false`) —
 * التداخل ممنوع خادمياً في bundleService (وحارس تطبيقي: نفحص كل مكوّن مضاف).
 *
 * الدلالة:
 *  - `bundleVariantId`: المتغيّر الأب (البكج نفسه؛ الذي يحمله `products.isBundle`).
 *  - `componentVariantId`: المتغيّر المكوّن (منتج بسيط بمخزون فعلي).
 *  - `componentBaseQuantity`: كم وحدة أساس من المكوّن تدخل في كل **وحدة أساس** من البكج.
 *    مثال: بكج «طقم مدرسي» = 3 أقلام + 1 دفتر ⇒ صفّان بـ3 و1. عند بيع 5 أطقم = خصم 15 قلماً + 5 دفاتر.
 *  - `componentUnitId`: وحدة العرض للمستخدم (اختيارية، لا تؤثّر على الحساب — الحساب دائماً بالأساس).
 *
 * قيد التفرّد: مكوّن واحد لكل (bundle, component) — إن أراد المدير كميّة أكبر يزيد `componentBaseQuantity`.
 * قيد الحذف: cascade على البكج، restrict على المكوّن (كي لا يُحذَف مكوّن مستعمَل في بكجٍ حيّ).
 */
export const bundleComponents = mysqlTable(
  "bundleComponents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    bundleVariantId: bigint("bundleVariantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    componentVariantId: bigint("componentVariantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    // كم وحدة أساس من المكوّن لكل وحدة أساس من البكج. صحيح موجب (>0) — يفرضه CHECK في 0057.
    componentBaseQuantity: int("componentBaseQuantity").notNull(),
    // وحدة العرض (كي يفهم المستخدم "3 أقلام" بدل "3 وحدات"). اختيارية، عرضٌ فقط.
    componentUnitId: bigint("componentUnitId", { mode: "number" }).references(
      () => productUnits.id,
      { onDelete: "set null" },
    ),
    sortOrder: int("sortOrder").default(0).notNull(),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    bundleIdx: index("idx_bundle_component_bundle").on(table.bundleVariantId),
    componentIdx: index("idx_bundle_component_child").on(
      table.componentVariantId,
    ),
    // مكوّن واحد لكل (بكج، مكوّن) — الكمّية تُدار بـcomponentBaseQuantity لا بتكرار الأسطر.
    bundleComponentUq: unique("uq_bundle_component").on(
      table.bundleVariantId,
      table.componentVariantId,
    ),
  }),
);

export type BundleComponent = typeof bundleComponents.$inferSelect;
export type InsertBundleComponent = typeof bundleComponents.$inferInsert;

/**
 * productRelatedProducts: علاقات ترويجية بين المنتجات وليست وصفة مخزون.
 * المصدر = المنتج الموجود في السلة، والهدف = منتج مكمل يظهر تحت «أكمل تجهيزك».
 * لا تغيّر هذه العلاقات السعر أو المخزون؛ هي إشارات merchandising يراجعها المدير.
 */
export const productRelatedProducts = mysqlTable(
  "productRelatedProducts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sourceProductId: bigint("sourceProductId", { mode: "number" })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    relatedProductId: bigint("relatedProductId", { mode: "number" })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    relationType: mysqlEnum("relationType", [
      "COMPLETE_KIT",
      "COMPATIBLE",
      "SAME_THEME",
      "UPSELL",
    ])
      .default("COMPLETE_KIT")
      .notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    sourceIdx: index("idx_prod_related_source").on(
      table.sourceProductId,
      table.isActive,
      table.sortOrder,
    ),
    relatedIdx: index("idx_prod_related_target").on(table.relatedProductId),
    pairUq: unique("uq_prod_related_pair").on(
      table.sourceProductId,
      table.relatedProductId,
    ),
    selfCheck: check(
      "chk_prod_related_not_self",
      sql`${table.sourceProductId} <> ${table.relatedProductId}`,
    ),
  }),
);

export type ProductRelatedProduct = typeof productRelatedProducts.$inferSelect;
export type InsertProductRelatedProduct =
  typeof productRelatedProducts.$inferInsert;

/**
 * invoiceItemBundleComponents (٧/٧/٢٦، gstack B6): لقطة مكوّنات البكج لحظة إنشاء `invoiceItem`.
 *
 * السبب: `bundleComponents` وصفة حيّة قابلة للتعديل عبر `bundlesRouter.setComponents`. مسار المرتجع
 * كان يستعملها ⇒ لو غيّر المدير الوصفة بين البيع والإرجاع، المرتجع يعيد مكوّنات مختلفة عمّا خُصم =
 * انحراف مخزون صامت. الآن نُخزّن اللقطة على مستوى invoiceItem، ومسار المرتجع يقرأ منها حصراً.
 *
 * دورة الحياة: الإدراج في `sale/create.ts` داخل نفس معاملة إنشاء الفاتورة (ذرّي). لا تُعدَّل بعد
 * ذلك أبداً (مبدأ «الأثر المُجمَّد» — كالخصم في invoiceItems.discountAmount). `ON DELETE cascade`
 * على `invoiceItemId` كي تختفي مع البند، و`ON DELETE restrict` على المكوّن (يمنع حذف مكوّن
 * تشير إليه فاتورة قابلة للإرجاع — نفس دلالة `bundleComponents.componentVariantId`).
 */
export const invoiceItemBundleComponents = mysqlTable(
  "invoiceItemBundleComponents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    invoiceItemId: bigint("invoiceItemId", { mode: "number" }).notNull(),
    componentVariantId: bigint("componentVariantId", {
      mode: "number",
    }).notNull(),
    componentBaseQuantity: int("componentBaseQuantity").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    itemIdx: index("idx_iibc_item").on(table.invoiceItemId),
    componentIdx: index("idx_iibc_component").on(table.componentVariantId),
    // مفاتيح أجنبية بأسماء صريحة قصيرة (تطابق migration 0060). الاسم التلقائيّ الذي يولّده
    // drizzle-kit من الأعمدة (`invoiceItemBundleComponents_componentVariantId_productVariants_id_fk`
    // = ٦٨ محرفاً) يتجاوز حدّ مُعرّفات MySQL (٦٤) ⇒ `db:push` يفشل على قاعدة فارغة بـ
    // ER_TOO_LONG_IDENT (يظهر على MySQL 8.4؛ CI على 8.0 كان يمرّره). الأسماء الصريحة تُبقي
    // db:push (قواعد الاختبار) متطابقاً مع مسار الهجرات (الإنتاج) على كلّ إصدارات MySQL 8.x.
    itemFk: foreignKey({
      columns: [table.invoiceItemId],
      foreignColumns: [invoiceItems.id],
      name: "fk_iibc_item",
    }).onDelete("cascade"),
    componentFk: foreignKey({
      columns: [table.componentVariantId],
      foreignColumns: [productVariants.id],
      name: "fk_iibc_component",
    }).onDelete("restrict"),
  }),
);

export type InvoiceItemBundleComponent =
  typeof invoiceItemBundleComponents.$inferSelect;
export type InsertInvoiceItemBundleComponent =
  typeof invoiceItemBundleComponents.$inferInsert;

/* ============================ موجات تحديث الأسعار (Price Waves) ============================ */

/**
 * priceUpdateWaves (٧/٧/٢٦): «موجة تحديث أسعار» = تعديل جماعيّ لأسعار البيع بمعاينة ذرّية.
 *
 * السياق العراقي: أسعار السوق (دولار، تكلفة استيراد، وسم مورد) تتذبذب أسبوعياً. المدير يريد
 * تحديث أسعار مجموعة منتجات دفعةً واحدة بنسبة/مبلغ محدَّد، ويرى **معاينة** قبل الالتزام،
 * ويحتفظ بسجلٍّ دائم لمن غيّر ولماذا (P&L الفعلي، فحص هامش، تدقيق).
 *
 * الآلية:
 *   1. `previewPriceWave(filters, changeType, changeValue)` — يُرجع صفوف productUnits×tier
 *      المتأثّرة مع (oldPrice, newPrice) — بلا كتابة.
 *   2. `applyPriceWave(inputAfterPreview, actor)` — يفتح معاملة واحدة:
 *        - يكتب رأس الموجة (priceUpdateWaves) بـtotalRows.
 *        - لكل صفٍّ متأثّر: UPDATE productPrices + INSERT priceChangeLog (مربوطاً بـwaveId).
 *   3. لا rollback جزئي: كل الأسطر تنجح أو لا تنجح (withTx).
 *
 * أنواع التغيير (`changeType`):
 *   INCREASE_PERCENT — رفع بنسبة (مثل +5% على كل شيء).
 *   DECREASE_PERCENT — تخفيض بنسبة.
 *   INCREASE_AMOUNT  — إضافة مبلغ ثابت لكل وحدة (مثل +500 د.ع).
 *   DECREASE_AMOUNT  — طرح مبلغ ثابت.
 *   SET_MARGIN       — تعيين هامش ربح على التكلفة (newPrice = تكلفة **الوحدة** × (1 + margin%))،
 *                      وتكلفة الوحدة = تكلفة الأساس × conversionFactor (وللبكج: من وصفته).
 *   REVERT           — (هجرة 0226) موجةُ **تراجع**: تستعيد `priceChangeLog.oldPrice` صفّاً صفّاً
 *                      لموجةٍ سابقة. `changeValue = 0` (لا نسبة لها)، ولذلك وُسِّع قيدا CHECK.
 *
 * `filtersJson` (v2، ٢٠/٨/٢٦): مستند النطاق الكامل —
 *   { v:2, scope: FILTERED|SELECTED|ALL, categoryId, productSearch, priceTier, productIds,
 *     roundToDenom, excludedCount, skippedCount }
 * ولموجة التراجع: { v:2, revertsWaveId, conflicts, forced }.
 * ⚠️ الحقل `onlyBelowMargin` المذكور سابقاً هنا **لم يُنفَّذ قطّ** — أُزيل من التوثيق كي لا يُبنى عليه.
 */
export const priceUpdateWaves = mysqlTable(
  "priceUpdateWaves",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    changeType: mysqlEnum("priceChangeType", [
      "INCREASE_PERCENT",
      "DECREASE_PERCENT",
      "INCREASE_AMOUNT",
      "DECREASE_AMOUNT",
      "SET_MARGIN",
      "REVERT",
    ]).notNull(),
    // قيمة التغيير: نسبة (0..1000) أو مبلغ ثابت أو نسبة الهامش. الدلالة تعتمد على changeType.
    // REVERT وحده يحمل صفراً (الاستعادة تأخذ قيمها من السجلّ لا من قاعدةٍ حسابية).
    changeValue: decimal("changeValue", { precision: 15, scale: 2 }).notNull(),
    // مستند النطاق كـJSON — للتدقيق (من غيّر ولمن ولمتى وبأيّ تقريب واستثناءات).
    filtersJson: text("filtersJson"),
    totalRows: int("totalRows").default(0).notNull(),
    appliedBy: int("appliedBy")
      .notNull()
      .references(() => users.id),
    appliedAt: timestamp("appliedAt").defaultNow().notNull(),
    // هجرة 0226: الموجة التي تتراجع عنها هذه الموجة. فهرسٌ **فريد** ⇒ لا يُتراجَع عن موجةٍ مرّتين،
    // ويجعل «مُتراجَعٌ عنها» قابلاً للاستعلام بضمّةٍ واحدة بدل مسحٍ للسجلّ.
    // ⚠️ بلا FK عمداً: drizzle-kit يُسقط UNIQUE حين يجتمع مع FK على العمود نفسه (فخٌّ موثَّق)،
    // والتكامل مضمونٌ تطبيقياً — `revertPriceWave` تقرأ الموجة الأصلية قبل الكتابة، ولا مسار حذفٍ
    // لـ`priceUpdateWaves` في النظام أصلاً.
    revertsWaveId: bigint("revertsWaveId", { mode: "number" }),
  },
  (table) => ({
    appliedAtIdx: index("idx_wave_applied_at").on(table.appliedAt),
    appliedByIdx: index("idx_wave_applied_by").on(table.appliedBy),
    revertsIdx: unique("uq_wave_reverts").on(table.revertsWaveId),
  }),
);

export type PriceUpdateWave = typeof priceUpdateWaves.$inferSelect;
export type InsertPriceUpdateWave = typeof priceUpdateWaves.$inferInsert;

/**
 * priceChangeLog: صفٌّ لكل تغيير سعر على (productUnit × tier) — سجلّ دائم للتدقيق.
 * `waveId` nullable: التغييرات اليدوية (شاشة تعديل المنتج فرادى) تُسجَّل بـwaveId=NULL لاحقاً؛
 * تغييرات الموجة الجماعية تُربَط بـwaveId. الأثر مُجمَّد — لا يُحذَف السجلّ عند إلغاء الموجة.
 */
export const priceChangeLog = mysqlTable(
  "priceChangeLog",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productUnitId: bigint("productUnitId", { mode: "number" })
      .notNull()
      .references(() => productUnits.id, { onDelete: "cascade" }),
    priceTier: mysqlEnum("priceChangeTier", [
      "RETAIL",
      "WHOLESALE",
      "GOVERNMENT",
    ]).notNull(),
    // oldPrice=NULL يشير إلى إنشاء أوّل سعر (لم يكن هناك سعر قبل).
    oldPrice: decimal("oldPrice", { precision: 15, scale: 2 }),
    newPrice: decimal("newPrice", { precision: 15, scale: 2 }).notNull(),
    // مبرّر التغيير (اختياري لكن ينصح به) — يعرَض في التقارير.
    reason: varchar("reason", { length: 255 }),
    waveId: bigint("waveId", { mode: "number" }).references(
      () => priceUpdateWaves.id,
      { onDelete: "set null" },
    ),
    actorUserId: int("actorUserId")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    unitTierIdx: index("idx_price_log_unit_tier").on(
      table.productUnitId,
      table.priceTier,
    ),
    waveIdx: index("idx_price_log_wave").on(table.waveId),
    createdAtIdx: index("idx_price_log_created").on(table.createdAt),
  }),
);

export type PriceChangeLog = typeof priceChangeLog.$inferSelect;
export type InsertPriceChangeLog = typeof priceChangeLog.$inferInsert;

/* ============================ المخزون لكل (متغيّر × فرع) ============================ */

/** رصيد المخزون بالوحدة الأساس لكل متغيّر في كل فرع. */
export const branchStock = mysqlTable(
  "branchStock",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    // DB-01: لا CHECK(quantity>=0) — خدمات الطباعة (allowNegative) تَدفع الرصيد سالباً عمداً (قرار عمل)؛
    // حارس البيع الزائد تطبيقيّ للبيع العاديّ. أُقصِي من 0018 لأنّ قيد القاعدة يَكسر بيع الطباعة.
    quantity: int("quantity").default(0).notNull(),
    // آخر جرد معتمد شمل هذا الصنف في هذا الفرع — يغذّي «آخر جرد» والجرد الدوري ABC.
    lastCountedAt: timestamp("lastCountedAt"),
    // «الافتتاح التدريجي» (١٨/٧): متى ثُبِّت الرصيد الافتتاحي لهذا (الصنف×الفرع) — NULL = غير مُفتتَح
    // فيُسمح ببيعه بالسالب نقدياً أثناء «وضع الافتتاح» المؤقّت. يُثبَّت من اعتماد جرد افتتاحي أو
    // إنشاء/استيراد منتج بمخزون افتتاحي، والافتتاح مرّة واحدة لكل (صنف×فرع) — لا يُعاد.
    openedAt: timestamp("openedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    variantBranchUq: unique("uq_stock_variant_branch").on(
      table.variantId,
      table.branchId,
    ),
    branchIdx: index("idx_stock_branch").on(table.branchId),
    // S1 (٢٩/٦/٢٦): تنبيهات نقص المخزون (branchId+quantity) وكشف الجرد المتقادم (branchId+lastCountedAt). هجرة 0031.
    branchQtyIdx: index("idx_stock_branch_qty").on(
      table.branchId,
      table.quantity,
    ),
    branchCountedIdx: index("idx_stock_branch_counted").on(
      table.branchId,
      table.lastCountedAt,
    ),
  }),
);

export type BranchStock = typeof branchStock.$inferSelect;
export type InsertBranchStock = typeof branchStock.$inferInsert;

/** سجل حركات المخزون (بالوحدة الأساس). التحويل بين الفروع = حركتان. */
export const inventoryMovements = mysqlTable(
  "inventoryMovements",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    movementType: mysqlEnum("movementType", [
      "IN",
      "OUT",
      "ADJUST",
      "RETURN",
      "TRANSFER_IN",
      "TRANSFER_OUT",
    ]).notNull(),
    // الكمية بالوحدة الأساس (موجبة دائماً؛ الاتجاه من النوع).
    quantity: int("quantity").notNull(),
    // ⭐ P1-#3 (٢٥/٨): الدلتا الموقَّعة — يُعبَّأ على كل كتابة (applyMovement + setStock)، ويُستخدم
    // كمصدرٍ رخيصٍ للـSQL لبناء تقارير المطابقة (`Σ signedDelta = رصيد الفرع`) بلا Parsing للنصّ.
    // NULL مسموحٌ للتوافق مع الصفوف القائمة قبل هذه الهجرة (تُملأ backfill في 0265). القرّاء الجدد
    // يفضّلونه على `signedMoveQty` — يبقى الأخير fallback نصّياً للـidempotency في القراءة القديمة.
    signedDelta: int("signedDelta"),
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
    branchDateIdx: index("idx_move_branch_date").on(
      table.branchId,
      table.createdAt,
    ),
    branchVariantTypeIdx: index("idx_move_branch_variant_type").on(
      table.branchId,
      table.variantId,
      table.movementType,
    ),
  }),
);

export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type InsertInventoryMovement = typeof inventoryMovements.$inferInsert;

/** طلبات تسوية المخزون المُعلَّقة (فصل مهام #٦، الشريحة ٢): التسوية المباشرة عملية حسّاسة ⇒ تُنشأ
 *  **معلَّقةً بلا تغيير مخزون** ويعتمدها مديرٌ آخر (SOD: المُعتمِد ≠ المُنشئ) فيُطبَّق setStock + قيد ADJUST. */
export const stockAdjustmentRequests = mysqlTable(
  "stockAdjustmentRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    targetQuantity: int("targetQuantity").notNull(),
    // لقطة الرصيد لحظة الطلب — يُرفَض الاعتماد إن اختلف الرصيد الحيّ عنها (تفاؤليّ) لمنع محو حركاتٍ
    // وقعت في نافذة الاعتماد وترحيل ربحٍ/خسارةٍ وهميّة (المراجعة العدائية C1).
    expectedQuantity: int("expectedQuantity").notNull(),
    notes: varchar("notes", { length: 500 }),
    // سببُ التسوية (P2-#3، ٢٥/٨) — اختياريٌّ للتوافق مع الصفوف القائمة (NULL = «غير محدَّد»).
    // الأسباب الحسّاسة (DAMAGE/LOSS/THEFT) تُلزم `attachmentUrl` أدناه على مستوى الخدمة.
    // ⚠️ أوّل معامل mysqlEnum = اسم العمود (لا اسم النوع) — راجع [[mysqlenum-column-name-prod-only-break-2026-08-21]].
    reason: mysqlEnum("reason", [
      "STOCK_TAKE",
      "DAMAGE",
      "LOSS",
      "THEFT",
      "SAMPLE",
      "INTERNAL_USE",
      "GIFT",
      "CORRECTION",
      "OTHER",
    ]),
    // مرفق إثبات (data URL لصورةٍ مضغوطة) — إلزاميّ للأسباب الحسّاسة، اختياريّ لغيرها. النمطُ نظير
    // `receipts.attachmentUrl` (mediumtext ⇒ يتّسع لـ~16MB وهو كافٍ للصور المضغوطة).
    attachmentUrl: mediumtext("attachmentUrl"),
    status: mysqlEnum("stockAdjustmentStatus", [
      "PENDING_APPROVAL",
      "APPROVED",
      "REJECTED",
    ])
      .default("PENDING_APPROVAL")
      .notNull(),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    approvedBy: int("approvedBy").references(() => users.id), // المُعتمِد (≠ المُنشئ) — NULL حتى الحسم
    approvedAt: timestamp("approvedAt"),
    appliedMovementId: bigint("appliedMovementId", { mode: "number" }), // حركة المخزون المُطبَّقة عند الاعتماد
    rejectionReason: varchar("rejectionReason", { length: 500 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    statusBranchIdx: index("idx_stockadj_status_branch").on(
      table.status,
      table.branchId,
    ),
    variantIdx: index("idx_stockadj_variant").on(table.variantId),
  }),
);

export type StockAdjustmentRequest =
  typeof stockAdjustmentRequests.$inferSelect;

/* ==================== عتبات المخزون المخصّصة للفرع (تقرير المراجعة P1-#4، ٢٥/٨) ====================
 *
 * `productVariants.minStock`/`reorderPoint` عالميّة على مستوى المتغيّر ⇒ الفرعُ سريع الدوران
 * والبطيء يتلقّيان نفس التنبيه بنفس الحدّ، وهو ما يُنبِّه عليه تقرير الفحص التشغيليّ (٢٥/٨).
 * هذا الجدول يحمل **override** لكل (متغيّر × فرع)؛ العتبةُ الفرعيّة إن وُجدت تسود، وإلّا يُستعمل
 * الافتراض المخزَّن على المتغيّر (fallback). أعمدةُ المتغيّر تبقى كما هي (توافق ⇒ صفر أثر تحميل).
 * الاستعلاماتُ الرئيسة (`listReorderAlerts` وشاشة الرصيد الحيّ) تقرأ عبر LEFT JOIN + COALESCE.
 * القارئُ العامّ (dashboard/reports) يبقى على الافتراض حتى يُطلَب توسيعُه بشريحةٍ لاحقة.
 */
export const variantBranchThresholds = mysqlTable(
  "variantBranchThresholds",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    /** override الحدّ الأدنى؛ NULL = ورث الافتراضَ من `productVariants.minStock`. */
    minStock: int("minStock"),
    /** override حدّ إعادة الطلب؛ NULL = ورث الافتراضَ من `productVariants.reorderPoint`. */
    reorderPoint: int("reorderPoint"),
    updatedBy: int("updatedBy").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    // مفتاح الاتّحاد وحمايةٌ من التكرار: صفٌّ واحد لكل (متغيّر × فرع). القيدُ الفريد يُلتقط من الشاشة
    // بـER_DUP_ENTRY فيتحوّل إلى upsert عبر ON DUPLICATE KEY UPDATE في الطبقة العليا.
    vbtUq: unique("uq_vbt_variant_branch").on(table.variantId, table.branchId),
    branchIdx: index("idx_vbt_branch").on(table.branchId),
  }),
);

export type VariantBranchThreshold = typeof variantBranchThresholds.$inferSelect;

/* ==================== إعادة تقييم تكلفة المخزون (حوكمة التكلفة — تدقيق ٢٧/٧ H3/H4) ====================
 *
 * `productVariants.costPrice` مصدر الحقيقة الوحيد لتقييم المخزون في الميزانية ولتكلفة البضاعة
 * المباعة. تعديلُه يدوياً على صنفٍ **له رصيد** يحرّك أصلَ المخزون ⇒ تتحرّك حقوق الملكية (الرصيد
 * المُكمِّل) بلا سطرٍ مقابلٍ في قائمة الدخل — فأُغلق ذلك المسار (`services/costRevaluation.ts`).
 * هذا الجدول هو **المسار المحكوم البديل**: مستندٌ صريح بغرضٍ محاسبيّ وسببٍ مكتوب، يعتمده مديرٌ
 * ثانٍ (فصل المهام)، فيُرحَّل عند الاعتماد قيدُ ADJUST بقيمة `Δالتكلفة × الكمية` **لكل فرعٍ** له
 * رصيد — ومن ثمّ يخضع تلقائياً لحارس إقفال الفترة (`postEntry` ⇒ `assertPeriodOpen`).
 */
export const costRevaluationRequests = mysqlTable(
  "costRevaluationRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    /** فرع الطالب — للفلترة والعزل؛ التكلفة نفسها عامّة لكل الفروع (عمودٌ على المتغيّر لا على الفرع). */
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    oldCost: decimal("oldCost", { precision: 15, scale: 2 }).notNull(),
    newCost: decimal("newCost", { precision: 15, scale: 2 }).notNull(),
    /**
     * الغرض المحاسبيّ — هو ما يحدّد الحساب المقابل، ولذلك لا يُقبل طلبٌ بلا غرض:
     * CORRECTION = تصحيح تكلفةٍ أُدخلت خطأً (الاتجاهان)، IMPAIRMENT = هبوط قيمة/تقادم (نزولاً فقط).
     */
    purpose: mysqlEnum("costRevaluationPurpose", [
      "CORRECTION",
      "IMPAIRMENT",
    ]).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    /** لقطة إجمالي الكمية المملوكة لحظة الطلب — يُرفَض الاعتماد إن انحرفت (قيمة القيد تتبعها). */
    expectedQuantity: int("expectedQuantity").notNull(),
    /** لقطة الكمية لكل فرع: `[{ branchId, quantity }]` — منها تُشتقّ قيود الاعتماد فرعاً فرعاً. */
    branchQuantities: json("branchQuantities"),
    /** أثر القيمة المتوقَّع = (newCost − oldCost) × expectedQuantity — يُعرَض قبل الاعتماد. */
    expectedValueDelta: decimal("expectedValueDelta", {
      precision: 15,
      scale: 2,
    }).notNull(),
    status: mysqlEnum("costRevaluationStatus", [
      "PENDING_APPROVAL",
      "APPROVED",
      "REJECTED",
    ])
      .default("PENDING_APPROVAL")
      .notNull(),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    approvedBy: int("approvedBy").references(() => users.id),
    approvedAt: timestamp("approvedAt"),
    rejectionReason: varchar("rejectionReason", { length: 500 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    statusIdx: index("idx_costreval_status").on(table.status, table.branchId),
    variantIdx: index("idx_costreval_variant").on(table.variantId),
  }),
);

export type CostRevaluationRequest =
  typeof costRevaluationRequests.$inferSelect;

/* ============================ تحويلات المخزون بخطوتين (بالطريق ← استلام) ============================ */

/**
 * سند تحويل بين فرعين بخطوتين: الإرسال يخصم من المصدر فوراً (TRANSFER_OUT) ويضع البضاعة
 * «بالطريق» (لا تُحتسب في رصيد أي فرع)، والاستلام في الفرع الوجهة يطابق الكميات فعلياً
 * (TRANSFER_IN بالمستلَم فقط) — العجز يبقى موثَّقاً على السند سطراً بسطر.
 */
export const stockTransfers = mysqlTable(
  "stockTransfers",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    transferNumber: varchar("transferNumber", { length: 24 })
      .notNull()
      .unique("uq_transfer_number"),
    fromBranchId: bigint("fromBranchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    toBranchId: bigint("toBranchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    status: mysqlEnum("transferStatus", ["IN_TRANSIT", "RECEIVED", "CANCELLED"])
      .default("IN_TRANSIT")
      .notNull(),
    reason: varchar("reason", { length: 24 }),
    notes: text("notes"),
    // مجاميع بالوحدة الأساس (تُعرَض في القوائم بلا join على الأسطر).
    totalSentBase: int("totalSentBase").default(0).notNull(),
    totalReceivedBase: int("totalReceivedBase"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    receivedBy: int("receivedBy").references(() => users.id),
    receivedAt: timestamp("receivedAt"),
    receiveNotes: text("receiveNotes"),
    cancelledBy: int("cancelledBy").references(() => users.id),
    cancelledAt: timestamp("cancelledAt"),
  },
  (table) => ({
    fromStatusIdx: index("idx_transfer_from_status").on(
      table.fromBranchId,
      table.status,
    ),
    toStatusIdx: index("idx_transfer_to_status").on(
      table.toBranchId,
      table.status,
    ),
    dateIdx: index("idx_transfer_date").on(table.createdAt),
  }),
);

export type StockTransfer = typeof stockTransfers.$inferSelect;

export const stockTransferLines = mysqlTable(
  "stockTransferLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    transferId: bigint("transferId", { mode: "number" })
      .notNull()
      .references(() => stockTransfers.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    quantitySent: int("quantitySent").notNull(),
    // NULL حتى الاستلام؛ بعده = ما وصل فعلاً (0..المرسَل). الفرق = عجز نقل موثَّق.
    quantityReceived: int("quantityReceived"),
    // ملاحظة السطر (إلزامية خادمياً عند وجود فرق بين المرسَل والمستلَم).
    note: varchar("note", { length: 255 }),
  },
  (table) => ({
    transferIdx: index("idx_tline_transfer").on(table.transferId),
    variantIdx: index("idx_tline_variant").on(table.variantId),
    transferVariantUq: unique("uq_tline_transfer_variant").on(
      table.transferId,
      table.variantId,
    ),
  }),
);

export type StockTransferLine = typeof stockTransferLines.$inferSelect;

/* ============================ ورديات الكاشير ============================ */

export const shifts = mysqlTable(
  "shifts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    userId: int("userId")
      .notNull()
      .references(() => users.id),
    openingBalance: decimal("openingBalance", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    expectedCash: decimal("expectedCash", { precision: 15, scale: 2 }),
    countedCash: decimal("countedCash", { precision: 15, scale: 2 }),
    variance: decimal("variance", { precision: 15, scale: 2 }),
    status: mysqlEnum("shiftStatus", ["OPEN", "CLOSED"])
      .default("OPEN")
      .notNull(),
    // نوع الوردية: RETAIL (كاشير المبيعات/التجزئة) أو RECEPTION (خدمة الزبائن) أو PRINT_SERVICES
    // (كاشير خدمات الطباعة والاستنساخ) — كلٌّ درج/رصيد افتتاحي/عرابين وZ-report مستقلّ. قرار المالك
    // (٢٣/٧/٢٦): فصلٌ كامل بين كاشير التجزئة وكاشير خدمات الطباعة (صلاحية + درج). DEFAULT RETAIL ⇒ كل
    // الورديات القائمة تجزئة. يدخل في openGuard ⇒ وردية مفتوحة واحدة لكل (موظّف×فرع×نوع)، فيُمكن
    // لموظّفٍ حملُ ورديات تجزئة واستقبال وطباعة معاً.
    shiftType: mysqlEnum("shiftType", ["RETAIL", "RECEPTION", "PRINT_SERVICES"])
      .default("RETAIL")
      .notNull(),
    // حارس ذرّي: «userId:branchId:shiftType» عند الفتح، NULL عند الإغلاق. UNIQUE يسمح بـNULL متعدّد
    // ⇒ وردية مفتوحة واحدة لكل (موظّف×فرع×نوع)؛ فتحٌ متزامن ثانٍ لنفس النوع يفشل بـER_DUP_ENTRY.
    openGuard: varchar("openGuard", { length: 64 }).unique(
      "uq_shift_open_guard",
    ),
    openedAt: timestamp("openedAt").defaultNow().notNull(),
    closedAt: timestamp("closedAt"),
    notes: text("notes"),
    // treasury-stage2: snapshot لعدّاد الفئات وقت الإغلاق (تدقيق فقط، بلا تأثير محاسبي).
    // يَخزّن {250: n, 500: n, ...} للفئات السبع لـIQD. nullable لتوافق ورديات تاريخية.
    countedBreakdown: json("countedBreakdown"),
    // ①ج استمرارية نقد الورديات — المتبقّي فعلياً في الدرج بعد إغلاق هذه الوردية = المعدود − المُسلَّم
    // للخزينة عند الإغلاق (cash drop منتصف الوردية لا يُطرَح: سبق أن غادر الدرج قبل العدّ). يُصبح
    // «الرصيد الافتتاحيّ المتوقَّع» للوردية التالية لنفس (الفرع×النوع). nullable: الورديات المفتوحة
    // والتاريخية (قبل هذه الهجرة) لا تَحمله ⇒ لا مطابقة (سلوك «أوّل وردية»، بلا تحذير زائف).
    closingDrawerCash: decimal("closingDrawerCash", {
      precision: 15,
      scale: 2,
    }),
    // الرصيد الافتتاحيّ المتوقَّع الملتقَط لحظة فتح هذه الوردية (= closingDrawerCash لآخر وردية مغلقة
    // لنفس الفرع/النوع). null حين لا سابقة (أوّل وردية). لِلتدقيق وتقرير فجوات الاستمرارية.
    openingExpectedCash: decimal("openingExpectedCash", {
      precision: 15,
      scale: 2,
    }),
    // سبب اختلاف الرصيد الافتتاحيّ المُدخَل عن المتوقَّع (إلزاميّ عند الاختلاف — تحذيرٌ يُسجَّل لا حظر).
    // null حين لا اختلاف أو لا سابقة.
    openingDiscrepancyReason: varchar("openingDiscrepancyReason", {
      length: 500,
    }),
    // حوكمة تسوية الدرج: «المعدود» ليس مصدر مال. عند أي فرق تُحفظ العلّة والتفسير،
    // والفروق الجوهرية لا تعتمد إلا بفاعل إداري (فصل واجبات). nullable للورديات التاريخية/المفتوحة.
    varianceReasonCode: mysqlEnum("varianceReasonCode", [
      "COUNT_ERROR",
      "UNRECORDED_SALE",
      "UNRECORDED_CASH_IN",
      "UNRECORDED_CASH_OUT",
      "CHANGE_FUND_TRANSFER",
      "OFFLINE_SALE",
      "REFUND_ERROR",
      "OTHER",
    ]),
    varianceReason: varchar("varianceReason", { length: 500 }),
    reconciliationStatus: mysqlEnum("reconciliationStatus", [
      "MATCHED",
      "EXPLAINED",
      "MANAGER_APPROVED",
    ]),
    closedByUserId: int("closedByUserId").references(() => users.id),
    varianceReviewedByUserId: int("varianceReviewedByUserId").references(
      () => users.id,
    ),
  },
  (table) => ({
    branchIdx: index("idx_shift_branch").on(table.branchId),
    userIdx: index("idx_shift_user").on(table.userId),
    statusIdx: index("idx_shift_status").on(table.status),
  }),
);

export type Shift = typeof shifts.$inferSelect;
export type InsertShift = typeof shifts.$inferInsert;

/* ============================ الفواتير والمبيعات ============================ */

export const invoices = mysqlTable(
  "invoices",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    invoiceNumber: varchar("invoiceNumber", { length: 50 }).notNull().unique(),
    sourceType: mysqlEnum("sourceType", [
      "POS",
      "ONLINE",
      "ORDER",
      "WORKORDER",
    ]).notNull(),
    sourceId: varchar("sourceId", { length: 50 }),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    shiftId: bigint("shiftId", { mode: "number" }).references(() => shifts.id),
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
    ),
    priceTier: mysqlEnum("priceTier", ["RETAIL", "WHOLESALE", "GOVERNMENT"])
      .default("RETAIL")
      .notNull(),
    invoiceDate: timestamp("invoiceDate").defaultNow().notNull(),
    dueDate: date("dueDate"),
    // 0018: DB-level CHECK (>= 0) أُضيف على subtotal/total/paidAmount في migration 0018.
    // (cashRoundingAdjustment موقَّع عمداً ⇒ مُستثنى.)
    subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // لقطة نسبة الضريبة وقت إصدار الفاتورة. لا تُشتقّ من المبلغ لاحقاً لأن التقريب
    // والفواتير التاريخية قد يجعلان الاشتقاق غير دقيق.
    taxRatePercent: decimal("taxRatePercent", { precision: 5, scale: 2 })
      .default("0")
      .notNull(),
    discountAmount: decimal("discountAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    costTotal: decimal("costTotal", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // فرق تقريب النقد العراقي (±) للبيع النقدي الكامل؛ يُسجَّل أيضاً كقيد ADJUST ليتّسق الدفتر مع النقد المستلم.
    cashRoundingAdjustment: decimal("cashRoundingAdjustment", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    // أجرة الشحن/التوصيل كإيراد على رأس الفاتورة (COD المتجر) — مُضمَّنة في total لا في subtotal، وقيد
    // SALE يعترف بها ضمن revenue. تُخزَّن صراحةً (هجرة 0070) ليعكسها المرتجع الكامل بدقّة فيبقى
    // Σ(revenue)=Σ(profit)=0 (مراجعة عدائية ١٢/٧: عكسٌ بلا هذا العمود كان يترك إيراد شحنٍ وهميّاً).
    deliveryFee: decimal("deliveryFee", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // إفصاح التوصيل المجّاني (0152): يميّز «توصيل أُهدي» عن «بلا توصيل» — كلاهما كان
    // `deliveryFee = 0` فلا يُفرَّقان. `deliveryFree` هو التمييز، و`deliveryWaivedAmount`
    // قيمةُ ما تُنوزِل عنه (يراها الزبون على الفاتورة وتُحصى في التقارير).
    // **إفصاحٌ لا محاسبة**: الإيراد يبقى `deliveryFee` وحده — لا قيد ولا أثر ماليّ لهذين.
    deliveryFree: boolean("deliveryFree").default(false).notNull(),
    deliveryWaivedAmount: decimal("deliveryWaivedAmount", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    status: mysqlEnum("invoiceStatus", [
      "PENDING",
      "CONFIRMED",
      "PAID",
      "PARTIALLY_PAID",
      "CANCELLED",
      "RETURNED",
      // تصحيح الفاتورة (0168): الأصل يصير SUPERSEDED عند تصحيحه (عكسٌ كامل + إعادة إصدار
      // بفاتورةٍ جديدة). يخرج من القوائم النشطة كـCANCELLED/RETURNED، والعمولة/التقارير مشتقّةٌ
      // من الدفتر لا من الحالة فلا تتأثّر (base.ts:17-18). مربوطٌ بالجديدة عبر correctedByInvoiceId.
      "SUPERSEDED",
    ])
      .default("PENDING")
      .notNull(),
    paidAmount: decimal("paidAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // returnedTotal: مجموع ما أُرجِع من إجمالي الفاتورة (تراكميّ عبر مرتجعات جزئية).
    // يُحدَّث في returnService مع كل مرتجع. يُستخدَم في reconcile و AR-aging لمنع
    // انحراف وهمي حين المرتجع الجزئي يخفّض currentBalance دون total/paidAmount.
    // AR الحقيقي للفاتورة = max(total − paidAmount − returnedTotal, 0).
    returnedTotal: decimal("returnedTotal", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    paymentMethod: varchar("paymentMethod", { length: 20 }),
    // paymentMode (٢٨/٨/٢٦، هجرة 0276): متى يُتوقَّع تحصيل الفاتورة؟ الحقلُ الغائبُ الذي كان يجعل
    // النظام يخلط بين نمطَين ماليّين مختلفَين جوهريّاً:
    //   • PREPAID — دُفعت لحظة الإنشاء (أو تُدفع الآن، مسار البيع الكلاسيكيّ).
    //   • COD     — تُحصَّل لحظة التسليم (مالٌ حقيقيٌّ متأخّرٌ ساعات، **لا ائتمان**). يُتجاوز
    //               فحصُ حدّ الائتمان لأنّ المال يأتي مع المندوب — لا يُترك ديناً على العميل.
    //   • CREDIT  — دينٌ حقيقيٌّ على العميل (يخضع لسقف الائتمان الكامل).
    // كان النظام يعامل كلَّ «غير مدفوع» كائتمان (بلاغ المالك: «لا يمكنني إنشاء طلبٍ لعميلٍ لا
    // أعرفه»). الفرقُ حاسم: خلطُهما يمنع طلب اتّصالٍ مشروع أو يُدخل ديوناً وهميّة.
    paymentMode: mysqlEnum("paymentMode", ["PREPAID", "COD", "CREDIT"])
      .default("PREPAID")
      .notNull(),
    paymentDate: timestamp("paymentDate"),
    notes: text("notes"),
    // ٥/٨ — زبون عابر: اسمٌ وهاتفٌ مرجعيّان على الفاتورة نفسها (لا عميل ولا ذمّة). يُطبَعان على
    // الإيصال ويُستعملان عند تحويل الفاتورة للتوصيل. customerId يبقى NULL — فلا يتأثّر AR ولا
    // كشف الحساب ولا سقف الائتمان، ولا تُنشَأ سجلّات عملاء طيفية من كل بيعٍ نقديّ.
    contactName: varchar("contactName", { length: 255 }),
    contactPhone: varchar("contactPhone", { length: 32 }),
    // أوفلاين (هجرة 0085، ش٣ من خطة الأوفلاين): فاتورة التُقطت على جهاز الكاشير أثناء انقطاع
    // الاتصال وأُعيد تشغيلها عبر offline.replaySale. الرقم المؤقّت OFF-... هو المطبوع على
    // الإيصال الحراري وقت الالتقاط — يبقى قابلاً للبحث (مرتجعات/استفسار بورقة الزبون)،
    // وcapturedAt لحظة البيع الحقيقية (قيود الدفتر تبقى بوقت الخادم — سلامة قفل الفترة).
    originatedOffline: boolean("originatedOffline").default(false).notNull(),
    offlineReceiptNumber: varchar("offlineReceiptNumber", { length: 40 }),
    capturedAt: timestamp("capturedAt"),
    // لقطة تدقيق ثابتة: الاسم وقت البيع لا يتبدّل عند إعادة تسمية/تعطيل الحساب لاحقاً.
    salespersonNameSnapshot: varchar("salespersonNameSnapshot", {
      length: 255,
    }),
    // معرّف محطة/جهاز نقطة البيع (يُرسل من العميل؛ ويُحفظ أيضاً لبيع الأوفلاين).
    posDeviceId: varchar("posDeviceId", { length: 64 }),
    createdBy: int("createdBy").references(() => users.id),
    // فواتير تاريخية/مستوردة قد تحمل CANCELLED؛ أي مسار إلغاء مستقبلي يملك حقول تدقيق صريحة.
    cancelledBy: int("cancelledBy").references(() => users.id, {
      onDelete: "set null",
    }),
    cancelledByNameSnapshot: varchar("cancelledByNameSnapshot", {
      length: 255,
    }),
    cancelledAt: timestamp("cancelledAt"),
    // تصحيح الفاتورة (0168) — نسب التصحيح ثنائيّة الاتجاه (FK ذاتيّ، ON DELETE SET NULL):
    //   correctionOfInvoiceId: تُوضَع على الفاتورة **المصحّحة الجديدة** ⇒ تشير إلى الأصل.
    //   correctedByInvoiceId : تُوضَع على **الأصل** (SUPERSEDED) ⇒ تشير إلى المصحّحة الجديدة.
    correctionOfInvoiceId: bigint("correctionOfInvoiceId", {
      mode: "number",
    }).references((): AnyMySqlColumn => invoices.id, { onDelete: "set null" }),
    correctedByInvoiceId: bigint("correctedByInvoiceId", {
      mode: "number",
    }).references((): AnyMySqlColumn => invoices.id, { onDelete: "set null" }),
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
    // تصحيح الفاتورة (0168): بحث نسب التصحيح (الأصل↔المصحّحة) بلا مسحٍ كامل.
    correctionOfIdx: index("idx_invoice_correction_of").on(
      table.correctionOfInvoiceId,
    ),
    correctedByIdx: index("idx_invoice_corrected_by").on(
      table.correctedByInvoiceId,
    ),
    // G11 (١٩/٦/٢٦): composite indexes للتقارير الأكثر استعمالاً — AR aging و Daily Sales.
    statusCustomerIdx: index("idx_invoice_status_customer").on(
      table.status,
      table.customerId,
    ),
    // S1 (٢٩/٦/٢٦): أعمار الذمم/المبيعات اليومية لكل (فرع+حالة+تاريخ) + تعرّض الائتمان لكل (عميل+استحقاق+حالة). هجرة 0031.
    // (status-first مفيد للشمول الإيجابي IN — مُثبَت بالقياس: ٥× أسرع من (branch,date,status) لـAR aging.)
    branchStatusDateIdx: index("idx_invoice_branch_status_date").on(
      table.branchId,
      table.status,
      table.invoiceDate,
    ),
    // ملاحظة: idx_invoice_branch_date حُذف في 0033 — صار بادئةً مكرّرةً من idx_invoice_branch_date_status (S2).
    customerDueIdx: index("idx_invoice_customer_due").on(
      table.customerId,
      table.dueDate,
      table.status,
    ),
    // S2 (٢٩/٦/٢٦): فهارس مُغطّية بترتيب (التاريخ ثم الحالة) لتقارير المبيعات — مُثبَتة بالقياس (هجرة 0032).
    // الترتيب حاسم: invoiceStatus NOT IN نفيٌ غير-مساواة يكسر البادئة، فالتاريخ يجب أن يسبق الحالة.
    dateStatusIdx: index("idx_invoice_date_status").on(
      table.invoiceDate,
      table.status,
    ),
    branchDateStatusIdx: index("idx_invoice_branch_date_status").on(
      table.branchId,
      table.invoiceDate,
      table.status,
    ),
    sourceUq: unique("uq_invoice_source").on(table.sourceType, table.sourceId),
    // أوفلاين (0084): بحث بالرقم المؤقّت المطبوع على إيصال الزبون (مرتجع/استفسار).
    offlineReceiptIdx: index("idx_invoice_offline_receipt").on(
      table.offlineReceiptNumber,
    ),
    salespersonDateIdx: index("idx_invoice_salesperson_date").on(
      table.createdBy,
      table.invoiceDate,
    ),
    // ش٠ (٥/٨، V2): طابور الاستقبال يفلتر على shiftId ويرتّب/يقطع بـid (keyset) — كان تعليق
    // delivery/queries.ts يدّعي أن العمود «مفهرَس» ولا فهرس له فعلاً ⇒ مسح كامل مع نموّ الجدول.
    shiftIdx: index("idx_invoice_shift").on(table.shiftId, table.id),
  }),
);

export type Invoice = typeof invoices.$inferSelect;
export type InsertInvoice = typeof invoices.$inferInsert;

export const invoiceItems = mysqlTable(
  "invoiceItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    invoiceId: bigint("invoiceId", { mode: "number" })
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(
      () => productUnits.id,
    ),
    workOrderId: bigint("workOrderId", { mode: "number" }),
    // 0018: DB-level CHECK (>= 0) أُضيف على quantity/baseQuantity/unitPrice/total في migration 0018.
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    returnedBaseQuantity: int("returnedBaseQuantity").default(0).notNull(),
    // الكمية المُرتجعة التي أُعيدت للمخزون فعلاً (restock=true فقط). التالف/أمر الشغل لا يزيدها،
    // فتبقى تكلفته خسارةً في تقارير COGS التحليلية مطابِقةً لدفتر P&L (returnService يزيدها عند
    // restock فقط؛ والقيم التاريخية مُعبَّأة = returnedBaseQuantity في هجرة الإضافة لحفظ تطابق الماضي).
    returnedRestockedBaseQuantity: int("returnedRestockedBaseQuantity")
      .default(0)
      .notNull(),
    unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
    unitCost: decimal("unitCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    discountPercent: decimal("discountPercent", {
      precision: 5,
      scale: 2,
    }).default("0"),
    discountAmount: decimal("discountAmount", {
      precision: 15,
      scale: 2,
    }).default("0"),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    // promotions v2 (٨/٧/٢٦): العرض المطبَّق على السطر (nullable — الأغلبية بلا عرض). التخزين هنا
    // يمنع «تعديل عرضٍ لاحقاً» من تغيير سجلّ فواتير سابقة (الأثر مُجمَّد). B11: NOT NULL DEFAULT '0'
    // على `promotionDiscount` (كان nullable ⇒ انحراف بين schema والهجرة).
    promotionId: bigint("promotionId", { mode: "number" }),
    promotionDiscount: decimal("promotionDiscount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // هدايا الفاتورة (0149): سطرٌ مُهدىً — سعره صفر ويُخصَم من المخزون كسائر البنود، لكنّ تكلفته
    // (لقطة WAVG في `unitCost` أدناه، محفوظة كاملةً) تُرحَّل قيدَ GIFT_OUT مصروفَ هدايا بدل أن
    // تدخل `invoices.costTotal`/قيد SALE ⇒ الثابت «SALE.cost = invoices.costTotal = تكلفة البنود
    // المدفوعة» يبقى سارياً، والهدية خارج وعاء العمولة تلقائياً (الوعاء يفلتر SALE/RETURN).
    isGift: boolean("isGift").default(false).notNull(),
    // product-content-governance (0251): الاسم الذي طُبع/اعتمد لحظة البيع، لا يتغير مع تحديث الكتالوج.
    itemNameSnapshot: varchar("itemNameSnapshot", { length: 512 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    invoiceIdx: index("idx_item_invoice").on(table.invoiceId),
    variantIdx: index("idx_item_variant").on(table.variantId),
    productUnitIdx: index("idx_item_productUnit").on(table.productUnitId),
    // S1 (٢٩/٦/٢٦): مطابقة المرتجعات/COGS المتمحورة حول الصنف (variantId+invoiceId). هجرة 0031.
    variantInvoiceIdx: index("idx_item_variant_invoice").on(
      table.variantId,
      table.invoiceId,
    ),
    // promotions v2: تقرير أثر العرض بحسب معرّف العرض.
    promotionIdx: index("idx_item_promotion").on(table.promotionId),
    nameSnapshotIdx: index("idx_item_name_snapshot").on(table.itemNameSnapshot),
  }),
);

export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type InsertInvoiceItem = typeof invoiceItems.$inferInsert;

/* ============================ CRM — الحملات التجارية ============================ */

/** الحملة هي المظلّة التجارية التي تربط الجمهور بالعروض والكوبونات والنتائج.
 *  تبقى `promotions` محرك التسعير الفعلي، بينما تملك الحملة الهدف ودورة الاعتماد. */
export const crmCampaigns = mysqlTable(
  "crmCampaigns",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    objective: text("objective"),
    status: mysqlEnum("crmCampaignStatus", [
      "DRAFT",
      "REVIEW",
      "APPROVED",
      "SCHEDULED",
      "ACTIVE",
      "PAUSED",
      "ENDED",
    ])
      .default("DRAFT")
      .notNull(),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
      { onDelete: "set null" },
    ),
    startsOn: date("startsOn"),
    endsOn: date("endsOn"),
    ownerUserId: int("ownerUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedBy: int("approvedBy").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approvedAt"),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    branchStatusIdx: index("idx_crm_campaign_branch_status").on(
      table.branchId,
      table.status,
    ),
    datesIdx: index("idx_crm_campaign_dates").on(table.startsOn, table.endsOn),
  }),
);

export type CrmCampaign = typeof crmCampaigns.$inferSelect;
export type InsertCrmCampaign = typeof crmCampaigns.$inferInsert;

/* ============================ العروض والخصومات على المبيعات (Promotions v2) ============================ */

/**
 * promotions v2 (٨/٧/٢٦، بعد gstack-review على PR #163): إعادة بناء بفلسفة «نقطة العرض = نقطة الفرض» —
 * pos.ts يحلّ السعر المخصوم ويعيده لِـPOS، والكاشير يبني payment.amount من السعر المخصوم مباشرةً
 * (لا انحراف بين ما يعرضه العميل وما يسجّله الخادم).
 *
 * الفوارق الحاسمة عن الإصدار الأوّل (المسحوب):
 *  * الحلّ في pos.ts لا في sale/create ⇒ POS «يعرف» بالعرض قبل عرض السعر، فتُجنّبنا B2 (فائض Z-report).
 *  * `promotionDiscount` على invoiceItems صار NOT NULL (B11).
 *  * `minLineAmount` صار NOT NULL DEFAULT 0 (B11: NULL كان يعطّل العرض بصمت).
 *  * تاريخ الفاعلية يستعمل حبيبة اليوم المحلي (B8: fix effectiveTo يوم الأخير لا يعمل).
 *  * الأولوية عند التعارض حتميّة (priority ⇒ discountForUnit ⇒ id).
 *  * السعر التعاقدي يفوز دائماً (قرار المالك — resolvePromotion يعود null إن hasContractPrice).
 */
export const promotions = mysqlTable(
  "promotions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    campaignId: bigint("campaignId", { mode: "number" }).references(
      () => crmCampaigns.id,
      { onDelete: "set null" },
    ),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    type: mysqlEnum("promotionType", ["PERCENT", "AMOUNT"]).notNull(),
    discountPercent: decimal("discountPercent", { precision: 5, scale: 2 })
      .default("0")
      .notNull(),
    discountAmount: decimal("discountAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    scope: mysqlEnum("promotionScope", [
      "ALL",
      "CATEGORIES",
      "PRODUCTS",
    ]).notNull(),
    effectiveFrom: date("effectiveFrom").notNull(),
    effectiveTo: date("effectiveTo"),
    customerTier: mysqlEnum("promotionCustomerTier", [
      "RETAIL",
      "WHOLESALE",
      "GOVERNMENT",
    ]),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
      { onDelete: "set null" },
    ),
    // gstack B11: NOT NULL DEFAULT '0' (كان nullable ⇒ NULL يعطّل العرض بصمت مع lte).
    minLineAmount: decimal("minLineAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    priority: int("priority").default(0).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    // AUTO = يطبّق تلقائياً في القناة. COUPON = لا يُطبّق إلا بعد تحقق كوبون صالح في معاملة البيع.
    applicationMode: mysqlEnum("promotionApplicationMode", ["AUTO", "COUPON"])
      .default("AUTO")
      .notNull(),
    // قناة العرض (0073): true = عرض متجر إلكترونيّ (من لوحة hPanel، أونلاين فقط — يُستثنى من تسعير
    // الكاشير). false = عرض كاشير/إدارة عامّ (السلوك السابق). يميّز القناتين إذ يتطابق branch+tier.
    isStoreManaged: boolean("isStoreManaged").default(false).notNull(),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    activeDatesIdx: index("idx_promo_active_dates").on(
      table.isActive,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    scopeIdx: index("idx_promo_scope").on(table.scope),
    branchIdx: index("idx_promo_branch").on(table.branchId),
    campaignIdx: index("idx_promo_campaign").on(table.campaignId),
    applicationIdx: index("idx_promo_application").on(
      table.applicationMode,
      table.isActive,
    ),
  }),
);

export type Promotion = typeof promotions.$inferSelect;
export type InsertPromotion = typeof promotions.$inferInsert;

/**
 * promotionTargets: أهداف العرض عند scope ≠ ALL. صفٌّ واحد لكل هدف — إحدى (categoryId/productId/variantId)
 * حصراً (نفرض ذلك بـCHECK). productId = العرض يشمل كل متغيّرات المنتج (الأشيَع). variantId = دقيق.
 */
export const promotionTargets = mysqlTable(
  "promotionTargets",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    promotionId: bigint("promotionId", { mode: "number" })
      .notNull()
      .references(() => promotions.id, { onDelete: "cascade" }),
    categoryId: bigint("categoryId", { mode: "number" }).references(
      () => categories.id,
      { onDelete: "cascade" },
    ),
    productId: bigint("productId", { mode: "number" }).references(
      () => products.id,
      { onDelete: "cascade" },
    ),
    variantId: bigint("variantId", { mode: "number" }).references(
      () => productVariants.id,
      { onDelete: "cascade" },
    ),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    promoIdx: index("idx_promo_target_promo").on(table.promotionId),
    categoryIdx: index("idx_promo_target_category").on(table.categoryId),
    productIdx: index("idx_promo_target_product").on(table.productId),
    variantIdx: index("idx_promo_target_variant").on(table.variantId),
  }),
);

export type PromotionTarget = typeof promotionTargets.$inferSelect;
export type InsertPromotionTarget = typeof promotionTargets.$inferInsert;

/* ============================ CRM — برامج الكوبونات والإصدارات والاسترداد ============================ */

export const couponPrograms = mysqlTable(
  "couponPrograms",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    campaignId: bigint("campaignId", { mode: "number" }).references(
      () => crmCampaigns.id,
      { onDelete: "set null" },
    ),
    promotionId: bigint("promotionId", { mode: "number" })
      .notNull()
      .references(() => promotions.id),
    name: varchar("name", { length: 255 }).notNull(),
    status: mysqlEnum("couponProgramStatus", [
      "DRAFT",
      "ACTIVE",
      "PAUSED",
      "ENDED",
    ])
      .default("DRAFT")
      .notNull(),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
      { onDelete: "set null" },
    ),
    validFrom: date("validFrom").notNull(),
    validTo: date("validTo"),
    perCouponLimit: int("perCouponLimit").default(1).notNull(),
    perCustomerLimit: int("perCustomerLimit").default(1).notNull(),
    codePrefix: varchar("codePrefix", { length: 12 }).default("CRM").notNull(),
    // لقطة تصميم قابلة للإصدار؛ تغيير القالب لاحقاً لا يغيّر بطاقة سبق إصدارها.
    designJson: json("designJson"),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    campaignIdx: index("idx_coupon_program_campaign").on(table.campaignId),
    promoIdx: index("idx_coupon_program_promo").on(table.promotionId),
    branchStatusIdx: index("idx_coupon_program_branch_status").on(
      table.branchId,
      table.status,
    ),
    datesIdx: index("idx_coupon_program_dates").on(
      table.validFrom,
      table.validTo,
    ),
  }),
);

export const coupons = mysqlTable(
  "coupons",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    programId: bigint("programId", { mode: "number" })
      .notNull()
      .references(() => couponPrograms.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 64 }).notNull(),
    codeHash: varchar("codeHash", { length: 64 }).notNull(),
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
      { onDelete: "set null" },
    ),
    status: mysqlEnum("couponStatus", ["ACTIVE", "REDEEMED", "VOID"])
      .default("ACTIVE")
      .notNull(),
    redemptionCount: int("redemptionCount").default(0).notNull(),
    issuedAt: timestamp("issuedAt").defaultNow().notNull(),
    voidedAt: timestamp("voidedAt"),
    voidedBy: int("voidedBy").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    codeUq: unique("uq_coupon_code").on(table.code),
    hashUq: unique("uq_coupon_hash").on(table.codeHash),
    programIdx: index("idx_coupon_program").on(table.programId),
    customerIdx: index("idx_coupon_customer").on(table.customerId),
    statusIdx: index("idx_coupon_status").on(table.status),
  }),
);

export const couponRedemptions = mysqlTable(
  "couponRedemptions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    couponId: bigint("couponId", { mode: "number" })
      .notNull()
      .references(() => coupons.id),
    programId: bigint("programId", { mode: "number" })
      .notNull()
      .references(() => couponPrograms.id),
    invoiceId: bigint("invoiceId", { mode: "number" })
      .notNull()
      .references(() => invoices.id),
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
      { onDelete: "set null" },
    ),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    discountAmount: decimal("discountAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    redeemedBy: int("redeemedBy")
      .notNull()
      .references(() => users.id),
    redeemedAt: timestamp("redeemedAt").defaultNow().notNull(),
  },
  (table) => ({
    invoiceUq: unique("uq_coupon_redemption_invoice").on(table.invoiceId),
    couponInvoiceUq: unique("uq_coupon_redemption_coupon_invoice").on(
      table.couponId,
      table.invoiceId,
    ),
    programCustomerIdx: index("idx_coupon_redemption_program_customer").on(
      table.programId,
      table.customerId,
    ),
    redeemedAtIdx: index("idx_coupon_redemption_at").on(table.redeemedAt),
  }),
);

export type CouponProgram = typeof couponPrograms.$inferSelect;
export type Coupon = typeof coupons.$inferSelect;
export type CouponRedemption = typeof couponRedemptions.$inferSelect;

/* ============================ متجر العملاء — الولاء والنقاط ============================ */

/** برنامج ولاء واحد أو أكثر، لا يلمس التطبيق قيمه مباشرةً؛ الإدارة تفعله وتضبط قواعده من الداشبورد. */
export const loyaltyPrograms = mysqlTable(
  "loyaltyPrograms",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    status: mysqlEnum("status", ["DRAFT", "ACTIVE", "PAUSED"])
      .default("DRAFT")
      .notNull(),
    /** نقاط لكل دينار عراقي؛ Decimal يمنع تراكم خطأ floating point في القيمة التسويقية. */
    pointsPerIqd: decimal("pointsPerIqd", { precision: 16, scale: 6 })
      .default("0")
      .notNull(),
    /** قيمة الخصم بالدينار لكل نقطة عند الاستبدال. */
    iqdDiscountPerPoint: decimal("iqdDiscountPerPoint", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    minRedeemPoints: int("minRedeemPoints").default(0).notNull(),
    maxRedeemPercent: tinyint("maxRedeemPercent").default(0).notNull(),
    expiresAfterDays: int("expiresAfterDays"),
    createdBy: int("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    statusIdx: index("idx_loyalty_program_status").on(table.status),
  }),
);

/** حساب العميل لا يحمل أي بيانات عرض؛ الرصيد والسجل يحكمان من الخادم حصراً. */
export const loyaltyAccounts = mysqlTable(
  "loyaltyAccounts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    programId: bigint("programId", { mode: "number" })
      .notNull()
      .references(() => loyaltyPrograms.id),
    customerId: bigint("customerId", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    pointsBalance: decimal("pointsBalance", { precision: 18, scale: 2 })
      .default("0")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    programCustomerUq: unique("uq_loyalty_program_customer").on(
      table.programId,
      table.customerId,
    ),
    customerIdx: index("idx_loyalty_account_customer").on(table.customerId),
  }),
);

/** دفتر نقاط غير قابل للتعديل؛ كل منح أو صرف أو عكس يترك أثراً تدقيقياً قابلاً للمراجعة. */
export const loyaltyLedgerEntries = mysqlTable(
  "loyaltyLedgerEntries",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    accountId: bigint("accountId", { mode: "number" })
      .notNull()
      .references(() => loyaltyAccounts.id),
    customerId: bigint("customerId", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    onlineOrderId: bigint("onlineOrderId", { mode: "number" }),
    entryType: mysqlEnum("entryType", [
      "ORDER_EARN",
      "ORDER_REVERSE",
      "REDEEM",
      "ADJUSTMENT",
      "EXPIRE",
    ]).notNull(),
    pointsDelta: decimal("pointsDelta", { precision: 18, scale: 2 }).notNull(),
    balanceAfter: decimal("balanceAfter", {
      precision: 18,
      scale: 2,
    }).notNull(),
    note: varchar("note", { length: 255 }),
    createdBy: int("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    accountCreatedIdx: index("idx_loyalty_ledger_account_created").on(
      table.accountId,
      table.createdAt,
    ),
    orderEarnUq: unique("uq_loyalty_order_earn").on(
      table.onlineOrderId,
      table.entryType,
    ),
  }),
);

export type LoyaltyProgram = typeof loyaltyPrograms.$inferSelect;
export type LoyaltyAccount = typeof loyaltyAccounts.$inferSelect;
export type LoyaltyLedgerEntry = typeof loyaltyLedgerEntries.$inferSelect;

/* ============================ عروض الأسعار (Quotations) ============================ */

/** عرض سعر — مستند تفاوضي بلا أثر على المخزون أو الدفتر حتى يُحوَّل إلى فاتورة. */
export const quotations = mysqlTable(
  "quotations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    quoteNumber: varchar("quoteNumber", { length: 50 }).notNull().unique(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
    ),
    priceTier: mysqlEnum("quotePriceTier", [
      "RETAIL",
      "WHOLESALE",
      "GOVERNMENT",
    ])
      .default("RETAIL")
      .notNull(),
    quoteDate: timestamp("quoteDate").defaultNow().notNull(),
    validUntil: date("validUntil"),
    subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    taxRatePercent: decimal("taxRatePercent", { precision: 5, scale: 2 })
      .default("0")
      .notNull(),
    discountAmount: decimal("discountAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    status: mysqlEnum("quoteStatus", [
      "DRAFT",
      "SENT",
      "ACCEPTED",
      "REJECTED",
      "CONVERTED",
      "EXPIRED",
    ])
      .default("DRAFT")
      .notNull(),
    convertedInvoiceId: bigint("convertedInvoiceId", {
      mode: "number",
    }).references(() => invoices.id),
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
  }),
);

export type Quotation = typeof quotations.$inferSelect;
export type InsertQuotation = typeof quotations.$inferInsert;

export const quotationItems = mysqlTable(
  "quotationItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    quotationId: bigint("quotationId", { mode: "number" })
      .notNull()
      .references(() => quotations.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" })
      .notNull()
      .references(() => productUnits.id),
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
    discountAmount: decimal("discountAmount", {
      precision: 15,
      scale: 2,
    }).default("0"),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    quoteIdx: index("idx_qitem_quote").on(table.quotationId),
    variantIdx: index("idx_qitem_variant").on(table.variantId),
  }),
);

export type QuotationItem = typeof quotationItems.$inferSelect;
export type InsertQuotationItem = typeof quotationItems.$inferInsert;

/* ============================ المقبوضات والمدفوعات ============================ */

export const receipts = mysqlTable(
  "receipts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(
      () => invoices.id,
    ),
    // ربط إيصال العربون بأمر الشغل قبل وجود فاتورة؛ يُربَط بالفاتورة عند التسليم.
    workOrderId: bigint("workOrderId", { mode: "number" }),
    // ربط إيصال عربون الحجز قبل وجود فاتورة (نمط workOrderId، الحجوزات ٢٧/٧): يُربَط بالفاتورة عند التحويل.
    reservationId: bigint("reservationId", { mode: "number" }),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    shiftId: bigint("shiftId", { mode: "number" }).references(() => shifts.id),
    direction: mysqlEnum("direction", ["IN", "OUT"]).default("IN").notNull(),
    // 0018: DB-level CHECK (amount >= 0) أُضيف في migration 0018 (المبلغ موجب؛ الاتجاه من `direction`).
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    // EXCHANGE: سند صرف مُنشأ حصراً من تسديد المورد عبر الصيرفة؛ لا يمسّ الخزينة.
    paymentMethod: mysqlEnum("paymentMethod", [
      "CASH",
      "CARD",
      "CHECK",
      "TRANSFER",
      "WALLET",
      "EXCHANGE",
      // ش٥ (٦/٨): رصيد اتصال زين (أكواد كروت شحن) — حسابٌ مشتقّ يُسوّى دورياً، لا يلمس الدرج
      // أبداً (I15: cashBucket يبقى NULL). قيمة enum على جدول قائم = هجرة مرقّمة 0154 + نسخة
      // extras آخر قائمة ci-apply (V10 — واحدة وحدها عطلٌ صامت).
      "TELECOM",
    ]).notNull(),
    /**
     * cash-treasury-mode (تدقيق ١٧/٦): فصل النقد إلى دلوَين دلالياً.
     *  - DRAWER: نقد درج كاشير ⇒ يَخصم/يُضيف إلى Z-report عبر shiftId.
     *  - TREASURY: نقد خزينة إدارية (admin/manager بلا وردية) ⇒ سجلّ مستقلّ، لا يَدخل
     *    تسوية الدرج، يَظهر في تقرير «المعاملات الإدارية + النقد اليتيم» مفصولاً.
     * الحقل اختياري NULL للسجلات غير النقدية (لا دلوَ لها) وللسجلات التاريخية قبل ١٧/٦.
     */
    cashBucket: mysqlEnum("cashBucket", ["DRAWER", "TREASURY"]),
    referenceNumber: varchar("referenceNumber", { length: 100 }),
    /**
     * 0185 — عمود مولَّد STORED = `CD-…:direction` لصفوف السحب النقديّ وحدها، وNULL لغيرها.
     * عليه فهرس فريد `uq_receipt_cash_drop` ⇒ يستحيل رقما سحبٍ متطابقان لنفس الاتجاه، بينما
     * تبقى مراجع بقيّة السندات حرّةً في التكرار (NULLات لا تتصادم). drizzle لا يَلمسه
     * (read-only من JS) — مُعرَّف هنا للأنواع وحارس `db:verify` فقط.
     */
    cashDropKey: varchar("cashDropKey", { length: 110 }),
    /** ش٥ (§٩.٤): هاتف مُرسِل رصيد الاتصال — مُطبَّع E.164 بserver/lib/phone.ts (اختياريّ:
     *  الآلية الأساس أكواد كروت الشحن في referenceNumber، وهذا لمن حوّل من رقمه مباشرة). */
    telecomSenderPhone: varchar("telecomSenderPhone", { length: 32 }),
    checkNumber: varchar("checkNumber", { length: 50 }),
    cardLastFour: varchar("cardLastFour", { length: 4 }),
    status: mysqlEnum("receiptStatus", [
      "PENDING",
      "COMPLETED",
      "FAILED",
      "REVERSED",
    ])
      .default("COMPLETED")
      .notNull(),
    // ── سندات قبض/صرف مستقلّة (B1): receipts بلا فاتورة بل بطرف خارجي (راتب، إيجار، …) ──
    voucherNumber: varchar("voucherNumber", { length: 50 }).unique(), // RV/PV-branchId-YYYYMMDD-NNNNN
    partyType: mysqlEnum("voucherPartyType", ["CUSTOMER", "SUPPLIER", "OTHER"]),
    partyId: bigint("partyId", { mode: "number" }), // CUSTOMER ⇒ customers.id، SUPPLIER ⇒ suppliers.id، OTHER ⇒ null
    description: text("description"), // وصف الغرض من السند
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    // vouchers-pro (٣٠/٦/٢٦): تَعزيزات تَدقيقية ومحاسبية للسندات المُستقلّة.
    voucherCategoryId: bigint("voucherCategoryId", { mode: "number" }), // FK → voucherCategories (هَجرة 0036)
    counterpartyName: varchar("counterpartyName", { length: 200 }), // اسم الطرف الحُرّ لسندات «أخرى» (راتب الموظف فلان…)
    voucherDate: date("voucherDate"), // تاريخ السند الفعلي (قد يَختلف عن createdAt)
    // attachment-upload (٥/٧): MEDIUMTEXT — كانت TEXT (64KB) تكسر data URLs لصور المُرفق المضغوطة
    // (نمط productImages/workOrderImages). الهجرة 0047.
    attachmentUrl: mediumtext("attachmentUrl"), // data URL صورة مُرفق مضغوطة (إيصال/فاتورة/كَشف بنك)
    internalNote: text("internalNote"), // مُلاحظة داخلية للتدقيق (لا تُطبع)
    signatureHash: varchar("signatureHash", { length: 64 }), // SHA-256 hex لخَتم السند بَعد الاعتماد (سَلامة سجل تَدقيقي)
    approvalStatus: mysqlEnum("receiptApprovalStatus", [
      "APPROVED",
      "PENDING_APPROVAL",
      "REJECTED",
    ])
      .default("APPROVED")
      .notNull(),
    approvedBy: int("approvedBy"), // FK → users (هَجرة 0036)؛ NULL إن لم يَستلزم موافقة
    approvedAt: timestamp("approvedAt"), // وقت الاعتماد
  },
  (table) => ({
    invoiceIdx: index("idx_receipt_invoice").on(table.invoiceId),
    workOrderIdx: index("idx_receipt_wo").on(table.workOrderId),
    reservationIdx: index("idx_receipt_reservation").on(table.reservationId),
    branchIdx: index("idx_receipt_branch").on(table.branchId),
    dateIdx: index("idx_receipt_date").on(table.createdAt),
    voucherIdx: index("idx_receipt_voucher").on(table.voucherNumber),
    partyIdx: index("idx_receipt_party").on(table.partyType, table.partyId),
    // G11 (١٩/٦/٢٦): فهرس shiftId حرج — Z-report لكل إغلاق وردية كان full scan على آلاف الإيصالات يومياً.
    shiftIdx: index("idx_receipt_shift").on(table.shiftId),
    // S0 (٢٩/٦/٢٦): فهرس أُنشئ في 0013 على عمود `bucketId` ثم أسقطه 0017 (حذف نظام دلاء النقد) ⇒ بقي مفقوداً.
    // يُعاد على `cashBucket` عبر هجرة 0030 اليدوية. (snapshot مجمَّد عند 0019 ⇒ لا db:generate — توثيق فقط.)
    bucketStatusIdx: index("idx_receipt_bucket_status").on(
      table.cashBucket,
      table.status,
    ),
    // S1 (٢٩/٦/٢٦): إغلاق Z-report (shiftId+تاريخ)، تسوية الخزينة لكل (فرع+دلو+تاريخ)، تتبّع دفعات الفاتورة. هجرة 0031.
    shiftDateIdx: index("idx_receipt_shift_date").on(
      table.shiftId,
      table.createdAt,
    ),
    bucketDateIdx: index("idx_receipt_bucket_date").on(
      table.cashBucket,
      table.createdAt,
    ),
    invoiceStatusIdx: index("idx_receipt_invoice_status").on(
      table.invoiceId,
      table.status,
    ),
    branchBucketDateIdx: index("idx_receipt_branch_bucket_date").on(
      table.branchId,
      table.cashBucket,
      table.createdAt,
    ),
    // card-account (0098): مسح مقبوضات/مدفوعات البطاقة لكل فرع×تاريخ (رصيد حساب البطاقة المشتقّ) —
    // بلا فهرس كان full scan على receipts بفلتر paymentMethod='CARD'.
    payMethodBranchDateIdx: index("idx_receipt_paymethod_branch_date").on(
      table.paymentMethod,
      table.branchId,
      table.createdAt,
    ),
    // ش٥/0155: قراءات حارس زين القافلة (telecom.ts) — بلا فهرسٍ خادمٍ كان فحص الكود الأحاديّ
    // يقفل X كامل نطاق TELECOM (نموّ غير محدود + تسلسل كل الفروع). الأول يحصر قفل فحص
    // الازدواج بسجلّات/فجوة الكود المعنيّ، والثاني يحصر قفل السقف اليوميّ بالمستخدم×اليوم.
    payMethodRefIdx: index("idx_receipt_paymethod_ref").on(
      table.paymentMethod,
      table.referenceNumber,
    ),
    payMethodUserDateIdx: index("idx_receipt_paymethod_user_date").on(
      table.paymentMethod,
      table.createdBy,
      table.createdAt,
    ),
  }),
);

export type Receipt = typeof receipts.$inferSelect;
export type InsertReceipt = typeof receipts.$inferInsert;

/**
 * عدّ مستقل لعقد حيازة نقدية CD/CH. السجل append-only: المحاولة المختلفة لا تمحو
 * فرقاً سابقاً، والقبول المالي يحصل فقط لسجل MATCHED.
 */
export const cashCustodyCounts = mysqlTable(
  "cashCustodyCounts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    treasuryReceiptId: bigint("treasuryReceiptId", { mode: "number" })
      .notNull()
      .references(() => receipts.id),
    clientRequestId: varchar("clientRequestId", { length: 64 }).notNull(),
    declaredAmount: decimal("declaredAmount", { precision: 15, scale: 2 }).notNull(),
    countedAmount: decimal("countedAmount", { precision: 15, scale: 2 }).notNull(),
    variance: decimal("variance", { precision: 15, scale: 2 }).notNull(),
    countedBreakdown: json("countedBreakdown"),
    status: mysqlEnum("cashCustodyCountStatus", ["MATCHED", "VARIANCE_OPEN"]).notNull(),
    countedByUserId: int("countedByUserId")
      .notNull()
      .references(() => users.id),
    countedAt: timestamp("countedAt").defaultNow().notNull(),
  },
  (table) => ({
    requestUq: unique("uq_cash_custody_count_request").on(
      table.treasuryReceiptId,
      table.clientRequestId,
    ),
    receiptStatusIdx: index("idx_cash_custody_receipt_status").on(
      table.treasuryReceiptId,
      table.status,
    ),
  }),
);

export type CashCustodyCount = typeof cashCustodyCounts.$inferSelect;

/** لقطة الجرد الفعلي للخزينة لفرع ويوم عمل UTC واحد. */
export const cashDailyReconciliations = mysqlTable(
  "cashDailyReconciliations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).notNull(),
    businessDate: date("businessDate", { mode: "string" }).notNull(),
    expectedTreasuryCash: decimal("expectedTreasuryCash", { precision: 15, scale: 2 }).notNull(),
    countedTreasuryCash: decimal("countedTreasuryCash", { precision: 15, scale: 2 }).notNull(),
    variance: decimal("variance", { precision: 15, scale: 2 }).notNull(),
    countedBreakdown: json("countedBreakdown"),
    status: mysqlEnum("cashDailyReconciliationStatus", [
      "MATCHED",
      "VARIANCE_OPEN",
      "RESOLVED_WITH_ADJUSTMENT",
      "CLOSED",
      "REOPENED",
    ]).notNull(),
    notes: varchar("notes", { length: 500 }),
    lastClientRequestId: varchar("lastClientRequestId", { length: 64 }).notNull(),
    closeClientRequestId: varchar("closeClientRequestId", { length: 64 }),
    evidenceHash: varchar("evidenceHash", { length: 64 }).notNull(),
    shiftCount: int("shiftCount").default(0).notNull(),
    custodyCount: int("custodyCount").default(0).notNull(),
    version: int("version").default(1).notNull(),
    countedByUserId: int("countedByUserId").notNull().references(() => users.id),
    countedAt: timestamp("countedAt").defaultNow().notNull(),
    closedByUserId: int("closedByUserId").references(() => users.id),
    closedAt: timestamp("closedAt"),
    reopenedByUserId: int("reopenedByUserId").references(() => users.id),
    reopenedAt: timestamp("reopenedAt"),
    reopenReason: varchar("reopenReason", { length: 500 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    branchDateUq: unique("uq_cash_daily_branch_date").on(table.branchId, table.businessDate),
    requestUq: unique("uq_cash_daily_request").on(table.lastClientRequestId),
    closeRequestUq: unique("uq_cash_daily_close_request").on(table.closeClientRequestId),
    statusDateIdx: index("idx_cash_daily_status_date").on(table.status, table.businessDate),
    branchFk: foreignKey({
      name: "fk_cash_daily_branch",
      columns: [table.branchId],
      foreignColumns: [branches.id],
    }),
  }),
);

export type CashDailyReconciliation = typeof cashDailyReconciliations.$inferSelect;

/**
 * استثناء صفري الأثر ليوم تاريخي فُقد فيه الجرد المادي. لا يمثل جرداً ولا حركةً
 * مالية؛ يحمل بصمة اليوم وربطاً بمطابقة لاحقة مغلقة، ويحتاج طالباً ومراجعاً مختلفين.
 */
export const cashMissedDailyCountExceptions = mysqlTable(
  "cashMissedDailyCountExceptions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).notNull(),
    businessDate: date("businessDate", { mode: "string" }).notNull(),
    carryForwardReconciliationId: bigint("carryForwardReconciliationId", {
      mode: "number",
    }).notNull(),
    carryForwardBusinessDate: date("carryForwardBusinessDate", {
      mode: "string",
    }).notNull(),
    carryForwardVersion: int("carryForwardVersion").notNull(),
    carryForwardEvidenceHash: char("carryForwardEvidenceHash", {
      length: 64,
    }).notNull(),
    missingDayEvidenceHash: char("missingDayEvidenceHash", {
      length: 64,
    }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    evidenceReference: mediumtext("evidenceReference").notNull(),
    status: mysqlEnum("missedDailyCountExceptionStatus", [
      "PENDING",
      "APPROVED",
      "REJECTED",
    ])
      .default("PENDING")
      .notNull(),
    activeBusinessDateKey: varchar("activeBusinessDateKey", { length: 80 }),
    requestClientRequestId: varchar("requestClientRequestId", {
      length: 64,
    }).notNull(),
    requestHash: char("requestHash", { length: 64 }).notNull(),
    immutableEvidenceHash: char("immutableEvidenceHash", {
      length: 64,
    }).notNull(),
    requestedByUserId: int("requestedByUserId").notNull(),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    version: int("version").default(1).notNull(),
    decisionClientRequestId: varchar("decisionClientRequestId", { length: 64 }),
    decisionHash: char("decisionHash", { length: 64 }),
    reviewedByUserId: int("reviewedByUserId"),
    reviewedAt: timestamp("reviewedAt"),
    decisionNote: varchar("decisionNote", { length: 500 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    activeDateUq: unique("uq_cash_missed_daily_active_date").on(
      table.activeBusinessDateKey,
    ),
    requestUq: unique("uq_cash_missed_daily_request").on(
      table.requestClientRequestId,
    ),
    decisionUq: unique("uq_cash_missed_daily_decision").on(
      table.decisionClientRequestId,
    ),
    branchDateIdx: index("idx_cash_missed_daily_branch_date").on(
      table.branchId,
      table.businessDate,
      table.status,
    ),
    carryIdx: index("idx_cash_missed_daily_carry").on(
      table.carryForwardReconciliationId,
      table.carryForwardVersion,
    ),
    branchFk: foreignKey({
      name: "fk_cash_missed_daily_branch",
      columns: [table.branchId],
      foreignColumns: [branches.id],
    }),
    carryFk: foreignKey({
      name: "fk_cash_missed_daily_carry",
      columns: [table.carryForwardReconciliationId],
      foreignColumns: [cashDailyReconciliations.id],
    }),
    requesterFk: foreignKey({
      name: "fk_cash_missed_daily_requester",
      columns: [table.requestedByUserId],
      foreignColumns: [users.id],
    }),
    reviewerFk: foreignKey({
      name: "fk_cash_missed_daily_reviewer",
      columns: [table.reviewedByUserId],
      foreignColumns: [users.id],
    }),
    datesCheck: check(
      "chk_cash_missed_daily_dates",
      sql`${table.carryForwardBusinessDate} > ${table.businessDate}`,
    ),
    versionCheck: check(
      "chk_cash_missed_daily_version",
      sql`${table.version} IN (1, 2) AND ${table.carryForwardVersion} > 0`,
    ),
    decisionShapeCheck: check(
      "chk_cash_missed_daily_decision_shape",
      sql`(
        (${table.status} = 'PENDING' AND ${table.version} = 1 AND ${table.decisionClientRequestId} IS NULL AND ${table.decisionHash} IS NULL AND ${table.reviewedByUserId} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.decisionNote} IS NULL)
        OR
        (${table.status} IN ('APPROVED','REJECTED') AND ${table.version} = 2 AND ${table.decisionClientRequestId} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.reviewedByUserId} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionNote} IS NOT NULL AND ${table.reviewedByUserId} <> ${table.requestedByUserId})
      )`,
    ),
  }),
);

export type CashMissedDailyCountException =
  typeof cashMissedDailyCountExceptions.$inferSelect;

/** سلسلة أحداث immutable تمنع اختزال الطلب والقرار في رأسٍ قابل للاستبدال. */
export const cashMissedDailyCountExceptionEvents = mysqlTable(
  "cashMissedDailyCountExceptionEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    exceptionId: bigint("exceptionId", { mode: "number" }).notNull(),
    version: int("version").notNull(),
    eventType: mysqlEnum("missedDailyCountExceptionEventType", [
      "PROPOSED",
      "APPROVED",
      "REJECTED",
    ]).notNull(),
    clientRequestId: varchar("clientRequestId", { length: 64 }).notNull(),
    requestHash: char("requestHash", { length: 64 }).notNull(),
    actorUserId: int("actorUserId").notNull(),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    requestUq: unique("uq_cash_missed_daily_event_request").on(
      table.clientRequestId,
    ),
    versionUq: unique("uq_cash_missed_daily_event_version").on(
      table.exceptionId,
      table.version,
    ),
    exceptionIdx: index("idx_cash_missed_daily_events_exception").on(
      table.exceptionId,
      table.version,
    ),
    exceptionFk: foreignKey({
      name: "fk_cash_missed_daily_event_exception",
      columns: [table.exceptionId],
      foreignColumns: [cashMissedDailyCountExceptions.id],
    }),
    actorFk: foreignKey({
      name: "fk_cash_missed_daily_event_actor",
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }),
    versionCheck: check(
      "chk_cash_missed_daily_event_version",
      sql`((${table.eventType} = 'PROPOSED' AND ${table.version} = 1) OR (${table.eventType} IN ('APPROVED','REJECTED') AND ${table.version} = 2))`,
    ),
  }),
);

export type CashMissedDailyCountExceptionEvent =
  typeof cashMissedDailyCountExceptionEvents.$inferSelect;

/**
 * مستند دليل فرق نقد غير قابل للتعديل. نخزّن البايتات نفسها لا رابطاً أو وصفاً يكتبه
 * المستخدم، وتُعاد مطابقة sha256 داخل قفل المعاملة عند الاقتراح والقرار.
 */
export const cashVarianceEvidenceDocuments = mysqlTable(
  "cashVarianceEvidenceDocuments",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).notNull(),
    evidenceType: mysqlEnum("evidenceType", ["IMAGE", "PDF"]).notNull(),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    contentType: varchar("contentType", { length: 100 }).notNull(),
    contentHash: char("contentHash", { length: 64 }).notNull(),
    content: mediumblob("content").notNull(),
    createdByUserId: int("createdByUserId").notNull(),
    registrationClientRequestId: varchar("registrationClientRequestId", { length: 64 })
      .notNull()
      .unique("uq_cash_variance_evidence_request"),
    registrationRequestHash: char("registrationRequestHash", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    branchHashUq: unique("uq_cash_variance_evidence_branch_hash").on(
      table.branchId,
      table.contentHash,
    ),
    branchCreatedIdx: index("idx_cash_variance_evidence_branch_created").on(
      table.branchId,
      table.createdAt,
    ),
    branchFk: foreignKey({
      name: "fk_cash_variance_evidence_branch",
      columns: [table.branchId],
      foreignColumns: [branches.id],
    }),
    creatorFk: foreignKey({
      name: "fk_cash_variance_evidence_creator",
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
    }),
    hashCheck: check(
      "chk_cash_variance_evidence_hash",
      sql`${table.contentHash} REGEXP '^[0-9a-fA-F]{64}$'`,
    ),
  }),
);

export type CashVarianceEvidenceDocument =
  typeof cashVarianceEvidenceDocuments.$inferSelect;

/**
 * اقتراح تسوية فرق نقدي. الرأس دليل immutable: لا حالةً قابلة للكتابة هنا؛
 * الحالة والإصدار مشتقان حصراً من آخر حدث append-only في cashVarianceCaseEvents.
 */
export const cashVarianceCases = mysqlTable(
  "cashVarianceCases",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).notNull(),
    sourceType: mysqlEnum("cashVarianceSourceType", [
      "CUSTODY",
      "DAILY_TREASURY",
    ]).notNull(),
    custodyReceiptId: bigint("custodyReceiptId", { mode: "number" }),
    custodyCountId: bigint("custodyCountId", { mode: "number" }),
    dailyReconciliationId: bigint("dailyReconciliationId", {
      mode: "number",
    }),
    /** إصدار مستند المصدر وقت الاقتراح؛ يمنع اعتماد فرقٍ بعد إعادة عد/تغيير الدليل. */
    sourceVersion: int("sourceVersion").default(1).notNull(),
    sourceReference: varchar("sourceReference", { length: 100 }).notNull(),
    /** بصمة دليل مستند المصدر عند الاقتراح؛ إلزامية للمطابقة اليومية وصفر أثر للعهدة. */
    sourceEvidenceHash: char("sourceEvidenceHash", { length: 64 }),
    expectedAmount: decimal("expectedAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    actualAmount: decimal("actualAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    /** actualAmount - expectedAmount؛ السالب عجز والموجب زيادة. */
    variance: decimal("variance", { precision: 15, scale: 2 }).notNull(),
    reasonCode: mysqlEnum("cashVarianceReasonCode", [
      "COUNT_ERROR",
      "UNRECORDED_CASH_IN",
      "UNRECORDED_CASH_OUT",
      "CUSTODY_LOSS",
      "DOCUMENTATION_ERROR",
      "OTHER",
    ]).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    /** وصف بشري فقط؛ المستند الحاكم هو evidenceDocumentId + evidenceContentHash. */
    evidenceReference: varchar("evidenceReference", { length: 2000 }).notNull(),
    evidenceDocumentId: bigint("evidenceDocumentId", { mode: "number" }),
    evidenceContentHash: char("evidenceContentHash", { length: 64 }),
    responsibleUserId: int("responsibleUserId"),
    responsibleEmployeeId: bigint("responsibleEmployeeId", {
      mode: "number",
    }),
    responsibleNameSnapshot: varchar("responsibleNameSnapshot", {
      length: 255,
    }),
    countedByUserId: int("countedByUserId").notNull(),
    proposedByUserId: int("proposedByUserId").notNull(),
    proposalClientRequestId: varchar("proposalClientRequestId", {
      length: 64,
    })
      .notNull()
      .unique("uq_cash_variance_proposal_request"),
    proposalRequestHash: char("proposalRequestHash", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    custodyCountUq: unique("uq_cash_variance_custody_count").on(
      table.custodyCountId,
    ),
    dailyVersionUq: unique("uq_cash_variance_daily_version").on(
      table.dailyReconciliationId,
      table.sourceVersion,
    ),
    branchCreatedIdx: index("idx_cash_variance_branch_created").on(
      table.branchId,
      table.createdAt,
    ),
    branchFk: foreignKey({
      name: "fk_cash_variance_branch",
      columns: [table.branchId],
      foreignColumns: [branches.id],
    }),
    custodyReceiptFk: foreignKey({
      name: "fk_cash_variance_custody_receipt",
      columns: [table.custodyReceiptId],
      foreignColumns: [receipts.id],
    }),
    custodyCountFk: foreignKey({
      name: "fk_cash_variance_custody_count",
      columns: [table.custodyCountId],
      foreignColumns: [cashCustodyCounts.id],
    }),
    dailyFk: foreignKey({
      name: "fk_cash_variance_daily",
      columns: [table.dailyReconciliationId],
      foreignColumns: [cashDailyReconciliations.id],
    }),
    evidenceFk: foreignKey({
      name: "fk_cash_variance_case_evidence",
      columns: [table.evidenceDocumentId],
      foreignColumns: [cashVarianceEvidenceDocuments.id],
    }),
    responsibleFk: foreignKey({
      name: "fk_cash_variance_responsible",
      columns: [table.responsibleUserId],
      foreignColumns: [users.id],
    }),
    responsibleEmployeeFk: foreignKey({
      name: "fk_cash_variance_employee",
      columns: [table.responsibleEmployeeId],
      foreignColumns: [employees.id],
    }),
    counterFk: foreignKey({
      name: "fk_cash_variance_counter",
      columns: [table.countedByUserId],
      foreignColumns: [users.id],
    }),
    proposerFk: foreignKey({
      name: "fk_cash_variance_proposer",
      columns: [table.proposedByUserId],
      foreignColumns: [users.id],
    }),
    sourceShapeCheck: check(
      "chk_cash_variance_source_shape",
      sql`(
        (${table.sourceType} = 'CUSTODY' AND ${table.custodyReceiptId} IS NOT NULL AND ${table.custodyCountId} IS NOT NULL AND ${table.dailyReconciliationId} IS NULL AND ${table.sourceEvidenceHash} IS NULL AND (
          (${table.variance} < 0 AND ${table.responsibleUserId} IS NOT NULL AND ${table.responsibleEmployeeId} IS NOT NULL AND ${table.responsibleNameSnapshot} IS NOT NULL)
          OR (${table.variance} > 0 AND ${table.responsibleUserId} IS NULL AND ${table.responsibleEmployeeId} IS NULL AND ${table.responsibleNameSnapshot} IS NULL)
        ))
        OR
        (${table.sourceType} = 'DAILY_TREASURY' AND ${table.custodyReceiptId} IS NULL AND ${table.custodyCountId} IS NULL AND ${table.dailyReconciliationId} IS NOT NULL AND ${table.sourceEvidenceHash} IS NOT NULL AND ${table.responsibleUserId} IS NULL AND ${table.responsibleEmployeeId} IS NULL AND ${table.responsibleNameSnapshot} IS NULL)
      )`,
    ),
    amountCheck: check(
      "chk_cash_variance_amounts",
      sql`${table.expectedAmount} >= 0 AND ${table.actualAmount} >= 0 AND ${table.variance} <> 0 AND ${table.variance} = ${table.actualAmount} - ${table.expectedAmount}`,
    ),
    sourceVersionCheck: check(
      "chk_cash_variance_source_version",
      sql`${table.sourceVersion} > 0`,
    ),
  }),
);

export type CashVarianceCase = typeof cashVarianceCases.$inferSelect;

/** سجل الحالة الوحيد لتسوية الفرق؛ لا UPDATE ولا DELETE في الخدمة. */
export const cashVarianceCaseEvents = mysqlTable(
  "cashVarianceCaseEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    caseId: bigint("caseId", { mode: "number" }).notNull(),
    version: int("version").notNull(),
    eventType: mysqlEnum("cashVarianceEventType", [
      "PROPOSED",
      "APPROVED",
      "REJECTED",
    ]).notNull(),
    clientRequestId: varchar("clientRequestId", { length: 64 })
      .notNull()
      .unique("uq_cash_variance_event_request"),
    requestHash: char("requestHash", { length: 64 }).notNull(),
    actorUserId: int("actorUserId").notNull(),
    note: varchar("note", { length: 500 }),
    counterAccountRole: mysqlEnum("cashVarianceCounterAccountRole", [
      "EMPLOYEE_ADVANCES",
      "LOSSES",
      "OTHER_LIABILITY",
    ]),
    resolvedVariance: decimal("resolvedVariance", {
      precision: 15,
      scale: 2,
    }),
    adjustmentReceiptId: bigint("adjustmentReceiptId", {
      mode: "number",
    }).unique("uq_cash_variance_adjustment_receipt"),
    accountingEntryId: bigint("accountingEntryId", { mode: "number" })
      .unique("uq_cash_variance_accounting_entry"),
    /** ذمة الموظف الناتجة عن عجز العهدة فقط؛ لا تُنشأ لعجز DAILY أو للزيادة. */
    advanceId: bigint("advanceId", { mode: "number" }).unique(
      "uq_cash_variance_advance",
    ),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    caseVersionUq: unique("uq_cash_variance_case_version").on(
      table.caseId,
      table.version,
    ),
    caseCreatedIdx: index("idx_cash_variance_case_created").on(
      table.caseId,
      table.createdAt,
    ),
    caseFk: foreignKey({
      name: "fk_cash_variance_event_case",
      columns: [table.caseId],
      foreignColumns: [cashVarianceCases.id],
    }),
    actorFk: foreignKey({
      name: "fk_cash_variance_event_actor",
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }),
    receiptFk: foreignKey({
      name: "fk_cash_variance_event_receipt",
      columns: [table.adjustmentReceiptId],
      foreignColumns: [receipts.id],
    }),
    entryFk: foreignKey({
      name: "fk_cash_variance_event_entry",
      columns: [table.accountingEntryId],
      foreignColumns: [accountingEntries.id],
    }),
    advanceFk: foreignKey({
      name: "fk_cash_variance_advance",
      columns: [table.advanceId],
      foreignColumns: [employeeAdvances.id],
    }),
    versionCheck: check(
      "chk_cash_variance_event_version",
      sql`${table.version} > 0`,
    ),
    resolutionShapeCheck: check(
      "chk_cash_variance_resolution_shape",
      sql`(
        (${table.eventType} = 'APPROVED' AND ${table.counterAccountRole} = 'EMPLOYEE_ADVANCES' AND ${table.resolvedVariance} < 0 AND ${table.adjustmentReceiptId} IS NOT NULL AND ${table.accountingEntryId} IS NOT NULL AND ${table.advanceId} IS NOT NULL)
        OR
        (${table.eventType} = 'APPROVED' AND ${table.counterAccountRole} = 'LOSSES' AND ${table.resolvedVariance} < 0 AND ${table.adjustmentReceiptId} IS NOT NULL AND ${table.accountingEntryId} IS NOT NULL AND ${table.advanceId} IS NULL)
        OR
        (${table.eventType} = 'APPROVED' AND ${table.counterAccountRole} = 'OTHER_LIABILITY' AND ${table.resolvedVariance} > 0 AND ${table.adjustmentReceiptId} IS NOT NULL AND ${table.accountingEntryId} IS NOT NULL AND ${table.advanceId} IS NULL)
        OR
        (${table.eventType} <> 'APPROVED' AND ${table.counterAccountRole} IS NULL AND ${table.resolvedVariance} IS NULL AND ${table.adjustmentReceiptId} IS NULL AND ${table.accountingEntryId} IS NULL AND ${table.advanceId} IS NULL)
      )`,
    ),
  }),
);

export type CashVarianceCaseEvent = typeof cashVarianceCaseEvents.$inferSelect;

/**
 * Indexed ownership of an accepted cash-drop source by a shift-funding request.
 * JSON on receipts remains the immutable audit snapshot; this relation is the
 * concurrency and lookup authority, so source reuse never requires a history scan.
 */
export const shiftFundingSourceLinks = mysqlTable(
  "shiftFundingSourceLinks",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestReceiptId: bigint("requestReceiptId", { mode: "number" })
      .notNull()
      .references(() => receipts.id),
    sourceReceiptId: bigint("sourceReceiptId", { mode: "number" })
      .notNull()
      .references(() => receipts.id),
    activeSourceReceiptId: bigint("activeSourceReceiptId", {
      mode: "number",
    }).references(() => receipts.id),
    targetShiftId: bigint("targetShiftId", { mode: "number" })
      .notNull()
      .references(() => shifts.id),
    activeTargetShiftId: bigint("activeTargetShiftId", {
      mode: "number",
    }).references(() => shifts.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    state: mysqlEnum("shiftFundingLinkState", [
      "PENDING",
      "CONSUMED",
      "RELEASED",
    ])
      .default("PENDING")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    requestUnique: unique("uq_shift_funding_link_request").on(
      table.requestReceiptId,
    ),
    activeSourceUnique: unique("uq_shift_funding_link_active_source").on(
      table.activeSourceReceiptId,
    ),
    activeTargetUnique: unique("uq_shift_funding_link_active_target").on(
      table.activeTargetShiftId,
    ),
    targetStateIdx: index("idx_shift_funding_link_target_state").on(
      table.targetShiftId,
      table.state,
    ),
    branchStateIdx: index("idx_shift_funding_link_branch_state").on(
      table.branchId,
      table.state,
    ),
    activeStateCheck: check(
      "chk_shift_funding_link_active_state",
      sql`(
        (${table.state} = 'PENDING' AND ${table.activeSourceReceiptId} IS NOT NULL AND ${table.activeSourceReceiptId} = ${table.sourceReceiptId} AND ${table.activeTargetShiftId} IS NOT NULL AND ${table.activeTargetShiftId} = ${table.targetShiftId})
        OR (${table.state} = 'CONSUMED' AND ${table.activeSourceReceiptId} IS NOT NULL AND ${table.activeSourceReceiptId} = ${table.sourceReceiptId} AND ${table.activeTargetShiftId} IS NULL)
        OR (${table.state} = 'RELEASED' AND ${table.activeSourceReceiptId} IS NULL AND ${table.activeTargetShiftId} IS NULL)
      )`,
    ),
  }),
);

/**
 * محاولة دفع خارجية للكاشيرين العادي والطباعة (0183).
 *
 * المرجع هنا مستقلّ عن `receipts.referenceNumber`: ذلك الحقل قديم ومتعدد الأغراض (سندات/زين/
 * تحويلات)، أما هذا السجل فيمثّل دورة حياة عملية خارجية واحدة. لا تُربط المحاولة بفاتورة/إيصال
 * إلا بعد وصولها إلى CONFIRMED، والربطان فريدان كي تُستهلك مرةً واحدة فقط.
 */
export const externalPaymentAttempts = mysqlTable(
  "externalPaymentAttempts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    channel: mysqlEnum("externalPaymentChannel", [
      "POS",
      "PRINT_POS",
      "SALES_COLLECTION",
    ]).notNull(),
    paymentMethod: mysqlEnum("externalPaymentMethod", [
      "CARD",
      "CHECK",
      "TRANSFER",
      "WALLET",
    ]).notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    /** هوية مسار المزود والحساب مشتقتان خادمياً، لا يرسلهما العميل. */
    providerCode: varchar("providerCode", { length: 32 }).notNull(),
    accountReference: varchar("accountReference", { length: 80 }).notNull(),
    /** كود محطة POS المحلي؛ إلزامي لكل محاولة كي لا يصبح المرجع عائماً بين الأجهزة. */
    deviceId: varchar("deviceId", { length: 64 }).notNull(),
    externalReference: varchar("externalReference", { length: 100 }).notNull(),
    /** UPPER(TRIM(reference)) محفوظ صراحةً لتفرّد حتمي مستقل عن collation. */
    normalizedReference: varchar("normalizedReference", {
      length: 100,
    }).notNull(),
    state: mysqlEnum("externalPaymentState", [
      "INITIATED",
      "CONFIRMED",
      "FAILED",
      "REVERSED",
    ])
      .default("INITIATED")
      .notNull(),
    requestId: varchar("requestId", { length: 80 }).notNull(),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    confirmedBy: int("confirmedBy").references(() => users.id),
    confirmedAt: timestamp("confirmedAt"),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(
      () => invoices.id,
    ),
    receiptId: bigint("receiptId", { mode: "number" }).references(
      () => receipts.id,
    ),
    consumedAt: timestamp("consumedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    /** مرجع المزود فريد عالمياً بعد التطبيع، مهما تغيّر الفرع أو الطريقة أو قناة البيع. */
    referenceUq: unique("uq_extpay_reference").on(table.normalizedReference),
    requestUq: unique("uq_extpay_request").on(table.createdBy, table.requestId),
    invoiceIdx: index("idx_extpay_invoice").on(table.invoiceId),
    receiptUq: unique("uq_extpay_receipt").on(table.receiptId),
    branchStateIdx: index("idx_extpay_branch_state").on(
      table.branchId,
      table.state,
      table.createdAt,
    ),
    amountPositiveCheck: check(
      "chk_extpay_amount_positive",
      sql`${table.amount} > 0`,
    ),
    normalizedReferenceCheck: check(
      "chk_extpay_reference_normalized",
      sql`${table.normalizedReference} = UPPER(TRIM(${table.externalReference})) AND ${table.normalizedReference} <> ''`,
    ),
    confirmedEvidenceCheck: check(
      "chk_extpay_confirmed_evidence",
      sql`${table.state} NOT IN ('CONFIRMED','REVERSED') OR (${table.confirmedBy} IS NOT NULL AND ${table.confirmedAt} IS NOT NULL)`,
    ),
    consumptionCompleteCheck: check(
      "chk_extpay_consumption_complete",
      sql`(${table.invoiceId} IS NULL AND ${table.receiptId} IS NULL AND ${table.consumedAt} IS NULL)
        OR (${table.invoiceId} IS NOT NULL AND ${table.receiptId} IS NOT NULL AND ${table.consumedAt} IS NOT NULL
          AND ${table.state} IN ('CONFIRMED','REVERSED'))`,
    ),
  }),
);

export type ExternalPaymentAttempt =
  typeof externalPaymentAttempts.$inferSelect;
export type InsertExternalPaymentAttempt =
  typeof externalPaymentAttempts.$inferInsert;

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
    direction: mysqlEnum("voucherCategoryDirection", ["IN", "OUT", "BOTH"])
      .default("BOTH")
      .notNull(),
    /**
     * الحساب المقابل لسند OTHER: في القبض يُدائن، وفي الصرف يُمدن.
     * varchar مقصود بدل enum حتى تبقى إضافة أدوار شجرة الحسابات بهجرةٍ مستقلة؛
     * قيد CHECK والخدمة يحصرانه في الأدوار الآمنة المتوافقة مع الاتجاه.
     */
    postingRole: varchar("postingRole", { length: 64 }),
    description: varchar("description", { length: 300 }),
    isActive: boolean("isActive").default(true).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    activeIdx: index("idx_vchcat_active").on(table.isActive),
    dirIdx: index("idx_vchcat_dir").on(table.direction),
    postingRoleCheck: check(
      "chk_vchcat_posting_role",
      sql`${table.postingRole} IS NULL OR (
        (${table.direction} = 'IN' AND ${table.postingRole} IN ('OTHER_REVENUE','CAPITAL','OWNER_CURRENT','LOAN_PAYABLE','OTHER_LIABILITY'))
        OR (${table.direction} = 'OUT' AND ${table.postingRole} IN ('OWNER_CURRENT','LOAN_PAYABLE','OTHER_LIABILITY','SALARIES','RENT','UTILITIES','OPERATING_EXPENSE','DELIVERY_EXPENSE','GIFTS_PROMO','LOSSES','OTHER_EXPENSE'))
        OR (${table.direction} = 'BOTH' AND ${table.postingRole} IN ('OWNER_CURRENT','LOAN_PAYABLE','OTHER_LIABILITY'))
      )`,
    ),
  }),
);

export type VoucherCategory = typeof voucherCategories.$inferSelect;
export type InsertVoucherCategory = typeof voucherCategories.$inferInsert;

/* ==================== مطابقة حساب البطاقة/البنك (card-account) ====================
 * لقطات مطابقة رصيد البطاقة **المشتقّ** (Σ receipts paymentMethod='CARD') مع كشف البنك عند تاريخٍ
 * محدَّد — سجلٌّ تدقيقيٌّ لا يمسّ أيّ رصيد (لا جدول رصيد مخزَّن؛ نمط الخزينة/الدرج القائم). الهجرة 0098.
 * راجع server/services/cardAccountService.ts. */
export const cardReconciliations = mysqlTable(
  "cardReconciliations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** ش٥: نوع الحساب المُطابَق — بطاقة/بنك أو رصيد زين (نواةٌ واحدة معمَّمة لا مرآة منسوخة). */
    accountKind: mysqlEnum("accountKind", ["CARD", "TELECOM"])
      .default("CARD")
      .notNull(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    asOfDate: date("asOfDate", { mode: "string" }).notNull(), // تاريخ الكشف (رصيد النظام محسوب حتى نهاية يومه)
    systemBalance: decimal("systemBalance", {
      precision: 15,
      scale: 2,
    }).notNull(), // رصيد النظام المتوقَّع (محسوب خادمياً)
    statementBalance: decimal("statementBalance", {
      precision: 15,
      scale: 2,
    }).notNull(), // رصيد كشف البنك المُدخَل يدوياً
    difference: decimal("difference", { precision: 15, scale: 2 }).notNull(), // systemBalance − statementBalance
    statementLabel: varchar("statementLabel", { length: 120 }),
    note: text("note"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    // ش٥ (F8 — لا قيد UNIQUE على الجدول): الفهرس وُسِّع بنوع الحساب ليخدم «آخر مطابقة زين».
    // branchId يتصدّر (لا accountKind): فهرس FK الفرع — إسقاطه بلا بديلٍ متصدّرٍ به يفشل ER_1553.
    branchIdx: index("idx_cardrecon_branch").on(
      table.branchId,
      table.accountKind,
      table.asOfDate,
    ),
    createdIdx: index("idx_cardrecon_created").on(table.createdAt),
  }),
);

export type CardReconciliation = typeof cardReconciliations.$inferSelect;
export type InsertCardReconciliation = typeof cardReconciliations.$inferInsert;

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
    entryType: mysqlEnum("entryType", [
      "SALE",
      "PURCHASE",
      "PAYMENT_IN",
      "PAYMENT_OUT",
      "RETURN",
      "ADJUST",
      "OPENING",
      "INTERNAL_USE",
      "WASTAGE",
      "CASH_HANDOVER",
      "CASH_TRANSFER_OUT",
      "CASH_TRANSFER_IN",
      "DELIVERY_DISPATCH",
      "DELIVERY_REMIT",
      "DELIVERY_FEE",
      // ٥/٨ — أجرة توصيل قُبضت في الدرج **أمانةً** للمندوب: حركة نقدٍ بلا إيراد ولا مصروف
      // (تمرير). تُبرَّأ عند خصمها من توريد المندوب. تُميَّز عن DELIVERY_FEE (مصروف حقيقيّ حين
      // تتحمّلها المكتبة) كي لا يختلط الالتزام بالمصروف في التقارير.
      "DELIVERY_FEE_HELD",
      "DELIVERY_WRITEOFF",
      "EXCHANGE_DEPOSIT",
      "EXCHANGE_WITHDRAW",
      "EXCHANGE_FX_BUY",
      "EXCHANGE_SETTLE",
      "EXCHANGE_FEE",
      "EXCHANGE_FX_DIFF",
      "GIFT_OUT",
      "SHIFT_FLOAT_OUT",
      "TREASURY_FUNDING",
      "DIGITAL_WALLET_DEPOSIT",
      "DIGITAL_WALLET_WITHDRAWAL",
      "DIGITAL_WALLET_CONSUMPTION",
      "DIGITAL_WALLET_REVERSAL",
      "DIGITAL_WALLET_ADJUSTMENT",
      "DIGITAL_WRITEOFF",
    ]).notNull(),
    /** Immutable evidence of the explicit P2 posting decision (null for legacy/unmapped rows). */
    postingProfile: varchar("postingProfile", { length: 64 }),
    postingIntentJson: json("postingIntentJson"),
    postingIntentHash: char("postingIntentHash", { length: 64 }),
    /** Exact SHADOW/ACTIVE cycle that owned this persisted posting evidence. */
    postingCycleId: varchar("postingCycleId", { length: 36 }),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(
      () => invoices.id,
    ),
    // F1 (تدقيق ٢/٧): أُضيف FK ⇒ purchaseOrderId يشير لأمر شراء موجود (تكامل مرجعيّ). الهجرة 0040.
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" }).references(
      () => purchaseOrders.id,
    ),
    /**
     * تصنيف التزام أمر الشراء المستقل عن وضع الدفتر المزدوج. NULL = قيد تاريخي/AP؛
     * CASH_CLEARING يمنع خلط تسوية الشراء النقدي بذمة المورد حتى في وضع OFF.
     */
    purchaseLiabilityAccount: mysqlEnum("purchaseLiabilityAccount", [
      "AP",
      "CASH_CLEARING",
    ]),
    receiptId: bigint("receiptId", { mode: "number" }).references(
      () => receipts.id,
    ),
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
    ),
    supplierId: bigint("supplierId", { mode: "number" }).references(
      () => suppliers.id,
    ),
    // delivery-cod: طرف جهة التوصيل لقيود العهدة DELIVERY_* — نظير customerId/supplierId.
    // يبقى بلا .references (طرف التوصيل قد يكون عميلاً أو مندوباً خارجياً — لا جدول أمّ وحيد). يُمكّن مطابقة العهدة بـGROUP BY.
    deliveryPartyId: bigint("deliveryPartyId", { mode: "number" }),
    // exchange-house: طرف الصيرفة لقيود EXCHANGE_*. F1 (تدقيق ٢/٧): أُضيف FK ⇒ يشير لصيرفة موجودة. الهجرة 0040.
    exchangeHouseId: bigint("exchangeHouseId", { mode: "number" }).references(
      () => exchangeHouses.id,
    ),
    // digital-cards: طرف المحفظة الرقمية لقيود DIGITAL_WALLET_*.
    digitalWalletId: bigint("digitalWalletId", { mode: "number" }),
    revenue: decimal("revenue", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    cost: decimal("cost", { precision: 15, scale: 2 }).default("0").notNull(),
    profit: decimal("profit", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    entryDate: date("entryDate").notNull(),
    notes: text("notes"),
    // حارس بنيوي ضدّ التكرار: مثل «SALE:<invoiceId>» ⇒ قيد SALE واحد لكل فاتورة على مستوى القاعدة.
    // UNIQUE يسمح بـNULL متعدّد، فالقيود التي تتكرّر مشروعاً (دفعات/مرتجعات) تتركه NULL.
    dedupeKey: varchar("dedupeKey", { length: 80 }).unique("uq_entry_dedupe"),
    // منفّذ القيد ولقطة اسمه؛ تُملآن حالياً في مرتجعات البيع لتمييز منفّذ المرتجع عن البائع.
    createdBy: int("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByNameSnapshot: varchar("createdByNameSnapshot", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    typeIdx: index("idx_entry_type").on(table.entryType),
    postingCycleIdx: index("idx_entry_posting_cycle").on(table.postingCycleId),
    invoiceIdx: index("idx_entry_invoice").on(table.invoiceId),
    dateIdx: index("idx_entry_date").on(table.entryDate),
    supplierIdx: index("idx_entry_supplier").on(table.supplierId),
    customerIdx: index("idx_entry_customer").on(table.customerId),
    // G11 (١٩/٦/٢٦): فهرس branchId حرج — GL/P&L/الميزانية/كشوف الحساب تستعلم على branchId،
    // كان full scan على مليون قيد لكل تقرير.
    branchIdx: index("idx_entry_branch").on(table.branchId),
    deliveryPartyIdx: index("idx_entry_delivery_party").on(
      table.deliveryPartyId,
    ),
    // exchange-house: كشف حساب الصيرفة + تقارير العمولة/فرق الصرف لكل صيرفة بالتاريخ.
    exchangeIdx: index("idx_entry_exchange").on(table.exchangeHouseId),
    exchangeDateIdx: index("idx_entry_exchange_date").on(
      table.exchangeHouseId,
      table.entryDate,
    ),
    // S1 (٢٩/٦/٢٦): شريان GL/P&L — (فرع+نوع+تاريخ)؛ وكشوف حساب العميل/المورّد بالتاريخ. هجرة 0031.
    branchTypeDateIdx: index("idx_entry_branch_type_date").on(
      table.branchId,
      table.entryType,
      table.entryDate,
    ),
    customerDateIdx: index("idx_entry_customer_date").on(
      table.customerId,
      table.entryDate,
    ),
    supplierDateIdx: index("idx_entry_supplier_date").on(
      table.supplierId,
      table.entryDate,
    ),
    // commissions (٦/٧/٢٦): كنسة محرّك العمولات الشهرية شركةً كاملةً — entryType IN (SALE,RETURN)
    // بنطاق شهر على entryDate بلا فرع ⇒ idx_entry_branch_type_date (يبدأ بالفرع) لا يخدمها. هجرة 0051.
    typeDateIdx: index("idx_entry_type_date").on(
      table.entryType,
      table.entryDate,
    ),
    // digital-cards: كشف حساب المحفظة الرقمية بالتاريخ.
    digitalWalletDateIdx: index("idx_entry_digital_wallet_date").on(
      table.digitalWalletId,
      table.entryDate,
    ),
  }),
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
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
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
    ])
      .default("OTHER")
      .notNull(),
    /**
     * الفئة المُدارة (هجرة 0203) — التصنيف التشغيليّ الذي يختاره المستخدم. الدلو أعلاه يبقى
     * مصدر الحقيقة المحاسبيّ ويُشتقّ من `expenseCategories.bucket` عند الكتابة، فلا ينحرفان.
     * NULL ممكنٌ للسجلّات التاريخية التي لم تُردَم (لا شيء يتعطّل بغيابها).
     */
    expenseCategoryId: bigint("expenseCategoryId", { mode: "number" }),
    // 0018: DB-level CHECK (amount >= 0) أُضيف في migration 0018.
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    paymentMethod: mysqlEnum("expensePaymentMethod", [
      "CASH",
      "CARD",
      "CHECK",
      "TRANSFER",
      "WALLET",
      "ACCRUAL",
    ])
      .default("CASH")
      .notNull(),
    // cash-treasury-mode: مرآة receipts.cashBucket — DRAWER=درج كاشير، TREASURY=خزينة إدارية.
    cashBucket: mysqlEnum("expenseCashBucket", ["DRAWER", "TREASURY"]),
    // production-slice: مصدر الصرف — CASH=نقدي (الموجود، يخصم الصندوق)، STOCK=صرف من المخزون بالكلفة (نثرية/تلف، بلا صندوق).
    source: mysqlEnum("expenseSource", ["CASH", "STOCK", "ACCRUAL"])
      .default("CASH")
      .notNull(),
    // مع source=STOCK فقط: INTERNAL_USE=نثرية داخلية (مصروف)، WASTAGE=تلف (خسارة). NULL لـCASH.
    stockReason: mysqlEnum("expenseStockReason", ["INTERNAL_USE", "WASTAGE"]),
    description: text("description"),
    referenceNumber: varchar("referenceNumber", { length: 100 }),
    // v3-add-screens: جهة الصرف + مركز التكلفة + علم متكرّر + دورية التكرار.
    payee: varchar("payee", { length: 200 }),
    costCenter: varchar("costCenter", { length: 80 }),
    isRecurring: boolean("isRecurring").default(false),
    recurringFrequency: mysqlEnum("recurringFrequency", [
      "DAILY",
      "WEEKLY",
      "MONTHLY",
      "QUARTERLY",
      "YEARLY",
    ]),
    receiptId: bigint("receiptId", { mode: "number" }).references(
      () => receipts.id,
    ),
    // دورة المصروف المالي: الكبير/غير النثري يُنشأ بلا أثر ثم يفعّله اعتماد المالك.
    // ACTIVE وحدها تعني أن الإيصال والقيد ومصدر الدفع نُفّذت فعلاً.
    status: mysqlEnum("expenseStatus", [
      "PENDING_APPROVAL",
      "ACTIVE",
      "REJECTED",
      "CANCELLED",
    ])
      .default("ACTIVE")
      .notNull(),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    branchIdx: index("idx_expense_branch").on(table.branchId),
    dateIdx: index("idx_expense_date").on(table.expenseDate),
    categoryIdx: index("idx_expense_category").on(table.category),
    managedCategoryIdx: index("idx_expense_managed_category").on(
      table.expenseCategoryId,
    ),
    statusIdx: index("idx_expense_status").on(table.status),
    accrualMethodCheck: check(
      "chk_expense_accrual_method",
      sql`(
        (${table.source} = 'ACCRUAL' AND ${table.paymentMethod} = 'ACCRUAL') OR
        (${table.source} <> 'ACCRUAL' AND ${table.paymentMethod} <> 'ACCRUAL')
      )`,
    ),
  }),
);

export type Expense = typeof expenses.$inferSelect;
export type InsertExpense = typeof expenses.$inferInsert;

/* ==================== فئات المصروفات المُدارة (هجرة 0203) ====================
 * طبقةٌ تشغيلية فوق `expenses.expenseCategory` لا بديلٌ عنه: الـENUM يبقى **الدلو المحاسبيّ**
 * الذي يشتقّ منه `expenseRole()` حسابَ الدفتر وتطابقه استعلاماتُ إقفال الشهر نصّاً، بينما هذا
 * الجدول يمنح المالك تصنيفاً دقيقاً يديره بنفسه (وقود/أحبار/مولّدة…). كل فئة تُعلن دلوها،
 * والمصروف يكتب الاثنين معاً ⇒ صفر تغيير في الدفتر والتقارير والإقفال.
 * لا تُحذف فئة بل تُعطَّل، ولا يتغيّر دلوها بعد ارتباطها بمصروف (حفاظاً على أثر التدقيق).
 */
export const expenseCategories = mysqlTable(
  "expenseCategories",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 100 }).notNull().unique(),
    /** الدلو المحاسبيّ — نفس قائمة `expenses.expenseCategory` حرفياً. */
    bucket: mysqlEnum("expenseCategoryBucket", [
      "RENT",
      "UTILITIES",
      "SUPPLIES",
      "SALARY",
      "TRANSPORT",
      "MAINTENANCE",
      "MARKETING",
      "OTHER",
    ]).notNull(),
    description: varchar("description", { length: 300 }),
    isActive: boolean("isActive").default(true).notNull(),
    /**
     * فئة الدلو الاحتياطية: يُسنَد إليها أي طلبٍ قديم يحمل الدلو وحده (أندرويد/أوفلاين/استيراد)
     * فلا يبقى مصروفٌ بلا فئة مُدارة. تضبطها الهجرة ولا تُدار من الواجهة، وتُمنع من التعطيل.
     */
    isBucketDefault: boolean("isBucketDefault").default(false).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    activeIdx: index("idx_expcat_active").on(table.isActive),
    bucketIdx: index("idx_expcat_bucket").on(
      table.bucket,
      table.isBucketDefault,
    ),
  }),
);

// اسمٌ بلاحقة Row عمداً: `ExpenseCategory` محجوزٌ في expenseService لاتّحاد الدلاء الثمانية
// (النوع المحاسبيّ)، وخلطهما في ملفٍ واحد يُنتج تصادماً صامتاً في القراءة قبل المترجم.
export type ExpenseCategoryRow = typeof expenseCategories.$inferSelect;
export type InsertExpenseCategoryRow = typeof expenseCategories.$inferInsert;

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
    transferNumber: varchar("transferNumber", { length: 50 })
      .notNull()
      .unique(), // CT-fromBranch-YYYYMMDD-NNNNN
    fromBranchId: bigint("fromBranchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    toBranchId: bigint("toBranchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(), // DB CHECK > 0 (migration manual)
    status: mysqlEnum("cashTransferStatus", [
      "IN_TRANSIT",
      "RECEIVED",
      "CANCELLED",
    ])
      .default("IN_TRANSIT")
      .notNull(),
    sentBy: int("sentBy")
      .notNull()
      .references(() => users.id),
    receivedBy: int("receivedBy").references(() => users.id),
    cancelledBy: int("cancelledBy").references(() => users.id),
    sentAt: timestamp("sentAt").defaultNow().notNull(),
    receivedAt: timestamp("receivedAt"),
    cancelledAt: timestamp("cancelledAt"),
    sentReceiptId: bigint("sentReceiptId", { mode: "number" }).references(
      () => receipts.id,
    ),
    receivedReceiptId: bigint("receivedReceiptId", {
      mode: "number",
    }).references(() => receipts.id),
    reversalReceiptId: bigint("reversalReceiptId", {
      mode: "number",
    }).references(() => receipts.id),
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
  }),
);

export type CashTransfer = typeof cashTransfers.$inferSelect;
export type InsertCashTransfer = typeof cashTransfers.$inferInsert;

/* ============================ أوامر الشغل / التخصيص / المطبعة ============================ */

export const workOrders = mysqlTable(
  "workOrders",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    orderNumber: varchar("orderNumber", { length: 50 }).notNull().unique(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
    ),
    // المنتج الأساس الخام (درع زجاجي/خشبي) — قد يكون null لخدمة طباعة صرفة.
    baseVariantId: bigint("baseVariantId", { mode: "number" }).references(
      () => productVariants.id,
    ),
    title: varchar("title", { length: 255 }).notNull(),
    customizationText: text("customizationText"),
    quantity: int("quantity").default(1).notNull(),
    materialsCost: decimal("materialsCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    laborCost: decimal("laborCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    salePrice: decimal("salePrice", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // v3-add-screens: قناة الاستلام + معرّفها (handle).
    receptionChannel: mysqlEnum("receptionChannel", [
      "WALK_IN",
      "WHATSAPP",
      "INSTAGRAM",
      "TIKTOK",
      "PHONE",
      "OTHER",
    ]).default("WALK_IN"),
    channelHandle: varchar("channelHandle", { length: 120 }),
    // v3-add-screens: أولوية، عربون، الدفع (نقدي/بطاقة/تحويل) + المرجع + إيصال.
    priority: mysqlEnum("woPriority", ["LOW", "NORMAL", "URGENT"]).default(
      "NORMAL",
    ),
    deposit: decimal("deposit", { precision: 15, scale: 2 }).default("0"),
    // ش٥: TELECOM — عربونٌ بأيّ طريقة (م٢) يشمل رصيد زين؛ توسيع enum قائم = 0154 + extras (V10).
    // صدق طريقة الدفع (١٨/٨، هجرة 0210): بلا افتراض — الطريقة تخصّ **العربون**، وأمرٌ بلا
    // عربون يبقى NULL. كان `default("CASH")` يسحق null الصريح فيُقرأ أمرٌ لم يُقبض فيه دينار
    // كأنّه «دُفع نقداً» (بلاغ المالك: «جميع الفواتير تظهر نقدية»).
    paymentMethod: mysqlEnum("woPaymentMethod", [
      "CASH",
      "CARD",
      "TRANSFER",
      "WALLET",
      "TELECOM",
    ]),
    // paymentMode (٢٨/٨/٢٦، هجرة 0276): يتشقّق «متى يُتوقَّع دفعُ ما تبقّى» عن «كيف قُبض العربون».
    // القيَم نفسها كـinvoices.paymentMode (مصدر ذخيرة مشترك). أمر شغلٍ بـpaymentMode='COD' يعني
    // المندوب سيُحصِّل عند التسليم — يُتجاوز فحصُ حدّ الائتمان في workOrder.deliver.
    // اسم العمود = "paymentMode" (يطابق الهجرة SQL 0276 و invoices.paymentMode). Drizzle
    // mysqlEnum inline (لا نوعاً معرَّفاً)، فلا تعارض بين جدولَين يحملان عموداً بنفس الاسم.
    paymentMode: mysqlEnum("paymentMode", ["PREPAID", "COD", "CREDIT"])
      .default("PREPAID")
      .notNull(),
    paymentReference: varchar("paymentReference", { length: 100 }),
    // v3-add-screens(100%): TEXT لاستيعاب data URLs (≥100KB) عند الترميز المضمَّن.
    paymentReceiptUrl: text("paymentReceiptUrl"),
    // ش٠ (٥/٨، V3): هويّة إيصال العربون الصريحة — تُكتب لحظة قبضه في createWorkOrderInTx.
    // كان الالتقاط ظنّياً بـ`.limit(1)` على (workOrderId, IN, invoiceId NULL) فيتصادم مع إيصال
    // أجرة COUNTER (نفس البصمة) ⇒ إلغاء الأمر قد يردّ مبلغ الأجرة بدل العربون، والتسليم قد يربط
    // الإيصال الخاطئ بالفاتورة. بلا FK (receipts يشير إلى workOrders أصلاً — نتجنّب حلقة FK).
    depositReceiptId: bigint("depositReceiptId", { mode: "number" }),
    // v3-add-screens: التوصيل.
    hasDelivery: boolean("hasDelivery").default(false),
    deliveryAddress: text("deliveryAddress"),
    deliveryCost: decimal("deliveryCost", { precision: 15, scale: 2 }).default(
      "0",
    ),
    // هاتف مستلم التوصيل — مصدر حقيقة قابل للاستعلام (كان محصوراً بنصّ customizationText الحرّ).
    // يُقرأ افتراضياً عند إرسال المندوب (delivery/dispatch.ts) إن لم يُمرَّر صراحةً.
    deliveryPhone: varchar("deliveryPhone", { length: 20 }),
    // ٥/٨ — أجرة التوصيل تمريرٌ لا إيراد (قرار المالك): مَن يقبضها يُحدَّد لكل طلب.
    //   COURIER = المندوب يقبضها من الزبون (الافتراضي) ⇒ لا تمرّ بالدرج ولا بدفترنا إطلاقاً.
    //   COUNTER = الكاشير قبضها مقدّماً ⇒ تدخل الدرج **أمانةً** (التزام) وتُنقَص من توريد المندوب.
    //   SHOP    = المكتبة تتحمّلها (توصيل مجّاني للزبون) ⇒ مصروفٌ حقيقيّ عند التوريد.
    deliveryFeeCollection: mysqlEnum("deliveryFeeCollection", [
      "COURIER",
      "COUNTER",
      "SHOP",
    ])
      .default("COURIER")
      .notNull(),
    // زبون عابر بلا سجلّ عميل: اسمٌ وهاتفٌ مرجعيّان للطلب (طباعة/اتصال/تحويل للتوصيل).
    // لا يُنشئان عميلاً ولا ذمّة — customerId يبقى NULL ما لم يُحفَظ العميل صراحةً.
    contactName: varchar("contactName", { length: 255 }),
    contactPhone: varchar("contactPhone", { length: 32 }),
    status: mysqlEnum("workOrderStatus", [
      "RECEIVED",
      "IN_PROGRESS",
      "READY",
      "DELIVERED",
      "CANCELLED",
    ])
      .default("RECEIVED")
      .notNull(),
    /**
     * الموجة ١ (0292، ٣٠/٨/٢٦) — إشارةُ الفنّيّ **داخل** المرحلة، متعامدةٌ على `status`.
     * NORMAL = افتراض · READY = «جاهز للانتقال للتالية» · BLOCKED = «معطَّل + سبب».
     * ⛔ ليست حاكماً مالياً — القراراتُ المحاسبية تبقى على `status` وحدها.
     * القاموس الحاكم: [`shared/workOrderKanban.ts`](../shared/workOrderKanban.ts).
     */
    // اسمُ العمود مطابقٌ للـSQL في الهجرة (`kanbanState` بلا بادئة `wo`) — أوّل معامل
    // `mysqlEnum` هو اسم العمود لا اسم النوع، وانحرافُه يُسقط على الإنتاج وحده (يمسكه
    // `check:schema-drift`). لا تعارض: لا جدول آخر يحمل عموداً بهذا الاسم.
    kanbanState: mysqlEnum("kanbanState", ["NORMAL", "READY", "BLOCKED"])
      .default("NORMAL")
      .notNull(),
    /** يُفرض غير-فارغ في `setKanbanState` حين kanbanState = BLOCKED. */
    blockedReason: varchar("blockedReason", { length: 255 }),
    /**
     * ش٤ (0219) — سببُ الإلغاء ووقتُه وفاعله. نظيرُها موجودٌ في `receptionDrafts` و
     * `onlineOrders` وكان غائباً عن `workOrders` وحده، فيذوب «لم يحضر العميل» في إلغاءٍ
     * مجهول السبب. ⛔ ولا عمودَ **رمزٍ** ثانٍ: تقرير «لم يحضر أصحابها» يُشتقّ من عمر
     * الجاهزية (`workStartedAt + workSeconds`) — العمودُ للمساءلة والتقريرُ اشتقاق.
     */
    cancelReason: varchar("cancelReason", { length: 500 }),
    cancelledAt: timestamp("cancelledAt"),
    cancelledBy: int("cancelledBy").references(() => users.id),
    /**
     * ش٥ (0220) — **الطلبُ الجامع**: أوامرُ السلّة الواحدة تصير إخوة. لا كيانَ «طلب» جديد —
     * المسوّدة هي الطلب ولها `draftNumber`. والاشتقاق من `clientRequestId` **أحاديُّ
     * الاتجاه**: أمرُ الشغل لا يحمله، والربط في `idempotencyKeys` بـ`refId` **بلا فهرس** ⇒
     * سؤال «ما إخوةُ هذا الأمر؟» مسحٌ كاملٌ لجدولٍ ينمو بلا حدّ.
     */
    // ⚠️ بلا `.references()` **عمداً**: الثلاثة تُشكّل دورةً في استنتاج الأنواع
    //    (conversations ← workOrders ← receptionDrafts ← conversations) فينهار النوع إلى `any`
    //    ويسقط `pnpm check` في ملفّاتٍ لا علاقة لها. والمفتاح الأجنبيّ **مفروضٌ في القاعدة**
    //    بـ`fk_wo_draft` (هجرة 0220) — والهجرات مكتوبةٌ يدوياً هنا لا مولَّدةً من المخطّط.
    draftId: bigint("draftId", { mode: "number" }),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(
      () => invoices.id,
    ),
    assignedTo: int("assignedTo").references(() => users.id),
    dueDate: date("dueDate"),
    // تَتبّع زَمن التَنفيذ الفِعلي (شَريحة #4 backend gaps):
    // workStartedAt يُكتَب عند startWorkOrder، workSeconds يُحسَب عند markWorkOrderReady
    // (= TIMESTAMPDIFF(SECOND, workStartedAt, NOW())). يَستبدل اشتقاق المؤقّت من auditLogs.
    workStartedAt: timestamp("workStartedAt"),
    workSeconds: int("workSeconds"),
    deliveredAt: timestamp("deliveredAt"),
    // تحرير بنود الأمر (0199) — التمييز البصريّ «مُعدَّل» الذي طلبه المالك (١٧/٨/٢٦).
    // ⚠️ لا يصحّ اشتقاقه من `updatedAt`: ذاك يتحرّك مع **كل** كتابة (تغيّر حالة، سحب، إسناد)
    // فيصبح كل أمرٍ «معدَّلاً» ويفقد الوسم معناه. هذه الأعمدة تُكتب من مسار تحرير البنود وحده.
    materialsEditedAt: timestamp("materialsEditedAt"),
    materialsEditedBy: int("materialsEditedBy").references(() => users.id),
    /** عدّاد تحريرات البنود — يميّز «عُدِّل مرّة» من «عُدِّل ٤ مرات» في المتابعة والتدقيق. */
    materialsEditCount: int("materialsEditCount").default(0).notNull(),
    /**
     * نسخة تحكّم متفائلة لكلّ كتابة على أمر الشغل. ترفعها قاعدة البيانات من trigger موحّد
     * كي تشمل جميع الكتّاب، لا مسارات الواجهة الجديدة وحدها. طلبات التعديل/الإلغاء تحفظ
     * baseVersion وتفشل STALE إن تغيّر الأمر قبل الاعتماد.
     */
    version: int("version").default(1).notNull(),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_wo_number").on(table.orderNumber),
    branchIdx: index("idx_wo_branch").on(table.branchId),
    customerIdx: index("idx_wo_customer").on(table.customerId),
    statusIdx: index("idx_wo_status").on(table.status),
    // الموجة ١ (0292): KPIs العمود تجمع `count + sum + late` مقسّمةً على (status, kanbanState).
    statusKanbanIdx: index("idx_wo_status_kanban").on(table.status, table.kanbanState),
    // commissions (٦/٧/٢٦): يقسّي علاقة 1:1 أمر شغل↔فاتورة التسليم التي يعتمدها الإسناد الذكي
    // (فاتورة WORKORDER تُنسَب لمنشئ أمر الشغل عبر join على invoiceId) — تعدّد NULL مسموح.
    // ⚠ invoiceId عمود FK — drizzle-kit قد يُسقط UNIQUE عليه صامتاً؛ دقّق هجرة 0051 يدوياً.
    invoiceUq: unique("uq_wo_invoice").on(table.invoiceId),
    depositReceiptIdx: index("idx_wo_deposit_receipt").on(
      table.depositReceiptId,
    ),
  }),
);

export type WorkOrder = typeof workOrders.$inferSelect;
export type InsertWorkOrder = typeof workOrders.$inferInsert;

/**
 * ش٢ (٥/٨/٢٦) — مسوّدة طلب محطة خدمة الزبائن (م١: تعديلٌ حرّ قبل التثبيت بصفر أثرٍ ماليّ).
 * الوثيقة الحاكمة docs/reception-cashier-system-design-2026-08-05.md §٥.١.
 * **صفرٌ ماليّ بنيوياً** (الثابت I1): الكيان لا يكتب في invoices/accountingEntries/
 * inventoryMovements أصلاً — يخرج تلقائياً من وعاء العمولة والأعمار وZ-report.
 */
export const receptionDrafts = mysqlTable(
  "receptionDrafts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** DRF-{فرع}-{YYYYMMDD}-{NNNNN} — مسلسلٌ مستقلّ لا يمسّ ترقيم الفواتير. */
    draftNumber: varchar("draftNumber", { length: 40 }).notNull(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    /** إعلاميّ فقط — المسوّدة لا تنتمي لوردية (I14: لا تمنع الإغلاق). */
    createdByShiftId: bigint("createdByShiftId", { mode: "number" }),
    status: mysqlEnum("draftStatus", [
      "OPEN",
      "COMMITTED",
      "CANCELLED",
      "EXPIRED",
    ])
      .default("OPEN")
      .notNull(),
    /** قفل تفاؤليّ للتحرير المتوازي (I9). */
    version: int("version").default(0).notNull(),
    /** يولّده **الخادم** عند الإنشاء ويعيش مع الصفّ — طبقة idempotency الثالثة للتثبيت (ش٣):
     *  يصير sourceId `{uuid}-sale` فيصطدم بـuq_invoice_source حتى لو سقط القفلان. */
    commitRequestId: char("commitRequestId", { length: 36 }).notNull(),
    /** يُرفع عند أوّل قبضٍ (ش٤) **ولا يُخفَض أبداً** — العمود الفقريّ لحارس I3. */
    moneyLocked: boolean("moneyLocked").default(false).notNull(),
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
    ),
    contactName: varchar("contactName", { length: 255 }),
    contactPhone: varchar("contactPhone", { length: 32 }),
    priceTier: mysqlEnum("draftPriceTier", [
      "RETAIL",
      "WHOLESALE",
      "GOVERNMENT",
    ])
      .default("RETAIL")
      .notNull(),
    channel: varchar("channel", { length: 20 }),
    /** معرّف العميل على القناة (رقم واتساب/اسم حساب) — 0214. كان `channel` بلا معرّفٍ
     *  مقابل، فتُفقَد وسيلةُ الرجوع للزبون عند تثبيت المسوّدة رغم أنّ
     *  `workOrders.channelHandle` قائمٌ ينتظر قيمة. */
    channelHandle: varchar("channelHandle", { length: 120 }),
    /** المحادثة التي وُلد منها الطلب (0214) — يجعل الربط يقع **داخل معاملة التثبيت**
     *  فإمّا (أمر شغل + محادثة مربوطة) وإمّا لا شيء. */
    conversationId: bigint("conversationId", { mode: "number" }).references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    dueDate: date("dueDate"),
    /** ذاكرة عرضٍ فقط — تُعاد حسابها خادمياً في كل كتابةٍ وعند التثبيت (لا يُقرأ منها قرار). */
    subtotal: decimal("subtotal", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    discountTotal: decimal("discountTotal", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    total: decimal("total", { precision: 15, scale: 2 }).default("0").notNull(),
    committedInvoiceId: bigint("committedInvoiceId", {
      mode: "number",
    }).references(() => invoices.id),
    committedPrintInvoiceId: bigint("committedPrintInvoiceId", {
      mode: "number",
    }).references(() => invoices.id),
    expiresAt: timestamp("expiresAt"),
    committedAt: timestamp("committedAt"),
    cancelledAt: timestamp("cancelledAt"),
    cancelReason: varchar("cancelReason", { length: 500 }),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    updatedBy: int("updatedBy"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    numberUq: unique("uq_draft_number").on(table.draftNumber),
    commitRequestUq: unique("uq_draft_commit_request").on(
      table.commitRequestId,
    ),
    committedInvoiceUq: unique("uq_draft_committed_invoice").on(
      table.committedInvoiceId,
    ),
    conversationIdx: index("idx_draft_conversation").on(table.conversationId),
    branchStatusIdx: index("idx_draft_branch_status_id").on(
      table.branchId,
      table.status,
      table.id,
    ),
    creatorIdx: index("idx_draft_creator").on(table.createdBy, table.status),
    phoneIdx: index("idx_draft_phone").on(table.contactPhone),
    customerIdx: index("idx_draft_customer").on(table.customerId),
  }),
);

/** بنود المسوّدة — لقطة تحريرٍ حرّة (GOODS/PRINT/CUSTOM). FKs المنتج RESTRICT عمداً + مدخل
 *  getProductUsage محصورٌ بـOPEN (V17) كي لا تمنع مسوّدةٌ ملغاة حذف منتجٍ للأبد.
 *  قاعدة صلبة (I22): لا استعلام قائمةٍ ينتقي designImages/printSpec ولا حمولة تدقيقٍ تحملهما. */
export const receptionDraftLines = mysqlTable(
  "receptionDraftLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    draftId: bigint("draftId", { mode: "number" })
      .notNull()
      .references(() => receptionDrafts.id, { onDelete: "cascade" }),
    lineKind: mysqlEnum("draftLineKind", [
      "GOODS",
      "PRINT",
      "CUSTOM",
    ]).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    variantId: bigint("variantId", { mode: "number" }).references(
      () => productVariants.id,
    ),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(
      () => productUnits.id,
    ),
    quantity: decimal("quantity", { precision: 15, scale: 3 })
      .default("1")
      .notNull(),
    unitPrice: decimal("unitPrice", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    discountAmount: decimal("discountAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    lineTotal: decimal("lineTotal", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    title: varchar("title", { length: 255 }),
    customizationText: text("customizationText"),
    /** MEDIUMTEXT: صور base64 مضغوطة (نمط productImages) — JSON [{url,caption,sortOrder}]. */
    designImages: mediumtext("designImages"),
    /** مواصفة السطر المخصّص (JSON بنية CustomizationData عدا الصور) — للاستئناف الوفيّ. */
    printSpec: text("printSpec"),
    dueDate: date("dueDate"),
    assignedTo: int("assignedTo"),
    priceOverride: boolean("priceOverride").default(false).notNull(),
    priceApprovedBy: bigint("priceApprovedBy", { mode: "number" }),
    lineRequestId: varchar("lineRequestId", { length: 64 }),
  },
  (table) => ({
    draftIdx: index("idx_dline_draft").on(table.draftId, table.sortOrder),
  }),
);

export type ReceptionDraft = typeof receptionDrafts.$inferSelect;
export type ReceptionDraftLine = typeof receptionDraftLines.$inferSelect;

/**
 * ش٤ (٥/٨/٢٦) — سجلّ المال السابق للفاتورة (العرابين على المسوّدات) §٥.٣.
 * جدولٌ واحد بثلاثة أنواع صفوف: COLLECTION (قبضٌ محتجز) / APPLICATION (تخصيصٌ لهدفٍ عند
 * التثبيت) / REFUND (ردٌّ مربوطٌ بأمّه). يحلّ محلّ أيّ مسحٍ ظنّيٍّ للإيصالات:
 * - `receiptId UNIQUE` هو الإصلاح البنيويّ لعلّة V3 (لا `.limit(1)` ولا `NOT LIKE`).
 * - `amount` موجبٌ دائماً؛ الاتجاه من `kind`.
 * - `method` تشمل TELECOM منذ الإنشاء (مكسبٌ مجّانيّ — extras لازمٌ فقط لتوسيع
 *   receipts.paymentMethod القائم في ش٥)؛ قبضُ TELECOM نفسه يُرفض خدمياً حتى ش٥.
 */
export const orderPayments = mysqlTable(
  "orderPayments",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    draftId: bigint("draftId", { mode: "number" })
      .notNull()
      .references(() => receptionDrafts.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
    ),
    kind: mysqlEnum("orderPayKind", [
      "COLLECTION",
      "APPLICATION",
      "REFUND",
    ]).notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    method: mysqlEnum("orderPayMethod", [
      "CASH",
      "CARD",
      "TRANSFER",
      "WALLET",
      "TELECOM",
    ]),
    /** إيصال القبض/الردّ؛ NULL لصفوف APPLICATION. */
    receiptId: bigint("receiptId", { mode: "number" }).references(
      () => receipts.id,
    ),
    /** وردية القبض — تبقى عليها أبداً (قاعدة ٤ / I12). */
    shiftId: bigint("shiftId", { mode: "number" }).references(() => shifts.id),
    /** APPLICATION/REFUND ← COLLECTION الأمّ. FK ذاتيّ عبر AnyMySqlColumn (نمط drizzle). */
    parentPaymentId: bigint("parentPaymentId", { mode: "number" }).references(
      (): AnyMySqlColumn => orderPayments.id,
    ),
    appliedKind: mysqlEnum("orderPayAppliedKind", ["INVOICE", "WORKORDER"]),
    appliedId: bigint("appliedId", { mode: "number" }),
    /** على صفوف COLLECTION فقط. */
    status: mysqlEnum("orderPayStatus", ["HELD", "APPLIED", "REFUNDED"]),
    referenceNumber: varchar("referenceNumber", { length: 64 }),
    clientRequestId: varchar("clientRequestId", { length: 80 }),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    receiptUq: unique("uq_orderpay_receipt").on(table.receiptId),
    requestUq: unique("uq_orderpay_request").on(table.clientRequestId),
    draftIdx: index("idx_orderpay_draft").on(
      table.draftId,
      table.kind,
      table.status,
    ),
    appliedIdx: index("idx_orderpay_applied").on(
      table.appliedKind,
      table.appliedId,
    ),
    parentIdx: index("idx_orderpay_parent").on(table.parentPaymentId),
  }),
);

export type OrderPayment = typeof orderPayments.$inferSelect;

/** المواد المستهلكة من المخزون لأمر الشغل. */
export const workOrderMaterials = mysqlTable(
  "workOrderMaterials",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    workOrderId: bigint("workOrderId", { mode: "number" })
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    baseQuantity: int("baseQuantity").notNull(),
    unitCost: decimal("unitCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    woIdx: index("idx_wom_wo").on(table.workOrderId),
    variantIdx: index("idx_wom_variant").on(table.variantId),
  }),
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
    workOrderId: bigint("workOrderId", { mode: "number" })
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(
      () => productUnits.id,
    ),
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
    discountAmount: decimal("discountAmount", {
      precision: 15,
      scale: 2,
    }).default("0"),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    woIdx: index("idx_woi_wo").on(table.workOrderId),
    variantIdx: index("idx_woi_variant").on(table.variantId),
  }),
);

export type WorkOrderItem = typeof workOrderItems.$inferSelect;
export type InsertWorkOrderItem = typeof workOrderItems.$inferInsert;

/** v3-add-screens: صور نموذج العمل المطلوب (مرفقات سحب-وإفلات على أمر الشغل). */
export const workOrderImages = mysqlTable(
  "workOrderImages",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    workOrderId: bigint("workOrderId", { mode: "number" })
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    // import-integration: MEDIUMTEXT (~16MB) — TEXT (64KB) كان يكسر data URLs للصور بـ«قيمة أطول من المسموح».
    url: mediumtext("url").notNull(),
    caption: varchar("caption", { length: 255 }),
    sortOrder: int("sortOrder").default(0).notNull(),
    /**
     * نسخةُ ملفّ التصميم (0218، ش٢). «الحاليّ» = `MAX(revision)`، و«المُبطَل» ما دونه،
     * و«عدد التعديلات» = `MAX−1` — كلّها مشتقّة، فلا `supersededBy` ولا `approvedAt/By`
     * (الموافقة كلّها في `tasks`/`taskEvents` بطرفها وزمنها وسجلّها).
     * والصفوف القائمة تصير النسخة ١ بحكم الافتراضيّ.
     */
    revision: int("revision").default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    woIdx: index("idx_woimg_wo").on(table.workOrderId),
    woRevIdx: index("idx_woimg_wo_revision").on(
      table.workOrderId,
      table.revision,
    ),
  }),
);

export type WorkOrderImage = typeof workOrderImages.$inferSelect;
export type InsertWorkOrderImage = typeof workOrderImages.$inferInsert;

/** v3-add-screens: صور المنتج، أوّلها الرئيسية افتراضياً. */
export const productImages = mysqlTable(
  "productImages",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productId: bigint("productId", { mode: "number" })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    // product-variants: صورة لكل لون. NULL = صورة على مستوى المنتج (السلوك القديم)؛ قيمة = صورة هذا المتغيّر.
    variantId: bigint("variantId", { mode: "number" }).references(
      () => productVariants.id,
      { onDelete: "cascade" },
    ),
    // import-integration: MEDIUMTEXT (~16MB) — TEXT (64KB) كان يكسر data URLs للصور بـ«قيمة أطول من المسموح».
    url: mediumtext("url").notNull(),
    isPrimary: boolean("isPrimary").default(false).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    // image-studio (0095): تخزين هجين معنون-بالمحتوى. NULL = صفّ إرثيّ يُخدَم من `url` (توافق خلفيّ).
    // القراءة المزدوجة (objectKey ? store : url) والحرّاس (reviewStatus أمام البايتات) في شرائح لاحقة.
    // راجع docs/product-image-studio-design-2026-07-21.md §١.
    objectKey: varchar("objectKey", { length: 255 }), // مفتاح مخزن الكائنات للصورة المعالَجة
    originalKey: varchar("originalKey", { length: 255 }), // مفتاح الأصل غير الممسوس (عكوسيّة قرار ٢)
    contentHash: varchar("contentHash", { length: 64 }), // sha256 بايتات المعالَجة — بصمة v=/ETag/أوفلاين
    thumbDataUrl: mediumtext("thumbDataUrl"), // مصغّرة ~64px تبقى في DB (شبكة أمان العرض)
    mime: varchar("mime", { length: 32 }),
    width: int("width"),
    height: int("height"),
    bytes: int("bytes"),
    reviewStatus: mysqlEnum("reviewStatus", [
      "APPROVED",
      "PENDING_REVIEW",
      "REJECTED",
    ])
      .default("APPROVED")
      .notNull(),
    origin: mysqlEnum("origin", [
      "ORIGINAL",
      "STUDIO_FREE",
      "STUDIO_PRO",
      "STUDIO_AI",
      "MANUAL",
    ])
      .default("ORIGINAL")
      .notNull(),
    /** هوية مهمة الاستوديو التي نشرت النسخة الحالية؛ تمنع استرجاع مهمة أقدم فوق نشر أحدث متماثل البصمة. */
    publishedStudioJobId: bigint("publishedStudioJobId", { mode: "number" }),
    migratedAt: timestamp("migratedAt"),
  },
  (table) => ({
    prodIdx: index("idx_pimg_product").on(table.productId),
    variantIdx: index("idx_pimg_variant").on(table.variantId),
    // نفس سبب فهرسة مفاتيح المهام: إثبات غياب المرجع قبل الحذف.
    objectKeyIdx: index("idx_pimg_object_key").on(table.objectKey),
    originalKeyIdx: index("idx_pimg_original_key").on(table.originalKey),
  }),
);

export type ProductImage = typeof productImages.$inferSelect;
export type InsertProductImage = typeof productImages.$inferInsert;

/** حملات تشغيل الاستوديو: تجمع مهام النواقص دون إسناد أو نشر تلقائي. */
export const productStudioCampaigns = mysqlTable(
  "productStudioCampaigns",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 180 }).notNull(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    // PAUSED = «تجميد ذكيّ» بقرار المالك ٢٨/٨: تختفي الحملة من مسار المصوّر (فلترُ ACTIVE
    // القائم يكفي)، وتبقى المهام المُسنَدة سلفاً قابلةً للإتمام والاعتماد — لا نطمس عمل
    // بدأه موظف تبعاً لقرارٍ إداريّ مؤقّت. الاستئناف بضغطةِ زرّ (PAUSED→ACTIVE).
    status: mysqlEnum("status", ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"])
      .default("DRAFT")
      .notNull(),
    startsAt: timestamp("startsAt"),
    dueAt: timestamp("dueAt"),
    /** نطاق الحملة: كل المنتجات · فئةٌ · **عدّة فئات** · مجموعةٌ مختارة صراحةً. */
    scopeKind: mysqlEnum("scopeKind", ["ALL", "CATEGORY", "CATEGORIES", "PRODUCTS"])
      .default("ALL")
      .notNull(),
    /** الفئة حين يكون النطاق CATEGORY (فئةٌ واحدة، إرثيّ) — تشمل شجرتَها الفرعيّة. */
    scopeCategoryId: bigint("scopeCategoryId", { mode: "number" }),
    /** التوجيه الإداريّ: كم صورةً مطلوبة لكل منتج في هذه الحملة. */
    requiredImages: int("requiredImages").default(1).notNull(),
    /**
     * سياسةُ الصور — تحدّد ما يدخل الطابور من المنتجات ضمن النطاق:
     *   • ONLY_MISSING (افتراضيّ) — منتجاتٌ لم تبلغ `requiredImages` صور معتمَدة.
     *   • ANY_REGARDLESS — كل المنتجات ضمن النطاق، حتى المكتملة (لإضافة صور جديدة).
     *
     * الحاجة (المالك ٢٦/٨): «حملة تصوير تشمل حتى التي تحمل صور» — دون هذا الوضع
     * تُصفّى المنتجات المُصوَّرة تلقائياً، فلا مسارَ لإضافة صورةٍ ثالثة لمنتجٍ بصورتين.
     */
    imagesPolicy: mysqlEnum("imagesPolicy", ["ONLY_MISSING", "ANY_REGARDLESS"])
      .default("ONLY_MISSING")
      .notNull(),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    branchStatusIdx: index("idx_pscampaign_branch_status").on(
      table.branchId,
      table.status,
    ),
    branchDueIdx: index("idx_pscampaign_branch_due").on(
      table.branchId,
      table.dueAt,
    ),
  }),
);

/** منتجات الحملة حين يكون نطاقها PRODUCTS — اختيارٌ صريح لا اشتقاق. */
export const productStudioCampaignProducts = mysqlTable(
  "productStudioCampaignProducts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // المفاتيح مُعلَنة هنا أيضاً لا في الهجرة وحدها: `db:push` (مسار قواعد التطوير
    // والاختبار) يبني من هذا الملف، فإغفالها يُنتج قواعدَ بلا قيودٍ ولا cascade —
    // شكلٌ مختلف عن الإنتاج، وصفوفُ عضويةٍ يتيمة تمرّ في الاختبار وتسقط في الواقع.
    campaignId: bigint("campaignId", { mode: "number" }).notNull(),
    productId: bigint("productId", { mode: "number" }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    uq: unique("uq_pscp_campaign_product").on(
      table.campaignId,
      table.productId,
    ),
    // بأسماء صريحة قصيرة: التسمية التلقائية هنا تتجاوز ٦٤ محرفاً فتُفشل `db:push`
    // على MySQL 8.4 (راجع docs/local-test-db.md). والأسماء تطابق هجرة 0225 حرفاً بحرف.
    campaignFk: foreignKey({
      columns: [table.campaignId],
      foreignColumns: [productStudioCampaigns.id],
      name: "fk_pscp_campaign",
    }).onDelete("cascade"),
    productFk: foreignKey({
      columns: [table.productId],
      foreignColumns: [products.id],
      name: "fk_pscp_product",
    }).onDelete("cascade"),
  }),
);

/**
 * فئاتُ الحملة حين يكون نطاقها CATEGORIES — اختيارٌ متعدّد صريح. كلّ فئةٍ فيها تشمل
 * شجرتَها الفرعيّة (نفس منطق CATEGORY المُفرَد). هجرة 0269.
 */
export const productStudioCampaignCategories = mysqlTable(
  "productStudioCampaignCategories",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    campaignId: bigint("campaignId", { mode: "number" }).notNull(),
    categoryId: bigint("categoryId", { mode: "number" }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    uq: unique("uq_pscc_campaign_category").on(table.campaignId, table.categoryId),
    categoryIdx: index("idx_pscc_category").on(table.categoryId),
    campaignFk: foreignKey({
      columns: [table.campaignId],
      foreignColumns: [productStudioCampaigns.id],
      name: "fk_pscc_campaign",
    }).onDelete("cascade"),
    categoryFk: foreignKey({
      columns: [table.categoryId],
      foreignColumns: [categories.id],
      name: "fk_pscc_category",
    }).onDelete("cascade"),
  }),
);

/**
 * مصوّرو الحملة. الحملة تُسنَد إلى **عدّة** موظفين، ومنها يسحب كلٌّ منهم المنتج الذي
 * يمسح باركوده — بدل إسنادٍ فرديّ مسبَق لكل مهمة على حدة.
 */
export const productStudioCampaignAssignees = mysqlTable(
  "productStudioCampaignAssignees",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    campaignId: bigint("campaignId", { mode: "number" }).notNull(),
    userId: int("userId").notNull(),
    createdBy: int("createdBy").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    uq: unique("uq_psca_campaign_user").on(table.campaignId, table.userId),
    campaignFk: foreignKey({
      columns: [table.campaignId],
      foreignColumns: [productStudioCampaigns.id],
      name: "fk_psca_campaign",
    }).onDelete("cascade"),
    userFk: foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "fk_psca_user",
    }),
  }),
);

export type ProductStudioCampaign = typeof productStudioCampaigns.$inferSelect;
export type InsertProductStudioCampaign =
  typeof productStudioCampaigns.$inferInsert;

/**
 * image-studio (0096): طابور/سجلّ عمليات الاستوديو. **يحتجز المرشّح المعالَج (`processedUrl`) حتى
 * الاعتماد** (§٥ #١: لا يُجسَّد كصفّ productImages قابل للخدمة قبل المراجعة، سدّاً لتجاوز البوّابة
 * بتخمين id). أساس مسار المراجعة/الأسينك (ش٢/Pro/CUT)؛ المسار المتزامن (FLATTEN inline) يُعتمَد بشرياً
 * في الحال ويُحفَظ صورةً عاديّة. راجع docs/product-image-studio-design-2026-07-21.md §٥.
 */
export const productImageJobs = mysqlTable(
  "productImageJobs",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productId: bigint("productId", { mode: "number" }).references(
      () => products.id,
      { onDelete: "cascade" },
    ),
    variantId: bigint("variantId", { mode: "number" }).references(
      () => productVariants.id,
      { onDelete: "cascade" },
    ),
    campaignId: bigint("campaignId", { mode: "number" }).references(
      () => productStudioCampaigns.id,
      { onDelete: "set null" },
    ),
    sourceContentHash: varchar("sourceContentHash", { length: 64 }),
    /** لقطة الفرع عند الإسناد؛ المدير محصور بفرعه، والمالك/الأدمن فقط يعبران. */
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    /** بصمة الاسم والوصف وقت بدء المهمة لمنع طمس تعديلٍ أحدث عند الاعتماد. */
    sourceProductHash: varchar("sourceProductHash", { length: 64 }),
    /** صورة المصدر القائمة، إن بدأت المهمة من صورة محفوظة. لا يُعرَض رابطها للعامل مباشرةً. */
    sourceImageId: bigint("sourceImageId", { mode: "number" }).references(
      () => productImages.id,
      { onDelete: "set null" },
    ),
    /** الأصل والمرشّح في المخزن الخاص؛ لا data URL كامل الدقة في MySQL. */
    originalObjectKey: varchar("originalObjectKey", { length: 255 }),
    processedObjectKey: varchar("processedObjectKey", { length: 255 }),
    originalMime: varchar("originalMime", { length: 32 }),
    processedMime: varchar("processedMime", { length: 32 }),
    processedContentHash: varchar("processedContentHash", { length: 64 }),
    processedBytes: int("processedBytes"),
    processedWidth: int("processedWidth"),
    processedHeight: int("processedHeight"),
    // المرشّح المحتجَز — لا يُخدَم عبر /api/img حتى الاعتماد (§٥ #١).
    processedUrl: mediumtext("processedUrl"),
    mode: mysqlEnum("mode", ["FLATTEN", "CUT", "PRO", "AI"]).notNull(),
    status: mysqlEnum("status", [
      "ASSIGNED",
      "IN_PROGRESS",
      "PENDING_REVIEW",
      "APPROVED",
      "REJECTED",
      "FAILED",
      "REVERTED",
      /** أُلغيت بقرار مدير موثَّق: حالة نهائية تُفرغ activeSlot فيعود المنتج قابلاً لمهمة جديدة. */
      "CANCELLED",
    ])
      .default("PENDING_REVIEW")
      .notNull(),
    /** أولوية تشغيلية للمهمة؛ لا تغيّر صلاحياتها أو ترتيب المراجعة الأمني. */
    priority: mysqlEnum("priority", ["LOW", "NORMAL", "HIGH", "URGENT"])
      .default("NORMAL")
      .notNull(),
    /** موعد الإنجاز التشغيلي، ويظل NULL للمهام بلا SLA محدد. */
    dueAt: timestamp("dueAt"),
    /** قفل تفاؤلي لكل تعديل من الهاتف أو سطح المكتب. */
    revision: int("revision").default(1).notNull(),
    templateVersion: int("templateVersion"),
    createdBy: int("createdBy").references(() => users.id), // users.id = int (لا bigint)
    assignedTo: int("assignedTo").references(() => users.id),
    assignedBy: int("assignedBy").references(() => users.id),
    /** لحظةُ تسليم المهمة لمنفّذ. زمنُ الدورة يُقاس منها لا من الإنشاء: مهامُ الحملة
        تُولَد بالآلاف في لحظةٍ واحدة، فقياسُها من الإنشاء يُبلّغ عمرَ الطابور لا زمنَ العمل. */
    assignedAt: timestamp("assignedAt"),
    reviewedBy: int("reviewedBy").references(() => users.id),
    /** فتحة فريدة للمهمة النشطة: 1 أثناء العمل، NULL بعد الإغلاق؛ تمنع مهمتين لمنتج واحد. */
    activeSlot: tinyint("activeSlot"),
    /** lease مشترك في DB يمنع رفع مرشحين متوازيين عبر عدة workers. */
    uploadLeaseToken: varchar("uploadLeaseToken", { length: 64 }),
    uploadLeaseExpiresAt: timestamp("uploadLeaseExpiresAt"),
    /** إثبات خادمي قصير العمر بأن مزوداً مدفوعاً/ذكياً نُفّذ لهذه المهمة. */
    processingProofTokenHash: varchar("processingProofTokenHash", {
      length: 64,
    }),
    processingProofMode: mysqlEnum("processingProofMode", ["PRO", "AI"]),
    processingProofCandidateHash: varchar("processingProofCandidateHash", {
      length: 64,
    }),
    processingProofExpiresAt: timestamp("processingProofExpiresAt"),
    /** حجز ذري مستقل يمنع استهلاك مزودين متوازيين للمهمة نفسها قبل إصدار الإثبات. */
    processingLeaseTokenHash: varchar("processingLeaseTokenHash", {
      length: 64,
    }),
    processingLeaseExpiresAt: timestamp("processingLeaseExpiresAt"),
    proposedName: varchar("proposedName", { length: 255 }),
    proposedDescription: text("proposedDescription"),
    proposedMarketingCopy: text("proposedMarketingCopy"),
    rejectionReason: varchar("rejectionReason", { length: 500 }),
    /** أثر الإلغاء على الصفّ نفسه — لا يُحمَّل على rejectionReason فمعناهما مختلف:
        «أعِدها للتعديل» ≠ «هذه المهمة لن تُنفَّذ». */
    cancellationReason: varchar("cancellationReason", { length: 500 }),
    cancelledBy: int("cancelledBy").references(() => users.id),
    cancelledAt: timestamp("cancelledAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    submittedAt: timestamp("submittedAt"),
    /** آخر منفّذ أرسل المرشح؛ يثبَّت خادمياً ويمنع اعتماده حتى لو تغيّر الإسناد لاحقاً. */
    submittedBy: int("submittedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
  },
  (table) => ({
    prodIdx: index("idx_pijob_product").on(table.productId),
    campaignStatusIdx: index("idx_pijob_campaign_status").on(
      table.campaignId,
      table.status,
    ),
    statusIdx: index("idx_pijob_status").on(table.status),
    assigneeStatusIdx: index("idx_pijob_assignee_status").on(
      table.assignedTo,
      table.status,
    ),
    branchStatusIdx: index("idx_pijob_branch_status").on(
      table.branchId,
      table.status,
    ),
    branchPriorityDueIdx: index("idx_pijob_branch_priority_due").on(
      table.branchId,
      table.priority,
      table.dueAt,
    ),
    submitterStatusIdx: index("idx_pijob_submitter_status").on(
      table.submittedBy,
      table.status,
    ),
    // مفتاحُ التفرّد: (productId, variantScope, activeSlot) حيث `variantScope` عمودٌ
    // مولَّدٌ VIRTUAL بـ IFNULL(variantId, 0). يُبنى ويُطبَّق بهجرة 0268 (لا يعبّر
    // عنه drizzle-kit مباشرةً)، ويُثبَّت في CI عبر `ci-apply-extra-migrations.mjs`.
    // مصوّرٌ يمسح بديل A ⇒ مهمّة (X, id(A))، وزميلُه يمسح بديل B ⇒ (X, id(B))
    // — لا تصادم. مسحُ الأمّ مباشرةً (variantId=NULL) ⇒ (X, 0). راجع
    // `drizzle/migrations/0268_studio_variant_scoped_jobs.sql`.
    // كنس المخزن يسأل «هل ما زال لهذا المفتاح مرجع؟» لكل مرشّح تحت قفل؛ بلا فهرسٍ
    // كان كلّ سؤالٍ مسحاً كاملاً للجدول.
    originalKeyIdx: index("idx_pijob_original_key").on(table.originalObjectKey),
    processedKeyIdx: index("idx_pijob_processed_key").on(
      table.processedObjectKey,
    ),
  }),
);

export type ProductImageJob = typeof productImageJobs.$inferSelect;
export type InsertProductImageJob = typeof productImageJobs.$inferInsert;

/** سجل ثابت المفتاح لكنس كائنات الرفع التي لم تُربط بصف DB بعد فشل/انقطاع. */
/**
 * سقف الإرسال اليوميّ لكل منفّذ في استوديو المنتجات.
 *
 * حارس الاستهلاك القائم يغطّي المزوّدين المدفوعين وحدهم؛ ومسار الإرسال المجّاني
 * (FLATTEN/CUT) كان بلا أيّ سقف: كل إرسال يكتب حتى كائنَين معنونَين بمحتواهما — لا
 * يُستبدَلان أبداً ولا يُستردّان (الكنس معطَّل افتراضياً) — فسقفه الوحيد كان محدّد
 * المعدّل العامّ للـIP.
 *
 * العدّ بالبايتات لا بعدد النداءات وحده: الكلفة تخزينٌ لا استدعاء.
 */
export const productStudioSubmitQuota = mysqlTable(
  "productStudioSubmitQuota",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** يوم UTC — نفس حدّ اليوم المعتمد في هذه الوحدة (businessDay). */
    usageDate: date("usageDate", { mode: "string" }).notNull(),
    userId: int("userId")
      .notNull()
      .references(() => users.id),
    submitCount: int("submitCount").default(0).notNull(),
    bytesWritten: bigint("bytesWritten", { mode: "number" })
      .default(0)
      .notNull(),
    lastSubmittedAt: timestamp("lastSubmittedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userDayUq: unique("uq_pssq_user_day").on(table.usageDate, table.userId),
  }),
);

export const productImageObjectStaging = mysqlTable(
  "productImageObjectStaging",
  {
    objectKey: varchar("objectKey", { length: 255 }).primaryKey(),
    state: mysqlEnum("state", ["PENDING", "REFERENCED"])
      .default("PENDING")
      .notNull(),
    touchedAt: timestamp("touchedAt").defaultNow().onUpdateNow().notNull(),
    referencedAt: timestamp("referencedAt"),
  },
  (table) => ({
    stateTouchedIdx: index("idx_piostage_state_touched").on(
      table.state,
      table.touchedAt,
    ),
  }),
);

/* ============================ المشتريات ============================ */

export const purchaseOrders = mysqlTable(
  "purchaseOrders",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    poNumber: varchar("poNumber", { length: 50 }).notNull().unique(),
    supplierId: bigint("supplierId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    orderDate: timestamp("orderDate").defaultNow().notNull(),
    expectedDeliveryDate: date("expectedDeliveryDate"),
    subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    taxRatePercent: decimal("taxRatePercent", { precision: 5, scale: 2 })
      .default("0")
      .notNull(),
    // landed-cost (0098): تكلفة الشحن/الكمرك الكلّية — تُوزَّع على البنود بنسبة القيمة وتُرسمَل في
    // تكلفة المخزون (WAVG) عند الاستلام، وتُضاف إلى ذمّة المورّد. total = subtotal + tax + شحن + كمرك.
    shippingCost: decimal("shippingCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    customsCost: decimal("customsCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // 0018: DB-level CHECK (>= 0) أُضيف على total/paidAmount في migration 0018.
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    paidAmount: decimal("paidAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // تصنيف التسوية التعاقدي للأمر، مستقل عن وسيلة التنفيذ. التاريخي CREDIT لأن النظام
    // قبل 0240 كان لا ينشئ دفعة إلا إذا أُدخل مبلغ صريح عند الاستلام؛ هذا يمنع تحويل
    // الأوامر القديمة إلى صرف نقدي تلقائي بعد الترقية.
    settlementType: mysqlEnum("settlementType", ["CASH", "CREDIT"])
      .default("CREDIT")
      .notNull(),
    status: mysqlEnum("poStatus", [
      "DRAFT",
      "SENT",
      "CONFIRMED",
      "RECEIVED",
      "CANCELLED",
    ])
      .default("DRAFT")
      .notNull(),
    // فاتورة المورد الأصلية: عند USD تكون أسعار البنود بالدولار وagreedRate سعر التثبيت الذي
    // حُوّلت به إلى تكلفة مخزون دينارية. التسديد اللاحق يطفئ paidUsd بسعره الفعلي ويُنتج فرق صرف.
    agreedCurrency: mysqlEnum("poCurrency", ["IQD", "USD"])
      .default("IQD")
      .notNull(),
    usdTotal: decimal("usdTotal", { precision: 15, scale: 2 }),
    agreedRate: decimal("agreedRate", { precision: 15, scale: 4 }),
    // خصم فاتورة المورّد (0204): يُدخَل فاتورياً ويُوزَّع بنسبة القيمة، فتُخزَّن أعمدةُ المال
    // **صافيةً** (subtotal/total/unitPrice/usdUnitPrice) ⇒ AP وWAVG ومرتجع الشراء تلتقطه بلا
    // تغييرٍ في قرّائها. هذان العمودان **إفصاحٌ وإعادةُ تحميلٍ للمحرّر** لا مدخلٌ في أيّ حساب:
    // `invoiceDiscount` بالدينار، و`usdInvoiceDiscount` بالدولار للأمر الدولاريّ (نظير usdTotal).
    invoiceDiscount: decimal("invoiceDiscount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    usdInvoiceDiscount: decimal("usdInvoiceDiscount", {
      precision: 15,
      scale: 2,
    }),
    paidUsd: decimal("paidUsd", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    returnedUsd: decimal("returnedUsd", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    notes: text("notes"),
    version: int("version").default(1).notNull(),
    currentRevisionId: bigint("currentRevisionId", { mode: "number" }).references(
      (): AnyMySqlColumn => purchaseOrderRevisions.id,
    ),
    approvedRevisionId: bigint("approvedRevisionId", { mode: "number" }).references(
      (): AnyMySqlColumn => purchaseOrderRevisions.id,
    ),
    lastEditedBy: int("lastEditedBy").references(() => users.id),
    submittedBy: int("submittedBy").references(() => users.id),
    submittedAt: timestamp("submittedAt"),
    approvedBy: int("approvedBy").references(() => users.id),
    approvedAt: timestamp("approvedAt"),
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
    supplierStatusIdx: index("idx_po_supplier_status").on(
      table.supplierId,
      table.status,
    ),
    currentRevisionUq: unique("uq_po_current_revision").on(table.currentRevisionId),
    approvedRevisionUq: unique("uq_po_approved_revision").on(table.approvedRevisionId),
  }),
);

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type InsertPurchaseOrder = typeof purchaseOrders.$inferInsert;

export const purchaseOrderItems = mysqlTable(
  "purchaseOrderItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" })
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(
      () => productUnits.id,
    ),
    // 0018: DB-level CHECK (>= 0) أُضيف على quantity/baseQuantity/unitPrice/total في migration 0018.
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    // لقطة فاتورة المورد الأصلية. تبقى unitPrice/total أعلاه بالدينار لتغذية WAVG والدفتر.
    usdUnitPrice: decimal("usdUnitPrice", { precision: 15, scale: 4 }),
    usdTotal: decimal("usdTotal", { precision: 15, scale: 2 }),
    // سعر الوحدة **قبل خصم الفاتورة** (0204) — لقطةُ ورقة المورّد سطراً سطراً. `unitPrice`
    // أعلاه صافٍ (هو ما نَدين به ونُرسمله)، وهذا هو المُعلَن على المستند. `NULL` = بلا خصم
    // (أو أمرٌ سابقٌ للعمود) ⇒ القارئ يسقط على `unitPrice` نفسه.
    listUnitPrice: decimal("listUnitPrice", { precision: 15, scale: 2 }),
    usdListUnitPrice: decimal("usdListUnitPrice", { precision: 15, scale: 4 }),
    receivedBaseQuantity: int("receivedBaseQuantity").default(0),
    // مرتجعات الشراء المرجعية: عدّاد ذري على بند الأمر نفسه. يُقفَل البند عند إنشاء المرتجع
    // ويُزاد داخل المعاملة كي لا تتمكن معاملتان متزامنتان من تجاوز المستلَم.
    returnedBaseQuantity: int("returnedBaseQuantity").default(0).notNull(),
    // receivedNet: مجموع ما قُيِّد فعلياً للبند عبر استلامات متعدّدة. عند الـreceive
    // الذي يُكمل الكمية، يُستعمل (total − receivedNet) كقيمة remainder بالضبط ⇒
    // مجموع AP/PURCHASE يطابق إجمالي الـPO تماماً (لا انجراف 0.01 IQD).
    receivedNet: decimal("receivedNet", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    receivedUsd: decimal("receivedUsd", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    poIdx: index("idx_poi_po").on(table.purchaseOrderId),
    variantIdx: index("idx_poi_variant").on(table.variantId),
  }),
);

export type PurchaseOrderItem = typeof purchaseOrderItems.$inferSelect;
export type InsertPurchaseOrderItem = typeof purchaseOrderItems.$inferInsert;

/** لقطة أمر شراء ثابتة؛ صفّ PO يبقى projection سريعاً ولا يُستعمل كدليل اعتماد. */
export const purchaseOrderRevisions = mysqlTable(
  "purchaseOrderRevisions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" }).notNull().references((): AnyMySqlColumn => purchaseOrders.id),
    revisionNo: int("revisionNo").notNull(),
    baseRevisionId: bigint("baseRevisionId", { mode: "number" }),
    // Expansion 0303 keeps the physical default LEGACY for rolling-deploy compatibility.
    // Governed writers always send NATIVE explicitly; a later cutover may flip the default
    // only after every pre-0303 worker has been drained.
    origin: mysqlEnum("origin", ["NATIVE", "LEGACY"]).default("LEGACY").notNull(),
    supplierId: bigint("supplierId", { mode: "number" }).notNull().references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    agreedCurrency: mysqlEnum("agreedCurrency", ["IQD", "USD"]).notNull(),
    agreedRate: decimal("agreedRate", { precision: 15, scale: 4 }),
    settlementType: mysqlEnum("settlementType", ["CASH", "CREDIT"]).notNull(),
    expectedDeliveryDate: date("expectedDeliveryDate"),
    subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }).notNull(),
    shippingCost: decimal("shippingCost", { precision: 15, scale: 2 }).notNull(),
    customsCost: decimal("customsCost", { precision: 15, scale: 2 }).notNull(),
    invoiceDiscount: decimal("invoiceDiscount", { precision: 15, scale: 2 }).notNull(),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    usdTotal: decimal("usdTotal", { precision: 15, scale: 2 }),
    notesSnapshot: text("notesSnapshot"),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    revisionReason: varchar("revisionReason", { length: 500 }).notNull(),
    // LEGACY backfill must not fabricate an operator; native revisions require an actor in the service.
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    orderRevisionUq: unique("uq_po_revision_no").on(table.purchaseOrderId, table.revisionNo),
    orderHashUq: unique("uq_po_revision_hash").on(table.purchaseOrderId, table.payloadHash),
    branchTimeIdx: index("idx_po_revision_branch_time").on(table.branchId, table.createdAt),
    baseRevisionFk: foreignKey({
      name: "fk_po_revision_base",
      columns: [table.baseRevisionId],
      foreignColumns: [table.id],
    }),
    positiveRevision: check("chk_po_revision_number", sql`${table.revisionNo} > 0`),
    nonNegativeAmounts: check("chk_po_revision_amounts", sql`${table.subtotal} >= 0 AND ${table.taxAmount} >= 0 AND ${table.shippingCost} >= 0 AND ${table.customsCost} >= 0 AND ${table.invoiceDiscount} >= 0 AND ${table.total} >= 0`),
    nativeActor: check("chk_po_revision_native_actor", sql`${table.origin} = 'LEGACY' OR ${table.createdBy} IS NOT NULL`),
  }),
);

export const purchaseOrderRevisionItems = mysqlTable(
  "purchaseOrderRevisionItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    revisionId: bigint("revisionId", { mode: "number" }).notNull(),
    lineNo: int("lineNo").notNull(),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(() => productUnits.id),
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    listUnitPrice: decimal("listUnitPrice", { precision: 15, scale: 2 }).notNull(),
    unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
    lineTotal: decimal("lineTotal", { precision: 15, scale: 2 }).notNull(),
    usdListUnitPrice: decimal("usdListUnitPrice", { precision: 15, scale: 4 }),
    usdUnitPrice: decimal("usdUnitPrice", { precision: 15, scale: 4 }),
    usdLineTotal: decimal("usdLineTotal", { precision: 15, scale: 2 }),
    productNameSnapshot: varchar("productNameSnapshot", { length: 255 }).notNull(),
    variantNameSnapshot: varchar("variantNameSnapshot", { length: 120 }),
    skuSnapshot: varchar("skuSnapshot", { length: 120 }),
    unitNameSnapshot: varchar("unitNameSnapshot", { length: 80 }),
  },
  (table) => ({
    revisionLineUq: unique("uq_po_revision_line").on(table.revisionId, table.lineNo),
    variantIdx: index("idx_po_revision_item_variant").on(table.variantId),
    revisionFk: foreignKey({
      name: "fk_po_revision_item_revision",
      columns: [table.revisionId],
      foreignColumns: [purchaseOrderRevisions.id],
    }).onDelete("cascade"),
    positiveValues: check("chk_po_revision_item_values", sql`${table.lineNo} > 0 AND ${table.quantity} > 0 AND ${table.baseQuantity} > 0 AND ${table.listUnitPrice} >= 0 AND ${table.unitPrice} >= 0 AND ${table.lineTotal} >= 0`),
  }),
);

export const purchaseOrderControlRequests = mysqlTable(
  "purchaseOrderControlRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 }).notNull().unique("uq_po_control_request_key"),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" }).notNull(),
    revisionId: bigint("revisionId", { mode: "number" }),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    kind: mysqlEnum("kind", ["APPROVE_REVISION", "CANCEL_ORDER", "EMERGENCY_ORDER"]).notNull(),
    baseOrderVersion: int("baseOrderVersion").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "STALE"]).default("PENDING").notNull(),
    pendingGuard: varchar("pendingGuard", { length: 160 }).unique("uq_po_control_pending"),
    requestedBy: int("requestedBy").notNull().references(() => users.id),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    reviewReason: varchar("reviewReason", { length: 500 }),
    appliedAt: timestamp("appliedAt"),
  },
  (table) => ({
    branchStatusIdx: index("idx_po_control_branch_status").on(table.branchId, table.status),
    orderStatusIdx: index("idx_po_control_order_status").on(table.purchaseOrderId, table.status),
    orderFk: foreignKey({
      name: "fk_po_control_order",
      columns: [table.purchaseOrderId],
      foreignColumns: [purchaseOrders.id],
    }),
    revisionFk: foreignKey({
      name: "fk_po_control_revision",
      columns: [table.revisionId],
      foreignColumns: [purchaseOrderRevisions.id],
    }),
    decisionShape: check("chk_po_control_decision", sql`(
      (${table.status} = 'PENDING' AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.appliedAt} IS NULL AND ${table.pendingGuard} IS NOT NULL)
      OR (${table.status} = 'APPROVED' AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.appliedAt} IS NOT NULL AND ${table.pendingGuard} IS NULL)
      OR (${table.status} IN ('REJECTED','STALE') AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.appliedAt} IS NULL AND ${table.pendingGuard} IS NULL)
    )`),
    makerChecker: check("chk_po_control_maker_checker", sql`(${table.reviewedBy} IS NULL OR ${table.reviewedBy} <> ${table.requestedBy})`),
  }),
);

export const purchaseOrderEvents = mysqlTable(
  "purchaseOrderEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    eventKey: varchar("eventKey", { length: 160 }).notNull().unique("uq_po_event_key"),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" }).notNull().references(() => purchaseOrders.id),
    revisionId: bigint("revisionId", { mode: "number" }).references(() => purchaseOrderRevisions.id),
    requestId: bigint("requestId", { mode: "number" }).references(() => purchaseOrderControlRequests.id),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    eventType: varchar("eventType", { length: 60 }).notNull(),
    reason: varchar("reason", { length: 500 }),
    actorUserId: int("actorUserId").references(() => users.id),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    previousEventHash: char("previousEventHash", { length: 64 }),
    eventHash: char("eventHash", { length: 64 }).notNull().unique("uq_po_event_hash"),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  },
  (table) => ({
    orderTimeIdx: index("idx_po_event_order_time").on(table.purchaseOrderId, table.occurredAt),
    branchTimeIdx: index("idx_po_event_branch_time").on(table.branchId, table.occurredAt),
  }),
);

export const purchaseControlSettings = mysqlTable(
  "purchaseControlSettings",
  {
    branchId: bigint("branchId", { mode: "number" }).primaryKey().references(() => branches.id),
    requireRequisition: boolean("requireRequisition").default(false).notNull(),
    allowEmergencyOrder: boolean("allowEmergencyOrder").default(true).notNull(),
    requireEmergencyApproval: boolean("requireEmergencyApproval").default(true).notNull(),
    priceTolerancePercent: decimal("priceTolerancePercent", { precision: 7, scale: 4 }).default("0").notNull(),
    totalToleranceAmount: decimal("totalToleranceAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    blockUninvoicedReceiptsAtClose: boolean("blockUninvoicedReceiptsAtClose").default(true).notNull(),
    version: int("version").default(1).notNull(),
    updatedBy: int("updatedBy").references(() => users.id),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    tolerances: check("chk_purchase_control_tolerances", sql`${table.priceTolerancePercent} >= 0 AND ${table.totalToleranceAmount} >= 0`),
  }),
);

export const purchaseRequisitions = mysqlTable(
  "purchaseRequisitions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requisitionNumber: varchar("requisitionNumber", { length: 50 }).notNull().unique("uq_purchase_req_number"),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    neededBy: date("neededBy"),
    purpose: varchar("purpose", { length: 500 }).notNull(),
    costCenter: varchar("costCenter", { length: 120 }),
    priority: mysqlEnum("priority", ["LOW", "NORMAL", "URGENT"]).default("NORMAL").notNull(),
    version: int("version").default(1).notNull(),
    status: mysqlEnum("status", ["DRAFT", "SUBMITTED", "APPROVED", "PARTIALLY_ORDERED", "FULLY_ORDERED", "FULFILLED", "REJECTED", "CANCELLED"]).default("DRAFT").notNull(),
    createdBy: int("createdBy").notNull().references(() => users.id),
    submittedBy: int("submittedBy").references(() => users.id),
    submittedAt: timestamp("submittedAt"),
    approvedBy: int("approvedBy").references(() => users.id),
    approvedAt: timestamp("approvedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    branchStatusIdx: index("idx_purchase_req_branch_status").on(table.branchId, table.status),
    neededIdx: index("idx_purchase_req_needed").on(table.neededBy),
  }),
);

export const purchaseRequisitionItems = mysqlTable(
  "purchaseRequisitionItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requisitionId: bigint("requisitionId", { mode: "number" }).notNull(),
    lineNo: int("lineNo").notNull(),
    variantId: bigint("variantId", { mode: "number" }).notNull().references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(() => productUnits.id),
    requestedBaseQuantity: int("requestedBaseQuantity").notNull(),
    approvedBaseQuantity: int("approvedBaseQuantity").default(0).notNull(),
    orderedBaseQuantity: int("orderedBaseQuantity").default(0).notNull(),
    receivedBaseQuantity: int("receivedBaseQuantity").default(0).notNull(),
    estimatedUnitPrice: decimal("estimatedUnitPrice", { precision: 15, scale: 2 }),
    preferredSupplierId: bigint("preferredSupplierId", { mode: "number" }).references(() => suppliers.id),
    justification: varchar("justification", { length: 500 }).notNull(),
  },
  (table) => ({
    reqLineUq: unique("uq_purchase_req_line").on(table.requisitionId, table.lineNo),
    variantIdx: index("idx_purchase_req_item_variant").on(table.variantId),
    requisitionFk: foreignKey({
      name: "fk_purchase_req_item_req",
      columns: [table.requisitionId],
      foreignColumns: [purchaseRequisitions.id],
    }).onDelete("cascade"),
    quantityShape: check("chk_purchase_req_item_quantities", sql`${table.requestedBaseQuantity} > 0 AND ${table.approvedBaseQuantity} >= 0 AND ${table.approvedBaseQuantity} <= ${table.requestedBaseQuantity} AND ${table.orderedBaseQuantity} >= 0 AND ${table.orderedBaseQuantity} <= ${table.approvedBaseQuantity} AND ${table.receivedBaseQuantity} >= 0 AND ${table.receivedBaseQuantity} <= ${table.orderedBaseQuantity}`),
  }),
);

export const purchaseRequisitionControlRequests = mysqlTable(
  "purchaseRequisitionControlRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 }).notNull().unique("uq_purchase_req_control_request_key"),
    requisitionId: bigint("requisitionId", { mode: "number" }).notNull(),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    kind: mysqlEnum("kind", ["APPROVE", "CANCEL"]).notNull(),
    baseVersion: int("baseVersion").notNull(),
    payload: json("payload").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "STALE"]).default("PENDING").notNull(),
    pendingGuard: varchar("pendingGuard", { length: 160 }).unique("uq_purchase_req_control_pending"),
    requestedBy: int("requestedBy").notNull().references(() => users.id),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    reviewReason: varchar("reviewReason", { length: 500 }),
    appliedAt: timestamp("appliedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    branchStatusIdx: index("idx_purchase_req_control_branch_status").on(table.branchId, table.status),
    requisitionFk: foreignKey({
      name: "fk_purchase_req_control_req",
      columns: [table.requisitionId],
      foreignColumns: [purchaseRequisitions.id],
    }),
    decisionShape: check("chk_purchase_req_control_decision", sql`(
      (${table.status} = 'PENDING' AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.appliedAt} IS NULL AND ${table.pendingGuard} IS NOT NULL)
      OR (${table.status} = 'APPROVED' AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.appliedAt} IS NOT NULL AND ${table.pendingGuard} IS NULL)
      OR (${table.status} IN ('REJECTED','STALE') AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.appliedAt} IS NULL AND ${table.pendingGuard} IS NULL)
    )`),
    // ⭐ قرار المالك (٤/٩/٢٦): توسيع «لا اعتماد ثانٍ بعد المالك» — قيدُ maker-checker
    // السابق (`chk_purchase_req_control_maker_checker`) أُسقط بالهجرة 0334. راجع
    // [[owner-decision-no-second-approval]] والتعليق الموازي على الجداول الستّة
    // الأولى (هجرة 0333).
  }),
);

export const purchaseOrderRequisitionAllocations = mysqlTable(
  "purchaseOrderRequisitionAllocations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    purchaseOrderRevisionItemId: bigint("purchaseOrderRevisionItemId", { mode: "number" }).notNull(),
    requisitionItemId: bigint("requisitionItemId", { mode: "number" }).notNull(),
    allocatedBaseQuantity: int("allocatedBaseQuantity").notNull(),
  },
  (table) => ({
    pairUq: unique("uq_po_req_allocation_pair").on(table.purchaseOrderRevisionItemId, table.requisitionItemId),
    requisitionIdx: index("idx_po_req_allocation_req").on(table.requisitionItemId),
    revisionItemFk: foreignKey({
      name: "fk_po_req_alloc_revision_item",
      columns: [table.purchaseOrderRevisionItemId],
      foreignColumns: [purchaseOrderRevisionItems.id],
    }),
    requisitionItemFk: foreignKey({
      name: "fk_po_req_alloc_req_item",
      columns: [table.requisitionItemId],
      foreignColumns: [purchaseRequisitionItems.id],
    }),
    positiveQty: check("chk_po_req_allocation_positive", sql`${table.allocatedBaseQuantity} > 0`),
  }),
);

/** إذن استلام مخزني مستقل عن فاتورة المورد؛ POSTED يثبت المخزون مقابل GRNI لا AP. */
export const goodsReceipts = mysqlTable(
  "goodsReceipts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    receiptNumber: varchar("receiptNumber", { length: 50 })
      .notNull()
      .unique("uq_goods_receipt_number"),
    clientRequestId: varchar("clientRequestId", { length: 120 })
      .notNull()
      .unique("uq_goods_receipt_request"),
    origin: mysqlEnum("origin", ["NATIVE", "LEGACY_AGGREGATE"])
      .default("NATIVE")
      .notNull(),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" })
      .notNull()
      .references(() => purchaseOrders.id),
    purchaseOrderRevisionId: bigint("purchaseOrderRevisionId", {
      mode: "number",
    }),
    supplierId: bigint("supplierId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    status: mysqlEnum("status", ["POSTED", "PARTIALLY_REVERSED", "REVERSED"])
      .default("POSTED")
      .notNull(),
    version: int("version").default(1).notNull(),
    receivedAt: timestamp("receivedAt").defaultNow().notNull(),
    supplierDeliveryNote: varchar("supplierDeliveryNote", { length: 160 }),
    currency: mysqlEnum("currency", ["IQD", "USD"]).notNull(),
    agreedRate: decimal("agreedRate", { precision: 15, scale: 4 }),
    netAmount: decimal("netAmount", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalAmount: decimal("totalAmount", { precision: 15, scale: 2 }).notNull(),
    usdTotal: decimal("usdTotal", { precision: 15, scale: 2 }),
    notes: varchar("notes", { length: 500 }),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    createdBy: int("createdBy").references(() => users.id),
    postedBy: int("postedBy").references(() => users.id),
    postedAt: timestamp("postedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    requestHashUq: unique("uq_goods_receipt_request_hash").on(
      table.clientRequestId,
      table.payloadHash,
    ),
    orderDateIdx: index("idx_goods_receipt_order_date").on(
      table.purchaseOrderId,
      table.receivedAt,
    ),
    branchStatusIdx: index("idx_goods_receipt_branch_status").on(
      table.branchId,
      table.status,
    ),
    supplierDateIdx: index("idx_goods_receipt_supplier_date").on(
      table.supplierId,
      table.receivedAt,
    ),
    revisionFk: foreignKey({
      name: "fk_grn_revision",
      columns: [table.purchaseOrderRevisionId],
      foreignColumns: [purchaseOrderRevisions.id],
    }),
    amountShape: check(
      "chk_goods_receipt_amounts",
      sql`${table.netAmount} >= 0 AND ${table.taxAmount} >= 0 AND ${table.totalAmount} = ${table.netAmount} + ${table.taxAmount}`,
    ),
    originRevision: check(
      "chk_goods_receipt_origin_revision",
      sql`${table.origin} = 'LEGACY_AGGREGATE' OR (${table.purchaseOrderRevisionId} IS NOT NULL AND ${table.createdBy} IS NOT NULL)`,
    ),
    postingShape: check(
      "chk_goods_receipt_posting",
      sql`${table.origin} = 'LEGACY_AGGREGATE' OR (${table.postedBy} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
  }),
);

export const goodsReceiptItems = mysqlTable(
  "goodsReceiptItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    goodsReceiptId: bigint("goodsReceiptId", { mode: "number" })
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: "cascade" }),
    lineNo: int("lineNo").notNull(),
    purchaseOrderItemId: bigint("purchaseOrderItemId", { mode: "number" })
      .notNull()
      .references(() => purchaseOrderItems.id),
    purchaseOrderRevisionItemId: bigint("purchaseOrderRevisionItemId", {
      mode: "number",
    }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(
      () => productUnits.id,
    ),
    receivedBaseQuantity: int("receivedBaseQuantity").notNull(),
    acceptedBaseQuantity: int("acceptedBaseQuantity").notNull(),
    rejectedBaseQuantity: int("rejectedBaseQuantity").default(0).notNull(),
    reversedBaseQuantity: int("reversedBaseQuantity").default(0).notNull(),
    returnedBaseQuantity: int("returnedBaseQuantity").default(0).notNull(),
    rejectionReason: varchar("rejectionReason", { length: 500 }),
    unitCostIqd: decimal("unitCostIqd", { precision: 15, scale: 2 }).notNull(),
    netAmount: decimal("netAmount", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalAmount: decimal("totalAmount", { precision: 15, scale: 2 }).notNull(),
    usdAmount: decimal("usdAmount", { precision: 15, scale: 2 }),
    inventoryMovementId: bigint("inventoryMovementId", { mode: "number" })
      .unique("uq_goods_receipt_inventory_movement")
      .references(() => inventoryMovements.id),
  },
  (table) => ({
    receiptLineUq: unique("uq_goods_receipt_line").on(
      table.goodsReceiptId,
      table.lineNo,
    ),
    receiptOrderItemUq: unique("uq_goods_receipt_order_item").on(
      table.goodsReceiptId,
      table.purchaseOrderItemId,
    ),
    orderItemIdx: index("idx_goods_receipt_item_order").on(
      table.purchaseOrderItemId,
    ),
    revisionItemIdx: index("idx_goods_receipt_item_revision").on(
      table.purchaseOrderRevisionItemId,
    ),
    revisionItemFk: foreignKey({
      name: "fk_grn_item_revision_item",
      columns: [table.purchaseOrderRevisionItemId],
      foreignColumns: [purchaseOrderRevisionItems.id],
    }),
    quantityShape: check(
      "chk_goods_receipt_item_quantities",
      sql`${table.receivedBaseQuantity} > 0 AND ${table.acceptedBaseQuantity} >= 0 AND ${table.rejectedBaseQuantity} >= 0 AND ${table.receivedBaseQuantity} = ${table.acceptedBaseQuantity} + ${table.rejectedBaseQuantity} AND ${table.reversedBaseQuantity} >= 0 AND ${table.returnedBaseQuantity} >= 0 AND ${table.reversedBaseQuantity} + ${table.returnedBaseQuantity} <= ${table.acceptedBaseQuantity}`,
    ),
    amountShape: check(
      "chk_goods_receipt_item_amounts",
      sql`${table.unitCostIqd} >= 0 AND ${table.netAmount} >= 0 AND ${table.taxAmount} >= 0 AND ${table.totalAmount} = ${table.netAmount} + ${table.taxAmount}`,
    ),
  }),
);

/** طلب عكس إذن استلام: صفر أثر حتى اعتماد شخص ثانٍ. */
export const goodsReceiptReversalRequests = mysqlTable(
  "goodsReceiptReversalRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 })
      .notNull()
      .unique("uq_grn_reversal_request_key"),
    goodsReceiptId: bigint("goodsReceiptId", { mode: "number" })
      .notNull()
      .references(() => goodsReceipts.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    baseReceiptVersion: int("baseReceiptVersion").notNull(),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "STALE"])
      .default("PENDING")
      .notNull(),
    pendingGuard: varchar("pendingGuard", { length: 180 }).unique(
      "uq_grn_reversal_pending",
    ),
    requestedBy: int("requestedBy")
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    reviewReason: varchar("reviewReason", { length: 500 }),
    decisionKey: varchar("decisionKey", { length: 120 }).unique(
      "uq_grn_reversal_decision_key",
    ),
    decisionHash: char("decisionHash", { length: 64 }),
    appliedAt: timestamp("appliedAt"),
  },
  (table) => ({
    branchStatusIdx: index("idx_grn_reversal_request_branch_status").on(
      table.branchId,
      table.status,
    ),
    receiptStatusIdx: index("idx_grn_reversal_request_receipt_status").on(
      table.goodsReceiptId,
      table.status,
    ),
    decisionShape: check(
      "chk_grn_reversal_request_decision",
      sql`(
        (${table.status} = 'PENDING' AND ${table.pendingGuard} IS NOT NULL AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.decisionKey} IS NULL AND ${table.decisionHash} IS NULL AND ${table.appliedAt} IS NULL)
        OR (${table.status} = 'APPROVED' AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NOT NULL)
        OR (${table.status} IN ('REJECTED','STALE') AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NULL)
      )`,
    ),
    // ⭐ قرار المالك (٤/٩/٢٦): توسيع «لا اعتماد ثانٍ بعد المالك» — قيدُ maker-checker
    // السابق (`chk_grn_reversal_request_maker_checker`) أُسقط بالهجرة 0334.
  }),
);

export const goodsReceiptReversalRequestItems = mysqlTable(
  "goodsReceiptReversalRequestItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestId: bigint("requestId", { mode: "number" })
      .notNull(),
    goodsReceiptItemId: bigint("goodsReceiptItemId", { mode: "number" })
      .notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    reason: varchar("reason", { length: 500 }),
  },
  (table) => ({
    requestItemUq: unique("uq_grn_reversal_request_item").on(
      table.requestId,
      table.goodsReceiptItemId,
    ),
    requestFk: foreignKey({
      name: "fk_grn_rev_req_item_request",
      columns: [table.requestId],
      foreignColumns: [goodsReceiptReversalRequests.id],
    }).onDelete("cascade"),
    receiptItemFk: foreignKey({
      name: "fk_grn_rev_req_item_receipt_item",
      columns: [table.goodsReceiptItemId],
      foreignColumns: [goodsReceiptItems.id],
    }),
    positiveQuantity: check(
      "chk_grn_reversal_request_item_qty",
      sql`${table.baseQuantity} > 0`,
    ),
  }),
);

/** مستند عكس نهائي؛ التصحيح اللاحق بمستند تعويضي جديد لا بتعديل هذا الصف. */
export const goodsReceiptReversals = mysqlTable(
  "goodsReceiptReversals",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    reversalNumber: varchar("reversalNumber", { length: 50 })
      .notNull()
      .unique("uq_grn_reversal_number"),
    requestId: bigint("requestId", { mode: "number" })
      .notNull()
      .unique("uq_grn_reversal_request"),
    goodsReceiptId: bigint("goodsReceiptId", { mode: "number" })
      .notNull()
      .references(() => goodsReceipts.id),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" })
      .notNull()
      .references(() => purchaseOrders.id),
    purchaseOrderRevisionId: bigint("purchaseOrderRevisionId", {
      mode: "number",
    })
      .notNull(),
    supplierId: bigint("supplierId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    netAmount: decimal("netAmount", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalAmount: decimal("totalAmount", { precision: 15, scale: 2 }).notNull(),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 })
      .notNull()
      .unique("uq_grn_reversal_hash"),
    reason: varchar("reason", { length: 500 }).notNull(),
    postedBy: int("postedBy")
      .notNull()
      .references(() => users.id),
    postedAt: timestamp("postedAt").defaultNow().notNull(),
  },
  (table) => ({
    receiptDateIdx: index("idx_grn_reversal_receipt_date").on(
      table.goodsReceiptId,
      table.postedAt,
    ),
    requestFk: foreignKey({
      name: "fk_grn_reversal_request",
      columns: [table.requestId],
      foreignColumns: [goodsReceiptReversalRequests.id],
    }),
    revisionFk: foreignKey({
      name: "fk_grn_reversal_revision",
      columns: [table.purchaseOrderRevisionId],
      foreignColumns: [purchaseOrderRevisions.id],
    }),
    amountShape: check(
      "chk_grn_reversal_amounts",
      sql`${table.netAmount} >= 0 AND ${table.taxAmount} >= 0 AND ${table.totalAmount} = ${table.netAmount} + ${table.taxAmount}`,
    ),
  }),
);

export const goodsReceiptReversalItems = mysqlTable(
  "goodsReceiptReversalItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    reversalId: bigint("reversalId", { mode: "number" })
      .notNull()
      .references(() => goodsReceiptReversals.id, { onDelete: "cascade" }),
    goodsReceiptItemId: bigint("goodsReceiptItemId", { mode: "number" })
      .notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    netAmount: decimal("netAmount", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalAmount: decimal("totalAmount", { precision: 15, scale: 2 }).notNull(),
    inventoryMovementId: bigint("inventoryMovementId", { mode: "number" })
      .notNull()
      .unique("uq_grn_reversal_inventory_movement"),
  },
  (table) => ({
    reversalItemUq: unique("uq_grn_reversal_item").on(
      table.reversalId,
      table.goodsReceiptItemId,
    ),
    receiptItemFk: foreignKey({
      name: "fk_grn_reversal_item_receipt_item",
      columns: [table.goodsReceiptItemId],
      foreignColumns: [goodsReceiptItems.id],
    }),
    movementFk: foreignKey({
      name: "fk_grn_reversal_item_movement",
      columns: [table.inventoryMovementId],
      foreignColumns: [inventoryMovements.id],
    }),
    shape: check(
      "chk_grn_reversal_item_shape",
      sql`${table.baseQuantity} > 0 AND ${table.netAmount} >= 0 AND ${table.taxAmount} >= 0 AND ${table.totalAmount} = ${table.netAmount} + ${table.taxAmount}`,
    ),
  }),
);

/** روابط القيود تسمح بعدة استلامات/عكوس وتربط الترحيل القديم بقيوده الحقيقية. */
export const goodsReceiptAccountingLinks = mysqlTable(
  "goodsReceiptAccountingLinks",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    linkKey: varchar("linkKey", { length: 160 })
      .notNull()
      .unique("uq_grn_accounting_link_key"),
    goodsReceiptId: bigint("goodsReceiptId", { mode: "number" })
      .notNull()
      .references(() => goodsReceipts.id),
    reversalId: bigint("reversalId", { mode: "number" }),
    accountingEntryId: bigint("accountingEntryId", { mode: "number" })
      .notNull()
      .unique("uq_grn_accounting_entry"),
    linkType: mysqlEnum("linkType", [
      "GRNI_RECOGNITION",
      "GRNI_REVERSAL",
      "LEGACY_PURCHASE",
    ]).notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    receiptIdx: index("idx_grn_accounting_receipt").on(table.goodsReceiptId),
    reversalFk: foreignKey({
      name: "fk_grn_accounting_reversal",
      columns: [table.reversalId],
      foreignColumns: [goodsReceiptReversals.id],
    }),
    entryFk: foreignKey({
      name: "fk_grn_accounting_entry",
      columns: [table.accountingEntryId],
      foreignColumns: [accountingEntries.id],
    }),
    shape: check(
      "chk_grn_accounting_link_shape",
      sql`${table.amount} >= 0 AND ((${table.linkType} = 'GRNI_REVERSAL' AND ${table.reversalId} IS NOT NULL) OR (${table.linkType} <> 'GRNI_REVERSAL' AND ${table.reversalId} IS NULL))`,
    ),
  }),
);

/** فاتورة المورد المستقلة: AP لا ينشأ إلا عند POSTED؛ قبلها المطابقة بلا أثر مالي. */
export const supplierInvoices = mysqlTable(
  "supplierInvoices",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    invoiceNumber: varchar("invoiceNumber", { length: 60 })
      .notNull()
      .unique("uq_supplier_invoice_number"),
    clientRequestId: varchar("clientRequestId", { length: 120 })
      .notNull()
      .unique("uq_supplier_invoice_request"),
    origin: mysqlEnum("origin", ["NATIVE", "LEGACY"])
      .default("NATIVE")
      .notNull(),
    /**
     * تصنيف مصدر الالتزام، مستقل عن POSTED: قيد CASH_CLEARING ليس AP صالحاً
     * لسداد جديد، وNULL التاريخي يبقى UNKNOWN حتى معالجة قضية النزاهة.
     */
    liabilityClass: mysqlEnum("liabilityClass", [
      "NATIVE_AP",
      "LEGACY_AP",
      "LEGACY_CASH_CLEARING",
      "LEGACY_UNKNOWN",
    ])
      .default("NATIVE_AP")
      .notNull(),
    /** بوابة إنشاء سداد جديد؛ OPEN فقط هو المؤهل لمسار supplierPayments. */
    paymentGate: mysqlEnum("paymentGate", [
      "OPEN",
      "SETTLED",
      "BLOCKED_CASH_CLEARING",
      "BLOCKED_REVIEW",
    ])
      .default("OPEN")
      .notNull(),
    legacyPurchaseOrderId: bigint("legacyPurchaseOrderId", {
      mode: "number",
    }).references(() => purchaseOrders.id),
    supplierId: bigint("supplierId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id),
    externalInvoiceNumber: varchar("externalInvoiceNumber", { length: 160 }),
    externalNumberNorm: varchar("externalNumberNorm", { length: 160 }),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    status: mysqlEnum("status", [
      "DRAFT",
      "ON_HOLD",
      "MATCHED",
      "POSTED",
      "REVERSED",
    ])
      .default("DRAFT")
      .notNull(),
    version: int("version").default(1).notNull(),
    draftState: mysqlEnum("draftState", ["ACTIVE", "VOIDED"])
      .default("ACTIVE")
      .notNull(),
    invoiceDate: date("invoiceDate", { mode: "string" }).notNull(),
    dueDate: date("dueDate", { mode: "string" }),
    currency: mysqlEnum("currency", ["IQD", "USD"]).notNull(),
    agreedRate: decimal("agreedRate", { precision: 15, scale: 4 }),
    subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    discountAmount: decimal("discountAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalAmount: decimal("totalAmount", { precision: 15, scale: 2 }).notNull(),
    /** تسوية إرثية مثبتة حصراً من قيود/إيصالات حتمية؛ ليست دفعة مختلقة. */
    legacySettledAmount: decimal("legacySettledAmount", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    legacySettlementEvidenceHash: char("legacySettlementEvidenceHash", {
      length: 64,
    }),
    paymentGateReason: varchar("paymentGateReason", { length: 500 }),
    usdTotal: decimal("usdTotal", { precision: 15, scale: 2 }),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    evidenceType: mysqlEnum("evidenceType", [
      "DOCUMENT_IMAGE",
      "PDF",
      "EMAIL",
      "EDI",
      "LEGACY_LEDGER",
      "OTHER",
    ]).notNull(),
    evidenceReference: varchar("evidenceReference", { length: 500 }),
    holdReason: varchar("holdReason", { length: 500 }),
    postingEntryId: bigint("postingEntryId", { mode: "number" })
      .unique("uq_supplier_invoice_posting_entry")
      .references(() => accountingEntries.id),
    reversalEntryId: bigint("reversalEntryId", { mode: "number" })
      .unique("uq_supplier_invoice_reversal_entry")
      .references(() => accountingEntries.id),
    createdBy: int("createdBy").references(() => users.id),
    postedBy: int("postedBy").references(() => users.id),
    postedAt: timestamp("postedAt"),
    reversedBy: int("reversedBy").references(() => users.id),
    reversedAt: timestamp("reversedAt"),
    reversalReason: varchar("reversalReason", { length: 500 }),
    voidedBy: int("voidedBy").references(() => users.id),
    voidedAt: timestamp("voidedAt"),
    voidReason: varchar("voidReason", { length: 500 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    supplierExternalUq: unique("uq_supplier_invoice_external").on(
      table.supplierId,
      table.externalNumberNorm,
    ),
    requestHashUq: unique("uq_supplier_invoice_request_hash").on(
      table.clientRequestId,
      table.payloadHash,
    ),
    branchStatusIdx: index("idx_supplier_invoice_branch_status").on(
      table.branchId,
      table.status,
    ),
    supplierDateIdx: index("idx_supplier_invoice_supplier_date").on(
      table.supplierId,
      table.invoiceDate,
    ),
    paymentGateIdx: index("idx_supplier_invoice_payment_gate").on(
      table.branchId,
      table.paymentGate,
      table.status,
    ),
    amountShape: check(
      "chk_supplier_invoice_amounts",
      sql`${table.subtotal} >= 0 AND ${table.taxAmount} >= 0 AND ${table.discountAmount} >= 0 AND ${table.discountAmount} <= ${table.subtotal} + ${table.taxAmount} AND ${table.totalAmount} = ${table.subtotal} + ${table.taxAmount} - ${table.discountAmount}`,
    ),
    nativeDocument: check(
      "chk_supplier_invoice_native_document",
      sql`${table.origin} = 'LEGACY' OR (${table.externalInvoiceNumber} IS NOT NULL AND CHAR_LENGTH(TRIM(${table.externalInvoiceNumber})) > 0 AND ${table.externalNumberNorm} IS NOT NULL AND CHAR_LENGTH(TRIM(${table.externalNumberNorm})) > 0 AND ${table.createdBy} IS NOT NULL AND ${table.evidenceReference} IS NOT NULL AND CHAR_LENGTH(TRIM(${table.evidenceReference})) > 0)`,
    ),
    lifecycleShape: check(
      "chk_supplier_invoice_lifecycle",
      sql`(
        (${table.status} IN ('DRAFT','ON_HOLD','MATCHED') AND ${table.postingEntryId} IS NULL AND ${table.postedAt} IS NULL AND ${table.reversalEntryId} IS NULL AND ${table.reversedAt} IS NULL)
        OR (${table.status} = 'POSTED' AND (${table.origin} = 'LEGACY' OR (${table.postingEntryId} IS NOT NULL AND ${table.postedBy} IS NOT NULL AND ${table.postedAt} IS NOT NULL)) AND ${table.reversalEntryId} IS NULL AND ${table.reversedAt} IS NULL)
        OR (${table.status} = 'REVERSED' AND ${table.postingEntryId} IS NOT NULL AND ${table.postedAt} IS NOT NULL AND ${table.reversalEntryId} IS NOT NULL AND ${table.reversedBy} IS NOT NULL AND ${table.reversedAt} IS NOT NULL AND ${table.reversalReason} IS NOT NULL)
      )`,
    ),
    legacyLiabilityShape: check(
      "chk_supplier_invoice_legacy_liability",
      sql`(
        (${table.origin} = 'NATIVE' AND ${table.liabilityClass} = 'NATIVE_AP' AND ${table.paymentGate} IN ('OPEN','SETTLED') AND ${table.legacyPurchaseOrderId} IS NULL AND ${table.legacySettledAmount} = 0 AND ${table.legacySettlementEvidenceHash} IS NULL)
        OR (${table.origin} = 'LEGACY' AND ${table.liabilityClass} <> 'NATIVE_AP' AND ${table.legacyPurchaseOrderId} IS NOT NULL AND ${table.legacySettlementEvidenceHash} IS NOT NULL
          AND ((${table.liabilityClass} = 'LEGACY_CASH_CLEARING' AND ${table.paymentGate} = 'BLOCKED_CASH_CLEARING' AND ${table.legacySettledAmount} = 0)
            OR (${table.liabilityClass} = 'LEGACY_UNKNOWN' AND ${table.paymentGate} = 'BLOCKED_REVIEW' AND ${table.legacySettledAmount} = 0)
            OR (${table.liabilityClass} = 'LEGACY_AP' AND ${table.paymentGate} IN ('OPEN','SETTLED','BLOCKED_REVIEW'))))
      ) AND ${table.legacySettledAmount} >= 0 AND ${table.legacySettledAmount} <= ${table.totalAmount}`,
    ),
    draftStateShape: check(
      "chk_supplier_invoice_draft_state",
      sql`(
        (${table.draftState} = 'ACTIVE' AND ${table.voidedBy} IS NULL AND ${table.voidedAt} IS NULL AND ${table.voidReason} IS NULL)
        OR (${table.draftState} = 'VOIDED' AND ${table.status} = 'DRAFT' AND ${table.voidedBy} IS NOT NULL AND ${table.voidedAt} IS NOT NULL AND ${table.voidReason} IS NOT NULL AND CHAR_LENGTH(TRIM(${table.voidReason})) >= 3)
      )`,
    ),
  }),
);

/** سجل append-only لكل تعديل أو إلغاء لمسودة فاتورة مورد. */
export const supplierInvoiceDraftRevisions = mysqlTable(
  "supplierInvoiceDraftRevisions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    supplierInvoiceId: bigint("supplierInvoiceId", { mode: "number" })
      .notNull(),
    revisionNo: int("revisionNo").notNull(),
    action: mysqlEnum("action", ["UPDATE_DRAFT", "VOID_DRAFT"]).notNull(),
    requestKey: varchar("requestKey", { length: 120 }).notNull(),
    requestPayloadHash: char("requestPayloadHash", { length: 64 }).notNull(),
    baseVersion: int("baseVersion").notNull(),
    resultVersion: int("resultVersion").notNull(),
    beforeCanonical: mediumtext("beforeCanonical").notNull(),
    beforeHash: char("beforeHash", { length: 64 }).notNull(),
    afterCanonical: mediumtext("afterCanonical").notNull(),
    afterHash: char("afterHash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    actedBy: int("actedBy").notNull().references(() => users.id),
    actedAt: timestamp("actedAt").defaultNow().notNull(),
  },
  (table) => ({
    revisionNoUq: unique("uq_supplier_invoice_draft_revision_no").on(
      table.supplierInvoiceId,
      table.revisionNo,
    ),
    versionUq: unique("uq_supplier_invoice_draft_revision_version").on(
      table.supplierInvoiceId,
      table.resultVersion,
    ),
    requestKeyUq: unique("uq_supplier_invoice_draft_request_key").on(
      table.requestKey,
    ),
    actorIdx: index("idx_supplier_invoice_draft_revision_actor").on(
      table.actedBy,
      table.actedAt,
    ),
    invoiceFk: foreignKey({
      name: "fk_supplier_invoice_draft_revision_invoice",
      columns: [table.supplierInvoiceId],
      foreignColumns: [supplierInvoices.id],
    }),
    shape: check(
      "chk_supplier_invoice_draft_revision_shape",
      sql`${table.revisionNo} > 0 AND ${table.baseVersion} > 0 AND ${table.resultVersion} = ${table.baseVersion} + 1 AND CHAR_LENGTH(TRIM(${table.reason})) >= 3`,
    ),
  }),
);

export const supplierInvoiceLines = mysqlTable(
  "supplierInvoiceLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    supplierInvoiceId: bigint("supplierInvoiceId", { mode: "number" })
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: "cascade" }),
    lineNo: int("lineNo").notNull(),
    purchaseOrderRevisionItemId: bigint("purchaseOrderRevisionItemId", {
      mode: "number",
    }),
    variantId: bigint("variantId", { mode: "number" }).references(
      () => productVariants.id,
    ),
    description: varchar("description", { length: 500 }).notNull(),
    invoicedBaseQuantity: int("invoicedBaseQuantity").notNull(),
    unitPriceIqd: decimal("unitPriceIqd", { precision: 15, scale: 2 }).notNull(),
    netAmount: decimal("netAmount", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalAmount: decimal("totalAmount", { precision: 15, scale: 2 }).notNull(),
    usdUnitPrice: decimal("usdUnitPrice", { precision: 15, scale: 4 }),
    usdTotal: decimal("usdTotal", { precision: 15, scale: 2 }),
  },
  (table) => ({
    invoiceLineUq: unique("uq_supplier_invoice_line").on(
      table.supplierInvoiceId,
      table.lineNo,
    ),
    revisionItemIdx: index("idx_supplier_invoice_line_revision").on(
      table.purchaseOrderRevisionItemId,
    ),
    revisionItemFk: foreignKey({
      name: "fk_supplier_invoice_line_revision",
      columns: [table.purchaseOrderRevisionItemId],
      foreignColumns: [purchaseOrderRevisionItems.id],
    }),
    shape: check(
      "chk_supplier_invoice_line_shape",
      sql`${table.lineNo} > 0 AND ${table.invoicedBaseQuantity} > 0 AND ${table.unitPriceIqd} >= 0 AND ${table.netAmount} >= 0 AND ${table.taxAmount} >= 0 AND ${table.totalAmount} = ${table.netAmount} + ${table.taxAmount}`,
    ),
  }),
);

/** نتيجة مطابقة محفوظة بلقطة حدودها؛ تغيير الإعدادات لا يغيّر حكم تشغيل قديم. */
export const supplierInvoiceMatchRuns = mysqlTable(
  "supplierInvoiceMatchRuns",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    matchKey: varchar("matchKey", { length: 160 })
      .notNull()
      .unique("uq_supplier_invoice_match_key"),
    supplierInvoiceId: bigint("supplierInvoiceId", { mode: "number" })
      .notNull(),
    supplierId: bigint("supplierId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    runNo: int("runNo").notNull(),
    outcome: mysqlEnum("outcome", ["EXACT", "WITHIN_TOLERANCE", "HOLD"]).notNull(),
    policyVersion: int("policyVersion").notNull(),
    policySnapshot: mediumtext("policySnapshot").notNull(),
    policyHash: char("policyHash", { length: 64 }).notNull(),
    poRevisionSetHash: char("poRevisionSetHash", { length: 64 }).notNull(),
    goodsReceiptSetHash: char("goodsReceiptSetHash", { length: 64 }).notNull(),
    invoiceHash: char("invoiceHash", { length: 64 }).notNull(),
    priceTolerancePercent: decimal("priceTolerancePercent", {
      precision: 7,
      scale: 4,
    }).notNull(),
    quantityToleranceBase: int("quantityToleranceBase").default(0).notNull(),
    totalToleranceAmount: decimal("totalToleranceAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    orderedBaseQuantity: int("orderedBaseQuantity").notNull(),
    receivedBaseQuantity: int("receivedBaseQuantity").notNull(),
    invoicedBaseQuantity: int("invoicedBaseQuantity").notNull(),
    poTotal: decimal("poTotal", { precision: 15, scale: 2 }).notNull(),
    grnTotal: decimal("grnTotal", { precision: 15, scale: 2 }).notNull(),
    invoiceTotal: decimal("invoiceTotal", { precision: 15, scale: 2 }).notNull(),
    quantityVarianceBase: int("quantityVarianceBase").notNull(),
    priceVarianceAmount: decimal("priceVarianceAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    totalVarianceAmount: decimal("totalVarianceAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    outcomeReason: varchar("outcomeReason", { length: 500 }),
    holdCodes: json("holdCodes").notNull(),
    evidenceSnapshot: mediumtext("evidenceSnapshot").notNull(),
    evidenceHash: char("evidenceHash", { length: 64 }).notNull(),
    performedBy: int("performedBy")
      .notNull()
      .references(() => users.id),
    performedAt: timestamp("performedAt").defaultNow().notNull(),
  },
  (table) => ({
    invoiceRunUq: unique("uq_supplier_invoice_match_run").on(
      table.supplierInvoiceId,
      table.runNo,
    ),
    invoiceEvidenceUq: unique("uq_supplier_invoice_match_evidence").on(
      table.supplierInvoiceId,
      table.evidenceHash,
    ),
    invoiceDateIdx: index("idx_supplier_invoice_match_date").on(
      table.supplierInvoiceId,
      table.performedAt,
    ),
    branchOutcomeIdx: index("idx_supplier_invoice_match_branch_outcome").on(
      table.branchId,
      table.outcome,
    ),
    invoiceFk: foreignKey({
      name: "fk_supplier_match_invoice",
      columns: [table.supplierInvoiceId],
      foreignColumns: [supplierInvoices.id],
    }),
    toleranceShape: check(
      "chk_supplier_invoice_match_tolerances",
      sql`${table.runNo} > 0 AND ${table.policyVersion} > 0 AND ${table.priceTolerancePercent} >= 0 AND ${table.quantityToleranceBase} >= 0 AND ${table.totalToleranceAmount} >= 0 AND ${table.orderedBaseQuantity} >= 0 AND ${table.receivedBaseQuantity} >= 0 AND ${table.invoicedBaseQuantity} >= 0`,
    ),
  }),
);

export const supplierInvoiceMatchAllocations = mysqlTable(
  "supplierInvoiceMatchAllocations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    matchRunId: bigint("matchRunId", { mode: "number" })
      .notNull(),
    supplierInvoiceLineId: bigint("supplierInvoiceLineId", { mode: "number" })
      .notNull(),
    purchaseOrderRevisionItemId: bigint("purchaseOrderRevisionItemId", {
      mode: "number",
    })
      .notNull(),
    goodsReceiptItemId: bigint("goodsReceiptItemId", { mode: "number" })
      .notNull(),
    matchedBaseQuantity: int("matchedBaseQuantity").notNull(),
    poUnitPriceIqd: decimal("poUnitPriceIqd", { precision: 15, scale: 2 }).notNull(),
    grnUnitCostIqd: decimal("grnUnitCostIqd", { precision: 15, scale: 2 }).notNull(),
    invoiceUnitPriceIqd: decimal("invoiceUnitPriceIqd", {
      precision: 15,
      scale: 2,
    }).notNull(),
    quantityVarianceBase: int("quantityVarianceBase").notNull(),
    priceVarianceAmount: decimal("priceVarianceAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    matchedAmount: decimal("matchedAmount", { precision: 15, scale: 2 }).notNull(),
  },
  (table) => ({
    allocationUq: unique("uq_supplier_invoice_match_allocation").on(
      table.matchRunId,
      table.supplierInvoiceLineId,
      table.goodsReceiptItemId,
    ),
    receiptItemIdx: index("idx_supplier_invoice_match_grn_item").on(
      table.goodsReceiptItemId,
    ),
    runFk: foreignKey({
      name: "fk_supplier_match_alloc_run",
      columns: [table.matchRunId],
      foreignColumns: [supplierInvoiceMatchRuns.id],
    }).onDelete("cascade"),
    invoiceLineFk: foreignKey({
      name: "fk_supplier_match_alloc_invoice_line",
      columns: [table.supplierInvoiceLineId],
      foreignColumns: [supplierInvoiceLines.id],
    }),
    revisionItemFk: foreignKey({
      name: "fk_supplier_match_alloc_revision_item",
      columns: [table.purchaseOrderRevisionItemId],
      foreignColumns: [purchaseOrderRevisionItems.id],
    }),
    receiptItemFk: foreignKey({
      name: "fk_supplier_match_alloc_grn_item",
      columns: [table.goodsReceiptItemId],
      foreignColumns: [goodsReceiptItems.id],
    }),
    shape: check(
      "chk_supplier_invoice_match_allocation_shape",
      sql`${table.matchedBaseQuantity} > 0 AND ${table.poUnitPriceIqd} >= 0 AND ${table.grnUnitCostIqd} >= 0 AND ${table.invoiceUnitPriceIqd} >= 0 AND ${table.matchedAmount} >= 0`,
    ),
  }),
);

/** اعتماد الترحيل أو العكس مع SOD وبصمة قرار؛ HOLD صلب ولا يملك نوع تجاوز. */
export const supplierInvoiceApprovalRequests = mysqlTable(
  "supplierInvoiceApprovalRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 })
      .notNull()
      .unique("uq_supplier_invoice_approval_request"),
    supplierInvoiceId: bigint("supplierInvoiceId", { mode: "number" })
      .notNull(),
    matchRunId: bigint("matchRunId", { mode: "number" }),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    kind: mysqlEnum("kind", ["POST_INVOICE", "REVERSE_INVOICE"]).notNull(),
    baseInvoiceVersion: int("baseInvoiceVersion").notNull(),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    evidenceType: mysqlEnum("evidenceType", [
      "DOCUMENT_IMAGE",
      "PDF",
      "EMAIL",
      "SIGNED_APPROVAL",
      "OTHER",
    ]),
    evidenceReference: varchar("evidenceReference", { length: 500 }),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "STALE"])
      .default("PENDING")
      .notNull(),
    pendingGuard: varchar("pendingGuard", { length: 180 }).unique(
      "uq_supplier_invoice_approval_pending",
    ),
    requestedBy: int("requestedBy")
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    reviewReason: varchar("reviewReason", { length: 500 }),
    decisionKey: varchar("decisionKey", { length: 120 }).unique(
      "uq_supplier_invoice_approval_decision",
    ),
    decisionHash: char("decisionHash", { length: 64 }),
    appliedAt: timestamp("appliedAt"),
  },
  (table) => ({
    branchStatusIdx: index("idx_supplier_invoice_approval_branch_status").on(
      table.branchId,
      table.status,
    ),
    invoiceStatusIdx: index("idx_supplier_invoice_approval_invoice_status").on(
      table.supplierInvoiceId,
      table.status,
    ),
    invoiceFk: foreignKey({
      name: "fk_supplier_invoice_approval_invoice",
      columns: [table.supplierInvoiceId],
      foreignColumns: [supplierInvoices.id],
    }),
    matchRunFk: foreignKey({
      name: "fk_supplier_invoice_approval_match",
      columns: [table.matchRunId],
      foreignColumns: [supplierInvoiceMatchRuns.id],
    }),
    decisionShape: check(
      "chk_supplier_invoice_approval_decision",
      sql`(
        (${table.status} = 'PENDING' AND ${table.pendingGuard} IS NOT NULL AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.decisionKey} IS NULL AND ${table.decisionHash} IS NULL AND ${table.appliedAt} IS NULL)
        OR (${table.status} = 'APPROVED' AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NOT NULL)
        OR (${table.status} IN ('REJECTED','STALE') AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NULL)
      )`,
    ),
    // ⭐ قرار المالك (٤/٩/٢٦): توسيع «لا اعتماد ثانٍ بعد المالك» — قيدُ maker-checker
    // السابق (`chk_supplier_invoice_approval_maker_checker`) أُسقط بالهجرة 0334.
  }),
);

/** مستند مرتجع شراء مستقلّ؛ لا نستخدم قيد الدفتر أو أمر الشراء كهوية للمرتجع. */
export const purchaseReturns = mysqlTable(
  "purchaseReturns",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    returnNumber: varchar("returnNumber", { length: 50 }).notNull().unique(),
    clientRequestId: varchar("clientRequestId", { length: 80 })
      .notNull()
      .unique(),
    origin: mysqlEnum("origin", ["NATIVE", "LEGACY"])
      .default("NATIVE")
      .notNull(),
    status: mysqlEnum("status", [
      "POSTED",
      "PARTIALLY_REVERSED",
      "REVERSED",
    ])
      .default("POSTED")
      .notNull(),
    version: int("version").default(1).notNull(),
    requestId: bigint("requestId", { mode: "number" })
      .unique("uq_purchase_return_request")
      .references((): AnyMySqlColumn => purchaseReturnRequests.id),
    supplierInvoiceId: bigint("supplierInvoiceId", { mode: "number" }),
    matchRunId: bigint("matchRunId", { mode: "number" }).references(
      () => supplierInvoiceMatchRuns.id,
    ),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" })
      .notNull()
      .references(() => purchaseOrders.id),
    supplierId: bigint("supplierId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    accountingEntryId: bigint("accountingEntryId", { mode: "number" })
      .unique()
      .references(() => accountingEntries.id, { onDelete: "set null" }),
    cashRefundReceiptId: bigint("cashRefundReceiptId", { mode: "number" })
      .unique("uq_purchase_return_cash_receipt")
      .references(() => receipts.id),
    settlement: mysqlEnum("settlement", ["CREDIT", "CASH"])
      .default("CREDIT")
      .notNull(),
    paymentMethod: mysqlEnum("paymentMethod", [
      "CASH",
      "CARD",
      "CHECK",
      "TRANSFER",
      "WALLET",
    ])
      .default("CASH")
      .notNull(),
    netAmount: decimal("netAmount", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalAmount: decimal("totalAmount", { precision: 15, scale: 2 }).notNull(),
    cashRefundAmount: decimal("cashRefundAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    creditOffsetAmount: decimal("creditOffsetAmount", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    reason: varchar("reason", { length: 500 }),
    payloadCanonical: mediumtext("payloadCanonical"),
    payloadHash: char("payloadHash", { length: 64 }),
    evidenceType: mysqlEnum("evidenceType", [
      "RETURN_NOTE",
      "SUPPLIER_ACKNOWLEDGEMENT",
      "DOCUMENT_IMAGE",
      "PDF",
      "EMAIL",
      "OTHER",
      "LEGACY_LEDGER",
    ]),
    evidenceReference: varchar("evidenceReference", { length: 500 }),
    postedBy: int("postedBy").references(() => users.id),
    postedAt: timestamp("postedAt"),
    createdBy: int("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByNameSnapshot: varchar("createdByNameSnapshot", {
      length: 255,
    }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    poIdx: index("idx_purchase_returns_po").on(table.purchaseOrderId),
    supplierDateIdx: index("idx_purchase_returns_supplier_date").on(
      table.supplierId,
      table.createdAt,
    ),
    branchDateIdx: index("idx_purchase_returns_branch_date").on(
      table.branchId,
      table.createdAt,
    ),
    invoiceStatusIdx: index("idx_purchase_return_invoice_status").on(
      table.supplierInvoiceId,
      table.status,
    ),
    nativeSourceShape: check(
      "chk_purchase_return_native_source",
      sql`${table.origin} = 'LEGACY' OR (${table.requestId} IS NOT NULL AND ${table.supplierInvoiceId} IS NOT NULL AND ${table.matchRunId} IS NOT NULL AND ${table.payloadCanonical} IS NOT NULL AND ${table.payloadHash} IS NOT NULL AND ${table.evidenceType} IS NOT NULL AND ${table.evidenceReference} IS NOT NULL AND ${table.postedBy} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
    amountShape: check(
      "chk_purchase_return_amounts",
      sql`${table.netAmount} >= 0 AND ${table.taxAmount} >= 0 AND ${table.totalAmount} = ${table.netAmount} + ${table.taxAmount} AND ${table.cashRefundAmount} >= 0 AND ${table.creditOffsetAmount} >= 0 AND ${table.cashRefundAmount} + ${table.creditOffsetAmount} = ${table.totalAmount}`,
    ),
    cashReceiptShape: check(
      "chk_purchase_return_cash_receipt",
      sql`${table.origin} = 'LEGACY' OR ((${table.cashRefundAmount} = 0 AND ${table.cashRefundReceiptId} IS NULL) OR (${table.cashRefundAmount} > 0 AND ${table.cashRefundReceiptId} IS NOT NULL))`,
    ),
  }),
);

export const purchaseReturnItems = mysqlTable(
  "purchaseReturnItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    purchaseReturnId: bigint("purchaseReturnId", { mode: "number" })
      .notNull()
      .references(() => purchaseReturns.id, { onDelete: "cascade" }),
    purchaseOrderItemId: bigint("purchaseOrderItemId", { mode: "number" })
      .notNull()
      .references(() => purchaseOrderItems.id),
    supplierInvoiceLineId: bigint("supplierInvoiceLineId", {
      mode: "number",
    }),
    goodsReceiptItemId: bigint("goodsReceiptItemId", { mode: "number" }).references(
      () => goodsReceiptItems.id,
    ),
    matchAllocationId: bigint("matchAllocationId", { mode: "number" }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(
      () => productUnits.id,
    ),
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
    lineTotal: decimal("lineTotal", { precision: 15, scale: 2 }).notNull(),
    inventoryMovementId: bigint("inventoryMovementId", { mode: "number" })
      .unique("uq_purchase_return_inventory_movement")
      .references(() => inventoryMovements.id),
    productNameSnapshot: varchar("productNameSnapshot", {
      length: 255,
    }).notNull(),
    variantNameSnapshot: varchar("variantNameSnapshot", { length: 120 }),
    unitNameSnapshot: varchar("unitNameSnapshot", { length: 80 }),
  },
  (table) => ({
    returnIdx: index("idx_purchase_return_items_return").on(
      table.purchaseReturnId,
    ),
    poItemIdx: index("idx_purchase_return_items_po_item").on(
      table.purchaseOrderItemId,
    ),
    sourceIdx: index("idx_purchase_return_item_source").on(
      table.supplierInvoiceLineId,
      table.goodsReceiptItemId,
    ),
    invoiceLineFk: foreignKey({
      name: "fk_pri_invoice_line",
      columns: [table.supplierInvoiceLineId],
      foreignColumns: [supplierInvoiceLines.id],
    }),
    matchAllocationFk: foreignKey({
      name: "fk_pri_match_alloc",
      columns: [table.matchAllocationId],
      foreignColumns: [supplierInvoiceMatchAllocations.id],
    }),
    sourceShape: check(
      "chk_purchase_return_item_source",
      sql`(${table.supplierInvoiceLineId} IS NULL AND ${table.goodsReceiptItemId} IS NULL AND ${table.matchAllocationId} IS NULL) OR (${table.supplierInvoiceLineId} IS NOT NULL AND ${table.goodsReceiptItemId} IS NOT NULL AND ${table.matchAllocationId} IS NOT NULL)`,
    ),
    amountShape: check(
      "chk_purchase_return_item_amounts",
      sql`${table.quantity} > 0 AND ${table.baseQuantity} > 0 AND ${table.unitPrice} >= 0 AND ${table.lineTotal} >= 0`,
    ),
  }),
);

/**
 * طلب مرتجع شراء محكوم. إنشاء الطلب صفر أثر: لا مخزون ولا AP ولا نقد حتى قرار
 * مراجع ثانٍ على نفس نسخة فاتورة المورد وبصمة المصادر الثلاثية.
 */
export const purchaseReturnRequests = mysqlTable(
  "purchaseReturnRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 })
      .notNull()
      .unique("uq_purchase_return_request_key"),
    supplierInvoiceId: bigint("supplierInvoiceId", { mode: "number" })
      .notNull(),
    matchRunId: bigint("matchRunId", { mode: "number" })
      .notNull()
      .references(() => supplierInvoiceMatchRuns.id),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" })
      .notNull()
      .references(() => purchaseOrders.id),
    supplierId: bigint("supplierId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    baseInvoiceVersion: int("baseInvoiceVersion").notNull(),
    settlement: mysqlEnum("settlement", ["CREDIT", "CASH"])
      .default("CREDIT")
      .notNull(),
    paymentMethod: mysqlEnum("paymentMethod", [
      "CASH",
      "CARD",
      "TRANSFER",
      "WALLET",
    ])
      .default("CASH")
      .notNull(),
    requestedNetAmount: decimal("requestedNetAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    requestedTaxAmount: decimal("requestedTaxAmount", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    requestedTotalAmount: decimal("requestedTotalAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    evidenceType: mysqlEnum("evidenceType", [
      "RETURN_NOTE",
      "SUPPLIER_ACKNOWLEDGEMENT",
      "DOCUMENT_IMAGE",
      "PDF",
      "EMAIL",
      "OTHER",
    ]).notNull(),
    evidenceReference: varchar("evidenceReference", { length: 500 }).notNull(),
    evidenceHash: char("evidenceHash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "STALE"])
      .default("PENDING")
      .notNull(),
    pendingGuard: varchar("pendingGuard", { length: 180 }).unique(
      "uq_purchase_return_pending",
    ),
    requestedBy: int("requestedBy")
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    reviewReason: varchar("reviewReason", { length: 500 }),
    decisionKey: varchar("decisionKey", { length: 120 }).unique(
      "uq_purchase_return_decision",
    ),
    decisionHash: char("decisionHash", { length: 64 }),
    appliedAt: timestamp("appliedAt"),
  },
  (table) => ({
    invoiceStatusIdx: index("idx_purchase_return_req_invoice_status").on(
      table.supplierInvoiceId,
      table.status,
    ),
    branchStatusIdx: index("idx_purchase_return_req_branch_status").on(
      table.branchId,
      table.status,
    ),
    evidenceUq: unique("uq_purchase_return_request_evidence").on(
      table.supplierInvoiceId,
      table.evidenceHash,
    ),
    amountShape: check(
      "chk_purchase_return_request_amounts",
      sql`${table.requestedNetAmount} >= 0 AND ${table.requestedTaxAmount} >= 0 AND ${table.requestedTotalAmount} = ${table.requestedNetAmount} + ${table.requestedTaxAmount}`,
    ),
    decisionShape: check(
      "chk_purchase_return_request_decision",
      sql`(
        (${table.status} = 'PENDING' AND ${table.pendingGuard} IS NOT NULL AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.decisionKey} IS NULL AND ${table.decisionHash} IS NULL AND ${table.appliedAt} IS NULL)
        OR (${table.status} = 'APPROVED' AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NOT NULL)
        OR (${table.status} IN ('REJECTED','STALE') AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NULL)
      )`,
    ),
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — قيدُ maker-checker السابق
    // (`chk_purchase_return_request_maker_checker`) أُسقط بالهجرة 0333؛ التطبيقُ وحده
    // يفرض الآن «معتمِدٌ نشطٌ isOwner» (لا يمكن للقيد أن يقرأ isOwner من جدولٍ آخر).
  }),
);

export const purchaseReturnRequestItems = mysqlTable(
  "purchaseReturnRequestItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestId: bigint("requestId", { mode: "number" })
      .notNull(),
    lineNo: int("lineNo").notNull(),
    supplierInvoiceLineId: bigint("supplierInvoiceLineId", { mode: "number" })
      .notNull(),
    goodsReceiptItemId: bigint("goodsReceiptItemId", { mode: "number" })
      .notNull(),
    matchAllocationId: bigint("matchAllocationId", { mode: "number" })
      .notNull(),
    purchaseOrderItemId: bigint("purchaseOrderItemId", { mode: "number" })
      .notNull(),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    requestedBaseQuantity: int("requestedBaseQuantity").notNull(),
    unitPriceIqd: decimal("unitPriceIqd", { precision: 15, scale: 2 }).notNull(),
    netAmount: decimal("netAmount", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalAmount: decimal("totalAmount", { precision: 15, scale: 2 }).notNull(),
    sourceSnapshot: mediumtext("sourceSnapshot").notNull(),
    sourceHash: char("sourceHash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 500 }),
  },
  (table) => ({
    requestLineUq: unique("uq_purchase_return_request_line").on(
      table.requestId,
      table.lineNo,
    ),
    requestAllocationUq: unique("uq_purchase_return_request_allocation").on(
      table.requestId,
      table.matchAllocationId,
    ),
    sourceHashUq: unique("uq_purchase_return_request_source").on(
      table.requestId,
      table.sourceHash,
    ),
    sourceIdx: index("idx_purchase_return_req_item_source").on(
      table.goodsReceiptItemId,
      table.supplierInvoiceLineId,
    ),
    requestFk: foreignKey({
      name: "fk_prri_request",
      columns: [table.requestId],
      foreignColumns: [purchaseReturnRequests.id],
    }).onDelete("cascade"),
    invoiceLineFk: foreignKey({
      name: "fk_prri_invoice_line",
      columns: [table.supplierInvoiceLineId],
      foreignColumns: [supplierInvoiceLines.id],
    }),
    receiptItemFk: foreignKey({
      name: "fk_prri_grn_item",
      columns: [table.goodsReceiptItemId],
      foreignColumns: [goodsReceiptItems.id],
    }),
    matchAllocationFk: foreignKey({
      name: "fk_prri_match_alloc",
      columns: [table.matchAllocationId],
      foreignColumns: [supplierInvoiceMatchAllocations.id],
    }),
    orderItemFk: foreignKey({
      name: "fk_prri_po_item",
      columns: [table.purchaseOrderItemId],
      foreignColumns: [purchaseOrderItems.id],
    }),
    shape: check(
      "chk_purchase_return_request_item_shape",
      sql`${table.lineNo} > 0 AND ${table.requestedBaseQuantity} > 0 AND ${table.unitPriceIqd} >= 0 AND ${table.netAmount} >= 0 AND ${table.taxAmount} >= 0 AND ${table.totalAmount} = ${table.netAmount} + ${table.taxAmount}`,
    ),
  }),
);

/** طلب عكس مرتجعٍ مرحّل؛ يظل صفر أثر حتى اعتماد مراجع ثانٍ. */
export const purchaseReturnReversalRequests = mysqlTable(
  "purchaseReturnReversalRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 })
      .notNull()
      .unique("uq_purchase_return_reversal_request_key"),
    purchaseReturnId: bigint("purchaseReturnId", { mode: "number" })
      .notNull(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    baseReturnVersion: int("baseReturnVersion").notNull(),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    evidenceType: mysqlEnum("evidenceType", [
      "SUPPLIER_ACKNOWLEDGEMENT",
      "DOCUMENT_IMAGE",
      "PDF",
      "EMAIL",
      "SIGNED_APPROVAL",
      "OTHER",
    ]).notNull(),
    evidenceReference: varchar("evidenceReference", { length: 500 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "STALE"])
      .default("PENDING")
      .notNull(),
    pendingGuard: varchar("pendingGuard", { length: 180 }).unique(
      "uq_purchase_return_reversal_pending",
    ),
    requestedBy: int("requestedBy")
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    reviewReason: varchar("reviewReason", { length: 500 }),
    decisionKey: varchar("decisionKey", { length: 120 }).unique(
      "uq_purchase_return_reversal_decision",
    ),
    decisionHash: char("decisionHash", { length: 64 }),
    appliedAt: timestamp("appliedAt"),
  },
  (table) => ({
    returnStatusIdx: index("idx_purchase_return_rev_req_status").on(
      table.purchaseReturnId,
      table.status,
    ),
    branchStatusIdx: index("idx_purchase_return_rev_branch_status").on(
      table.branchId,
      table.status,
    ),
    purchaseReturnFk: foreignKey({
      name: "fk_prrev_req_return",
      columns: [table.purchaseReturnId],
      foreignColumns: [purchaseReturns.id],
    }),
    decisionShape: check(
      "chk_purchase_return_reversal_decision",
      sql`(
        (${table.status} = 'PENDING' AND ${table.pendingGuard} IS NOT NULL AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.decisionKey} IS NULL AND ${table.decisionHash} IS NULL AND ${table.appliedAt} IS NULL)
        OR (${table.status} = 'APPROVED' AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NOT NULL)
        OR (${table.status} IN ('REJECTED','STALE') AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NULL)
      )`,
    ),
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — قيدُ maker-checker السابق
    // (`chk_purchase_return_reversal_maker_checker`) أُسقط بالهجرة 0333؛ راجع التعليق
    // الموازي على `chk_purchase_return_request_maker_checker` أعلاه.
  }),
);

export const purchaseReturnReversalRequestItems = mysqlTable(
  "purchaseReturnReversalRequestItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestId: bigint("requestId", { mode: "number" })
      .notNull(),
    purchaseReturnItemId: bigint("purchaseReturnItemId", { mode: "number" })
      .notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    reason: varchar("reason", { length: 500 }),
  },
  (table) => ({
    requestItemUq: unique("uq_purchase_return_reversal_req_item").on(
      table.requestId,
      table.purchaseReturnItemId,
    ),
    requestFk: foreignKey({
      name: "fk_prrev_req_item_req",
      columns: [table.requestId],
      foreignColumns: [purchaseReturnReversalRequests.id],
    }).onDelete("cascade"),
    purchaseReturnItemFk: foreignKey({
      name: "fk_prrev_req_item_return",
      columns: [table.purchaseReturnItemId],
      foreignColumns: [purchaseReturnItems.id],
    }),
    positiveQuantity: check(
      "chk_purchase_return_reversal_req_qty",
      sql`${table.baseQuantity} > 0`,
    ),
  }),
);

/** مستند عكس نهائي؛ لا يعدّل أو يحذف، وأي تصحيح لاحق بمستند جديد. */
export const purchaseReturnReversals = mysqlTable(
  "purchaseReturnReversals",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    reversalNumber: varchar("reversalNumber", { length: 50 })
      .notNull()
      .unique("uq_purchase_return_reversal_number"),
    requestId: bigint("requestId", { mode: "number" })
      .notNull()
      .unique("uq_purchase_return_reversal_request"),
    purchaseReturnId: bigint("purchaseReturnId", { mode: "number" })
      .notNull()
      .references(() => purchaseReturns.id),
    supplierInvoiceId: bigint("supplierInvoiceId", { mode: "number" })
      .notNull()
      .references(() => supplierInvoices.id),
    supplierId: bigint("supplierId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    netAmount: decimal("netAmount", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalAmount: decimal("totalAmount", { precision: 15, scale: 2 }).notNull(),
    accountingEntryId: bigint("accountingEntryId", { mode: "number" })
      .notNull()
      .unique("uq_purchase_return_reversal_entry"),
    cashRepaymentReceiptId: bigint("cashRepaymentReceiptId", { mode: "number" })
      .unique("uq_purchase_return_reversal_receipt")
      .references(() => receipts.id),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 })
      .notNull()
      .unique("uq_purchase_return_reversal_hash"),
    reason: varchar("reason", { length: 500 }).notNull(),
    postedBy: int("postedBy")
      .notNull()
      .references(() => users.id),
    postedAt: timestamp("postedAt").defaultNow().notNull(),
  },
  (table) => ({
    returnDateIdx: index("idx_purchase_return_reversal_date").on(
      table.purchaseReturnId,
      table.postedAt,
    ),
    requestFk: foreignKey({
      name: "fk_prrev_request",
      columns: [table.requestId],
      foreignColumns: [purchaseReturnReversalRequests.id],
    }),
    accountingEntryFk: foreignKey({
      name: "fk_prrev_entry",
      columns: [table.accountingEntryId],
      foreignColumns: [accountingEntries.id],
    }),
    amountShape: check(
      "chk_purchase_return_reversal_amounts",
      sql`${table.netAmount} >= 0 AND ${table.taxAmount} >= 0 AND ${table.totalAmount} = ${table.netAmount} + ${table.taxAmount}`,
    ),
  }),
);

export const purchaseReturnReversalItems = mysqlTable(
  "purchaseReturnReversalItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    reversalId: bigint("reversalId", { mode: "number" })
      .notNull(),
    purchaseReturnItemId: bigint("purchaseReturnItemId", { mode: "number" })
      .notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    netAmount: decimal("netAmount", { precision: 15, scale: 2 }).notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalAmount: decimal("totalAmount", { precision: 15, scale: 2 }).notNull(),
    inventoryMovementId: bigint("inventoryMovementId", { mode: "number" })
      .notNull()
      .unique("uq_purchase_return_reversal_movement"),
  },
  (table) => ({
    reversalItemUq: unique("uq_purchase_return_reversal_item").on(
      table.reversalId,
      table.purchaseReturnItemId,
    ),
    reversalFk: foreignKey({
      name: "fk_prrev_item_doc",
      columns: [table.reversalId],
      foreignColumns: [purchaseReturnReversals.id],
    }).onDelete("cascade"),
    purchaseReturnItemFk: foreignKey({
      name: "fk_prrev_item_return_item",
      columns: [table.purchaseReturnItemId],
      foreignColumns: [purchaseReturnItems.id],
    }),
    movementFk: foreignKey({
      name: "fk_prrev_item_movement",
      columns: [table.inventoryMovementId],
      foreignColumns: [inventoryMovements.id],
    }),
    shape: check(
      "chk_purchase_return_reversal_item_shape",
      sql`${table.baseQuantity} > 0 AND ${table.netAmount} >= 0 AND ${table.taxAmount} >= 0 AND ${table.totalAmount} = ${table.netAmount} + ${table.taxAmount}`,
    ),
  }),
);

export type PurchaseReturn = typeof purchaseReturns.$inferSelect;
export type PurchaseReturnItem = typeof purchaseReturnItems.$inferSelect;
export type PurchaseReturnRequest = typeof purchaseReturnRequests.$inferSelect;
export type PurchaseReturnReversal = typeof purchaseReturnReversals.$inferSelect;

/**
 * دليل تسوية إرثي مادي، لا Payment مختلق: كل صف يشير إلى القيد والإيصال الحقيقيين،
 * ويُستعمل فقط حين تكون فاتورة AP الوحيدة للأمر ويمكن إسناد الدليل إليها حتمياً.
 */
export const legacySupplierInvoiceSettlements = mysqlTable(
  "legacySupplierInvoiceSettlements",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    supplierInvoiceId: bigint("supplierInvoiceId", { mode: "number" })
      .notNull(),
    sourceAccountingEntryId: bigint("sourceAccountingEntryId", {
      mode: "number",
    })
      .notNull()
      .unique("uq_legacy_supplier_settlement_entry"),
    sourceReceiptId: bigint("sourceReceiptId", { mode: "number" })
      .notNull()
      .references(() => receipts.id),
    direction: mysqlEnum("direction", ["PAYMENT_OUT", "PAYMENT_IN"]).notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    evidenceSnapshot: mediumtext("evidenceSnapshot").notNull(),
    evidenceHash: char("evidenceHash", { length: 64 })
      .notNull()
      .unique("uq_legacy_supplier_settlement_evidence"),
    materializedAt: timestamp("materializedAt").defaultNow().notNull(),
  },
  (table) => ({
    invoiceDateIdx: index("idx_legacy_supplier_settlement_invoice").on(
      table.supplierInvoiceId,
      table.materializedAt,
    ),
    receiptIdx: index("idx_legacy_supplier_settlement_receipt").on(
      table.sourceReceiptId,
    ),
    invoiceFk: foreignKey({
      name: "fk_lsis_invoice",
      columns: [table.supplierInvoiceId],
      foreignColumns: [supplierInvoices.id],
    }),
    entryFk: foreignKey({
      name: "fk_lsis_entry",
      columns: [table.sourceAccountingEntryId],
      foreignColumns: [accountingEntries.id],
    }),
    amountShape: check(
      "chk_legacy_supplier_settlement_amount",
      sql`${table.amount} > 0`,
    ),
  }),
);

/** طلب صرف مورّد؛ تخصيصاته المطلوبة لا تحرّك AP حتى الاعتماد والتطبيق الذري. */
export const supplierPaymentRequests = mysqlTable(
  "supplierPaymentRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 })
      .notNull()
      .unique("uq_supplier_payment_request_key"),
    supplierId: bigint("supplierId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    currency: mysqlEnum("currency", ["IQD", "USD"]).notNull(),
    exchangeRate: decimal("exchangeRate", { precision: 15, scale: 4 }),
    requestedAmount: decimal("requestedAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    requestedCurrencyAmount: decimal("requestedCurrencyAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    paymentMethod: mysqlEnum("paymentMethod", [
      "CASH",
      "CARD",
      "TRANSFER",
      "WALLET",
    ]).notNull(),
    externalReference: varchar("externalReference", { length: 160 }),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    evidenceType: mysqlEnum("evidenceType", [
      "PAYMENT_ORDER",
      "BANK_ADVICE",
      "TRANSFER_RECEIPT",
      "CASH_ACKNOWLEDGEMENT",
      "DOCUMENT_IMAGE",
      "PDF",
      "OTHER",
    ]).notNull(),
    evidenceReference: varchar("evidenceReference", { length: 500 }).notNull(),
    evidenceHash: char("evidenceHash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "STALE"])
      .default("PENDING")
      .notNull(),
    pendingGuard: varchar("pendingGuard", { length: 180 }).unique(
      "uq_supplier_payment_pending",
    ),
    requestedBy: int("requestedBy")
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    reviewReason: varchar("reviewReason", { length: 500 }),
    decisionKey: varchar("decisionKey", { length: 120 }).unique(
      "uq_supplier_payment_decision",
    ),
    decisionHash: char("decisionHash", { length: 64 }),
    appliedAt: timestamp("appliedAt"),
  },
  (table) => ({
    branchStatusIdx: index("idx_supplier_payment_req_branch_status").on(
      table.branchId,
      table.status,
    ),
    supplierStatusIdx: index("idx_supplier_payment_req_supplier_status").on(
      table.supplierId,
      table.status,
    ),
    evidenceUq: unique("uq_supplier_payment_request_evidence").on(
      table.supplierId,
      table.evidenceHash,
    ),
    amountShape: check(
      "chk_supplier_payment_request_amounts",
      sql`${table.requestedAmount} > 0 AND ${table.requestedCurrencyAmount} > 0 AND ((${table.currency} = 'IQD' AND ${table.exchangeRate} IS NULL AND ${table.requestedAmount} = ${table.requestedCurrencyAmount}) OR (${table.currency} = 'USD' AND ${table.exchangeRate} IS NOT NULL AND ${table.exchangeRate} > 0))`,
    ),
    evidenceShape: check(
      "chk_supplier_payment_request_evidence",
      sql`CHAR_LENGTH(TRIM(${table.evidenceReference})) > 0 AND (${table.paymentMethod} = 'CASH' OR (${table.externalReference} IS NOT NULL AND CHAR_LENGTH(TRIM(${table.externalReference})) > 0))`,
    ),
    decisionShape: check(
      "chk_supplier_payment_request_decision",
      sql`(
        (${table.status} = 'PENDING' AND ${table.pendingGuard} IS NOT NULL AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.decisionKey} IS NULL AND ${table.decisionHash} IS NULL AND ${table.appliedAt} IS NULL)
        OR (${table.status} = 'APPROVED' AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NOT NULL)
        OR (${table.status} IN ('REJECTED','STALE') AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NULL)
      )`,
    ),
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — قيدُ maker-checker السابق
    // (`chk_supplier_payment_request_maker_checker`) أُسقط بالهجرة 0333؛ راجع التعليق
    // الموازي على `chk_purchase_return_request_maker_checker`.
  }),
);

export const supplierPaymentRequestAllocations = mysqlTable(
  "supplierPaymentRequestAllocations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestId: bigint("requestId", { mode: "number" })
      .notNull(),
    supplierInvoiceId: bigint("supplierInvoiceId", { mode: "number" })
      .notNull(),
    /** حجز فاتورة واحد لطلب سداد حي؛ تُصفّره الخدمة عند كل قرار نهائي. */
    activeInvoiceGuard: bigint("activeInvoiceGuard", { mode: "number" }),
    invoiceVersion: int("invoiceVersion").notNull(),
    requestedAmount: decimal("requestedAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    requestedCurrencyAmount: decimal("requestedCurrencyAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    invoiceSnapshot: mediumtext("invoiceSnapshot").notNull(),
    invoiceHash: char("invoiceHash", { length: 64 }).notNull(),
  },
  (table) => ({
    requestInvoiceUq: unique("uq_supplier_payment_req_invoice").on(
      table.requestId,
      table.supplierInvoiceId,
    ),
    activeInvoiceUq: unique("uq_supplier_payment_active_invoice").on(
      table.activeInvoiceGuard,
    ),
    invoiceIdx: index("idx_supplier_payment_req_alloc_invoice").on(
      table.supplierInvoiceId,
    ),
    requestFk: foreignKey({
      name: "fk_spreq_alloc_req",
      columns: [table.requestId],
      foreignColumns: [supplierPaymentRequests.id],
    }).onDelete("cascade"),
    invoiceFk: foreignKey({
      name: "fk_spreq_alloc_invoice",
      columns: [table.supplierInvoiceId],
      foreignColumns: [supplierInvoices.id],
    }),
    amountShape: check(
      "chk_supplier_payment_req_alloc_amount",
      sql`${table.requestedAmount} > 0 AND ${table.requestedCurrencyAmount} > 0 AND ${table.invoiceVersion} > 0`,
    ),
    activeInvoiceShape: check(
      "chk_supplier_payment_active_invoice",
      sql`${table.activeInvoiceGuard} IS NULL OR ${table.activeInvoiceGuard} = ${table.supplierInvoiceId}`,
    ),
  }),
);

/** رأس دفعة مرحّلة؛ AP المطفأ يُشتق حصراً من supplierPaymentAllocations. */
export const supplierPayments = mysqlTable(
  "supplierPayments",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    paymentNumber: varchar("paymentNumber", { length: 60 })
      .notNull()
      .unique("uq_supplier_payment_number"),
    requestId: bigint("requestId", { mode: "number" })
      .notNull()
      .unique("uq_supplier_payment_request")
      .references(() => supplierPaymentRequests.id),
    supplierId: bigint("supplierId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    status: mysqlEnum("status", ["POSTED", "PARTIALLY_REFUNDED", "REFUNDED"])
      .default("POSTED")
      .notNull(),
    version: int("version").default(1).notNull(),
    currency: mysqlEnum("currency", ["IQD", "USD"]).notNull(),
    exchangeRate: decimal("exchangeRate", { precision: 15, scale: 4 }),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    currencyAmount: decimal("currencyAmount", { precision: 15, scale: 2 }).notNull(),
    paymentMethod: mysqlEnum("paymentMethod", [
      "CASH",
      "CARD",
      "TRANSFER",
      "WALLET",
    ]).notNull(),
    externalReference: varchar("externalReference", { length: 160 }),
    receiptId: bigint("receiptId", { mode: "number" })
      .notNull()
      .unique("uq_supplier_payment_receipt")
      .references(() => receipts.id),
    accountingEntryId: bigint("accountingEntryId", { mode: "number" })
      .notNull()
      .unique("uq_supplier_payment_entry")
      .references(() => accountingEntries.id),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 })
      .notNull()
      .unique("uq_supplier_payment_hash"),
    postedBy: int("postedBy")
      .notNull()
      .references(() => users.id),
    postedAt: timestamp("postedAt").defaultNow().notNull(),
  },
  (table) => ({
    supplierDateIdx: index("idx_supplier_payment_supplier_date").on(
      table.supplierId,
      table.postedAt,
    ),
    branchStatusIdx: index("idx_supplier_payment_branch_status").on(
      table.branchId,
      table.status,
    ),
    amountShape: check(
      "chk_supplier_payment_amounts",
      sql`${table.amount} > 0 AND ${table.currencyAmount} > 0 AND ((${table.currency} = 'IQD' AND ${table.exchangeRate} IS NULL AND ${table.amount} = ${table.currencyAmount}) OR (${table.currency} = 'USD' AND ${table.exchangeRate} IS NOT NULL AND ${table.exchangeRate} > 0))`,
    ),
    evidenceShape: check(
      "chk_supplier_payment_external_reference",
      sql`${table.paymentMethod} = 'CASH' OR (${table.externalReference} IS NOT NULL AND CHAR_LENGTH(TRIM(${table.externalReference})) > 0)`,
    ),
  }),
);

export const supplierPaymentAllocations = mysqlTable(
  "supplierPaymentAllocations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    supplierPaymentId: bigint("supplierPaymentId", { mode: "number" })
      .notNull(),
    requestAllocationId: bigint("requestAllocationId", { mode: "number" })
      .notNull()
      .unique("uq_supplier_payment_request_allocation"),
    supplierInvoiceId: bigint("supplierInvoiceId", { mode: "number" })
      .notNull(),
    allocatedAmount: decimal("allocatedAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    allocatedCurrencyAmount: decimal("allocatedCurrencyAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    refundedAmount: decimal("refundedAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    refundedCurrencyAmount: decimal("refundedCurrencyAmount", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    invoiceHash: char("invoiceHash", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    paymentInvoiceUq: unique("uq_supplier_payment_allocation_invoice").on(
      table.supplierPaymentId,
      table.supplierInvoiceId,
    ),
    invoiceIdx: index("idx_supplier_payment_alloc_invoice").on(
      table.supplierInvoiceId,
    ),
    paymentFk: foreignKey({
      name: "fk_spalloc_payment",
      columns: [table.supplierPaymentId],
      foreignColumns: [supplierPayments.id],
    }).onDelete("cascade"),
    requestAllocationFk: foreignKey({
      name: "fk_spalloc_request_alloc",
      columns: [table.requestAllocationId],
      foreignColumns: [supplierPaymentRequestAllocations.id],
    }),
    invoiceFk: foreignKey({
      name: "fk_spalloc_invoice",
      columns: [table.supplierInvoiceId],
      foreignColumns: [supplierInvoices.id],
    }),
    amountShape: check(
      "chk_supplier_payment_allocation_amounts",
      sql`${table.allocatedAmount} > 0 AND ${table.allocatedCurrencyAmount} > 0 AND ${table.refundedAmount} >= 0 AND ${table.refundedCurrencyAmount} >= 0 AND ${table.refundedAmount} <= ${table.allocatedAmount} AND ${table.refundedCurrencyAmount} <= ${table.allocatedCurrencyAmount}`,
    ),
  }),
);

/** طلب استرداد مبلغ سبق دفعه للمورّد؛ لا قبض ولا عكس AP قبل الاعتماد. */
export const supplierPaymentRefundRequests = mysqlTable(
  "supplierPaymentRefundRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 })
      .notNull()
      .unique("uq_supplier_payment_refund_request_key"),
    supplierPaymentId: bigint("supplierPaymentId", { mode: "number" })
      .notNull(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    basePaymentVersion: int("basePaymentVersion").notNull(),
    requestedAmount: decimal("requestedAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    requestedCurrencyAmount: decimal("requestedCurrencyAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    refundMethod: mysqlEnum("refundMethod", [
      "CASH",
      "CARD",
      "TRANSFER",
      "WALLET",
    ]).notNull(),
    externalReference: varchar("externalReference", { length: 160 }),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    evidenceType: mysqlEnum("evidenceType", [
      "SUPPLIER_ACKNOWLEDGEMENT",
      "BANK_ADVICE",
      "TRANSFER_RECEIPT",
      "CASH_RECEIPT",
      "DOCUMENT_IMAGE",
      "PDF",
      "OTHER",
    ]).notNull(),
    evidenceReference: varchar("evidenceReference", { length: 500 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "STALE"])
      .default("PENDING")
      .notNull(),
    pendingGuard: varchar("pendingGuard", { length: 180 }).unique(
      "uq_supplier_payment_refund_pending",
    ),
    requestedBy: int("requestedBy")
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    reviewReason: varchar("reviewReason", { length: 500 }),
    decisionKey: varchar("decisionKey", { length: 120 }).unique(
      "uq_supplier_payment_refund_decision",
    ),
    decisionHash: char("decisionHash", { length: 64 }),
    appliedAt: timestamp("appliedAt"),
  },
  (table) => ({
    paymentStatusIdx: index("idx_supplier_payment_refund_status").on(
      table.supplierPaymentId,
      table.status,
    ),
    branchStatusRequestedIdx: index("idx_sprefund_branch_status_requested").on(
      table.branchId,
      table.status,
      table.requestedAt,
      table.id,
    ),
    statusRequestedIdx: index("idx_sprefund_status_requested").on(
      table.status,
      table.requestedAt,
      table.id,
    ),
    paymentFk: foreignKey({
      name: "fk_sprefund_req_payment",
      columns: [table.supplierPaymentId],
      foreignColumns: [supplierPayments.id],
    }),
    amountShape: check(
      "chk_supplier_payment_refund_request_amounts",
      sql`${table.requestedAmount} > 0 AND ${table.requestedCurrencyAmount} > 0 AND ${table.basePaymentVersion} > 0`,
    ),
    decisionShape: check(
      "chk_supplier_payment_refund_decision",
      sql`(
        (${table.status} = 'PENDING' AND ${table.pendingGuard} IS NOT NULL AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.decisionKey} IS NULL AND ${table.decisionHash} IS NULL AND ${table.appliedAt} IS NULL)
        OR (${table.status} = 'APPROVED' AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NOT NULL)
        OR (${table.status} IN ('REJECTED','STALE') AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NULL)
      )`,
    ),
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — قيدُ maker-checker السابق
    // (`chk_supplier_payment_refund_maker_checker`) أُسقط بالهجرة 0333؛ راجع التعليق
    // الموازي على `chk_purchase_return_request_maker_checker`.
  }),
);

export const supplierPaymentRefundRequestItems = mysqlTable(
  "supplierPaymentRefundRequestItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestId: bigint("requestId", { mode: "number" })
      .notNull(),
    supplierPaymentAllocationId: bigint("supplierPaymentAllocationId", {
      mode: "number",
    })
      .notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    currencyAmount: decimal("currencyAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
  },
  (table) => ({
    requestAllocationUq: unique("uq_supplier_payment_refund_req_alloc").on(
      table.requestId,
      table.supplierPaymentAllocationId,
    ),
    requestFk: foreignKey({
      name: "fk_sprefund_req_item_req",
      columns: [table.requestId],
      foreignColumns: [supplierPaymentRefundRequests.id],
    }).onDelete("cascade"),
    paymentAllocationFk: foreignKey({
      name: "fk_sprefund_req_item_alloc",
      columns: [table.supplierPaymentAllocationId],
      foreignColumns: [supplierPaymentAllocations.id],
    }),
    amountShape: check(
      "chk_supplier_payment_refund_req_item_amount",
      sql`${table.amount} > 0 AND ${table.currencyAmount} > 0`,
    ),
  }),
);

export const supplierPaymentRefunds = mysqlTable(
  "supplierPaymentRefunds",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    refundNumber: varchar("refundNumber", { length: 60 })
      .notNull()
      .unique("uq_supplier_payment_refund_number"),
    requestId: bigint("requestId", { mode: "number" })
      .notNull()
      .unique("uq_supplier_payment_refund_request"),
    supplierPaymentId: bigint("supplierPaymentId", { mode: "number" })
      .notNull()
      .references(() => supplierPayments.id),
    supplierId: bigint("supplierId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    currencyAmount: decimal("currencyAmount", { precision: 15, scale: 2 }).notNull(),
    receiptId: bigint("receiptId", { mode: "number" })
      .notNull()
      .unique("uq_supplier_payment_refund_receipt")
      .references(() => receipts.id),
    accountingEntryId: bigint("accountingEntryId", { mode: "number" })
      .notNull()
      .unique("uq_supplier_payment_refund_entry")
      .references(() => accountingEntries.id),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 })
      .notNull()
      .unique("uq_supplier_payment_refund_hash"),
    postedBy: int("postedBy")
      .notNull()
      .references(() => users.id),
    postedAt: timestamp("postedAt").defaultNow().notNull(),
  },
  (table) => ({
    paymentDateIdx: index("idx_supplier_payment_refund_date").on(
      table.supplierPaymentId,
      table.postedAt,
    ),
    requestFk: foreignKey({
      name: "fk_sprefund_request",
      columns: [table.requestId],
      foreignColumns: [supplierPaymentRefundRequests.id],
    }),
    amountShape: check(
      "chk_supplier_payment_refund_amounts",
      sql`${table.amount} > 0 AND ${table.currencyAmount} > 0`,
    ),
  }),
);

export const supplierPaymentRefundItems = mysqlTable(
  "supplierPaymentRefundItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    refundId: bigint("refundId", { mode: "number" })
      .notNull()
      .references(() => supplierPaymentRefunds.id, { onDelete: "cascade" }),
    supplierPaymentAllocationId: bigint("supplierPaymentAllocationId", {
      mode: "number",
    })
      .notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    currencyAmount: decimal("currencyAmount", { precision: 15, scale: 2 }).notNull(),
  },
  (table) => ({
    refundAllocationUq: unique("uq_supplier_payment_refund_allocation").on(
      table.refundId,
      table.supplierPaymentAllocationId,
    ),
    paymentAllocationFk: foreignKey({
      name: "fk_sprefund_item_alloc",
      columns: [table.supplierPaymentAllocationId],
      foreignColumns: [supplierPaymentAllocations.id],
    }),
    amountShape: check(
      "chk_supplier_payment_refund_item_amount",
      sql`${table.amount} > 0 AND ${table.currencyAmount} > 0`,
    ),
  }),
);

export type SupplierPaymentRequest = typeof supplierPaymentRequests.$inferSelect;
export type SupplierPayment = typeof supplierPayments.$inferSelect;
export type SupplierPaymentAllocation = typeof supplierPaymentAllocations.$inferSelect;

/** مصروف تابع للشراء؛ يبقى DRAFT حتى اعتماد مستقل، ولا يُرسمل في المخزون. */
export const purchaseCharges = mysqlTable(
  "purchaseCharges",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    chargeNumber: varchar("chargeNumber", { length: 60 })
      .notNull()
      .unique("uq_purchase_charge_number"),
    clientRequestId: varchar("clientRequestId", { length: 120 })
      .notNull()
      .unique("uq_purchase_charge_request"),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    payeeSupplierId: bigint("payeeSupplierId", { mode: "number" }).references(
      () => suppliers.id,
    ),
    expenseAccountId: bigint("expenseAccountId", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    chargeType: mysqlEnum("chargeType", [
      "SHIPPING",
      "CUSTOMS",
      "FREIGHT",
      "INSURANCE",
      "INSPECTION",
      "OTHER",
    ]).notNull(),
    settlement: mysqlEnum("settlement", ["PAID", "PAYABLE"]).notNull(),
    paymentMethod: mysqlEnum("paymentMethod", [
      "CASH",
      "CARD",
      "TRANSFER",
      "WALLET",
    ]),
    status: mysqlEnum("status", ["DRAFT", "POSTED", "REVERSED"])
      .default("DRAFT")
      .notNull(),
    version: int("version").default(1).notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    expenseDate: date("expenseDate", { mode: "string" }).notNull(),
    externalReference: varchar("externalReference", { length: 160 }),
    evidenceType: mysqlEnum("evidenceType", [
      "SUPPLIER_INVOICE",
      "CARRIER_INVOICE",
      "CUSTOMS_RECEIPT",
      "BANK_ADVICE",
      "DOCUMENT_IMAGE",
      "PDF",
      "OTHER",
    ]).notNull(),
    evidenceReference: varchar("evidenceReference", { length: 500 }).notNull(),
    evidenceHash: char("evidenceHash", { length: 64 }).notNull(),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    postingEntryId: bigint("postingEntryId", { mode: "number" })
      .unique("uq_purchase_charge_posting_entry")
      .references(() => accountingEntries.id),
    paymentReceiptId: bigint("paymentReceiptId", { mode: "number" })
      .unique("uq_purchase_charge_payment_receipt")
      .references(() => receipts.id),
    reversalEntryId: bigint("reversalEntryId", { mode: "number" })
      .unique("uq_purchase_charge_reversal_entry")
      .references(() => accountingEntries.id),
    reversalReceiptId: bigint("reversalReceiptId", { mode: "number" })
      .unique("uq_purchase_charge_reversal_receipt")
      .references(() => receipts.id),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    postedBy: int("postedBy").references(() => users.id),
    postedAt: timestamp("postedAt"),
    reversedBy: int("reversedBy").references(() => users.id),
    reversedAt: timestamp("reversedAt"),
    reversalReason: varchar("reversalReason", { length: 500 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    branchStatusIdx: index("idx_purchase_charge_branch_status").on(
      table.branchId,
      table.status,
    ),
    accountDateIdx: index("idx_purchase_charge_account_date").on(
      table.expenseAccountId,
      table.expenseDate,
    ),
    evidenceUq: unique("uq_purchase_charge_evidence").on(
      table.payeeSupplierId,
      table.evidenceHash,
    ),
    amountShape: check("chk_purchase_charge_amount", sql`${table.amount} > 0`),
    settlementShape: check(
      "chk_purchase_charge_settlement",
      sql`(${table.settlement} = 'PAYABLE' AND ${table.payeeSupplierId} IS NOT NULL AND ${table.paymentMethod} IS NULL AND ${table.paymentReceiptId} IS NULL) OR (${table.settlement} = 'PAID' AND ${table.paymentMethod} IS NOT NULL)`,
    ),
    lifecycleShape: check(
      "chk_purchase_charge_lifecycle",
      sql`(
        (${table.status} = 'DRAFT' AND ${table.postingEntryId} IS NULL AND ${table.postedBy} IS NULL AND ${table.postedAt} IS NULL AND ${table.reversalEntryId} IS NULL AND ${table.reversedBy} IS NULL AND ${table.reversedAt} IS NULL)
        OR (${table.status} = 'POSTED' AND ${table.postingEntryId} IS NOT NULL AND ${table.postedBy} IS NOT NULL AND ${table.postedAt} IS NOT NULL AND (${table.settlement} = 'PAYABLE' OR ${table.paymentReceiptId} IS NOT NULL) AND ${table.reversalEntryId} IS NULL AND ${table.reversedBy} IS NULL AND ${table.reversedAt} IS NULL)
        OR (${table.status} = 'REVERSED' AND ${table.postingEntryId} IS NOT NULL AND ${table.postedAt} IS NOT NULL AND ${table.reversalEntryId} IS NOT NULL AND ${table.reversedBy} IS NOT NULL AND ${table.reversedAt} IS NOT NULL AND ${table.reversalReason} IS NOT NULL)
      )`,
    ),
  }),
);

export const purchaseChargeAllocations = mysqlTable(
  "purchaseChargeAllocations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    purchaseChargeId: bigint("purchaseChargeId", { mode: "number" })
      .notNull()
      .references(() => purchaseCharges.id, { onDelete: "cascade" }),
    lineNo: int("lineNo").notNull(),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" }).references(
      () => purchaseOrders.id,
    ),
    goodsReceiptId: bigint("goodsReceiptId", { mode: "number" }).references(
      () => goodsReceipts.id,
    ),
    supplierInvoiceId: bigint("supplierInvoiceId", { mode: "number" }),
    allocatedAmount: decimal("allocatedAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    sourceSnapshot: mediumtext("sourceSnapshot").notNull(),
    sourceHash: char("sourceHash", { length: 64 }).notNull(),
  },
  (table) => ({
    chargeLineUq: unique("uq_purchase_charge_allocation_line").on(
      table.purchaseChargeId,
      table.lineNo,
    ),
    chargeSourceUq: unique("uq_purchase_charge_allocation_source").on(
      table.purchaseChargeId,
      table.sourceHash,
    ),
    sourceIdx: index("idx_purchase_charge_allocation_source").on(
      table.purchaseOrderId,
      table.goodsReceiptId,
      table.supplierInvoiceId,
    ),
    supplierInvoiceFk: foreignKey({
      name: "fk_pcharge_alloc_invoice",
      columns: [table.supplierInvoiceId],
      foreignColumns: [supplierInvoices.id],
    }),
    sourceShape: check(
      "chk_purchase_charge_allocation_source",
      sql`${table.lineNo} > 0 AND ${table.allocatedAmount} > 0 AND (${table.purchaseOrderId} IS NOT NULL OR ${table.goodsReceiptId} IS NOT NULL OR ${table.supplierInvoiceId} IS NOT NULL)`,
    ),
  }),
);

/** طلب ترحيل/عكس مصروف شراء؛ القرار وحده يكتب قيد EXPENSE وإيصال التسوية. */
export const purchaseChargeControlRequests = mysqlTable(
  "purchaseChargeControlRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 })
      .notNull()
      .unique("uq_purchase_charge_control_request"),
    purchaseChargeId: bigint("purchaseChargeId", { mode: "number" })
      .notNull(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    kind: mysqlEnum("kind", ["POST", "REVERSE"]).notNull(),
    baseChargeVersion: int("baseChargeVersion").notNull(),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    evidenceReference: varchar("evidenceReference", { length: 500 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "STALE"])
      .default("PENDING")
      .notNull(),
    pendingGuard: varchar("pendingGuard", { length: 180 }).unique(
      "uq_purchase_charge_control_pending",
    ),
    requestedBy: int("requestedBy")
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    reviewReason: varchar("reviewReason", { length: 500 }),
    decisionKey: varchar("decisionKey", { length: 120 }).unique(
      "uq_purchase_charge_control_decision",
    ),
    decisionHash: char("decisionHash", { length: 64 }),
    appliedAt: timestamp("appliedAt"),
  },
  (table) => ({
    chargeStatusIdx: index("idx_purchase_charge_control_status").on(
      table.purchaseChargeId,
      table.status,
    ),
    branchStatusIdx: index("idx_purchase_charge_control_branch").on(
      table.branchId,
      table.status,
    ),
    chargeFk: foreignKey({
      name: "fk_pcharge_ctl_charge",
      columns: [table.purchaseChargeId],
      foreignColumns: [purchaseCharges.id],
    }),
    decisionShape: check(
      "chk_purchase_charge_control_decision",
      sql`(
        (${table.status} = 'PENDING' AND ${table.pendingGuard} IS NOT NULL AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.decisionKey} IS NULL AND ${table.decisionHash} IS NULL AND ${table.appliedAt} IS NULL)
        OR (${table.status} = 'APPROVED' AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NOT NULL)
        OR (${table.status} IN ('REJECTED','STALE') AND ${table.pendingGuard} IS NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.appliedAt} IS NULL)
      )`,
    ),
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — قيدُ maker-checker السابق
    // (`chk_purchase_charge_control_maker_checker`) أُسقط بالهجرة 0333؛ راجع التعليق
    // الموازي على `chk_purchase_return_request_maker_checker`.
  }),
);

export type PurchaseCharge = typeof purchaseCharges.$inferSelect;
export type PurchaseChargeAllocation = typeof purchaseChargeAllocations.$inferSelect;

/**
 * قضية نزاهة شراء تشغيلية. الرأس يحمل الحالة الحالية، فيما purchaseIntegrityCaseEvents
 * هو السجل غير القابل للتعديل لكل دليل وطلب وقرار.
 */
export const purchaseIntegrityCases = mysqlTable(
  "purchaseIntegrityCases",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    caseNumber: varchar("caseNumber", { length: 60 })
      .notNull()
      .unique("uq_purchase_integrity_case_number"),
    caseKey: varchar("caseKey", { length: 180 })
      .notNull()
      .unique("uq_purchase_integrity_case_key"),
    openGuard: varchar("openGuard", { length: 180 }).unique(
      "uq_purchase_integrity_open_guard",
    ),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    supplierId: bigint("supplierId", { mode: "number" }).references(
      () => suppliers.id,
    ),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" }).references(
      () => purchaseOrders.id,
    ),
    goodsReceiptId: bigint("goodsReceiptId", { mode: "number" }).references(
      () => goodsReceipts.id,
    ),
    supplierInvoiceId: bigint("supplierInvoiceId", { mode: "number" }).references(
      () => supplierInvoices.id,
    ),
    purchaseReturnId: bigint("purchaseReturnId", { mode: "number" }).references(
      () => purchaseReturns.id,
    ),
    supplierPaymentId: bigint("supplierPaymentId", { mode: "number" }).references(
      () => supplierPayments.id,
    ),
    purchaseChargeId: bigint("purchaseChargeId", { mode: "number" }).references(
      () => purchaseCharges.id,
    ),
    code: mysqlEnum("code", [
      "GRN_WITHOUT_POSTED_INVOICE",
      "INVOICE_WITHOUT_GRN",
      "UNMATCHED_POSTED_INVOICE",
      "PAYMENT_EXCEEDS_INVOICE",
      "RETURN_EXCEEDS_MATCH",
      "RETURN_WITHOUT_SOURCE",
      "CHARGE_WITHOUT_EVIDENCE",
      "AP_LEDGER_MISMATCH",
      "GRNI_AGING",
      "DUPLICATE_SUPPLIER_DOCUMENT",
      "LEGACY_AP_CLASSIFICATION",
      "LEGACY_PAYMENT_ALLOCATION_AMBIGUOUS",
      "LEGACY_PAYMENT_EVIDENCE_INVALID",
      "LEGACY_PAYMENT_EXCEEDS_INVOICE",
      "PERIOD_CLOSE_BLOCKER",
      "OTHER",
    ]).notNull(),
    origin: mysqlEnum("origin", ["USER", "SYSTEM"])
      .default("USER")
      .notNull(),
    severity: mysqlEnum("severity", ["LOW", "MEDIUM", "HIGH", "CRITICAL"])
      .default("MEDIUM")
      .notNull(),
    status: mysqlEnum("status", [
      "OPEN",
      "IN_REVIEW",
      "PENDING_RESOLUTION",
      "RESOLVED",
      "DISMISSED",
    ])
      .default("OPEN")
      .notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    description: varchar("description", { length: 1000 }).notNull(),
    detectedAmount: decimal("detectedAmount", { precision: 15, scale: 2 }),
    detectedAt: timestamp("detectedAt").defaultNow().notNull(),
    evidenceSnapshot: mediumtext("evidenceSnapshot").notNull(),
    evidenceHash: char("evidenceHash", { length: 64 }).notNull(),
    openedBy: int("openedBy").references(() => users.id),
    assignedTo: int("assignedTo").references(() => users.id),
    resolutionRequestKey: varchar("resolutionRequestKey", { length: 120 }).unique(
      "uq_purchase_integrity_resolution_request",
    ),
    resolutionRequestHash: char("resolutionRequestHash", { length: 64 }),
    resolutionRequestedBy: int("resolutionRequestedBy").references(
      () => users.id,
    ),
    resolutionRequestedAt: timestamp("resolutionRequestedAt"),
    resolutionReason: varchar("resolutionReason", { length: 1000 }),
    resolutionEvidenceReference: varchar("resolutionEvidenceReference", {
      length: 500,
    }),
    pendingResolutionGuard: varchar("pendingResolutionGuard", {
      length: 180,
    }).unique("uq_purchase_integrity_resolution_pending"),
    decisionKey: varchar("decisionKey", { length: 120 }).unique(
      "uq_purchase_integrity_resolution_decision",
    ),
    decisionHash: char("decisionHash", { length: 64 }),
    resolutionDecision: mysqlEnum("resolutionDecision", [
      "APPROVE_RESOLVED",
      "APPROVE_DISMISSED",
      "REJECT",
    ]),
    resolvedBy: int("resolvedBy").references(() => users.id),
    resolvedAt: timestamp("resolvedAt"),
    decisionReason: varchar("decisionReason", { length: 1000 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    branchStatusIdx: index("idx_purchase_integrity_branch_status").on(
      table.branchId,
      table.status,
      table.severity,
    ),
    supplierCodeIdx: index("idx_purchase_integrity_supplier_code").on(
      table.supplierId,
      table.code,
    ),
    invoiceIdx: index("idx_purchase_integrity_invoice").on(
      table.supplierInvoiceId,
    ),
    evidenceUq: unique("uq_purchase_integrity_case_evidence").on(
      table.caseKey,
      table.evidenceHash,
    ),
    amountShape: check(
      "chk_purchase_integrity_detected_amount",
      sql`${table.detectedAmount} IS NULL OR ${table.detectedAmount} >= 0`,
    ),
    openerShape: check(
      "chk_purchase_integrity_opener",
      sql`(${table.origin} = 'USER' AND ${table.openedBy} IS NOT NULL) OR (${table.origin} = 'SYSTEM' AND ${table.openedBy} IS NULL)`,
    ),
    resolutionShape: check(
      "chk_purchase_integrity_resolution",
      sql`(
        (${table.status} IN ('OPEN','IN_REVIEW') AND ${table.pendingResolutionGuard} IS NULL AND ${table.resolutionRequestKey} IS NULL AND ${table.resolutionRequestedBy} IS NULL AND ${table.resolutionRequestedAt} IS NULL AND ${table.decisionKey} IS NULL AND ${table.resolvedBy} IS NULL AND ${table.resolvedAt} IS NULL)
        OR (${table.status} = 'PENDING_RESOLUTION' AND ${table.pendingResolutionGuard} IS NOT NULL AND ${table.resolutionRequestKey} IS NOT NULL AND ${table.resolutionRequestHash} IS NOT NULL AND ${table.resolutionRequestedBy} IS NOT NULL AND ${table.resolutionRequestedAt} IS NOT NULL AND ${table.resolutionReason} IS NOT NULL AND ${table.decisionKey} IS NULL AND ${table.resolvedBy} IS NULL AND ${table.resolvedAt} IS NULL)
        OR (${table.status} IN ('RESOLVED','DISMISSED') AND ${table.pendingResolutionGuard} IS NULL AND ${table.resolutionRequestKey} IS NOT NULL AND ${table.resolutionRequestHash} IS NOT NULL AND ${table.resolutionRequestedBy} IS NOT NULL AND ${table.resolutionRequestedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.resolutionDecision} IN ('APPROVE_RESOLVED','APPROVE_DISMISSED') AND ${table.resolvedBy} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL AND ${table.decisionReason} IS NOT NULL)
      )`,
    ),
    makerChecker: check(
      "chk_purchase_integrity_resolution_sod",
      sql`${table.resolvedBy} IS NULL OR ${table.resolvedBy} <> ${table.resolutionRequestedBy}`,
    ),
  }),
);

/** سجل قضية append-only؛ trigger 0306 يمنع UPDATE وDELETE حتى من الكتّاب القدماء. */
export const purchaseIntegrityCaseEvents = mysqlTable(
  "purchaseIntegrityCaseEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    eventKey: varchar("eventKey", { length: 160 })
      .notNull()
      .unique("uq_purchase_integrity_event_key"),
    caseId: bigint("caseId", { mode: "number" })
      .notNull()
      .references(() => purchaseIntegrityCases.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    eventType: mysqlEnum("eventType", [
      "OPENED",
      "EVIDENCE_ADDED",
      "REVIEW_STARTED",
      "ASSIGNED",
      "RESOLUTION_REQUESTED",
      "RESOLUTION_APPROVED",
      "RESOLUTION_REJECTED",
      "DISMISSED",
      "REOPENED",
    ]).notNull(),
    actorType: mysqlEnum("actorType", ["USER", "SYSTEM"])
      .default("USER")
      .notNull(),
    previousStatus: mysqlEnum("previousStatus", [
      "OPEN",
      "IN_REVIEW",
      "PENDING_RESOLUTION",
      "RESOLVED",
      "DISMISSED",
    ]),
    newStatus: mysqlEnum("newStatus", [
      "OPEN",
      "IN_REVIEW",
      "PENDING_RESOLUTION",
      "RESOLVED",
      "DISMISSED",
    ]).notNull(),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    evidenceReference: varchar("evidenceReference", { length: 500 }),
    reason: varchar("reason", { length: 1000 }).notNull(),
    actorId: int("actorId").references(() => users.id),
    counterpartyActorId: int("counterpartyActorId").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    eventHashUq: unique("uq_purchase_integrity_event_hash").on(
      table.caseId,
      table.payloadHash,
    ),
    caseDateIdx: index("idx_purchase_integrity_event_case_date").on(
      table.caseId,
      table.createdAt,
    ),
    branchTypeIdx: index("idx_purchase_integrity_event_branch_type").on(
      table.branchId,
      table.eventType,
    ),
    makerChecker: check(
      "chk_purchase_integrity_event_sod",
      sql`${table.eventType} NOT IN ('RESOLUTION_APPROVED','DISMISSED') OR (${table.counterpartyActorId} IS NOT NULL AND ${table.counterpartyActorId} <> ${table.actorId})`,
    ),
    actorShape: check(
      "chk_purchase_integrity_event_actor",
      sql`(${table.actorType} = 'USER' AND ${table.actorId} IS NOT NULL) OR (${table.actorType} = 'SYSTEM' AND ${table.actorId} IS NULL AND ${table.eventType} IN ('OPENED','EVIDENCE_ADDED'))`,
    ),
  }),
);

export type PurchaseIntegrityCase = typeof purchaseIntegrityCases.$inferSelect;
export type PurchaseIntegrityCaseEvent = typeof purchaseIntegrityCaseEvents.$inferSelect;

/* ============================ الطلبات الإلكترونية (الشحن/التتبع) ============================ */

export const onlineOrders = mysqlTable(
  "onlineOrders",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    orderNumber: varchar("orderNumber", { length: 50 }).notNull().unique(),
    customerId: bigint("customerId", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(
      () => invoices.id,
    ),
    orderDate: timestamp("orderDate").defaultNow().notNull(),
    // لقطة 24 ساعة لطلبات المتجر PENDING؛ nullable فقط لتوافق الإدخالات الداخلية/الإرثية.
    reservationExpiresAt: timestamp("reservationExpiresAt", { fsp: 3 }).default(
      sql`(DATE_ADD(orderDate, INTERVAL 24 HOUR))`,
    ),
    subtotal: decimal("subtotal", { precision: 15, scale: 2 }).notNull(),
    shippingCost: decimal("shippingCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // لقطة عرض الشحن المجاني للطلب نفسه. shippingCost هو ما يدفعه الزبون (صفر عند الهدية)،
    // أمّا deliveryWaivedAmount فهو أجرة المندوب الفعلية التي تحمّلتها المكتبة. تنتقل اللقطة
    // إلى الفاتورة/الإرسالية عند dispatch ولا تُشتق لاحقاً من جدول أسعار قابل للتعديل.
    deliveryFree: boolean("deliveryFree").default(false).notNull(),
    deliveryWaivedAmount: decimal("deliveryWaivedAmount", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    taxAmount: decimal("taxAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    status: mysqlEnum("orderStatus", [
      "PENDING",
      "CONFIRMED",
      "PROCESSING",
      "SHIPPED",
      "DELIVERED",
      "CANCELLED",
    ])
      .default("PENDING")
      .notNull(),
    shippingAddress: text("shippingAddress"),
    trackingNumber: varchar("trackingNumber", { length: 100 }),
    // حقول متجر الجوال B2C (COD) — أُضيفت في هجرة 0063. المحافظة تُحدّد الأجرة (shippingCost)
    // والتوجيه؛ الإحداثيات لخريطة المندوب (شريحة ٥)؛ clientRequestId لمنع الطلب المكرّر (نقرة مزدوجة).
    governorate: varchar("governorate", { length: 40 }),
    latitude: decimal("latitude", { precision: 10, scale: 7 }),
    longitude: decimal("longitude", { precision: 10, scale: 7 }),
    clientRequestId: varchar("clientRequestId", { length: 80 }),
    // تتبّع الضيف: الرمز الخام لا يُخزّن. publicId عشوائي بلا PII يسمح بإعادة إصدار الرمز
    // الحتميّ عند idempotent replay، وhash هو مفتاح الاسترجاع/الإبطال. انتهاءٌ صريح محدود.
    guestTrackingPublicId: varchar("guestTrackingPublicId", { length: 32 }),
    guestTrackingTokenHash: varchar("guestTrackingTokenHash", { length: 64 }),
    guestTrackingExpiresAt: timestamp("guestTrackingExpiresAt", { fsp: 3 }),
    // كوبون المتجر المحقق خادمياً؛ يُستهلك عند إصدار الفاتورة الحقيقية.
    couponCode: varchar("couponCode", { length: 64 }),
    couponDiscount: decimal("couponDiscount", { precision: 15, scale: 2 }).default("0").notNull(),
    // جهة التوصيل المُسنَد إليها الطلب عند الإرسال (مندوب داخلي/شركة) — تغذّي شاشة المندوب (ش٥). هجرة 0067.
    deliveryPartyId: bigint("deliveryPartyId", { mode: "number" }),
    // سبب الإلغاء — يملؤه المندوب عند «تعذّر التسليم» (رفض الزبون/عنوان خاطئ...) ليراه الموظّف. هجرة 0069.
    cancelReason: varchar("cancelReason", { length: 500 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_order_number").on(table.orderNumber),
    customerIdx: index("idx_order_customer").on(table.customerId),
    statusIdx: index("idx_order_status").on(table.status),
    statusReservationExpiryIdx: index("idx_order_status_reservation_expiry").on(
      table.status,
      table.reservationExpiresAt,
    ),
    clientReqUq: unique("uq_online_order_client_req").on(table.clientRequestId),
    guestTrackingPublicIdUq: unique("uq_online_order_guest_tracking_public_id").on(
      table.guestTrackingPublicId,
    ),
    guestTrackingTokenHashUq: unique("uq_online_order_guest_tracking_hash").on(
      table.guestTrackingTokenHash,
    ),
    deliveryPartyIdx: index("idx_order_delivery_party").on(
      table.deliveryPartyId,
    ),
  }),
);

export type OnlineOrder = typeof onlineOrders.$inferSelect;
export type InsertOnlineOrder = typeof onlineOrders.$inferInsert;

/**
 * حجز قسيمة لطلب متجر. ACTIVE لا يعني «مستهلكة»: يمنع استعمالها في طلب/فاتورة أخرى فقط.
 * عند الإرسال تتحول REDEEMED مع couponRedemptions داخل المعاملة نفسها؛ وعند إلغاء/انتهاء
 * الطلب قبل الإرسال تتحول RELEASED. بعد SHIPPED لا تُعاد تلقائياً (سياسة مكافحة إساءة مستقلة).
 */
export const couponReservations = mysqlTable(
  "couponReservations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    couponId: bigint("couponId", { mode: "number" })
      .notNull()
      .references(() => coupons.id),
    programId: bigint("programId", { mode: "number" })
      .notNull()
      .references(() => couponPrograms.id),
    onlineOrderId: bigint("onlineOrderId", { mode: "number" })
      .notNull()
      .references(() => onlineOrders.id, { onDelete: "cascade" }),
    customerId: bigint("customerId", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    discountAmount: decimal("discountAmount", { precision: 15, scale: 2 })
      .notNull(),
    status: mysqlEnum("status", [
      "ACTIVE",
      "REDEEMED",
      "RELEASED",
    ])
      .default("ACTIVE")
      .notNull(),
    // null بعد CONFIRMED: التأكيد حوّل الحجز المؤقت إلى وعدٍ يبقى حتى الإرسال أو الإلغاء.
    expiresAt: timestamp("expiresAt", { fsp: 3 }),
    reservedAt: timestamp("reservedAt", { fsp: 3 }).defaultNow().notNull(),
    redeemedAt: timestamp("redeemedAt", { fsp: 3 }),
    releasedAt: timestamp("releasedAt", { fsp: 3 }),
    releaseReason: varchar("releaseReason", { length: 120 }),
  },
  (table) => ({
    orderUq: unique("uq_coupon_reservation_order").on(table.onlineOrderId),
    couponStatusIdx: index("idx_coupon_reservation_coupon_status").on(
      table.couponId,
      table.status,
      table.expiresAt,
    ),
    programCustomerStatusIdx: index("idx_coupon_reservation_program_customer_status").on(
      table.programId,
      table.customerId,
      table.status,
      table.expiresAt,
    ),
  }),
);

export type CouponReservation = typeof couponReservations.$inferSelect;

export const onlineOrderItems = mysqlTable(
  "onlineOrderItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    onlineOrderId: bigint("onlineOrderId", { mode: "number" })
      .notNull()
      .references(() => onlineOrders.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(
      () => productUnits.id,
    ),
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }).notNull(),
    total: decimal("total", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    orderIdx: index("idx_ooi_order").on(table.onlineOrderId),
  }),
);

export type OnlineOrderItem = typeof onlineOrderItems.$inferSelect;
export type InsertOnlineOrderItem = typeof onlineOrderItems.$inferInsert;

/** مراجعة المنتج من عميل استلم طلباً يحتويه؛ تبقى معلّقة إلى اعتماد المتجر. */
export const storefrontProductReviews = mysqlTable(
  "storefrontProductReviews",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productId: bigint("productId", { mode: "number" }).notNull().references(() => products.id, { onDelete: "cascade" }),
    customerId: bigint("customerId", { mode: "number" }).notNull().references(() => customers.id, { onDelete: "cascade" }),
    onlineOrderId: bigint("onlineOrderId", { mode: "number" }).notNull().references(() => onlineOrders.id, { onDelete: "cascade" }),
    rating: int("rating").notNull(),
    comment: varchar("comment", { length: 1000 }).notNull(),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED"]).default("PENDING").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    moderatedAt: timestamp("moderatedAt"),
  },
  (table) => ({
    productStatusCreatedIdx: index("idx_storefront_review_product_status_created").on(table.productId, table.status, table.createdAt),
    customerIdx: index("idx_storefront_review_customer").on(table.customerId),
    orderProductUq: unique("uq_storefront_review_order_product").on(table.onlineOrderId, table.productId),
  }),
);

export type StorefrontProductReview = typeof storefrontProductReviews.$inferSelect;
export type InsertStorefrontProductReview = typeof storefrontProductReviews.$inferInsert;

/** رابط عام عابر لقائمة رغبات. لا يحمل أي بيانات عميل ويحتفظ بمعرّفات منتجات فقط. */
export const storefrontWishlistShares = mysqlTable(
  "storefrontWishlistShares",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** 144-bit URL-safe server token؛ لا يشتق من العميل ولا من أرقام المنتجات. */
    token: varchar("token", { length: 32 }).notNull(),
    productIds: json("productIds").$type<number[]>().notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    tokenUq: unique("uq_storefront_wishlist_share_token").on(table.token),
    expiryIdx: index("idx_storefront_wishlist_share_expiry").on(table.expiresAt),
  }),
);

export type StorefrontWishlistShare = typeof storefrontWishlistShares.$inferSelect;
export type InsertStorefrontWishlistShare = typeof storefrontWishlistShares.$inferInsert;

/** رابط عام عابر للسلة؛ يحفظ معرفات وحدات البيع والكميات فقط ويُعاد تسعيره عند الفتح. */
export const storefrontCartShares = mysqlTable(
  "storefrontCartShares",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    token: varchar("token", { length: 32 }).notNull(),
    lines: json("lines").$type<Array<{ productId: number; productUnitId: number; quantity: number }>>().notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    tokenUq: unique("uq_storefront_cart_share_token").on(table.token),
    expiryIdx: index("idx_storefront_cart_share_expiry").on(table.expiresAt),
  }),
);
export type StorefrontCartShare = typeof storefrontCartShares.$inferSelect;
export type InsertStorefrontCartShare = typeof storefrontCartShares.$inferInsert;

// ═══════════════════════ إدارة المتجر (لوحة hPanel): بنرات + إعدادات ═══════════════════════
/**
 * storeBanners — بنرات ترويجية **يديرها الموظف** من لوحة المتجر (عنوان/وصف/صورة/زرّ/ترتيب/نافذة
 * تاريخ). مستقلّة عن بنرات «عروض اليوم» المشتقّة تلقائياً من promotions (تُعرَض بجانبها في المتجر).
 * الصورة data-URL مضغوط في mediumtext (نمط productImages.url). branchId=null ⇒ كل الفروع.
 */
export const storeBanners = mysqlTable(
  "storeBanners",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    title: varchar("title", { length: 255 }).notNull(),
    subtitle: varchar("subtitle", { length: 500 }),
    imageUrl: mediumtext("imageUrl"),
    images: json("images"),
    /** نسخة هاتف اختيارية؛ تمنع إجبار تصميم سطح المكتب على مساحة الهاتف. */
    mobileImageUrl: mediumtext("mobileImageUrl"),
    /**
     * SMART_CROP للصور الفوتوغرافية، PRESERVE_FULL للتصاميم التي تحتوي نصاً داخل الصورة
     * (الأصل كامل فوق خلفية ممتدة)، وLAYERED للحملات التي يركب فيها النص من الحقول.
     */
    renderMode: mysqlEnum("renderMode", [
      "SMART_CROP",
      "PRESERVE_FULL",
      "LAYERED",
    ])
      .default("PRESERVE_FULL")
      .notNull(),
    focusX: int("focusX").default(50).notNull(),
    focusY: int("focusY").default(50).notNull(),
    ctaLabel: varchar("ctaLabel", { length: 120 }),
    ctaUrl: varchar("ctaUrl", { length: 500 }),
    // موضع البنر في المتجر (هجرة 0074): HERO كاروسيل أعلى المتجر (الافتراضي = سلوك ما قبل العمود)،
    // SIDE بنر طولي بجوانب الشاشات العريضة، INLINE فاصل عرضي بين صفوف المنتجات.
    placement: mysqlEnum("placement", ["HERO", "SIDE", "INLINE"])
      .default("HERO")
      .notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    effectiveFrom: date("effectiveFrom", { mode: "string" }),
    effectiveTo: date("effectiveTo", { mode: "string" }),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    activeSortIdx: index("idx_banner_active_sort").on(t.isActive, t.sortOrder),
    branchIdx: index("idx_banner_branch").on(t.branchId),
  }),
);
export type StoreBanner = typeof storeBanners.$inferSelect;
export type InsertStoreBanner = typeof storeBanners.$inferInsert;

/** مؤشرات يومية مجمّعة للبنرات؛ لا تحتفظ بأي معرّف زائر أو بيانات شخصية. */
export const storeBannerDailyMetrics = mysqlTable(
  "storeBannerDailyMetrics",
  {
    bannerId: bigint("bannerId", { mode: "number" })
      .notNull()
      .references(() => storeBanners.id, { onDelete: "cascade" }),
    metricDate: date("metricDate", { mode: "string" }).notNull(),
    placement: mysqlEnum("placement", ["HERO", "SIDE", "INLINE"]).notNull(),
    impressions: int("impressions").default(0).notNull(),
    clicks: int("clicks").default(0).notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.bannerId, t.metricDate, t.placement],
      name: "pk_banner_daily_metric",
    }),
    dateIdx: index("idx_banner_metric_date").on(t.metricDate),
  }),
);

/**
 * قمع تحويل المتجر اليومي. لا يخزّن أي معرّف زائر أو عنوان أو بيانات عميل؛
 * إنه عداد عمل تشغيلي لكل فرع/يوم فقط، كي لا تتحول التحليلات التسويقية إلى
 * سجل تصفح فردي.
 */
export const storeConversionDailyMetrics = mysqlTable(
  "storeConversionDailyMetrics",
  {
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    metricDate: date("metricDate", { mode: "string" }).notNull(),
    productViews: int("productViews").default(0).notNull(),
    cartAdds: int("cartAdds").default(0).notNull(),
    checkoutStarts: int("checkoutStarts").default(0).notNull(),
    completedOrders: int("completedOrders").default(0).notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.branchId, t.metricDate],
      name: "pk_store_conversion_daily",
    }),
    dateIdx: index("idx_store_conversion_date").on(t.metricDate),
  }),
);
export type StoreConversionDailyMetric =
  typeof storeConversionDailyMetrics.$inferSelect;

/** نقرات «قد يعجبك أيضاً» اليومية؛ عداد مجهّل للمنتج المقترح دون معرّف زائر أو جلسة. */
export const storeRecommendationDailyMetrics = mysqlTable(
  "storeRecommendationDailyMetrics",
  {
    // ٢٤/٨: أزلنا `.references()` inline — أسماء FK التلقائيّة كانت تُتوَّج بـ
    // `storeRecommendationDailyMetrics_recommendedProductId_products_id_fk` (٦٥ حرفاً)،
    // فيرفضها MySQL 8.4 بحدّ الـ٦٤. نستعمل `foreignKey({ name })` أدناه بأسماءٍ صريحة قصيرة.
    branchId: bigint("branchId", { mode: "number" }).notNull(),
    metricDate: date("metricDate", { mode: "string" }).notNull(),
    sourceProductId: bigint("sourceProductId", { mode: "number" }).notNull(),
    recommendedProductId: bigint("recommendedProductId", { mode: "number" }).notNull(),
    clicks: int("clicks").default(0).notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.branchId, t.metricDate, t.sourceProductId, t.recommendedProductId],
      name: "pk_store_recommendation_daily",
    }),
    dateIdx: index("idx_store_recommendation_metric_date").on(t.metricDate),
    recommendedIdx: index("idx_store_recommendation_product").on(t.recommendedProductId, t.metricDate),
    // أسماءٌ صريحة ≤٦٤ حرفاً — تُلبّي حدّ MySQL 8.4 على أسماء المُعرِّفات.
    branchFk: foreignKey({
      columns: [t.branchId],
      foreignColumns: [branches.id],
      name: "fk_srdm_branch",
    }).onDelete("cascade"),
    sourceFk: foreignKey({
      columns: [t.sourceProductId],
      foreignColumns: [products.id],
      name: "fk_srdm_source_product",
    }).onDelete("cascade"),
    recommendedFk: foreignKey({
      columns: [t.recommendedProductId],
      foreignColumns: [products.id],
      name: "fk_srdm_recommended_product",
    }).onDelete("cascade"),
  }),
);
export type StoreRecommendationDailyMetric = typeof storeRecommendationDailyMetrics.$inferSelect;

/** إعدادات المتجر (صفّ مفرد، نمط taxSettings): فتح/إغلاق المتجر، شريط إعلان، رقم واتساب. */
export const storeSettings = mysqlTable(
  "storeSettings",
  {
    id: int("id").autoincrement().primaryKey(),
    isOpen: boolean("isOpen").default(true).notNull(),
    announcement: varchar("announcement", { length: 500 }),
    whatsappNumber: varchar("whatsappNumber", { length: 20 }),
    /**
     * الفرع التشغيلي الوحيد للمتجر العام. لا يجوز استنتاجه من فرع المستخدم أو من رقم 1؛
     * كل الكتالوج والطلب ولوحة الإدارة يعيد قراءة هذا المرجع الصريح.
     * يبقى nullable لتسمح الهجرة بقاعدة جديدة قبل seed، لكن فتح المتجر يُرفض خادمياً بلا قيمة.
     */
    fulfillmentBranchId: bigint("fulfillmentBranchId", {
      mode: "number",
    }).references(() => branches.id, { onDelete: "restrict" }),
    // عتبة التوصيل المجاني (AOV): إن بلغ المجموع الفرعي هذا الحدّ ⇒ أجرة توصيل صفر. null/0 = معطّل.
    freeShippingThreshold: decimal("freeShippingThreshold", {
      precision: 15,
      scale: 2,
    }),
    updatedBy: int("updatedBy").references(() => users.id),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    fulfillmentBranchIdx: index("idx_store_settings_fulfillment_branch").on(
      table.fulfillmentBranchId,
    ),
  }),
);
export type StoreSettings = typeof storeSettings.$inferSelect;
export type InsertStoreSettings = typeof storeSettings.$inferInsert;

/* ============================ الموارد البشرية ============================ */

export const employees = mysqlTable(
  "employees",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").references(() => users.id),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
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
    payType: mysqlEnum("payType", ["monthly", "hourly"])
      .default("monthly")
      .notNull(),
    allowances: decimal("allowances", { precision: 15, scale: 2 }).default("0"),
    /** سعر الساعة لكل يوم لموظفي الساعة: {"الأحد":5000,...} (أجر اليوم = ساعات × سعر ذلك اليوم). */
    dayRates: json("dayRates"),
    /**
     * جدول الدوام الأسبوعيّ لهذا الموظف: ساعات كل يوم بأسماء الأيام العربية (0139)
     *   {"الأحد":8,"الاثنين":8,"الثلاثاء":8,"الأربعاء":8,"الخميس":8,"الجمعة":4,"السبت":0}
     *
     * **صفر ساعة = يوم راحة** — فالمفهومان (الراحة والساعات) واحدٌ لا اثنان. استبدل
     * `restDays`+`dailyHours` من 0138 لأن الواقع أغنى منهما: الجمعة عند المالك **يوم دوام
     * بساعات أقلّ** يحدّدها، لا راحةً ولا يوماً كاملاً — وهو ما عجز النموذج القديم عن تمثيله.
     *
     * منه يُشتقّ مقام سعر الساعة: مجموع ساعات أيام الشهر وفق هذا الجدول.
     * null = يُستعمل الجدول الافتراضي العامّ في hrAttendanceSettings.
     */
    workSchedule: json("workSchedule"),
    /**
     * إعفاءٌ من الحضور — راتبٌ ثابت (0141، قرار المالك ٣١/٧). للمُلّاك ولمن لا جهاز له.
     * مع تفعيل الأجر بالحضور، غير المُعفى بلا بصمات يُحتسب شهراً كاملاً غياباً فيقبض صفراً.
     * **صريح لا مُخمَّن**: الإعفاء التلقائيّ لمن لا بصمات له كان سيُعفي صامتاً موظفاً
     * تعطّل جهازه فيقبض عن غيابٍ حقيقيّ. الإعفاء من الحضور وحده — الإجازات والسلف تبقى.
     */
    attendanceExempt: boolean("attendanceExempt").default(false).notNull(),
    /** حالة التوظيف (مستقلة عن isActive للحذف الناعم). */
    employmentStatus: mysqlEnum("employmentStatus", [
      "active",
      "leave",
      "terminated",
    ])
      .default("active")
      .notNull(),
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
  }),
);

export type Employee = typeof employees.$inferSelect;
export type InsertEmployee = typeof employees.$inferInsert;

export const attendance = mysqlTable(
  "attendance",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    employeeId: bigint("employeeId", { mode: "number" })
      .notNull()
      .references(() => employees.id),
    attendanceDate: date("attendanceDate", { mode: "string" }).notNull(),
    checkIn: timestamp("checkIn"),
    checkOut: timestamp("checkOut"),
    status: mysqlEnum("attendanceStatus", [
      "PRESENT",
      "ABSENT",
      "LATE",
      "LEAVE",
    ]).notNull(),
    notes: text("notes"),
    // HR — نظام الساعات: ساعات اليوم + سعر الساعة (لقطة وقت التسجيل) + الأجر المحسوب + مصدر التسجيل.
    hours: decimal("hours", { precision: 6, scale: 2 }),
    hourlyRate: decimal("hourlyRate", { precision: 15, scale: 2 }),
    amount: decimal("amount", { precision: 15, scale: 2 }),
    source: varchar("source", { length: 20 }).default("fingerprint"), // fingerprint | manual
    /**
     * يومٌ ينقصه إغلاق (عدد بصمات فرديّ) — 0137. لا يُخمَّن أجره ولا يمرّ صامتاً بصفر ساعات:
     * يُوسَم ليصحّحه المدير يدوياً قبل إغلاق الشهر. التصحيح اليدوي يُطفئ الوسم.
     */
    needsReview: boolean("needsReview").default(false).notNull(),
    reviewReason: varchar("reviewReason", { length: 120 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    employeeIdx: index("idx_att_employee").on(table.employeeId),
    dateIdx: index("idx_att_date").on(table.attendanceDate),
    // طابور التصحيح: الأيام الناقصة قليلة وسط آلاف الصفوف ⇒ فهرس جزئيّ المعنى على العلم+التاريخ.
    reviewIdx: index("idx_att_review").on(
      table.needsReview,
      table.attendanceDate,
    ),
    // مفتاح فريد ليوم/موظف: يضمن سجلّ حضور واحد لكل (موظف، تاريخ) فيمنع ازدواج
    // الصفوف الذي يضاعف ساعات/مبالغ مسيّر الرواتب (تكامل مالي). يدعم UPSERT الخدمة.
    employeeDateUq: unique("uq_att_employee_date").on(
      table.employeeId,
      table.attendanceDate,
    ),
  }),
);

export type Attendance = typeof attendance.$inferSelect;
export type InsertAttendance = typeof attendance.$inferInsert;

/* ============================ الاستيراد والطباعة والتدقيق ============================ */

export const importBatches = mysqlTable(
  "importBatches",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    batchName: varchar("batchName", { length: 255 }).notNull(),
    importType: mysqlEnum("importType", [
      "PRODUCTS",
      "CUSTOMERS",
      "SUPPLIERS",
    ]).notNull(),
    fileName: varchar("fileName", { length: 255 }),
    totalRows: int("totalRows"),
    successfulRows: int("successfulRows").default(0),
    failedRows: int("failedRows").default(0),
    status: mysqlEnum("batchStatus", [
      "PENDING",
      "PROCESSING",
      "COMPLETED",
      "FAILED",
    ])
      .default("PENDING")
      .notNull(),
    errorLog: json("errorLog"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  (table) => ({
    typeIdx: index("idx_import_type").on(table.importType),
  }),
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
    /**
     * ١٢٠ لا ٦٤ (هجرة 0328، ٣/٩/٢٦): عقودُ الراوترات والخدمات تقبل المفتاح حتى ١٢٠ محرفاً
     * (`decisionKey`/`requestKey` `.max(120)`، وأعمدة goodsReceipts/supplierInvoices/purchaseCharges
     * ١٢٠) بينما كان هذا العمود وحده ٦٤ ⇒ مفتاحُ قرار الشاشة
     * `purchase-decision-PURCHASE_ORDER-<id>-approve-<uuid>` (~٨٠) يمرّ كلَّ الطبقات ثمّ يسقط هنا
     * بـER_DATA_TOO_LONG فيُرفض اعتمادُ فاتورة الشراء ورفضُها معاً على الإنتاج.
     */
    clientRequestId: varchar("clientRequestId", { length: 120 }).notNull(),
    refId: bigint("refId", { mode: "number" }).notNull(), // المعرّف الناتج (إيصال/استرداد/استلام)
    // hash الحمولة القانونيّ (sha256، #٥): يكشف «نفس المفتاح بحمولةٍ مختلفة» ⇒ CONFLICT. nullable
    // للتوافق الخلفيّ (صفوف/مسارات بلا hash تبقى تُعيد refId المخزّن كالسابق).
    payloadHash: varchar("payloadHash", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    opKeyUq: unique("uq_idempotency_op_key").on(
      table.operation,
      table.clientRequestId,
    ),
  }),
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;

export const printJobs = mysqlTable(
  "printJobs",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    jobType: mysqlEnum("printJobType", [
      "INVOICE",
      "SHIFT_REPORT",
      "OPENING_BALANCE",
      "RECEIPT",
      "WORK_ORDER",
    ])
      .default("INVOICE")
      .notNull(),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(
      () => invoices.id,
    ),
    referenceId: bigint("referenceId", { mode: "number" }),
    payload: json("payload"),
    status: mysqlEnum("printStatus", [
      "PENDING",
      "PRINTING",
      "PRINTED",
      "FAILED",
    ])
      .default("PENDING")
      .notNull(),
    attempts: int("attempts").default(0),
    maxAttempts: int("maxAttempts").default(3),
    errorMessage: text("errorMessage"),
    printedAt: timestamp("printedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    statusIdx: index("idx_print_status").on(table.status),
  }),
);

export type PrintJob = typeof printJobs.$inferSelect;
export type InsertPrintJob = typeof printJobs.$inferInsert;

/** سجل تدقيق طباعة append-only. كل انتقال (طلب/فتح حوار/إرسال/فشل) صف مستقل لا يُعدَّل. */
export const documentPrintEvents = mysqlTable(
  "documentPrintEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestId: varchar("requestId", { length: 80 }).notNull(),
    documentType: varchar("documentType", { length: 40 }).notNull(),
    documentId: bigint("documentId", { mode: "number" }),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    actorUserId: int("actorUserId")
      .notNull()
      .references(() => users.id),
    actorNameSnapshot: varchar("actorNameSnapshot", { length: 255 }).notNull(),
    channel: mysqlEnum("channel", [
      "BROWSER",
      "PDF",
      "THERMAL",
      "SERVER_BRIDGE",
    ]).notNull(),
    outcome: mysqlEnum("outcome", [
      "REQUESTED",
      "DIALOG_OPENED",
      "DISPATCHED",
      "FAILED",
    ]).notNull(),
    copies: int("copies").default(1).notNull(),
    failureCode: varchar("failureCode", { length: 80 }),
    reprintOfRequestId: varchar("reprintOfRequestId", { length: 80 }),
    eventAt: timestamp("eventAt").defaultNow().notNull(),
  },
  (table) => ({
    requestOutcomeUq: unique("uq_print_event_request_outcome").on(
      table.requestId,
      table.outcome,
    ),
    documentIdx: index("idx_print_event_document").on(
      table.documentType,
      table.documentId,
      table.eventAt,
    ),
    actorDateIdx: index("idx_print_event_actor_date").on(
      table.actorUserId,
      table.eventAt,
    ),
    branchDateIdx: index("idx_print_event_branch_date").on(
      table.branchId,
      table.eventAt,
    ),
  }),
);

export type DocumentPrintEvent = typeof documentPrintEvents.$inferSelect;

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
    /** عقد الإسناد مستقلّ عن حمولة التغيير كي يبقى oldValue/newValue متوافقين مع مستهلكيهما. */
    operation: json("operation"),
    /** نسخة مفهرسة من operation.screenPath لتصفية سجل الشاشة بلا JSON_EXTRACT. */
    screenPath: varchar("screenPath", { length: 255 }),
    ipAddress: varchar("ipAddress", { length: 45 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("idx_audit_user").on(table.userId),
    branchIdx: index("idx_audit_branch").on(table.branchId),
    actionIdx: index("idx_audit_action").on(table.action),
    dateIdx: index("idx_audit_date").on(table.createdAt),
    // S1 (٢٩/٦/٢٦): تتبّع نشاط المستخدم (userId+action+تاريخ) وسجلّ تغيّر الكيان (entityType+entityId+تاريخ). هجرة 0031.
    userActionDateIdx: index("idx_audit_user_action_date").on(
      table.userId,
      table.action,
      table.createdAt,
    ),
    entityIdx: index("idx_audit_entity").on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    screenPathIdIdx: index("idx_audit_screen_path_id").on(
      table.screenPath,
      table.id,
    ),
  }),
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
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    scopeType: mysqlEnum("scopeType", [
      "FULL",
      "MOVING",
      "CATEGORY",
      "MANUAL",
    ]).notNull(),
    // وصف النطاق (JSON): { days?, categoryIds?, variantIds?, label }
    scopeDetail: text("scopeDetail"),
    // NORMAL = جرد دوري بكامل قيوده المالية؛ OPENING = «جرد افتتاحي» (الافتتاح التدريجي ١٨/٧): يثبّت
    // العدّ كرصيد افتتاحي (setStock بمرجع OPENING) **بلا قيدَي عجز/زيادة** ويختم branchStock.openedAt —
    // محصور بنافذة وضع الافتتاح وبمدير فأعلى وبتوقيعَين دائماً، ويستبعد المُفتتَح (مرّة واحدة لكل صنف×فرع).
    sessionType: mysqlEnum("sessionType", ["NORMAL", "OPENING"])
      .default("NORMAL")
      .notNull(),
    status: mysqlEnum("stocktakeStatus", [
      "COUNTING",
      "REVIEW",
      "APPROVED",
      "CANCELLED",
    ])
      .default("COUNTING")
      .notNull(),
    // جرد أعمى: بوابة العدّ لا تستلم الرصيد الدفتري إطلاقاً.
    blind: boolean("blind").default(true).notNull(),
    // «ضمن الحد» = pct ≤ thresholdPct و |القيمة| ≤ thresholdValue.
    thresholdPct: decimal("thresholdPct", { precision: 5, scale: 2 })
      .default("5.00")
      .notNull(),
    thresholdValue: decimal("thresholdValue", { precision: 15, scale: 2 })
      .default("25000.00")
      .notNull(),
    // فرق واحد |قيمته| > dualThreshold ⇒ توقيعان من مستخدمَين مختلفَين.
    dualThreshold: decimal("dualThreshold", { precision: 15, scale: 2 })
      .default("150000.00")
      .notNull(),
    directUnderThreshold: boolean("directUnderThreshold")
      .default(true)
      .notNull(),
    waNotify: boolean("waNotify").default(true).notNull(),
    dupPolicy: mysqlEnum("dupPolicy", ["VERIFY", "BLOCK"])
      .default("VERIFY")
      .notNull(),
    // أسلوب العدّ (وثيقة «الجرد بالباركود» ٢٢/٨): SCAN_REQUIRED = لا تُفتح بطاقة عدٍّ إلا بمسحٍ
    // فعليّ أو استثناء يدويّ محكوم؛ FREE = النقر الحر يفتح البطاقة (السلوك القديم). الافتراض في
    // القاعدة FREE للتوافق مع الجلسات القائمة قبل الميزة؛ والجلسة الجديدة تُنشأ SCAN_REQUIRED من
    // create.ts (قرار المالك) — راجع shared/stocktakeCountMethod.ts.
    countMethod: mysqlEnum("countMethod", ["SCAN_REQUIRED", "FREE"])
      .default("FREE")
      .notNull(),
    // حوكمة (م٥، وثيقة «الجرد بالباركود» ٢٢/٨): إن كانت true، لا تُعتمد الجلسة ما دام صنفٌ يتجاوز
    // الحدّ لم يُعَد عدّه فعلياً (RECOUNT) — قرار المدير وحده لا يكفي فوق الحدّ. الافتراض false
    // (توافق الجلسات القائمة والسلوك القديم). راجع reviewCore.buildBarriers.
    requireRecountOverThreshold: boolean("requireRecountOverThreshold")
      .default(false)
      .notNull(),
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
  }),
);

export type StocktakeSession = typeof stocktakeSessions.$inferSelect;
export type InsertStocktakeSession = typeof stocktakeSessions.$inferInsert;

/** تكليف عامل جرد (منطقة): رابط خارجي بـ PIN (hash) أو حساب داخلي. */
export const stocktakeAssignments = mysqlTable(
  "stocktakeAssignments",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sessionId: bigint("sessionId", { mode: "number" })
      .notNull()
      .references(() => stocktakeSessions.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    method: mysqlEnum("method", ["PIN", "USER"]).notNull(),
    userId: int("userId").references(() => users.id),
    pinHash: varchar("pinHash", { length: 255 }),
    zone: varchar("zone", { length: 120 }),
    status: mysqlEnum("assignmentStatus", ["ACTIVE", "SUBMITTED", "REMOVED"])
      .default("ACTIVE")
      .notNull(),
    // أثر دورة حياة العامل: الإزالة إبطال وصول وليست حذفاً للسجل أو للعدّات المنفّذة.
    addedBy: int("addedBy").references(() => users.id),
    removedBy: int("removedBy").references(() => users.id),
    removedAt: timestamp("removedAt"),
    removalReason: varchar("removalReason", { length: 255 }),
    // قفل محاولات PIN الفاشلة (نمط قفل الحساب 5/15د).
    failedPinAttempts: int("failedPinAttempts").default(0).notNull(),
    lockedUntil: timestamp("lockedUntil"),
    lastActivityAt: timestamp("lastActivityAt"),
    submittedAt: timestamp("submittedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    sessionIdx: index("idx_stkassign_session").on(table.sessionId),
    sessionStatusIdx: index("idx_stkassign_session_status").on(
      table.sessionId,
      table.status,
    ),
  }),
);

export type StocktakeAssignment = typeof stocktakeAssignments.$inferSelect;
export type InsertStocktakeAssignment =
  typeof stocktakeAssignments.$inferInsert;

/** أصناف الجلسة: لقطة الرصيد الدفتري والتكلفة لحظة الإنشاء (جوهر الجرد الأعمى). */
export const stocktakeItems = mysqlTable(
  "stocktakeItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sessionId: bigint("sessionId", { mode: "number" })
      .notNull()
      .references(() => stocktakeSessions.id, { onDelete: "cascade" }),
    assignmentId: bigint("assignmentId", { mode: "number" })
      .notNull()
      .references(() => stocktakeAssignments.id),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    // الرصيد الدفتري بالوحدة الأساس لحظة بدء الجلسة — لا يصل لبوابة العدّ أبداً.
    expectedQty: int("expectedQty").notNull(),
    // تكلفة المتغيّر لحظة الإنشاء — تقييم الفرق يثبت عليها.
    unitCost: decimal("unitCost", { precision: 15, scale: 2 }).notNull(),
    // طلب إعادة العدّ: PENDING يحجب الاعتماد حتى يصل عدّ RECOUNT.
    recountStatus: mysqlEnum("recountStatus", ["PENDING", "DONE"]),
    recountRequestedBy: int("recountRequestedBy").references(() => users.id),
    recountReason: varchar("recountReason", { length: 255 }),
    recountRequestedAt: timestamp("recountRequestedAt"),
    // اعتماد مرحلي أثناء استمرار الجرد؛ التسوية المخزنية والمحاسبية تبقى عند الاعتماد النهائي.
    reviewApprovedBy: int("reviewApprovedBy").references(() => users.id),
    reviewApprovedAt: timestamp("reviewApprovedAt"),
    // بصمة نسخة العد/القرار التي اعتمدها المدير.
    reviewApprovedOperationId: bigint("reviewApprovedOperationId", {
      mode: "number",
    }),
    reviewApprovedQty: int("reviewApprovedQty"),
    reviewApprovedSnapshotHash: varchar("reviewApprovedSnapshotHash", {
      length: 64,
    }),
    // آخر إعادة فتح صريحة؛ السجل الكامل append-only في stocktakeItemReviewEvents.
    reviewReopenedBy: int("reviewReopenedBy"),
    reviewReopenedAt: timestamp("reviewReopenedAt"),
    reviewReopenReason: varchar("reviewReopenReason", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    sessionVariantUq: unique("uq_stkitem_session_variant").on(
      table.sessionId,
      table.variantId,
    ),
    sessionIdx: index("idx_stkitem_session").on(table.sessionId),
    assignmentIdx: index("idx_stkitem_assignment").on(table.assignmentId),
    sessionReviewApprovedIdx: index("idx_stkitem_session_review_approved").on(
      table.sessionId,
      table.reviewApprovedAt,
    ),
    reviewApprovedOperationFk: foreignKey({
      name: "fk_stkitem_review_approved_operation",
      columns: [table.reviewApprovedOperationId],
      foreignColumns: [stocktakeCountOperations.id],
    }).onDelete("set null"),
    reviewReopenedByFk: foreignKey({
      name: "fk_stkitem_review_reopened_by",
      columns: [table.reviewReopenedBy],
      foreignColumns: [users.id],
    }),
  }),
);

export type StocktakeItem = typeof stocktakeItems.$inferSelect;
export type InsertStocktakeItem = typeof stocktakeItems.$inferInsert;

/** سجل العدّات: الأول + إعادة العدّ + التحقّقي (عدّ زميل بسياسة VERIFY) — كلها تبقى موثّقة. */
export const stocktakeCounts = mysqlTable(
  "stocktakeCounts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sessionId: bigint("sessionId", { mode: "number" })
      .notNull()
      .references(() => stocktakeSessions.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    assignmentId: bigint("assignmentId", { mode: "number" })
      .notNull()
      .references(() => stocktakeAssignments.id),
    kind: mysqlEnum("kind", ["FIRST", "RECOUNT", "VERIFY"]).notNull(),
    // بالوحدة الأساس (التحويل من وحدات الإدخال يتم قبل الحفظ).
    qty: int("qty").notNull(),
    // تفصيل الإدخال متعدد الوحدات (JSON): {"كرتون":2,"قطعة":5} — للتدقيق.
    unitBreakdown: text("unitBreakdown"),
    // نسب العدّة إلى مصدرها (وثيقة «الجرد بالباركود» ٢٢/٨): مسح قارئ/كاميرا، أو استثناء يدويّ
    // محكوم، أو اختيار حر (FREE فقط). NULL للعدّات السابقة لهذه الميزة. التسمية والقواعد في
    // shared/stocktakeCountMethod.ts؛ الإثبات (إعادة حلّ الباركود) في submit.ts.
    entryMethod: mysqlEnum("entryMethod", [
      "SCAN_HID",
      "SCAN_CAMERA",
      "MANUAL_AUTHORIZED",
      "SEARCH_PICK",
    ]),
    // الباركود الممسوح فعلاً (كما وصل) — للتدقيق ولإثبات المطابقة الخادمية. NULL للإدخال اليدوي.
    scannedBarcode: varchar("scannedBarcode", { length: 64 }),
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
    sessionVariantIdx: index("idx_stkcount_session_variant").on(
      table.sessionId,
      table.variantId,
    ),
    assignmentIdx: index("idx_stkcount_assignment").on(table.assignmentId),
    // S1 (٢٩/٦/٢٦): تحليل جولات الجرد لكل (جلسة+نوع العدّة+وقت العدّ). هجرة 0031.
    sessionKindDateIdx: index("idx_stkcount_session_kind_date").on(
      table.sessionId,
      table.kind,
      table.countedAt,
    ),
    requestUq: unique("uq_stkcount_request").on(
      table.sessionId,
      table.clientRequestId,
    ),
  }),
);

export type StocktakeCount = typeof stocktakeCounts.$inferSelect;
export type InsertStocktakeCount = typeof stocktakeCounts.$inferInsert;

/** Append-only idempotency ledger for count.submit across offline devices. */
export const stocktakeCountOperations = mysqlTable(
  "stocktakeCountOperations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sessionId: bigint("sessionId", { mode: "number" })
      .notNull()
      .references(() => stocktakeSessions.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    assignmentId: bigint("assignmentId", { mode: "number" })
      .notNull()
      .references(() => stocktakeAssignments.id),
    clientRequestId: varchar("clientRequestId", { length: 64 }).notNull(),
    requestQty: int("requestQty").notNull(),
    requestUnitBreakdown: text("requestUnitBreakdown"),
    resultKind: mysqlEnum("resultKind", [
      "FIRST",
      "RECOUNT",
      "VERIFY",
    ]).notNull(),
    resultVerifyMatch: boolean("resultVerifyMatch"),
    // نسب الطلب المقبول إلى مصدره — مرآة stocktakeCounts (سجل الإعادة الوحيد). NULL لما قبل الميزة.
    entryMethod: mysqlEnum("entryMethod", [
      "SCAN_HID",
      "SCAN_CAMERA",
      "MANUAL_AUTHORIZED",
      "SEARCH_PICK",
    ]),
    scannedBarcode: varchar("scannedBarcode", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    requestUq: unique("uq_stkcountop_request").on(
      table.sessionId,
      table.clientRequestId,
    ),
    assignmentCreatedIdx: index("idx_stkcountop_assignment_created").on(
      table.assignmentId,
      table.createdAt,
    ),
  }),
);

export type StocktakeCountOperation =
  typeof stocktakeCountOperations.$inferSelect;
export type InsertStocktakeCountOperation =
  typeof stocktakeCountOperations.$inferInsert;

/**
 * باركود مُسِح في الميدان ولم يُحلّ داخل نطاق الجلسة (وثيقة «الجرد بالباركود» ٢٢/٨).
 * أثمن ما يلتقطه الجرد: بضاعة على الرف لا يعرفها النظام أو صنفٌ خارج النطاق. append-only —
 * يُلتقط أوفلاين عبر الطابور القائم، ويعالجه المشرف: RESOLVED (أُضيف للنطاق/سُجّل) أو DISMISSED.
 */
export const stocktakeUnknownScans = mysqlTable(
  "stocktakeUnknownScans",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sessionId: bigint("sessionId", { mode: "number" })
      .notNull()
      .references(() => stocktakeSessions.id, { onDelete: "cascade" }),
    assignmentId: bigint("assignmentId", { mode: "number" })
      .notNull()
      .references(() => stocktakeAssignments.id),
    barcode: varchar("barcode", { length: 64 }).notNull(),
    scannedByName: varchar("scannedByName", { length: 120 }).notNull(),
    scannedByUserId: int("scannedByUserId").references(() => users.id),
    status: mysqlEnum("unknownScanStatus", ["PENDING", "RESOLVED", "DISMISSED"])
      .default("PENDING")
      .notNull(),
    // إن حُلّ بإضافته للنطاق: المتغيّر الذي أُلحق (وإلا NULL — سُجّل كصنف غير مسجّل).
    resolvedVariantId: bigint("resolvedVariantId", { mode: "number" }).references(
      () => productVariants.id,
    ),
    resolvedBy: int("resolvedBy").references(() => users.id),
    resolvedAt: timestamp("resolvedAt"),
    resolutionNote: varchar("resolutionNote", { length: 255 }),
    // idempotency لمزامنة طابور الأوفلاين — نفس المسح لا يُكرَّر صفّاً.
    clientRequestId: varchar("clientRequestId", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    sessionStatusIdx: index("idx_stkunknown_session_status").on(
      table.sessionId,
      table.status,
    ),
    requestUq: unique("uq_stkunknown_request").on(
      table.sessionId,
      table.clientRequestId,
    ),
  }),
);

export type StocktakeUnknownScan = typeof stocktakeUnknownScans.$inferSelect;
export type InsertStocktakeUnknownScan =
  typeof stocktakeUnknownScans.$inferInsert;

/** سجل ذري append-only لكل اعتماد مرحلي أو إعادة فتح. */
export const stocktakeItemReviewEvents = mysqlTable(
  "stocktakeItemReviewEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sessionId: bigint("sessionId", { mode: "number" }).notNull(),
    variantId: bigint("variantId", { mode: "number" }).notNull(),
    action: mysqlEnum("action", ["APPROVE", "REOPEN"]).notNull(),
    snapshotOperationId: bigint("snapshotOperationId", { mode: "number" }),
    snapshotQty: int("snapshotQty"),
    snapshotHash: varchar("snapshotHash", { length: 64 }),
    reason: varchar("reason", { length: 255 }),
    actedBy: int("actedBy").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    sessionVariantCreatedIdx: index(
      "idx_stk_review_event_session_variant_created",
    ).on(table.sessionId, table.variantId, table.createdAt),
    actorCreatedIdx: index("idx_stk_review_event_actor_created").on(
      table.actedBy,
      table.createdAt,
    ),
    sessionFk: foreignKey({
      name: "fk_stk_review_event_session",
      columns: [table.sessionId],
      foreignColumns: [stocktakeSessions.id],
    }).onDelete("cascade"),
    variantFk: foreignKey({
      name: "fk_stk_review_event_variant",
      columns: [table.variantId],
      foreignColumns: [productVariants.id],
    }),
    operationFk: foreignKey({
      name: "fk_stk_review_event_operation",
      columns: [table.snapshotOperationId],
      foreignColumns: [stocktakeCountOperations.id],
    }).onDelete("set null"),
    actorFk: foreignKey({
      name: "fk_stk_review_event_actor",
      columns: [table.actedBy],
      foreignColumns: [users.id],
    }),
  }),
);

export type StocktakeItemReviewEvent =
  typeof stocktakeItemReviewEvents.$inferSelect;
export type InsertStocktakeItemReviewEvent =
  typeof stocktakeItemReviewEvents.$inferInsert;

/** قرارات المراجعة: تسوية/إبقاء + سبب الفرق (تحليل الانكماش) — تُثبَّت قيمها النهائية عند الاعتماد. */
export const stocktakeDecisions = mysqlTable(
  "stocktakeDecisions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    sessionId: bigint("sessionId", { mode: "number" })
      .notNull()
      .references(() => stocktakeSessions.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    action: mysqlEnum("action", ["ADJUST", "KEEP"]).notNull(),
    // العدّ المصحَّح النهائي بالوحدة الأساس (يُعاد حسابه داخل معاملة الاعتماد).
    finalQty: int("finalQty"),
    // الفرق المُسوّى فعلياً وقيمته بتكلفة اللقطة — تُكتب عند الاعتماد.
    diffQty: int("diffQty"),
    value: decimal("value", { precision: 15, scale: 2 }),
    reason: mysqlEnum("reason", [
      "UNSPECIFIED",
      "DAMAGE",
      "LOSS_THEFT",
      "ENTRY_ERROR",
      "PRINT_WASTE",
    ])
      .default("UNSPECIFIED")
      .notNull(),
    note: text("note"),
    // NULL + autoApplied=true ⇒ تسوية تلقائية ضمن الحد.
    decidedBy: int("decidedBy").references(() => users.id),
    autoApplied: boolean("autoApplied").default(false).notNull(),
    decidedAt: timestamp("decidedAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    sessionVariantUq: unique("uq_stkdecision_session_variant").on(
      table.sessionId,
      table.variantId,
    ),
    sessionIdx: index("idx_stkdecision_session").on(table.sessionId),
  }),
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
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    // اسم وصفي يضعه المدير («شاشة المدخل»، «كاونتر القرطاسية»…).
    label: varchar("label", { length: 120 }).notNull(),
    // sha256(token) بالست عشري — البحث يكون بالتجزئة لا بالرمز الخام.
    tokenHash: varchar("tokenHash", { length: 64 })
      .notNull()
      .unique("uq_kiosk_token_hash"),
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
  }),
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
    outputVariantId: bigint("outputVariantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    outputProductUnitId: bigint("outputProductUnitId", { mode: "number" })
      .notNull()
      .references(() => productUnits.id),
    // عمالة/تشغيل لكل وحدة ناتج أساس (اختياري) — تُضاف لكلفة المنتج، بلا قيد محاسبي منفصل.
    laborPerOutputBase: decimal("laborPerOutputBase", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    // الهدر المعياري المتوقّع في التشغيل (كسر 0–1، مثل 0.05 = 5%): يُمتَص ضمنه في كلفة الوحدة السليمة؛
    // ما يتجاوزه = هدر غير طبيعي يُسجَّل خسارة منفصلة (قيد WASTAGE) لا يضخّم كلفة السليم.
    wasteStdPct: decimal("wasteStdPct", { precision: 5, scale: 2 })
      .default("0")
      .notNull(),
    notes: text("notes"),
    isActive: boolean("isActive").default(true).notNull(),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    outputIdx: index("idx_recipe_output").on(table.outputVariantId),
    activeIdx: index("idx_recipe_active").on(table.isActive),
  }),
);

export type ProductionRecipe = typeof productionRecipes.$inferSelect;
export type InsertProductionRecipe = typeof productionRecipes.$inferInsert;

/** مكوّنات الوصفة: استهلاك بالوحدة الأساس لكل وحدة ناتج أساس واحدة (مثلاً 30 ورقة/ملزمة). */
export const productionRecipeLines = mysqlTable(
  "productionRecipeLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    recipeId: bigint("recipeId", { mode: "number" })
      .notNull()
      .references(() => productionRecipes.id, { onDelete: "cascade" }),
    inputVariantId: bigint("inputVariantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    inputProductUnitId: bigint("inputProductUnitId", {
      mode: "number",
    }).references(() => productUnits.id),
    // استهلاك بالوحدة الأساس لكل وحدة ناتج أساس واحدة (يُضرب في كمية الإنتاج Q).
    qtyPerOutputBase: decimal("qtyPerOutputBase", {
      precision: 15,
      scale: 4,
    }).notNull(),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    recipeIdx: index("idx_recipeline_recipe").on(table.recipeId),
    inputIdx: index("idx_recipeline_input").on(table.inputVariantId),
  }),
);

export type ProductionRecipeLine = typeof productionRecipeLines.$inferSelect;
export type InsertProductionRecipeLine =
  typeof productionRecipeLines.$inferInsert;

/**
 * مستند إنتاج/تحويل: يستهلك مدخلات (ورق…) ويُنتج مخرجات (دفتر/كتاب/كيس) ذرّياً.
 * **لا قيد محاسبي** (تحويل أصل↔أصل محايد)؛ القيمة محفوظة بحركتَي المخزون + WAVG على كلفة المخرَج.
 */
export const productionOrders = mysqlTable(
  "productionOrders",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    docNumber: varchar("docNumber", { length: 50 })
      .notNull()
      .unique("uq_production_docnum"),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    status: mysqlEnum("productionStatus", ["CONFIRMED", "CANCELLED"])
      .default("CONFIRMED")
      .notNull(),
    materialsCost: decimal("materialsCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    laborCost: decimal("laborCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalCost: decimal("totalCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // إنتاجية التشغيل (تُملأ بمسار «التشغيل بوصفة»؛ NULL للمستندات اليدوية/القديمة):
    // batchQty = ما بدأ التشغيل (يقود استهلاك المواد)، goodQty = batchQty − scrapQty (السليم الناتج)،
    // scrapQty = التالف الكلي، abnormalLoss = خسارة الهدر غير الطبيعي (قيد WASTAGE، لا تُمتَص في كلفة السليم).
    batchQty: int("batchQty"),
    goodQty: int("goodQty"),
    scrapQty: int("scrapQty").default(0).notNull(),
    abnormalLoss: decimal("abnormalLoss", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // لقطة الهدر المعياري وقت التشغيل (من الوصفة) — المستند ثابت فلا يتأثّر بتعديل الوصفة لاحقاً.
    wasteStdPct: decimal("wasteStdPct", { precision: 5, scale: 2 })
      .default("0")
      .notNull(),
    notes: text("notes"),
    linkedWorkOrderId: bigint("linkedWorkOrderId", {
      mode: "number",
    }).references(() => workOrders.id),
    linkedRecipeId: bigint("linkedRecipeId", { mode: "number" }).references(
      () => productionRecipes.id,
    ),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_production_number").on(table.docNumber),
    branchIdx: index("idx_production_branch").on(table.branchId),
    statusIdx: index("idx_production_status").on(table.status),
  }),
);

export type ProductionOrder = typeof productionOrders.$inferSelect;
export type InsertProductionOrder = typeof productionOrders.$inferInsert;

/** أسطر مستند الإنتاج: INPUT=مُستهلَك (حركة OUT)، OUTPUT=مُنتَج (حركة IN). الكمية الأساس عدد صحيح. */
export const productionLines = mysqlTable(
  "productionLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    productionOrderId: bigint("productionOrderId", { mode: "number" })
      .notNull()
      .references(() => productionOrders.id, { onDelete: "cascade" }),
    direction: mysqlEnum("productionLineDirection", [
      "INPUT",
      "OUTPUT",
    ]).notNull(),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(
      () => productUnits.id,
    ),
    quantity: decimal("quantity", { precision: 15, scale: 4 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    unitCost: decimal("unitCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    lineCost: decimal("lineCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
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
  }),
);

export type ProductionLine = typeof productionLines.$inferSelect;
export type InsertProductionLine = typeof productionLines.$inferInsert;

/** أصناف مصروف «صرف من المخزون» (نثرية/تلف): المُستهلَك من المخزون بكلفته (مرتبط بـexpenses.source=STOCK). */
export const expenseStockItems = mysqlTable(
  "expenseStockItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    expenseId: bigint("expenseId", { mode: "number" })
      .notNull()
      .references(() => expenses.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" }).references(
      () => productUnits.id,
    ),
    quantity: decimal("quantity", { precision: 15, scale: 4 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    unitCost: decimal("unitCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    lineCost: decimal("lineCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    expenseIdx: index("idx_expitem_expense").on(table.expenseId),
    variantIdx: index("idx_expitem_variant").on(table.variantId),
  }),
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
      "computers",
      "display",
      "furniture",
      "vehicles",
      "printing",
      "devices",
    ]).notNull(),
    brand: varchar("brand", { length: 120 }),
    serial: varchar("serial", { length: 120 }),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    location: varchar("location", { length: 255 }),

    /** الموظف صاحب العهدة الحالية (NULL = أصل عام/غير مُسلَّم). */
    custodianId: bigint("custodianId", { mode: "number" }).references(
      () => employees.id,
    ),
    supplierId: bigint("supplierId", { mode: "number" }).references(
      () => suppliers.id,
    ),

    purchaseDate: date("purchaseDate", { mode: "string" }).notNull(),
    purchaseValue: decimal("purchaseValue", {
      precision: 15,
      scale: 2,
    }).notNull(),
    salvageValue: decimal("salvageValue", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    /** العمر الإنتاجي بالسنوات. */
    usefulLifeYears: int("usefulLifeYears").notNull(),
    /** sl = القسط الثابت، db = القسط المتناقص المضاعف. */
    depreciationMethod: mysqlEnum("depreciationMethod", ["sl", "db"])
      .default("sl")
      .notNull(),
    /** FI-02: الإهلاك المتراكم المُرحَّل للدفتر — يَتتبّع computeDepreciation عبر الترحيل الشهري؛
     *  الميزانية تَقرأ NBV = purchaseValue − هذا العمود. */
    accumulatedDepreciation: decimal("accumulatedDepreciation", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),

    condition: varchar("condition", { length: 60 }),
    warrantyEnd: date("warrantyEnd", { mode: "string" }),

    status: mysqlEnum("assetStatus", [
      "active", // بالخدمة
      "maintenance", // في الصيانة
      "retired", // خارج الخدمة (بانتظار قرار)
      "disposed", // مُستبعَد (بيع/خردة)
    ])
      .default("active")
      .notNull(),

    /** الإخراج/الاستبعاد. */
    disposalDate: date("disposalDate", { mode: "string" }),
    disposalValue: decimal("disposalValue", { precision: 15, scale: 2 }),
    disposalReason: varchar("disposalReason", { length: 255 }),

    /** ربط اختياري بجهاز بصمة (kioskDevices) في وحدة الموارد البشرية. */
    linkedDeviceId: bigint("linkedDeviceId", { mode: "number" }).references(
      () => kioskDevices.id,
    ),

    /** Stable idempotency identity for the acquisition command. */
    clientRequestId: varchar("clientRequestId", { length: 64 }),
    /** SHA-256 of the canonical acquisition request; detects key reuse. */
    requestPayloadHash: char("requestPayloadHash", { length: 64 }),
    recognitionStatus: mysqlEnum("recognitionStatus", [
      "ACTIVE",
      "CORRECTION_PENDING",
      "CORRECTED",
    ])
      .default("ACTIVE")
      .notNull(),

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
    clientRequestUq: unique("uq_asset_client_req").on(t.clientRequestId),
  }),
);
export type FixedAsset = typeof fixedAssets.$inferSelect;
export type InsertFixedAsset = typeof fixedAssets.$inferInsert;

/* سلسلة العهدة — كل صفّ فترة عهدة لموظف (toDate=NULL ⇒ العهدة الجارية). */
export const assetCustodyLog = mysqlTable(
  "assetCustodyLog",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    assetId: bigint("assetId", { mode: "number" })
      .notNull()
      .references(() => fixedAssets.id),
    employeeId: bigint("employeeId", { mode: "number" })
      .notNull()
      .references(() => employees.id),
    fromDate: date("fromDate", { mode: "string" }).notNull(),
    /** NULL = العهدة الحالية (لم تُعَد بعد). */
    toDate: date("toDate", { mode: "string" }),
    note: text("note"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    assetIdx: index("idx_custody_asset").on(t.assetId),
    employeeIdx: index("idx_custody_employee").on(t.employeeId),
  }),
);
export type AssetCustody = typeof assetCustodyLog.$inferSelect;
export type InsertAssetCustody = typeof assetCustodyLog.$inferInsert;

/* سجلّ الصيانة لكل أصل + تكلفتها. */
export const assetMaintenance = mysqlTable(
  "assetMaintenance",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    assetId: bigint("assetId", { mode: "number" })
      .notNull()
      .references(() => fixedAssets.id),
    maintDate: date("maintDate", { mode: "string" }).notNull(),
    type: varchar("type", { length: 255 }).notNull(),
    vendor: varchar("vendor", { length: 255 }),
    vendorSupplierId: bigint("vendorSupplierId", { mode: "number" }),
    cost: decimal("cost", { precision: 15, scale: 2 }).default("0").notNull(),
    evidenceReference: varchar("evidenceReference", { length: 191 }),
    financialStatus: mysqlEnum("financialStatus", [
      "ACTIVE",
      "CORRECTION_PENDING",
      "CORRECTED",
    ])
      .default("ACTIVE")
      .notNull(),
    clientRequestId: varchar("clientRequestId", { length: 64 }),
    requestPayloadHash: char("requestPayloadHash", { length: 64 }),
    note: text("note"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    assetIdx: index("idx_maint_asset").on(t.assetId),
    dateIdx: index("idx_maint_date").on(t.maintDate),
    supplierIdx: index("idx_maint_supplier").on(t.vendorSupplierId),
    financialStatusIdx: index("idx_maint_fin_status").on(t.financialStatus),
    clientRequestUq: unique("uq_maint_client_req").on(t.clientRequestId),
    vendorSupplierFk: foreignKey({
      columns: [t.vendorSupplierId],
      foreignColumns: [suppliers.id],
      name: "fk_maint_vendor_supplier",
    }).onDelete("no action"),
  }),
);
export type AssetMaintenance = typeof assetMaintenance.$inferSelect;
export type InsertAssetMaintenance = typeof assetMaintenance.$inferInsert;

/**
 * Current projection of every governed expense/fixed-asset obligation.
 * Money-bearing history lives in accrualObligationEvents.
 */
export const accrualObligations = mysqlTable(
  "accrualObligations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    kind: mysqlEnum("kind", [
      "PURCHASE_SHIPPING",
      "ASSET_MAINTENANCE",
      "ASSET_ACQUISITION_CASH",
      "ASSET_ACQUISITION_SUPPLIER",
    ]).notNull(),
    branchId: bigint("branchId", { mode: "number" }).notNull(),
    expenseId: bigint("expenseId", { mode: "number" }),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" }),
    assetId: bigint("assetId", { mode: "number" }),
    maintenanceId: bigint("maintenanceId", { mode: "number" }),
    sourceKey: varchar("sourceKey", { length: 191 }).notNull(),
    recognizedAmount: decimal("recognizedAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    status: mysqlEnum("status", [
      "ACCRUED_UNPAID",
      "PAYMENT_PENDING",
      "PAYABLE_UNSETTLED",
      "PAID",
      "CORRECTION_PENDING",
      "REFUND_PENDING",
      "REFUNDED",
      "RECOGNITION_REVERSED",
    ]).notNull(),
    beneficiaryType: mysqlEnum("beneficiaryType", [
      "SUPPLIER",
      "OTHER",
    ]).notNull(),
    beneficiarySupplierId: bigint("beneficiarySupplierId", {
      mode: "number",
    }),
    beneficiaryName: varchar("beneficiaryName", { length: 200 }),
    /** Source-document reference, never a later payment reference. */
    evidenceReference: varchar("evidenceReference", { length: 191 }).notNull(),
    plannedPaymentMethod: mysqlEnum("plannedPaymentMethod", [
      "CASH",
      "CARD",
      "CHECK",
      "TRANSFER",
      "WALLET",
    ]),
    clientRequestId: varchar("clientRequestId", { length: 64 }).notNull(),
    sourceHash: char("sourceHash", { length: 64 }).notNull(),
    recognizedBy: int("recognizedBy").notNull(),
    recognizedAt: timestamp("recognizedAt").notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    sourceKeyUq: unique("uq_accrual_obligation_source").on(t.sourceKey),
    clientRequestUq: unique("uq_accrual_obligation_request").on(
      t.clientRequestId,
    ),
    branchStatusIdx: index("idx_accrual_obligation_branch_status").on(
      t.branchId,
      t.status,
    ),
    kindStatusIdx: index("idx_accrual_obligation_kind_status").on(
      t.kind,
      t.status,
    ),
    expenseIdx: index("idx_accrual_obligation_expense").on(t.expenseId),
    purchaseOrderIdx: index("idx_accrual_obligation_purchase").on(
      t.purchaseOrderId,
    ),
    assetIdx: index("idx_accrual_obligation_asset").on(t.assetId),
    maintenanceIdx: index("idx_accrual_obligation_maintenance").on(
      t.maintenanceId,
    ),
    branchFk: foreignKey({
      columns: [t.branchId],
      foreignColumns: [branches.id],
      name: "fk_acc_ob_branch",
    }).onDelete("no action"),
    expenseFk: foreignKey({
      columns: [t.expenseId],
      foreignColumns: [expenses.id],
      name: "fk_acc_ob_expense",
    }).onDelete("no action"),
    purchaseFk: foreignKey({
      columns: [t.purchaseOrderId],
      foreignColumns: [purchaseOrders.id],
      name: "fk_acc_ob_purchase",
    }).onDelete("no action"),
    assetFk: foreignKey({
      columns: [t.assetId],
      foreignColumns: [fixedAssets.id],
      name: "fk_acc_ob_asset",
    }).onDelete("no action"),
    maintenanceFk: foreignKey({
      columns: [t.maintenanceId],
      foreignColumns: [assetMaintenance.id],
      name: "fk_acc_ob_maint",
    }).onDelete("no action"),
    supplierFk: foreignKey({
      columns: [t.beneficiarySupplierId],
      foreignColumns: [suppliers.id],
      name: "fk_acc_ob_supplier",
    }).onDelete("no action"),
    recognizedByFk: foreignKey({
      columns: [t.recognizedBy],
      foreignColumns: [users.id],
      name: "fk_acc_ob_actor",
    }).onDelete("no action"),
    amountCheck: check(
      "chk_accrual_obligation_positive",
      sql`${t.recognizedAmount} > 0`,
    ),
    evidenceCheck: check(
      "chk_accrual_obligation_evidence",
      sql`CHAR_LENGTH(TRIM(${t.evidenceReference})) > 0`,
    ),
    beneficiaryCheck: check(
      "chk_accrual_obligation_beneficiary",
      sql`(
        (${t.beneficiaryType} = 'SUPPLIER' AND ${t.beneficiarySupplierId} IS NOT NULL) OR
        (${t.beneficiaryType} = 'OTHER' AND ${t.beneficiarySupplierId} IS NULL AND CHAR_LENGTH(TRIM(${t.beneficiaryName})) > 0)
      )`,
    ),
    supplierKindCheck: check(
      "chk_accrual_obligation_supplier_kind",
      sql`${t.kind} <> 'ASSET_ACQUISITION_SUPPLIER' OR ${t.beneficiaryType} = 'SUPPLIER'`,
    ),
    sourceShapeCheck: check(
      "chk_accrual_obligation_source_shape",
      sql`(
        (${t.kind} = 'PURCHASE_SHIPPING' AND ${t.expenseId} IS NOT NULL AND ${t.purchaseOrderId} IS NOT NULL AND ${t.assetId} IS NULL AND ${t.maintenanceId} IS NULL) OR
        (${t.kind} = 'ASSET_MAINTENANCE' AND ${t.expenseId} IS NOT NULL AND ${t.purchaseOrderId} IS NULL AND ${t.assetId} IS NOT NULL AND ${t.maintenanceId} IS NOT NULL) OR
        (${t.kind} IN ('ASSET_ACQUISITION_CASH','ASSET_ACQUISITION_SUPPLIER') AND ${t.expenseId} IS NULL AND ${t.purchaseOrderId} IS NULL AND ${t.assetId} IS NOT NULL AND ${t.maintenanceId} IS NULL)
      )`,
    ),
  }),
);
export type AccrualObligation = typeof accrualObligations.$inferSelect;
export type InsertAccrualObligation = typeof accrualObligations.$inferInsert;

/** Append-only monetary and audit history for an accrual obligation. */
export const accrualObligationEvents = mysqlTable(
  "accrualObligationEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    obligationId: bigint("obligationId", { mode: "number" }).notNull(),
    eventType: mysqlEnum("eventType", [
      "RECOGNIZED",
      "PAYMENT_REQUESTED",
      "PAYMENT_REJECTED",
      "PAYMENT_SETTLED",
      "CORRECTION_REQUESTED",
      "CORRECTION_REJECTED",
      "SETTLEMENT_REVERSED",
      "RECOGNITION_REVERSED",
    ]).notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    receiptId: bigint("receiptId", { mode: "number" }),
    accountingEntryId: bigint("accountingEntryId", {
      mode: "number",
    }),
    evidenceReference: varchar("evidenceReference", { length: 191 }),
    actorId: int("actorId").notNull(),
    reviewerId: int("reviewerId"),
    dedupeKey: varchar("dedupeKey", { length: 191 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    dedupeKeyUq: unique("uq_accrual_event_dedupe").on(t.dedupeKey),
    entryUq: unique("uq_accrual_event_entry").on(t.accountingEntryId),
    obligationTimeIdx: index("idx_accrual_event_obligation_time").on(
      t.obligationId,
      t.createdAt,
    ),
    receiptIdx: index("idx_accrual_event_receipt").on(t.receiptId),
    obligationFk: foreignKey({
      columns: [t.obligationId],
      foreignColumns: [accrualObligations.id],
      name: "fk_acc_evt_obligation",
    }).onDelete("no action"),
    receiptFk: foreignKey({
      columns: [t.receiptId],
      foreignColumns: [receipts.id],
      name: "fk_acc_evt_receipt",
    }).onDelete("no action"),
    entryFk: foreignKey({
      columns: [t.accountingEntryId],
      foreignColumns: [accountingEntries.id],
      name: "fk_acc_evt_entry",
    }).onDelete("no action"),
    actorFk: foreignKey({
      columns: [t.actorId],
      foreignColumns: [users.id],
      name: "fk_acc_evt_actor",
    }).onDelete("no action"),
    reviewerFk: foreignKey({
      columns: [t.reviewerId],
      foreignColumns: [users.id],
      name: "fk_acc_evt_reviewer",
    }).onDelete("no action"),
    amountCheck: check(
      "chk_accrual_event_positive_amount",
      sql`${t.amount} > 0`,
    ),
    referenceShapeCheck: check(
      "chk_accrual_event_reference_shape",
      sql`(
        (${t.eventType} IN ('RECOGNIZED','RECOGNITION_REVERSED') AND ${t.accountingEntryId} IS NOT NULL AND ${t.receiptId} IS NULL) OR
        (${t.eventType} IN ('PAYMENT_SETTLED','SETTLEMENT_REVERSED') AND ${t.accountingEntryId} IS NOT NULL AND ${t.receiptId} IS NOT NULL) OR
        (${t.eventType} IN ('PAYMENT_REQUESTED','PAYMENT_REJECTED') AND ${t.accountingEntryId} IS NULL AND ${t.receiptId} IS NOT NULL) OR
        (${t.eventType} IN ('CORRECTION_REQUESTED','CORRECTION_REJECTED') AND ${t.accountingEntryId} IS NULL AND ${t.receiptId} IS NULL)
      )`,
    ),
  }),
);
export type AccrualObligationEvent =
  typeof accrualObligationEvents.$inferSelect;
export type InsertAccrualObligationEvent =
  typeof accrualObligationEvents.$inferInsert;

/** Maker/checker request for correcting a recognized or settled obligation. */
export const accrualCorrectionRequests = mysqlTable(
  "accrualCorrectionRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    obligationId: bigint("obligationId", { mode: "number" }).notNull(),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED"])
      .default("PENDING")
      .notNull(),
    previousObligationStatus: mysqlEnum("previousObligationStatus", [
      "ACCRUED_UNPAID",
      "PAYMENT_PENDING",
      "PAYABLE_UNSETTLED",
      "PAID",
      "CORRECTION_PENDING",
      "REFUND_PENDING",
      "REFUNDED",
      "RECOGNITION_REVERSED",
    ]).notNull(),
    reason: text("reason").notNull(),
    externalEvidenceReference: varchar("externalEvidenceReference", {
      length: 191,
    }).notNull(),
    attachmentUrl: mediumtext("attachmentUrl").notNull(),
    refundPaymentMethod: mysqlEnum("refundPaymentMethod", [
      "CASH",
      "CARD",
      "CHECK",
      "TRANSFER",
      "WALLET",
    ]),
    refundCashBucket: mysqlEnum("refundCashBucket", ["DRAWER", "TREASURY"]),
    refundReferenceNumber: varchar("refundReferenceNumber", { length: 100 }),
    refundCardLastFour: char("refundCardLastFour", { length: 4 }),
    refundRequestReceiptId: bigint("refundRequestReceiptId", {
      mode: "number",
    }),
    clientRequestId: varchar("clientRequestId", { length: 64 }).notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    requestedBy: int("requestedBy").notNull(),
    reviewedBy: int("reviewedBy"),
    rejectionReason: varchar("rejectionReason", { length: 255 }),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    reviewedAt: timestamp("reviewedAt"),
  },
  (t) => ({
    clientRequestUq: unique("uq_accrual_correction_request").on(
      t.clientRequestId,
    ),
    obligationStatusIdx: index("idx_accrual_correction_obligation_status").on(
      t.obligationId,
      t.status,
    ),
    refundReceiptIdx: index("idx_accrual_correction_refund_receipt").on(
      t.refundRequestReceiptId,
    ),
    obligationFk: foreignKey({
      columns: [t.obligationId],
      foreignColumns: [accrualObligations.id],
      name: "fk_acc_corr_obligation",
    }).onDelete("no action"),
    refundReceiptFk: foreignKey({
      columns: [t.refundRequestReceiptId],
      foreignColumns: [receipts.id],
      name: "fk_acc_corr_refund_receipt",
    }).onDelete("no action"),
    requestedByFk: foreignKey({
      columns: [t.requestedBy],
      foreignColumns: [users.id],
      name: "fk_acc_corr_requested_by",
    }).onDelete("no action"),
    reviewedByFk: foreignKey({
      columns: [t.reviewedBy],
      foreignColumns: [users.id],
      name: "fk_acc_corr_reviewed_by",
    }).onDelete("no action"),
    evidenceCheck: check(
      "chk_accrual_correction_evidence",
      sql`CHAR_LENGTH(TRIM(${t.externalEvidenceReference})) > 0 AND CHAR_LENGTH(TRIM(${t.attachmentUrl})) > 0`,
    ),
    statusCheck: check(
      "chk_accrual_correction_status",
      sql`(
        (${t.status} = 'PENDING' AND ${t.reviewedBy} IS NULL AND ${t.reviewedAt} IS NULL AND ${t.rejectionReason} IS NULL) OR
        (${t.status} = 'APPROVED' AND ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL AND ${t.rejectionReason} IS NULL) OR
        (${t.status} = 'REJECTED' AND ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL AND CHAR_LENGTH(TRIM(${t.rejectionReason})) > 0)
      )`,
    ),
    makerCheckerCheck: check(
      "chk_accrual_correction_maker_checker",
      sql`${t.reviewedBy} IS NULL OR ${t.reviewedBy} <> ${t.requestedBy}`,
    ),
    refundShapeCheck: check(
      "chk_accrual_correction_refund_shape",
      sql`(
        (${t.refundPaymentMethod} IS NULL AND ${t.refundCashBucket} IS NULL AND ${t.refundReferenceNumber} IS NULL AND ${t.refundCardLastFour} IS NULL AND ${t.refundRequestReceiptId} IS NULL) OR
        (${t.refundPaymentMethod} = 'CASH' AND ${t.refundCashBucket} IS NOT NULL AND ${t.refundReferenceNumber} IS NULL AND ${t.refundCardLastFour} IS NULL) OR
        (${t.refundPaymentMethod} = 'CARD' AND ${t.refundCashBucket} IS NULL AND ${t.refundCardLastFour} REGEXP '^[0-9]{4}$') OR
        (${t.refundPaymentMethod} IN ('CHECK','TRANSFER','WALLET') AND ${t.refundCashBucket} IS NULL AND CHAR_LENGTH(TRIM(${t.refundReferenceNumber})) > 0 AND ${t.refundCardLastFour} IS NULL)
      )`,
    ),
  }),
);
export type AccrualCorrectionRequest =
  typeof accrualCorrectionRequests.$inferSelect;
export type InsertAccrualCorrectionRequest =
  typeof accrualCorrectionRequests.$inferInsert;

/* مستندات الأصل (فاتورة شراء/كفالة/محضر استبعاد…) — مفتاح S3 اختياري. */
export const assetDocuments = mysqlTable(
  "assetDocuments",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    assetId: bigint("assetId", { mode: "number" })
      .notNull()
      .references(() => fixedAssets.id),
    title: varchar("title", { length: 255 }).notNull(),
    /** مفتاح S3 — مهمَل (لا بنية S3 في هذا النظام؛ يبقى للتوافق الخلفيّ). */
    fileKey: varchar("fileKey", { length: 512 }),
    /** المستند نفسه: صورة base64 مضغوطة (data URL) — نمط productImages/receipts.attachmentUrl. */
    dataUrl: mediumtext("dataUrl"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ assetIdx: index("idx_doc_asset").on(t.assetId) }),
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
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    status: mysqlEnum("payrollStatus", [
      "draft",
      "approved",
      "paid",
      "cancelled",
    ])
      .default("draft")
      .notNull(),
    /** Immutable approval generation. Reopen increments this before re-approval. */
    revisionNo: int("revisionNo").default(0).notNull(),
    /** Civil Baghdad service-period end date used for the accrual journal. */
    accrualDate: date("accrualDate", { mode: "string" }),
    /** Accountant-approved legal inputs, frozen with the run (automatic rates remain off). */
    legalPolicySnapshot: json("legalPolicySnapshot").$type<
      Record<string, unknown>
    >(),
    legalPolicyHash: char("legalPolicyHash", { length: 64 }),
    approvalSnapshotHash: char("approvalSnapshotHash", { length: 64 }),
    employeeCount: int("employeeCount").default(0).notNull(),
    totalGross: decimal("totalGross", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalOvertime: decimal("totalOvertime", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // commissions (٦/٧/٢٦): مجموع بنود العمولة الملتقطة من تشغيلة العمولات المعتمدة لنفس الشهر
    // (totalNet يشملها أصلاً — عمود مستقل للعرض والتدقيق). هجرة 0051.
    totalCommission: decimal("totalCommission", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalDeductions: decimal("totalDeductions", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalNet: decimal("totalNet", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // ── مجاميع المكوّنات القانونية (البند ④، هجرة 0098) — للعرض/التدقيق. 0 ما لم يُفعَّل المكوّن ────
    // حصّتا الموظف (مُتضمَّنتان في totalDeductions) — عمودان مستقلّان للتفصيل.
    totalSocialSecurityEmployee: decimal("totalSocialSecurityEmployee", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    totalIncomeTax: decimal("totalIncomeTax", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // كلفة رب العمل + استحقاق نهاية الخدمة (خارج totalNet/totalDeductions — التزامات على الشركة).
    totalSocialSecurityEmployer: decimal("totalSocialSecurityEmployer", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    totalEndOfServiceAccrual: decimal("totalEndOfServiceAccrual", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    notes: text("notes"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    approvedAt: timestamp("approvedAt"),
    // SOD-01/02: مُعتمِد ودافع المسيّر — لإنفاذ «صانع≠مدقّق» وإثبات الهوية في السجلّ المالي الثابت
    // (كان الاعتماد/الدفع لا يُسجّلان مَن نفّذهما ⇒ تعذّر إثبات وجود مُعتمِد مستقلّ).
    approvedBy: int("approvedBy").references(() => users.id),
    paidBy: int("paidBy").references(() => users.id),
    paidAt: timestamp("paidAt"),
    cancelledBy: int("cancelledBy").references(() => users.id),
    cancelledAt: timestamp("cancelledAt"),
    cancelReason: varchar("cancelReason", { length: 255 }),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    // HR-PAY-01 (تدقيق ٢٠/٦/٢٦): UNIQUE(period) — نموذج «مسيّر واحد شهريّاً لكل الشركة» (قرار المالك).
    // كان (period,branchId) [G12] يُتيح مسيّراً لكل فرع بينما generatePayroll يُحمّل كل موظّفي الشركة
    // ⇒ فرعان يولّدان مسيّرين كلٌّ يدفع لكل موظّف (دفع مزدوج). التفرّد بالشهر وحده يَمنعه ذرّياً
    // (الفحص المسبق غير قافل؛ القيد الفريد هو الحارس + الراوتر يُحوّل ER_DUP_ENTRY إلى CONFLICT).
    periodUq: unique("uq_payroll_period").on(t.period),
    statusIdx: index("idx_payroll_status").on(t.status),
  }),
);
export type PayrollRun = typeof payrollRuns.$inferSelect;
export type InsertPayrollRun = typeof payrollRuns.$inferInsert;

/* بند مسيّر لكل موظف (لقطة الأجر وقت توليد المسيّر). */
export const payrollItems = mysqlTable(
  "payrollItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    runId: bigint("runId", { mode: "number" })
      .notNull()
      .references(() => payrollRuns.id),
    employeeId: bigint("employeeId", { mode: "number" })
      .notNull()
      .references(() => employees.id),
    /** Frozen at generation/approval; null means an explicitly GLOBAL legacy item. */
    branchIdSnapshot: bigint("branchIdSnapshot", { mode: "number" }).references(
      () => branches.id,
    ),
    revisionNo: int("revisionNo").default(0).notNull(),
    payType: varchar("payType", { length: 10 }).notNull(), // monthly | hourly
    hours: decimal("hours", { precision: 8, scale: 2 }),
    gross: decimal("gross", { precision: 15, scale: 2 }).default("0").notNull(),
    allowances: decimal("allowances", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    overtime: decimal("overtime", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // commissions (٦/٧/٢٦): عمولة المبيعات الملتقطة من سطر تشغيلة العمولات المعتمدة لنفس الشهر —
    // للقراءة فقط في المسيّر (تعديلها = إعادة احتساب التشغيلة قبل التوليد). net = gross + overtime
    // + commission − deductions. هجرة 0051.
    commission: decimal("commission", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    deductions: decimal("deductions", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    /** Wage-only reductions; advances and statutory withholdings stay classified below. */
    wageReduction: decimal("wageReduction", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // بند 12ج (٧/٧): جزء الاستقطاع الآتي من سلف الموظف (مُتضمَّن في deductions لا إضافة عليها) —
    // يُملأ تلقائياً عند التوليد من employeeAdvances النشطة، وعند صرف التشغيلة يُنقص أرصدتها. هجرة 0056.
    advanceDeduction: decimal("advanceDeduction", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // ── المكوّنات القانونية العراقية (البند ④، هجرة 0098) — لقطة قيمة كل مكوّن وقت التوليد ────────
    // كلها **معطَّلة افتراضياً** (payrollLegalSettings) ⇒ 0 ما لم يُفعّلها المالك ⇒ صفر انحدار.
    // حصّة الموظف من الضمان الاجتماعي (**مُتضمَّنة في deductions** ⇒ تُنقص net). هجرة 0098.
    socialSecurityEmployee: decimal("socialSecurityEmployee", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    // ضريبة الدخل المستقطعة (**مُتضمَّنة في deductions** ⇒ تُنقص net). هجرة 0098.
    incomeTax: decimal("incomeTax", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // حصّة رب العمل من الضمان الاجتماعي — **كلفة على الشركة، لا تُخصَم من الموظف** (خارج deductions/net). عرض فقط.
    socialSecurityEmployer: decimal("socialSecurityEmployer", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    // استحقاق مكافأة نهاية الخدمة المتراكم لهذا الشهر — **التزام يُعرَض، لا يُخصَم ولا يُصرَف هنا**
    // (الصرف الفعليّ عند الفصل عبر تسوية نهاية الخدمة القائمة — لا ازدواج). عرض فقط، خارج deductions/net.
    endOfServiceAccrual: decimal("endOfServiceAccrual", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    net: decimal("net", { precision: 15, scale: 2 }).default("0").notNull(),
    snapshotHash: char("snapshotHash", { length: 64 }),
    note: varchar("note", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    runIdx: index("idx_payitem_run").on(t.runId),
    empIdx: index("idx_payitem_emp").on(t.employeeId),
    branchRevisionIdx: index("idx_payitem_branch_revision").on(
      t.branchIdSnapshot,
      t.revisionNo,
    ),
    wageReductionNonnegative: check(
      "chk_payitem_wage_reduction_nonnegative",
      sql`${t.wageReduction} >= 0`,
    ),
  }),
);
export type PayrollItem = typeof payrollItems.$inferSelect;
export type InsertPayrollItem = typeof payrollItems.$inferInsert;

/**
 * Independent payroll sub-ledger. Remaining balances, not journal totals, are
 * the governing operational source for payroll liabilities.
 */
export const payrollObligations = mysqlTable(
  "payrollObligations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    runId: bigint("runId", { mode: "number" }).references(() => payrollRuns.id),
    itemId: bigint("itemId", { mode: "number" }).references(
      () => payrollItems.id,
    ),
    employeeId: bigint("employeeId", { mode: "number" }).references(
      () => employees.id,
    ),
    /** Explicit source link for end-of-service obligations (0188). */
    terminationId: bigint("terminationId", { mode: "number" }),
    /** Immutable location grain; null is the explicit GLOBAL opening/legacy grain. */
    branchIdSnapshot: bigint("branchIdSnapshot", { mode: "number" }).references(
      () => branches.id,
    ),
    revisionNo: int("revisionNo").default(0).notNull(),
    kind: mysqlEnum("payrollObligationKind", [
      "SALARY_NET",
      "INCOME_TAX",
      "SOCIAL_SECURITY",
      "EOS_PROVISION",
    ]).notNull(),
    originalAmount: decimal("originalAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    remainingAmount: decimal("remainingAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    dueDate: date("dueDate", { mode: "string" }),
    status: mysqlEnum("payrollObligationStatus", [
      "OPEN",
      "PARTIAL",
      "SETTLED",
      "REVERSED",
    ])
      .default("OPEN")
      .notNull(),
    sourceType: mysqlEnum("payrollObligationSourceType", [
      "PAYROLL_APPROVAL",
      "OPENING_CERTIFICATE",
      "TERMINATION",
    ]).notNull(),
    /** Canonical idempotency key; required even when run/item are absent at opening. */
    sourceKey: varchar("sourceKey", { length: 191 }).notNull(),
    authorityName: varchar("authorityName", { length: 200 }),
    authorityReference: varchar("authorityReference", { length: 191 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    sourceKeyUq: unique("uq_payroll_obligation_source").on(t.sourceKey),
    approvalRevisionUq: unique("uq_payroll_obligation_revision").on(
      t.runId,
      t.itemId,
      t.revisionNo,
      t.kind,
    ),
    runStatusIdx: index("idx_payroll_obligation_run_status").on(
      t.runId,
      t.revisionNo,
      t.status,
    ),
    employeeKindIdx: index("idx_payroll_obligation_employee_kind").on(
      t.employeeId,
      t.kind,
    ),
    terminationKindUq: unique("uq_payroll_obligation_termination_kind").on(
      t.terminationId,
      t.kind,
    ),
    branchKindIdx: index("idx_payroll_obligation_branch_kind").on(
      t.branchIdSnapshot,
      t.kind,
    ),
    positiveOriginal: check(
      "chk_payroll_obligation_positive_original",
      sql`${t.originalAmount} > 0`,
    ),
    remainingRange: check(
      "chk_payroll_obligation_remaining_range",
      sql`${t.remainingAmount} >= 0 AND ${t.remainingAmount} <= ${t.originalAmount}`,
    ),
    statusBalance: check(
      "chk_payroll_obligation_status_balance",
      sql`(
        (${t.status} = 'OPEN' AND ${t.remainingAmount} = ${t.originalAmount}) OR
        (${t.status} = 'PARTIAL' AND ${t.remainingAmount} > 0 AND ${t.remainingAmount} < ${t.originalAmount}) OR
        (${t.status} IN ('SETTLED','REVERSED') AND ${t.remainingAmount} = 0)
      )`,
    ),
    approvalSource: check(
      "chk_payroll_obligation_approval_source",
      sql`${t.sourceType} <> 'PAYROLL_APPROVAL' OR (${t.runId} IS NOT NULL AND ${t.itemId} IS NOT NULL)`,
    ),
  }),
);
export type PayrollObligation = typeof payrollObligations.$inferSelect;
export type InsertPayrollObligation = typeof payrollObligations.$inferInsert;

/** Maker/checker request that carries tax or social-security money to an authority. */
export const payrollRemittanceRequests = mysqlTable(
  "payrollRemittanceRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    kind: mysqlEnum("payrollRemittanceKind", [
      "INCOME_TAX",
      "SOCIAL_SECURITY",
    ]).notNull(),
    payingBranchId: bigint("payingBranchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    requestedAmount: decimal("requestedAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    authorityName: varchar("authorityName", { length: 200 }).notNull(),
    referenceNumber: varchar("referenceNumber", { length: 100 }).notNull(),
    supportingDocumentUrl: mediumtext("supportingDocumentUrl").notNull(),
    status: mysqlEnum("payrollRemittanceStatus", [
      "PENDING",
      "APPROVED",
      "PAID",
      "REJECTED",
      "REVERSED",
    ])
      .default("PENDING")
      .notNull(),
    sourceKey: varchar("sourceKey", { length: 191 }).notNull(),
    receiptId: bigint("receiptId", { mode: "number" }).references(
      () => receipts.id,
    ),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    approvedBy: int("approvedBy").references(() => users.id),
    approvedAt: timestamp("approvedAt"),
    paidBy: int("paidBy").references(() => users.id),
    paidAt: timestamp("paidAt"),
    rejectedBy: int("rejectedBy").references(() => users.id),
    rejectedAt: timestamp("rejectedAt"),
    rejectionReason: varchar("rejectionReason", { length: 255 }),
    reversedBy: int("reversedBy").references(() => users.id),
    reversedAt: timestamp("reversedAt"),
    reversalReason: varchar("reversalReason", { length: 255 }),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    sourceKeyUq: unique("uq_payroll_remittance_source").on(t.sourceKey),
    receiptUq: unique("uq_payroll_remittance_receipt").on(t.receiptId),
    statusKindIdx: index("idx_payroll_remittance_status_kind").on(
      t.status,
      t.kind,
    ),
    branchIdx: index("idx_payroll_remittance_branch").on(t.payingBranchId),
    positiveAmount: check(
      "chk_payroll_remittance_positive_amount",
      sql`${t.requestedAmount} > 0`,
    ),
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — قيدُ maker-checker السابق
    // (`chk_payroll_remittance_maker_checker`) أُسقط بالهجرة 0333؛ راجع التعليق الموازي
    // على `chk_purchase_return_request_maker_checker`.
  }),
);
export type PayrollRemittanceRequest =
  typeof payrollRemittanceRequests.$inferSelect;
export type InsertPayrollRemittanceRequest =
  typeof payrollRemittanceRequests.$inferInsert;

/** Explicit bridge between a frozen payroll event and its simplified accounting entry. */
export const payrollAccountingEvents = mysqlTable(
  "payrollAccountingEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    runId: bigint("runId", { mode: "number" }).references(() => payrollRuns.id),
    obligationId: bigint("obligationId", { mode: "number" }).references(
      () => payrollObligations.id,
    ),
    remittanceRequestId: bigint("remittanceRequestId", {
      mode: "number",
    }),
    /** End-of-service source link; deferred callback resolves the declaration cycle. */
    terminationId: bigint("terminationId", { mode: "number" }),
    branchIdSnapshot: bigint("branchIdSnapshot", { mode: "number" }).references(
      () => branches.id,
    ),
    revisionNo: int("revisionNo").default(0).notNull(),
    eventKind: mysqlEnum("payrollAccountingEventKind", [
      "ACCRUAL",
      "ACCRUAL_REVERSAL",
      "SALARY_PAYMENT",
      "SALARY_PAYMENT_RETURN",
      "TAX_REMITTANCE",
      "SOCIAL_SECURITY_REMITTANCE",
      "REMITTANCE_RETURN",
      "EOS_SETTLEMENT",
      "EOS_SETTLEMENT_REVERSAL",
    ]).notNull(),
    accountingEntryId: bigint("accountingEntryId", {
      mode: "number",
    }).notNull(),
    receiptId: bigint("receiptId", { mode: "number" }).references(
      () => receipts.id,
    ),
    reversalOfId: bigint("reversalOfId", { mode: "number" }),
    sourceKey: varchar("sourceKey", { length: 191 }).notNull(),
    sourceHash: char("sourceHash", { length: 64 }).notNull(),
    occurredAt: timestamp("occurredAt").notNull(),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    sourceKeyUq: unique("uq_payroll_accounting_event_source").on(t.sourceKey),
    accountingEntryUq: unique("uq_payroll_accounting_event_entry").on(
      t.accountingEntryId,
    ),
    reversalUq: unique("uq_payroll_event_reversal_once").on(t.reversalOfId),
    runRevisionIdx: index("idx_payroll_event_run_revision").on(
      t.runId,
      t.revisionNo,
      t.eventKind,
    ),
    obligationIdx: index("idx_payroll_event_obligation").on(t.obligationId),
    remittanceIdx: index("idx_payroll_event_remittance").on(
      t.remittanceRequestId,
    ),
    terminationIdx: index("idx_payroll_event_termination").on(t.terminationId),
    receiptIdx: index("idx_payroll_event_receipt").on(t.receiptId),
    remittanceFk: foreignKey({
      name: "fk_payroll_event_remittance",
      columns: [t.remittanceRequestId],
      foreignColumns: [payrollRemittanceRequests.id],
    }),
    accountingEntryFk: foreignKey({
      name: "fk_payroll_event_entry",
      columns: [t.accountingEntryId],
      foreignColumns: [accountingEntries.id],
    }),
    reversalFk: foreignKey({
      name: "fk_payroll_event_reversal",
      columns: [t.reversalOfId],
      foreignColumns: [t.id],
    }),
    reversalShape: check(
      "chk_payroll_event_reversal_shape",
      sql`(
        (${t.eventKind} IN ('ACCRUAL_REVERSAL','SALARY_PAYMENT_RETURN','REMITTANCE_RETURN','EOS_SETTLEMENT_REVERSAL') AND ${t.reversalOfId} IS NOT NULL) OR
        (${t.eventKind} NOT IN ('ACCRUAL_REVERSAL','SALARY_PAYMENT_RETURN','REMITTANCE_RETURN','EOS_SETTLEMENT_REVERSAL') AND ${t.reversalOfId} IS NULL)
      )`,
    ),
  }),
);
export type PayrollAccountingEvent =
  typeof payrollAccountingEvents.$inferSelect;
export type InsertPayrollAccountingEvent =
  typeof payrollAccountingEvents.$inferInsert;

/** Append-only applications and reversals against payroll obligations. */
export const payrollObligationAllocations = mysqlTable(
  "payrollObligationAllocations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    obligationId: bigint("obligationId", { mode: "number" }).notNull(),
    accountingEventId: bigint("accountingEventId", {
      mode: "number",
    }).notNull(),
    remittanceRequestId: bigint("remittanceRequestId", {
      mode: "number",
    }),
    direction: mysqlEnum("payrollAllocationDirection", ["APPLY", "REVERSE"])
      .default("APPLY")
      .notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    reversalOfId: bigint("reversalOfId", { mode: "number" }),
    sourceKey: varchar("sourceKey", { length: 191 }).notNull(),
    occurredAt: timestamp("occurredAt").notNull(),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    sourceKeyUq: unique("uq_payroll_allocation_source").on(t.sourceKey),
    obligationEventUq: unique("uq_payroll_allocation_event").on(
      t.obligationId,
      t.accountingEventId,
      t.direction,
    ),
    reversalUq: unique("uq_payroll_allocation_reversal_once").on(
      t.reversalOfId,
    ),
    obligationTimeIdx: index("idx_payroll_allocation_obligation_time").on(
      t.obligationId,
      t.occurredAt,
    ),
    remittanceIdx: index("idx_payroll_allocation_remittance").on(
      t.remittanceRequestId,
    ),
    obligationFk: foreignKey({
      name: "fk_payroll_allocation_obligation",
      columns: [t.obligationId],
      foreignColumns: [payrollObligations.id],
    }),
    accountingEventFk: foreignKey({
      name: "fk_payroll_allocation_event",
      columns: [t.accountingEventId],
      foreignColumns: [payrollAccountingEvents.id],
    }),
    remittanceFk: foreignKey({
      name: "fk_payroll_allocation_remittance",
      columns: [t.remittanceRequestId],
      foreignColumns: [payrollRemittanceRequests.id],
    }),
    reversalFk: foreignKey({
      name: "fk_payroll_allocation_reversal",
      columns: [t.reversalOfId],
      foreignColumns: [t.id],
    }),
    positiveAmount: check(
      "chk_payroll_allocation_positive_amount",
      sql`${t.amount} > 0`,
    ),
    reversalShape: check(
      "chk_payroll_allocation_reversal_shape",
      sql`(
        (${t.direction} = 'REVERSE' AND ${t.reversalOfId} IS NOT NULL) OR
        (${t.direction} = 'APPLY' AND ${t.reversalOfId} IS NULL)
      )`,
    ),
  }),
);
export type PayrollObligationAllocation =
  typeof payrollObligationAllocations.$inferSelect;
export type InsertPayrollObligationAllocation =
  typeof payrollObligationAllocations.$inferInsert;

/* ============================ الأهداف والعمولات (commissions) ============================ */

/**
 * خطة عمولات: أساس الاحتساب + نمط الشرائح. الأساس المنفَّذ NET_SALES فقط (صافي المبيعات
 * المفوترة − المرتجعات، قرار المالك ٦/٧/٢٦) — COLLECTED/PROFIT محجوزان والمحرّك يرفضهما صراحةً.
 * لا حذف صلب (أسطر التشغيلات المعتمدة والإسنادات التاريخية تُشير إليها) — تعطيل فقط.
 */
export const commissionPlans = mysqlTable(
  "commissionPlans",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    basis: mysqlEnum("commissionBasis", ["NET_SALES", "COLLECTED", "PROFIT"])
      .default("NET_SALES")
      .notNull(),
    // TARGET_PCT: عتبة الشريحة = نسبة تحقيق الهدف الشهري ٪ ؛ AMOUNT_SLAB: العتبة = صافي مبيعات بالدينار.
    tierMode: mysqlEnum("commissionTierMode", ["TARGET_PCT", "AMOUNT_SLAB"])
      .default("TARGET_PCT")
      .notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    notes: varchar("notes", { length: 255 }),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    activeIdx: index("idx_cplan_active").on(t.isActive),
  }),
);
export type CommissionPlan = typeof commissionPlans.$inferSelect;
export type InsertCommissionPlan = typeof commissionPlans.$inferInsert;

/**
 * شرائح الخطة (تصاعدية بالعتبة): بلوغ العتبة يمنح ratePct على **كامل** الأساس الفعلي + مكافأة
 * مقطوعة — لا شرائح هامشية (بساطة يفهمها الموظف). رتابة النِّسَب/المكافآت تُفرَض في الخدمة
 * (منع «بِع أكثر تربح أقل»).
 */
export const commissionPlanTiers = mysqlTable(
  "commissionPlanTiers",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    planId: bigint("planId", { mode: "number" })
      .notNull()
      .references(() => commissionPlans.id, { onDelete: "cascade" }),
    sort: int("sort").notNull(), // 0..n تصاعدياً مع threshold — يُخزَّن في لقطة السطر (tierIndex).
    threshold: decimal("threshold", { precision: 15, scale: 2 }).notNull(),
    ratePct: decimal("ratePct", { precision: 7, scale: 4 })
      .default("0")
      .notNull(),
    fixedBonus: decimal("fixedBonus", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
  },
  (t) => ({
    planSortUq: unique("uq_ctier_plan_sort").on(t.planId, t.sort),
    planThresholdUq: unique("uq_ctier_plan_threshold").on(
      t.planId,
      t.threshold,
    ),
  }),
);
export type CommissionPlanTier = typeof commissionPlanTiers.$inferSelect;
export type InsertCommissionPlanTier = typeof commissionPlanTiers.$inferInsert;

/**
 * إسناد خطة لموظف بفترات شهرية [effectiveFrom..effectiveTo] شاملةً، effectiveTo=NULL = مفتوح.
 * إسناد مفتوح واحد لكل موظف — التداخل يُمنع تطبيقياً تحت قفل FOR UPDATE على صفّ الموظف
 * (MySQL بلا قيد استبعاد مدى). يشترط employees.userId (نسبة المبيعات تتبع users.id في الدفتر).
 */
export const commissionAssignments = mysqlTable(
  "commissionAssignments",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    employeeId: bigint("employeeId", { mode: "number" })
      .notNull()
      .references(() => employees.id),
    planId: bigint("planId", { mode: "number" })
      .notNull()
      .references(() => commissionPlans.id),
    effectiveFrom: varchar("effectiveFrom", { length: 7 }).notNull(), // YYYY-MM
    effectiveTo: varchar("effectiveTo", { length: 7 }), // NULL = مفتوح
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    empFromIdx: index("idx_cassign_emp_from").on(t.employeeId, t.effectiveFrom),
    planIdx: index("idx_cassign_plan").on(t.planId),
  }),
);
export type CommissionAssignment = typeof commissionAssignments.$inferSelect;
export type InsertCommissionAssignment =
  typeof commissionAssignments.$inferInsert;

/** هدف مبيعات شهري لموظف (دينار، صافي مبيعات). هدف واحد لكل (موظف × شهر). */
export const salesTargets = mysqlTable(
  "salesTargets",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    employeeId: bigint("employeeId", { mode: "number" })
      .notNull()
      .references(() => employees.id),
    period: varchar("period", { length: 7 }).notNull(), // YYYY-MM
    targetAmount: decimal("targetAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    notes: varchar("notes", { length: 255 }),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    empPeriodUq: unique("uq_target_emp_period").on(t.employeeId, t.period),
    periodIdx: index("idx_target_period").on(t.period),
  }),
);
export type SalesTarget = typeof salesTargets.$inferSelect;
export type InsertSalesTarget = typeof salesTargets.$inferInsert;

/**
 * تشغيلة عمولات شهرية (مسودة → معتمدة) — مرآة مسيّر الرواتب: UNIQUE(period) شركةً كاملةً
 * (يطابق uq_payroll_period كي يلتقطها مسيّر الشهر نفسه)، SOD (المعتمِد ≠ المحتسِب)،
 * والدفع ليس هنا — payrollRunId يُثبَّت داخل معاملة توليد المسيّر عند الالتقاط
 * (ON DELETE SET NULL ⇒ حذف مسودة المسيّر يفكّ الربط فيُلتقط مجدداً بلا ازدواج).
 */
export const commissionRuns = mysqlTable(
  "commissionRuns",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    period: varchar("period", { length: 7 }).notNull(), // YYYY-MM
    status: mysqlEnum("commissionRunStatus", ["draft", "approved"])
      .default("draft")
      .notNull(),
    version: int("version").default(1).notNull(),
    employeeCount: int("employeeCount").default(0).notNull(),
    totalBaseSales: decimal("totalBaseSales", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalBaseReturns: decimal("totalBaseReturns", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    totalCommission: decimal("totalCommission", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    payrollRunId: bigint("payrollRunId", { mode: "number" }).references(
      () => payrollRuns.id,
      { onDelete: "set null" },
    ),
    computedAt: timestamp("computedAt").defaultNow().notNull(), // يُحدَّث عند كل إعادة احتساب.
    notes: text("notes"),
    createdBy: int("createdBy").references(() => users.id),
    approvedBy: int("approvedBy").references(() => users.id),
    approvedAt: timestamp("approvedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    periodUq: unique("uq_commission_period").on(t.period),
    statusIdx: index("idx_commission_status").on(t.status),
  }),
);
export type CommissionRun = typeof commissionRuns.$inferSelect;
export type InsertCommissionRun = typeof commissionRuns.$inferInsert;

/**
 * سطر تشغيلة لموظف — **لقطة كاملة** وقت الاحتساب (الأساس/الهدف/الشريحة/النِّسَب) لا مراجع حيّة:
 * تعديل الخطط/الأهداف لاحقاً لا يغيّر تشغيلة معتمدة. الترحيل السالب: carryOut(P) ≤ 0 يصبح
 * carryIn(P+1) — استرداد المرتجعات بلا عكس رواتب. يُكتب سطر لكل موظف مؤهَّل حتى بصفر نشاط
 * (يحفظ سلسلة الترحيل واكتمال الالتقاط في المسيّر).
 */
export const commissionRunLines = mysqlTable(
  "commissionRunLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    runId: bigint("runId", { mode: "number" })
      .notNull()
      .references(() => commissionRuns.id),
    employeeId: bigint("employeeId", { mode: "number" })
      .notNull()
      .references(() => employees.id),
    userId: int("userId").notNull(), // لقطة users.id المنسوب إليه البيع وقت الاحتساب.
    branchId: bigint("branchId", { mode: "number" }), // لقطة employees.branchId وقت الاحتساب.
    baseSales: decimal("baseSales", { precision: 15, scale: 2 })
      .default("0")
      .notNull(), // Σ SALE.revenue (موجب)
    baseReturns: decimal("baseReturns", { precision: 15, scale: 2 })
      .default("0")
      .notNull(), // Σ |RETURN.revenue| (موجب)
    // بضاعة الأمانة (ش٣، هجرة 0094): لقطة خصم حصص المودِعين من الوعاء (العمولة على الهامش فقط).
    baseConsignDeduction: decimal("baseConsignDeduction", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    carryIn: decimal("carryIn", { precision: 15, scale: 2 })
      .default("0")
      .notNull(), // موقَّع (≤ 0 من عجز سابق)
    effectiveBase: decimal("effectiveBase", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    carryOut: decimal("carryOut", { precision: 15, scale: 2 })
      .default("0")
      .notNull(), // موقَّع (≤ 0)
    targetAmount: decimal("targetAmount", { precision: 15, scale: 2 }), // لقطة؛ NULL = لا هدف لهذا الشهر.
    achievementPct: decimal("achievementPct", { precision: 9, scale: 2 }), // NULL حين لا هدف.
    planId: bigint("planId", { mode: "number" })
      .notNull()
      .references(() => commissionPlans.id), // لقطة.
    tierIndex: int("tierIndex"), // sort الشريحة المطبَّقة؛ NULL = لم تُبلَغ أي شريحة.
    ratePct: decimal("ratePct", { precision: 7, scale: 4 })
      .default("0")
      .notNull(), // لقطة.
    fixedBonus: decimal("fixedBonus", { precision: 15, scale: 2 })
      .default("0")
      .notNull(), // لقطة.
    commissionAmount: decimal("commissionAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // تفكيك للواجهة/التدقيق: {invoiceCount, returnCount, planName, tierThreshold, formula}.
    detail: json("detail"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    runEmpUq: unique("uq_cline_run_emp").on(t.runId, t.employeeId),
    empIdx: index("idx_cline_emp").on(t.employeeId),
  }),
);
export type CommissionRunLine = typeof commissionRunLines.$inferSelect;
export type InsertCommissionRunLine = typeof commissionRunLines.$inferInsert;

/* طلبات الإجازات (تخصم من رصيد الموظف عند الموافقة على المدفوعة منها). */
export const leaveRequests = mysqlTable(
  "leaveRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    employeeId: bigint("employeeId", { mode: "number" })
      .notNull()
      .references(() => employees.id),
    leaveType: varchar("leaveType", { length: 30 }).notNull(), // سنوية | مرضية | أمومة | بدون راتب
    paid: boolean("paid").default(true).notNull(),
    fromDate: date("fromDate", { mode: "string" }).notNull(),
    toDate: date("toDate", { mode: "string" }).notNull(),
    days: int("days").notNull(),
    status: mysqlEnum("leaveStatus", ["pending", "approved", "rejected"])
      .default("pending")
      .notNull(),
    reason: text("reason"),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    decidedBy: int("decidedBy").references(() => users.id),
    decidedAt: timestamp("decidedAt"),
  },
  (t) => ({
    empIdx: index("idx_leave_emp").on(t.employeeId),
    statusIdx: index("idx_leave_status").on(t.status),
  }),
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
    employmentType: varchar("employmentType", { length: 30 })
      .default("full_time")
      .notNull(),
    location: varchar("location", { length: 200 }),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
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
  (t) => ({ pubIdx: index("idx_vacancy_published").on(t.isPublished) }),
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
    // ملكية مستقرة للمتقدّم حتى عند التقديم العام أو حذف الوظيفة لاحقاً؛
    // لا تُشتق الصلاحية من vacancyId الاختياري لأنه قد يصبح NULL.
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
      { onDelete: "set null" },
    ),
    // ربط اختياري بالوظيفة الشاغرة التي قدّم المتقدّم عليها (إن قدّم عبر بطاقة في المعرض).
    vacancyId: bigint("vacancyId", { mode: "number" }).references(
      () => jobVacancies.id,
    ),
    source: varchar("source", { length: 20 }).default("external").notNull(), // external | paper | archive
    stage: mysqlEnum("applicantStage", [
      "new",
      "review",
      "interview",
      "accepted",
      "rejected",
      "archived",
    ])
      .default("new")
      .notNull(),
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
  (t) => ({
    stageIdx: index("idx_applicant_stage").on(t.stage),
    branchIdx: index("idx_applicant_branch").on(t.branchId, t.createdAt),
  }),
);
export type JobApplicant = typeof jobApplicants.$inferSelect;
export type InsertJobApplicant = typeof jobApplicants.$inferInsert;

/**
 * CV bytes are isolated from applicant list queries so normal HR screens never
 * pull multi-megabyte blobs. `publicKey` is random and non-sequential; download
 * still requires an authenticated HR reader and vacancy-branch authorization.
 */
export const jobApplicantCvFiles = mysqlTable(
  "jobApplicantCvFiles",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    applicantId: bigint("applicantId", { mode: "number" })
      .notNull()
      .references(() => jobApplicants.id, { onDelete: "cascade" }),
    publicKey: char("publicKey", { length: 43 }).notNull(),
    fileName: varchar("fileName", { length: 180 }).notNull(),
    mimeType: varchar("mimeType", { length: 100 }).notNull(),
    sizeBytes: int("sizeBytes").notNull(),
    bytes: mediumblob("bytes").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    applicantUnique: unique("uq_jobApplicantCv_applicant").on(t.applicantId),
    publicKeyUnique: unique("uq_jobApplicantCv_publicKey").on(t.publicKey),
  }),
);
export type JobApplicantCvFile = typeof jobApplicantCvFiles.$inferSelect;
export type InsertJobApplicantCvFile = typeof jobApplicantCvFiles.$inferInsert;

/* أجهزة البصمة (الموارد البشرية) + شاشة الهجرة من المزوّد المدفوع إلى خادم الرؤية. */
/**
 * إعدادات احتساب الحضور (صفّ مفرد id=1) — 0137.
 * الوردية الليلية العابرة منتصف الليل نادرة في المطبعة (قرار مالك) ⇒ **معطَّلة افتراضياً**:
 * تفعيلها يجعل بصمة الفجر تُغلق وردية أمس بدل أن تفتح يوماً جديداً بصفر ساعات.
 */
export const hrAttendanceSettings = mysqlTable("hrAttendanceSettings", {
  id: int("id").primaryKey().default(1),
  /**
   * سقف الساعات المعقولة لليوم (0139): «لا توجد ساعات عمل ٢٠ ولا ١٨ ولا حتى ١٦» (قرار
   * المالك). يومٌ يتجاوزه يُقصّ عنده ويُوسَم «يحتاج تصحيح» — بصمةٌ منسيّة أو خللُ ساعةٍ
   * في الجهاز يُنتج فترةً وهمية تُدفَع أجرَ عملٍ لم يقع.
   */
  maxDailyHours: decimal("maxDailyHours", { precision: 5, scale: 2 })
    .default("12.00")
    .notNull(),
  /**
   * الأجر بالحضور (0138) — قرار مالك: «الذي يحضر له راتب، والذي غاب لا راتب لغيابه»،
   * والاحتساب **بالساعات**: سعر ساعة الشهريّ = راتبه ÷ ساعات دوامه في الشهر،
   * وأجرُه = ساعات حضوره الفعلية × ذلك السعر.
   * **معطَّل افتراضياً**: تفعيله بأثرٍ رجعيّ قبل تشغيل الجهاز يُظهر الجميع غائبين
   * ويُصفّر رواتبهم — لذا يلزمه تاريخُ سريانٍ صريح ولا يُخصَم قبله إطلاقاً.
   */
  attendancePayEnabled: boolean("attendancePayEnabled")
    .default(false)
    .notNull(),
  attendancePayFrom: date("attendancePayFrom", { mode: "string" }),
  /**
   * الوردية الليلية العابرة منتصف الليل (0185) — **معطَّلة افتراضياً** (قرار مالك: نادرة
   * في المطبعة). كان هذا المفتاح موصوفاً في تعليقات المخطط والخدمة والموجّه والواجهة
   * **بلا عمودٍ ولا تنفيذ** — أي ميزةٌ موثَّقة معدومة (تدقيق ١٧/٨): وردية 22:00→06:00
   * تُسجَّل يومين ببصمةٍ واحدة لكلٍّ ⇒ صفر ساعات وصفر أجر لليلة عملٍ كاملة.
   *
   * تغييرُه **لا يعيد حساب الماضي** — الأيام المطويّة تبقى كما هي؛ وما يصل بعده يُحتسب
   * بالسياسة الجديدة (مسيّرات سابقة قد تكون بُنيت على الأرقام القديمة).
   */
  nightShiftEnabled: boolean("nightShiftEnabled").default(false).notNull(),
  /** ساعةُ الفصل (0-23): بصمةٌ قبلها تُغلق وردية اليوم السابق ولا تفتح يوماً جديداً. */
  nightShiftCutoffHour: int("nightShiftCutoffHour").default(8).notNull(),
  updatedBy: int("updatedBy").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type HrAttendanceSettings = typeof hrAttendanceSettings.$inferSelect;

export const hrFingerprintDevices = mysqlTable(
  "hrFingerprintDevices",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    model: varchar("model", { length: 120 }),
    location: varchar("location", { length: 200 }),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
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
    /* —— مزامنة حقيقية (0089) —— */
    /** الرقم التسلسلي الفعلي الذي يعرّف الجهاز نفسه به في المصافحة (SN) — مفتاح التوثيق الوحيد. */
    serialNumber: varchar("serialNumber", { length: 64 }),
    /** بروتوكول الجهاز: AIFACE_WS (عائلة AI518/AiFace — WebSocket JSON) | ZKTECO_PUSH (iclock HTTP). */
    protocol: varchar("protocol", { length: 20 })
      .default("AIFACE_WS")
      .notNull(),
    /** بوابة القبول: جهاز مجهول SN يُسجَّل تلقائياً معطَّلاً ولا تُقبل بصماته حتى يعتمده مدير. */
    enabled: boolean("enabled").default(true).notNull(),
    /** آخر إشارة حياة (مصافحة/نبض/دفعة) — مصدر حالة متصل/منقطع الحقيقية في الشاشة. */
    lastSeenAt: timestamp("lastSeenAt"),
    lastHandshakeAt: timestamp("lastHandshakeAt"),
    /** آخر بصمة مستلمة (توقيت الجهاز المحلي كنص). */
    lastPunchAt: datetime("lastPunchAt", { mode: "string" }),
    /** ما أبلغه الجهاز عن نفسه في المصافحة (موديل/عدادات/فيرموير) — عرضٌ صادق بدل الإدخال اليدوي. */
    devInfo: json("devInfo"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    migratedIdx: index("idx_fpdev_migrated").on(t.migrated),
    // تفرّد SN على القيم الفعلية فقط (NULL متعدد مسموح للصفوف اليدوية القديمة).
    serialUq: unique("uq_fpdev_serial").on(t.serialNumber),
  }),
);
export type HrFingerprintDevice = typeof hrFingerprintDevices.$inferSelect;
export type InsertHrFingerprintDevice =
  typeof hrFingerprintDevices.$inferInsert;

/**
 * محاولات الاتصال الواردة من **مصدر (عنوان) غير موثوق** — أساس مبدأ «العنوان يُتعلَّم لا يُكتَب».
 *
 * سبب الوجود (عطل ١١/٨/٢٦): مزوّد الإنترنت يغيّر عنوان المتجر العامّ دورياً (‎.9.235 ⇒ ‎.10.138
 * ⇒ ‎.10.103)، فتصدّ بوّابتا الأمان الجهازَ **بصمت**؛ ولأنّ العنوان الموثوق مكتوبٌ يدوياً في
 * مكانين (‎.env بلا شاشة + عمود ip بلا شاشة) كان التعافي يتطلّب SSH. هذا الجدول يحوّل المحاولة
 * المرفوضة من سطرِ سجلٍّ يُدفن إلى **واقعةٍ مرئية قابلة للحسم**: تُعتمَد تلقائياً متى عزّزتها
 * جلسةُ موظّفٍ مُصادَقٍ من العنوان نفسه (نفس حدّ الثقة، مُحدَّثاً بدل أن يتعفّن)، وإلّا ظهرت
 * في الشاشة لاعتمادٍ بنقرة.
 *
 * القيد الفريد (serialNumber, ip) = صفٌّ واحد لكلّ مصدر مهما تكرّرت المحاولات — الجهاز يقرع
 * كلّ ~٢٠٠م.ث عند الرفض، فلولاه لأُغرق الجدول بآلاف الصفوف في ساعة.
 */
export const hrDeviceOriginAttempts = mysqlTable(
  "hrDeviceOriginAttempts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** الجهاز المطابق للرقم التسلسلي إن وُجد (null = رقم تسلسليّ مجهول تماماً). */
    deviceId: bigint("deviceId", { mode: "number" }).references(
      () => hrFingerprintDevices.id,
    ),
    serialNumber: varchar("serialNumber", { length: 64 }).notNull(),
    ip: varchar("ip", { length: 64 }).notNull(),
    /** قرار البوّابة وقت آخر محاولة: IP_MISMATCH | UNBOUND | NETWORK_BLOCKED | SERIAL_MISMATCH… */
    decision: varchar("decision", { length: 32 }).notNull(),
    attemptCount: int("attemptCount").default(1).notNull(),
    firstSeenAt: timestamp("firstSeenAt").defaultNow().notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
    /** null = معلّقة تنتظر قراراً؛ غير null = حُسمت (اعتماداً أو صرفاً). */
    resolvedAt: timestamp("resolvedAt"),
    /** AUTO = اعتُمد بقرينة جلسة مُصادَقة · MANUAL = اعتمده مدير من الشاشة · DISMISSED = صُرف. */
    resolution: varchar("resolution", { length: 16 }),
    resolvedBy: int("resolvedBy").references(() => users.id),
  },
  (t) => ({
    originUq: unique("uq_hr_origin_sn_ip").on(t.serialNumber, t.ip),
    pendingIdx: index("idx_hr_origin_pending").on(t.resolvedAt, t.lastSeenAt),
  }),
);
export type HrDeviceOriginAttempt = typeof hrDeviceOriginAttempts.$inferSelect;

/**
 * البصمات الخام كما وصلت من الأجهزة — «التخزين الخام أولاً»: لا تضيع بصمة أبداً ولا تتكرّر.
 * القيد الفريد (serialNumber, enrollId, punchAt) = idempotency: الجهاز يعيد دفع سجلاته
 * بعد كل انقطاع، والإدراج المكرَّر يُهمَل بصمت (نمط uq_invoice_source في المبيعات).
 * punchAt توقيت حائط محلي من ساعة الجهاز (datetime نصي — لا تحويل مناطق زمنية، §businessDay).
 */
export const hrAttendancePunches = mysqlTable(
  "hrAttendancePunches",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    deviceId: bigint("deviceId", { mode: "number" }).references(
      () => hrFingerprintDevices.id,
    ),
    serialNumber: varchar("serialNumber", { length: 64 }).notNull(),
    /** رقم المستخدم داخل الجهاز (enrollid/PIN) — يُحلّ إلى موظف عبر hrDeviceUsers.employeeId. */
    enrollId: int("enrollId").notNull(),
    punchAt: datetime("punchAt", { mode: "string" }).notNull(),
    /** وسيلة التحقق كما أبلغها الجهاز: face | card | pwd | fp | غيرها. */
    mode: varchar("mode", { length: 12 }),
    /** اتجاه التسجيل إن أبلغه الجهاز: in | out (كثير من الأجهزة لا تفرّق — تبقى null). */
    inOut: varchar("inOut", { length: 8 }),
    /** الموظف المحلول لحظة الاستلام (null = غير مربوط ⇒ طابور مراجعة، لا يُرمى). */
    employeeId: bigint("employeeId", { mode: "number" }).references(
      () => employees.id,
    ),
    /** لحظة الطيّ في سجل attendance (null = بانتظار المعالجة). */
    processedAt: timestamp("processedAt"),
    /** سبب تعذّر الطيّ إن حدث (موظف منتهي الخدمة، غير مربوط...) — تشخيص لا تخمين. */
    processNote: varchar("processNote", { length: 200 }),
    /** الحمولة الأصلية كما وصلت (تشخيص/إعادة معالجة عند تحسين السائقين). */
    raw: json("raw"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    punchUq: unique("uq_punch_sn_enroll_time").on(
      t.serialNumber,
      t.enrollId,
      t.punchAt,
    ),
    unprocessedIdx: index("idx_punch_unprocessed").on(t.processedAt),
    employeeDateIdx: index("idx_punch_employee_time").on(
      t.employeeId,
      t.punchAt,
    ),
    deviceIdx: index("idx_punch_device").on(t.deviceId),
  }),
);
export type HrAttendancePunch = typeof hrAttendancePunches.$inferSelect;

/**
 * مرآة مستخدمي كل جهاز + نسخة احتياطية من قوالبهم (وجه/بصمة/بطاقة) + الربط بالموظف.
 * الربط (deviceId, enrollId) → employeeId هو مصدر حقيقة تحويل البصمة إلى حضور،
 * والنسخة الاحتياطية للقوالب تعني: جهاز تالف ⇒ جهاز جديد + دفع القوالب إليه، لا إعادة تسجيل أحد.
 */
export const hrDeviceUsers = mysqlTable(
  "hrDeviceUsers",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    deviceId: bigint("deviceId", { mode: "number" })
      .notNull()
      .references(() => hrFingerprintDevices.id),
    enrollId: int("enrollId").notNull(),
    /** الاسم كما هو مخزّن في الجهاز (قد يختلف عن اسم الموظف الرسمي). */
    name: varchar("name", { length: 120 }),
    isAdmin: boolean("isAdmin").default(false).notNull(),
    cardNo: varchar("cardNo", { length: 40 }),
    /** قوالب التحقق المسحوبة احتياطياً: { "<backupnum>": record } — وجه/بصمة/كلمة مرور. */
    backupData: json("backupData"),
    /** الموظف المربوط — التحويل بصمة→حضور يمرّ حصراً من هنا. */
    employeeId: bigint("employeeId", { mode: "number" }).references(
      () => employees.id,
    ),
    /**
     * سريان الربط: لا تُنسَب للموظف أيّ بصمة أقدم من هذا التاريخ (0136).
     * ضروري لأن أرقام الأجهزة تُعاد استعمالها — رقم ٧ كان لموظف غادر ثم أُعطي لموظف جديد،
     * وبلا هذا الحدّ كان سحب تاريخ الجهاز (getalllog) ينسب حضور السابق للاحق فيدخل راتبه.
     * null = بلا حدّ (سلوك ما قبل 0136 — يُستعمل فقط حين لا يُعرف تاريخ المباشرة).
     */
    effectiveFrom: date("effectiveFrom", { mode: "string" }),
    /**
     * انتهاء سريان الربط (0207) — **مرآةُ `effectiveFrom`، والطرفُ الذي كان مفقوداً**.
     *
     * كان إنهاءُ الخدمة يُصفّر `employeeId` **فوراً** أياً كان تاريخ الإنهاء، وهو الطبيعيّ أن
     * يقع يومَ العمل الأخير نفسه ⇒ بصماتُ ذلك اليوم تصل بلا صاحبٍ فتُسجَّل **صفر ساعات**،
     * ولا أحد يلاحظ لأن أجر شهر الفصل يُكتب يدوياً في تسوية نهاية الخدمة (تدقيق ١٧/٨، بند ٢١).
     *
     * فبدل قطع الربط، يُحدّ: تُنسَب البصمات حتى هذا التاريخ **شاملاً**، وما بعده لا يُنسَب —
     * فيُحفظ اليوم الأخير ويبقى الحارسُ ضدّ إعادة استعمال رقم الجهاز قائماً.
     * null = ربطٌ سارٍ بلا نهاية (الحالة الطبيعية لموظفٍ على رأس العمل).
     */
    effectiveTo: date("effectiveTo", { mode: "string" }),
    syncedAt: timestamp("syncedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    deviceEnrollUq: unique("uq_devuser_device_enroll").on(
      t.deviceId,
      t.enrollId,
    ),
    // 0136: تقابل أحاديّ لكل جهاز — موظفٌ واحد لكل رقم (uq أعلاه) ورقمٌ واحد لكل موظف (هنا).
    // بدونه يُربط الموظف برقمين على الجهاز نفسه ⇒ الطيّ يُنتج يومَي حضور منفصلين لنفس الشخص
    // فتتضاعف ساعاته في مسيّر الرواتب. تعدّد NULL مسموح ⇒ صفوف غير مربوطة لا تتأثر.
    deviceEmployeeUq: unique("uq_devuser_device_employee").on(
      t.deviceId,
      t.employeeId,
    ),
    employeeIdx: index("idx_devuser_employee").on(t.employeeId),
  }),
);
export type HrDeviceUser = typeof hrDeviceUsers.$inferSelect;

/**
 * طابور أوامر الخادم→الجهاز (مزامنة وقت، سحب السجل الكامل، سحب/دفع مستخدمين، إعادة تشغيل).
 * الجهاز عميلٌ يبادر بالاتصال (خلف NAT) ⇒ الأوامر تُصفّ هنا وتُدفع إليه لحظة اتصاله/نبضه.
 */
export const hrDeviceCommands = mysqlTable(
  "hrDeviceCommands",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    deviceId: bigint("deviceId", { mode: "number" })
      .notNull()
      .references(() => hrFingerprintDevices.id),
    cmd: varchar("cmd", { length: 30 }).notNull(),
    payload: json("payload"),
    status: mysqlEnum("status", ["queued", "sent", "done", "failed"])
      .default("queued")
      .notNull(),
    result: json("result"),
    error: text("error"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    sentAt: timestamp("sentAt"),
    doneAt: timestamp("doneAt"),
  },
  (t) => ({
    deviceStatusIdx: index("idx_devcmd_device_status").on(t.deviceId, t.status),
  }),
);
export type HrDeviceCommand = typeof hrDeviceCommands.$inferSelect;

/* الترقيات (اعتمادها يحدّث مسمّى/راتب الموظف). */
export const employeePromotions = mysqlTable(
  "employeePromotions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    employeeId: bigint("employeeId", { mode: "number" })
      .notNull()
      .references(() => employees.id),
    fromTitle: varchar("fromTitle", { length: 150 }),
    toTitle: varchar("toTitle", { length: 150 }).notNull(),
    fromSalary: decimal("fromSalary", { precision: 15, scale: 2 }),
    toSalary: decimal("toSalary", { precision: 15, scale: 2 }),
    effectiveDate: date("effectiveDate", { mode: "string" }).notNull(),
    reason: varchar("reason", { length: 255 }),
    status: mysqlEnum("promotionStatus", ["pending", "approved"])
      .default("pending")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    approvedAt: timestamp("approvedAt"),
    approvedBy: int("approvedBy").references(() => users.id),
    // SOD (تدقيق ١٧/٧): مُنشئ الترقية لفرض «المعتمِد ≠ المُنشئ»؛ appliedAt يميّز المطبَّقة على راتب
    // الموظف عن المؤجَّلة (effectiveDate مستقبليّ) التي تُطبَّق عند بلوغ تاريخها.
    createdBy: int("createdBy").references(() => users.id),
    appliedAt: timestamp("appliedAt"),
    // حزمة الأجر (0143): البصمة الأجرية الكاملة قبل/بعد — الراتب والبدلات وجدول الدوام
    // وأسعار الأيام والإعفاء وطريقة الأجر. كانت الترقية تحمل الراتب وحده، فبقيت بقيةُ
    // الحقول الحاملة للأجر بلا مسارِ تغييرٍ مزدوج الاعتماد. `toWage` هو **الهدف كاملاً**
    // لا رقعةً جزئية ⇒ تطبيقُه عند الاعتماد قطعيٌّ لا يحتاج دمجاً بحالةٍ تغيّرت بينهما.
    fromWage: json("fromWage"),
    toWage: json("toWage"),
  },
  (t) => ({ empIdx: index("idx_promo_emp").on(t.employeeId) }),
);
export type EmployeePromotion = typeof employeePromotions.$inferSelect;
export type InsertEmployeePromotion = typeof employeePromotions.$inferInsert;

/* إنهاء الخدمات (إكماله يضع الموظف «منتهي الخدمة» + تاريخ + تسوية). */
export const employeeTerminations = mysqlTable(
  "employeeTerminations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    employeeId: bigint("employeeId", { mode: "number" })
      .notNull()
      .references(() => employees.id),
    terminationType: varchar("terminationType", { length: 30 }).notNull(), // انتهاء عقد | استقالة | فصل
    lastDay: date("lastDay", { mode: "string" }).notNull(),
    settlement: decimal("settlement", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // 0190: gross-to-net values are explicit human-approved inputs; no legal
    // rate is inferred. settlement remains the server-derived cash payout.
    earnedGrossWages: decimal("earnedGrossWages", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    wageReductions: decimal("wageReductions", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    advanceRecovery: decimal("advanceRecovery", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    /** Immutable active-advance balance immediately after recognition; bound into settlementSnapshotHash. */
    remainingAdvanceAtRecognition: decimal("remainingAdvanceAtRecognition", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    incomeTax: decimal("incomeTax", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    employeeSocialSecurity: decimal("employeeSocialSecurity", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    employerSocialSecurity: decimal("employerSocialSecurity", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    leaveCompensation: decimal("leaveCompensation", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    noticeCompensation: decimal("noticeCompensation", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    eosBenefit: decimal("eosBenefit", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    otherSettlement: decimal("otherSettlement", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    otherSettlementLabel: varchar("otherSettlementLabel", { length: 120 }),
    settlementEvidenceNote: varchar("settlementEvidenceNote", {
      length: 500,
    }).notNull(),
    zeroAmountsAttested: boolean("zeroAmountsAttested")
      .default(false)
      .notNull(),
    settlementPaymentMethod: varchar("settlementPaymentMethod", { length: 20 })
      .default("CASH")
      .notNull(),
    settlementPaymentReference: varchar("settlementPaymentReference", {
      length: 120,
    }),
    settlementSnapshotHash: char("settlementSnapshotHash", { length: 64 }),
    // Frozen provision split at recognition: used for the award, released surplus, and expensed shortfall.
    eosProvisionAvailable: decimal("eosProvisionAvailable", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    eosProvisionConsumed: decimal("eosProvisionConsumed", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    eosProvisionReleased: decimal("eosProvisionReleased", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    eosExpenseRecognized: decimal("eosExpenseRecognized", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    reason: varchar("reason", { length: 255 }),
    status: mysqlEnum("terminationStatus", ["pending", "completed"])
      .default("pending")
      .notNull(),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    recognizedAt: timestamp("recognizedAt"),
    recognizedBy: int("recognizedBy").references(() => users.id),
    recognitionEventId: bigint("recognitionEventId", { mode: "number" }),
    paymentReversedAt: timestamp("paymentReversedAt"),
    paymentReversedBy: int("paymentReversedBy").references(() => users.id),
    paymentReversalReason: varchar("paymentReversalReason", { length: 255 }),
    recognitionReversedAt: timestamp("recognitionReversedAt"),
    recognitionReversedBy: int("recognitionReversedBy").references(
      () => users.id,
    ),
    recognitionReversalReason: varchar("recognitionReversalReason", {
      length: 255,
    }),
    recognitionReversalEventId: bigint("recognitionReversalEventId", {
      mode: "number",
    }),
  },
  (t) => ({
    empIdx: index("idx_term_emp").on(t.employeeId),
    recognitionIdx: index("idx_term_recognition").on(t.status, t.recognizedAt),
    grossToNetNonnegative: check(
      "chk_term_gross_net_nonnegative",
      sql`${t.earnedGrossWages} >= 0 AND ${t.wageReductions} >= 0 AND ${t.advanceRecovery} >= 0 AND ${t.incomeTax} >= 0 AND ${t.employeeSocialSecurity} >= 0 AND ${t.employerSocialSecurity} >= 0`,
    ),
    earnedNetNonnegative: check(
      "chk_term_earned_net_nonnegative",
      sql`${t.earnedGrossWages} >= ${t.wageReductions} + ${t.advanceRecovery} + ${t.incomeTax} + ${t.employeeSocialSecurity}`,
    ),
    advanceSnapshotNonnegative: check(
      "chk_term_advance_snapshot_nonnegative",
      sql`${t.remainingAdvanceAtRecognition} >= 0`,
    ),
    payoutDerived: check(
      "chk_term_payout_derived",
      sql`${t.settlement} = ${t.earnedGrossWages} - ${t.wageReductions} - ${t.advanceRecovery} - ${t.incomeTax} - ${t.employeeSocialSecurity} + ${t.leaveCompensation} + ${t.noticeCompensation} + ${t.eosBenefit} + ${t.otherSettlement}`,
    ),
    evidenceAttested: check(
      "chk_term_evidence_attested",
      sql`${t.zeroAmountsAttested} = 1 AND CHAR_LENGTH(TRIM(${t.settlementEvidenceNote})) >= 10`,
    ),
    recognitionMakerChecker: check(
      "chk_term_recognition_maker_checker",
      sql`${t.recognizedBy} IS NULL OR ${t.createdBy} IS NULL OR ${t.recognizedBy} <> ${t.createdBy}`,
    ),
    recognitionLifecycle: check(
      "chk_term_recognition_lifecycle",
      sql`(
        (${t.recognizedAt} IS NULL AND ${t.recognizedBy} IS NULL AND ${t.settlementSnapshotHash} IS NULL AND ${t.recognitionEventId} IS NULL) OR
        (${t.recognizedAt} IS NOT NULL AND ${t.recognizedBy} IS NOT NULL AND ${t.settlementSnapshotHash} IS NOT NULL)
      )`,
    ),
    paymentReversalLifecycle: check(
      "chk_term_payment_reversal_lifecycle",
      sql`(
        (${t.paymentReversedAt} IS NULL AND ${t.paymentReversedBy} IS NULL AND ${t.paymentReversalReason} IS NULL) OR
        (${t.paymentReversedAt} IS NOT NULL AND ${t.paymentReversedBy} IS NOT NULL AND CHAR_LENGTH(TRIM(${t.paymentReversalReason})) >= 5)
      )`,
    ),
    recognitionReversalLifecycle: check(
      "chk_term_recognition_reversal_lifecycle",
      sql`(
        (${t.recognitionReversedAt} IS NULL AND ${t.recognitionReversedBy} IS NULL AND ${t.recognitionReversalReason} IS NULL AND ${t.recognitionReversalEventId} IS NULL) OR
        (${t.recognitionReversedAt} IS NOT NULL AND ${t.recognitionReversedBy} IS NOT NULL AND CHAR_LENGTH(TRIM(${t.recognitionReversalReason})) >= 5 AND ${t.recognitionReversalEventId} IS NOT NULL)
      )`,
    ),
  }),
);
export type EmployeeTermination = typeof employeeTerminations.$inferSelect;
export type InsertEmployeeTermination =
  typeof employeeTerminations.$inferInsert;

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
    status: mysqlEnum("periodStatus", ["LOCKED", "ARCHIVED"])
      .default("LOCKED")
      .notNull(),
    notes: varchar("notes", { length: 255 }),
    lockedBy: int("lockedBy")
      .notNull()
      .references(() => users.id),
    lockedAt: timestamp("lockedAt").defaultNow().notNull(),
    /** Month-close identity. Legacy rows stay null until explicit owner bootstrap. */
    closeMonth: varchar("closeMonth", { length: 7 }),
    closeRevision: int("closeRevision"),
    predecessorPeriodId: bigint("predecessorPeriodId", {
      mode: "number",
    }),
  },
  (t) => ({
    cutoffIdx: index("idx_period_cutoff").on(t.cutoffDate),
    statusIdx: index("idx_period_status").on(t.status),
    closeRevisionUq: unique("uq_period_close_revision").on(
      t.closeMonth,
      t.closeRevision,
    ),
    predecessorFk: foreignKey({
      name: "fk_period_predecessor",
      columns: [t.predecessorPeriodId],
      foreignColumns: [t.id],
    }),
    closeIdentityCheck: check(
      "chk_period_close_identity",
      sql`(
        (${t.closeMonth} IS NULL AND ${t.closeRevision} IS NULL) OR
        (${t.closeMonth} REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$' AND ${t.closeRevision} > 0
          AND DATE_FORMAT(LAST_DAY(${t.cutoffDate}),'%Y-%m') = ${t.closeMonth})
      )`,
    ),
  }),
);
export type FinancialPeriod = typeof financialPeriods.$inferSelect;
export type InsertFinancialPeriod = typeof financialPeriods.$inferInsert;

/**
 * لقطاتُ تقييم المخزون عند إقفال الفترة (P1-#2، ٢٥/٨).
 *
 * أصل المخزون في الميزانية يُقرأ **حيّاً** (`SUM(quantity × costPrice)` + الحمل بالطريق) —
 * حركةٌ واحدة بعد إقفال الشهر تُغيّر ميزانيةَ الشهر المُقفَل بأثرٍ رجعيّ، فينحرف عن الأرباح
 * المُرحَّلة، ولا يبقى للميزانية المقفلة أصلٌ يُعاد إنتاجه.
 *
 * الحلّ: `readInventoryValuation` يُلتقط في نفس معاملة `approveMonthClose` (وأيضاً في
 * `yearEnd` لاتّساقٍ زمنيّ). صفٌّ لكل (فترة × نطاق) — «COMPANY» للشركة، أو `branchId` لفرعٍ
 * بعينه لاحقاً. الأعمدةُ الثلاثة `totalValue`/`stockValue`/`inTransitValue` تفتح تقاريرَ
 * ميزانيةٍ مرجعيّةً حسب التاريخ بلا إعادة حساب من مخزون اليوم.
 *
 * ⚠️ **غيرُ قابلٍ للتعديل** بعد الكتابة: أيّ تصحيحٍ يستلزم إلغاءَ إقفال الفترة (revision جديد)
 * ⇒ لقطةٌ جديدة تُنسَخ للفترة الجديدة. الصفّ يبقى للسجلّ التدقيقيّ.
 */
export const inventoryValuationSnapshots = mysqlTable(
  "inventoryValuationSnapshots",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** الفترةُ المُقفَلة التي التُقطت اللقطةُ لها. NULL مسموحٌ للقطاتٍ ad-hoc خارج الإقفال (شريحة لاحقة). */
    periodLockId: bigint("periodLockId", { mode: "number" }).references(
      () => financialPeriods.id,
    ),
    /** تاريخُ الأصل الذي تُمثِّله اللقطة (نهاية الفترة عادةً). */
    cutoffDate: date("cutoffDate", { mode: "string" }).notNull(),
    /** لحظة الالتقاط الفعليّة (قد تختلف عن cutoffDate — الالتقاطُ في وقت الاعتماد). */
    capturedAt: timestamp("capturedAt").defaultNow().notNull(),
    /** المُعتمِد (هو الذي شغّل الالتقاط). */
    capturedBy: int("capturedBy")
      .notNull()
      .references(() => users.id),
    /** نطاقُ اللقطة: COMPANY = مجمَّع؛ BRANCH = مقيَّد بـbranchId. */
    scopeKey: mysqlEnum("scopeKey", ["COMPANY", "BRANCH"])
      .default("COMPANY")
      .notNull(),
    /** فرعٌ محدَّد للنطاق BRANCH؛ NULL للنطاق COMPANY. */
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    /** إجمالي التقييم = المستقرّ + بالطريق. الرقمُ الذي يدخل الميزانية. */
    totalValue: decimal("totalValue", { precision: 15, scale: 2 }).notNull(),
    /** قيمة المستقرّ في `branchStock` وحدها. */
    stockValue: decimal("stockValue", { precision: 15, scale: 2 }).notNull(),
    /** قيمة الحمل بالطريق (سندات IN_TRANSIT بلقطة WAVG الحاليّة). */
    inTransitValue: decimal("inTransitValue", { precision: 15, scale: 2 }).notNull(),
    /**
     * تفصيلُ الفروع (JSON) — `[{branchId, value, inTransitValue?}]`. يُخزَّن نصّياً كي يبقى
     * قابلاً للتحقّق التاريخيّ حتى لو تغيّر تعريفُ الحقول لاحقاً.
     */
    branchesJson: text("branchesJson"),
  },
  (t) => ({
    // صفٌّ واحد لكل (فترة × نطاق) — إعادة الالتقاط تفشل بـER_DUP_ENTRY (revision جديد يعني
    // periodLockId جديد ⇒ صفٌّ منفصل حكماً، فلا تعارض).
    periodScopeUq: unique("uq_valuation_period_scope").on(
      t.periodLockId,
      t.scopeKey,
      t.branchId,
    ),
    cutoffIdx: index("idx_valuation_cutoff").on(t.cutoffDate),
    periodIdx: index("idx_valuation_period").on(t.periodLockId),
  }),
);
export type InventoryValuationSnapshot = typeof inventoryValuationSnapshots.$inferSelect;

/** موافقات ائتمان مُسبَقة — يُقيِّد creditApproved بـ(customer, maxAmount, expiresAt).
 * المنطق: المدير يُنشئ صفّاً بـ(customerId, maxAmount, expiresAt). الكاشير يمرّر approvalId
 * في sale؛ الخدمة تتحقّق: customer مطابق، unpaid ≤ maxAmount، now ≤ expiresAt، consumedAt IS NULL.
 * بعد الاستهلاك consumedAt + consumedByInvoiceId مُسجَّلان ⇒ لا تُستعمل ثانية. */
export const creditApprovals = mysqlTable(
  "creditApprovals",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    customerId: bigint("customerId", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    // نطاق القرار المالي. الصفوف التاريخية قد تبقى null بعد الترحيل إن تعذّر استنتاج
    // فرعها، لكنها تُعامل فشلاً مغلقاً ولا تُستهلك. كل إنشاء جديد يفرض branchId خادمياً.
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    maxAmount: decimal("maxAmount", { precision: 15, scale: 2 }).notNull(),
    approvedBy: int("approvedBy")
      .notNull()
      .references(() => users.id),
    approvedAt: timestamp("approvedAt").defaultNow().notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    consumedByInvoiceId: bigint("consumedByInvoiceId", {
      mode: "number",
    }).references(() => invoices.id),
    notes: varchar("notes", { length: 255 }),
  },
  (t) => ({
    customerExpiryIdx: index("idx_capp_customer").on(t.customerId, t.expiresAt),
    branchExpiryIdx: index("idx_capp_branch_expiry").on(
      t.branchId,
      t.expiresAt,
    ),
  }),
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
    scopeKey: varchar("scopeKey", { length: 32 }).default("COMPANY").notNull(),
    revision: int("revision").default(1).notNull(),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    supersedesSnapshotId: bigint("supersedesSnapshotId", {
      mode: "number",
    }),
    closedAt: timestamp("closedAt").defaultNow().notNull(),
    closedBy: int("closedBy")
      .notNull()
      .references(() => users.id),
    totalRevenue: decimal("totalRevenue", {
      precision: 15,
      scale: 2,
    }).notNull(),
    totalCogs: decimal("totalCogs", { precision: 15, scale: 2 }).notNull(),
    totalExpenses: decimal("totalExpenses", {
      precision: 15,
      scale: 2,
    }).notNull(),
    netProfit: decimal("netProfit", { precision: 15, scale: 2 }).notNull(),
    retainedEarningsEntryId: bigint("retainedEarningsEntryId", {
      mode: "number",
    }).references(() => accountingEntries.id),
    snapshotData: text("snapshotData"),
  },
  (t) => ({
    yearScopeRevisionUq: unique("uq_year_scope_revision").on(
      t.year,
      t.scopeKey,
      t.revision,
    ),
    supersedesFk: foreignKey({
      name: "fk_year_end_supersedes",
      columns: [t.supersedesSnapshotId],
      foreignColumns: [t.id],
    }),
    revisionCheck: check("chk_year_snapshot_revision", sql`${t.revision} > 0`),
  }),
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
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    channel: mysqlEnum("convChannel", [
      "WHATSAPP",
      "INSTAGRAM",
      "TIKTOK",
      "STORE",
      "PHONE",
      "WALK_IN",
      "OTHER",
    ]).notNull(),
    // مُعَرّف العَميل على القَناة الأَصلية (رَقم هاتف لِواتساب، username لانستغرام، ...).
    // فَريد لكل (channel + branch) لِمَنع تَكرار المحادثة لنفس الزَبون.
    channelHandle: varchar("channelHandle", { length: 120 }).notNull(),
    // رَبط للسجلّ العميل في نِظامنا (إن وُجد) — قد يَكون null لِرسالة أَولى مِن مَجهول.
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
    ),
    // اسم مَعروض (مُلتَقَط مِن منصّة القَناة لو لم نَعرفه بَعد).
    displayName: varchar("displayName", { length: 200 }),
    // أَمر شَغل مَربوط (لو الزَبون يَسأل عن أمر جاري) — اِختياري.
    linkedWorkOrderId: bigint("linkedWorkOrderId", {
      mode: "number",
    }).references(() => workOrders.id),
    // عَدّاد غَير مَقروء + آخِر رِسالة لِفَرز الـinbox بِسُرعة بَلا scan رَسائل.
    unreadCount: int("unreadCount").default(0).notNull(),
    lastMessageAt: timestamp("lastMessageAt"),
    lastMessagePreview: varchar("lastMessagePreview", { length: 280 }),
    // OPEN = نَشِط، ARCHIVED = مُؤرشَف يَدوياً، CLOSED = بَعد تَسليم أَمر شَغل.
    status: mysqlEnum("convStatus", ["OPEN", "ARCHIVED", "CLOSED"])
      .default("OPEN")
      .notNull(),
    // مُوظَّف مُسنَد لِلمُحادثة — اِختياري (نَمط 0106، مركز واتساب الأعمال).
    assignedTo: int("assignedTo").references(() => users.id),
    // آخِر رِسالة IN وَاردة مِن العَميل — مِرساة حِساب نافِذة الرَدّ الحُرّ ٢٤ ساعة (WhatsApp Cloud API).
    lastInboundAt: timestamp("lastInboundAt"),
    // رَبط اِختياري بِمورّد (مُحادثات B2B مع مورّدين عبر نَفس صَندوق الوارِد).
    supplierId: bigint("supplierId", { mode: "number" }).references(
      () => suppliers.id,
    ),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    branchIdx: index("idx_conv_branch").on(
      t.branchId,
      t.status,
      t.lastMessageAt,
    ),
    customerIdx: index("idx_conv_customer").on(t.customerId),
    // مُحادثة فَريدة لكل (قَناة + handle + فَرع) ⇒ webhook مُكَرّر لا يُكرّر السجلّ.
    chHandleUq: unique("uq_conv_channel_handle").on(
      t.channel,
      t.channelHandle,
      t.branchId,
    ),
  }),
);
export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;

/** رَسائل المحادثة — IN مِن الزَبون، OUT مِن مُوظَّفنا، NOTE مُلاحظة داخِلية. */
export const conversationMessages = mysqlTable(
  "conversationMessages",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    conversationId: bigint("conversationId", { mode: "number" })
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
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
    deliveryStatus: mysqlEnum("msgDelivery", [
      "PENDING",
      "SENT",
      "DELIVERED",
      "READ",
      "FAILED",
    ]),
    // خَتم زَمني مِن Meta نَفسها (قد يَختلف عَن createdAt بِبُرهة الشَبكة) — نَمط 0106.
    waTimestamp: timestamp("waTimestamp"),
    // آخِر تَحديث لِـdeliveryStatus (مِن أَحداث statuses[] في الـwebhook).
    statusUpdatedAt: timestamp("statusUpdatedAt"),
    // كود خَطأ Meta عِند FAILED (مِثلاً 131047 = اِنتهاء نافِذة الرَدّ الحُرّ).
    errorCode: varchar("errorCode", { length: 20 }),
    // اِسم القالب المُعتمَد لَو الرِسالة مِن نَوع TEMPLATE.
    templateName: varchar("templateName", { length: 128 }),
    // مَصدر الرِسالة: API (نِظامنا) أَو PHONE_APP (تَطبيق واتساب الأَعمال على الهاتِف مُباشرةً) أَو SYSTEM.
    origin: mysqlEnum("origin", ["API", "PHONE_APP", "SYSTEM"]),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    convIdx: index("idx_msg_conv").on(t.conversationId, t.createdAt),
    // مُعَرّف خارِجي فَريد لِمَنع كَتابة مُكَرَّرة عند webhook retries.
    externalUq: unique("uq_msg_external").on(t.externalId),
  }),
);
export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type InsertConversationMessage =
  typeof conversationMessages.$inferInsert;

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
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    channel: mysqlEnum("intChannel", [
      "WHATSAPP",
      "INSTAGRAM",
      "STORE",
    ]).notNull(),
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
    status: mysqlEnum("intStatus", ["PENDING", "ACTIVE", "FAILED", "DISABLED"])
      .default("PENDING")
      .notNull(),
    lastVerifiedAt: timestamp("lastVerifiedAt"),
    // نَتيجة آخر تَحقّق (إن فَشل): سَبب مَقروء لِلعَرض في الشاشة.
    lastError: varchar("lastError", { length: 500 }),
    // مُعرّف حِساب واتساب الأَعمال (WABA ID) — لِـWhatsApp Cloud API فَقط.
    wabaId: varchar("wabaId", { length: 80 }),
    // قاعِدة API مُخصَّصة (حِيادية المُزوّد) — NULL = graph.facebook.com الاِفتراضي.
    apiBaseUrl: varchar("apiBaseUrl", { length: 160 }),
    updatedBy: int("updatedBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    // قَناة واحدة لكل فَرع — لا تَكرار. تَغيير tokens = تَحديث نَفس السجلّ.
    branchChannelUq: unique("uq_int_branch_channel").on(t.branchId, t.channel),
    statusIdx: index("idx_int_status").on(t.status),
  }),
);
export type ChannelIntegration = typeof channelIntegrations.$inferSelect;
export type InsertChannelIntegration = typeof channelIntegrations.$inferInsert;

/* ============================ مَركز واتساب الأَعمال — نَواة Cloud API (شَريحة #١، 0106) ============================
 *
 * المَنطق: طابور إرسال صادِر واحِد (waOutbox) بِـidempotency (dedupeKey) + إعادة مُحاولة (attempts/
 * nextAttemptAt) + جَدوَلة/حَملات مُستقبَلية (campaignId/taskId رَوابط مَنطقية فَقط — الجَدولان
 * مَحجوزان لِشَرائح S2/S5 لاحِقاً، بِلا FK فِعلي حَتى تُنشآ). waMedia يَحفظ وَسائط الرَسائل (base64)
 * بَعد جَلبٍ مُؤجَّل (رَوابط Graph تَنتهي صَلاحيتها بِسُرعة). waWebhookEvents سِجلّ خام تَسلسلي
 * لِأَحداث الـwebhook الوارِدة (تَشخيص/إعادة مُعالَجة عِند الفَشل).
 */

/** طابور الإرسال الصادِر لِواتساب (وَ لاحِقاً قَنوات أُخرى) — مَصدر الحَقيقة الوَحيد لِلإرسال. */
export const waOutbox = mysqlTable(
  "waOutbox",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).notNull(),
    // مُعَرّف idempotency — يَمنع إرسالاً مُزدَوجاً لِنَفس الحَدث (إعادة مُحاولة/طَلب مُكَرَّر).
    dedupeKey: varchar("dedupeKey", { length: 190 }).notNull(),
    conversationId: bigint("conversationId", { mode: "number" }),
    toPhoneE164: varchar("toPhoneE164", { length: 20 }),
    // لقطة منطقية (بلا FK عمداً) لتطبيق إلغاء الموافقة عند التسليم؛ حذف العميل يجب أن يُلغي الصف
    // لا أن يمحو الهوية بـSET NULL فيتعذّر على العامل معرفة أن مصدر الرسالة لم يعد موجوداً.
    customerId: bigint("customerId", { mode: "number" }),
    // SESSION_TEXT = رَدّ حُرّ ضِمن نافِذة ٢٤ساعة، TEMPLATE = قالِب مُعتمَد، MEDIA = إرسال وَسائط،
    // MEDIA_FETCH = جَلب مُؤجَّل لِوَسائط وارِدة (رَوابط Graph تَنتهي بِسُرعة).
    kind: mysqlEnum("kind", [
      "SESSION_TEXT",
      "TEMPLATE",
      "MEDIA",
      "MEDIA_FETCH",
    ]).notNull(),
    // حُمولة الطَلب الكامِلة (نَصّ/قالِب/وَسائط) — شَكلها يَعتمد على kind.
    payloadJson: json("payloadJson").notNull(),
    templateName: varchar("templateName", { length: 128 }),
    templateLang: varchar("templateLang", { length: 10 }),
    status: mysqlEnum("status", [
      "QUEUED",
      "SENDING",
      "SENT",
      "FAILED",
      "CANCELLED",
    ])
      .default("QUEUED")
      .notNull(),
    attempts: int("attempts").default(0).notNull(),
    nextAttemptAt: timestamp("nextAttemptAt"),
    lastError: varchar("lastError", { length: 500 }),
    // مُعَرّف الرِسالة عِند Meta بَعد الإرسال (لِمُطابَقة أَحداث statuses[] في الـwebhook).
    wamid: varchar("wamid", { length: 200 }),
    // رَوابط مَنطقية فَقط (بِلا FK) — الجَدولان campaigns/tasks لَم يُنشآ بَعد (S2/S5).
    campaignId: bigint("campaignId", { mode: "number" }),
    taskId: bigint("taskId", { mode: "number" }),
    scheduledAt: timestamp("scheduledAt"),
    createdBy: int("createdBy"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    dedupeUq: unique("uq_wa_outbox_dedupe").on(t.dedupeKey),
    // الكَنّاس يَنتقي الصُفوف الجاهِزة لِلإرسال/إعادة المُحاولة بِسُرعة (status + وَقت الاِستِحقاق).
    pickIdx: index("idx_wa_outbox_pick").on(t.status, t.nextAttemptAt),
    wamidIdx: index("idx_wa_outbox_wamid").on(t.wamid),
    campaignIdx: index("idx_wa_outbox_campaign").on(t.campaignId, t.status),
    customerStatusIdx: index("idx_wa_outbox_customer_status").on(
      t.customerId,
      t.status,
    ),
  }),
);
export type WaOutbox = typeof waOutbox.$inferSelect;
export type InsertWaOutbox = typeof waOutbox.$inferInsert;

/** وَسائط الرَسائل (وارِدة/صادِرة) — base64 بَعد جَلب مُؤجَّل (رَوابط Graph تَنتهي بِسُرعة). */
export const waMedia = mysqlTable(
  "waMedia",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    messageId: bigint("messageId", { mode: "number" }).notNull(),
    mimeType: varchar("mimeType", { length: 80 }).notNull(),
    bytesBase64: mediumtext("bytesBase64").notNull(),
    sizeBytes: int("sizeBytes").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    // وَسائط فَريدة لِكُل رِسالة — لا تَكرار لِنَفس messageId.
    messageUq: unique("uq_wa_media_message").on(t.messageId),
  }),
);
export type WaMedia = typeof waMedia.$inferSelect;
export type InsertWaMedia = typeof waMedia.$inferInsert;

/** سِجلّ خام تَسلسلي لِأَحداث الـwebhook الوارِدة (تَشخيص/إعادة مُعالَجة عِند الفَشل). */
export const waWebhookEvents = mysqlTable(
  "waWebhookEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    channel: varchar("channel", { length: 20 }).notNull(),
    integrationId: bigint("integrationId", { mode: "number" }),
    payloadJson: json("payloadJson").notNull(),
    status: mysqlEnum("status", ["PENDING", "PROCESSED", "FAILED"])
      .default("PENDING")
      .notNull(),
    attempts: int("attempts").default(0).notNull(),
    lastError: varchar("lastError", { length: 500 }),
    receivedAt: timestamp("receivedAt").defaultNow().notNull(),
    processedAt: timestamp("processedAt"),
  },
  (t) => ({
    pickIdx: index("idx_wa_events_pick").on(t.status, t.receivedAt),
  }),
);
export type WaWebhookEvent = typeof waWebhookEvents.$inferSelect;
export type InsertWaWebhookEvent = typeof waWebhookEvents.$inferInsert;

/* ============================ نِظام المَهام المُوَحَّد — ش١ (S2، هجرة 0107) ============================
 *
 * الأَساس فَقط (جَداول + صَلاحيات + بَذر) — الخِدمة/الراوتر/الشاشات في مَهام لاحِقة. راجِع
 * docs/whatsapp-hub-design-2026-07-23.md §٣. `tasks` تَذكرة مُوَحَّدة لكل طَلب/تَفاعُل بِغَضّ النَظر
 * عَن مَصدره (واتساب/إنستغرام/تيكتوك/مَتجر/هاتف/حُضوري/آخَر) — قابِلة لِلرَبط بِعَميل/مورّد/مُحادَثة/
 * أَمر شَغل/فاتورة/عَرض سِعر. waitingSince/waitingAccumMs يوقِفان عَدّاد SLA أَثناء اِنتِظار رَدّ
 * العَميل (لا يُحتَسَب على المُوَظَّف). `taskEvents` سِجلّ أَحداث تَسلسُليّ بِلا حَذف. `serviceTypes`
 * أَنواع خِدمة مَرجِعية (تَصنيف + أَولوية اِفتِراضية + SLA بِالساعات). `waKeywordRules` قَواعِد تَصنيف
 * تِلقائي بِكَلِمات مِفتاحية لِفَرز رَسائل واتساب الوارِدة (عامّة إِن branchId=NULL، أَو خاصّة بِفَرع).
 * `waHubSettings` singleton (نَمَط openingModeSettings) لِإِعدادات مَركَز واتساب الأَعمال.
 */

/** تَذكرة مُوَحَّدة: طَلب خِدمة/دَعم/اِستِفسار/مُتابَعة/داخِلية — بِغَضّ النَظر عَن قَناة الوُرود. */
export const tasks = mysqlTable(
  "tasks",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    taskNumber: varchar("taskNumber", { length: 40 }).notNull(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    taskKind: mysqlEnum("taskKind", [
      "SERVICE_REQUEST",
      "SUPPORT",
      "INQUIRY",
      "FOLLOW_UP",
      "INTERNAL",
    ])
      .default("INQUIRY")
      .notNull(),
    taskStatus: mysqlEnum("taskStatus", [
      "NEW",
      "IN_PROGRESS",
      "WAITING_CUSTOMER",
      "RESOLVED",
      "CANCELLED",
    ])
      .default("NEW")
      .notNull(),
    priority: mysqlEnum("priority", ["LOW", "NORMAL", "HIGH", "URGENT"])
      .default("NORMAL")
      .notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
    ),
    supplierId: bigint("supplierId", { mode: "number" }).references(
      () => suppliers.id,
    ),
    conversationId: bigint("conversationId", { mode: "number" }).references(
      () => conversations.id,
    ),
    linkedWorkOrderId: bigint("linkedWorkOrderId", {
      mode: "number",
    }).references(() => workOrders.id),
    linkedInvoiceId: bigint("linkedInvoiceId", { mode: "number" }).references(
      () => invoices.id,
    ),
    linkedQuotationId: bigint("linkedQuotationId", {
      mode: "number",
    }).references(() => quotations.id),
    serviceTypeId: bigint("serviceTypeId", { mode: "number" }).references(
      () => serviceTypes.id,
    ),
    // قَناة الاِستِلام (نَفس تِعداد convChannel) — null لِمَهمّة داخِلية بِلا قَناة خارِجية.
    sourceChannel: mysqlEnum("sourceChannel", [
      "WHATSAPP",
      "INSTAGRAM",
      "TIKTOK",
      "STORE",
      "PHONE",
      "WALK_IN",
      "OTHER",
    ]),
    assignedTo: int("assignedTo").references(() => users.id),
    createdBy: int("createdBy").references(() => users.id),
    dueAt: timestamp("dueAt"),
    firstResponseAt: timestamp("firstResponseAt"),
    resolvedAt: timestamp("resolvedAt"),
    // مِرساة إِيقاف عَدّاد SLA أَثناء اِنتِظار العَميل + المُتَراكِم مِن فَترات اِنتِظار سابِقة (ms).
    waitingSince: timestamp("waitingSince"),
    waitingAccumMs: bigint("waitingAccumMs", { mode: "number" })
      .default(0)
      .notNull(),
    csatScore: tinyint("csatScore"),
    csatRequestedAt: timestamp("csatRequestedAt"),
    reopenCount: int("reopenCount").default(0).notNull(),
    resolutionNote: text("resolutionNote"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    numberUq: unique("uq_task_number").on(t.taskNumber),
    branchStatusIdx: index("idx_task_branch_status").on(
      t.branchId,
      t.taskStatus,
    ),
    assigneeIdx: index("idx_task_assignee").on(t.assignedTo, t.taskStatus),
    customerIdx: index("idx_task_customer").on(t.customerId),
    convIdx: index("idx_task_conv").on(t.conversationId),
  }),
);
export type Task = typeof tasks.$inferSelect;
export type InsertTask = typeof tasks.$inferInsert;

/** سِجلّ أَحداث المَهمّة — تَعليق/تَغيير حالة/إِسناد/رَبط/نِظام/CSAT. تَسلسُليّ بِلا حَذف أَو status. */
export const taskEvents = mysqlTable(
  "taskEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    taskId: bigint("taskId", { mode: "number" })
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    eventType: mysqlEnum("eventType", [
      "COMMENT",
      "STATUS",
      "ASSIGN",
      "LINK",
      "SYSTEM",
      "CSAT",
    ]).notNull(),
    fromStatus: varchar("fromStatus", { length: 20 }),
    toStatus: varchar("toStatus", { length: 20 }),
    note: text("note"),
    userId: int("userId").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    taskIdx: index("idx_task_events_task").on(t.taskId, t.createdAt),
  }),
);
export type TaskEvent = typeof taskEvents.$inferSelect;
export type InsertTaskEvent = typeof taskEvents.$inferInsert;

/** نَوع خِدمة مَرجِعي — تَصنيف + أَولوية اِفتِراضية + SLA بِالساعات (null = بِلا SLA مَضبوط). */
export const serviceTypes = mysqlTable(
  "serviceTypes",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    defaultKind: mysqlEnum("defaultKind", [
      "SERVICE_REQUEST",
      "SUPPORT",
      "INQUIRY",
      "FOLLOW_UP",
      "INTERNAL",
    ])
      .default("SERVICE_REQUEST")
      .notNull(),
    defaultPriority: mysqlEnum("defaultPriority", [
      "LOW",
      "NORMAL",
      "HIGH",
      "URGENT",
    ])
      .default("NORMAL")
      .notNull(),
    slaHours: int("slaHours"),
    /**
     * هل يحجز هذا النوعُ **تنفيذَ أمر الشغل**؟ (0217، ش٢) — قرارُ سياسةٍ بشريّ لا تحمله
     * بيانات. الافتراضيّ `false` ⇒ صفر أثرٍ سلوكيّ، ومفتاحُ الإيقاف الفوريّ بلا نشرٍ محفوظ.
     * ⛔ ليس عَلَماً على أمر الشغل: الحجزُ يُقرأ بـ«هل ثمّة مهمّةٌ حاجزة مفتوحة؟» فلا عَلَمٌ
     * ثانٍ ينجرف عن الواقع، والموافقةُ تبطل بحكم البناء حين تُفتَح مهمّةٌ جديدة.
     */
    blocksExecution: boolean("blocksExecution").default(false).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    nameUq: unique("uq_service_type_name").on(t.name),
  }),
);
export type ServiceType = typeof serviceTypes.$inferSelect;
export type InsertServiceType = typeof serviceTypes.$inferInsert;

/** قاعِدة تَصنيف تِلقائي بِكَلِمة مِفتاحية لِفَرز رَسائل واتساب الوارِدة إِلى نَوع مَهمّة — عامّة
 *  (branchId=NULL) أَو خاصّة بِفَرع، بِتَرتيب أَولوية تَطبيق (priority الأَصغَر يُطَبَّق أَوّلاً). */
export const waKeywordRules = mysqlTable(
  "waKeywordRules",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    pattern: varchar("pattern", { length: 190 }).notNull(),
    matchKind: mysqlEnum("matchKind", [
      "SERVICE_REQUEST",
      "SUPPORT",
      "INQUIRY",
      "FOLLOW_UP",
      "INTERNAL",
    ]).notNull(),
    serviceTypeId: bigint("serviceTypeId", { mode: "number" }).references(
      () => serviceTypes.id,
    ),
    priority: int("priority").default(0).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    activeIdx: index("idx_wa_kw_active").on(t.isActive, t.priority),
  }),
);
export type WaKeywordRule = typeof waKeywordRules.$inferSelect;
export type InsertWaKeywordRule = typeof waKeywordRules.$inferInsert;

/** إِعدادات مَركَز واتساب الأَعمال (صَفّ singleton id=1، نَمَط openingModeSettings): وَضع الفَرز
 *  (تِلقائي كامِل/كَلِمات مِفتاحية فَقط/يَدَوي)، رُدود الترحيب/خارِج الدَوام، مَفاتيح أَتمَتة لِكُل
 *  تَدَفُّق عَلى حِدة (كُلّها مُعَطَّلة اِفتِراضياً)، ومِفتاح إِيقاف طارِئ (killSwitch) يوقِف كُل إِرسال آلي. */
export const waHubSettings = mysqlTable("waHubSettings", {
  id: int("id").autoincrement().primaryKey(),
  triageMode: mysqlEnum("triageMode", ["AUTO_ALL", "KEYWORD_ONLY", "MANUAL"])
    .default("AUTO_ALL")
    .notNull(),
  autoTaskEnabled: boolean("autoTaskEnabled").default(true).notNull(),
  businessHoursJson: json("businessHoursJson"),
  afterHoursReply: text("afterHoursReply"),
  welcomeReply: text("welcomeReply"),
  throttlePerMinute: int("throttlePerMinute").default(10).notNull(),
  optOutKeywords: text("optOutKeywords"),
  campaignApprovalThreshold: int("campaignApprovalThreshold")
    .default(500)
    .notNull(),
  // ── مَفاتيح أَتمَتة لِكُل تَدَفُّق عَلى حِدة — كُلّها مُعَطَّلة اِفتِراضياً (صِفر أَثَر رَجعيّ) ──
  autoReplyAfterHours: boolean("autoReplyAfterHours").default(false).notNull(),
  autoReplyWelcome: boolean("autoReplyWelcome").default(false).notNull(),
  flowArReminder: boolean("flowArReminder").default(false).notNull(),
  flowOrderReady: boolean("flowOrderReady").default(false).notNull(),
  flowPurchaseThanks: boolean("flowPurchaseThanks").default(false).notNull(),
  flowConsignmentWithdraw: boolean("flowConsignmentWithdraw")
    .default(false)
    .notNull(),
  flowReservationNearExpiry: boolean("flowReservationNearExpiry")
    .default(false)
    .notNull(),
  csatOnResolve: boolean("csatOnResolve").default(false).notNull(),
  killSwitch: boolean("killSwitch").default(false).notNull(),
  updatedBy: int("updatedBy").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type WaHubSettings = typeof waHubSettings.$inferSelect;
export type InsertWaHubSettings = typeof waHubSettings.$inferInsert;

/* ============================ قوالب Meta — مركز واتساب الأعمال (S4، هجرة 0109) ============================
 *
 * المَنطق: القوالب المُعتمَدة عِند Meta هي الوَسيلة الوَحيدة لِلإرسال خارِج نافِذة ٢٤ ساعة (تَذكيرات
 * آجِلة/إشعارات جاهِزية/حَملات — templateService.syncTemplatesFromGraph تَسحَبها دَورياً عَبر
 * GET /{wabaId}/message_templates وتُخَزّنها هُنا). name+language مُميَّزان عَلى مُستَوى WABA (وَثيقة
 * Meta) ⇒ UNIQUE مُرَكَّب. bodyText/variableCount مُستَخرَجان مِن componentsJson (type=BODY) وَقت
 * المُزامَنة — عَرض/تَعبِئة سَريعة بِلا تَفكيك JSON في كل اِستِهلاك. branchId=NULL = قالِب عامّ (الحالة
 * الغالِبة — القَوالِب على مُستَوى WABA لا الفَرع).
 */
export const waTemplates = mysqlTable(
  "waTemplates",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    name: varchar("name", { length: 128 }).notNull(),
    language: varchar("language", { length: 10 }).default("ar").notNull(),
    category: mysqlEnum("category", ["MARKETING", "UTILITY", "AUTHENTICATION"])
      .default("UTILITY")
      .notNull(),
    templateStatus: mysqlEnum("templateStatus", [
      "PENDING",
      "APPROVED",
      "REJECTED",
      "PAUSED",
      "DISABLED",
    ])
      .default("PENDING")
      .notNull(),
    bodyText: text("bodyText"),
    componentsJson: json("componentsJson"),
    variableCount: int("variableCount").default(0).notNull(),
    qualityScore: varchar("qualityScore", { length: 20 }),
    syncedAt: timestamp("syncedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    nameLangUq: unique("uq_wa_template_name_lang").on(t.name, t.language),
    statusIdx: index("idx_wa_template_status").on(t.templateStatus),
  }),
);
export type WaTemplate = typeof waTemplates.$inferSelect;
export type InsertWaTemplate = typeof waTemplates.$inferInsert;

/* ============================ بنك جهات الاتصال — أشخاص الاتصال B2B (S3، هجرة 0108) ============================ */

/** شَخص اتّصال مَربوط بِعَميل أَو مورّد (لا كِلَيهما — لا قَيد CHECK عَلى MySQL، يُفرَض تَطبيقياً):
 *  جِهة تَواصُل فِعلية داخِل مُؤسَّسة الطَرَف (مُفَوَّض/مُحاسِب/مُدير مُشتَريات…) بِهاتف مُستَقِل.
 *  البَحث لاحِقاً عَلى name/phone مُباشَرةً — بِلا searchNorm (تَعقيد زائِد لِحَجم بَيانات صَغير). */
export const contactPersons = mysqlTable(
  "contactPersons",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
    ),
    supplierId: bigint("supplierId", { mode: "number" }).references(
      () => suppliers.id,
    ),
    name: varchar("name", { length: 160 }).notNull(),
    phone: varchar("phone", { length: 20 }),
    // صِفة نَصّية حُرّة: مُفَوَّض/مُحاسِب/مُدير مُشتَريات…
    role: varchar("role", { length: 60 }),
    isPrimary: boolean("isPrimary").default(false).notNull(),
    notes: varchar("notes", { length: 255 }),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    customerIdx: index("idx_contact_person_customer").on(t.customerId),
    supplierIdx: index("idx_contact_person_supplier").on(t.supplierId),
    phoneIdx: index("idx_contact_person_phone").on(t.phone),
  }),
);
export type ContactPerson = typeof contactPersons.$inferSelect;
export type InsertContactPerson = typeof contactPersons.$inferInsert;

/* ============================ التوصيل (COD) — جهات التوصيل والعهد والترحيل ============================ */

/** جهة توصيل: مندوب فرد أو شركة توصيل. كيان بيانات (لا مستخدم نظام). currentBalance = عهدة COD القائمة. */
export const deliveryParties = mysqlTable(
  "deliveryParties",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    partyType: mysqlEnum("deliveryPartyKind", ["INDIVIDUAL", "COMPANY"])
      .default("INDIVIDUAL")
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 20 }),
    phone2: varchar("phone2", { length: 20 }),
    // ربط اختياري بحساب دخول (مندوب courier) ⇒ شاشة «توصيلاتي» الذاتية تحلّ partyId من ctx.user.
    // فريد: حساب واحد لكل جهة (هجرة 0068). nullable ⇒ الجهات الخارجية/شركات التوصيل بلا حساب.
    userId: int("userId").references(() => users.id),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    nationalId: varchar("nationalId", { length: 40 }),
    vehicleInfo: varchar("vehicleInfo", { length: 120 }),
    // أجرة توصيل افتراضية ثابتة لكل طلب (D7) — تُملأ في حوار التعيين ويُمكن تعديلها.
    defaultFee: decimal("defaultFee", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // عهدة COD القائمة (موجب = الجهة مدينة بنقدٍ مطلوب تحصيله/تحصَّل ولم يُورَّد). نظير customers.currentBalance.
    currentBalance: decimal("currentBalance", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    version: int("version").default(1).notNull(),
    floatLimit: decimal("floatLimit", { precision: 15, scale: 2 }),
    /**
     * H2 (٢٩/٨/٢٦، هجرة 0289) — تفعيلٌ لكلّ جهة: عند التسوية يُدفَع للمندوب مبلغُ العمولة (من قاعدة
     * `courierCommissionRules`) بدل الأجرة الكاملة، والفارقُ يُقيَّد إيراداً `DELIVERY_REVENUE` للمكتبة.
     * يعمل فقط حين تكون للجهة قاعدةٌ فعّالة أيضاً. `false` (الافتراض) = السلوك السابق بلا مساس.
     */
    useCommissionForSettlement: boolean("useCommissionForSettlement").default(false).notNull(),
    /**
     * Slice DFP1 (٣٠/٨/٢٦، هجرة 0294) — SLA على عمر الطرود المفتوحة لكلّ جهة (أيّام):
     * `assertFloatLimitTx` يرفض إسناداً جديداً إن كان لدى الجهة أيّ طرد أقدم من هذه القيمة
     * دون توريد. الافتراض 7 (أسبوعٌ تشغيليّ). المدى المقبول 1..365 محروسٌ بـCHECK constraint.
     */
    maxOpenParcelAgeDays: int("maxOpenParcelAgeDays").default(7).notNull(),
    notes: text("notes"),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    nameIdx: index("idx_delivery_party_name").on(table.name),
    branchIdx: index("idx_delivery_party_branch").on(table.branchId),
    activeIdx: index("idx_delivery_party_active").on(table.isActive),
    userUq: unique("uq_delivery_party_user").on(table.userId),
  }),
);
export type DeliveryParty = typeof deliveryParties.$inferSelect;
export type InsertDeliveryParty = typeof deliveryParties.$inferInsert;

/**
 * Portal membership for a delivery party.  The legacy deliveryParties.userId
 * column remains during the compatibility window, but authorization and
 * company multi-user access are driven by this append-only-friendly mapping.
 */
export const deliveryPartyMembers = mysqlTable(
  "deliveryPartyMembers",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    partyId: bigint("partyId", { mode: "number" })
      .notNull()
      .references(() => deliveryParties.id, { onDelete: "cascade" }),
    userId: int("userId")
      .notNull()
      .references(() => users.id),
    memberRole: mysqlEnum("memberRole", ["DRIVER", "MANAGER", "ACCOUNTANT"])
      .default("DRIVER")
      .notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    partyUserUq: unique("uq_delivery_party_member").on(
      table.partyId,
      table.userId,
    ),
    // One portal identity cannot silently act for two delivery parties.
    userUq: unique("uq_delivery_party_member_user").on(table.userId),
    partyActiveIdx: index("idx_delivery_party_member_active").on(
      table.partyId,
      table.isActive,
    ),
  }),
);
export type DeliveryPartyMember = typeof deliveryPartyMembers.$inferSelect;
export type InsertDeliveryPartyMember =
  typeof deliveryPartyMembers.$inferInsert;

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
    balanceIqd: decimal("balanceIqd", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    balanceUsd: decimal("balanceUsd", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // القيمة الدفترية الموقعة لرصيد الدولار بالدينار. هذا هو المصدر المحاسبي الدقيق؛
    // usdCostRate مشتق للعرض فقط لأن تخزينه بأربع منازل لا يكفي لإعادة بناء السنت الأخير.
    balanceUsdCarryingIqd: decimal("balanceUsdCarryingIqd", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    // متوسط كلفة الدينار للدولار الواحد (WAVG) — مشتق للعرض والتدقيق، لا مصدر للحركة الدفترية.
    usdCostRate: decimal("usdCostRate", { precision: 15, scale: 4 })
      .default("0")
      .notNull(),
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
    usdCarryingSignCheck: check(
      "chk_exchange_usd_carrying_sign",
      sql`(
        (${table.balanceUsd} = 0 AND ${table.balanceUsdCarryingIqd} = 0)
        OR (${table.balanceUsd} > 0 AND ${table.balanceUsdCarryingIqd} > 0)
        OR (${table.balanceUsd} < 0 AND ${table.balanceUsdCarryingIqd} < 0)
      )`,
    ),
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
    exchangeHouseId: bigint("exchangeHouseId", { mode: "number" })
      .notNull()
      .references(() => exchangeHouses.id),
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    type: mysqlEnum("exchangeTxnType", [
      "DEPOSIT",
      "WITHDRAW",
      "FX_BUY",
      "SETTLE",
      "OPENING",
    ]).notNull(),
    currency: mysqlEnum("exchangeTxnCurrency", ["IQD", "USD"])
      .default("IQD")
      .notNull(),
    // مبلغ الدينار (إيداع/سحب/الدين المُسوّى) ومبلغ الدولار (شراء/تسديد بالدولار) — كلٌّ بعملته.
    iqdAmount: decimal("iqdAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    usdAmount: decimal("usdAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    exchangeRate: decimal("exchangeRate", { precision: 15, scale: 4 })
      .default("0")
      .notNull(),
    commission: decimal("commission", { precision: 15, scale: 2 })
      .default("0")
      .notNull(), // بعملة المحفظة
    commissionIqd: decimal("commissionIqd", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    fxDiff: decimal("fxDiff", { precision: 15, scale: 2 })
      .default("0")
      .notNull(), // مكسب(+)/خسارة(−) صرف محقَّق
    supplierId: bigint("supplierId", { mode: "number" }).references(
      () => suppliers.id,
    ),
    purchaseOrderId: bigint("purchaseOrderId", { mode: "number" }).references(
      () => purchaseOrders.id,
    ),
    // مبلغ الدين الدولاري الذي أُطفئ، مستقل عن عملة محفظة الصيرفة (قد نسحب IQD وتصل USD للمورد).
    settledUsd: decimal("settledUsd", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    settledIqd: decimal("settledIqd", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // لقطة الرصيد بعد العملية (تدقيق + رصيد جارٍ في كشف الحساب).
    balanceIqdAfter: decimal("balanceIqdAfter", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    balanceUsdAfter: decimal("balanceUsdAfter", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    receiptId: bigint("receiptId", { mode: "number" }).references(
      () => receipts.id,
    ),
    // PENDING_APPROVAL: إيداع دولار مباشر بانتظار اعتماد مديرٍ ثانٍ (SOD) — لا يمسّ رصيد المحفظة حتى الاعتماد
    // (recomputeHouseFromLog يرشّح ACTIVE فيستثنيه). ACTIVE = نافذ، REVERSED = معكوس.
    status: mysqlEnum("exchangeTxnStatus", [
      "ACTIVE",
      "REVERSED",
      "PENDING_APPROVAL",
    ])
      .default("ACTIVE")
      .notNull(),
    notes: text("notes"),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_exchange_txn_number").on(table.txnNumber),
    houseIdx: index("idx_exchange_txn_house").on(
      table.exchangeHouseId,
      table.createdAt,
    ),
    supplierIdx: index("idx_exchange_txn_supplier").on(table.supplierId),
    purchaseOrderIdx: index("idx_exchange_txn_po").on(table.purchaseOrderId),
    typeIdx: index("idx_exchange_txn_type").on(table.type),
    custodyScopeIdx: index("idx_exchange_custody_scope").on(
      table.exchangeHouseId,
      table.branchId,
      table.status,
      table.currency,
      table.type,
      table.id,
    ),
  }),
);
export type ExchangeTransaction = typeof exchangeTransactions.$inferSelect;
export type InsertExchangeTransaction =
  typeof exchangeTransactions.$inferInsert;

/** دفعة ترحيل: تسوية تحصيلات جهة التوصيل (خصم الأجرة وتوريد الصافي — D8). */
export const deliveryRemittances = mysqlTable(
  "deliveryRemittances",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    remittanceNumber: varchar("remittanceNumber", { length: 50 })
      .notNull()
      .unique(), // DR-{branch}-{YYYYMMDD}-{seq}
    // كشف شركة التوصيل (١٩/٨، هجرة 0212) — مستند الشركة الذي قاد هذه التسوية.
    // رقمه **فريدٌ لكل جهة** (فهرس uq_remittance_party_statement): إعادة إدخال نفس الكشف
    // ترتدّ على القيد بدل أن تضاعف القيود. NULL = توريدٌ يدويّ بلا كشف (السلوك القديم).
    companyStatementNumber: varchar("companyStatementNumber", { length: 64 }),
    statementDate: date("statementDate"),
    /** صورة/PDF الكشف — الدليل المستنديّ الذي يُراجَع عند أي خلاف. */
    statementAttachmentUrl: text("statementAttachmentUrl"),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    partyId: bigint("partyId", { mode: "number" })
      .notNull()
      .references(() => deliveryParties.id),
    // الوردية التي استلمت صافي النقد (RECEPTION/RETAIL) — يُحدَّد عبر shiftIdForCashTx.
    shiftId: bigint("shiftId", { mode: "number" }).references(() => shifts.id),
    collectedTotal: decimal("collectedTotal", {
      precision: 15,
      scale: 2,
    }).notNull(), // Σ المُحصَّل (COD)
    feesTotal: decimal("feesTotal", { precision: 15, scale: 2 })
      .default("0")
      .notNull(), // Σ الأجور (مستحقات الجهة)
    /**
     * Σ استقطاعات الشركة على الكشف (أجور توصيل حسمتها من الحصيلة قبل التوريد).
     * **مصروف شركةٍ مستقلّ لا تخفيضُ ذمّة عميل** — الزبون دفع كامل COD، والشركة احتفظت
     * بأجرتها؛ خصمُها من ذمّة العميل كان سيُسقط إيراداً لم يسقط. مرآةُ قرار الشحن/الكمرك.
     */
    deductionsTotal: decimal("deductionsTotal", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    netRemitted: decimal("netRemitted", { precision: 15, scale: 2 }).notNull(), // collectedTotal − feesTotal
    /**
     * Slice H (٢٩/٨/٢٦، هجرة 0288) — عمولة المندوب المحسوبة بحسب قاعدة `courierCommissionRules`
     * الفعّالة (FLAT_PER_DELIVERY افتراضياً). تُخزَّن لغرض العرض والمقارنة مع `feesTotal` — لا تُحرِّك
     * التدفّق النقديّ الحاليّ. NULL حين لا قاعدةَ فعّالةٌ للجهة (السلوك السابق).
     */
    courierCommissionAmount: decimal("courierCommissionAmount", { precision: 15, scale: 2 }),
    shortfallTotal: decimal("shortfallTotal", { precision: 15, scale: 2 })
      .default("0")
      .notNull(), // عجز يبقى عهدة (D4)
    // إيصالا الدرج: IN=collectedTotal (نقد كامل) + OUT=feesTotal (مصروف توصيل) ⇒ صافي الدرج = netRemitted.
    receiptInId: bigint("receiptInId", { mode: "number" }).references(
      () => receipts.id,
    ),
    receiptOutId: bigint("receiptOutId", { mode: "number" }).references(
      () => receipts.id,
    ),
    status: mysqlEnum("deliveryRemittanceStatus", [
      "BALANCED",
      "SHORT",
      "OVER",
    ]).notNull(),
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
    consignmentNumber: varchar("consignmentNumber", { length: 50 })
      .notNull()
      .unique(), // CN-{branch}-{YYYYMMDD}-{seq}
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    partyId: bigint("partyId", { mode: "number" })
      .notNull()
      .references(() => deliveryParties.id),
    invoiceId: bigint("invoiceId", { mode: "number" })
      .notNull()
      .references(() => invoices.id),
    workOrderId: bigint("workOrderId", { mode: "number" }),
    sourceType: mysqlEnum("sourceType", [
      "WORK_ORDER",
      "ONLINE_ORDER",
      "INVOICE",
    ])
      .default("INVOICE")
      .notNull(),
    sourceId: bigint("sourceId", { mode: "number" }).notNull(),
    // A company may have many portal users; a parcel can be narrowed to one
    // driver while managers/accountants retain party-wide visibility.
    assignedUserId: int("assignedUserId").references(() => users.id),
    // العميل النهائي (المستلم). فاتورة أمر الشغل تبقى منسوبةً للعميل، وجهة التوصيل تحمل العهدة.
    endCustomerId: bigint("endCustomerId", { mode: "number" }).references(
      () => customers.id,
    ),
    codAmount: decimal("codAmount", { precision: 15, scale: 2 }).notNull(), // المطلوب تحصيله = total − deposit
    collectedAmount: decimal("collectedAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // ٢٢/٨ (0249) — ما سدّده الزبون **بالكاونتر** بعد ثبوت التسليم (كشف شركةٍ جزئيّ ثم جاء
    // الزبون للمحل): يُنقص المتبقّي المتوقَّع من الجهة بلا رفع عهدتها — النقد لم يمرّ بيدها.
    // المتبقّي الحيّ للإرسالية = codAmount − collectedAmount − counterSettledAmount.
    counterSettledAmount: decimal("counterSettledAmount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    deliveryFee: decimal("deliveryFee", { precision: 15, scale: 2 })
      .default("0")
      .notNull(), // أجرة ثابتة لكل طلب (D7)
    // ٥/٨ — مَن قبض الأجرة (مرآة workOrders.deliveryFeeCollection، تُثبَّت لحظة الإرسال):
    //   COURIER ⇒ الأجرة خارج codAmount وخارج دفترنا كلّياً (يقبضها المندوب من الزبون).
    //   COUNTER ⇒ قُبضت في الدرج أمانةً ⇒ تُخصَم من صافي التوريد (تُبرَّأ الأمانة، بلا مصروف).
    //   SHOP    ⇒ المكتبة تتحمّلها ⇒ تُخصَم من التوريد **كمصروف** حقيقيّ (السلوك القديم).
    feeCollection: mysqlEnum("consignmentFeeCollection", [
      "COURIER",
      "COUNTER",
      "SHOP",
    ])
      .default("COURIER")
      .notNull(),
    // ختم تسوية الأجرة: يُضبَط حين تُدفَع للمندوب لحظة الإرسال (COUNTER — النقد بالدرج أصلاً،
    // أو أيّ حالةٍ بلا COD يُنتظَر). وجودُه يمنع خصمها ثانيةً من التوريد ⇒ لا صرفَ مزدوج.
    feeSettledAt: timestamp("feeSettledAt"),
    recipientName: varchar("recipientName", { length: 255 }),
    recipientPhone: varchar("recipientPhone", { length: 20 }),
    deliveryAddress: text("deliveryAddress"),
    governorate: varchar("governorate", { length: 40 }),
    latitude: decimal("latitude", { precision: 10, scale: 7 }),
    longitude: decimal("longitude", { precision: 10, scale: 7 }),
    parcelStatus: mysqlEnum("parcelStatus", [
      "ASSIGNED",
      "ACCEPTED",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "FAILED",
      "CANCELLED",
      "RETURNED",
    ])
      .default("ASSIGNED")
      .notNull(),
    moneyStatus: mysqlEnum("moneyStatus", [
      "NOT_APPLICABLE",
      "UNSETTLED",
      "PARTIAL",
      "SETTLED",
      "CANCELLED",
      "WRITTEN_OFF",
    ])
      .default("UNSETTLED")
      .notNull(),
    status: mysqlEnum("consignmentStatus", [
      "DISPATCHED",
      "DELIVERED",
      "PARTIAL",
      "CANCELLED",
      "RETURNED",
      "WRITTEN_OFF",
    ])
      .default("DISPATCHED")
      .notNull(),
    remittanceId: bigint("remittanceId", { mode: "number" }).references(
      () => deliveryRemittances.id,
    ),
    dispatchedBy: int("dispatchedBy").references(() => users.id),
    dispatchedAt: timestamp("dispatchedAt").defaultNow().notNull(),
    acceptedAt: timestamp("acceptedAt"),
    pickedUpAt: timestamp("pickedUpAt"),
    outForDeliveryAt: timestamp("outForDeliveryAt"),
    settledAt: timestamp("settledAt"),
    // ٨/٨ — ختمُ تسليم المندوب الذاتيّ (شاشة «توصيلاتي») لإرساليات الاستقبال: إفصاحٌ تشغيليّ
    // بحت («المندوب يقول: سلّمتُ»). لا يمسّ status/collectedAmount/remittanceId/settledAt/العهدة/
    // الدفتر — المال يُسوَّى عند توريد المندوب (recordDeliveryRemittance) كما هو دون تغيير.
    courierDeliveredAt: timestamp("courierDeliveredAt"),
    // Null until the COD is recognized as cash in the courier's custody.
    // Legacy rows receive a cut-over stamp to avoid charging the same cash a
    // second time when their physical-delivery evidence is added later.
    custodyRecognizedAt: timestamp("custodyRecognizedAt"),
    failedAt: timestamp("failedAt"),
    failureReason: varchar("failureReason", { length: 500 }),
    /**
     * **المرتجعُ المُعلَن** (0246): الشركةُ أعلنت أنّ الطرد راجعٌ إلينا — **ولم يصل بعد**.
     * يُغلق توقّعَ التحصيل وحده؛ والمخزونُ والفاتورةُ والعربون تنتظر الاستلامَ والفحص
     * (`returnConsignment`). ⛔ ليست قيمةَ `parcelStatus` عمداً: القيمةُ الجديدة تُعمي كلّ
     * حارسٍ يقارن الحالة صامتاً — والطردُ يبقى `DISPATCHED` لأنّه حيٌّ فعلاً.
     */
    returnDeclaredAt: timestamp("returnDeclaredAt"),
    returnDeclaredBy: int("returnDeclaredBy").references(() => users.id),
    returnDeclaredReason: varchar("returnDeclaredReason", { length: 500 }),
    cancelledAt: timestamp("cancelledAt"),
    cancellationReason: varchar("cancellationReason", { length: 500 }),
    cancelledBy: int("cancelledBy").references(() => users.id),
    returnedAt: timestamp("returnedAt"),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    numberIdx: index("idx_consignment_number").on(table.consignmentNumber),
    partyStatusIdx: index("idx_consignment_party_status").on(
      table.partyId,
      table.status,
    ),
    branchIdx: index("idx_consignment_branch").on(table.branchId),
    remittanceIdx: index("idx_consignment_remittance").on(table.remittanceId),
    // اِستقبال (تكامل التوصيل، ٤/٨): يربط أوامر الشغل بإرساليّاتها — كان العمود مكتوباً فقط
    // بلا فهرس، وصار الآن مقروءاً بانتظام (LEFT JOIN من قائمة أوامر الشغل).
    workOrderIdx: index("idx_consignment_workorder").on(table.workOrderId),
    sourceUq: unique("uq_consignment_source").on(
      table.sourceType,
      table.sourceId,
    ),
    parcelQueueIdx: index("idx_consignment_parcel_queue").on(
      table.partyId,
      table.parcelStatus,
      table.assignedUserId,
    ),
    moneyQueueIdx: index("idx_consignment_money_queue").on(
      table.partyId,
      table.moneyStatus,
    ),
    // حارس بنيوي: فاتورة واحدة ⇒ إرسالية واحدة (لا ازدواج عهدة على نفس البيع).
    invoiceUq: unique("uq_consignment_invoice").on(table.invoiceId),
  }),
);
export type DeliveryConsignment = typeof deliveryConsignments.$inferSelect;
export type InsertDeliveryConsignment =
  typeof deliveryConsignments.$inferInsert;

/** Immutable allocation of one remittance to one consignment. */
export const deliveryRemittanceLines = mysqlTable(
  "deliveryRemittanceLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    remittanceId: bigint("remittanceId", { mode: "number" })
      .notNull()
      .references(() => deliveryRemittances.id, { onDelete: "cascade" }),
    consignmentId: bigint("consignmentId", { mode: "number" })
      .notNull()
      .references(() => deliveryConsignments.id),
    grossApplied: decimal("grossApplied", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    feeOffset: decimal("feeOffset", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    cashReceived: decimal("cashReceived", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    writtenOffAmount: decimal("writtenOffAmount", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    legacySnapshot: boolean("legacySnapshot").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    allocationUq: unique("uq_delivery_remittance_line").on(
      table.remittanceId,
      table.consignmentId,
    ),
    consignmentIdx: index("idx_delivery_remittance_line_cn").on(
      table.consignmentId,
      table.createdAt,
    ),
  }),
);
export type DeliveryRemittanceLine =
  typeof deliveryRemittanceLines.$inferSelect;

/**
 * Rebuildable operational ledger.  Amounts are positive; entryType defines
 * their meaning. currentBalance is retained only as a checked cache.
 */
export const deliveryLedgerEntries = mysqlTable(
  "deliveryLedgerEntries",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    eventKey: varchar("eventKey", { length: 160 }).notNull().unique(),
    partyId: bigint("partyId", { mode: "number" })
      .notNull()
      .references(() => deliveryParties.id),
    consignmentId: bigint("consignmentId", { mode: "number" }).references(
      () => deliveryConsignments.id,
    ),
    remittanceId: bigint("remittanceId", { mode: "number" }).references(
      () => deliveryRemittances.id,
    ),
    // Legacy shared-party balances may not be attributable to one branch.
    // Every new operational entry is still written with its source branch.
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    entryType: mysqlEnum("entryType", [
      "COD_ASSIGNED",
      "COD_COLLECTED",
      "COD_REMITTED",
      "COD_RELEASED",
      "COD_WRITTEN_OFF",
      "COD_RECOVERED",
      // Slice DFP1 (٣٠/٨/٢٦، هجرة 0295): عجزُ التحصيل ذمّةٌ فوريّة على المندوب — رافعٌ لعهدة
      // الجهة تماماً كـCOD_COLLECTED، لكن مع إلزامِ `shortfallReason` أدناه.
      "SHORTFALL_ASSIGNED",
      "FEE_EARNED",
      "FEE_PAID",
      "FEE_OFFSET",
      "FEE_REFUNDED",
    ]).notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    /**
     * Slice DFP1 (٣٠/٨/٢٦، هجرة 0295) — سببُ العجز حين entryType='SHORTFALL_ASSIGNED'.
     * قيمُه من `shared/shortfallReason.ts` (enum ثابت)، وإلّا NULL. لا نصّ حرّ — القيمة
     * يحرسها الخادم عبر `isShortfallReason` قبل الإدراج، ويعرضها الكشف بتسميةٍ عربية.
     */
    shortfallReason: varchar("shortfallReason", { length: 60 }),
    notes: varchar("notes", { length: 500 }),
    createdBy: int("createdBy").references(() => users.id),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    partyTimeIdx: index("idx_delivery_ledger_party_time").on(
      table.partyId,
      table.occurredAt,
    ),
    consignmentIdx: index("idx_delivery_ledger_cn").on(table.consignmentId),
    remittanceIdx: index("idx_delivery_ledger_remit").on(table.remittanceId),
    shortfallReasonIdx: index("idx_delivery_ledger_shortfall_reason").on(
      table.shortfallReason,
    ),
  }),
);
export type DeliveryLedgerEntry = typeof deliveryLedgerEntries.$inferSelect;

/** Mandatory transition history for chain-of-custody reconstruction. */
export const deliveryEvents = mysqlTable(
  "deliveryEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    eventKey: varchar("eventKey", { length: 160 }).notNull().unique(),
    consignmentId: bigint("consignmentId", { mode: "number" })
      .notNull()
      .references(() => deliveryConsignments.id),
    eventType: varchar("eventType", { length: 60 }).notNull(),
    fromParcelStatus: varchar("fromParcelStatus", { length: 30 }),
    toParcelStatus: varchar("toParcelStatus", { length: 30 }),
    fromMoneyStatus: varchar("fromMoneyStatus", { length: 30 }),
    toMoneyStatus: varchar("toMoneyStatus", { length: 30 }),
    payload: json("payload"),
    actorUserId: int("actorUserId").references(() => users.id),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  },
  (table) => ({
    consignmentTimeIdx: index("idx_delivery_event_cn_time").on(
      table.consignmentId,
      table.occurredAt,
    ),
  }),
);
export type DeliveryEvent = typeof deliveryEvents.$inferSelect;

/** Transactional outbox row written beside every delivery event. */
export const deliveryOutbox = mysqlTable(
  "deliveryOutbox",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    eventId: bigint("eventId", { mode: "number" })
      .notNull()
      .references(() => deliveryEvents.id, { onDelete: "cascade" }),
    topic: varchar("topic", { length: 100 }).notNull(),
    payload: json("payload").notNull(),
    attempts: int("attempts").default(0).notNull(),
    availableAt: timestamp("availableAt").defaultNow().notNull(),
    processedAt: timestamp("processedAt"),
    lastError: varchar("lastError", { length: 500 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    /**
     * حالةُ الصفّ (Tier-1 #1، ٢٥/٨): PENDING = مُتاحٌ للسحب؛ DEAD_LETTER = مستنفَدٌ (attempts
     * تجاوز الحدّ) لا يُعاد سحبه بلا إعادة تفعيلٍ إداريّة. قبل هذه الهجرة كان صفٌّ سامٌّ يُعاد
     * كلّ ٥ دقائق للأبد بلا تصعيد — الحلقةُ صامتةٌ على الإنتاج.
     */
    status: mysqlEnum("status", ["PENDING", "DEAD_LETTER"]).default("PENDING").notNull(),
    /** لحظة النقل إلى DEAD_LETTER — للتقرير + للاسترجاع الإداريّ. NULL طالما PENDING. */
    deadLetteredAt: timestamp("deadLetteredAt"),
  },
  (table) => ({
    pendingIdx: index("idx_delivery_outbox_pending").on(
      table.processedAt,
      table.availableAt,
    ),
    // فهرسٌ ضيّق للمسح الإداريّ للـDEAD_LETTER — أفضل من فحصٍ عبر (processedAt IS NULL).
    statusIdx: index("idx_delivery_outbox_status").on(table.status),
  }),
);
export type DeliveryOutboxRow = typeof deliveryOutbox.$inferSelect;

/**
 * سجلّ أحداث دورة حياة أمر الشغل (Slice 6، ٢٨/٨/٢٦، هجرة 0278).
 *
 * تعميمُ النموذج المرجعيّ `deliveryEvents` على أمر الشغل — المحور ١ من تدقيق ٢٨/٨/٢٦:
 * كان `workOrderRouter.timeline` يقرأ من `auditLogs` وحده، وهو سجلٌّ عامٌّ بأعمدة JSON
 * (`oldValue`/`newValue`) صعبةِ الاستعلام والفهرسة. `workOrderEvents` يُضاف كطبقةٍ ثانيةٍ
 * منظَّمة: `fromStatus`/`toStatus` أعمدةٌ مُنمَّطة قابلة للفلترة والفهرسة، و`eventKey`
 * فريدٌ يمنع الازدواج (idempotency على مستوى القاعدة).
 *
 * **Dual-write أثناء الفترة الانتقاليّة:** المسارات الحاليّة تبقى تكتب `logAuditTx` (لا كسر
 * لـtimeline القائم)، وتضيف `recordWorkOrderEvent` على التوازي. بمرور الوقت وبعد إثبات
 * موثوقيّة السجلّ الجديد، يمكن الاستغناء عن الكتابة المزدوجة.
 *
 * **الفرق عن deliveryEvents:** كيانٌ مختلف (workOrder بدل consignment)، والحالة واحدةٌ
 * (status) لا اثنتان (parcelStatus/moneyStatus).
 */
export const workOrderEvents = mysqlTable(
  "workOrderEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /**
     * مفتاحٌ فريدٌ لكلّ حدث — يمنع الازدواج على مستوى القاعدة. الاصطلاح:
     * `wo:<workOrderId>:<eventType>:<seq?>` — seq اختياريّ للأحداث التي قد تتكرّر
     * (assign/release/materials-update). للأحداث الأحاديّة (start/markReady/deliver/cancel)
     * لا حاجة لـseq.
     */
    eventKey: varchar("eventKey", { length: 160 }).notNull().unique(),
    workOrderId: bigint("workOrderId", { mode: "number" })
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    /** نوع الحدث (مطابق لـ`shared/workOrderEventType.ts` — enumerated للاستقرار). */
    eventType: varchar("eventType", { length: 60 }).notNull(),
    /** انتقالُ الحالة الاختياريّ (null للأحداث بلا نقلةٍ كـassign/materials-update). */
    fromStatus: varchar("fromStatus", { length: 30 }),
    toStatus: varchar("toStatus", { length: 30 }),
    /** حمولة إضافيّة للحدث (مواد، أسباب، مبالغ، مستندات مرجعيّة). */
    payload: json("payload"),
    actorUserId: int("actorUserId").references(() => users.id),
    /** الفرع لأثرِ العزل التقريريّ — بدونه استعلامات الأعمار تحتاج JOIN مع workOrders. */
    branchId: bigint("branchId", { mode: "number" }),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  },
  (table) => ({
    workOrderTimeIdx: index("idx_wo_event_wo_time").on(
      table.workOrderId,
      table.occurredAt,
    ),
    eventTypeIdx: index("idx_wo_event_type").on(table.eventType),
  }),
);
export type WorkOrderEvent = typeof workOrderEvents.$inferSelect;

/**
 * طلبات التحكم الإداري/التشغيلي بأوامر الشغل (0298).
 *
 * الصف المعلّق صفرُ أثر: لا يغيّر الأمر ولا المخزون ولا النقد. الاعتماد وحده، داخل معاملة
 * واحدة وبعد مطابقة baseVersion وpayloadHash، يطبّق التغيير. لا حذف؛ القرار append-only
 * عبر حالة نهائية وحقول المراجع.
 */
export const workOrderControlRequests = mysqlTable(
  "workOrderControlRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 }).notNull().unique(),
    workOrderId: bigint("workOrderId", { mode: "number" })
      .notNull()
      .references(() => workOrders.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    requestType: mysqlEnum("requestType", [
      "COMMERCIAL_EDIT",
      "MATERIAL_ADJUST",
      "CANCEL",
      "REVERSE_DELIVERY",
    ]).notNull(),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "STALE"])
      .default("PENDING")
      .notNull(),
    baseVersion: int("baseVersion").notNull(),
    payload: json("payload").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    requestedBy: int("requestedBy").notNull().references(() => users.id),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    reviewNote: varchar("reviewNote", { length: 500 }),
    appliedAt: timestamp("appliedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    workOrderStatusIdx: index("idx_wo_control_work_status").on(table.workOrderId, table.status),
    branchStatusIdx: index("idx_wo_control_branch_status").on(table.branchId, table.status),
    requesterIdx: index("idx_wo_control_requester").on(table.requestedBy),
    reviewerIdx: index("idx_wo_control_reviewer").on(table.reviewedBy),
    decisionShape: check(
      "chk_wo_control_decision_shape",
      sql`(
        (${table.status} = 'PENDING' AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.appliedAt} IS NULL)
        OR (${table.status} = 'APPROVED' AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.appliedAt} IS NOT NULL)
        OR (${table.status} IN ('REJECTED','STALE') AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.appliedAt} IS NULL)
      )`,
    ),
    makerChecker: check(
      "chk_wo_control_maker_checker",
      sql`(${table.reviewedBy} IS NULL OR ${table.reviewedBy} <> ${table.requestedBy})`,
    ),
  }),
);

export type WorkOrderControlRequest = typeof workOrderControlRequests.$inferSelect;

/**
 * نسخة تصميم مستقلة عن وجود الصور: حتى التصميم النصي أو حذف كل الصور يبقى نسخة قابلة
 * للبصم والاعتماد. صور workOrderImages تحمل رقم revision نفسه، بينما هذا الصف هو رأس النسخة.
 */
export const workOrderDesignRevisions = mysqlTable(
  "workOrderDesignRevisions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    workOrderId: bigint("workOrderId", { mode: "number" }).notNull().references(() => workOrders.id),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    revision: int("revision").notNull(),
    customizationSnapshot: text("customizationSnapshot"),
    contentHash: char("contentHash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    createdBy: int("createdBy").notNull().references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    workRevisionUq: unique("uq_wo_design_revision").on(table.workOrderId, table.revision),
    branchTimeIdx: index("idx_wo_design_revision_branch_time").on(table.branchId, table.createdAt),
    creatorIdx: index("idx_wo_design_revision_creator").on(table.createdBy),
  }),
);
export type WorkOrderDesignRevision = typeof workOrderDesignRevisions.$inferSelect;

/** طلب اعتماد نسخة تصميم محددة؛ القرار لا يُنقل إلى نسخة لاحقة وتفصل القيود الطالب عن المراجع. */
export const workOrderDesignApprovals = mysqlTable(
  "workOrderDesignApprovals",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 }).notNull().unique(),
    workOrderId: bigint("workOrderId", { mode: "number" }).notNull().references(() => workOrders.id),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    revisionId: bigint("revisionId", { mode: "number" }).notNull(),
    taskId: bigint("taskId", { mode: "number" }).references(() => tasks.id),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "SUPERSEDED"]).default("PENDING").notNull(),
    requestedBy: int("requestedBy").notNull().references(() => users.id),
    requestNote: varchar("requestNote", { length: 500 }),
    decisionKey: varchar("decisionKey", { length: 120 }).unique(),
    decisionHash: char("decisionHash", { length: 64 }),
    decisionReason: varchar("decisionReason", { length: 500 }),
    evidenceType: mysqlEnum("evidenceType", ["WHATSAPP_MESSAGE", "CUSTOMER_SIGNATURE", "EMAIL", "ATTACHMENT", "OTHER"]),
    evidenceReference: varchar("evidenceReference", { length: 500 }),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    revisionUq: unique("uq_wo_design_approval_revision").on(table.revisionId),
    workStatusIdx: index("idx_wo_design_approval_work_status").on(table.workOrderId, table.status),
    branchStatusIdx: index("idx_wo_design_approval_branch_status").on(table.branchId, table.status),
    taskIdx: index("idx_wo_design_approval_task").on(table.taskId),
    requesterIdx: index("idx_wo_design_approval_requester").on(table.requestedBy),
    reviewerIdx: index("idx_wo_design_approval_reviewer").on(table.reviewedBy),
    revisionFk: foreignKey({
      name: "fk_wo_design_approval_revision",
      columns: [table.revisionId],
      foreignColumns: [workOrderDesignRevisions.id],
    }),
    decisionShape: check(
      "chk_wo_design_approval_decision",
      sql`(
        (${table.status} = 'PENDING' AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.decisionKey} IS NULL AND ${table.decisionHash} IS NULL)
        OR (${table.status} IN ('APPROVED','REJECTED') AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionKey} IS NOT NULL AND ${table.decisionHash} IS NOT NULL AND ${table.decisionReason} IS NOT NULL AND ${table.evidenceType} IS NOT NULL AND ${table.evidenceReference} IS NOT NULL)
        OR (${table.status} = 'SUPERSEDED' AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL)
      )`,
    ),
    makerChecker: check(
      "chk_wo_design_approval_maker_checker",
      sql`(${table.reviewedBy} IS NULL OR ${table.reviewedBy} <> ${table.requestedBy})`,
    ),
  }),
);
export type WorkOrderDesignApproval = typeof workOrderDesignApprovals.$inferSelect;

/**
 * سجلّ أحداث الفاتورة (Slice 9، ٢٨/٨/٢٦، هجرة 0281) — مرآةُ `workOrderEvents`.
 *
 * الفاتورةُ تعبُر مسار حياتها بأحداثٍ متعدّدة: إنشاء، تعديل، تصحيح (SUPERSEDED)، إلغاء،
 * مرتجع، سداد. اليوم مسارُ auditLogs يعرض بعضها، لكنّه مبعثرٌ بلا `fromStatus/toStatus`
 * مُنمَّطة. هذا السجلّ يوفّر الطبقة الثانية المنظَّمة (كنمط deliveryEvents).
 *
 * **Dual-write:** كسائر السجلّات الجديدة — المسارات الحرِجة تكتب هنا بالتوازي مع
 * السلوك القائم بلا كسر.
 */
export const invoiceEvents = mysqlTable(
  "invoiceEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** `inv:<invoiceId>:<eventType>[:<seq>]` — نفس اصطلاح workOrderEvents. */
    eventKey: varchar("eventKey", { length: 160 }).notNull().unique(),
    invoiceId: bigint("invoiceId", { mode: "number" })
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    eventType: varchar("eventType", { length: 60 }).notNull(),
    fromStatus: varchar("fromStatus", { length: 30 }),
    toStatus: varchar("toStatus", { length: 30 }),
    payload: json("payload"),
    actorUserId: int("actorUserId").references(() => users.id),
    branchId: bigint("branchId", { mode: "number" }),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  },
  (table) => ({
    invoiceTimeIdx: index("idx_invoice_event_inv_time").on(
      table.invoiceId,
      table.occurredAt,
    ),
    eventTypeIdx: index("idx_invoice_event_type").on(table.eventType),
  }),
);
export type InvoiceEvent = typeof invoiceEvents.$inferSelect;

/**
 * مناطق التوصيل (Slice 7، ٢٨/٨/٢٦، هجرة 0279) — يُنقل التسعير من ثابتٍ في الكود
 * (`shared/governorates.ts`) إلى **بيانات محكومة** يعدّلها المدير بلا نشر.
 *
 * البذرة: ١٨ محافظة عراقية بنفس الأجرة التقديريّة القائمة — لا كسر للسلوك الحاليّ.
 * المصدر يبقى `shared/governorates.ts` كـfallback حتى تُملأ الجداول (backwards-compat).
 */
export const deliveryZones = mysqlTable(
  "deliveryZones",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** رمزٌ مستقرٌّ (مثل `baghdad`/`basra`) — يُطابق `Governorate.id` للربط بلا اجتهاد. */
    code: varchar("code", { length: 60 }).notNull().unique(),
    name: varchar("name", { length: 120 }).notNull(),
    /**
     * الفرعُ المفضَّل الذي يخدم هذه المنطقة (اختياريّ). إن كان `null` تعني: كلّ الفروع.
     * يُستعمل مستقبلاً لتوجيه الطلب للفرع الأقرب.
     */
    preferredBranchId: bigint("preferredBranchId", { mode: "number" }),
    isActive: boolean("isActive").default(true).notNull(),
    displayOrder: int("displayOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
);
export type DeliveryZone = typeof deliveryZones.$inferSelect;

/**
 * قواعد تسعير التوصيل (Slice 7، ٢٨/٨/٢٦، هجرة 0279).
 *
 * صفٌّ لكلّ (zoneId × ruleType) — الحدّ الأدنى FLAT_FEE فقط في هذه الشريحة، يمكن إضافة
 * PER_KM/WEIGHT_TIER لاحقاً بلا كسر (varchar بدل enum مُغلَق).
 *
 * ⚠️ **حبيبة السعر:** بالدينار العراقي **الصحيح** (لا كسور — قرار المالك ٦/٨/٢٦: تقريب
 * نقديّ ٢٥٠). العمود decimal(15,2) للتوافق مع تنسيق المال الحاليّ، القيم عمليّاً صحيحة.
 */
export const deliveryPricingRules = mysqlTable(
  "deliveryPricingRules",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    zoneId: bigint("zoneId", { mode: "number" })
      .notNull()
      .references(() => deliveryZones.id, { onDelete: "cascade" }),
    ruleType: varchar("ruleType", { length: 30 }).default("FLAT_FEE").notNull(),
    /** الأجرة الأساس. مطلوبةٌ لكلّ ruleType (حتى PER_KM يبدأ من `baseFee` ثمّ يزيد). */
    baseFee: decimal("baseFee", { precision: 15, scale: 2 }).notNull(),
    /** ⚙️ حقولٌ اختياريّة لتوسّعٍ مستقبليّ (PER_KM: perKmFee؛ WEIGHT: perKgFee). */
    perKmFee: decimal("perKmFee", { precision: 15, scale: 2 }),
    perKgFee: decimal("perKgFee", { precision: 15, scale: 2 }),
    minFee: decimal("minFee", { precision: 15, scale: 2 }),
    maxFee: decimal("maxFee", { precision: 15, scale: 2 }),
    isActive: boolean("isActive").default(true).notNull(),
    /** فرعُ المصدر إن كان التسعير مختلفاً بحسب فرع البدء. `null` = كلّ الفروع. */
    branchId: bigint("branchId", { mode: "number" }),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    zoneIdx: index("idx_delivery_pricing_zone").on(table.zoneId, table.isActive),
  }),
);
export type DeliveryPricingRule = typeof deliveryPricingRules.$inferSelect;

/**
 * قواعدُ عمولة جهة التوصيل (Slice 8، ٢٨/٨/٢٦، هجرة 0280) — الغرض:
 *
 * كان تسعير عمولة المندوب/الشركة يجري باجتهاد التسوية اليدويّة (deliveryLedgerEntries) —
 * لا قاعدةٌ صريحةٌ محكومة. الآن جدولٌ مصدرُ الحقيقة لكيفيّة حساب العمولة لكلّ جهة (أو
 * افتراضيّاً بلا partyId ⇒ يُطبَّق على كلّ الجهات التي لا قاعدةَ خاصّةً لها).
 *
 * **الأنماط المدعومة الآن:**
 *   • `FLAT_PER_DELIVERY`  — مبلغٌ ثابتٌ لكلّ إرساليّة (أشيع نموذج في العراق).
 *   • `PERCENT_OF_FEE`     — نسبةٌ من أجرة التوصيل نفسها (إذا كانت الأجرة عالية).
 *   • `PERCENT_OF_ORDER`   — نسبةٌ من قيمة الطلب المُحصَّل (نموذج «التاكسي التسليم»).
 *   • `HYBRID`             — الأنسب: ثابتٌ + نسبة.
 *
 * ⚠️ **صفر أثرٍ ماليّ في هذه الشريحة** — هذا الأساسُ فقط. الاستهلاك (auto-posting +
 * auto-settlement عند إغلاق الوردية) يأتي في شريحةٍ لاحقة بعد قرارٍ صريحٍ من المالك
 * على نموذج العمولة الأنسب لعملياته.
 */
export const courierCommissionRules = mysqlTable(
  "courierCommissionRules",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** الجهةُ المخصَّصة. `null` = قاعدةٌ افتراضيّةٌ لكلّ الجهات (يُطبَّق حين لا قاعدةَ خاصّة). */
    partyId: bigint("partyId", { mode: "number" }).references(() => deliveryParties.id, {
      onDelete: "cascade",
    }),
    ruleType: varchar("ruleType", { length: 30 }).notNull(),
    /** المبلغُ الثابت لكلّ إرساليّة (يُقرأ بـFLAT_PER_DELIVERY و HYBRID). */
    flatAmount: decimal("flatAmount", { precision: 15, scale: 2 }),
    /** نسبة العمولة (0-100). يُقرأ بـPERCENT_OF_FEE و PERCENT_OF_ORDER و HYBRID. */
    percentValue: decimal("percentValue", { precision: 5, scale: 2 }),
    /** حدٌّ أدنى مضمون للمندوب (كلَّ إرساليّة). حِمايةً للمندوب في السلال الصغيرة. */
    minGuarantee: decimal("minGuarantee", { precision: 15, scale: 2 }),
    /** حدٌّ أعلى لكلّ إرساليّة. حِمايةً للمكتبة في الطلبات الكبيرة. */
    maxCap: decimal("maxCap", { precision: 15, scale: 2 }),
    isActive: boolean("isActive").default(true).notNull(),
    /** الفرع الذي تسري عليه القاعدة. `null` = كلّ الفروع. */
    branchId: bigint("branchId", { mode: "number" }),
    effectiveFrom: timestamp("effectiveFrom"),
    effectiveTo: timestamp("effectiveTo"),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    partyIdx: index("idx_courier_commission_party").on(table.partyId, table.isActive),
  }),
);
export type CourierCommissionRule = typeof courierCommissionRules.$inferSelect;

/** إعدادات الضريبة (صفّ singleton واحد id=1): افتراضي تفعيل الضريبة على الفاتورة الجديدة +
 *  نسبتها + الرقم الضريبي للشركة (يُطبَع على الفاتورة). العراق VAT=0% افتراضياً — enabledByDefault
 *  يبقى false ما لم يُفعِّله المدير صراحةً. يُنشَأ الصفّ كسولاً (get-or-create) عند أول قراءة. */
export const taxSettings = mysqlTable("taxSettings", {
  id: int("id").autoincrement().primaryKey(),
  enabledByDefault: boolean("enabledByDefault").default(false).notNull(),
  defaultTaxRatePercent: decimal("defaultTaxRatePercent", {
    precision: 5,
    scale: 2,
  })
    .default("0")
    .notNull(),
  taxRegistrationNumber: varchar("taxRegistrationNumber", { length: 50 }),
  updatedBy: int("updatedBy").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type TaxSettings = typeof taxSettings.$inferSelect;
export type InsertTaxSettings = typeof taxSettings.$inferInsert;

/** «وضع الافتتاح» المؤقّت (صفّ singleton واحد id=1، نمط taxSettings): أثناء إدخال النظام للخدمة يُسمح
 *  ببيع الصنف **غير المُفتتَح** (branchStock.openedAt IS NULL) بالسالب نقدياً حتى يُجرَد جرداً افتتاحياً.
 *  حوكمة صلبة (مراجعة عدائية ١٨/٧): التفعيل يشترط endsAt (إلزامي، ≤ ٦٠ يوماً من لحظة التفعيل)، الكتابة
 *  admin فقط + حدثا تدقيق enable/disable، والحارس الفعلي خادميّ لحظة البيع (الواجهة مرآة فقط). */
export const openingModeSettings = mysqlTable("openingModeSettings", {
  id: int("id").autoincrement().primaryKey(),
  enabled: boolean("enabled").default(false).notNull(),
  /** نهاية النافذة — إلزامي منطقياً عند enabled=true (تحقّق خادمي)؛ انقضاؤه = الوضع مطفأ حكماً. */
  endsAt: timestamp("endsAt"),
  /** سقف كمية السطر الواحد النازل بالسالب (بالوحدة الأساس) — يصدّ خطأ الإدخال والاحتيال معاً. */
  maxNegativeQtyPerLine: int("maxNegativeQtyPerLine").default(100).notNull(),
  updatedBy: int("updatedBy").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type OpeningModeSettings = typeof openingModeSettings.$inferSelect;
export type InsertOpeningModeSettings = typeof openingModeSettings.$inferInsert;

/** إعدادات «استوديو صور المنتجات» (صفّ singleton id=1، نمط taxSettings): مسار Pro المدفوع
 *  (remove.bg) — مفتاح API مُشفَّراً (AES-256-GCM عبر cryptoService) + مفتاح تفعيل. عند التعطيل أو
 *  نفاد الرصيد (402) أو تعطّل الخدمة يبقى مسار FLATTEN المجانيّ الآمن هو الافتراضي. المفتاح لا
 *  يُعرَض نصّاً أبداً (قناع فقط، نمط channelIntegrations). أمانة صارمة: remove.bg قصٌّ لا توليد. */
export const imageStudioSettings = mysqlTable("imageStudioSettings", {
  id: int("id").autoincrement().primaryKey(),
  /** تفعيل مسار Pro (remove.bg). معطَّل افتراضياً ⇒ FLATTEN المجانيّ فقط. */
  proEnabled: boolean("proEnabled").default(false).notNull(),
  /** مفتاح remove.bg API مُشفَّراً (صيغة v1:iv:tag:ct) — null=غير مضبوط ⇒ Pro لا يعمل. */
  encryptedRemovebgKey: text("encryptedRemovebgKey"),
  /** آخر فحص اتصال ناجح (للعرض) + آخر خطأ (تشخيص، ≤٥٠٠ حرف). */
  lastVerifiedAt: timestamp("lastVerifiedAt"),
  lastError: varchar("lastError", { length: 500 }),
  // ── مسار الذكاء الاصطناعي (استوديو موحّد بإعادة تصميم من برومت جاهز) — مستقلّ عن remove.bg ──
  //  توليديّ (Gemini/أي مزوّد): يُعيد تصميم صورة المنتج كتصوير استوديو موحّد (خلفية بيضاء + إضاءة
  //  + ظلّ) بحفظ الأصل. لأنّه توليديّ (يعيد رسم البكسلات، بخلاف remove.bg القاصّ) ⇒ مراجعة/اعتماد
  //  بشريّ إلزاميّ قبل استبدال الأصل، والأصل يبقى دائماً. معطَّل افتراضياً. المفتاح مشفَّر مثل remove.bg.
  /** تفعيل مسار الذكاء الاصطناعي. معطَّل افتراضياً. */
  aiEnabled: boolean("aiEnabled").default(false).notNull(),
  /** المزوّد — GEMINI افتراضياً، قابل للتوسّع لمزوّدين آخرين بلا هجرة. */
  aiProvider: varchar("aiProvider", { length: 20 }).default("GEMINI").notNull(),
  /** معرّف النموذج (null ⇒ الافتراضي في الكود، مثل gemini-2.5-flash-image). */
  aiModel: varchar("aiModel", { length: 80 }),
  /** مفتاح مزوّد الذكاء الاصطناعي مُشفَّراً (صيغة v1:iv:tag:ct) — null ⇒ AI لا يعمل. */
  encryptedAiKey: text("encryptedAiKey"),
  /** البرومت الجاهز لاستوديو الذكاء الاصطناعي (null ⇒ الافتراضي المُحصَّن في الكود). */
  aiStudioPrompt: text("aiStudioPrompt"),
  aiLastVerifiedAt: timestamp("aiLastVerifiedAt"),
  aiLastError: varchar("aiLastError", { length: 500 }),
  updatedBy: int("updatedBy").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type ImageStudioSettings = typeof imageStudioSettings.$inferSelect;
export type InsertImageStudioSettings = typeof imageStudioSettings.$inferInsert;

/**
 * عدّاد يومي غير قابل للتجاوز لنداءات مزوّدي استوديو الصور المدفوعة. يُحجز النداء قبل
 * الاتصال الخارجي ولا يُعاد بعده، لأن فشل الشبكة لا يثبت أن المزوّد لم يقتطع رصيداً.
 * هذا هو مصدر الحقيقة للسقف اليومي عبر إعادة تشغيل PM2.
 */
export const imageStudioUsageDaily = mysqlTable(
  "imageStudioUsageDaily",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    usageDate: date("usageDate", { mode: "string" }).notNull(),
    service: mysqlEnum("service", ["REMOVEBG", "AI"]).notNull(),
    requestCount: int("requestCount").default(0).notNull(),
    lastRequestedAt: timestamp("lastRequestedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    dailyServiceUq: unique("uq_image_studio_usage_daily_service").on(
      table.usageDate,
      table.service,
    ),
  }),
);
export type ImageStudioUsageDaily = typeof imageStudioUsageDaily.$inferSelect;
export type InsertImageStudioUsageDaily =
  typeof imageStudioUsageDaily.$inferInsert;

/**
 * سقفٌ يوميّ **اختياريّ** لكل (فرع × خدمة). غياب الصفّ = بلا حدٍّ فرعيّ، فالسقف الشركيّ
 * في `imageStudioUsageDaily` يبقى وحده — صفر أثرٍ سلوكيّ حتى يضبطه المدير صراحةً.
 * مفتاحٌ مركّبٌ طبيعيّ: الصفّ هو (الفرع، الخدمة) ولا معنى لمعرّفٍ بديلٍ له.
 */
export const imageStudioBranchBudgets = mysqlTable(
  "imageStudioBranchBudgets",
  {
    // ⚠️ `branches.id` هو bigint — و`int` هنا يُفشل إنشاء الـFK بـ«أعمدة غير متوافقة».
    branchId: bigint("branchId", { mode: "number" }).notNull(),
    service: mysqlEnum("service", ["REMOVEBG", "AI"]).notNull(),
    dailyLimit: int("dailyLimit").notNull(),
    updatedBy: int("updatedBy"),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.branchId, table.service] }),
    branchFk: foreignKey({
      columns: [table.branchId],
      foreignColumns: [branches.id],
      name: "fk_isbb_branch",
    }).onDelete("cascade"),
  }),
);
export type ImageStudioBranchBudget =
  typeof imageStudioBranchBudgets.$inferSelect;

/** عدّاد الاستهلاك اليوميّ لكل (يوم × خدمة × فرع) — نظير `imageStudioUsageDaily` مُنطَّقاً بالفرع. */
export const imageStudioBranchUsageDaily = mysqlTable(
  "imageStudioBranchUsageDaily",
  {
    usageDate: date("usageDate", { mode: "string" }).notNull(),
    service: mysqlEnum("service", ["REMOVEBG", "AI"]).notNull(),
    branchId: bigint("branchId", { mode: "number" }).notNull(),
    requestCount: int("requestCount").default(0).notNull(),
    lastRequestedAt: timestamp("lastRequestedAt").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.usageDate, table.service, table.branchId],
    }),
    branchFk: foreignKey({
      columns: [table.branchId],
      foreignColumns: [branches.id],
      name: "fk_isbud_branch",
    }).onDelete("cascade"),
  }),
);
export type ImageStudioBranchUsageDaily =
  typeof imageStudioBranchUsageDaily.$inferSelect;

/** صف ثابت لكل مستخدم لمعدل مزودي الصور؛ لا يتراكم مع الطلبات ويُقفل عبر جميع عمال PM2. */
export const imageStudioUserRateState = mysqlTable("imageStudioUserRateState", {
  userId: int("userId")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  windowStartedAt: timestamp("windowStartedAt").notNull(),
  requestCount: int("requestCount").default(0).notNull(),
  lastRequestedAt: timestamp("lastRequestedAt").notNull(),
});
export type ImageStudioUserRateState =
  typeof imageStudioUserRateState.$inferSelect;
export type InsertImageStudioUserRateState =
  typeof imageStudioUserRateState.$inferInsert;

/** شريحة تصاعدية لضريبة الدخل: `upTo` حدّ أعلى للشريحة (سلسلة مالية) أو null للشريحة المفتوحة
 *  العليا («فما فوق»)، `rate` نسبة مئوية (سلسلة). الاحتساب حدّيّ تصاعديّ (كل جزء بنسبة شريحته). */
export type IncomeTaxBracket = { upTo: string | null; rate: string };

/** إعدادات المكوّنات القانونية العراقية للرواتب (صفّ singleton id=1، نمط taxSettings) — البند ④.
 *  ثلاثة مكوّنات كلٌّ بمفتاح تفعيل مستقلّ **معطَّل افتراضياً**: ضمان اجتماعي + ضريبة دخل مستقطعة +
 *  مكافأة نهاية خدمة. **ما لم يُفعَّل المكوّن ⇒ صفر أثر على الرواتب (net/deductions كما هي اليوم).**
 *  ⚠️ النِّسب/الشرائح **إعداداتٌ يضبطها المالك مع محاسبه القانونيّ** — القيم الافتراضية توضيحية فقط
 *  (كلها صفر/معطَّلة ابتداءً). يُنشَأ الصفّ كسولاً (ensure-row) عند أوّل تحديث. هجرة 0098. */
export const payrollLegalSettings = mysqlTable("payrollLegalSettings", {
  id: int("id").autoincrement().primaryKey(),
  // ── الضمان الاجتماعي ───────────────────────────────────────────────────────────
  socialSecurityEnabled: boolean("socialSecurityEnabled")
    .default(false)
    .notNull(),
  /** نسبة حصّة الموظف (٪) — تُخصَم من أجره. توضيحيّ ~٥٪. */
  socialSecurityEmployeeRate: decimal("socialSecurityEmployeeRate", {
    precision: 5,
    scale: 2,
  })
    .default("0")
    .notNull(),
  /** نسبة حصّة رب العمل (٪) — كلفة على الشركة لا تُخصَم من الموظف. توضيحيّ ~١٢٪. */
  socialSecurityEmployerRate: decimal("socialSecurityEmployerRate", {
    precision: 5,
    scale: 2,
  })
    .default("0")
    .notNull(),
  /** وعاء احتساب الضمان: الأساسيّ (الراتب الأساس) أو الإجماليّ (أساسيّ + مخصّصات). */
  socialSecurityBase: mysqlEnum("socialSecurityBase", ["basic", "gross"])
    .default("basic")
    .notNull(),
  // ── ضريبة الدخل المستقطعة ──────────────────────────────────────────────────────
  incomeTaxEnabled: boolean("incomeTaxEnabled").default(false).notNull(),
  /** شرائح تصاعدية قابلة للضبط (قائمة: حدّ + نسبة). null = بلا شرائح مضبوطة بعد. الوعاء الضريبيّ =
   *  الإجماليّ − حصّة الموظف من الضمان − الإعفاء. */
  incomeTaxBrackets: json("incomeTaxBrackets").$type<IncomeTaxBracket[]>(),
  /** إعفاء شخصيّ/عائليّ (مبلغ شهريّ) يُطرح من الوعاء قبل تطبيق الشرائح. */
  incomeTaxExemption: decimal("incomeTaxExemption", { precision: 15, scale: 2 })
    .default("0")
    .notNull(),
  // ── مكافأة نهاية الخدمة (استحقاق متراكم) ───────────────────────────────────────
  endOfServiceEnabled: boolean("endOfServiceEnabled").default(false).notNull(),
  /** عدد أيام آخر راتب المستحقّة **لكل سنة خدمة** (المعدّل اليوميّ = الأساسيّ÷٣٠). الاستحقاق الشهريّ
   *  المتراكم = (أيام × المعدّل اليوميّ) ÷ ١٢. توضيحيّ (مثلاً ٢١). عرض/التزام فقط — لا يُصرَف هنا. */
  endOfServiceDaysPerYear: decimal("endOfServiceDaysPerYear", {
    precision: 6,
    scale: 2,
  })
    .default("0")
    .notNull(),
  updatedBy: int("updatedBy").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type PayrollLegalSettings = typeof payrollLegalSettings.$inferSelect;
export type InsertPayrollLegalSettings =
  typeof payrollLegalSettings.$inferInsert;

/** سجلّ تذكيرات الذمم الآجلة (AR reminders) — كل صفّ = تذكير أُرسِل أو أُخطِّي.
 *  يُملأ حصراً بعد فعل المستخدم في شاشة `/ar-reminders` (لا cron، لا إرسال آلي).
 *  يمنع تكرار التذكير على نفس العميل خلال ٧ أيام (استعلام queue يستبعد من ذُكّر مؤخراً).
 *  snapshots اللحظية (المبلغ + أقدم فاتورة + أيام التأخّر + نص الرسالة) للتدقيق التاريخي. */
export const arReminders = mysqlTable(
  "arReminders",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    customerId: bigint("customerId", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    /** الرصيد الآجل الفعلي (إجمالي غير المسدّد عبر كل الفواتير >٧ أيام) وقت التذكير. */
    totalUnpaidSnapshot: decimal("totalUnpaidSnapshot", {
      precision: 15,
      scale: 2,
    }).notNull(),
    /** أقدم فاتورة غير مدفوعة (DATE، YYYY-MM-DD كنصّ). لحساب أيام التأخّر تاريخياً. */
    oldestInvoiceDate: date("oldestInvoiceDate", { mode: "string" }).notNull(),
    /** عدد أيام تأخّر أقدم فاتورة وقت التذكير (لَـmetadata، لا يُعاد حسابها). */
    daysOverdue: int("daysOverdue").notNull(),
    /** نصّ رسالة الواتساب المرسَلة (بعد sanitizeForWhatsApp) — snapshot للتدقيق. */
    messageBody: text("messageBody").notNull(),
    status: mysqlEnum("arReminderStatus", ["SENT", "SKIPPED"]).notNull(),
    /** سبب التخطّي (nullable — يُملأ فقط عند status='SKIPPED'، مثل «العميل وعد يوم الأحد»). */
    skipReason: varchar("skipReason", { length: 255 }),
    /** تاريخ وعد العميل بالدفع (اختياري، YYYY-MM-DD). حين مُلئ يوم التخطّي ⇒ العميل يُعاد
     *  إظهاره في القائمة يوم الوعد نفسه (يتخطّى تبريد ٧ أيام) بشارة «موعود اليوم»، حتى لو
     *  كان تذكيره الأخير ضمن نافذة التبريد الاعتيادية — يمكن أن يفوّت الموظفُ متابعة الوعد. */
    promisedDate: date("promisedDate", { mode: "string" }),
    /** وسيلة الإرسال: MANUAL (زر شاشة المتابعة القائمة، الوضع الوحيد قبل S4) أو API (قالب Meta
     *  معتمَد عبر Cloud API، S4/S5). NULL للسجلّات القديمة قبل هذه الهجرة (يدويّة فعلياً). */
    sentVia: mysqlEnum("sentVia", ["MANUAL", "API"]),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    // استعلام queue: «آخر تذكير على customerId في آخر ٧ أيام» + عزل فرع.
    customerCreatedIdx: index("idx_ar_reminders_customer_created").on(
      table.customerId,
      table.createdAt,
    ),
    branchCreatedIdx: index("idx_ar_reminders_branch_created").on(
      table.branchId,
      table.createdAt,
    ),
  }),
);
export type ArReminder = typeof arReminders.$inferSelect;
export type InsertArReminder = typeof arReminders.$inferInsert;

/** تذكيرات الذمم الدائنة (AP reminders) — مرآة `arReminders`: مراجعة يومية لموردين ندين لهم منذ ≥٧ أيام
 *  → إرسال واتساب يدوي (تنسيق سداد/طلب كشف) أو تخطٍّ موثَّق. لا يمسّ الدفتر ولا الأموال — سجلّ فعلٍ فقط.
 *  التبريد ٧ أيام + تاريخ وعدنا بالسداد نظير AR تماماً. snapshots لحظية للتدقيق التاريخي. */
export const apReminders = mysqlTable(
  "apReminders",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    supplierId: bigint("supplierId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    /** الرصيد الدائن الفعلي (المستحقّ للمورد علينا) وقت التذكير. */
    totalUnpaidSnapshot: decimal("totalUnpaidSnapshot", {
      precision: 15,
      scale: 2,
    }).notNull(),
    /** أقدم أمر شراء غير مسدَّد (DATE، YYYY-MM-DD كنصّ). لحساب أيام التأخّر تاريخياً. */
    oldestPoDate: date("oldestPoDate", { mode: "string" }).notNull(),
    /** عدد أيام تأخّر أقدم أمر شراء وقت التذكير (metadata، لا يُعاد حسابها). */
    daysOverdue: int("daysOverdue").notNull(),
    /** نصّ رسالة الواتساب المرسَلة (بعد sanitizeForWhatsApp) — snapshot للتدقيق. */
    messageBody: text("messageBody").notNull(),
    status: mysqlEnum("apReminderStatus", ["SENT", "SKIPPED"]).notNull(),
    /** سبب التخطّي (nullable — يُملأ فقط عند status='SKIPPED'). */
    skipReason: varchar("skipReason", { length: 255 }),
    /** تاريخ وعدنا بالسداد (اختياري، YYYY-MM-DD). حين مُلئ يوم التخطّي ⇒ المورد يُعاد إظهاره
     *  في القائمة يوم الوعد نفسه (يتخطّى تبريد ٧ أيام) بشارة «موعود اليوم» لمتابعة السداد. */
    promisedDate: date("promisedDate", { mode: "string" }),
    /** وسيلة الإرسال: MANUAL (زر شاشة المتابعة القائمة) أو API (قالب Meta معتمَد، S4/S5).
     *  NULL للسجلّات القديمة قبل هذه الهجرة (يدويّة فعلياً). */
    sentVia: mysqlEnum("sentVia", ["MANUAL", "API"]),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    supplierCreatedIdx: index("idx_ap_reminders_supplier_created").on(
      table.supplierId,
      table.createdAt,
    ),
    branchCreatedIdx: index("idx_ap_reminders_branch_created").on(
      table.branchId,
      table.createdAt,
    ),
  }),
);
export type ApReminder = typeof apReminders.$inferSelect;
export type InsertApReminder = typeof apReminders.$inferInsert;

/** اشتراكات Web Push للمستخدم (VAPID) — كل جهاز/متصفّح يشترك مرّة، ويُشطَب لينياً عند إبطال المستخدم
 *  أو انتهاء صلاحية endpoint (404/410 من خدمة الدفع). لا يخزّن أرقام هواتف أو بيانات شخصية عدا
 *  تعريف الجهاز — endpoint نفسه من خدمة الدفع بالمتصفّح (fcm.googleapis / Mozilla) بلا أثر شخصي. */
export const pushSubscriptions = mysqlTable(
  "pushSubscriptions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id),
    /** URL الفريد لخدمة دفع المتصفّح لهذا الجهاز — يُبطَل ⇒ 410 عند الإرسال. UNIQUE يمنع
     *  تكرار نفس الجهاز/المتصفّح عند إعادة الاشتراك (نُعيد استعمال الصفّ لا نُنشئ ثانياً). */
    endpoint: varchar("endpoint", { length: 500 }).notNull().unique(),
    /** مفتاح تشفير محتوى الرسالة (p256dh — منحنى ECDH؛ يوفّره المتصفّح). */
    p256dh: text("p256dh").notNull(),
    /** سرّ مصادقة الرسالة (auth — تشفير AES-GCM؛ يوفّره المتصفّح). */
    auth: varchar("auth", { length: 100 }).notNull(),
    /** User-Agent المُختصَر — للتشخيص فقط (مثلاً «Chrome على Android»). لا يُعرَض. */
    userAgent: varchar("userAgent", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    /** حين انتهت صلاحية الاشتراك (410 من خدمة الدفع) أو أبطله المستخدم — لا يُحذَف كي يبقى log
     *  الإرسال قابلاً للتتبّع تاريخياً. الاستعلام النشِط يُصفّي `revokedAt IS NULL`. */
    revokedAt: timestamp("revokedAt"),
  },
  (table) => ({
    userIdx: index("idx_push_sub_user").on(table.userId),
  }),
);
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type InsertPushSubscription = typeof pushSubscriptions.$inferInsert;

/** رموز FCM لتطبيق Android الأصلي. الرمز مشفر، والبحث/منع التكرار يتمان بهاش غير عكوس. */
export const nativePushDevices = mysqlTable(
  "nativePushDevices",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: char("tokenHash", { length: 64 }).notNull().unique(),
    tokenCiphertext: text("tokenCiphertext").notNull(),
    devicePublicKeyHash: char("devicePublicKeyHash", { length: 64 }).notNull(),
    platform: mysqlEnum("platform", ["ANDROID"]).default("ANDROID").notNull(),
    environment: mysqlEnum("environment", ["dev", "staging", "prod"]).notNull(),
    appVersion: varchar("appVersion", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
    revokedAt: timestamp("revokedAt"),
  },
  (table) => ({
    userActiveIdx: index("idx_native_push_user_active").on(
      table.userId,
      table.revokedAt,
      table.environment,
    ),
    deviceOwnerIdx: index("idx_native_push_device_owner").on(
      table.userId,
      table.devicePublicKeyHash,
      table.revokedAt,
    ),
  }),
);
export type NativePushDevice = typeof nativePushDevices.$inferSelect;
export type InsertNativePushDevice = typeof nativePushDevices.$inferInsert;

/** أجهزة عملاء متجر العملاء: رمز Expo Push مشفر، ومعرّفه التجزئي فقط للفهرسة ومنع التكرار. لا يرتبط
 * برقم هاتف؛ الربط الاختياري بالعميل يتم بعد تحقق Firebase في طبقة هوية منفصلة. */
export const storefrontPushDevices = mysqlTable(
  "storefrontPushDevices",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
      { onDelete: "set null" },
    ),
    tokenHash: char("tokenHash", { length: 64 }).notNull().unique(),
    tokenCiphertext: text("tokenCiphertext").notNull(),
    platform: mysqlEnum("platform", ["IOS", "ANDROID"]).notNull(),
    appVersion: varchar("appVersion", { length: 64 }).notNull(),
    marketingOptIn: boolean("marketingOptIn").notNull().default(false),
    transactionalOptIn: boolean("transactionalOptIn").notNull().default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
    revokedAt: timestamp("revokedAt"),
  },
  (table) => ({
    activeMarketingIdx: index("idx_storefront_push_active_marketing").on(
      table.marketingOptIn,
      table.revokedAt,
    ),
    customerActiveIdx: index("idx_storefront_push_customer").on(
      table.customerId,
      table.revokedAt,
    ),
  }),
);
export type StorefrontPushDevice = typeof storefrontPushDevices.$inferSelect;

/** حملة متجر تمر بمسار مسودة ← اعتماد ← جدولة، ولا تخرج إلى صندوق التسليم قبل اعتمادها. */
export const storefrontPushCampaigns = mysqlTable(
  "storefrontPushCampaigns",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** مفتاح ثابت للأحداث التشغيلية الموجّهة (حالة طلب مثلاً). حملات الإدارة تتركه NULL. */
    eventKey: varchar("eventKey", { length: 190 }).unique(),
    name: varchar("name", { length: 160 }).notNull(),
    kind: mysqlEnum("kind", ["MARKETING", "TRANSACTIONAL"])
      .notNull()
      .default("MARKETING"),
    status: mysqlEnum("status", [
      "DRAFT",
      "APPROVED",
      "SCHEDULED",
      "RUNNING",
      "COMPLETED",
      "CANCELLED",
    ])
      .notNull()
      .default("DRAFT"),
    title: varchar("title", { length: 80 }).notNull(),
    body: varchar("body", { length: 180 }).notNull(),
    destination: varchar("destination", { length: 180 }).notNull(),
    throttlePerMinute: int("throttlePerMinute").notNull().default(120),
    scheduledAt: timestamp("scheduledAt"),
    approvedBy: int("approvedBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdBy: int("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    launchedAt: timestamp("launchedAt"),
    completedAt: timestamp("completedAt"),
    recipientCount: int("recipientCount").notNull().default(0),
    sentCount: int("sentCount").notNull().default(0),
    openedCount: int("openedCount").notNull().default(0),
    clickedCount: int("clickedCount").notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    dueIdx: index("idx_storefront_push_campaign_due").on(
      table.status,
      table.scheduledAt,
    ),
  }),
);
export type StorefrontPushCampaign =
  typeof storefrontPushCampaigns.$inferSelect;

/** صندوق تسليم منفصل لكل جهاز، يعيد المحاولة بتراجع محدود ويحفظ الفتح والنقر من دون تخزين محتوى حساس. */
export const storefrontPushDeliveries = mysqlTable(
  "storefrontPushDeliveries",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    campaignId: bigint("campaignId", { mode: "number" }).notNull(),
    deviceId: bigint("deviceId", { mode: "number" }).notNull(),
    status: mysqlEnum("status", [
      "PENDING",
      "PROCESSING",
      "RETRY",
      "SENT",
      "GONE",
      "FAILED",
    ])
      .notNull()
      .default("PENDING"),
    attemptCount: tinyint("attemptCount").notNull().default(0),
    availableAt: timestamp("availableAt").defaultNow().notNull(),
    lockedAt: timestamp("lockedAt"),
    providerTicketId: varchar("providerTicketId", { length: 255 }),
    errorCode: varchar("errorCode", { length: 64 }),
    sentAt: timestamp("sentAt"),
    openedAt: timestamp("openedAt"),
    clickedAt: timestamp("clickedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    campaignDeviceUnique: unique("uq_storefront_push_delivery").on(
      table.campaignId,
      table.deviceId,
    ),
    dueIdx: index("idx_storefront_push_delivery_due").on(
      table.status,
      table.availableAt,
    ),
    campaignFk: foreignKey({
      columns: [table.campaignId],
      foreignColumns: [storefrontPushCampaigns.id],
      name: "fk_storefront_push_delivery_campaign",
    }).onDelete("cascade"),
    deviceFk: foreignKey({
      columns: [table.deviceId],
      foreignColumns: [storefrontPushDevices.id],
      name: "fk_storefront_push_delivery_device",
    }).onDelete("cascade"),
  }),
);
export type StorefrontPushDelivery =
  typeof storefrontPushDeliveries.$inferSelect;

/** سجل إرسال FCM بلا محتوى الرسالة الحسّاس. */
export const nativePushDeliveryLog = mysqlTable(
  "nativePushDeliveryLog",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: char("tokenHash", { length: 64 }).notNull(),
    notificationId: varchar("notificationId", { length: 96 }).notNull(),
    kind: varchar("kind", { length: 40 }).notNull(),
    destination: varchar("destination", { length: 256 }).notNull(),
    status: mysqlEnum("status", ["SENT", "GONE", "FAILED"]).notNull(),
    statusCode: int("statusCode").notNull(),
    messageId: varchar("messageId", { length: 255 }),
    errorCode: varchar("errorCode", { length: 64 }),
    sentAt: timestamp("sentAt").defaultNow().notNull(),
  },
  (table) => ({
    userSentIdx: index("idx_native_push_delivery_user_sent").on(
      table.userId,
      table.sentAt,
    ),
    notificationIdx: index("idx_native_push_delivery_notification").on(
      table.notificationId,
    ),
    notificationTokenUnique: unique(
      "nativePushDeliveryLog_notification_token_unique",
    ).on(table.notificationId, table.tokenHash),
  }),
);
export type NativePushDelivery = typeof nativePushDeliveryLog.$inferSelect;

/**
 * Transactional outbox for native push. The safe, already-redacted payload is committed in the
 * same transaction as appNotifications. Workers claim due rows and retry with bounded backoff.
 */
export const nativePushOutbox = mysqlTable(
  "nativePushOutbox",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventKey: varchar("eventKey", { length: 190 }).notNull().unique(),
    payload: json("payload").notNull(),
    environment: mysqlEnum("environment", ["dev", "staging", "prod"]).notNull(),
    status: mysqlEnum("status", [
      "PENDING",
      "PROCESSING",
      "RETRY",
      "SENT",
      "DEAD",
    ])
      .default("PENDING")
      .notNull(),
    attemptCount: int("attemptCount").default(0).notNull(),
    availableAt: timestamp("availableAt").defaultNow().notNull(),
    lockedAt: timestamp("lockedAt"),
    completedAt: timestamp("completedAt"),
    lastError: varchar("lastError", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    dueIdx: index("idx_native_push_outbox_due").on(
      table.status,
      table.availableAt,
      table.id,
    ),
    userCreatedIdx: index("idx_native_push_outbox_user_created").on(
      table.userId,
      table.createdAt,
    ),
  }),
);
export type NativePushOutboxRow = typeof nativePushOutbox.$inferSelect;
export type InsertNativePushOutbox = typeof nativePushOutbox.$inferInsert;

/** Web Push durable outbox. Unlike the legacy fire-and-forget path, a transient push provider
 * failure keeps the row retryable while the in-app notification remains the source of truth. */
export const webPushOutbox = mysqlTable(
  "webPushOutbox",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventKey: varchar("eventKey", { length: 190 }).notNull().unique(),
    payload: json("payload").notNull(),
    status: mysqlEnum("status", [
      "PENDING",
      "PROCESSING",
      "RETRY",
      "SENT",
      "DEAD",
    ])
      .default("PENDING")
      .notNull(),
    attemptCount: int("attemptCount").default(0).notNull(),
    availableAt: timestamp("availableAt").defaultNow().notNull(),
    lockedAt: timestamp("lockedAt"),
    completedAt: timestamp("completedAt"),
    lastError: varchar("lastError", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    dueIdx: index("idx_web_push_outbox_due").on(
      table.status,
      table.availableAt,
      table.id,
    ),
    userCreatedIdx: index("idx_web_push_outbox_user_created").on(
      table.userId,
      table.createdAt,
    ),
  }),
);
export type WebPushOutboxRow = typeof webPushOutbox.$inferSelect;
export type InsertWebPushOutbox = typeof webPushOutbox.$inferInsert;

/**
 * Transactional outbox for creating the durable in-app notification itself.
 *
 * Producers insert a row in the same transaction as their domain change. The reconciler then
 * calls `createAppNotification`, whose own transaction atomically creates `appNotifications` and
 * `nativePushOutbox`. A failed call remains PENDING with a leased `availableAt`; the unique
 * `eventKey` closes the crash window between notification creation and marking this row DELIVERED.
 */
export const appNotificationOutbox = mysqlTable(
  "appNotificationOutbox",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).references(() => branches.id),
    recipientUserId: int("recipientUserId")
      .notNull()
      .references(() => users.id),
    streamKey: varchar("streamKey", { length: 190 }).notNull(),
    occurrenceId: varchar("occurrenceId", { length: 80 }).notNull(),
    eventKey: varchar("eventKey", { length: 190 }).notNull().unique(),
    payload: json("payload").notNull(),
    status: mysqlEnum("status", ["PENDING", "DELIVERED", "INVALID"])
      .default("PENDING")
      .notNull(),
    attemptCount: int("attemptCount").default(0).notNull(),
    availableAt: timestamp("availableAt").defaultNow().notNull(),
    processedAt: timestamp("processedAt"),
    lastError: varchar("lastError", { length: 500 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    dueIdx: index("idx_app_notice_outbox_due").on(
      table.status,
      table.availableAt,
      table.id,
    ),
    occurrenceIdx: index("idx_app_notice_outbox_occurrence").on(
      table.occurrenceId,
      table.status,
      table.availableAt,
      table.id,
    ),
    streamIdx: index("idx_app_notice_outbox_stream").on(
      table.streamKey,
      table.status,
      table.id,
    ),
    branchDueIdx: index("idx_app_notice_outbox_branch_due").on(
      table.branchId,
      table.status,
      table.availableAt,
      table.id,
    ),
  }),
);
export type AppNotificationOutboxRow = typeof appNotificationOutbox.$inferSelect;
export type InsertAppNotificationOutbox = typeof appNotificationOutbox.$inferInsert;

/** صندوق الإشعارات داخل السوبر تطبيق — مصدر دائم قابل للقراءة والتدقيق، مستقل عن Web Push.
 *  `eventKey` يجعل إدراج الحدث idempotent حتى لو أعاد العامل/الـwebhook المحاولة. */
export const appNotifications = mysqlTable(
  "appNotifications",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id),
    kind: varchar("kind", { length: 40 }).notNull(),
    family: mysqlEnum("family", [
      "OPERATIONS",
      "ADMIN",
      "EMPLOYEE",
      "SYSTEM",
      "APPROVAL",
    ])
      .default("SYSTEM")
      .notNull(),
    title: varchar("title", { length: 180 }).notNull(),
    body: varchar("body", { length: 600 }).notNull(),
    route: varchar("route", { length: 255 }).notNull(),
    entityType: varchar("entityType", { length: 60 }),
    entityId: bigint("entityId", { mode: "number" }),
    eventKey: varchar("eventKey", { length: 190 }).notNull().unique(),
    requiresAction: boolean("requiresAction").default(false).notNull(),
    readAt: timestamp("readAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userCreatedIdx: index("idx_app_notice_user_created").on(
      table.userId,
      table.createdAt,
    ),
    userReadIdx: index("idx_app_notice_user_read").on(
      table.userId,
      table.readAt,
    ),
    userFamilyCreatedIdx: index("idx_app_notice_user_family_created").on(
      table.userId,
      table.family,
      table.createdAt,
    ),
  }),
);
export type AppNotification = typeof appNotifications.$inferSelect;
export type InsertAppNotification = typeof appNotifications.$inferInsert;

/** تفضيلات الإشعارات الشخصية. الاشتراك الفعلي بالجهاز يبقى في pushSubscriptions؛ هذا الصف
 *  يحدّد فئات الأحداث التي يسمح المستخدم بإظهارها على شاشة القفل. */
export const appNotificationPreferences = mysqlTable(
  "appNotificationPreferences",
  {
    userId: int("userId")
      .primaryKey()
      .references(() => users.id),
    taskAssigned: boolean("taskAssigned").default(true).notNull(),
    payrollReady: boolean("payrollReady").default(true).notNull(),
    attendance: boolean("attendance").default(true).notNull(),
    leaveStatus: boolean("leaveStatus").default(true).notNull(),
    approvals: boolean("approvals").default(true).notNull(),
    quietHoursStart: varchar("quietHoursStart", { length: 5 }),
    quietHoursEnd: varchar("quietHoursEnd", { length: 5 }),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
);
export type AppNotificationPreference =
  typeof appNotificationPreferences.$inferSelect;

/** سجلّ إرسال الإشعارات — يمنع الإرسال المزدوج (يوم واحد لكل مستخدم لكل نوع) ويوفّر تدقيقاً تاريخياً.
 *  status: SENT ناجح، FAILED_GONE (410=المستخدم أبطل الاشتراك بالمتصفّح، شطبنا الصفّ)،
 *  FAILED_OTHER أعطال شبكة/خادم أخرى (نُبقي الاشتراك ونعيد المحاولة الغد). */
export const pushNotificationLog = mysqlTable(
  "pushNotificationLog",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id),
    kind: varchar("pushKind", { length: 40 }).notNull(),
    /** JSON مُرسَل (aggregate counts فقط — لا أسماء عملاء) — للتدقيق التاريخي. */
    payload: text("payload").notNull(),
    status: mysqlEnum("pushLogStatus", [
      "SENT",
      "FAILED_GONE",
      "FAILED_OTHER",
    ]).notNull(),
    /** رمز HTTP من خدمة الدفع (201 ناجح، 410 gone…) — nullable قبل الإرسال الفعلي. */
    statusCode: int("statusCode"),
    /** رسالة الخطأ (nullable — يُملأ عند FAILED_*). */
    errorMessage: varchar("errorMessage", { length: 500 }),
    sentAt: timestamp("sentAt").defaultNow().notNull(),
  },
  (table) => ({
    // يُستعلَم يومياً: «هل أُرسل morning brief لهذا المستخدم اليوم؟» ⇒ (userId,sentAt).
    userSentIdx: index("idx_push_log_user_sent").on(table.userId, table.sentAt),
  }),
);
export type PushNotificationLogRow = typeof pushNotificationLog.$inferSelect;

/** حجز إرسال إشعار «برنامج اليوم» ليوم مُحدَّد لمستخدم مُحدَّد — أداة تنسيق ذرّية (INSERT IGNORE).
 *  السبب: نافذة إعادة تشغيل PM2 (reload) قد تشغّل عمليّتين لثوانٍ ⇒ cron يفتح مرّتين. الحجز الأوّل
 *  يفوز والباقي يفشل بسلام (بلا خطأ). PRIMARY KEY يوفّر الذرّية بلا حاجة لـMySQL advisory lock. */
export const pushDailyClaim = mysqlTable(
  "pushDailyClaim",
  {
    userId: int("userId")
      .notNull()
      .references(() => users.id),
    kind: mysqlEnum("pushClaimKind", ["MORNING_BRIEF"]).notNull(),
    claimDay: date("claimDay", { mode: "string" }).notNull(),
    claimedAt: timestamp("claimedAt").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.kind, table.claimDay] }),
  }),
);
export type PushDailyClaim = typeof pushDailyClaim.$inferSelect;

/* ============================ بند 12 (٧/٧): الأقساط والشيكات الآجلة ============================ */

/**
 * خطة أقساط لعميل — بيع آجل مجدول بدفعات (نقدية أو شيكات آجلة). كل خطة ACTIVE مرتبطة
 * بفاتورة بيع حيّة؛ يبقى invoiceId قابلاً لـNULL مؤقتاً لتوافق عمال ما قبل 0308، بينما الكاتب
 * الجديد يفرضه في عقد الخدمة. تشديد قاعدة البيانات مؤجل إلى cutover بعد تصريف العمال القديمة.
 * الدلالة المالية: الخطة **جدولة تحصيل** فوق ذمّة العميل القائمة — لا قيد محاسبي عند الإنشاء؛
 * سداد كل قسط يمرّ عبر سند قبض حقيقي (createVoucher) فيحرّك الذمّة والدفتر بالمسار القائم الموحَّد.
 */
export const installmentPlans = mysqlTable(
  "installmentPlans",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    customerId: bigint("customerId", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(
      () => invoices.id,
    ),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    totalAmount: decimal("totalAmount", { precision: 15, scale: 2 }).notNull(),
    downPayment: decimal("downPayment", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    status: mysqlEnum("planStatus", ["ACTIVE", "COMPLETED", "CANCELLED"])
      .default("ACTIVE")
      .notNull(),
    /**
     * حارس مادي لخطة نشطة واحدة لكل فاتورة. يضبطه trigger 0308 إلى invoiceId
     * في ACTIVE وإلى NULL في الحالات النهائية، فتسمح فريدة MySQL بعدة صفوف منتهية.
     */
    activeInvoiceGuard: bigint("activeInvoiceGuard", { mode: "number" }),
    notes: text("notes"),
    createdBy: bigint("createdBy", { mode: "number" }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    customerIdx: index("idx_instplan_customer").on(t.customerId),
    branchStatusIdx: index("idx_instplan_branch_status").on(
      t.branchId,
      t.status,
    ),
    activeInvoiceUq: unique("uq_instplan_active_invoice").on(
      t.activeInvoiceGuard,
    ),
  }),
);
export type InstallmentPlan = typeof installmentPlans.$inferSelect;

/** قسط مفرد داخل خطة — نقدي أو شيك آجل (رقم الشيك + المصرف). السداد يربط سند القبض الفعلي. */
export const installmentLines = mysqlTable(
  "installmentLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    planId: bigint("planId", { mode: "number" })
      .notNull()
      .references(() => installmentPlans.id, { onDelete: "cascade" }),
    seq: int("seq").notNull(),
    dueDate: date("dueDate", { mode: "string" }).notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    kind: mysqlEnum("lineKind", ["CASH", "CHECK"]).default("CASH").notNull(),
    checkNumber: varchar("checkNumber", { length: 60 }),
    bankName: varchar("bankName", { length: 100 }),
    status: mysqlEnum("lineStatus", ["PENDING", "PAID", "BOUNCED", "CANCELLED"])
      .default("PENDING")
      .notNull(),
    receiptId: bigint("receiptId", { mode: "number" }),
    paidAt: timestamp("paidAt"),
    note: varchar("note", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    planIdx: index("idx_instline_plan").on(t.planId),
    dueStatusIdx: index("idx_instline_due_status").on(t.dueDate, t.status),
  }),
);
export type InstallmentLine = typeof installmentLines.$inferSelect;

/* ============================ بند 12ب (٧/٧): التسعير التعاقدي لعميل ============================ */

/**
 * سعر تعاقدي خاص بعميل لوحدة منتج بعينها — يتقدّم على فئات التسعير الثلاث (RETAIL/WHOLESALE/
 * GOVERNMENT) عند البيع لهذا العميل (عقود الدوائر الحكومية). فريد لكل (عميل × وحدة منتج).
 */
export const customerContractPrices = mysqlTable(
  "customerContractPrices",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    customerId: bigint("customerId", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    productUnitId: bigint("productUnitId", { mode: "number" })
      .notNull()
      .references(() => productUnits.id),
    price: decimal("price", { precision: 15, scale: 2 }).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    note: varchar("note", { length: 255 }),
    createdBy: bigint("createdBy", { mode: "number" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    customerUnitUq: unique("uq_contract_customer_unit").on(
      t.customerId,
      t.productUnitId,
    ),
    customerIdx: index("idx_contract_customer").on(t.customerId),
  }),
);
export type CustomerContractPrice = typeof customerContractPrices.$inferSelect;

/* ============================ بند 12ج (٧/٧): سلف الموظفين ============================ */

/**
 * سلفة موظف — تُمنح بسند صرف حقيقي (خزينة OUT عبر createVoucher) ويُخصم رصيدها تلقائياً من
 * تشغيلات الرواتب (payrollItems.advanceDeduction) عند الصرف حتى التسوية. monthlyDeduction=null
 * ⇒ يُخصم أقصى الممكن من كل راتب.
 */
export const employeeAdvances = mysqlTable(
  "employeeAdvances",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    employeeId: bigint("employeeId", { mode: "number" })
      .notNull()
      .references(() => employees.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    remaining: decimal("remaining", { precision: 15, scale: 2 }).notNull(),
    monthlyDeduction: decimal("monthlyDeduction", { precision: 15, scale: 2 }),
    status: mysqlEnum("advanceStatus", ["ACTIVE", "SETTLED", "CANCELLED"])
      .default("ACTIVE")
      .notNull(),
    receiptId: bigint("receiptId", { mode: "number" }),
    note: varchar("note", { length: 255 }),
    createdBy: bigint("createdBy", { mode: "number" }).notNull(),
    grantedAt: timestamp("grantedAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    empStatusIdx: index("idx_advance_emp_status").on(t.employeeId, t.status),
  }),
);

/**
 * تسويات السلف المرتبطة بمسيّر الرواتب (تدقيق ١٧/٧) — لمنع الخصم المضاعف. تُكتب صفٌّ لكل سلفة
 * تُسوّى عند دفع المسيّر (settleAdvancesOnPayTx)؛ وتُستعاد أرصدتها عند **حذف** المسيّر (لا عكسه).
 */
/**
 * 0190: append-only application/reversal of employee advances inside a
 * human-approved termination gross-to-net settlement. Kept separate from
 * advanceSettlements because that ledger is structurally owned by payrollRun.
 */
/**
 * 0191 maker/checker requests for actual advance repayments and returns.
 * A PENDING row is deliberately zero-effect; APPROVED is the only state that
 * may reference a materialized receipt and accounting entry.
 */
export const employeeAdvanceRepaymentRequests = mysqlTable(
  "employeeAdvanceRepaymentRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKind: mysqlEnum("advanceRepaymentRequestKind", [
      "REPAYMENT",
      "RETURN",
    ]).notNull(),
    status: mysqlEnum("advanceRepaymentRequestStatus", [
      "PENDING",
      "APPROVED",
      "REJECTED",
    ])
      .default("PENDING")
      .notNull(),
    employeeId: bigint("employeeId", { mode: "number" }).notNull(),
    branchId: bigint("branchId", { mode: "number" }).notNull(),
    originalRequestId: bigint("originalRequestId", { mode: "number" }),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    paymentMethod: mysqlEnum("advanceRepaymentPaymentMethod", [
      "CASH",
      "CARD",
      "TRANSFER",
      "WALLET",
    ]).notNull(),
    cashBucket: mysqlEnum("advanceRepaymentCashBucket", ["DRAWER", "TREASURY"]),
    shiftId: bigint("shiftId", { mode: "number" }),
    referenceNumber: varchar("referenceNumber", { length: 100 }),
    cardLastFour: varchar("cardLastFour", { length: 4 }),
    transactionDate: date("transactionDate").notNull(),
    evidenceNote: varchar("evidenceNote", { length: 500 }).notNull(),
    clientRequestId: varchar("clientRequestId", { length: 80 }).notNull(),
    sourceKey: varchar("sourceKey", { length: 191 }).notNull(),
    sourceHash: char("sourceHash", { length: 64 }).notNull(),
    evidenceHash: char("evidenceHash", { length: 64 }).notNull(),
    receiptId: bigint("receiptId", { mode: "number" }),
    accountingEntryId: bigint("accountingEntryId", { mode: "number" }),
    createdBy: int("createdBy").notNull(),
    reviewedBy: int("reviewedBy"),
    reviewedAt: timestamp("reviewedAt"),
    rejectionReason: varchar("rejectionReason", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    sourceUq: unique("uq_advrep_req_source").on(t.sourceKey),
    externalRefUq: unique("uq_advrep_req_external_ref").on(
      t.branchId,
      t.requestKind,
      t.paymentMethod,
      t.referenceNumber,
    ),
    receiptUq: unique("uq_advrep_req_receipt").on(t.receiptId),
    entryUq: unique("uq_advrep_req_entry").on(t.accountingEntryId),
    employeeStatusIdx: index("idx_advrep_req_employee_status").on(
      t.employeeId,
      t.status,
    ),
    branchStatusIdx: index("idx_advrep_req_branch_status").on(
      t.branchId,
      t.status,
    ),
    originalIdx: index("idx_advrep_req_original").on(t.originalRequestId),
    employeeFk: foreignKey({
      columns: [t.employeeId],
      foreignColumns: [employees.id],
      name: "fk_advrep_req_employee",
    }).onDelete("no action"),
    branchFk: foreignKey({
      columns: [t.branchId],
      foreignColumns: [branches.id],
      name: "fk_advrep_req_branch",
    }).onDelete("no action"),
    originalFk: foreignKey({
      columns: [t.originalRequestId],
      foreignColumns: [t.id],
      name: "fk_advrep_req_original",
    }).onDelete("no action"),
    shiftFk: foreignKey({
      columns: [t.shiftId],
      foreignColumns: [shifts.id],
      name: "fk_advrep_req_shift",
    }).onDelete("no action"),
    receiptFk: foreignKey({
      columns: [t.receiptId],
      foreignColumns: [receipts.id],
      name: "fk_advrep_req_receipt",
    }).onDelete("no action"),
    entryFk: foreignKey({
      columns: [t.accountingEntryId],
      foreignColumns: [accountingEntries.id],
      name: "fk_advrep_req_entry",
    }).onDelete("no action"),
    makerFk: foreignKey({
      columns: [t.createdBy],
      foreignColumns: [users.id],
      name: "fk_advrep_req_maker",
    }).onDelete("no action"),
    reviewerFk: foreignKey({
      columns: [t.reviewedBy],
      foreignColumns: [users.id],
      name: "fk_advrep_req_reviewer",
    }).onDelete("no action"),
    positiveAmount: check("chk_advrep_req_positive", sql`${t.amount} > 0`),
    originalShape: check(
      "chk_advrep_req_original_shape",
      sql`(${t.requestKind} = 'REPAYMENT' AND ${t.originalRequestId} IS NULL) OR (${t.requestKind} = 'RETURN' AND ${t.originalRequestId} IS NOT NULL)`,
    ),
    evidenceShape: check(
      "chk_advrep_req_evidence",
      sql`(
      ${t.paymentMethod} = 'CASH' AND ${t.cashBucket} = 'DRAWER' AND ${t.shiftId} IS NOT NULL AND ${t.referenceNumber} IS NULL AND ${t.cardLastFour} IS NULL
    ) OR (
      ${t.paymentMethod} = 'CARD' AND ${t.cashBucket} IS NULL AND ${t.shiftId} IS NULL AND CHAR_LENGTH(TRIM(${t.referenceNumber})) > 0 AND ${t.cardLastFour} REGEXP '^[0-9]{4}$'
    ) OR (
      ${t.paymentMethod} IN ('TRANSFER','WALLET') AND ${t.cashBucket} IS NULL AND ${t.shiftId} IS NULL AND CHAR_LENGTH(TRIM(${t.referenceNumber})) > 0 AND ${t.cardLastFour} IS NULL
    )`,
    ),
    lifecycleShape: check(
      "chk_advrep_req_lifecycle",
      sql`(
      ${t.status} = 'PENDING' AND ${t.reviewedBy} IS NULL AND ${t.reviewedAt} IS NULL AND ${t.receiptId} IS NULL AND ${t.accountingEntryId} IS NULL AND ${t.rejectionReason} IS NULL
    ) OR (
      ${t.status} = 'APPROVED' AND ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL AND ${t.receiptId} IS NOT NULL AND ${t.accountingEntryId} IS NOT NULL AND ${t.rejectionReason} IS NULL
    ) OR (
      ${t.status} = 'REJECTED' AND ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL AND ${t.receiptId} IS NULL AND ${t.accountingEntryId} IS NULL AND CHAR_LENGTH(TRIM(${t.rejectionReason})) >= 5
    )`,
    ),
  }),
);
export type EmployeeAdvanceRepaymentRequest =
  typeof employeeAdvanceRepaymentRequests.$inferSelect;

/** Append-only subledger; a correction is a REVERSE row, never an edit/delete. */
export const employeeAdvanceRepaymentAllocations = mysqlTable(
  "employeeAdvanceRepaymentAllocations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestId: bigint("requestId", { mode: "number" }).notNull(),
    advanceId: bigint("advanceId", { mode: "number" }).notNull(),
    direction: mysqlEnum("advanceRepaymentAllocationDirection", [
      "APPLY",
      "REVERSE",
    ]).notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    reversalOfId: bigint("reversalOfId", { mode: "number" }),
    receiptId: bigint("receiptId", { mode: "number" }).notNull(),
    accountingEntryId: bigint("accountingEntryId", {
      mode: "number",
    }).notNull(),
    sourceKey: varchar("sourceKey", { length: 191 }).notNull(),
    occurredAt: timestamp("occurredAt").notNull(),
    createdBy: int("createdBy").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    sourceUq: unique("uq_advrep_alloc_source").on(t.sourceKey),
    reversalUq: unique("uq_advrep_alloc_reversal").on(t.reversalOfId),
    requestIdx: index("idx_advrep_alloc_request").on(t.requestId),
    advanceIdx: index("idx_advrep_alloc_advance").on(t.advanceId),
    requestFk: foreignKey({
      columns: [t.requestId],
      foreignColumns: [employeeAdvanceRepaymentRequests.id],
      name: "fk_advrep_alloc_request",
    }).onDelete("no action"),
    advanceFk: foreignKey({
      columns: [t.advanceId],
      foreignColumns: [employeeAdvances.id],
      name: "fk_advrep_alloc_advance",
    }).onDelete("no action"),
    reversalFk: foreignKey({
      columns: [t.reversalOfId],
      foreignColumns: [t.id],
      name: "fk_advrep_alloc_reversal",
    }).onDelete("no action"),
    receiptFk: foreignKey({
      columns: [t.receiptId],
      foreignColumns: [receipts.id],
      name: "fk_advrep_alloc_receipt",
    }).onDelete("no action"),
    entryFk: foreignKey({
      columns: [t.accountingEntryId],
      foreignColumns: [accountingEntries.id],
      name: "fk_advrep_alloc_entry",
    }).onDelete("no action"),
    actorFk: foreignKey({
      columns: [t.createdBy],
      foreignColumns: [users.id],
      name: "fk_advrep_alloc_actor",
    }).onDelete("no action"),
    positiveAmount: check("chk_advrep_alloc_positive", sql`${t.amount} > 0`),
    reversalShape: check(
      "chk_advrep_alloc_reversal_shape",
      sql`(${t.direction} = 'APPLY' AND ${t.reversalOfId} IS NULL) OR (${t.direction} = 'REVERSE' AND ${t.reversalOfId} IS NOT NULL)`,
    ),
  }),
);
export type EmployeeAdvanceRepaymentAllocation =
  typeof employeeAdvanceRepaymentAllocations.$inferSelect;

export const terminationAdvanceAllocations = mysqlTable(
  "terminationAdvanceAllocations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    terminationId: bigint("terminationId", { mode: "number" }).notNull(),
    advanceId: bigint("advanceId", { mode: "number" }).notNull(),
    accountingEventId: bigint("accountingEventId", {
      mode: "number",
    }).notNull(),
    direction: mysqlEnum("terminationAdvanceDirection", ["APPLY", "REVERSE"])
      .default("APPLY")
      .notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    reversalOfId: bigint("reversalOfId", { mode: "number" }),
    sourceKey: varchar("sourceKey", { length: 191 }).notNull(),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
    createdBy: int("createdBy").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    terminationIdx: index("idx_termadv_term").on(t.terminationId),
    advanceIdx: index("idx_termadv_adv").on(t.advanceId),
    eventIdx: index("idx_termadv_event").on(t.accountingEventId),
    sourceKeyUq: unique("uq_termadv_source").on(t.sourceKey),
    reversalUq: unique("uq_termadv_reversal").on(t.reversalOfId),
    terminationFk: foreignKey({
      columns: [t.terminationId],
      foreignColumns: [employeeTerminations.id],
      name: "fk_termadv_term",
    }).onDelete("no action"),
    advanceFk: foreignKey({
      columns: [t.advanceId],
      foreignColumns: [employeeAdvances.id],
      name: "fk_termadv_advance",
    }).onDelete("no action"),
    eventFk: foreignKey({
      columns: [t.accountingEventId],
      foreignColumns: [payrollAccountingEvents.id],
      name: "fk_termadv_event",
    }).onDelete("no action"),
    reversalFk: foreignKey({
      columns: [t.reversalOfId],
      foreignColumns: [t.id],
      name: "fk_termadv_reversal",
    }).onDelete("no action"),
    actorFk: foreignKey({
      columns: [t.createdBy],
      foreignColumns: [users.id],
      name: "fk_termadv_actor",
    }).onDelete("no action"),
    positiveAmount: check("chk_termadv_positive", sql`${t.amount} > 0`),
    reversalShape: check(
      "chk_termadv_reversal_shape",
      sql`(${t.direction} = 'APPLY' AND ${t.reversalOfId} IS NULL) OR (${t.direction} = 'REVERSE' AND ${t.reversalOfId} IS NOT NULL)`,
    ),
  }),
);
export type TerminationAdvanceAllocation =
  typeof terminationAdvanceAllocations.$inferSelect;

export const advanceSettlements = mysqlTable(
  "advanceSettlements",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    runId: bigint("runId", { mode: "number" })
      .notNull()
      .references(() => payrollRuns.id),
    advanceId: bigint("advanceId", { mode: "number" })
      .notNull()
      .references(() => employeeAdvances.id),
    employeeId: bigint("employeeId", { mode: "number" }).notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    revisionNo: int("revisionNo").default(0).notNull(),
    direction: mysqlEnum("advanceSettlementDirection", ["APPLY", "REVERSE"])
      .default("APPLY")
      .notNull(),
    reversalOfId: bigint("reversalOfId", { mode: "number" }).references(
      (): AnyMySqlColumn => advanceSettlements.id,
    ),
    /** Nullable only for the legacy writer until the 0185 lifecycle is activated. */
    sourceKey: varchar("sourceKey", { length: 191 }),
    createdBy: int("createdBy").references(() => users.id),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    runIdx: index("idx_advsettle_run").on(t.runId),
    runRevisionIdx: index("idx_advsettle_run_revision").on(
      t.runId,
      t.revisionNo,
    ),
    advanceIdx: index("idx_advsettle_advance").on(t.advanceId),
    sourceKeyUq: unique("uq_advsettle_source").on(t.sourceKey),
    reversalOnceUq: unique("uq_advsettle_reversal_once").on(t.reversalOfId),
    positiveAmount: check(
      "chk_advsettle_positive_amount",
      sql`${t.amount} > 0`,
    ),
    reversalShape: check(
      "chk_advsettle_reversal_shape",
      sql`(
        (${t.direction} = 'REVERSE' AND ${t.reversalOfId} IS NOT NULL) OR
        (${t.direction} = 'APPLY' AND ${t.reversalOfId} IS NULL)
      )`,
    ),
  }),
);
export type AdvanceSettlement = typeof advanceSettlements.$inferSelect;
export type EmployeeAdvance = typeof employeeAdvances.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// تسعير الطباعة الرقمية (Digital) — البند⑥ الطبقة٢ (٢٢/٧). المطبعة ديجيتال لا أوفست: الوحدة =
// الوجه المطبوع (الورق مشمول في سعره)، والعريض (فلكس) بالمتر المربّع. الأرقام كلّها إعداداتٌ
// يملؤها المدير. راجع shared/printPricing.ts + server/services/printPricing.
// ═══════════════════════════════════════════════════════════════════════════

/** إعدادات تسعير الطباعة (صفّ singleton id=1، نمط taxSettings): وضع التسعير (هامش على الكلفة /
 *  سعر بيع مباشر) + نسبة الهامش الافتراضية + رسم التجهيز. يملؤها المدير من شاشة الإعدادات. */
export const printPricingSettings = mysqlTable("printPricingSettings", {
  id: int("id").autoincrement().primaryKey(),
  pricingMode: mysqlEnum("pricingMode", ["MARGIN", "DIRECT"])
    .default("MARGIN")
    .notNull(),
  defaultMarginPercent: decimal("defaultMarginPercent", {
    precision: 6,
    scale: 3,
  })
    .default("0")
    .notNull(),
  setupFee: decimal("setupFee", { precision: 15, scale: 2 })
    .default("0")
    .notNull(),
  updatedBy: int("updatedBy").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type PrintPricingSettings = typeof printPricingSettings.$inferSelect;

/** سعر الوجه المطبوع لكل (مقاس ISO × نمط ملوّن/أبيض-أسود) — يشمل الورق. قيد فريد على الزوج
 *  (سعرٌ واحدٌ لكل تركيبة، upsert). المقاس غير المُسعَّر لا يظهر في الحاسبة. */
export const printFacePrices = mysqlTable(
  "printFacePrices",
  {
    id: int("id").autoincrement().primaryKey(),
    paperSize: mysqlEnum("paperSize", [
      "A0",
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
      "A6",
      "A7",
      "A8",
      "A9",
      "A10",
      "B0",
      "B1",
      "B2",
      "B3",
      "B4",
      "B5",
      "B6",
      "B7",
      "B8",
      "B9",
      "B10",
    ]).notNull(),
    colorMode: mysqlEnum("colorMode", ["COLOR", "BW"]).notNull(),
    pricePerFace: decimal("pricePerFace", {
      precision: 15,
      scale: 2,
    }).notNull(),
    updatedBy: int("updatedBy").references(() => users.id),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    faceUq: unique("uq_print_face_price").on(t.paperSize, t.colorMode),
  }),
);
export type PrintFacePrice = typeof printFacePrices.$inferSelect;

/** ورق مميّز اختياريّ (كوشيه/لاصق/شفاف…) — زيادةٌ لكل وجه أو ورقة فوق سعر الوجه القياسيّ. */
export const printPaperUpcharges = mysqlTable("printPaperUpcharges", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  unit: mysqlEnum("unit", ["PER_FACE", "PER_SHEET"])
    .default("PER_SHEET")
    .notNull(),
  upcharge: decimal("upcharge", { precision: 15, scale: 2 }).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PrintPaperUpcharge = typeof printPaperUpcharges.$inferSelect;

/** وسائط الطباعة العريضة (فلكس/استيكر/فينيل…) — سعرٌ لكل متر مربّع. */
export const printWideMedia = mysqlTable("printWideMedia", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  pricePerSqm: decimal("pricePerSqm", { precision: 15, scale: 2 }).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PrintWideMedia = typeof printWideMedia.$inferSelect;

/** خيارات التشطيب (تغليف/تجليد/قصّ/طيّ…) — سعرٌ لكل نسخة أو لكل شغلة. */
export const printFinishingOptions = mysqlTable("printFinishingOptions", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  unit: mysqlEnum("unit", ["PER_COPY", "PER_JOB"])
    .default("PER_COPY")
    .notNull(),
  price: decimal("price", { precision: 15, scale: 2 }).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PrintFinishingOption = typeof printFinishingOptions.$inferSelect;

/* ============================ البث التسويقي — واتساب (S5، هجرة 0110) ============================
 *
 * قناة تنفيذ مراسلة جماعية فوق عالم `crmCampaigns` القائم (`crmCampaignId` رابط اختياري للعزو
 * التقريري فقط — لا تكرار لآلة حالات الحملات). الشريحة (`segmentJson`) تُبنى وقت الإنشاء/الإطلاق
 * عبر باني RFM حيّ (`server/services/whatsapp/segmentService.ts`) على customers/invoices —
 * تُخزَّن كلقطة معايير لا نتائج (النتائج الفعلية = صفوف `waBroadcastRecipients` وقت التقطير، T5.2).
 * القالب (`templateId`) يُشترَط من فئة MARKETING ومُعتمَداً فعلياً عند Meta (`waTemplates`).
 * `audienceCount`/`costEstimate` لقطة وقت الإنشاء تُعاد حسابها حيّاً عند الإطلاق (قد تكون تغيّرت).
 * اعتماد ثانٍ إلزامي (Maker-Checker) فوق عتبة حجم الجمهور (`waHubSettings.campaignApprovalThreshold`)
 * — بلا استثناء لـadmin (قرار مالك موثَّق، خلافاً لنمط السندات المعتاد SOD-04).
 */
export const waBroadcasts = mysqlTable(
  "waBroadcasts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // NULL = كل الفروع (بثّ عامّ — محصور بالأدمن فعلياً في الخدمة، نمط crmCampaigns.branchId).
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
    ),
    crmCampaignId: bigint("crmCampaignId", { mode: "number" }).references(
      () => crmCampaigns.id,
    ),
    name: varchar("name", { length: 160 }).notNull(),
    templateId: bigint("templateId", { mode: "number" })
      .notNull()
      .references(() => waTemplates.id),
    templateLang: varchar("templateLang", { length: 10 })
      .default("ar")
      .notNull(),
    // تعيين متغيّرات القالب لحقول العميل: {"1": "name", "2": "currentBalance", ...}.
    varsMapJson: json("varsMapJson"),
    // معايير باني الشرائح (SegmentCriteria) — لقطة معايير لا نتائج؛ يُعاد حلّها حيّاً وقت الإطلاق.
    segmentJson: json("segmentJson").notNull(),
    broadcastStatus: mysqlEnum("broadcastStatus", [
      "DRAFT",
      "PENDING_APPROVAL",
      "APPROVED",
      "RUNNING",
      "PAUSED",
      "COMPLETED",
      "CANCELLED",
    ])
      .default("DRAFT")
      .notNull(),
    audienceCount: int("audienceCount").default(0).notNull(),
    costEstimate: decimal("costEstimate", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    throttlePerMinute: int("throttlePerMinute").default(10).notNull(),
    scheduledAt: timestamp("scheduledAt"),
    pausedReason: varchar("pausedReason", { length: 200 }),
    createdBy: int("createdBy").references(() => users.id),
    approvedBy: int("approvedBy").references(() => users.id),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    statusIdx: index("idx_wa_broadcast_status").on(t.broadcastStatus),
  }),
);
export type WaBroadcast = typeof waBroadcasts.$inferSelect;
export type InsertWaBroadcast = typeof waBroadcasts.$inferInsert;

/** صفٌّ لكل مستلم — يُدرَج كسولاً دفعة-دفعة وقت التقطير (T5.2)، لا عند الإنشاء/الإطلاق. */
export const waBroadcastRecipients = mysqlTable(
  "waBroadcastRecipients",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    broadcastId: bigint("broadcastId", { mode: "number" })
      .notNull()
      .references(() => waBroadcasts.id, { onDelete: "cascade" }),
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
    ),
    phoneE164: varchar("phoneE164", { length: 20 }).notNull(),
    recipientStatus: mysqlEnum("recipientStatus", [
      "PENDING",
      "QUEUED",
      "SENT",
      "DELIVERED",
      "READ",
      "FAILED",
      "SKIPPED_OPTOUT",
    ])
      .default("PENDING")
      .notNull(),
    outboxId: bigint("outboxId", { mode: "number" }),
    wamid: varchar("wamid", { length: 200 }),
    errorCode: varchar("errorCode", { length: 20 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    // مستلم مكرّر في نفس الحملة (نفس الهاتف) — يمنع إدراجاً مزدوجاً لدفعة التقطير idempotent.
    recipientUq: unique("uq_wa_broadcast_recipient").on(
      t.broadcastId,
      t.phoneE164,
    ),
    pickIdx: index("idx_wa_broadcast_recip_pick").on(
      t.broadcastId,
      t.recipientStatus,
    ),
  }),
);
export type WaBroadcastRecipient = typeof waBroadcastRecipients.$inferSelect;
export type InsertWaBroadcastRecipient =
  typeof waBroadcastRecipients.$inferInsert;

/* ═══════════════════════ الحجوزات (Reservations — R-م٣، ٢٧/٧/٢٦) ═══════════════════════
 * حجز ناعم (soft reservation، نمط ATP العالمي SAP/Odoo): لا يمسّ branchStock.quantity إطلاقاً.
 * المتاح للبيع (ATP) = branchStock.quantity − reservationStock.reservedBase.
 * دورة الحياة: ACTIVE → (PARTIALLY_FULFILLED) → FULFILLED | EXPIRED | CANCELLED | RELEASED — بلا حذف.
 * قرارات المالك (٢٧/٧): إنفاذ ناعم (تحذير لا منع عند البيع) · عربون اختياري مسترد كامل · الهاتف إلزامي.
 * الوثيقة الحاكمة: docs/gifts-reservations-design-2026-07-27.md. */
export const reservations = mysqlTable(
  "reservations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    reservationNumber: varchar("reservationNumber", { length: 40 }).notNull(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
    ),
    contactName: varchar("contactName", { length: 200 }),
    // الهاتف إلزاميّ (قرار المالك): وسيلة الاستدعاء وقت الحضور + تذكير الانتهاء.
    contactPhone: varchar("contactPhone", { length: 32 }).notNull(),
    channel: mysqlEnum("reservationChannel", [
      "PHONE",
      "WALK_IN",
      "WHATSAPP",
      "STORE",
    ])
      .default("PHONE")
      .notNull(),
    status: mysqlEnum("reservationStatus", [
      "ACTIVE",
      "PARTIALLY_FULFILLED",
      "FULFILLED",
      "EXPIRED",
      "CANCELLED",
      "RELEASED",
    ])
      .default("ACTIVE")
      .notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    // أثر دائم يمنع تكرار تنبيه قرب الانتهاء. يُصفَّر عند تمديد الحجز كي يُنبَّه عن الموعد الجديد.
    nearExpiryNotifiedAt: timestamp("nearExpiryNotifiedAt"),
    // عربون الحجز (R-م٥): إيصال IN مربوط قبل الفاتورة (نمط workOrders.deposit). NULL حتى يُدفع.
    depositReceiptId: bigint("depositReceiptId", { mode: "number" }),
    // الفاتورة المنفِّذة عند التحويل لبيع (R-م٤). NULL حتى التحويل الكامل.
    fulfilledInvoiceId: bigint("fulfilledInvoiceId", {
      mode: "number",
    }).references(() => invoices.id),
    notes: text("notes"),
    createdBy: int("createdBy").references(() => users.id),
    releasedBy: int("releasedBy").references(() => users.id),
    cancelReason: varchar("cancelReason", { length: 300 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    numberUq: unique("uq_reservation_number").on(t.reservationNumber),
    branchStatusIdx: index("idx_reservation_branch_status").on(
      t.branchId,
      t.status,
    ),
    customerIdx: index("idx_reservation_customer").on(t.customerId),
    phoneIdx: index("idx_reservation_phone").on(t.contactPhone),
    // كنّاس الانتهاء التلقائي: مسح (status ∧ expiresAt) بلا full scan.
    expiresIdx: index("idx_reservation_expires").on(t.status, t.expiresAt),
    nearExpiryIdx: index("idx_reservation_near_expiry").on(
      t.status,
      t.channel,
      t.nearExpiryNotifiedAt,
      t.expiresAt,
    ),
  }),
);
export type Reservation = typeof reservations.$inferSelect;
export type InsertReservation = typeof reservations.$inferInsert;

/** بنود الحجز — بوحدة الأساس دائماً (منع حجز «درزن» ثم بيع القطع مفردةً). fulfilledBase للتنفيذ الجزئي. */
export const reservationLines = mysqlTable(
  "reservationLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    reservationId: bigint("reservationId", { mode: "number" })
      .notNull()
      .references(() => reservations.id, { onDelete: "cascade" }),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" })
      .notNull()
      .references(() => productUnits.id),
    baseQuantity: int("baseQuantity").notNull(),
    fulfilledBase: int("fulfilledBase").default(0).notNull(),
    // سعر مرجعيّ وقت الحجز (عرض فقط — السعر النهائي يُحسَب عند البيع).
    quotedUnitPrice: decimal("quotedUnitPrice", { precision: 15, scale: 2 }),
  },
  (t) => ({
    reservationIdx: index("idx_reservation_line_res").on(t.reservationId),
    variantIdx: index("idx_reservation_line_variant").on(t.variantId),
  }),
);
export type ReservationLine = typeof reservationLines.$inferSelect;
export type InsertReservationLine = typeof reservationLines.$inferInsert;

/** سجلّ أحداث الحجز — تسلسليّ بلا حذف (حجز/تمديد/تنفيذ/إلغاء/انتهاء/تحرير/عربون/استرداد). */
export const reservationEvents = mysqlTable(
  "reservationEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    reservationId: bigint("reservationId", { mode: "number" })
      .notNull()
      .references(() => reservations.id, { onDelete: "cascade" }),
    eventType: mysqlEnum("reservationEventType", [
      "CREATE",
      "EXTEND",
      "PARTIAL_FULFILL",
      "FULFILL",
      "CANCEL",
      "EXPIRE",
      "RELEASE",
      "DEPOSIT",
      "REFUND",
      "SYSTEM",
    ]).notNull(),
    fromStatus: varchar("fromStatus", { length: 24 }),
    toStatus: varchar("toStatus", { length: 24 }),
    note: text("note"),
    userId: int("userId").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    resIdx: index("idx_reservation_events_res").on(
      t.reservationId,
      t.createdAt,
    ),
  }),
);
export type ReservationEvent = typeof reservationEvents.$inferSelect;
export type InsertReservationEvent = typeof reservationEvents.$inferInsert;

/* المحجوز المجمّع لكل (صنف×فرع) — نمط branchStock نفسه (للأداء والتزامن، أفضل من SUM لحظيّ).
 * ثابت حرج: reservedBase = Σ(baseQuantity − fulfilledBase) للحجوزات النشطة (ACTIVE/PARTIALLY_FULFILLED).
 * يُحدَّث نسبياً (reservedBase ± delta) تحت قفل .for("update") مع كل تغيّر حجز — كما applyMovement مع branchStock. */
export const reservationStock = mysqlTable(
  "reservationStock",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    reservedBase: int("reservedBase").default(0).notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    variantBranchUq: unique("uq_reservation_stock_variant_branch").on(
      t.variantId,
      t.branchId,
    ),
    branchIdx: index("idx_reservation_stock_branch").on(t.branchId),
  }),
);
export type ReservationStock = typeof reservationStock.$inferSelect;
export type InsertReservationStock = typeof reservationStock.$inferInsert;

/**
 * شجرة الحسابات (Chart of Accounts) — أساس الدفتر المزدوج (P0، قرار المالك ٢٧/٧). جدولٌ **إضافيّ** لا
 * يمسّ أيّ دفترٍ قائم. كل حساب يحمل `systemRole` يربطه بالمفهوم القائم في النظام (ذمم العملاء↔customers،
 * المخزون↔branchStock، المبيعات↔إيراد قيود البيع…) — هذا الربط أساسُ محرّك القيود (P1) لاحقاً.
 * systemRole فريدٌ حين وُجد (حسابٌ واحد لكل دور نظاميّ)، وnull للحسابات التفصيلية الحرّة (تعدُّد NULL مسموح).
 */
export const accounts = mysqlTable(
  "accounts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    type: mysqlEnum("type", [
      "ASSET",
      "LIABILITY",
      "EQUITY",
      "REVENUE",
      "EXPENSE",
    ]).notNull(),
    parentId: bigint("parentId", { mode: "number" }),
    systemRole: varchar("systemRole", { length: 40 }),
    isActive: boolean("isActive").default(true).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    notes: varchar("notes", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    uqCode: unique("uq_account_code").on(t.code),
    uqSystemRole: unique("uq_account_system_role").on(t.systemRole),
    typeIdx: index("idx_account_type").on(t.type),
  }),
);
export type Account = typeof accounts.$inferSelect;
export type InsertAccount = typeof accounts.$inferInsert;

/**
 * إصدار دليل الامتثال النظامي. الحسابات التشغيلية تبقى في `accounts`، بينما هذا الإصدار
 * يثبت الدليل الذي اعتمده مراقب الحسابات مع مرجعه وتاريخ نفاذه وبصمة محتواه. `activeGuard`
 * حارس singleton: لا يمكن أن يوجد أكثر من إصدار نظامي نافذ في اللحظة نفسها.
 */
export const statutoryAccountingProfiles = mysqlTable(
  "statutoryAccountingProfiles",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    profileKey: varchar("profileKey", { length: 64 }).notNull(),
    version: int("version").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    authorityReference: varchar("authorityReference", { length: 255 }).notNull(),
    effectiveFrom: date("effectiveFrom", { mode: "string" }).notNull(),
    status: mysqlEnum("status", ["DRAFT", "ACTIVE", "RETIRED"])
      .default("DRAFT")
      .notNull(),
    activeGuard: varchar("activeGuard", { length: 16 }),
    contentHash: char("contentHash", { length: 64 }),
    accountantName: varchar("accountantName", { length: 150 }),
    approvalReference: varchar("approvalReference", { length: 255 }),
    approvedBy: int("approvedBy").references(() => users.id),
    approvedAt: timestamp("approvedAt"),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    keyVersionUq: unique("uq_stat_profile_key_version").on(
      t.profileKey,
      t.version,
    ),
    activeGuardUq: unique("uq_stat_profile_active_guard").on(t.activeGuard),
    activeStateCheck: check(
      "chk_stat_profile_active_state",
      sql`((${t.status} = 'ACTIVE' AND ${t.activeGuard} = 'ACTIVE') OR (${t.status} <> 'ACTIVE' AND ${t.activeGuard} IS NULL))`,
    ),
    statusIdx: index("idx_stat_profile_status").on(t.status),
  }),
);
export type StatutoryAccountingProfile =
  typeof statutoryAccountingProfiles.$inferSelect;
export type InsertStatutoryAccountingProfile =
  typeof statutoryAccountingProfiles.$inferInsert;

/** حساب نظامي ضمن إصدارٍ واحد؛ رموزه لا تُخلط برموز الدليل التشغيلي. */
export const statutoryAccounts = mysqlTable(
  "statutoryAccounts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    profileId: bigint("profileId", { mode: "number" })
      .notNull()
      .references(() => statutoryAccountingProfiles.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 30 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    type: mysqlEnum("type", [
      "ASSET",
      "LIABILITY",
      "EQUITY",
      "REVENUE",
      "EXPENSE",
    ]).notNull(),
    normalBalance: mysqlEnum("normalBalance", ["DEBIT", "CREDIT"]).notNull(),
    parentId: bigint("parentId", { mode: "number" }),
    isPosting: boolean("isPosting").default(true).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    notes: varchar("notes", { length: 500 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    profileCodeUq: unique("uq_stat_account_profile_code").on(
      t.profileId,
      t.code,
    ),
    profileTypeIdx: index("idx_stat_account_profile_type").on(
      t.profileId,
      t.type,
      t.sortOrder,
    ),
    parentFk: foreignKey({
      name: "fk_stat_account_parent",
      columns: [t.parentId],
      foreignColumns: [t.id],
    }).onDelete("restrict"),
  }),
);
export type StatutoryAccount = typeof statutoryAccounts.$inferSelect;
export type InsertStatutoryAccount = typeof statutoryAccounts.$inferInsert;

/**
 * الخريطة المعتمدة بين حسابٍ تشغيلي وحسابٍ نظامي. الإصدار جزء من المفتاح عبر `profileId`؛
 * لذلك تعديل دليلٍ لاحق لا يعيد تصنيف تاريخ إصدارٍ سابق.
 */
export const statutoryAccountMappings = mysqlTable(
  "statutoryAccountMappings",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    profileId: bigint("profileId", { mode: "number" })
      .notNull(),
    internalAccountId: bigint("internalAccountId", { mode: "number" })
      .notNull(),
    statutoryAccountId: bigint("statutoryAccountId", { mode: "number" })
      .notNull(),
    rationale: varchar("rationale", { length: 500 }),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    internalUq: unique("uq_stat_mapping_internal").on(
      t.profileId,
      t.internalAccountId,
    ),
    statutoryIdx: index("idx_stat_mapping_statutory").on(
      t.profileId,
      t.statutoryAccountId,
    ),
    profileFk: foreignKey({
      name: "fk_stat_mapping_profile",
      columns: [t.profileId],
      foreignColumns: [statutoryAccountingProfiles.id],
    }).onDelete("cascade"),
    internalFk: foreignKey({
      name: "fk_stat_mapping_internal",
      columns: [t.internalAccountId],
      foreignColumns: [accounts.id],
    }).onDelete("restrict"),
    statutoryFk: foreignKey({
      name: "fk_stat_mapping_account",
      columns: [t.statutoryAccountId],
      foreignColumns: [statutoryAccounts.id],
    }).onDelete("restrict"),
  }),
);
export type StatutoryAccountMapping =
  typeof statutoryAccountMappings.$inferSelect;
export type InsertStatutoryAccountMapping =
  typeof statutoryAccountMappings.$inferInsert;

// ============================================================
// منظومة الهدايا/المجانيات (٢٧/٧/٢٦، هجرة 0116) — الوارد (IN: صفر تكلفة، تخفيف WAVG، بلا دين مورّد)
// + الصادر (OUT: قيد GIFT_OUT، revenue=0 profit=-cost، بلا invoiceId، حوكمة SOD فوق العتبة).
// جدول واحد بعمود `direction` يخدم الاتجاهين (نمط receipts.direction).
// ============================================================

// حملات الهدايا (G-م٧، هجرة 0119): تصنيف + ميزانيّة اختياريّة تُفرَض بقفل تسلسليّ عند كل هدية صادرة مرتبطة.
// تُعرَّف قبل giftVouchers (التي تشير إليها) — نمط الإحالة الخلفية المُثبَت في هذا الملف.
export const giftCampaigns = mysqlTable(
  "giftCampaigns",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    reason: varchar("reason", { length: 255 }),
    startDate: date("startDate"),
    endDate: date("endDate"),
    budgetCost: decimal("budgetCost", { precision: 15, scale: 2 }),
    status: mysqlEnum("status", ["ACTIVE", "CLOSED"])
      .default("ACTIVE")
      .notNull(),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    uqName: unique("uq_gift_campaign_name").on(t.name),
  }),
);
export type GiftCampaign = typeof giftCampaigns.$inferSelect;
export type InsertGiftCampaign = typeof giftCampaigns.$inferInsert;

export const giftVouchers = mysqlTable(
  "giftVouchers",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    giftNumber: varchar("giftNumber", { length: 32 }).notNull(),
    direction: mysqlEnum("direction", ["OUT", "IN"]).notNull(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    // العميل (للصادر) / المورّد (للوارد) — أحدهما حسب الاتجاه.
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
    ),
    supplierId: bigint("supplierId", { mode: "number" }).references(
      () => suppliers.id,
    ),
    // ربط حملة تسويقية اختياريّ (G-م٧، هجرة 0119) — للصادر دلالياً؛ ميزانيّة الحملة تُفرَض بقفل تسلسليّ.
    campaignId: bigint("campaignId", { mode: "number" }).references(
      () => giftCampaigns.id,
    ),
    giftType: varchar("giftType", { length: 32 }),
    reason: varchar("reason", { length: 255 }),
    // قابل للبيع؟ الوارد للاستخدام الداخلي/العيّنة = false (مؤجَّل التنفيذ لـ G-م١ب — يبقى العمود للتوسعة).
    sellable: boolean("sellable").default(true).notNull(),
    supplierRef: varchar("supplierRef", { length: 64 }),
    estimatedValue: decimal("estimatedValue", { precision: 15, scale: 2 }),
    status: mysqlEnum("status", [
      "DRAFT",
      "PENDING_APPROVAL",
      "APPROVED",
      "DELIVERED",
      "CANCELLED",
      "REVERSED",
    ])
      .default("DRAFT")
      .notNull(),
    totalCost: decimal("totalCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    notes: varchar("notes", { length: 500 }),
    signatureHash: varchar("signatureHash", { length: 128 }),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    approvedBy: int("approvedBy").references(() => users.id),
    approvedAt: timestamp("approvedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    uqNumber: unique("uq_gift_number").on(t.giftNumber),
    dirBranchStatusIdx: index("idx_gift_dir_branch_status").on(
      t.direction,
      t.branchId,
      t.status,
    ),
    customerIdx: index("idx_gift_customer").on(t.customerId),
    supplierIdx: index("idx_gift_supplier").on(t.supplierId),
    createdIdx: index("idx_gift_created").on(t.createdAt),
    campaignIdx: index("idx_gift_campaign").on(t.campaignId),
  }),
);
export type GiftVoucher = typeof giftVouchers.$inferSelect;
export type InsertGiftVoucher = typeof giftVouchers.$inferInsert;

export const giftVoucherLines = mysqlTable(
  "giftVoucherLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    giftVoucherId: bigint("giftVoucherId", { mode: "number" })
      .notNull()
      .references(() => giftVouchers.id),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id),
    productUnitId: bigint("productUnitId", { mode: "number" })
      .notNull()
      .references(() => productUnits.id),
    // الكمية بالوحدة المختارة + الكمية بوحدة الأساس (baseQuantity = quantity × conversionFactor).
    quantity: decimal("quantity", { precision: 15, scale: 4 }).notNull(),
    baseQuantity: int("baseQuantity").notNull(),
    // لقطة تكلفة الوحدة وقت العملية (للصادر: WAVG وقت الإخراج؛ للوارد: 0).
    unitCostSnapshot: decimal("unitCostSnapshot", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    lineCost: decimal("lineCost", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    // سعر البيع المرجعيّ (عرضيّ للصادر — «قيمة الهدية» على الإيصال).
    refSalePrice: decimal("refSalePrice", { precision: 15, scale: 2 }),
  },
  (t) => ({
    voucherIdx: index("idx_giftline_voucher").on(t.giftVoucherId),
    variantIdx: index("idx_giftline_variant").on(t.variantId),
  }),
);
export type GiftVoucherLine = typeof giftVoucherLines.$inferSelect;
export type InsertGiftVoucherLine = typeof giftVoucherLines.$inferInsert;

/* ==== البطاقات الرقمية والاشتراكات ==== */

/**
 * مزوّدو البطاقات الرقمية والاشتراكات (اتصالات، بطاقات عالمية، تعليمية…).
 * كل مزوّد مرتبط بمورّد واحد (supplier) في المنظومة.
 */
export const digitalProviders = mysqlTable(
  "digitalProviders",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    supplierId: bigint("supplierId", { mode: "number" })
      .notNull()
      .references(() => suppliers.id)
      .unique("uq_digital_provider_supplier"),
    providerType: mysqlEnum("providerType", [
      "TELECOM",
      "GLOBAL_CARDS",
      "EDUCATIONAL",
      "OTHER",
    ]).notNull(),
    settlementMode: mysqlEnum("settlementMode", [
      "PREPAID",
      "POSTPAID",
    ]).notNull(),
    recognitionMode: mysqlEnum("recognitionMode", [
      "PRINCIPAL_GROSS",
    ]).notNull(),
    referencePolicy: mysqlEnum("referencePolicy", [
      "REQUIRED",
      "OPTIONAL",
      "NONE",
    ]).notNull(),
    settlementCycle: mysqlEnum("settlementCycle", [
      "DAILY",
      "WEEKLY",
      "BIWEEKLY",
      "MONTHLY",
      "ON_DEMAND",
    ]).notNull(),
    lowBalanceThreshold: decimal("lowBalanceThreshold", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    notes: text("notes"),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    supplierIdx: index("idx_dprovider_supplier").on(t.supplierId),
  }),
);
export type DigitalProvider = typeof digitalProviders.$inferSelect;
export type InsertDigitalProvider = typeof digitalProviders.$inferInsert;

/**
 * محافظ رقمية: رصيد مسبق الدفع لدى مزوّد × فرع.
 * الرصيد يُحدَّث ذرّياً عبر حركات digitalWalletTransactions.
 */
export const digitalWallets = mysqlTable(
  "digitalWallets",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    providerId: bigint("providerId", { mode: "number" })
      .notNull()
      .references(() => digitalProviders.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    code: varchar("code", { length: 40 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    currency: mysqlEnum("currency", ["IQD"]).notNull(),
    currentBalance: decimal("currentBalance", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    reservedBalance: decimal("reservedBalance", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    providerBranchCodeUq: unique("uq_wallet_provider_branch_code").on(
      t.providerId,
      t.branchId,
      t.code,
    ),
    branchIdx: index("idx_wallet_branch").on(t.branchId),
  }),
);
export type DigitalWallet = typeof digitalWallets.$inferSelect;
export type InsertDigitalWallet = typeof digitalWallets.$inferInsert;

/**
 * حركات المحفظة الرقمية: إيداع / سحب / استهلاك بيع / عكس / تسوية.
 * كل حركة تُغيّر الرصيد تحت قفل ذرّي.
 */
export const digitalWalletTransactions = mysqlTable(
  "digitalWalletTransactions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    transactionNumber: varchar("transactionNumber", { length: 40 })
      .notNull()
      .unique("uq_dwt_number"),
    walletId: bigint("walletId", { mode: "number" })
      .notNull()
      .references(() => digitalWallets.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    // WRITEOFF (هجرة 0129): خصم شطب نيّةٍ عالقة — يخفض الرصيد كما خفضه جهاز المزوّد فعلاً.
    type: mysqlEnum("type", [
      "OPENING",
      "DEPOSIT",
      "SALE_CONSUMPTION",
      "SALE_REVERSAL",
      "WITHDRAWAL",
      "ADJUSTMENT",
      "WRITEOFF",
    ]).notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    direction: mysqlEnum("direction", ["IN", "OUT"]).notNull(),
    balanceAfter: decimal("balanceAfter", {
      precision: 15,
      scale: 2,
    }).notNull(),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(
      () => invoices.id,
    ),
    invoiceItemId: bigint("invoiceItemId", { mode: "number" }).references(
      () => invoiceItems.id,
    ),
    receiptId: bigint("receiptId", { mode: "number" }).references(
      () => receipts.id,
    ),
    status: mysqlEnum("status", ["ACTIVE", "PENDING_APPROVAL", "REVERSED"])
      .default("ACTIVE")
      .notNull(),
    clientRequestId: varchar("clientRequestId", { length: 80 }),
    notes: text("notes"),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    approvedBy: int("approvedBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    approvedAt: timestamp("approvedAt"),
  },
  (t) => ({
    walletIdx: index("idx_dwt_wallet").on(t.walletId),
    walletClientUq: unique("uq_dwt_wallet_client").on(
      t.walletId,
      t.clientRequestId,
    ),
  }),
);
export type DigitalWalletTransaction =
  typeof digitalWalletTransactions.$inferSelect;
export type InsertDigitalWalletTransaction =
  typeof digitalWalletTransactions.$inferInsert;

/**
 * عروض رقمية: ربط مزوّد بمنتج/متغيّر/وحدة مع إعدادات التسعير والهامش.
 */
export const digitalOfferings = mysqlTable(
  "digitalOfferings",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    providerId: bigint("providerId", { mode: "number" })
      .notNull()
      .references(() => digitalProviders.id),
    productId: bigint("productId", { mode: "number" })
      .notNull()
      .references(() => products.id),
    variantId: bigint("variantId", { mode: "number" })
      .notNull()
      .references(() => productVariants.id)
      .unique("uq_doffering_variant"),
    productUnitId: bigint("productUnitId", { mode: "number" })
      .notNull()
      .references(() => productUnits.id)
      .unique("uq_doffering_unit"),
    offeringType: mysqlEnum("offeringType", [
      "TELECOM_CARD",
      "GLOBAL_CARD",
      "EDUCATIONAL_SUBSCRIPTION",
      "OTHER",
    ]).notNull(),
    requiresStudentData: boolean("requiresStudentData")
      .default(false)
      .notNull(),
    // للاشتراكات التعليمية فقط: مدة العقد الذي ينشأ بعد البيع الناجح.
    // NULL يبقي العروض القديمة متوافقة ولا ينشئ عقداً بأثر رجعي.
    subscriptionDurationDays: int("subscriptionDurationDays"),
    faceValue: decimal("faceValue", { precision: 15, scale: 2 }),
    faceCurrency: varchar("faceCurrency", { length: 3 }),
    pricingMode: mysqlEnum("pricingMode", [
      "FIXED_MARGIN",
      "PERCENT_MARGIN",
      "FIXED_PLUS_PERCENT",
      "FIXED_SELL_PRICE",
    ]).notNull(),
    fixedMargin: decimal("fixedMargin", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    marginPercent: decimal("marginPercent", { precision: 5, scale: 2 })
      .default("0")
      .notNull(),
    minimumMargin: decimal("minimumMargin", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    roundingStep: decimal("roundingStep", { precision: 15, scale: 2 })
      .default("250")
      .notNull(),
    priceValidityHours: int("priceValidityHours"),
    cardColorToken: varchar("cardColorToken", { length: 30 }),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    providerIdx: index("idx_doffering_provider").on(t.providerId),
  }),
);
export type DigitalOffering = typeof digitalOfferings.$inferSelect;
export type InsertDigitalOffering = typeof digitalOfferings.$inferInsert;

/**
 * ربط عرض رقمي بفرع (تفعيل/ترتيب عرض/مفضّلة + محفظة اختيارية).
 * مفتاح أساسي مركّب (offeringId, branchId).
 */
export const digitalOfferingBranches = mysqlTable(
  "digitalOfferingBranches",
  {
    offeringId: bigint("offeringId", { mode: "number" })
      .notNull()
      .references(() => digitalOfferings.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    walletId: bigint("walletId", { mode: "number" }).references(
      () => digitalWallets.id,
    ),
    isActive: boolean("isActive").default(true).notNull(),
    isFavorite: boolean("isFavorite").default(false).notNull(),
    displayOrder: int("displayOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.offeringId, t.branchId],
      name: "pk_doffering_branch",
    }),
    branchIdx: index("idx_dob_branch").on(t.branchId),
  }),
);
export type DigitalOfferingBranch = typeof digitalOfferingBranches.$inferSelect;
export type InsertDigitalOfferingBranch =
  typeof digitalOfferingBranches.$inferInsert;

/**
 * دُفعات أسعار العروض الرقمية: مسودة → منشورة → مُلغاة.
 * copiedFromBatchId: مرجع ذاتي بلا قيد FK (نمط categories.parentId).
 */
export const digitalPriceBatches = mysqlTable(
  "digitalPriceBatches",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    providerId: bigint("providerId", { mode: "number" })
      .notNull()
      .references(() => digitalProviders.id),
    businessDate: date("businessDate", { mode: "string" }).notNull(),
    // مبرّر موجز لقرار سعر اليوم: يظهر مع الدفعة المحفوظة ولا يغيّر أي قيد سابق.
    changeReason: varchar("changeReason", { length: 300 }),
    status: mysqlEnum("status", [
      "DRAFT",
      "PUBLISHED",
      "SUPERSEDED",
      "CANCELLED",
    ])
      .default("DRAFT")
      .notNull(),
    // مرجع ذاتي — الدُفعة المنسوخة منها (بلا FK بنيوي، نمط parentId).
    copiedFromBatchId: bigint("copiedFromBatchId", { mode: "number" }),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    publishedBy: int("publishedBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    publishedAt: timestamp("publishedAt"),
    // §٧.١ (هجرة 0130): اعتماد مديرٍ ثانٍ حين تتغيّر حصةُ بطاقةٍ ≥٥٠٪ عن السعر النافذ.
    // يُمسَح في `saveDraft` عند أيّ تعديل ⇒ لا يُعتمَد سعرٌ ثمّ يُنشَر غيره.
    bigChangeApprovedBy: int("bigChangeApprovedBy").references(() => users.id),
    bigChangeApprovedAt: timestamp("bigChangeApprovedAt"),
    // عمودان مولَّدان STORED + فهرسان فريدان (هجرة 0127، تُطبَّق عبر ci-apply-extra-migrations):
    // draftKey يحمل NULL خارج DRAFT وpublishedKey خارج PUBLISHED، وفهرس MySQL الفريد يقبل تكرار
    // NULL ⇒ «مسودّة واحدة لكل (فرع×مزوّد×تاريخ)» و«منشورة واحدة سارية لكل (فرع×مزوّد)».
    // drizzle لا يَلمسهما (read-only من JS) — مُعرَّفان هنا للأنواع فقط، نمط products.searchNorm.
    draftKey: varchar("draftKey", { length: 80 }),
    publishedKey: varchar("publishedKey", { length: 80 }),
  },
  (t) => ({
    branchProviderIdx: index("idx_dpbatch_branch_provider").on(
      t.branchId,
      t.providerId,
    ),
    statusIdx: index("idx_dpbatch_status").on(t.status),
  }),
);
export type DigitalPriceBatch = typeof digitalPriceBatches.$inferSelect;
export type InsertDigitalPriceBatch = typeof digitalPriceBatches.$inferInsert;

/**
 * نسخ أسعار العروض الرقمية داخل دُفعة. كل نسخة = عرض × فرع × تاريخ سريان.
 */
export const digitalPriceVersions = mysqlTable(
  "digitalPriceVersions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    batchId: bigint("batchId", { mode: "number" })
      .notNull()
      .references(() => digitalPriceBatches.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    offeringId: bigint("offeringId", { mode: "number" })
      .notNull()
      .references(() => digitalOfferings.id),
    providerShare: decimal("providerShare", {
      precision: 15,
      scale: 2,
    }).notNull(),
    sellPrice: decimal("sellPrice", { precision: 15, scale: 2 }).notNull(),
    marginAmount: decimal("marginAmount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    validFrom: timestamp("validFrom").notNull(),
    validUntil: timestamp("validUntil"),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    batchOfferingUq: unique("uq_dpv_batch_offering").on(
      t.batchId,
      t.offeringId,
    ),
    offeringIdx: index("idx_dpv_offering").on(t.offeringId),
    branchIdx: index("idx_dpv_branch").on(t.branchId),
  }),
);
export type DigitalPriceVersion = typeof digitalPriceVersions.$inferSelect;
export type InsertDigitalPriceVersion =
  typeof digitalPriceVersions.$inferInsert;

/**
 * السعر الحالي الساري لكل عرض × فرع (مؤشّر مادّيّ — صفّ واحد لكل زوج).
 * مفتاح أساسي مركّب (branchId, offeringId).
 */
export const digitalCurrentPrices = mysqlTable(
  "digitalCurrentPrices",
  {
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    offeringId: bigint("offeringId", { mode: "number" })
      .notNull()
      .references(() => digitalOfferings.id),
    priceVersionId: bigint("priceVersionId", { mode: "number" })
      .notNull()
      .references(() => digitalPriceVersions.id),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.branchId, t.offeringId],
      name: "pk_dcurrent_price",
    }),
  }),
);
export type DigitalCurrentPrice = typeof digitalCurrentPrices.$inferSelect;
export type InsertDigitalCurrentPrice =
  typeof digitalCurrentPrices.$inferInsert;

/**
 * بلاغات تغيّر سعر المزوّد — يسجّلها الكاشير ويعالجها المدير.
 */
export const digitalPriceChangeReports = mysqlTable(
  "digitalPriceChangeReports",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    offeringId: bigint("offeringId", { mode: "number" })
      .notNull()
      .references(() => digitalOfferings.id),
    providerId: bigint("providerId", { mode: "number" })
      .notNull()
      .references(() => digitalProviders.id),
    currentPriceVersionId: bigint("currentPriceVersionId", {
      mode: "number",
    }).notNull(),
    reportedProviderShare: decimal("reportedProviderShare", {
      precision: 15,
      scale: 2,
    }).notNull(),
    status: mysqlEnum("status", ["OPEN", "APPROVED", "REJECTED", "RESOLVED"])
      .default("OPEN")
      .notNull(),
    reportedBy: int("reportedBy")
      .notNull()
      .references(() => users.id),
    resolvedBy: int("resolvedBy").references(() => users.id),
    resolutionPriceVersionId: bigint("resolutionPriceVersionId", {
      mode: "number",
    }),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    resolvedAt: timestamp("resolvedAt"),
  },
  (t) => ({
    statusIdx: index("idx_dpcr_status").on(t.status),
    providerIdx: index("idx_dpcr_provider").on(t.providerId),
    fkCurrPv: foreignKey({
      columns: [t.currentPriceVersionId],
      foreignColumns: [digitalPriceVersions.id],
      name: "fk_dpcr_curr_pv",
    }),
    fkResPv: foreignKey({
      columns: [t.resolutionPriceVersionId],
      foreignColumns: [digitalPriceVersions.id],
      name: "fk_dpcr_res_pv",
    }),
  }),
);
export type DigitalPriceChangeReport =
  typeof digitalPriceChangeReports.$inferSelect;
export type InsertDigitalPriceChangeReport =
  typeof digitalPriceChangeReports.$inferInsert;

/**
 * ملفّات الطلاب: بيانات طالب مرتبطة بعميل (للاشتراكات التعليمية).
 */
export const studentProfiles = mysqlTable(
  "studentProfiles",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    customerId: bigint("customerId", { mode: "number" })
      .notNull()
      .references(() => customers.id)
      .unique("uq_student_customer"),
    studentPhone: varchar("studentPhone", { length: 20 })
      .notNull()
      .unique("uq_student_phone"),
    guardianPhone: varchar("guardianPhone", { length: 20 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    guardianIdx: index("idx_student_guardian").on(t.guardianPhone),
  }),
);
export type StudentProfile = typeof studentProfiles.$inferSelect;
export type InsertStudentProfile = typeof studentProfiles.$inferInsert;

/**
 * نيّات بيع رقمية (سلة مُحضَّرة): دورة حياة PREPARED → EXECUTING → EXECUTED → FINALIZED.
 * تُلغى تلقائياً عند انقضاء expiresAt.
 */
export const digitalSaleIntents = mysqlTable(
  "digitalSaleIntents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    clientRequestId: varchar("clientRequestId", { length: 80 })
      .notNull()
      .unique("uq_dsi_client_request"),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    shiftId: bigint("shiftId", { mode: "number" })
      .notNull()
      .references(() => shifts.id),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    // WRITEOFF_PENDING/WRITTEN_OFF (هجرة 0129): مسار إنهاء النيّة العالقة بشطبٍ باعتمادٍ ثنائيّ.
    status: mysqlEnum("status", [
      "PREPARED",
      "EXECUTING",
      "EXECUTED",
      "FINALIZED",
      "CANCELLED",
      "EXPIRED",
      "NEEDS_REVIEW",
      "WRITEOFF_PENDING",
      "WRITTEN_OFF",
    ])
      .default("PREPARED")
      .notNull(),
    cartFingerprint: varchar("cartFingerprint", { length: 64 }).notNull(),
    checkoutSnapshot: json("checkoutSnapshot").$type<DigitalCheckoutSnapshot>(),
    paymentMethod: varchar("paymentMethod", { length: 20 }).notNull(),
    /** محاولة قبض الزبون بالبطاقة، مستقلة عن مرجع إصدار الكرت لدى مزوّد البطاقات. */
    externalPaymentAttemptId: bigint("externalPaymentAttemptId", {
      mode: "number",
    }).unique("uq_dsi_extpay_attempt"),
    externalPaymentDeviceId: varchar("externalPaymentDeviceId", { length: 64 }),
    expectedTotal: decimal("expectedTotal", {
      precision: 15,
      scale: 2,
    }).notNull(),
    invoiceId: bigint("invoiceId", { mode: "number" })
      .references(() => invoices.id)
      .unique("uq_dsi_invoice"),
    expiresAt: timestamp("expiresAt").notNull(),
    // أثر الشطب (هجرة 0129): مَن طلب ولماذا، ومَن اعتمد ومتى — أساس فحص SOD (طالب ≠ معتمِد).
    writeoffRequestedBy: int("writeoffRequestedBy").references(() => users.id),
    writeoffRequestedAt: timestamp("writeoffRequestedAt"),
    writeoffReason: varchar("writeoffReason", { length: 300 }),
    writeoffApprovedBy: int("writeoffApprovedBy").references(() => users.id),
    writeoffApprovedAt: timestamp("writeoffApprovedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    statusIdx: index("idx_dsi_status").on(t.status),
    branchIdx: index("idx_dsi_branch").on(t.branchId),
    externalPaymentAttemptFk: foreignKey({
      name: "fk_dsi_extpay_attempt",
      columns: [t.externalPaymentAttemptId],
      foreignColumns: [externalPaymentAttempts.id],
    }),
  }),
);
export type DigitalSaleIntent = typeof digitalSaleIntents.$inferSelect;
export type InsertDigitalSaleIntent = typeof digitalSaleIntents.$inferInsert;

/**
 * حجوزات أرصدة المحفظة الرقمية: تُحجَز عند إعداد النيّة وتُستهلَك/تُطلَق عند التنفيذ/الإلغاء.
 */
export const digitalWalletReservations = mysqlTable(
  "digitalWalletReservations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    walletId: bigint("walletId", { mode: "number" })
      .notNull()
      .references(() => digitalWallets.id),
    intentId: bigint("intentId", { mode: "number" })
      .notNull()
      .references(() => digitalSaleIntents.id),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    status: mysqlEnum("status", ["ACTIVE", "CONSUMED", "RELEASED"])
      .default("ACTIVE")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    consumedAt: timestamp("consumedAt"),
    releasedAt: timestamp("releasedAt"),
  },
  (t) => ({
    walletIntentUq: unique("uq_dwr_wallet_intent").on(t.walletId, t.intentId),
    intentIdx: index("idx_dwr_intent").on(t.intentId),
  }),
);
export type DigitalWalletReservation =
  typeof digitalWalletReservations.$inferSelect;
export type InsertDigitalWalletReservation =
  typeof digitalWalletReservations.$inferInsert;

/**
 * بنود نيّة البيع الرقمية: كل بند = عرض رقمي بلقطات سعر وحالة تنفيذ.
 */
export const digitalSaleIntentItems = mysqlTable(
  "digitalSaleIntentItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    intentId: bigint("intentId", { mode: "number" })
      .notNull()
      .references(() => digitalSaleIntents.id),
    lineKey: varchar("lineKey", { length: 64 }).notNull(),
    /** NULL for legacy single-card operations; one key per provider basket. */
    providerBasketKey: varchar("providerBasketKey", { length: 64 }),
    /** Only the owner retains the globally unique provider reference claim. */
    referenceOwnerItemId: bigint("referenceOwnerItemId", { mode: "number" }),
    offeringId: bigint("offeringId", { mode: "number" })
      .notNull()
      .references(() => digitalOfferings.id),
    // ش٧ (هجرة 0128): المزوّد مُنزَّل على البند — القيد الفريد «مرجع واحد لكل مزوّد» يحتاجه في
    // الصفّ نفسه. ثابتٌ بعد الإنشاء (مشتقٌّ من digitalOfferings.providerId لحظة الإعداد).
    providerId: bigint("providerId", { mode: "number" }).notNull().default(0),
    priceVersionId: bigint("priceVersionId", { mode: "number" }).notNull(),
    sellPriceSnapshot: decimal("sellPriceSnapshot", {
      precision: 15,
      scale: 2,
    }).notNull(),
    providerShareSnapshot: decimal("providerShareSnapshot", {
      precision: 15,
      scale: 2,
    }).notNull(),
    marginSnapshot: decimal("marginSnapshot", {
      precision: 15,
      scale: 2,
    }).notNull(),
    fulfillmentStatus: mysqlEnum("fulfillmentStatus", [
      "PENDING",
      "SUCCESS",
      "FAILED",
      "UNKNOWN",
    ])
      .default("PENDING")
      .notNull(),
    providerReference: varchar("providerReference", { length: 120 }),
    confirmedBy: int("confirmedBy").references(() => users.id),
    confirmedAt: timestamp("confirmedAt"),
    studentCustomerId: bigint("studentCustomerId", {
      mode: "number",
    }).references(() => customers.id),
    studentNameSnapshot: varchar("studentNameSnapshot", { length: 255 }),
    studentPhoneSnapshot: varchar("studentPhoneSnapshot", { length: 20 }),
    guardianPhoneSnapshot: varchar("guardianPhoneSnapshot", { length: 20 }),
    studentAddressSnapshot: text("studentAddressSnapshot"),
    // عمود مولَّد STORED + فهرس فريد (هجرة 0128، تُطبَّق عبر ci-apply-extra-migrations):
    // NULL ما لم يوجد مرجع ⇒ الفهرس الفريد يقبل تكرار NULL، فينحصر المنع على البنود ذات المرجع.
    // drizzle لا يَلمسه (read-only من JS) — مُعرَّف هنا للأنواع فقط، نمط products.searchNorm.
    refKey: varchar("refKey", { length: 160 }),
  },
  (t) => ({
    intentLineUq: unique("uq_dsii_intent_line").on(t.intentId, t.lineKey),
    basketOwnerTargetUq: unique("uq_dsii_basket_owner_target").on(t.intentId, t.providerId, t.providerBasketKey, t.id),
    basketOwnerFk: foreignKey({
      columns: [t.intentId, t.providerId, t.providerBasketKey, t.referenceOwnerItemId],
      foreignColumns: [t.intentId, t.providerId, t.providerBasketKey, t.id],
      name: "fk_dsii_basket_owner",
    }),
    offeringIdx: index("idx_dsii_offering").on(t.offeringId),
    fkPv: foreignKey({
      columns: [t.priceVersionId],
      foreignColumns: [digitalPriceVersions.id],
      name: "fk_dsii_pv",
    }),
  }),
);
export type DigitalSaleIntentItem = typeof digitalSaleIntentItems.$inferSelect;
export type InsertDigitalSaleIntentItem =
  typeof digitalSaleIntentItems.$inferInsert;

/**
 * قرار معالجة عملية بيع رقمية لم تكتمل.
 *
 * الطلب لا يُحدث أثراً مالياً. التنفيذ لا يتم إلا بعد اعتماد مدير آخر، ثم يُطبّق
 * أحد المسارات الثلاثة الذرية: إلغاء بلا إصدار، إكمال البيع، أو إثبات خسارة.
 */
export const digitalSaleReviewResolutions = mysqlTable(
  "digitalSaleReviewResolutions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    intentId: bigint("intentId", { mode: "number" })
      .notNull()
      .unique("uq_dsrr_intent"),
    decision: mysqlEnum("decision", [
      "CANCEL_NO_ISSUE",
      "FINALIZE_SALE",
      "WRITEOFF_LOSS",
    ]).notNull(),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED"])
      .default("PENDING")
      .notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    requestedBy: int("requestedBy").notNull(),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    reviewedBy: int("reviewedBy"),
    reviewedAt: timestamp("reviewedAt"),
    reviewReason: varchar("reviewReason", { length: 500 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    statusIdx: index("idx_dsrr_status").on(t.status),
    intentFk: foreignKey({
      columns: [t.intentId],
      foreignColumns: [digitalSaleIntents.id],
      name: "fk_dsrr_intent",
    }),
    requesterFk: foreignKey({
      columns: [t.requestedBy],
      foreignColumns: [users.id],
      name: "fk_dsrr_requester",
    }),
    reviewerFk: foreignKey({
      columns: [t.reviewedBy],
      foreignColumns: [users.id],
      name: "fk_dsrr_reviewer",
    }),
  }),
);
export type DigitalSaleReviewResolution =
  typeof digitalSaleReviewResolutions.$inferSelect;

/** لقطة قرار كل بند داخل طلب المعالجة؛ تحفظ ما طابقه المدير مع تقرير جهاز المزوّد. */
export const digitalSaleReviewResolutionItems = mysqlTable(
  "digitalSaleReviewResolutionItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    resolutionId: bigint("resolutionId", { mode: "number" }).notNull(),
    intentItemId: bigint("intentItemId", { mode: "number" }).notNull(),
    outcome: mysqlEnum("outcome", ["ISSUED", "NOT_ISSUED"]).notNull(),
    providerReference: varchar("providerReference", { length: 120 }),
  },
  (t) => ({
    itemUq: unique("uq_dsrri_item").on(t.intentItemId),
    resolutionIdx: index("idx_dsrri_resolution").on(t.resolutionId),
    resolutionFk: foreignKey({
      columns: [t.resolutionId],
      foreignColumns: [digitalSaleReviewResolutions.id],
      name: "fk_dsrri_resolution",
    }),
    itemFk: foreignKey({
      columns: [t.intentItemId],
      foreignColumns: [digitalSaleIntentItems.id],
      name: "fk_dsrri_item",
    }),
  }),
);
export type DigitalSaleReviewResolutionItem =
  typeof digitalSaleReviewResolutionItems.$inferSelect;

/**
 * تفاصيل البيع الرقمي: لقطة كاملة لبيانات كل بند رقمي مُباع (مرتبط ببند الفاتورة).
 */
export const digitalSaleDetails = mysqlTable(
  "digitalSaleDetails",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    invoiceId: bigint("invoiceId", { mode: "number" })
      .notNull()
      .references(() => invoices.id),
    invoiceItemId: bigint("invoiceItemId", { mode: "number" })
      .notNull()
      .references(() => invoiceItems.id)
      .unique("uq_dsd_invoice_item"),
    intentItemId: bigint("intentItemId", { mode: "number" })
      .notNull()
      .references(() => digitalSaleIntentItems.id)
      .unique("uq_dsd_intent_item"),
    offeringId: bigint("offeringId", { mode: "number" })
      .notNull()
      .references(() => digitalOfferings.id),
    providerId: bigint("providerId", { mode: "number" })
      .notNull()
      .references(() => digitalProviders.id),
    priceVersionId: bigint("priceVersionId", { mode: "number" })
      .notNull()
      .references(() => digitalPriceVersions.id),
    settlementModeSnapshot: mysqlEnum("settlementModeSnapshot", [
      "PREPAID",
      "POSTPAID",
    ]).notNull(),
    sellPriceSnapshot: decimal("sellPriceSnapshot", {
      precision: 15,
      scale: 2,
    }).notNull(),
    providerShareSnapshot: decimal("providerShareSnapshot", {
      precision: 15,
      scale: 2,
    }).notNull(),
    profitSnapshot: decimal("profitSnapshot", {
      precision: 15,
      scale: 2,
    }).notNull(),
    providerReference: varchar("providerReference", { length: 120 }),
    // الكرت صادر · أو ردُّ خسارةٍ **طُلب وينتظر مديراً ثانياً** (هجرة 0132) · أو عُكس والمزوّد
    // أعاد الحصة · أو رُدّ ثمنه فعلاً والحصة خسارةٌ على المكتبة.
    // (0131 كانت قد حذفت `REVERSAL_PENDING` لأن لا كود يكتبها؛ هذه تُعيد حالةً معلّقة **مع** كودها.)
    fulfillmentStatus: mysqlEnum("fulfillmentStatus", [
      "ISSUED",
      "LOSS_REFUND_PENDING",
      "REVERSED",
      "LOSS_REFUND",
    ])
      .default("ISSUED")
      .notNull(),
    studentCustomerId: bigint("studentCustomerId", {
      mode: "number",
    }).references(() => customers.id),
    studentNameSnapshot: varchar("studentNameSnapshot", { length: 255 }),
    studentPhoneSnapshot: varchar("studentPhoneSnapshot", { length: 20 }),
    guardianPhoneSnapshot: varchar("guardianPhoneSnapshot", { length: 20 }),
    studentAddressSnapshot: text("studentAddressSnapshot"),
    walletTransactionId: bigint("walletTransactionId", { mode: "number" }),
    // أثر ردّ الخسارة (هجرة 0132): مَن طلب ولماذا، ومَن اعتمد ومتى — أساس فحص SOD (طالب ≠ معتمِد).
    lossRefundRequestedBy: int("lossRefundRequestedBy").references(
      () => users.id,
    ),
    lossRefundRequestedAt: timestamp("lossRefundRequestedAt"),
    lossRefundReason: varchar("lossRefundReason", { length: 300 }),
    lossRefundApprovedBy: int("lossRefundApprovedBy").references(
      () => users.id,
    ),
    lossRefundApprovedAt: timestamp("lossRefundApprovedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    invoiceIdx: index("idx_dsd_invoice").on(t.invoiceId),
    providerIdx: index("idx_dsd_provider").on(t.providerId),
    fkWalletTx: foreignKey({
      columns: [t.walletTransactionId],
      foreignColumns: [digitalWalletTransactions.id],
      name: "fk_dsd_wallet_tx",
    }),
  }),
);
export type DigitalSaleDetail = typeof digitalSaleDetails.$inferSelect;
export type InsertDigitalSaleDetail = typeof digitalSaleDetails.$inferInsert;

/**
 * عقود الاشتراكات التعليمية: يولدها البيع الناجح فقط من لقطات البيع المثبتة.
 * لا تغير أسعاراً أو محافظاً؛ التجديد بيع جديد يشير إلى العقد السابق.
 */
export const digitalSubscriptionContracts = mysqlTable(
  "digitalSubscriptionContracts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    offeringId: bigint("offeringId", { mode: "number" })
      .notNull()
      .references(() => digitalOfferings.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    invoiceId: bigint("invoiceId", { mode: "number" })
      .notNull()
      .references(() => invoices.id),
    invoiceItemId: bigint("invoiceItemId", { mode: "number" })
      .notNull()
      .references(() => invoiceItems.id)
      .unique("uq_dsub_invoice_item"),
    studentCustomerId: bigint("studentCustomerId", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    studentNameSnapshot: varchar("studentNameSnapshot", {
      length: 255,
    }).notNull(),
    durationDays: int("durationDays").notNull(),
    startsAt: timestamp("startsAt").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    previousContractId: bigint("previousContractId", { mode: "number" }),
    status: mysqlEnum("status", ["ACTIVE", "CANCELLED"])
      .default("ACTIVE")
      .notNull(),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    subscriberOfferingIdx: index("idx_dsub_subscriber_offering").on(
      t.studentCustomerId,
      t.offeringId,
    ),
    branchExpiryIdx: index("idx_dsub_branch_expiry").on(
      t.branchId,
      t.expiresAt,
    ),
  }),
);
export type DigitalSubscriptionContract =
  typeof digitalSubscriptionContracts.$inferSelect;
export type InsertDigitalSubscriptionContract =
  typeof digitalSubscriptionContracts.$inferInsert;

/**
 * مطابقة أرصدة المحفظة الرقمية: مقارنة الرصيد المتوقّع بالفعلي لكل محفظة × يوم.
 */
export const digitalWalletReconciliations = mysqlTable(
  "digitalWalletReconciliations",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    walletId: bigint("walletId", { mode: "number" })
      .notNull()
      .references(() => digitalWallets.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    businessDate: date("businessDate", { mode: "string" }).notNull(),
    expectedBalance: decimal("expectedBalance", {
      precision: 15,
      scale: 2,
    }).notNull(),
    actualBalance: decimal("actualBalance", {
      precision: 15,
      scale: 2,
    }).notNull(),
    variance: decimal("variance", { precision: 15, scale: 2 }).notNull(),
    status: mysqlEnum("status", ["MATCHED", "VARIANCE_OPEN", "RESOLVED"])
      .default("MATCHED")
      .notNull(),
    countedBy: int("countedBy")
      .notNull()
      .references(() => users.id),
    reviewedBy: int("reviewedBy").references(() => users.id),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    reviewedAt: timestamp("reviewedAt"),
  },
  (t) => ({
    walletDateUq: unique("uq_dwrecon_wallet_date").on(
      t.walletId,
      t.businessDate,
    ),
    branchIdx: index("idx_dwrecon_branch").on(t.branchId),
  }),
);
export type DigitalWalletReconciliation =
  typeof digitalWalletReconciliations.$inferSelect;
export type InsertDigitalWalletReconciliation =
  typeof digitalWalletReconciliations.$inferInsert;

// ============================================================
// الدفتر المزدوج — P2 (هجرة 0172، خطة docs/double-entry-p2-plan-2026-08-11.md)
// جداولٌ **إضافيّة بحتة**: لا عمودٌ قائم يُعدَّل ولا سلوكُ قيدٍ حاليٍّ يتغيّر. الكتابة فيها محكومةٌ
// بعلَم `doubleEntrySettings.mode` وافتراضه `OFF` ⇒ النشر بصفر أثر (بوّابتا س١+س٢ في الخطة).
// ============================================================

/**
 * رأس القيد المزدوج — إمّا حدثٌ ماليّ في `accountingEntries`، أو لقطة افتتاح اصطناعية واحدة عند
 * بدء SHADOW. المصدر الاصطناعي لا يغيّر الدفتر المبسّط ولا يعيد كتابة التاريخ؛ وظيفته حمل أرصدة
 * القطع القديمة إلى اليومية كي لا يبدأ الدفتر المعتمد من صفر.
 *  - `status='POSTED'` ⇒ له أسطرٌ متوازنة في `journalLines`.
 *  - `status='UNMAPPED'` ⇒ **بلا أسطر**: نوعُ قيدٍ لم تُكتَب خريطته بعد. الفجوة تُسجَّل ولا تُفشِل
 *    عملية أعمال أبداً (س٣)، وعدّادها = بوّابة الانتقال إلى ACTIVE (س٧).
 *  - `ON DELETE CASCADE` إلزاميّ: `upsertOpeningEntry` يحذف قيوداً فعلاً ⇒ RESTRICT كان سيُفشل
 *    حذف رصيدٍ افتتاحيّ ويكسر عمليةً قائمة.
 */
export const journalEntries = mysqlTable(
  "journalEntries",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    entryId: bigint("entryId", { mode: "number" }).references(
      () => accountingEntries.id,
      {
        onDelete: "cascade",
      },
    ),
    sourceType: mysqlEnum("sourceType", ["ACCOUNTING_ENTRY", "SHADOW_OPENING"])
      .default("ACCOUNTING_ENTRY")
      .notNull(),
    /** مفتاح المصدر الاصطناعي؛ null لحدث accountingEntries، وفريدٌ للقطة الافتتاح. */
    sourceKey: varchar("sourceKey", { length: 120 }),
    /** القالب المحاسبي الموثّق الذي ولّد الأسطر؛ يبقى null للفجوة غير القابلة للترحيل. */
    postingProfile: varchar("postingProfile", { length: 64 }),
    /** يعزل دورات SHADOW المتعاقبة؛ لا يجوز أن تدخل يوميات دورة موقوفة في أرصدة الدورة الحالية. */
    cycleId: varchar("cycleId", { length: 36 }),
    entryDate: date("entryDate").notNull(),
    /**
     * Tier-3 #1 (٢٧/٨، هجرة 0272): FK صريحة إلى `branches.id` `ON DELETE RESTRICT`.
     * الحوكمة: سلسلة الاشتقاق `accountingEntries.branchId` (FK'd) → `journalEntries.branchId`
     * (كان بلا FK) → `journalLines.branchId` (كان بلا FK حتى Tier-2 #6). أُضيفت FK للطرفَين معاً
     * دفاعاً في العمق يمسك أيّ writeJournal بـbranchId خاطئ لحظة الإدراج.
     */
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
      { onDelete: "restrict" },
    ),
    status: mysqlEnum("status", ["POSTED", "UNMAPPED", "MEMO"])
      .default("POSTED")
      .notNull(),
    unmappedReason: varchar("unmappedReason", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    entryUq: unique("uq_journal_entry").on(t.entryId),
    sourceUq: unique("uq_journal_source_key").on(t.sourceKey),
    dateStatusIdx: index("idx_journal_date_status").on(t.entryDate, t.status),
    cycleDateIdx: index("idx_journal_cycle_date").on(t.cycleId, t.entryDate),
  }),
);
export type JournalEntry = typeof journalEntries.$inferSelect;
export type InsertJournalEntry = typeof journalEntries.$inferInsert;

/**
 * سطر القيد المزدوج: مدينٌ أو دائن (أحدهما صفر دائماً، والقيم غير سالبة — العكوس تُمرَّر كقيودٍ
 * عكسيّة صريحة، يفرضه `postingEngine.nonNeg`). `role` = `accounts.systemRole`؛ الوصل بشجرة
 * الحسابات وقت التقرير بـJOIN لا وقت الكتابة (يُجنّب بحثَ حسابٍ في مسار البيع الساخن).
 */
export const journalLines = mysqlTable(
  "journalLines",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    journalId: bigint("journalId", { mode: "number" })
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 40 }).notNull(),
    /**
     * Tier-2 #5 (٢٦/٨، هجرة 0270): FK صريحة إلى `accounts.id` — يُغني عن ربط soft-link
     * عبر `role`→`systemRole` (بلا FK، بلا حماية إعادة تسمية، ولا يدعم حساباً بلا systemRole).
     * Nullable ⇒ صفوف SHADOW قديمة تبقى صحيحة، والكاتب الجديد يملؤه دائماً.
     * `ON DELETE RESTRICT`: حسابٌ استُعمل في يوميّة لا يُحذَف (قرارٌ محاسبيّ).
     */
    accountId: bigint("accountId", { mode: "number" }).references(
      () => accounts.id,
      { onDelete: "restrict" },
    ),
    /**
     * Tier-2 #6 (٢٦/٨، هجرة 0271): بعدٌ تحليليّ على مستوى السطر — `branchId`.
     * `journalEntries.branchId` قائمٌ على مستوى الرأس، لكنّ قيداً واحداً قد يشمل حركاتٍ
     * من فروعٍ مختلفة (تحويلٌ بين فروع، تسويةٌ متعدّدة). البعد على السطر يُمكّن ميزان
     * مراجعةٍ بالفرع، وP&L أدقّ، وحصّةً لكل فرعٍ من مصروفٍ مشترك دون تفكيك الرأس.
     * Tier-3 #1 (٢٧/٨، هجرة 0272): FK حوكميّة إلى `branches.id` أُضيفت بالتنسيق مع
     * FK على `journalEntries.branchId` (كانتا بلا FK في وقت 0271 حتى نُنسّق البذر
     * في اختبارات الدفتر المزدوج). النمط الآن مطابقٌ لـ`accountingEntries.branchId`.
     */
    branchId: bigint("branchId", { mode: "number" }).references(
      () => branches.id,
      { onDelete: "restrict" },
    ),
    /**
     * Tier-3 #2 (٢٧/٨، هجرة 0273): أبعادُ الطرف على السطر — مرآةٌ لنمط `accountingEntries`
     * (customerId FK + supplierId FK + deliveryPartyId بلا FK). تُمكّن ميزان حساب العميل،
     * تحليل مصروف المورّد، وتعرّض عهدة المندوب دون مطابقةٍ يدويّة بالفواتير/الإيصالات.
     * كلها nullable — سطرٌ واحد يحمل بعداً واحداً في معظم الحالات (AR للعميل، AP للمورّد).
     */
    customerId: bigint("customerId", { mode: "number" }).references(
      () => customers.id,
      { onDelete: "restrict" },
    ),
    supplierId: bigint("supplierId", { mode: "number" }).references(
      () => suppliers.id,
      { onDelete: "restrict" },
    ),
    /** بلا FK — نظير `accountingEntries.deliveryPartyId`: قد يكون طرفٌ خارجيّ. */
    deliveryPartyId: bigint("deliveryPartyId", { mode: "number" }),
    /**
     * Tier-3 #4 (٢٧/٨، هجرة 0274): إكمالُ الأبعاد الثانويّة.
     * `exchangeHouseId` FK إلى exchangeHouses (RESTRICT) — لقيود EXCHANGE_*.
     * `digitalWalletId` بلا FK — مرآةٌ لـaccountingEntries: قد يكون خارجياً.
     */
    exchangeHouseId: bigint("exchangeHouseId", { mode: "number" }).references(
      () => exchangeHouses.id,
      { onDelete: "restrict" },
    ),
    digitalWalletId: bigint("digitalWalletId", { mode: "number" }),
    /** لقطة إصدار الامتثال والحساب النظامي وقت الترحيل؛ لا JOIN حي يعيد تصنيف التاريخ. */
    statutoryProfileId: bigint("statutoryProfileId", {
      mode: "number",
    }),
    statutoryAccountId: bigint("statutoryAccountId", {
      mode: "number",
    }),
    debit: decimal("debit", { precision: 15, scale: 2 }).default("0").notNull(),
    credit: decimal("credit", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
  },
  (t) => ({
    roleIdx: index("idx_journal_line_role").on(t.role),
    accountIdx: index("idx_journal_line_account").on(t.accountId),
    branchIdx: index("idx_journal_line_branch").on(t.branchId),
    customerIdx: index("idx_journal_line_customer").on(t.customerId),
    supplierIdx: index("idx_journal_line_supplier").on(t.supplierId),
    deliveryPartyIdx: index("idx_journal_line_delivery_party").on(t.deliveryPartyId),
    exchangeHouseIdx: index("idx_journal_line_exchange_house").on(t.exchangeHouseId),
    digitalWalletIdx: index("idx_journal_line_digital_wallet").on(t.digitalWalletId),
    statutoryIdx: index("idx_journal_line_statutory").on(
      t.statutoryProfileId,
      t.statutoryAccountId,
    ),
    statutoryProfileFk: foreignKey({
      name: "fk_journal_line_stat_profile",
      columns: [t.statutoryProfileId],
      foreignColumns: [statutoryAccountingProfiles.id],
    }).onDelete("restrict"),
    statutoryAccountFk: foreignKey({
      name: "fk_journal_line_stat_account",
      columns: [t.statutoryAccountId],
      foreignColumns: [statutoryAccounts.id],
    }).onDelete("restrict"),
  }),
);
export type JournalLineRow = typeof journalLines.$inferSelect;
export type InsertJournalLineRow = typeof journalLines.$inferInsert;

/**
 * علَم أوضاع الدفتر المزدوج (صفٌّ مفرد، نمط `taxSettings`):
 *  - `OFF` (الافتراض) — لا كتابة إطلاقاً. صفر أثرٍ على الإنتاج.
 *  - `SHADOW` — كتابةٌ موازيةٌ للمطابقة فقط؛ الدفتر المُعتمَد يبقى المبسّط.
 *  - `ACTIVE` — الدفتر المزدوج مصدرُ التقارير المحاسبية. **لا يُبلَغ إلّا ببوّابةٍ آليّة** (س٧):
 *    ≥٣٠ يوماً SHADOW + صفر فجوات + انحراف مطابقةٍ = 0.00 + كل أنواع `EntryType` مُخطَّطة.
 */
export const doubleEntrySettings = mysqlTable("doubleEntrySettings", {
  id: int("id").default(1).primaryKey(),
  mode: mysqlEnum("mode", ["OFF", "SHADOW", "ACTIVE"]).default("OFF").notNull(),
  shadowStartedAt: timestamp("shadowStartedAt"),
  /** معرف ثابت لدورة OFF→SHADOW→ACTIVE الحالية؛ يُسجل على كل رأس يومية. */
  shadowCycleId: varchar("shadowCycleId", { length: 36 }),
  /** بصمة لقطة القطع الافتتاحية التي وافق عليها الأدمن عند بدء SHADOW. */
  shadowOpeningHash: varchar("shadowOpeningHash", { length: 64 }),
  /** مرجع مصادقة محاسبٍ بشري على سياسات الخرائط الملتبسة؛ غيابه يحجب ACTIVE. */
  policyApprovalReference: varchar("policyApprovalReference", { length: 255 }),
  /** Exact posting-policy revision covered by the accountant approval. */
  policyApprovalPolicyHash: char("policyApprovalPolicyHash", { length: 64 }),
  /** Shadow cycle and opening snapshot covered by the same approval. */
  policyApprovalCycleId: varchar("policyApprovalCycleId", { length: 36 }),
  policyApprovalOpeningHash: char("policyApprovalOpeningHash", { length: 64 }),
  policyAccountantName: varchar("policyAccountantName", { length: 150 }),
  policyApprovedAt: timestamp("policyApprovedAt"),
  policyApprovedBy: int("policyApprovedBy").references(() => users.id),
  updatedBy: int("updatedBy").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type DoubleEntrySettings = typeof doubleEntrySettings.$inferSelect;

/**
 * طلبات إقفال الشهر (ش٥ب، هجرة 0173) — قرار المالك (١١/٨): **المدير يطلُب، والأدمن/المالك يُقفل**،
 * و**لا تجاوز للحاجز إطلاقاً**. السبب من الكود لا افتراضاً: `lockPeriod` عامٌّ على الشركة كلّها
 * (`financialPeriods` بلا branchId) ومحصورٌ بـadminProcedure منذ بنائه ⇒ فتحُه للمدير إضعافُ ضابط.
 *
 * بلا `branchId` عمداً: القفل عامّ فالطلب عامّ، والجاهزية تُحسب لكل الفروع حتماً (جاهزيةٌ مُنطَّقةٌ
 * بفرع الطالب كانت ستُجيز الإقفال وفرعٌ آخر فيه وردية مفتوحة).
 */
export const monthCloseRequests = mysqlTable(
  "monthCloseRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    month: varchar("month", { length: 7 }).notNull(),
    status: mysqlEnum("status", ["PENDING_APPROVAL", "APPROVED", "REJECTED"])
      .default("PENDING_APPROVAL")
      .notNull(),
    /** لقطة الجاهزية وقت الطلب (JSON) — **للتدقيق فقط**؛ الاعتماد يُعيد الفحص حيّاً. */
    readinessSnapshot: text("readinessSnapshot").notNull(),
    requestedBy: int("requestedBy")
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    decidedBy: int("decidedBy").references(() => users.id),
    decidedAt: timestamp("decidedAt"),
    rejectionReason: varchar("rejectionReason", { length: 500 }),
    /** financialPeriods.id الناتج عن الاعتماد — أثرٌ مباشر من الطلب إلى القفل الذي أنتجه. */
    lockedPeriodId: bigint("lockedPeriodId", { mode: "number" }),
    /** Revision proposed under the serialized company close frontier. */
    closeRevision: int("closeRevision"),
    /** Optimistic trace only; approval rechecks the live singleton. */
    requestedSequenceVersion: bigint("requestedSequenceVersion", {
      mode: "number",
    }),
    /** حارس «طلبٌ معلَّقٌ واحدٌ لكل شهر»: الشهر عند الإنشاء، NULL عند الحسم (نمط shifts.openGuard). */
    pendingGuard: varchar("pendingGuard", { length: 7 }).unique(
      "uq_month_close_pending",
    ),
  },
  (t) => ({
    statusRequestedIdx: index("idx_mcr_status_requested").on(
      t.status,
      t.requestedAt,
    ),
    sequenceIdentityCheck: check(
      "chk_mcr_sequence_identity",
      sql`(
        (${t.closeRevision} IS NULL AND ${t.requestedSequenceVersion} IS NULL) OR
        (${t.closeRevision} > 0 AND ${t.requestedSequenceVersion} >= 0)
      )`,
    ),
  }),
);
export type MonthCloseRequest = typeof monthCloseRequests.$inferSelect;

/** Immutable approval-time seal. Lifecycle is derived from append-only events. */
export const monthCloseCertificates = mysqlTable(
  "monthCloseCertificates",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    certificateNumber: varchar("certificateNumber", { length: 32 })
      .notNull()
      .unique("uq_month_close_certificate_number"),
    month: varchar("month", { length: 7 }).notNull(),
    revision: int("revision").notNull(),
    kind: mysqlEnum("monthCloseCertificateKind", [
      "MONTH_CLOSE",
      "YEAR_END",
    ]).notNull(),
    requestId: bigint("requestId", { mode: "number" })
      .notNull()
      .unique("uq_month_close_certificate_request"),
    periodId: bigint("periodId", { mode: "number" })
      .notNull()
      .unique("uq_month_close_certificate_period"),
    supersedesCertificateId: bigint("supersedesCertificateId", {
      mode: "number",
    }),
    previousCertificateId: bigint("previousCertificateId", {
      mode: "number",
    }),
    previousCertificateHash: char("previousCertificateHash", { length: 64 }),
    yearEndSnapshotId: bigint("yearEndSnapshotId", {
      mode: "number",
    }),
    retainedEarningsEntryId: bigint("retainedEarningsEntryId", {
      mode: "number",
    }),
    requestedBy: int("requestedBy").notNull(),
    requestedAt: timestamp("requestedAt").notNull(),
    approvedBy: int("approvedBy").notNull(),
    approvedAt: timestamp("approvedAt").notNull(),
    doubleEntryMode: mysqlEnum("certificateDoubleEntryMode", [
      "OFF",
      "SHADOW",
      "ACTIVE",
    ]).notNull(),
    cycleId: varchar("cycleId", { length: 36 }),
    openingHash: char("openingHash", { length: 64 }),
    postingPolicyHash: char("postingPolicyHash", { length: 64 }),
    canonicalVersion: varchar("canonicalVersion", { length: 32 }).notNull(),
    requestSnapshotHash: char("requestSnapshotHash", { length: 64 }).notNull(),
    approvalReadinessHash: char("approvalReadinessHash", {
      length: 64,
    }).notNull(),
    evidenceRootHash: char("evidenceRootHash", { length: 64 }).notNull(),
    snapshotCanonical: mediumtext("snapshotCanonical").notNull(),
    snapshotHash: char("snapshotHash", { length: 64 }).notNull(),
    certificateHash: char("certificateHash", { length: 64 })
      .notNull()
      .unique("uq_month_close_certificate_hash"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    monthRevisionUq: unique("uq_month_close_certificate_revision").on(
      t.month,
      t.revision,
    ),
    monthIdx: index("idx_month_close_certificate_month").on(t.month, t.id),
    requestFk: foreignKey({
      name: "fk_mcc_request",
      columns: [t.requestId],
      foreignColumns: [monthCloseRequests.id],
    }),
    periodFk: foreignKey({
      name: "fk_mcc_period",
      columns: [t.periodId],
      foreignColumns: [financialPeriods.id],
    }),
    supersedesFk: foreignKey({
      name: "fk_mcc_supersedes",
      columns: [t.supersedesCertificateId],
      foreignColumns: [t.id],
    }),
    previousFk: foreignKey({
      name: "fk_mcc_previous",
      columns: [t.previousCertificateId],
      foreignColumns: [t.id],
    }),
    yearEndFk: foreignKey({
      name: "fk_mcc_year_end",
      columns: [t.yearEndSnapshotId],
      foreignColumns: [yearEndSnapshots.id],
    }),
    retainedEntryFk: foreignKey({
      name: "fk_mcc_retained_entry",
      columns: [t.retainedEarningsEntryId],
      foreignColumns: [accountingEntries.id],
    }),
    requestedByFk: foreignKey({
      name: "fk_mcc_requested_by",
      columns: [t.requestedBy],
      foreignColumns: [users.id],
    }),
    approvedByFk: foreignKey({
      name: "fk_mcc_approved_by",
      columns: [t.approvedBy],
      foreignColumns: [users.id],
    }),
    identityCheck: check(
      "chk_mcc_identity",
      sql`${t.month} REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$' AND ${t.revision} > 0 AND ${t.requestedBy} <> ${t.approvedBy}`,
    ),
    previousPairCheck: check(
      "chk_mcc_previous_pair",
      sql`(
        (${t.previousCertificateId} IS NULL AND ${t.previousCertificateHash} IS NULL) OR
        (${t.previousCertificateId} IS NOT NULL AND ${t.previousCertificateHash} IS NOT NULL)
      )`,
    ),
    kindRefsCheck: check(
      "chk_mcc_kind_refs",
      sql`(
        (${t.kind} = 'MONTH_CLOSE' AND ${t.yearEndSnapshotId} IS NULL AND ${t.retainedEarningsEntryId} IS NULL) OR
        (${t.kind} = 'YEAR_END' AND ${t.yearEndSnapshotId} IS NOT NULL)
      )`,
    ),
    runtimeTupleCheck: check(
      "chk_mcc_runtime_tuple",
      sql`(
        (${t.doubleEntryMode} = 'OFF' AND ${t.cycleId} IS NULL AND ${t.openingHash} IS NULL) OR
        (${t.doubleEntryMode} IN ('SHADOW','ACTIVE') AND ${t.cycleId} IS NOT NULL AND ${t.openingHash} IS NOT NULL AND ${t.postingPolicyHash} IS NOT NULL)
      )`,
    ),
  }),
);
export type MonthCloseCertificate = typeof monthCloseCertificates.$inferSelect;

/** Chunked immutable manifests covered by the certificate evidence root. */
export const monthCloseCertificateEvidence = mysqlTable(
  "monthCloseCertificateEvidence",
  {
    certificateId: bigint("certificateId", { mode: "number" }).notNull(),
    datasetCode: varchar("datasetCode", { length: 48 }).notNull(),
    chunkNo: int("chunkNo").default(1).notNull(),
    rowCount: int("rowCount").notNull(),
    minId: bigint("minId", { mode: "number" }),
    maxId: bigint("maxId", { mode: "number" }),
    canonicalRowsHash: char("canonicalRowsHash", { length: 64 }).notNull(),
    referenceCanonical: mediumtext("referenceCanonical").notNull(),
  },
  (t) => ({
    pk: primaryKey({
      name: "pk_mcce",
      columns: [t.certificateId, t.datasetCode, t.chunkNo],
    }),
    certificateFk: foreignKey({
      name: "fk_mcce_certificate",
      columns: [t.certificateId],
      foreignColumns: [monthCloseCertificates.id],
    }),
    chunkShapeCheck: check(
      "chk_mcce_chunk_shape",
      sql`${t.chunkNo} > 0 AND ${t.rowCount} >= 0 AND (
        (${t.minId} IS NULL AND ${t.maxId} IS NULL) OR
        (${t.minId} IS NOT NULL AND ${t.maxId} IS NOT NULL AND ${t.minId} <= ${t.maxId})
      )`,
    ),
  }),
);
export type MonthCloseCertificateEvidence =
  typeof monthCloseCertificateEvidence.$inferSelect;

/** Append-only bootstrap/close/unlock lifecycle chain. */
export const monthCloseEvents = mysqlTable(
  "monthCloseEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    eventKey: varchar("eventKey", { length: 96 })
      .notNull()
      .unique("uq_month_close_event_key"),
    eventType: mysqlEnum("monthCloseEventType", [
      "BOOTSTRAP",
      "CLOSE",
      "UNLOCK",
    ]).notNull(),
    month: varchar("month", { length: 7 }),
    requestId: bigint("requestId", { mode: "number" }),
    periodId: bigint("periodId", { mode: "number" }),
    certificateId: bigint("certificateId", { mode: "number" }),
    actorId: int("actorId").notNull(),
    occurredAt: timestamp("occurredAt").notNull(),
    reason: varchar("reason", { length: 500 }),
    payloadCanonical: mediumtext("payloadCanonical").notNull(),
    previousEventHash: char("previousEventHash", { length: 64 }),
    eventHash: char("eventHash", { length: 64 })
      .notNull()
      .unique("uq_month_close_event_hash"),
  },
  (t) => ({
    monthIdx: index("idx_month_close_event_month").on(t.month, t.id),
    requestFk: foreignKey({
      name: "fk_mce_request",
      columns: [t.requestId],
      foreignColumns: [monthCloseRequests.id],
    }),
    periodFk: foreignKey({
      name: "fk_mce_period",
      columns: [t.periodId],
      foreignColumns: [financialPeriods.id],
    }),
    certificateFk: foreignKey({
      name: "fk_mce_certificate",
      columns: [t.certificateId],
      foreignColumns: [monthCloseCertificates.id],
    }),
    actorFk: foreignKey({
      name: "fk_mce_actor",
      columns: [t.actorId],
      foreignColumns: [users.id],
    }),
    referenceShapeCheck: check(
      "chk_mce_reference_shape",
      sql`(
        (${t.eventType} = 'BOOTSTRAP' AND ${t.requestId} IS NULL AND ${t.certificateId} IS NULL AND
          ((${t.month} IS NULL AND ${t.periodId} IS NULL) OR (${t.month} IS NOT NULL AND ${t.periodId} IS NOT NULL))) OR
        (${t.eventType} = 'CLOSE' AND ${t.month} IS NOT NULL AND ${t.requestId} IS NOT NULL AND ${t.periodId} IS NOT NULL AND ${t.certificateId} IS NOT NULL) OR
        (${t.eventType} = 'UNLOCK' AND ${t.month} IS NOT NULL AND ${t.requestId} IS NULL AND ${t.periodId} IS NOT NULL)
      )`,
    ),
  }),
);
export type MonthCloseEvent = typeof monthCloseEvents.$inferSelect;

/** Mutable operational projection; immutable evidence lives above. */
export const monthCloseSequence = mysqlTable(
  "monthCloseSequence",
  {
    id: int("id").default(1).primaryKey(),
    status: mysqlEnum("monthCloseSequenceStatus", ["NEEDS_BOOTSTRAP", "READY"])
      .default("NEEDS_BOOTSTRAP")
      .notNull(),
    sequenceStartMonth: varchar("sequenceStartMonth", { length: 7 }),
    activeThroughMonth: varchar("activeThroughMonth", { length: 7 }),
    nextRequiredMonth: varchar("nextRequiredMonth", { length: 7 }),
    activePeriodId: bigint("activePeriodId", { mode: "number" }),
    activeCertificateId: bigint("activeCertificateId", { mode: "number" }),
    lastEventId: bigint("lastEventId", { mode: "number" }),
    lastEventHash: char("lastEventHash", { length: 64 }),
    version: bigint("version", { mode: "number" }).default(0).notNull(),
    bootstrappedAt: timestamp("bootstrappedAt"),
    bootstrappedBy: int("bootstrappedBy"),
    bootstrapReason: varchar("bootstrapReason", { length: 500 }),
    bootstrapReference: varchar("bootstrapReference", { length: 255 }),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    activePeriodFk: foreignKey({
      name: "fk_mcs_period",
      columns: [t.activePeriodId],
      foreignColumns: [financialPeriods.id],
    }),
    activeCertificateFk: foreignKey({
      name: "fk_mcs_certificate",
      columns: [t.activeCertificateId],
      foreignColumns: [monthCloseCertificates.id],
    }),
    lastEventFk: foreignKey({
      name: "fk_mcs_event",
      columns: [t.lastEventId],
      foreignColumns: [monthCloseEvents.id],
    }),
    bootstrappedByFk: foreignKey({
      name: "fk_mcs_bootstrap_by",
      columns: [t.bootstrappedBy],
      foreignColumns: [users.id],
    }),
    singletonCheck: check(
      "chk_month_close_sequence_singleton",
      sql`${t.id} = 1`,
    ),
    statusTupleCheck: check(
      "chk_mcs_status_tuple",
      sql`(
        (${t.status} = 'NEEDS_BOOTSTRAP' AND ${t.sequenceStartMonth} IS NULL AND ${t.nextRequiredMonth} IS NULL) OR
        (${t.status} = 'READY' AND ${t.sequenceStartMonth} IS NOT NULL AND ${t.nextRequiredMonth} IS NOT NULL
          AND ${t.version} > 0 AND ${t.bootstrappedAt} IS NOT NULL AND ${t.bootstrappedBy} IS NOT NULL
          AND ${t.bootstrapReason} IS NOT NULL AND ${t.bootstrapReference} IS NOT NULL)
      )`,
    ),
  }),
);
export type MonthCloseSequence = typeof monthCloseSequence.$inferSelect;

/**
 * طلبات فتح نهاية السنة — maker/checker صريح، والاعتماد وحده ينشئ عكساً مطابقاً
 * للقيد المحتفظ به ثم يعيد واجهة الإقفال إلى ديسمبر. لا حذف ولا backfill ضمني.
 */
export const yearEndReopenRequests = mysqlTable(
  "yearEndReopenRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    year: int("year").notNull(),
    snapshotId: bigint("snapshotId", { mode: "number" }).notNull(),
    certificateId: bigint("certificateId", { mode: "number" }).notNull(),
    periodId: bigint("periodId", { mode: "number" }).notNull(),
    status: mysqlEnum("yearEndReopenStatus", [
      "PENDING_APPROVAL",
      "APPROVED",
      "REJECTED",
    ])
      .default("PENDING_APPROVAL")
      .notNull(),
    /** Unique only while pending; cleared on decision so a later revision can be reopened. */
    pendingSnapshotId: bigint("pendingSnapshotId", { mode: "number" }),
    clientRequestId: varchar("clientRequestId", { length: 64 }).notNull(),
    requestPayloadHash: char("requestPayloadHash", { length: 64 }).notNull(),
    requestedBy: int("requestedBy").notNull(),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    decidedBy: int("decidedBy"),
    decidedAt: timestamp("decidedAt"),
    decisionReason: varchar("decisionReason", { length: 500 }),
    reversalEntryId: bigint("reversalEntryId", { mode: "number" }),
    reopenEventId: bigint("reopenEventId", { mode: "number" }),
  },
  (t) => ({
    clientRequestUq: unique("uq_yerr_client_request").on(t.clientRequestId),
    pendingSnapshotUq: unique("uq_yerr_pending_snapshot").on(
      t.pendingSnapshotId,
    ),
    reversalEntryUq: unique("uq_yerr_reversal_entry").on(t.reversalEntryId),
    reopenEventUq: unique("uq_yerr_reopen_event").on(t.reopenEventId),
    yearStatusIdx: index("idx_yerr_year_status").on(
      t.year,
      t.status,
      t.requestedAt,
    ),
    snapshotFk: foreignKey({
      name: "fk_yerr_snapshot",
      columns: [t.snapshotId],
      foreignColumns: [yearEndSnapshots.id],
    }),
    certificateFk: foreignKey({
      name: "fk_yerr_certificate",
      columns: [t.certificateId],
      foreignColumns: [monthCloseCertificates.id],
    }),
    periodFk: foreignKey({
      name: "fk_yerr_period",
      columns: [t.periodId],
      foreignColumns: [financialPeriods.id],
    }),
    pendingSnapshotFk: foreignKey({
      name: "fk_yerr_pending_snapshot",
      columns: [t.pendingSnapshotId],
      foreignColumns: [yearEndSnapshots.id],
    }),
    requestedByFk: foreignKey({
      name: "fk_yerr_requested_by",
      columns: [t.requestedBy],
      foreignColumns: [users.id],
    }),
    decidedByFk: foreignKey({
      name: "fk_yerr_decided_by",
      columns: [t.decidedBy],
      foreignColumns: [users.id],
    }),
    reversalEntryFk: foreignKey({
      name: "fk_yerr_reversal_entry",
      columns: [t.reversalEntryId],
      foreignColumns: [accountingEntries.id],
    }),
    reopenEventFk: foreignKey({
      name: "fk_yerr_reopen_event",
      columns: [t.reopenEventId],
      foreignColumns: [monthCloseEvents.id],
    }),
    identityCheck: check(
      "chk_yerr_identity",
      sql`${t.year} BETWEEN 2020 AND 2100 AND CHAR_LENGTH(TRIM(${t.reason})) >= 10 AND CHAR_LENGTH(${t.requestPayloadHash}) = 64`,
    ),
    makerCheckerCheck: check(
      "chk_yerr_maker_checker",
      sql`${t.decidedBy} IS NULL OR ${t.decidedBy} <> ${t.requestedBy}`,
    ),
    lifecycleCheck: check(
      "chk_yerr_lifecycle",
      sql`(
        (${t.status} = 'PENDING_APPROVAL' AND ${t.pendingSnapshotId} = ${t.snapshotId}
          AND ${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL AND ${t.decisionReason} IS NULL
          AND ${t.reversalEntryId} IS NULL AND ${t.reopenEventId} IS NULL) OR
        (${t.status} = 'APPROVED' AND ${t.pendingSnapshotId} IS NULL
          AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL
          AND CHAR_LENGTH(TRIM(${t.decisionReason})) >= 5
          AND ${t.reversalEntryId} IS NOT NULL AND ${t.reopenEventId} IS NOT NULL) OR
        (${t.status} = 'REJECTED' AND ${t.pendingSnapshotId} IS NULL
          AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL
          AND CHAR_LENGTH(TRIM(${t.decisionReason})) >= 5
          AND ${t.reversalEntryId} IS NULL AND ${t.reopenEventId} IS NULL)
      )`,
    ),
  }),
);
export type YearEndReopenRequest = typeof yearEndReopenRequests.$inferSelect;
export type InsertYearEndReopenRequest =
  typeof yearEndReopenRequests.$inferInsert;

/**
 * إعلانات الموظفين الداخلية — الإدارة تنشر، والموظفون المستهدَفون يقرؤون/يُقرّون.
 * (فجوة إصدار حسمها collaboration-contract-audit: API + مفتاح صلاحيات + نموذج إقرار + عقد جمهور.)
 * الجمهور: ALL كل الموظفين · BRANCH فرعٌ بعينه (audienceBranchId) · ROLE دورٌ بعينه (audienceRole).
 */
export const announcements = mysqlTable(
  "announcements",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    body: text("body").notNull(),
    priority: mysqlEnum("announcementPriority", [
      "NORMAL",
      "IMPORTANT",
      "CRITICAL",
    ])
      .default("NORMAL")
      .notNull(),
    audienceType: mysqlEnum("announcementAudience", [
      "ALL",
      "BRANCH",
      "ROLE",
    ]).notNull(),
    audienceBranchId: bigint("audienceBranchId", { mode: "number" }).references(
      () => branches.id,
    ),
    audienceRole: varchar("audienceRole", { length: 40 }),
    /** هل يجب على الموظف الإقرار صراحةً بقراءته (لا مجرد فتحه)؟ */
    requiresAck: boolean("requiresAck").default(false).notNull(),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    isActive: boolean("isActive").default(true).notNull(),
    expiresAt: timestamp("expiresAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    activeIdx: index("idx_announcement_active").on(
      table.isActive,
      table.createdAt,
    ),
    audienceIdx: index("idx_announcement_audience").on(
      table.audienceType,
      table.audienceBranchId,
    ),
  }),
);
export type Announcement = typeof announcements.$inferSelect;

/** سجلّ قراءة/إقرار الموظف للإعلان — صفٌّ واحد لكل (إعلان × مستخدم). acknowledgedAt يُملأ عند الإقرار الصريح. */
export const announcementReads = mysqlTable(
  "announcementReads",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    announcementId: bigint("announcementId", { mode: "number" })
      .notNull()
      .references(() => announcements.id),
    userId: int("userId")
      .notNull()
      .references(() => users.id),
    readAt: timestamp("readAt").defaultNow().notNull(),
    acknowledgedAt: timestamp("acknowledgedAt"),
  },
  (table) => ({
    uniq: unique("uq_announcement_read").on(table.announcementId, table.userId),
    userIdx: index("idx_announcement_read_user").on(table.userId),
  }),
);
export type AnnouncementRead = typeof announcementReads.$inferSelect;

/**
 * 0186 — طابور استرداد المبيعات الأوفلاينية المرفوضة (المسار و-٤، ورقة الإصلاحات ١٦/٨).
 *
 * الجذر: حين يصل بيعٌ نقديّ التُقط أوفلاين **بعد إغلاق ورديته** (أو تجاوز ٧٢ ساعة)، يرفضه
 * الخادم بـ`PRECONDITION_FAILED` ولا يكتب شيئاً — بينما الزبون **دفع فعلاً والبضاعة خرجت**.
 * كان العنصر يبقى في طابور الجهاز وحده ⇒ إيرادٌ ومخزونٌ ونقدٌ خارج الدفتر، تضيع نهائياً
 * إن مُسحت بيانات المتصفّح. رسالة الرفض نفسها كانت تُحيل إلى «مراجعة التسوية اللاحقة» — وهي
 * غير موجودة. هذا الجدول هو تلك المراجعة: يلتقط الحمولة **خادمياً** لحظة الرفض فلا تعتمد
 * نجاتها على جهازٍ قد يُمسح، ثم يُرحّلها المدير بقرارٍ مُدقَّق إلى وردية مفتوحة.
 *
 * ليس دفتراً: صفٌّ هنا **لا يُنشئ أثراً مالياً**. القيد يُكتب فقط عند الترحيل عبر `createSale`.
 */
export const offlineRecoveryItems = mysqlTable(
  "offlineRecoveryItems",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    branchId: bigint("branchId", { mode: "number" }).notNull(),
    deviceId: varchar("deviceId", { length: 64 }),
    /**
     * الكاشير الذي التقط البيع وأرسله. تُعاد إليه نسبة الفاتورة عند الترحيل: محرّك العمولات
     * ينسب الفاتورة بـ`invoices.createdBy` (`commissions/base.ts`)، و`createSale` يكتب فيه
     * الفاعل — أي المدير المُراجِع — فكانت كل عملية استرداد تُحوّل عمولة الكاشير إلى المدير.
     */
    submittedByUserId: int("submittedByUserId"),
    /**
     * قناة الالتقاط. الترحيل الآليّ يدعم RETAIL وحدها (حمولتها هي عقد `replayOfflineSale`)،
     * أمّا PRINT/RECEPTION فتُلتقَط **للرصد ومنع الضياع** وتُسوَّى يدوياً — إخفاؤها أسوأ من
     * عرضها بلا زرّ ترحيل.
     * و`RETURN` (هجرة 0327) **معاكسُ الاتجاه**: نقدٌ خرج للزبون لا دخل منه. تصنيفُه RETAIL
     * كان سيُقرأ بيعاً في طابورٍ عنوانُه «مبيعاتٌ مدفوعة» — والمدير يقرّر على الاتجاه.
     */
    channel: mysqlEnum("recoveryChannel", ["RETAIL", "PRINT", "RECEPTION", "RETURN"])
      .default("RETAIL")
      .notNull(),
    /** مفتاح idempotency الأصليّ — فريدٌ كي لا يتضاعف العنصر بإعادة محاولة الجهاز. */
    clientRequestId: varchar("clientRequestId", { length: 64 }).notNull(),
    offlineReceiptNumber: varchar("offlineReceiptNumber", {
      length: 40,
    }).notNull(),
    capturedAt: timestamp("capturedAt").notNull(),
    /** الحمولة كما أُرسلت (JSON نصّاً) — مصدر الترحيل لاحقاً بلا إعادة إدخال يدويّ. */
    payload: mediumtext("payload").notNull(),
    rejectCode: varchar("rejectCode", { length: 40 }).notNull(),
    rejectReason: text("rejectReason"),
    recoveryStatus: mysqlEnum("recoveryStatus", [
      "PENDING",
      "POSTED",
      "DISCARDED",
    ])
      .default("PENDING")
      .notNull(),
    /** الفاتورة الناتجة عند الترحيل — الرابط بين الاحتجاز والدفتر. */
    invoiceId: bigint("invoiceId", { mode: "number" }),
    reviewedBy: int("reviewedBy"),
    reviewedAt: timestamp("reviewedAt"),
    discardReason: text("discardReason"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    uqRequest: unique("uq_offline_recovery_request").on(table.clientRequestId),
    statusIdx: index("idx_offline_recovery_status").on(
      table.recoveryStatus,
      table.branchId,
    ),
  }),
);
export type OfflineRecoveryItem = typeof offlineRecoveryItems.$inferSelect;

/**
 * عدّادات المستندات (١٨/٨، هجرة 0211) — مصدر الأرقام التسلسلية القصيرة.
 *
 * لماذا جدولٌ مستقلّ بدل مسح `MAX(number)+1` كما كان: المسح `LIKE 'prefix%'` مع `FOR UPDATE`
 * **لا يقفل صفوفاً غير موجودة** في InnoDB (تعليقٌ محفور في numbering.ts) فيقرأ متزامنان نفس
 * القيمة؛ عولج بـGET_LOCK ترقيعاً لمولّدَين فقط، وبقيت سبعةُ مولّدات أخرى بلا حماية. الحجز
 * هنا ذرّيٌّ بعمليةٍ واحدة (`LAST_INSERT_ID` داخل ON DUPLICATE KEY UPDATE) — لا قفلَ صريحاً
 * ولا مسحَ ولا سباقَ ممكناً.
 */
export const documentCounters = mysqlTable("documentCounters", {
  counterKey: varchar("counterKey", { length: 64 }).primaryKey(),
  lastValue: bigint("lastValue", { mode: "number", unsigned: true })
    .notNull()
    .default(0),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type DocumentCounter = typeof documentCounters.$inferSelect;

/**
 * طلبات الإرجاع من المحطة (١٩/٨، هجرة 0213) — قرار المالك «طلب موظف + اعتماد مدير».
 *
 * لماذا: `returns.create` محصورٌ بالمدير، وموظّف الاستقبال يُقال له «استدعِ المدير» في
 * شاشته — بينما رفضُ الزبون وإرجاعُ المندوب **حدثٌ يوميّ**. فإمّا يتوقّف العمل حتى يحضر
 * المدير، أو يُحفَظ المرتجع بحسابه فتضيع نسبةُ الفاعل الحقيقيّ.
 *
 * النمط مستنسَخٌ من `stockAdjustmentRequests` حرفياً: الطلب **مستند نيّةٍ لا مال** (لا قيد
 * ولا إيصال ولا حركة مخزون حتى الاعتماد)، ولقطةٌ تفاؤلية تمنع اعتماد طلبٍ بُني على حالةٍ
 * لم تعد قائمة، والمُعتمِد ≠ المُنشئ.
 */
export const returnRequests = mysqlTable(
  "returnRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    invoiceId: bigint("invoiceId", { mode: "number" })
      .notNull()
      .references(() => invoices.id),
    branchId: bigint("branchId", { mode: "number" })
      .notNull()
      .references(() => branches.id),
    /** [{ invoiceItemId, baseQuantity }] — تُنفَّذ حرفياً عند الاعتماد. */
    linesJson: json("linesJson").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    /** لقطة `invoices.returnedTotal` لحظة الطلب — حارسٌ تفاؤليّ عند الاعتماد. */
    invoiceReturnedSnapshot: decimal("invoiceReturnedSnapshot", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    status: mysqlEnum("returnRequestStatus", [
      "PENDING_APPROVAL",
      "APPROVED",
      "REJECTED",
    ])
      .default("PENDING_APPROVAL")
      .notNull(),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    approvedBy: int("approvedBy").references(() => users.id),
    approvedAt: timestamp("approvedAt"),
    resultReturnInvoiceId: bigint("resultReturnInvoiceId", { mode: "number" }),
    rejectionReason: varchar("rejectionReason", { length: 500 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    statusBranchIdx: index("idx_retreq_status_branch").on(
      table.status,
      table.branchId,
    ),
    invoiceIdx: index("idx_retreq_invoice").on(table.invoiceId),
    creatorIdx: index("idx_retreq_creator").on(table.createdBy),
  }),
);
export type ReturnRequest = typeof returnRequests.$inferSelect;

/* ============================ مسار المبيعات والعمليات الحرجة (0311–0313) ============================ */

export const salesLeads = mysqlTable(
  "salesLeads",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    leadNumber: varchar("leadNumber", { length: 50 }).notNull(),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    source: mysqlEnum("source", ["WALK_IN", "PHONE", "WHATSAPP", "INSTAGRAM", "FACEBOOK", "WEBSITE", "REFERRAL", "CAMPAIGN", "OTHER"]).notNull(),
    contactName: varchar("contactName", { length: 255 }).notNull(),
    companyName: varchar("companyName", { length: 255 }),
    phone: varchar("phone", { length: 20 }),
    email: varchar("email", { length: 320 }),
    customerId: bigint("customerId", { mode: "number" }).references(() => customers.id),
    ownerId: int("ownerId").notNull().references(() => users.id),
    nextFollowUpAt: timestamp("nextFollowUpAt"),
    status: mysqlEnum("status", ["NEW", "CONTACTED", "QUALIFIED", "DISQUALIFIED", "CONVERTED"]).default("NEW").notNull(),
    lastReason: varchar("lastReason", { length: 500 }),
    version: int("version").default(1).notNull(),
    createKey: varchar("createKey", { length: 120 }).notNull(),
    createHash: char("createHash", { length: 64 }).notNull(),
    createdBy: int("createdBy").notNull().references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    numberUq: unique("uq_sales_lead_number").on(t.leadNumber),
    createKeyUq: unique("uq_sales_lead_create_key").on(t.createKey),
    branchStatusIdx: index("idx_sales_lead_branch_status").on(t.branchId, t.status),
    ownerFollowupIdx: index("idx_sales_lead_owner_followup").on(t.ownerId, t.nextFollowUpAt),
    customerIdx: index("idx_sales_lead_customer").on(t.customerId),
    versionCheck: check("chk_sales_lead_version", sql`${t.version} > 0`),
    contactCheck: check("chk_sales_lead_contact", sql`CHAR_LENGTH(TRIM(${t.contactName})) > 0`),
    disqualifiedReasonCheck: check("chk_sales_lead_disqualified_reason", sql`${t.status} <> 'DISQUALIFIED' OR ${t.lastReason} IS NOT NULL`),
  }),
);
export type SalesLead = typeof salesLeads.$inferSelect;
export type InsertSalesLead = typeof salesLeads.$inferInsert;

export const salesLeadEvents = mysqlTable(
  "salesLeadEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    eventKey: varchar("eventKey", { length: 120 }).notNull(),
    leadId: bigint("leadId", { mode: "number" }).notNull().references(() => salesLeads.id),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    eventType: mysqlEnum("eventType", ["CREATED", "UPDATED", "STATUS_CHANGED", "CONVERTED"]).notNull(),
    fromStatus: mysqlEnum("fromStatus", ["NEW", "CONTACTED", "QUALIFIED", "DISQUALIFIED", "CONVERTED"]),
    toStatus: mysqlEnum("toStatus", ["NEW", "CONTACTED", "QUALIFIED", "DISQUALIFIED", "CONVERTED"]),
    baseVersion: int("baseVersion").notNull(),
    resultVersion: int("resultVersion").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    payload: json("payload").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    actorUserId: int("actorUserId").notNull().references(() => users.id),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  },
  (t) => ({
    eventKeyUq: unique("uq_sales_lead_event_key").on(t.eventKey),
    leadTimeIdx: index("idx_sales_lead_event_lead_time").on(t.leadId, t.occurredAt),
    branchTimeIdx: index("idx_sales_lead_event_branch_time").on(t.branchId, t.occurredAt),
    versionsCheck: check("chk_sales_lead_event_versions", sql`${t.baseVersion} > 0 AND ${t.resultVersion} >= ${t.baseVersion}`),
  }),
);
export type SalesLeadEvent = typeof salesLeadEvents.$inferSelect;
export type InsertSalesLeadEvent = typeof salesLeadEvents.$inferInsert;

export const salesOpportunities = mysqlTable(
  "salesOpportunities",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    opportunityNumber: varchar("opportunityNumber", { length: 50 }).notNull(),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    leadId: bigint("leadId", { mode: "number" }).references(() => salesLeads.id),
    customerId: bigint("customerId", { mode: "number" }).references(() => customers.id),
    ownerId: int("ownerId").notNull().references(() => users.id),
    title: varchar("title", { length: 255 }).notNull(),
    stage: mysqlEnum("stage", ["DISCOVERY", "PROPOSAL", "NEGOTIATION", "WON", "LOST"]).default("DISCOVERY").notNull(),
    expectedValue: decimal("expectedValue", { precision: 15, scale: 2 }).notNull(),
    probability: decimal("probability", { precision: 5, scale: 2 }).notNull(),
    expectedCloseDate: date("expectedCloseDate", { mode: "string" }).notNull(),
    quotationId: bigint("quotationId", { mode: "number" }).references(() => quotations.id),
    invoiceId: bigint("invoiceId", { mode: "number" }).references(() => invoices.id),
    lastReason: varchar("lastReason", { length: 500 }),
    version: int("version").default(1).notNull(),
    createKey: varchar("createKey", { length: 120 }).notNull(),
    createHash: char("createHash", { length: 64 }).notNull(),
    createdBy: int("createdBy").notNull().references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    numberUq: unique("uq_sales_opp_number").on(t.opportunityNumber),
    createKeyUq: unique("uq_sales_opp_create_key").on(t.createKey),
    leadUq: unique("uq_sales_opp_lead").on(t.leadId),
    quotationUq: unique("uq_sales_opp_quotation").on(t.quotationId),
    invoiceUq: unique("uq_sales_opp_invoice").on(t.invoiceId),
    branchStageIdx: index("idx_sales_opp_branch_stage").on(t.branchId, t.stage),
    ownerCloseIdx: index("idx_sales_opp_owner_close").on(t.ownerId, t.expectedCloseDate),
    customerIdx: index("idx_sales_opp_customer").on(t.customerId),
    valueProbabilityCheck: check("chk_sales_opp_value_probability", sql`${t.expectedValue} >= 0 AND ${t.probability} >= 0 AND ${t.probability} <= 100`),
    versionCheck: check("chk_sales_opp_version", sql`${t.version} > 0`),
    partyCheck: check("chk_sales_opp_party", sql`${t.leadId} IS NOT NULL OR ${t.customerId} IS NOT NULL`),
    wonInvoiceCheck: check("chk_sales_opp_won_invoice", sql`(${t.stage} = 'WON' AND ${t.invoiceId} IS NOT NULL) OR (${t.stage} <> 'WON' AND ${t.invoiceId} IS NULL)`),
    lostReasonCheck: check("chk_sales_opp_lost_reason", sql`${t.stage} <> 'LOST' OR ${t.lastReason} IS NOT NULL`),
  }),
);
export type SalesOpportunity = typeof salesOpportunities.$inferSelect;
export type InsertSalesOpportunity = typeof salesOpportunities.$inferInsert;

export const salesOpportunityEvents = mysqlTable(
  "salesOpportunityEvents",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    eventKey: varchar("eventKey", { length: 120 }).notNull(),
    opportunityId: bigint("opportunityId", { mode: "number" }).notNull().references(() => salesOpportunities.id),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    eventType: mysqlEnum("eventType", ["CREATED", "UPDATED", "STAGE_CHANGED"]).notNull(),
    fromStage: mysqlEnum("fromStage", ["DISCOVERY", "PROPOSAL", "NEGOTIATION", "WON", "LOST"]),
    toStage: mysqlEnum("toStage", ["DISCOVERY", "PROPOSAL", "NEGOTIATION", "WON", "LOST"]),
    baseVersion: int("baseVersion").notNull(),
    resultVersion: int("resultVersion").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    payload: json("payload").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    actorUserId: int("actorUserId").notNull().references(() => users.id),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  },
  (t) => ({
    eventKeyUq: unique("uq_sales_opp_event_key").on(t.eventKey),
    opportunityTimeIdx: index("idx_sales_opp_event_opp_time").on(t.opportunityId, t.occurredAt),
    branchTimeIdx: index("idx_sales_opp_event_branch_time").on(t.branchId, t.occurredAt),
    versionsCheck: check("chk_sales_opp_event_versions", sql`${t.baseVersion} > 0 AND ${t.resultVersion} >= ${t.baseVersion}`),
  }),
);
export type SalesOpportunityEvent = typeof salesOpportunityEvents.$inferSelect;
export type InsertSalesOpportunityEvent = typeof salesOpportunityEvents.$inferInsert;

export const salesControlRequests = mysqlTable(
  "salesControlRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 }).notNull(),
    invoiceId: bigint("invoiceId", { mode: "number" }).notNull().references(() => invoices.id),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    requestType: mysqlEnum("requestType", [
      "SALES_RETURN",
      "SALES_CANCEL",
      "SALES_REISSUE",
      "SALES_EXCHANGE",
      "SALES_DUE_DATE_CHANGE",
    ]).notNull(),
    // WITHDRAWN (هجرة 0326): سحبُ الطالب لطلبه — صفريّ الأثر، ويُحرّر `activeInvoiceId`
    // فتعود الفاتورة قابلةً لطلبٍ جديد. الاعتماد يبقى محكوماً بفصل المهام كما هو.
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "STALE", "WITHDRAWN"]).default("PENDING").notNull(),
    payload: json("payload").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    invoiceSnapshot: json("invoiceSnapshot").notNull(),
    snapshotHash: char("snapshotHash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    requestedBy: int("requestedBy").notNull().references(() => users.id),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    reviewNote: varchar("reviewNote", { length: 500 }),
    resultInvoiceId: bigint("resultInvoiceId", { mode: "number" }).references(() => invoices.id),
    appliedAt: timestamp("appliedAt"),
    activeInvoiceId: bigint("activeInvoiceId", { mode: "number" }).generatedAlwaysAs(sql`(CASE WHEN status = 'PENDING' THEN invoiceId ELSE NULL END)`, { mode: "stored" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    requestKeyUq: unique("salesControlRequests_requestKey_unique").on(t.requestKey),
    activeInvoiceUq: unique("salesControlRequests_active_invoice_unique").on(t.activeInvoiceId),
    branchStatusIdx: index("idx_sales_control_branch_status").on(t.branchId, t.status),
    invoiceStatusIdx: index("idx_sales_control_invoice_status").on(t.invoiceId, t.status),
    requesterIdx: index("idx_sales_control_requester").on(t.requestedBy),
    reviewerIdx: index("idx_sales_control_reviewer").on(t.reviewedBy),
    decisionShape: check("chk_sales_control_decision_shape", sql`(
      (${t.status} = 'PENDING' AND ${t.reviewedBy} IS NULL AND ${t.reviewedAt} IS NULL AND ${t.appliedAt} IS NULL)
      OR (${t.status} = 'APPROVED' AND ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL AND ${t.appliedAt} IS NOT NULL)
      OR (${t.status} IN ('REJECTED','STALE','WITHDRAWN') AND ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL AND ${t.appliedAt} IS NULL)
    )`),
    // السحبُ وحده يُستثنى: الساحبُ هو الطالبُ بالتعريف. ويبقى القيد مُلزِماً على
    // APPROVED/REJECTED حيث يعني رقابةً فعليّة (هجرة 0326).
    makerChecker: check("chk_sales_control_maker_checker", sql`${t.reviewedBy} IS NULL OR ${t.status} = 'WITHDRAWN' OR ${t.reviewedBy} <> ${t.requestedBy}`),
  }),
);
export type SalesControlRequest = typeof salesControlRequests.$inferSelect;
export type InsertSalesControlRequest = typeof salesControlRequests.$inferInsert;

export const salesExchangeCommands = mysqlTable(
  "salesExchangeCommands",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    controlRequestId: bigint("controlRequestId", { mode: "number" }).notNull(),
    commandKey: varchar("commandKey", { length: 120 }).notNull(),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    originalInvoiceId: bigint("originalInvoiceId", { mode: "number" }).notNull().references(() => invoices.id),
    replacementInvoiceId: bigint("replacementInvoiceId", { mode: "number" }).notNull().references(() => invoices.id),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    snapshotHash: char("snapshotHash", { length: 64 }).notNull(),
    originalTotal: decimal("originalTotal", { precision: 15, scale: 2 }).notNull(),
    replacementTotal: decimal("replacementTotal", { precision: 15, scale: 2 }).notNull(),
    deltaAmount: decimal("deltaAmount", { precision: 15, scale: 2 }).default("0").notNull(),
    settlementKind: mysqlEnum("settlementKind", ["NONE", "COLLECT", "CASH_REFUND", "CUSTOMER_CREDIT", "OUTSTANDING"]).notNull(),
    settlementMethod: mysqlEnum("settlementMethod", ["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]),
    requestedBy: int("requestedBy").notNull().references(() => users.id),
    approvedBy: int("approvedBy").notNull().references(() => users.id),
    executedAt: timestamp("executedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    controlRequestUq: unique("salesExchangeCommands_controlRequest_unique").on(t.controlRequestId),
    commandKeyUq: unique("salesExchangeCommands_commandKey_unique").on(t.commandKey),
    replacementUq: unique("salesExchangeCommands_replacement_unique").on(t.replacementInvoiceId),
    originalIdx: index("idx_sales_exchange_original").on(t.originalInvoiceId),
    branchDateIdx: index("idx_sales_exchange_branch_date").on(t.branchId, t.executedAt),
    controlRequestFk: foreignKey({
      name: "fk_sales_exchange_control_request",
      columns: [t.controlRequestId],
      foreignColumns: [salesControlRequests.id],
    }),
    makerChecker: check("chk_sales_exchange_maker_checker", sql`${t.requestedBy} <> ${t.approvedBy}`),
    deltaNonnegative: check("chk_sales_exchange_delta_nonnegative", sql`${t.deltaAmount} >= 0`),
    invoiceDistinct: check("chk_sales_exchange_invoice_distinct", sql`${t.originalInvoiceId} <> ${t.replacementInvoiceId}`),
  }),
);
export type SalesExchangeCommand = typeof salesExchangeCommands.$inferSelect;
export type InsertSalesExchangeCommand = typeof salesExchangeCommands.$inferInsert;

/* ============================ طلبات COD والعمولات المحكومة (0309–0310) ============================ */

export const deliveryCodWriteOffRequests = mysqlTable(
  "deliveryCodWriteOffRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 }).notNull(),
    partyId: bigint("partyId", { mode: "number" }).notNull().references(() => deliveryParties.id),
    consignmentId: bigint("consignmentId", { mode: "number" }),
    branchId: bigint("branchId", { mode: "number" }).notNull().references(() => branches.id),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "STALE"]).default("PENDING").notNull(),
    basePartyVersion: int("basePartyVersion").notNull(),
    amount: decimal("amount", { precision: 18, scale: 2 }).notNull(),
    payload: json("payload").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    evidenceNote: varchar("evidenceNote", { length: 500 }),
    attachmentUrl: varchar("attachmentUrl", { length: 2048 }),
    requestedBy: int("requestedBy").notNull().references(() => users.id),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    reviewNote: varchar("reviewNote", { length: 500 }),
    decisionKey: varchar("decisionKey", { length: 120 }),
    decisionHash: char("decisionHash", { length: 64 }),
    appliedAt: timestamp("appliedAt"),
    pendingGuard: varchar("pendingGuard", { length: 160 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    consignmentFk: foreignKey({
      name: "fk_delivery_cod_writeoff_consignment",
      columns: [t.consignmentId],
      foreignColumns: [deliveryConsignments.id],
    }).onDelete("set null"),
    requestKeyUq: unique("uq_delivery_cod_writeoff_request_key").on(t.requestKey),
    pendingUq: unique("uq_delivery_cod_writeoff_pending").on(t.pendingGuard),
    decisionUq: unique("uq_delivery_cod_writeoff_decision").on(t.decisionKey),
    partyStatusIdx: index("idx_delivery_cod_writeoff_party_status").on(t.partyId, t.status),
    branchStatusIdx: index("idx_delivery_cod_writeoff_branch_status").on(t.branchId, t.status),
    requesterIdx: index("idx_delivery_cod_writeoff_requester").on(t.requestedBy),
    reviewerIdx: index("idx_delivery_cod_writeoff_reviewer").on(t.reviewedBy),
    amountCheck: check("chk_delivery_cod_writeoff_amount", sql`${t.amount} > 0`),
    evidenceCheck: check("chk_delivery_cod_writeoff_evidence", sql`${t.evidenceNote} IS NOT NULL OR ${t.attachmentUrl} IS NOT NULL`),
    decisionShape: check("chk_delivery_cod_writeoff_decision", sql`(
      (${t.status} = 'PENDING' AND ${t.pendingGuard} IS NOT NULL AND ${t.reviewedBy} IS NULL AND ${t.reviewedAt} IS NULL AND ${t.decisionKey} IS NULL AND ${t.decisionHash} IS NULL AND ${t.appliedAt} IS NULL)
      OR (${t.status} = 'APPROVED' AND ${t.pendingGuard} IS NULL AND ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL AND ${t.decisionKey} IS NOT NULL AND ${t.decisionHash} IS NOT NULL AND ${t.appliedAt} IS NOT NULL)
      OR (${t.status} IN ('REJECTED','STALE') AND ${t.pendingGuard} IS NULL AND ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL AND ${t.decisionKey} IS NOT NULL AND ${t.decisionHash} IS NOT NULL AND ${t.appliedAt} IS NULL)
    )`),
    makerChecker: check("chk_delivery_cod_writeoff_maker_checker", sql`${t.reviewedBy} IS NULL OR ${t.reviewedBy} <> ${t.requestedBy}`),
  }),
);
export type DeliveryCodWriteOffRequest = typeof deliveryCodWriteOffRequests.$inferSelect;
export type InsertDeliveryCodWriteOffRequest = typeof deliveryCodWriteOffRequests.$inferInsert;

export const commissionRunApprovalRequests = mysqlTable(
  "commissionRunApprovalRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    requestKey: varchar("requestKey", { length: 120 }).notNull(),
    runId: bigint("runId", { mode: "number" }).notNull().references(() => commissionRuns.id, { onDelete: "restrict" }),
    scopeBranchId: bigint("scopeBranchId", { mode: "number" }).references(() => branches.id),
    status: mysqlEnum("status", ["PENDING", "APPROVED", "REJECTED", "STALE"]).default("PENDING").notNull(),
    baseRunVersion: int("baseRunVersion").notNull(),
    payload: json("payload").notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    requestedBy: int("requestedBy").notNull().references(() => users.id),
    reviewedBy: int("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt"),
    reviewNote: varchar("reviewNote", { length: 500 }),
    decisionKey: varchar("decisionKey", { length: 120 }),
    decisionHash: char("decisionHash", { length: 64 }),
    appliedAt: timestamp("appliedAt"),
    pendingGuard: varchar("pendingGuard", { length: 160 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    requestKeyUq: unique("uq_commission_run_approval_request_key").on(t.requestKey),
    pendingUq: unique("uq_commission_run_approval_pending").on(t.pendingGuard),
    decisionUq: unique("uq_commission_run_approval_decision").on(t.decisionKey),
    runStatusIdx: index("idx_commission_run_approval_run_status").on(t.runId, t.status),
    scopeStatusIdx: index("idx_commission_run_approval_scope_status").on(t.scopeBranchId, t.status),
    requesterIdx: index("idx_commission_run_approval_requester").on(t.requestedBy),
    reviewerIdx: index("idx_commission_run_approval_reviewer").on(t.reviewedBy),
    decisionShape: check("chk_commission_run_approval_decision", sql`(
      (${t.status} = 'PENDING' AND ${t.pendingGuard} IS NOT NULL AND ${t.reviewedBy} IS NULL AND ${t.reviewedAt} IS NULL AND ${t.decisionKey} IS NULL AND ${t.decisionHash} IS NULL AND ${t.appliedAt} IS NULL)
      OR (${t.status} = 'APPROVED' AND ${t.pendingGuard} IS NULL AND ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL AND ${t.decisionKey} IS NOT NULL AND ${t.decisionHash} IS NOT NULL AND ${t.appliedAt} IS NOT NULL)
      OR (${t.status} IN ('REJECTED','STALE') AND ${t.pendingGuard} IS NULL AND ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL AND ${t.decisionKey} IS NOT NULL AND ${t.decisionHash} IS NOT NULL AND ${t.appliedAt} IS NULL)
    )`),
    makerChecker: check("chk_commission_run_approval_maker_checker", sql`${t.reviewedBy} IS NULL OR ${t.reviewedBy} <> ${t.requestedBy}`),
  }),
);
export type CommissionRunApprovalRequest = typeof commissionRunApprovalRequests.$inferSelect;
export type InsertCommissionRunApprovalRequest = typeof commissionRunApprovalRequests.$inferInsert;

/**
 * ═══ documentEffects — سجلّ الأثر المستنديّ (القانون ق٧، هجرة 0329) ═══
 *
 * جدولٌ إلحاقيّ يوثّق كلّ أثرٍ ماليٍّ (مخزون/قيد/رصيد/عهدة/…) نُفّذ في مستندٍ ما.
 * المحرّك `server/services/reversalEngine.ts` يقرأ صفوف `phase=APPLY` ويكتب صفوف
 * `phase=REVERSE` مقابلة في **نفس المعاملة** التي تعكس المستند، وثابته المحروس:
 *   Σ signedAmount   لكل (documentType,documentId,effectKind) = 0 بعد العكس الكامل.
 *   Σ signedQuantity لكل (documentType,documentId,effectKind) = 0 بعد العكس الكامل.
 *
 * ⚠️ لا FK جامدة على الجداول المُتأثّرة (effectTable/effectRowId مرجعيّان بلا قيدٍ
 * ضامن) كي لا يُبطل الحذفُ الرجعيّ السجلَّ ولا يُقيّد الاندماج التدريجيّ مع خدماتٍ لا
 * تعرفه بعد.
 */
export const documentEffects = mysqlTable(
  "documentEffects",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    documentType: varchar("documentType", { length: 40 }).notNull(),
    documentId: bigint("documentId", { mode: "number" }).notNull(),
    effectKind: mysqlEnum("effectKind", [
      "INVENTORY",
      "LEDGER_ENTRY",
      "CUSTOMER_BALANCE",
      "SUPPLIER_BALANCE",
      "DELIVERY_CUSTODY",
      "PAID_AMOUNT",
      "COMMISSION",
      "DEPOSIT",
      "COUPON",
      "GIFT",
      "INSTALLMENT",
      "CARD",
      "CONSIGNMENT",
      "ROUNDING",
      "OFFLINE",
    ]).notNull(),
    phase: mysqlEnum("phase", ["APPLY", "REVERSE"]).notNull(),
    effectTable: varchar("effectTable", { length: 64 }),
    effectRowId: bigint("effectRowId", { mode: "number" }),
    signedAmount: decimal("signedAmount", { precision: 15, scale: 4 })
      .default("0")
      .notNull(),
    signedQuantity: int("signedQuantity").default(0).notNull(),
    branchId: bigint("branchId", { mode: "number" }),
    actorUserId: int("actorUserId"),
    reversalOfEffectId: bigint("reversalOfEffectId", { mode: "number" }),
    reason: varchar("reason", { length: 200 }),
    scope: varchar("scope", { length: 40 }),
    payloadJson: json("payloadJson"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    reversalFk: foreignKey({
      columns: [t.reversalOfEffectId],
      foreignColumns: [t.id],
      name: "fk_document_effects_reversal_of",
    }),
    docIdx: index("idx_document_effects_doc").on(t.documentType, t.documentId),
    docKindIdx: index("idx_document_effects_doc_kind").on(
      t.documentType,
      t.documentId,
      t.effectKind,
    ),
    reversalIdx: index("idx_document_effects_reversal_of").on(
      t.reversalOfEffectId,
    ),
    createdIdx: index("idx_document_effects_created").on(t.createdAt),
    reversalShape: check(
      "chk_document_effects_reversal_shape",
      sql`(${t.phase} = 'APPLY' AND ${t.reversalOfEffectId} IS NULL)
           OR (${t.phase} = 'REVERSE' AND ${t.reversalOfEffectId} IS NOT NULL)`,
    ),
  }),
);

export type DocumentEffect = typeof documentEffects.$inferSelect;
export type InsertDocumentEffect = typeof documentEffects.$inferInsert;

/**
 * ═══ recordVersions — اللقطة والاستعادة (م٦ ق٨، هجرة 0330) ═══
 *
 * **المبدأ الحاكم:** لا لقطة ⇒ لا تعديل. كل تعديلٍ لكيانٍ مرجعيٍّ (منتج/عميل/…) يُنشئ صفَّ
 * لقطةٍ داخل نفس المعاملة، يحمل الحمولةَ الكاملة قبل التعديل. الاستعادةُ = تعديلٌ جديدٌ
 * يحمل حمولةَ إصدارٍ قديمٍ ويمرّ بكلّ حرّاس التعديل — لا كتابةٌ خامٌّ للجدول الأصل.
 *
 * ⚠️ بلا FK جامدة: الجدول polymorphic (`entityType`+`entityId`)، وحذفُ الطرف الأمّ يجب
 * ألّا يُقيّده سجلّ التاريخ. الفهارس تكفي للاستعلامات الحاكمة.
 *
 * ⛔ الخدمة `versioning/recordVersion.ts` **لا تكتب** إلّا داخل `Tx`، وتفشل مغلقةً بلا
 * سبب — انظر عقدها هناك.
 */
export const recordVersions = mysqlTable(
  "recordVersions",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    entityType: varchar("entityType", { length: 50 }).notNull(),
    entityId: bigint("entityId", { mode: "number" }).notNull(),
    versionNumber: int("versionNumber").notNull(),
    payloadJson: json("payloadJson").notNull(),
    reason: varchar("reason", { length: 500 }),
    actorUserId: bigint("actorUserId", { mode: "number" }).notNull(),
    branchId: bigint("branchId", { mode: "number" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    uniqEntityVersion: unique("uniq_entity_version").on(
      t.entityType,
      t.entityId,
      t.versionNumber,
    ),
    entityHistoryIdx: index("idx_entity_history").on(
      t.entityType,
      t.entityId,
      t.createdAt,
    ),
    actorIdx: index("idx_actor").on(t.actorUserId, t.createdAt),
  }),
);

export type RecordVersion = typeof recordVersions.$inferSelect;
export type InsertRecordVersion = typeof recordVersions.$inferInsert;

/* ════════════════════ controlRequests — الجدول الحوكميّ الموحّد (م٧، 0331) ════════════════════
 *
 * جدولٌ واحد لكلّ طلبات القرار في النظام، مفتاحه `decisionKey` من
 * [`shared/decisionRegistry.ts`](../shared/decisionRegistry.ts). يحلّ محلَّ ٣٠ جدول «طلب
 * اعتماد» متشظّية تدريجياً في موجاتٍ لاحقة.
 *
 * **فرضٌ بنيويّ لطلبٍ نشطٍ واحد لكل (قرار، كيان):** العمود المولَّد `activeSlot`
 * (STORED) يحمل بصمة `(decisionKey, entityType, entityId)` حين `PENDING` فقط، وNULL
 * بعد القرار. `UNIQUE(activeSlot)` يمنع الازدواج بلا حدود على المحسومة.
 *
 * ⛔ الخدمة `controlRequests/index.ts` **لا تقرأ `ctx`** — تستقبل `Actor` صريحاً (§٥
 * من `CLAUDE.md`)، وتفشل مغلقةً بلا سبب أو خارج معاملة.
 */
export const controlRequests = mysqlTable(
  "controlRequests",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** مفتاحُ القرار — من `DECISION_REGISTRY`. مثال `purchases.approve`. */
    decisionKey: varchar("decisionKey", { length: 80 }).notNull(),
    /** نوعُ الكيان الذي يقع عليه القرار (`purchaseOrder`, `invoice`, `stocktakeSession`, …). */
    entityType: varchar("entityType", { length: 50 }).notNull(),
    /** معرّفُ الكيان في جدوله الأصلي. بلا FK جامدة — polymorphic. */
    entityId: bigint("entityId", { mode: "number" }).notNull(),
    status: mysqlEnum("status", [
      "PENDING",
      "APPROVED",
      "REJECTED",
      "WITHDRAWN",
      "SUPERSEDED",
    ])
      .default("PENDING")
      .notNull(),
    requestedByUserId: bigint("requestedByUserId", { mode: "number" }).notNull(),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    decidedByUserId: bigint("decidedByUserId", { mode: "number" }),
    decidedAt: timestamp("decidedAt"),
    /** سببُ الطلب. **إلزاميّ** (CHECK صمام على مسار الرفض؛ الخدمة تفرضه في كل مسار). */
    reason: varchar("reason", { length: 1000 }).notNull(),
    /** ملاحظةُ القرار. إلزاميّة على `REJECTED` بـCHECK؛ اختيارية على `APPROVED`/`WITHDRAWN`. */
    decisionNote: varchar("decisionNote", { length: 1000 }),
    /** حمولةُ سياقٍ (مبلغ، أرقام، تفاصيل يعرضها المُقرِّر). */
    payloadJson: json("payloadJson"),
    branchId: bigint("branchId", { mode: "number" }),
    /** بصمةُ الطلب النشط: `(decisionKey \t entityType \t entityId)` حين PENDING فقط. */
    activeSlot: varchar("activeSlot", { length: 200 }).generatedAlwaysAs(
      sql`(CASE WHEN status = 'PENDING' THEN CONCAT(decisionKey, '\t', entityType, '\t', CAST(entityId AS CHAR)) ELSE NULL END)`,
      { mode: "stored" },
    ),
  },
  (t) => ({
    activeSlotUq: unique("uniq_active_control_request").on(t.activeSlot),
    pendingByKindIdx: index("idx_control_request_pending_by_kind").on(
      t.decisionKey,
      t.status,
      t.requestedAt,
    ),
    byEntityIdx: index("idx_control_request_by_entity").on(
      t.entityType,
      t.entityId,
      t.requestedAt,
    ),
    byRequesterIdx: index("idx_control_request_by_requester").on(
      t.requestedByUserId,
      t.requestedAt,
    ),
    byDeciderIdx: index("idx_control_request_by_decider").on(
      t.decidedByUserId,
      t.decidedAt,
    ),
    /**
     * شكلُ الحقول حسب الحالة:
     *   PENDING     ⇒ لا مُقرِّر ولا وقت قرار ولا ملاحظة.
     *   APPROVED/REJECTED/SUPERSEDED ⇒ مُقرِّر ووقت قرار (والملاحظة على REJECTED بحارسٍ منفصل).
     *   WITHDRAWN   ⇒ وقت قرار موجود (لحظة السحب)؛ المُقرِّر يبقى NULL بحكم التعريف
     *                 (الساحبُ هو الطالبُ، وهو ما يستثنيه Maker-Checker).
     */
    decisionShape: check(
      "chk_control_request_decision_shape",
      sql`(
        (${t.status} = 'PENDING' AND ${t.decidedByUserId} IS NULL AND ${t.decidedAt} IS NULL AND ${t.decisionNote} IS NULL)
        OR (${t.status} IN ('APPROVED','REJECTED','SUPERSEDED') AND ${t.decidedByUserId} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)
        OR (${t.status} = 'WITHDRAWN' AND ${t.decidedAt} IS NOT NULL)
      )`,
    ),
    /** فصلُ المهام: المُقرِّر ليس المُنشئ. يُستثنى `WITHDRAWN` (الساحب = الطالب بالتعريف). */
    makerChecker: check(
      "chk_control_request_maker_checker",
      sql`${t.decidedByUserId} IS NULL OR ${t.status} = 'WITHDRAWN' OR ${t.decidedByUserId} <> ${t.requestedByUserId}`,
    ),
    /** الرفضُ يلزمه ملاحظةٌ نصّية (تُعرض للطالب فيفهم لماذا رُفض ويصحّح). */
    rejectNeedsNote: check(
      "chk_control_request_reject_needs_note",
      sql`${t.status} <> 'REJECTED' OR (${t.decisionNote} IS NOT NULL AND CHAR_LENGTH(TRIM(${t.decisionNote})) > 0)`,
    ),
  }),
);

export type ControlRequest = typeof controlRequests.$inferSelect;
export type InsertControlRequest = typeof controlRequests.$inferInsert;
