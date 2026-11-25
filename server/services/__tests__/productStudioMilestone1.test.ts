import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import * as schema from "../../../drizzle/schema";

// --- Multi-Tenant DB State Factory ---
type DbState = {
  productImages: any[];
  productImageJobs: any[];
  productStudioCampaigns: any[];
  productStudioCampaignProducts: any[];
  productStudioCampaignCategories: any[];
  productStudioCampaignAssignees: any[];
  productStudioSubmitQuota: any[];
  productPhotographyLocks: any[];
  auditLogs: any[];
  crmCampaigns: any[];
  storefrontPushCampaigns: any[];
  giftCampaigns: any[];
  products: any[];
  productVariants: any[];
  productUnits: any[];
  categories: any[];
  users: any[];
  idempotencyKeys: any[];
  currentCompanyId: number | null;
};

function createInitialDbState(companyId: number = 1): DbState {
  return {
    productImages: [],
    productImageJobs: [],
    productStudioCampaigns: [],
    productStudioCampaignProducts: [],
    productStudioCampaignCategories: [],
    productStudioCampaignAssignees: [],
    productStudioSubmitQuota: [],
    productPhotographyLocks: [],
    auditLogs: [],
    crmCampaigns: [],
    storefrontPushCampaigns: [],
    giftCampaigns: [],
    products: [],
    productVariants: [],
    productUnits: [],
    categories: [],
    users: [
      { id: 1, name: "مدير النظام", email: "admin@alroya.local", role: "manager" },
      { id: 2, name: "مصور تجريبي", email: "photo1@alroya.local", role: "cashier" },
      { id: 3, name: "مصور ثانٍ", email: "photo2@alroya.local", role: "cashier" },
    ],
    idempotencyKeys: [],
    currentCompanyId: companyId,
  };
}

let activeCompanyContext: number | null = null;
let dbState: DbState = createInitialDbState(1);
const tenantDbStates = new Map<number, DbState>();
tenantDbStates.set(1, dbState);

function getActiveDbState(): DbState {
  const cid = activeCompanyContext ?? dbState.currentCompanyId;
  if (cid != null && tenantDbStates.has(cid)) {
    return tenantDbStates.get(cid)!;
  }
  return dbState;
}

function getTableFromTarget(target: any): any[] {
  const state = getActiveDbState();
  if (target === schema.productImages) return state.productImages;
  if (target === schema.productImageJobs) return state.productImageJobs;
  if (target === schema.productStudioCampaigns) return state.productStudioCampaigns;
  if (target === schema.productStudioCampaignProducts) return state.productStudioCampaignProducts;
  if (target === schema.productStudioCampaignCategories) return state.productStudioCampaignCategories;
  if (target === schema.productStudioCampaignAssignees) return state.productStudioCampaignAssignees;
  if (target === schema.productStudioSubmitQuota) return state.productStudioSubmitQuota;
  if (target === schema.productPhotographyLocks) return state.productPhotographyLocks;
  if (target === schema.auditLogs) return state.auditLogs;
  if (target === schema.crmCampaigns) return state.crmCampaigns;
  if (target === schema.storefrontPushCampaigns) return state.storefrontPushCampaigns;
  if (target === schema.giftCampaigns) return state.giftCampaigns;
  if (target === schema.products) return state.products;
  if (target === schema.productVariants) return state.productVariants;
  if (target === schema.productUnits) return state.productUnits;
  if (target === schema.categories) return state.categories;
  if (target === schema.users) return state.users;
  if (target === schema.idempotencyKeys) return state.idempotencyKeys;
  return [];
}

