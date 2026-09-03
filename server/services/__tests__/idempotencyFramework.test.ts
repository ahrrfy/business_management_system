// إطار idempotency الموحّد (#٥): hash الحمولة القانونيّ + CONFLICT عند «نفس المفتاح بحمولةٍ مختلفة».
import { describe, expect, it } from "vitest";
import {
  checkIdempotency,
  idempotencyHash,
  legacyIdempotencyHash,
  recordIdempotencyKey,
  withIdempotency,
} from "../idempotency";
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

/**
 * بلاغ الإنتاج ٣/٩/٢٦ «حمولة الطلب لا تطابق بصمتها المحفوظة»: كلّ مستهلكٍ يبصم كائن JS الخامّ ثمّ
 * يخزّنه في عمود JSON (`JSON.stringify`) ويتحقّق على ما قرأه. `undefined` يصل من الواجهة عبر
 * superjson ويبقى بعد zod، وكان يُبصَم `"key":null` بينما التخزين يُسقطه ⇒ بصمتان مختلفتان.
 */
describe("idempotencyHash — مستقرّ عبر رحلة التخزين في عمود JSON", () => {
  const stored = (v: unknown) => JSON.parse(JSON.stringify(v));

  it("مفتاح بقيمة undefined = غيابه = ما بعد التخزين (حمولة مرتجع البيع حرفياً)", () => {
    const fromWire = {
      lines: [{ invoiceItemId: 1, baseQuantity: 1 }],
      refund: undefined,
      resolution: undefined,
      restock: true,
    };
    expect(idempotencyHash(fromWire)).toBe(idempotencyHash(stored(fromWire)));
    expect(idempotencyHash(fromWire)).toBe(
      idempotencyHash({ lines: [{ invoiceItemId: 1, baseQuantity: 1 }], restock: true }),
    );
    // null قيمةٌ حقيقية تُخزَّن وتُقرأ — تبقى مميّزةً عن الغياب.
    expect(idempotencyHash({ a: 1, b: undefined })).not.toBe(idempotencyHash({ a: 1, b: null }));
    // متداخلاً أيضاً (refund.shiftId: undefined).
    const nested = { refund: { amount: "10.00", method: "CASH", shiftId: undefined } };
    expect(idempotencyHash(nested)).toBe(idempotencyHash(stored(nested)));
  });

  it("Date تُبصَم كنصّ ISO كما تُخزَّن — وتاريخان مختلفان بصمتان مختلفتان", () => {
    const at = new Date("2026-09-03T00:00:00.000Z");
    expect(idempotencyHash({ at })).toBe(idempotencyHash({ at: at.toISOString() }));
    expect(idempotencyHash({ at })).not.toBe(idempotencyHash({ at: new Date("2026-09-04T00:00:00.000Z") }));
  });

  it("متّجه مثبَّت: قيمة JSON خالصة تحتفظ ببصمتها القديمة — البصمات المخزَّنة قبل الإصلاح تبقى صالحة", () => {
    // sha256 لـ {"a":1,"b":[1,2]} كما كانت الدالّة القديمة تُنتجه حرفياً.
    expect(idempotencyHash({ b: [1, 2], a: 1 })).toBe(
      "8baa73198470c7bb4c3ce142a8fd651affc0310d878bb9bd159e37a573fb4874",
    );
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

  // هجرة 0328 (بلاغ الإنتاج ٣/٩/٢٦): عرض العمود = عقد الراوترات (١٢٠) لا ٦٤ — مفتاح قرار الشاشة
  // `purchase-decision-PURCHASE_ORDER-<id>-approve-<uuid>` كان يسقط هنا بـER_DATA_TOO_LONG.
  // جسرُ الانتقال (Codex على #956، P1): مفتاحٌ سُجِّل **قبل** إصلاح ٣/٩/٢٦ ببصمةٍ قديمة لحمولةٍ
  // فيها undefined/Date (صفوف idempotencyKeys لا تحتفظ بالحمولة فلا يُصلحها سكربت). إعادةُ
  // المحاولة بعد النشر بنفس الحمولة يجب أن تُعيد replay لا CONFLICT — وإلّا أعاد الكاشير البيع
  // بمفتاحٍ جديد. وحمايةُ «نفس المفتاح بحمولةٍ مختلفة» تبقى قائمة.
  it("مفتاح ما قبل الإصلاح ببصمة قديمة: نفس الحمولة ⇒ replay، حمولة مختلفة ⇒ CONFLICT", async () => {
    const k = "idem-legacy-" + Date.now();
    const posPayload = { branchId: 1, deviceId: undefined, customerId: undefined, lines: [{ variantId: 1, quantity: "1" }] };
    const legacy = legacyIdempotencyHash(posPayload);
    expect(legacy).not.toBe(idempotencyHash(posPayload));
    await withTx((tx) => recordIdempotencyKey(tx, op, k, 777, legacy)); // كما كتبه الخادم القديم
    expect(await withTx((tx) => checkIdempotency(tx, op, k, idempotencyHash(posPayload)))).toBe(777);
    await expect(
      withTx((tx) => checkIdempotency(tx, op, k, idempotencyHash({ ...posPayload, lines: [{ variantId: 2, quantity: "9" }] }))),
    ).rejects.toThrow(/بحمولةٍ مختلفة/);
  });

  it("مفتاح بطول ١٢٠ محرفاً يُسجَّل ويُقرأ", async () => {
    const k = (`purchase-decision-PURCHASE_ORDER-${Date.now()}-approve-` + "0123456789abcdef".repeat(8)).slice(0, 120);
    expect(k).toHaveLength(120);
    await withTx((tx) => recordIdempotencyKey(tx, op, k, 120, null));
    expect(await withTx((tx) => checkIdempotency(tx, op, k))).toBe(120);
  });
});
