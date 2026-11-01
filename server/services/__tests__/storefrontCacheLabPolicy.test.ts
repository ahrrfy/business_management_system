import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  company: 1,
  rows: [] as any[],
  indexRead: vi.fn(),
  candidateReads: 0,
  pageReads: 0,
  stock: new Map<number, number>(),
  selected: [1],
  barcode: vi.fn(),
  availability: vi.fn(),
}));
vi.mock("../../tenancy/context", () => ({
  getCurrentCompanyId: () => fixture.company,
}));
vi.mock("../../db", () => ({
  getDb: () => ({
    select: (projection: Record<string, unknown>) => {
      const result = () => {
        if ("barcode" in projection) return fixture.indexRead();
        if ("isFeatured" in projection) {
          fixture.candidateReads++;
          return fixture.rows;
        }
        if ("description" in projection) {
          fixture.pageReads++;
          return fixture.rows.filter((r) =>
            fixture.selected.includes(r.productId),
          );
        }
        return [];
      };
      const q: any = {
        then: (ok: any, bad: any) =>
          Promise.resolve().then(result).then(ok, bad),
      };
      for (const method of [
        "from",
        "innerJoin",
        "leftJoin",
        "where",
        "groupBy",
        "orderBy",
        "limit",
      ])
        q[method] = () => q;
      return q;
    },
  }),
}));
vi.mock("../catalog/barcodeAliases", () => ({
  resolveBarcodeOwnerResult: (...args: any[]) => fixture.barcode(...args),
}));
vi.mock("../catalog/variantAvailability", () => ({
  loadVariantAvailability: (...args: any[]) => fixture.availability(...args),
}));
vi.mock("../storefrontContextService", () => ({
  requireActiveBranch: async (id: number) => id,
  requireStorefrontContext: async () => ({ branchId: 1 }),
}));
vi.mock("../../imageRoute", () => ({
  decodeDataUrl: vi.fn(),
  productImageUrl: vi.fn(),
  withPublicProductImageWidth: vi.fn(),
}));
vi.mock("../tx", () => ({ withTx: async (run: any) => run({}) }));
vi.mock("../salesPromotionService", () => ({
  loadPromotionRuleSnapshot: async () => ({}),
  resolvePromotionFromSnapshot: () => null,
}));

