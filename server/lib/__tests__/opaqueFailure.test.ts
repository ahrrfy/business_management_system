// الثابت الذي يحرسه هذا الملفّ: **رسالةٌ عامّة للمستخدم، سببٌ جذريٌّ كامل في السجلّ**.
// الطرفان لازمان معاً — رميٌ بلا تسجيل يمحو التشخيص (حادثة ٢١/٨: `Unknown column` عطّل كلّ
// مرتجعات الشراء ووصل المالكَ «تعذّر إتمام مرتجع الشراء» وحدها)، وتسريبُ SQL إلى الشاشة
// يكشف بنية القاعدة للكاشير.
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

const errorSpy = vi.fn();
vi.mock("../../logger", () => ({ logger: { error: (...args: unknown[]) => errorSpy(...args) } }));

const { failOpaque, rootCauseFields } = await import("../opaqueFailure");

const UNKNOWN_COLUMN = "Unknown column 'purchaseReturnSettlement' in 'field list'";
const QUERY = "insert into `purchaseReturns` (`purchaseReturnSettlement`) values (?)";

/** خطأ mysql2 حقيقيّ الشكل — هو ما ضاع في الحادثة. */
function mysqlError() {
  return Object.assign(new Error(UNKNOWN_COLUMN), {
    code: "ER_BAD_FIELD_ERROR",
    errno: 1054,
    sqlState: "42S22",
    sqlMessage: UNKNOWN_COLUMN,
    sql: "insert into `purchaseReturns` (`purchaseReturnSettlement`) values ('CREDIT')",
  });
}

/**
 * الشكل الذي يصل الراوتر فعلاً: drizzle 0.45 يلفّ خطأ mysql2 في `DrizzleQueryError`،
 * فتكون حقولُ mysql2 على `cause` ورسالةُ الغلاف `Failed query: …\nparams: …`.
 * (نُحاكيه بدل استيراد drizzle كي يبقى الاختبار وحدوياً بلا قاعدة.)
 */
function drizzleWrapped(inner: unknown = mysqlError(), params = "['CREDIT']") {
  return Object.assign(new Error(`Failed query: ${QUERY}\nparams: ${params}`), {
    name: "DrizzleQueryError",
    query: QUERY,
    params,
    cause: inner,
  });
}

describe("failOpaque", () => {
  // الخطأ المُمرَّر هنا بالشكل الملفوف — هو ما يصل الراوتر فعلاً من drizzle، لا خطأ mysql2 عارياً.
  it("يرمي رسالةً عامّة للمستخدم ويُسجّل السبب الجذريّ كاملاً", () => {
    errorSpy.mockClear();
    expect(() =>
      failOpaque(drizzleWrapped(), {
        op: "purchaseReturns.create",
        userMessage: "تعذّر إتمام مرتجع الشراء",
        context: { userId: 7, branchId: 1 },
      }),
    ).toThrow(TRPCError);

    try {
      failOpaque(drizzleWrapped(), { op: "purchaseReturns.create", userMessage: "تعذّر إتمام مرتجع الشراء" });
    } catch (thrown) {
      const e = thrown as TRPCError;
      expect(e.code).toBe("INTERNAL_SERVER_ERROR");
      // الرسالة الموجَّهة للشاشة تبقى عامّة: لا اسم عمودٍ ولا SQL.
      expect(e.message).toBe("تعذّر إتمام مرتجع الشراء");
      expect(e.message).not.toMatch(/purchaseReturnSettlement|insert into|ER_BAD_FIELD/);
    }

    const [payload, message] = errorSpy.mock.calls[0] as [Record<string, any>, string];
    expect(message).toContain("purchaseReturns.create");
    expect(payload.op).toBe("purchaseReturns.create");
    expect(payload.userId).toBe(7);
    expect(payload.branchId).toBe(1);
    // ما يجعل التشخيص ممكناً: اسمُ العمود وكودُ الخطأ والاستعلام.
    expect(payload.err.sqlMessage).toContain("purchaseReturnSettlement");
    expect(payload.err.code).toBe("ER_BAD_FIELD_ERROR");
    expect(payload.err.errno).toBe(1054);
    expect(payload.err.sql).toContain("insert into");
  });

  it("ينفذ إلى خطأ mysql2 الملفوف في DrizzleQueryError — لا يقرأ الإطار الأعلى وحده", () => {
    // الشكل الحقيقيّ في الإنتاج: `code`/`errno`/`sqlMessage` كلّها undefined في الأعلى.
    const wrapped = drizzleWrapped();
    expect((wrapped as any).code).toBeUndefined();
    expect((wrapped as any).sqlMessage).toBeUndefined();

    const fields = rootCauseFields(wrapped);
    expect(fields.code).toBe("ER_BAD_FIELD_ERROR");
    expect(fields.errno).toBe(1054);
    expect(fields.sqlState).toBe("42S22");
    expect(fields.sqlMessage).toContain("purchaseReturnSettlement");
    expect(fields.causeDepth).toBe(1);
    expect(fields.name).toBe("DrizzleQueryError");
  });

  it("يبلغ خطأ mysql2 عبر أكثر من غلاف، ولا يدور إلى ما لا نهاية على سلسلةٍ دائرية", () => {
    expect(rootCauseFields(drizzleWrapped(drizzleWrapped())).causeDepth).toBe(2);

    const a = new Error("غلاف أ") as Error & { cause?: unknown };
    const b = new Error("غلاف ب") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    const fields = rootCauseFields(a);
    expect(fields.causeDepth).toBeUndefined();  // لا خطأ قاعدة في السلسلة
    expect(fields.message).toBe("غلاف أ");
  });

  it("يقتطع الاستعلام ورسالةَ الغلاف الضخمة ويُعلن الاقتطاع بدل إغراق السجلّ صامتاً", () => {
    const huge = Object.assign(new Error("boom"), { sql: "x".repeat(5000), errno: 1064 });
    const fields = rootCauseFields(huge);
    expect((fields.sql as string).length).toBe(2000);
    expect(fields.sqlTruncated).toBe(5000);

    // رسالة DrizzleQueryError تحمل الاستعلام **والقيم** كاملةً ⇒ تُقتطع هي الأخرى.
    const fat = rootCauseFields(drizzleWrapped(mysqlError(), "y".repeat(9000)));
    expect((fat.message as string).length).toBe(2000);
    expect(fat.messageTruncated).toBeGreaterThan(9000);
  });

  it("يتحمّل ما ليس كائنَ خطأ (throw لنصّ أو null) بلا أن يرمي هو نفسه", () => {
    expect(rootCauseFields("انفجار نصّي").message).toBe("انفجار نصّي");
    expect(rootCauseFields(null).message).toBe("null");
    const plain = rootCauseFields(new Error("عاديّ"));
    expect(plain.message).toBe("عاديّ");
    expect(plain.sql).toBeUndefined();
  });
});
