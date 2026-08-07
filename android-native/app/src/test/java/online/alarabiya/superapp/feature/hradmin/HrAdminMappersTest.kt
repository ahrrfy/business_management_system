package online.alarabiya.superapp.feature.hradmin

import online.alarabiya.superapp.data.toEmployeePage
import online.alarabiya.superapp.data.toLeavePage
import online.alarabiya.superapp.data.toPayrollDetail
import online.alarabiya.superapp.model.hradmin.LeaveStatus
import online.alarabiya.superapp.model.hradmin.PayrollStatus
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class HrAdminMappersTest {
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
