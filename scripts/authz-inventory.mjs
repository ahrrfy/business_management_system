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
 *             وحدة — يُستعمل لاحقاً كحارس CI (§24.1). لا يُفعَّل في CI قبل اعتماد الكتالوج.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs", "authz");

/* ─────────────────────────── تصنيف الإجراءات (procedure kinds) ─────────────────────────── */

/**
 * تصنيف كل procedure مُصدَّر من server/trpc.ts: أي بوّابة يمثّل، وما الوحدة/المستوى/الأدوار،
 * وهل يفرض فرعاً. مشتقّ يدوياً من قراءة server/trpc.ts (المصدر الوحيد للبوّابات).
 * authority: raw-role | module-gate | module-map | none | admin | platform
 */
const PROCEDURES = {
  publicProcedure:            { authority: "none",        module: null,          level: null,   roles: [],                                          branch: false },
  protectedProcedure:         { authority: "none",        module: null,          level: null,   roles: [],                                          branch: false },
  branchScopedProcedure:      { authority: "none",        module: null,          level: null,   roles: [],                                          branch: "scoped" },
  adminProcedure:             { authority: "admin",       module: null,          level: null,   roles: ["admin"],                                   branch: false },
  platformAdminProcedure:     { authority: "platform",    module: null,          level: null,   roles: ["platformAdmin"],                           branch: false },
  managerProcedure:           { authority: "raw-role",    module: null,          level: null,   roles: ["manager"],                                 branch: false },
  managerBranchScopedProcedure:{ authority: "raw-role",   module: null,          level: null,   roles: ["manager"],                                 branch: "asserted" },
  cashierProcedure:           { authority: "raw-role",    module: null,          level: null,   roles: ["cashier", "manager"],                      branch: "required" },
  warehouseProcedure:         { authority: "raw-role",    module: null,          level: null,   roles: ["warehouse", "manager"],                    branch: "required" },
  reportViewerProcedure:      { authority: "module-gate", module: "reports",     level: "READ", roles: ["manager", "accountant", "auditor"],        branch: "asserted" },
  reportsProcedure:           { authority: "module-gate", module: "reports",     level: "READ", roles: ["manager", "accountant", "auditor"],        branch: "asserted" },
  posCashierProcedure:        { authority: "module-gate", module: "pos",         level: "FULL", roles: ["cashier", "manager"],                      branch: "required" },
  salesReadProcedure:         { authority: "module-map",  module: "sales",       level: "READ", roles: [],                                          branch: "scoped" },
  salesCashierProcedure:      { authority: "module-gate", module: "sales",       level: "FULL", roles: ["cashier", "manager"],                      branch: "required" },
  salesManagerProcedure:      { authority: "module-gate", module: "sales",       level: "FULL", roles: ["manager"],                                 branch: "required" },
  purchasesReadProcedure:     { authority: "module-map",  module: "purchases",   level: "READ", roles: [],                                          branch: "scoped" },
  purchasesManagerProcedure:  { authority: "module-gate", module: "purchases",   level: "FULL", roles: ["manager", "purchasing"],                   branch: "required" },
  purchasesWarehouseProcedure:{ authority: "module-gate", module: "purchases",   level: "FULL", roles: ["warehouse", "manager", "purchasing"],      branch: "required" },
  inventoryReadProcedure:     { authority: "module-map",  module: "inventory",   level: "READ", roles: [],                                          branch: "scoped" },
  inventoryWarehouseProcedure:{ authority: "module-gate", module: "inventory",   level: "FULL", roles: ["warehouse", "manager"],                    branch: "required" },
  inventoryManagerProcedure:  { authority: "module-gate", module: "inventory",   level: "FULL", roles: ["manager"],                                 branch: "required" },
  customersReadProcedure:     { authority: "module-map",  module: "crm",         level: "READ", roles: [],                                          branch: false },
  customersCashierProcedure:  { authority: "module-gate", module: "crm",         level: "FULL", roles: ["cashier", "manager", "sales_rep"],         branch: "required" },
  customersManagerProcedure:  { authority: "module-gate", module: "crm",         level: "FULL", roles: ["manager"],                                 branch: "required" },
  crmReadProcedure:           { authority: "module-map",  module: "crm",         level: "READ", roles: [],                                          branch: "scoped" },
  crmWriteProcedure:          { authority: "module-gate", module: "crm",         level: "FULL", roles: ["cashier", "manager", "sales_rep"],         branch: "required" },
  campaignsReadProcedure:     { authority: "module-map",  module: "campaigns",   level: "READ", roles: [],                                          branch: "scoped" },
  campaignsManagerProcedure:  { authority: "module-gate", module: "campaigns",   level: "FULL", roles: ["manager"],                                 branch: "required" },
  collectionsReadProcedure:   { authority: "module-map",  module: "collections", level: "READ", roles: [],                                          branch: "scoped" },
  collectionsManagerProcedure:{ authority: "module-gate", module: "collections", level: "FULL", roles: ["manager", "accountant"],                   branch: "required" },
  tasksReadProcedure:         { authority: "module-map",  module: "tasks",       level: "READ", roles: [],                                          branch: "scoped" },
  tasksWriteProcedure:        { authority: "module-gate", module: "tasks",       level: "FULL", roles: ["cashier", "manager", "sales_rep", "print_operator"], branch: "required" },
  tasksManagerProcedure:      { authority: "module-gate", module: "tasks",       level: "FULL", roles: ["manager"],                                 branch: "required" },
  storeReadProcedure:         { authority: "module-map",  module: "store",       level: "READ", roles: [],                                          branch: "scoped" },
  storeFulfillProcedure:      { authority: "module-gate", module: "store",       level: "FULL", roles: ["manager", "cashier", "sales_rep"],         branch: "required" },
  storeManagerProcedure:      { authority: "module-gate", module: "store",       level: "FULL", roles: ["manager"],                                 branch: "required" },
  courierProcedure:           { authority: "module-gate", module: "courier",     level: "FULL", roles: ["courier"],                                 branch: false },
  deliveryReadProcedure:      { authority: "module-map",  module: "store",       level: "READ", roles: [],                                          branch: "scoped" },
  suppliersReadProcedure:     { authority: "module-map",  module: "suppliers",   level: "READ", roles: [],                                          branch: false },
  suppliersManagerProcedure:  { authority: "module-gate", module: "suppliers",   level: "FULL", roles: ["manager", "warehouse", "purchasing"],      branch: "required" },
  consignmentWriteProcedure:  { authority: "module-gate", module: "consignments",level: "FULL", roles: ["warehouse", "manager", "accountant"],      branch: "required" },
  consignmentReadProcedure:   { authority: "module-map",  module: "consignments",level: "READ", roles: [],                                          branch: "scoped" },
  productsReadProcedure:      { authority: "module-map",  module: "products",    level: "READ", roles: [],                                          branch: false },
  productsManagerProcedure:   { authority: "module-gate", module: "products",    level: "FULL", roles: ["manager"],                                 branch: "required" },
  productsPurchaseProcedure:  { authority: "module-gate", module: "products",    level: "READ", roles: ["manager", "warehouse", "purchasing"],      branch: "required" },
  expensesReadProcedure:      { authority: "module-map",  module: "expenses",    level: "READ", roles: [],                                          branch: "scoped" },
  expensesCashierProcedure:   { authority: "module-gate", module: "expenses",    level: "FULL", roles: ["cashier", "manager", "accountant"],        branch: "required" },
  expensesManagerProcedure:   { authority: "module-gate", module: "expenses",    level: "FULL", roles: ["manager"],                                 branch: "required" },
  workordersReadProcedure:    { authority: "module-map",  module: "workorders",  level: "READ", roles: [],                                          branch: "scoped" },
  workordersCashierProcedure: { authority: "module-gate", module: "workorders",  level: "FULL", roles: ["cashier", "manager"],                      branch: "required" },
  workordersExecProcedure:    { authority: "module-gate", module: "workorders",  level: "FULL", roles: ["cashier", "manager", "print_operator"],    branch: "required" },
  workordersManagerProcedure: { authority: "module-gate", module: "workorders",  level: "FULL", roles: ["manager"],                                 branch: "required" },
  treasuryManagerProcedure:   { authority: "module-gate", module: "treasury",    level: "FULL", roles: ["manager", "accountant"],                   branch: "required" },
  treasuryManagerReadProcedure:{ authority: "module-gate",module: "treasury",    level: "READ", roles: ["manager", "accountant"],                   branch: "required" },
  treasuryReadProcedure:      { authority: "module-map",  module: "treasury",    level: "READ", roles: [],                                          branch: "scoped" },
  treasuryCashierProcedure:   { authority: "module-gate", module: "treasury",    level: "READ", roles: ["cashier", "manager"],                      branch: "required" },
  commissionsManagerProcedure:{ authority: "module-gate", module: "commissions", level: "FULL", roles: ["manager"],                                 branch: "required" },
  commissionsReadProcedure:   { authority: "module-map",  module: "commissions", level: "READ", roles: [],                                          branch: false },
  // بوّابات مُعرَّفة **خارج** server/trpc.ts (سلطة موزّعة — انظر §30.10 Legacy Mapping):
  auditReadProcedure:         { authority: "raw-role",    module: null,          level: null,   roles: ["admin", "auditor"],                        branch: false, local: "server/routers/auditRouter.ts:9" },
  kioskReadProcedure:         { authority: "none",        module: null,          level: null,   roles: [],                                          branch: "device", local: "server/routers/kioskRouter.ts:49" },
};

