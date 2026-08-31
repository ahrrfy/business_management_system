import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { useEffect } from "react";

/** الحدّ الأدنى من رموز ألوان الكاشير (متوافق بنيوياً مع POS_COLORS/LIGHT). */
export interface PosTokens {
  card: string;
  border: string;
  muted: string;
  mutedFg: string;
  fg: string;
  primary: string;
  danger: string;
}

export function ShiftHandoverSection({
  branchId,
  amount,
  value,
  onChange,
  disabled,
  excludeUserIds = [],
}: {
  branchId: number;
  amount: string;
  value: number | null;
  onChange: (userId: number | null) => void;
  disabled?: boolean;
  excludeUserIds?: number[];
}) {
  const me = trpc.auth.me.useQuery();
  const recipients = trpc.shifts.handoverRecipients.useQuery();
  const hasCash = !/^0(?:\.0{1,2})?$/.test(amount || "0");

  const options = (recipients.data ?? []).filter(
    (user) =>
      Number(user.branchId) === branchId &&
      Number(user.id) !== Number(me.data?.id) &&
      !excludeUserIds.includes(Number(user.id)),
  );
  useEffect(() => {
    if (!hasCash && value != null) onChange(null);
    if (
      hasCash &&
      !me.isLoading &&
      !recipients.isLoading &&
      value != null &&
      !options.some((user) => Number(user.id) === value)
    ) {
      onChange(null);
    }
  }, [branchId, hasCash, me.data?.id, me.isLoading, recipients.data, recipients.isLoading, value]);

  if (!hasCash) return null;

  return (
    <div className="mt-3 space-y-1.5 rounded-lg border bg-muted/30 p-3 text-right">
      <label className="block text-xs font-bold">مستلِم عهدة الإغلاق</label>
      <AppSelect
        value={value == null ? "" : String(value)}
        onValueChange={(next) => onChange(next ? Number(next) : null)}
        disabled={disabled || me.isLoading || recipients.isLoading || recipients.isError}
        placeholder="اختر المدير الذي سيعدّ النقد ويقبله"
        aria-label="مستلِم عهدة نقد الوردية"
        className="w-full"
      >
        {options.map((user) => (
          <option key={user.id} value={String(user.id)}>{user.name}</option>
        ))}
      </AppSelect>
      <p className="text-[11px] text-muted-foreground">
        سيغادر المبلغ الدرج ويظهر «نقداً في الطريق». لا يدخل الخزينة حتى يعدّه المستلم بنفسه.
      </p>
      {recipients.isError && (
        <div className="flex items-center justify-between gap-2 text-[11px] font-bold text-destructive">
          <span>تعذّر تحميل المستلمين؛ لم يُفترض عدم وجود مدير.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void recipients.refetch()}>إعادة المحاولة</Button>
        </div>
      )}
      {!recipients.isLoading && !recipients.isError && options.length === 0 && (
        <p className="text-[11px] font-bold text-destructive">لا يوجد مدير مستقل صالح في هذا الفرع.</p>
      )}
    </div>
  );
}
