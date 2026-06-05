import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Clock,
  LogIn,
  LogOut,
  Calendar,
  CheckCircle,
  AlertCircle,
  BarChart3,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

/**
 * ====================================
 * شاشة الحضور والانصراف
 * ====================================
 * 
 * واجهة متكاملة لـ:
 * - تسجيل الحضور بالبصمة
 * - تسجيل الانصراف
 * - عرض ساعات العمل
 * - تقارير الحضور
 */

interface AttendanceStatus {
  isCheckedIn: boolean;
  checkInTime?: Date;
  checkOutTime?: Date;
  workHours?: number;
}

export default function AttendancePage() {
  const [employeeId, setEmployeeId] = useState<number>(1);
  const [attendanceStatus, setAttendanceStatus] = useState<AttendanceStatus>({
    isCheckedIn: false,
  });
  const [selectedMonth, setSelectedMonth] = useState(new Date());
  const [showReport, setShowReport] = useState(false);

  // استدعاء APIs
  const recordBiometricMutation = trpc.biometric.recordBiometric.useMutation();
  const getAttendanceQuery = trpc.biometric.getAttendanceRecord.useQuery({
    employeeId,
  });
  const getMonthlyReportQuery = trpc.biometric.getMonthlyReport.useQuery({
    employeeId,
    year: selectedMonth.getFullYear(),
    month: selectedMonth.getMonth() + 1,
  });

  // تحديث حالة الحضور
  useEffect(() => {
    if (getAttendanceQuery.data?.data) {
      const record = getAttendanceQuery.data.data;
      setAttendanceStatus({
        isCheckedIn: !!record.checkInTime && !record.checkOutTime,
        checkInTime: record.checkInTime,
        checkOutTime: record.checkOutTime,
        workHours: record.workHours,
      });
    }
  }, [getAttendanceQuery.data]);

  /**
   * تسجيل البصمة (حضور/انصراف)
   */
  const handleBiometricRecord = async () => {
    try {
      const result = await recordBiometricMutation.mutateAsync({
        employeeId,
        fingerprint: "fingerprint_data", // سيتم استبداله ببيانات البصمة الفعلية من الجهاز
        deviceId: "device_001",
      });

      if (result.success) {
        toast.success(result.message);
        getAttendanceQuery.refetch();
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "حدث خطأ";
      toast.error(message);
    }
  };

  /**
   * الحصول على لون الحالة
   */
  const getStatusColor = () => {
    if (attendanceStatus.isCheckedIn) {
      return "text-green-600";
    }
    if (attendanceStatus.checkOutTime) {
      return "text-blue-600";
    }
    return "text-gray-600";
  };

  /**
   * الحصول على نص الحالة
   */
  const getStatusText = () => {
    if (attendanceStatus.isCheckedIn) {
      return "في العمل";
    }
    if (attendanceStatus.checkOutTime) {
      return "انصرف";
    }
    return "لم يتم التسجيل";
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* رأس الصفحة */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">
              الحضور والانصراف
            </h1>
            <p className="text-gray-600 mt-1">
              تسجيل الحضور والانصراف بالبصمة
            </p>
          </div>
          <Clock className="w-12 h-12 text-blue-600" />
        </div>

        {/* حالة الحضور الحالية */}
        <Card className="border-2">
          <CardHeader>
            <CardTitle>حالة الحضور اليوم</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* حالة الحضور */}
              <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg p-6 text-center">
                <div className={`text-4xl font-bold mb-2 ${getStatusColor()}`}>
                  {attendanceStatus.isCheckedIn ? (
                    <LogIn className="w-12 h-12 mx-auto" />
                  ) : attendanceStatus.checkOutTime ? (
                    <LogOut className="w-12 h-12 mx-auto" />
                  ) : (
                    <AlertCircle className="w-12 h-12 mx-auto" />
                  )}
                </div>
                <p className={`text-lg font-semibold ${getStatusColor()}`}>
                  {getStatusText()}
                </p>
              </div>

              {/* وقت الحضور */}
              <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-6 text-center">
                <p className="text-gray-600 text-sm mb-2">وقت الحضور</p>
                <p className="text-2xl font-bold text-green-600">
                  {attendanceStatus.checkInTime
                    ? new Date(attendanceStatus.checkInTime).toLocaleTimeString(
                        "ar-SA"
                      )
                    : "-"}
                </p>
              </div>

              {/* وقت الانصراف */}
              <div className="bg-gradient-to-br from-orange-50 to-orange-100 rounded-lg p-6 text-center">
                <p className="text-gray-600 text-sm mb-2">وقت الانصراف</p>
                <p className="text-2xl font-bold text-orange-600">
                  {attendanceStatus.checkOutTime
                    ? new Date(attendanceStatus.checkOutTime).toLocaleTimeString(
                        "ar-SA"
                      )
                    : "-"}
                </p>
              </div>
            </div>

            {/* ساعات العمل */}
            {attendanceStatus.workHours && (
              <div className="bg-purple-50 rounded-lg p-4">
                <p className="text-gray-600 text-sm mb-1">ساعات العمل</p>
                <p className="text-3xl font-bold text-purple-600">
                  {attendanceStatus.workHours.toFixed(2)} ساعة
                </p>
              </div>
            )}

            {/* زر تسجيل البصمة */}
            <Button
              onClick={handleBiometricRecord}
              disabled={recordBiometricMutation.isPending}
              className="w-full py-6 text-lg"
              size="lg"
            >
              {recordBiometricMutation.isPending ? (
                "جاري المعالجة..."
              ) : attendanceStatus.isCheckedIn ? (
                <>
                  <LogOut className="w-5 h-5 mr-2" />
                  تسجيل الانصراف
                </>
              ) : (
                <>
                  <LogIn className="w-5 h-5 mr-2" />
                  تسجيل الحضور
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* تقرير الحضور الشهري */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5" />
              تقرير الحضور الشهري
            </CardTitle>
            <Button
              variant="outline"
              onClick={() => setShowReport(!showReport)}
            >
              {showReport ? "إخفاء" : "عرض"}
            </Button>
          </CardHeader>

          {showReport && getMonthlyReportQuery.data?.data && (
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {/* أيام الحضور */}
                <div className="bg-green-50 rounded-lg p-4 text-center">
                  <p className="text-gray-600 text-sm mb-2">أيام الحضور</p>
                  <p className="text-3xl font-bold text-green-600">
                    {getMonthlyReportQuery.data.data.presentDays}
                  </p>
                </div>

                {/* أيام الغياب */}
                <div className="bg-red-50 rounded-lg p-4 text-center">
                  <p className="text-gray-600 text-sm mb-2">أيام الغياب</p>
                  <p className="text-3xl font-bold text-red-600">
                    {getMonthlyReportQuery.data.data.absentDays}
                  </p>
                </div>

                {/* أيام التأخر */}
                <div className="bg-yellow-50 rounded-lg p-4 text-center">
                  <p className="text-gray-600 text-sm mb-2">أيام التأخر</p>
                  <p className="text-3xl font-bold text-yellow-600">
                    {getMonthlyReportQuery.data.data.lateDays}
                  </p>
                </div>

                {/* إجازات */}
                <div className="bg-blue-50 rounded-lg p-4 text-center">
                  <p className="text-gray-600 text-sm mb-2">إجازات</p>
                  <p className="text-3xl font-bold text-blue-600">
                    {getMonthlyReportQuery.data.data.leaveDays}
                  </p>
                </div>

                {/* إجمالي ساعات العمل */}
                <div className="bg-purple-50 rounded-lg p-4 text-center md:col-span-2">
                  <p className="text-gray-600 text-sm mb-2">إجمالي ساعات العمل</p>
                  <p className="text-3xl font-bold text-purple-600">
                    {getMonthlyReportQuery.data.data.totalWorkHours}
                  </p>
                </div>

                {/* نسبة الحضور */}
                <div className="bg-indigo-50 rounded-lg p-4 text-center md:col-span-2">
                  <p className="text-gray-600 text-sm mb-2">نسبة الحضور</p>
                  <p className="text-3xl font-bold text-indigo-600">
                    {getMonthlyReportQuery.data.data.attendanceRate.toFixed(1)}%
                  </p>
                </div>
              </div>
            </CardContent>
          )}
        </Card>

        {/* اختيار الشهر */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="w-5 h-5" />
              اختيار الشهر
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                type="month"
                value={`${selectedMonth.getFullYear()}-${String(
                  selectedMonth.getMonth() + 1
                ).padStart(2, "0")}`}
                onChange={(e) => {
                  const [year, month] = e.target.value.split("-");
                  const newDate = new Date(parseInt(year), parseInt(month) - 1);
                  setSelectedMonth(newDate);
                  getMonthlyReportQuery.refetch();
                }}
                className="flex-1"
              />
              <Button
                onClick={() => getMonthlyReportQuery.refetch()}
                variant="outline"
              >
                تحديث
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
