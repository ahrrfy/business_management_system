# AlRoya BMS — الخطة الجراحية المنقّحة (v2) بعد المراجعة العدائية متعددة العدسات

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** تنفيذ المعالجات المالية والمحاسبية والتشغيلية المؤكدة بالكود (بعد إسقاط الفرضيات الخاطئة)، وإضافة مطابقة `EMPLOYEE_ADVANCES`، وتحصين الجرد والتسوية، وترشيق المطبوعات الحية، ثم الإزالة الآمنة لتطبيقات الهاتف (`expo/`, `android-native/`) مع **الإبقاء الكامل على `twa/` وميزات الويب المشتركة** وضمان بقاء CI والحرّاس أخضر 100%.

**Architecture:** 4 مراحل متسلسلة ببروتوكول أمان صارم (كل مهمة تبدأ باختبار فاشل أو فحص خط أساس وتنتهي بـ `pnpm check` + `pnpm check:guards` + اختبارات `TZ=UTC` المستهدفة):
1. إصلاحات `Blocker` المالية والمحاسبية (التوصيل `SHOP` + عجز الوردية وفصل المهام + تعويض العهدة ومطابقة السلف + الدفتر المزدوج).
2. إصلاحات `Major` التشغيلية (خيار `ACCRUAL` لشحن المشتريات + قفل المودِعين في الجرد + `periodLockService`/`tx.ts` + توحيد المسارات الموازية).
3. ترشيق المطبوعات **الحية** (حذف `a4Invoice.ts` الميت، تدقيق `printTemplates.ts`/`printTemplatesV2.ts`، بوليصة التوصيل، السند الحراري، أمر العمل، محضر الجرد).
4. الإزالة الآمنة لـ `expo/` و`android-native/` عبر فصل إشعارات الويب (`NotificationBell`/`MyWork`) وحماية `superAppAuthority`/`superAppProcedure` وتنظيف CI و`wellKnown.ts` (مع إبقاء `twa/`).

**Tech Stack:** TypeScript, tRPC v11, Drizzle ORM (MySQL 8), decimal.js, React 19 + Vite, Vitest.

## Global Constraints (من `CLAUDE.md`)
- الخدمة لا تقرأ `ctx` — تستقبل `Actor { userId, branchId, role }` و`Tx`.
- كل الحسابات المالية بـ `decimal.js`، والأرقام في الواجهة/المطبوعات بـ `"ar-IQ-u-nu-latn"`.
- كل رسالة خطأ جديدة تمر عبر `appErrorMessage` من `@shared/errors`.
- لا تعديل على `drizzle/schema.ts` بـ `DROP TABLE` تدميري خلال إزالة الهاتف (لحماية الهجرات القائمة).
- بوابة الإنجاز لكل شريحة: `pnpm check` + `pnpm check:guards` + `pnpm check:test-types` + اختبارات الشريحة (`TZ=UTC`).

---

## المرحلة 1: الإصلاحات المالية والمحاسبية الحرجة (`Blocker`)

### Task 1.1: تصحيح قيد تعويض العهدة التالفة/المفقودة + إضافة مطابقة `EMPLOYEE_ADVANCES`
> **الجذر المؤكد:** `employeeCustodyService.ts:164-198` يرحّل `Dr LOSSES / Cr INVENTORY` ثم يُدرج `employeeAdvances (OTHER_DEDUCTION)`، وعند الراتب يرحّل `payroll/accounting.ts:91` قيد `Cr EMPLOYEE_ADVANCES` ⇒ يختل حساب `EMPLOYEE_ADVANCES` بالسالب وتُخفض الأصول غير المخزنية من `INVENTORY`؛ ولا توجد مطابقة في `reconcileService.ts` لكشفه.

**Files:**
- Modify: `server/services/employeeCustodyService.ts:151-200`
- Modify: `server/services/reconcileService.ts` (إضافة `reconcileEmployeeAdvances()`)
- Reference (النمط الصحيح): `server/services/cashVarianceService.ts:1150-1199`
- Test: `server/services/__tests__/employeeCustodyAccounting.test.ts`

