import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import type { OperationSelection } from "./operationPermissionMatrixHelpers";

interface OperationPermissionVisibilityProps {
  id: string;
  mode: "role" | "user";
  disabled?: boolean;
  costVisibility?: boolean;
  inheritedCostVisibility: boolean;
  setVisibility: (selection: OperationSelection) => void;
}

export function OperationPermissionVisibility({
  id,
  mode,
  disabled,
  costVisibility,
  inheritedCostVisibility,
  setVisibility,
}: OperationPermissionVisibilityProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border p-3">
      <div>
        <Label htmlFor={`${id}-visibility`}>عرض التكلفة والربح</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          يشمل تكلفة الشراء وهوامش الربح في نتائج العمليات المفوّضة.
        </p>
      </div>
      {mode === "user" ? (
        <AppSelect
          id={`${id}-visibility`}
          className="w-48"
          disabled={disabled}
          value={
            costVisibility === undefined
              ? "inherit"
              : costVisibility
                ? "allow"
                : "deny"
          }
          onValueChange={(selection) =>
            setVisibility(selection as "allow" | "deny" | "inherit")
          }
        >
          <option value="inherit">
            وراثة ({inheritedCostVisibility ? "مسموح" : "محجوب"})
          </option>
          <option value="allow">عرض لهذا المستخدم</option>
          <option value="deny">حجب لهذا المستخدم</option>
        </AppSelect>
      ) : (
        <input
          id={`${id}-visibility`}
          type="checkbox"
          className="size-4"
          checked={costVisibility === true}
          disabled={disabled}
          onChange={(event) =>
            setVisibility(event.target.checked ? "allow" : "deny")
          }
        />
      )}
    </div>
  );
}
