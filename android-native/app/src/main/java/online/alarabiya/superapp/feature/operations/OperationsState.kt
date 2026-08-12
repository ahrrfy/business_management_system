package online.alarabiya.superapp.feature.operations

import online.alarabiya.superapp.model.operations.AssetDetail
import online.alarabiya.superapp.model.operations.AssetDisposalInput
import online.alarabiya.superapp.model.operations.AssetDocument
import online.alarabiya.superapp.model.operations.AssetFormOptions
import online.alarabiya.superapp.model.operations.AssetStatus
import online.alarabiya.superapp.model.operations.AssetSummary
import online.alarabiya.superapp.model.operations.AssetUpsertInput
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

    data class CreateAsset(
        val input: AssetUpsertInput,
        val requestToken: String,
    ) : PendingOperationsAction {
        override val key: String = "asset:create:$requestToken"
    }

    data class UpdateAsset(
        val asset: AssetSummary,
        val input: AssetUpsertInput,
    ) : PendingOperationsAction {
        override val key: String = "asset:update:${asset.id}"
    }

    data class HandoverAsset(
        val asset: AssetSummary,
        val employeeId: Long,
        val employeeName: String,
        val note: String?,
    ) : PendingOperationsAction {
        override val key: String = "asset:handover:${asset.id}"
    }

    data class ReleaseAssetCustody(val asset: AssetSummary) : PendingOperationsAction {
        override val key: String = "asset:custody-release:${asset.id}"
    }

    data class DisposeAsset(
        val asset: AssetSummary,
        val input: AssetDisposalInput,
    ) : PendingOperationsAction {
        override val key: String = "asset:dispose:${asset.id}"
    }

    data class AddAssetDocument(
        val asset: AssetSummary,
        val title: String,
        val dataUrl: String,
    ) : PendingOperationsAction {
        override val key: String = "asset:document:add:${asset.id}"
    }

    data class DeleteAssetDocument(
        val asset: AssetSummary,
        val document: AssetDocument,
    ) : PendingOperationsAction {
        override val key: String = "asset:document:delete:${document.id}"
    }

    data class PostDepreciation(
        val year: Int,
        val month: Int,
    ) : PendingOperationsAction {
        override val key: String = "asset:depreciation:$year-${month.toString().padStart(2, '0')}"
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

enum class AssetOverlay {
    Create,
    Edit,
    Handover,
    ReleaseCustody,
    Dispose,
    AddDocument,
    PostDepreciation,
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
    val assetsFresh: Boolean = false,
    val selectedAssetId: Long? = null,
    val assetDetail: OperationsDetailState<AssetDetail> = OperationsDetailState.None,
    val assetDetailFresh: Boolean = false,
    val assetOptions: OperationsDetailState<AssetFormOptions> = OperationsDetailState.None,
    val assetOptionsFresh: Boolean = false,
    val assetOverlay: AssetOverlay? = null,
    val outcomeUnknownAction: PendingOperationsAction? = null,
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
) {
    val assetMutationLocked: Boolean
        get() = busyKey != null || outcomeUnknownAction != null || !assetsFresh

    val selectedAssetFresh: Boolean
        get() = selectedAssetId != null && assetDetailFresh && assetDetail is OperationsDetailState.Content

    val outcomeReviewReady: Boolean
        get() {
            val action = outcomeUnknownAction ?: return false
            if (!assetsFresh) return false
            return when (action) {
                is PendingOperationsAction.CreateAsset -> true
                is PendingOperationsAction.DisposeAsset ->
                    assets.none { it.id == action.asset.id } ||
                        (selectedAssetId == action.asset.id && selectedAssetFresh)
                is PendingOperationsAction.UpdateAsset -> selectedAssetId == action.asset.id && selectedAssetFresh
                is PendingOperationsAction.HandoverAsset -> selectedAssetId == action.asset.id && selectedAssetFresh
                is PendingOperationsAction.ReleaseAssetCustody -> selectedAssetId == action.asset.id && selectedAssetFresh
                is PendingOperationsAction.AddAssetDocument -> selectedAssetId == action.asset.id && selectedAssetFresh
                is PendingOperationsAction.DeleteAssetDocument -> selectedAssetId == action.asset.id && selectedAssetFresh
                is PendingOperationsAction.ReturnAsset -> selectedAssetId == action.asset.id && selectedAssetFresh
                is PendingOperationsAction.StartMaintenance -> selectedAssetId == action.asset.id && selectedAssetFresh
                is PendingOperationsAction.PostDepreciation,
                is PendingOperationsAction.CreateConsignment,
                -> true
            }
        }
}

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
