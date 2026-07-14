import { Notice, Plugin, TFolder } from 'obsidian'
import type { FileExplorerView } from 'obsidian-typings'

import { DndEngine } from '@/core/dnd-engine'
import { ExplorerManager } from '@/core/explorer-manager'
import { OrderManager } from '@/core/order-manager'
import { Patcher } from '@/core/patcher'
import { SettingsTab } from '@/ui/settings'
import { populateSortMenu } from '@/ui/menu'
import { ConfirmModal } from '@/ui/modal'
import { initLog, logger } from '@/utils'
import type { FolderSettings, ItemSettings, Settings, StorageMode } from '@/types'

import {
	GlobalDataStorage,
	PerFolderFileStorage,
	getName,
	getParentPath,
	getMetadataPath,
	emptyFolderState,
	isFolderStateEmpty,
	childPrefix,
	isDirectChild,
} from '@/core/storage'
import type { FlexplorerStorage, FolderState, MigrationResult } from '@/core/storage'

const DEFAULT_SETTINGS: Settings = {
	storageMode: 'global',
	folderMetadataFilename: '.flexplorer.json',
	items: {},
	pinnedFiles: [],
	showHidden: false,
	newItemPlacement: 'top',
	persistOrderOnCreateDelete: true,
	debugMode: !!process.env.DEV,
	showCommandsInPalette: false,
}

export type FlexplorerPlugin = Flexplorer

export default class Flexplorer extends Plugin {
	private readonly log = initLog('', '#00ccff')

	declare settings: Settings
	readonly dndEngine = new DndEngine(this)
	readonly orderManager = new OrderManager(this)
	readonly explorerManager = new ExplorerManager(this)
	readonly patcher = new Patcher(this)

	/** Active storage backend, selected by storageMode. */
	private storage: FlexplorerStorage = new GlobalDataStorage(this as unknown as FlexplorerPlugin)
	private metadataFilename = '.flexplorer.json'

	// ── Lifecycle ────────────────────────────────────────────────────

	async onload() {
		await this.loadSettings()
		this.syncRuntimeSettings()
		this.log('Plugin loaded')
		this.app.workspace.onLayoutReady(() => this.init())
	}

	onunload() {
		this.explorerManager.disconnectObservers()
		this.dndEngine.detach()
		this.patcher.unpatch()
		this.sortExplorer()
		activeDocument.body.removeClass('fp-show-hidden')
		void this.flushStorage()
		this.log('Plugin unloaded')
	}

	// ── Settings ─────────────────────────────────────────────────────

	async saveSettings() {
		await this.storage.saveGlobalSettings({
			storageMode: this.settings.storageMode,
			folderMetadataFilename: this.settings.folderMetadataFilename,
			showHidden: this.settings.showHidden,
			newItemPlacement: this.settings.newItemPlacement,
			persistOrderOnCreateDelete: this.settings.persistOrderOnCreateDelete,
			debugMode: this.settings.debugMode,
		})

		// In per-folder mode, flush pending folder state writes too
		if (this.settings.storageMode === 'per-folder') {
			await this.storage.flushPendingWrites()
		}
	}

	async onExternalSettingsChange() {
		this.log('Settings changed externally')
		await this.loadSettings()
		this.syncRuntimeSettings()
		this.sortExplorer()
		this.explorerManager.syncIndicators()
	}

	// ── Storage helpers ──────────────────────────────────────────────

	/** Load (or reload) the state for a specific folder. */
	async loadFolderState(folderPath: string): Promise<FolderState | null> {
		return this.storage.loadFolderState(folderPath)
	}

	/** Persist the state for a specific folder. */
	async saveFolderState(folderPath: string, state: FolderState): Promise<void> {
		await this.storage.saveFolderState(folderPath, state)
	}

	/** Delete the persisted state for a folder (e.g. after folder deletion). */
	async deleteFolderState(folderPath: string): Promise<void> {
		await this.storage.deleteFolderState(folderPath)
	}

	/** Rename a folder's persisted state. */
	async renameFolderState(oldFolderPath: string, newFolderPath: string): Promise<void> {
		await this.storage.renameFolderState(oldFolderPath, newFolderPath)
	}

	/** Flush pending storage writes. */
	async flushStorage(): Promise<void> {
		await this.storage.flushPendingWrites()
	}

