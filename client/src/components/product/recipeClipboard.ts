import { D } from "@/lib/money";

function validDecimal(value: string, positive = false): boolean {
  try {
    const decimal = D(value);
    return decimal.isFinite() && (positive ? decimal.gt(0) : decimal.gte(0));
  } catch {
    return false;
  }
}

export const RECIPE_CLIPBOARD_BASE_KEY = "alroya_recipe_clipboard_v1";
export const RECIPE_CLIPBOARD_KEY = "alroya_recipe_clipboard_v1";
export const RECIPE_CLIPBOARD_LEGACY_KEY = "alroya_recipe_clipboard";
export const RECIPE_CLIPBOARD_EVENT = "alroya_recipe_clipboard_updated";

export function getRecipeClipboardKey(companyId?: number | null): string {
  if (companyId != null && Number.isFinite(companyId) && companyId > 0) {
    return `${RECIPE_CLIPBOARD_BASE_KEY}_c${companyId}`;
  }
  return RECIPE_CLIPBOARD_BASE_KEY;
}

let memoryClipboardFallback: CopiedRecipePayload | null = null;

export interface EditableLine {
  id?: number;
  inputVariantId: number;
  inputProductUnitId?: number | null;
  inputProductName: string;
  inputSku: string;
  inputCostPrice: string;
  qtyPerOutputBase: string;
  notes?: string | null;
  unitName?: string;
}

export interface CopiedRecipeLine {
  inputVariantId: number;
  inputProductUnitId?: number | null;
  inputProductName: string;
  inputSku: string;
  inputCostPrice: string;
  qtyPerOutputBase: string;
  notes?: string | null;
  unitName?: string;
}

export interface CopiedRecipePayload {
  version?: number;
  companyId?: number | null;
  recipeName: string;
  productName: string;
  laborPerOutputBase: string;
  wasteStdPct: string;
  notes?: string | null;
  lines: CopiedRecipeLine[];
  copiedAt: string;
}

export function sanitizeRecipeClipboard(
  raw: unknown,
  expectedCompanyId?: number | null,
): CopiedRecipePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const rawCompanyId = obj.companyId != null ? Number(obj.companyId) : null;
  const companyId =
    Number.isFinite(rawCompanyId) && (rawCompanyId as number) > 0
      ? (rawCompanyId as number)
      : null;

  // إذا تم تحديد شركة متوقعة، رفض الحمولة إذا كانت تخص شركة أخرى لتفادي تسرب بيانات الوصفات بين الشركات
  if (expectedCompanyId !== undefined) {
    const expected =
      expectedCompanyId != null &&
      Number.isFinite(expectedCompanyId) &&
      expectedCompanyId > 0
        ? expectedCompanyId
        : null;
    if (companyId !== expected) {
      return null;
    }
  }

  const rawLines = Array.isArray(obj.lines)
    ? obj.lines
    : Array.isArray(obj.items)
      ? obj.items
      : null;
  if (!rawLines || rawLines.length === 0) return null;

  const validLines: CopiedRecipeLine[] = [];

  for (const item of rawLines) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const variantId = Number(it.inputVariantId ?? it.variantId);
    if (!Number.isSafeInteger(variantId) || variantId <= 0) continue;

    const unitId =
      it.inputProductUnitId != null ? Number(it.inputProductUnitId) : null;
    const qty =
      it.qtyPerOutputBase != null
        ? String(it.qtyPerOutputBase)
        : it.quantity != null
          ? String(it.quantity)
          : "1";
    const cost =
      it.inputCostPrice != null
        ? String(it.inputCostPrice)
        : it.costPrice != null
          ? String(it.costPrice)
          : "0";
    if (!validDecimal(qty, true) || !validDecimal(cost)) continue;
    const pName =
      typeof it.inputProductName === "string" && it.inputProductName.trim()
        ? it.inputProductName.trim()
        : typeof it.productName === "string" && it.productName.trim()
          ? it.productName.trim()
          : `مادة خام (#${variantId})`;
    const sku =
      typeof it.inputSku === "string"
        ? it.inputSku
        : typeof it.sku === "string"
          ? it.sku
          : "";
    const uName = typeof it.unitName === "string" ? it.unitName : "وحدة";
    const notes = typeof it.notes === "string" ? it.notes : null;

    const existingIndex = validLines.findIndex(
      (l) => l.inputVariantId === variantId,
    );
    if (existingIndex >= 0) {
      const existing = validLines[existingIndex];
      // Quantities retain their precision; currency rounding here used to erase small materials.
      const sumQty = D(existing.qtyPerOutputBase).plus(D(qty)).toString();
      validLines[existingIndex] = {
        ...existing,
        qtyPerOutputBase: sumQty,
      };
      continue;
    }

    validLines.push({
      inputVariantId: variantId,
      inputProductUnitId:
        unitId && Number.isFinite(unitId) && unitId > 0 ? unitId : null,
      inputProductName: pName,
      inputSku: sku,
      inputCostPrice: cost,
      qtyPerOutputBase: qty,
      notes,
      unitName: uName,
    });
  }

  if (validLines.length === 0) return null;

  const labor =
    typeof obj.laborPerOutputBase === "string" ? obj.laborPerOutputBase : "0";
  const waste = typeof obj.wasteStdPct === "string" ? obj.wasteStdPct : "0";
  if (!validDecimal(labor) || !validDecimal(waste) || D(waste).gte(1))
    return null;

  return {
    version: 1,
    companyId,
    recipeName:
      typeof obj.recipeName === "string" && obj.recipeName.trim()
        ? obj.recipeName.trim()
        : "وصفة منتج",
    productName:
      typeof obj.productName === "string" && obj.productName.trim()
        ? obj.productName.trim()
        : "المنتج",
    laborPerOutputBase: labor,
    wasteStdPct: waste,
    notes: typeof obj.notes === "string" ? obj.notes : null,
    lines: validLines,
    copiedAt:
      typeof obj.copiedAt === "string"
        ? obj.copiedAt
        : new Date().toISOString(),
  };
}

