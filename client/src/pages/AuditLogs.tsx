import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/data-table/DataTable";
import type { OperationActor } from "@/components/data-table/ActorCell";
import { ListToolbar } from "@/components/list/ListToolbar";
import { FilterField } from "@/components/list/FilterField";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { fmtDateTime } from "@/lib/date";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";

type AuditRow = RouterOutputs["audit"]["list"]["rows"][number];
type AuditOperationMeta = {
  actor?: { source?: OperationActor["source"]; label?: string | null };
  outcome?: "SUCCESS" | "FAILURE";
  screenPath?: string;
};

function auditOperationMeta(row: Pick<AuditRow, "operation" | "newValue">): AuditOperationMeta {
  const direct = row.operation;
  if (direct !== null && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as AuditOperationMeta;
  }
  // توافق مؤقت مع أي صفوف كُتبت من نسخة تجريبية سبقت فصل العقد عن newValue.
  if (row.newValue === null || typeof row.newValue !== "object" || Array.isArray(row.newValue)) return {};
  const raw = (row.newValue as Record<string, unknown>)._operation;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as AuditOperationMeta;
}

// ترجمة الأفعال الموصولة فعلياً بـlogAudit عبر الخادم (راجع grep -rn "action:" server/routers server/services
// — الأكواد أدناه مطابقة حرفياً لما يُكتب في auditLogs.action، لا تخمين). مُجمَّعة حسب الوحدة لسهولة الصيانة؛
// أي فعلٍ جديد يُضاف هنا فور ظهوره خاماً في السجلّ (الاحتياط أدناه في actionLabel يُبقي القيمة مقروءة مؤقّتاً).
const ACTION_AR: Record<string, string> = {
  // المصادقة
  "auth.login": "تسجيل دخول",
  "auth.login.failed": "محاولة دخول فاشلة",
  "auth.login.locked": "دخول مرفوض — الحساب مقفل",
  "auth.login.ip_throttled": "دخول مرفوض — محاولات كثيرة من هذا العنوان",
  "auth.login.expired_temp": "دخول مرفوض — كلمة المرور المؤقّتة منتهية",
  "auth.login.2fa_challenge": "تحدّي المصادقة الثنائية",
  "auth.login.2fa_failed": "فشل رمز المصادقة الثنائية",
  "auth.2fa.recovery_used": "استخدام رمز استرداد 2FA",
  "auth.2fa.setup_start": "بدء تفعيل المصادقة الثنائية",
  "auth.2fa.enabled": "تفعيل المصادقة الثنائية",
  "auth.2fa.disable_failed": "فشل تعطيل المصادقة الثنائية",
  "auth.2fa.disabled": "تعطيل المصادقة الثنائية",
  "auth.2fa.recovery_regenerated": "تجديد رموز استرداد 2FA",
  "auth.logout": "تسجيل خروج",
  "auth.changePassword": "تغيير كلمة المرور",
  "auth.resetPassword": "إعادة تعيين كلمة المرور (للمدير)",
  "auth.revokeSessions": "إبطال كل جلسات الحساب",
  "auth.revokeSession": "إبطال جلسة واحدة",
  // المستخدمون
  "user.create": "إنشاء مستخدم",
  "user.update": "تعديل مستخدم",
  "user.delete": "حذف مستخدم",
  "user.activate": "تفعيل مستخدم",
  "user.deactivate": "تعطيل مستخدم",
  "user.resetPassword": "إعادة تعيين كلمة مرور مستخدم",
  "user.resetTwoFactor": "تصفير المصادقة الثنائية لمستخدم",
  "user.revokeSessions": "إبطال كل جلسات مستخدم",
  "user.revokeSession": "إبطال جلسة مستخدم واحدة",
  "user.changePassword": "تغيير كلمة مرور المستخدم نفسه",
  // الأدوار والصلاحيات
  "role.create": "إنشاء دور مخصّص",
  "role.update": "تعديل دور",
  "role.activate": "تفعيل دور",
  "role.deactivate": "تعطيل دور",
  "role.delete": "حذف دور",
  // الفروع
  "branch.create": "إنشاء فرع",
  "branch.update": "تعديل فرع",
  // البيع والمرتجعات
  "sale.create": "بيع",
  "sale.pay": "تسديد فاتورة",
  "sale.creditOverride": "تجاوز حدّ الائتمان",
  "sale.creditOverride.rateLimited": "تجاوز ائتمان مرفوض — محاولات كثيرة",
  "sale.creditOverride.fail": "فشل تجاوز حدّ الائتمان",
  "sale.creditOverride.adminCrossBranch": "تجاوز ائتمان أدمن بين الفروع",
  "sale.priceOverride": "تعديل سعر يدوي عند البيع",
  "sale.openingNegative": "بيع بالسالب — وضع الافتتاح",
  "sale.offlineReplay": "ترحيل بيع أوفلاين",
  "return.create": "مرتجع",
  // المشتريات
  "purchase.createOrder": "أمر شراء",
  "purchase.confirmOrder": "اعتماد أمر شراء",
  "purchase.receive": "استلام مشتريات",
  "purchase.settleUsdDirect": "تسوية مشتريات دولار مباشرة",
  "purchase.cancelOrder": "إلغاء أمر شراء",
  "purchaseReturn.create": "مرتجع مشتريات",
  // المخزون
  "inventory.transfer": "تحويل مخزون",
  "inventory.transferBatch": "تحويل مخزون بالجملة",
  "inventory.transferReceive": "استلام تحويل مخزون",
  "inventory.transferCancel": "إلغاء تحويل مخزون",
  "inventory.adjust": "تسوية مخزون",
  "inventory.adjustRequest": "طلب تسوية مخزون",
  "inventory.adjustApprove": "اعتماد تسوية مخزون",
  "inventory.adjustReject": "رفض تسوية مخزون",
  "inventory.movement": "حركة مخزون يدوية",
  "inventory.setReorderThresholds": "ضبط حدود إعادة الطلب",
  "inventory.createReorderDraft": "إنشاء مسوّدة إعادة طلب",
  "inventory.setSeasonTarget": "ضبط هدف موسمي",
  // الكاتالوج
  "product.create": "إنشاء منتج",
  "product.update": "تعديل منتج",
  "product.delete": "حذف منتج",
  "product.assignBarcode": "ربط باركود",
  "product.reassignCategory": "نقل منتج لفئة أخرى",
  "productUnit.addBarcodeAlias": "إضافة باركود بديل",
  "productUnit.removeBarcodeAlias": "حذف باركود بديل",
  "category.create": "إنشاء فئة",
  "category.update": "تعديل فئة",
  "category.delete": "حذف فئة",
  "category.merge": "دمج فئتين",
  "catalogAnomaly.markIntentional": "تمييز شذوذ سعر كمقصود",
  "catalogAnomaly.markIgnored": "تجاهل شذوذ سعر",
  "catalogAnomaly.clearOverride": "إلغاء تصنيف شذوذ سعر",
  "catalogAnomaly.revertCostChange": "التراجع عن تغيير تكلفة",
  // العملاء
  "customer.create": "إنشاء عميل",
  "customer.update": "تعديل عميل",
  "customer.deactivate": "تعطيل عميل",
  "customer.activate": "تفعيل عميل",
  "customer.delete": "حذف عميل",
  "customer.contractPrice.remove": "حذف سعر تعاقدي لعميل",
  "customer.waConsent.set": "ضبط موافقة واتساب للعميل",
  // الموردون
  "supplier.create": "إنشاء مورّد",
  "supplier.update": "تعديل مورّد",
  "supplier.deactivate": "تعطيل مورّد",
  "supplier.activate": "تفعيل مورّد",
  "supplier.delete": "حذف مورّد",
  // الورديات
  "shift.open": "فتح وردية",
  "shift.close": "إغلاق وردية",
  "shift.cashDrop": "سحب نقدي من الوردية",
  // المصاريف
  "expense.create": "مصروف",
  "expense.cancel": "إلغاء مصروف",
  // خدمة العملاء / أوامر الشغل
  "workOrder.create": "طلب خدمة",
  "workOrder.assign": "إسناد طلب خدمة",
  "workOrder.claim": "استلام طلب خدمة",
  "workOrder.start": "بدء طلب خدمة",
  "workOrder.markReady": "تجهيز طلب خدمة",
  "workOrder.receptionCheckout": "تسليم استقبال",
  "workOrder.deliver": "تسليم طلب خدمة",
  "workOrder.cancel": "إلغاء طلب خدمة",
  // عروض الأسعار
  "quotation.create": "عرض سعر",
  "quotation.update": "تعديل عرض سعر",
  "quotation.setStatus": "تغيير حالة عرض",
  "quotation.convert": "تحويل عرض لفاتورة",
  // الاستيراد
  "import.customers": "استيراد عملاء",
  "import.suppliers": "استيراد موردين",
  "import.products": "استيراد منتجات",
  // السندات والخزينة
  "voucher.approve": "اعتماد سند",
  "voucher.reject": "رفض سند",
  "voucher.cancel": "إلغاء سند",
  "voucherCategory.create": "إنشاء تصنيف سندات",
  "voucherCategory.update": "تعديل تصنيف سندات",
  "voucherCategory.merge": "دمج تصنيفَي سندات",
  "treasury.fund": "تمويل خزينة",
  "treasury.handover.accept": "قبول تسليم عهدة خزينة",
  "cashTransfer.send": "إرسال تحويل نقدي بين الفروع",
  "cashTransfer.receive": "استلام تحويل نقدي بين الفروع",
  "cashTransfer.cancel": "إلغاء تحويل نقدي بين الفروع",
  "cardAccount.reconcile": "مطابقة حساب البطاقة/البنك",
  // الأقساط
  "installment.plan.create": "إنشاء خطة أقساط",
  "installment.line.pay": "تحصيل قسط",
  "installment.line.bounce": "ارتداد قسط",
  "installment.plan.cancel": "إلغاء خطة أقساط",
  // بضاعة الأمانة
  "consignment.settlementCreate": "إنشاء تسوية أمانة",
  // الصيرفة
  "exchange.create": "إنشاء بيت صيرفة",
  "exchange.update": "تعديل بيت صيرفة",
  "exchange.setActive": "تفعيل/تعطيل بيت صيرفة",
  "exchange.deposit": "إيداع صيرفة",
  "exchange.withdraw": "سحب صيرفة",
  "exchange.buyUsd": "شراء دولار",
  "exchange.settle": "تسوية صيرفة",
  "exchange.reverse": "عكس عملية صيرفة",
  "exchange.approveDeposit": "اعتماد إيداع صيرفة",
  // التوصيل
  "delivery.party.create": "إنشاء جهة توصيل",
  "delivery.party.update": "تعديل جهة توصيل",
  "delivery.party.setActive": "تفعيل/تعطيل جهة توصيل",
  "delivery.dispatch": "إرسال شحنة توصيل",
  "delivery.remit": "توريد مستحقات توصيل",
  "delivery.return": "إرجاع شحنة توصيل",
  "delivery.settle": "تسوية توصيل",
  "delivery.writeOff": "شطب توصيل",
  "courier.confirmDelivery": "تأكيد تسليم مندوب",
  "courier.failDelivery": "فشل تسليم مندوب",
  // الائتمان
  "creditApproval.create": "طلب تجاوز ائتمان",
  "creditApproval.cancel": "إلغاء طلب تجاوز ائتمان",
  // CRM والتسويق
  "crm.campaign.create": "إنشاء حملة تسويقية",
  "crm.campaign.transition": "تغيير حالة حملة",
  "crm.couponProgram.create": "إنشاء برنامج كوبونات",
  "crm.couponProgram.status": "تغيير حالة برنامج كوبونات",
  "crm.coupon.issue": "إصدار كوبون",
  "crm.coupon.void": "إلغاء كوبون",
  "customerNote.create": "إضافة ملاحظة عميل",
  "customerNote.update": "تعديل ملاحظة عميل",
  "customerNote.resolve": "إغلاق ملاحظة عميل",
  "customerNote.delete": "حذف ملاحظة عميل",
  "contactPerson.create": "إضافة شخص تواصل",
  "contactPerson.update": "تعديل شخص تواصل",
  "contactPerson.setInactive": "تعطيل شخص تواصل",
  // مركز واتساب
  "conversation.sendTemplate": "إرسال قالب واتساب",
  "conversation.linkCustomer": "ربط محادثة بعميل",
  "broadcast.create": "إنشاء بثّ تسويقي",
  "broadcast.launch": "إطلاق بثّ تسويقي",
  "broadcast.approve": "اعتماد بثّ تسويقي",
  "broadcast.pause": "إيقاف بثّ تسويقي مؤقّتاً",
  "broadcast.cancel": "إلغاء بثّ تسويقي",
  "broadcast.resume": "استئناف بثّ تسويقي",
  "document.sendWhatsAppPdf": "إرسال مستند PDF عبر واتساب",
  "integration.verify": "التحقّق من تكامل",
  "integration.disable": "تعطيل تكامل",
  "integration.enable": "تفعيل تكامل",
  "integration.delete": "حذف تكامل",
  "integration.syncTemplates": "مزامنة قوالب واتساب",
  "waHubSettings.update": "تعديل إعدادات مركز واتساب",
  // استوديو الصور
  "imageStudio.updateSettings": "تعديل إعدادات استوديو الصور",
  "imageStudio.verifyConnection": "التحقّق من اتصال استوديو الصور",
  "imageStudio.updateAiSettings": "تعديل إعدادات الذكاء الاصطناعي للصور",
  "imageStudio.verifyAiConnection": "التحقّق من اتصال الذكاء الاصطناعي",
  // أجهزة الكشك والحضور
  "kiosk.deviceLogin": "دخول جهاز كشك",
  "kiosk.deviceLogin.failed": "فشل دخول جهاز كشك",
  "kiosk.device.create": "إضافة جهاز كشك",
  "kiosk.device.rotate": "تدوير مفتاح جهاز كشك",
  "kiosk.device.delete": "حذف جهاز كشك",
  "hrDevice.create": "إضافة جهاز حضور",
  "hrDevice.update": "تعديل جهاز حضور",
  "hrDevice.migrate": "ترحيل جهاز حضور",
  "hrDevice.mapUser": "ربط بصمة بموظف",
  "hrDevice.command": "أمر لجهاز حضور",
  "hrDevice.approve": "اعتماد جهاز حضور",
  "hrDevice.delete": "حذف جهاز حضور",
  "hrDevice.processFolds": "معالجة بصمات الطابور",
  "attendance.updateSettings": "تعديل إعدادات الحضور",
  "attendance.record": "تسجيل حضور",
  "attendance.recomputeRates": "إعادة احتساب أسعار الحضور",
  // الموارد البشرية
  "leave.create": "طلب إجازة",
  "leave.decide": "البتّ في طلب إجازة",
  "leave.cancel": "إلغاء إجازة",
  "payroll.generate": "توليد مسيّر رواتب",
  "payroll.updateItem": "تعديل بند راتب",
  "payroll.approve": "اعتماد مسيّر رواتب",
  "payroll.pay": "دفع رواتب",
  "payroll.cancel": "إلغاء مسيّر رواتب",
  "payroll.updateLegalSettings": "تعديل الإعدادات القانونية للرواتب",
  "payroll.advanceGrant": "منح سلفة راتب",
  "payroll.advanceCancel": "إلغاء سلفة راتب",
  "employee.create": "إنشاء موظف",
  "employee.linkAccount": "ربط موظف بحساب دخول",
  "employee.unlinkAccount": "فكّ ربط موظف بحساب دخول",
  "employee.update": "تعديل موظف",
  "employee.setStatus": "تغيير حالة موظف",
  "employee.delete": "حذف موظف",
  // الأصول الثابتة
  "asset.create": "إضافة أصل ثابت",
  "asset.depreciation.post": "ترحيل استهلاك أصل",
  "asset.update": "تعديل أصل ثابت",
  "asset.handover": "تسليم عهدة أصل",
  "asset.maintenance": "صيانة أصل",
  "asset.return": "إرجاع أصل",
  "asset.dispose": "استبعاد أصل",
  "asset.document.add": "إرفاق مستند أصل",
  "asset.document.delete": "حذف مستند أصل",
  // الإنتاج (المطبعة)
  "production.create": "أمر إنتاج",
  "production.cancel": "إلغاء أمر إنتاج",
  "production.recipe.create": "إنشاء وصفة إنتاج",
  "production.recipe.update": "تعديل وصفة إنتاج",
  "production.recipe.delete": "حذف وصفة إنتاج",
  // تسعير الطباعة
  "printPricing.updateSettings": "تعديل إعدادات تسعير الطباعة",
  "printPricing.upsertFacePrice": "ضبط سعر وجه طباعة",
  "printPricing.deleteFacePrice": "حذف سعر وجه طباعة",
  "printPricing.createPaperUpcharge": "إضافة فرق سعر ورق",
  "printPricing.updatePaperUpcharge": "تعديل فرق سعر ورق",
  "printPricing.createWideMedia": "إضافة وسيط طباعة عريضة",
  "printPricing.updateWideMedia": "تعديل وسيط طباعة عريضة",
  "printPricing.createFinishing": "إضافة خدمة تشطيب",
  "printPricing.updateFinishing": "تعديل خدمة تشطيب",
  "printPos.sale": "بيع من كاشير الطباعة",
  "printPos.creditOverride": "تجاوز ائتمان من كاشير الطباعة",
  "printPos.priceOverride": "تعديل سعر يدوي من كاشير الطباعة",
  // الفترات المحاسبية
  "period.lock": "قفل فترة محاسبية",
  "period.unlock": "فتح فترة محاسبية",
  "yearEnd.close": "إقفال سنة مالية",
  // الأهداف والعمولات
  "commissions.planCreate": "إنشاء خطة عمولات",
  "commissions.planUpdate": "تعديل خطة عمولات",
  "commissions.planSetActive": "تفعيل/تعطيل خطة عمولات",
  "commissions.assign": "إسناد خطة عمولات لموظف",
  "commissions.endAssignment": "إنهاء إسناد خطة عمولات",
  "commissions.targetsSave": "حفظ أهداف شهرية",
  "commissions.targetsCopy": "نسخ أهداف من شهر سابق",
  "commissions.runCompute": "احتساب تشغيلة عمولات",
  "commissions.runApprove": "اعتماد تشغيلة عمولات",
  "commissions.runUnapprove": "التراجع عن اعتماد تشغيلة عمولات",
  "commissions.runDelete": "حذف تشغيلة عمولات",
  // الباقات والعروض الترويجية
  "bundle.setComponents": "ضبط مكوّنات باقة",
  "promotion.create": "إنشاء عرض ترويجي",
  "promotion.deactivate": "تعطيل عرض ترويجي",
  "promotion.reactivate": "إعادة تفعيل عرض ترويجي",
  "promotion.update": "تعديل عرض ترويجي",
  "priceWave.apply": "تطبيق موجة تسعير",
  // الحجوزات
  "reservation.create": "إنشاء حجز",
  "reservation.cancel": "إلغاء حجز",
  "reservation.extend": "تمديد حجز",
  "reservation.convert": "تحويل حجز لفاتورة",
  // تذكيرات الذمم
  "arReminder.sent": "إرسال تذكير ذمم مدينة",
  "arReminder.sentViaApi": "إرسال تذكير ذمم مدينة (API)",
  "arReminder.skipped": "تخطّي تذكير ذمم مدينة",
  "apReminder.sent": "إرسال تذكير ذمم دائنة",
  "apReminder.sentViaApi": "إرسال تذكير ذمم دائنة (API)",
  "apReminder.skipped": "تخطّي تذكير ذمم دائنة",
  // الجرد
  "stocktake.portalAuth": "دخول بوّابة الجرد",
  "stocktake.portalAuth.failed": "فشل دخول بوّابة الجرد",
  "stocktake.count": "تسجيل عدّ جرد",
  "stocktake.submitAssignment": "تسليم مهمّة جرد",
  "stocktake.requestRecount": "طلب إعادة عدّ",
  "stocktake.resolveConflict": "حسم تعارض جرد",
  "stocktake.decide": "قرار جرد (تسوية/إبقاء)",
  "stocktake.approveItems": "اعتماد مرحلي لمنتجات الجرد",
  "stocktake.reopenItemReview": "إلغاء اعتماد مرحلي وإعادة فتح منتج الجرد",
  "stocktake.firstSign": "توقيع أول على الجرد",
  "stocktake.approve": "اعتماد الجرد",
  "stocktake.forceReview": "إجبار مراجعة الجرد",
  "stocktake.cancel": "إلغاء جلسة جرد",
  "stocktake.regeneratePin": "تجديد رمز بوّابة الجرد",
  "stocktake.addWorker": "إضافة عامل جرد",
  "stocktake.removeWorker": "إزالة عامل جرد مع حفظ العدّات",
  // المتجر الإلكتروني
  "store.order.setStatus": "تغيير حالة طلب المتجر",
  "store.order.dispatch": "إرسال طلب المتجر لمندوب",
  "store.banner.create": "إضافة بانر متجر",
  "store.banner.update": "تعديل بانر متجر",
  "store.banner.delete": "حذف بانر متجر",
  "store.settings.update": "تعديل إعدادات المتجر",
  "store.category.create": "إنشاء فئة متجر",
  "store.category.update": "تعديل فئة متجر",
  "store.category.delete": "حذف فئة متجر",
  "store.category.visibility": "تغيير ظهور فئة متجر",
  "store.category.reorder": "إعادة ترتيب فئات المتجر",
  "store.category.assignProducts": "إسناد منتجات لفئة متجر",
  "store.catalog.featured": "تمييز منتج في المتجر",
  "store.catalog.visibility": "تغيير ظهور منتج في المتجر",
  "store.catalog.stockRequest": "طلب توفّر منتج في المتجر",
  "store.catalog.image": "تعديل صورة منتج في المتجر",
  "store.promotion.create": "إنشاء عرض متجر",
  "store.promotion.deactivate": "تعطيل عرض متجر",
  // النظام
  "system.backup": "نسخة احتياطية",
  "system.backup.delete": "حذف نسخة احتياطية",
  "system.restore.begin": "بدء استعادة نسخة احتياطية",
  "system.restore": "استعادة نسخة احتياطية",
  "system.restore.upload.begin": "بدء رفع نسخة للاستعادة",
  "system.restore.upload": "رفع نسخة للاستعادة",
  "system.reset.begin": "بدء تصفير النظام",
  "system.reset": "تصفير النظام",
  "system.taxSettings.update": "تعديل إعدادات الضريبة",
  // المهام
  "task.create": "إنشاء مهمّة",
  "task.claim": "استلام مهمّة",
  "task.setWaiting": "تعليق مهمّة (بانتظار)",
  "task.resume": "استئناف مهمّة",
  "task.resolve": "إنهاء مهمّة",
  "task.comment": "تعليق على مهمّة",
  "task.assign": "إسناد مهمّة",
  "task.reopen": "إعادة فتح مهمّة",
  "task.cancel": "إلغاء مهمّة",
  // الإشعارات
  "push.subscribed": "الاشتراك بالإشعارات",
  "push.unsubscribed": "إلغاء الاشتراك بالإشعارات",
};

