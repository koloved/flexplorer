import { Notice } from 'obsidian'
import type { FlexplorerPlugin } from '@/plugin'
import { initLog } from '@/utils'
import {
	emptyFolderState,
	getMetadataPath,
	getName,
	isFolderStateEmpty,
	serialiseFolderState,
	validateMetadataFilename,
	childPrefix,
} from './path-utils'
import type {
	FolderState,
	FlexplorerStorage,
	MigrationResult,
	ReverseMigrationResult,
	ValidationResult,
} from './types'

const CURRENT_VERSION = 1
const SAVE_DEBOUNCE_MS = 300

/**
 * PerFolderFileStorage – the new Git-friendly storage backend.
 *
 * Stores each folder's ordering, hidden, and pinned state in a dedicated
 * metadata file (`.flexplorer.json` by default) inside that folder.
 * Global settings remain in the plugin's `data.json`.
 *
 * Features:
 * - Lazy-loading with in-memory cache
 * - Per-folder debounced writes (independent timers)
 * - Self-written-path tracking to survive Obsidian's modify events
 * - External-change detection to avoid stale-write races
 * - Atomic read-then-write for conflict reduction
 */
export class PerFolderFileStorage implements FlexplorerStorage {
	private readonly log = initLog('PER-FOLDER-STORAGE', '#44ddbb')

	/** Folder path → cached FolderState (lazy-populated). */
	private readonly cache = new Map<string, FolderState>()

	/** Folder path → debounce timer. */
	private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

	/** Pending write promises, one per folder. */
	private readonly pendingWrites = new Map<string, Promise<void>>()

	/** Absolute paths (vault-relative) we wrote ourselves this session. */
	private readonly selfWrittenPaths = new Set<string>()

	/** The content we last wrote for a given metadata path — for external-change detection. */
	private readonly lastWrittenContent = new Map<string, string>()

	private _metadataFilename = '.flexplorer.json'

	constructor(private readonly plugin: FlexplorerPlugin) {}

	get metadataFilename(): string {
		return this._metadataFilename
	}

	set metadataFilename(name: string) {
		const err = validateMetadataFilename(name)
		if (err) throw new Error(err)
		if (this._metadataFilename !== name) {
			this.clearCache()
			this._metadataFilename = name
		}
	}

	// ── Global settings ──────────────────────────────────────────────

	async loadGlobalSettings(): Promise<Record<string, unknown>> {
		const s = this.plugin.settings
		return {
			storageMode: 'per-folder' as const,
			folderMetadataFilename: this._metadataFilename,
			showHidden: s.showHidden,
			newItemPlacement: s.newItemPlacement,
			persistOrderOnCreateDelete: s.persistOrderOnCreateDelete,
			debugMode: s.debugMode,
		}
	}

	async saveGlobalSettings(settings: Record<string, unknown>): Promise<void> {
		const s = this.plugin.settings
		if (typeof settings.showHidden === 'boolean') s.showHidden = settings.showHidden
		if (typeof settings.newItemPlacement === 'string') s.newItemPlacement = settings.newItemPlacement as never
		if (typeof settings.persistOrderOnCreateDelete === 'boolean') s.persistOrderOnCreateDelete = settings.persistOrderOnCreateDelete
		if (typeof settings.debugMode === 'boolean') s.debugMode = settings.debugMode
		if (typeof settings.folderMetadataFilename === 'string') {
			this.metadataFilename = settings.folderMetadataFilename
		}

		// Save only global settings to data.json, NOT items/pinnedFiles — those
		// belong in .flexplorer.json in per-folder mode.
		const globalData: Record<string, unknown> = {
			storageMode: 'per-folder',
			folderMetadataFilename: this._metadataFilename,
			showHidden: s.showHidden,
			newItemPlacement: s.newItemPlacement,
			persistOrderOnCreateDelete: s.persistOrderOnCreateDelete,
			debugMode: s.debugMode,
		}
		await this.plugin.saveData(globalData)
	}

	// ── Per-folder state ─────────────────────────────────────────────

	async loadFolderState(folderPath: string): Promise<FolderState | null> {
		// Normalize root path
		const normalPath = folderPath || '/'
		const cached = this.cache.get(normalPath)
		if (cached !== undefined) return cached

		const metaPath = getMetadataPath(normalPath, this._metadataFilename)
		const adapter = this.plugin.app.vault.adapter

		try {
			const exists = await adapter.exists(metaPath)
			if (!exists) {
				this.cache.set(normalPath, emptyFolderState())
				return emptyFolderState()
			}

			const raw = await adapter.read(metaPath)

			if (this.selfWrittenPaths.has(metaPath)) {
				this.selfWrittenPaths.delete(metaPath)
			}

			const parsed = this.parseFolderState(raw, metaPath)
			if (parsed === null) {
				this.cache.set(normalPath, emptyFolderState())
				return null
			}

			this.cache.set(normalPath, parsed)
			return parsed
		} catch (e) {
			this.log('Error reading metadata file:', metaPath, e)
			this.cache.set(normalPath, emptyFolderState())
			return null
		}
	}

