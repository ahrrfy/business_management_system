import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn(), warn: vi.fn() } }));
import {
  ReceptionResumeDraft,
  type ReceptionResumeDraftInput,
} from "../ReceptionResumeDraft";

function fixture(previous: number | null, status = "OPEN") {
  const changed = vi.fn();
  const data = {
    id: 2,
    version: 1,
    status,
    lines: [],
    customerId: null,
    contactName: "",
    contactPhone: "",
    priceTier: "RETAIL",
    draftNumber: "DR-2",
    heldTotal: "0",
  };
  const known = {
    branchId: 1,
    offline: false,
    activeDraftRef: {
      current: previous == null ? null : { id: previous, version: 1 },
    },
    phoneResolution: "RESOLVED",
    phoneCustomer: { isPending: false },
    couponPreview: { isPending: false },
    draftResumeEpochRef: { current: 0 },
    draftSyncTimer: { current: null },
    draftSyncQueueRef: { current: null },
    workspaceDirty: false,
    flushActiveDraft: vi
      .fn()
      .mockResolvedValue({ ok: true, draftId: previous }),
    utils: {
      reception: { draftGet: { fetch: vi.fn().mockResolvedValue(data) } },
    },
    prevCustomerIdRef: { current: null },
    onPaymentScopeChanged: changed,
  };
  const input = new Proxy(known, {
    get: (target, name) =>
      name in target ? Reflect.get(target, name) : vi.fn(),
  }) as unknown as ReceptionResumeDraftInput;
  return { input, changed };
}
describe("successful draft switches isolate confirmed tender scope", () => {
  it("invalidates the payment scope once when another draft is actually installed", async () => {
    const { input, changed } = fixture(1);
    expect(await ReceptionResumeDraft(input, 2)).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    expect(input.activeDraftRef.current?.id).toBe(2);
  });
  it("preserves the current payment scope when opening the other draft fails", async () => {
    const { input, changed } = fixture(1, "COMMITTED");
    expect(await ReceptionResumeDraft(input, 2)).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });
  it.each([null, 2])(
    "preserves the same basket during promotion or forced reload (previous=%s)",
    async (previous) => {
      const { input, changed } = fixture(previous);
      expect(await ReceptionResumeDraft(input, 2, () => true, true)).toBe(true);
      expect(changed).not.toHaveBeenCalled();
    },
  );
});
