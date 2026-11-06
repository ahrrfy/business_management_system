import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { D } from "@/lib/money";
import type { ProductRecipeChange } from "@shared/productRecipeSave";
import type { EditableLine } from "./recipeClipboard";

export type { ProductRecipeChange } from "@shared/productRecipeSave";

export type RecipeDraftIdentity = Pick<
  ProductRecipeChange,
  "recipeId" | "expectedFingerprint" | "outputVariantId" | "outputProductUnitId"
>;
export type RecipeDraftFields = {
  formName: string;
  formLabor: string;
  formWaste: string;
  formNotes: string;
  formLines: EditableLine[];
};

function normalizedDecimal(value: string): string {
  try {
    const parsed = D(value);
    return parsed.isFinite() ? parsed.toString() : value;
  } catch {
    return value;
  }
}

/** Only persisted recipe fields enter the baseline; live material costs do not. */
export function recipeDraftSignature(fields: RecipeDraftFields): string {
  return JSON.stringify({
    name: fields.formName.trim(),
    labor: normalizedDecimal(fields.formLabor),
    waste: normalizedDecimal(fields.formWaste),
    notes: fields.formNotes.trim(),
    lines: fields.formLines.map((line) => [
      line.inputVariantId,
      line.inputProductUnitId ?? null,
      normalizedDecimal(line.qtyPerOutputBase),
      line.notes?.trim() || null,
    ]),
  });
}

export function recipeDraftBlockers(
  fields: RecipeDraftFields,
  identity: RecipeDraftIdentity | null,
  canWrite: boolean,
): string[] {
  const errors: string[] = [];
  if (!canWrite) errors.push("العملية غير مفوضة لحفظ الوصفة");
  if (!identity?.outputVariantId || !identity.outputProductUnitId)
    errors.push(
      "لا يمكن حفظ الوصفة لعدم وجود متغير أساسي أو وحدة أساسية للمنتج",
    );
  if (!identity?.expectedFingerprint)
    errors.push("تعذّر تثبيت نسخة الوصفة؛ أعد تحميل الوصفة قبل تعديلها");
  if (!fields.formName.trim()) errors.push("اسم الوصفة مطلوب");
  if (!fields.formLines.length)
    errors.push("يجب إضافة مادة خام واحدة على الأقل في الوصفة");
  for (const line of fields.formLines) {
    try {
      const quantity = D(line.qtyPerOutputBase);
      if (!quantity.isFinite() || quantity.lte(0)) throw new Error();
      if (quantity.decimalPlaces() > 4)
        errors.push(
          `كمية المادة «${line.inputProductName}» تقبل أربع منازل عشرية أو أقل دون تقريب`,
        );
    } catch {
      errors.push(
        `كمية المادة «${line.inputProductName}» يجب أن تكون أكبر من صفر`,
      );
    }
  }
  try {
    const labor = D(fields.formLabor);
    if (!labor.isFinite() || labor.isNegative()) throw new Error();
  } catch {
    errors.push("كلفة العمالة يجب أن تكون رقماً غير سالب");
  }
  try {
    const waste = D(fields.formWaste);
    if (!waste.isFinite() || waste.isNegative() || waste.gte(1))
      throw new Error();
  } catch {
    errors.push("نسبة الهدر المعياري يجب أن تكون بين 0 وأقل من 1");
  }
  return errors;
}

export function buildRecipeChange(
  fields: RecipeDraftFields,
  identity: RecipeDraftIdentity,
): ProductRecipeChange {
  return {
    ...identity,
    name: fields.formName.trim(),
    laborPerOutputBase: fields.formLabor.trim() || "0",
    wasteStdPct: fields.formWaste.trim() || "0",
    notes: fields.formNotes.trim() || null,
    ...(identity.recipeId == null ? { isActive: true } : {}),
    lines: fields.formLines.map((line) => ({
      inputVariantId: line.inputVariantId,
      inputProductUnitId: line.inputProductUnitId ?? null,
      qtyPerOutputBase: line.qtyPerOutputBase.trim(),
      notes: line.notes?.trim() || null,
    })),
  };
}

type RecipeSubmission = {
  change: ProductRecipeChange;
  complete: (result: unknown) => Promise<void>;
};
export type RecipeEditorRegistration = {
  isDirty: boolean;
  isPending: boolean;
  blockedBy: string[];
  prepare: () => RecipeSubmission | undefined;
};
type RecipeBridge = {
  isPending: boolean;
  register: (editor: MutableRefObject<RecipeEditorRegistration>) => () => void;
  changed: () => void;
};
export const ProductRecipeSaveContext = createContext<RecipeBridge | null>(
  null,
);
const emptyState = {
  isDirty: false,
  isPending: false,
  blockedBy: [] as string[],
};

/** One SaveBar owns the transaction; its nested recipe editor supplies the draft. */
export function useProductRecipeFormSave(isPending: boolean) {
  const editor = useRef<MutableRefObject<RecipeEditorRegistration> | null>(
    null,
  );
  const [state, setState] = useState(emptyState);
  const changed = useCallback(() => {
    const current = editor.current?.current;
    const next = current
      ? {
          isDirty: current.isDirty,
          isPending: current.isPending,
          blockedBy: current.blockedBy,
        }
      : emptyState;
    setState((previous) =>
      previous.isDirty === next.isDirty &&
      previous.isPending === next.isPending &&
      JSON.stringify(previous.blockedBy) === JSON.stringify(next.blockedBy)
        ? previous
        : next,
    );
  }, []);
  const register = useCallback(
    (registration: MutableRefObject<RecipeEditorRegistration>) => {
      editor.current = registration;
      changed();
      return () => {
        if (editor.current === registration) {
          editor.current = null;
          changed();
        }
      };
    },
    [changed],
  );
  const context = useMemo(
    () => ({ isPending, register, changed }),
    [isPending, register, changed],
  );
  return {
    ...state,
    context,
    prepare: () => editor.current?.current.prepare(),
  };
}

export function useProductRecipeDraftRegistration(
  editor: RecipeEditorRegistration,
  productId: number,
) {
  const bridge = useContext(ProductRecipeSaveContext);
  const current = useRef(editor);
  current.current = editor;
  useEffect(() => bridge?.register(current), [bridge?.register, productId]);
  const blockers = JSON.stringify(editor.blockedBy);
  useEffect(
    () => bridge?.changed(),
    [bridge?.changed, editor.isDirty, editor.isPending, blockers],
  );
  return bridge?.isPending ?? false;
}