/** أفعال تدلّ على أثر مالي/خارجي حسّاس — تُرفَع حساسيتها آلياً في الجرد. */
const SENSITIVE_HINTS = [
  "void", "cancel", "reverse", "refund", "approve", "reject", "delete", "remove", "purge",
  "export", "print", "send", "share", "broadcast", "impersonat", "reset", "override",
  "settle", "payout", "close", "reopen", "adjust", "writeoff", "unlock", "grant", "revoke",
];
const WRITE_KIND = "mutation";

/* ─────────────── اشتقاق كود الصلاحية المقترح `domain.resource.action` (§30.2) ─────────────── */

/** المجال المقترح لكل وحدة حالية (module → domain). الوحدات ليست مجالات: `settings`/`users` ⇒ iam. */
const MODULE_DOMAIN = {
  sales: "sales", pos: "sales", workorders: "workorders", crm: "crm", campaigns: "marketing",
  collections: "ar", treasury: "treasury", expenses: "treasury", purchases: "purchasing",
  suppliers: "purchasing", inventory: "inventory", consignments: "consignment", products: "catalog",
  reports: "reports", store: "store", courier: "delivery", tasks: "tasks", channels: "channels",
  hr: "hr", commissions: "commissions", assets: "assets", gifts: "gifts", reservations: "reservations",
  users: "iam", settings: "admin",
};

