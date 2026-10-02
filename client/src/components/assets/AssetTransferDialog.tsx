import { useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { ArrowLeftRight } from "lucide-react";
import { selectClsFull } from "@/lib/ui/formStyles";

interface AssetTransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: {
    id: number;
    code: string;
    name: string;
    branchId: number | null;
    location: string | null;
    custodianId: number | null;
  };
  onSuccess?: () => void;
}

export function AssetTransferDialog({
  open,
  onOpenChange,
  asset,
  onSuccess,
}: AssetTransferDialogProps) {
  const opts = trpc.assets.formOptions.useQuery(undefined, { enabled: open });
  const [targetBranchId, setTargetBranchId] = useState<string>("");
  const [targetCustodianId, setTargetCustodianId] = useState<string>("");
  const [location, setLocation] = useState<string>("");
  const [reason, setReason] = useState<string>("");

  const utils = trpc.useUtils();
  const transferMut = trpc.assets.transferBranch.useMutation({
    onSuccess: () => {
      notify.ok("تمت مناقلة الأصل بنجاح وتحديث العهدة والموقع");
      utils.assets.get.invalidate({ id: asset.id });
      utils.assets.list.invalidate();
      utils.assets.registerReport.invalidate();
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (err) => notify.err(err),
  });

  const availableBranches = (opts.data?.branches ?? []).filter(
    (b) => Number(b.id) !== Number(asset.branchId),
  );

  const availableEmployees = (opts.data?.employees ?? []).filter((e) => {
    if (!targetBranchId) return true;
    return e.branchId == null || Number(e.branchId) === Number(targetBranchId);
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetBranchId) {
      notify.warn("يرجى اختيار الفرع المحول إليه");
      return;
    }
    if (!reason.trim()) {
      notify.warn("يرجى توضيح سبب المناقلة");
      return;
    }

    transferMut.mutate({
      assetId: asset.id,
      targetBranchId: Number(targetBranchId),
      targetCustodianId: targetCustodianId ? Number(targetCustodianId) : null,
      location: location.trim() || undefined,
      reason: reason.trim(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowLeftRight className="size-5 text-primary" />
              <span>مناقلة أصل بين الفروع</span>
            </DialogTitle>
          </DialogHeader>

          <div className="p-3 rounded-lg bg-muted/60 text-xs space-y-1">
            <div className="font-semibold text-foreground">{asset.name}</div>
            <div className="text-muted-foreground font-mono" dir="ltr">
              {asset.code}
            </div>
            {asset.location && <div>الموقع الحالي: {asset.location}</div>}
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="target-branch">الفرع الهدف *</Label>
              <AppSelect
                id="target-branch"
                className={selectClsFull}
                value={targetBranchId}
                onValueChange={(val) => {
                  setTargetBranchId(val);
                  setTargetCustodianId("");
                }}
              >
                <option value="">اختر الفرع المحول إليه...</option>
                {availableBranches.map((b) => (
                  <option key={b.id} value={String(b.id)}>
                    {b.name}
                  </option>
                ))}
              </AppSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="target-custodian">الموظف المستلم (عهدة جديدة)</Label>
              <AppSelect
                id="target-custodian"
                className={selectClsFull}
                value={targetCustodianId}
                onValueChange={setTargetCustodianId}
              >
                <option value="">دون تسليم عهدة (أو اختيار لاحقاً)...</option>
                {availableEmployees.map((e) => (
                  <option key={e.id} value={String(e.id)}>
                    {e.name}
                  </option>
                ))}
              </AppSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="target-location">الموقع الجديد (الغرفة / القسم)</Label>
              <Input
                id="target-location"
                placeholder="مثال: صالة المبيعات الرئيسية، الطابق الأول"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="transfer-reason">سبب المناقلة *</Label>
              <Textarea
                id="transfer-reason"
                required
                rows={3}
                placeholder="بيان سبب نقل الأصل بين الفروع والمسؤول عن الطلب..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter className="flex gap-2 sm:justify-between pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              إلغاء
            </Button>
            <Button type="submit" disabled={transferMut.isPending}>
              {transferMut.isPending ? "جارٍ تنفيذ المناقلة…" : "تأكيد المناقلة"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
