/** Canonical operation permissions are generated from mounted tRPC routes, never a guessed matrix. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.argv.includes("--root")
  ? resolve(process.argv[process.argv.indexOf("--root") + 1])
  : SCRIPT_ROOT;
const modules = new Map();
const unknownVocabulary = new Set();
const normalizePath = (p) => relative(ROOT, p).replaceAll("\\", "/");

function loadModule(file) {
  if (modules.has(file)) return modules.get(file);
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const info = { file, sf, src, bindings: new Map(), imports: new Map() };
  modules.set(file, info);
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer)
          info.bindings.set(d.name.text, d.initializer);
      }
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const moduleName = statement.moduleSpecifier.text;
      if (!moduleName.startsWith(".")) continue;
      const stem = resolve(dirname(file), moduleName);
      const target = [`${stem}.ts`, `${stem}/index.ts`, stem].find(existsSync);
      const named = statement.importClause?.namedBindings;
      if (named && ts.isNamedImports(named))
        for (const item of named.elements) {
          info.imports.set(item.name.text, {
            file: target,
            name: item.propertyName?.text ?? item.name.text,
          });
        }
    }
  }
  return info;
}

function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression;
  return node;
}

function resolveBinding(node, info, visited = new Set()) {
  node = unwrap(node);
  if (!ts.isIdentifier(node)) return { node, info };
  const identity = `${info.file}:${node.text}`;
  if (visited.has(identity))
    throw new Error(`Circular router reference: ${identity}`);
  visited.add(identity);
  const imported = info.imports.get(node.text);
  if (imported?.file) {
    const other = loadModule(imported.file);
    const value = other.bindings.get(imported.name);
    if (!value) throw new Error(`Unresolved imported router ${identity}`);
    return resolveBinding(value, other, visited);
  }
  const local = info.bindings.get(node.text);
  if (!local) throw new Error(`Unresolved router reference: ${identity}`);
  return resolveBinding(local, info, visited);
}

function propertyName(node) {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  )
    return node.text;
  throw new Error(`Computed router key is not classified: ${node.getText()}`);
}

function routerObject(node, info) {
  ({ node, info } = resolveBinding(node, info));
  if (
    ts.isCallExpression(node) &&
    /^(router|t\.router)$/.test(node.expression.getText(info.sf))
  ) {
    const object = node.arguments[0];
    if (!object || !ts.isObjectLiteralExpression(object))
      throw new Error(
        `Router argument must be literal: ${normalizePath(info.file)}`,
      );
    return { node: object, info };
  }
  if (ts.isObjectLiteralExpression(node)) return { node, info };
  return null;
}

function walkRouter(node, info, prefix = [], out = []) {
  const resolved = routerObject(node, info);
  if (!resolved) throw new Error(`Not a router: ${prefix.join(".")}`);
  ({ node, info } = resolved);
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) {
      walkRouter(prop.expression, info, prefix, out);
      continue;
    }
    if (
      !ts.isPropertyAssignment(prop) &&
      !ts.isShorthandPropertyAssignment(prop)
    ) {
      throw new Error(
        `Unsupported router property: ${normalizePath(info.file)} ${prop.getText(info.sf).slice(0, 90)}`,
      );
    }
    const name = propertyName(prop.name);
    const path = [...prefix, name];
    const value = unwrap(
      ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer,
    );
    if (
      ts.isCallExpression(value) &&
      ts.isPropertyAccessExpression(value.expression) &&
      ["query", "mutation", "subscription"].includes(value.expression.name.text)
    ) {
      if (value.expression.name.text === "subscription")
        throw new Error(
          `Subscription requires explicit permission classification: ${path.join(".")}`,
        );
      const line =
        info.sf.getLineAndCharacterOfPosition(prop.getStart(info.sf)).line + 1;
      out.push({
        path: path.join("."),
        kind: value.expression.name.text,
        file: normalizePath(info.file),
        line,
        source: prop.getText(info.sf),
        value,
        info,
      });
    } else walkRouter(value, info, path, out);
  }
  return out;
}

/** An unconditional cutover rejection is not an executable business permission. */
function isRetiredWrite(ep) {
  const handler = ep.value.arguments[0];
  if (!handler || (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler))) return false;
  let body = handler.body;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return false;
    const statement = body.statements[0];
    if (!ts.isReturnStatement(statement) && !ts.isExpressionStatement(statement)) return false;
    body = statement.expression;
    if (!body) return false;
  }
  body = unwrap(body);
  if (!ts.isCallExpression(body) || !ts.isIdentifier(body.expression)) return false;
  const helper = ep.info.imports.get(body.expression.text)?.name ?? body.expression.text;
  return helper === "assertLegacyPurchaseWritePathDisabled";
}