/** المجال المقترح حين لا وحدة (بوّابة admin/raw-role/عامة) — من اسم الراوتر. */
const ROUTER_DOMAIN = {
  authRouter: "iam", userRouter: "iam", roleRouter: "iam", platformAdminRouter: "platform",
  auditRouter: "audit", systemRouter: "admin", periodLockRouter: "accounting", yearEndRouter: "accounting",
  accountsRouter: "accounting", employeeRouter: "hr", payrollRouter: "hr", attendanceRouter: "hr",
  leaveRouter: "hr", recruitmentRouter: "hr", hrDeviceRouter: "hr", assetsRouter: "assets",
  storefrontRouter: "storefront", kioskRouter: "kiosk", countPortalRouter: "inventory",
  branchRouter: "admin", integrationRouter: "admin", pushRouter: "admin", imports: "admin",
  barcodeRouter: "catalog", printPosRouter: "sales", printPricingRouter: "sales",
  stocktakeRouter: "inventory", deliveryRouter: "delivery", courierRouter: "delivery",
  creditApprovalRouter: "ar", installmentRouter: "ar", arRemindersRouter: "ar", apRemindersRouter: "ap",
  giftsRouter: "gifts", reservationsRouter: "reservations", offlineRouter: "sales",
  broadcastsRouter: "marketing", conversationRouter: "channels", contactsRouter: "crm",
  imageStudioRouter: "catalog", priceWavesRouter: "catalog", promotionRouter: "marketing",
  promotionsV2Router: "marketing", bundlesRouter: "catalog", catalogRouter: "catalog",
  cardAccountRouter: "treasury", cashTransfersRouter: "treasury", shiftRouter: "treasury",
  voucherRouter: "treasury", exchangeRouter: "treasury", expenseRouter: "treasury",
  documentDeliveryRouter: "documents", globalSearchRouter: "search", storeAdminRouter: "store",
  quotationRouter: "sales", saleRouter: "sales", returnRouter: "sales", purchaseRouter: "purchasing",
  purchaseReturns: "purchasing", productionRouter: "inventory", inventoryRouter: "inventory",
  supplierRouter: "purchasing", customerRouter: "crm", customerNoteRouter: "crm",
  workOrderRouter: "workorders", commissionsRouter: "commissions", consignmentRouter: "consignment",
  reportsRouter: "reports", tasksRouter: "tasks", crmRouter: "crm", treasuryRouter: "treasury",
};

