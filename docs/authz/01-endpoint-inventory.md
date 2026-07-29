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

**قراءة الرقم:** 130 نقطة على مستوى **البوّابة** (72 admin + 58 raw-role) تُحسم بـ**اسم الدور** —
هذا ما تستهدفه بوابة القبول §25.4 («صفر قرار أعمال يعتمد اسم الدور»). ويُضاف إليها **5 نقاط** تحكم
بالدور **منعاً داخل جسم المعالِج** (`HANDLER_ROLE_CHECK`، بعد استبعاد حرّاس الفرع)؛ فإجمالي النقاط ذات
القرار المعتمِد على اسم الدور أعلى قليلاً من 130، وكلّها تدخل نطاق §25.4.

## 1.3 الأعلام الحرجة

| العلَم | العدد | المعنى ومسار المعالجة |
|---|---|---|
| `LOCAL_GATE` | **119** (18%) | بوّابة مُعرَّفة **داخل ملف الراوتر** بإضافة middleware فعليّ (`.use(...)`) لا في `server/trpc.ts` ⇒ سلطة لامركزية. **لا تشمل** الأسماء المستعارة المجرَّدة (`const x = centralProcedure;`) — تلك ترث بوّابتها المركزية ولا تُعدّ لامركزية. |
| `NO_BRANCH_SCOPE` | **115** | نقاط ببوّابة وحدة (`module-map`) بلا أي بُعد فرع. الرقم الأشمل: **292 نقطة (44%)** بلا بُعد فرع في بوّابتها إطلاقاً — انظر 1.3.1. |
| `ADMIN_ONLY` | **75** | سلطة `admin` مطلقة بلا حبيبة (عدّ tRPC): **72** بوّابةً (`adminProcedure`) + **3** قيدَ admin **داخل جسم المعالِج** (رفضٌ إن لم يكن admin). مسار Express الإداريّ (`/api/backups/download`) يُعدّ في صفوف Express لا في عدّ tRPC. |
| `SENSITIVE_ACTION` | 76 | فعل مالي/خارجي حسّاس (إلغاء/اعتماد/عكس/حذف/تصدير/إرسال). |
| `RAW_ROLE_GATE` | **68** | حكمٌ باسم الدور: **58** سلطتها الأساسية اسم الدور + **8** **مركّبة** (`cashierProcedure` + `requireModule`) + **2** قيدَ دورٍ **داخل المعالِج** (مجموعة/`assertElevated`). |
| `HANDLER_ROLE_CHECK` | **5** | قيد **منعٍ** بالدور داخل جسم المعالِج (لا في البوّابة): `role !== …` أو `!SET.has(ctx.user.role)` أو `assertElevated(…)`. مصدر سلطةٍ لا تراه قراءة البوّابات وحدها. |
| `UNAUTHENTICATED` | 32 | `publicProcedure` (منها 15 mutation). |
| `READ_WITHOUT_MODULE_GATE` | 30 | قراءة بلا استشارة خريطة الصلاحيات. |
| `WRITE_WITHOUT_MODULE_GATE` | 23 | كتابة بلا بوّابة وحدة. |