const ROOT_LABELS = {
  system: "إعدادات النظام",
  auth: "الحساب والجلسة",
  superApp: "تطبيق الموظفين",
  executive: "الإدارة التنفيذية",
  cashRemediation: "تصحيح النقد التاريخي",
  statutoryAccounting: "المحاسبة النظامية",
  offline: "العمل دون اتصال",
  users: "المستخدمون",
  roles: "الأدوار والتفويض",
  sales: "فواتير المبيعات",
  salesPipeline: "دورة المبيعات",
  salesControl: "طلبات مراجعة المبيعات",
  purchases: "أوامر الشراء",
  purchaseReturnGovernance: "حوكمة مرتجعات الشراء",
  supplierPayments: "سداد الموردين",
  purchaseCharges: "مصروفات الشراء",
  purchaseIntegrity: "سلامة المشتريات",
  goodsReceiptReversal: "عكس استلام الشراء",
  supplierInvoiceApproval: "اعتماد فاتورة المورد",
  inventory: "المخزون والمناقلات",
  accounts: "الدفتر والحسابات",
  returns: "مرتجعات المبيعات",
  purchaseReturns: "مرتجعات المشتريات",
  printAudit: "تدقيق الطباعة",
  shifts: "ورديات الصندوق",
  catalog: "الأصناف والأسعار",
  catalogAnomalies: "تدقيق بيانات الأصناف",
  suppliers: "الموردون",
  consignments: "بضاعة الأمانة",
  digitalCards: "البطاقات والخدمات الرقمية",
  gifts: "الهدايا",
  branches: "الفروع",
  workOrders: "أوامر الشغل",
  refundRails: "مصادر رد المبالغ",
  workOrderDesignApproval: "اعتماد التصاميم",
  customers: "العملاء",
  customerNotes: "ملاحظات العملاء",
  arReminders: "متابعة ذمم العملاء",
  apReminders: "متابعة ذمم الموردين",
  push: "الإشعارات",
  nativePush: "إشعارات التطبيقات",
  expenses: "المصروفات",
  reports: "التقارير",
  quotations: "عروض الأسعار",
  audit: "سجل التدقيق",
  deliveryLegacyRepair: "تصحيح التوصيل التاريخي",
  barcode: "الباركود",
  imports: "استيراد البيانات",
  vouchers: "سندات القبض والصرف",
  voucherCategories: "تصنيفات السندات",
  stocktakes: "الجرد",
  count: "محطة العد",
  kiosk: "أكشاك الخدمة",
  storefront: "متجر العملاء",
  storeAdmin: "إدارة المتجر والطلبات",
  shelfAnalytics: "تحليل الأصناف",
  production: "الإنتاج",
  assets: "الأصول",
  employees: "الموظفون",
  hrEnterprise: "إدارة الموارد البشرية",
  attendance: "الحضور والانصراف",
  payroll: "الرواتب",
  installments: "الأقساط",
  commissions: "العمولات والأهداف",
  leaves: "الإجازات",
  recruitment: "التوظيف",
  hrDevices: "أجهزة الحضور",
  promotions: "الترقيات الوظيفية",
  printPos: "مبيعات خدمات الطباعة",
  printPricing: "تسعير الطباعة",
  globalSearch: "البحث العام",
  periodLock: "إقفال الفترات",
  creditApproval: "اعتماد الائتمان",
  yearEnd: "إقفال السنة",
  treasury: "الخزينة",
  cardAccount: "حساب البطاقة والبنك",
  cashTransfers: "تحويل النقد",
  conversations: "المحادثات والطلبات",
  integrations: "التكاملات",
  imageStudio: "صور المنتجات",
  productStudio: "استوديو الأصناف",
  delivery: "التوصيل",
  courier: "مهام المندوب",
  exchange: "الصيرفة",
  bundles: "وصفات المنتجات المركبة",
  priceWaves: "موجات تحديث الأسعار",
  salesPromotions: "العروض التجارية",
  crm: "الحملات والعلاقات",
  platformAdmin: "إدارة المنصة",
  contacts: "جهات الاتصال",
  broadcasts: "البث التسويقي",
  reservations: "الحجوزات",
  reception: "الاستقبال",
  documentDelivery: "إرسال المستندات",
  announcements: "إعلانات الموظفين",
  selfApprovalAudit: "تدقيق الاعتماد الذاتي",
  sessionContext: "سياق الجلسة",
  decisions: "مطلوب مني الآن",
  invoicePrinting: "طباعة فواتير المبيعات",
};
const STAGES = [
  [/approve|reject|decide|review|accept|deny/i, "APPROVAL", "اعتماد ومراجعة"],
  [
    /reverse|revert|refund|return|recover|restore|correct|remediat/i,
    "CORRECTION",
    "مرتجع وتصحيح",
  ],
  [/cancel|void|withdraw|abort|discard/i, "CANCELLATION", "إلغاء وسحب"],
  [
    /close|lock|settle|reconcil|archive|finish|complete/i,
    "CLOSING",
    "إقفال وتسوية",
  ],
  [
    /pay|collect|remit|receiveCash|deposit|withdraw|fund/i,
    "PAYMENT",
    "قبض وصرف",
  ],
  [
    /dispatch|deliver|assign|handover|release|start|execute|post|confirm|activate|publish|launch|apply/i,
    "EXECUTION",
    "تنفيذ وترحيل",
  ],
  [/request|submit|send|propose|escalat/i, "REQUEST", "طلب وإرسال"],
  [
    /create|add|save|update|edit|upsert|set|delete|remove|merge|import|generate|regenerate|upload|attach/i,
    "PREPARATION",
    "إعداد وتعديل",
  ],
];
const EXACT_LABELS = {
  "sales.create": "إصدار فاتورة مبيعات",
  "sales.correct": "تصحيح فاتورة مبيعات",
  "sales.cancel": "إلغاء فاتورة مبيعات وعكس أثرها",
  "sales.cancelUnpaidCod": "إلغاء فاتورة دفع عند الاستلام دون قبض أو صرف",
  "sales.pay": "تحصيل فاتورة مبيعات",
  "returns.create": "إنشاء طلب مرتجع مبيعات أو تنفيذ مرتجع مباشر",
  "returns.withdrawRequest": "سحب طلب مرتجع قديم قبل التنفيذ",
  "returns.executeSalesReturnCart": "تنفيذ سلة مرتجع المبيعات",
  "delivery.dispatch": "إسناد طلب متجر إلى جهة التوصيل",
  "delivery.dispatchInvoice": "إسناد فاتورة إلى جهة التوصيل",
  "delivery.reassign": "إعادة إسناد شحنة إلى جهة أخرى",
  "delivery.reassignConsignment": "إعادة إسناد شحنة إلى جهة أخرى",
  "purchases.createOrder": "إنشاء مسودة أمر شراء",
  "purchases.confirmOrder": "إرسال أمر الشراء وطلب اعتماده",
  "purchases.decideControl": "اعتماد أو رفض طلب مراجعة أو إلغاء أو شراء طارئ",
  "purchases.requestControl": "طلب مراجعة أمر شراء أو إلغائه أو شراء طارئ",
  "salesControl.requestExchange": "طلب استبدال البيع",
  "workOrders.requestControl": "طلب تعديل تجاري أو خامات أو إلغاء أو عكس تسليم أمر الشغل",
  "productStudio.transitionCampaign": "تفعيل أو إيقاف أو إكمال أو إلغاء حملة صور الأصناف",
  "digitalCards.sales.requestReviewResolution": "طلب حسم مراجعة البيع الرقمي بالإلغاء أو الإكمال أو شطب الخسارة",
  "supplierPayments.requestPayment": "طلب سداد فاتورة المورد",
  "supplierPayments.decidePayment": "اعتماد أو رفض سداد المورد",
  "supplierPayments.cashSources": "اختيار مصادر سداد المورد بما فيها الخزينة",
  "invoicePrinting.requestPrint": "طباعة فاتورة المبيعات",
  "invoicePrinting.requestReprint": "إعادة طباعة فاتورة المبيعات",
  "invoicePrinting.authorizeBridge": "الإرسال إلى جسر طابعة المتجر",
  "productStudio.authorizeExport": "تفويض تصدير صور الأصناف",
  "employees.createWithAccount":
    "إنشاء موظف مع بقاء إنشاء أو ربط حسابه للإدارة",
  "employees.update": "تعديل بيانات الموظف مع بقاء تعديل الأجور للإدارة",
  "customers.update": "تعديل بيانات العميل مع بقاء سقف الائتمان والرصيد للسلطة المالية",
  "workOrders.create": "إنشاء أمر شغل مع بقاء إدخال أجر العمل الإضافي للإدارة",
  "stocktakes.create": "إنشاء جلسة جرد مع بقاء الافتتاحي وإعدادات الحوكمة للإدارة",
};
// These existing readers return unmasked accounting cost/profit facts. Granting
// the operation also requires an explicit sensitive-data visibility decision.
const COST_VISIBILITY_PATHS = new Set([
  "returns.executePurchaseReturnCart",
  "catalogAnomalies.list",
  "catalogAnomalies.changeLog",
  "inventory.costRevaluationPreview",
  "inventory.costRevaluations",
  "inventory.costWaves",
  "inventory.costWave",
  "inventory.requestCostRevaluation",
  "inventory.approveCostRevaluation",
  "inventory.previewCostWave",
  "stocktakes.review",
  "stocktakes.report",
  "stocktakes.approve",
  "stocktakes.refreshOpeningValuationBasis",
  "digitalCards.pricing.getMorningSheet",
  "digitalCards.pricing.preview",
  "digitalCards.pricing.mismatchReports",
  "digitalCards.sales.saleDetails",
  "gifts.report",
  "reports.profitAndLoss",
  "reports.profitByCategory",
  "reports.topProducts",
  "reports.salesReport",
  "reports.salesRegister",
  "reports.salesByDimension",
  "reports.monthlyClosePack",
  "reports.deadStockValue",
  "reports.negativeStock",
  "reports.wipReport",
  "reports.productionReport",
  "reports.productionReportPage",
  "reports.workOrdersReport",
  "reports.inventoryValuation",
  "reports.inventoryValuationAt",
  "catalog.getForEdit",
  "catalog.getForVariantEdit",
  "catalog.forPurchase",
  "catalog.materialsForRecipe",
  "catalog.categoryStats",
  "catalog.lastPurchaseCost",
  "catalog.productVersions",
  "catalog.productVersionDiff",
  "reports.financialPosition",
  "reports.workOrderProfitability",
  "bundles.searchComponents",
  "bundles.lookupComponentByBarcode",
  "priceWaves.preview",
  "priceWaves.waveDetails",
  "consignments.balancesReport",
  "consignments.marginsReport",
  "consignments.settlementStatement",
  "production.list",
  "production.get",
  "production.runPreview",
  "production.bundles.list",
  "production.recipes.list",
  "production.recipes.listRunnable",
  "production.recipes.get",
  "production.recipes.materials",
  "production.recipes.forProduct",
  "production.recipes.suggestSimilar",
  "production.recipes.listForImport",
  "production.recipes.checkStockAvailability",
  "production.recipes.preview",
  "printPricing.estimate",
  "printPricing.settings",
  "audit.list",
  "audit.facets",
]);
const NAVIGATION_MODULE_OVERRIDES = {
  "audit.list": "reports",
  "audit.facets": "reports",
};
// Generic authenticated readers still keep their exact legacy (session-only)
// gate. Navigation classification is separate from authorization requirements.
const AUTHENTICATED_BUSINESS_READERS = {
  "globalSearch.search": null,
  "reports.dashboardMetrics": "reports",
  "branches.list": "settings",
  "imageStudio.aiConfig": "products",
  "system.getOpeningProgress": "inventory",
  "system.getTaxSettings": "settings",
  "invoicePrinting.authorizeBridge": "sales",
};
// These role checks restrict only the openingScope cross-branch option. Their
// ordinary branch query can be delegated; the handler keeps the admin condition.
const CONDITIONAL_SCOPE_CHECKS = new Set([
  "arReminders.queue",
  "arReminders.history",
  // Employee creation is independent; account.mode !== none keeps its explicit
  // administrator condition in the handler and account service.
  "employees.createWithAccount",
]);
// Exact reviewed bridges only: central permission proof replaces these old raw
// role gates. Without the helper in the relevant source, they stay UNSUPPORTED.
const HANDLED_ROLE_CHECKS = new Set([
  "audit.list",
  "audit.facets",
  "cardAccount.createReconciliation",
  "reservations.extend",
]);
// The reviewed service gates are independent of tRPC's outer procedure. A key
// remains unavailable until its exact adapter call is present in the service.
const SERVICE_ROLE_BINDINGS = new Map();
const bindServiceRoles = (paths, source, helper) => {
  for (const path of paths) SERVICE_ROLE_BINDINGS.set(path, { source, helper });
};
bindServiceRoles(["treasury.fundTreasury"], "server/services/treasuryFundingService.ts", "assertOperationAuthorityTx");
bindServiceRoles(["production.recipes.substituteMaterial"], "server/services/recipeService.ts", "assertOperationAuthorityTx");
bindServiceRoles(
  ["delivery.cancelAssignment"],
  "server/services/delivery/cancellation.ts",
  "assertOperationAuthorityTx",
);
bindServiceRoles(
  [
    "salesControl.claimCorrectionPayment",
    "salesControl.releaseCorrectionPaymentClaim",
    "salesControl.approve",
    "salesControl.reject",
  ],
  "server/services/sale/controlRequests.ts",
  "assertOperationAuthorityTx",
);
bindServiceRoles(
  ["cashTransfers.send", "cashTransfers.receive", "cashTransfers.cancel"],
  "server/services/cashTransferService.ts",
  "assertOperationAuthorityTx",
);
bindServiceRoles(
  ["expenses.create"],
  "server/services/expenseService.ts",
  "assertOperationAuthorityTx",
);
bindServiceRoles(
  ["gifts.campaignCreate", "gifts.campaignClose"],
  "server/services/gifts/campaigns.ts",
  "assertOperationAuthorityTx",
);
bindServiceRoles(
  ["gifts.createOutbound", "gifts.approveGift", "gifts.cancelGift"],
  "server/services/gifts/outbound.ts",
  "assertOperationAuthorityTx",
);
bindServiceRoles(
  ["supplierPayments.cashSources"],
  "server/services/purchase/supplierPayments.ts",
  "canonicalOperationAllowed",
);
bindServiceRoles(
  [
    "digitalCards.reversal.approve",
    "digitalCards.reversal.requestLossRefund",
    "digitalCards.reversal.lossRefund",
    "digitalCards.reversal.rejectLossRefund",
  ],
  "server/services/digitalCards/reversalService.ts",
  "assertServiceOperationTx",
);
bindServiceRoles(
  [
    "digitalCards.sales.requestReviewResolution",
    "digitalCards.sales.approveReviewResolution",
    "digitalCards.sales.rejectReviewResolution",
  ],
  "server/services/digitalCards/reviewResolutionService.ts",
  "assertServiceOperationTx",
);
bindServiceRoles(
  [
    "digitalCards.sales.requestWriteoff",
    "digitalCards.sales.approveWriteoff",
    "digitalCards.sales.rejectWriteoff",
  ],
  "server/services/digitalCards/writeoffService.ts",
  "assertServiceOperationTx",
);
bindServiceRoles(
  ["digitalCards.sales.recover"],
  "server/services/digitalCards/finalizeService.ts",
  "loadDigitalIntentScopeTx",
);
bindServiceRoles(
  [
    "workOrders.requestControl",
    "workOrders.approveControl",
    "workOrders.rejectControl",
    "workOrders.controlPreflight",
  ],
  "server/services/workOrder/controlRequests.ts",
  "assertOperationAuthorityTx",
);
bindServiceRoles(["workOrders.cancel"], "server/services/workOrder/cancel.ts", "assertOperationAuthorityTx");
bindServiceRoles(
  [
    "treasury.cashVariance.registerEvidence",
    "treasury.cashVariance.list",
    "treasury.cashVariance.get",
    "treasury.cashVariance.responsibleUsers",
    "treasury.cashVariance.propose",
    "treasury.cashVariance.approve",
    "treasury.cashVariance.reject",
  ],
  "server/services/cashVarianceService.ts",
  "assertCashVarianceOperation",
);
bindServiceRoles(
  ["treasury.missedDailyCount.request", "treasury.missedDailyCount.decide"],
  "server/services/cash/missedDailyCountException.ts",
  "assertOperationAuthorityTx",
);
// The return gate resolves the fresh locked stored user directly instead of
// using the shared actor adapter. The path still must be bound explicitly.
bindServiceRoles(
  ["returns.create"],
  "server/services/returnService.ts",
  "canonicalOperationAllowed",
);
bindServiceRoles(
  ["returns.withdrawRequest"],
  "server/services/returns/requests.ts",
  "assertOperationAuthorityTx",
);
const STUDIO_PROTECTED_ACCOUNT_PATHS = new Set([
  "productStudio.grantStudioAccess",
  "productStudio.createTemporaryPhotographer",
  "productStudio.revokeTemporaryPhotographers",
]);
const STUDIO_SERVICE_ROLE_PATHS = new Set(
  [
    "managerImages",
    "deleteImage",
    "setImagePrimary",
    "reorderImages",
    "imageHealthCounts",
    "discoverImageGaps",
    "gapProductIds",
    "topGapCategories",
    "assignees",
    "createCampaign",
    "updateCampaignDetails",
    "transitionCampaign",
    "previewCampaignBacklog",
    "createCampaignBacklog",
    "drainCampaignBacklog",
    "distributeCampaignTasks",
    "updateCampaignAssignees",
    "sendDueNotifications",
    "assign",
    "bulkAssign",
    "reassign",
    "bulkReassign",
    "bulkSetPriority",
    "updateSchedule",
    "approve",
    "reject",
    "revert",
    "cancel",
    "cancelCampaignBacklog",
    "productImages",
    "campaigns",
    "campaignBoard",
    "campaignAnalytics",
  ].map((method) => `productStudio.${method}`),
);

