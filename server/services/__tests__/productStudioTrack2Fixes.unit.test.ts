import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as schema from "../../../drizzle/schema";

const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_1X1_ALT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const WEBP_1X1 = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";

type TableName =
  | "products"
  | "productVariants"
  | "productUnits"
  | "productUnitBarcodes"
  | "productPrices"
  | "productImages"
  | "productImageJobs"
  | "productImageObjectStaging"
  | "productPhotographyLocks"
  | "productStudioCampaigns"
  | "productStudioCampaignAssignees"
  | "auditLogs"
  | "idempotencyKeys"
  | "categories"
  | "users"
  | "onlineOrders"
  | "onlineOrderItems"
  | "customers"
  | "branches"
  | "deliveryZones"
  | "deliveryParties"
  | "couponReservations"
  | "couponPrograms"
  | "promotions"
  | "invoices"
  | "branchStock"
  | "suppliers"
  | "appNotifications"
  | "appNotificationOutbox";

type DbState = Record<TableName, any[]>;

function createDbState(): DbState {
  return {
    products: [],
    productVariants: [],
    productUnits: [],
    productUnitBarcodes: [],
    productPrices: [],
    productImages: [],
    productImageJobs: [],
    productImageObjectStaging: [],
    productPhotographyLocks: [],
    productStudioCampaigns: [],
    productStudioCampaignAssignees: [],
    auditLogs: [],
    idempotencyKeys: [],
    categories: [],
    users: [
      { id: 1, name: "مدير", role: "manager", branchId: 1 },
      { id: 2, name: "مصور", role: "cashier", branchId: 1 },
    ],
    onlineOrders: [],
    onlineOrderItems: [],
    customers: [],
    branches: [{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN", isActive: true }],
    deliveryZones: [],
    deliveryParties: [],
    couponReservations: [],
    couponPrograms: [],
    promotions: [],
    invoices: [],
    branchStock: [],
    suppliers: [],
    appNotifications: [],
    appNotificationOutbox: [],
  };
}

let state: DbState = createDbState();
const deletedStoreKeys: string[] = [];
const storedObjects = new Map<string, { bytes: Buffer; mime: string }>();

function underlyingTableName(target: any): string {
  const syms = Object.getOwnPropertySymbols(target ?? {});
  const baseSym = syms.find((s) => s.description === "drizzle:BaseName");
  if (baseSym && target[baseSym]) return String(target[baseSym]);
  const nameSym = syms.find((s) => s.description === "drizzle:Name");
  return nameSym ? String(target[nameSym]) : "";
}

function tableNameFor(target: any): string {
  const syms = Object.getOwnPropertySymbols(target ?? {});
  const aliasSym = syms.find((s) => s.description === "drizzle:Alias");
  if (aliasSym && target[aliasSym]) return String(target[aliasSym]);
  return underlyingTableName(target);
}

function tableArray(target: any): any[] {
  const name = underlyingTableName(target);
  if (name && name in state) return state[name as TableName];
  return [];
}

function evalFilter(clause: any, rowByTable: Map<string, any>, fallbackRow: any): boolean {
  if (!clause) return true;
  if (typeof clause.__eval === "function") return clause.__eval(rowByTable, fallbackRow);
  return true;
}

function resolveCol(col: any, rowByTable: Map<string, any>, fallbackRow: any): any {
  const tblName = col?.table ? tableNameFor(col.table) : "";
  const colName = col?.name ?? "";
  if (tblName && rowByTable.has(tblName)) {
    const r = rowByTable.get(tblName);
    return r ? r[colName] : undefined;
  }
  return fallbackRow?.[colName];
}

const mockDb: any = {
  transaction: async (fn: (tx: any) => Promise<any>) => fn(mockDb),
  select: (fields?: any) => {
    let baseTarget: any = null;
    const joins: Array<{ kind: "left" | "inner"; target: any; on: any }> = [];
    let whereClause: any = null;
    let limitCount: number | null = null;

    const builder: any = {
      from: (target: any) => {
        baseTarget = target;
        return builder;
      },
      leftJoin: (target: any, on: any) => {
        joins.push({ kind: "left", target, on });
        return builder;
      },
      innerJoin: (target: any, on: any) => {
        joins.push({ kind: "inner", target, on });
        return builder;
      },
      where: (clause: any) => {
        whereClause = clause;
        return builder;
      },
      orderBy: () => builder,
      groupBy: () => builder,
      limit: (n: number) => {
        limitCount = n;
        return builder;
      },
      for: () => builder,
      then: (resolve: (val: any) => any) => {
        const baseName = tableNameFor(baseTarget);
        let combos: Array<Map<string, any>> = tableArray(baseTarget).map((r) => new Map([[baseName, r]]));
        for (const j of joins) {
          const jName = tableNameFor(j.target);
          const jRows = tableArray(j.target);
          const nextCombos: Array<Map<string, any>> = [];
          for (const combo of combos) {
            let matched = false;
            for (const jr of jRows) {
              const candidate = new Map(combo);
              candidate.set(jName, jr);
              if (evalFilter(j.on, candidate, jr)) {
                nextCombos.push(candidate);
                matched = true;
              }
            }
            if (!matched && j.kind === "left") {
              const candidate = new Map(combo);
              candidate.set(jName, null);
              nextCombos.push(candidate);
            }
          }
          combos = nextCombos;
        }
        let filtered = combos.filter((c) => evalFilter(whereClause, c, c.get(baseName)));
        if (limitCount != null) filtered = filtered.slice(0, limitCount);
        const projected = filtered.map((c) => {
          const baseRow = c.get(baseName);
          if (!fields) return { ...baseRow };
          if (fields.n !== undefined || fields.count !== undefined) {
            return { n: filtered.length, count: filtered.length };
          }
          const out: Record<string, any> = {};
          for (const [k, expr] of Object.entries(fields)) {
            if (expr && typeof expr === "object" && "name" in expr && "table" in expr) {
              out[k] = resolveCol(expr, c, baseRow);
            } else {
              out[k] = baseRow?.[k];
            }
          }
          return out;
        });
        if (fields && (fields.n !== undefined || fields.count !== undefined) && projected.length === 0) {
          return Promise.resolve(resolve([{ n: 0, count: 0 }]));
        }
        return Promise.resolve(resolve(projected));
      },
    };
    return builder;
  },
  insert: (target: any) => {
    const table = tableArray(target);
    return {
      values: (val: any) => {
        const rows = Array.isArray(val) ? val : [val];
        const inserted = rows.map((r, idx) => {
          const nextId =
            r.id ??
            (table.length > 0 ? Math.max(...table.map((x) => Number(x.id ?? 0))) + 1 : 1) + idx;
          const row = { id: nextId, createdAt: new Date(), updatedAt: new Date(), ...r };
          table.push(row);
          return row;
        });
        const res: any = Promise.resolve();
        res.$returningId = () => Promise.resolve(inserted.map((i) => ({ id: i.id })));
        res.onDuplicateKeyUpdate = (opts: any) => {
          const r = rows[0];
          const idx = table.findIndex((x) => x.objectKey != null && x.objectKey === r.objectKey);
          if (idx >= 0) table[idx] = { ...table[idx], ...opts.set };
          return Promise.resolve();
        };
        res.then = (fn: any) => Promise.resolve().then(fn);
        return res;
      },
    };
  },
  update: (target: any) => {
    const table = tableArray(target);
    const tName = tableNameFor(target);
    let patch: Record<string, any> = {};
    let whereClause: any = null;
    const builder: any = {
      set: (vals: any) => {
        patch = vals;
        return builder;
      },
      where: (clause: any) => {
        whereClause = clause;
        return builder;
      },
      then: (resolve: (val: any) => any) => {
        let count = 0;
        for (let i = 0; i < table.length; i++) {
          const map = new Map([[tName, table[i]]]);
          if (evalFilter(whereClause, map, table[i])) {
            const next = { ...table[i] };
            for (const [k, v] of Object.entries(patch)) {
              if (v !== undefined) {
                next[k] = k === "revision" && typeof v === "object" ? Number(next.revision ?? 1) + 1 : v;
              }
            }
            table[i] = next;
            count++;
          }
        }
        return Promise.resolve(resolve({ affectedRows: count }));
      },
    };
    return builder;
  },
  delete: (target: any) => {
    const table = tableArray(target);
    const tName = tableNameFor(target);
    let whereClause: any = null;
    const builder: any = {
      where: (clause: any) => {
        whereClause = clause;
        return builder;
      },
      then: (resolve: (val: any) => any) => {
        let affectedRows = 0;
        for (let i = table.length - 1; i >= 0; i--) {
          const map = new Map([[tName, table[i]]]);
          if (evalFilter(whereClause, map, table[i])) {
            table.splice(i, 1);
            affectedRows++;
          }
        }
        return Promise.resolve(resolve([{ affectedRows }]));
      },
    };
    return builder;
  },
};

vi.mock("drizzle-orm", async (importActual) => {
  const actual = await importActual<typeof import("drizzle-orm")>();
  const isCol = (x: any) => Boolean(x && typeof x === "object" && "name" in x && "table" in x);
  const valOf = (x: any, m: Map<string, any>, fb: any) => (isCol(x) ? resolveCol(x, m, fb) : x);
  return {
    ...actual,
    eq: (a: any, b: any) => ({ __eval: (m: Map<string, any>, fb: any) => valOf(a, m, fb) === valOf(b, m, fb) }),
    ne: (a: any, b: any) => ({ __eval: (m: Map<string, any>, fb: any) => valOf(a, m, fb) !== valOf(b, m, fb) }),
    gt: (a: any, b: any) => ({ __eval: (m: Map<string, any>, fb: any) => valOf(a, m, fb) > valOf(b, m, fb) }),
    gte: (a: any, b: any) => ({ __eval: (m: Map<string, any>, fb: any) => valOf(a, m, fb) >= valOf(b, m, fb) }),
    lt: (a: any, b: any) => ({ __eval: (m: Map<string, any>, fb: any) => valOf(a, m, fb) < valOf(b, m, fb) }),
    lte: (a: any, b: any) => ({ __eval: (m: Map<string, any>, fb: any) => valOf(a, m, fb) <= valOf(b, m, fb) }),
    isNull: (a: any) => ({ __eval: (m: Map<string, any>, fb: any) => valOf(a, m, fb) == null }),
    isNotNull: (a: any) => ({ __eval: (m: Map<string, any>, fb: any) => valOf(a, m, fb) != null }),
    inArray: (a: any, arr: any[]) => ({ __eval: (m: Map<string, any>, fb: any) => arr.includes(valOf(a, m, fb)) }),
    notInArray: (a: any, arr: any[]) => ({ __eval: (m: Map<string, any>, fb: any) => !arr.includes(valOf(a, m, fb)) }),
    and: (...clauses: any[]) => ({
      __eval: (m: Map<string, any>, fb: any) => clauses.every((c) => evalFilter(c, m, fb)),
    }),
    or: (...clauses: any[]) => ({
      __eval: (m: Map<string, any>, fb: any) => clauses.some((c) => evalFilter(c, m, fb)),
    }),
  };
});

vi.mock("../tx", () => ({
  requireDb: () => mockDb,
  withTx: (fn: (tx: any) => Promise<any>) => fn(mockDb),
  withStudioTx: (fn: (tx: any) => Promise<any>) => fn(mockDb),
}));

vi.mock("../../db", () => ({
  getDb: () => mockDb,
  requireDb: () => mockDb,
  isMultiTenantModeActive: () => false,
  getCurrentTenantDb: () => mockDb,
}));

vi.mock("../../tenancy/context", () => ({
  getCurrentCompanyId: () => 1,
}));

vi.mock("../tenancy/context", () => ({
  getCurrentCompanyId: () => 1,
}));

vi.mock("../../lib/imageStore", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/imageStore")>();
  return {
    ...actual,
    getImageStore: () => ({
      put: async (key: string, bytes: Buffer, mime: string) => {
        storedObjects.set(key, { bytes, mime });
        return key;
      },
      head: async (key: string) => ({ exists: storedObjects.has(key) }),
      delete: async (key: string) => {
        deletedStoreKeys.push(key);
        storedObjects.delete(key);
      },
    }),
    assertImageStoreOperationalConfiguration: vi.fn(),
    isImageStoreOperational: () => true,
  };
});

vi.mock("../lib/imageStore", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/imageStore")>();
  return {
    ...actual,
    getImageStore: () => ({
      put: async (key: string, bytes: Buffer, mime: string) => {
        storedObjects.set(key, { bytes, mime });
        return key;
      },
      head: async (key: string) => ({ exists: storedObjects.has(key) }),
      delete: async (key: string) => {
        deletedStoreKeys.push(key);
        storedObjects.delete(key);
      },
    }),
    assertImageStoreOperationalConfiguration: vi.fn(),
    isImageStoreOperational: () => true,
  };
});