	/**
	 * Get the item settings for `path`, consulting both the runtime `items`
	 * record and the active storage backend.
	 *
	 * In per-folder mode, if the item is not in `items` yet, it falls back
	 * to loading the parent folder's state and deriving the item settings.
	 */
	async getItemSettings(itemPath: string): Promise<{ isPinned: boolean; isHidden: boolean }> {
		// Check runtime first
		const existing = this.settings.items[itemPath]
		if (existing) {
			return { isPinned: existing.isPinned, isHidden: existing.isHidden }
		}

		if (this.settings.storageMode === 'per-folder') {
			// Try to derive from parent folder's state
			const parentPath = getParentPath(itemPath)
			const name = getName(itemPath)
			const folderState = await this.storage.loadFolderState(parentPath)
			if (folderState) {
				return {
					isPinned: folderState.pinned.includes(name),
					isHidden: folderState.hidden.includes(name),
				}
			}
		}

		return { isPinned: false, isHidden: false }
	}

	// ── Plugin internals ─────────────────────────────────────────────

	getExplorerView() {
		return this.app.workspace.getLeavesOfType('file-explorer')[0].view as FileExplorerView
	}

	sortExplorer() {
		this.getExplorerView().sort()
	}

	private init() {
		this.addSettingTab(new SettingsTab(this.app, this))
		this.registerVaultEventHandlers()
		this.registerCommands()
		this.patcher.patchMenu()
		this.orderManager.syncItems()
		this.syncShowHiddenClass()

		this.explorerManager.observeExplorerMount(this.onExplorerMount, { checkExisting: true })
		this.explorerManager.observeExplorerMount(this.onExplorerRemount, { watch: true })

		this.log('Plugin initialized')
	}

	private readonly onExplorerMount = (el: HTMLElement) => {
		this.log('Explorer mounted, initializing features:', el)
		this.patcher.patchExplorer()
		this.sortExplorer()
		this.explorerManager.syncIndicators()
		this.dndEngine.attach(el)
	}

	private readonly onExplorerRemount = (el: HTMLElement) => {
		this.log('Explorer remounted, re-attaching DnD engine:', el)
		this.dndEngine.attach(el)
	}

	// ── Commands ─────────────────────────────────────────────────────

	private registerCommands() {
		// Always register basic commands that are useful day-to-day
		this.addCommand({
			id: 'flexplorer-reload-metadata',
			name: 'Reload folder metadata',
			callback: () => this.reloadFolderMetadata(),
		})

		// Migration/validation commands — only in palette when the setting is on
		// to avoid clutter for most users. They're still accessible from the
		// Storage section in settings.
		if (!this.settings.showCommandsInPalette) return

		this.addCommand({
			id: 'flexplorer-migrate-to-per-folder',
			name: 'Migrate data.json to per-folder storage',
			callback: () => this.runMigration(),
		})

		this.addCommand({
			id: 'flexplorer-preview-migration',
			name: 'Preview migration to per-folder storage',
			callback: () => this.runMigrationPreview(),
		})

		this.addCommand({
			id: 'flexplorer-migrate-from-per-folder',
			name: 'Migrate per-folder storage to data.json',
			callback: () => this.runReverseMigration(),
		})

		this.addCommand({
			id: 'flexplorer-validate-metadata',
			name: 'Validate per-folder metadata files',
			callback: () => this.runValidation(),
		})

		this.addCommand({
			id: 'flexplorer-remove-metadata',
			name: 'Remove per-folder metadata files',
			callback: () => this.runRemoveMetadata(),
		})
	}

