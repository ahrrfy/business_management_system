import { useRef } from "react";
import { Download, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
export function ImportFileStep({
  reading,
  onFile,
  downloadTemplate,
}: {
  reading: boolean;
  onFile: (file?: File) => Promise<void>;
  downloadTemplate: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={reading}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!reading) void onFile(e.dataTransfer.files?.[0]);
        }}
        className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-5 sm:p-10 text-center text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40 disabled:opacity-70"
      >
        {reading ? (
          <>
            <Loader2 className="size-7 animate-spin" aria-hidden="true" />
            <span className="text-sm font-medium text-foreground">
              جارٍ قراءة الملف…
            </span>
          </>
        ) : (
          <>
            <Upload className="size-7" />
            <span className="text-sm font-medium text-foreground">
              اختر ملفاً أو أفلِته هنا
            </span>
            <span className="text-xs">صيغ مدعومة: .xlsx · .csv</span>
          </>
        )}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void onFile(file);
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          لا تملك قالباً؟ نزّل قالباً فارغاً بالأعمدة الصحيحة.
        </span>
        <Button variant="outline" size="sm" onClick={downloadTemplate}>
          <Download className="size-4" />
          تنزيل القالب
        </Button>
      </div>
    </div>
  );
}