export function getStoredRecipeClipboard(
  companyId?: number | null,
): CopiedRecipePayload | null {
  const scopedKey = getRecipeClipboardKey(companyId);
  try {
    if (typeof localStorage !== "undefined") {
      let raw = localStorage.getItem(scopedKey);
      if (!raw && !companyId) {
        raw = localStorage.getItem(RECIPE_CLIPBOARD_LEGACY_KEY);
      }
      if (raw) {
        const parsed = JSON.parse(raw);
        const sanitized = sanitizeRecipeClipboard(parsed, companyId);
        if (sanitized) return sanitized;
      }
    }
  } catch {
    // fallback to in-memory store below
  }

  if (memoryClipboardFallback) {
    const sanitized = sanitizeRecipeClipboard(
      memoryClipboardFallback,
      companyId,
    );
    if (sanitized) return sanitized;
  }

  return null;
}

export interface StoreClipboardResult {
  success: boolean;
  persistedLocally: boolean;
  sanitized: CopiedRecipePayload | null;
}

export function setStoredRecipeClipboard(
  payload: CopiedRecipePayload,
  companyId?: number | null,
): StoreClipboardResult {
  const targetCompanyId =
    companyId !== undefined
      ? companyId != null && Number.isFinite(companyId) && companyId > 0
        ? companyId
        : null
      : (payload.companyId ?? null);

  const payloadWithCompany: CopiedRecipePayload = {
    ...payload,
    companyId: targetCompanyId,
  };

  const sanitized = sanitizeRecipeClipboard(
    payloadWithCompany,
    targetCompanyId,
  );
  if (!sanitized) {
    return { success: false, persistedLocally: false, sanitized: null };
  }

  memoryClipboardFallback = sanitized;

  let persistedLocally = false;
  if (typeof localStorage !== "undefined") {
    try {
      const scopedKey = getRecipeClipboardKey(targetCompanyId);
      localStorage.setItem(scopedKey, JSON.stringify(sanitized));
      persistedLocally = true;
    } catch {
      persistedLocally = false;
    }
  }

  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(
        new CustomEvent(RECIPE_CLIPBOARD_EVENT, { detail: sanitized }),
      );
    } catch {}
  }

  return { success: true, persistedLocally, sanitized };
}
