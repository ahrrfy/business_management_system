// نقطة الدخول: يشغّل بحث كل نوع مطلوب بالتوازي (Promise.all) ثم يرتّب النتائج برتبتها.
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { getDb } from "../../db";
import type { SearchEntityType, SearchResult, GlobalSearchInput } from "./types";
import { classifyQuery } from "./types";
import { canSeeType, MASTER_DATA_TYPES, BRANCH_SCOPED_TYPES, ADMIN_TYPES } from "./rbac";
import { searchEmployees, searchUsers } from "./searchHr";
import { searchProducts, searchCustomers, searchSuppliers } from "./searchMasterData";
import { searchInvoices, searchQuotations, searchWorkOrders, searchPurchaseOrders, searchExpenses } from "./searchDocuments";

function resolveBranchScope(input: GlobalSearchInput): number | null {
  // يُطبَّع المالك إلى admin في سياق الطلب؛ لذلك admin وحده يصل هنا بصلاحية عبور مثبتة.
  if (input.role === "admin") return null;
  if (input.branchId == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر البحث",
        why: "البحث الشامل يعرض سجلّات فرعك وحده، وحسابُك بلا فرعٍ مُسنَد",
        doThis: "اطلب من المدير إسناد فرعٍ لحسابك من شاشة المستخدمين، ثمّ أعد البحث",
      }),
    });
  }
  return input.branchId;
}

export async function globalSearch(input: GlobalSearchInput): Promise<SearchResult[]> {
  const scopedBranchId = resolveBranchScope(input);
  const db = getDb();
  if (!db) return [];

  const { kind, query } = classifyQuery(input.query);
  if (!query) return [];

  const perEntityLimit = Math.min(Math.max(input.perEntityLimit ?? 6, 1), 20);
  const override = input.permissionsOverride ?? null;
  const requested = new Set<SearchEntityType>(
    (input.scopes ?? [...MASTER_DATA_TYPES, ...BRANCH_SCOPED_TYPES, ...ADMIN_TYPES]).filter((t) =>
      canSeeType(input.role, t, override),
    ),
  );

  const tasks: Promise<SearchResult[]>[] = [];

  if (requested.has("PRODUCT")) tasks.push(searchProducts(db, kind, query, perEntityLimit));
  if (requested.has("CUSTOMER")) tasks.push(searchCustomers(db, kind, query, perEntityLimit));
  if (requested.has("SUPPLIER") && canSeeType(input.role, "SUPPLIER", override))
    tasks.push(searchSuppliers(db, kind, query, perEntityLimit));

  if (requested.has("INVOICE")) tasks.push(searchInvoices(db, kind, query, perEntityLimit, scopedBranchId));
  if (requested.has("QUOTATION")) tasks.push(searchQuotations(db, kind, query, perEntityLimit, scopedBranchId));
  if (requested.has("WORK_ORDER")) tasks.push(searchWorkOrders(db, kind, query, perEntityLimit, scopedBranchId));
  if (requested.has("PURCHASE_ORDER") && canSeeType(input.role, "PURCHASE_ORDER", override))
    tasks.push(searchPurchaseOrders(db, kind, query, perEntityLimit, scopedBranchId));
  if (requested.has("EXPENSE") && canSeeType(input.role, "EXPENSE", override))
    tasks.push(searchExpenses(db, kind, query, perEntityLimit, scopedBranchId));

  // كيانات إدارية (موظف/مستخدم) — RBAC مطبَّق في canSeeType (يحلّ override)، وتشمل تحليل كود EMP-/USER-.
  if (requested.has("EMPLOYEE") && canSeeType(input.role, "EMPLOYEE", override))
    tasks.push(searchEmployees(db, kind, query, perEntityLimit, scopedBranchId));
  if (requested.has("USER") && canSeeType(input.role, "USER", override))
    tasks.push(searchUsers(db, kind, query, perEntityLimit));

  const groups = await Promise.all(tasks);
  return groups.flat().sort((a, b) => a.rank - b.rank);
}
