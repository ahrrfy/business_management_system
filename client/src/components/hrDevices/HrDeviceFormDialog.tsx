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
import { Label } from "@/components/ui/label";
import { PROTOCOL_LABELS, type DeviceFormData } from "./hrDeviceTypes";
import type { Dispatch, SetStateAction } from "react";

export interface HrDeviceFormDialogProps {
  open: boolean;
  onClose: () => void;
  editId: number | null;
  form: DeviceFormData;
  setForm: Dispatch<SetStateAction<DeviceFormData>>;
  branches: Array<{ id: number; name: string }>;
  isPending: boolean;
  onSubmit: () => void;
}

export function HrDeviceFormDialog({
  open,
  onClose,
  editId,
  form,
  setForm,
  branches,
  isPending,
  onSubmit,
}: HrDeviceFormDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editId != null ? "تعديل جهاز حضور" : "إضافة جهاز حضور"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="d-name">اسم الجهاز</Label>
            <Input
              id="d-name"
              value={form.name}
              onChange={(e) =>
                setForm((f) => ({ ...f, name: e.target.value }))
              }
              placeholder="جهاز البصمة — المدخل الرئيسي"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="d-sn">الرقم التسلسلي (SN)</Label>
            <Input
              id="d-sn"
              dir="ltr"
              value={form.serialNumber}
              onChange={(e) =>
                setForm((f) => ({ ...f, serialNumber: e.target.value }))
              }
              placeholder="ZXRB06004623"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="d-proto">نوع الجهاز</Label>
            <AppSelect
              id="d-proto"
              className="h-9"
              value={form.protocol}
              onValueChange={(next) =>
                setForm((f) => ({ ...f, protocol: next }))
              }
            >
              {Object.entries(PROTOCOL_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="d-ip">عنوان IP الدقيق الخاص بالجهاز</Label>
            <Input
              id="d-ip"
              dir="ltr"
              value={form.ip}
              onChange={(e) => setForm((f) => ({ ...f, ip: e.target.value }))}
              placeholder="مثال: عنوان الجهاز داخل شبكة الحضور"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="d-model">الطراز</Label>
            <Input
              id="d-model"
              value={form.model}
              onChange={(e) =>
                setForm((f) => ({ ...f, model: e.target.value }))
              }
              placeholder="AI518 وجه + بطاقة"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="d-location">الموقع</Label>
            <Input
              id="d-location"
              value={form.location}
              onChange={(e) =>
                setForm((f) => ({ ...f, location: e.target.value }))
              }
              placeholder="بوابة الفرع الرئيسي"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="d-branch">الفرع</Label>
            <AppSelect
              id="d-branch"
              className="h-9"
              value={form.branchId}
              onValueChange={(next) =>
                setForm((f) => ({ ...f, branchId: next }))
              }
            >
              <option value="">— بلا فرع —</option>
              {branches.map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.name}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="d-code">معرّف الجهاز (Device ID)</Label>
            <Input
              id="d-code"
              dir="ltr"
              value={form.deviceCode}
              onChange={(e) =>
                setForm((f) => ({ ...f, deviceCode: e.target.value }))
              }
              placeholder="1"
            />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          عند التسجيل المسبق يلزم ربط الرقم التسلسلي بعنوان جهاز فريد. الشبكات
          المشتركة أو NAT تحتاج مفتاح جهاز خاصاً في إعداد الخادم. لا تُقبل
          بصمات الجهاز المكتشف قبل الاعتماد.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            disabled={isPending}
            onClick={onSubmit}
          >
            {isPending
              ? "جارٍ…"
              : editId != null
                ? "حفظ"
                : "إضافة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
