import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtDateTime } from "@/lib/date";
import type { ActivationData } from "./types";

export function PolicyApprovalCard({
  activation,
  busy,
  policyReference,
  policyAccountantName,
  onPolicyReferenceChange,
  onPolicyAccountantNameChange,
  onApprovePolicy,
  onClearPolicy,
}: {
  activation: ActivationData;
  busy: boolean;
  policyReference: string;
  policyAccountantName: string;
  onPolicyReferenceChange: (value: string) => void;
  onPolicyAccountantNameChange: (value: string) => void;
  onApprovePolicy: () => void;
  onClearPolicy: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div>
        <div className="font-semibold">مصادقة السياسة المحاسبية</div>
        <p className="text-xs text-muted-foreground">
          يسجل النظام مرجع مراجعة محاسب بشري واسم المراجع كحوكمة داخلية،
          من دون ادعاء اعتماد معياري أو حكومي. تُسجل المصادقة بعد بدء
          SHADOW كي ترتبط بلقطة الدورة الفعلية.
        </p>
      </div>
      {activation.policyApproval ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">المرجع</dt>
              <dd className="font-medium">{activation.policyApproval.reference}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">المحاسب</dt>
              <dd className="font-medium">
                {activation.policyApproval.accountantName}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">سُجلت في</dt>
              <dd className="tabular-nums" dir="ltr">
                {fmtDateTime(activation.policyApproval.approvedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">الدورة المعتمدة</dt>
              <dd className="font-mono text-xs" dir="ltr">
                {activation.policyApproval.cycleId}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">بصمة الافتتاح</dt>
              <dd className="font-mono text-xs" dir="ltr">
                {activation.policyApproval.openingHash}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">إصدار سياسة الترحيل</dt>
              <dd className="font-mono text-xs" dir="ltr">
                {activation.policyApproval.policyHash}
              </dd>
            </div>
          </dl>
          {activation.mode !== "ACTIVE" && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClearPolicy}
            >
              مسح المصادقة
            </Button>
          )}
        </div>
      ) : (
        <div className="grid items-end gap-3 lg:grid-cols-[1fr_1fr_auto]">
          <label className="space-y-1 text-xs font-medium">
            مرجع المصادقة
            <Input
              value={policyReference}
              maxLength={255}
              disabled={busy || activation.mode !== "SHADOW"}
              onChange={(event) =>
                onPolicyReferenceChange(event.target.value)
              }
              placeholder="رقم/عنوان محضر المراجعة (10 أحرف على الأقل)"
            />
          </label>
          <label className="space-y-1 text-xs font-medium">
            اسم المحاسب المراجع
            <Input
              value={policyAccountantName}
              maxLength={150}
              disabled={busy || activation.mode !== "SHADOW"}
              onChange={(event) =>
                onPolicyAccountantNameChange(event.target.value)
              }
              placeholder="الاسم الصريح للمحاسب"
            />
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={
              busy ||
              activation.mode !== "SHADOW" ||
              policyReference.trim().length < 10 ||
              policyAccountantName.trim().length < 3
            }
            onClick={onApprovePolicy}
          >
            تسجيل المصادقة
          </Button>
        </div>
      )}
    </div>
  );
}
