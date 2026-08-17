/**
 * تراجعُ إعادة محاولة الطيّ وشبكةُ الأمان البنيويّة — server/services/hrDevices/attendanceFold.ts
 *
 * بلا قاعدة (يُحقن `requireDb` مزيَّفاً) لأنّ المقيس هنا **توقيتٌ ومنطقُ تصنيف** لا SQL.
 *
 * العطب المحروس (تدقيق ١٧/٨): كل خطأٍ غير مُصنَّف كان يجدول إعادةً بعد **١٥ ثانية ثابتة أبداً**؛
 * وخطأٌ دائمُ التكرار (كقفل المسيّر الذي كان يُعدّ عابراً) يعني ٥٧٦٠ دورةً يومياً، كلٌّ منها
 * تمسح الدفعة كاملةً — عبءُ قاعدةٍ بلا فائدة، وتجويعُ البصمات الجديدة عند سقف الدفعة.
 *
 * الثوابت المحروسة (الاتجاهان):
 *   ب١) العابر الحقيقيّ **لا يوسَم** (يبقى قابلاً للإعادة) ويُجدوَل تراجعاً أُسّيّاً 15→30→60.
 *   ب٢) أوّلُ إعادةٍ تبقى ١٥ ثانية (استجابةٌ فورية للعطل القصير — لا انحدار في السرعة).
 *   ب٣) دورةٌ سليمة **تُصفّر** التراجع فيعود العطل التالي إلى ١٥ ثانية.
 *   ب٤) قفلُ المسيّر يُركن **ولو تغيّرت صياغة رسالته** في `attendanceService.ts` (ليس ملكية
 *       هذه الوحدة): السؤال يُوجَّه لجدول المسيّرات لا للنصّ.
 *   ب٥) وتعذُّرُ ذلك السؤال (انقطاع قاعدة) **لا** يُحوّل يوماً حيّاً إلى مركونٍ نهائيّ.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** يفرّغ سلسلة الـawait داخل دورة الطيّ (كلها microtasks — لا مؤقّتات حقيقية). */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

interface FakeDb {
  db: unknown;
  updates: Row[];
  /** عدد دورات الطيّ = عدد مرّات التقاط الدفعة المعلَّقة. */
  cycles: () => number;
}

/**
 * قاعدةٌ مزيَّفة تُوزّع النتائج **بهوية الجدول** لا بترتيب النداء، فلا ينكسر الاختبار
 * لمجرّد إضافة استعلامٍ للوحدة. مخطّطُها يُستورد ديناميكياً بعد `resetModules` كي تكون
 * كائناتُ الجداول هي نفسها التي تراها الوحدة تحت الاختبار.
 */
function makeFakeDb(
  schema: typeof import("../../../drizzle/schema"),
  opts: {
    pending: () => Row[];
    punchTimes: () => Row[];
    lockedRuns?: () => Row[];
    onUpdate?: () => void;
  },
): FakeDb {
  const updates: Row[] = [];
  let cycles = 0;
  const db = {
    select: (_projection?: unknown) => {
      let table: unknown;
      let limited = false;
      const rows = async (): Promise<Row[]> => {
        if (table === schema.hrAttendancePunches) {
          // الالتقاط المحدود = دفعة الطيّ؛ وغير المحدود = بصمات اليوم في punchTimesOf.
          if (!limited) return opts.punchTimes();
          cycles++;
          return opts.pending();
        }
        if (table === schema.employees) return [{ userId: null, workSchedule: null }];
        if (table === schema.payrollRuns) return opts.lockedRuns?.() ?? [];
        // إعدادات الاحتساب وحارس الإدخال اليدوي: فارغان ⇒ الافتراضيّات ولا تصحيح يدويّ.
        return [];
      };
      const q: Record<string, unknown> & PromiseLike<Row[]> = {
        from: (t: unknown) => {
          table = t;
          return q;
        },
        where: () => q,
        leftJoin: () => q,
        orderBy: () => q,
        limit: () => {
          limited = true;
          return rows();
        },
        then: (resolve, reject) => rows().then(resolve, reject),
      };
      return q;
    },
    update: () => ({
      set: (values: Row) => ({
        where: async () => {
          updates.push(values);
          opts.onUpdate?.();
          return [{ affectedRows: 1 }];
        },
      }),
    }),
  };
  return { db, updates, cycles: () => cycles };
}

const PUNCH_DAY = "2026-07-01";
const punchRow = { id: 1, employeeId: 1, punchAt: `${PUNCH_DAY} 08:00:00` };
const dayTimes = [{ punchAt: `${PUNCH_DAY} 08:00:00` }, { punchAt: `${PUNCH_DAY} 16:30:00` }];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock("../tx");
  vi.doUnmock("../../logger");
  vi.doUnmock("../attendanceService");
  vi.doUnmock("../appNotificationService");
});

/** يُركّب الوحدة تحت الاختبار على قاعدةٍ مزيَّفة وسلوكِ `recordAttendance` المطلوب. */
async function loadFold(opts: {
  record: () => Promise<{ id: number }>;
  pending: () => Row[];
  lockedRuns?: () => Row[];
  onUpdate?: () => void;
}) {
  const schema = await import("../../../drizzle/schema");
  const fake = makeFakeDb(schema, {
    pending: opts.pending,
    punchTimes: () => dayTimes,
    lockedRuns: opts.lockedRuns,
    onUpdate: opts.onUpdate,
  });
  vi.doMock("../tx", () => ({ requireDb: () => fake.db }));
  vi.doMock("../../logger", () => ({ logger }));
  vi.doMock("../attendanceService", () => ({ recordAttendance: vi.fn(opts.record) }));
  vi.doMock("../appNotificationService", () => ({ createAppNotification: vi.fn() }));
  const mod = await import("../hrDevices/attendanceFold");
  return { ...mod, fake };
}

