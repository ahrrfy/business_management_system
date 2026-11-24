# أرشيف حملة التحصين المحاسبي والتشغيلي للنظام وإزالة تطبيقات الهاتف الأصلية (مع الإبقاء على TWA) وتحديث الاعتماديات — 2026-11-24

- **المرجع التخطيطي:** [`docs/superpowers/plans/2026-11-23-erp-hardening-and-mobile-removal.md`](superpowers/plans/2026-11-23-erp-hardening-and-mobile-removal.md)
- **طلبات الدمج المدموجة على `main`:**
  - `PR #1696` (`fix/erp-hardening-and-mobile-cleanup`، رأس الفرع `d3ce6dc69`، التزام الدمج `edfd27580fa7538febf93609de8626e79cc12e9d`، دُمج `2026-11-24T13:50:00Z`)
  - `PR #1692` (`dependabot/npm_and_yarn/safe-non-major-updates-4e79457872`، رأس الفرع `16bd949b5`، التزام الدمج `c94309b6a262c51a57227918496e21d203685c48`، دُمج `2026-11-24T15:29:46Z`)
- **طلب السحب المُغلق دون دمج (ملغى لانتفاء المجلد):** `PR #1693` (`dependabot/npm_and_yarn/expo/customer-store-mobile/safe-patch-updates-63d11f5cae` — أُغلق وحُذف فرعه بعد إزالة `expo/` بالكامل).
- **الالتزام المنشور والمفعّل حالياً في الإنتاج (`alroya-prod`):** `c94309b6a262c51a57227918496e21d203685c48` (بعد نشر `edfd27580` أولاً ثم `c94309b6a` عبر `pnpm prod:deploy`).

---

## ١. المعالجات المحاسبية والمالية والتشغيلية (`PR #1696`)

1. **حوكمة عجز الوردية وفصل المهام ([`server/routers/shiftRouter.ts`](../server/routers/shiftRouter.ts)، [`server/services/shiftService.ts`](../server/services/shiftService.ts)):**
   - منع الموافقة الذاتية للمدير على عجز ورديته الشخصية مع احترام `input.managerApprovedByUserId ?? ...` عند وجود مُعتمِد مستقل.
   - إنشاء صف في `employeeAdvances` بنوع `OTHER_DEDUCTION` ذرّياً عند اعتماد تحميل عجز الوردية على الموظف، وتغطيته باختبار [`server/services/__tests__/shiftCashGovernance.test.ts`](../server/services/__tests__/shiftCashGovernance.test.ts).
2. **معالجة عهد الموظفين والقيود العكسية عند التنازل ([`server/services/accounting/postingEngine.ts`](../server/services/accounting/postingEngine.ts)، [`server/services/employeeCustodyService.ts`](../server/services/employeeCustodyService.ts)، [`server/services/advances/advancesService.ts`](../server/services/advances/advancesService.ts)):**
   - إضافة قالب الترحيل `ADJUST_CUSTODY_RECOVERY` لقيد `Dr EMPLOYEE_ADVANCES / Cr OTHER_REVENUE` عند تحميل عهدة مفقودة/تالفة على الموظف (`CUSTODY_LOSS:<id>`) دون المساس بحساب `INVENTORY`.
   - إضافة القالب العكسي `ADJUST_CUSTODY_RECOVERY_REVERSAL` (`CUSTODY_LOSS_WAIVER:<advanceId>`) في `cancelAdvance` مع الإبقاء على مرجع `(#<id>)` عند التنازل عن خصم عهدة غير مستعمل لمنع بقاء رصيد معلق، وتوثيق ذلك في [`server/services/accounting/custodyRecoveryPosting.test.ts`](../server/services/accounting/custodyRecoveryPosting.test.ts) و[`server/services/__tests__/advancesService.test.ts`](../server/services/__tests__/advancesService.test.ts).
   - **ملاحظة تشغيلية:** أدّت إضافة قوالب القيد الجديدة إلى تحديث `POSTING_POLICY_HASH`؛ يلزم إعادة اعتماد البصمة في شاشة المطابقة (`/reconcile`) عند تشغيل وضع `SHADOW` أو `ACTIVE`.
3. **مطابقة سلف الموظفين (`reconcileEmployeeAdvances`) ([`server/services/reconcileService.ts`](../server/services/reconcileService.ts)، [`server/services/reports/reconcileSummary.ts`](../server/services/reports/reconcileSummary.ts)، [`client/src/pages/Reconcile.tsx`](../client/src/pages/Reconcile.tsx)، [`client/src/components/reconcile/exportReconcileReport.ts`](../client/src/components/reconcile/exportReconcileReport.ts)):**
   - ربط مطابقة `EMPLOYEE_ADVANCES` التشغيلي مع الدفتري ضمن `shadowCycleId` الفعّال، وإزالة الاختصار عند `count === 0` لكشف الانحرافات حتى مع القيود ذات السطر الصفري، وتغطيتها في [`server/services/__tests__/reconcileEmployeeAdvances.unit.test.ts`](../server/services/__tests__/reconcileEmployeeAdvances.unit.test.ts) و[`server/services/__tests__/reconcileSummary.test.ts`](../server/services/__tests__/reconcileSummary.test.ts).
4. **صون مسار الشحن المؤجّل `ACCRUAL` في استلام المشتريات ([`server/services/purchase/receive.ts`](../server/services/purchase/receive.ts)):**
   - الإبقاء على `createSystemPaymentRequestTx` بحالة `PENDING_APPROVAL` و`cashBucket: null` ليبقى الشحن الآجل قابلاً للسداد من الخزينة أو السندات دون تعطيل إغلاق الوردية.