	private async runMigration() {
		// Allow re-running migration when in per-folder mode but no root metadata exists
		const rootMetaExists = await this.app.vault.adapter.exists(
			getMetadataPath('/', this.settings.folderMetadataFilename),
		)

		if (this.settings.storageMode !== 'global' && rootMetaExists) {
			new Notice('Flexplorer: Already in per-folder mode with metadata files. Switch to "Single plugin data.json" first.')
			return
		}

		// If in per-folder mode but no metadata files exist, temporarily switch backend
		if (this.settings.storageMode === 'per-folder' && !rootMetaExists) {
			this.storage = new GlobalDataStorage(this as unknown as FlexplorerPlugin)
		}

		const globalStorage = this.storage
		if (!(globalStorage instanceof GlobalDataStorage)) {
			new Notice('Flexplorer: Unexpected storage backend. Cannot migrate.')
			return
		}

		new Notice('Flexplorer: Starting migration to per-folder storage...', 3000)

		try {
			const result = await globalStorage.migrateToPerFolder(
				this.settings.folderMetadataFilename,
				msg => this.log(msg),
			)

			if (result.conflicts.length > 0) {
				new Notice(
					`Flexplorer: Migration completed with ${result.conflicts.length} conflicts. See console for details.`,
					5000,
				)
			} else {
				new Notice(
					`Flexplorer: Migration complete. ${result.foldersCreated} folders processed, backup at ${result.backupPath}`,
					5000,
				)
			}

			// Switch to per-folder mode
			this.settings.storageMode = 'per-folder'
			await this.switchStorageBackend('per-folder')
			await this.saveSettings()
			this.sortExplorer()
			this.explorerManager.syncIndicators()
		} catch (e) {
			this.log('Migration failed:', e)
			new Notice('Flexplorer: Migration failed. See console for details.', 5000)
		}
	}

	private async runMigrationPreview() {
		const rootMetaExists = this.settings.storageMode === 'per-folder'
			? await this.app.vault.adapter.exists(getMetadataPath('/', this.settings.folderMetadataFilename))
			: false

		if (this.settings.storageMode !== 'global' && rootMetaExists) {
			new Notice('Flexplorer: Already in per-folder mode with metadata files.')
			return
		}

		// Use GlobalDataStorage for reading flat state
		const globalStorage = this.storage instanceof GlobalDataStorage
			? this.storage
			: new GlobalDataStorage(this as unknown as FlexplorerPlugin)

		try {
			const allStates = await globalStorage.loadAllFolderStates()
			const existingConflicts: string[] = []
			const adapter = this.app.vault.adapter

			for (const [folderPath] of allStates) {
				const metaPath = getMetadataPath(folderPath, this.settings.folderMetadataFilename)
				if (await adapter.exists(metaPath)) {
					existingConflicts.push(metaPath)
				}
			}

			const staleEntries: string[] = []
			for (const path of Object.keys(this.settings.items)) {
				if (!this.app.vault.getAbstractFileByPath(path)) {
					staleEntries.push(path)
				}
			}

			const topFolders = [...allStates.keys()].slice(0, 5)
			const summary = [
				`📋 Flexplorer Migration Preview`,
				``,
				`📁 Folders affected:     ${allStates.size}`,
				`📄 Metadata files:       ${allStates.size} ${existingConflicts.length > 0 ? `(${existingConflicts.length} existing — will be merged)` : '(all new)'}`,
				`🗑️ Stale entries:        ${staleEntries.length}`,
				`🔧 Global settings:      showHidden, newItemPlacement, persistOrderOnCreateDelete, debugMode`,
				``,
				existingConflicts.length > 0
					? `⚠️  ${existingConflicts.length} metadata file(s) already exist — they will be merged, not overwritten.`
					: '✅ No existing metadata files found — clean migration.',
				staleEntries.length > 0
					? `⚠️  ${staleEntries.length} item(s) in data.json reference non-existent files.`
					: '',
				``,
				topFolders.length > 0 ? 'Sample folders:' : '',
				...topFolders.map(fp => `  • ${fp}`),
				topFolders.length < allStates.size ? `  • … and ${allStates.size - topFolders.length} more` : '',
				``,
				'See console for full details.',
			].filter(Boolean).join('\n')

			new Notice(summary, 8000)
			this.log('Migration preview:', {
				foldersAffected: allStates.size,
				filesToCreate: allStates.size,
				existingConflicts: existingConflicts.length,
				staleEntries: staleEntries.length,
				conflictPaths: existingConflicts,
				stalePaths: staleEntries,
			})
		} catch (e) {
			this.log('Preview failed:', e)
			new Notice('Flexplorer: Preview failed. See console.', 4000)
		}
	}