const transientFailure = () => Promise.reject(new Error("temporary database outage"));

describe("تراجع إعادة المحاولة الأُسّيّ (ب١–ب٣)", () => {
  it("العابر لا يوسَم، وإعادةُ المحاولة 15→30→60 ثانية لا ١٥ ثابتة أبداً", async () => {
    let rows = [punchRow];
    const { processPendingFolds, stopAndDrainAttendanceFolds, fake } = await loadFold({
      record: transientFailure,
      pending: () => rows,
      onUpdate: () => {
        rows = [];
      },
    });
    try {
      await processPendingFolds();
      // ب١: البصمة بقيت معلَّقة (لا UPDATE) ⇒ لم يضِع يومٌ بسبب عطلٍ عابر.
      expect(fake.updates).toHaveLength(0);
      expect(fake.cycles()).toBe(1);

      // ب٢: أوّل إعادةٍ عند ١٥ ثانية بالضبط.
      await vi.advanceTimersByTimeAsync(14_999);
      await settle();
      expect(fake.cycles()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(fake.cycles()).toBe(2);

      // ب١: الثانية عند ٣٠ ثانية — لو بقيت ١٥ (العطب) لبدأت دورةٌ عند 14_999+1.
      await vi.advanceTimersByTimeAsync(29_999);
      await settle();
      expect(fake.cycles()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(fake.cycles()).toBe(3);

      // والثالثة عند ٦٠ ثانية (تضاعُفٌ لا ثبات).
      await vi.advanceTimersByTimeAsync(59_999);
      await settle();
      expect(fake.cycles()).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(fake.cycles()).toBe(4);
      expect(fake.updates).toHaveLength(0);
    } finally {
      await stopAndDrainAttendanceFolds();
    }
  });

  it("دورةٌ سليمة تُصفّر التراجع فيعود العطل التالي إلى ١٥ ثانية (ب٣)", async () => {
    let rows: Row[] = [punchRow];
    let failing = true;
    const { processPendingFolds, stopAndDrainAttendanceFolds, fake } = await loadFold({
      record: () => (failing ? transientFailure() : Promise.resolve({ id: 77 })),
      pending: () => rows,
      onUpdate: () => {
        rows = [];
      },
    });
    try {
      await processPendingFolds(); // عطلٌ عابر ⇒ التراجع صار ٣٠ ثانية للمرّة القادمة
      expect(fake.updates).toHaveLength(0);

      failing = false;
      await processPendingFolds(); // دورةٌ سليمة: اليوم كُتب والبصمة وُسمت
      expect(fake.updates).toHaveLength(1);
      expect(fake.updates[0].processNote).toBeNull();

      failing = true;
      rows = [punchRow];
      const before = fake.cycles();
      await processPendingFolds();
      // لولا التصفير لبقيت الإعادة عند ٣٠ ثانية فما فوق أبداً بعد أوّل عطل.
      await vi.advanceTimersByTimeAsync(14_999);
      await settle();
      expect(fake.cycles()).toBe(before + 1);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(fake.cycles()).toBe(before + 2);
    } finally {
      await stopAndDrainAttendanceFolds();
    }
  });
});

describe("شبكة الأمان البنيويّة لقفل المسيّر (ب٤–ب٥)", () => {
  it("يركن نهائياً ولو لم تطابق صياغةُ الرسالة أيّ نصّ معروف — السؤال للجدول لا للنصّ (ب٤)", async () => {
    let rows: Row[] = [punchRow];
    const { processPendingFolds, stopAndDrainAttendanceFolds, fake } = await loadFold({
      // صياغةٌ لا تشبه رسالة القفل الحالية إطلاقاً: تحاكي إعادة صياغةٍ في attendanceService.
      record: () => Promise.reject(new Error("payroll period is closed")),
      pending: () => rows,
      lockedRuns: () => [{ id: 5 }],
      onUpdate: () => {
        rows = [];
      },
    });
    try {
      const res = await processPendingFolds();
      expect(res).toEqual({ days: 0, parked: 1 });
      expect(fake.updates).toHaveLength(1);
      expect(fake.updates[0].processNote).toContain("شهر مقفل بمسيّر رواتب معتمد");
      expect(fake.updates[0].processNote).toContain("2026-07");
      expect(fake.updates[0].processedAt).toBeTruthy();
      // ولا حلقة: لا مؤقّت إعادةٍ معلّق بعد وسمٍ نهائيّ.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await stopAndDrainAttendanceFolds();
    }
  });

  it("تعذُّرُ سؤال جدول المسيّرات يبقي الخطأ عابراً ولا يَسِم يوماً حيّاً (ب٥)", async () => {
    const { processPendingFolds, stopAndDrainAttendanceFolds, fake } = await loadFold({
      record: () => Promise.reject(new Error("payroll period is closed")),
      pending: () => [punchRow],
      lockedRuns: () => {
        throw new Error("connection lost");
      },
    });
    try {
      const res = await processPendingFolds();
      expect(res).toEqual({ days: 0, parked: 0 });
      expect(fake.updates).toHaveLength(0); // لا وسم ⇒ اليوم ما زال قابلاً للاسترداد
      expect(vi.getTimerCount()).toBe(1); // وإعادةُ المحاولة مجدولة
    } finally {
      await stopAndDrainAttendanceFolds();
    }
  });
});
