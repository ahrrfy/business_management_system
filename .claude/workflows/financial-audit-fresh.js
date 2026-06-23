export const meta = {
  name: 'financial-integrity-audit-fresh',
  description: 'تدقيق عدائي للسلامة المالية/المحاسبية/النقدية/المخزنية — من الكود فقط، بلا قراءة أي توثيق/تقرير/خطة/ذاكرة سابقة',
  phases: [
    { title: 'Map' },
    { title: 'Probe' },
    { title: 'Verify' },
    { title: 'Critique' },
    { title: 'Synthesize' },
  ],
}

const FORBIDDEN_RULE = `
**قاعدة صارمة لا تُخرَق (وإلا التقرير باطل):**
ممنوع منعاً باتاً قراءة أيٍّ من:
- CLAUDE.md أو أي ملف *.md في الجذر
- مجلد docs/ بأكمله (تقارير سابقة، خطط، مراجعات، نُقدّر ادعاءاته صفراً)
- مجلد .claude/ ومجلد ~/.claude/ (تعليمات، ذاكرة، خطط)
- أي ملف يحوي «REVIEW» أو «audit» أو «plan» أو «memory» أو «status» في اسمه
- README، CHANGELOG، أو أي وثيقة وصف للمشروع
- ملفات اختبار (server/**/*.test.ts) كمصدر للحقيقة — يجوز قراءتها لتأكيد سلوك متوقَّع فقط، لا للاستنتاج «المنطقة آمنة لأنّ لها اختباراً»

**اقرأ فقط:**
- server/ (الخدمات، الـrouters، الـauth، tx.ts، context.ts، trpc.ts)
- client/src/ (الصفحات والمكوّنات للواجهة)
- drizzle/ (المخطط والهجرات)
- shared/ (utils مشتركة)
- package.json (للتقنية فقط، لا للنشاط المُدَّعى)

تعامل مع النظام كأنّك ترى الكود لأول مرّة. لا تثق في تعليق ولا اسم متغيّر — اقرأ السلوك. الادعاءات في الوثائق ليست حُجّةً ولا قرينة.
`

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    keyFiles: { type: 'array', items: { type: 'object', properties: { file: {type:'string'}, role: {type:'string'} }, required:['file','role'], additionalProperties:false } },
    invariants: { type: 'array', items: { type: 'string' } },
    riskHotspots: { type: 'array', items: { type: 'object', properties: { description: {type:'string'}, file: {type:'string'}, suspicion: {type:'string'} }, required:['description','file','suspicion'], additionalProperties:false } },
  },
  required: ['area','keyFiles','invariants','riskHotspots'],
  additionalProperties: false,
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical','high','medium','low'] },
          file: { type: 'string' },
          locator: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          impact: { type: 'string' },
          repro: { type: 'string' },
        },
        required: ['title','severity','file','locator','claim','evidence','impact'],
        additionalProperties: false,
      },
    },
  },
  required: ['lens','findings'],
  additionalProperties: false,
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high','medium','low'] },
    reasoning: { type: 'string' },
    counterEvidence: { type: 'string' },
    revisedSeverity: { type: 'string', enum: ['critical','high','medium','low','not-a-bug'] },
  },
  required: ['refuted','confidence','reasoning','revisedSeverity'],
  additionalProperties: false,
}

const GAP_SCHEMA = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string' },
          question: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['area','question','why'],
        additionalProperties: false,
      },
    },
  },
  required: ['gaps'],
  additionalProperties: false,
}

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    overallVerdict: { type: 'string' },
    criticalFindings: { type: 'array', items: { type: 'object', properties: { title:{type:'string'}, file:{type:'string'}, severity:{type:'string'}, impact:{type:'string'}, fix:{type:'string'} }, required:['title','file','severity','impact','fix'], additionalProperties:false } },
    highFindings: { type: 'array', items: { type: 'object', properties: { title:{type:'string'}, file:{type:'string'}, severity:{type:'string'}, impact:{type:'string'}, fix:{type:'string'} }, required:['title','file','severity','impact','fix'], additionalProperties:false } },
    mediumLowFindings: { type: 'array', items: { type: 'object', properties: { title:{type:'string'}, file:{type:'string'}, severity:{type:'string'} }, required:['title','file','severity'], additionalProperties:false } },
    healthyAreas: { type: 'array', items: { type: 'string' } },
    recommendedNextSlice: { type: 'string' },
  },
  required: ['summary','overallVerdict','criticalFindings','highFindings','mediumLowFindings','healthyAreas','recommendedNextSlice'],
  additionalProperties: false,
}

