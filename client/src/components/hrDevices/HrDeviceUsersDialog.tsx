import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
}: HrDeviceUsersDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>ربط مستخدمي الجهاز بالموظفين</DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground -mt-1">
          كل رقم في الجهاز يقابله موظف في النظام — بعد الربط تُحتسب بصماته
          حضوراً تلقائياً (حتى السابقة منها). إن كانت القائمة فارغة اسحب
          المستخدمين من الجهاز بزر «المستخدمون».
        </p>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={deviceUserQuery}
            onChange={(e) => setDeviceUserQuery(e.target.value)}
            placeholder="بحث بالرقم أو الاسم في الجهاز…"
            aria-label="بحث في مستخدمي الجهاز"
            className="h-8 w-full pr-8"
          />
        </div>
        <ScrollTableShell maxHeightClass="max-h-[50vh]" showColumnVisibility={false}>
          <table className="w-full text-sm">
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
                  <td className="p-2 text-center tabular-nums">
                    {u.enrollId}
                  </td>
                  <td className="p-2 text-xs">{u.name ?? "—"}</td>
                  <td className="p-2 text-center text-xs">
                    {u.hasBackup ? "نعم" : "—"}
                  </td>
                  <td className="p-2">
                    <AppSelect
                      className="h-9"
                      value={u.employeeId ? String(u.employeeId) : ""}
                      onValueChange={(next) =>
                        onMapUser(u.enrollId, next ? Number(next) : null)
                      }
                    >
                      <option value="">— غير مربوط —</option>
                      {employeeOptions.map((emp) => (
                        <option key={emp.id} value={String(emp.id)}>
                          {emp.name}
                        </option>
                      ))}
                    </AppSelect>
                  </td>
                </tr>
              ))}
              {!deviceUsersLoading && visibleDeviceUsers.length === 0 && (
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