const ENTITY_AR: Record<string, string> = {
  accounting: "المحاسبة", announcements: "الإعلانات", auth: "الهوية والجلسات", branch: "فرع", branches: "الفروع",
  cardAccount: "حساب البطاقة", catalog: "المنتجات", customer: "عميل", customers: "العملاء", delivery: "التوصيل",
  expense: "مصروف", expenses: "المصاريف", exchange: "الصيرفة", inventory: "المخزون", invoice: "فاتورة",
  invoices: "الفواتير", payroll: "الرواتب", product: "منتج", purchase: "مشتريات", purchases: "المشتريات",
  reports: "التقارير", return: "مرتجع", role: "دور وصلاحيات", sale: "مبيعات", shifts: "الورديات",
  stocktake: "الجرد", supplier: "مورّد", system: "النظام", task: "مهمّة", tasks: "المهام", treasury: "الخزينة",
  user: "مستخدم", users: "المستخدمون", voucher: "سند", workOrder: "طلب خدمة", workOrders: "طلبات الخدمة",
};
const RPC_VERB_AR: Record<string, string> = {
  acknowledge: "تأكيد الاطلاع", approve: "اعتماد", assign: "إسناد", cancel: "إلغاء", close: "إغلاق",
  collect: "تحصيل", complete: "إكمال", create: "إنشاء", delete: "حذف", import: "استيراد", markRead: "تحديد كمقروء",
  open: "فتح", pay: "تسديد", receive: "استلام", reject: "رفض", remove: "إزالة", restore: "استعادة",
  reverse: "عكس", save: "حفظ", send: "إرسال", setActive: "تغيير حالة التفعيل", settle: "تسوية",
  submit: "إرسال للمراجعة", sync: "مزامنة", update: "تعديل",
};
function entityLabel(type: string): string {
  return ENTITY_AR[type] ?? type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ");
}
/** ترجمة فعل — يشمل تلقائياً كل حركة جديدة يلتقطها العقد العام rpc.module.method. */
function actionLabel(a: string): string {
  if (a.startsWith("rpc.")) {
    const parts = a.slice(4).split(".").filter(Boolean);
    const moduleKey = parts[0] ?? "operation";
    const method = parts.at(-1) ?? "mutation";
    const verb = RPC_VERB_AR[method] ?? method.replace(/([a-z])([A-Z])/g, "$1 $2");
    return `${verb} — ${entityLabel(moduleKey)}`;
  }
  return ACTION_AR[a] ?? a.replace(/\./g, " › ");
}