vi.mock("../appNotificationOutboxService", () => ({
  enqueueAppNotificationOutbox: vi.fn().mockResolvedValue(undefined),
  reconcileAppNotificationOutbox: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../productContentAiService", () => ({
  generateAndSaveContentDraftForProduct: vi.fn().mockResolvedValue({ draftId: null, reason: "SKIPPED" }),
}));

import {
  approveStudioTask,
  cleanupStudioStaging,
  quickSaveBarcodeProductImage,
  setProductImagePrimaryStatus,
  type ProductStudioActor,
} from "../productStudioService";
import { deleteProductImage, setPrimaryProductImage } from "../productStudioImageManager";
import { getProductForVariantEdit } from "../catalog/productEditDocument";
import { getOnlineOrder } from "../storeAdmin/orderFulfillmentService";
import { resolveStudioImageSrc } from "../../../client/src/lib/productImages";

const manager: ProductStudioActor = { userId: 1, branchId: 1, role: "manager", name: "مدير" };
const prevGcMode = process.env.R2_GC_MODE;
const prevGcConfirm = process.env.R2_GC_DELETE_CONFIRM;

function sha256OfDataUrl(dataUrl: string): string {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
}

describe("Track 2: atomic replacement, R2 GC reclaim, multi-variant deduplication & image URLs", () => {
  beforeEach(() => {
    state = createDbState();
    deletedStoreKeys.length = 0;
    storedObjects.clear();
    process.env.R2_GC_MODE = prevGcMode;
    process.env.R2_GC_DELETE_CONFIRM = prevGcConfirm;

    state.products.push({
      id: 100,
      name: "منتج متعدد المتغيرات",
      isActive: true,
      isService: false,
      showInStore: false,
      isBundle: false,
      isCustomizable: false,
      allowAutoCartRecommendations: true,
      allowBackorder: false,
      isConsignment: false,
      stockUsage: "SALE_ONLY",
      showInReception: true,
      showInPrintPos: false,
      showInQuotations: true,
      showInAdvancedSales: true,
    });
    state.productVariants.push(
      { id: 10, productId: 100, sku: "VAR-10", variantName: "أحمر", color: "أحمر", size: null, costPrice: "100.00", reorderPoint: 0, minStock: 0, isActive: true },
      { id: 11, productId: 100, sku: "VAR-11", variantName: "أزرق", color: "أزرق", size: null, costPrice: "100.00", reorderPoint: 0, minStock: 0, isActive: true },
      { id: 12, productId: 100, sku: "VAR-12", variantName: "أخضر", color: "أخضر", size: null, costPrice: "100.00", reorderPoint: 0, minStock: 0, isActive: true },
    );
    state.productUnits.push(
      { id: 101, variantId: 10, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, barcode: "4005401516071", isActive: true },
      { id: 102, variantId: 11, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, barcode: "4005401516072", isActive: true },
      { id: 103, variantId: 12, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, barcode: "4005401516073", isActive: true },
    );
  });

  afterEach(() => {
    process.env.R2_GC_MODE = prevGcMode;
    process.env.R2_GC_DELETE_CONFIRM = prevGcConfirm;
  });

  it("quickSaveBarcodeProductImage with replaceImageId atomically replaces old row and preserves primary + sortOrder", async () => {
    const oldHash = sha256OfDataUrl(PNG_1X1);
    state.productImages.push(
      {
        id: 50,
        productId: 100,
        variantId: 10,
        url: `/api/img/product/50?v=${oldHash.slice(0, 16)}`,
        objectKey: `single/studio/candidate/old-${oldHash}.png`,
        contentHash: oldHash,
        isPrimary: true,
        sortOrder: 3,
        reviewStatus: "APPROVED",
        origin: "STUDIO_FREE",
      },
      {
        id: 51,
        productId: 100,
        variantId: 10,
        url: `/api/img/product/51?v=${oldHash.slice(0, 16)}`,
        objectKey: `single/studio/candidate/sibling.png`,
        contentHash: oldHash,
        isPrimary: false,
        sortOrder: 4,
        reviewStatus: "APPROVED",
        origin: "STUDIO_FREE",
      },
    );

    // Cross-variant replacement must fail closed
    await expect(
      quickSaveBarcodeProductImage(manager, {
        productId: 100,
        variantId: 11,
        processedDataUrl: PNG_1X1_ALT,
        thumbnailDataUrl: WEBP_1X1,
        mode: "FLATTEN",
        replaceImageId: 50,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Same-scope replacement deletes old image #50, inserts new primary at sortOrder 3
    const saved = await quickSaveBarcodeProductImage(manager, {
      productId: 100,
      variantId: 10,
      processedDataUrl: PNG_1X1_ALT,
      thumbnailDataUrl: WEBP_1X1,
      mode: "FLATTEN",
      setAsPrimary: false,
      replaceImageId: 50,
    });

    expect(saved.autoApproved).toBe(true);
    const variantImgs = state.productImages.filter((im) => im.productId === 100 && im.variantId === 10);
    expect(variantImgs.map((im) => im.id)).not.toContain(50);
    expect(variantImgs).toHaveLength(2);
    const replacement = variantImgs.find((im) => im.id === saved.imageId)!;
    expect(replacement.isPrimary).toBe(true);
    expect(replacement.sortOrder).toBe(3);
  });

  it("approveStudioTask with replaceImageId atomically replaces target row without stacking duplicates", async () => {
    const newHash = sha256OfDataUrl(PNG_1X1_ALT);
    const newKey = `single/studio/candidate/${newHash}.png`;
    state.productImages.push({
      id: 60,
      productId: 100,
      variantId: null,
      url: `/api/img/product/60?v=${"a".repeat(16)}`,
      objectKey: "single/studio/candidate/old-parent.png",
      contentHash: "a".repeat(64),
      isPrimary: true,
      sortOrder: 2,
      reviewStatus: "APPROVED",
      origin: "STUDIO_FREE",
    });
    state.productImageJobs.push({
      id: 700,
      productId: 100,
      variantId: null,
      branchId: 1,
      status: "PENDING_REVIEW",
      mode: "FLATTEN",
      assignedTo: 2,
      submittedBy: 2,
      sourceImageId: null,
      processedObjectKey: newKey,
      originalObjectKey: "single/studio/original/raw.png",
      processedContentHash: newHash,
      processedMime: "image/webp",
      processedUrl: WEBP_1X1,
      processedWidth: 1,
      processedHeight: 1,
      processedBytes: 68,
      revision: 1,
    });

    const res = await approveStudioTask(manager, 700, undefined, 1, 60);
    expect(state.productImages.find((im) => im.id === 60)).toBeUndefined();
    const parentImgs = state.productImages.filter((im) => im.productId === 100 && im.variantId == null);
    expect(parentImgs).toHaveLength(1);
    expect(parentImgs[0].id).toBe(res.imageId);
    expect(parentImgs[0].isPrimary).toBe(true);
    expect(parentImgs[0].sortOrder).toBe(2);
  });

  it("cleanupStudioStaging reclaims R2 keys of APPROVED jobs once their productImages row is deleted, while preserving active jobs", async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60_000);
    const deletedImgKey = "single/studio/candidate/deleted-approved.png";
    const activeJobKey = "single/studio/candidate/still-pending-review.png";

    storedObjects.set(deletedImgKey, { bytes: Buffer.from("a"), mime: "image/png" });
    storedObjects.set(activeJobKey, { bytes: Buffer.from("b"), mime: "image/png" });

    // Terminal APPROVED job whose productImages row was already deleted/replaced
    state.productImageJobs.push(
      {
        id: 801,
        productId: 100,
        status: "APPROVED",
        processedObjectKey: deletedImgKey,
        originalObjectKey: null,
      },
      {
        id: 802,
        productId: 100,
        status: "PENDING_REVIEW",
        processedObjectKey: activeJobKey,
        originalObjectKey: null,
      },
    );
    state.productImageObjectStaging.push(
      { objectKey: deletedImgKey, state: "PENDING", referencedAt: old, touchedAt: old },
      { objectKey: activeJobKey, state: "PENDING", referencedAt: old, touchedAt: old },
    );

    process.env.R2_GC_MODE = "delete";
    process.env.R2_GC_DELETE_CONFIRM = "DELETE_RETAINED_R2_OBJECTS";

    const removed = await cleanupStudioStaging(10, {
      loadDeletionAuthorization: async () => ({ authorize: () => {} }),
    });

    expect(removed).toBe(1);
    expect(deletedStoreKeys).toEqual([deletedImgKey]);
    expect(storedObjects.has(deletedImgKey)).toBe(false);
    expect(storedObjects.has(activeJobKey)).toBe(true);
  });

  it("getOnlineOrderDetail never duplicates items across 3 variants with primary images and uses /api/img/inventory-product", async () => {
    const h = "b".repeat(64);
    state.productImages.push(
      { id: 1, productId: 100, variantId: 10, url: `/api/img/product/1?v=${h.slice(0, 16)}`, objectKey: "single/studio/candidate/1.png", contentHash: h, isPrimary: true, sortOrder: 0, reviewStatus: "APPROVED" },
      { id: 2, productId: 100, variantId: 11, url: `/api/img/product/2?v=${h.slice(0, 16)}`, objectKey: "single/studio/candidate/2.png", contentHash: h, isPrimary: true, sortOrder: 0, reviewStatus: "APPROVED" },
      { id: 3, productId: 100, variantId: 12, url: `/api/img/product/3?v=${h.slice(0, 16)}`, objectKey: "single/studio/candidate/3.png", contentHash: h, isPrimary: true, sortOrder: 0, reviewStatus: "APPROVED" },
    );
    state.onlineOrders.push({
      id: 900,
      orderNumber: "ORD-4005",
      branchId: 1,
      customerId: null,
      status: "PENDING",
      subtotal: "1500.00",
      total: "1500.00",
      amountDueAtDoor: "1500.00",
      createdAt: new Date(),
    });
    state.onlineOrderItems.push({
      id: 901,
      onlineOrderId: 900,
      variantId: 11,
      productUnitId: 102,
      quantity: "2",
      unitPrice: "750.00",
      total: "1500.00",
      customizationSnapshot: null,
    });

    const detail = await getOnlineOrder(900, 1);
    expect(detail).not.toBeNull();
    expect(detail!.items).toHaveLength(1);
    expect(detail!.items[0].variantId).toBe(11);
    expect(detail!.items[0].imageUrl).toBe(`/api/img/inventory-product/2?v=${h.slice(0, 16)}`);
  });

  it("setPrimaryProductImage & setProductImagePrimaryStatus reject unapproved images, and deleteProductImage removes even the last image", async () => {
    state.productImages.push(
      { id: 70, productId: 100, variantId: 10, url: "/api/img/product/70", isPrimary: false, sortOrder: 0, reviewStatus: "PENDING_REVIEW" },
      { id: 71, productId: 100, variantId: 10, url: "/api/img/product/71", isPrimary: true, sortOrder: 1, reviewStatus: "APPROVED" },
    );

    await expect(setPrimaryProductImage(manager, 70)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      setProductImagePrimaryStatus(manager, { productId: 100, imageId: 70, isPrimary: true }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Manager can delete the last APPROVED primary image cleanly
    const del = await deleteProductImage(manager, { imageId: 71 });
    expect(del).toEqual({ imageId: 71, promotedNewPrimary: false });
    expect(state.productImages.find((im) => im.id === 71)).toBeUndefined();
  });

  it("getProductForVariantEdit preserves url column while providing safe displayUrl for showInStore=0 and resolveStudioImageSrc avoids broken URLs", async () => {
    const h = "c".repeat(64);
    state.productImages.push({
      id: 80,
      productId: 100,
      variantId: null,
      url: `/api/img/product/80?v=${h.slice(0, 16)}`,
      objectKey: "single/studio/candidate/80.webp",
      contentHash: h,
      thumbDataUrl: "data:image/webp;base64,THUMB80",
      origin: "STUDIO_AI",
      reviewStatus: "APPROVED",
      isPrimary: true,
      sortOrder: 0,
    });

    const doc = await getProductForVariantEdit(100);
    expect(doc).not.toBeNull();
    expect(doc!.images[0].url).toBe(`/api/img/product/80?v=${h.slice(0, 16)}`);
    expect(doc!.images[0].displayUrl).toBe("data:image/webp;base64,THUMB80");

    // When thumbDataUrl is null, displayUrl falls back to /api/img/inventory-product/:id?v=<16-hex>
    state.productImages[0].thumbDataUrl = null;
    const docNoThumb = await getProductForVariantEdit(100);
    expect(docNoThumb!.images[0].url).toBe(`/api/img/product/80?v=${h.slice(0, 16)}`);
    expect(docNoThumb!.images[0].displayUrl).toBe(`/api/img/inventory-product/80?v=${h.slice(0, 16)}`);

    // Client helper rewrites /api/img/product/:id?v=... -> /api/img/inventory-product/:id?v=... and never emits ?v=thumb or bare ID
    expect(
      resolveStudioImageSrc({
        id: 80,
        url: `/api/img/product/80?v=${h.slice(0, 16)}&w=320`,
        thumbDataUrl: null,
        contentHash: null,
      }),
    ).toBe(`/api/img/inventory-product/80?v=${h.slice(0, 16)}`);
    expect(
      resolveStudioImageSrc({
        id: 81,
        url: "/api/img/product/81",
        thumbDataUrl: null,
        contentHash: null,
      }),
    ).toBe("");
  });
});