> **تصحيحات دقّة (مراجعتا Codex + مراجعة review-module على PR #405):**
> - `LOCAL_GATE` كان 163 لأنه احتسب الأسماء المستعارة المجرَّدة (44 منها في `reportsRouter`) — الصحيح **119**.
> - `HANDLER_ROLE_CHECK` (مسحُ جسم المعالِج) يلتقط بوّابات المنع بالدور التي لا تظهر في تعريف البوّابة
>   (`cardAccount.createReconciliation`، `reservations.extend`، `employee.createWithAccount`،
>   `arReminders.queue/history`). قُصِر على **مسار الرفض** واستُبعد منه لاحقاً **اصطلاحُ عزل الفرع**
>   (`role !== "admin" && …branchId…` ≈ `requireOwnBranch`) — كان أوّلاً يضخّم العدد إلى 23 ويسم ~18
>   حارسَ فرعٍ زوراً «admin فقط»؛ العدد الصحيح بعد الاستبعاد **5**، وبه هبطت `ADMIN_ONLY` من 92 إلى **75**
>   و`RAW_ROLE_GATE` إلى **68**.
> - وحدةٌ مُطبَّقة inline على النقطة (`fundTreasury`، `updateLegalSettings`) صارت تُلتقَط وتُنسَب لوحدتها.

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

المُلتقَطة آلياً هي **حصراً** استدعاءات `cron.schedule`/`setInterval` الفعلية — خمسٌ، ثلاثٌ منها ذات أثر:

| المهمة | الموضع | الأثر |
|---|---|---|
| جدولة الدفعة الصباحية | `server/services/morningPushScheduler.ts:164` (cron) | إرسال خارجي (Push) |
| كنّاس صادر واتساب | `server/services/whatsapp/outboxSweeper.ts:89` (cron) | **إرسال خارجي فعليّ** |
| كنّاس جسر أجهزة الحضور | `server/services/hrDevices/bridge.ts:60` (interval) | كتابة حضور |
| كنّاسا `authRouter:59` و`saleRouter:43` | (interval) | تنظيف ذاكرة (بلا أثر أعمال) |

> **تصحيح (مراجعة Codex على PR #405):** الإصدار الأول أدرج «دورة حياة الحجوزات» ضمن الخمس خطأً.
> `expireDueReservations` (`server/services/reservations/lifecycle.ts`) **مُصدَّرٌ ومُعرَّف بلا أيّ
> مستدعٍ ولا مجدوِل** في المستودع (تعليق السطر 89 عن «node-cron» قديمٌ ولا كود خلفه) — فليس مهمة
> مجدولة ولا يحمل انتهاكاً بلا-Principal. الخمس أعلاه هي الالتقاط الآليّ الصحيح.

ثلاث مهام تُحدث أثراً خارجياً أو كتابياً **بسلطة غير محدّدة** ⇒ مخالفة §20.3 قائمة اليوم.

## 1.6 مسارات Express (15)

| المسار | المصادقة الحالية | التفويض الحالي |
|---|---|---|
| `GET /api/print/status` | كوكي الجلسة | مصادقة فقط (`none/session`) — لا بوّابة دور |
| `POST /api/print/raw` · `POST /api/print/test` | كوكي الجلسة | **raw-role**: admin/manager يمرّان؛ غيرهما يلزمه وردية مفتوحة (`printRoute.ts:29`). البوّابة على POST فقط. |
| `GET /api/img/banner/:id/:slot` · `/product/:id` | — | `public` — صور عامّة |
| `GET /api/img/kiosk-product/:id` | جهاز كشك | `device` — يتجاوز `showInStore` (كتالوج مخفيّ) — حساسية أعلى من العامّة |
| `GET /api/backups/download` | كوكي + CSRF | `admin` — **تصدير بيانات كاملة** (حسّاس عالٍ) |
| `GET /api/wa/media/:messageId` | جلسة مستخدم | `session` — وسائط محادثات (PII، حسّاس عالٍ) |
| `POST /api/webhooks/whatsapp` · `/instagram` · `/store` | HMAC | `hmac` — Principal تكامل (كتابة صندوق وارد) |
| `GET /api/webhooks/whatsapp` · `/instagram` | verify-token | `public` — تحقّق challenge فقط (لا HMAC ولا كتابة) |
| `GET /.well-known/assetlinks.json` · `GET /healthz` | — | `public` — عامّ بالتصميم |

**تحديث (مراجعة Codex على PR #405):** صار الجرد يسجّل **السلطة الفعليّة لكل مسار Express** في الـCSV
والـJSON (`authority`/`roles`/`sensitivity`/`note`) بدل ثابتٍ اصطناعيّ موحّد — فيميّز تنزيل النسخة
الكاملة (`admin`) عن `/healthz` (`public`) عن وسائط الواتساب (`session`). التصنيف مشتقٌّ يدوياً من
قراءة كل ملف مسار (`classifyExpress`)، ويبقى التحقّق النهائيّ لكل مسار بنداً في المرحلة 1.

## 1.7 حقول الجرد (§20.2)

الجرد المولَّد يغطّي اليوم: اسم النقطة · الراوتر · النوع (قراءة/كتابة) · البوّابة · مصدر السلطة ·
الوحدة والمستوى · الأدوار · حالة الفرع · الحساسية وسببها · الأعلام · الموضع في الكود ·
**الصلاحية الذرية المقترحة**.

**ما لم يُغطَّ بعد** (يُستكمل يدوياً بمالك المجال في المرحلة 1): المورد النهائي · الحقول الحسّاسة ·
حدود القيمة · متطلبات MFA · قواعد SoD · متطلبات الموافقة · أحداث التدقيق · الاختبارات المرتبطة ·
مالك المجال. هذه أعمدة **قرار** لا أعمدة **استنتاج آليّ**.
