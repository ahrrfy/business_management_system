import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { FIELD_TYPE_LABELS } from "@shared/customizationTemplateTerms";
import {
  addEditorOption,
  editorOptions,
  moveEditorOption,
  removeEditorOption,
  renameEditorOption,
  type EditorField,
  type FieldType,
} from "./customizationTemplateEditorModel";
function DependencyValuesControl({
  field,
  fields,
  onChange,
}: {
  field: EditorField;
  fields: EditorField[];
  onChange: (value: string) => void;
}) {
  const parent = fields.find(
    (candidate) => candidate.fieldKey === field.dependencyKey,
  );
  const options =
    parent && ["SELECT", "SWATCH"].includes(parent.fieldType)
      ? editorOptions(parent.optionsText)
      : [];
  if (!field.dependencyKey || options.length === 0) {
    return (
      <Input
        value={field.dependencyValues}
        onChange={(event) => onChange(event.target.value)}
        placeholder="القيم المطلوبة مفصولة بفاصلة"
        disabled={!field.dependencyKey}
      />
    );
  }
  const selected = new Set(
    field.dependencyValues
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return (
    <div className="rounded-md border p-2 md:col-span-2">
      <p className="mb-2 font-bold">يظهر عند اختيار:</p>
      <div className="flex flex-wrap gap-3">
        {options.map((option) => (
          <label key={option.value} className="flex min-h-9 items-center gap-2">
            <input
              type="checkbox"
              checked={selected.has(option.value)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(option.value);
                else next.delete(option.value);
                onChange(
                  options
                    .filter((candidate) => next.has(candidate.value))
                    .map((candidate) => candidate.value)
                    .join(","),
                );
              }}
            />{" "}
            {option.label}
          </label>
        ))}
      </div>
    </div>
  );
}

export function CustomizationFieldEditor({
  field,
  index,
  fields,
  onUpdate,
  onTypeChange,
  onMove,
  onRemove,
}: {
  field: EditorField;
  index: number;
  fields: EditorField[];
  onUpdate: (patch: Partial<EditorField>) => void;
  onTypeChange: (type: FieldType) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const fieldKeys = fields.map((item) => item.fieldKey).filter(Boolean);
  return (
    <div className="min-w-0 rounded-md border bg-background p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-muted-foreground">
          الحقل {index + 1}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label="نقل الحقل إلى الأعلى"
          >
            <ArrowUp className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11"
            onClick={() => onMove(1)}
            disabled={index === fields.length - 1}
            aria-label="نقل الحقل إلى الأسفل"
          >
            <ArrowDown className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11"
            onClick={onRemove}
            aria-label="حذف الحقل"
          >
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_15rem_auto] md:items-end">
        <label className="text-xs font-bold">
          اسم الحقل كما يراه الزبون
          <Input
            value={field.label}
            onChange={(event) => onUpdate({ label: event.target.value })}
            className="mt-1.5"
            placeholder="مثال: النص المطلوب على الختم"
          />
        </label>
        <label className="text-xs font-bold">
          طريقة الإجابة
          <select
            value={field.fieldType}
            onChange={(event) => onTypeChange(event.target.value as FieldType)}
            className="mt-1.5 h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            {Object.entries(FIELD_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex h-9 items-center gap-2 text-xs font-bold">
          <input
            type="checkbox"
            checked={field.isRequired}
            onChange={(event) => onUpdate({ isRequired: event.target.checked })}
          />{" "}
          مطلوب
        </label>
      </div>
      {["SELECT", "SWATCH"].includes(field.fieldType) && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold">
              الخيارات التي يراها الزبون
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                onUpdate({ optionsText: addEditorOption(field.optionsText) })
              }
            >
              <Plus className="size-3.5" /> إضافة خيار
            </Button>
          </div>
          {editorOptions(field.optionsText).map(
            (option, optionIndex, options) => (
              <div key={option.value} className="flex items-center gap-1">
                <Input
                  value={option.label}
                  onChange={(event) =>
                    onUpdate({
                      optionsText: renameEditorOption(
                        field.optionsText,
                        option.value,
                        event.target.value,
                      ),
                    })
                  }
                  aria-label={`اسم الخيار ${optionIndex + 1}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  onClick={() =>
                    onUpdate({
                      optionsText: moveEditorOption(
                        field.optionsText,
                        option.value,
                        -1,
                      ),
                    })
                  }
                  disabled={optionIndex === 0}
                  aria-label={`نقل الخيار ${option.label} إلى الأعلى`}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  onClick={() =>
                    onUpdate({
                      optionsText: moveEditorOption(
                        field.optionsText,
                        option.value,
                        1,
                      ),
                    })
                  }
                  disabled={optionIndex === options.length - 1}
                  aria-label={`نقل الخيار ${option.label} إلى الأسفل`}
                >
                  <ArrowDown className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  onClick={() =>
                    onUpdate({
                      optionsText: removeEditorOption(
                        field.optionsText,
                        option.value,
                      ),
                    })
                  }
                  aria-label={`حذف الخيار ${option.label}`}
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </div>
            ),
          )}
        </div>
      )}
      <details className="mt-3 rounded-md border border-dashed p-2 text-xs">
        <summary className="cursor-pointer font-bold text-muted-foreground">
          إعدادات متقدمة — اختيارية
        </summary>
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 md:grid-cols-3">
          <label>
            الحد الأقصى للنص
            <Input
              value={field.maxLength}
              onChange={(event) => onUpdate({ maxLength: event.target.value })}
              type="number"
              className="mt-1"
              placeholder="تلقائي"
            />
          </label>
          <label>
            سعر إضافي
            <Input
              value={field.priceDelta}
              onChange={(event) => onUpdate({ priceDelta: event.target.value })}
              className="mt-1"
            />
          </label>
          <label>
            المفتاح التقني
            <Input
              value={field.fieldKey}
              onChange={(event) => onUpdate({ fieldKey: event.target.value })}
              className="mt-1 font-mono"
              dir="ltr"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={field.isActive}
              onChange={(event) => onUpdate({ isActive: event.target.checked })}
            />{" "}
            ظاهر للزبون
          </label>
          <select
            value={field.dependencyKey}
            onChange={(event) =>
              onUpdate({ dependencyKey: event.target.value })
            }
            className="h-9 rounded-md border bg-background px-2"
          >
            <option value="">يظهر دائماً</option>
            {fieldKeys
              .filter((key) => key !== field.fieldKey)
              .map((key) => (
                <option key={key} value={key}>
                  يظهر حسب {key}
                </option>
              ))}
          </select>
          <DependencyValuesControl
            field={field}
            fields={fields}
            onChange={(value) => onUpdate({ dependencyValues: value })}
          />
        </div>
      </details>
    </div>
  );
}
