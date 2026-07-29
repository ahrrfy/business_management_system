# 1 · جرد نقاط الدخول (Endpoint Inventory)

> §30.1 — «جرد نقاط الدخول مع الصلاحية والنطاق والحساسية».
> **البيانات الكاملة:** [`endpoint-inventory.csv`](endpoint-inventory.csv) · [`endpoint-inventory.json`](endpoint-inventory.json)
> **مولَّدة بـ:** `node scripts/authz-inventory.mjs` (قراءة فقط)

## 1.1 الحصيلة

| السطح | العدد | ملاحظة |
|---|---|---|
| tRPC | **671** (337 mutation، 334 query) | 64 راوتراً في 72 ملفاً |
| Express | 15 مساراً | تحت 10 نقاط تركيب `/api/*` |
| Webhooks | 5 | whatsapp × 2، instagram × 2، store × 1 |
| مهام مجدولة/دورية | 5 | 2 cron + 3 setInterval |
| **الإجمالي المحصور** | **691** | + المسارات الثابتة و`/healthz` و`.well-known` |

## 1.2 مصادر السلطة الفعلية — التوزيع

| مصدر السلطة | النقاط | آلية الحسم |
|---|---|---|
| `module-gate` (`requireModuleGate`) | 266 | قائمة أدوار + خريطة الوحدة + منح صريح |
| `module-map` (`requireModule` العاري) | 217 | خريطة الوحدة فقط (لا قائمة أدوار) |
| `admin` (`adminProcedure`) | **72** | `ctx.user.role === "admin"` — سلطة مطلقة |
| `raw-role` (`requireRole` وما يعادله) | **58** | **اسم الدور** — ممنوع في §29.4 |
| بلا بوّابة (`public`/`protected`/`branchScoped`) | 53 | مصادقة فقط أو لا شيء |
| `platform` | 5 | مدير المنصّة (حدّ ثقة منفصل) |

**قراءة الرقم:** 130 نقطة (72 + 58) تُحسم اليوم بـ**اسم الدور** حصراً — هذا هو الرقم الذي تستهدفه
بوابة القبول §25.4 («صفر قرار أعمال يعتمد اسم الدور»).

## 1.3 الأعلام الحرجة

| العلَم | العدد | المعنى ومسار المعالجة |
|---|---|---|
| `LOCAL_GATE` | **119** (18%) | بوّابة مُعرَّفة **داخل ملف الراوتر** بإضافة middleware فعليّ (`.use(...)`) لا في `server/trpc.ts` ⇒ سلطة لامركزية. **لا تشمل** الأسماء المستعارة المجرَّدة (`const x = centralProcedure;`) — تلك ترث بوّابتها المركزية ولا تُعدّ لامركزية. |
| `NO_BRANCH_SCOPE` | **115** | نقاط ببوّابة وحدة (`module-map`) بلا أي بُعد فرع. الرقم الأشمل: **292 نقطة (44%)** بلا بُعد فرع في بوّابتها إطلاقاً — انظر 1.3.1. |
| `SENSITIVE_ACTION` | 76 | فعل مالي/خارجي حسّاس (إلغاء/اعتماد/عكس/حذف/تصدير/إرسال). |
| `ADMIN_ONLY` | 72 | سلطة مطلقة بلا حبيبة. |
| `RAW_ROLE_GATE` | 66 | حكمٌ باسم الدور: **58** بوّابةً سلطتها الأساسية اسم الدور + **8** بوّابات **مركّبة** (أساسٌ مُقيَّد بالدور `cashierProcedure` + `requireModule`) يبقى فيها قيد الدور فاعلاً فوق قيد الوحدة. |
| `UNAUTHENTICATED` | 32 | `publicProcedure` (منها 15 mutation). |
| `READ_WITHOUT_MODULE_GATE` | 30 | قراءة بلا استشارة خريطة الصلاحيات. |
| `WRITE_WITHOUT_MODULE_GATE` | 23 | كتابة بلا بوّابة وحدة. |

