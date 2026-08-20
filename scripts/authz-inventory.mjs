#!/usr/bin/env node
/**
 * scripts/authz-inventory.mjs — جرد نقاط الدخول لأغراض إعادة هندسة الصلاحيات (AGP-002 §30.1).
 *
 * أداة **قراءة فقط**: لا تعدّل كوداً ولا سلوكاً. تمسح مصدر الخادم وتُخرج:
 *   docs/authz/endpoint-inventory.csv   — صفّ لكل نقطة دخول
 *   docs/authz/endpoint-inventory.json  — نفس البيانات + ملخّصات
 *
 * تغطّي: tRPC (queries/mutations عبر كل الراوترات)، مسارات Express (طباعة/صور/نسخ/وسائط واتساب/
 * webhooks/well-known/healthz)، والمهام المجدولة (node-cron/setInterval).
 *
 * الاستعمال:  node scripts/authz-inventory.mjs [--check]
 *   --check : يفشل بخروج 1 إن وُجدت نقطة tRPC على publicProcedure/protectedProcedure بلا بوّابة
 *             وحدة/دور خام مستجدّ (§24.1، T-12). **مُفعَّل في CI** عبر `pnpm check:authz`.
 */
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs", "authz");

/* ─────────────────────────── تصنيف الإجراءات (procedure kinds) ─────────────────────────── */

/**
 * تصنيف كل procedure مُصدَّر من server/trpc.ts: أي بوّابة يمثّل، وما الوحدة/المستوى/الأدوار،
 * وهل يفرض فرعاً. مشتقّ يدوياً من قراءة server/trpc.ts (المصدر الوحيد للبوّابات).
 * authority: raw-role | module-gate | module-map | token | owner | public-read | none | admin | platform
 */
