export const meta = {
  name: 'build-slice',
  description: 'بناء شريحة رأسية كاملة إلى ١٠٠٪ بفريق وكلاء: عقد → كتّاب متوازون → تحقّق عدائي → كشف نواقص → إصلاح → دمج + بوّابة DoD',
  whenToUse: 'حين تريد إنجاز وحدة/شريحة (خلفية+واجهة) إلى جاهزية إنتاجية كاملة داخل جلسة معزولة واحدة.',
  phases: [
    { title: 'Contract', detail: 'معماري يثبّت عقد API↔UI وملكية الملفات (كاتب واحد لكل ملف)' },
    { title: 'Build', detail: 'كتّاب متوازون (عزل worktree) — ملف لكل كاتب ضدّ العقد' },
    { title: 'Verify', detail: 'مراجعة عدائية متعددة العدسات (review-module) — للقراءة فقط' },
    { title: 'Gap', detail: 'ناقد اكتمال DoD: شاشة/تنقّل/اختبار/ادعاء غير مُتحقَّق' },
    { title: 'Fix', detail: 'حلقة إصلاح محدودة — كاتب واحد لكل ملف + فحص/اختبار' },
    { title: 'Integrate', detail: 'القائد يصل الملفات الساخنة + فحص/اختبار/جولة بصرية + بوّابة DoD' },
  ],
}

// args = SLICE_SPEC: { sliceId, title, goal?, entities?, needsSchema?, needsSeed?, budget? }
const spec = args ?? {}
const sliceId = spec.sliceId || 'slice'
const title = spec.title || sliceId
const goal = spec.goal || ''
const ROUNDS = Number(spec.budget) || 3

const CLAUDE_MD = 'D:\\business_management_system\\CLAUDE.md'
const CONV = `اقرأ أولاً ${CLAUDE_MD} للاتفاقيات الحاكمة: الذرّية (كل عملية داخل withTx؛ throw ⇒ ROLLBACK)، ` +
  `الأموال عبر decimal.js + money.ts (ممنوع parseFloat/Number)، المخزون عبر inventoryService.applyMovement تحت قفل، ` +
  `الدفتر/الذمم تلقائياً، حماية الإجراءات بـ protectedProcedure + zod. القاعدة الحاكمة: خلفية+واجهة+فحص+تحقّق+تنقّل = ١٠٠٪. ` +
  `الشريحة المرجعية: server/services/workOrderService.ts + server/routers/workOrderRouter.ts.`

const HOT = ['server/routers.ts', 'client/src/App.tsx', 'client/src/components/AppLayout.tsx', 'drizzle/schema.ts', 'server/seed.ts']

