import { router } from "./trpc";
import { systemRouter } from "./routers/systemRouter";
import { authRouter } from "./routers/authRouter";
import { saleRouter } from "./routers/saleRouter";
import { purchaseRouter } from "./routers/purchaseRouter";
import { inventoryRouter } from "./routers/inventoryRouter";
import { returnRouter } from "./routers/returnRouter";
import { purchaseReturnsRouter } from "./routers/purchaseReturns";
import { shiftRouter } from "./routers/shiftRouter";
import { catalogRouter } from "./routers/catalogRouter";
import { supplierRouter } from "./routers/supplierRouter";
import { consignmentRouter } from "./routers/consignmentRouter";
import { branchRouter } from "./routers/branchRouter";
import { workOrderRouter } from "./routers/workOrderRouter";
import { customerRouter } from "./routers/customerRouter";
import { customerNoteRouter } from "./routers/customerNoteRouter";
import { arRemindersRouter } from "./routers/arRemindersRouter";
import { apRemindersRouter } from "./routers/apRemindersRouter";
import { pushRouter } from "./routers/pushRouter";
import { expenseRouter } from "./routers/expenseRouter";
import { reportsRouter } from "./routers/reportsRouter";
import { quotationRouter } from "./routers/quotationRouter";
import { userRouter } from "./routers/userRouter";
import { roleRouter } from "./routers/roleRouter";
import { auditRouter } from "./routers/auditRouter";
import { barcodeRouter } from "./routers/barcodeRouter";
import { importRouter } from "./routers/imports";
import { voucherRouter, voucherCategoryRouter } from "./routers/voucherRouter";
import { stocktakeRouter } from "./routers/stocktakeRouter";
import { countPortalRouter } from "./routers/countPortalRouter";
import { kioskRouter } from "./routers/kioskRouter";
import { productionRouter } from "./routers/productionRouter";
import { assetsRouter } from "./routers/assetsRouter";
import { employeeRouter } from "./routers/employeeRouter";
import { attendanceRouter } from "./routers/attendanceRouter";
import { payrollRouter } from "./routers/payrollRouter";
import { installmentRouter } from "./routers/installmentRouter";
import { commissionsRouter } from "./routers/commissionsRouter";
import { leaveRouter } from "./routers/leaveRouter";
import { recruitmentRouter } from "./routers/recruitmentRouter";
import { hrDeviceRouter } from "./routers/hrDeviceRouter";
import { promotionRouter } from "./routers/promotionRouter";
import { printPosRouter } from "./routers/printPosRouter";
import { globalSearchRouter } from "./routers/globalSearchRouter";
import { periodLockRouter } from "./routers/periodLockRouter";
import { creditApprovalRouter } from "./routers/creditApprovalRouter";
import { yearEndRouter } from "./routers/yearEndRouter";
import { treasuryRouter } from "./routers/treasuryRouter";
import { cardAccountRouter } from "./routers/cardAccountRouter";
import { cashTransfersRouter } from "./routers/cashTransfersRouter";
import { conversationRouter } from "./routers/conversationRouter";
import { integrationRouter } from "./routers/integrationRouter";
import { deliveryRouter } from "./routers/deliveryRouter";
import { exchangeRouter } from "./routers/exchangeRouter";
import { bundlesRouter } from "./routers/bundlesRouter";
import { priceWavesRouter } from "./routers/priceWavesRouter";
import { promotionsV2Router } from "./routers/promotionsV2Router";
import { platformAdminRouter } from "./routers/platformAdminRouter";
import { storefrontRouter } from "./routers/storefrontRouter";
import { storeAdminRouter } from "./routers/storeAdminRouter";
import { courierRouter } from "./routers/courierRouter";
import { crmRouter } from "./routers/crmRouter";
import { offlineRouter } from "./routers/offlineRouter";
import { imageStudioRouter } from "./routers/imageStudioRouter";
import { printPricingRouter } from "./routers/printPricingRouter";
import { tasksRouter } from "./routers/tasksRouter";
import { contactsRouter } from "./routers/contactsRouter";

/**
 * Root API router. Business module routers are mounted here as they are built.
 */
