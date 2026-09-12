import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import type { IntegrationConnectionChannel } from "@/lib/integrationCenter";

export function NewIntegrationDialog({
  onCreated,
  onClose,
  branches,
  channelMeta,
}: {
  onCreated: () => void;
  onClose: () => void;
  branches: { id: number; name: string }[];
  channelMeta: Record<IntegrationConnectionChannel, { label: string }>;
}) {
  const [branchId, setBranchId] = useState<number>(branches[0]?.id ?? 0);
  const [channel, setChannel] = useState<IntegrationConnectionChannel>("WHATSAPP");
  const upsert = trpc.integrations.upsert.useMutation({
    onSuccess: () => { onCreated(); onClose(); },
    onError: (e) => notify.err(e),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent dir="rtl" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>إضافة قناة اتصال</DialogTitle>
          <DialogDescription>اختر الفرع والقناة، ثم أكمل الاعتمادات واختبر الإعداد بعد الإضافة.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 items-start">
            <div>
              <label className="text-xs text-muted-foreground">الفرع</label>
              <AppSelect
                value={String(branchId || "")}
                onValueChange={(value) => setBranchId(Number(value))}
                className="mt-1"
                aria-label="الفرع"
              >
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </AppSelect>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">القناة</label>
              <AppSelect
                value={channel}
                onValueChange={(value) => setChannel(value as IntegrationConnectionChannel)}
                className="mt-1"
                aria-label="القناة"
              >
                <option value="WHATSAPP">{channelMeta.WHATSAPP.label}</option>
                <option value="INSTAGRAM">{channelMeta.INSTAGRAM.label}</option>
                <option value="STORE">{channelMeta.STORE.label}</option>
              </AppSelect>
            </div>
          </div>
          <div className="text-xs text-muted-foreground rounded-md bg-muted/30 border p-2.5">
            بعد الإنشاء افتح «إدارة الاتصال» لإدخال الاعتمادات وإجراء التحقق. قناة المتجر الحالية تستقبل webhook موقّعاً فقط ولا تزامن المنتجات أو المخزون.
          </div>
        </div>
        <DialogFooter className="sm:justify-stretch">
          <Button variant="outline" onClick={onClose} className="flex-1">إلغاء</Button>
          <Button
            onClick={() => upsert.mutate({ branchId, channel })}
            disabled={upsert.isPending || !branchId}
            className="flex-1"
          >
            إضافة القناة
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
