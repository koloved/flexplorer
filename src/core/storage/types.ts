import type { SortOrder } from '@/types'

/**
 * Versioned state for a single folder, stored in `.flexplorer.json`.
 */
export interface FolderState {
	version: number
	/** Relative names of immediate children in manual order. */
	order: string[]
	/** Relative names of hidden immediate children. */
	hidden: string[]
	/** Relative names of pinned immediate children. */
	pinned: string[]
	/**
	 * Per-folder sort mode. `undefined` (or absent) means "inherit global
	 * default" which is `'custom'` in the current Flexplorer model.
	 */
	sortMode?: SortOrder
	/**
	 * Extension slot – parsers MUST ignore unknown fields within the same
	 * major version so future fields (e.g. `groups`) do not break older
	 * plugin versions.
	 */
	[unknownField: string]: unknown
}

/**
 * Storage backend contract.
 *
 * Every backend MUST:
 * - be stateless from the caller's perspective (own caching internally);
 * - return a full {@link FolderState} for every folder that exists on disk,
 *   even when no metadata file has been created yet (empty defaults);
 * - tolerate concurrent calls on different folder paths.
 */
export interface FlexplorerStorage {
	// ── Global settings ──────────────────────────────────────────────

	/** Load the global (non-folder-specific) settings map. */
	loadGlobalSettings(): Promise<Record<string, unknown>>

	/** Persist the global settings map. */
	saveGlobalSettings(settings: Record<string, unknown>): Promise<void>

	// ── Per-folder state ─────────────────────────────────────────────

	/**
	 * Return the state for `folderPath`.
	 *
	 * Returns a default empty state when no metadata file exists yet.
	 * Returns `null` when the file is corrupt or has an unknown version
	 * (caller decides fallback behaviour).
	 */
	loadFolderState(folderPath: string): Promise<FolderState | null>

	/** Persist `state` for `folderPath`. Creates parent directories if needed. */
	saveFolderState(folderPath: string, state: FolderState): Promise<void>

	/** Delete the metadata file for a folder. No-op if absent. */
	deleteFolderState(folderPath: string): Promise<void>

	/**
	 * Rename a folder's stored state (e.g. after the folder itself was
	 * moved/renamed). Default implementation calls
	 * {@link loadFolderState old} → {@link saveFolderState new} → {@link deleteFolderState old}.
	 * Override for atomic renames when the backend supports it.
	 */
	renameFolderState(oldFolderPath: string, newFolderPath: string): Promise<void>

	// ── Bulk / lifecycle ─────────────────────────────────────────────

	/**
	 * Scan the vault and return every folder that has a metadata file.
	 * Used during migration and validation.
	 * `undefined` means the backend cannot enumerate (always returns
	 * everything in {@link loadGlobalSettings}).
	 */
	enumerateFoldersWithState?(): Promise<string[]>

	/**
	 * Load every folder state that exists on disk.
	 * Used during migration and reverse-migration.
	 */
	loadAllFolderStates(): Promise<Map<string, FolderState>>

	/** Flush any pending/throttled writes and settle the underlying I/O. */
	flushPendingWrites(): Promise<void>
}

/** Internal state that bridges between the flat `items` record and per-folder files. */
export interface FolderStateData {
	folderPath: string
	state: FolderState
}

/** Result of the forward migration (data.json → per-folder). */
export interface MigrationResult {
	foldersCreated: number
	filesCreated: number
	conflicts: string[]
	staleEntries: string[]
	backupPath: string
}

/** Result of the reverse migration (per-folder → data.json). */
export interface ReverseMigrationResult {
	foldersProcessed: number
	totalItems: number
	backupPath: string
}

/** Result of a validation run. */
export interface ValidationResult {
	totalFiles: number
	validFiles: number
	invalidFiles: string[]
	unknownVersionFiles: string[]
	staleReferences: string[]
}

/** Options passed to dry-run preview. */
export interface MigrationPreview {
	foldersAffected: number
	filesToCreate: number
	existingFiles: string[]
	staleEntries: string[]
	globalKeysPreserved: string[]
}

/** Debounced save entry for a single folder. */
export interface PendingSave {
	promise: Promise<void>
	resolve: () => void
	timer: ReturnType<typeof setTimeout> | undefined
}
