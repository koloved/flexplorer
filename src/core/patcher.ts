import { Menu } from 'obsidian'
import type { FileExplorerView } from 'obsidian-typings'

import { populateSortMenu } from '@/ui/menu'
import { initLog } from '@/utils'
import type Flexplorer from '@/plugin'
import type { FolderSettings } from '@/types'

const ROOT_PATH = '/'
const FILE_EXPLORER_SORT_LABEL_KEY = 'plugins.file-explorer.action-change-sort'

export class Patcher {
	private readonly log = initLog('PATCHER', '#988bff')
	private unpatchExplorer: (() => void) | null = null
	private unpatchMenu: (() => void) | null = null

	constructor(private readonly plugin: Flexplorer) {}

	patchExplorer() {
		const plugin = this.plugin

		const explorerProto = Object.getPrototypeOf(plugin.getExplorerView()) as FileExplorerView
		const originalGetSortedFolderItems = explorerProto.getSortedFolderItems

		explorerProto.getSortedFolderItems = function (folder) {
			let items = originalGetSortedFolderItems.call(this, folder)

			// Per-folder mode: filter out metadata files from the tree
			if (plugin.settings.storageMode === 'per-folder') {
				const metaFilename = plugin.settings.folderMetadataFilename
				items = items.filter(item => item.file.name !== metaFilename)
			}

			const folderSettings = plugin.settings.items[folder.path] as FolderSettings | undefined
			if (!folderSettings) return items
			return plugin.orderManager.getSortedItems(folderSettings, items)
		}

		this.unpatchExplorer = () => explorerProto.getSortedFolderItems = originalGetSortedFolderItems
		this.log('Explorer patched' + (plugin.settings.storageMode === 'per-folder' ? ' (metadata filtered)' : ''))
	}

	patchMenu() {
		const patcher = this
		const plugin = this.plugin

		const originalShowAtMouseEvent = Menu.prototype.showAtMouseEvent

		Menu.prototype.showAtMouseEvent = function (evt) {
			const triggerEl = evt.target as HTMLElement
			const sortButtonLabel = i18next.t(FILE_EXPLORER_SORT_LABEL_KEY)
			if (triggerEl.getAttribute('aria-label') !== sortButtonLabel || !triggerEl.classList.contains('nav-action-button'))
				return originalShowAtMouseEvent.call(this, evt)

			const folderSettings = (plugin.settings.items[ROOT_PATH] ?? {
				customOrder: [],
				sortOrder: 'custom',
				isPinned: false,
				isHidden: false,
			}) as FolderSettings
			const customMenu = populateSortMenu(new Menu(), folderSettings.sortOrder, plugin, ROOT_PATH, folderSettings)
				.addItem(item => item.setTitle('Show hidden')
					.setChecked(plugin.settings.showHidden)
					.onClick(() => {
						plugin.settings.showHidden = !plugin.settings.showHidden
						void plugin.saveSettings()
						activeDocument.body.toggleClass('fp-show-hidden', plugin.settings.showHidden)
					}))

			patcher.log(`Custom sort menu opened for '${ROOT_PATH}'`)
			return originalShowAtMouseEvent.call(customMenu, evt)
		}

		this.unpatchMenu = () => Menu.prototype.showAtMouseEvent = originalShowAtMouseEvent
		this.log('Menu patched')
	}

	unpatch() {
		this.unpatchExplorer?.()
		this.unpatchMenu?.()
		this.log('Patches removed')
	}
}
