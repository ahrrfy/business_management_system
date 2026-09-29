import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { qrCodeSvg } from "@/lib/printing/qr";
import { code128Svg } from "@/lib/printing/barcode";
import { printAssetLabel, type AssetLabelData } from "@/lib/assets/print";
import { Printer, QrCode } from "lucide-react";

interface AssetQrTagDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: AssetLabelData;
}

export function AssetQrTagDialog({ open, onOpenChange, asset }: AssetQrTagDialogProps) {
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [barcodeSvg, setBarcodeSvg] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !asset.code) return;
    let active = true;

    qrCodeSvg(asset.code, { size: 160, margin: 1 })
      .then((svg) => {
        if (active) setQrSvg(svg);
      })
      .catch(() => {
        if (active) setQrSvg(null);
      });

    try {
      const bc = code128Svg(asset.code, { moduleWidth: 1.5, height: 40, showText: false });
      setBarcodeSvg(bc.svg);
    } catch {
      setBarcodeSvg(null);
    }

    return () => {
      active = false;
    };
  }, [open, asset.code]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="size-5 text-primary" />
            <span>ملصق تتبع الأصل ورمز QR</span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center justify-center p-6 border rounded-xl bg-card shadow-inner space-y-3 text-center">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            {asset.branchName ?? "الأصول الثابتة"}
          </div>

          <div className="font-bold text-base line-clamp-2 max-w-xs">{asset.name}</div>

          <div className="p-3 bg-white rounded-lg border shadow-sm my-1 flex items-center justify-center min-h-[170px] min-w-[170px]">
            {qrSvg ? (
              <div dangerouslySetInnerHTML={{ __html: qrSvg }} />
            ) : (
              <div className="size-36 animate-pulse bg-muted rounded" />
            )}
          </div>

          <div className="font-mono text-lg font-extrabold tracking-wider text-primary dir-ltr" dir="ltr">
            {asset.code}
          </div>

          {barcodeSvg && (
            <div
              className="max-w-full overflow-hidden opacity-85"
              dangerouslySetInnerHTML={{ __html: barcodeSvg }}
            />
          )}

          <div className="text-xs text-muted-foreground space-y-0.5 pt-1">
            {asset.serial && (
              <div>
                الرقم التسلسلي: <span className="font-mono font-medium" dir="ltr">{asset.serial}</span>
              </div>
            )}
            {asset.category && <div>الفئة: {asset.category}</div>}
          </div>
        </div>

        <DialogFooter className="flex gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            إغلاق
          </Button>
          <Button
            onClick={() => {
              printAssetLabel(asset);
            }}
            className="flex items-center gap-2"
          >
            <Printer className="size-4" />
            <span>طباعة الملصق (80×100مم)</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