// ============ Phase 1: Map (from code only) ============
phase('Map')
log('المرحلة ١: رسم خرائط ١٢ منطقة من الكود فقط — بلا قراءة أي وثيقة')

const MAP_AREAS = [
  { key: 'schema-money-fields', prompt: `اقرأ drizzle/schema.ts كاملاً. عدّ كل حقل مالي (decimal/numeric/varchar للأموال). صنّفه: invoices/items/payments/journal/balances/movements/cost. حدّد أنواع البيانات وأطوالها. حدّد القيود (UNIQUE، FK، DEFAULT). لا تقرأ شيئاً خارج drizzle/.` },
  { key: 'money-utility', prompt: `ابحث بـGlob عن shared/**/money* وshared/**/decimal* و server/**/money*. اقرأ كل ملف عُثر عليه. حدّد: دوال التحويل، التقريب، صيغة الحفظ في DB، التحقّق من الصحّة. ابحث بـGrep عن parseFloat / parseInt / Number\\( في server/services/ وserver/routers/.` },
  { key: 'transactions', prompt: `اقرأ server/services/tx.ts (أو ما يكافئه — ابحث بـGlob أولاً). افهم سيمانتك withTx بالضبط. ثم بـGlob اسرد كل server/services/*.ts، واقرأ كل ملف خدمة، وحدّد: هل يستعمل withTx؟ كم جدولاً يكتب في عملية واحدة؟ هل توجد كتابات خارج المعاملة؟` },
  { key: 'inventory', prompt: `اقرأ server/services/inventoryService.ts (أو ابحث بـGlob server/services/*inventory*). افهم applyMovement سطراً بسطر. ابحث بـGrep عن كل من يستدعيه (server/**) وعن كل من يكتب جدول branchStock مباشرة. سرد أنواع الحركات المدعومة من enum في schema.` },
  { key: 'cash-shift', prompt: `ابحث بـGlob عن server/services/*shift* وserver/services/*cash* وserver/services/*handover*. اقرأها. ابحث بـGrep عن cashRegister و openingBalance وclosingBalance. تتبَّع: كيف تُفتح وردية؟ كيف ينسب بيع نقدي إلى وردية؟ كيف تُغلَق؟ كيف يحدث handover؟` },
  { key: 'ledger', prompt: `ابحث بـGrep في server/ عن «journalEntries» و«journal_entries» — كل من يدرج/يحدّث/يحذف. لكل موقع، حدّد: ما العملية المُحرِّكة (بيع/شراء/مرتجع/دفع/تحويل/إغلاق)؟ ما الإشارة؟ ما القيود (FK، UNIQUE)؟ ما الحقول (debit/credit أم amount/sign)؟` },
  { key: 'balances', prompt: `ابحث بـGrep في server/ عن «currentBalance». لكل موقع تحديث في customers أو suppliers: ما العملية المُحرِّكة؟ هل في withTx؟ هل يُكتب journalEntries مرافق؟ هل مسار واحد يُغيّر الرصيد فقط بلا قيد (انجراف محتمل)؟` },
  { key: 'rbac-procedures', prompt: `اقرأ server/trpc.ts كاملاً. حدّد كل procedure معرّفاً (publicProcedure/authProcedure/cashierProcedure/managerProcedure/warehouseProcedure/adminProcedure...). افهم كل واحد ماذا يفحص. ثم ابحث بـGrep عن استعمالها في server/routers/* — أيّ router يستخدم أيّ procedure؟` },
  { key: 'routers-surface', prompt: `بـGlob اسرد server/routers/*.ts. لكل router افتح وعدّ endpoints: query/mutation. حدّد لكلٍّ: input schema، procedure level، الـoutput. أعطِ لائحة موجزة لكلّ ما يحوي «cash/sale/invoice/return/transfer/purchase/payment/expense/workOrder/inventory/customer/supplier/journal/audit/user» في اسمه أو منطقه.` },
  { key: 'cross-module-flows', prompt: `حدّد بقراءة الخدمات (server/services/*) المسارات المتعدّدة الوحدات. اقرأ خدمات: invoices/sales، purchases/receive، returns، transfers، workOrders/deliver، expenses. لكل مسار: ما الجداول المكتوبة (ترتيباً)؟ هل في withTx واحد؟ ما المخرجات الخارجية (طباعة/HTTP/timeout) داخل المعاملة؟` },
  { key: 'auth-jwt', prompt: `بـGlob اسرد server/auth/* وابحث في server/middleware/* وserver/trpc.ts وcontext.ts. كيف تُولَّد JWT؟ ما الحقول (sub، role، branchId، sessionsValidFrom)؟ كيف تُحدَّد صلاحية الجلسة؟ كيف يُحدَّد ctx.user.branchId؟ كيف يُربَط بكل استعلام؟` },
  { key: 'audit-service', prompt: `ابحث بـGlob عن server/services/*audit* وفي server/ بـGrep عن «auditLogs» و«audit.log». لكل استدعاء فعلي للكتابة في auditLogs: ما العملية؟ ما الحقول المسجَّلة (من/ماذا/متى/قبل/بعد)؟ ما الحجم الفعلي للتغطية (عدد المواقع التي تكتب فعلاً)؟` },
]

