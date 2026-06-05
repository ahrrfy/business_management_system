import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Upload, Download, FileSpreadsheet, CheckCircle, AlertCircle, Loader2, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

type ImportStep = "upload" | "mapping" | "validation" | "importing" | "complete";
type EntityType = "products" | "customers" | "suppliers";

interface ColumnMapping {
  sourceColumn: string;
  targetField: string;
  confidence: number;
}

interface ValidationResult {
  isValid: boolean;
  totalRows: number;
  validRows: number;
  errorRows: number;
  duplicateRows: number;
  errors: { row: number; field: string; message: string }[];
  duplicates: { row: number; field: string; existingValue: string }[];
  warnings: { row: number; field: string; message: string }[];
}

export default function ImportExport() {
  const [importStep, setImportStep] = useState<ImportStep>("upload");
  const [selectedType, setSelectedType] = useState<EntityType>("products");
  const [file, setFile] = useState<File | null>(null);
  const [fileHeaders, setFileHeaders] = useState<string[]>([]);
  const [fileData, setFileData] = useState<Record<string, any>[]>([]);
  const [columnMappings, setColumnMappings] = useState<ColumnMapping[]>([]);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const expectedColumns = trpc.importExport.getExpectedColumns.useQuery({ entityType: selectedType });
  const smartMapping = trpc.importExport.smartMapping.useMutation();
  const validateData = trpc.importExport.validate.useMutation();
  const executeImport = trpc.importExport.executeImport.useMutation();

  const dataTypes = [
    { value: "products" as EntityType, label: "المنتجات" },
    { value: "customers" as EntityType, label: "العملاء" },
    { value: "suppliers" as EntityType, label: "الموردين" },
  ];

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.name.endsWith(".xlsx") && !f.name.endsWith(".xls") && !f.name.endsWith(".csv")) {
      toast.error("يرجى رفع ملف Excel أو CSV فقط");
      return;
    }
    setFile(f);
    toast.info("جاري قراءة الملف...");
    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const text = event.target?.result as string;
          const lines = text.split("\n").filter(l => l.trim());
          if (lines.length < 2) { toast.error("الملف فارغ أو لا يحتوي على بيانات"); return; }
          const headers = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
          const rows = lines.slice(1).map(line => {
            const values = line.split(",").map(v => v.trim().replace(/"/g, ""));
            const row: Record<string, any> = {};
            headers.forEach((h, i) => { row[h] = values[i] || ""; });
            return row;
          });
          setFileHeaders(headers);
          setFileData(rows);
          const mappings = await smartMapping.mutateAsync({ headers, entityType: selectedType });
          setColumnMappings(mappings);
          setImportStep("mapping");
          toast.success(`تم قراءة ${rows.length} صف من الملف`);
        } catch (err) { toast.error("خطأ في قراءة الملف"); }
      };
      reader.readAsText(f);
    } catch (err) { toast.error("خطأ في معالجة الملف"); }
  }

  function updateMapping(sourceColumn: string, targetField: string) {
    setColumnMappings(prev => prev.map(m => m.sourceColumn === sourceColumn ? { ...m, targetField, confidence: 1 } : m));
  }

  async function handleValidate() {
    setImportStep("validation");
    try {
      const result = await validateData.mutateAsync({ data: fileData, entityType: selectedType, columnMappings });
      setValidationResult(result);
    } catch (err: any) { toast.error(err.message || "خطأ في التحقق"); setImportStep("mapping"); }
  }

  async function handleExecuteImport() {
    setImportStep("importing");
    try {
      const result = await executeImport.mutateAsync({ data: fileData, entityType: selectedType, columnMappings, skipDuplicates: true });
      setImportResult(result);
      setImportStep("complete");
      toast.success(`تم استيراد ${result.imported} سجل بنجاح!`);
    } catch (err: any) { toast.error(err.message || "خطأ في الاستيراد"); setImportStep("validation"); }
  }

  function handleExport(type: EntityType, format: "csv" | "excel") {
    toast.info("ميزة التصدير قيد التطوير - ستكون متاحة قريباً");
  }

  function resetImport() {
    setImportStep("upload"); setFile(null); setFileHeaders([]); setFileData([]);
    setColumnMappings([]); setValidationResult(null); setImportResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const targetFields = expectedColumns.data || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">الاستيراد والتصدير</h1>
        <p className="text-muted-foreground mt-1">استيراد البيانات من CSV أو تصدير البيانات الحالية - مصمم للهجرة من النظام القديم</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Upload className="h-5 w-5 text-primary" />استيراد البيانات</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 mb-6">
            {["رفع الملف", "مطابقة الأعمدة", "التحقق", "الاستيراد", "اكتمال"].map((step, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${i <= ["upload","mapping","validation","importing","complete"].indexOf(importStep) ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{i + 1}</div>
                <span className="text-sm hidden sm:inline">{step}</span>
                {i < 4 && <div className="w-6 h-0.5 bg-muted" />}
              </div>
            ))}
          </div>

          {importStep === "upload" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">نوع البيانات المراد استيرادها</label>
                <Select value={selectedType} onValueChange={(v) => setSelectedType(v as EntityType)}>
                  <SelectTrigger className="w-full max-w-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {dataTypes.map((dt) => (<SelectItem key={dt.value} value={dt.value}>{dt.label}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              {targetFields.length > 0 && (
                <div className="bg-muted/50 p-4 rounded-lg">
                  <p className="text-sm font-medium mb-2">الحقول المتوقعة في الملف:</p>
                  <div className="flex flex-wrap gap-2">
                    {targetFields.map((f: any) => (<Badge key={f.field} variant={f.required ? "default" : "secondary"}>{f.label} {f.required && "*"}</Badge>))}
                  </div>
                </div>
              )}
              <div className="border-2 border-dashed rounded-lg p-8 text-center hover:border-primary/50 transition-colors">
                <FileSpreadsheet className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground mb-2">اسحب ملف CSV هنا أو اضغط للاختيار</p>
                <p className="text-xs text-muted-foreground mb-4">الصيغ المدعومة: CSV (مفصول بفاصلة)</p>
                <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileUpload} className="hidden" id="file-upload" />
                <label htmlFor="file-upload"><Button asChild><span>اختيار ملف</span></Button></label>
              </div>
            </div>
          )}

          {importStep === "mapping" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">ملف: <strong>{file?.name}</strong> — {fileData.length} صف</p>
                <Button variant="ghost" size="sm" onClick={resetImport}><ArrowLeft className="h-4 w-4 ml-1" />رجوع</Button>
              </div>
              <Table>
                <TableHeader><TableRow><TableHead className="text-right">عمود الملف</TableHead><TableHead className="text-right">الحقل في النظام</TableHead><TableHead className="text-right">الثقة</TableHead></TableRow></TableHeader>
                <TableBody>
                  {columnMappings.map((mapping) => (
                    <TableRow key={mapping.sourceColumn}>
                      <TableCell className="font-mono text-sm">{mapping.sourceColumn}</TableCell>
                      <TableCell>
                        <Select value={mapping.targetField} onValueChange={(v) => updateMapping(mapping.sourceColumn, v)}>
                          <SelectTrigger className="w-48"><SelectValue placeholder="اختر الحقل" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="skip">— تخطي —</SelectItem>
                            {targetFields.map((f: any) => (<SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Badge className={mapping.confidence >= 0.8 ? "bg-green-100 text-green-800" : mapping.confidence >= 0.5 ? "" : "bg-red-100 text-red-800"}>{Math.round(mapping.confidence * 100)}%</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {fileData.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2">معاينة أول 3 صفوف:</p>
                  <div className="overflow-x-auto border rounded-lg">
                    <Table>
                      <TableHeader><TableRow>{fileHeaders.map(h => <TableHead key={h} className="text-right text-xs">{h}</TableHead>)}</TableRow></TableHeader>
                      <TableBody>{fileData.slice(0, 3).map((row, i) => (<TableRow key={i}>{fileHeaders.map(h => <TableCell key={h} className="text-xs">{row[h]}</TableCell>)}</TableRow>))}</TableBody>
                    </Table>
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <Button onClick={handleValidate} disabled={validateData.isPending}>{validateData.isPending && <Loader2 className="h-4 w-4 animate-spin ml-2" />}التحقق من البيانات</Button>
                <Button variant="outline" onClick={resetImport}>إلغاء</Button>
              </div>
            </div>
          )}

          {importStep === "validation" && (
            <div className="space-y-4">
              {validateData.isPending ? (
                <div className="text-center py-8"><Loader2 className="h-12 w-12 animate-spin mx-auto text-primary mb-4" /><p className="text-lg font-medium">جاري التحقق من البيانات...</p></div>
              ) : validationResult ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 border rounded-lg text-center"><CheckCircle className="h-8 w-8 mx-auto text-green-600 mb-2" /><p className="text-2xl font-bold text-green-600">{validationResult.validRows}</p><p className="text-xs text-muted-foreground">صف صالح</p></div>
                    <div className="p-4 border rounded-lg text-center"><AlertCircle className="h-8 w-8 mx-auto text-red-600 mb-2" /><p className="text-2xl font-bold text-red-600">{validationResult.errorRows}</p><p className="text-xs text-muted-foreground">صف به أخطاء</p></div>
                  </div>
                  {validationResult.errors.length > 0 && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-4 max-h-40 overflow-y-auto">
                      <p className="text-sm font-medium text-red-800 mb-2">الأخطاء:</p>
                      {validationResult.errors.slice(0, 10).map((err, i) => (<p key={i} className="text-xs text-red-700">• صف {err.row}: {err.field} - {err.message}</p>))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button onClick={handleExecuteImport} disabled={validationResult.validRows === 0}>استيراد {validationResult.validRows} سجل صالح</Button>
                    <Button variant="outline" onClick={() => setImportStep("mapping")}>تعديل المطابقة</Button>
                    <Button variant="ghost" onClick={resetImport}>إلغاء</Button>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {importStep === "importing" && (
            <div className="text-center py-8"><Loader2 className="h-12 w-12 animate-spin mx-auto text-primary mb-4" /><p className="text-lg font-medium">جاري استيراد البيانات...</p></div>
          )}

          {importStep === "complete" && importResult && (
            <div className="text-center py-8 space-y-4">
              <CheckCircle className="h-12 w-12 mx-auto text-green-600 mb-4" />
              <p className="text-lg font-medium text-green-600">تم الاستيراد بنجاح!</p>
              <div className="grid grid-cols-3 gap-4 max-w-md mx-auto">
                <div className="p-3 border rounded-lg"><p className="text-xl font-bold text-green-600">{importResult.imported}</p><p className="text-xs text-muted-foreground">تم استيراده</p></div>
                <div className="p-3 border rounded-lg"><p className="text-xl font-bold text-yellow-600">{importResult.skipped}</p><p className="text-xs text-muted-foreground">تم تخطيه</p></div>
                <div className="p-3 border rounded-lg"><p className="text-xl font-bold text-red-600">{importResult.errors.length}</p><p className="text-xs text-muted-foreground">أخطاء</p></div>
              </div>
              <Button className="mt-4" onClick={resetImport}>استيراد ملف آخر</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Download className="h-5 w-5 text-primary" />تصدير البيانات</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {dataTypes.map((dt) => (
              <div key={dt.value} className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
                <span className="font-medium">{dt.label}</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => handleExport(dt.value, "excel")}><FileSpreadsheet className="h-3 w-3 ml-1" />Excel</Button>
                  <Button size="sm" variant="outline" onClick={() => handleExport(dt.value, "csv")}>CSV</Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
