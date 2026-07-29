// أقسام فرعية (٢٩/٧): تجميع قائمة الفئات المسطّحة (id/name/parentId) لعرضها شجرياً في أي
// <select> يستعمل trpc.catalog.categories — فئة رئيسية بلا فرعيات تُعرض كخيار عادي، وفئة رئيسية
// لها فرعيات تُعرض كـ<optgroup> يحوي خياراً لها هي نفسها («عام») ثم فرعياتها. لا يغيّر categoryId
// المُرسَل — القيمة تبقى معرّف الفئة (رئيسية أو فرعية) كما كانت دائماً.
export interface CategoryLite {
  id: number;
  name: string;
  parentId: number | null;
}

export function groupCategoriesTree<T extends CategoryLite>(list: T[]): { top: T; children: T[] }[] {
  const byParent = new Map<number, T[]>();
  for (const c of list) {
    if (c.parentId != null) {
      const arr = byParent.get(c.parentId);
      if (arr) arr.push(c);
      else byParent.set(c.parentId, [c]);
    }
  }
  return list.filter((c) => c.parentId == null).map((top) => ({ top, children: byParent.get(top.id) ?? [] }));
}

/** يُستعمل داخل `<select>...</select>` مكان `.map(c => <option>)` — نفس القيمة (id)، عرض شجري فقط. */
export function CategoryOptionList({ categories }: { categories: CategoryLite[] }) {
  const groups = groupCategoriesTree(categories);
  return (
    <>
      {groups.map(({ top, children }) =>
        children.length ? (
          <optgroup key={top.id} label={top.name}>
            <option value={top.id}>{top.name} (عام)</option>
            {children.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </optgroup>
        ) : (
          <option key={top.id} value={top.id}>{top.name}</option>
        ),
      )}
    </>
  );
}