/** المورد المقترح من اسم الراوتر (يُنقّح يدوياً عند اعتماد الكتالوج). */
function resourceOf(router, name) {
  const nested = name.includes(".") ? name.split(".").slice(0, -1).join("_") : null;
  if (nested) return nested.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const base = router.replace(/Router$/, "").replace(/s$/, "");
  return base.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

/** الفعل القياسي المقترح من اسم النقطة (§10.2)، أو الاسم نفسه كفعل أعمال خاص. */
const ACTION_MAP = [
  [/^(list|search|find|browse|facets|options|lookup)/i, "list"],
  [/^(get|byId|detail|show|view|preview|status|summary|stats|report|export$)/i, "view"],
  [/^export/i, "export"], [/^(print|label)/i, "print"], [/^(send|notify|broadcast|share)/i, "send"],
  [/^(create|add|new|open|start|submit$|register|record|issue)/i, "create"],
  [/^(update|edit|set|save|rename|assign|move|patch|toggle)/i, "update"],
  [/^(delete|remove|purge|destroy)/i, "delete"],
  [/^(approve|confirm|sign)/i, "approve"], [/^reject/i, "reject"],
  [/^(cancel|void)/i, "void"], [/^(reverse|revert|undo)/i, "reverse"], [/^refund/i, "refund"],
  [/^(close|finish|finalize)/i, "close"], [/^(reopen|unlock)/i, "reopen"],
  [/^import/i, "import"], [/^(download|file)/i, "download"], [/^(login|auth)/i, "authenticate"],
  [/^logout/i, "logout"], [/^(revoke|disable|deactivate)/i, "revoke"],
];
function actionOf(name) {
  const leaf = name.includes(".") ? name.split(".").pop() : name;
  for (const [re, act] of ACTION_MAP) if (re.test(leaf)) return act;
  return leaf.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

function proposePermission(router, name, module) {
  const domain = MODULE_DOMAIN[module] ?? ROUTER_DOMAIN[router] ?? router.replace(/Router$/, "").toLowerCase();
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
 *   const hrRead  = protectedProcedure.use(requireModule("hr", "READ"));
 *   const assetWrite = protectedProcedure.use(requireModule("assets", "FULL"));
 *   const auditReadProcedure = protectedProcedure.use(({ctx}) => { if (ctx.user.role !== "admin") ... })
 * كل واحدة مصدر سلطة إضافي خارج السجلّ المركزي ⇒ تُعلَّم LOCAL_GATE في الجرد.
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
    const mod = rhs.match(/requireModule\(\s*["']([^"']+)["']\s*,\s*["'](FULL|READ)["']/);
    const roleGate = rhs.match(/ctx\.user\.role\s*!==\s*["']([a-z_]+)["']/g);
    const requireRole = rhs.match(/requireRole\(([^)]*)\)/);
    const inherited = PROCEDURES[base] ?? null;
    gates[name] = {
      authority: mod ? "module-map" : roleGate ? "raw-role" : requireRole ? "raw-role" : (inherited?.authority ?? "none"),
      module: mod ? mod[1] : inherited?.module ?? null,
      level: mod ? mod[2] : inherited?.level ?? null,
      roles: roleGate
        ? Array.from(new Set(roleGate.map((r) => r.match(/["']([a-z_]+)["']/)[1])))
        : requireRole
          ? Array.from(requireRole[1].matchAll(/["']([a-z_]+)["']/g)).map((x) => x[1])
          : inherited?.roles ?? [],
      branch: inherited?.branch ?? false,
      local: true,
      base,
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
    const prefix = nested.map((n) => n.prefix).filter(Boolean).join(".");
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
        while (nested.length && depth <= nested[nested.length - 1].depth) nested.pop();
      }
    }
  }
  flush("unknown", lines.length);
  return out;
}

function sensitivityOf(ep) {
  const n = ep.name.toLowerCase();
  const hit = SENSITIVE_HINTS.find((h) => n.includes(h));
  if (ep.kind === WRITE_KIND && hit) return { level: "HIGH", why: `فعل حسّاس: ${hit}` };
  if (ep.kind === WRITE_KIND) return { level: "MEDIUM", why: "كتابة" };
  if (hit && (hit === "export" || hit === "print")) return { level: "HIGH", why: `أثر خارجي: ${hit}` };
  return { level: "LOW", why: "قراءة" };
}

/** أعلام المخاطر التي تهمّ خطة الترحيل. */
function flagsOf(ep, meta) {
  const f = [];
  if (!meta) f.push("PROCEDURE_UNKNOWN");
  else {
    if (meta.authority === "none" && ep.kind === WRITE_KIND) f.push("WRITE_WITHOUT_MODULE_GATE");
    if (meta.authority === "none" && ep.kind === "query") f.push("READ_WITHOUT_MODULE_GATE");
    if (meta.authority === "raw-role") f.push("RAW_ROLE_GATE");
    if (meta.authority === "admin") f.push("ADMIN_ONLY");
    if (meta.authority === "module-map" && meta.branch === false) f.push("NO_BRANCH_SCOPE");
    if (meta.authority === "unknown") f.push("PROCEDURE_UNRESOLVED");
    if (meta.local) f.push("LOCAL_GATE");
  }
  if (ep.procedure === "publicProcedure") f.push("UNAUTHENTICATED");
  const s = sensitivityOf(ep);
  if (s.level === "HIGH") f.push("SENSITIVE_ACTION");
  return f;
}

/* ─────────────────────────── مسح Express + المهام ─────────────────────────── */

function scanExpress() {
  const rows = [];
  const files = [
    "server/printRoute.ts", "server/imageRoute.ts", "server/backupRoutes.ts",
    "server/routes/channelWebhooks.ts", "server/routes/waMedia.ts", "server/wellKnown.ts",
    "server/index.ts",
  ];
  for (const rel of files) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, "utf8").split(/\r?\n/);
    lines.forEach((l, i) => {
      const m = l.match(/\b(?:r|app|router)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/);
      if (m) rows.push({ surface: "express", method: m[1].toUpperCase(), path: m[2], file: rel, line: i + 1 });
      const mount = l.match(/app\.use\(\s*["'`](\/api\/[^"'`]*)["'`]/);
      if (mount) rows.push({ surface: "express-mount", method: "MOUNT", path: mount[1], file: rel, line: i + 1 });
    });
  }
  return rows;
}

function scanJobs() {
  const rows = [];
  for (const f of walk(join(ROOT, "server"))) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((l, i) => {
      if (/cron\.schedule\s*\(/.test(l)) rows.push({ kind: "cron", file: relative(ROOT, f), line: i + 1 });
      else if (/setInterval\s*\(/.test(l)) rows.push({ kind: "interval", file: relative(ROOT, f), line: i + 1 });
    });
  }
  return rows;
}

/* ─────────────────────────── التنفيذ ─────────────────────────── */

const trpcFiles = [
  ...walk(join(ROOT, "server", "routers")),
  join(ROOT, "server", "routers.ts"),
].filter(existsSync);

const endpoints = [];
for (const f of trpcFiles) {
  const routerName = relative(ROOT, f).replace(/\\/g, "/").replace(/^server\/routers\//, "").replace(/\.ts$/, "");
  for (const ep of scanTrpcFile(f)) {
    const meta = ep.gate;
    const s = sensitivityOf(ep);
    endpoints.push({
      surface: "trpc",
      router: routerName,
      proposedPermission: proposePermission(routerName, ep.name, meta?.module ?? null),
      name: ep.name,
      kind: ep.kind,
      procedure: ep.procedure,
      authority: meta?.authority ?? "unknown",
      module: meta?.module ?? "",
      level: meta?.level ?? "",
      roles: (meta?.roles ?? []).join("|"),
      branch: meta?.branch === false ? "none" : String(meta?.branch ?? "unknown"),
      sensitivity: s.level,
      sensitivityWhy: s.why,
      flags: flagsOf(ep, meta).join("|"),
      loc: `${relative(ROOT, ep.file).replace(/\\/g, "/")}:${ep.line}`,
    });
  }
}
endpoints.sort((a, b) => (a.router + a.name).localeCompare(b.router + b.name));

const express = scanExpress();
const jobs = scanJobs();

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
  proposedPermissions: new Set(endpoints.map((e) => e.proposedPermission)).size,
  proposedDomains: tally(endpoints, (e) => e.proposedPermission.split(".")[0]),
};

function tally(rows, fn) {
  const m = {};
  for (const r of rows) m[fn(r)] = (m[fn(r)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}
function tallyFlags(rows) {
  const m = {};
  for (const r of rows) for (const f of r.flags.split("|").filter(Boolean)) m[f] = (m[f] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}

mkdirSync(OUT_DIR, { recursive: true });

const cols = ["surface", "router", "name", "proposedPermission", "kind", "procedure", "authority", "module", "level", "roles", "branch", "sensitivity", "sensitivityWhy", "flags", "loc"];
const csv = [cols.join(",")]
  .concat(endpoints.map((e) => cols.map((c) => `"${String(e[c] ?? "").replace(/"/g, '""')}"`).join(",")))
  .join("\n");
writeFileSync(join(OUT_DIR, "endpoint-inventory.csv"), "﻿" + csv, "utf8");
writeFileSync(
  join(OUT_DIR, "endpoint-inventory.json"),
  JSON.stringify({ summary, endpoints, express, jobs }, null, 2),
  "utf8",
);

console.log(JSON.stringify(summary, null, 2));

if (process.argv.includes("--check")) {
  const bad = endpoints.filter((e) => e.flags.includes("WRITE_WITHOUT_MODULE_GATE"));
  if (bad.length) {
    console.error(`\n✖ ${bad.length} نقطة كتابة بلا بوّابة وحدة:`);
    for (const b of bad.slice(0, 50)) console.error(`  - ${b.router}.${b.name} (${b.procedure}) ${b.loc}`);
    process.exit(1);
  }
}
