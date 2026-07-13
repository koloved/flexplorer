<div align="center">
	<picture>
		<source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/kh4f/flexplorer/refs/heads/assets/logo-dark.png">
		<img alt="logo" src="https://raw.githubusercontent.com/kh4f/flexplorer/refs/heads/assets/logo-light.png">
	</picture>
	<br>
	An Obsidian plugin that <b>enhances the native file explorer</b>
	<br><br>
	<p>
		<a href='https://github.com/obsidianmd/obsidian-releases/blob/master/community-plugin-stats.json#:~:text="flexplorer"' target="_blank"><img src="https://img.shields.io/badge/dynamic/json?logo=obsidian&style=flat-square&color=D6CFCB&labelColor=49355E&label=Downloads&query=%24%5B%22flexplorer%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json" alt="downloads"></a>&nbsp;
		<a href="https://github.com/kh4f/flexplorer/releases"><img src="https://img.shields.io/github/v/tag/kh4f/flexplorer?label=%F0%9F%8F%B7%EF%B8%8F%20Release&style=flat-square&color=D6CFCB&labelColor=49355E" alt="version"/></a>&nbsp;
		<a href="https://github.com/kh4f/flexplorer/issues?q=is%3Aopen+label%3Abug"><img src="https://img.shields.io/github/issues/kh4f/flexplorer/bug?label=%F0%9F%90%9B%20Bugs&style=flat-square&color=D6CFCB&labelColor=49355E" alt="bugs"></a>
	</p>
	<b>
		<a href="#-features">Features</a>&nbsp; •&nbsp;
		<a href="#%EF%B8%8F-usage">Usage</a>&nbsp; •&nbsp;
		<a href="#-per-folder-storage">Per-folder storage</a>&nbsp; •&nbsp;
		<a href="#-installation">Installation</a>&nbsp; •&nbsp;
		<a href="#-credits">Credits</a>
	</b>
	<br><br>
	<img src="https://raw.githubusercontent.com/kh4f/flexplorer/refs/heads/assets/demo.gif" alt="demo">
</div>

## 🔥 Features
- **Per-folder sorting:** each folder can use its own sorting mode
- **Custom order mode:** manually arrange items via drag-and-drop
- **Pinning & hiding:** keep important files at the top, hide irrelevant ones
- **Mobile support:** all features work on mobile as well
- **Per-folder storage mode:** store ordering and visibility per folder for Git-friendly collaboration

## 🕹️ Usage
![guide](https://raw.githubusercontent.com/kh4f/flexplorer/refs/heads/assets/guide.png)

#### Notes:
- To drag items on touch devices, hold them **by the right edge**

## 📁 Per-folder storage

Per-folder storage is an optional Git-friendly storage mode for collaborative vaults.

Instead of storing the state of the entire vault in one plugin data file (`.obsidian/plugins/flexplorer/data.json`), Flexplorer stores each folder's ordering and visibility state in a local `.flexplorer.json` file inside that folder.

### When to use it

- **Collaborative vaults** shared via Git, Obsidian Sync, or Syncthing
- **Large vaults** where different people maintain different sections
- **Any setup** where a single `data.json` causes sync conflicts

### How it works

```
Vault/
├── .flexplorer.json          ← root folder order
├── Documentation/
│   ├── .flexplorer.json      ← Documentation folder order
│   ├── Introduction.md
│   ├── FAQ.md
│   └── Configuration/
│       ├── .flexplorer.json  ← Configuration folder order
│       ├── General.md
│       └── Advanced.md
└── Development/
    ├── .flexplorer.json      ← Development folder order
    ├── Roadmap.md
    └── Internal.md
```

Each `.flexplorer.json` file controls **only its immediate children**:

```json
{
"version": 1,
"order": ["Introduction.md", "Configuration", "FAQ.md"],
"hidden": ["Internal.md"],
"pinned": ["Introduction.md"]
}
```

### How to enable

1. Open **Settings → Flexplorer → Storage**
2. Change **Storage mode** to `Per-folder metadata files`
3. If you have existing ordering data, choose **Migrate data** when prompted

### Migration commands

Accessible via the command palette (`Ctrl/Cmd+P`):

| Command | Description |
|---------|-------------|
| `Flexplorer: Migrate data.json to per-folder storage` | Create `.flexplorer.json` files from existing `data.json` data |
| `Flexplorer: Preview migration to per-folder storage` | Dry-run — shows what will happen without writing anything |
| `Flexplorer: Migrate per-folder storage to data.json` | Reverse migration: collect all `.flexplorer.json` back into `data.json` |
| `Flexplorer: Validate per-folder metadata files` | Check all `.flexplorer.json` files for errors and stale references |
| `Flexplorer: Reload folder metadata` | Clear cache and re-read all `.flexplorer.json` files |

### Git conflicts

Per-folder storage minimises merge conflicts:

- **Different folders** edited by different people → **no conflict**
- **Same folder** edited by two people → conflict is **localised to one small `.flexplorer.json` file**
- **Renaming or moving a folder** → internal metadata stays intact

To opt out of synchronising metadata entirely, add this to your `.gitignore`:

```gitignore
**/.flexplorer.json
```

> **Note:** With the gitignore line, every user will have their own local ordering — changes won't sync.

### Going back

To return to the single-file mode, use `Flexplorer: Migrate per-folder storage to data.json`. The `.flexplorer.json` files are **not automatically deleted** — use the command `Flexplorer: Remove per-folder metadata files` (if available) or delete them manually.

## 📥 Installation
- **Via the Obsidian Community**: https://community.obsidian.md/plugins/flexplorer
- **Using the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat)**: `Add Beta Plugin` → `kh4f/flexplorer`
- **Manually**: [download](https://github.com/kh4f/flexplorer/releases/latest) `manifest.json`, `main.js`, and `styles.css` into `vault/.obsidian/plugins/flexplorer/`

## 💖 Credits
- **Inspiration**: [Obsidian Bartender](https://github.com/Mara-Li/obsidian-bartender), [Custom File Explorer sorting](https://github.com/SebastianMC/obsidian-custom-sort), [File Explorer++](https://github.com/kelszo/obsidian-file-explorer-plus)
- **Huge thanks** to [@Zweikeks](https://github.com/Zweikeks), [@Azmoinal](https://github.com/Azmoinal), [@SublimePeace](https://github.com/SublimePeace), [@AE-SAY-WAY](https://github.com/AE-SAY-WAY), [@Anonym0usPlayer](https://github.com/Anonym0usPlayer) and others for testing and feedback!
- **Special thanks** to [@Mara-Li](https://github.com/Mara-Li) for contributions!