const row = (id: number, name: string) => ({
  productId: id,
  productUnitId: id,
  variantId: id,
  productName: name,
  storeTitle: null,
  brand: "Brand",
  categoryId: 1,
  category: "Stationery",
  barcode: String(id),
  price: "1000.00",
  conversionFactor: "1",
  unitName: "piece",
  isFeatured: false,
  hasImage: 0,
  description: null,
  variantKind: "STANDARD",
  isBundle: false,
});
const deferred = () => {
  let resolve!: (v: any) => void, reject!: (e: any) => void;
  const promise = new Promise<any>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("RUNTIME_LAB_READ_CACHE", "1");
  fixture.company = 1;
  fixture.rows = [row(1, "Pencil"), row(2, "Notebook"), row(3, "Marker")];
  fixture.stock = new Map([
    [1, 10],
    [2, 10],
    [3, 10],
  ]);
  fixture.selected = [1];
  fixture.candidateReads = 0;
  fixture.pageReads = 0;
  fixture.indexRead.mockReset().mockImplementation(async () => fixture.rows);
  fixture.barcode.mockReset().mockResolvedValue({ status: "NOT_FOUND" });
  fixture.availability.mockReset().mockImplementation(
    async (_db, _branch, ids: number[]) =>
      new Map(
        ids.map((id) => [
          id,
          {
            availableBase: fixture.stock.get(id) ?? 0,
            onHandBase: fixture.stock.get(id) ?? 0,
            reservedBase: 0,
            hasStockRow: true,
          },
        ]),
      ),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("actual index shares a deferred company load across different terms, isolates companies and expires at 5s", async () => {
  const { loadStorefrontSearchMatches: search } =
    await import("../storefrontSearchIndex");
  const read = deferred();
  fixture.indexRead.mockReturnValueOnce(read.promise);
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const pencil = search("Pencil"),
    notebook = search("Notebook");
  await new Promise(setImmediate);
  expect(fixture.indexRead).toHaveBeenCalledTimes(1);
  read.resolve(fixture.rows);
  expect((await pencil).map((r) => r.productId)).toEqual([1]);
  expect((await notebook).map((r) => r.productId)).toEqual([2]);
  fixture.company = 2;
  fixture.rows = [row(9, "Privatecompany")];
  expect(await search("Pencil")).toEqual([]);
  expect((await search("Privatecompany")).map((r) => r.productId)).toEqual([9]);
  fixture.company = 1;
  expect((await search("Pencil")).map((r) => r.productId)).toEqual([1]);
  expect(fixture.indexRead).toHaveBeenCalledTimes(2);
  now += 5_001;
  expect(await search("Pencil")).toEqual([]);
  expect(fixture.indexRead).toHaveBeenCalledTimes(3);
});
it("actual index rejects all coalesced waiters and retries a failed loader", async () => {
  const { loadStorefrontSearchMatches: search } =
    await import("../storefrontSearchIndex");
  const read = deferred();
  fixture.indexRead.mockReturnValueOnce(read.promise);
  const results = Promise.allSettled([search("Pencil"), search("Notebook")]);
  await new Promise(setImmediate);
  expect(fixture.indexRead).toHaveBeenCalledTimes(1);
  read.reject(new Error("offline"));
  expect(await results).toEqual([
    { status: "rejected", reason: new Error("offline") },
    { status: "rejected", reason: new Error("offline") },
  ]);
  expect((await search("Pencil")).map((r) => r.productId)).toEqual([1]);
  expect(fixture.indexRead).toHaveBeenCalledTimes(2);
});
it("plain test execution immediately sees fixture edits", async () => {
  vi.stubEnv("RUNTIME_LAB_READ_CACHE", "");
  const { loadStorefrontSearchMatches: search } =
    await import("../storefrontSearchIndex");
  expect(await search("Pencil")).toHaveLength(1);
  fixture.rows = [row(4, "Newfixture")];
  expect(await search("Pencil")).toEqual([]);
  expect(fixture.indexRead).toHaveBeenCalledTimes(2);
});
it("cached catalog ranking preserves product pagination, brands and fresh availability on every page", async () => {
  const { storefrontCatalog: catalog } = await import("../storefrontService");
  fixture.selected = [3];
  const first = await catalog({ branchId: 1, limit: 1 });
  expect(first.items.map((r) => r.productId)).toEqual([3]);
  expect(first.brands).toEqual(["Brand"]);
  expect(first.nextCursor).toBe(3);
  expect(fixture.candidateReads).toBe(1);
  fixture.stock.set(3, 0);
  const unavailable = await catalog({ branchId: 1, limit: 1 });
  expect(unavailable.items).toEqual([]);
  expect(unavailable.nextCursor).toBe(3);
  expect(unavailable.hasMore).toBe(true);
  fixture.selected = [2];
  const next = await catalog({ branchId: 1, limit: 1, cursor: 3 });
  expect(next.items.map((r) => r.productId)).toEqual([2]);
  expect(next.nextCursor).toBe(2);
  expect(fixture.candidateReads).toBe(1);
  expect(fixture.pageReads).toBe(3);
  expect(
    fixture.availability.mock.calls.filter((c) => c[2].includes(3)),
  ).toHaveLength(3);
});
it("actual catalog cache keeps company, branch, refinement and resolved barcode-unit keys separate", async () => {
  const { storefrontCatalog: catalog } = await import("../storefrontService");
  await catalog({ branchId: 1 });
  await catalog({ branchId: 1 });
  expect(fixture.candidateReads).toBe(1);
  fixture.company = 2;
  await catalog({ branchId: 1 });
  await catalog({ branchId: 2 });
  await catalog({ branchId: 2, brand: "Brand" });
  expect(fixture.candidateReads).toBe(4);
  fixture.barcode.mockResolvedValueOnce({
    status: "FOUND",
    owner: { productUnitId: 1 },
  });
  await catalog({ branchId: 2, search: "Scan" });
  fixture.barcode.mockResolvedValueOnce({
    status: "FOUND",
    owner: { productUnitId: 2 },
  });
  await catalog({ branchId: 2, search: "Scan" });
  expect(fixture.candidateReads).toBe(6);
  expect(fixture.indexRead).not.toHaveBeenCalled();
});
it("actual suggestion cache uses explicit lab policy, isolates company results and preserves default test freshness", async () => {
  const { storefrontSearchSuggestions: suggest } =
    await import("../storefrontSearchService");
  const first = await suggest({ query: "Pencil" });
  expect(first.products.map((p) => p.productId)).toEqual([1]);
  const barcodeReads = fixture.barcode.mock.calls.length;
  expect(await suggest({ query: "Pencil" })).toEqual(first);
  expect(fixture.barcode).toHaveBeenCalledTimes(barcodeReads);
  fixture.company = 2;
  fixture.rows = [row(9, "Othercompany")];
  expect((await suggest({ query: "Pencil" })).products).toEqual([]);
  vi.stubEnv("RUNTIME_LAB_READ_CACHE", "");
  fixture.company = 1;
  expect((await suggest({ query: "Pencil" })).products).toEqual([]);
});
