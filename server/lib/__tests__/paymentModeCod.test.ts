/**
 * paymentMode='COD' — يُتجاوز فحصُ حدّ الائتمان (Slice 3، ٢٨/٨/٢٦، هجرة 0276).
 *
 * البلاغ الأصليّ (المالك): «النظام يمنع الموظف من إنشاء طلبٍ لعميلٍ لا نعرفه» — كان
 * `creditLimit='0'` (الافتراضيّ لكلّ عميلٍ جديد) يحظر أيّ فاتورة غير مدفوعة، بينما COD
 * ليس ائتماناً بل تأجيلٌ لساعاتٍ (المندوب يحمل المال).
 *
 * الاختبار: مع paymentMode='COD' يجب ألا يُلمَس صفّ العميل إطلاقاً — فلا فحص، لا رمي،
 * حتى لو كان creditLimit='0'.
 */
import { describe, it, expect, vi } from "vitest";
import { assertCreditLimit } from "../credit";

/** tx شكليّ: كلّ استدعاءٍ للـselect يفشل الاختبار (لا يجب أن يُلمَس مع COD). */
function makeThrowingTx() {
  const forbidden = () => {
    throw new Error("لا ينبغي أن يُستعلَم عن العميل عند paymentMode='COD' — يُتجاوز الفحص كلّياً");
  };
  return {
    select: forbidden,
  } as unknown as Parameters<typeof assertCreditLimit>[0];
}

/** tx شكليّ للمقارنة: يُحصي كم مرّةً استُدعي `.select()`. */
function makeCountingTx() {
  const rowsFor = { creditLimit: "0", currentBalance: "0" };
  const from = vi.fn(() => ({ where: vi.fn(() => ({ for: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([rowsFor]) })) })) }));
  const select = vi.fn(() => ({ from }));
  return { select } as unknown as Parameters<typeof assertCreditLimit>[0];
}

describe("assertCreditLimit — paymentMode='COD' يُتجاوز الفحص", () => {
  it("لا يستعلم عن صفّ العميل حين paymentMode='COD' (مبلغ موجب)", async () => {
    const tx = makeThrowingTx();
    // مبلغٌ موجب صريح ⇒ الفحص كان سيفشل لولا paymentMode='COD' يُتجاوزه قبل أيّ استعلام.
    await expect(
      assertCreditLimit(tx, 999, "50000", 1, "COD"),
    ).resolves.toBeUndefined();
  });

  it("يعبُر بلا فحصٍ حتى مع مبلغٍ ضخم (لا سقفٌ يوقفه)", async () => {
    const tx = makeThrowingTx();
    await expect(
      assertCreditLimit(tx, 999, "10000000", 1, "COD"),
    ).resolves.toBeUndefined();
  });

  it("لا يزال يعبُر عندما `add ≤ 0` (السلوك السابق مصون: صفر ⇒ صفر فحص)", async () => {
    const tx = makeThrowingTx();
    await expect(assertCreditLimit(tx, 999, "0", 1, "COD")).resolves.toBeUndefined();
    // بلا paymentMode أيضاً (السلوك القديم): صفر ⇒ صفر فحص.
    await expect(assertCreditLimit(tx, 999, "0", 1)).resolves.toBeUndefined();
  });
});

describe("assertCreditLimit — paymentMode='PREPAID'/'CREDIT'/غياب يُطبِّق الفحص كالمعتاد", () => {
  it("PREPAID مع مبلغ موجب ⇒ يستعلم عن صفّ العميل (لا يُتجاوز)", async () => {
    const tx = makeCountingTx() as unknown as { select: ReturnType<typeof vi.fn> };
    // creditLimit='0' في mock ⇒ يجب أن يرمي FORBIDDEN («نقديّ فقط»).
    await expect(
      assertCreditLimit(tx as never, 999, "50000", 1, "PREPAID"),
    ).rejects.toThrow(/نقدي/);
    expect(tx.select).toHaveBeenCalledTimes(1);
  });

  it("CREDIT مع مبلغ موجب ⇒ يستعلم عن صفّ العميل (لا يُتجاوز)", async () => {
    const tx = makeCountingTx() as unknown as { select: ReturnType<typeof vi.fn> };
    await expect(
      assertCreditLimit(tx as never, 999, "50000", 1, "CREDIT"),
    ).rejects.toThrow(/نقدي/);
    expect(tx.select).toHaveBeenCalledTimes(1);
  });

  it("paymentMode غير مُمرَّر (undefined) ⇒ سلوكٌ كسابق (يستعلم كالمعتاد)", async () => {
    const tx = makeCountingTx() as unknown as { select: ReturnType<typeof vi.fn> };
    await expect(assertCreditLimit(tx as never, 999, "50000", 1)).rejects.toThrow(/نقدي/);
    // (تم رفض paymentMode='COD' في تجاوز الفحص، هذا الاختبار يتحقّق أنّ غياب paymentMode لا يُعطّل الفحص القديم)
    expect(tx.select).toHaveBeenCalledTimes(1);
  });
});
