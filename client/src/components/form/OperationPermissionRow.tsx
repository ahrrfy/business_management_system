import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import type {
  OperationPermission,
  OperationPolicy,
} from "@shared/operationPermissions";
import {
  requiresCost,
  stageLabel,
  type OperationSelection,
} from "./operationPermissionMatrixHelpers";

interface OperationPermissionRowProps {
  id: string;
  operation: OperationPermission;
  value: OperationPolicy | null;
  inherited?: OperationPolicy;
  mode: "role" | "user";
  disabled?: boolean;
  costAllowed: boolean;
  effective: (key: string) => boolean;
  setGrants: (keys: string[], selection: OperationSelection) => void;
  setScope: (key: string, selection: string) => void;
}

export function OperationPermissionRow({
  id,
  operation,
  value,
  inherited,
  mode,
  disabled,
  costAllowed,
  effective,
  setGrants,
  setScope,
}: OperationPermissionRowProps) {
  const own = value?.grants[operation.key];
  return (
    <div
      key={operation.key}
      className="flex flex-col items-stretch gap-3 px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
    >
      <div className="min-w-0 flex-1">
        <Label htmlFor={`${id}-${operation.key}`} className="font-normal">
          {operation.label}
        </Label>
        <div className="mt-1 text-xs text-muted-foreground">
          {stageLabel(operation.lifecycleStage)}
          {operation.branch ? " · ضمن الفرع المعتمد" : ""}
          {requiresCost(operation) ? " · يتطلب عرض التكلفة والربح" : ""}
          {mode === "user"
            ? ` · ${own === undefined ? "موروثة من الدور" : "استثناء فردي"}`
            : ""}
        </div>
      </div>
      {mode === "user" ? (
        <AppSelect
          id={`${id}-${operation.key}`}
          aria-label={`تفويض ${operation.label}`}
          className="w-full sm:w-44"
          size="sm"
          disabled={disabled}
          value={own === undefined ? "inherit" : own ? "allow" : "deny"}
          onValueChange={(selection) =>
            setGrants(
              [operation.key],
              selection as "allow" | "deny" | "inherit",
            )
          }
        >
          <option value="inherit">
            وراثة (
            {inherited?.grants[operation.key]
              ? requiresCost(operation) && !costAllowed
                ? "محجوبة بإذن التكلفة"
                : "مفوّضة"
              : "ممنوعة"}
            )
          </option>
          <option
            value="allow"
            disabled={requiresCost(operation) && !costAllowed}
          >
            {requiresCost(operation) && !costAllowed && own === true
              ? "منح محجوب بإذن التكلفة"
              : "منح لهذا المستخدم"}
          </option>
          <option value="deny">منع لهذا المستخدم</option>
        </AppSelect>
      ) : (
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <input
            id={`${id}-${operation.key}`}
            className="size-4"
            type="checkbox"
            checked={effective(operation.key)}
            disabled={
              disabled ||
              (requiresCost(operation) &&
                !costAllowed &&
                !effective(operation.key))
            }
            onChange={(event) =>
              setGrants(
                [operation.key],
                event.target.checked ? "allow" : "deny",
              )
            }
          />
          <span>
            {requiresCost(operation) && !costAllowed && effective(operation.key)
              ? "محجوبة حتى تفعيل عرض التكلفة"
              : effective(operation.key)
                ? "مفوّضة"
                : "ممنوعة"}
          </span>
        </label>
      )}
      {operation.supportsRecordScope && (
        <AppSelect
          aria-label={`نطاق سجلات ${operation.label}`}
          size="sm"
          className="w-full sm:w-44"
          disabled={disabled}
          value={
            value?.recordScopes?.[operation.key] ??
            (mode === "user" ? "inherit" : "OWN")
          }
          onValueChange={(selection) => setScope(operation.key, selection)}
        >
          {mode === "user" && (
            <option value="inherit">
              وراثة (
              {inherited?.recordScopes?.[operation.key] === "BRANCH"
                ? "الفرع"
                : "سجلاته فقط"}
              )
            </option>
          )}
          <option value="OWN">سجلات المستخدم فقط</option>
          <option value="BRANCH">سجلات الفرع</option>
        </AppSelect>
      )}
    </div>
  );
}