	async saveFolderState(folderPath: string, state: FolderState): Promise<void> {
		this.cache.set(folderPath, { ...state })

		const existing = this.saveTimers.get(folderPath)
		if (existing) clearTimeout(existing)

		return new Promise<void>(resolve => {
			const timer = setTimeout(async () => {
				try {
					await this.writeFolderState(folderPath, state)
				} finally {
					this.saveTimers.delete(folderPath)
					this.pendingWrites.delete(folderPath)
					resolve()
				}
			}, SAVE_DEBOUNCE_MS)

			this.saveTimers.set(folderPath, timer)

			const prom = new Promise<void>(res => {
				const origTimer = timer
				const check = setInterval(() => {
					if (this.saveTimers.get(folderPath) !== origTimer) {
						clearInterval(check)
						const current = this.pendingWrites.get(folderPath)
						if (current) current.then(res).catch(res)
						else res()
					}
				}, 50)
			})
			this.pendingWrites.set(folderPath, prom)
		})
	}

	async deleteFolderState(folderPath: string): Promise<void> {
		this.cache.delete(folderPath)
		const timer = this.saveTimers.get(folderPath)
		if (timer) {
			clearTimeout(timer)
			this.saveTimers.delete(folderPath)
		}
		this.pendingWrites.delete(folderPath)

		const metaPath = getMetadataPath(folderPath, this._metadataFilename)
		const adapter = this.plugin.app.vault.adapter
		try {
			if (await adapter.exists(metaPath)) {
				selfWrittenAdd(this.selfWrittenPaths, metaPath)
				await adapter.remove(metaPath)
			}
		} catch (e) {
			this.log('Error deleting metadata file:', metaPath, e)
		}
	}

	async renameFolderState(oldFolderPath: string, newFolderPath: string): Promise<void> {
		const state = this.cache.get(oldFolderPath) ?? await this.loadFolderState(oldFolderPath)
		if (state) {
			this.cache.delete(oldFolderPath)
			this.cache.set(newFolderPath, state)
		}

		const oldMeta = getMetadataPath(oldFolderPath, this._metadataFilename)
		const newMeta = getMetadataPath(newFolderPath, this._metadataFilename)
		const adapter = this.plugin.app.vault.adapter

		try {
			if (await adapter.exists(oldMeta)) {
				selfWrittenAdd(this.selfWrittenPaths, oldMeta)
				selfWrittenAdd(this.selfWrittenPaths, newMeta)
				await adapter.rename(oldMeta, newMeta)
			}
		} catch (e) {
			this.log('Error renaming metadata file:', oldMeta, '→', newMeta, e)
		}
	}

	// ── Bulk / lifecycle ─────────────────────────────────────────────

	async enumerateFoldersWithState(): Promise<string[]> {
		const adapter = this.plugin.app.vault.adapter
		const folders: string[] = []

		try {
			await this.collectFoldersWithMetadata('', folders, adapter)
		} catch (e) {
			this.log('Error enumerating folders:', e)
		}

		return folders
	}

	async loadAllFolderStates(): Promise<Map<string, FolderState>> {
		const map = new Map<string, FolderState>()
		const folders = await this.enumerateFoldersWithState()
		for (const fp of folders) {
			const state = await this.loadFolderState(fp)
			if (state) map.set(fp, state)
		}
		return map
	}

	async flushPendingWrites(): Promise<void> {
		// Execute all pending writes immediately (bypass debounce)
		const pending = [...this.saveTimers.keys()]
		for (const folderPath of pending) {
			const timer = this.saveTimers.get(folderPath)
			if (timer) clearTimeout(timer)
			this.saveTimers.delete(folderPath)
		}
		this.pendingWrites.clear()

		// Flush cache entries that were touched but not yet written
		for (const [folderPath, state] of this.cache) {
			if (state && !isFolderStateEmpty(state)) {
				await this.writeFolderState(folderPath, state)
			}
		}
	}

	invalidateCache(folderPath: string): void {
		this.cache.delete(folderPath)
	}

	clearCache(): void {
		this.cache.clear()
	}

	markSelfWritten(metaPath: string): void {
		selfWrittenAdd(this.selfWrittenPaths, metaPath)
	}

	isMetadataFile(vaultPath: string): boolean {
		const filename = this._metadataFilename
		return vaultPath === filename
			|| vaultPath.endsWith(`/${filename}`)
			|| vaultPath === `/${filename}`
	}

