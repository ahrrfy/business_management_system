import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import * as schema from "../../../drizzle/schema";

// --- Multi-Tenant DB State Factory ---
type DbState = {
  productImages: any[];
  productImageJobs: any[];
  productImageObjectStaging: any[];
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
    productImageObjectStaging: [],
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
  if (target === schema.productImageObjectStaging) return state.productImageObjectStaging;
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
      innerJoin: () => builder,
      groupBy: () => builder,
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
        __filter: (item: any) => item[colName] === val,
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
  isMultiTenantModeActive: () => true,
  getCurrentTenantDb: () => mockDb,
}));

const tenancyContextMock = {
  runWithCompany: async <T>(companyId: number, _db: any, fn: () => Promise<T> | T): Promise<T> => {
    const prev = activeCompanyContext;
    activeCompanyContext = companyId;
    try {
      return await fn();
    } finally {
      activeCompanyContext = prev;
    }
  },
  getCurrentCompanyId: () => activeCompanyContext ?? dbState.currentCompanyId,
  getCurrentTenantDb: () => mockDb,
};

vi.mock("../../tenancy/context", () => ({
  runWithCompany: <T>(companyId: number, db: any, fn: () => Promise<T> | T) =>
    tenancyContextMock.runWithCompany(companyId, db, fn),
  getCurrentCompanyId: () => tenancyContextMock.getCurrentCompanyId(),
  getCurrentTenantDb: () => tenancyContextMock.getCurrentTenantDb(),
}));

vi.mock("../tenancy/context", () => ({
  runWithCompany: <T>(companyId: number, db: any, fn: () => Promise<T> | T) =>
    tenancyContextMock.runWithCompany(companyId, db, fn),
  getCurrentCompanyId: () => tenancyContextMock.getCurrentCompanyId(),
  getCurrentTenantDb: () => tenancyContextMock.getCurrentTenantDb(),
}));

vi.mock("../tenancy/registry", () => ({
  resolveCompanyById: vi.fn().mockImplementation((id: number) =>
    Promise.resolve({ id, code: `company_${id}`, name: `Company ${id}` }),
  ),
}));

vi.mock("../../tenancy/registry", () => ({
  resolveCompanyById: vi.fn().mockImplementation((id: number) =>
    Promise.resolve({ id, code: `company_${id}`, name: `Company ${id}` }),
  ),
}));

vi.mock("../../lib/imageStore", () => ({
  getImageStore: () => ({
    put: vi.fn().mockResolvedValue("mock-key"),
    get: vi.fn(),
    delete: vi.fn(),
  }),
  assertImageStoreOperationalConfiguration: vi.fn(),
  isImageStoreOperational: () => true,
  shortHash: (h: string) => (h ? h.slice(0, 12) : "abcdef123456"),
  contentHash: () => "hash-mock-123456",
  objectKeyFor: (hash: string, mime: string, prefix: string) => `${prefix}/${hash}.${mime.split("/")[1] || "jpg"}`,
  studioObjectPrefix: (kind: string) => `studio/${kind}`,
  MAX_PUBLISHED_PRODUCT_IMAGE_BYTES: 5 * 1024 * 1024,
}));

vi.mock("../lib/imageStore", () => ({
  getImageStore: () => ({
    put: vi.fn().mockResolvedValue("mock-key"),
    get: vi.fn(),
    delete: vi.fn(),
  }),
  assertImageStoreOperationalConfiguration: vi.fn(),
  isImageStoreOperational: () => true,
  shortHash: (h: string) => (h ? h.slice(0, 12) : "abcdef123456"),
  contentHash: () => "hash-mock-123456",
  objectKeyFor: (hash: string, mime: string, prefix: string) => `${prefix}/${hash}.${mime.split("/")[1] || "jpg"}`,
  studioObjectPrefix: (kind: string) => `studio/${kind}`,
  MAX_PUBLISHED_PRODUCT_IMAGE_BYTES: 5 * 1024 * 1024,
}));

vi.mock("../imageStudioSettingsService", () => ({
  getAiStudioRuntime: vi.fn().mockResolvedValue(null),
  getDecryptedRemovebgKey: vi.fn().mockResolvedValue(null),
}));

