import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const pagesRoot = path.resolve("client/src/pages");

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile() && entry.name.endsWith(".tsx")) files.push(full);
  }
  return files;
}

const rows = [];
for (const file of await walk(pagesRoot)) {
  const source = await readFile(file, "utf8");
  if (!/<table|<DataTable|<ScrollTableShell/.test(source)) continue;
  const usesDataTable = /<DataTable/.test(source);
  rows.push({
    page: path.relative(pagesRoot, file).replaceAll("\\", "/"),
    toolbar: /<ListToolbar/.test(source),
    search: (usesDataTable && !/searchable=\{false\}/.test(source))
      || /type="search"|placeholder="[^"]*(?:بحث|ابحث)|search=\{/.test(source),
    status: /status|الحالة/.test(source),
    branch: /branchId|الفرع/.test(source),
    date: /type="date"|<PeriodFilter/.test(source),
    reset: /onResetFilters|مسح الفلاتر|إعادة ضبط/.test(source),
    export: /exportRows|exportSpec=|تصدير/.test(source),
    print: /printReportDoc|onPrint=|print[A-Z]|طباعة/.test(source),
    refresh: /onRefresh=|refetch\(|refreshAll|تحديث/.test(source),
    pagination: usesDataTable || /<TablePager|setPage\(|pageIndex|offset/.test(source),
    sorting: usesDataTable || /sorting|sortBy|getToggleSortingHandler|orderBy/.test(source),
    bulk: /<SelectionBar|useRowSelection|selectedRows|selection=/.test(source),
  });
}

rows.sort((a, b) => a.page.localeCompare(b.page, "ar"));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const count = (key) => rows.filter((row) => row[key]).length;
console.log(`List/table screens: ${rows.length}`);
console.log(`Standard ListToolbar: ${count("toolbar")}/${rows.length}`);
console.log(`Text search: ${count("search")}/${rows.length}`);
console.log(`Filter reset: ${count("reset")}/${rows.length}`);
console.log(`Export: ${count("export")}/${rows.length}`);
console.log(`Print: ${count("print")}/${rows.length}`);
console.log(`Refresh: ${count("refresh")}/${rows.length}`);
console.log(`Pagination: ${count("pagination")}/${rows.length}`);
console.log(`Sorting: ${count("sorting")}/${rows.length}`);
console.log(`Bulk actions: ${count("bulk")}/${rows.length}`);
console.log("");
console.log("| Screen | Toolbar | Search | Reset | Export | Print | Refresh | Paging | Sort | Bulk |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const row of rows) {
  const mark = (value) => value ? "yes" : "—";
  console.log(`| ${row.page} | ${mark(row.toolbar)} | ${mark(row.search)} | ${mark(row.reset)} | ${mark(row.export)} | ${mark(row.print)} | ${mark(row.refresh)} | ${mark(row.pagination)} | ${mark(row.sorting)} | ${mark(row.bulk)} |`);
}