	private async runReverseMigration() {
		if (this.settings.storageMode !== 'per-folder') {
			new Notice('Flexplorer: Not in per-folder mode. Switch to "Per-folder metadata files" first.')
			return
		}

		new Notice('Flexplorer: Starting reverse migration to data.json...', 3000)

		try {
			const allStates = await this.storage.loadAllFolderStates()
			const pinnedFiles: string[] = []
			const items: Record<string, ItemSettings> = {}

			for (const [folderPath, state] of allStates) {
				const prefix = childPrefix(folderPath)

				// Folder entry — preserve isPinned/isHidden from parent folder's state
				items[folderPath] = {
					...(items[folderPath] as Record<string, unknown> ?? {}),
					customOrder: state.order,
					sortOrder: state.sortMode ?? 'custom',
				} as ItemSettings

				for (const name of state.hidden) {
					const path = prefix + name
					const existing = items[path] ?? {}
					items[path] = { ...existing, isHidden: true } as ItemSettings
				}

				for (const name of state.pinned) {
					const path = prefix + name
					const existing = items[path] ?? {}
					items[path] = { ...existing, isPinned: true } as ItemSettings
					if (!pinnedFiles.includes(path)) pinnedFiles.push(path)
				}
			}

			// Create backup
			const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
			const backupPath = `${this.manifest.dir ?? '.obsidian/plugins/flexplorer'}/data.pre-global-migration-${ts}.json`

			const currentData = await this.loadData()
			await this.app.vault.adapter.write(backupPath, JSON.stringify(currentData, null, 2))

			// Write merged data.json
			this.settings.items = items
			this.settings.pinnedFiles = pinnedFiles
			this.settings.storageMode = 'global'
			await this.switchStorageBackend('global')
			await this.saveSettings()

			new Notice(
				`Flexplorer: Reverse migration complete. ${allStates.size} folders processed, backup at ${backupPath}. Metadata files were NOT deleted.`,
				6000,
			)

			this.sortExplorer()
			this.explorerManager.syncIndicators()
		} catch (e) {
			this.log('Reverse migration failed:', e)
			new Notice('Flexplorer: Reverse migration failed. See console.', 5000)
		}
	}

	private async runValidation() {
		if (this.settings.storageMode !== 'per-folder') {
			new Notice('Flexplorer: Validation is only available in per-folder mode.')
			return
		}

		if (!(this.storage instanceof PerFolderFileStorage)) {
			new Notice('Flexplorer: Unexpected storage backend.')
			return
		}

		try {
			const result = await this.storage.validateMetadataFiles()
			const msg = [
				`Flexplorer Validation Report`,
				`  Total metadata files: ${result.totalFiles}`,
				`  Valid: ${result.validFiles}`,
				`  Invalid (JSON errors): ${result.invalidFiles.length}`,
				`  Unknown version: ${result.unknownVersionFiles.length}`,
				`  Stale references: ${result.staleReferences.length}`,
				``,
				result.invalidFiles.length > 0
					? `  Invalid:\n    ${result.invalidFiles.join('\n    ')}`
					: '',
				result.unknownVersionFiles.length > 0
					? `  Unknown version:\n    ${result.unknownVersionFiles.join('\n    ')}`
					: '',
				result.staleReferences.length > 0
					? `  Stale:\n    ${result.staleReferences.join('\n    ')}`
					: '',
			].filter(Boolean).join('\n')

			new Notice(`Flexplorer: Validation complete. ${result.validFiles}/${result.totalFiles} valid.`, 4000)
			this.log(msg)
		} catch (e) {
			this.log('Validation failed:', e)
			new Notice('Flexplorer: Validation failed. See console.', 4000)
		}
	}

	private async reloadFolderMetadata() {
		if (this.settings.storageMode !== 'per-folder') {
			new Notice('Flexplorer: Reload is only available in per-folder mode.')
			return
		}

		if (this.storage instanceof PerFolderFileStorage) {
			this.storage.clearCache()
			this.log('Metadata cache cleared')

			// Rebuild runtime items from folder states
			const flat = await this.storage.rebuildFlatState()
			this.settings.items = flat.items as Record<string, FolderSettings>
			this.settings.pinnedFiles = flat.pinnedFiles

			this.sortExplorer()
			this.explorerManager.syncIndicators()
			new Notice('Flexplorer: Metadata reloaded.', 2000)
		}
	}

