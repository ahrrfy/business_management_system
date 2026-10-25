import { MobileDataCard } from "@/components/ui/MobileDataCard";
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Search } from "lucide-react";

export interface DeviceUserItem {
  id: number;
  enrollId: number;
  name?: string | null;
  hasBackup?: boolean | number | null;
  employeeId?: number | null;
}

export interface HrDeviceUsersDialogProps {
  open: boolean;
  onClose: () => void;
  deviceUserQuery: string;
  setDeviceUserQuery: (q: string) => void;
  visibleDeviceUsers: DeviceUserItem[];
  deviceUsersLoading: boolean;
  totalDeviceUsers: number;
  employeeOptions: Array<{ id: number; name: string }>;
  onMapUser: (enrollId: number, employeeId: number | null) => void;
  deviceUsersError: boolean;
  employeeOptionsLoading: boolean;
  employeeOptionsError: boolean;
  isMapping: boolean;
  onRetryUsers: () => void;
  onRetryEmployees: () => void;
}

export function HrDeviceUsersDialog({
  open,
  onClose,
  deviceUserQuery,
  setDeviceUserQuery,
  visibleDeviceUsers,
  deviceUsersLoading,
  totalDeviceUsers,
  employeeOptions,
  onMapUser,
  deviceUsersError,
  employeeOptionsLoading,
  employeeOptionsError,
  isMapping,
  onRetryUsers,
  onRetryEmployees,
}: HrDeviceUsersDialogProps) {
  const employeeSelect = (u: DeviceUserItem) => (
    <AppSelect
      className="h-9"
      aria-label={`ربط المستخدم ${u.enrollId}`}
      disabled={
        isMapping ||
        deviceUsersLoading ||
        deviceUsersError ||
        employeeOptionsLoading ||
        employeeOptionsError
      }
      value={u.employeeId ? String(u.employeeId) : ""}
      onValueChange={(next) =>
        onMapUser(u.enrollId, next ? Number(next) : null)
      }
    >
      <option value="">— غير مربوط —</option>
      {u.employeeId &&
        !employeeOptions.some((emp) => emp.id === u.employeeId) && (
          <option value={String(u.employeeId)} disabled>
            موظف #{u.employeeId} — خارج الخيارات الحالية
          </option>
        )}
      {employeeOptions.map((emp) => (
        <option key={emp.id} value={String(emp.id)}>
          {emp.name}
        </option>
      ))}
    </AppSelect>
  );
  const emptyMessage =
    !deviceUsersLoading && !deviceUsersError && visibleDeviceUsers.length === 0
      ? totalDeviceUsers === 0
        ? "لا مستخدمون مسحوبون بعد — أرسل أمر «المستخدمون» من جدول الأجهزة ثم افتح هذا الحوار."
        : "لا نتائج مطابقة للبحث."
      : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="min-w-0 grid-cols-[minmax(0,1fr)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>ربط مستخدمي الجهاز بالموظفين</DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground -mt-1">
          كل رقم في الجهاز يقابله موظف في النظام — بعد الربط تُحتسب بصماته
          حضوراً تلقائياً (حتى السابقة منها). إن كانت القائمة فارغة اسحب
          المستخدمين من الجهاز بزر «المستخدمون».
        </p>
        {deviceUsersLoading && (
          <p role="status" className="text-sm">
            جارٍ تحميل مستخدمي الجهاز…
          </p>
        )}
        {deviceUsersError && (
          <div role="alert" className="text-sm text-destructive">
            تعذّر تحميل مستخدمي الجهاز.{" "}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRetryUsers}
            >
              إعادة محاولة تحميل المستخدمين
            </Button>
          </div>
        )}
        {employeeOptionsError && (
          <div role="alert" className="text-sm text-destructive">
            تعذّر تحميل خيارات الموظفين؛ الربط متوقف حتى نجاح التحديث.{" "}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRetryEmployees}
            >
              إعادة محاولة تحميل الموظفين
            </Button>
          </div>
        )}
        {employeeOptionsLoading && (
          <p role="status" className="text-sm">
            جارٍ تحميل خيارات الموظفين…
          </p>
        )}
        {isMapping && (
          <p role="status" className="text-sm">
            جارٍ حفظ الربط وإلحاق البصمات؛ انتظر اكتمال العملية.
          </p>
        )}
        <UnifiedSearchInput
          barcode={false}
          debounceMs={0}
          value={deviceUserQuery}
          onChange={setDeviceUserQuery}
          placeholder="بحث بالرقم أو الاسم في الجهاز…"
          aria-label="بحث في مستخدمي الجهاز"
          size="compact"
          className="w-full"
        />
        <div className="min-w-0 space-y-2 sm:hidden">
          {visibleDeviceUsers.map((u) => (
            <MobileDataCard
              key={u.id}
              title={<span className="break-words whitespace-normal">{u.name ?? "—"}</span>}
              metadata={[
                { label: "رقم المستخدم", value: u.enrollId },
                { label: "قوالب محفوظة؟", value: u.hasBackup ? "نعم" : "—" },
              ]}
            >
              <label className="block min-w-0 space-y-1 text-xs">
                الموظف المربوط{employeeSelect(u)}
              </label>
            </MobileDataCard>
          ))}
          {emptyMessage && (
            <p className="p-3 text-center text-xs text-muted-foreground">
              {emptyMessage}
            </p>
          )}
        </div>
        <ScrollTableShell
          className="hidden min-w-0 sm:block"
          maxHeightClass="max-h-[50vh]"
          showColumnVisibility={false}
        >
          <table className="w-full min-w-[34rem] table-fixed text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 text-center">الرقم</th>
                <th className="p-2">الاسم في الجهاز</th>
                <th className="p-2 text-center">قوالب محفوظة؟</th>
                <th className="p-2">الموظف المربوط</th>
              </tr>
            </thead>
            <tbody>
              {visibleDeviceUsers.map((u) => (
                <tr key={u.id} className="border-t">
                  <td className="p-2 text-center tabular-nums">{u.enrollId}</td>
                  <td className="break-words p-2 text-xs">{u.name ?? "—"}</td>
                  <td className="p-2 text-center text-xs">
                    {u.hasBackup ? "نعم" : "—"}
                  </td>
                  <td className="p-2">{employeeSelect(u)}</td>
                </tr>
              ))}
              {!deviceUsersLoading &&
                !deviceUsersError &&
                visibleDeviceUsers.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="p-4 text-center text-xs text-muted-foreground"
                    >
                      {totalDeviceUsers === 0
                        ? "لا مستخدمون مسحوبون بعد — أرسل أمر «المستخدمون» من جدول الأجهزة ثم افتح هذا الحوار."
                        : "لا نتائج مطابقة للبحث."}
                    </td>
                  </tr>
                )}
            </tbody>
          </table>
        </ScrollTableShell>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