// أعمدة تصدير Excel — مشتركة بين زرّ التصدير (تُغذّى بكل النتائج المطابقة للفلاتر).
function exportColumns() {
  return [
    { key: "createdAt", header: "التاريخ والوقت", map: (r: AuditRow) => dt(r.createdAt as unknown as string) },
    { key: "userName", header: "المستخدم", map: (r: AuditRow) => r.userName ?? (r.userId ? `#${r.userId}` : "") },
    { key: "action", header: "الفعل", map: (r: AuditRow) => actionLabel(r.action) },
    { key: "entityType", header: "الكيان", map: (r: AuditRow) => entityLabel(r.entityType) },
    { key: "entityId", header: "المعرّف", map: (r: AuditRow) => r.entityId ?? "" },
    { key: "branchName", header: "الفرع", map: (r: AuditRow) => r.branchName ?? (r.branchId ? `#${r.branchId}` : "") },
    { key: "outcome", header: "النتيجة", map: (r: AuditRow) => {
      const outcome = auditOperationMeta(r).outcome;
      return outcome === "FAILURE" ? "فشلت" : outcome === "SUCCESS" ? "نجحت" : "غير موثّقة";
    } },
    { key: "screenPath", header: "الشاشة المبلّغ عنها", map: (r: AuditRow) => r.screenPath ?? auditOperationMeta(r).screenPath ?? "" },
    { key: "oldValue", header: "القيمة القديمة", map: (r: AuditRow) => jsonStr(r.oldValue) },
    { key: "newValue", header: "القيمة الجديدة", map: (r: AuditRow) => jsonStr(r.newValue) },
    { key: "ipAddress", header: "IP", map: (r: AuditRow) => r.ipAddress ?? "" },
  ];
}

