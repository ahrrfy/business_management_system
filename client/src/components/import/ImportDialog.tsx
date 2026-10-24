// Each open/entity/schema owns its draft; late reads cannot repopulate another session.
import { ImportSession } from "./ImportSession";
import type { ImportDialogProps } from "./types";
export type { ImportDialogProps } from "./types";
export function ImportDialog<TRow>(props: ImportDialogProps<TRow>) {
  if (!props.open) return null;
  const scope = JSON.stringify([
    props.entityName,
    props.fields.map(({ key, type, required }) => [key, type, required]),
    props.meta,
  ]);
  return <ImportSession key={scope} {...props} />;
}