	private async runRemoveMetadata() {
		const storage = this.storage instanceof PerFolderFileStorage ? this.storage : null

		// Confirm with the user
		new ConfirmModal(this.app, 'Remove metadata files',
			`This will delete ALL .flexplorer.json files from every folder in the vault.\n\n` +
			`Custom ordering, hidden, and pinned data will be lost.\n\n` +
			`Storage mode will be switched to "Single plugin data.json". Continue?`,
			async isConfirmed => {
				if (!isConfirmed) return

				const progressNotice = new Notice('Flexplorer: Removing metadata files...', 0)

				try {
					const adapter = this.app.vault.adapter as { exists: (p: string) => Promise<boolean>; list: (p: string) => Promise<{ files: string[]; folders: string[] }>; read: (p: string) => Promise<string>; write: (p: string, d: string) => Promise<void>; remove: (p: string) => Promise<void> }
					const filename = this.settings.folderMetadataFilename
					const found: string[] = []

					// Scan vault for metadata files recursively
					const scan = async (prefix: string): Promise<void> => {
						const own = prefix ? `${prefix}/${filename}` : filename
						try {
							if (await adapter.exists(own)) found.push(own)
						} catch {}
						try {
							const listing = await adapter.list(prefix)
							for (const f of listing.folders) {
								await scan(f)
							}
						} catch {}
					}
					await scan('')

					// Delete all found metadata files
					let removed = 0
					for (const metaPath of found) {
						try {
							await adapter.remove(metaPath)
							removed++
						} catch (e) {
							this.log('Failed to remove', metaPath, e)
						}
					}

					storage?.clearCache()

					// Switch to global mode
					this.settings.storageMode = 'global'
					this.settings.items = {}
					this.settings.pinnedFiles = []
					await this.switchStorageBackend('global')
					await this.saveSettings()
					this.sortExplorer()
					this.explorerManager.syncIndicators()

					progressNotice.hide()
					new Notice(`Flexplorer: Removed ${removed} metadata file(s). Switched to Single plugin data.json.`, 5000)
				} catch (e) {
					progressNotice.hide()
					this.log('Remove metadata failed:', e)
					new Notice('Flexplorer: Failed to remove metadata files. See console.', 5000)
				}
			}).open()
	}

	// ── Vault events ─────────────────────────────────────────────────

