import { Image as ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { QuickStudioController } from "./useQuickStudioController";

export function QuickStudioImagePreviewDialog({
  controller,
}: {
  controller: QuickStudioController;
}) {
  const { previewZoomImage, setPreviewZoomImage } = controller;
  return (
    <>
      {previewZoomImage && (
        <Dialog
          open={Boolean(previewZoomImage)}
          onOpenChange={(open) => !open && setPreviewZoomImage(null)}
        >
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sm">
                <ImageIcon aria-hidden className="size-4 text-primary" />
                معاينة الصورة بكامل الدقة
              </DialogTitle>
            </DialogHeader>
            <div className="flex max-h-[75dvh] items-center justify-center overflow-hidden rounded-lg bg-white p-2">
              <img
                src={previewZoomImage}
                alt="معاينة كاملة"
                className="max-h-full max-w-full object-contain"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPreviewZoomImage(null)}
              >
                إغلاق
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