	async handleExternalModify(metaPath: string): Promise<void> {
		const folderPath = this.metaPathToFolderPath(metaPath)
		if (folderPath === undefined) return

		if (this.selfWrittenPaths.has(metaPath)) {
			this.selfWrittenPaths.delete(metaPath)
			return
		}

		// If the user has pending (unsaved) changes for this folder, skip
		// re-reading so their in-progress drag-and-drop is not wiped out.
		// The next writeFolderState will merge external changes on save.
		if (this.saveTimers.has(folderPath)) {
			this.log('External change skipped — pending local changes for', folderPath)
			return
		}

		this.log('External change detected:', metaPath)
		this.cache.delete(folderPath)
		await this.loadFolderState(folderPath)

		this.plugin.sortExplorer()
		this.plugin.explorerManager.syncIndicators()
	}

	/** Return the folder path (Obsidian convention: '/' for root) that owns a metadata path. */
	private metaPathToFolderPath(metaPath: string): string | undefined {
		const filename = this._metadataFilename
		if (metaPath === filename) return '/'

		const suffix = `/${filename}`
		if (metaPath.endsWith(suffix)) {
			const folder = metaPath.slice(0, -suffix.length)
			return folder || '/'
		}
		return undefined
	}

	// ── Migration helpers ────────────────────────────────────────────

	async validateMetadataFiles(): Promise<ValidationResult> {
		const result: ValidationResult = {
			totalFiles: 0,
			validFiles: 0,
			invalidFiles: [],
			unknownVersionFiles: [],
			staleReferences: [],
		}

		const adapter = this.plugin.app.vault.adapter
		const folders = await this.enumerateFoldersWithState()

		for (const fp of folders) {
			result.totalFiles++
			const metaPath = getMetadataPath(fp, this._metadataFilename)
			try {
				const raw = await adapter.read(metaPath)
				const parsed = this.parseFolderState(raw, metaPath)
				if (parsed === null) {
					result.invalidFiles.push(metaPath)
					continue
				}
				if (parsed.version !== CURRENT_VERSION) {
					result.unknownVersionFiles.push(metaPath)
					continue
				}
				result.validFiles++

				const folder = this.plugin.app.vault.getFolderByPath(fp)
				if (!folder) {
					result.staleReferences.push(fp)
					continue
				}
				const existingNames = new Set(folder.children.map(c => c.name))
				for (const name of [...parsed.order, ...parsed.hidden, ...parsed.pinned]) {
					if (!existingNames.has(name)) {
						result.staleReferences.push(`${fp}/${name}`)
					}
				}
			} catch (e) {
				result.invalidFiles.push(metaPath)
			}
		}

		return result
	}

	/**
	 * Convenience: build up `items` and `pinnedFiles` from folder states.
	 * Used by the plugin after loading or migration.
	 */
	async rebuildFlatState(): Promise<{
		items: Record<string, unknown>
		pinnedFiles: string[]
	}> {
		const items: Record<string, unknown> = {}
		const pinnedFiles: string[] = []
		const allStates = await this.loadAllFolderStates()

		for (const [folderPath, state] of allStates) {
			const prefix = childPrefix(folderPath)

			// Don't overwrite isPinned/isHidden set by parent folder's state
			items[folderPath] = {
				...(items[folderPath] as Record<string, unknown> ?? {}),
				customOrder: state.order,
				sortOrder: state.sortMode ?? 'custom',
			}

			for (const name of state.hidden) {
				const path = prefix + name
				const existing = items[path] ?? {}
				items[path] = { ...(existing as Record<string, unknown>), isHidden: true }
			}

			for (const name of state.pinned) {
				const path = prefix + name
				const existing = items[path] ?? {}
				items[path] = { ...(existing as Record<string, unknown>), isPinned: true }
				if (!pinnedFiles.includes(path)) pinnedFiles.push(path)
			}
		}

		// Ensure every vault folder has at least a default entry,
		// so the patched getSortedFolderItems never gets undefined.
		this.ensureAllFoldersInItems(items)

		return { items, pinnedFiles }
	}

	/**
	 * Walk the vault tree and create default entries for any folder
	 * that doesn't have one yet.
	 */
	private ensureAllFoldersInItems(items: Record<string, unknown>): void {
		const walk = (folderPath: string): void => {
			if (!items[folderPath]) {
				items[folderPath] = {
					customOrder: [],
					sortOrder: 'custom',
				}
			}
			const folder = this.plugin.app.vault.getFolderByPath(folderPath === '/' ? '/' : folderPath)
			if (!folder) return
			for (const child of folder.children) {
				if ('children' in child) {
					walk(child.path)
				}
			}
		}
		walk('/')
	}

	// ── Private helpers ──────────────────────────────────────────────

