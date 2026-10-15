import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const fail = (message) => {
  console.error(`✗ حارس إسناد العمليات: ${message}`);
  process.exitCode = 1;
};
const filesUnder = (dir, extension) => {
  const out = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(path.join(root, current), { withFileTypes: true })) {
      const relative = path.join(current, entry.name);
      if (entry.isDirectory()) visit(relative);
      else if (relative.endsWith(extension) && !relative.includes("__tests__") && !relative.endsWith(".test.ts")) out.push(relative);
    }
  };
  visit(dir);
  return out;
};

const exactStringList = (source, expected) => {
  if (!/^\s*["'][^"']+["'](?:\s*,\s*["'][^"']+["'])*\s*,?\s*$/.test(source ?? "")) return false;
  const values = [...source.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]).sort();
  return JSON.stringify(values) === JSON.stringify([...expected].sort());
};

/** Check the audit route itself; a role declaration elsewhere cannot protect an unwrapped page. */
const auditRouteProtected = (app, navigation) => {
  const route = app.match(/<Route\b[^>]*\bpath\s*=\s*["']\/audit["'][^>]*>([\s\S]*?)<\/Route>/)?.[1];
  const wrapper = route?.match(/<RequireRole\b([^>]*)>([\s\S]*?)<\/RequireRole>/);
  if (!wrapper || !/<AuditLogs\b/.test(wrapper[2])) return false;
  if (!/\bgate\s*=/.test(wrapper[1])) {
    return !/\bmodule\s*=/.test(wrapper[1]) && exactStringList(
      wrapper[1].match(/\broles\s*=\s*\{\s*\[([^\]]*)\]\s*\}/)?.[1], ["admin", "auditor"],
    );
  }
  if (!/\bgate\s*=\s*\{\s*AUDIT_LOGS_GATE\s*\}/.test(wrapper[1]) ||
      !/import\s*\{[^}]*\bAUDIT_LOGS_GATE\b[^}]*\}\s*from\s*["']@\/lib\/navVisibility["']/.test(app)) return false;
  const gate = navigation.match(/export\s+const\s+AUDIT_LOGS_GATE(?:\s*:\s*RoleGate)?\s*=\s*\{([^}]*)\}/)?.[1];
  return !!gate && !/\b(?:module|managerOnly|anyOf|allOf)\s*:/.test(gate) &&
    exactStringList(gate.match(/\broles\s*:\s*\[([^\]]*)\]/)?.[1], ["admin", "auditor"]) &&
    exactStringList(gate.match(/\boperations\s*:\s*\[([^\]]*)\]/)?.[1], ["audit.list", "audit.facets"]);
};

const auditGateSelfTest = () => {
  const route = (props) => `<Route path="/audit"><Shell><RequireRole ${props}><AuditLogs /></RequireRole></Shell></Route>`;
  const imported = 'import { AUDIT_LOGS_GATE } from "@/lib/navVisibility";';
  const gate = 'export const AUDIT_LOGS_GATE: RoleGate = { roles: ["admin", "auditor"], operations: ["audit.list", "audit.facets"] };';
  const cases = [
    [route('roles={["admin","auditor"]}'), "", true],
    [imported + route("gate={AUDIT_LOGS_GATE}"), gate, true],
    ['<Route path="/audit"><AuditLogs /></Route>' + route('roles={["admin","auditor"]}').replace('/audit', '/other'), gate, false],
    [imported + route("gate={AUDIT_LOGS_GATE}"), gate.replace('"audit.facets"', '"audit.export"'), false],
    [imported + route("gate={AUDIT_LOGS_GATE}"), gate.replace('"auditor"', '"cashier"'), false],
    [route('roles={["admin","auditor"]} gate={OTHER_GATE}'), gate, false],
  ];
  for (const [app, navigation, expected] of cases) {
    if (auditRouteProtected(app, navigation) !== expected) throw new Error("اختبار حارس بوابة سجل الحركات فشل.");
  }
};
auditGateSelfTest();
if (process.argv.includes("--selftest")) {
  console.log("✓ الاختبار الذاتي لبوابة سجل الحركات: legacy + canonical + رفض المسار غير المحمي.");
  process.exit(0);
}

