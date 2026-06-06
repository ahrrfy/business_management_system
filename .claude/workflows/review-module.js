export const meta = {
  name: 'review-module',
  description: 'مراجعة عدائية متعددة العدسات + كشف نواقص لوحدة/منطقة (للقراءة فقط، بلا تعارض)، ثم تأكيد كل ملاحظة',
  phases: [
    { title: 'Review', detail: 'عدسات متوازية تبحث عن أخطاء حقيقية في الكود الفعلي' },
    { title: 'Gap', detail: 'ناقد اكتمال يكتشف الشاشات/التدفّقات/الاختبارات الناقصة' },
    { title: 'Synthesize', detail: 'تأكيد/رفض كل ملاحظة ودمج النواقص في قائمة قابلة للتنفيذ' },
  ],
}

// args = { title?: string, paths?: string[], goal?: string }
const t = args ?? {}
const title = t.title ?? 'الوحدة الحالية'
const paths = Array.isArray(t.paths) && t.paths.length ? t.paths.join('\n- ') : '(حدّد paths في args)'
const goal = t.goal ?? ''

const CTX = `راجع التنفيذ الفعلي لوحدة «${title}» في نظام إدارة أعمال الرؤية العربية (tRPC + drizzle mysql2 + React).
أولاً اقرأ D:\\business_management_system\\CLAUDE.md للاتفاقيات الحاكمة (الذرّية withTx، الأموال decimal، المخزون بالوحدة الأساس، الدفتر/الذمم، القاعدة: خلفية+واجهة+تحقق=١٠٠٪).
ثم اقرأ الملفات:
- ${paths}
${goal ? `الهدف المرجو من الوحدة: ${goal}` : ''}
أبلغ عن أخطاء **حقيقية** فقط (تكسر ثابتاً/تفسد بيانات/تخالف اتفاقية)، لا ملاحظات أسلوبية.`

const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['lens', 'findings'],
  properties: {
    lens: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'severity', 'file', 'problem', 'evidence', 'fix'],
        properties: {
          title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' }, problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' },
        },
      },
    },
  },
}

const lenses = [
  { k: 'correctness-atomicity', f: 'الصحّة والذرّية: عمليات خارج withTx، سباقات، أخطاء منطق/حالات حافة.' },
  { k: 'money-ledger', f: 'الأموال والدفتر: تسرّب float، تقريب، إشارات، ذمم AR/AP، ازدواج حساب.' },
  { k: 'ui-wiring', f: 'الواجهة والربط: شاشة موصولة فعلاً بالـAPI؟ أخطاء حالة/تحميل/تحقق إدخال؟ تظهر في التنقّل؟' },
  { k: 'security-auth', f: 'الأمان: إجراءات محمية (protectedProcedure)، تسريب بيانات حساسة، تحقق المدخلات zod.' },
]

phase('Review')
const reviews = (await parallel(
  lenses.map((l) => () => agent(`${CTX}\n\nعدستك: **${l.k}** — ${l.f}\nأعد findings (قد تكون فارغة).`, { label: `review:${l.k}`, phase: 'Review', schema: FINDINGS }))
)).filter(Boolean)

phase('Gap')
const GAPS = {
  type: 'object', additionalProperties: false, required: ['gaps'],
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'kind', 'why'],
        properties: { title: { type: 'string' }, kind: { type: 'string', enum: ['screen', 'flow', 'test', 'unverified-claim', 'other'] }, why: { type: 'string' } },
      },
    },
  },
}
const gaps = await agent(
  `${CTX}\n\nأنت ناقد الاكتمال. بحسب القاعدة (خلفية+واجهة+تحقق=١٠٠٪)، ما الناقص في «${title}» ليكون شريحة رأسية كاملة؟ شاشة إدخال؟ تدفّق غير مكتمل؟ اختبار مفقود؟ ادعاء غير مُتحقَّق؟`,
  { label: 'gap-find', phase: 'Gap', schema: GAPS }
)

phase('Synthesize')
const VERDICT = {
  type: 'object', additionalProperties: false, required: ['confirmed', 'rejected', 'missing', 'summary'],
  properties: {
    confirmed: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'severity', 'file', 'fix'], properties: { title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, file: { type: 'string' }, fix: { type: 'string' } } } },
    rejected: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'whyFalse'], properties: { title: { type: 'string' }, whyFalse: { type: 'string' } } } },
    missing: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}
const verdict = await agent(
  `${CTX}\n\nأنت المحقّق العدائي. إليك ملاحظات العدسات والنواقص (JSON):\nFINDINGS: ${JSON.stringify(reviews.flatMap((r) => r.findings.map((f) => ({ ...f, lens: r.lens }))))}\nGAPS: ${JSON.stringify(gaps?.gaps ?? [])}\nتحقّق من كل ملاحظة بقراءة الكود واحكم: خطأ حقيقي (confirmed) أم إيجابية كاذبة (rejected). ادمج المكرّر. أعد المؤكَّد مرتّباً بالخطورة، والنواقص (missing) المؤكَّدة، وملخّصاً وحكماً على نسبة اكتمال الوحدة.`,
  { label: 'synthesize', phase: 'Synthesize', schema: VERDICT }
)

return { reviewedLenses: reviews.length, verdict }
