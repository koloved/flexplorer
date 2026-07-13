export type NewItemPlacement = 'top' | 'bottom'

export type SortOrder =
	| 'custom'
	| 'byName'
	| 'byNameReverse'
	| 'byCreatedTime'
	| 'byCreatedTimeReverse'
	| 'byModifiedTime'
	| 'byModifiedTimeReverse'

/** Storage modes for Flexplorer's ordering/visibility state. */
export type StorageMode = 'global' | 'per-folder'

export interface Settings {
	/** Storage mode: 'global' (single data.json) or 'per-folder' (.flexplorer.json per folder). */
	storageMode: StorageMode
	/** Filename for per-folder metadata files. Only relevant when storageMode === 'per-folder'. */
	folderMetadataFilename: string
	/** Per-item settings, keyed by absolute path. */
	items: Record<string, ItemSettings>
	/** Flat list of pinned file absolute paths (legacy). */
	pinnedFiles: string[]
	showHidden: boolean
	newItemPlacement: NewItemPlacement
	persistOrderOnCreateDelete: boolean
	debugMode: boolean
}

export interface BaseItemSettings {
	isPinned: boolean
	isHidden: boolean
	[key: string]: unknown
}

export interface FolderSettings extends BaseItemSettings {
	customOrder: string[]
	sortOrder: SortOrder
}

export type ItemSettings = BaseItemSettings | FolderSettings