const trpc = read("server/trpc.ts");
const procedureRoots = trpc.match(/t\.procedure/g) ?? [];
if (procedureRoots.length !== 1) fail(`يجب أن يبقى t.procedure بجذر واحد مدقّق؛ الموجود ${procedureRoots.length}.`);
for (const contract of [
  "t.procedure.use(auditMutationOperation)",
  'outcome = result.ok ? "SUCCESS" : "FAILURE"',
  "automaticActorForProcedure(path, ctx.user != null)",
  "await getRawInput()",
  "const shouldWriteAutomatic = result.ok ? !specializedAuditWritten : ctx.user != null",
]) {
  if (!trpc.includes(contract)) fail(`عقد tRPC ناقص: ${contract}`);
}

const routerFiles = filesUnder("server/routers", ".ts");
const mutationCount = routerFiles.reduce((sum, file) => sum + (read(file).match(/\.mutation\s*\(/g)?.length ?? 0), 0);

const serverFiles = filesUnder("server", ".ts");
const unsafeHttp = [];
for (const file of serverFiles) {
  const source = read(file);
  const routes = [...source.matchAll(/\b(?:r|router|app)\.(?:post|put|patch|delete)\s*\(/g)];
  if (!routes.length) continue;
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    const region = source.slice(route.index, routes[index + 1]?.index ?? source.length);
    if (!/\blogAudit\s*\(/.test(region)) {
      fail(`${file}: المسار ${route[0]} بلا نداء logAudit ضمن معالجه.`);
    }
    if (!/outcome\s*:\s*["']FAILURE["']/.test(region)) {
      fail(`${file}: المسار ${route[0]} بلا سجل فشل صريح ضمن معالجه.`);
    }
  }
  unsafeHttp.push(...routes.map((route) => `${file}:${route[0]}`));
}

const platformRouter = read("server/routers/platformAdminRouter.ts");
const platformMutations = platformRouter.match(/\.mutation\s*\(/g)?.length ?? 0;
const platformAudits = platformRouter.match(/\blogPlatformAudit\s*\(/g)?.length ?? 0;
if (platformAudits < platformMutations) {
  fail(`إدارة المنصّة: ${platformMutations} mutations مقابل ${platformAudits} سجلات منصة.`);
}
if (!platformRouter.includes("listPlatformAudit")) fail("سجلّ إدارة المنصّة يُكتب لكنه غير قابل للعرض.");

// كل عامل جديد يجب أن يُصنّف هنا صراحةً: سجل نظام مركزي، سجل حدث/صندوق دائم، أو قراءة فقط.
const BACKGROUND_POLICIES = {
  startAppNotificationOutboxWorker: "durable appNotificationOutbox + system summary",
  startDeliveryOutboxWorker: "durable deliveryOutbox + system summary",
  startLagMonitor: "read-only runtime telemetry",
  startMorningPushCron: "durable pushDailyClaim/pushNotificationLog + system summary",
  startNativePushOutboxWorker: "durable nativePushOutbox + system summary",
  startSuperAppExpoPushWorker: "durable superAppExpoPushOutbox + system summary",
  startOnlineOrderExpirySweeper: "durable onlineOrders state + system summary",
  startProductStudioNotificationWorker: "SYSTEM_ACTOR + appNotifications/auditLogs",
  startProductStudioStagingWorker: "durable staging rows + system summary",
  startPurchaseIntegrityMonitor: "read-only forensic monitor",
  startReconcileScheduler: "read-only financial reconciliation",
  startReservationsSweeper: "durable reservationEvents + system summary",
  startStorefrontPushCampaignWorker: "durable storefrontPushDeliveries",
  startWebPushOutboxWorker: "durable webPushOutbox + pushNotificationLog",
  startWaOutboxSweeper: "durable waOutbox/waWebhookEvents + system summary",
};
const index = read("server/index.ts");
const registeredJobs = new Set(
  [...index.matchAll(/\b(start[A-Z][A-Za-z0-9]*(?:Worker|Cron|Sweeper|Monitor|Scheduler))\s*\(\s*\)/g)].map((match) => match[1]),
);
for (const job of registeredJobs) if (!BACKGROUND_POLICIES[job]) fail(`العامل ${job} بلا سياسة إسناد صريحة.`);
for (const job of Object.keys(BACKGROUND_POLICIES)) if (!registeredJobs.has(job)) fail(`سياسة عامل يتيم: ${job}.`);
if (!index.includes('runAcrossActiveTenants("reception_draft_sweep", sweepExpiredDrafts)')) {
  fail("كنّاس مسودات الاستقبال خارج سجل عامل النظام.");
}
const background = read("server/tenancy/backgroundTenants.ts");
for (const contract of ["backgroundOperationEffectCount", "auditBackgroundFailure", "system.job.", 'source: "system"', 'outcome: "FAILURE"']) {
  if (!background.includes(contract)) fail(`عقد العامل المركزي ناقص: ${contract}`);
}

const CENTRALIZED_JOB_FILES = {
  app_notification_outbox: "server/services/appNotificationOutboxWorker.ts",
  delivery_outbox: "server/services/delivery/outboxWorker.ts",
  delivery_stale_sweep: "server/services/delivery/staleSweep.ts",
  morning_push: "server/services/morningPushScheduler.ts",
  native_push_outbox: "server/services/nativePushOutboxWorker.ts",
  superapp_expo_push_outbox: "server/services/superAppPushWorker.ts",
  web_push_outbox: "server/services/webPushOutboxWorker.ts",
  online_order_reservation_expiry: "server/services/onlineOrderExpirySweeper.ts",
  product_studio_staging: "server/services/productStudioStagingWorker.ts",
  reception_draft_sweep: "server/services/reception/draft.ts",
  reservation_near_expiry: "server/services/reservations/nearExpiry.ts",
  whatsapp_outbox: "server/services/whatsapp/outboxSweeper.ts",
};
for (const [job, file] of Object.entries(CENTRALIZED_JOB_FILES)) {
  const source = read(file);
  const escapedJob = job.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entersScope = new RegExp(`runAcrossActiveTenants\\s*\\(\\s*["']${escapedJob}["']`).test(source);
  const guardsRecursion = new RegExp(`isBackgroundOperationActive\\s*\\(\\s*["']${escapedJob}["']\\s*\\)`).test(source);
  if (!entersScope || !guardsRecursion) fail(`${file}: العامل ${job} يستطيع تجاوز نطاق الإسناد المركزي.`);
}

const app = read("client/src/App.tsx");
const shellStart = app.indexOf("function Shell(");
const shellEnd = app.indexOf("function StudioRouteAccess", shellStart);
const shell = app.slice(shellStart, shellEnd);
if (!shell.includes("<OperationAuditAccess />")) fail("مدخل سجل الحركات غير مركّب في Shell لكل الشاشات المحمية.");
if (!auditRouteProtected(app, read("client/src/lib/navVisibility.ts"))) fail("مسار سجل الحركات المستقل أو صلاحياته ناقصة.");

const auditPage = read("client/src/pages/AuditLogs.tsx");
for (const contract of ['mode: "columns" as const', "screenPath", "auditOperationMeta", "محاولة فاشلة"]) {
  if (!auditPage.includes(contract)) fail(`واجهة سجل الحركات ناقصة: ${contract}`);
}
const platformPage = read("client/src/pages/PlatformAdmin.tsx");
if (!platformPage.includes("<PlatformAuditTable />") || !platformPage.includes("operation={operation}")) {
  fail("واجهة إدارة المنصّة لا تعرض عقد من/ماذا/الهدف/الوقت.");
}

const screenContextClients = [
  "client/src/main.tsx",
  "client/src/lib/printing/serverBridge.ts",
  "client/src/pages/Settings.tsx",
];
for (const file of screenContextClients) {
  if (!read(file).includes("screenAttributionHeaders()")) {
    fail(`${file}: طلب كاتب داخلي بلا سياق الشاشة المبلّغ عنه.`);
  }
}
const auditRouter = read("server/routers/auditRouter.ts");
if (!auditRouter.includes("eq(auditLogs.screenPath, i.screenPath)")) {
  fail("فلتر سجل الشاشة لا يستخدم العمود المفهرس auditLogs.screenPath.");
}

const pageFiles = filesUnder("client/src/pages", ".tsx");
const tableSurfaces = pageFiles.reduce(
  (sum, file) => sum + (read(file).match(/<(?:DataTable|Table|table)\b/g)?.length ?? 0),
  0,
);
const inlineOperationTables = pageFiles.reduce(
  (sum, file) => sum + (read(file).match(/operation=\{[^}]+\}/g)?.length ?? 0),
  0,
);
const protectedRoutes = app.match(/<Shell>/g)?.length ?? 0;

if (!process.exitCode) {
  console.log(
    `✓ تغطية إسناد العمليات: ${mutationCount} mutation عبر جذر واحد، ${unsafeHttp.length} مسارات HTTP كاتبة، ` +
      `${registeredJobs.size} عوامل مصنّفة، ${protectedRoutes} مسارات محمية، ${pageFiles.length} شاشة تحت مدخل السجل العام؛ ` +
      `${inlineOperationTables} جداول بإسناد داخل الصف من أصل ${tableSurfaces} سطحاً، والبقية تصل لسجل الشاشة العام.`,
  );
}