import {
  bulkApproveStudioTasks,
  bulkRejectStudioTasks,
  clearRecentCacheInvalidations,
  generateCacheBustedImageUrl,
  getRecentCacheInvalidations,
  invalidateProductStudioCaches,
  quickBarcodeLookup,
  setProductImagePrimaryStatus,
  type ProductStudioActor,
} from "../productStudioService";
import {
  AI_STUDIO_FIDELITY_GUARD,
  DEFAULT_GEMINI_IMAGE_MODEL,
  executeStudioAiWithFallback,
} from "../aiImageStudioService";
import { buildAiStudioPrompt } from "@shared/imageStudio/aiPrompt";
import { routeOperationAuthority } from "../authorization/operationAuthority";
import type { OperationUser } from "@shared/operationPermissions";

describe("Milestone 2: Backend AI, Bulk Approvals, Rejection Loop & Sync", () => {
  const managerUser: OperationUser & { id: number; branchId?: number } = {
    id: 1,
    role: "manager",
    branchId: 1,
    operationPolicyEnabled: true,
    resolvedOperationPolicy: {
      version: 1,
      grants: {
        "operation.productStudio.bulkApproveStudioTasks": true,
        "operation.productStudio.bulkRejectStudioTasks": true,
      },
      recordScopes: {
        "operation.productStudio.bulkApproveStudioTasks": "BRANCH",
        "operation.productStudio.bulkRejectStudioTasks": "BRANCH",
      },
    },
  };

  const managerActor: ProductStudioActor = {
    userId: 1,
    role: "manager",
    branchId: 1,
    name: "مدير النظام",
  };

  const employeeActor: ProductStudioActor = {
    userId: 2,
    role: "cashier",
    branchId: 1,
    name: "مصور تجريبي",
  };

  beforeEach(() => {
    activeCompanyContext = 1;
    dbState = createInitialDbState(1);
    tenantDbStates.clear();
    tenantDbStates.set(1, dbState);
    tenantDbStates.set(2, createInitialDbState(2));
    clearRecentCacheInvalidations();

    // Populate common products in company 1
    dbState.products.push(
      { id: 101, name: "كتاب الكيمياء للمرحلة الثانوية", description: "كتاب دراسي", isActive: true },
      { id: 102, name: "دفتر ملاحظات سلك 100 ورقة", description: "دفتر عالي الجودة", isActive: true },
      { id: 103, name: "قلم حبر أزرق جاف", description: "علبة أقلام", isActive: true },
    );

    // Populate common product units
    dbState.productUnits.push(
      { id: 1, productId: 101, barcode: "9781234567890", unitName: "قطعة", isBaseUnit: true, isActive: true },
      { id: 2, productId: 102, barcode: "6921234567890", unitName: "دفتر", isBaseUnit: true, isActive: true },
    );
  });

  // =========================================================================
  // 1. Bulk Approvals (bulkApproveStudioTasks)
  // =========================================================================
  describe("1. Bulk Approvals (bulkApproveStudioTasks)", () => {
    it("promotes pending tasks to APPROVED, creates/updates catalog images, logs audit, and invalidates caches", async () => {
      // Setup pending jobs for products 101 and 102
      dbState.productImageJobs.push(
        {
          id: 501,
          productId: 101,
          branchId: 1,
          status: "PENDING_REVIEW",
          processedObjectKey: "candidates/img501.webp",
          processedContentHash: "hash-501",
          processedMime: "image/webp",
          processedBytes: 45000,
          processedWidth: 1,
          processedHeight: 1,
          processedUrl: "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=",
          mode: "AI",
          assignedTo: 2,
          revision: 1,
        },
        {
          id: 502,
          productId: 102,
          branchId: 1,
          status: "PENDING_REVIEW",
          processedObjectKey: "candidates/img502.webp",
          processedContentHash: "hash-502",
          processedMime: "image/webp",
          processedBytes: 52000,
          processedWidth: 1,
          processedHeight: 1,
          processedUrl: "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=",
          mode: "PRO",
          assignedTo: 2,
          revision: 1,
        },
      );

      const result = await bulkApproveStudioTasks(managerActor, {
        taskIds: [501, 502],
        adminOverrideReason: "تم التدقيق والموافقة على الجودة",
      });

      expect(result.approvedCount).toBe(2);
      expect(result.taskIds).toEqual([501, 502]);

      // Verify job records updated
      const job501 = dbState.productImageJobs.find((j) => j.id === 501);
      const job502 = dbState.productImageJobs.find((j) => j.id === 502);
      expect(job501.status).toBe("APPROVED");
      expect(job501.reviewedBy).toBe(managerActor.userId);
      expect(job501.reviewedAt).toBeInstanceOf(Date);
      expect(job502.status).toBe("APPROVED");

      // Verify productImages created with reviewStatus = APPROVED
      const approvedImages101 = dbState.productImages.filter((img) => img.productId === 101 && img.reviewStatus === "APPROVED");
      const approvedImages102 = dbState.productImages.filter((img) => img.productId === 102 && img.reviewStatus === "APPROVED");
      expect(approvedImages101.length).toBe(1);
      expect(approvedImages102.length).toBe(1);
      expect(approvedImages101[0].isPrimary).toBe(true); // Promoted to primary since no previous primary existed
      expect(approvedImages102[0].isPrimary).toBe(true);

      // Verify silent audit logs
      const auditEntries = dbState.auditLogs.filter((a) => a.action === "productStudio.bulkApprove");
      expect(auditEntries.length).toBe(2);
      expect(auditEntries[0].userId).toBe(managerActor.userId);
      expect(auditEntries[0].newValue.photographerId).toBe(2);
      expect(auditEntries[0].newValue.approverId).toBe(managerActor.userId);

      // Verify cache invalidation dispatched
      const recentInvalidations = getRecentCacheInvalidations();
      expect(recentInvalidations.length).toBeGreaterThan(0);
      const last = recentInvalidations[recentInvalidations.length - 1];
      expect(last.channels).toContain("catalog.adminList");
      expect(last.channels).toContain("catalog.posList");
      expect(last.channels).toContain("kiosk.banner");
      expect(last.channels).toContain("storefront");
      expect(last.productIds).toContain(101);
      expect(last.productIds).toContain(102);
    });

    it("rejects non-manager accounts with FORBIDDEN", async () => {
      await expect(
        bulkApproveStudioTasks(employeeActor, { taskIds: [501] }),
      ).rejects.toThrow(TRPCError);
    });

    it("preserves existing primary cover when product already has an approved primary image", async () => {
      // Pre-existing approved primary image for product 101
      dbState.productImages.push({
        id: 99,
        productId: 101,
        variantId: null,
        url: "/api/img/product/99?v=initial",
        isPrimary: true,
        sortOrder: 1,
        reviewStatus: "APPROVED",
      });

      // New pending job
      dbState.productImageJobs.push({
        id: 503,
        productId: 101,
        branchId: 1,
        status: "PENDING_REVIEW",
        processedObjectKey: "candidates/img503.webp",
        processedContentHash: "hash-503",
        processedMime: "image/webp",
        processedWidth: 1,
        processedHeight: 1,
        processedUrl: "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=",
        mode: "FLATTEN",
        revision: 1,
      });

      await bulkApproveStudioTasks(managerActor, { taskIds: [503] });

      const oldImg = dbState.productImages.find((img) => img.id === 99);
      const newImg = dbState.productImages.find((img) => img.publishedStudioJobId === 503);
      expect(oldImg.isPrimary).toBe(true);
      expect(newImg.isPrimary).toBe(false); // Does not overwrite existing primary
    });

    it("successfully validates operation authority binding for bulkApproveStudioTasks", async () => {
      dbState.productImageJobs.push({
        id: 510,
        productId: 101,
        branchId: 1,
        status: "PENDING_REVIEW",
        processedObjectKey: "candidates/img510.webp",
        processedContentHash: "hash-510",
        processedMime: "image/webp",
        processedBytes: 45000,
        processedWidth: 1,
        processedHeight: 1,
        processedUrl: "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=",
        mode: "AI",
        assignedTo: 2,
        revision: 1,
      });

      const approvalAuthority = routeOperationAuthority(
        managerUser,
        "productStudio.bulkApproveStudioTasks",
      );
      expect(approvalAuthority).toBeDefined();
      expect(approvalAuthority?.path).toBe("productStudio.bulkApproveStudioTasks");

      const actorWithAuthority: ProductStudioActor = {
        ...managerActor,
        operationAuthority: approvalAuthority,
      };

      const result = await bulkApproveStudioTasks(actorWithAuthority, {
        taskIds: [510],
      });
      expect(result.approvedCount).toBe(1);
      expect(result.taskIds).toEqual([510]);

      // Mismatched authority path is rejected with FORBIDDEN
      const mismatchedAuthority = routeOperationAuthority(
        managerUser,
        "productStudio.bulkRejectStudioTasks",
      );
      const actorWithWrongAuthority: ProductStudioActor = {
        ...managerActor,
        operationAuthority: mismatchedAuthority,
      };
      await expect(
        bulkApproveStudioTasks(actorWithWrongAuthority, { taskIds: [510] }),
      ).rejects.toThrow(TRPCError);
    });
  });

  // =========================================================================
  // 2. Bulk Rejections (bulkRejectStudioTasks) & Safeguards
  // =========================================================================
  describe("2. Bulk Rejections (bulkRejectStudioTasks) & Safeguards", () => {
    it("updates tasks to REJECTED, records rejection reason, and never deletes approved catalog images", async () => {
      // Existing approved catalog image (must NOT be touched or deleted)
      dbState.productImages.push({
        id: 77,
        productId: 101,
        url: "/api/img/product/77?v=clean",
        reviewStatus: "APPROVED",
        isPrimary: true,
      });

      // Pending staging job linked to a staging image record
      dbState.productImages.push({
        id: 78,
        productId: 101,
        url: "stored-object",
        reviewStatus: "PENDING_REVIEW",
        isPrimary: false,
      });

      dbState.productImageJobs.push({
        id: 601,
        productId: 101,
        branchId: 1,
        sourceImageId: 78,
        status: "PENDING_REVIEW",
        processedUrl: "data:image/jpeg;base64,candidate601",
        processedObjectKey: "candidates/img601.webp",
        assignedTo: 2,
        revision: 1,
      });

      const result = await bulkRejectStudioTasks(managerActor, {
        taskIds: [601],
        reason: "الإضاءة خافتة جداً وزاوية الالتقاط غير مستوية",
      });

      expect(result.rejectedCount).toBe(1);
      expect(result.taskIds).toEqual([601]);

      const job = dbState.productImageJobs.find((j) => j.id === 601);
      expect(job.status).toBe("REJECTED");
      expect(job.rejectionReason).toBe("الإضاءة خافتة جداً وزاوية الالتقاط غير مستوية");
      expect(job.reviewedBy).toBe(managerActor.userId);
      expect(job.processedUrl).toBeNull(); // Cleared on rejection

      // Staging unlinked/updated to REJECTED
      const stagingImg = dbState.productImages.find((img) => img.id === 78);
      expect(stagingImg.reviewStatus).toBe("REJECTED");

      // CRITICAL INTEGRITY SAFEGUARD: Approved catalog image is 100% UNTOUCHED
      const approvedImg = dbState.productImages.find((img) => img.id === 77);
      expect(approvedImg).toBeDefined();
      expect(approvedImg.reviewStatus).toBe("APPROVED");
      expect(approvedImg.isPrimary).toBe(true);

      // Verify audit entry
      const audit = dbState.auditLogs.find((a) => a.action === "productStudio.bulkReject");
      expect(audit).toBeDefined();
      expect(audit.newValue.reason).toBe("الإضاءة خافتة جداً وزاوية الالتقاط غير مستوية");
      expect(audit.newValue.photographerId).toBe(2);
    });

    it("rejects rejection reasons shorter than 5 characters with BAD_REQUEST", async () => {
      await expect(
        bulkRejectStudioTasks(managerActor, { taskIds: [601], reason: "لا" }),
      ).rejects.toThrow(TRPCError);
    });

    it("rejects non-manager actors with FORBIDDEN", async () => {
      await expect(
        bulkRejectStudioTasks(employeeActor, { taskIds: [601], reason: "سبب وجيه للرفض" }),
      ).rejects.toThrow(TRPCError);
    });

    it("successfully validates operation authority binding for bulkRejectStudioTasks", async () => {
      dbState.productImageJobs.push({
        id: 610,
        productId: 101,
        branchId: 1,
        status: "PENDING_REVIEW",
        processedUrl: "data:image/jpeg;base64,candidate610",
        assignedTo: 2,
        revision: 1,
      });

      const rejectAuthority = routeOperationAuthority(
        managerUser,
        "productStudio.bulkRejectStudioTasks",
      );
      expect(rejectAuthority).toBeDefined();
      expect(rejectAuthority?.path).toBe("productStudio.bulkRejectStudioTasks");

      const actorWithAuthority: ProductStudioActor = {
        ...managerActor,
        operationAuthority: rejectAuthority,
      };

      const result = await bulkRejectStudioTasks(actorWithAuthority, {
        taskIds: [610],
        reason: "الصورة غير واضحة وتحتاج إعادة تصوير",
      });
      expect(result.rejectedCount).toBe(1);
      expect(result.taskIds).toEqual([610]);

      // Mismatched authority path is rejected with FORBIDDEN
      const mismatchedAuthority = routeOperationAuthority(
        managerUser,
        "productStudio.bulkApproveStudioTasks",
      );
      const actorWithWrongAuthority: ProductStudioActor = {
        ...managerActor,
        operationAuthority: mismatchedAuthority,
      };
      await expect(
        bulkRejectStudioTasks(actorWithWrongAuthority, {
          taskIds: [610],
          reason: "الصورة غير واضحة وتحتاج إعادة تصوير",
        }),
      ).rejects.toThrow(TRPCError);
    });
  });

  // =========================================================================
  // 3. Quick Barcode Lookup Rejection Surfacing & Reshoot Recovery
  // =========================================================================
  describe("3. Quick Barcode Lookup Rejection Surfacing & Reshoot Recovery", () => {
    it("surfaces REJECTED activeJob state with rejectionReason to enable instant 1-click reshooting", async () => {
      // Product 101 has a recently rejected job
      dbState.productImageJobs.push({
        id: 701,
        productId: 101,
        status: "REJECTED",
        rejectionReason: "الصورة بها انعكاس ضوئي شديد على غلاف الكتاب",
        assignedTo: employeeActor.userId,
        activeSlot: 1,
      });

      const lookup = await quickBarcodeLookup(employeeActor, {
        productId: 101,
        barcode: "9781234567890",
      });

      expect(lookup.found).toBe(true);
      expect(lookup.product.id).toBe(101);
      expect(lookup.activeJob).toBeDefined();
      expect(lookup.activeJob?.status).toBe("REJECTED");
      expect(lookup.activeJob?.rejectionReason).toBe("الصورة بها انعكاس ضوئي شديد على غلاف الكتاب");
      expect(lookup.activeJob?.activeSlot).toBe(1);

      // Lock is not stuck for the worker
      expect(lookup.lock.isLocked).toBe(false);
    });
  });

  // =========================================================================
  // 4. Primary Cover Image Management (setProductImagePrimaryStatus)
  // =========================================================================
  describe("4. Primary Cover Image Management (setProductImagePrimaryStatus)", () => {
    it("enforces exactly ONE primary image per product/variant, demoting older primary images", async () => {
      // Two images for product 101: image 10 is currently primary
      dbState.productImages.push(
        { id: 10, productId: 101, variantId: null, isPrimary: true, reviewStatus: "APPROVED" },
        { id: 11, productId: 101, variantId: null, isPrimary: false, reviewStatus: "APPROVED" },
      );

      // Set image 11 as primary
      const res = await setProductImagePrimaryStatus(managerActor, {
        productId: 101,
        imageId: 11,
        isPrimary: true,
      });

      expect(res.success).toBe(true);
      expect(res.imageId).toBe(11);
      expect(res.isPrimary).toBe(true);

      const img10 = dbState.productImages.find((img) => img.id === 10);
      const img11 = dbState.productImages.find((img) => img.id === 11);
      expect(img10.isPrimary).toBe(false); // Demoted
      expect(img11.isPrimary).toBe(true); // Promoted

      // Verify silent audit logging
      const audit = dbState.auditLogs.find((a) => a.action === "productStudio.setPrimary");
      expect(audit).toBeDefined();
      expect(audit.newValue.imageId).toBe(11);
      expect(audit.newValue.isPrimary).toBe(true);

      // Verify cache invalidation triggered
      const recent = getRecentCacheInvalidations();
      expect(recent.some((r) => r.productIds.includes(101))).toBe(true);
    });

    it("throws NOT_FOUND when target image does not belong to the product", async () => {
      await expect(
        setProductImagePrimaryStatus(managerActor, {
          productId: 101,
          imageId: 9999,
          isPrimary: true,
        }),
      ).rejects.toThrow(TRPCError);
    });
  });

  // =========================================================================
  // 5. AI Studio Fidelity Guard
  // =========================================================================
  describe("5. AI Studio Fidelity Guard (aiImageStudioService)", () => {
    it("configures standard model and defines AI_STUDIO_FIDELITY_GUARD with all 5 mandatory protections", () => {
      expect(DEFAULT_GEMINI_IMAGE_MODEL).toBe("gemini-3.1-flash-lite-image");
      expect(AI_STUDIO_FIDELITY_GUARD).toBeDefined();

      // 1. Arabic text preservation
      expect(AI_STUDIO_FIDELITY_GUARD).toContain("Arabic text character-for-character preservation");
      expect(AI_STUDIO_FIDELITY_GUARD).toContain("book titles, author names, packaging labels, instructions");

      // 2. Brand logo and trademark geometry preservation
      expect(AI_STUDIO_FIDELITY_GUARD).toContain("Brand logo and trademark geometry preservation");

      // 3. Packaging geometry integrity (zero warping)
      expect(AI_STUDIO_FIDELITY_GUARD).toContain("Zero warping");
      expect(AI_STUDIO_FIDELITY_GUARD).toContain("crisp box, book, package, and container edges");

      // 4. Studio clean neutral background (#FFFFFF) and diffused lighting
      expect(AI_STUDIO_FIDELITY_GUARD).toContain("#FFFFFF");
      expect(AI_STUDIO_FIDELITY_GUARD).toContain("diffused lightbox lighting");
      expect(AI_STUDIO_FIDELITY_GUARD).toContain("contact shadow");

      // 5. Strict color preservation
      expect(AI_STUDIO_FIDELITY_GUARD).toContain("Strict color preservation");
    });

    it("ensures buildAiStudioPrompt contains Zero warping and 100% Arabic text character-for-character preservation", () => {
      const prompt = buildAiStudioPrompt("Enhanced studio background");
      expect(prompt).toContain("Zero warping");
      expect(prompt).toContain("100% Arabic text character-for-character preservation");
      expect(prompt).toContain("Brand logo and trademark geometry preservation");
      expect(prompt).toContain("#FFFFFF");
      expect(prompt).toContain("diffused lightbox lighting");
      expect(prompt).toContain("Strict color preservation");
    });
  });

  // =========================================================================
  // 6. Graceful AI Fallback to Local FLATTEN
  // =========================================================================
  describe("6. Graceful AI Fallback to Local FLATTEN", () => {
    it("falls back to LOCAL_FLATTEN when API key is missing without dropping worker photo", async () => {
      const sampleDataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/";
      const result = await executeStudioAiWithFallback({
        imageDataUrl: sampleDataUrl,
        apiKey: "", // missing
      });

      expect(result.fallbackApplied).toBe(true);
      expect(result.provider).toBe("LOCAL_FLATTEN");
      expect(result.imageDataUrl).toBe(sampleDataUrl); // Worker photo preserved intact!
    });

    it("falls back to LOCAL_FLATTEN when external AI call times out or throws an error", async () => {
      const sampleDataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/";
      const mockFailingFetch = vi.fn().mockRejectedValue(new Error("Network timeout after 20000ms"));

      const result = await executeStudioAiWithFallback({
        imageDataUrl: sampleDataUrl,
        apiKey: "fake-key-for-test",
        fetchImpl: mockFailingFetch as any,
      });

      expect(result.fallbackApplied).toBe(true);
      expect(result.provider).toBe("LOCAL_FLATTEN");
      expect(result.imageDataUrl).toBe(sampleDataUrl); // Worker photo is NEVER lost!
      expect(result.fallbackReason).toBeDefined();
    });
  });

  // =========================================================================
  // 7. Silent Audit Logging & Multi-Tenant Isolation
  // =========================================================================
  describe("7. Silent Audit Logging & Multi-Tenant Isolation", () => {
    it("strictly isolates bulk approvals between tenants", async () => {
      // In Tenant 1: Job 801 on Product 101
      dbState.productImageJobs.push({
        id: 801,
        productId: 101,
        branchId: 1,
        status: "PENDING_REVIEW",
        processedObjectKey: "candidates/img801.webp",
        processedContentHash: "hash-801",
        processedMime: "image/webp",
        processedWidth: 1,
        processedHeight: 1,
        processedUrl: "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=",
        mode: "FLATTEN",
      });

      // Switch context to Tenant 2
      const tenant2State = tenantDbStates.get(2)!;
      tenant2State.products.push({ id: 101, name: "منتج شركة ثانية بنفس المعرّف", isActive: true });

      // In Tenant 2, job 801 should NOT exist
      await tenancyContextMock.runWithCompany(2, mockDb, async () => {
        const lookup = await quickBarcodeLookup(managerActor, { productId: 101 });
        expect(lookup.activeJob).toBeNull(); // Tenant 2 cannot see Tenant 1's pending job
      });

      // Bulk approval in Tenant 1 works cleanly
      const approveRes = await bulkApproveStudioTasks(managerActor, { taskIds: [801] });
      expect(approveRes.approvedCount).toBe(1);

      // Audit log exists only in Tenant 1
      expect(dbState.auditLogs.some((a) => a.action === "productStudio.bulkApprove")).toBe(true);
      expect(tenant2State.auditLogs.length).toBe(0);
    });
  });

  // =========================================================================
  // 8. Cache Busting URLs & Multi-System Sync
  // =========================================================================
  describe("8. Cache Busting URLs & Multi-System Sync", () => {
    it("generates deterministic cache-busting URLs across relative, query-based, and plain URLs", () => {
      const url1 = generateCacheBustedImageUrl("/api/img/product/101", "v12345");
      expect(url1).toBe("/api/img/product/101?v=v12345");

      // Replaces existing version parameter
      const url2 = generateCacheBustedImageUrl("/api/img/product/101?v=oldHash", "newHash");
      expect(url2).toBe("/api/img/product/101?v=newHash");

      // Preserves existing unrelated query parameters
      const url3 = generateCacheBustedImageUrl("/api/img/product/101?size=thumb&v=v1", "v2");
      expect(url3).toContain("size=thumb");
      expect(url3).toContain("v=v2");

      // Data URLs are returned as-is
      const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      expect(generateCacheBustedImageUrl(dataUrl)).toBe(dataUrl);
    });

    it("dispatches multi-system cache invalidation to catalog, pos, kiosk, and storefront", () => {
      const invalidation = invalidateProductStudioCaches(1, [101, 102]);

      expect(invalidation.success).toBe(true);
      expect(invalidation.productCount).toBe(2);
      expect(invalidation.invalidatedChannels).toEqual([
        "catalog.adminList",
        "catalog.posList",
        "kiosk.banner",
        "storefront",
      ]);

      const recent = getRecentCacheInvalidations();
      expect(recent.length).toBe(1);
      expect(recent[0].companyId).toBe(1);
      expect(recent[0].productIds).toEqual([101, 102]);
    });
  });
});