const STUDIO_IMAGE_MANAGER_PATHS = new Set([
  "productStudio.managerImages",
  "productStudio.deleteImage",
  "productStudio.setImagePrimary",
  "productStudio.reorderImages",
]);
const STUDIO_DISCOVERY_PATHS = new Set([
  "productStudio.imageHealthCounts",
  "productStudio.discoverImageGaps",
  "productStudio.gapProductIds",
  "productStudio.topGapCategories",
]);
const serviceProofCache = new Map();
function serviceSource(relativePath) {
  const file = resolve(ROOT, relativePath);
  if (!serviceProofCache.has(file))
    serviceProofCache.set(
      file,
      existsSync(file) ? readFileSync(file, "utf8") : "",
    );
  return serviceProofCache.get(file);
}
export function serviceRoleReviewNeeded(path) {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (STUDIO_SERVICE_ROLE_PATHS.has(path)) {
    const helper = serviceSource(
      "server/services/authorization/studioOperationAuthority.ts",
    );
    const router = serviceSource("server/routers/productStudioRouter.ts");
    const service = serviceSource(
      STUDIO_IMAGE_MANAGER_PATHS.has(path)
        ? "server/services/productStudioImageManager.ts"
        : STUDIO_DISCOVERY_PATHS.has(path)
          ? "server/services/productStudioDiscovery.ts"
          : "server/services/productStudioService.ts",
    );
    // Finite manager allowlist, exact router proof, exact service binding, and
    // shared transaction revalidation must all be present for this operation.
    return !(
      helper.includes(`"${path}"`) &&
      /\bhasServiceOperationAuthority\s*\(/.test(helper) &&
      /\bassertOperationAuthorityTx\s*\(/.test(helper) &&
      /\brouteOperationAuthority\s*\(/.test(router) &&
      new RegExp(`\\bactor\\s*\\(\\s*ctx\\s*,\\s*["']${escapedPath}["']`).test(
        router,
      ) &&
      new RegExp(
        `\\bassertStudioOperationBinding\\s*\\(\\s*actor\\s*,\\s*["']${escapedPath}["']`,
      ).test(service)
    );
  }
  const binding = SERVICE_ROLE_BINDINGS.get(path);
  if (!binding) return false;
  const source = serviceSource(binding.source);
  const call = new RegExp(
    `\\b${binding.helper}\\s*\\([\\s\\S]{0,350}?["']${escapedPath}["']`,
  );
  return !call.test(source);
}
const FIXED_HANDLER_AUTHORITY = new Set([
  "payroll.obligations",
  "commissions.plans.create",
  "commissions.plans.update",
  "commissions.plans.setActive",
  "commissions.runs.approveRequest",
  "commissions.runs.rejectRequest",
  "commissions.runs.remove",
]);
// Mutating scopes implemented and revalidated inside these exact services.
const SERVICE_RECORD_SCOPE_PATHS = new Set([
  "treasury.getRecentMovements",
  "shifts.list",
  "shifts.report",
  "workOrders.start",
  "workOrders.markReady",
  "workOrders.setKanbanState",
  "digitalCards.sales.prepare",
  "digitalCards.sales.claimExecution",
  "digitalCards.sales.markExecution",
  "digitalCards.sales.cancelIntent",
  "digitalCards.sales.getIntent",
  "digitalCards.sales.finalize",
  "digitalCards.sales.recover",
]);
const STAGE_OVERRIDES = {
  "sales.create": "EXECUTION",
  "purchases.confirmOrder": "REQUEST",
  "supplierPayments.requestPayment": "REQUEST",
  "supplierPayments.decidePayment": "APPROVAL",
  "purchases.decideControl": "APPROVAL",
  "returns.create": "REQUEST",
  "returns.executeSalesReturnCart": "CORRECTION",
};
const WORDS = {
  list: "قائمة",
  get: "تفاصيل",
  find: "بحث",
  search: "بحث",
  lookup: "بحث",
  by: "حسب",
  for: "لـ",
  of: "لـ",
  my: "الخاصة بي",
  all: "الكل",
  create: "إنشاء",
  add: "إضافة",
  update: "تعديل",
  edit: "تعديل",
  save: "حفظ",
  set: "ضبط",
  upsert: "حفظ",
  remove: "إزالة",
  delete: "حذف",
  approve: "اعتماد",
  reject: "رفض",
  decide: "حسم",
  request: "طلب",
  submit: "إرسال",
  confirm: "تأكيد",
  cancel: "إلغاء",
  void: "إبطال",
  reverse: "عكس",
  revert: "تراجع",
  restore: "استعادة",
  correct: "تصحيح",
  return: "مرتجع",
  refund: "رد مبلغ",
  recover: "استرداد",
  close: "إقفال",
  open: "فتح",
  reopen: "إعادة فتح",
  start: "بدء",
  finish: "إنهاء",
  complete: "إكمال",
  execute: "تنفيذ",
  apply: "تطبيق",
  post: "ترحيل",
  dispatch: "إسناد للتوصيل",
  reassign: "إعادة إسناد",
  assign: "إسناد",
  handover: "تسليم العهدة",
  release: "تحرير",
  deliver: "تسليم",
  delivery: "التوصيل",
  collect: "تحصيل",
  pay: "سداد",
  payment: "السداد",
  payments: "المدفوعات",
  remittance: "التوريد",
  remit: "توريد",
  settle: "تسوية",
  settlement: "التسوية",
  reconcile: "مطابقة",
  reconciliation: "المطابقة",
  withdraw: "سحب",
  deposit: "إيداع",
  fund: "تمويل",
  print: "طباعة",
  reprint: "إعادة طباعة",
  export: "تصدير",
  import: "استيراد",
  preview: "معاينة",
  estimate: "تقدير",
  calculate: "حساب",
  validate: "تحقق",
  check: "فحص",
  verify: "تحقق",
  generate: "توليد",
  regenerate: "إعادة توليد",
  upload: "رفع",
  download: "تنزيل",
  attach: "إرفاق",
  detach: "فصل",
  link: "ربط",
  unlink: "فك الربط",
  merge: "دمج",
  split: "تقسيم",
  clone: "نسخ",
  copy: "نسخ",
  duplicate: "تكرار",
  activate: "تفعيل",
  deactivate: "تعطيل",
  enable: "تفعيل",
  disable: "تعطيل",
  toggle: "تبديل",
  active: "النشاط",
  mark: "إثبات",
  launch: "إطلاق",
  publish: "نشر",
  unpublish: "إلغاء النشر",
  archive: "أرشفة",
  abandon: "ترك",
  abort: "إيقاف",
  pause: "تعليق",
  resume: "استئناف",
  queue: "الطابور",
  acknowledge: "إقرار",
  ack: "إقرار",
  retry: "إعادة المحاولة",
  refresh: "تحديث",
  sync: "مزامنة",
  send: "إرسال",
  probe: "فحص الاتصال",
  test: "اختبار",
  health: "الحالة",
  ping: "فحص الاتصال",
  login: "دخول",
  logout: "خروج",
  me: "حسابي",
  status: "الحالة",
  settings: "الإعدادات",
  config: "الإعدادات",
  summary: "الملخص",
  overview: "نظرة عامة",
  report: "تقرير",
  reports: "التقارير",
  stats: "الإحصاءات",
  statistics: "الإحصاءات",
  metrics: "المؤشرات",
  dashboard: "لوحة المتابعة",
  history: "السجل",
  timeline: "تسلسل الأحداث",
  audit: "التدقيق",
  events: "الأحداث",
  event: "الحدث",
  logs: "السجل",
  log: "السجل",
  detail: "التفاصيل",
  details: "التفاصيل",
  options: "الخيارات",
  defaults: "القيم الافتراضية",
  count: "العدد",
  counts: "الأعداد",
  total: "الإجمالي",
  totals: "الإجماليات",
  balance: "الرصيد",
  balances: "الأرصدة",
  statement: "كشف الحساب",
  statements: "كشوف الحساب",
  financials: "الوضع المالي",
  obligations: "الالتزامات",
  exposure: "العهد",
  pending: "المعلّق",
  ready: "الجاهز",
  overdue: "المتأخر",
  stale: "المتأخر",
  recent: "الأحدث",
  current: "الحالي",
  latest: "الأحدث",
  available: "المتاح",
  availability: "التوفر",
  eligible: "المستحق",
  eligibility: "الاستحقاق",
  approved: "المعتمد",
  approvers: "المعتمدون",
  rejected: "المرفوض",
  cancelled: "الملغى",
  failed: "الفشل",
  delivered: "المسلّم",
  received: "المستلم",
  paid: "المسدّد",
  unpaid: "غير المسدّد",
  draft: "المسودة",
  drafts: "المسودات",
  document: "المستند",
  documents: "المستندات",
  order: "الطلب",
  orders: "الطلبات",
  invoice: "الفاتورة",
  invoices: "الفواتير",
  sale: "المبيعة",
  sales: "المبيعات",
  purchase: "الشراء",
  purchases: "المشتريات",
  supplier: "المورد",
  suppliers: "الموردون",
  customer: "العميل",
  customers: "العملاء",
  party: "الجهة",
  parties: "الجهات",
  member: "العضو",
  members: "الأعضاء",
  consignment: "الشحنة",
  consignments: "الشحنات",
  parcel: "الطرد",
  parcels: "الطرود",
  courier: "المندوب",
  couriers: "المناديب",
  branch: "الفرع",
  branches: "الفروع",
  account: "الحساب",
  accounts: "الحسابات",
  user: "المستخدم",
  users: "المستخدمون",
  role: "الدور",
  roles: "الأدوار",
  session: "الجلسة",
  sessions: "الجلسات",
  password: "كلمة المرور",
  permission: "التفويض",
  permissions: "التفويضات",
  product: "الصنف",
  products: "الأصناف",
  variant: "المتغير",
  variants: "المتغيرات",
  unit: "الوحدة",
  units: "الوحدات",
  category: "التصنيف",
  categories: "التصنيفات",
  barcode: "الباركود",
  barcodes: "الباركودات",
  price: "السعر",
  prices: "الأسعار",
  cost: "التكلفة",
  costs: "التكاليف",
  stock: "المخزون",
  inventory: "المخزون",
  movement: "الحركة",
  movements: "الحركات",
  transfer: "المناقلة",
  transfers: "المناقلات",
  receipt: "الإيصال",
  receipts: "الإيصالات",
  voucher: "السند",
  vouchers: "السندات",
  expense: "المصروف",
  expenses: "المصروفات",
  treasury: "الخزينة",
  cash: "النقد",
  shift: "الوردية",
  shifts: "الورديات",
  drawer: "الدرج",
  period: "الفترة",
  periods: "الفترات",
  year: "السنة",
  yearend: "إقفال السنة",
  entry: "القيد",
  entries: "القيود",
  ledger: "الدفتر",
  batch: "الدفعة",
  batches: "الدفعات",
  item: "البند",
  items: "البنود",
  line: "السطر",
  lines: "السطور",
  material: "الخامة",
  materials: "الخامات",
  recipe: "الوصفة",
  recipes: "الوصفات",
  bundle: "البكج",
  bundles: "البكجات",
  production: "الإنتاج",
  machine: "الماكينة",
  machines: "الماكينات",
  operator: "المشغّل",
  work: "الشغل",
  workorder: "أمر الشغل",
  workorders: "أوامر الشغل",
  design: "التصميم",
  proof: "الإثبات",
  approval: "الاعتماد",
  approvals: "الاعتمادات",
  control: "التحكم",
  controls: "التحكمات",
  revision: "المراجعة",
  revisions: "المراجعات",
  reason: "السبب",
  reasons: "الأسباب",
  charge: "المصروف",
  charges: "المصروفات",
  fee: "الأجور",
  fees: "الأجور",
  limit: "السقف",
  limits: "السقوف",
  credit: "الائتمان",
  digital: "الرقمي",
  card: "البطاقة",
  cards: "البطاقات",
  wallet: "المحفظة",
  wallets: "المحافظ",
  provider: "المزود",
  providers: "المزودون",
  offering: "الخدمة",
  offerings: "الخدمات",
  subscription: "الاشتراك",
  subscriptions: "الاشتراكات",
  student: "الطالب",
  students: "الطلاب",
  employee: "الموظف",
  employees: "الموظفون",
  staff: "الموظف",
  attendance: "الحضور",
  payroll: "الراتب",
  wage: "الأجر",
  salary: "الراتب",
  salaries: "الرواتب",
  leave: "الإجازة",
  leaves: "الإجازات",
  vacation: "الإجازة",
  recruitment: "التوظيف",
  vacancy: "الشاغر",
  vacancies: "الشواغر",
  applicant: "المتقدم",
  applicants: "المتقدمون",
  asset: "الأصل",
  assets: "الأصول",
  installment: "القسط",
  installments: "الأقساط",
  commission: "العمولة",
  commissions: "العمولات",
  target: "الهدف",
  targets: "الأهداف",
  plan: "الخطة",
  plans: "الخطط",
  promotion: "العرض",
  promotions: "العروض",
  coupon: "الكوبون",
  coupons: "الكوبونات",
  campaign: "الحملة",
  campaigns: "الحملات",
  broadcast: "البث",
  broadcasts: "البث",
  contact: "جهة الاتصال",
  contacts: "جهات الاتصال",
  note: "الملاحظة",
  notes: "الملاحظات",
  conversation: "المحادثة",
  conversations: "المحادثات",
  message: "الرسالة",
  messages: "الرسائل",
  template: "القالب",
  templates: "القوالب",
  channel: "القناة",
  channels: "القنوات",
  integration: "التكامل",
  integrations: "التكاملات",
  announcement: "الإعلان",
  announcements: "الإعلانات",
  reservation: "الحجز",
  reservations: "الحجوزات",
  quotation: "عرض السعر",
  quotations: "عروض الأسعار",
  image: "الصورة",
  images: "الصور",
  content: "المحتوى",
  version: "الإصدار",
  versions: "الإصدارات",
  change: "التغيير",
  changes: "التغييرات",
  diff: "الفروقات",
  mapping: "الربط",
  mappings: "الروابط",
  pin: "الرمز",
  token: "الرمز",
  tokens: "الرموز",
  device: "الجهاز",
  devices: "الأجهزة",
  legal: "القانوني",
  tax: "الضريبة",
  opening: "الافتتاح",
  closing: "الإقفال",
  progress: "التقدم",
  source: "المصدر",
  destination: "الوجهة",
  scope: "النطاق",
  scopes: "النطاقات",
  flag: "الوسم",
  flags: "الوسوم",
  tag: "الوسم",
  tags: "الوسوم",
  field: "الحقل",
  fields: "الحقول",
  form: "النموذج",
  forms: "النماذج",
  type: "النوع",
  types: "الأنواع",
  kind: "النوع",
  id: "المعرّف",
  ids: "المعرّفات",
  name: "الاسم",
  names: "الأسماء",
  reference: "المرجع",
  ref: "المرجع",
  url: "الرابط",
  urls: "الروابط",
  pdf: "المستند المطبوع",
  pos: "نقطة البيع",
  ai: "الذكاء المساعد",
  wa: "واتساب",
  sms: "الرسالة النصية",
  cod: "التحصيل عند التسليم",
  b2b: "الشركات",
  rfm: "شرائح العملاء",
  r2: "تخزين الملفات",
  usd: "الدولار",
  iqd: "الدينار",
  otp: "رمز التحقق",
  gl: "الدفتر",
  ap: "ذمم الموردين",
  ar: "ذمم العملاء",
  grn: "استلام البضاعة",
  wip: "الإنتاج الجاري",
  hr: "الموارد البشرية",
  sla: "مهلة الخدمة",
  mode: "الوضع",
  rules: "القواعد",
  rule: "القاعدة",
  enabled: "المفعّل",
  disabled: "المعطّل",
  bulk: "الجماعي",
  many: "المتعدد",
  one: "المفرد",
  manual: "اليدوي",
  auto: "التلقائي",
  external: "الخارجي",
  internal: "الداخلي",
  public: "العام",
  daily: "اليومي",
  monthly: "الشهري",
  annual: "السنوي",
  day: "اليوم",
  month: "الشهر",
  months: "الأشهر",
  date: "التاريخ",
  range: "المدة",
  window: "المدة",
  from: "من",
  to: "إلى",
  in: "في",
  out: "الخارج",
  with: "مع",
  without: "دون",
  and: "و",
  or: "أو",
  full: "الكامل",
  partial: "الجزئي",
  flex: "المرن",
  own: "الخاص",
  self: "الذاتي",
  stocktake: "الجرد",
  countsheet: "ورقة العد",
  recount: "إعادة العد",
  monitor: "متابعة",
  assignable: "القابل للإسناد",
  extend: "تمديد",
  extension: "التمديد",
  commitment: "الالتزام",
  forecast: "التوقع",
  demand: "الطلب",
  capacity: "الطاقة",
  utilization: "الاستغلال",
  accrual: "الاستحقاق",
  compensation: "التعويض",
  deduction: "الاستقطاع",
  deductions: "الاستقطاعات",
  overtime: "الإضافي",
  termination: "نهاية الخدمة",
  advance: "السلفة",
  advances: "السلف",
  loan: "القرض",
  loans: "القروض",
  contribution: "المساهمة",
  contributions: "المساهمات",
  pension: "التقاعد",
  insurance: "التأمين",
  incident: "الحادث",
  incidents: "الحوادث",
  disciplinary: "الانضباط",
  training: "التدريب",
  skill: "المهارة",
  skills: "المهارات",
  grade: "الدرجة",
  grades: "الدرجات",
  position: "المنصب",
  positions: "المناصب",
  department: "القسم",
  departments: "الأقسام",
  employment: "التوظيف",
  contract: "العقد",
  contracts: "العقود",
  benefits: "المزايا",
  benefit: "الميزة",
  allocation: "التخصيص",
  allocations: "التخصيصات",
  collection: "التحصيل",
  collections: "التحصيلات",
  attachment: "المرفق",
  attachments: "المرفقات",
  chargeback: "استرداد التحصيل",
  writeoff: "شطب العجز",
  write: "كتابة",
  off: "الشطب",
  shortfall: "العجز",
  variance: "الفرق",
  discrepancy: "الفرق",
  proofed: "المثبت",
  exposure: "العهد",
  obligations: "الالتزامات",
  follow: "متابعة",
  up: "المتابعة",
  reset: "إعادة ضبط",
  clear: "مسح",
  purge: "حذف نهائي",
  flagging: "الوسم",
  feedback: "التقييم",
  rating: "التقييم",
  analytics: "التحليل",
  ranking: "الترتيب",
  top: "الأعلى",
  slow: "البطيء",
  moving: "الحركة",
  dormant: "الراكد",
  dead: "الراكد",
  turnover: "الدوران",
  margin: "الهامش",
  profit: "الربح",
  loss: "الخسارة",
  revenue: "الإيراد",
  net: "الصافي",
  gross: "الإجمالي",
  profitloss: "الأرباح والخسائر",
  expenses: "المصروفات",
  costing: "التكلفة",
  valuation: "التقييم",
  revaluation: "إعادة التقييم",
  anomaly: "الخلل",
  anomalies: "المشكلات",
  integrity: "السلامة",
  unresolved: "غير المحسوم",
  resolved: "المحسوم",
  resolve: "حل",
  repair: "إصلاح",
  remediation: "تصحيح",
  legacy: "التاريخي",
  baseline: "خط الأساس",
  diagnostics: "التشخيص",
  inspect: "فحص",
  healthcheck: "فحص الحالة",
  catalog: "دليل الأصناف",
  lookup: "بحث",
  helper: "المساعد",
  similar: "المشابه",
  suggestion: "الاقتراح",
  suggestions: "الاقتراحات",
  suggest: "اقتراح",
  recommend: "اقتراح",
  recommendations: "الاقتراحات",
  predicted: "المتوقع",
  predictive: "التنبؤي",
  forecast: "التوقع",
  run: "التشغيل",
  runs: "التشغيلات",
  job: "المهمة",
  jobs: "المهام",
  task: "المهمة",
  tasks: "المهام",
  snapshot: "اللقطة",
  snapshots: "اللقطات",
  outbox: "طابور الإرسال",
  inbox: "صندوق الوارد",
  board: "لوحة المتابعة",
  zone: "المنطقة",
  zones: "المناطق",
  route: "المسار",
  routes: "المسارات",
  address: "العنوان",
  addresses: "العناوين",
  location: "الموقع",
  locations: "المواقع",
  phone: "الهاتف",
  email: "البريد",
  connection: "الاتصال",
  connected: "المتصل",
  connections: "الاتصالات",
  disconnect: "فصل",
  reconnect: "إعادة اتصال",
  rotate: "تجديد",
  revoke: "إلغاء التفويض",
  enroll: "تسجيل",
  register: "تسجيل",
  registration: "التسجيل",
  pairing: "الاقتران",
  pair: "اقتران",
  secret: "السر",
  secrets: "الأسرار",
  credential: "بيانات الدخول",
  credentials: "بيانات الدخول",
  policy: "السياسة",
  policies: "السياسات",
  security: "الأمان",
  access: "الوصول",
  permissioned: "المفوّض",
  reconciliation: "المطابقة",
  ingest: "استيراد",
  events: "الأحداث",
  webhook: "إشعار التكامل",
  webhooks: "إشعارات التكامل",
  match: "مطابقة",
  matching: "المطابقة",
  compare: "مقارنة",
  contrast: "مقارنة",
  evidence: "الدليل",
  fingerprint: "البصمة",
  fingerprinted: "المبصّم",
  force: "الإلزام",
  override: "استثناء",
  exception: "الاستثناء",
  exceptions: "الاستثناءات",
  test: "اختبار",
  discount: "الخصم",
  discounts: "الخصومات",
  retention: "الاحتجاز",
  custody: "العهدة",
  escrow: "الأمانة",
  fund: "تمويل",
  funding: "التمويل",
  budget: "الموازنة",
  budgets: "الموازنات",
  data: "البيانات",
  file: "الملف",
  files: "الملفات",
  rows: "الصفوف",
  row: "الصف",
  result: "النتيجة",
  results: "النتائج",
  receipt: "الإيصال",
  openingBalance: "الرصيد الافتتاحي",
};

Object.assign(WORDS, {
  requests: "الطلبات",
  correction: "التصحيح",
  corrections: "التصحيحات",
  review: "المراجعة",
  reviews: "المراجعات",
  repayment: "السداد",
  reversal: "العكس",
  reversals: "عمليات العكس",
  wave: "الموجة",
  waves: "الموجات",
  sources: "المصادر",
  leads: "العملاء المحتملون",
  page: "الصفحة",
  reorder: "إعادة الطلب",
  resolution: "المعالجة",
  claim: "المطالبة",
  adjustment: "التسوية",
  adjustments: "التسويات",
  thresholds: "العتبات",
  requisition: "طلب التوريد",
  requisitions: "طلبات التوريد",
  opportunities: "فرص البيع",
  notifications: "الإشعارات",
  record: "تسجيل",
  components: "المكونات",
  component: "المكوّن",
  customization: "التخصيص",
  persons: "الأشخاص",
  transition: "انتقال الحالة",
  alerts: "التنبيهات",
  penalties: "الغرامات",
  spot: "الفوري",
  bonuses: "المكافآت",
  replay: "إعادة المعالجة",
  readiness: "الجاهزية",
  held: "المحتجز",
  backlog: "المتراكم",
  aging: "أعمار الذمم",
  whatsapp: "واتساب",
  profile: "الملف",
  profiles: "الملفات",
  banners: "اللافتات",
  journal: "اليومية",
  journals: "اليوميات",
  sent: "المرسل",
  acquisition: "الاقتناء",
  receive: "استلام",
  performance: "الأداء",
  previous: "السابق",
  program: "البرنامج",
  programs: "البرامج",
  issue: "إصدار",
  due: "المستحق",
  dues: "المستحقات",
  today: "اليوم",
  gift: "الهدية",
  reception: "الاستقبال",
  pricing: "التسعير",
  company: "الشركة",
  remittances: "التوريدات",
  mismatch: "عدم التطابق",
  prepare: "إعداد",
  initiate: "بدء",
  outcome: "نتيجة التنفيذ",
  quick: "السريع",
  convert: "تحويل",
  breakdown: "التفصيل",
  double: "المزدوج",
  loyalty: "الولاء",
  quote: "عرض السعر",
  thematic: "الموضوعي",
  expo: "التطبيق",
  push: "الإشعار",
  missed: "الفائت",
  skipped: "المتجاوز",
  via: "عبر",
  api: "التكامل",
  maintenance: "الصيانة",
  related: "ذات الصلة",
  reconciliations: "المطابقات",
  alias: "الاسم البديل",
  usage: "الاستخدام",
  leaderboard: "ترتيب الأداء",
  assignment: "الإسناد",
  unified: "الموحّد",
  transit: "الطريق",
  letter: "المتعثر",
  sheet: "الورقة",
  sheets: "الورقات",
  intent: "نية التنفيذ",
  execution: "التنفيذ",
  center: "المركز",
  unclassified: "غير المصنّف",
  origin: "المنشأ",
  origins: "المناشئ",
  command: "الأمر",
  commands: "الأوامر",
  studio: "الاستوديو",
  transform: "تحويل",
  season: "الموسم",
  recovery: "الاسترداد",
  financial: "المالي",
  certificate: "الشهادة",
  certificates: "الشهادات",
  number: "الرقم",
  finishing: "التشطيب",
  paper: "الورق",
  upcharge: "الزيادة السعرية",
  wide: "العريض",
  media: "الخامة",
  face: "الوجه",
  temporary: "المؤقت",
  photographer: "المصور",
  photographers: "المصورون",
  analyze: "تحليل",
  produce: "إنتاج",
  multi: "المتعدد",
  reissue: "إعادة إصدار",
  insights: "المؤشرات",
  flow: "التدفق",
  index: "الفهرس",
  general: "العام",
  pack: "الحزمة",
  trial: "المراجعة",
  exchange: "الصيرفة",
  scan: "المسح",
  scans: "المسح",
  reactivate: "إعادة تفعيل",
  replace: "استبدال",
  worker: "العامل",
  alternative: "البديل",
  focused: "المحدد",
  method: "الطريقة",
  badge: "الشارة",
  preflight: "التحقق قبل التنفيذ",
  tree: "شجرة",
  disposal: "الاستبعاد",
  dispose: "استبعاد",
  depreciation: "الاستهلاك",
  reclassify: "إعادة تصنيف",
  recompute: "إعادة حساب",
  rates: "المعدلات",
  facets: "المرشحات",
  impact: "الأثر",
  dry: "المعاينة",
  admin: "الإدارة",
  extract: "استخراج",
  facts: "الحقائق",
  last: "الأخير",
  ignored: "المتجاهل",
  intentional: "المقصود",
  celebrations: "المناسبات",
  end: "النهاية",
  compute: "حساب",
  grid: "الجدول",
  consignor: "المودع",
  margins: "الهوامش",
  duplicates: "المكرر",
  inactive: "غير النشط",
  consent: "الموافقة",
  read: "القراءة",
  fail: "إثبات الفشل",
  deliveries: "التسليمات",
  issued: "المصدر",
  dossier: "الملف الكامل",
  instant: "الفوري",
  google: "جوجل",
  invite: "دعوة",
  operations: "العمليات",
  smart: "المساعد",
  comparison: "المقارنة",
  declare: "إقرار",
  ui: "الواجهة",
  governorate: "المحافظة",
  requeue: "إعادة للطابور",
  store: "المتجر",
  tracking: "التتبع",
  executions: "التنفيذات",
  postpaid: "الآجل",
  big: "الكبير",
  morning: "الصباحي",
  reversible: "القابل للعكس",
  expire: "إنهاء الصلاحية",
  finalize: "إنهاء العملية",
  needs: "الاحتياجات",
  sibling: "المشابه",
  low: "المنخفض",
  whats: "واتساب",
  app: "التطبيق",
  clearance: "إخلاء العهدة",
  buy: "شراء",
  deposits: "الإيداعات",
  backfill: "استكمال التاريخ",
  managed: "المُدار",
  trace: "تتبع",
  outbound: "الصادر",
  inbound: "الوارد",
  bonus: "المكافأة",
  bridge: "الربط",
  dismiss: "استبعاد",
  links: "الروابط",
  enqueue: "إضافة للطابور",
  map: "ربط",
  migrate: "ترحيل",
  migration: "الترحيل",
  process: "معالجة",
  folds: "دمج السجلات",
  punches: "حركات البصمة",
  trust: "الثقة",
  unlinked: "غير المربوط",
  probation: "التجربة",
  renew: "تجديد",
  terminate: "إنهاء الخدمة",
  expiry: "انتهاء الصلاحية",
  encashment: "بدل نقدي",
  disburse: "صرف",
  bounce: "إرجاع الدفعة",
  soon: "القريب",
  hub: "المركز",
  adjust: "تسوية",
  backorder: "البيع قبل التوريد",
  revaluations: "إعادة التقييم",
  rich: "المفصل",
  on: "على",
  hand: "المتاح",
  planning: "التخطيط",
  incoming: "الوارد",
  accrue: "إثبات الاستحقاق",
  discard: "إلغاء المسودة",
  grant: "تفويض",
  biometric: "البصمة الحيوية",
  statutory: "النظامي",
  obligation: "الالتزام",
  action: "العملية",
  sequence: "التسلسل",
  services: "الخدمات",
  assignees: "المكلفون",
  bind: "ربط",
  processing: "المعالجة",
  priority: "الأولوية",
  candidate: "المرشح",
  candidates: "المرشحون",
  discover: "اكتشاف",
  gaps: "النواقص",
  gap: "النقص",
  distribute: "توزيع",
  drain: "تفريغ الطابور",
  manager: "المدير",
  next: "التالي",
  reserve: "حجز",
  primary: "الرئيسي",
  schedule: "الجدولة",
  matrix: "المصفوفة",
  requirements: "المتطلبات",
  runnable: "القابل للتشغيل",
  substitute: "استبدال",
  terminations: "تسويات نهاية الخدمة",
  recognition: "إثبات الاستحقاق",
  blockers: "الموانع",
  returns: "المرتجعات",
  shipping: "الشحن",
  commit: "تنفيذ",
  promote: "نقل للمرحلة التالية",
  stage: "المرحلة",
  abc: "تصنيف الأهمية",
  analysis: "التحليل",
  watch: "متابعة",
  orphans: "غير المرتبط",
  value: "القيمة",
  at: "عند",
  management: "الإدارة",
  negative: "السالب",
  shadow: "المقارنة",
  risk: "المخاطر",
  dimension: "البعد",
  movers: "الأصناف المتحركة",
  composition: "التكوين",
  agent: "الوكيل",
  volume: "الحجم",
  csat: "رضا العميل",
  response: "الاستجابة",
  profitability: "الربحية",
  no: "دون",
  cart: "السلة",
  forensic: "التدقيق التفصيلي",
  drawers: "الأدراج",
  performers: "الأفضل أداءً",
  universal: "الموحّد",
  salespeople: "البائعون",
  drop: "إسقاط",
  recipients: "المستلمون",
  accountant: "المحاسب",
  income: "الدخل",
  seed: "تهيئة",
  iraqi: "العراقي",
  coverage: "التغطية",
  counter: "العداد",
  quality: "الجودة",
  cycle: "الدورة",
  first: "الأول",
  sign: "توقيع",
  ira: "الدخل والذمم",
  picker: "الاختيار",
  basis: "الأساس",
  remaining: "المتبقي",
  conflict: "التعارض",
  unknown: "غير المعروف",
  featured: "المميز",
  visible: "الظاهر",
  visibility: "الظهور",
  round: "الدور",
  robin: "التناوب",
  prepared: "المجهز",
  official: "الرسمي",
  moderate: "مراجعة",
  bootstrap: "التهيئة",
  payslip: "قسيمة الراتب",
  reveal: "إظهار",
  module: "الوحدة",
  pulse: "المؤشرات",
  refunds: "رد المبالغ",
  accept: "قبول",
  propose: "اقتراح",
  responsible: "المسؤول",
  series: "السلسلة",
  kpi: "مؤشرات الأداء",
  trends: "الاتجاهات",
  context: "السياق",
  historical: "التاريخي",
  other: "الأخرى",
  aggregate: "التجميع",
  resubmit: "إعادة إرسال",
  cancellation: "الإلغاء",
  checkout: "إنهاء البيع",
  kanban: "لوحة المتابعة",
  state: "الحالة",
});
Object.assign(WORDS, {
  backup: "النسخ الاحتياطي",
  backups: "النسخ الاحتياطية",
  banner: "اللافتة",
  challenge: "طلب التحقق",
  click: "النقر",
  codes: "الرموز",
  conversion: "التحويل",
  factor: "المعامل",
  firebase: "هوية التطبيق",
  info: "المعلومات",
  interaction: "التفاعل",
  notification: "الإشعار",
  now: "الآن",
  outgoing: "الصادر",
  preferences: "التفضيلات",
  private: "الخاص",
  recommendation: "الاقتراح",
  setup: "الإعداد",
  share: "المشاركة",
  two: "الثنائي",
  username: "اسم المستخدم",
  wishlist: "المفضلة",
  companies: "الشركات",
  crypto: "التشفير",
  effective: "الفعال",
  linkable: "القابل للربط",
  mine: "الخاصة بي",
  mobile: "تطبيق الهاتف",
  native: "التطبيق",
  offers: "العروض",
  provision: "تجهيز",
  respond: "الرد",
  shelf: "الرف",
  subscribe: "اشتراك",
  tenancy: "الشركة",
  track: "تتبع",
  unlock: "إعادة فتح",
  unsubscribe: "إلغاء الاشتراك",
});

function procedureUsesOwnerScope(name, info, visited = new Set()) {
  if (name === "branchScopedProcedure") return true;
  const identity = `${info.file}:${name}`;
  if (visited.has(identity)) return false;
  visited.add(identity);
  let initializer = info.bindings.get(name);
  if (!initializer) {
    const imported = info.imports.get(name);
    if (!imported?.file) return false;
    return procedureUsesOwnerScope(
      imported.name,
      loadModule(imported.file),
      visited,
    );
  }
  initializer = unwrap(initializer);
  while (
    ts.isCallExpression(initializer) &&
    ts.isPropertyAccessExpression(initializer.expression)
  )
    initializer = initializer.expression.expression;
  return (
    ts.isIdentifier(initializer) &&
    procedureUsesOwnerScope(initializer.text, info, visited)
  );
}

Object.assign(WORDS, {
  auth: "الدخول",
  aftercare: "معالجة ما بعد البيع",
  fulfillment: "التجهيز",
  excess: "الفائض",
  payee: "المستفيد",
  key: "المفتاح",
  label: "التسمية",
  system: "النظام",
  authorize: "تفويض",
});

function labelFor(path, kind) {
  if (EXACT_LABELS[path]) return EXACT_LABELS[path];
  const parts = path.split(".");
  const tokens = parts
    .slice(1)
    .join(" ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\d]+/)
    .filter(Boolean);
  const translated = tokens.map((t) => {
    if (!WORDS[t.toLowerCase()]) unknownVocabulary.add(t.toLowerCase());
    return WORDS[t.toLowerCase()] ?? t;
  });
  return `${translated.join(" ")} — ${ROOT_LABELS[parts[0]]}`;
}

function aliasesOf(ep, meta, knownKeys, procedureAliases) {
  const explicit = [
    ...ep.source.matchAll(/requireAtomicPermission\(\s*["']([^"']+)["']/g),
  ].map((m) => m[1]);
  const byPath = {
    "sales.create": ["pos.invoice.create"],
    "sales.correct": ["pos.invoice.edit"],
    "sales.cancel": ["pos.invoice.void"],
    "returns.create": ["pos.return.create"],
    "returns.withdrawRequest": ["pos.return.create"],
    "returns.executeSalesReturnCart": ["pos.return.create"],
  };
  const aliases = [
    ...new Set([
      ...explicit,
      ...(procedureAliases.get(meta.procedure) ?? []),
      ...(byPath[ep.path] ?? []),
    ]),
  ]
    .map((k) => (k === "pos.refund.create" ? "pos.return.create" : k))
    .sort();
  for (const key of aliases)
    if (!knownKeys.has(key))
      throw new Error(`Undefined legacy atomic alias ${key} for ${ep.path}`);
  return aliases;
}

export function generateOperationPermissions() {
  unknownVocabulary.clear();
  serviceProofCache.clear();
  const inventory = JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve(SCRIPT_ROOT, "scripts/authz-inventory.mjs"),
        "--json",
        "--root",
        ROOT,
      ],
      { encoding: "utf8", maxBuffer: 20_000_000 },
    ),
  );
  const metadata = new Map(inventory.endpoints.map((e) => [e.loc, e]));
  const rootModule = loadModule(resolve(ROOT, "server/routers.ts"));
  const appRouter = rootModule.bindings.get("appRouter");
  if (!appRouter)
    throw new Error("appRouter must be declared in server/routers.ts");
  const endpoints = walkRouter(appRouter, rootModule).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const atomicSource = [
    "shared/atomicPermissions.ts",
    "shared/atomicPermissionExtensions.ts",
  ]
    .map((p) => readFileSync(resolve(ROOT, p), "utf8"))
    .join("\n");
  const knownKeys = new Set(
    [...atomicSource.matchAll(/key:\s*["']([^"']+)["']/g)].map((m) => m[1]),
  );
  const trpcSource = readFileSync(resolve(ROOT, "server/trpc.ts"), "utf8");
  const procedureAliases = new Map(
    [...trpcSource.matchAll(/export const (\w+)\s*=([\s\S]*?);/g)].map((m) => [
      m[1],
      [...m[2].matchAll(/requireAtomicPermission\(\s*["']([^"']+)["']/g)].map(
        (a) => a[1],
      ),
    ]),
  );
  const paths = new Set();
  const entries = endpoints.map((ep) => {
    if (paths.has(ep.path))
      throw new Error(`Duplicate mounted operation: ${ep.path}`);
    paths.add(ep.path);
    const meta = metadata.get(`${ep.file}:${ep.line}`);
    if (
      !meta ||
      meta.authority === "unknown" ||
      meta.flags.includes("PROCEDURE_UNRESOLVED")
    ) {
      throw new Error(
        `Operation lacks gate classification: ${ep.path} at ${ep.file}:${ep.line}`,
      );
    }
    if (meta.kind !== ep.kind)
      throw new Error(
        `Operation kind differs between AST and authz scan: ${ep.path}`,
      );
    const root = ep.path.split(".")[0];
    if (!ROOT_LABELS[root])
      throw new Error(`Operation domain needs Arabic description: ${root}`);
    const module = meta.module || null;
    const isPublic =
      meta.flags.includes("UNAUTHENTICATED") ||
      ["public", "public-read"].includes(meta.authority);
    const fixedAuthority =
      meta.procedure === "storeGlobalAdminProcedure" ||
      ["owner", "admin"].includes(meta.authority) ||
      meta.gateRoles === "admin" ||
      meta.inheritedAuthority === "admin" ||
      STUDIO_PROTECTED_ACCOUNT_PATHS.has(ep.path) ||
      FIXED_HANDLER_AUTHORITY.has(ep.path);
    const identity = [
      "self-assignment",
      "platform",
      "token",
      "device-bootstrap",
    ].includes(meta.authority);
    const retired = isRetiredWrite(ep);
    const conditionalScope = CONDITIONAL_SCOPE_CHECKS.has(ep.path);
    const handledRoleCheck =
      HANDLED_ROLE_CHECKS.has(ep.path) &&
      /\bcanonicalOperationAllowed\s*\(/.test(
        ep.path.startsWith("audit.") ? ep.info.src : ep.source,
      );
    const requiresLegacyReview =
      (meta.flags.includes("HANDLER_ROLE_CHECK") &&
        !conditionalScope &&
        !fixedAuthority &&
        !handledRoleCheck) ||
      // A locally defined role middleware has no central bypass contract.
      (meta.authority === "raw-role" &&
        meta.flags.includes("LOCAL_GATE") &&
        !handledRoleCheck) ||
      serviceRoleReviewNeeded(ep.path);
    const authenticatedBusinessReader =
      Object.hasOwn(AUTHENTICATED_BUSINESS_READERS, ep.path) &&
      meta.authority === "none" &&
      !isPublic;
    const delegable =
      !isPublic &&
      !fixedAuthority &&
      !identity &&
      !retired &&
      !requiresLegacyReview &&
      (["module-map", "module-gate", "operation-gate", "raw-role"].includes(meta.authority) ||
        authenticatedBusinessReader);
    const reservedKind = delegable
      ? null
      : retired
        ? "RETIRED"
        : isPublic
        ? "PUBLIC"
        : requiresLegacyReview
          ? "UNSUPPORTED"
          : fixedAuthority
            ? "AUTHORITY"
            : "IDENTITY";
    const method = ep.path.split(".").at(-1);
    const stage =
      STAGE_OVERRIDES[ep.path] ??
      (ep.kind === "query"
        ? "VIEW"
        : /^(request|propose|submit)/i.test(method)
          ? "REQUEST"
          : (STAGES.find(([re]) => re.test(method))?.[1] ?? "EXECUTION"));
    return {
      key: `operation.${ep.path}`,
      path: ep.path,
      kind: ep.kind,
      module,
      navigationModule: authenticatedBusinessReader
        ? AUTHENTICATED_BUSINESS_READERS[ep.path]
        : (NAVIGATION_MODULE_OVERRIDES[ep.path] ?? module),
      roles: meta.roles.split("|").filter(Boolean).sort(),
      authority: meta.procedure === "storeGlobalAdminProcedure" ? "admin" : meta.authority,
      inheritedAuthority: meta.inheritedAuthority ?? null,
      branch:
        meta.branch === "none"
          ? false
          : meta.branch === "true"
            ? true
            : meta.branch,
      label: labelFor(ep.path, ep.kind),
      domain: root,
      resource: ROOT_LABELS[root],
      lifecycleStage: stage,
      legacyAliases: aliasesOf(ep, meta, knownKeys, procedureAliases),
      delegable,
      level: meta.level || null,
      procedure: meta.procedure,
      source: `${ep.file}:${ep.line}`,
      supportsRecordScope:
        delegable &&
        (SERVICE_RECORD_SCOPE_PATHS.has(ep.path) ||
          (procedureUsesOwnerScope(meta.procedure, ep.info) &&
            /\bscopedOwnerId\b/.test(ep.source))),
      requiresCostVisibility: COST_VISIBILITY_PATHS.has(ep.path),
      requiresLegacyReview,
      reservedKind,
      reservedReason: delegable
        ? null
        : retired
          ? "مسار قديم معطّل؛ استخدم إجراءات المشتريات والسداد المحكومة"
          : isPublic
          ? "قناة عامة أو مصادقة مستقلة"
          : requiresLegacyReview
            ? "قيد دور في المعالج أو الخدمة لم يرتبط بعد بالتفويض المستقل"
            : fixedAuthority
              ? "سلطة مالك أو إدارة ثابتة محفوظة"
              : "عملية مساندة مرتبطة بهوية الجلسة",
    };
  });
  if (unknownVocabulary.size)
    throw new Error(
      `Operation labels need Arabic vocabulary: ${[...unknownVocabulary].sort().join(", ")}`,
    );
  for (const path of COST_VISIBILITY_PATHS) {
    if (!paths.has(path) && ROOT === SCRIPT_ROOT)
      throw new Error(
        `Cost visibility classification refers to missing operation: ${path}`,
      );
  }
  if (ROOT === SCRIPT_ROOT)
    for (const path of [
      ...SERVICE_ROLE_BINDINGS.keys(),
      ...STUDIO_SERVICE_ROLE_PATHS,
      ...STUDIO_PROTECTED_ACCOUNT_PATHS,
    ]) {
      if (!paths.has(path))
        throw new Error(
          `Service authority classification refers to missing operation: ${path}`,
        );
    }
  return entries;
}

export function renderOperationPermissions(entries) {
  return `// Generated by scripts/generate-operation-permissions.mjs. Do not edit.\n// Exact mounted tRPC paths; reserved operations retain their mandatory identity checks.\n// prettier-ignore\nexport interface GeneratedOperationPermission {\n  key: string; path: string; kind: "query" | "mutation"; module: string | null; navigationModule: string | null;\n  roles: string[]; authority: string; inheritedAuthority: string | null; branch: boolean | string; label: string;\n  domain: string; resource: string; lifecycleStage: string; legacyAliases: string[];\n  delegable: boolean; level: string | null; procedure: string; source: string; reservedReason: string | null; supportsRecordScope: boolean; requiresCostVisibility: boolean; requiresLegacyReview: boolean; reservedKind: "AUTHORITY" | "IDENTITY" | "PUBLIC" | "UNSUPPORTED" | "RETIRED" | null;\n}\n// prettier-ignore\nexport const GENERATED_OPERATION_PERMISSIONS: readonly GeneratedOperationPermission[] = [\n${entries.map((e) => `  ${JSON.stringify(e)},`).join("\n")}\n];\n`;
}

/** Two bounded chunks keep the full catalog below the existing per-chunk build budget. */
export function renderOperationPermissionFiles(entries) {
  const full = renderOperationPermissions(entries);
  const declaration = "export const GENERATED_OPERATION_PERMISSIONS: readonly GeneratedOperationPermission[] = [";
  const header = full.slice(0, full.indexOf("// prettier-ignore\n" + declaration));
  const middle = Math.ceil(entries.length / 2);
  const files = {
    "operationPermissionCatalog.generated.ts": `${header}import { GENERATED_OPERATION_PERMISSIONS_PART_1 } from "./operationPermissionCatalog.part1.generated";\nimport { GENERATED_OPERATION_PERMISSIONS_PART_2 } from "./operationPermissionCatalog.part2.generated";\nexport const GENERATED_OPERATION_PERMISSIONS: readonly GeneratedOperationPermission[] = [...GENERATED_OPERATION_PERMISSIONS_PART_1, ...GENERATED_OPERATION_PERMISSIONS_PART_2];\n`,
  };
  for (const [index, chunk] of [entries.slice(0, middle), entries.slice(middle)].entries()) {
    files[`operationPermissionCatalog.part${index + 1}.generated.ts`] = `// Generated by scripts/generate-operation-permissions.mjs. Do not edit.\nimport type { GeneratedOperationPermission } from "./operationPermissionCatalog.generated";\n// prettier-ignore\nexport const GENERATED_OPERATION_PERMISSIONS_PART_${index + 1}: readonly GeneratedOperationPermission[] = [\n${chunk.map((entry) => `  ${JSON.stringify(entry)},`).join("\n")}\n];\n`;
  }
  return files;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const entries = generateOperationPermissions();
  const files = renderOperationPermissionFiles(entries);
  if (process.argv.includes("--check")) {
    if (Object.entries(files).some(([name, result]) => {
      const output = resolve(ROOT, "shared", name);
      return !existsSync(output) || readFileSync(output, "utf8") !== result;
    })) {
      console.error(
        "Canonical operation catalog is stale. Run node scripts/generate-operation-permissions.mjs and review the changes.",
      );
      process.exitCode = 1;
    } else
      console.log(
        `Canonical operation catalog verified: ${entries.length} exact paths, ${entries.filter((e) => e.delegable).length} delegable operations.`,
      );
  } else {
    for (const [name, result] of Object.entries(files)) writeFileSync(resolve(ROOT, "shared", name), result);
    console.log(
      `Generated ${entries.length} exact operations (${entries.filter((e) => e.delegable).length} delegable).`,
    );
  }
}