const maps = await parallel(MAP_AREAS.map(a => () =>
  agent(`${FORBIDDEN_RULE}\n\nمهمّتك (مرسم خرائط لمنطقة واحدة):\n${a.prompt}\n\nأعطِ: الملفات الرئيسة وأدوارها، الثوابت (invariants) التي يفترض الكود أن تصمد، مناطق الخطر التي يستحقّ أن تُهاجَم في الجولة التالية. لا اختراع، لا استنتاج من اسم متغيّر، لا قراءة وثائق.`,
    { label: `map:${a.key}`, phase: 'Map', schema: MAP_SCHEMA, effort: 'high' })
))

const validMaps = maps.filter(Boolean)
log(`المرحلة ١ اكتملت: ${validMaps.length}/${MAP_AREAS.length} خريطة (مشتقّة من الكود فقط)`)

// ============ Phase 2 + 3: Probe + Verify ============
phase('Probe')
log('المرحلة ٢-٣: ١٤ عدسة هجوم عدائية، وكل ملاحظة تُحقَّق بمحقّق مضادّ فور وصولها')

const mapDigest = validMaps.map(m => `[${m.area}] ملفات: ${m.keyFiles.slice(0,5).map(k=>k.file).join(', ')}. مخاطر مرشَّحة: ${m.riskHotspots.slice(0,3).map(r=>r.description).join(' | ')}`).join('\n').slice(0, 12000)