- [ ] **Step 1:** كتابة اختبار فاشل يثبت أن تعويض عهدة `DAMAGED`/`LOST` محمَّل على الموظف يُقيد `Dr EMPLOYEE_ADVANCES` (لا `LOSSES`) ولا يمس `INVENTORY` لعهد الأصول والأدوات (`TOOL`, `DEVICE`, `VEHICLE`, `KEY`)، بحيث يعود `EMPLOYEE_ADVANCES` صفراً بعد استقطاع الراتب.
- [ ] **Step 2:** تشغيل الاختبار والتأكد من فشله.
- [ ] **Step 3:** تصحيح `employeeCustodyService.ts:164-198` لترحيل `Dr EMPLOYEE_ADVANCES` مقابل حساب التسوية المناسب (وفصل حالة تحمل الشركة `LOSSES` بلا `employeeAdvances`)، وإضافة `reconcileEmployeeAdvances()` في `reconcileService.ts` لمطابقة `SUM(employeeAdvances.remaining)` مع رصيد الحساب الدفتري `EMPLOYEE_ADVANCES`.
- [ ] **Step 4:** تشغيل الاختبار + `pnpm check`.

### Task 1.2: إغلاق فجوة عجز الوردية + سد ثغرة الموافقة الذاتية للمدير (`shiftRouter.ts` + `shiftService.ts`)
> **الجذر المؤكد:** (1) `shiftRouter.ts:394-396, 424` يسمح للمدير/الأدمن باعتماد عجز ورديته الشخصية (`verifiedManagerId = ctx.user.id`, `enforceCashGovernance = false`) في خرق لفصل المهام و`CONTEXT.md`. (2) `shiftService.ts:519-567` يرحّل `Dr EMPLOYEE_ADVANCES / Cr CASH` بلا صف في `employeeAdvances` ولا تحقق من وجود سجل موظف لـ `sh.userId`.

**Files:**
- Modify: `server/routers/shiftRouter.ts:393-425`
- Modify: `server/services/shiftService.ts:467-568`
- Test: `server/services/__tests__/shiftCloseVarianceGovernance.test.ts`

- [ ] **Step 1:** كتابة اختبارات فاشلة تغطي: (أ) رفض اعتماد المدير عجز ورديته الشخصية، (ب) إنشاء صف `employeeAdvances` مرتبط بموظف الوردية `sh.userId` (ورفض التحميل على `EMPLOYEE_ADVANCES` إذا كان صاحب الوردية بلا سجل موظف نشط، أو توجيهه حصراً إلى قضية `cashVarianceService`).
- [ ] **Step 2:** تطبيق المعالجة الجراحية في `shiftRouter.ts` (منع `verifiedManagerId === shift.userId` لغير حالة الطوارئ/المالك أو إلزام قضية `cashVarianceService` وفق `CONTEXT.md`) وفي `shiftService.ts:519-567` (إدراج `employeeAdvances` ذرياً مع `receiptId: outReceiptId` أسوةً بـ `cashVarianceService.ts:1184-1198`).
- [ ] **Step 3:** تشغيل اختبارات `shift` و`cashVariance` (`TZ=UTC`) + `pnpm check`.

### Task 1.3: تعميم اقتطاع أجرة «التوصيل على المكتبة» (`SHOP`) لـ `INVOICE` و`WORK_ORDER` بحذر الشحنات المجمعة
> **الجذر المؤكد:** `dispatchInvoice.ts:717-722` يُنشئ إرساليات بـ `ONLINE_ORDER` و`WORK_ORDER` و`INVOICE`، لكن `remittance.ts:801-807, 871-872` و`detachedShipmentFees.ts:50,119,127,167` و`dailySettlement.ts:224` و`queries.ts:359` تقصر الاقتطاع التلقائي على `ONLINE_ORDER` فقط.

**Files:**
- Modify: `server/services/delivery/remittance.ts:801-807, 870-874`
- Modify: `server/services/delivery/detachedShipmentFees.ts:50, 119, 127, 167`
- Modify: `server/services/delivery/dailySettlement.ts:224`
- Modify: `server/services/delivery/queries.ts:359`
- Inspect: `server/services/delivery/fees.ts:412` (حارس `hasOrderBasedCommission` للشحنات متعددة الفواتير)
- Test: `server/services/__tests__/deliveryRemittanceShopFee.test.ts`