const mockDb = {
  select: (fields?: any) => {
    let sourceTable: any[] = [];
    let filterFn: ((item: any) => boolean) | null = null;
    let limitCount: number | null = null;
    let isForUpdate = false;

    const builder: any = {
      from: (target: any) => {
        sourceTable = getTableFromTarget(target);
        return builder;
      },
      leftJoin: () => builder,
      where: (clause: any) => {
        filterFn = clause?.__filter ?? null;
        return builder;
      },
      orderBy: () => builder,
      limit: (n: number) => {
        limitCount = n;
        return builder;
      },
      for: () => {
        isForUpdate = true;
        return builder;
      },
      then: (resolve: (val: any) => any) => {
        let results = filterFn ? sourceTable.filter(filterFn) : [...sourceTable];
        if (fields && typeof fields === "object" && fields.count) {
          return Promise.resolve(resolve([{ count: results.length }]));
        }
        if (limitCount != null) {
          results = results.slice(0, limitCount);
        }
        return Promise.resolve(resolve(results));
      },
    };
    return builder;
  },
  insert: (target: any) => {
    const table = getTableFromTarget(target);
    return {
      values: (val: any) => {
        const rows = Array.isArray(val) ? val : [val];
        const inserted = rows.map((r, idx) => {
          const rowWithId = {
            id: r.id ?? table.length + idx + 1,
            ...r,
          };
          table.push(rowWithId);
          return rowWithId;
        });
        const res: any = Promise.resolve();
        res.$returningId = () => Promise.resolve(inserted.map((i) => ({ id: i.id })));
        res.onDuplicateKeyUpdate = (opts: any) => {
          const r = rows[0];
          const pkIndex = table.findIndex((x) => x.productId === r.productId);
          if (pkIndex >= 0) {
            table[pkIndex] = { ...table[pkIndex], ...opts.set };
          }
          return Promise.resolve();
        };
        res.then = (fn: any) => Promise.resolve().then(fn);
        return res;
      },
    };
  },
  update: (target: any) => {
    const table = getTableFromTarget(target);
    let updateVals: any = {};
    let whereFilter: ((item: any) => boolean) | null = null;
    let whereCalled = false;
    const builder: any = {
      set: (vals: any) => {
        updateVals = vals;
        return builder;
      },
      where: (clause: any) => {
        whereCalled = true;
        whereFilter = clause?.__filter ?? null;
        return builder;
      },
      then: (resolve: (val: any) => any) => {
        for (let i = 0; i < table.length; i++) {
          if (!whereCalled || !whereFilter || whereFilter(table[i])) {
            table[i] = { ...table[i], ...updateVals };
          }
        }
        return Promise.resolve(resolve({ affectedRows: table.length }));
      },
    };
    return builder;
  },
  delete: (target: any) => {
    const table = getTableFromTarget(target);
    let whereFilter: ((item: any) => boolean) | null = null;
    let whereCalled = false;
    const builder: any = {
      where: (clause: any) => {
        whereCalled = true;
        whereFilter = clause?.__filter ?? null;
        return builder;
      },
      then: (resolve: (val: any) => any) => {
        let affectedRows = 0;
        if (whereCalled) {
          if (whereFilter) {
            for (let i = table.length - 1; i >= 0; i--) {
              if (whereFilter(table[i])) {
                table.splice(i, 1);
                affectedRows++;
              }
            }
          }
        } else {
          affectedRows = table.length;
          table.length = 0;
        }
        const res: any = [{ affectedRows }];
        res.affectedRows = affectedRows;
        return Promise.resolve(resolve(res));
      },
    };
    return builder;
  },
};

// Mock drizzle expressions with simulated filter metadata
vi.mock("drizzle-orm", async (importActual) => {
  const actual = await importActual<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: any, val: any) => {
      const colName = col?.name || (typeof col === "string" ? col : "unknown");
      return {
        __filter: (item: any) => {
          const itemVal = item[colName];
          return itemVal === val;
        },
      };
    },
    ne: (col: any, val: any) => {
      const colName = col?.name || "unknown";
      return {
        __filter: (item: any) => item[colName] !== val,
      };
    },
    gt: (col: any, val: any) => {
      const colName = col?.name || "unknown";
      return {
        __filter: (item: any) => item[colName] > val,
      };
    },
    gte: (col: any, val: any) => {
      const colName = col?.name || "unknown";
      return {
        __filter: (item: any) => item[colName] >= val,
      };
    },
    lt: (col: any, val: any) => {
      const colName = col?.name || "unknown";
      return {
        __filter: (item: any) => item[colName] < val,
      };
    },
    lte: (col: any, val: any) => {
      const colName = col?.name || "unknown";
      return {
        __filter: (item: any) => item[colName] <= val,
      };
    },
    and: (...clauses: any[]) => ({
      __filter: (item: any) => clauses.every((c) => !c?.__filter || c.__filter(item)),
    }),
    or: (...clauses: any[]) => ({
      __filter: (item: any) => clauses.some((c) => !c?.__filter || c.__filter(item)),
    }),
    isNull: (col: any) => {
      const colName = col?.name || "unknown";
      return {
        __filter: (item: any) => item[colName] == null,
      };
    },
    isNotNull: (col: any) => {
      const colName = col?.name || "unknown";
      return {
        __filter: (item: any) => item[colName] != null,
      };
    },
    inArray: (col: any, arr: any[]) => {
      const colName = col?.name || "unknown";
      return {
        __filter: (item: any) => arr.includes(item[colName]),
      };
    },
    sql: Object.assign(
      (strings: any, ...values: any[]) => {
        const s = actual.sql(strings, ...values);
        return Object.assign(s, { count: true });
      },
      actual.sql,
    ),
  };
});