// ───────────────────────── المخططات ─────────────────────────
const CONTRACT = {
  type: 'object', additionalProperties: false,
  required: ['sliceId', 'router', 'procedures', 'ownedFiles', 'hotFileEdits', 'screens'],
  properties: {
    sliceId: { type: 'string' },
    router: { type: 'object', additionalProperties: false, required: ['mountKey', 'file'], properties: { mountKey: { type: 'string' }, file: { type: 'string' } } },
    procedures: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['name', 'kind', 'input', 'output', 'protection', 'atomicity', 'money'],
        properties: {
          name: { type: 'string' }, kind: { type: 'string', enum: ['query', 'mutation'] },
          input: { type: 'string' }, output: { type: 'string' },
          protection: { type: 'string', enum: ['public', 'protected', 'admin'] },
          atomicity: { type: 'string' }, money: { type: 'string' },
        },
      },
    },
    ownedFiles: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['path', 'role', 'writer'],
        properties: { path: { type: 'string' }, role: { type: 'string', enum: ['service', 'router', 'page', 'test', 'helper'] }, writer: { type: 'string' } },
      },
    },
    hotFileEdits: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['file', 'edit'],
        properties: { file: { type: 'string', enum: HOT }, edit: { type: 'string' } },
      },
    },
    screens: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['path', 'route', 'navLabel', 'purpose'],
        properties: { path: { type: 'string' }, route: { type: 'string' }, navLabel: { type: 'string' }, purpose: { type: 'string' } },
      },
    },
  },
}
const WRITE_RESULT = {
  type: 'object', additionalProperties: false, required: ['file', 'status', 'exports', 'notes'],
  properties: {
    file: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    exports: { type: 'array', items: { type: 'string' } },
    contractDeviations: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}
const GAPS = {
  type: 'object', additionalProperties: false, required: ['gaps'],
  properties: {
    gaps: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['title', 'kind', 'file', 'why'],
        properties: { title: { type: 'string' }, kind: { type: 'string', enum: ['screen', 'nav', 'flow', 'test', 'unverified-claim', 'money', 'atomicity', 'other'] }, file: { type: 'string' }, why: { type: 'string' } },
      },
    },
  },
}
const DOD_GATE = {
  type: 'object', additionalProperties: false,
  required: ['backend', 'frontend', 'check', 'tests', 'nav', 'visual', 'pass', 'summary'],
  properties: {
    backend: { type: 'object', additionalProperties: false, required: ['ok', 'evidence'], properties: { ok: { type: 'boolean' }, evidence: { type: 'string' } } },
    frontend: { type: 'object', additionalProperties: false, required: ['ok', 'evidence'], properties: { ok: { type: 'boolean' }, evidence: { type: 'string' } } },
    check: { type: 'object', additionalProperties: false, required: ['ok', 'output'], properties: { ok: { type: 'boolean' }, output: { type: 'string' } } },
    tests: { type: 'object', additionalProperties: false, required: ['ok', 'output'], properties: { ok: { type: 'boolean' }, output: { type: 'string' } } },
    nav: { type: 'object', additionalProperties: false, required: ['ok', 'evidence'], properties: { ok: { type: 'boolean' }, evidence: { type: 'string' } } },
    visual: { type: 'object', additionalProperties: false, required: ['ok', 'evidence'], properties: { ok: { type: 'boolean' }, evidence: { type: 'string' } } },
    pass: { type: 'boolean' }, summary: { type: 'string' },
  },
}

// ───────────────────────── طور ٠: العقد ─────────────────────────
phase('Contract')
const contract = await agent(
  `${CONV}\n\nأنت المعماري. صمّم شريحة «${title}» (sliceId=${sliceId}).${goal ? ` الهدف: ${goal}.` : ''}` +
  `${spec.entities ? ` الكيانات/الجداول: ${spec.entities.join(', ')}.` : ''}\n` +
  `اقرأ الشريحة المرجعية (work-orders) وحدّد: مفتاح تركيب الراوتر وملفه؛ كل إجراء (اسم/نوع/مدخل zod نصاً/مخرج نصاً/حماية/قاعدة ذرّية/قاعدة أموال)؛ ` +
  `قائمة الملفات المملوكة (كاتب واحد لكل ملف، role منها)؛ تعديلات الملفات الساخنة المؤجَّلة للدمج (${HOT.join(', ')})؛ والشاشات (مسار/route/نص تنقّل/غرض).\n` +
  `قاعدة صارمة: لا تُدرج أي ملف ساخن ضمن ownedFiles.`,
  { label: 'architect', phase: 'Contract', schema: CONTRACT }
)

// تحقّق برمجي من العقد (لا وكيل): كاتب واحد لكل ملف + لا ملف ساخن مملوك.
const owned = (contract.ownedFiles || []).map((f) => f.path)
const dupes = owned.filter((p, i) => owned.indexOf(p) !== i)
const hotOwned = owned.filter((p) => HOT.includes(p.replace(/\\/g, '/')))
if (dupes.length) log(`⚠ عقد: ملفات مكرّرة (كاتبان لملف؟): ${dupes.join(', ')}`)
if (hotOwned.length) log(`⚠ عقد: ملف ساخن ضمن المملوكة (يجب أن يُدمج في الطور الأخير): ${hotOwned.join(', ')}`)
log(`العقد: ${contract.procedures.length} إجراء · ${owned.length} ملف مملوك · ${(contract.screens || []).length} شاشة`)

// ───────────────────────── طور ١: البناء ─────────────────────────
phase('Build')
const buildFiles = (contract.ownedFiles || []).filter((f) => !HOT.includes(f.path.replace(/\\/g, '/')))
const writes = (await parallel(
  buildFiles.map((f) => () => agent(
    `${CONV}\n\nأنت كاتب. نفّذ **هذا الملف فقط**: ${f.path} (role=${f.role}).\nالعقد (JSON): ${JSON.stringify(contract)}\n` +
    `التزم الاتفاقيات حرفياً. لا تلمس أي ملف آخر ولا الملفات الساخنة. إن احتجت ملفاً ساخناً، أعد status=blocked واذكر التعديل المطلوب في notes.`,
    { label: `write:${f.role}:${f.path.split('/').pop()}`, phase: 'Build', schema: WRITE_RESULT, isolation: 'worktree' }
  ))
)).filter(Boolean)

