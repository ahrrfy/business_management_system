package online.alarabiya.superapp.feature.hradmin

import online.alarabiya.superapp.data.toEmployeePage
import online.alarabiya.superapp.data.toLeavePage
import online.alarabiya.superapp.data.toPayrollDetail
import online.alarabiya.superapp.data.toAttendancePage
import online.alarabiya.superapp.data.toEmployeeAdvanceOrNull
import online.alarabiya.superapp.data.toEmployeePromotionOrNull
import online.alarabiya.superapp.data.toFingerprintDeviceOrNull
import online.alarabiya.superapp.data.toPayrollLegalSettings
import online.alarabiya.superapp.data.validateLegalSettings
import online.alarabiya.superapp.model.hradmin.PayrollLegalSettings
import online.alarabiya.superapp.model.hradmin.LeaveStatus
import online.alarabiya.superapp.model.hradmin.PayrollStatus
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class HrAdminMappersTest {
    @Test
    fun `legal settings preserve decimal strings without floating point conversion`() {
        val settings = JSONObject()
            .put("socialSecurityEnabled", true)
            .put("socialSecurityEmployeeRate", "5.25")
            .put("socialSecurityEmployerRate", "12.00")
            .put("socialSecurityBase", "gross")
            .put("incomeTaxEnabled", true)
            .put("incomeTaxBrackets", JSONArray().put(JSONObject().put("upTo", "1000000.00").put("rate", "3.50")))
            .put("incomeTaxExemption", "250000.00")
            .put("endOfServiceEnabled", true)
            .put("endOfServiceDaysPerYear", "21.00")
            .toPayrollLegalSettings()

        assertEquals("5.25", settings.socialSecurityEmployeeRate)
        assertEquals("1000000.00", settings.incomeTaxBrackets.single().upTo)
        validateLegalSettings(settings)
    }

    @Test
    fun `legal settings reject non decimal money text`() {
        val invalid = PayrollLegalSettings(false, "five", "0", "basic", false, emptyList(), "0", false, "0", null, null)
        assertThrows(IllegalArgumentException::class.java) { validateLegalSettings(invalid) }
    }
    @Test
    fun `attendance page maps device source and authoritative totals`() {
        val page = JSONObject()
            .put("rows", JSONArray().put(JSONObject()
                .put("id", 9).put("employeeId", 2).put("employeeName", "أحمد")
                .put("attendanceDate", "2026-08-09").put("hours", "8.00")
                .put("source", "fingerprint")))
            .put("total", 71)
            .put("totals", JSONObject().put("hours", "533.50"))
            .toAttendancePage()

        assertEquals(71, page.total)
        assertEquals("533.50", page.totalHours)
        assertEquals("fingerprint", page.rows.single().source)
    }

    @Test
    fun `device mapper keeps server connectivity evidence`() {
        val device = JSONObject().put("id", 3).put("name", "بوابة الإدارة")
            .put("status", "online").put("lastSeenAt", "2026-08-09T12:00:00Z")
            .put("receivedPunches", 40).put("pendingPunches", 2)
            .toFingerprintDeviceOrNull()!!

        assertTrue(device.online)
        assertEquals(40, device.receivedPunches)
        assertEquals(2, device.pendingPunches)
    }

    @Test
    fun `advance and promotion mappers reject missing server ids`() {
        assertEquals(null, JSONObject().put("employeeId", 2).toEmployeeAdvanceOrNull())
        assertEquals(null, JSONObject().put("id", 2).toEmployeePromotionOrNull())
    }

    @Test
    fun `promotion maps workflow fields without inventing values`() {
        val promotion = JSONObject().put("id", 8).put("employeeId", 4)
            .put("employeeName", "سارة").put("fromTitle", "محاسب")
            .put("toTitle", "محاسب أول").put("effectiveDate", "2026-09-01")
            .put("status", "pending").toEmployeePromotionOrNull()!!

        assertEquals("محاسب أول", promotion.toTitle)
        assertEquals("pending", promotion.status)
    }
    @Test
    fun `employee page rejects rows outside requested branch`() {
        val json = JSONObject().put("rows", JSONArray().put(employeeJson(9))).put("total", 1)

        assertThrows(IllegalArgumentException::class.java) { json.toEmployeePage(expectedBranchId = 7) }
    }

    @Test
    fun `payroll detail maps server money and workflow status`() {
        val json = JSONObject()
            .put("id", 4)
            .put("period", "2026-08")
            .put("status", "approved")
            .put("employeeCount", 1)
            .put("totalGross", "1200.00")
            .put("totalDeductions", "200.00")
            .put("totalNet", "1000.00")
            .put("items", JSONArray().put(JSONObject()
                .put("id", 8)
                .put("employeeId", 11)
                .put("employeeName", "موظف")
                .put("gross", "1200.00")
                .put("deductions", "200.00")
                .put("net", "1000.00")))

        val detail = json.toPayrollDetail()

        assertEquals(PayrollStatus.APPROVED, detail.run.status)
        assertEquals("1000.00", detail.run.totalNet)
        assertEquals("1000.00", detail.items.single().net)
    }

    @Test
    fun `leave page keeps server counters rather than recomputing partial page`() {
        val json = JSONObject()
            .put("rows", JSONArray().put(JSONObject()
                .put("id", 3)
                .put("employeeId", 5)
                .put("employeeName", "موظف")
                .put("leaveType", "سنوية")
                .put("fromDate", "2026-08-01")
                .put("toDate", "2026-08-03")
                .put("days", 3)
                .put("status", "pending")))
            .put("total", 20)
            .put("hasMore", true)
            .put("counts", JSONObject().put("pending", 12).put("approved", 8).put("monthDays", 31))

        val page = json.toLeavePage()

        assertEquals(LeaveStatus.PENDING, page.rows.single().status)
        assertEquals(12, page.counts.pending)
        assertEquals(31, page.counts.monthDays)
    }

    private fun employeeJson(branchId: Long) = JSONObject()
        .put("id", 1)
        .put("branchId", branchId)
        .put("fullName", "موظف")
        .put("payType", "monthly")
        .put("employmentStatus", "active")
}