	private async writeFolderState(folderPath: string, state: FolderState): Promise<void> {
		const metaPath = getMetadataPath(folderPath, this._metadataFilename)
		const adapter = this.plugin.app.vault.adapter

		// Variant B: delete the file when state is completely empty
		if (isFolderStateEmpty(state)) {
			try {
				if (await adapter.exists(metaPath)) {
					selfWrittenAdd(this.selfWrittenPaths, metaPath)
					await adapter.remove(metaPath)
				}
			} catch (e) {
				this.log('Error deleting empty metadata file:', metaPath, e)
			}
			this.lastWrittenContent.delete(metaPath)
			return
		}

		// External-change guard: re-read the file before writing
		try {
			if (await adapter.exists(metaPath)) {
				const currentRaw = await adapter.read(metaPath)
				const lastWritten = this.lastWrittenContent.get(metaPath)

				if (lastWritten !== undefined && currentRaw !== lastWritten) {
					const externalState = this.parseFolderState(currentRaw, metaPath)
					if (externalState !== null) {
						const merged: FolderState = {
							...state,
							hidden: [...new Set([...externalState.hidden, ...state.hidden])],
							pinned: [...new Set([...externalState.pinned, ...state.pinned])],
						}

						if (JSON.stringify(merged) !== JSON.stringify(state)) {
							new Notice(
								`Flexplorer detected external changes to ${metaPath} and merged them with your local changes.`,
								5000,
							)
							this.log('Merged external changes for', metaPath)
							state = merged
						}
					}
				}
			}
		} catch {
			// If re-reading fails, proceed with write anyway
		}

		const content = serialiseFolderState(state)

		selfWrittenAdd(this.selfWrittenPaths, metaPath)
		this.lastWrittenContent.set(metaPath, content)

		try {
			await adapter.write(metaPath, content)
		} catch (e) {
			this.log('Error writing metadata file:', metaPath, e)
			throw e
		}
	}

	private parseFolderState(raw: string, metaPath: string): FolderState | null {
		let parsed: Record<string, unknown>
		try {
			parsed = JSON.parse(raw)
		} catch {
			new Notice(
				`Flexplorer could not read ${metaPath}. The file contains invalid JSON. Default sorting is used for this folder.`,
				5000,
			)
			this.log('Invalid JSON in', metaPath)
			return null
		}

		if (typeof parsed !== 'object' || parsed === null) {
			new Notice(`Flexplorer: ${metaPath} is not a valid JSON object.`)
			return null
		}

		const version = typeof parsed.version === 'number' ? parsed.version : 1
		if (version !== CURRENT_VERSION) {
			new Notice(
				`Flexplorer: ${metaPath} has version ${version}, but only version ${CURRENT_VERSION} is supported. Default sorting used for this folder.`,
				5000,
			)
			this.log('Unknown version', version, 'in', metaPath)
			return null
		}

		const state: FolderState = {
			version,
			order: Array.isArray(parsed.order) ? parsed.order.filter((e): e is string => typeof e === 'string') : [],
			hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((e): e is string => typeof e === 'string') : [],
			pinned: Array.isArray(parsed.pinned) ? parsed.pinned.filter((e): e is string => typeof e === 'string') : [],
		}

		if (typeof parsed.sortMode === 'string') {
			state.sortMode = parsed.sortMode as never
		}

		const known = new Set(['version', 'order', 'hidden', 'pinned', 'sortMode'])
		for (const [key, value] of Object.entries(parsed)) {
			if (!known.has(key)) {
				state[key] = value
			}
		}

		return state
	}

	private async collectFoldersWithMetadata(
		prefix: string,
		acc: string[],
		adapter: { list: (path: string) => Promise<{ files: string[]; folders: string[] }>; exists: (path: string) => Promise<boolean> },
	): Promise<void> {
		const filename = this._metadataFilename

		try {
			const listing = await adapter.list(prefix)

			// Check the current folder's own metadata file (not just subfolders)
			// For root (prefix=''), this checks '.flexplorer.json'
			const ownMeta = prefix ? `${prefix}/${filename}` : filename
			try {
				if (await adapter.exists(ownMeta)) {
					acc.push(prefix || '/')
				}
			} catch {}

			for (const folderPath of listing.folders) {
				const metaPath = `${folderPath}/${filename}`
				try {
					if (await adapter.exists(metaPath)) {
						const normalised = folderPath.replace(/^\/+|\/+$/g, '')
						acc.push(normalised)
					}
				} catch {
					// Skip inaccessible folders
				}
				await this.collectFoldersWithMetadata(folderPath, acc, adapter)
			}
		} catch {
			// Prefix may not exist (empty root etc.)
		}
	}
}

/**
 * Thread-safe-ish helper: add a path to the self-written set,
 * then schedule its removal after a short delay to account for
 * Obsidian's event processing latency.
 */
function selfWrittenAdd(set: Set<string>, path: string): void {
	set.add(path)
	setTimeout(() => set.delete(path), 2000)
}