const blocked = writes.filter((w) => w.status === 'blocked')
const drift = writes.filter((w) => (w.contractDeviations || []).length)
if (blocked.length) log(`⚠ بناء: ملفات محجوبة (تحتاج ملفاً ساخناً): ${blocked.map((w) => w.file).join(', ')} — تُؤجَّل للطور الأخير`)
if (drift.length) log(`⚠ بناء: انحراف عن العقد في: ${drift.map((w) => w.file).join(', ')} — سيُعالَج في الإصلاح`)

const reviewPaths = [...buildFiles.map((f) => f.path), ...(contract.screens || []).map((s) => s.path)]
  .filter((v, i, a) => a.indexOf(v) === i)

// ───────────────────────── طور ٢: التحقّق العدائي (إعادة استخدام review-module) ─────────────────────────
phase('Verify')
let review
try {
  review = await workflow('review-module', { title, paths: reviewPaths, goal })
} catch (e) {
  log(`تعذّر استدعاء review-module مباشرة (${e?.message || e}) — تحقّق مضمّن بديل`)
  const FINDINGS = {
    type: 'object', additionalProperties: false, required: ['confirmed'],
    properties: { confirmed: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'severity', 'file', 'fix'], properties: { title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, file: { type: 'string' }, fix: { type: 'string' } } } } },
  }
  const lenses = ['الصحّة والذرّية (withTx/سباقات)', 'الأموال والدفتر (float/تقريب/ذمم)', 'الواجهة والربط (موصولة؟ حالات؟ تنقّل؟)', 'الأمان (protected/zod/تسريب)']
  const rs = (await parallel(lenses.map((l) => () => agent(
    `${CONV}\n\nراجع عدائياً «${title}» عبر العدسة: ${l}. الملفات: ${reviewPaths.join(', ')}. أبلغ confirmed (أخطاء حقيقية فقط).`,
    { label: `verify:${l.slice(0, 12)}`, phase: 'Verify', schema: FINDINGS }
  )))).filter(Boolean)
  review = { verdict: { confirmed: rs.flatMap((r) => r.confirmed), rejected: [], missing: [], summary: 'تحقّق مضمّن' } }
}
const verdict = review.verdict || { confirmed: [], missing: [], summary: '' }
log(`تحقّق: ${verdict.confirmed.length} مؤكَّد · ${(verdict.missing || []).length} ناقص`)

// ───────────────────────── طور ٣: كشف النواقص (DoD) ─────────────────────────
phase('Gap')
const gapsRes = await agent(
  `${CONV}\n\nأنت ناقد الاكتمال. العقد: ${JSON.stringify(contract)}\nملاحظات التحقّق: ${JSON.stringify(verdict)}\n` +
  `بحسب القاعدة (خلفية+واجهة+فحص+تحقّق+تنقّل=١٠٠٪)، عدّد النواقص الحقيقية في «${title}»: إجراء بلا شاشة؟ شاشة بلا مدخل في التنقّل؟ ` +
  `مسار أموال/ذرّية بلا اختبار؟ idempotency/قيد دفتر مفقود؟ حالات تحميل/خطأ/فارغ؟ ادعاء غير مُتحقَّق؟`,
  { label: 'dod-gap', phase: 'Gap', schema: GAPS }
)
const gaps = gapsRes.gaps || []
log(`نواقص DoD: ${gaps.length}`)

