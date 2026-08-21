// الثابت الذي يحرسه هذا الملفّ: **رسالةٌ عامّة للمستخدم، سببٌ جذريٌّ كامل في السجلّ**.
// الطرفان لازمان معاً — رميٌ بلا تسجيل يمحو التشخيص (حادثة ٢١/٨: `Unknown column` عطّل كلّ
// مرتجعات الشراء ووصل المالكَ «تعذّر إتمام مرتجع الشراء» وحدها)، وتسريبُ SQL إلى الشاشة
// يكشف بنية القاعدة للكاشير.
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

const errorSpy = vi.fn();
vi.mock("../../logger", () => ({ logger: { error: (...args: unknown[]) => errorSpy(...args) } }));

const { failOpaque, rootCauseFields } = await import("../opaqueFailure");

/** خطأ mysql2 حقيقيّ الشكل — هو ما ضاع في الحادثة. */
function mysqlError() {
  return Object.assign(new Error("Unknown column 'purchaseReturnSettlement' in 'field list'"), {
    code: "ER_BAD_FIELD_ERROR",
    errno: 1054,
    sqlState: "42S22",
    sqlMessage: "Unknown column 'purchaseReturnSettlement' in 'field list'",
    sql: "insert into `purchaseReturns` (`purchaseReturnSettlement`) values ('CREDIT')",
  });
}

describe("failOpaque", () => {
  it("يرمي رسالةً عامّة للمستخدم ويُسجّل السبب الجذريّ كاملاً", () => {
    errorSpy.mockClear();
    expect(() =>
      failOpaque(mysqlError(), {
        op: "purchaseReturns.create",
        userMessage: "تعذّر إتمام مرتجع الشراء",
        context: { userId: 7, branchId: 1 },
      }),
    ).toThrow(TRPCError);

    try {
      failOpaque(mysqlError(), { op: "purchaseReturns.create", userMessage: "تعذّر إتمام مرتجع الشراء" });
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

  it("يقتطع الاستعلام الضخم ويُعلن الاقتطاع بدل إغراق السجلّ صامتاً", () => {
    const huge = Object.assign(new Error("boom"), { sql: "x".repeat(5000) });
    const fields = rootCauseFields(huge);
    expect((fields.sql as string).length).toBe(2000);
    expect(fields.sqlTruncated).toBe(5000);
  });

  it("يتحمّل ما ليس كائنَ خطأ (throw لنصّ أو null) بلا أن يرمي هو نفسه", () => {
    expect(rootCauseFields("انفجار نصّي").message).toBe("انفجار نصّي");
    expect(rootCauseFields(null).message).toBe("null");
    const plain = rootCauseFields(new Error("عاديّ"));
    expect(plain.message).toBe("عاديّ");
    expect(plain.sql).toBeUndefined();
  });
});
