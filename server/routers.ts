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
import { branchRouter } from "./routers/branchRouter";
import { workOrderRouter } from "./routers/workOrderRouter";
import { customerRouter } from "./routers/customerRouter";
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
import { cashTransfersRouter } from "./routers/cashTransfersRouter";
import { conversationRouter } from "./routers/conversationRouter";
import { integrationRouter } from "./routers/integrationRouter";
import { deliveryRouter } from "./routers/deliveryRouter";
import { exchangeRouter } from "./routers/exchangeRouter";
import { platformAdminRouter } from "./routers/platformAdminRouter";

/**
 * Root API router. Business module routers are mounted here as they are built.
 */
export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
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
  branches: branchRouter,
  workOrders: workOrderRouter,
  customers: customerRouter,
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
  production: productionRouter,
  assets: assetsRouter,
  employees: employeeRouter,
  attendance: attendanceRouter,
  payroll: payrollRouter,
  leaves: leaveRouter,
  recruitment: recruitmentRouter,
  hrDevices: hrDeviceRouter,
  promotions: promotionRouter,
  printPos: printPosRouter,
  globalSearch: globalSearchRouter,
  // المرحلة ٦ (١٩/٦/٢٦): إقفال فترات + موافقات ائتمان + إقفال سنوي.
  periodLock: periodLockRouter,
  creditApproval: creditApprovalRouter,
  yearEnd: yearEndRouter,
  treasury: treasuryRouter,
  cashTransfers: cashTransfersRouter,
  // شَريحة #5 (٢٣/٦/٢٦): صَندوق الوارد المُوحَّد — WhatsApp/Instagram/متجر/يَدوي.
  conversations: conversationRouter,
  // شَريحة #6 (٢٤/٦/٢٦): إدارة tokens التَكاملات في الواجهة (بَدل .env).
  integrations: integrationRouter,
  // delivery-cod (٢٦/٦/٢٦): التوصيل (COD) — جهات التوصيل/العهد/الترحيل.
  delivery: deliveryRouter,
  // exchange-house (٣٠/٦/٢٦): الصيرفة (الصرّاف) — محفظتان دينار/دولار + تسديد موردين + كشف/مطابقة.
  exchange: exchangeRouter,
  // تعدد الشركات — شاشة إدارة المنصّة (منفصلة تماماً عن جلسة/أدوار أي شركة).
  platformAdmin: platformAdminRouter,
});

export type AppRouter = typeof appRouter;