// ───────────────────────── طور ٤: حلقة الإصلاح ─────────────────────────
phase('Fix')
function groupByFile(items) {
  const m = new Map()
  for (const it of items) { const k = it.file || 'unknown'; if (!m.has(k)) m.set(k, []); m.get(k).push(it) }
  return [...m.entries()].map(([file, list]) => ({ file, list }))
}
let confirmed = verdict.confirmed || []
let pendingGaps = gaps
let cleanStreak = 0
for (let round = 0; round < ROUNDS && cleanStreak < 2; round++) {
  const fixable = [...confirmed, ...pendingGaps.map((g) => ({ title: g.title, severity: 'high', file: g.file, fix: g.why }))]
    .filter((f) => f.file && !HOT.includes(String(f.file).replace(/\\/g, '/')))
  const todo = groupByFile(fixable)
  if (!todo.length) { cleanStreak++; log(`جولة ${round + 1}: لا إصلاحات — نظيفة (${cleanStreak}/2)`); continue }

  await parallel(todo.map(({ file, list }) => () => agent(
    `${CONV}\n\nأنت مُصلِح. عالِج **هذا الملف فقط**: ${file}\nالملاحظات: ${JSON.stringify(list)}\nالعقد: ${JSON.stringify(contract)}\nطبّق الإصلاحات دون لمس ملفات أخرى.`,
    { label: `fix:${String(file).split('/').pop()}`, phase: 'Fix', schema: WRITE_RESULT, isolation: todo.length > 1 ? 'worktree' : undefined }
  )))

  // إعادة تحقّق مُوجَّهة لما تغيّر + فحص
  const re = await agent(
    `${CONV}\n\nأعد التحقّق العدائي بعد الإصلاح لملفات «${title}»: ${reviewPaths.join(', ')}. ثم نفّذ في الطرفية: pnpm check و pnpm test (الموجّه للشريحة إن أمكن). ` +
    `أبلغ confirmed المتبقّية + هل pnpm check نظيف + هل الاختبارات خضراء.`,
    {
      label: `recheck:${round + 1}`, phase: 'Fix',
      schema: {
        type: 'object', additionalProperties: false, required: ['confirmed', 'checkOk', 'testsOk'],
        properties: { confirmed: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'severity', 'file', 'fix'], properties: { title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, file: { type: 'string' }, fix: { type: 'string' } } } }, checkOk: { type: 'boolean' }, testsOk: { type: 'boolean' } },
      },
    }
  )
  confirmed = re.confirmed || []
  pendingGaps = []
  const criticals = confirmed.filter((f) => f.severity === 'critical' || f.severity === 'high')
  if (re.checkOk && re.testsOk && !criticals.length) cleanStreak++; else cleanStreak = 0
  log(`جولة ${round + 1}: check=${re.checkOk} tests=${re.testsOk} حرجة=${criticals.length} (نظيفة ${cleanStreak}/2)`)
}

// ───────────────────────── طور ٥: الدمج + بوّابة DoD ─────────────────────────
phase('Integrate')
const dod = await agent(
  `${CONV}\n\nأنت قائد الدمج (المُكامِل). الشريحة «${title}».\n` +
  `١) ادّعِ التكامل: شغّل في الطرفية: node scripts/coord.mjs claim _integration --hot (إن رُفض فجلسة أخرى تدمج — انتظر/نسّق).\n` +
  `٢) طبّق تعديلات الملفات الساخنة من العقد بالترتيب وتسلسلياً (أنت فقط): ${JSON.stringify(contract.hotFileEdits)} ` +
  `— تركيب الراوتر في server/routers.ts، المسار في client/src/App.tsx، مدخل التنقّل في client/src/components/AppLayout.tsx${spec.needsSeed ? '، وبذرة في server/seed.ts' : ''}.\n` +
  `٣) نفّذ pnpm check (كامل) و pnpm test؛ ثم جولة بصرية عبر أدوات preview: شغّل الخادم، سجّل الدخول، افتح مدخل التنقّل الجديد، جرّب التدفّق الأساسي (زر→خدمة→DB→عرض)، والتقط لقطة.\n` +
  `٤) املأ بوّابة DoD بأدلّة حقيقية فقط (لا تدّعِ نجاحاً بلا دليل). pass = AND لكل الأبعاد الستة.\n` +
  `٥) حرّر التكامل: node scripts/coord.mjs release _integration.`,
  { label: 'integrate+dod', phase: 'Integrate', schema: DOD_GATE }
)

log(dod.pass ? `✅ DoD مكتملة لـ «${title}» — جاهزة للالتزام على فرع الجلسة` : `⛔ DoD غير مكتملة — أبعاد ناقصة: ${['backend', 'frontend', 'check', 'tests', 'nav', 'visual'].filter((k) => !dod[k]?.ok).join(', ')}`)

return { sliceId, title, contract, verdict, gaps, dod, pass: dod.pass }
