import { App, PluginSettingTab, Setting, Notice } from 'obsidian'

import { logger, initLog } from '@/utils'
import type Flexplorer from '@/plugin'
import type { NewItemPlacement } from '@/types'
import { validateMetadataFilename } from '@/core/storage'
import { StorageSwitchModal } from './modal'

export class SettingsTab extends PluginSettingTab {
	private readonly log = initLog('SETTINGS', '#ff8800')

	constructor(readonly app: App, readonly plugin: Flexplorer) { super(app, plugin) }

	display() {
		this.containerEl.empty()
		this.addStorageSettings()
		this.addBehaviourSettings()
	}

	private addStorageSettings() {
		const plugin = this.plugin
		const settings = plugin.settings

		new Setting(this.containerEl)
			.setName('Storage')
			.setHeading()

		new Setting(this.containerEl)
			.setName('Storage mode')
			.setDesc('Choose where Flexplorer stores file order, visibility and pinned state. Per-folder storage reduces sync and Git conflicts in collaborative vaults.')
			.addDropdown(dropdown => dropdown
				.addOption('global', 'Single plugin data.json')
				.addOption('per-folder', 'Per-folder metadata files')
				.setValue(settings.storageMode)
				.onChange(async newMode => {
					if (newMode === settings.storageMode) return

					const hasData = settings.storageMode === 'global'
						? Object.keys(settings.items).length > 0
						: await this.hasPerFolderData()

					if (!hasData) {
						settings.storageMode = newMode as 'global' | 'per-folder'
						await plugin.saveSettings()
						this.display()
						return
					}

					new StorageSwitchModal(
						this.app,
						newMode as 'per-folder' | 'global',
						// Migrate
						async () => {
							if (newMode === 'per-folder') {
								await plugin.app.commands.executeCommandById('flexplorer-migrate-to-per-folder')
							} else {
								await plugin.app.commands.executeCommandById('flexplorer-migrate-from-per-folder')
							}
							this.display()
						},
						// Switch without migration
						async () => {
							settings.storageMode = newMode as 'global' | 'per-folder'
							await plugin.saveSettings()
							plugin.sortExplorer()
							this.display()
						},
					).open()
				}),
			)

		// Metadata filename — only visible in per-folder mode
		if (settings.storageMode === 'per-folder') {
			const filenameSetting = new Setting(this.containerEl)
				.setName('Folder metadata filename')
				.setDesc('Filename for per-folder metadata files. Changing this will not migrate existing files.')
				.addText(text => text
					.setPlaceholder('.flexplorer.json')
					.setValue(settings.folderMetadataFilename)
					.onChange(async value => {
						const err = validateMetadataFilename(value)
						if (err) {
							filenameSetting.setDesc(err)
							return
						}
						filenameSetting.setDesc('Filename for per-folder metadata files.')
						settings.folderMetadataFilename = value.trim()
						await plugin.saveSettings()
					}),
				)
		}
	}

	private addBehaviourSettings() {
		const plugin = this.plugin
		const settings = plugin.settings

		new Setting(this.containerEl)
			.setName('Behaviour')
			.setHeading()

		const persistOrderOnCreateDeleteDesc = activeDocument.createDocumentFragment()
		persistOrderOnCreateDeleteDesc.append('Update data.json immediately when files are created or deleted. Disable this if your sync service, especially Obsidian Sync, creates sync conflicts when merging data.json across devices after file create/delete events. ')
		persistOrderOnCreateDeleteDesc.createEl('a', {
			text: 'Issue #120 discussion',
			href: 'https://github.com/kh4f/flexplorer/issues/120#issuecomment-3782479650',
		})

		new Setting(this.containerEl)
			.setName('New item placement')
			.setDesc('Default placement for new items inside a folder')
			.addDropdown(dropdown => dropdown
				.addOption('top', 'Top')
				.addOption('bottom', 'Bottom')
				.setValue(settings.newItemPlacement)
				.onChange(newItemPlacement => {
					settings.newItemPlacement = newItemPlacement as NewItemPlacement
					void plugin.saveSettings()
				}),
			)
		new Setting(this.containerEl)
			.setName('Persist order on create/delete')
			.setDesc(persistOrderOnCreateDeleteDesc)
			.addToggle(toggle => toggle
				.setValue(settings.persistOrderOnCreateDelete)
				.onChange(shouldPersistOrderOnCreateDelete => {
					settings.persistOrderOnCreateDelete = shouldPersistOrderOnCreateDelete
					void plugin.saveSettings()
				}),
			)
		new Setting(this.containerEl)
			.setName('Debug mode')
			.setDesc('Show debug logs in the console')
			.addToggle(toggle => toggle
				.setValue(settings.debugMode)
				.onChange(enableDebugMode => {
					settings.debugMode = enableDebugMode
					logger.level = enableDebugMode ? 'debug' : 'silent'
					void plugin.saveSettings()
				}),
			)
	}

	private async hasPerFolderData(): Promise<boolean> {
		try {
			const adapter = this.app.vault.adapter
			const filename = this.plugin.settings.folderMetadataFilename
			return await adapter.exists(filename) // root metadata file at minimum
		} catch {
			return false
		}
	}
}
