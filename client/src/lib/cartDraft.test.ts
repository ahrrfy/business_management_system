import { describe, expect, it } from "vitest";
import {
  discardLegacyPosDrafts,
  loadPosTabsDraft,
  posTabsDraftKey,
  savePosTabsDraft,
  type PosDraftScope,
} from "./cartDraft";

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

const shiftA: PosDraftScope = { branchId: 1, userId: 10, shiftId: 100 };

describe("عزل مسودات نقطة البيع", () => {
  it("يعزل السلة بين المستخدمين والورديات حتى على الفرع والجهاز نفسيهما", () => {
    const storage = new MemoryStorage();
    const tabs = [{ id: 1, cart: [{ sku: "A" }] }];
    savePosTabsDraft(storage, shiftA, tabs, 1);

    expect(loadPosTabsDraft(storage, shiftA)).toEqual({ tabs, activeId: 1 });
    expect(loadPosTabsDraft(storage, { ...shiftA, userId: 11 })).toBeNull();
    expect(loadPosTabsDraft(storage, { ...shiftA, shiftId: 101 })).toBeNull();
  });

  it("يرفض حمولة تحمل نطاقاً مختلفاً حتى لو وُضعت قسراً تحت المفتاح الصحيح", () => {
    const storage = new MemoryStorage();
    storage.setItem(posTabsDraftKey(shiftA), JSON.stringify({
      version: 2,
      scope: { ...shiftA, userId: 99 },
      tabs: [{ id: 1, cart: [{ sku: "LEAK" }] }],
      activeId: 1,
      savedAt: Date.now(),
    }));

    expect(loadPosTabsDraft(storage, shiftA)).toBeNull();
  });

  it("يتلف مفاتيح الفرع القديمة مجهولة المستخدم والوردية ولا يهاجرها", () => {
    const storage = new MemoryStorage();
    storage.setItem("alroya.posTabs.b1", JSON.stringify({ tabs: [{ cart: ["old"] }] }));
    storage.setItem("alroya.cartDraft.b1", JSON.stringify({ cart: ["old"] }));

    discardLegacyPosDrafts(storage, 1);

    expect(storage.getItem("alroya.posTabs.b1")).toBeNull();
    expect(storage.getItem("alroya.cartDraft.b1")).toBeNull();
    expect(loadPosTabsDraft(storage, shiftA)).toBeNull();
  });
});