// Mock database and transaction access with ACID queue serialization
let txQueue = Promise.resolve();
const serializeTx = async (fn: (tx: any) => Promise<any>) => {
  const current = txQueue;
  let nextResolve: () => void;
  txQueue = new Promise<void>((resolve) => {
    nextResolve = resolve;
  });
  await current;
  try {
    return await fn(mockDb);
  } finally {
    nextResolve!();
  }
};

vi.mock("../tx", () => ({
  requireDb: () => mockDb,
  withTx: (fn: (tx: any) => Promise<any>) => serializeTx(fn),
  withStudioTx: (fn: (tx: any) => Promise<any>) => serializeTx(fn),
}));

vi.mock("../../db", () => ({
  getDb: () => mockDb,
  requireDb: () => mockDb,
}));

vi.mock("../../lib/imageStore", () => ({
  getImageStore: () => ({
    put: vi.fn().mockResolvedValue("mock-key"),
    get: vi.fn(),
    delete: vi.fn(),
  }),
  assertImageStoreOperationalConfiguration: vi.fn(),
  isImageStoreOperational: () => true,
  MAX_PUBLISHED_PRODUCT_IMAGE_BYTES: 10_000_000,
  objectKeyFor: (hash: string, mime: string, prefix: string) => `${prefix}/${hash}`,
  shortHash: (h: string) => h.slice(0, 8),
  studioObjectPrefix: (kind: string) => `studio/${kind}`,
  contentHash: () => "hash123",
}));

import {
  acquireOrCheckLock,
  heartbeatLock,
  purgeProductStudioLegacyData,
  quickBarcodeLookup,
  quickSaveBarcodeProductImage,
  releaseLock,
  type ProductStudioActor,
} from "../productStudioService";
import { productStudioRouter } from "../../routers/productStudioRouter";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";

