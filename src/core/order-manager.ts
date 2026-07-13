import { TAbstractFile, TFile, TFolder } from 'obsidian'
import type { FileTreeItem } from 'obsidian-typings'

import { initLog } from '@/utils'
import type Flexplorer from '@/plugin'
import type { BaseItemSettings, FolderSettings, SortOrder } from '@/types'
import { getParentPath, getName, emptyFolderState, isFolderStateEmpty, childPrefix, isDirectChild } from '@/core/storage'
import type { FolderState } from '@/core/storage'

const DEFAULT_ITEM_SETTINGS: BaseItemSettings = { isPinned: false, isHidden: false }
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export class OrderManager {
	private readonly log = initLog('ORDER-MANAGER', '#ff5000')

	constructor(private readonly plugin: Flexplorer) {}

	syncItems(root = this.plugin.app.vault.root) {
		this.log(`Syncing items with vault in root '${root.path}'`)
		this.cleanUpInvalidPaths()

		if (this.plugin.settings.storageMode === 'per-folder') {
			this.syncPerFolder(root)
		} else {
			this.sync(root)
		}

		this.persistAndLog('Items synced:')
	}

	add(item: TAbstractFile) {
		const insertPos = this.plugin.settings.newItemPlacement
		this.log(`Adding new item '${item.path}' at '${insertPos}'`)

		const items = this.plugin.settings.items
		const isFolder = item instanceof TFolder
		const parentPath = item.parent!.path
		const parentItem = items[parentPath] as FolderSettings

		items[item.path] = {
			...DEFAULT_ITEM_SETTINGS,
			...(isFolder ? { customOrder: [], sortOrder: 'custom' } : {}),
		}

		if (insertPos === 'top') parentItem.customOrder.unshift(item.name)
		else parentItem.customOrder.push(item.name)

		this.persistCreateDeleteChange('Order updated after item creation:', parentPath)
	}

	move(from: string, to: string, siblingPath?: string, pos?: 'before' | 'after') {
		this.log(`Moving '${from}' to '${to}' ${pos} '${siblingPath}'`)
		if (from === to && siblingPath === to) return this.log('No move needed')

		const items = this.plugin.settings.items
		const fromName = getName(from)
		const toName = getName(to)
		const fromParentPath = getParentPath(from)
		const toParentPath = getParentPath(to)
		const fromParent = items[fromParentPath] as FolderSettings | undefined
		const toParent = items[toParentPath] as FolderSettings | undefined
		const parentChanged = fromParentPath !== toParentPath

		if (!(from in items)) return this.log('Source item not found in settings')
		if (from !== to) {
			items[to] = items[from]
			delete items[from]
			this.plugin.settings.pinnedFiles = this.plugin.settings.pinnedFiles.map(p => p === from ? to : p)
		}

		if (fromParent && toParent) {
			const fromIndex = fromParent.customOrder.indexOf(fromName)

			let insertIndex = 0
			if (siblingPath) {
				const siblingIndex = toParent.customOrder.indexOf(getName(siblingPath))
				insertIndex = pos === 'before' ? siblingIndex : siblingIndex + 1
			} else if (!parentChanged) {
				insertIndex = fromIndex
			}
			fromParent.customOrder = fromParent.customOrder.filter(p => {
				if (p === fromName) {
					if (!parentChanged && fromIndex < insertIndex) insertIndex--
					return false
				}
				return true
			})
			if (!toParent.customOrder.includes(toName)) toParent.customOrder.splice(insertIndex, 0, toName)
		}

		this.persistAndLog('Order updated:', [fromParentPath, toParentPath])

		if (!parentChanged) {
			this.log('Directory did not change, sorting explorer')
			this.plugin.sortExplorer()
		}
	}

	remove(path: string) {
		this.log(`Removing '${path}'`)

		const items = this.plugin.settings.items
		const name = getName(path)
		const parentPath = getParentPath(path)
		const parentItem = items[parentPath] as FolderSettings

		delete items[path]

		parentItem.customOrder = parentItem.customOrder.filter(p => p !== name)

		this.persistCreateDeleteChange('Order updated after item deletion:', parentPath)

		// If the deleted item was a folder with its own metadata, clean it up
		if (this.plugin.settings.storageMode === 'per-folder') {
			void this.plugin.deleteFolderState(path)
		}
	}

	getSortedItems(
		folderSettings: FolderSettings,
		items: FileTreeItem[],
		sortOrder: SortOrder = folderSettings.sortOrder,
	): FileTreeItem[] {
		return items.slice().sort((aItem, bItem) => {
			const [a, b] = [aItem.file, bItem.file]
			const isAPinned = this.plugin.settings.items[a.path]?.isPinned ?? false
			const isBPinned = this.plugin.settings.items[b.path]?.isPinned ?? false
			if (isAPinned !== isBPinned) return isAPinned ? -1 : 1

			if (sortOrder !== 'custom') {
				const isAFolder = a instanceof TFolder
				const isBFolder = b instanceof TFolder
				if (isAFolder !== isBFolder) return isAFolder ? -1 : 1
			}

			switch (sortOrder) {
				case 'custom': {
					const aIndex = folderSettings.customOrder.indexOf(a.name)
					const bIndex = folderSettings.customOrder.indexOf(b.name)
					if (aIndex === -1 || bIndex === -1) return this.compareByName(a, b)
					return aIndex - bIndex
				}
				case 'byNameReverse': return this.compareByName(b, a)
				case 'byCreatedTime': return this.compareByTimestamp(a, b, 'ctime', 'asc')
				case 'byCreatedTimeReverse': return this.compareByTimestamp(a, b, 'ctime', 'desc')
				case 'byModifiedTime': return this.compareByTimestamp(a, b, 'mtime', 'asc')
				case 'byModifiedTimeReverse': return this.compareByTimestamp(a, b, 'mtime', 'desc')
				case 'byName':
				default: return this.compareByName(a, b)
			}
		})
	}

	// ── Per-folder mode helpers ──────────────────────────────────────

	/**
	 * In per-folder mode, update `settings.items` after a folder state
	 * has been modified so that the runtime representation stays in sync.
	 */
	applyFolderStateToRuntime(folderPath: string, state: FolderState): void {
		const items = this.plugin.settings.items
		const prefix = childPrefix(folderPath)

		// Folder entry — preserve isPinned/isHidden set by parent folder
		const existing = items[folderPath] as Record<string, unknown> | undefined
		items[folderPath] = {
			...(existing ?? {}),
			customOrder: state.order,
			sortOrder: state.sortMode ?? 'custom',
		} as FolderSettings

		// Remove old child entries that are no longer referenced
		const referencedNames = new Set([...state.order, ...state.hidden, ...state.pinned])
		for (const key of Object.keys(items)) {
			if (isDirectChild(key, folderPath)) {
				const name = getName(key)
				if (!referencedNames.has(name)) {
					delete items[key]
				}
			}
		}

		// Add hidden/pinned entries
		for (const name of state.hidden) {
			const path = prefix + name
			const existing = (items[path] as Record<string, unknown>) ?? {}
			items[path] = { ...DEFAULT_ITEM_SETTINGS, ...existing, isHidden: true } as BaseItemSettings
		}

		for (const name of state.pinned) {
			const path = prefix + name
			const existing = (items[path] as Record<string, unknown>) ?? {}
			items[path] = { ...DEFAULT_ITEM_SETTINGS, ...existing, isPinned: true } as BaseItemSettings
			if (!this.plugin.settings.pinnedFiles.includes(path)) {
				this.plugin.settings.pinnedFiles.push(path)
			}
		}
	}

	// ── Private ──────────────────────────────────────────────────────

	private sync(folder: TFolder) {
		const folderPath = folder.path
		const oldSettings = this.plugin.settings.items[folderPath] as FolderSettings | undefined
		const newChildren = folder.children.map(c => c.name)

		const oldChildren = oldSettings?.customOrder ?? []
		let mergedChildren = oldChildren.filter(p => newChildren.includes(p))
		const addedChildren = newChildren.filter(p => !oldChildren.includes(p))
		mergedChildren = this.plugin.settings.newItemPlacement === 'top'
			? [...addedChildren, ...mergedChildren]
			: [...mergedChildren, ...addedChildren]

		this.plugin.settings.items[folderPath] = {
			...DEFAULT_ITEM_SETTINGS,
			sortOrder: 'custom',
			...oldSettings,
			customOrder: mergedChildren,
		}

		for (const child of folder.children) {
			if (child instanceof TFolder) {
				this.sync(child)
				continue
			}

			if (child instanceof TFile) {
				const prevSettings = this.plugin.settings.items[child.path] as BaseItemSettings | undefined
				this.plugin.settings.items[child.path] = { ...DEFAULT_ITEM_SETTINGS, ...prevSettings }
			}
		}
	}

	private syncPerFolder(folder: TFolder) {
		const folderPath = folder.path
		const newChildren = folder.children.map(c => c.name)

		// Try to load existing state from the storage backend first
		// This preserves custom order, hidden, and pinned from .flexplorer.json
		void this.plugin.loadFolderState(folderPath).then(existingState => {
			const state = existingState ?? emptyFolderState()

			// Merge children: keep existing order, add new children
			const existingOrder = state.order.filter(p => newChildren.includes(p))
			const addedChildren = newChildren.filter(p => !state.order.includes(p))
			state.order = this.plugin.settings.newItemPlacement === 'top'
				? [...addedChildren, ...existingOrder]
				: [...existingOrder, ...addedChildren]

			this.applyFolderStateToRuntime(folderPath, state)
		})

		// In the meantime, create a minimal runtime entry so the tree can render
		if (!this.plugin.settings.items[folderPath]) {
			this.plugin.settings.items[folderPath] = {
				...DEFAULT_ITEM_SETTINGS,
				sortOrder: 'custom',
				customOrder: newChildren,
			}
		}

		// Recursively sync children
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				this.syncPerFolder(child)
				continue
			}

			if (child instanceof TFile) {
				const prevSettings = this.plugin.settings.items[child.path] as BaseItemSettings | undefined
				this.plugin.settings.items[child.path] = { ...DEFAULT_ITEM_SETTINGS, ...prevSettings }
			}
		}
	}

	private cleanUpInvalidPaths() {
		for (const path of Object.keys(this.plugin.settings.items)) {
			if (!this.plugin.app.vault.getAbstractFileByPath(path)) {
				delete this.plugin.settings.items[path]
			}
		}
		for (const path of this.plugin.settings.pinnedFiles) {
			if (!this.plugin.app.vault.getAbstractFileByPath(path)) {
				this.plugin.settings.pinnedFiles.remove(path)
			}
		}
		this.plugin.settings.pinnedFiles = this.plugin.settings.pinnedFiles.unique()
	}

	private compareByName(a: TAbstractFile, b: TAbstractFile) {
		return collator.compare(a.name, b.name)
	}

	private compareByTimestamp(a: TAbstractFile, b: TAbstractFile, type: 'ctime' | 'mtime', direction: 'asc' | 'desc') {
		const aTimestamp = a instanceof TFile ? a.stat[type] : -Infinity
		const bTimestamp = b instanceof TFile ? b.stat[type] : -Infinity
		return direction === 'asc' ? aTimestamp - bTimestamp : bTimestamp - aTimestamp
	}

	private persistAndLog(message: string, changedFolderPaths?: string[]) {
		const plugin = this.plugin

		if (plugin.settings.storageMode === 'per-folder' && changedFolderPaths && changedFolderPaths.length > 0) {
			const uniquePaths = [...new Set(changedFolderPaths)]
			for (const folderPath of uniquePaths) {
				const folderSettings = plugin.settings.items[folderPath] as FolderSettings | undefined
				if (!folderSettings) continue
				void plugin.saveFolderState(folderPath, {
					version: 1,
					order: folderSettings.customOrder,
					hidden: this.collectHiddenNames(folderPath),
					pinned: this.collectPinnedNames(folderPath),
					sortMode: folderSettings.sortOrder,
				})
			}
			void plugin.saveSettings()
			this.log(message, structuredClone(plugin.settings.items))
			return
		}

		void plugin.saveSettings()
		this.log(message, structuredClone(plugin.settings.items))
	}

	private persistCreateDeleteChange(message: string, changedFolderPath?: string) {
		if (!this.plugin.settings.persistOrderOnCreateDelete) {
			this.log(message, structuredClone(this.plugin.settings.items))
			return this.log('Skipping data.json update')
		}

		if (this.plugin.settings.storageMode === 'per-folder' && changedFolderPath) {
			const folderSettings = this.plugin.settings.items[changedFolderPath] as FolderSettings | undefined
			if (folderSettings) {
				void this.plugin.saveFolderState(changedFolderPath, {
					version: 1,
					order: folderSettings.customOrder,
					hidden: this.collectHiddenNames(changedFolderPath),
					pinned: this.collectPinnedNames(changedFolderPath),
					sortMode: folderSettings.sortOrder,
				})
			}
			void this.plugin.saveSettings()
			this.log(message, structuredClone(this.plugin.settings.items))
			return
		}

		this.persistAndLog(message, changedFolderPath ? [changedFolderPath] : undefined)
	}

	private collectHiddenNames(folderPath: string): string[] {
		const items = this.plugin.settings.items
		const hidden: string[] = []
		for (const [path, item] of Object.entries(items)) {
			if (isDirectChild(path, folderPath) && item.isHidden) {
				hidden.push(getName(path))
			}
		}
		return hidden
	}

	private collectPinnedNames(folderPath: string): string[] {
		const items = this.plugin.settings.items
		const pinned: string[] = []
		for (const [path, item] of Object.entries(items)) {
			if (isDirectChild(path, folderPath) && item.isPinned) {
				pinned.push(getName(path))
			}
		}
		return pinned
	}
}