const PROBE_LENSES = [
  { key: 'money-precision', prompt: `**عدسة الدقة المالية:** ابحث بـGrep عن استعمالات parseFloat / Number\\( / parseInt على ما يبدو حقلاً مالياً، أو عمليات + - * / مباشرة على حقول decimal من DB. ابحث عن إجماليات تتراكم بـnumber بدل decimal. ابحث عن toFixed مستعملاً للحفظ (لا للعرض). اقرأ مسارات: حساب إجمالي الفاتورة، حساب باقي الأجل، حساب الخصومات، تحويل العملات إن وُجد.` },
  { key: 'atomicity', prompt: `**عدسة الذرّية:** اقرأ كل service يكتب جدولين+. هل ملفوف بـwithTx؟ هل withTx يستدعي شيئاً قد يُلقي بعد بداية الكتابة (طباعة، fetch، setTimeout، تحقّق مكلف)؟ هل يوجد مسار يُحدّث رصيد + يكتب قيداً + يُحدّث currentBalance بـthree DB calls منفصلة بلا withTx؟ قدّم سيناريو فشل واقعي لكل ملاحظة.` },
  { key: 'concurrency', prompt: `**عدسة التزامن:** ابحث عن read-modify-write على branchStock/cashRegister/currentBalance/invoiceNumber بلا قفل (.for('update') في Drizzle) أو optimistic version. اقرأ توليد invoiceNumber/poNumber — هل عدّاد فيه سباق؟ سيناريو: بائعان يبيعان آخر قطعة، أو فاتورتان نقديتان متزامنتان على نفس الوردية.` },
  { key: 'idempotency', prompt: `**عدسة Idempotency:** ابحث بـGrep عن «clientRequestId» في server/. أين يُستعمل؟ ابحث في drizzle/schema.ts عن UNIQUE(sourceType, sourceId) أو ما يكافئها. أي العمليات محمية: البيع/المرتجع/الشراء/الدفعة/التحويل/أمر الشغل؟ ابحث عن try/catch على ER_DUP_ENTRY. ماذا يحدث على retry بعد commit جزئي/كامل/فشل؟` },
  { key: 'sign-convention', prompt: `**عدسة إشارات الدفتر/الذمم:** اقرأ من الكود (لا من الاسم): هل قيد RETURN يُحفظ بـamount سالب؟ هل دفع المورد يخفّض suppliers.currentBalance أم يرفعه؟ هل دفع العميل يخفّض customers.currentBalance؟ هل قيد OPENING يستعمل نفس الاتفاقية كقيد عادي؟ ابحث عن مكان واحد يكسر الاتفاق (مثلاً service يحفظ بإشارة موجبة حيث الباقي سالب).` },
  { key: 'isolation-idor', prompt: `**عدسة عزل الفرع/IDOR:** لكل query/mutation في server/routers/* يأخذ معرّفاً (invoiceId/productId/customerId/movementId) من العميل، اقرأ الاستعلام Drizzle المُنفَّذ. هل يحوي where(eq(table.branchId, ctx.user.branchId))؟ ركّز: invoices، invoiceItems، inventoryMovements، branchStock، shifts، workOrders، expenses، payments. هل مستخدم فرع SALES يستطيع قراءة فاتورة فرع MAIN لو مرّر معرّفها؟` },
  { key: 'rbac-leakage', prompt: `**عدسة RBAC:** هل التكلفة محذوفة فعلياً من output الـtRPC للكاشير (redact في select أو في mapper)؟ أم تُرسَل في الاستجابة ويُخفى بالواجهة (تسرّب عبر devtools)؟ اقرأ productsRouter/variantsRouter/inventoryRouter/reportsRouter. ابحث عن endpoints حسّاسة (تعديل سعر، حذف، عكس) بدون procedure مناسبة (مثلاً تستعمل authProcedure حيث يلزم managerProcedure).` },
  { key: 'balance-drift', prompt: `**عدسة انجراف الأرصدة:** افحص ميدانياً: هل كل تحديث لـcustomers.currentBalance مصحوب بقيد journal مقابل؟ هل العكس صحيح؟ أين قد ينحرف الرصيد عن مجموع الفواتير-المدفوعات؟ ابحث عن: إلغاء فاتورة آجلة (إن وُجد) — هل يعكس currentBalance؟ تعديل يدوي للرصيد — هل يكتب قيداً؟ استيراد افتتاحي — قيد + تحديث متّسقان؟` },
  { key: 'inventory-invariants', prompt: `**عدسة لا-سلبية المخزون وbaseQuantity:** اقرأ applyMovement وكل من يستدعيه. هل baseQuantity دائماً int (تحقّق Math.round/floor/ceil أو int parsing)؟ هل branchStock يصبح سالباً (ابحث عن allowNegative أو غياب الحارس)؟ التحويل بين فرعين: هل خصم+إضافة ذرّيان في withTx واحد؟ ماذا لو فشلت الإضافة بعد الخصم؟ ماذا عن inventoryMovement من نوع ADJUSTMENT — من يستطيع تنفيذه؟` },
  { key: 'cash-shift', prompt: `**عدسة سلامة الصندوق/الوردية:** كيف تنسب فاتورة نقدية إلى shiftId؟ اقرأ الكود. ماذا لو أُنشئت بعد بدء closeShift بميلي ثانية (سباق)؟ هل expense.cashOut يخصم من وردية حالية ذرّياً؟ هل إلغاء مصروف (إن وُجد) يعكس بدقّة؟ هل closeShift يحجز سيولة لحظتها أم يحسبها بعدياً؟ هل يوجد فحص أنّ shift مفتوح قبل قبول بيع نقدي؟` },
  { key: 'cross-module-trace', prompt: `**عدسة تكامل الوحدات:** تتبَّع من الكود حرفياً (اقرأ الـservice فعلياً):\n١) deliver لأمر شغل → كم جدولاً يُكتب؟ كلّها داخل withTx واحد؟ ماذا لو فشل قيد journal بعد إنشاء invoice؟\n٢) استلام شراء جزئي → +branchStock + AP، هل المخزون يُحجز قبل إصدار قيد AP أو بالعكس؟\n٣) مرتجع كامل/جزئي → -invoice + +branchStock + قيد عكسي + currentBalance — كم استدعاء DB؟ هل سيناريو الفشل بالمنتصف يُلوّث الحالة؟\n٤) تحويل بين فرعين — حركتان في withTx واحد أم اثنان؟` },
  { key: 'auth-session', prompt: `**عدسة المصادقة والجلسة:** اقرأ تدفّق تسجيل الدخول وإصدار JWT والتحقّق. هل JWT يحوي branchId/role أم يُقرَأ من DB كل طلب؟ ماذا لو غيّر مدير دور كاشير — هل توكنه القديم يبقى صالحاً؟ هل سرّ JWT في .env فقط؟ هل الكوكي HttpOnly+SameSite+Secure (في prod)؟ هل CSRF محمي على المسارات الحسّاسة؟` },
  { key: 'sql-injection-input', prompt: `**عدسة حقن SQL ومدخلات غير موثوقة:** ابحث في server/ عن استعمالات sql.raw/sql\`\` بمعرّفات قادمة من العميل بلا فلتر. ابحث عن استعلامات يدوية (db.execute بـtemplate string) تحوي قيماً قادمة من input. هل zod schemas حازمة على routers (regex، length، enum)؟ هل ملفات الاستيراد (CSV/Excel) معالَجة بأمان (لا eval، لا path traversal)؟` },
  { key: 'audit-coverage', prompt: `**عدسة تغطية auditLogs:** بـGrep في server/ ابحث عن استدعاءات auditService.log أو ما يكافئه. لكل عملية كتابة حسّاسة (تغيير سعر، حذف فاتورة، عكس مرتجع، تعديل رصيد، تعطيل/إعادة كلمة مرور، تغيير دور، closeShift، تحويل، استيراد): هل تكتب سطر audit؟ ما الحقول المسجَّلة فعلياً؟ ما الفجوة بين الكتابات الحسّاسة والـaudit المرصودة؟` },
]