describe("Milestone 1 — Backend Core: Schema, Ephemeral Lock, Atomic Purge & Lifecycle", () => {
  const managerActor: ProductStudioActor = {
    userId: 1,
    branchId: 1,
    role: "manager",
    isOwner: true,
    name: "مدير النظام",
  };

  const employeeActor: ProductStudioActor = {
    userId: 2,
    branchId: 1,
    role: "cashier",
    isOwner: false,
    name: "مصور تجريبي",
  };

  const otherEmployeeActor: ProductStudioActor = {
    userId: 3,
    branchId: 1,
    role: "cashier",
    isOwner: false,
    name: "مصور ثانٍ",
  };

  beforeEach(() => {
    activeCompanyContext = null;
    txQueue = Promise.resolve();
    dbState = createInitialDbState(1);
    tenantDbStates.clear();
    tenantDbStates.set(1, dbState);
  });

  describe("1. Database Schema Exports", () => {
    it("exports productPhotographyLocks with correct column definitions and indexes", () => {
      expect(schema.productPhotographyLocks).toBeDefined();
      const cols = schema.productPhotographyLocks;
      expect(cols.productId).toBeDefined();
      expect(cols.variantId).toBeDefined();
      expect(cols.userId).toBeDefined();
      expect(cols.userName).toBeDefined();
      expect(cols.lockedAt).toBeDefined();
      expect(cols.heartbeatAt).toBeDefined();
      expect(cols.expiresAt).toBeDefined();
    });
  });

  describe("2. Atomic DB Purge (purgeProductStudioLegacyData)", () => {
    beforeEach(() => {
      // Seed legacy studio data
      dbState.productImages.push(
        { id: 10, productId: 100, url: "http://img1", reviewStatus: "APPROVED", publishedStudioJobId: 99 },
        { id: 11, productId: 101, url: "http://img2", reviewStatus: "APPROVED", publishedStudioJobId: 98 },
      );
      dbState.productImageJobs.push(
        { id: 98, productId: 101, status: "APPROVED" },
        { id: 99, productId: 100, status: "IN_PROGRESS" },
        { id: 100, productId: 102, status: "ASSIGNED" },
      );
      dbState.productStudioCampaigns.push({ id: 1, name: "حملة تجريبية" });
      dbState.productStudioCampaignProducts.push({ campaignId: 1, productId: 100 });
      dbState.productStudioCampaignCategories.push({ campaignId: 1, categoryId: 5 });
      dbState.productStudioCampaignAssignees.push({ campaignId: 1, userId: 2 });
      dbState.productStudioSubmitQuota.push({ id: 1, userId: 2, submitCount: 15 });
      dbState.productPhotographyLocks.push({
        productId: 100,
        userId: 2,
        userName: "مصور",
        expiresAt: new Date(Date.now() + 60000),
      });

      // Seed unrelated campaigns that must be strictly untouched
      dbState.crmCampaigns.push({ id: 50, name: "حملة تسويقية CRM" });
      dbState.storefrontPushCampaigns.push({ id: 60, name: "إشعار متجر" });
      dbState.giftCampaigns.push({ id: 70, name: "حملة هدايا" });
    });

    it("rejects unauthorized non-manager actors with FORBIDDEN", async () => {
      await expect(purgeProductStudioLegacyData(employeeActor)).rejects.toThrow(TRPCError);
      try {
        await purgeProductStudioLegacyData(employeeActor);
      } catch (err: any) {
        expect(err.code).toBe("FORBIDDEN");
      }
    });

    it("executes atomic purge, preserving approved images and keeping external campaigns untouched", async () => {
      const result = await purgeProductStudioLegacyData(managerActor);

      expect(result.success).toBe(true);
      expect(result.preservedApprovedImages).toBe(2);
      expect(result.purgedAt).toBeInstanceOf(Date);

      // Verify studio campaigns & jobs are deleted
      expect(dbState.productImageJobs).toHaveLength(0);
      expect(dbState.productStudioCampaigns).toHaveLength(0);
      expect(dbState.productStudioCampaignProducts).toHaveLength(0);
      expect(dbState.productStudioCampaignCategories).toHaveLength(0);
      expect(dbState.productStudioCampaignAssignees).toHaveLength(0);
      expect(dbState.productStudioSubmitQuota).toHaveLength(0);
      expect(dbState.productPhotographyLocks).toHaveLength(0);

      // Verify approved productImages are strictly preserved and publishedStudioJobId is unlinked
      expect(dbState.productImages).toHaveLength(2);
      expect(dbState.productImages[0].publishedStudioJobId).toBeNull();
      expect(dbState.productImages[1].publishedStudioJobId).toBeNull();
      expect(dbState.productImages[0].reviewStatus).toBe("APPROVED");
      expect(dbState.productImages[1].reviewStatus).toBe("APPROVED");

      // Verify external marketing campaigns are 100% untouched (RED LINE)
      expect(dbState.crmCampaigns).toHaveLength(1);
      expect(dbState.crmCampaigns[0].name).toBe("حملة تسويقية CRM");
      expect(dbState.storefrontPushCampaigns).toHaveLength(1);
      expect(dbState.storefrontPushCampaigns[0].name).toBe("إشعار متجر");
      expect(dbState.giftCampaigns).toHaveLength(1);
      expect(dbState.giftCampaigns[0].name).toBe("حملة هدايا");

      // Verify audit log entry
      expect(dbState.auditLogs).toHaveLength(1);
      expect(dbState.auditLogs[0].action).toBe("productStudio.atomicPurge");
      expect(dbState.auditLogs[0].entityType).toBe("productStudio");
      expect(dbState.auditLogs[0].newValue.preservedApprovedImages).toBe(2);
    });
  });

  describe("3. Ephemeral TTL Concurrency Locks", () => {
    it("acquires lock when no active lock exists", async () => {
      const res = await acquireOrCheckLock(employeeActor, { productId: 201 });
      expect(res.acquired).toBe(true);
      expect(res.remainingSeconds).toBe(90);

      expect(dbState.productPhotographyLocks).toHaveLength(1);
      expect(dbState.productPhotographyLocks[0].productId).toBe(201);
      expect(dbState.productPhotographyLocks[0].userId).toBe(employeeActor.userId);
      expect(dbState.productPhotographyLocks[0].userName).toBe("مصور تجريبي");
    });

    it("prevents collision: alerts other employee with active photographer name and remainingSeconds", async () => {
      // First employee locks product 202
      await acquireOrCheckLock(employeeActor, { productId: 202 });

      // Second employee attempts to acquire lock on product 202
      const res = await acquireOrCheckLock(otherEmployeeActor, { productId: 202 });
      expect(res.acquired).toBe(false);
      expect(res.activePhotographerName).toBe("مصور تجريبي");
      expect(res.remainingSeconds).toBeGreaterThan(0);
      expect(res.remainingSeconds).toBeLessThanOrEqual(90);
    });

    it("renews TTL lock when same owner re-checks or shoots again", async () => {
      await acquireOrCheckLock(employeeActor, { productId: 203 });
      const renewRes = await acquireOrCheckLock(employeeActor, { productId: 203 });

      expect(renewRes.acquired).toBe(true);
      expect(renewRes.remainingSeconds).toBe(90);
      expect(dbState.productPhotographyLocks).toHaveLength(1);
    });

    it("heartbeatLock extends lock TTL when called by owner", async () => {
      await acquireOrCheckLock(employeeActor, { productId: 204 });

      const hbRes = await heartbeatLock(employeeActor, { productId: 204 });
      expect(hbRes.renewed).toBe(true);

      // Heartbeat by non-owner returns renewed: false
      const nonOwnerHb = await heartbeatLock(otherEmployeeActor, { productId: 204 });
      expect(nonOwnerHb.renewed).toBe(false);
    });

    it("cleans up expired lock automatically when TTL elapses", async () => {
      // Seed expired lock
      dbState.productPhotographyLocks.push({
        productId: 205,
        userId: 99,
        userName: "مصور سابق",
        lockedAt: new Date(Date.now() - 100000),
        heartbeatAt: new Date(Date.now() - 100000),
        expiresAt: new Date(Date.now() - 10000), // expired 10s ago
      });

      // Employee acquires lock on expired product
      const res = await acquireOrCheckLock(employeeActor, { productId: 205 });
      expect(res.acquired).toBe(true);
      expect(res.remainingSeconds).toBe(90);
      expect(dbState.productPhotographyLocks[0].userId).toBe(employeeActor.userId);
    });

    it("releaseLock removes lock owned by caller", async () => {
      await acquireOrCheckLock(employeeActor, { productId: 206 });
      expect(dbState.productPhotographyLocks).toHaveLength(1);

      const relRes = await releaseLock(employeeActor, { productId: 206 });
      expect(relRes.released).toBe(true);
      expect(dbState.productPhotographyLocks).toHaveLength(0);
    });

    it("rejects release of active lock owned by another user and leaves lock intact", async () => {
      // User A (employeeActor) acquires lock on product 207
      const acqRes = await acquireOrCheckLock(employeeActor, { productId: 207 });
      expect(acqRes.acquired).toBe(true);
      expect(dbState.productPhotographyLocks).toHaveLength(1);
      expect(dbState.productPhotographyLocks[0].userId).toBe(employeeActor.userId);

      // User B (otherEmployeeActor) attempts to release User A's active lock
      const relRes = await releaseLock(otherEmployeeActor, { productId: 207 });
      expect(relRes.released).toBe(false);

      // Verify User A's lock remains completely intact in the database
      expect(dbState.productPhotographyLocks).toHaveLength(1);
      expect(dbState.productPhotographyLocks[0].productId).toBe(207);
      expect(dbState.productPhotographyLocks[0].userId).toBe(employeeActor.userId);
      expect(dbState.productPhotographyLocks[0].userName).toBe("مصور تجريبي");
    });

    it("releaseLock on unlocked product is idempotent and returns released: true", async () => {
      const relRes = await releaseLock(employeeActor, { productId: 9999 });
      expect(relRes.released).toBe(true);
    });

    it("releaseLock removes an expired foreign lock", async () => {
      // Seed expired lock owned by user 99
      dbState.productPhotographyLocks.push({
        productId: 208,
        userId: 99,
        userName: "مصور سابق",
        lockedAt: new Date(Date.now() - 100000),
        heartbeatAt: new Date(Date.now() - 100000),
        expiresAt: new Date(Date.now() - 10000), // expired 10s ago
      });

      const relRes = await releaseLock(employeeActor, { productId: 208 });
      expect(relRes.released).toBe(true);
      expect(dbState.productPhotographyLocks.filter((l) => l.productId === 208)).toHaveLength(0);
    });

    it("handles 10 concurrent acquire attempts via Promise.all: exactly 1 acquires and 9 reject", async () => {
      const tenUsers: ProductStudioActor[] = Array.from({ length: 10 }, (_, i) => ({
        userId: 100 + i,
        branchId: 1,
        role: "cashier",
        isOwner: false,
        name: `المصور رقم ${i + 1}`,
      }));

      // Fire 10 concurrent acquire attempts simultaneously
      const results = await Promise.all(
        tenUsers.map((actor) => acquireOrCheckLock(actor, { productId: 888 })),
      );

      const acquired = results.filter((r) => r.acquired === true);
      const rejected = results.filter((r) => r.acquired === false);

      // Exactly 1 winner acquired
      expect(acquired).toHaveLength(1);
      expect(acquired[0].remainingSeconds).toBe(90);

      // Exactly 9 losers rejected
      expect(rejected).toHaveLength(9);

      // Find the winner from the DB lock record
      expect(dbState.productPhotographyLocks).toHaveLength(1);
      const activeLock = dbState.productPhotographyLocks[0];
      expect(activeLock.productId).toBe(888);

      const winner = tenUsers.find((u) => u.userId === activeLock.userId);
      expect(winner).toBeDefined();

      // All 9 rejected callers must receive the winner's name and valid remainingSeconds
      for (const rej of rejected) {
        expect(rej.activePhotographerName).toBe(winner!.name);
        expect(rej.remainingSeconds).toBeGreaterThan(0);
        expect(rej.remainingSeconds).toBeLessThanOrEqual(90);
      }
    });
  });

  describe("4. Zero-Premature-Record Lifecycle", () => {
    beforeEach(() => {
      // Seed product and variants
      dbState.products.push({
        id: 301,
        name: "دفتر ملاحظات عالي الجودة",
        isActive: true,
        isService: false,
      });
      dbState.productVariants.push({
        id: 401,
        productId: 301,
        variantName: "أزرق",
        isActive: true,
      });
      dbState.productUnits.push({
        id: 501,
        variantId: 401,
        barcode: "6901234567890",
        isActive: true,
        isBaseUnit: true,
      });
    });

    it("quickBarcodeLookup is strictly read-only and includes lock status", async () => {
      // Active lock on product 301
      await acquireOrCheckLock(otherEmployeeActor, { productId: 301 });

      const initialJobCount = dbState.productImageJobs.length;
      const initialImageCount = dbState.productImages.length;

      const lookup = await quickBarcodeLookup(employeeActor, {
        productId: 301,
        variantId: 401,
      });

      // Assert strictly read-only
      expect(dbState.productImageJobs.length).toBe(initialJobCount);
      expect(dbState.productImages.length).toBe(initialImageCount);

      // Assert product details returned
      expect(lookup.product.id).toBe(301);
      expect(lookup.product.name).toBe("دفتر ملاحظات عالي الجودة");

      // Assert lock info is included
      expect(lookup.lock).toBeDefined();
      expect(lookup.lock.isLocked).toBe(true);
      expect(lookup.lock.activePhotographerName).toBe("مصور ثانٍ");
      expect(lookup.lock.remainingSeconds).toBeGreaterThan(0);
    });

    it("quickSaveBarcodeProductImage auto-releases the lock upon successful save", async () => {
      // Acquire lock first
      await acquireOrCheckLock(employeeActor, { productId: 301 });
      expect(dbState.productPhotographyLocks).toHaveLength(1);

      // Perform quick save
      const saveRes = await quickSaveBarcodeProductImage(employeeActor, {
        productId: 301,
        variantId: 401,
        processedDataUrl: "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        thumbnailDataUrl: "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        mode: "FLATTEN",
      });

      expect(saveRes.success).toBe(true);
      expect(saveRes.jobId).toBeDefined();

      // Lock must be released automatically
      expect(dbState.productPhotographyLocks).toHaveLength(0);
    });
  });

  describe("5. Idempotency & Debounce", () => {
    beforeEach(() => {
      dbState.products.push({
        id: 302,
        name: "قلم حبر جاف",
        isActive: true,
        isService: false,
      });
    });

    it("replays cached response on duplicate clientRequestId without duplicating records", async () => {
      const clientRequestId = "req-photographer-click-12345";
      const payload = {
        productId: 302,
        processedDataUrl: "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        thumbnailDataUrl: "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        mode: "FLATTEN" as const,
        clientRequestId,
      };

      // First submission
      const firstRes = await quickSaveBarcodeProductImage(employeeActor, payload);
      expect(firstRes.success).toBe(true);
      const jobId = firstRes.jobId;
      expect(dbState.productImageJobs).toHaveLength(1);

      // Duplicate submission (double click or retry)
      const duplicateRes = await quickSaveBarcodeProductImage(employeeActor, payload);
      expect(duplicateRes.success).toBe(true);
      expect(duplicateRes.jobId).toBe(jobId);

      // Must not create another job row
      expect(dbState.productImageJobs).toHaveLength(1);
    });

    it("throws CONFLICT if same clientRequestId is used with different payload", async () => {
      const clientRequestId = "req-photographer-conflict-999";
      const payload1 = {
        productId: 302,
        processedDataUrl: "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        thumbnailDataUrl: "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        mode: "FLATTEN" as const,
        clientRequestId,
      };

      await quickSaveBarcodeProductImage(employeeActor, payload1);

      const conflictingPayload = {
        productId: 302,
        processedDataUrl: "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        thumbnailDataUrl: "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        mode: "AI" as const, // Different mode -> different payload hash!
        clientRequestId,
      };

      await expect(quickSaveBarcodeProductImage(employeeActor, conflictingPayload)).rejects.toThrow(TRPCError);
    });
  });

  describe("6. Atomic Legacy Data Purge", () => {
    it("purges unapproved jobs while preserving APPROVED product images", async () => {
      dbState.productImages.push(
        { id: 101, productId: 801, url: "http://img-approved", reviewStatus: "APPROVED", publishedStudioJobId: 44 },
      );
      dbState.productImageJobs.push(
        { id: 44, productId: 801, status: "IN_PROGRESS" },
      );

      const purgeRes = await purgeProductStudioLegacyData(managerActor);
      expect(purgeRes.success).toBe(true);
      expect(purgeRes.preservedApprovedImages).toBe(1);
      expect(dbState.productImageJobs).toHaveLength(0);
      expect(dbState.productImages).toHaveLength(1);
    });
  });

  describe("7. Router Endpoints Integration", () => {
    function createCaller(user: any) {
      return productStudioRouter.createCaller({
        user,
        req: {} as any,
        res: {} as any,
      } as any);
    }

    it("exposes acquireOrCheckLock, heartbeatLock, releaseLock, and purgeProductStudioLegacyData", async () => {
      const caller = createCaller({
        id: 1,
        name: "مدير النظام",
        email: "admin@alroya.local",
        role: "admin",
        branchId: 1,
        isOwner: true,
        permissionsOverride: { productStudio: "FULL" },
      });

      const lockRes = await caller.acquireOrCheckLock({ productId: 999 });
      expect(lockRes.acquired).toBe(true);

      const hbRes = await caller.heartbeatLock({ productId: 999 });
      expect(hbRes.renewed).toBe(true);

      const relRes = await caller.releaseLock({ productId: 999 });
      expect(relRes.released).toBe(true);

      const purgeRes = await caller.purgeProductStudioLegacyData();
      expect(purgeRes.success).toBe(true);
    });
  });
});