- [ ] **Step 1:** كتابة اختبارات فاشلة تغطي: (أ) إرسالية `INVOICE` و`WORK_ORDER` بحالة `SHOP` و`DELIVERED` مع `codAmount > 0` تُخصم أجرتها (`FEE_OFFSET`) عند التوريد، (ب) احترام `useCommissionForSettlement`، (ج) إبقاء `AFTERCARE_EXECUTION` و`FULFILLMENT_REQUEST` محظورَين من الاقتطاع.
- [ ] **Step 2:** استبدال فحص `sourceType === "ONLINE_ORDER"` بدالة مساعدة واحدة `isWithholdableShopFeeSource(sourceType)` تشمل `ONLINE_ORDER | INVOICE | WORK_ORDER` وتستثني `AFTERCARE_EXECUTION` و`FULFILLMENT_REQUEST`.
- [ ] **Step 3:** تشغيل جميع اختبارات `delivery` (`TZ=UTC`) + `pnpm check`.

### Task 1.4: إغلاق فجوات الدفتر المزدوج (`SHADOW` / `ACTIVE`)
**Files:**
- Inspect & Modify: `server/services/accounting/shadowHook.ts:29-44`
- Audit: جرد مستدعي `postEntry` بلا `postingIntent`.

- [ ] **Step 1:** تعيين أدوار حسابية صريحة لـ `WALLET` و`EXCHANGE` و`TELECOM` في `cashRoleFor` وفق شجرة الحسابات.
- [ ] **Step 2:** جرد وسد أي استدعاء `postEntry` يفتقد `postingIntent`، ثم تشغيل اختبارات الدفتر المزدوج.

---

## المرحلة 2: الإصلاحات التشغيلية والحوكمة والجرد (`Major`)

### Task 2.1: إصلاح خيار `shippingFundingSource === "ACCRUAL"` في استلام المشتريات
> **التصحيح بعد المراجعة العدائية:** مسار `DRAWER` سليم لأنه يستدعي `settlePurchaseShippingFromShiftTx` فوراً (`purchase/receive.ts:1100-1108`). **الخلل الحقيقي** هو أن اختيار `ACCRUAL` يُجبر في `1045-1099` على إنشاء سند صرف `TREASURY` (`PAYMENT_PENDING`) بدلاً من إبقائه `ACCRUED_UNPAID`.

**Files:**
- Modify: `server/services/purchase/receive.ts:1045-1116`

- [ ] **Step 1:** كتابة اختبار فاشل يثبت أن اختيار `shippingFundingSource: "ACCRUAL"` يُثبت الالتزام بحالة `ACCRUED_UNPAID` ولا ينشئ سند دفع معلقاً (`shippingPaymentRequestReceiptId === null`).
- [ ] **Step 2:** إحاطة `createSystemPaymentRequestTx` و`transitionAccrualObligationTx(..., "PAYMENT_PENDING")` بشرط `if (fundingMode !== "ACCRUAL")`.
- [ ] **Step 3:** تشغيل اختبارات `purchase` (`TZ=UTC`) + `pnpm check`.

### Task 2.2: تحصين الجرد والتسوية (`stocktake/finalize.ts` + `countPortalService.ts`)
> **المؤكد بالكود:** حساب `netAfter` في `reviewCore.ts:475-499` دقيق رياضياً مع استمرار البيع والشراء، لكن `stocktake/finalize.ts:540-575` يعدّل أرصدة المودِعين دون قفل `suppliers` بـ `.for("update")` تصاعدياً (بعكس `transferService.ts:772-777`).

**Files:**
- Modify: `server/services/stocktake/finalize.ts:537-575`
- Inspect: `server/services/countPortalService.ts`, `server/routers/missedDailyCountExceptionRouter.ts`

