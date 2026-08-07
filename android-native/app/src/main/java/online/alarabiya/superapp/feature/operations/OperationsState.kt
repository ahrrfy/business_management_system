package online.alarabiya.superapp.feature.operations

import online.alarabiya.superapp.model.operations.AssetDetail
import online.alarabiya.superapp.model.operations.AssetStatus
import online.alarabiya.superapp.model.operations.AssetSummary
import online.alarabiya.superapp.model.operations.ConsignmentNoteDetail
import online.alarabiya.superapp.model.operations.ConsignmentNoteSummary
import online.alarabiya.superapp.model.operations.ConsignmentNoteType
import online.alarabiya.superapp.model.operations.ConsignorProduct
import online.alarabiya.superapp.model.operations.MyCommissionStatus
import online.alarabiya.superapp.model.operations.OperationsCapabilities
import online.alarabiya.superapp.model.operations.OperationsSection
import online.alarabiya.superapp.model.operations.OperationsScope
import java.time.YearMonth

sealed interface OperationsDetailState<out T> {
    data object None : OperationsDetailState<Nothing>
    data object Loading : OperationsDetailState<Nothing>
    data class Content<T>(val value: T) : OperationsDetailState<T>
    data class Error(val message: String) : OperationsDetailState<Nothing>
}

sealed interface PendingOperationsAction {
    val key: String

    data class ReturnAsset(val asset: AssetSummary) : PendingOperationsAction {
        override val key: String = "asset:return:${asset.id}"
    }

    data class StartMaintenance(
        val asset: AssetSummary,
        val type: String,
        val vendor: String?,
        val note: String?,
        val date: String?,
    ) : PendingOperationsAction {
        override val key: String = "asset:maintenance:${asset.id}"
    }

    data class CreateConsignment(
        val note: ConsignmentNoteSummary,
        val type: ConsignmentNoteType,
        val product: ConsignorProduct,
        val quantity: String,
        val notes: String?,
        val clientRequestId: String,
    ) : PendingOperationsAction {
        override val key: String = "consignment:create:$clientRequestId"
    }
}

data class OperationsUiState(
    val section: OperationsSection = OperationsSection.Assets,
    val scope: OperationsScope,
    val capabilities: OperationsCapabilities,
    val loading: Boolean = false,
    val loadingMore: Boolean = false,
    val query: String = "",
    val assetStatus: AssetStatus? = null,
    val assets: List<AssetSummary> = emptyList(),
    val assetsLoaded: Boolean = false,
    val selectedAssetId: Long? = null,
    val assetDetail: OperationsDetailState<AssetDetail> = OperationsDetailState.None,
    val commissionPeriod: String = YearMonth.now().toString(),
    val commission: OperationsDetailState<MyCommissionStatus?> = OperationsDetailState.None,
    val consignmentType: ConsignmentNoteType? = null,
    val notes: List<ConsignmentNoteSummary> = emptyList(),
    val notesTotal: Int = 0,
    val notesLoaded: Boolean = false,
    val selectedNoteId: Long? = null,
    val noteDetail: OperationsDetailState<ConsignmentNoteDetail> = OperationsDetailState.None,
    val quickNoteTarget: ConsignmentNoteSummary? = null,
    val quickProducts: OperationsDetailState<List<ConsignorProduct>> = OperationsDetailState.None,
    val pendingAction: PendingOperationsAction? = null,
    val busyKey: String? = null,
    val error: String? = null,
    val notice: String? = null,
)

object OperationsStateFilter {
    fun assets(state: OperationsUiState): List<AssetSummary> {
        val query = state.query.trim()
        return state.assets.asSequence()
            .filter { state.section != OperationsSection.Custody || it.custodianId != null }
            .filter { asset ->
                query.isEmpty() || listOfNotNull(
                    asset.code,
                    asset.name,
                    asset.branchName,
                    asset.location,
                    asset.custodianName,
                ).any { it.contains(query, ignoreCase = true) }
            }
            .toList()
    }

    fun notes(state: OperationsUiState): List<ConsignmentNoteSummary> {
        val query = state.query.trim()
        if (query.isEmpty()) return state.notes
        return state.notes.filter { note ->
            listOf(note.noteNumber, note.consignorName).any { it.contains(query, ignoreCase = true) }
        }
    }
}
