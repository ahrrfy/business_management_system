import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import type { OperationalCaps } from "@shared/atomicPermissions";
import type { OperationPermission, OperationPolicy } from "@shared/operationPermissions";
import { requiresCost, stageLabel, type OperationSelection } from "./operationPermissionMatrixHelpers";

const REFUND_CAP_PATHS = new Set([
  "sales.cancel", "returns.create", "returns.executeSalesReturnCart", "reception.refundDeposit",
]);

interface Props {
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
  isDaily?: boolean;
  operationalCaps?: OperationalCaps | null;
  inheritedOperationalCaps?: OperationalCaps | null;
  onOperationalCapsChange?: (caps: OperationalCaps | null) => void;
}

export function OperationPermissionRow(props: Props) {
  const { id, operation, value, inherited, mode, disabled, costAllowed, effective, setGrants, setScope } = props;
  const own = value?.grants[operation.key];
  const allowed = effective(operation.key) && (!requiresCost(operation) || costAllowed);
  const hasRefundCap = REFUND_CAP_PATHS.has(operation.path);
  const ownCap = props.operationalCaps?.maxRefundAmountIqd;
  const inheritedCap = props.inheritedOperationalCaps?.maxRefundAmountIqd;
  const effectiveCap = ownCap ?? inheritedCap ?? "0.00";
  const decision = !allowed
    ? (requiresCost(operation) && effective(operation.key)
        ? "محجوبة حتى تفعيل عرض التكلفة"
        : "ممنوع")
    : hasRefundCap
      ? Number(effectiveCap) > 0
        ? `ينفذ مباشرة حتى ${Number(effectiveCap).toLocaleString("ar-IQ-u-nu-latn")} د.ع؛ وبعده يحتاج اعتماداً`
        : "يحتاج اعتماداً لأي مبلغ"
      : "ينفذ مباشرة ضمن شروط العملية";

  return (
    <div className="grid grid-cols-[minmax(210px,1.4fr)_minmax(150px,1fr)_150px_240px_180px] items-center gap-3 px-3 py-2 text-sm">
      <div className="min-w-0">
        <Label htmlFor={`${id}-${operation.key}`} className="font-normal">{operation.label}</Label>
        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" dir="ltr">{operation.path}</div>
        {props.isDaily && <span className="mt-1 inline-block bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">مهمة يومية افتراضية</span>}
      </div>
      <div className="text-xs text-muted-foreground"><div>{operation.resource}</div><div>{stageLabel(operation.lifecycleStage)}</div>{operation.branch ? <div>ضمن الفرع المعتمد</div> : null}{requiresCost(operation) && !costAllowed ? <div>تتطلب تفعيل عرض التكلفة والربح</div> : null}</div>
      {mode === "user" ? (
        <AppSelect id={`${id}-${operation.key}`} aria-label={`تفويض ${operation.label}`} size="sm" disabled={disabled} value={own === undefined ? "inherit" : own ? "allow" : "deny"} onValueChange={(selection) => setGrants([operation.key], selection as OperationSelection)}>
          <option value="inherit">يرث ({inherited?.grants[operation.key] ? "سماح" : "منع"})</option>
          <option value="allow" disabled={requiresCost(operation) && !costAllowed}>سماح</option>
          <option value="deny">منع</option>
        </AppSelect>
      ) : (
        <label className="inline-flex cursor-pointer items-center gap-2"><input id={`${id}-${operation.key}`} className="size-4" type="checkbox" checked={effective(operation.key)} disabled={disabled || (requiresCost(operation) && !costAllowed && !effective(operation.key))} onChange={(event) => setGrants([operation.key], event.target.checked ? "allow" : "deny")} /><span>{allowed ? "سماح" : "منع"}</span></label>
      )}
      <div className="space-y-1">
        <div className={allowed ? "text-money-positive" : "text-destructive"}>{decision}</div>
        {hasRefundCap && allowed && props.onOperationalCapsChange && (
          <div>
            <MoneyInput aria-label={`سقف ${operation.label}`} disabled={disabled} value={ownCap ?? ""}
              placeholder={mode === "user" ? `يرث ${Number(inheritedCap ?? 0).toLocaleString("ar-IQ-u-nu-latn")}` : "0"}
              onChange={(next) => props.onOperationalCapsChange?.({ ...(props.operationalCaps ?? {}), maxRefundAmountIqd: next || (mode === "user" ? undefined : "0.00") })}
              className="h-8 text-xs" />
            <p className="text-[10px] text-muted-foreground">السقف المباشر؛ التجاوز ينتقل للاعتماد</p>
          </div>
        )}
      </div>
      {operation.supportsRecordScope ? (
        <AppSelect aria-label={`نطاق سجلات ${operation.label}`} size="sm" disabled={disabled} value={value?.recordScopes?.[operation.key] ?? (mode === "user" ? "inherit" : "OWN")} onValueChange={(selection) => setScope(operation.key, selection)}>
          {mode === "user" && <option value="inherit">يرث ({inherited?.recordScopes?.[operation.key] === "BRANCH" ? "الفرع" : "سجلاته"})</option>}
          <option value="OWN">سجلاته فقط</option><option value="BRANCH">الفرع</option>
        </AppSelect>
      ) : <span className="text-xs text-muted-foreground">حسب الفرع والمستند</span>}
    </div>
  );
}
