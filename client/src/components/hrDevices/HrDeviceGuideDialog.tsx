import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface HrDeviceGuideDialogProps {
  open: boolean;
  onClose: () => void;
  myHost: string;
  bridgePort: string | number;
}

export function HrDeviceGuideDialog({
  open,
  onClose,
  myHost,
  bridgePort,
}: HrDeviceGuideDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>توجيه الجهاز إلى خادمك</DialogTitle>
        </DialogHeader>
        <ol className="text-[13px] leading-relaxed space-y-2 list-decimal pr-5">
          <li>
            من شاشة الجهاز: <b>Menu ← Comm set / Server</b>.
          </li>
          <li>
            اضبط:{" "}
            <span dir="ltr" className="font-mono text-xs">
              Server Req = Yes
            </span>
          </li>
          <li>
            فعّل النطاق:{" "}
            <span dir="ltr" className="font-mono text-xs">
              Use domainNm = Yes
            </span>
          </li>
          <li>
            ثم اكتب:{" "}
            <span dir="ltr" className="font-mono text-xs">
              DomainNm = {myHost}
            </span>
          </li>
          <li>
            والمنفذ:{" "}
            <span dir="ltr" className="font-mono text-xs">
              SerPortNo = {bridgePort}
            </span>
          </li>
          <li>
            احفظ وأعد تشغيل الجهاز — سيظهر خلال دقيقة في الجدول أعلاه (متصل /
            بانتظار الاعتماد).
          </li>
          <li>
            أجهزة ZKTeco: نفس الفكرة من قائمة Cloud Server Setting (ADMS) بنفس
            النطاق والمنفذ.
          </li>
        </ol>
        <p className="text-[11px] text-muted-foreground">
          بديلٌ للنطاق:{" "}
          <span dir="ltr" className="font-mono text-xs">
            Use domainNm = No
          </span>{" "}
          ثم
          <span dir="ltr" className="font-mono text-xs">
            {" "}
            Server IP ={" "}
          </span>{" "}
          عنوان الخادم الرقمي — لكن النطاق أفضل (تغيّر عنوان الخادم يُحلّ
          بتحديث DNS واحد بلا لمس الأجهزة).
        </p>
        <p className="text-[11px] text-muted-foreground">
          يحتفظ الجهاز بالسجلات الموجودة في ذاكرته، ويعيد إرسالها تلقائياً بعد
          الاتصال. ويمكن طلب السجل كاملاً من قائمة إجراءات الجهاز.
        </p>
        <DialogFooter>
          <Button onClick={onClose}>فهمت</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