const PROCEDURES = {
  publicProcedure: {
    authority: "none",
    module: null,
    level: null,
    roles: [],
    branch: false,
  },
  storefrontPublicReadProcedure: {
    authority: "public-read",
    module: "storefront",
    level: "READ",
    roles: [],
    branch: false,
  },
  storefrontPublicWriteProcedure: {
    authority: "public",
    module: "storefront",
    level: "WRITE",
    roles: [],
    branch: false,
  },
  passwordResetTokenProcedure: {
    authority: "token",
    module: "users",
    level: "RESET_TOKEN",
    roles: ["password-reset-token"],
    branch: false,
  },
  protectedProcedure: {
    authority: "none",
    module: null,
    level: null,
    roles: [],
    branch: false,
  },
  ownerProcedure: {
    authority: "owner",
    module: "ownership",
    level: "APPROVE",
    roles: [],
    branch: false,
  },
  nativeBootstrapProcedure: {
    authority: "device-bootstrap",
    module: null,
    level: null,
    roles: ["current-native-client"],
    branch: "device",
  },
  selfServiceProcedure: {
    authority: "self-assignment",
    module: null,
    level: "SELF",
    roles: ["authenticated-user"],
    branch: "self",
  },
  superAppProcedure: {
    authority: "module-map",
    module: null,
    level: "RESOLVED",
    roles: ["authenticated-user"],
    branch: "scoped",
  },
  // تكليف جرد ذاتي: ليست صلاحية مخزون عامة؛ handler يربط كل استعلام بالمستخدم المكلّف.
  stocktakeAssignmentProcedure: {
    authority: "self-assignment",
    module: "inventory",
    level: "ASSIGNED",
    roles: ["assigned-user"],
    branch: "self",
  },
  branchScopedProcedure: {
    authority: "none",
    module: null,
    level: null,
    roles: [],
    branch: "scoped",
  },
  adminProcedure: {
    authority: "admin",
    module: null,
    level: null,
    roles: ["admin"],
    branch: false,
  },
  usersAdminProcedure: {
    authority: "module-gate",
    module: "users",
    level: "FULL",
    roles: ["admin"],
    branch: false,
  },
  settingsAdminProcedure: {
    authority: "module-gate",
    module: "settings",
    level: "FULL",
    roles: ["admin"],
    branch: false,
  },
  platformAdminProcedure: {
    authority: "platform",
    module: null,
    level: null,
    roles: ["platformAdmin"],
    branch: false,
  },
  managerProcedure: {
    authority: "raw-role",
    module: null,
    level: null,
    roles: ["manager"],
    branch: false,
  },
  managerBranchScopedProcedure: {
    authority: "raw-role",
    module: null,
    level: null,
    roles: ["manager"],
    branch: "asserted",
  },
  cashierProcedure: {
    authority: "raw-role",
    module: null,
    level: null,
    roles: ["cashier", "manager"],
    branch: "required",
  },
  warehouseProcedure: {
    authority: "raw-role",
    module: null,
    level: null,
    roles: ["warehouse", "manager"],
    branch: "required",
  },
  reportViewerProcedure: {
    authority: "module-gate",
    module: "reports",
    level: "READ",
    roles: ["manager", "accountant", "auditor"],
    branch: "asserted",
  },
  posCashierProcedure: {
    authority: "module-gate",
    module: "pos",
    level: "FULL",
    roles: ["cashier", "manager"],
    branch: "required",
  },
  salesReadProcedure: {
    authority: "module-map",
    module: "sales",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  // بوابة قراءة فاتورة مفردة للطباعة: sales>=READ أو workorders=FULL، مع عزل الفرع.
  // تُسجَّل كسلطة مركبة كي لا يصنّف الحارس الإجراءَ كبوابة مجهولة، من دون توسيع
  // صلاحية وحدة المبيعات لمشغّل الاستقبال.
  invoiceViewProcedure: {
    authority: "module-map",
    module: "sales|workorders",
    level: "READ|FULL",
    roles: [],
    branch: "scoped",
  },
  // بوابة **قوائم** الفواتير (١٨/٨): نفس سلطة المستند المفرد موسَّعةً بنطاق كاشير الطباعة
  // (pos=FULL)، والنطاق يقصّ القناة داخل الاستعلام (RECEPTION/PRINT_SERVICES) مع عزل الفرع
  // وعزل الموظف. تُسجَّل كسلطة مركبة كي لا تُصنَّف نقاطها «مجهولة الإجراء».
  invoiceListProcedure: {
    authority: "module-map",
    module: "sales|workorders|pos",
    level: "READ|FULL|FULL",
    roles: [],
    branch: "scoped",
  },
  salesCashierProcedure: {
    authority: "module-gate",
    module: "sales",
    level: "FULL",
    roles: ["cashier", "manager"],
    branch: "required",
  },
  salesManagerProcedure: {
    authority: "module-gate",
    module: "sales",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  purchasesReadProcedure: {
    authority: "module-map",
    module: "purchases",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  purchasesManagerProcedure: {
    authority: "module-gate",
    module: "purchases",
    level: "FULL",
    roles: ["manager", "purchasing"],
    branch: "required",
  },
  purchasesWarehouseProcedure: {
    authority: "module-gate",
    module: "purchases",
    level: "FULL",
    roles: ["warehouse", "manager", "purchasing"],
    branch: "required",
  },
  inventoryReadProcedure: {
    authority: "module-map",
    module: "inventory",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  inventoryWarehouseProcedure: {
    authority: "module-gate",
    module: "inventory",
    level: "FULL",
    roles: ["warehouse", "manager"],
    branch: "required",
  },
  inventoryManagerProcedure: {
    authority: "module-gate",
    module: "inventory",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  // مركّبة runtime: inventoryManagerProcedure ثم requireAdmin. نسجلها module-gate
  // لأن شرط admin تشديد إضافي داخل البوابة، لا مسار كتابة إداري خارج حوكمة الوحدة.
  inventoryAdminProcedure: {
    authority: "module-gate",
    module: "inventory",
    level: "FULL",
    roles: ["admin"],
    branch: false,
  },
  reportsManagerProcedure: {
    authority: "module-gate",
    module: "reports",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  // مركّبة runtime: reportsManagerProcedure ثم requireAdmin؛ شرط admin تشديدٌ إضافي.
  reportsAdminProcedure: {
    authority: "module-gate",
    module: "reports",
    level: "FULL",
    roles: ["admin"],
    branch: false,
  },
  customersReadProcedure: {
    authority: "module-map",
    module: "crm",
    level: "READ",
    roles: [],
    branch: false,
  },
  customersCashierProcedure: {
    authority: "module-gate",
    module: "crm",
    level: "FULL",
    roles: ["cashier", "manager", "sales_rep"],
    branch: "required",
  },
  // (١٢/٨) بوّابة إنشاء العميل من محطة الاستقبال: crm=FULL **أو** workorders=FULL — نمط
  // invoiceViewProcedure نفسه أعلاه. توثَّق كسلطةٍ مركّبة صريحة (crm|workorders — FULL|FULL)
  // كي يعكس الجرد كلا فرعي الإذن، فلا يُقنَع المراجع أن العميل يُنشَأ عبر بوّابة crm وحدها.
  customersReceptionCreateProcedure: {
    authority: "module-map",
    module: "crm|workorders",
    level: "FULL|FULL",
    roles: [],
    branch: "scoped",
  },
  customersManagerProcedure: {
    authority: "module-gate",
    module: "crm",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  crmReadProcedure: {
    authority: "module-map",
    module: "crm",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  crmWriteProcedure: {
    authority: "module-gate",
    module: "crm",
    level: "FULL",
    roles: ["cashier", "manager", "sales_rep"],
    branch: "required",
  },
  campaignsReadProcedure: {
    authority: "module-map",
    module: "campaigns",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  campaignsManagerProcedure: {
    authority: "module-gate",
    module: "campaigns",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  collectionsReadProcedure: {
    authority: "module-map",
    module: "collections",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  collectionsManagerProcedure: {
    authority: "module-gate",
    module: "collections",
    level: "FULL",
    roles: ["manager", "accountant"],
    branch: "required",
  },
  tasksReadProcedure: {
    authority: "module-map",
    module: "tasks",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  tasksWriteProcedure: {
    authority: "module-gate",
    module: "tasks",
    level: "FULL",
    roles: ["cashier", "manager", "sales_rep", "print_operator"],
    branch: "required",
  },
  tasksManagerProcedure: {
    authority: "module-gate",
    module: "tasks",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  storeReadProcedure: {
    authority: "module-map",
    module: "store",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  storeFulfillProcedure: {
    authority: "module-gate",
    module: "store",
    level: "FULL",
    roles: ["manager", "cashier", "sales_rep"],
    branch: "required",
  },
  storeManagerProcedure: {
    authority: "module-gate",
    module: "store",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  courierProcedure: {
    authority: "module-gate",
    module: "courier",
    level: "FULL",
    roles: ["courier"],
    branch: false,
  },
  deliveryReadProcedure: {
    authority: "module-map",
    module: "store",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  deliveryManagerProcedure: {
    authority: "module-gate",
    module: "store",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  deliveryCashierProcedure: {
    authority: "module-gate",
    module: "store",
    level: "FULL",
    roles: ["cashier", "manager"],
    branch: "required",
  },
  suppliersReadProcedure: {
    authority: "module-map",
    module: "suppliers",
    level: "READ",
    roles: [],
    branch: false,
  },
  suppliersManagerProcedure: {
    authority: "module-gate",
    module: "suppliers",
    level: "FULL",
    roles: ["manager", "warehouse", "purchasing"],
    branch: "required",
  },
  consignmentWriteProcedure: {
    authority: "module-gate",
    module: "consignments",
    level: "FULL",
    roles: ["warehouse", "manager", "accountant"],
    branch: "required",
  },
  consignmentReadProcedure: {
    authority: "module-map",
    module: "consignments",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  productsReadProcedure: {
    authority: "module-map",
    module: "products",
    level: "READ",
    roles: [],
    branch: false,
  },
  productsManagerProcedure: {
    authority: "module-gate",
    module: "products",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  productsPurchaseProcedure: {
    authority: "module-gate",
    module: "products",
    level: "READ",
    roles: ["manager", "warehouse", "purchasing"],
    branch: "required",
  },
  productStudioReadProcedure: {
    authority: "module-map",
    module: "productStudio",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  productStudioWriteProcedure: {
    authority: "module-map",
    module: "productStudio",
    level: "FULL",
    roles: [],
    branch: "scoped",
  },
  // managerProcedure + requireModule؛ الخدمة تعيد قفل المهمة وتفرض branchId لكل فعل إشرافي.
  productStudioManagerProcedure: {
    authority: "module-gate",
    module: "productStudio",
    level: "FULL",
    roles: ["manager"],
    branch: "asserted",
  },
  expensesReadProcedure: {
    authority: "module-map",
    module: "expenses",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  expensesCashierProcedure: {
    authority: "module-gate",
    module: "expenses",
    level: "FULL",
    roles: ["cashier", "manager", "accountant"],
    branch: "required",
  },
  expensesManagerProcedure: {
    authority: "module-gate",
    module: "expenses",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  workordersReadProcedure: {
    authority: "module-map",
    module: "workorders",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  workordersCashierProcedure: {
    authority: "module-gate",
    module: "workorders",
    level: "FULL",
    roles: ["cashier", "manager"],
    branch: "required",
  },
  workordersExecProcedure: {
    authority: "module-gate",
    module: "workorders",
    level: "FULL",
    roles: ["cashier", "manager", "print_operator"],
    branch: "required",
  },
  workordersManagerProcedure: {
    authority: "module-gate",
    module: "workorders",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  treasuryManagerProcedure: {
    authority: "module-gate",
    module: "treasury",
    level: "FULL",
    roles: ["manager", "accountant"],
    branch: "required",
  },
  treasuryManagerReadProcedure: {
    authority: "module-gate",
    module: "treasury",
    level: "READ",
    roles: ["manager", "accountant"],
    branch: "required",
  },
  treasuryReadProcedure: {
    authority: "module-map",
    module: "treasury",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  // بيانات مرجعية عامّة للخزينة (فئات السندات): نفس بوّابة الوحدة تماماً، و`branch: "none"`
  // لأنّ `voucherCategories` بلا عمود branchId ⇒ لا عزل فرعٍ ممكن ولا مطلوب. لا تُستعمل لأي
  // إجراء يمسّ `receipts` (تلك تبقى على treasuryManagerProcedure بـbranch: "required").
  treasuryGlobalProcedure: {
    authority: "module-gate",
    module: "treasury",
    level: "FULL",
    roles: ["manager", "accountant"],
    branch: "none",
  },
  // فئات المصروفات: بيانات مرجعية عامّة بلا branchId. القراءة بخريطة الوحدة (كل من يُنشئ
  // مصروفاً يحتاج المنتقي)، والكتابة بقائمة الإدارة. المصروف نفسه يبقى مقصوراً بالفرع.
  expensesGlobalReadProcedure: {
    authority: "module-map",
    module: "expenses",
    level: "READ",
    roles: [],
    branch: "none",
  },
  expensesGlobalProcedure: {
    authority: "module-gate",
    module: "expenses",
    level: "FULL",
    roles: ["manager", "accountant"],
    branch: "none",
  },
  treasuryGlobalReadProcedure: {
    authority: "module-gate",
    module: "treasury",
    level: "READ",
    roles: ["manager", "accountant"],
    branch: "none",
  },
  treasuryCashierProcedure: {
    authority: "module-gate",
    module: "treasury",
    level: "READ",
    roles: ["cashier", "manager"],
    branch: "required",
  },
  commissionsManagerProcedure: {
    authority: "module-gate",
    module: "commissions",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  commissionsReadProcedure: {
    authority: "module-map",
    module: "commissions",
    level: "READ",
    roles: [],
    branch: false,
  },
  // البطاقات الرقمية (digital_cards) — أُضيفت على main بعد فرع هذه المراجعة (دمج origin/main):
  digitalCardsManagerProcedure: {
    authority: "module-gate",
    module: "digital_cards",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  digitalCardsPosProcedure: {
    authority: "module-map",
    module: "digital_cards",
    level: "READ",
    roles: [],
    branch: "scoped",
  },
  digitalCardsAdminReadProcedure: {
    authority: "module-gate",
    module: "digital_cards",
    level: "READ",
    roles: ["manager", "accountant", "auditor"],
    branch: "scoped",
  },
  // priceSanity L2 — تدقيق شذوذ الكتالوج (٣٠/٧/٢٦). قراءة: manager/accountant/auditor (نمط
  // digitalCardsAdminRead)، كتابة: manager فقط (الاستثناءات قرارٌ إداريّ).
  catalogAnomaliesReadProcedure: {
    authority: "module-gate",
    module: "catalogAnomalies",
    level: "READ",
    roles: ["manager", "accountant", "auditor"],
    branch: false,
  },
  catalogAnomaliesManagerProcedure: {
    authority: "module-gate",
    module: "catalogAnomalies",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  announcementsManagerProcedure: {
    authority: "module-gate",
    module: "announcements",
    level: "FULL",
    roles: ["manager"],
    branch: "required",
  },
  announcementsReadProcedure: {
    authority: "module-map",
    module: "announcements",
    level: "READ",
    roles: [],
    branch: false,
  },
  // بوّابات مُعرَّفة **خارج** server/trpc.ts (سلطة موزّعة — انظر §30.10 Legacy Mapping):
  auditReadProcedure: {
    authority: "raw-role",
    module: null,
    level: null,
    roles: ["admin", "auditor"],
    branch: false,
    local: "server/routers/auditRouter.ts:9",
  },
  kioskReadProcedure: {
    authority: "none",
    module: null,
    level: null,
    roles: [],
    branch: "device",
    local: "server/routers/kioskRouter.ts:49",
  },
};

/** أفعال تدلّ على أثر مالي/خارجي حسّاس — تُرفَع حساسيتها آلياً في الجرد. */
const SENSITIVE_HINTS = [
  "void",
  "cancel",
  "reverse",
  "refund",
  "approve",
  "reject",
  "delete",
  "remove",
  "purge",
  "export",
  "print",
  "send",
  "share",
  "broadcast",
  "impersonat",
  "reset",
  "override",
  "settle",
  "payout",
  "close",
  "reopen",
  "adjust",
  "writeoff",
  "unlock",
  "grant",
  "revoke",
];
const WRITE_KIND = "mutation";

/* ─────────────── اشتقاق كود الصلاحية المقترح `domain.resource.action` (§30.2) ─────────────── */

/** المجال المقترح لكل وحدة حالية (module → domain). الوحدات ليست مجالات: `settings`/`users` ⇒ iam. */
const MODULE_DOMAIN = {
  sales: "sales",
  pos: "sales",
  workorders: "workorders",
  crm: "crm",
  campaigns: "marketing",
  collections: "ar",
  treasury: "treasury",
  expenses: "treasury",
  purchases: "purchasing",
  suppliers: "purchasing",
  inventory: "inventory",
  consignments: "consignment",
  products: "catalog",
  catalogAnomalies: "catalog",
  reports: "reports",
  store: "store",
  courier: "delivery",
  tasks: "tasks",
  channels: "channels",
  hr: "hr",
  commissions: "commissions",
  assets: "assets",
  gifts: "gifts",
  reservations: "reservations",
  users: "iam",
  settings: "admin",
};

/** المجال المقترح حين لا وحدة (بوّابة admin/raw-role/عامة) — من اسم الراوتر. */
const ROUTER_DOMAIN = {
  authRouter: "iam",
  userRouter: "iam",
  roleRouter: "iam",
  platformAdminRouter: "platform",
  auditRouter: "audit",
  systemRouter: "admin",
  periodLockRouter: "accounting",
  yearEndRouter: "accounting",
  accountsRouter: "accounting",
  employeeRouter: "hr",
  payrollRouter: "hr",
  attendanceRouter: "hr",
  leaveRouter: "hr",
  recruitmentRouter: "hr",
  hrDeviceRouter: "hr",
  assetsRouter: "assets",
  storefrontRouter: "storefront",
  kioskRouter: "kiosk",
  countPortalRouter: "inventory",
  branchRouter: "admin",
  integrationRouter: "admin",
  pushRouter: "admin",
  imports: "admin",
  barcodeRouter: "catalog",
  printPosRouter: "sales",
  printPricingRouter: "sales",
  stocktakeRouter: "inventory",
  deliveryRouter: "delivery",
  courierRouter: "delivery",
  creditApprovalRouter: "ar",
  installmentRouter: "ar",
  arRemindersRouter: "ar",
  apRemindersRouter: "ap",
  giftsRouter: "gifts",
  reservationsRouter: "reservations",
  offlineRouter: "sales",
  broadcastsRouter: "marketing",
  conversationRouter: "channels",
  contactsRouter: "crm",
  imageStudioRouter: "catalog",
  priceWavesRouter: "catalog",
  promotionRouter: "marketing",
  promotionsV2Router: "marketing",
  bundlesRouter: "catalog",
  catalogRouter: "catalog",
  cardAccountRouter: "treasury",
  cashTransfersRouter: "treasury",
  shiftRouter: "treasury",
  voucherRouter: "treasury",
  exchangeRouter: "treasury",
  expenseRouter: "treasury",
  documentDeliveryRouter: "documents",
  globalSearchRouter: "search",
  storeAdminRouter: "store",
  quotationRouter: "sales",
  saleRouter: "sales",
  returnRouter: "sales",
  purchaseRouter: "purchasing",
  purchaseReturns: "purchasing",
  productionRouter: "inventory",
  inventoryRouter: "inventory",
  supplierRouter: "purchasing",
  customerRouter: "crm",
  customerNoteRouter: "crm",
  workOrderRouter: "workorders",
  commissionsRouter: "commissions",
  consignmentRouter: "consignment",
  reportsRouter: "reports",
  tasksRouter: "tasks",
  crmRouter: "crm",
  treasuryRouter: "treasury",
};

/** المورد المقترح من اسم الراوتر (يُنقّح يدوياً عند اعتماد الكتالوج). */
function resourceOf(router, name) {
  const nested = name.includes(".")
    ? name.split(".").slice(0, -1).join("_")
    : null;
  if (nested) return nested.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const base = router.replace(/Router$/, "").replace(/s$/, "");
  return base.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

/** الفعل القياسي المقترح من اسم النقطة (§10.2)، أو الاسم نفسه كفعل أعمال خاص. */
const ACTION_MAP = [
  [/^(list|search|find|browse|facets|options|lookup)/i, "list"],
  [
    /^(get|byId|detail|show|view|preview|status|summary|stats|report|export$)/i,
    "view",
  ],
  [/^export/i, "export"],
  [/^(print|label)/i, "print"],
  [/^(send|notify|broadcast|share)/i, "send"],
  [/^(create|add|new|open|start|submit$|register|record|issue)/i, "create"],
  [/^(update|edit|set|save|rename|assign|move|patch|toggle)/i, "update"],
  [/^(delete|remove|purge|destroy)/i, "delete"],
  [/^(approve|confirm|sign)/i, "approve"],
  [/^reject/i, "reject"],
  [/^(cancel|void)/i, "void"],
  [/^(reverse|revert|undo)/i, "reverse"],
  [/^refund/i, "refund"],
  [/^(close|finish|finalize)/i, "close"],
  [/^(reopen|unlock)/i, "reopen"],
  [/^import/i, "import"],
  [/^(download|file)/i, "download"],
  [/^(login|auth)/i, "authenticate"],
  [/^logout/i, "logout"],
  [/^(revoke|disable|deactivate)/i, "revoke"],
];
function actionOf(name) {
  const leaf = name.includes(".") ? name.split(".").pop() : name;
  for (const [re, act] of ACTION_MAP) if (re.test(leaf)) return act;
  return leaf.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

function proposePermission(router, name, module) {
  const domain =
    MODULE_DOMAIN[module] ??
    ROUTER_DOMAIN[router] ??
    router.replace(/Router$/, "").toLowerCase();
  return `${domain}.${resourceOf(router, name)}.${actionOf(name)}`;
}

/* ─────────────────────────── مسح tRPC ─────────────────────────── */

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__tests__" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/**
 * يلتقط **بوّابات محلّية** مُعرَّفة داخل ملف الراوتر نفسه (لا في server/trpc.ts) — نمط شائع جداً:
 *   const hrRead  = protectedProcedure.use(requireModule("hr", "READ"));            ← بوّابة محلّية حقيقية
 *   const channelsWrite = cashierProcedure.use(requireModule("channels", "FULL")); ← مركّبة: دور + وحدة
 *   const reportsProcedure = reportViewerProcedure;                                 ← اسم مستعار فقط (لا LOCAL_GATE)
 *
 * تمييزان حاسمان (تصحيح مراجعة Codex على PR #405):
 *  (P2) **الاسم المستعار المجرَّد** (بلا `.use(...)`) ليس بوّابة لامركزية — يرث بوّابته المركزية كاملةً
 *       ولا يُعلَّم LOCAL_GATE، وإلّا انتفخ عدّاد «السلطة اللامركزية» زوراً.
 *  (P1) **البوّابة المركّبة** (أساسٌ مُقيَّد بالدور + `requireModule`) تحمل **مصدرَي سلطة**: الدور المورَّث
 *       من الأساس + الوحدة المُضافة. لا يجوز أن يبتلع تصنيفُ الوحدة قيدَ الدور — نُبقي RAW_ROLE_GATE
 *       (أو ADMIN_ONLY) للأساس مع تسجيل الوحدة.
 */
function scanLocalGates(src) {
  const gates = {};
  const re = /(?:^|\n)\s*const\s+([A-Za-z0-9_]+)\s*=\s*([\s\S]*?);\s*(?=\n)/g;
  let m;
  while ((m = re.exec(src))) {
    const [, name, rhs] = m;
    if (!/Procedure\b/.test(rhs)) continue;
    if (rhs.length > 1200) continue;
    // استبعاد الراوترات الفرعية (`const ordersRouter = router({...})`) — ليست بوّابات.
    if (/^router\s*\(/.test(rhs.trim()) || /Router$/.test(name)) continue;
    const base = (rhs.match(/([A-Za-z0-9_]*Procedure)\b/) || [])[1] ?? null;
    const inherited = PROCEDURES[base] ?? gates[base] ?? null;
    const addsMiddleware = /\.use\s*\(/.test(rhs);

    // (P2) اسمٌ مستعار مجرَّد: `const x = someProcedure;` بلا `.use` ⇒ هو البوّابة نفسها، لا بوّابةٌ
    // جديدة. يرث كل شيء ولا يُعلَّم LOCAL_GATE (وإلّا نُسبت لامركزيةٌ لبوّابةٍ مركزية).
    if (!addsMiddleware) {
      gates[name] = inherited
        ? { ...inherited, local: false, base }
        : {
            authority: "none",
            module: null,
            level: null,
            roles: [],
            branch: false,
            local: false,
            base,
          };
      continue;
    }

    const mod = rhs.match(
      /requireModule\(\s*["']([^"']+)["']\s*,\s*["'](FULL|READ)["']/,
    );
    // بوابة QR الموقّع: لا جلسة، لكن الخدمة تتحقق من HMAC قبل تمرير الملخص للمعالج.
    const tokenGate = /requireOnlineOrderLabel\b/.test(rhs);
    const roleGate = rhs.match(/ctx\.user\.role\s*!==\s*["']([a-z_]+)["']/g);
    const requireRole = rhs.match(/requireRole\(([^)]*)\)/);
    // (P1) الأساس مُقيَّد بالدور (raw-role) أو admin ⇒ البوّابة مركّبة: يبقى قيد الدور المورَّث فاعلاً
    // فوق قيد الوحدة المُضاف. نحفظ العلَم كي لا تختفي 130 نقطة سلطة-الدور من الجرد والترحيل.
    const inheritsRoleAuthority =
      inherited?.authority === "raw-role" || inherited?.authority === "admin";
    const localRoles = roleGate
      ? Array.from(
          new Set(roleGate.map((r) => r.match(/["']([a-z_]+)["']/)[1])),
        )
      : requireRole
        ? Array.from(requireRole[1].matchAll(/["']([a-z_]+)["']/g)).map(
            (x) => x[1],
          )
        : null;

    gates[name] = {
      authority: mod
        ? "module-map"
        : localRoles
          ? "raw-role"
          : tokenGate
            ? "token"
            : (inherited?.authority ?? "none"),
      module: mod ? mod[1] : (inherited?.module ?? null),
      level: mod ? mod[2] : (inherited?.level ?? null),
      roles: localRoles ?? inherited?.roles ?? [],
      branch: tokenGate ? "token" : (inherited?.branch ?? false),
      local: true,
      base,
      // مصدر سلطة الدور المورَّث (raw-role/admin من الأساس) يبقى مسجَّلاً حتى مع requireModule.
      inheritsRoleAuthority: !!(inheritsRoleAuthority && mod),
      inheritedAuthority: inheritsRoleAuthority ? inherited.authority : null,
    };
  }
  return gates;
}

/**
 * يستخرج نقاط tRPC من ملف: كل `name: someProcedure ... .query(|.mutation(`.
 * يتتبّع أيضاً الراوترات المتداخلة `name: router({` لبناء المسار الكامل.
 */
function scanTrpcFile(file) {
  const src = readFileSync(file, "utf8");
  const localGates = scanLocalGates(src);
  const lines = src.split(/\r?\n/);
  const out = [];
  // مكدّس الراوترات المتداخلة: [{ prefix, braceDepth }]
  const nested = [];
  let depth = 0;
  let pending = null; // { name, proc, line, startDepth }

  const flush = (kind, line) => {
    if (!pending) return;
    const prefix = nested
      .map((n) => n.prefix)
      .filter(Boolean)
      .join(".");
    out.push({
      name: prefix ? `${prefix}.${pending.name}` : pending.name,
      procedure: pending.proc,
      gate: localGates[pending.proc] ?? PROCEDURES[pending.proc] ?? null,
      kind,
      file,
      line: pending.line,
      endLine: line,
    });
    pending = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\/\/.*$/, "");

    // راوتر متداخل: `key: router({`
    const nestedM = line.match(/^\s*([a-zA-Z0-9_]+)\s*:\s*router\s*\(\s*\{/);
    if (nestedM) nested.push({ prefix: nestedM[1], depth });

    // بداية نقطة دخول — إمّا procedure مركزي (…Procedure) أو بوّابة محلّية معروفة في هذا الملف
    const m = line.match(/^\s*([a-zA-Z0-9_]+)\s*:\s*([a-zA-Z][a-zA-Z0-9_]*)\b/);
    if (m && (/Procedure$/.test(m[2]) || localGates[m[2]])) {
      flush("unknown", i + 1); // نقطة سابقة بلا query/mutation صريح
      pending = { name: m[1], proc: m[2], line: i + 1 };
    }
    if (pending) {
      if (/\.query\s*\(/.test(line)) flush("query", i + 1);
      else if (/\.mutation\s*\(/.test(line)) flush("mutation", i + 1);
      else if (/\.subscription\s*\(/.test(line)) flush("subscription", i + 1);
    }

    // تتبّع العمق بعد المعالجة
    for (const ch of line) {
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") {
        depth--;
        while (nested.length && depth <= nested[nested.length - 1].depth)
          nested.pop();
      }
    }
  }
  flush("unknown", lines.length);

  // (P1 — مراجعة Codex ٢) فحصٌ لجسم المعالِج: بعضُ النقاط تحكم بالدور **داخل** الـhandler لا في
  // البوّابة (مثل `if (!RECON_WRITERS.has(ctx.user.role)) throw` أو `assertElevated(ctx.user.role)`
  // أو `ctx.user.role !== "admin"`). المسح المعتمِد على البوّابة وحده يُعميها. نمسح شريحة كل نقطة
  // (من سطرها حتى بداية التالية) عن أنماط قرار الدور ونسجّلها مصدرَ سلطةٍ إضافياً.
  // نلتقط **بوّابات المنع** بالدور داخل المعالِج فقط (مسار الرفض)، لا اصطلاح رفع النطاق
  // (`ctx.user.role === "admin"` لتوسيع البيانات — قرار نطاقٍ مُمثَّلٌ أصلاً، ليس بوّابةً تمنع).
  // أنماط المنع: `!== "role"` · `!SET.has(ctx.user.role)` · `assertElevated(...)` · `NOT_ADMIN_ERR_MSG`.
  // نلتقط **بوّابات المنع** بالدور داخل المعالِج فقط (مسار الرفض)، ونستبعد صراحةً:
  //  - اصطلاح رفع النطاق `ctx.user.role === "admin"` (قرار نطاقٍ لا بوّابة).
  //  - اصطلاح **عزل الفرع/IDOR** `role !== "admin" && ...branchId...` (مكافئ requireOwnBranch،
  //    يعفي admin ويضيّق بالفرع — ليس بوّابةً «admin فقط»). مراجعة review-module A3.
  // نميّز كلَّ مطابقة `!== "admin"` بجوارها القريب: إن حوى `branchId`/`branch` فهي حارس فرعٍ يُتجاهل.
  const nearBranch = (body, idx) =>
    /branch/i.test(body.slice(Math.max(0, idx - 60), idx + 60));
  out.sort((a, b) => a.line - b.line);
  for (let i = 0; i < out.length; i++) {
    const start = out[i].line - 1;
    const end = Math.min(
      i + 1 < out.length ? out[i + 1].line - 1 : lines.length,
      start + 160,
    );
    const body = lines.slice(start, end).join("\n");

    // (A4) وحدة مُطبَّقة inline على النقطة: `name: baseProc.use(requireModule("mod","LEVEL"))`.
    // scanLocalGates لا يراها (تُطابق `const NAME=` فقط) وحلّ البوّابة يُفتاح باسم الإجراء الأساس.
    // نقرأ سطور الإعلان (حتى .query/.mutation) ونُلحق module/level بالبوّابة المحلولة.
    const declEnd = Math.min(out[i].endLine ?? out[i].line, start + 12);
    const decl = lines.slice(start, declEnd).join("\n");
    const inlineMod = decl.match(
      /\.use\(\s*requireModule\(\s*["']([^"']+)["']\s*,\s*["'](FULL|READ)["']/,
    );
    if (inlineMod && out[i].gate) {
      out[i].gate = {
        ...out[i].gate,
        module: inlineMod[1],
        level: inlineMod[2],
        inlineModule: true,
      };
    }

    // (A3) بوّابات المنع بالدور — مع استبعاد حرّاس الفرع.
    const adminHits = [
      ...body.matchAll(/ctx\.user\.role\s*!==\s*["']admin["']/g),
    ];
    const denyAdmin =
      adminHits.some((m) => !nearBranch(body, m.index)) ||
      /\bNOT_ADMIN_ERR_MSG\b/.test(body);
    const denyRoleNe = [
      ...body.matchAll(/ctx\.user\.role\s*!==\s*["']([a-z_]+)["']/g),
    ]
      .filter((m) => m[1] !== "admin" && !nearBranch(body, m.index))
      .map((m) => m[1]);
    const denyRoleSet = /![A-Z_]+\.has\(\s*ctx\.user\.role\s*\)/.test(body); // !RECON_WRITERS.has(ctx.user.role)
    const denyElevated = /\bassertElevated\s*\(/.test(body);
    const roles = Array.from(new Set(denyRoleNe));
    const hasHandlerGate =
      denyAdmin || denyRoleSet || denyElevated || roles.length > 0;
    if (hasHandlerGate) {
      out[i].handlerGate = {
        admin: denyAdmin && roles.length === 0 && !denyRoleSet && !denyElevated,
        roles,
        // قيد دورٍ بلا تعداد صريح في الشريحة (مجموعة/دالّة تحكم) — نعلّمه raw-role عاماً للمراجعة.
        opaque: denyRoleSet || denyElevated,
      };
    }
  }
  return out;
}

function sensitivityOf(ep) {
  const n = ep.name.toLowerCase();
  const hit = SENSITIVE_HINTS.find((h) => n.includes(h));
  if (ep.kind === WRITE_KIND && hit)
    return { level: "HIGH", why: `فعل حسّاس: ${hit}` };
  if (ep.kind === WRITE_KIND) return { level: "MEDIUM", why: "كتابة" };
  if (hit && (hit === "export" || hit === "print"))
    return { level: "HIGH", why: `أثر خارجي: ${hit}` };
  return { level: "LOW", why: "قراءة" };
}

/** أعلام المخاطر التي تهمّ خطة الترحيل. */
function flagsOf(ep, meta) {
  const f = [];
  if (!meta) f.push("PROCEDURE_UNKNOWN");
  else {
    if (meta.authority === "none" && ep.kind === WRITE_KIND)
      f.push("WRITE_WITHOUT_MODULE_GATE");
    if (meta.authority === "public-read" && ep.kind === WRITE_KIND)
      f.push("WRITE_WITHOUT_MODULE_GATE");
    if (meta.authority === "none" && ep.kind === "query")
      f.push("READ_WITHOUT_MODULE_GATE");
    if (meta.authority === "raw-role") f.push("RAW_ROLE_GATE");
    if (meta.authority === "admin") f.push("ADMIN_ONLY");
    // (P1) بوّابة مركّبة (module + أساس مُقيَّد بالدور): قيد الدور المورَّث يبقى فاعلاً ⇒ نُبقي علَمه.
    if (meta.inheritsRoleAuthority && meta.inheritedAuthority === "raw-role")
      f.push("RAW_ROLE_GATE");
    if (meta.inheritsRoleAuthority && meta.inheritedAuthority === "admin")
      f.push("ADMIN_ONLY");
    if (meta.authority === "module-map" && meta.branch === false)
      f.push("NO_BRANCH_SCOPE");
    if (meta.authority === "unknown") f.push("PROCEDURE_UNRESOLVED");
    if (meta.local) f.push("LOCAL_GATE");
  }
  // (P1 — مراجعة Codex ٢) قيد دورٍ داخل جسم المعالِج: مصدر سلطةٍ إضافيّ فوق البوّابة.
  if (ep.handlerGate) {
    f.push("HANDLER_ROLE_CHECK");
    if (ep.handlerGate.admin && !f.includes("ADMIN_ONLY")) f.push("ADMIN_ONLY");
    if (
      (ep.handlerGate.roles.length || ep.handlerGate.opaque) &&
      !f.includes("RAW_ROLE_GATE")
    )
      f.push("RAW_ROLE_GATE");
  }
  if (
    ep.procedure === "publicProcedure" ||
    ep.procedure === "storefrontPublicReadProcedure"
  )
    f.push("UNAUTHENTICATED");
  const s = sensitivityOf(ep);
  if (s.level === "HIGH") f.push("SENSITIVE_ACTION");
  return f;
}

/* ─────────────────────────── مسح Express + المهام ─────────────────────────── */

/**
 * (P1 — مراجعة Codex ٢) تصنيف السلطة الفعليّة لكل مسار Express حسب ملفه — مشتقٌّ يدوياً من قراءة
 * المصدر (لا سلطة اصطناعية موحّدة). المفتاح: بادئة الملف. القيمة: {authority, roles, sensitivity, note}.
 */
function classifyExpress(file, path, method) {
  const f = file.replace(/\\/g, "/");
  const G = method === "GET";
  if (f.endsWith("backupRoutes.ts"))
    return {
      authority: "admin",
      roles: "admin",
      sensitivity: "HIGH",
      note: "كوكي+CSRF، أدمن — تنزيل نسخة كاملة",
    };
  if (f.endsWith("printRoute.ts")) {
    // A5: GET /status مصادقةٌ فقط؛ POST /raw،/test بوّابة (أدمن/مدير أو وردية مفتوحة).
    if (G)
      return {
        authority: "none",
        roles: "session",
        sensitivity: "LOW",
        note: "مصادقة فقط — حالة الجسر",
      };
    return {
      authority: "raw-role",
      roles: "admin|manager|open-shift",
      sensitivity: "HIGH",
      note: "طباعة خام — أدمن/مدير أو وردية مفتوحة",
    };
  }
  if (f.endsWith("waMedia.ts"))
    return {
      authority: "none",
      roles: "session",
      sensitivity: "HIGH",
      note: "جلسة مستخدم — وسائط محادثات (PII)",
    };
  if (f.endsWith("channelWebhooks.ts")) {
    // A5: GET = تحقّق verify-token + echo hub.challenge (بلا HMAC، بلا كتابة)؛ POST = HMAC.
    if (G)
      return {
        authority: "public",
        roles: "verify-token",
        sensitivity: "LOW",
        note: "تحقّق webhook (challenge) — لا HMAC ولا كتابة",
      };
    return {
      authority: "hmac",
      roles: "integration",
      sensitivity: "MEDIUM",
      note: "توقيع HMAC — Principal تكامل (كتابة صندوق وارد)",
    };
  }
  if (f.endsWith("imageRoute.ts")) {
    // A5: /kiosk-product محروسٌ بجهاز الكشك ويكشف كتالوجاً مخفيّاً عن المتجر (showInStore) ⇒ حساسية أعلى.
    if (path.includes("kiosk"))
      return {
        authority: "device",
        roles: "kiosk",
        sensitivity: "MEDIUM",
        note: "جهاز كشك — يتجاوز showInStore (كتالوج مخفيّ)",
      };
    return {
      authority: "public",
      roles: "public",
      sensitivity: "LOW",
      note: "صور عامّة (بنر/منتج)",
    };
  }
  if (f.endsWith("wellKnown.ts"))
    return {
      authority: "public",
      roles: "public",
      sensitivity: "LOW",
      note: "عامّ بالتصميم",
    };
  if (path === "/healthz")
    return {
      authority: "public",
      roles: "public",
      sensitivity: "LOW",
      note: "فحص صحّة عامّ",
    };
  if (f.endsWith("index.ts"))
    return {
      authority: "mount",
      roles: "",
      sensitivity: "",
      note: "نقطة تركيب (tenancy/csrf middleware)",
    };
  return { authority: "unknown", roles: "", sensitivity: "", note: "" };
}

function scanExpress(root) {
  const rows = [];
  const files = [
    "server/printRoute.ts",
    "server/imageRoute.ts",
    "server/backupRoutes.ts",
    "server/routes/channelWebhooks.ts",
    "server/routes/waMedia.ts",
    "server/wellKnown.ts",
    "server/index.ts",
  ];
  for (const rel of files) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, "utf8").split(/\r?\n/);
    lines.forEach((l, i) => {
      const m = l.match(
        /\b(?:r|app|router)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/,
      );
      if (m)
        rows.push({
          surface: "express",
          method: m[1].toUpperCase(),
          path: m[2],
          file: rel,
          line: i + 1,
          ...classifyExpress(rel, m[2], m[1]),
        });
      const mount = l.match(/app\.use\(\s*["'`](\/api\/[^"'`]*)["'`]/);
      if (mount)
        rows.push({
          surface: "express-mount",
          method: "MOUNT",
          path: mount[1],
          file: rel,
          line: i + 1,
          ...classifyExpress(rel, mount[1], "MOUNT"),
        });
    });
  }
  return rows;
}

function scanJobs(root) {
  const rows = [];
  const base = join(root, "server");
  if (!existsSync(base)) return rows;
  for (const f of walk(base)) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((l, i) => {
      if (/cron\.schedule\s*\(/.test(l))
        rows.push({
          kind: "cron",
          file: relative(root, f).replace(/\\/g, "/"),
          line: i + 1,
        });
      else if (/setInterval\s*\(/.test(l))
        rows.push({
          kind: "interval",
          file: relative(root, f).replace(/\\/g, "/"),
          line: i + 1,
        });
    });
  }
  return rows;
}

/* ─────────────────────────── حساب الجرد لجذرٍ مّا ─────────────────────────── */

/** يمسح شجرة `server/` تحت `root` ويُعيد الجرد الكامل — يقبل أي checkout (head أو base) بلا كتابة. */
function computeInventory(root) {
  const trpcFiles = [
    ...walk(join(root, "server", "routers")),
    join(root, "server", "routers.ts"),
  ].filter(existsSync);

  const endpoints = [];
  for (const f of trpcFiles) {
    const routerName = relative(root, f)
      .replace(/\\/g, "/")
      .replace(/^server\/routers\//, "")
      .replace(/\.ts$/, "");
    for (const ep of scanTrpcFile(f)) {
      const meta = ep.gate;
      const s = sensitivityOf(ep);
      const gateRoles = meta?.roles ?? [];
      const handlerRoles = ep.handlerGate
        ? [
            ...ep.handlerGate.roles,
            ...(ep.handlerGate.admin ? ["admin"] : []),
            ...(ep.handlerGate.opaque ? ["role-check"] : []),
          ]
        : [];
      const roles = Array.from(new Set([...gateRoles, ...handlerRoles]));
      endpoints.push({
        surface: "trpc",
        router: routerName,
        proposedPermission: proposePermission(
          routerName,
          ep.name,
          meta?.module ?? null,
        ),
        name: ep.name,
        kind: ep.kind,
        procedure: ep.procedure,
        authority: meta?.authority ?? "unknown",
        module: meta?.module ?? "",
        level: meta?.level ?? "",
        roles: roles.join("|"),
        branch:
          meta?.branch === false ? "none" : String(meta?.branch ?? "unknown"),
        sensitivity: s.level,
        sensitivityWhy: s.why,
        flags: flagsOf(ep, meta).join("|"),
        loc: `${relative(root, ep.file).replace(/\\/g, "/")}:${ep.line}`,
      });
    }
  }
  endpoints.sort((a, b) =>
    (a.router + a.name).localeCompare(b.router + b.name),
  );

  const express = scanExpress(root);
  const jobs = scanJobs(root);
  const summary = {
    generatedFrom: "static scan (read-only)",
    trpcTotal: endpoints.length,
    byKind: tally(endpoints, (e) => e.kind),
    byAuthority: tally(endpoints, (e) => e.authority),
    bySensitivity: tally(endpoints, (e) => e.sensitivity),
    byModule: tally(endpoints, (e) => e.module || "(none)"),
    flagCounts: tallyFlags(endpoints),
    expressRoutes: express.filter((r) => r.surface === "express").length,
    expressMounts: express.filter((r) => r.surface === "express-mount").length,
    jobs: jobs.length,
    routerFiles: trpcFiles.length,
    proposedPermissions: new Set(endpoints.map((e) => e.proposedPermission))
      .size,
    proposedDomains: tally(
      endpoints,
      (e) => e.proposedPermission.split(".")[0],
    ),
  };
  return { endpoints, express, jobs, summary };
}

/* ─────────────────── تعريف الانتهاك + بصمته (مشترك: static + diff) ─────────────────── */

/** انحدارُ سلطةٍ حقيقيّ للحارس الساكن (`--check`): raw-role أو بلا بوّابة وحدة (قراءةً/كتابةً) أو
 *  admin على كتابة. PROCEDURE_UNKNOWN مُستبعَدٌ عمداً هنا (انجراف الجدول اليدويّ يُفشل الحارس الساكن
 *  على كودٍ خارج الـPR). حارس الدمج (diff) يستعمل `emitPredicate` الأوسع الذي **يشمل** المستجدّ من
 *  UNKNOWN لأنّ مقارنة الأساس تُلغي انجراف main أصلاً (مراجعة review-module #2). */
function isViolation(e) {
  return (
    e.flags.includes("WRITE_WITHOUT_MODULE_GATE") ||
    e.flags.includes("READ_WITHOUT_MODULE_GATE") ||
    e.flags.includes("RAW_ROLE_GATE") ||
    (e.flags.includes("ADMIN_ONLY") && e.kind === WRITE_KIND)
  );
}

/** المُصدَّر لحارس الدمج: الانتهاكات + **المستجدّ من UNKNOWN**. الأخير آمنٌ في مسار الفرق (base يحوي
 *  unknowns الخاصّة بـmain ⇒ يُطرح) لكنه يمسك إجراءً غير مسجَّلٍ **يُدخِله الـPR** (مراجعة #2). */
function isEmittable(e) {
  return (
    isViolation(e) ||
    e.flags.includes("PROCEDURE_UNKNOWN") ||
    e.flags.includes("PROCEDURE_UNRESOLVED")
  );
}

/**
 * بصمة انتهاكٍ **مستقلّة عن رقم السطر** (يتغيّر بين base وhead) للمقارنة بالأساس المتحرّك.
 * تشمل (مراجعة review-module #1، #4): الراوتر/الاسم/النوع + أعلام الانتهاك + **مجموعة الأدوار الممنوحة**
 * (كي يُكشف خفضُ بوّابةٍ خشنة manager→cashier — كلاهما RAW_ROLE_GATE فلا يكفي العلَم) + **بُعد الفرع**
 * (كي يُكشف إسقاط عزل الفرع scoped→none). أيُّ تغيُّرٍ في هذه ⇒ بصمةٌ جديدة ⇒ يظهر مستجدّاً في الفرق.
 */
function violationSig(e) {
  const vflags = e.flags
    .split("|")
    .filter((f) =>
      /RAW_ROLE_GATE|WITHOUT_MODULE_GATE|ADMIN_ONLY|PROCEDURE_UNKNOWN|PROCEDURE_UNRESOLVED/.test(
        f,
      ),
    )
    .sort()
    .join(",");
  const roles = (e.roles || "").split("|").filter(Boolean).sort().join(",");
  return `${e.router}.${e.name}.${e.kind}|${vflags}|r=${roles}|b=${e.branch}`;
}

function tally(rows, fn) {
  const m = {};
  for (const r of rows) m[fn(r)] = (m[fn(r)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}
function tallyFlags(rows) {
  const m = {};
  for (const r of rows)
    for (const f of r.flags.split("|").filter(Boolean)) m[f] = (m[f] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/* ─────────── وضع «بصمات الانتهاك» (يستهلكه حارس merge-base) ───────────
 * `--emit-violations [--root <dir>]` يمسح جذراً مّا (head أو checkout الأساس) ويطبع بصمات الانتهاك
 * JSON على stdout **بلا كتابة أي ملف**. حارس authz-guard-diff.mjs يستدعيه مرّتين (head/base) ويفرّق. */
if (process.argv.includes("--emit-violations")) {
  const root = argVal("--root") || ROOT;
  const { endpoints } = computeInventory(root);
  const items = endpoints.filter(isEmittable).map((e) => ({
    sig: violationSig(e),
    loc: e.loc,
    flags: e.flags
      .split("|")
      .filter((f) =>
        /RAW_ROLE_GATE|WITHOUT_MODULE_GATE|ADMIN_ONLY|PROCEDURE_UNKNOWN|PROCEDURE_UNRESOLVED/.test(
          f,
        ),
      )
      .join(","),
  }));
  process.stdout.write(JSON.stringify({ root, count: items.length, items }));
  process.exit(0);
}

// ─── الوضع الافتراضي: مسح الجذر الحاليّ + كتابة الجرد + الحارس الساكن (--check) ───
const { endpoints, express, jobs, summary } = computeInventory(ROOT);

mkdirSync(OUT_DIR, { recursive: true });

const cols = [
  "surface",
  "router",
  "name",
  "proposedPermission",
  "kind",
  "procedure",
  "authority",
  "module",
  "level",
  "roles",
  "branch",
  "sensitivity",
  "sensitivityWhy",
  "flags",
  "loc",
];

// (P1) صفوف tRPC + **كل** الأسطح الأخرى (Express + المهام) في نفس CSV — الوثيقة تدّعي تغطيتها،
// فلا تُترك في JSON وحده. أعمدة موحّدة؛ الحقول غير المنطبقة فارغة.
const csvRows = endpoints.map((e) => e);
for (const r of express) {
  const eflags = ["EXPRESS_SURFACE"];
  if (r.authority === "admin") eflags.push("ADMIN_ONLY");
  if (r.authority === "raw-role") eflags.push("RAW_ROLE_GATE");
  if (r.authority === "public" || r.authority === "mixed")
    eflags.push("UNAUTHENTICATED");
  if (r.sensitivity === "HIGH") eflags.push("SENSITIVE_ACTION");
  csvRows.push({
    surface: r.surface,
    router: "(express)",
    name: `${r.method} ${r.path}`,
    proposedPermission: "",
    kind: r.surface === "express-mount" ? "mount" : "route",
    procedure: r.method,
    authority: r.authority, // (P1) السلطة الفعليّة لكل مسار لا ثابتٌ اصطناعيّ
    module: "",
    level: "",
    roles: r.roles ?? "",
    branch: "",
    sensitivity: r.sensitivity ?? "",
    sensitivityWhy: r.note ?? "",
    flags: eflags.join("|"),
    loc: `${r.file}:${r.line}`,
  });
}
for (const j of jobs) {
  csvRows.push({
    surface: "job",
    router: "(scheduled)",
    name: j.kind,
    proposedPermission: "",
    kind: j.kind,
    procedure: j.kind,
    authority: "none",
    module: "",
    level: "",
    roles: "",
    branch: "",
    sensitivity: "",
    sensitivityWhy: "",
    flags: "JOB_NO_PRINCIPAL",
    loc: `${j.file}:${j.line}`,
  });
}
const csv = [cols.join(",")]
  .concat(
    csvRows.map((e) =>
      cols.map((c) => `"${String(e[c] ?? "").replace(/"/g, '""')}"`).join(","),
    ),
  )
  .join("\n");
writeFileSync(join(OUT_DIR, "endpoint-inventory.csv"), "﻿" + csv, "utf8");
writeFileSync(
  join(OUT_DIR, "endpoint-inventory.json"),
  JSON.stringify({ summary, endpoints, express, jobs }, null, 2),
  "utf8",
);

console.log(JSON.stringify(summary, null, 2));

// ─────────────────────────── وضع الحارس (--check) ───────────────────────────
// (P1) الحارس الموعود في docs/authz/07-threat-model.md (T-12) يمنع **إعادة إدخال** raw-role gate أو
// نقطة غير مسجَّلة — لا مجرّد كتابة بلا بوّابة. لذا يفشل على أيٍّ من:
//   WRITE_WITHOUT_MODULE_GATE · READ_WITHOUT_MODULE_GATE · RAW_ROLE_GATE · ADMIN_ONLY(كتابة) · PROCEDURE_UNKNOWN/UNRESOLVED
// مع **قاعدة أساس صريحة** (authz-baseline.json) تُغرّب الحالة القائمة، فلا يفشل إلّا على المستجدّ.
// توليد الأساس أول مرّة: `node scripts/authz-inventory.mjs --write-baseline`.
if (
  process.argv.includes("--check") ||
  process.argv.includes("--write-baseline")
) {
  const BASELINE = join(OUT_DIR, "authz-baseline.json");
  // (A1 — مراجعة review-module) المفتاح يشمل **الملف**: أسماء الراوترات مشتقّة منه، فتتصادم أوراقٌ
  // متطابقة عبر تصديرات/راوترات-فرعية متعددة في الملف نفسه (voucherRouter.create ×2،
  // storeAdminRouter.list ×6…). المفتاح `router.name` وحده كان يُغرّب انحداراً على شقيقٍ مُصادِم؛
  // ضمّ الملف + **ترتيب الشقيق** يجعل كل نقطة مُغرَّبةً بذاتها فلا يُخفي بعضُها بعضاً.
  //
  // (A1-b — إصلاح انجراف الأساس، ٣١/٧/٢٦) كان المفتاح يضمّ `loc` **برقم السطر**، فأيُّ تحريرٍ أعلى
  // نقطةٍ مُغرَّبة يزيح سطرها ⇒ تظهر «مستجدّةً» زوراً بلا أيّ تغيير سلطة، ويحمرّ `pnpm check:guards`
  // على `main` نظيفاً. حدث فعلاً: #425 أضاف `previewScopeCount` فأزاح **٢٠** نقطة في
  // `stocktakeRouter.ts` (البوّابات بايتاً ببايت كما هي — `raw-role` ثابتٌ عند ٥٨). الأساس يُغرّب
  // **هويّة** النقطة لا **موضعها** ⇒ نُسقط رقم السطر ونُبقي الملف + ترتيب الشقيق (`#n` للثاني فصاعداً).
  // انزياحُ الترتيب يبقى مكشوفاً (إدخال شقيقٍ مُصادِم فوق آخر = تغييرٌ بنيويّ يستحقّ المراجعة).
  const keyOf = new Map();
  {
    // `endpoints` مرتَّبةٌ ثباتاً بـ(router+name)، وداخل الملف الواحد بترتيب السطر ⇒ الترتيب حتميّ.
    const seen = new Map();
    for (const e of endpoints) {
      const base = `${e.router}.${e.name}@${e.loc.replace(/:\d+$/, "")}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      keyOf.set(e, n > 1 ? `${base}#${n}` : base);
    }
  }
  const key = (e) =>
    keyOf.get(e) ?? `${e.router}.${e.name}@${e.loc.replace(/:\d+$/, "")}`;
  // isViolation مشتركةٌ الآن (معرّفة أعلى): raw-role/بلا بوّابة وحدة قراءةً أو كتابةً/admin-كتابة.
  const flagged = endpoints.filter(isViolation);

  // PROCEDURE_UNKNOWN/UNRESOLVED = بوّابةٌ **لا يعرفها** جدول PROCEDURES اليدويّ (لا انحدار أمنيّ بذاته).
  // خريطة الإجراءات تنجرف حتماً كلّما أضاف main راوتراً جديداً بإجراءٍ جديد — فجعلُها قاتلة يُفشل CI
  // على كودٍ خارج الـPR (كما حدث فعلاً مع digitalCardsRouter). لذا **تُبلَّغ فقط** (تحثّ على تحديث
  // الجدول) ولا تُفشِل الحارس؛ الإنفاذ يبقى على المصنَّف: raw-role/بلا بوّابة/admin-كتابة.
  const unknown = endpoints.filter(
    (e) =>
      e.flags.includes("PROCEDURE_UNKNOWN") ||
      e.flags.includes("PROCEDURE_UNRESOLVED"),
  );
  if (unknown.length && process.argv.includes("--check")) {
    const procs = [...new Set(unknown.map((e) => e.procedure))];
    console.error(
      `\nℹ ${unknown.length} نقطة بإجراءٍ غير مسجَّل في جدول PROCEDURES (تبليغٌ لا إفشال — حدِّث الجدول): ${procs.join(", ")}`,
    );
  }

  if (process.argv.includes("--write-baseline")) {
    writeFileSync(
      BASELINE,
      JSON.stringify(
        { generated: "static", keys: flagged.map(key).sort() },
        null,
        2,
      ),
      "utf8",
    );
    console.error(
      `\n✔ كُتب الأساس: ${flagged.length} نقطة معروفة في ${relative(ROOT, BASELINE)}`,
    );
    process.exit(0);
  }

  const baseline = new Set(
    existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")).keys : [],
  );
  const novel = flagged.filter((e) => !baseline.has(key(e)));
  if (novel.length) {
    console.error(
      `\n✖ ${novel.length} نقطة سلطة مستجدّة خارج الأساس (raw-role / بلا بوّابة / غير مسجَّلة):`,
    );
    for (const b of novel.slice(0, 50)) {
      console.error(
        `  - ${key(b)} [${b.flags
          .split("|")
          .filter((x) =>
            /RAW_ROLE|WITHOUT_MODULE|UNKNOWN|UNRESOLVED|ADMIN_ONLY/.test(x),
          )
          .join(",")}] ${b.loc}`,
      );
    }
    console.error(
      `\nإن كانت مقصودة: راجعها ثم أعِد توليد الأساس بـ --write-baseline (قرار واعٍ موثَّق).`,
    );
    process.exit(1);
  }
  console.error(
    `\n✔ لا نقطة سلطة مستجدّة خارج الأساس (${baseline.size} نقطة مُغرَّبة).`,
  );
}