const probeResults = await pipeline(
  PROBE_LENSES,
  l => agent(`${FORBIDDEN_RULE}\n\n${l.prompt}\n\nخرائط المنطقة (موجزة، مشتقّة من الكود):\n${mapDigest}\n\nأنت محقّق عدائي رفيع. اقرأ الكود فعلياً (Read/Grep). افترض الكود مذنب حتى يثبت بريئه. لكل ملاحظة قدّم: ملف:سطر دقيق، الادعاء، اقتباس الدليل من الكود، التأثير العملي، سيناريو إعادة إنتاج إن أمكن. لا ملاحظة بلا مرجع كود حرفي. لا تستنتج «المنطقة آمنة» لأنّ لها اختباراً أو لأنّ التسمية توحي بذلك — اقرأ السلوك.`,
    { label: `probe:${l.key}`, phase: 'Probe', schema: FINDINGS_SCHEMA, effort: 'high' }),
  result => {
    if (!result || !result.findings || result.findings.length === 0) return { lens: result?.lens || 'unknown', findings: [] }
    return parallel(result.findings.map((f, i) => () =>
      agent(`${FORBIDDEN_RULE}\n\nأنت محقّق مضادّ متشكّك. حاول دحض هذه الملاحظة بقراءة الكود مباشرة:\n\nالعنوان: ${f.title}\nالخطورة المُقترحة: ${f.severity}\nالملف: ${f.file}\nالموقع: ${f.locator}\nالادعاء: ${f.claim}\nالدليل المُقدَّم: ${f.evidence}\nالتأثير: ${f.impact}\n\nاقرأ الملف فعلياً. هل الادعاء صحيح؟ أم يوجد ضمان (قيد فريد، withTx، حقل redacted في trpc output، فلتر branchId مُطبَّق، تعطيل افتراضي، تحقّق قبلي) يُبطل المخاوف؟\n\nافترض refuted=true عند الشكّ. غيّر revisedSeverity إلى not-a-bug إذا الدليل يكشف فهماً خاطئاً. لا تتساهل.`,
        { label: `verify:${result.lens.slice(0,18)}:${i}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' })
        .then(v => v ? ({ ...f, lens: result.lens, verdict: v }) : null)
        .catch(() => null)
    )).then(verdicts => ({ lens: result.lens, findings: verdicts.filter(Boolean) }))
  }
)

const allFindings = probeResults.filter(Boolean).flatMap(r => r.findings || [])
const confirmed = allFindings.filter(f => f.verdict && !f.verdict.refuted && f.verdict.revisedSeverity !== 'not-a-bug')
const refutedCount = allFindings.length - confirmed.length

log(`المرحلتان ٢-٣ اكتملتا: ${allFindings.length} ملاحظة خام → ${confirmed.length} مُؤكَّدة (${refutedCount} دُحضت أو خُفِّضت إلى not-a-bug)`)

// ============ Phase 4: Completeness Critique + gap-followup ============
phase('Critique')
log('المرحلة ٤: ناقد اكتمال ينظر فيما فاتنا، ثم جولة فجوات إضافية')

const criticDigest = JSON.stringify({
  areasCovered: validMaps.map(m => m.area),
  lensesRun: PROBE_LENSES.map(p => p.key),
  confirmedFindingsSample: confirmed.slice(0, 30).map(f => ({ title: f.title, severity: f.verdict.revisedSeverity || f.severity, file: f.file, lens: f.lens })),
}).slice(0, 18000)

const gaps = await agent(`${FORBIDDEN_RULE}\n\nأنت ناقد اكتمال متشكّك. الفريق دقّق نظاماً تقنياً عبر هذه الخرائط والعدسات وأكّد الملاحظات أدناه. سؤالك الوحيد: **ما الذي لم نطرحه؟**\n\n${criticDigest}\n\nاقرأ الكود (server/routers/* وserver/services/*) لاكتشاف:\n- وحدات/مسارات لم نتطرّق إليها (مثلاً: إغلاق سنة مالي، تسوية بنكية، تعديل بأثر رجعي، عربون، قسط مؤجَّل، خصم تسوية، فرق صرف، إلغاء فاتورة مدفوعة، مرتجع مرتجع، حذف منتج له حركات)\n- علاقات بين وحدات لم نتتبّعها (تأثير غير مباشر)\n- سيناريوهات مالية محتملة لم نُحاكِها\n\nأعطِ ٥-١٠ فجوات محدّدة قابلة للفحص بمرجع ملف ابتدائي.`,
  { label: 'critic:gaps', phase: 'Critique', schema: GAP_SCHEMA, effort: 'high' })

const gapList = (gaps && gaps.gaps) ? gaps.gaps : []
const topGaps = gapList.slice(0, 5)

const gapFindingsRaw = await parallel(topGaps.map((g, i) => () =>
  agent(`${FORBIDDEN_RULE}\n\nفجوة لم تُفحص: **${g.area}** — ${g.question}\nالسبب: ${g.why}\n\nافحصها الآن بصرامة. اقرأ الكود (Read/Grep)، اعطِ ملاحظات محدّدة بمراجع ملف:سطر. لا اختراع.`,
    { label: `gap:${i}:${g.area.slice(0,16)}`, phase: 'Critique', schema: FINDINGS_SCHEMA, effort: 'high' })
))

const gapConfirmed = gapFindingsRaw.filter(Boolean).flatMap(r => (r.findings || []).map(f => ({ ...f, lens: `gap:${r.lens}`, verdict: { refuted: false, confidence: 'medium', reasoning: 'gap-followup', revisedSeverity: f.severity } })))

log(`المرحلة ٤ اكتملت: ${gapList.length} فجوة محتملة → ${gapConfirmed.length} ملاحظة إضافية`)

// ============ Phase 5: Synthesize ============
phase('Synthesize')
log('المرحلة ٥: تجميع نهائي بترتيب الخطورة، المناطق السليمة، الشريحة التالية')

const allConfirmed = [...confirmed, ...gapConfirmed]
const synthPayload = allConfirmed.map(f => ({
  title: f.title,
  severity: (f.verdict && f.verdict.revisedSeverity) ? f.verdict.revisedSeverity : f.severity,
  file: f.file,
  locator: f.locator,
  claim: f.claim,
  impact: f.impact,
  lens: f.lens,
  confidence: f.verdict?.confidence || 'medium',
}))
const synthContext = JSON.stringify(synthPayload).slice(0, 60000)
const healthyHint = validMaps.map(m => m.area).join(', ')

const synthesis = await agent(`${FORBIDDEN_RULE}\n\nأنت رئيس فريق التدقيق. هذه الملاحظات المُؤكَّدة من فريق عدائي على نظام تقنيّ (لا تعتمد إلا على ما في القائمة، لا تستحضر أيّ توثيق). أنتج تقريراً نهائياً منظَّماً بالعربية الفصحى:\n\nالملاحظات المُؤكَّدة:\n${synthContext}\n\nالمناطق المفحوصة (مرشَّحة للحكم «سليمة» إن لم تظهر فيها ملاحظات حرجة بعد المسح): ${healthyHint}\n\nمتطلّباتك:\n- summary: ٢-٤ جمل تشخّص حالة السلامة العامة بناءً على البيانات أعلاه فقط\n- overallVerdict: حُكم نهائي صريح (سليم/يحتاج إصلاحات قبل التوسّع/خطر مالي جوهري)\n- criticalFindings: فقط ما خطورته critical، مع fix بسطر واحد\n- highFindings: high، مع fix بسطر واحد\n- mediumLowFindings: قائمة موجزة (title/file/severity فقط)\n- healthyAreas: المناطق التي صمدت أمام الهجوم بلا ملاحظات حرجة (صورة متوازنة لا قائمة عيوب فقط)\n- recommendedNextSlice: الشريحة التالية الأنسب للإصلاح\n\nاجمع المكرّرات، لا تضخّم، لا تبتر، كن صادقاً.`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA, effort: 'high' })

return {
  mapsCovered: validMaps.length,
  lensesRun: PROBE_LENSES.length,
  rawFindings: allFindings.length,
  refutedCount,
  confirmedFromProbe: confirmed.length,
  gapsIdentified: gapList.length,
  gapFindings: gapConfirmed.length,
  totalConfirmed: allConfirmed.length,
  synthesis,
}