5. **أقفال المودِعين في الجرد، ترقيم الفواتير، وفصل الطبقات:**
   - توحيد ترتيب أقفال المودِعين (`FOR UPDATE`) تصاعدياً في [`server/services/stocktake/finalize.ts`](../server/services/stocktake/finalize.ts) وإظهار تنبيه التسوية السالبة في [`client/src/lib/printing/stocktakeTemplates.ts`](../client/src/lib/printing/stocktakeTemplates.ts) ([`wave31StocktakePrint.test.ts`](../client/src/lib/printing/__tests__/wave31StocktakePrint.test.ts)).
   - استخراج منطق مطابقة الأوفلاين من [`server/routers/offlineRouter.ts`](../server/routers/offlineRouter.ts) إلى [`server/services/offline/preflightReconciliation.ts`](../server/services/offline/preflightReconciliation.ts)، وتوحيد ترقيم الفواتير في [`server/services/sale/invoiceNumbering.ts`](../server/services/sale/invoiceNumbering.ts) و[`server/services/sale/create.ts`](../server/services/sale/create.ts).
   - تشديد خطوط الأساس في [`scripts/layer-imports-baseline.json`](../scripts/layer-imports-baseline.json)، [`scripts/error-messages-baseline.json`](../scripts/error-messages-baseline.json)، [`scripts/friction-baseline.json`](../scripts/friction-baseline.json)، و[`scripts/orphan-endpoints-baseline.json`](../scripts/orphan-endpoints-baseline.json).
6. **تثبيت عقد أجور التوصيل (`SHOP`) والمطبوعات الحية:**
   - الإبقاء على الاقتطاع التلقائي لأجرة `SHOP` محصوراً بطلبات `ONLINE_ORDER` في خدمات التوصيل وفق عقد النظام القائم، وحذف ملف `a4Invoice.ts` الميت، وتحسين وضوح مطبوعات بوليصة التوصيل والسندات وأوامر الشغل ([`printDeliveryDispatchSlip.ts`](../client/src/lib/printing/printDeliveryDispatchSlip.ts)، [`voucherPrint.ts`](../client/src/lib/printing/voucherPrint.ts)، [`workOrderRaster.ts`](../client/src/lib/printing/workOrderRaster.ts)).

---

## ٢. إزالة تطبيقات الهاتف الأصلية مع الإبقاء على الويب و`TWA` (`PR #1696`)

- **إزالة الشيفرة وسلاسل الإصدار الأصلية:** حذف مجلدَي `expo/` و`android-native/`، ومسارات CI الخاصة بهما (`android-release.yml`، `expo-mobile-check.yml`)، وإعداد Dependabot الفرعي، والسكربتات الخاصة بإصدار الجوال (`verify-android-release-workflow-gate.mjs`، `verify-mobile-release-env.mjs`).
- **تفكيك راوترات وعمّال الجوال وتقاعد صلاحياتها:** حذف `superAppRouter.ts` و`nativePushRouter.ts` وخدمات الإشعارات/الجوال المرتبطة بها (`superAppPushService.ts`، `nativePushService.ts`، `mobileTodayService.ts`، إلخ)، وتقاعد مفاتيح الصلاحيات المعنية في [`shared/operationPermissionRetirements.json`](../shared/operationPermissionRetirements.json) مع تحديث جرد الصلاحيات ([`docs/authz/endpoint-inventory.json`](authz/endpoint-inventory.json)).
- **استقلالية إشعارات الويب وبقاء `TWA`:** فصل إشعارات الويب عبر [`server/routers/notificationsRouter.ts`](../server/routers/notificationsRouter.ts) وربط [`client/src/components/NotificationBell.tsx`](../client/src/components/NotificationBell.tsx)، مع الحفاظ الكامل على مجلد `twa/` ومسار التحقق `/.well-known/assetlinks.json` في [`server/wellKnown.ts`](../server/wellKnown.ts).

---

## ٣. تحديث الاعتماديات (`PR #1692`) والنشر الإنتاجي والتحقق

- **إصلاح ودمج `PR #1692`:** تحديث 12 حزمة غير رئيسية في [`package.json`](../package.json) و[`pnpm-lock.yaml`](../pnpm-lock.yaml)، وتحديث حارس [`scripts/__tests__/dependencySecurityWorkflow.test.ts`](../scripts/__tests__/dependencySecurityWorkflow.test.ts) لقبول الإصدارات المرقَّعة `minimatch >= 11.0.1` و`glob >= 14.0.2` بعد ترقية `typescript-eslint`، ثم اجتياز كافة فحوصات الـ PR والدمج على `c94309b6a` واجتياز فحوصات `main`.
- **النشر والتحقق على `alroya-prod`:**
  - نُفِّذ `pnpm prod:deploy` للالتزام `edfd27580` ثم للالتزام `c94309b6a`.
  - خادم الإنتاج مستقر حالياً على `c94309b6a`؛ عمليات PM2 (`erp-server` ×3، و`erp-hr-bridge`، و`pm2-logrotate`) جميعها `online`، ومتجر الويب (`alarabiya.online` و`srv1548487.hstgr.cloud`) جاهز، ومسار `https://alarabiya.online/.well-known/assetlinks.json` يستجيب بـ `HTTP 200`.