function dt(d: string | Date | null | undefined): string {
  return fmtDateTime(d);
}

function jsonStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// عرض مختصر لقيمة JSON — يستخرج أبرز ٤ مفاتيح لتبقى الخلية قصيرة.
function shortValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  try {
    const entries = Object.entries(v as Record<string, unknown>).filter(([key]) => !key.startsWith("_")).slice(0, 4);
    return entries.map(([k, val]) => `${k}: ${jsonStr(val)}`).join(" · ");
  } catch {
    return jsonStr(v);
  }
}

export default function AuditLogs() {
  const utils = trpc.useUtils();

  // فلاتر الشاشة محفوظة في الرابط (useUrlFilters) — نمط Users.tsx نفسه: تعيش مع فتح التفاصيل
  // والرجوع، وقابلة للمشاركة. كل القيم نصوص، نشتقّ الأنواع الفعلية أدناه.
  const [f, setF, resetF] = useUrlFilters({
    action: "", entityType: "", entityId: "", screenPath: "", userId: "", branchId: "", from: "", to: "", page: "0",
  });
  const userId = f.userId ? Number(f.userId) : undefined;
  const branchId = f.branchId ? Number(f.branchId) : undefined;
  const page = Number(f.page) || 0;
  const limit = 50;
  function setPage(updater: number | ((p: number) => number)) {
    const next = typeof updater === "function" ? updater(page) : updater;
    setF({ page: String(Math.max(0, next)) });
  }

  // مدخلات الفلترة المشتركة (بلا limit/offset) — للاستعلام وللتصدير الشامل، فلا يخالف المُصدَّر ما
  // على الشاشة.
  const filterInput = useMemo(
    () => ({
      action: f.action || undefined,
      entityType: f.entityType || undefined,
      entityId: f.entityId.trim() || undefined,
      screenPath: f.screenPath.trim() || undefined,
      userId,
      branchId,
      from: f.from || undefined,
      to: f.to || undefined,
    }),
    [f.action, f.entityType, f.entityId, f.screenPath, userId, branchId, f.from, f.to],
  );

  const facets = trpc.audit.facets.useQuery();
  const branches = trpc.branches.list.useQuery();
  const list = trpc.audit.list.useQuery({ ...filterInput, limit, offset: page * limit });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const activeFilterCount = [f.action, f.entityType, f.entityId, f.screenPath, f.userId, f.branchId, f.from, f.to].filter(Boolean).length;

  const columns = useMemo<ColumnDef<AuditRow, unknown>[]>(() => [
    {
      id: "change", header: "تفاصيل التغيير", accessorFn: (row) => shortValue(row.newValue ?? row.oldValue),
      cell: ({ row }) => {
        const record = row.original;
        const detail = record.oldValue && record.newValue
          ? `قديم: ${shortValue(record.oldValue)} ← جديد: ${shortValue(record.newValue)}`
          : record.newValue ? shortValue(record.newValue) : record.oldValue ? `قديم: ${shortValue(record.oldValue)}` : "لا تفاصيل إضافية";
        const fullTitle = record.oldValue || record.newValue
          ? `قديم: ${jsonStr(record.oldValue)}\nجديد: ${jsonStr(record.newValue)}` : detail;
        return <span className="block max-w-80 whitespace-normal text-xs text-muted-foreground [overflow-wrap:anywhere]" title={fullTitle}>{detail}</span>;
      },
      enableSorting: false, meta: { kind: "text", width: "wide", wrap: true },
    },
    {
      accessorKey: "branchName", header: "الفرع",
      cell: ({ row }) => row.original.branchName ?? (row.original.branchId ? `فرع #${row.original.branchId}` : "غير محدد"),
      enableSorting: false, meta: { kind: "text" },
    },
    {
      id: "outcome", header: "النتيجة", accessorFn: (row) => auditOperationMeta(row).outcome ?? "UNKNOWN",
      cell: ({ row }) => {
        const outcome = auditOperationMeta(row.original).outcome;
        return outcome === "FAILURE"
          ? <span className="font-medium text-destructive">فشلت</span>
          : outcome === "SUCCESS"
            ? <span className="font-medium text-money-positive">نجحت</span>
            : <span className="font-medium text-muted-foreground">غير موثّقة</span>;
      },
      enableSorting: false, meta: { kind: "status", align: "center" },
    },
    {
      id: "screenPath", header: "الشاشة المبلّغ عنها", accessorFn: (row) => row.screenPath ?? auditOperationMeta(row).screenPath ?? "",
      cell: ({ row }) => {
        const path = row.original.screenPath ?? auditOperationMeta(row.original).screenPath;
        return path ? <bdi dir="ltr" className="text-sm">{path}</bdi> : <span className="text-sm text-muted-foreground">غير موثّقة</span>;
      },
      enableSorting: false, meta: { kind: "code", width: "wide" },
    },
    {
      accessorKey: "ipAddress", header: "عنوان الجهاز IP", cell: ({ row }) => row.original.ipAddress ?? "غير متاح",
      enableSorting: false, meta: { kind: "code" },
    },
  ], []);

  const operation = useMemo(() => ({
    mode: "columns" as const,
    getOperation: (row: AuditRow) => {
      const meta = auditOperationMeta(row);
      const failed = meta.outcome === "FAILURE";
      return {
        actor: row.userId != null
          ? { userId: Number(row.userId), name: row.userName, source: "user" as const }
          : meta.actor?.source
            ? { name: meta.actor.label, source: meta.actor.source }
            : row.action.startsWith("system.") ? { source: "system" as const } : { name: "هوية غير مؤكدة", source: "legacy" as const },
        action: { code: row.action, label: `${failed ? "محاولة فاشلة — " : ""}${actionLabel(row.action)}` },
        subject: { type: row.entityType, label: entityLabel(row.entityType), id: row.entityId },
        at: row.createdAt,
      };
    },
    labels: { actor: "من قام", action: "ماذا فعل", subject: "على ماذا", time: "متى" },
  }), []);

  return (
    <div className="space-y-4">
      <PageHeader
        title="سجلّ التدقيق"
        description="كل عملية حسّاسة: من نفّذها، ماذا، متى، ومن أيّ جهاز (IP). للأدمن والمدقق المستقل."
      />

      <Card>
        <CardHeader>
          <ListToolbar
            title="السجلّات"
            count={total}
            loading={list.isLoading}
            filters={
              <>
                <FilterField label="الفعل">
                  <AppSelect
                    size="sm"
                    value={f.action || "ALL"}
                    onValueChange={(v) => { setF({ action: v === "ALL" ? "" : v }); setPage(0); }}
                    aria-label="الفعل"
                    className="h-8 w-auto min-w-36"
                  >
                    <option value="ALL">كل الأفعال</option>
                    {(facets.data?.actions ?? []).map((a) => (
                      <option key={a} value={a}>{actionLabel(a)}</option>
                    ))}
                  </AppSelect>
                </FilterField>
                <FilterField label="نوع الكيان">
                  <AppSelect
                    size="sm"
                    value={f.entityType || "ALL"}
                    onValueChange={(v) => { setF({ entityType: v === "ALL" ? "" : v }); setPage(0); }}
                    aria-label="نوع الكيان"
                    className="h-8 w-auto min-w-32"
                  >
                    <option value="ALL">كل الكيانات</option>
                    {(facets.data?.entityTypes ?? []).map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </AppSelect>
                </FilterField>
                <FilterField label="معرّف الهدف">
                  <Input
                    value={f.entityId}
                    onChange={(e) => { setF({ entityId: e.target.value }); setPage(0); }}
                    placeholder="رقم السجل"
                    className="h-8 w-28"
                    dir="ltr"
                    aria-label="معرّف الهدف"
                  />
                </FilterField>
                <FilterField label="الشاشة المبلّغ عنها">
                  <Input
                    value={f.screenPath}
                    onChange={(e) => { setF({ screenPath: e.target.value }); setPage(0); }}
                    placeholder="/مسار-الشاشة"
                    className="h-8 w-36"
                    dir="ltr"
                    aria-label="مسار الشاشة"
                  />
                </FilterField>
                <FilterField label="المستخدم">
                  <AppSelect
                    size="sm"
                    value={f.userId || "ALL"}
                    onValueChange={(v) => { setF({ userId: v === "ALL" ? "" : v }); setPage(0); }}
                    aria-label="المستخدم"
                    className="h-8 w-auto min-w-32"
                  >
                    <option value="ALL">كل المستخدمين</option>
                    {(facets.data?.users ?? []).map((u) => (
                      <option key={u.id} value={String(u.id)}>{u.name}</option>
                    ))}
                  </AppSelect>
                </FilterField>
                <FilterField label="الفرع">
                  <AppSelect
                    size="sm"
                    value={f.branchId || "ALL"}
                    onValueChange={(v) => { setF({ branchId: v === "ALL" ? "" : v }); setPage(0); }}
                    aria-label="الفرع"
                    className="h-8 w-auto min-w-28"
                  >
                    <option value="ALL">كل الفروع</option>
                    {(branches.data ?? []).map((b) => (
                      <option key={b.id} value={String(b.id)}>{b.name}</option>
                    ))}
                  </AppSelect>
                </FilterField>
                <FilterField label="من تاريخ">
                  <Input
                    type="date" dir="ltr" value={f.from}
                    onChange={(e) => { setF({ from: e.target.value }); setPage(0); }}
                    className="h-8 w-36" aria-label="من تاريخ"
                  />
                </FilterField>
                <FilterField label="إلى تاريخ">
                  <Input
                    type="date" dir="ltr" value={f.to}
                    onChange={(e) => { setF({ to: e.target.value }); setPage(0); }}
                    className="h-8 w-36" aria-label="إلى تاريخ"
                  />
                </FilterField>
              </>
            }
            activeFilterCount={activeFilterCount}
            onResetFilters={() => { resetF(); setPage(0); }}
            onRefresh={() => void list.refetch()}
            refreshing={list.isFetching}
            onPrint={() => window.print()}
            exportSpec={{
              filename: `سجلّ-التدقيق${f.from ? `-${f.from}` : ""}${f.to ? `-${f.to}` : ""}`,
              rows,
              formats: ["xlsx", "csv"],
              columns: exportColumns(),
              // تصدير كل السجلّات المطابقة للفلاتر (لا الصفحة المعروضة فقط) — نفس filterInput حتماً.
              fetchAll: () =>
                fetchAllPaged<AuditRow>(
                  (offset, lim) =>
                    utils.audit.list
                      .fetch({ ...filterInput, limit: lim, offset })
                      .then((r) => ({ rows: (r.rows ?? []) as AuditRow[], total: r.total })),
                  { pageSize: 200 },
                ),
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            columns={columns}
            data={rows}
            operation={operation}
            searchable={false}
            loading={list.isLoading}
            errorState={{ isError: list.isError, message: "تعذّر تحميل سجلّ التدقيق.", onRetry: () => void list.refetch() }}
            emptyText="لا سجلّات مطابقة."
            viewKey="audit-log"
            getRowId={(row) => String(row.id)}
            serverPagination={{ page, onPageChange: setPage, pageSize: limit, total }}
          />
        </CardContent>
      </Card>

    </div>
  );
}
