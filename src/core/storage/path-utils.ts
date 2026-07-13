import type { FolderState } from './types'

/** The metadata filename used in per-folder storage mode. */
export const DEFAULT_METADATA_FILENAME = '.flexplorer.json'

/**
 * Build the metadata file path for a given folder.
 *
 * Handles the vault root specially: when `folderPath` is empty or `'/'`,
 * the metadata file sits at the vault root, not at `/.flexplorer.json`.
 *
 * Examples:
 * ```
 * getMetadataPath('')            → '.flexplorer.json'
 * getMetadataPath('/')           → '.flexplorer.json'
 * getMetadataPath('Documentation') → 'Documentation/.flexplorer.json'
 * getMetadataPath('A/B/C')       → 'A/B/C/.flexplorer.json'
 * ```
 */
export function getMetadataPath(folderPath: string, filename = DEFAULT_METADATA_FILENAME): string {
	const normalised = folderPath === '/' ? '' : folderPath.replace(/^\/+|\/+$/g, '')
	return normalised ? `${normalised}/${filename}` : filename
}

/**
 * Extract the parent folder path from an absolute item path.
 * Returns `'/'` for top-level items to match Obsidian's root convention.
 *
 * Examples:
 * ```
 * getParentPath('Documentation/Introduction.md') → 'Documentation'
 * getParentPath('Introduction.md')              → '/'
 * getParentPath('/')                             → '/'
 * ```
 */
export function getParentPath(itemPath: string): string {
	if (itemPath === '/') return '/'
	const idx = itemPath.lastIndexOf('/')
	return idx === -1 ? '/' : itemPath.slice(0, idx)
}

/**
 * Extract the leaf name (file or folder) from an absolute path.
 *
 * Examples:
 * ```
 * getName('Documentation/Introduction.md') → 'Introduction.md'
 * getName('Introduction.md')              → 'Introduction.md'
 * getName('/')                             → ''
 * ```
 */
export function getName(itemPath: string): string {
	const idx = itemPath.lastIndexOf('/')
	return idx === -1 ? itemPath : itemPath.slice(idx + 1)
}

/**
 * Validate a metadata filename candidate.
 * Returns an error message string, or `null` when valid.
 */
export function validateMetadataFilename(name: string): string | null {
	const trimmed = name.trim()

	if (!trimmed) return 'Filename must not be empty'
	if (trimmed.includes('/') || trimmed.includes('\\')) return 'Filename must not contain / or \\'
	if (trimmed === '.' || trimmed === '..') return 'Filename must not be "." or ".."'
	if (trimmed.length > 255) return 'Filename is too long (max 255 characters)'

	return null
}

/**
 * Serialise a FolderState for writing.
 * Always produces stable, deterministic JSON:
 * - keys in a fixed order (version, order, hidden, pinned, ...)
 * - formatted with 2-space indent
 * - trailing newline
 */
export function serialiseFolderState(state: FolderState): string {
	const ordered: Record<string, unknown> = {
		version: state.version,
		order: state.order,
		hidden: state.hidden,
		pinned: state.pinned,
	}

	if (state.sortMode && state.sortMode !== 'custom') {
		ordered.sortMode = state.sortMode
	}

	// Include any unrecognised extension fields (sorted for stability)
	const known = new Set(['version', 'order', 'hidden', 'pinned', 'sortMode'])
	const extra = Object.keys(state)
		.filter(k => !known.has(k))
		.sort()

	for (const key of extra) {
		ordered[key] = state[key]
	}

	return JSON.stringify(ordered, null, 2) + '\n'
}

/** Create an empty (default) folder state. */
export function emptyFolderState(): FolderState {
	return {
		version: 1,
		order: [],
		hidden: [],
		pinned: [],
	}
}

/** Check whether a folder state is effectively empty (all arrays empty, no extra fields). */
export function isFolderStateEmpty(state: FolderState): boolean {
	return state.version === 1
		&& state.order.length === 0
		&& state.hidden.length === 0
		&& state.pinned.length === 0
		&& (!state.sortMode || state.sortMode === 'custom')
		&& Object.keys(state).filter(k => !['version', 'order', 'hidden', 'pinned', 'sortMode'].includes(k)).length === 0
}

/**
 * Remove references to items not present in `existingNames`.
 * Returns a new state without mutating the original.
 */
export function pruneStaleReferences(state: FolderState, existingNames: Set<string>): FolderState {
	return {
		...state,
		order: state.order.filter(n => existingNames.has(n)),
		hidden: state.hidden.filter(n => existingNames.has(n)),
		pinned: state.pinned.filter(n => existingNames.has(n)),
	}
}

/**
 * Build the item-path prefix for children of a given folder.
 *
 * When `folderPath` is the root (`'/'`), children are at the vault root
 * so the prefix is empty.  Otherwise it is `folderPath + '/'`.
 *
 * Examples:
 * ```
 * childPrefix('/')              → ''
 * childPrefix('Documentation')   → 'Documentation/'
 * childPrefix('A/B/C')          → 'A/B/C/'
 * ```
 */
export function childPrefix(folderPath: string): string {
	return folderPath === '/' ? '' : `${folderPath}/`
}

/**
 * Check whether `childPath` is a direct child of the folder at `folderPath`.
 *
 * Examples:
 * ```
 * isDirectChild('Readme.md', '/')              → true
 * isDirectChild('/')                            → fallsú
 * isDirectChild('Doc/Readme.md', 'Doc')         → true
 * isDirectChild('Doc/Sub/Readme.md', 'Doc')     → false
 * ```
 */
export function isDirectChild(childPath: string, folderPath: string): boolean {
	if (childPath === folderPath) return false
	return getParentPath(childPath) === folderPath
}
