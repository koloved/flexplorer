import { Notice } from 'obsidian'
import type { FlexplorerPlugin } from '@/plugin'
import { initLog } from '@/utils'
import { emptyFolderState, serialiseFolderState, getMetadataPath, getName, childPrefix, isDirectChild } from './path-utils'
import type { FolderState, FlexplorerStorage, MigrationResult, ReverseMigrationResult, ValidationResult } from './types'
import type { ItemSettings } from '@/types'

/**
 * GlobalDataStorage – the original storage backend.
 *
 * Keeps **everything** inside a single `data.json` (via Obsidian's
 * `loadData`/`saveData`). This is the default mode and is 100 %
 * backward-compatible with the pre-refactor Flexplorer.
 *
 * To satisfy the {@link FlexplorerStorage} contract it translates
 * between the flat `items` record and per-folder {@link FolderState}.
 */
export class GlobalDataStorage implements FlexplorerStorage {
	private readonly log = initLog('GLOBAL-STORAGE', '#88ccff')

	constructor(private readonly plugin: FlexplorerPlugin) {}

	// ── Global settings ──────────────────────────────────────────────

	async loadGlobalSettings(): Promise<Record<string, unknown>> {
		const s = this.plugin.settings
		return {
			storageMode: 'global' as const,
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
		await this.plugin.saveData(this.plugin.settings)
	}

	// ── Per-folder state ─────────────────────────────────────────────

	async loadFolderState(folderPath: string): Promise<FolderState | null> {
		const folderSettings = this.plugin.settings.items[folderPath] as { customOrder?: string[]; sortOrder?: string } | undefined
		if (!folderSettings) return emptyFolderState()

		const order = folderSettings.customOrder ?? []
		const hidden = this.findHiddenInFolder(folderPath)
		const pinned = this.findPinnedInFolder(folderPath)

		return {
			version: 1,
			order,
			hidden,
			pinned,
			sortMode: folderSettings.sortOrder as never,
		}
	}

	async saveFolderState(folderPath: string, state: FolderState): Promise<void> {
		const items = this.plugin.settings.items
		const existing = items[folderPath]

		items[folderPath] = {
			...(existing as Record<string, unknown> ?? {}),
			customOrder: state.order,
			sortOrder: state.sortMode ?? 'custom',
		} as ItemSettings

		// Update individual item entries
		const prefix = childPrefix(folderPath)
		for (const name of state.hidden) {
			const itemPath = prefix + name
			const item = items[itemPath]
			if (item) (item as Record<string, unknown>).isHidden = true
		}
		for (const name of state.pinned) {
			const itemPath = prefix + name
			const item = items[itemPath]
			if (item) (item as Record<string, unknown>).isPinned = true
		}

		await this.plugin.saveData(this.plugin.settings)
	}

	async deleteFolderState(folderPath: string): Promise<void> {
		const items = this.plugin.settings.items
		delete items[folderPath]

		// Delete all direct children' item settings
		for (const key of Object.keys(items)) {
			if (isDirectChild(key, folderPath)) {
				delete items[key]
			}
		}

		await this.plugin.saveData(this.plugin.settings)
	}

	async renameFolderState(oldFolderPath: string, newFolderPath: string): Promise<void> {
		const state = await this.loadFolderState(oldFolderPath)
		if (!state) return
		await this.deleteFolderState(oldFolderPath)
		await this.saveFolderState(newFolderPath, state)
	}

	// ── Bulk / lifecycle ─────────────────────────────────────────────

	async enumerateFoldersWithState(): Promise<string[]> {
		const items = this.plugin.settings.items
		return Object.keys(items).filter(k => {
			const v = items[k]
			return typeof (v as Record<string, unknown>).customOrder === 'object' || typeof (v as Record<string, unknown>).sortOrder === 'string'
		})
	}

	async loadAllFolderStates(): Promise<Map<string, FolderState>> {
		const map = new Map<string, FolderState>()
		const folderPaths = await this.enumerateFoldersWithState()
		for (const fp of folderPaths) {
			const state = await this.loadFolderState(fp)
			if (state) map.set(fp, state)
		}
		return map
	}

	async flushPendingWrites(): Promise<void> {
		// GlobalDataStorage writes synchronously through saveSettings → saveData.
		// Nothing to flush.
	}

	// ── Migration helpers ────────────────────────────────────────────

	async migrateToPerFolder(
		filename: string,
		onProgress?: (msg: string) => void,
	): Promise<MigrationResult> {
		const result: MigrationResult = {
			foldersCreated: 0,
			filesCreated: 0,
			conflicts: [],
			staleEntries: [],
			backupPath: '',
		}

		const adapter = this.plugin.app.vault.adapter
		const allStates = await this.loadAllFolderStates()

		// Create backup
		const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
		const backupPath = `${this.plugin.manifest.dir ?? '.obsidian/plugins/flexplorer'}/data.pre-per-folder-migration-${ts}.json`
		result.backupPath = backupPath

		await adapter.write(backupPath, JSON.stringify(this.plugin.settings, null, 2))
		onProgress?.(`Backup created at ${backupPath}`)

		for (const [folderPath, state] of allStates) {
			const metaPath = getMetadataPath(folderPath, filename)
			onProgress?.(`Processing ${metaPath}`)

			const exists = await adapter.exists(metaPath)
			if (exists) {
				result.conflicts.push(metaPath)
				// Read existing and merge
				try {
					const existingRaw = await adapter.read(metaPath)
					const existing = JSON.parse(existingRaw) as FolderState
					state.order = [...new Set([...existing.order, ...state.order])]
					state.hidden = [...new Set([...existing.hidden, ...state.hidden])]
					state.pinned = [...new Set([...existing.pinned, ...state.pinned])]
				} catch {
					// Leave our version as-is
				}
				onProgress?.(`  Merged with existing ${metaPath}`)
			}

			try {
				await adapter.write(metaPath, serialiseFolderState(state))
				result.foldersCreated++
				result.filesCreated++
			} catch (e) {
				this.log('Failed to write', metaPath, e)
				result.conflicts.push(`${metaPath} (write failed)`)
			}
		}

		// Detect stale entries (items pointing to non-existent files)
		for (const path of Object.keys(this.plugin.settings.items)) {
			if (!this.plugin.app.vault.getAbstractFileByPath(path)) {
				result.staleEntries.push(path)
			}
		}

		onProgress?.(`Migration complete: ${result.foldersCreated} folders, ${result.filesCreated} files, ${result.conflicts.length} conflicts`)
		return result
	}

	async validateMetadataFiles(filename: string): Promise<ValidationResult> {
		const result: ValidationResult = {
			totalFiles: 0,
			validFiles: 0,
			invalidFiles: [],
			unknownVersionFiles: [],
			staleReferences: [],
		}

		const adapter = this.plugin.app.vault.adapter
		const folderPaths = await this.enumerateFoldersWithState()

		for (const fp of folderPaths) {
			result.totalFiles++
			const state = await this.loadFolderState(fp)
			if (!state) {
				result.invalidFiles.push(fp)
				continue
			}
			if (state.version !== 1) {
				result.unknownVersionFiles.push(fp)
				continue
			}
			result.validFiles++

			// Check stale references
			const folder = this.plugin.app.vault.getFolderByPath(fp)
			if (!folder) {
				result.staleReferences.push(fp)
				continue
			}
			const existingNames = new Set(folder.children.map(c => c.name))
			for (const name of [...state.order, ...state.hidden, ...state.pinned]) {
				if (!existingNames.has(name)) {
					result.staleReferences.push(`${fp}/${name}`)
				}
			}
		}

		return result
	}

	// ── Internal helpers ─────────────────────────────────────────────

	private findHiddenInFolder(folderPath: string): string[] {
		const items = this.plugin.settings.items
		const hidden: string[] = []
		for (const [path, item] of Object.entries(items)) {
			if (isDirectChild(path, folderPath) && (item as Record<string, unknown>).isHidden) {
				hidden.push(getName(path))
			}
		}
		return hidden
	}

	private findPinnedInFolder(folderPath: string): string[] {
		const items = this.plugin.settings.items
		const pinned: string[] = []
		for (const [path, item] of Object.entries(items)) {
			if (isDirectChild(path, folderPath) && (item as Record<string, unknown>).isPinned) {
				pinned.push(getName(path))
			}
		}
		return pinned
	}
}
