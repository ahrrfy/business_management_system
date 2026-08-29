import { describe, expect, it } from "vitest";
import { enqueuePostCommit, withTx } from "../tx";

/**
 * ن-٢-هـ (Codex ٢٩/٨) — بيان صحّة لِـ post-commit hooks المركزيّة على `withTx`.
 * تمنع الانحدار حين يُضاف مُستدعٍ جديد لأيّ خدمة تعتمد `enqueuePostCommit` (مثلاً
 * `createSystemPaymentRequestTx` ⇒ `notifyApprovalPendingByReceipt`) — إن كسر
 * أحدُهم دلاليّةَ الطابور فسقط اختباران على الأقلّ.
 */
describe("withTx post-commit hooks", () => {
  it("fires hooks in registration order after commit", async () => {
    const order: string[] = [];
    await withTx(async (tx) => {
      enqueuePostCommit(tx, () => {
        order.push("first");
      });
      enqueuePostCommit(tx, async () => {
        await Promise.resolve();
        order.push("second");
      });
      enqueuePostCommit(tx, () => {
        order.push("third");
      });
    });
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("does NOT fire hooks when the transaction rolls back", async () => {
    let fired = false;
    await expect(
      withTx(async (tx) => {
        enqueuePostCommit(tx, () => {
          fired = true;
        });
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow("intentional rollback");
    expect(fired).toBe(false);
  });

  it("does NOT propagate a hook failure — fail-open contract", async () => {
    let secondRan = false;
    await withTx(async (tx) => {
      enqueuePostCommit(tx, () => {
        throw new Error("hook failure — must be swallowed");
      });
      enqueuePostCommit(tx, () => {
        secondRan = true;
      });
    });
    expect(secondRan).toBe(true);
  });

  it("clears the hook queue after draining (no accidental replay)", async () => {
    let count = 0;
    await withTx(async (tx) => {
      enqueuePostCommit(tx, () => {
        count += 1;
      });
    });
    // Second empty withTx call must not re-fire the previous hook.
    await withTx(async () => {});
    expect(count).toBe(1);
  });
});