- [ ] **Step 1:** إضافة قفل `suppliers` بـ `.for("update")` مرتّباً تصاعدياً بـ `asc(suppliers.id)` قبل حلقة `adjustSupplierBalance` في `stocktake/finalize.ts:540`.
- [ ] **Step 2:** التحقق في `countPortalService.ts` و`missedDailyCountExceptionRouter.ts` من عدم وجود ثغرات تجاوز لقفل اليوم/الشهر.
- [ ] **Step 3:** تشغيل اختبارات `stocktake` (`TZ=UTC`) + `pnpm check`.

### Task 2.3: إصلاح `periodLockService.ts` وتسجيل أخطاء `tx.ts`
**Files:**
- Modify: `server/services/periodLockService.ts:212, 219, 238, 256` (تصحيح الترميز المشوّه عبر `appErrorMessage`).
- Modify: `server/services/tx.ts:94-98` (تسجيل أخطاء `drainPostCommitHooks` عبر `logger.error`).

### Task 2.4: توحيد المسارات الموازية (`printSaleService.ts` + `offlineRouter.ts`)
**Files:**
- Refactor: `server/routers/offlineRouter.ts` (1,925 سطر) ← نقل منطق الأعمال والمعاملات إلى `server/services/offline/` التزاماً بقاعدة الطبقات (`CLAUDE.md §٢`).
- Refactor: `server/services/printSaleService.ts` ← تقليص الازدواجية مع `sale/create.ts` في ترحيل الفاتورة.

---

## المرحلة 3: ترشيق المطبوعات **الحية** وحذف القوالب الميتة (`Printables`)

### Task 3.1: حذف `a4Invoice.ts` الميت وتدقيق القالب الحي `printTemplates.ts` / `printTemplatesV2.ts`
> **التصحيح بعد المراجعة العدائية:** `a4Invoice.ts` لا تستدعيه أي شاشة في الإنتاج (`printTemplates.test.ts` فقط)؛ القالب الحي هو `printInvoiceA4` في `printTemplates.ts` عبر `invoiceDetailPrintData.ts`.

- [ ] مراجعة `printInvoiceA4` في `printTemplates.ts` / `printTemplatesV2.ts` للوضوح وإزالة الشروحات الزائدة، ثم حذف `client/src/lib/printing/a4Invoice.ts` (وتحديث `printTemplates.test.ts`) ضمن ترشيق الكود.

### Task 3.2: توضيح بوليصة التوصيل (`client/src/lib/printing/printDeliveryDispatchSlip.ts`)
- [ ] عند `feeCollection === "SHOP"`: فصل سطر العميل (`أجرة التوصيل على العميل: مجاناً (على المكتبة) — 0 د.ع`) عن مستحق المندوب، وتحديث اختباراته (`printDeliverySource.test.ts` / `workflowDocuments.test.ts`).

### Task 3.3: إزالة الحشو والتكرار في المطبوعات اليومية
- [ ] `voucherPrint.ts:121-123`: حذف `partyBalance` المكرر في الحراري `80mm` وإبقاء `قبل/بعد` فقط، ونقل `الطابع/وقت الطلب` لنسخة `A4`.
- [ ] `workOrderRaster.ts:125-131`: اختصار رأس التذكرة الحرارية.
- [ ] `printTerminationSettlement.ts:82`: اختصار فقرة الإفصاح الطويلة إلى سطر موجز.
- [ ] `stocktakeTemplates.ts`: إبراز `negativeSettlements` وعجز الأمانة بوضوح في محضر الجرد `A4` دون حشو.

---

## المرحلة 4: الإزالة الآمنة لـ `Expo` و`Android Native` و`iOS` (مع الإبقاء على `TWA` والويب)

> **البروتوكول الآمن المعدَّل بعد كشف الارتباطات الحرجة بالويب والـ CI:**

### Task 4.1: حماية ونقل ميزات الويب المشتركة **قبل أي حذف**
**Keep intact:**
- `twa/` (تطبيق الويب `TWA` بالكامل)
- `server/services/superAppAuthority.ts` و`superAppProcedure` في `server/trpc.ts` (تستخدمها شاشات الويب `executiveRouter.ts:10` و`decisionsRouter.ts:20,35,50` — تُترك عاملة أو يُعاد تسميتها لاحقاً في PR منفصل لتجنب كسر `check:authz`).

