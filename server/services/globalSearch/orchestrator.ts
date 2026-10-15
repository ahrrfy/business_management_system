// نقطة الدخول: يشغّل بحث كل نوع مطلوب بالتوازي (Promise.all) ثم يرتّب النتائج برتبتها.
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import {
  hasOperationPolicy,
  operationRecordScope,
} from "@shared/operationPermissions";
import { getDb } from "../../db";
import type {
  SearchEntityType,
  SearchResult,
  GlobalSearchInput,
} from "./types";
import { classifyQuery } from "./types";
import {
  canSeeType,
  SEARCH_SOURCE_READ_PATH,
  MASTER_DATA_TYPES,
  BRANCH_SCOPED_TYPES,
  ADMIN_TYPES,
} from "./rbac";
import { searchEmployees, searchUsers } from "./searchHr";
import {
  searchProducts,
  searchCustomers,
  searchSuppliers,
} from "./searchMasterData";
import {
  searchInvoices,
  searchQuotations,
  searchWorkOrders,
  searchPurchaseOrders,
  searchExpenses,
} from "./searchDocuments";

function resolveBranchScope(input: GlobalSearchInput): number | null {
  // عبور الفروع صفة الإدارة الثابتة؛ OWN يقيّد سجلات النتائج بصورة مستقلة.
  if (input.role === "admin") return null;
  if (input.branchId == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر البحث",
        why: "البحث الشامل يعرض سجلّات فرعك وحده، وحسابُك بلا فرعٍ مُسنَد",
        doThis:
          "اطلب من المدير إسناد فرعٍ لحسابك من شاشة المستخدمين، ثمّ أعد البحث",
      }),
    });
  }
  return input.branchId;
}

export async function globalSearch(
  input: GlobalSearchInput,
): Promise<SearchResult[]> {
  const scopedBranchId = resolveBranchScope(input);
  const db = getDb();
  if (!db) return [];

  const { kind, query } = classifyQuery(input.query);
  if (!query) return [];

  const perEntityLimit = Math.min(Math.max(input.perEntityLimit ?? 6, 1), 20);
  const override = input.permissionsOverride ?? null;
  const canSearchType = (type: SearchEntityType) =>
    canSeeType(input.role, type, override, input.operationUser);
  const ownerForType = (type: SearchEntityType): number | null => {
    const user = input.operationUser;
    if (
      !user ||
      !hasOperationPolicy(user) ||
      user.isOwner ||
      operationRecordScope(user, SEARCH_SOURCE_READ_PATH[type]) !== "OWN"
    )
      return null;
    // غياب هوية الفاعل يفشل مغلقاً، ولا يحوّل OWN إلى رؤية الفرع.
    return Number.isInteger(user.id) && Number(user.id) > 0
      ? Number(user.id)
      : -1;
  };
  const requested = new Set<SearchEntityType>(
    (
      input.scopes ?? [
        ...MASTER_DATA_TYPES,
        ...BRANCH_SCOPED_TYPES,
        ...ADMIN_TYPES,
      ]
    ).filter((t) => canSearchType(t)),
  );

  const tasks: Promise<SearchResult[]>[] = [];

  if (requested.has("PRODUCT"))
    tasks.push(searchProducts(db, kind, query, perEntityLimit, scopedBranchId));
  if (requested.has("CUSTOMER"))
    tasks.push(searchCustomers(db, kind, query, perEntityLimit));
  if (requested.has("SUPPLIER"))
    tasks.push(searchSuppliers(db, kind, query, perEntityLimit));

  if (requested.has("INVOICE"))
    tasks.push(
      searchInvoices(
        db,
        kind,
        query,
        perEntityLimit,
        scopedBranchId,
        ownerForType("INVOICE"),
      ),
    );
  if (requested.has("QUOTATION"))
    tasks.push(
      searchQuotations(db, kind, query, perEntityLimit, scopedBranchId),
    );
  if (requested.has("WORK_ORDER"))
    tasks.push(
      searchWorkOrders(db, kind, query, perEntityLimit, scopedBranchId),
    );
  if (requested.has("PURCHASE_ORDER"))
    tasks.push(
      searchPurchaseOrders(db, kind, query, perEntityLimit, scopedBranchId),
    );
  if (requested.has("EXPENSE"))
    tasks.push(
      searchExpenses(
        db,
        kind,
        query,
        perEntityLimit,
        scopedBranchId,
        ownerForType("EXPENSE"),
      ),
    );

  // كيانات إدارية (موظف/مستخدم) — RBAC مطبَّق في canSeeType (يحلّ override)، وتشمل تحليل كود EMP-/USER-.
  if (requested.has("EMPLOYEE"))
    tasks.push(
      searchEmployees(db, kind, query, perEntityLimit, scopedBranchId),
    );
  if (requested.has("USER"))
    tasks.push(searchUsers(db, kind, query, perEntityLimit));

  const groups = await Promise.all(tasks);
  return groups.flat().sort((a, b) => a.rank - b.rank);
}
