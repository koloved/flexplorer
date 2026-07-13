import { App, Modal, Setting, Notice } from 'obsidian'

export class ConfirmModal extends Modal {
	constructor(app: App, title: string, content: string, private readonly onSubmit: (isConfirmed: boolean) => void) {
		super(app)

		this.setTitle(title)
		this.setContent(content)

		new Setting(this.contentEl)
			.addButton(btn => btn.setButtonText('Yes').setCta().onClick(() => {
				this.onSubmit(true)
				this.close()
			}))
			.addButton(btn => btn.setButtonText('No').onClick(() => {
				this.onSubmit(false)
				this.close()
			}))
	}
}

/** Modal shown when switching storage mode while data exists. */
export class StorageSwitchModal extends Modal {
	constructor(
		app: App,
		private readonly targetMode: 'per-folder' | 'global',
		private readonly onMigrate: () => void,
		private readonly onSwitch: () => void,
	) {
		super(app)

		const modeLabel = targetMode === 'per-folder' ? 'Per-folder metadata files' : 'Single plugin data.json'

		this.setTitle('Switch storage mode')
		this.setContent(`Flexplorer data exists in the current storage mode. Choose an action:`)

		new Setting(this.contentEl)
			.setName('Migrate data')
			.setDesc(`Migrate existing ordering and visibility data to ${modeLabel}.`)
			.addButton(btn => btn.setButtonText('Migrate').setCta().onClick(() => {
				this.close()
				this.onMigrate()
			}))

		new Setting(this.contentEl)
			.setName('Switch without migration')
			.setDesc('Existing ordering and visibility settings will not be available in the new mode until migrated. No files will be deleted.')
			.addButton(btn => btn.setButtonText('Switch').onClick(() => {
				this.close()
				this.onSwitch()
			}))

		new Setting(this.contentEl)
			.setName('Cancel')
			.setDesc('Keep the current storage mode.')
			.addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
	}
}