export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  // العمل دون اتصال (لقطات النموذج المحلي) — الشريحة ٢ من خطة الأوفلاين.
  offline: offlineRouter,
  users: userRouter,
  roles: roleRouter,
  sales: saleRouter,
  purchases: purchaseRouter,
  inventory: inventoryRouter,
  returns: returnRouter,
  purchaseReturns: purchaseReturnsRouter,
  shifts: shiftRouter,
  catalog: catalogRouter,
  suppliers: supplierRouter,
  consignments: consignmentRouter,
  branches: branchRouter,
  workOrders: workOrderRouter,
  customers: customerRouter,
  customerNotes: customerNoteRouter,
  arReminders: arRemindersRouter,
  apReminders: apRemindersRouter,
  push: pushRouter,
  expenses: expenseRouter,
  reports: reportsRouter,
  quotations: quotationRouter,
  audit: auditRouter,
  barcode: barcodeRouter,
  imports: importRouter,
  vouchers: voucherRouter,
  voucherCategories: voucherCategoryRouter,
  stocktakes: stocktakeRouter,
  count: countPortalRouter,
  kiosk: kioskRouter,
  storefront: storefrontRouter,
  storeAdmin: storeAdminRouter,
  production: productionRouter,
  assets: assetsRouter,
  employees: employeeRouter,
  attendance: attendanceRouter,
  payroll: payrollRouter,
  installments: installmentRouter,
  // commissions (٦/٧/٢٦): الأهداف والعمولات — خطط/أهداف شهرية/تشغيلات عمولات البائعين.
  commissions: commissionsRouter,
  leaves: leaveRouter,
  recruitment: recruitmentRouter,
  hrDevices: hrDeviceRouter,
  promotions: promotionRouter,
  printPos: printPosRouter,
  // printPricing (٢٢/٧): محرّك تسعير الطباعة الرقمية (Digital) — حاسبة + إعدادات، محصورة بالمدير.
  printPricing: printPricingRouter,
  globalSearch: globalSearchRouter,
  // المرحلة ٦ (١٩/٦/٢٦): إقفال فترات + موافقات ائتمان + إقفال سنوي.
  periodLock: periodLockRouter,
  creditApproval: creditApprovalRouter,
  yearEnd: yearEndRouter,
  treasury: treasuryRouter,
  // حساب البطاقة/البنك: رصيد مشتقّ من receipts (paymentMethod='CARD') + مطابقة كشف البنك (reportViewer).
  cardAccount: cardAccountRouter,
  cashTransfers: cashTransfersRouter,
  // شَريحة #5 (٢٣/٦/٢٦): صَندوق الوارد المُوحَّد — WhatsApp/Instagram/متجر/يَدوي.
  conversations: conversationRouter,
  // شَريحة #6 (٢٤/٦/٢٦): إدارة tokens التَكاملات في الواجهة (بَدل .env).
  integrations: integrationRouter,
  imageStudio: imageStudioRouter,
  // delivery-cod (٢٦/٦/٢٦): التوصيل (COD) — جهات التوصيل/العهد/الترحيل.
  delivery: deliveryRouter,
  // courier (١٢/٧/٢٦): شاشة المندوب الذاتية «توصيلاتي» — طلباتي + تأكيد التسليم والتحصيل.
  courier: courierRouter,
  // exchange-house (٣٠/٦/٢٦): الصيرفة (الصرّاف) — محفظتان دينار/دولار + تسديد موردين + كشف/مطابقة.
  exchange: exchangeRouter,
  // bundles (٧/٧/٢٦): المنتجات المركّبة (باندل/بكج) — إدارة وصفة المكوّنات + معاينة أثر التعديل.
  bundles: bundlesRouter,
  // priceWaves (٧/٧/٢٦): موجات تحديث الأسعار — معاينة قبل الالتزام + تطبيق ذرّي + سجلّ دائم.
  priceWaves: priceWavesRouter,
  // salesPromotions v2 (٨/٧/٢٦): العروض على catalog/pos.ts (فلسفة «نقطة العرض = نقطة الفرض»).
  // NOTE: مفتاح `salesPromotions` مختلف عن `promotions` (ترقيات HR).
  salesPromotions: promotionsV2Router,
  // CRM هو نقطة الملكية الموحدة للحملات والعروض والكوبونات؛ الوحدات الأخرى مستهلكة للأحداث فقط.
  crm: crmRouter,
  // تعدد الشركات — شاشة إدارة المنصّة (منفصلة تماماً عن جلسة/أدوار أي شركة).
  platformAdmin: platformAdminRouter,
  // نظام المهام الموحّد (S2 — مركز واتساب الأعمال، ٢٣/٧/٢٦): تذكرة موحّدة لكل طلب خدمة/دعم/استفسار.
  tasks: tasksRouter,
  // بنك جهات الاتصال (S3، T3.2): بحث موحّد + بطاقة ٣٦٠° + أشخاص اتصال B2B + كشف ازدواج.
  // مفتاح صلاحيات «crm» القائم يُعاد استخدامه (لا مفتاح جديد) — لا علاقة بـ`crm:` أعلاه
  // (ذاك مفتاح راوتر حملات/كوبونات تاريخي على وحدة «campaigns» رغم الاسم).
  contacts: contactsRouter,
});

export type AppRouter = typeof appRouter;
