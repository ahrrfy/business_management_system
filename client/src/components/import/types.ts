import type {
  ImportField,
  ImportHandler,
  ImportMeta,
  ImportSummary,
} from "@/lib/import";
export type ImportDialogProps<TRow> = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  entityName: string;
  fields: ImportField<TRow>[];
  onImport: ImportHandler<TRow>;
  onDone?: (summary: ImportSummary) => void;
  maxBytes?: number;
  /** وصف سلوكي (من importFields بجوار FIELDS): مفاتيح الرصيد/العملة/التجميع + دعم خيارات الخادم.
   *  غيابه مع وجود مفتاح productName في fields ⇒ fallback منتجات (تجميع وتقسيم عميل صرف، بلا خيارات خادمية). */
  meta?: ImportMeta;
};

export const BATCH_SIZE = 1000;
export const PREVIEW_LIMIT = 100;
