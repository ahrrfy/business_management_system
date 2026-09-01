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
if (!app.includes('path="/audit"') || !app.includes('roles={["admin","auditor"]}')) fail("مسار سجل الحركات المستقل أو صلاحياته ناقصة.");

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
