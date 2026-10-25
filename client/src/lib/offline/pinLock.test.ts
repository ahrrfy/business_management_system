import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveOfflineProfile, setOfflinePin } from "./pinLock";
const state = vi.hoisted(() => ({
  profile: null as any,
  get: vi.fn(),
  put: vi.fn(),
  derivations: [] as Array<(value: ArrayBuffer) => void>,
  salt: 0,
  tail: Promise.resolve() as Promise<unknown>,
}));
vi.mock("./db", () => ({
  offlineDb: {
    profile: {
      get: (...args: any[]) => state.get(...args),
      put: (...args: any[]) => state.put(...args),
    },
    transaction: (_mode: string, _table: any, task: () => Promise<unknown>) => {
      const result = state.tail.then(task);
      state.tail = result.catch(() => {});
      return result;
    },
  },
}));
beforeEach(() => {
  state.profile = {
    key: "profile",
    companyId: 1,
    userId: 7,
    name: "الموظف الأول",
    role: "cashier",
    branchId: 2,
    pinSalt: null,
    pinHash: null,
    savedAt: "2026-10-25T10:00:00Z",
  };
  state.derivations = [];
  state.salt = 0;
  state.tail = Promise.resolve();
  state.get
    .mockReset()
    .mockImplementation(async () => structuredClone(state.profile));
  state.put.mockReset().mockImplementation(async (row) => {
    state.profile = structuredClone(row);
  });
  vi.stubGlobal("crypto", {
    getRandomValues: (array: Uint8Array) => array.fill(++state.salt),
    subtle: {
      importKey: async () => ({}),
      deriveBits: () =>
        new Promise<ArrayBuffer>((resolve) => state.derivations.push(resolve)),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
async function waitForDerivations(count: number) {
  await vi.waitFor(() => expect(state.derivations).toHaveLength(count));
}
function finish(index: number, value: number) {
  state.derivations[index](new Uint8Array(32).fill(value).buffer);
}
it("does not restore the previous employee after profile identity changes during derivation", async () => {
  const pending = setOfflinePin("1234");
  await waitForDerivations(1);
  state.profile = {
    ...state.profile,
    userId: 8,
    name: "الموظف الثاني",
    savedAt: "2026-10-25T10:01:00Z",
  };
  finish(0, 11);
  expect((await pending).ok).toBe(false);
  expect(state.profile.userId).toBe(8);
  expect(state.put).not.toHaveBeenCalled();
});
it("does not let an older pending PIN overwrite a newer committed PIN", async () => {
  const first = setOfflinePin("1234");
  await waitForDerivations(1);
  const second = setOfflinePin("5678");
  await waitForDerivations(2);
  finish(1, 22);
  expect((await second).ok).toBe(true);
  finish(0, 11);
  expect((await first).ok).toBe(false);
  expect(Array.from(state.profile.pinHash)).toEqual(Array(32).fill(22));
  expect(state.put).toHaveBeenCalledOnce();
});
it("preserves current profile details instead of writing the stale snapshot", async () => {
  const pending = setOfflinePin("1234");
  await waitForDerivations(1);
  await saveOfflineProfile({
    id: 7,
    companyId: 1,
    name: "اسم محدث",
    role: "manager",
    branchId: 3,
  });
  finish(0, 11);
  expect((await pending).ok).toBe(false);
  expect(state.profile).toMatchObject({
    name: "اسم محدث",
    role: "manager",
    branchId: 3,
  });
});
it("preserves an existing PIN only for the same company and employee", async () => {
  state.profile.pinSalt = new Uint8Array([1]);
  state.profile.pinHash = new Uint8Array([2]);
  await saveOfflineProfile({
    id: 7,
    companyId: 1,
    name: "نفس الموظف",
    role: "cashier",
    branchId: 2,
  });
  expect(state.profile.pinHash).toEqual(new Uint8Array([2]));
  await saveOfflineProfile({
    id: 7,
    companyId: 2,
    name: "شركة أخرى",
    role: "cashier",
    branchId: 2,
  });
  expect(state.profile.pinHash).toBeNull();
  expect(state.profile.pinSalt).toBeNull();
});
it("keeps validation and missing-profile failures free of writes", async () => {
  expect((await setOfflinePin("12")).ok).toBe(false);
  state.profile = null;
  expect((await setOfflinePin("1234")).ok).toBe(false);
  expect(state.derivations).toHaveLength(0);
  expect(state.put).not.toHaveBeenCalled();
});