> **تصحيح دقّة (مراجعة Codex على PR #405):** عدّ الإصدار الأول `LOCAL_GATE` = 163 لأنه احتسب الأسماء
> المستعارة المجرَّدة بوّاباتٍ لامركزية (أبرزها 44 نقطة في `reportsRouter` عبر `reportsProcedure =
> reportViewerProcedure` — بوّابةٌ **مركزية** لا لامركزية). العدد الصحيح **119**. وبالمقابل صحّح الجرد
> عدّ `RAW_ROLE_GATE` إلى 66 بعد أن كان يبتلع قيد الدور في البوّابات المركّبة (`channelsWrite`).

### البوّابات اللامركزية (119 نقطة عبر 14 راوتراً)

النمط السائد — إضافة `requireModule` فوق أساسٍ لا يحمل بوّابة وحدة:

```ts
// server/routers/attendanceRouter.ts:12
const hrRead  = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));
```

| الراوتر | الوحدة | النقاط |
|---|---|---|
| `attendanceRouter`, `employeeRouter`, `payrollRouter`, `leaveRouter`, `recruitmentRouter`, `hrDeviceRouter` | `hr` | 68 |
| `assetsRouter` | `assets` | 15 |
| `conversationRouter`, `promotionRouter` | `channels` | 10 |
| `giftsRouter` | `gifts` | 9 |
| `treasuryRouter` | `treasury` | 8 |
| `reservationsRouter` | `reservations` | 5 |
| `auditRouter` | — (فحص دور محليّ) | 2 |
| `kioskRouter`, غيرها | — | 2 |

**لماذا يهم:** وحدة `hr` — أحسّ الوحدات (رواتب، بيانات شخصية) — **لا تملك ولا بوّابة واحدة في
السجلّ المركزي**. 68 نقطة تحكمها ثوابت محلّية. أي مراجعة تقرأ `server/trpc.ts` وحده تخرج بصورة
ناقصة بنحو **السُّبع** (119 نقطة). هذا يفسّر لماذا تشترط §24.1 حصر AST وحارس CI.

**ملاحظة:** `reportsRouter` **ليس** لامركزياً — بوّاباته أسماء مستعارة لـ`reportViewerProcedure`
المركزية؛ استبعاده يجعل جهد نقل السلطة اللامركزية موجَّهاً نحو الراوترات الفعلية أعلاه.

### 1.3.1 بُعد الفرع في البوّابات — التوزيع الكامل

| حالة الفرع في البوّابة | النقاط | المعنى |
|---|---:|---|
| `required` (`requireOwnBranch`) | 228 | يُرفض من لا فرع له (عدا admin/manager) |
| `scoped` (`branchScopedProcedure`) | 94 | يُمرَّر `scopedBranchId` للاستعلام (`null` = كل الفروع للمرتفعين) |
| `asserted` | 57 | يُتحقَّق **فقط إن أرسل العميل `branchId`**؛ غيابه يمرّ |
| `none` | **292 (44%)** | لا بُعد فرع إطلاقاً |

الـ292 تشمل 72 نقطة `adminProcedure` و32 عامّة (وكثير منها مشروع: كتالوج مشترك، إدارة نظام).
التصنيف النهائي (مقبول / ثغرة) قرار مالك المجال في المرحلة 1.

⚠️ الحالة `asserted` (57 نقطة) نمط خطر بذاته: العزل **مشروط بمبادرة العميل**. غياب `branchId` من
الحمولة يعبُر الفحص، ويبقى الاعتماد على منطق داخل المعالِج.

### النقاط بلا عزل فرع — أثقل التجمّعات (من الـ115 ذات بوّابة الوحدة)

| الراوتر | الوحدة | النقاط | التقدير الأولي |
|---|---|---|---|
| `reportsRouter` | `reports` | 44 | عزل جزئيّ داخل الاستعلامات (`scopedBranchId`) — يُتحقَّق نقطةً-نقطةً |
| `catalogRouter`, `bundlesRouter`, `priceWavesRouter`, `imageStudioRouter` | `products` | ~22 | كتالوج مشترك — غياب الفرع **مقصود ومقبول** |
| `employeeRouter`, `payrollRouter`, `leaveRouter` | `hr` | ~20 | **يحتاج قراراً**: هل بيانات الموظف معزولة بالفرع؟ |
| `assetsRouter` | `assets` | 15 | الأصل له فرع — الغياب مرشّح ثغرة |
| `customerRouter`, `customerNoteRouter` | `crm` | 6 | كتالوج عملاء مشترك — مقبول |
| `supplierRouter` | `suppliers` | 4 | كتالوج موردين مشترك — مقبول |
| `commissionsRouter` | `commissions` | 5 | يحتاج قراراً |

**غياب عزل الفرع ليس ثغرة تلقائياً** — الكتالوج المشترك (منتجات/عملاء/موردون) مشترك بالتصميم.
التصنيف النهائي (مقبول / ثغرة) قرار مالك المجال، وهو بند صريح في بوابة خروج المرحلة 1 (§23).

## 1.4 النقاط غير المصادَقة (32) — تصنيف

| الفئة | النقاط | الحكم |
|---|---|---|
| تمهيد الهوية | `authRouter.login/logout/twoFactorVerify`، `platformAdminRouter.login/logout` | **مشروعة** — لا يمكن أن تُحمى بصلاحية. |
| هوية جهاز | `kioskRouter.deviceLogin/deviceLogout/banner/lookup` | Principal «جهاز كشك» — يحتاج تمثيلاً في النموذج. |
| بوابة الجرد | `countPortalRouter.auth/submit/finish/logout` + قراءة | Principal «جلسة عدّ» — **تكتب على المخزون**. أولوية عليا. |
| واجهة المتجر | `storefrontRouter.createOrder/trackBanner/trackConversion` + قراءات | Principal «زبون مجهول» — `createOrder` ينشئ التزاماً. |
| توظيف عام | `recruitmentRouter.openVacancies/submit` | Principal «متقدّم» — يكتب PII. |

**استنتاج حاكم:** خمسة أنواع Principal غير بشرية تكتب في النظام اليوم، ولا يمثّلها نموذج
`users`/`roles`. هذه هي الفجوة ح-٢ في [`00-spec-review.md`](00-spec-review.md).

## 1.5 المهام المجدولة (5) — بلا هوية

| المهمة | الموضع | الأثر |
|---|---|---|
| جدولة الدفعة الصباحية | `server/services/morningPushScheduler.ts:164` (cron) | إرسال خارجي (Push) |
| كنّاس صادر واتساب | `server/services/whatsapp/outboxSweeper.ts:89` (cron) | **إرسال خارجي فعليّ** |
| دورة حياة الحجوزات | `server/services/reservations/lifecycle.ts` | تعديل حالة حجوزات |
| كنّاس جسر أجهزة الحضور | `server/services/hrDevices/bridge.ts:60` (interval) | كتابة حضور |
| كنّاسا `authRouter:59` و`saleRouter:43` | (interval) | تنظيف ذاكرة (بلا أثر أعمال) |

ثلاث مهام تُحدث أثراً خارجياً أو كتابياً **بسلطة غير محدّدة** ⇒ مخالفة §20.3 قائمة اليوم.

## 1.6 مسارات Express (15)

| المسار | المصادقة الحالية | التفويض الحالي |
|---|---|---|
| `GET /api/print/status` | كوكي الجلسة | مصادقة فقط |
| `POST /api/print/raw` | كوكي الجلسة | **raw-role**: admin/manager يمرّان؛ غيرهما يلزمه وردية مفتوحة (`printRoute.ts:29`) |
| `POST /api/print/test` | كوكي الجلسة | كما أعلاه |
| `GET /api/img/banner/:id/:slot` · `/product/:id` · `/kiosk-product/:id` | — | يحتاج تحقّقاً |
| `GET /api/backups/download` | كوكي + CSRF | يحتاج تحقّقاً — **تصدير بيانات كاملة** |
| `GET /api/wa/media/:messageId` | — | يحتاج تحقّقاً — وسائط محادثات (PII) |
| `GET/POST /api/webhooks/whatsapp` · `/instagram` · `/store` | HMAC | Principal تكامل |
| `GET /.well-known/assetlinks.json` · `GET /healthz` | — | عامّ بالتصميم |

**بند مفتوح:** ثلاثة مسارات (`/api/img`, `/api/backups`, `/api/wa/media`) لم تُحسَم تفويضاتها في
هذا الجرد الآلي — تُقرأ يدوياً في المرحلة 1. أُدرجت هنا صراحةً بدل إغفالها.

## 1.7 حقول الجرد (§20.2)

الجرد المولَّد يغطّي اليوم: اسم النقطة · الراوتر · النوع (قراءة/كتابة) · البوّابة · مصدر السلطة ·
الوحدة والمستوى · الأدوار · حالة الفرع · الحساسية وسببها · الأعلام · الموضع في الكود ·
**الصلاحية الذرية المقترحة**.

**ما لم يُغطَّ بعد** (يُستكمل يدوياً بمالك المجال في المرحلة 1): المورد النهائي · الحقول الحسّاسة ·
حدود القيمة · متطلبات MFA · قواعد SoD · متطلبات الموافقة · أحداث التدقيق · الاختبارات المرتبطة ·
مالك المجال. هذه أعمدة **قرار** لا أعمدة **استنتاج آليّ**.