	private registerVaultEventHandlers() {
		this.registerEvent(this.app.vault.on('create', item => {
			this.log(`Item created: ${item.path}`)
			this.orderManager.add(item)
		}))

		this.registerEvent(this.app.vault.on('rename', (item, oldPath) => {
			this.log(`Item renamed from ${oldPath} to ${item.path}`)
			this.orderManager.move(oldPath, item.path)
		}))

		this.registerEvent(this.app.vault.on('delete', item => {
			this.log(`Item deleted: ${item.path}`)
			this.orderManager.remove(item.path)
		}))

		this.registerEvent(this.app.vault.on('modify', item => {
			// Check if this is a metadata file change in per-folder mode
			if (this.settings.storageMode === 'per-folder' && this.storage instanceof PerFolderFileStorage) {
				if (this.storage.isMetadataFile(item.path)) {
					void this.storage.handleExternalModify(item.path)
					return
				}
			}

			// Default behaviour: refresh explorer for modified-time sorting
			const parentPath = item.parent?.path ?? ''
			const folderSettings = this.settings.items[parentPath] as FolderSettings
			if (folderSettings?.sortOrder?.startsWith('byModifiedTime')) {
				this.log(`File modified in '${item.path}' with modified-time-based sorting, sorting explorer`)
				this.sortExplorer()
			}
		}))

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				this.log(`File menu opened for '${file.path}'`)
				if (file.path === '/') return this.log('Root folder menu, skipping')

				const fileSettings = this.settings.items[file.path]

				if (file instanceof TFolder) {
					const folderSettings = fileSettings as FolderSettings
					const currentOrder = folderSettings?.sortOrder ?? 'custom'

					menu.addItem(item => {
						item.setTitle('Sort order').setIcon('sort-asc')
						const submenu = item.setSubmenu().setNoIcon()
						populateSortMenu(submenu, currentOrder, this, file.path, folderSettings ?? {
							customOrder: [],
							sortOrder: 'custom',
							isPinned: false,
							isHidden: false,
						})
					})
				}

				const effectiveSettings = fileSettings ?? { isPinned: false, isHidden: false }

				menu.addItem(item => item
					.setTitle(effectiveSettings.isPinned ? 'Unpin' : 'Pin')
					.setIcon(effectiveSettings.isPinned ? 'pin-off' : 'pin')
					.onClick(() => {
						const s = this.settings.items[file.path] ?? { isPinned: false, isHidden: false }
						s.isPinned = !s.isPinned
						this.settings.items[file.path] = s
						this.syncPinnedFileState(file.path, s.isPinned)
						void this.persistItemStateChange(file.path)
						void this.saveSettings()
						this.sortExplorer()
						this.explorerManager.syncIndicators()
					}))
					.addItem(item => item
						.setTitle(effectiveSettings.isHidden ? 'Unhide' : 'Hide')
						.setIcon(effectiveSettings.isHidden ? 'eye' : 'eye-off')
						.onClick(() => {
							const s = this.settings.items[file.path] ?? { isPinned: false, isHidden: false }
							s.isHidden = !s.isHidden
							this.settings.items[file.path] = s
							void this.persistItemStateChange(file.path)
							void this.saveSettings()
							this.explorerManager.syncIndicators()
						}))
			}),
		)
	}

	// ── Internal helpers ─────────────────────────────────────────────

	private async loadSettings() {
		const data = await this.loadData() as Partial<Settings> | undefined
		this.settings = { ...DEFAULT_SETTINGS, ...data }

		// Ensure items defaults
		this.settings.items ??= {}
		this.settings.pinnedFiles ??= []

		this.initStorageBackend()

		// In per-folder mode, rebuild runtime items from metadata files on disk.
		// This handles the case where settings were copied to a new vault
		// but .flexplorer.json files haven't been migrated yet.
		if (this.settings.storageMode === 'per-folder' && this.storage instanceof PerFolderFileStorage) {
			try {
				const flat = await this.storage.rebuildFlatState()
				this.settings.items = flat.items as Record<string, ItemSettings>
				this.settings.pinnedFiles = flat.pinnedFiles
			} catch (e) {
				this.log('Failed to rebuild flat state from metadata:', e)
			}
		}

		this.log('Settings loaded:', this.settings)
	}

	/**
	 * Select the correct storage backend based on current settings.
	 */
	private initStorageBackend(): void {
		if (this.settings.storageMode === 'per-folder') {
			const perFolder = new PerFolderFileStorage(this as unknown as FlexplorerPlugin)
			perFolder.metadataFilename = this.settings.folderMetadataFilename || '.flexplorer.json'
			this.storage = perFolder
			this.metadataFilename = this.settings.folderMetadataFilename
			this.log('Using PerFolderFileStorage backend')
		} else {
			this.storage = new GlobalDataStorage(this as unknown as FlexplorerPlugin)
			this.log('Using GlobalDataStorage backend')
		}
	}

	/**
	 * Switch storage backend at runtime (after migration).
	 */
	private async switchStorageBackend(mode: StorageMode): Promise<void> {
		this.settings.storageMode = mode
		this.initStorageBackend()

		if (mode === 'per-folder') {
			// Rebuild runtime state from folder files
			if (this.storage instanceof PerFolderFileStorage) {
				const flat = await this.storage.rebuildFlatState()
				this.settings.items = flat.items as Record<string, ItemSettings>
				this.settings.pinnedFiles = flat.pinnedFiles
			}
		}
	}

	private syncRuntimeSettings() {
		logger.level = this.settings.debugMode ? 'debug' : 'silent'
		this.syncShowHiddenClass()
	}

	private syncShowHiddenClass() {
		activeDocument.body.toggleClass('fp-show-hidden', this.settings.showHidden)
	}

	private syncPinnedFileState(filePath: string, isPinned: boolean) {
		if (isPinned) this.settings.pinnedFiles.push(filePath)
		else this.settings.pinnedFiles.remove(filePath)
	}

	/**
	 * In per-folder mode, persist the parent folder's state to .flexplorer.json
	 * after a pin/hide change on an item. Does nothing in global mode
	 * because saveSettings() there already writes everything to data.json.
	 */
	private async persistItemStateChange(itemPath: string): Promise<void> {
		if (this.settings.storageMode !== 'per-folder') return
		const parentPath = getParentPath(itemPath)
		const folderSettings = this.settings.items[parentPath] as FolderSettings | undefined
		if (!folderSettings) return

		const hidden: string[] = []
		const pinned: string[] = []
		for (const [path, item] of Object.entries(this.settings.items)) {
			if (isDirectChild(path, parentPath)) {
				if (item.isHidden) hidden.push(getName(path))
				if (item.isPinned) pinned.push(getName(path))
			}
		}

		await this.saveFolderState(parentPath, {
			version: 1,
			order: folderSettings.customOrder,
			hidden,
			pinned,
			sortMode: folderSettings.sortOrder,
		})
	}
}
