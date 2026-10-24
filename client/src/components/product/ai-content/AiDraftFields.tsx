import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  PRODUCT_CONTENT_FIELD_LABELS as FIELD_LABELS,
  PRODUCT_CONTENT_FIELD_HINTS as FIELD_HINTS,
  PRODUCT_CONTENT_FIELD_LIMITS as FIELD_LIMITS,
  type ProductContentField,
} from "@shared/productContentAiLabels";
import type { ProductContentDraftEditor } from "./useProductContentDraft";
const FIELD_ORDER = Object.keys(FIELD_LABELS) as ProductContentField[];
export function AiDraftFields({
  editor,
}: {
  editor: ProductContentDraftEditor;
}) {
  const prefix = useId();
  const { visibleDraft, edited, updateField } = editor;
  if (!visibleDraft) return null;
  return (
    <>
      <div className="grid gap-3 lg:grid-cols-2">
        {FIELD_ORDER.map((field) => {
          const value = visibleDraft[field];
          const manuallyEdited = edited[field] !== undefined;
          return (
            <div
              key={field}
              className="space-y-1.5 rounded-md border bg-background/80 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor={`${prefix}-${field}`}
                  className="text-sm font-semibold"
                >
                  {FIELD_LABELS[field]}
                </label>
                {manuallyEdited && (
                  <Badge variant="outline" className="text-[10px]">
                    تعديل يدوي
                  </Badge>
                )}
              </div>
              <Textarea
                id={`${prefix}-${field}`}
                rows={
                  field === "description" || field === "marketingCopy" ? 3 : 2
                }
                value={value}
                onChange={(event) => updateField(field, event.target.value)}
                placeholder={FIELD_HINTS[field]}
                maxLength={FIELD_LIMITS[field]}
              />
              <p className="text-[11px] text-muted-foreground">
                {FIELD_HINTS[field]}
              </p>
            </div>
          );
        })}
      </div>

      {visibleDraft.keywords.length > 0 && (
        <div className="rounded-md border bg-background/80 p-3">
          <p className="mb-2 text-sm font-semibold">كلمات البحث المقترحة</p>
          <div className="flex flex-wrap gap-1.5">
            {visibleDraft.keywords.map((keyword) => (
              <Badge key={keyword} variant="secondary">
                {keyword}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {visibleDraft.unsupportedClaims.length > 0 && (
        <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/70 px-3 py-2 text-xs text-[var(--sem-warn)]">
          <p className="font-semibold">عبارات لم يعتمدها النظام</p>
          <ul className="mt-1 list-disc space-y-1 pe-5">
            {visibleDraft.unsupportedClaims.map((item) => (
              <li key={`${item.text}-${item.reason}`}>
                {item.text}: {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
