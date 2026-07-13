import { describe, expect, test } from 'bun:test'
import {
	childPrefix,
	emptyFolderState,
	getMetadataPath,
	getName,
	getParentPath,
	isDirectChild,
	isFolderStateEmpty,
	pruneStaleReferences,
	serialiseFolderState,
	validateMetadataFilename,
} from '../core/storage/path-utils'

// ── getMetadataPath ────────────────────────────────────────────────

describe('getMetadataPath', () => {
	test('root folder returns bare filename', () => {
		expect(getMetadataPath('')).toBe('.flexplorer.json')
		expect(getMetadataPath('/')).toBe('.flexplorer.json')
	})

	test('nested folder joins with slash', () => {
		expect(getMetadataPath('Documentation')).toBe('Documentation/.flexplorer.json')
		expect(getMetadataPath('A/B/C')).toBe('A/B/C/.flexplorer.json')
	})

	test('strips leading/trailing slashes', () => {
		expect(getMetadataPath('/Documentation/')).toBe('Documentation/.flexplorer.json')
	})

	test('custom filename', () => {
		expect(getMetadataPath('Docs', '.meta.json')).toBe('Docs/.meta.json')
	})
})

// ── getParentPath ──────────────────────────────────────────────────

describe('getParentPath', () => {
	test('root returns /', () => {
		expect(getParentPath('/')).toBe('/')
	})

	test('top-level file returns /', () => {
		expect(getParentPath('Readme.md')).toBe('/')
	})

	test('nested file returns parent folder', () => {
		expect(getParentPath('Doc/Readme.md')).toBe('Doc')
		expect(getParentPath('A/B/C/File.md')).toBe('A/B/C')
	})
})

// ── getName ─────────────────────────────────────────────────────────

describe('getName', () => {
	test('top-level file returns itself', () => {
		expect(getName('Readme.md')).toBe('Readme.md')
	})

	test('nested file returns leaf name', () => {
		expect(getName('Doc/File.md')).toBe('File.md')
		expect(getName('A/B/C/File.md')).toBe('File.md')
	})

	test('empty for root', () => {
		expect(getName('/')).toBe('')
	})
})

// ── childPrefix ────────────────────────────────────────────────────

describe('childPrefix', () => {
	test('root returns empty string', () => {
		expect(childPrefix('/')).toBe('')
	})

	test('folder returns with trailing slash', () => {
		expect(childPrefix('Doc')).toBe('Doc/')
		expect(childPrefix('A/B/C')).toBe('A/B/C/')
	})
})

// ── isDirectChild ──────────────────────────────────────────────────

describe('isDirectChild', () => {
	test('root children', () => {
		expect(isDirectChild('Readme.md', '/')).toBe(true)
		expect(isDirectChild('Folder', '/')).toBe(true)
	})

	test('nested children', () => {
		expect(isDirectChild('Doc/Readme.md', 'Doc')).toBe(true)
		expect(isDirectChild('Doc/Sub/Readme.md', 'Doc')).toBe(false)
	})

	test('self is not child', () => {
		expect(isDirectChild('/', '/')).toBe(false)
		expect(isDirectChild('Doc', 'Doc')).toBe(false)
	})
})

// ── validateMetadataFilename ───────────────────────────────────────

describe('validateMetadataFilename', () => {
	test('valid names', () => {
		expect(validateMetadataFilename('.flexplorer.json')).toBeNull()
		expect(validateMetadataFilename('metadata.json')).toBeNull()
	})

	test('empty', () => {
		expect(validateMetadataFilename('')).toBe('Filename must not be empty')
	})

	test('contains slash', () => {
		const err = validateMetadataFilename('path/file.json')
		expect(err).toContain('/ or \\')
	})

	test('special dir names', () => {
		expect(validateMetadataFilename('.')).toContain('not be')
		expect(validateMetadataFilename('..')).toContain('not be')
	})
})

// ── serialiseFolderState ───────────────────────────────────────────

describe('serialiseFolderState', () => {
	test('produces stable JSON with trailing newline', () => {
		const state = { version: 1, order: ['a.md', 'b.md'], hidden: [], pinned: [] }
		const result = serialiseFolderState(state)
		expect(result.endsWith('\n')).toBe(true)
		const parsed = JSON.parse(result)
		expect(parsed.version).toBe(1)
		expect(parsed.order).toEqual(['a.md', 'b.md'])
	})

	test('keys in deterministic order', () => {
		const state = { version: 1, order: ['a'], hidden: ['b'], pinned: [], sortMode: 'custom' as const }
		const lines = serialiseFolderState(state).split('\n')
		// First data line should be  "version":
		expect(lines[1].trim()).toBe('"version": 1,')
	})

	test('preserves unknown extension fields sorted', () => {
		const state = { version: 1, order: [], hidden: [], pinned: [], groups: ['x'], zField: 1 }
		const result = serialiseFolderState(state)
		const parsed = JSON.parse(result)
		expect(parsed.groups).toEqual(['x'])
		expect(parsed.zField).toBe(1)
	})
})

// ── emptyFolderState ───────────────────────────────────────────────

describe('emptyFolderState', () => {
	test('creates empty state v1', () => {
		const state = emptyFolderState()
		expect(state.version).toBe(1)
		expect(state.order).toEqual([])
		expect(state.hidden).toEqual([])
		expect(state.pinned).toEqual([])
	})
})

// ── isFolderStateEmpty ─────────────────────────────────────────────

describe('isFolderStateEmpty', () => {
	test('truly empty', () => {
		expect(isFolderStateEmpty(emptyFolderState())).toBe(true)
	})

	test('not empty when has order', () => {
		const state = emptyFolderState()
		state.order = ['a']
		expect(isFolderStateEmpty(state)).toBe(false)
	})

	test('empty with sortMode custom is still empty', () => {
		const state = emptyFolderState()
		state.sortMode = 'custom'
		expect(isFolderStateEmpty(state)).toBe(true)
	})

	test('not empty with non-custom sortMode', () => {
		const state = emptyFolderState()
		state.sortMode = 'byName'
		expect(isFolderStateEmpty(state)).toBe(false)
	})
})

// ── pruneStaleReferences ───────────────────────────────────────────

describe('pruneStaleReferences', () => {
	test('removes non-existent names from all arrays', () => {
		const state = {
			version: 1,
			order: ['a.md', 'b.md', 'gone.md'],
			hidden: ['gone.md'],
			pinned: ['a.md'],
		}
		const existing = new Set(['a.md', 'b.md'])
		const pruned = pruneStaleReferences(state, existing)
		expect(pruned.order).toEqual(['a.md', 'b.md'])
		expect(pruned.hidden).toEqual([])
		expect(pruned.pinned).toEqual(['a.md'])
	})

	test('does not mutate original', () => {
		const state = { version: 1, order: ['gone.md'], hidden: [], pinned: [] }
		const existing = new Set<string>()
		pruneStaleReferences(state, existing)
		expect(state.order).toEqual(['gone.md'])
	})
})
