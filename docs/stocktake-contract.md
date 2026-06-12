# عقد شريحة «الجرد والتسوية» — مُلزِم لكل العمّال

> القائد يملك هذا الملف. كل عامل يقرأه كاملاً + ملف(ات) تصميمه قبل أي سطر كود.
> **التصميم المرجعي**: `D:\bms-design-stocktake\project\design_handoff_stocktake\` — اقرأ `README.md` فيه (التوجيه التنفيذي) + ملفك المحدد.
> **جذر العمل**: `D:\business_management_system__stocktake` (worktree معزول، فرع `session/stocktake`، منفذ 3002، قاعدة `erp_stocktake`). **كل المسارات أدناه نسبية لهذا الجذر — لا تكتب خارج ملفاتك المملوكة.**

## ٠. حقائق المستودع (لا تعد استكشافها)

- **معاملات**: `withTx(async (tx) => …)` من `server/services/tx.ts` — أي throw ⇒ ROLLBACK كامل.
- **المخزون**: `server/services/inventoryService.ts`:
  - `applyMovement(tx, { variantId, branchId, baseQuantity (موجب), movementType: "IN"|"OUT"|"RETURN"|"TRANSFER_IN"|"TRANSFER_OUT", referenceType?, referenceId?, relatedBranchId?, notes?, createdBy? })` — لا يقبل ADJUST.
  - `setStock(tx, { variantId, branchId, targetQuantity (مطلق), referenceType?, referenceId?, notes?, createdBy? })` — يكتب حركة ADJUST تحت قفل `.for("update")`. **تسوية الجرد تمر حصراً من هنا.**
- **الدفتر**: `server/services/ledgerService.ts` → `postEntry(tx, { entryType, branchId?, …, revenue?, cost?, profit?, amount?, entryDate?, notes?, dedupeKey? })`. أنواع: SALE/PURCHASE/PAYMENT_IN/PAYMENT_OUT/RETURN/ADJUST/OPENING. `dedupeKey` UNIQUE (نمط `SALE:<invoiceId>`).
- **الأموال**: `server/services/money.ts`: `money(x)`, `round2`, `toDbMoney`, `sumMoney`, `toDateStr`. **ممنوع** parseFloat/Number على الأموال.
- **التدقيق**: `server/services/auditService.ts` → `logAudit(ctx, { action, entityType, entityId?, oldValue?, newValue? })` — يُستدعى في الراوتر (best-effort)، يقبل user=null.
- **الحُرّاس** (`server/trpc.ts`): `publicProcedure`, `protectedProcedure`, `adminProcedure`, `managerProcedure` (admin+manager), `warehouseProcedure` (admin+manager+warehouse), `branchScopedProcedure` (يضخ `ctx.scopedBranchId`: null للمرتفعين وإلا branchId). إخفاء التكلفة: `canSeeCost(role)` = admin/manager.
- **المصادقة**: jose HS256 بسرّ `process.env.JWT_SECRET`؛ كلمات المرور scrypt عبر `server/auth/password.ts` (`hashPassword`, `verifyPassword` — timing-safe). كوكي عبر `getSessionCookieOptions(req)` من `server/cookies.ts`.
- **عميل tRPC**: `import { trpc } from "@/lib/trpc"` + أنواع `RouterOutputs`. توستات: `notify.ok/err/warn/info` من `@/lib/notify`. أرقام: `fmt` (فواصل آلاف 2dp) و`fmtInt` (لاتيني صحيح) من `@/lib/money`.
- **باركود**: `useBarcodeScanner(onScan, {enabled, minLength, thresholdMs})` من `@/hooks/useBarcodeScanner`.
- **طباعة A4**: ابنِ بنمط `printQuotation` في `client/src/lib/printing/printTemplates.ts`: builders من `./docHtml` (`wrapA4Doc`, `docHeader`, `docMeta`, `docTable`, `docSummary`, `docFooter`, `openPrintWindow`) + `fmt/fmtC/esc` من `./brand` + `code128Svg` من `./barcode`.
- **واتساب**: عميل فقط — `openWhatsApp(phone, message)` من `@/lib/whatsapp` (wa.me).
- **مكونات**: shadcn تحت `@/components/ui/*` (Card, Button, Badge, Dialog, Select, Switch, Tabs, Progress, Input, Textarea, Checkbox…) + Cairo + RTL. صفحات مرجعية للأنماط: `client/src/pages/Customers.tsx` (قائمة/فلاتر/ترقيم)، `POS.tsx` (ماسح)، `Purchases.tsx`.
- **الأرقام لاتينية دائماً** (123456789): استعمل fmt/fmtInt أو `toLocaleString("ar-IQ-u-nu-latn")`.

## ١. المخطط (مُنجَز — لا تلمس schema.ts)

في `drizzle/schema.ts` (مدفوع للقاعدتين): `stocktakeSessions`, `stocktakeAssignments`, `stocktakeItems`, `stocktakeCounts`, `stocktakeDecisions` + `branchStock.lastCountedAt`. اقرأ تعريفاتها من الملف نفسه (نهاية الملف). نقاط مفصلية:
- `stocktakeItems`: لقطة `expectedQty` (int، وحدة أساس) + `unitCost` (decimal) لحظة الإنشاء؛ `UNIQUE(sessionId, variantId)`؛ حقول إعادة العدّ (`recountStatus: PENDING|DONE`, reason, requestedBy/At).
- `stocktakeCounts`: `kind: FIRST|RECOUNT|VERIFY`، `qty` int أساس، `unitBreakdown` JSON نصي، `countedByName`، `isConflict`, `resolvedPick: FIRST|VERIFY`, `clientRequestId` + `UNIQUE(sessionId, clientRequestId)` (idempotency للأوفلاين).
- `stocktakeDecisions`: `action: ADJUST|KEEP`, `finalQty`, `diffQty`, `value`, `reason: UNSPECIFIED|DAMAGE|LOSS_THEFT|ENTRY_ERROR|PRINT_WASTE`, `decidedBy` (NULL+`autoApplied` = تلقائي)، `UNIQUE(sessionId, variantId)`.
- `stocktakeAssignments`: `method: PIN|USER`, `pinHash`, قفل PIN (`failedPinAttempts`, `lockedUntil`)، `status: ACTIVE|SUBMITTED`.

## ٢. معادلات الأعمال (انقلها حرفياً — مصدرها `jrd-data.jsx` + README §٤)

```
rawCount      = آخر RECOUNT إن وُجد وإلا FIRST (مع مراعاة resolvedPick عند تعارض VERIFY)
netAfter      = Σ تأثير حركات المخزون على (variant×branch) بعد countedAt للعدّ الفعّال
                (الإشارة حسب movementType كما في inventoryService: IN/RETURN/TRANSFER_IN = +qty،
                 OUT/TRANSFER_OUT = −qty، ADJUST = الدلتا كما سُجّلت — افحص applyMovement/setStock وطابق)
adjustedCount = rawCount + netAfter            // التصحيح الآلي (autoAdjust، افتراضي ON)
bookNow       = branchStock.quantity الحالي
diff          = adjustedCount − bookNow
value         = diff × unitCost(snapshot)      // decimal.js
pct           = expectedQty === 0 ? null : |diff| / expectedQty × 100
withinThreshold = diff≠null && (pct ≤ thresholdPct && |value| ≤ thresholdValue)
overThreshold   = diff≠0 && !withinThreshold
requiresDualSign(item) = |value| > dualThreshold
```
- تعارض VERIFY: عدّان مختلفان (FIRST ≠ VERIFY) بلا `resolvedPick` ⇒ يحجب الاعتماد. `resolvedPick` يحدد أي قيمة هي `rawCount`. عدّ RECOUNT لاحق يمسح التعارض ويحلّ محل الجميع.
- إعادة عدّ PENDING تحجب الاعتماد.

### الاعتماد (الأذرّ — `withTx` واحدة):
1. اقرأ الجلسة `FOR UPDATE`. إن APPROVED ⇒ أرجع نجاحاً بلا أثر (idempotent). يجب REVIEW.
2. حواجز: لا recount PENDING، لا تعارض مفتوح، كل عنصر `overThreshold` له قرار صريح (ADJUST/KEEP). إن `directUnderThreshold=false` فكل diff≠0 يحتاج قراراً.
3. توقيعان: إن وُجد عنصر مُسوّى `|value| > dualThreshold` ⇒ يلزم `firstSignBy` موجوداً و**approver ≠ firstSignBy** (تحقّق خادمي بـ id).
4. **أعد حساب** rawCount/netAfter/diff داخل المعاملة (لا تثق بحسابات شاشة المراجعة). لكل قرار ADJUST فعّال بـ diff≠0: `setStock(tx, { variantId, branchId, targetQuantity: adjustedCount, referenceType: "STOCKTAKE", referenceId: sessionId, notes: code, createdBy })`.
5. عناصر معدودة بلا قرار وdiff≠0 وضمن الحد و`directUnderThreshold` ⇒ قرار ADJUST تلقائي (`autoApplied=true, decidedBy=null, reason=UNSPECIFIED`). عناصر diff=0 ⇒ قرار KEEP تلقائي (diffQty=0) — **يلزم لسجل IRA والمحضر**. حدّث كل القرارات بـ `finalQty/diffQty/value` النهائية.
6. قيدان محاسبيان (إن وُجدت قيم): عجز ⇒ `postEntry(tx, { entryType:"ADJUST", branchId, cost: +Σ|قيم العجز المسوّى|, amount: 0, notes: "جرد <code> — عجز مخزون", dedupeKey: "STOCKTAKE:<id>:SHORT" })`، زيادة ⇒ مثله بـ `cost: −Σقيم الزيادة` و`dedupeKey: "STOCKTAKE:<id>:OVER"` وملاحظة «زيادة جرد». **قبل التثبيت**: افحص كيف تستهلك التقارير (`server/routers/reportsRouter*`/`reports`) حقول revenue/cost/profit/amount لقيود ADJUST، واضبط الحقول بحيث ينخفض الربح بقيمة العجز ويرتفع بالزيادة **دون** تشويه المبيعات أو الصندوق؛ وثّق القرار بتعليق واختبار.
7. `branchStock.lastCountedAt = now` لكل صنف **معدود** في الجلسة.
8. الجلسة ⇒ APPROVED + approvedBy/At. (audit في الراوتر بعد نجاح المعاملة.)

### توليد الرمز
`CNT-<السنة>-<NNNN>` تسلسلي: داخل tx اقرأ MAX(code) للسنة `FOR UPDATE` على الجلسات؛ أعد المحاولة مرة عند ER_DUP_ENTRY (code UNIQUE).

## ٣. عقد الـ API — `server/routers/stocktakeRouter.ts` (يُركَّب لاحقاً كـ `stocktakes`)

> zod كأمثلة `purchaseRouter`. كل mutation تستدعي خدمة في `stocktakeService.ts` ثم `logAudit` (action بنمط `stocktake.<فعل>`, entityType `"stocktake"`, entityId sessionId). TRPCError برسائل عربية واضحة.

| إجراء | حارس | المدخل (zod) | المخرج |
|---|---|---|---|
| `create` | `warehouseProcedure` | `{ name, branchId, scopeType: "FULL"\|"MOVING"\|"CATEGORY"\|"MANUAL", movingDays?, categoryIds?: number[], variantIds?: number[], blind?, thresholdPct?: string, thresholdValue?: string, dualThreshold?: string, directUnderThreshold?, waNotify?, dupPolicy?, notes?, assignments: [{ name, method:"PIN"\|"USER", userId?, zone?, variantIds?: number[] }] (min 1) }` | `{ sessionId, code, itemCount, assignments: [{ assignmentId, name, method, zone, pin?: string /*مرة واحدة*/, itemCount }] }` |
| `list` | `warehouseProcedure` | `{ status?, branchId?, limit=50, offset=0 }?` | صفوف: `{ id, code, name, branchId, branchName, scopeType, scopeLabel, status, itemCount, countedCount, createdAt, createdByName, submittedAt, approvedAt }` |
| `get` | `warehouseProcedure` | `{ sessionId }` | ترويسة الجلسة + التكليفات (بلا pinHash أبداً) + progress |
| `monitor` | `warehouseProcedure` | `{ sessionId }` | `{ session, assignments: [{ id, name, method, zone, status, total, counted, lastActivityAt }], recentCounts: [{ variantLabel, qty, kind, byName, at }] (آخر ٢٠), pendingRecounts, conflicts }` — **بلا expectedQty/تكلفة** |
| `review` | `managerProcedure` | `{ sessionId, autoAdjust?: boolean=true }` | §٤ أدناه |
| `requestRecount` | `warehouseProcedure` | `{ sessionId, variantId, reason (min 3) }` | `{ ok }` |
| `resolveConflict` | `managerProcedure` | `{ sessionId, variantId, pick: "FIRST"\|"VERIFY" }` | `{ ok }` |
| `decide` | `managerProcedure` | `{ sessionId, variantId, action: "ADJUST"\|"KEEP", reason, note? }` | `{ ok }` |
| `firstSign` | `managerProcedure` | `{ sessionId }` | `{ ok, firstSignByName, firstSignAt }` |
| `approve` | `managerProcedure` | `{ sessionId }` | `{ ok, alreadyApproved?, adjustedCount, shortExpense, overGain }` |
| `forceReview` | `managerProcedure` | `{ sessionId }` | إقفال العدّ يدوياً (تكليفات ACTIVE ⇒ SUBMITTED) |
| `cancel` | `adminProcedure` | `{ sessionId, reason? }` | `{ ok }` |
| `regeneratePin` | `warehouseProcedure` | `{ assignmentId }` | `{ pin }` (مرة واحدة) + audit |
| `cycleSuggestions` | `warehouseProcedure` | `{ branchId? }` | `[{ variantId, productName, variantName, sku, abc: "A"\|"B"\|"C", freqDays, freqLabel, lastCountedAt, daysOver }]` (القيمة السنوية تظهر للمدير فقط: `annualValue?`) |
| `ira` | `managerProcedure` | `{}` | `{ branches: [{ branchId, name, months: [{ ym, ira }] }], workers: [{ name, accuracy, counts }] }` من الجلسات المعتمدة فعلياً |
| `stats` | `warehouseProcedure` | `{}` | `{ counting, review }` (لبطاقة لوحة التحكم/القائمة) |
| `report` | `managerProcedure` | `{ sessionId }` | كل بيانات المحضر (انظر §٦) |
| `countSheets` | `warehouseProcedure` | `{ sessionId }` | لكل تكليف: `{ assignment, items: [{ productName, variantName, sku, barcode, baseUnit }] }` — **أعمى: بلا expectedQty** |
| `log` | `managerProcedure` | `{ sessionId }` | أحداث auditLogs (entityType stocktake) `[{ at, byName, action, detail? }]` |

قواعد إضافية:
- `create`: دور warehouse غير المرتفع ⇒ `branchId` يُجبَر على فرعه، والحدود (`threshold*`) تُتجاهل وتُستعمل الافتراضيات (تعديل الحدود manager+ — README §٨). توزيع الأصناف: union(variantIds للتكليفات) يجب أن يساوي نطاق الجلسة؛ أصناف بلا تكليف ⇒ التكليف الأول. PIN: ٤ أرقام عشوائية (crypto) فريدة داخل الجلسة، تُخزَّن hash فقط.
- `list/get/monitor/...`: دور warehouse يرى فرعه فقط (نمط scopedBranchId).
- `review/report`: للمدير+ فقط (تكاليف وقيم).

## ٤. مخرج `review` (الشاشة الأهم تعتمد عليه حرفياً)

```ts
{
  session: { id, code, name, branchId, branchName, status, blind,
             thresholdPct, thresholdValue, dualThreshold, directUnderThreshold,
             dupPolicy, createdAt, createdByName, submittedAt,
             firstSign: { byName, at } | null, approved: { byName, at } | null },
  rows: [{
    variantId, productName, variantName, sku, baseUnit, zone, assignmentName,
    expectedQty, rawCount: number|null, kindUsed: "FIRST"|"RECOUNT"|null,
    countedByName, countedAt,
    recount: { status: "PENDING"|"DONE", reason, requestedByName, qty2: number|null } | null,
    verify: { qty, byName, at, match: boolean } | null,
    conflict: { qty1, by1, qty2, by2, resolvedPick: "FIRST"|"VERIFY"|null } | null,
    movesAfter: [{ type, qty /*مُشارة ±*/, ref, at }], netAfter,
    adjustedCount: number|null, bookNow, diff: number|null, value: string|null,
    pct: number|null, withinThreshold, overThreshold, requiresDualSign,
    decision: { action, reason, note, decidedByName: string|null, autoApplied } | null,
  }],
  totals: { total, counted, matched, over, short, overThr,
            netValue, shortValue, overValue },     // قيم نصية decimal
  barriers: { notCounted, pendingRecounts, openConflicts, undecidedOverThreshold,
              requiresDualSign: boolean, firstSigned: boolean, canApprove: boolean,
              canFinalApprove: boolean /*التوقيع الثاني متاح لهذا المستخدم*/ },
  ledgerPreview: { shortExpense: string, overGain: string },
}
```
`autoAdjust=false` ⇒ نفس البنية لكن `adjustedCount = rawCount` (للمقارنة في الواجهة).

## ٥. بوابة العدّ العامة — `server/routers/countPortalRouter.ts` (`count`) + `server/services/countPortalService.ts`

كلها `publicProcedure`. الهوية عبر **أحد**: كوكي `count_token` (JWT jose HS256، حمولة `{ k:"stk", sid, aid }`، صلاحية ١٢ساعة، خيارات `getSessionCookieOptions`) **أو** مستخدم النظام المسجَّل (`ctx.user`) المرتبط بتكليف `method=USER`.

| إجراء | المدخل | السلوك |
|---|---|---|
| `auth` | `{ sessionCode, pin? }` | جلسة COUNTING فقط. PIN: جرّب التكليفات PIN غير المقفلة (`verifyPassword`)؛ فشل ⇒ زد `failedPinAttempts` على كل تكليفات PIN غير المقفلة بالجلسة، وعند ≥٥ ⇒ `lockedUntil=+15د` (ثم صفّر العدّاد)؛ نجاح ⇒ صفّر العدّاد، أصدر JWT في كوكي `count_token`. بلا PIN: `ctx.user` ⇒ تكليف USER مطابق. المخرج: `{ ok, assignmentName, zone, mode: "PIN"\|"USER" }` |
| `state` | `{ sessionCode }` | `{ session: { code, name, branchName, status, dupPolicy, blind }, assignment: { id, name, zone, status }, progress: { mine: {counted,total}, session: {counted,total} }, recountTasks: [{ variantId, productName, variantName, reason }], items: [{ variantId, productName, variantName, sku, isMine: boolean, counted: boolean /*من أي أحد*/, myCount: { qty, at, unitBreakdown } | null, colleagueCounted: boolean /*بلا كمية*/, units: [{ unitName, factor: number, barcode }] }] }` — **يُمنع منعاً باتاً**: expectedQty، أسعار/تكاليف، كميات الزملاء |
| `submit` | `{ sessionCode, variantId, qty (int ≥0 أساس), unitBreakdown?: string (≤500), clientRequestId (uuid) }` | منطق §أدناه؛ idempotent عبر `UNIQUE(sessionId, clientRequestId)` — تكرار ⇒ نجاح بلا أثر |
| `finish` | `{ sessionCode }` | التكليف ⇒ SUBMITTED؛ آخر تكليف ⇒ الجلسة REVIEW + `submittedAt`. مخرج `{ ok, sessionMovedToReview }` |
| `logout` | `{}` | مسح الكوكي |

منطق `submit` (داخل `withTx`):
- تحقّق: الجلسة COUNTING، التكليف ACTIVE، الصنف ضمن أصناف الجلسة.
- **منطقتي** (item.assignmentId == تكليفي): إن recountStatus=PENDING ⇒ سجل `kind=RECOUNT`، recountStatus=DONE، وامسح أي تعارض على الصنف (التعارض يُحل بالعد الثالث). وإلا إن لي FIRST سابق ⇒ حدّثه (qty/at/breakdown). وإلا أدرج FIRST.
- **منطقة زميل**: `dupPolicy=BLOCK` ⇒ TRPCError CONFLICT برسالة واضحة. `VERIFY`: لا FIRST بعد ⇒ أدرج FIRST باسمي؛ يوجد FIRST لغيري ⇒ أدرج/حدّث VERIFY باسمي، `isConflict = (qty ≠ FIRST.qty)`.
- حدّث `lastActivityAt`. audit action `stocktake.count` (user قد يكون null؛ ضع countedByName في newValue).
- ممنوع البيع بالبوابة على جلسة غير COUNTING أو تكليف SUBMITTED (TRPCError).

## ٦. الواجهة — الصفحات والملكية (انسخ البنية والنصوص والتدفق من ملف التصميم المحدد لكل صفحة)

| صفحة | مسار | مالك | مرجع تصميم |
|---|---|---|---|
| `client/src/pages/Stocktakes.tsx` | `/stocktakes` | W3 | `jrd-sessions.jsx` |
| `client/src/pages/StocktakeNew.tsx` | `/stocktakes/new` (+ prefill `?variants=1,2&name=…` من reconcile/الدوري) | W3 | `jrd-wizard.jsx` |
| `client/src/pages/StocktakeMonitor.tsx` | `/stocktakes/:id` | W4 | `jrd-sessions.jsx` (المتابعة) |
| `client/src/pages/StocktakeReview.tsx` | `/stocktakes/:id/review` | W4 | `jrd-review.jsx` |
| `client/src/pages/StocktakeReport.tsx` | `/stocktakes/:id/report` | W5 | `jrd-report.jsx` |
| `client/src/pages/StocktakeCountSheets.tsx` | `/stocktakes/:id/sheets` | W5 | `jrd-countsheet.jsx` |
| `client/src/lib/printing/stocktakeTemplates.ts` (`printStocktakeReport`, `printCountSheets`) | — | W5 | `jrd-report.jsx`, `jrd-countsheet.jsx` |
| `client/src/pages/CountPortal.tsx` + `client/src/lib/countQueue.ts` | `/count/:code` (**عام، خارج AppLayout، موبايل أولاً**) | W6 | `jrd-count.jsx` |

ملاحظات مُلزِمة للواجهة:
- استعلم بـ `trpc.stocktakes.*` و`trpc.count.*` (سيركّبهما القائد بهذه الأسماء — اكتب الكود عليها مباشرة).
- دور المستخدم من `trpc.auth.me.useQuery()`؛ أخفِ القيم/الأزرار حسب مصفوفة README §٨ (الخادم يحجب فعلياً — الواجهة تجمّل فقط).
- المتابعة الحية: `refetchInterval: 5000` في monitor/state.
- واتساب (عند `waNotify`): أزرار wa.me فقط (تذكير عامل في Monitor، إشعار مسؤول بعد `finish` في البوابة إن رغبت) — لا خادم.
- الأوفلاين (W6): `countQueue.ts` طابور localStorage بمفتاح `countq_<code>`: عند فشل `submit` بسبب الشبكة ⇒ enqueue (نفس clientRequestId) + شارة ⏳؛ مزامنة عند `online`/فاصل ٥ث؛ `finish` يتطلب طابوراً فارغاً واتصالاً. مؤشر حالة الاتصال في الترويسة.
- إدخال متعدد الوحدات: صفوف (كرتون/درزن/قطعة) × factor ⇒ مجموع أساس صحيح، يُعرض live، ويُرسل `qty` النهائي + `unitBreakdown` JSON.
- البحث في البوابة محلي (على items المحمّلة) + مسح باركود (`useBarcodeScanner` + مطابقة `units[].barcode`).
- التقرير والقوائم الورقية: زر «طباعة» يستدعي قالب W5؛ والشاشة نفسها معاينة جميلة (نمط `jrd-report.jsx`).

## ٧. التكامل (القائد فقط — لا يلمسه العمّال)
`server/routers.ts` (+`stocktakes`,`count`)، `client/src/App.tsx` (مسارات + `/count/:code` عام)، `AppLayout.tsx` (بند «الجرد والتسوية» بعد «أرصدة المخزون»)، `server/index.ts` (rate-limit على `count.auth` بنمط auth.login)، `Inventory.tsx` (عمود «آخر جرد»)، `Reconcile.tsx` (زر «أنشئ جلسة جرد لهذه الأصناف»)، `Dashboard.tsx` (بطاقة «بانتظار المراجعة»)، `seed.ts` (لا تغيير).

## ٨. ممنوعات قاطعة
- لا تعديل على ملفات خارج ملكيتك (الجدول أعلاه + §٧). لا `parseFloat` على أموال. لا تحديث `branchStock` مباشرة. لا كشف expectedQty/أسعار/تكاليف/كميات زملاء عبر بوابة العدّ. لا قيود دفترية بلا dedupeKey. كل النصوص عربية والأرقام لاتينية. أي غموض: اتبع `jrd-*.jsx` المرجعي ثم README الحزمة.
