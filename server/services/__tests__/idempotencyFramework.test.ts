// إطار idempotency الموحّد (#٥): hash الحمولة القانونيّ + CONFLICT عند «نفس المفتاح بحمولةٍ مختلفة».
import { describe, expect, it } from "vitest";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey, withIdempotency } from "../idempotency";
import { withTx } from "../tx";

describe("idempotencyHash — قانونيّ ومستقرّ", () => {
  it("نفس المدخل ⇒ نفس الـhash؛ ترتيب المفاتيح لا يهمّ", () => {
    expect(idempotencyHash({ a: 1, b: 2 })).toBe(idempotencyHash({ b: 2, a: 1 }));
    expect(idempotencyHash({ a: 1, nested: { x: 1, y: 2 } })).toBe(idempotencyHash({ nested: { y: 2, x: 1 }, a: 1 }));
    expect(idempotencyHash([1, 2, 3])).toBe(idempotencyHash([1, 2, 3]));
  });
  it("حمولة مختلفة ⇒ hash مختلف", () => {
    expect(idempotencyHash({ amount: "10" })).not.toBe(idempotencyHash({ amount: "20" }));
    expect(idempotencyHash({ invoiceId: 1 })).not.toBe(idempotencyHash({ invoiceId: 2 }));
  });
  it("hex ٦٤ محرفاً", () => {
    expect(idempotencyHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("withIdempotency / checkIdempotency — DB", () => {
  const op = "test.idem";

  it("أول نداء يُشغّل، والثاني بنفس المفتاح+الحمولة يُعيد replay بنفس refId (لا يُعاد تشغيل run)", async () => {
    const k = "idem-A-" + Date.now();
    const payload = { invoiceId: 1, amount: "10" };
    const r1 = await withTx((tx) =>
      withIdempotency(tx, { operation: op, clientRequestId: k, payload }, async () => ({ refId: 111, result: "fresh" })),
    );
    expect(r1.replay).toBe(false);
    expect(r1.refId).toBe(111);
    expect(r1.result).toBe("fresh");

    let ranAgain = false;
    const r2 = await withTx((tx) =>
      withIdempotency(tx, { operation: op, clientRequestId: k, payload }, async () => {
        ranAgain = true;
        return { refId: 999, result: "should-not-run" };
      }),
    );
    expect(r2.replay).toBe(true);
    expect(r2.refId).toBe(111); // refId المخزّن لا 999
    expect(ranAgain).toBe(false); // run() لم يُنفَّذ ثانيةً
  });

  it("نفس المفتاح بحمولةٍ مختلفة ⇒ CONFLICT (كان يُعيد النتيجة القديمة صامتاً)", async () => {
    const k = "idem-B-" + Date.now();
    await withTx((tx) =>
      withIdempotency(tx, { operation: op, clientRequestId: k, payload: { amount: "10" } }, async () => ({ refId: 222 })),
    );
    await expect(
      withTx((tx) =>
        withIdempotency(tx, { operation: op, clientRequestId: k, payload: { amount: "999" } }, async () => ({ refId: 333 })),
      ),
    ).rejects.toThrow(/حمولةٍ مختلفة|CONFLICT/);
  });

  it("توافقٌ خلفيّ: مفتاحٌ سُجِّل بلا hash ⇒ checkIdempotency يعيد refId بلا CONFLICT", async () => {
    const k = "idem-C-" + Date.now();
    await withTx((tx) => recordIdempotencyKey(tx, op, k, 444)); // بلا hash (نمط قديم)
    const got = await withTx((tx) => checkIdempotency(tx, op, k, idempotencyHash({ any: "payload" })));
    expect(got).toBe(444); // لا CONFLICT رغم تمرير hash (المخزّن null)
  });

  it("بلا clientRequestId ⇒ لا فحص (null)", async () => {
    const got = await withTx((tx) => checkIdempotency(tx, op, null, idempotencyHash({ a: 1 })));
    expect(got).toBeNull();
  });
});
