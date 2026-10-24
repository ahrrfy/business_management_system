import { Camera, Loader2, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import type { QuickStudioController } from "./useQuickStudioController";

export function QuickStudioSearchBar({
  controller,
  className,
}: {
  controller: QuickStudioController;
  className: string;
}) {
  const {
    barcodeInput,
    setBarcodeInput,
    searchInputRef,
    handleStartSearch,
    lookupQuery,
    offline,
    setCameraScannerOpen,
    lookupTarget,
  } = controller;
  return (
    <Card
      className={`border-primary/25 bg-gradient-to-br from-primary/[0.03] via-card to-background shadow-sm ${className}`}
    >
      <CardContent className="p-3 sm:p-4">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ScanLine aria-hidden className="size-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-foreground">
                مسح واستعلام المنتجات بالباركود
              </h3>
              <p className="text-xs text-muted-foreground">
                مسح فوري بالكاميرا أو القارئ لمعاينة الصور وإضافة لقطات جديدة
                ومعالجتها واعتمادها مباشرة.
              </p>
            </div>
          </div>

          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:max-w-md sm:flex-1 sm:flex-nowrap sm:justify-end">
            <div className="min-w-[180px] flex-1">
              <UnifiedSearchInput
                ref={searchInputRef}
                value={barcodeInput}
                onChange={(val) => setBarcodeInput(val)}
                onScan={(scanned) => {
                  setBarcodeInput(scanned);
                  handleStartSearch(scanned);
                }}
                onSubmit={() => handleStartSearch(barcodeInput)}
                barcode={true}
                disabled={offline || lookupQuery.isLoading}
                placeholder="امسح الباركود أو اكتبه ثم اضغط Enter..."
                className="w-full"
              />
            </div>

            <Button
              type="button"
              variant="outline"
              size="default"
              disabled={offline}
              onClick={() => setCameraScannerOpen(true)}
              className="shrink-0 gap-1.5 border-dashed font-semibold"
              title="مسح باركود المنتج بكاميرا الهاتف"
            >
              <Camera aria-hidden className="size-4 text-primary" />
              <span className="hidden xs:inline">كاميرا الهاتف</span>
              <span className="xs:hidden">مسح</span>
            </Button>

            <Button
              type="button"
              size="default"
              disabled={
                offline || !barcodeInput.trim() || lookupQuery.isLoading
              }
              onClick={() => handleStartSearch(barcodeInput)}
              className="shrink-0 font-semibold"
            >
              {lookupQuery.isLoading &&
              lookupTarget?.barcode === barcodeInput.trim() ? (
                <Loader2 aria-hidden className="size-4 animate-spin" />
              ) : (
                "استعلام"
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