**Migrate web notifications:**
- [ ] نقل إجراءات الويب الثلاثة (`notifications`, `markNotificationRead`, `markAllNotificationsRead`) من `superAppRouter.ts` إلى راوتر ويب مخصص (`notificationsRouter.ts`) وتحديث المستدعيين الوحيدين في الويب:
  - `client/src/components/NotificationBell.tsx:70,78,101,102`
  - `client/src/pages/MyWork.tsx:223,261,268`
- [ ] إزالة استيرادات ونداءات `nativePushService` و`superAppPushService` من:
  - `server/routers/authRouter.ts:59-60`
  - `server/services/approvalEventNotifier.ts`, `sessionEventNotifier.ts`, `appNotificationService.ts`, `productStudioService.ts`, `employeeService.ts`, `userService.ts`, `passwordResetService.ts` (مع إبقاء إشعارات الويب `webPush` و`appNotification` سليمة 100%).
- [ ] **Gate:** تشغيل `pnpm check`.

### Task 4.2: تنظيف `wellKnown.ts` وفصل الراوترات والعمال المخصصة للهاتف
- [ ] تعديل `server/wellKnown.ts:3-88`: حذف قسم `STOREFRONT_ANDROID_PACKAGE` و`STOREFRONT_EAS_DEVELOPMENT_SHA256` (الخاص بـ Expo)، و**الإبقاء الكامل على قسم `TWA` (`TWA_ANDROID_PACKAGE` و`TWA_SHA256_CERT_FINGERPRINTS`)**.
- [ ] تعديل `server/routers.ts`: استبدال `superApp` بـ `notifications` (إن نُقلت) وحذف `nativePushRouter`.
- [ ] تعديل `server/index.ts:949-957`: حذف تشغيل وإيقاف `nativePushOutboxWorker` و`superAppPushWorker`.
- [ ] إزالة `expoSuperAppProcedure` و`nativeBootstrapProcedure` من `server/trpc.ts` (بعد التأكد عبر `rg` من عدم بقاء أي مستخدم لهما).

### Task 4.3: حذف مجلدات الهاتف وملفات الخادم والـ CI الخاصة بها
- [ ] **Delete directories:** `expo/`, `android-native/` *(الإبقاء على `twa/`)*
- [ ] **Delete mobile-only backend/tests:** `superAppRouter.ts`, `nativePushRouter.ts`, `superAppPushService.ts`, `superAppPushWorker.ts`, `nativePushService.ts`, `nativePushOutboxWorker.ts`, `mobileTodayService.ts`, `mobileProductionReadiness.ts` واختباراتها الحصرية.
- [ ] **Clean CI & Guard Scripts (إلزامي لمنع كسر CI):**
  - حذف `.github/workflows/expo-mobile-check.yml` و`.github/workflows/android-release.yml`
  - إزالة خطوة `pnpm check:mobile-release` من `.github/workflows/ci.yml:303`
  - إزالة سطرَي `--lockfile=expo/...` من `.github/workflows/security.yml:50-51`
  - إزالة إدخالَي `/expo/*` من `.github/dependabot.yml:23, 41`
  - إزالة مراجع `expo/*` من `scripts/check-zod-security-boundary.mjs:8-9, 47, 66-67`
  - إزالة سكربتات `check:mobile-release` و`mobile:*` من `package.json:36-40`
  - إزالة ملفات الاختبار المحذوفة من `vitest.unit.config.ts` وتحديث خط أساس `check:authz` و`check:orphans` رسمياً.
  - التحقق من حذف `scripts/verify-android-release-workflow-gate.mjs` و`scripts/verify-mobile-release-env.mjs` بعد خلو المراجع.

### Task 4.4: بوابة التحقق النهائية الإلزامية (Zero-Hallucination Gate)
- [ ] `pnpm check` (0 أخطاء أنواع)
- [ ] `pnpm check:guards` (نجاح جميع الحرّاس بما فيها `check:zod-security-boundary` و`check:authz` و`check:orphans`)
- [ ] `pnpm check:test-types`
- [ ] `pnpm test:unit` (`TZ=UTC`)
- [ ] `pnpm build` (نجاح بناء الإنتاج للويب والخادم)
