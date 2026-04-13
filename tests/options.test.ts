import { describe, expect, it, vi } from 'vitest'

import {
	scanOrphanedBookmarks,
	resetOrphanedBookmarks,
	readLocalMappings,
	writeLocalMappings,
	readSyncedMappings,
	overwriteSyncedMappings,
} from '../src/mappingMigration'
import { getNewUrl } from '../src/urlCodec'
import { SYNC_FOLDER_TITLE, SYNC_FOLDER_PARENT_ID, buildContainerMappingUrl, buildMappingTitle } from '../src/containerMappings'
import type { BookmarkNode, BrowserApi, ContainerMappingRecord } from '../src/models'

// --- Lightweight BrowserApi mock for options page helpers ---

class MemoryExtensionStorage {
	private readonly data = new Map<string, unknown>()

	public async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
		if (keys === null || keys === undefined) {
			return Object.fromEntries(this.data.entries())
		}
		if (typeof keys === 'string') {
			return { [keys]: this.data.get(keys) }
		}
		if (Array.isArray(keys)) {
			return Object.fromEntries(keys.map((key) => [key, this.data.get(key)]))
		}
		const result: Record<string, unknown> = {}
		for (const [key, defaultValue] of Object.entries(keys)) {
			result[key] = this.data.has(key) ? this.data.get(key) : defaultValue
		}
		return result
	}

	public async set(items: Record<string, unknown>): Promise<void> {
		for (const [key, value] of Object.entries(items)) {
			this.data.set(key, value)
		}
	}
}

function createOptionsBrowserMock(options?: {
	bookmarks?: BookmarkNode[]
	syncFolderChildren?: BookmarkNode[]
}): BrowserApi {
	const allBookmarks = [...(options?.bookmarks ?? [])]
	const syncFolderChildren = options?.syncFolderChildren ?? []
	const extensionStorage = new MemoryExtensionStorage()
	let createdIndex = 0

	const syncFolder: BookmarkNode = {
		id: 'sync-folder-1',
		type: 'folder',
		title: SYNC_FOLDER_TITLE,
		parentId: SYNC_FOLDER_PARENT_ID,
	}

	return {
		bookmarks: {
			search: vi.fn().mockImplementation(async (query: string | { query?: string, url?: string, title?: string }) => {
				if (typeof query === 'string') {
					return allBookmarks.filter((b) => b.url?.includes(query) || b.title?.includes(query))
				}
				if (typeof query.title === 'string') {
					if (query.title === SYNC_FOLDER_TITLE) {
						return [syncFolder]
					}
					return allBookmarks.filter((b) => b.title === query.title)
				}
				if (typeof query.query === 'string') {
					return allBookmarks.filter((b) => b.url?.includes(query.query!) || b.title?.includes(query.query!))
				}
				return allBookmarks
			}),
			get: vi.fn().mockImplementation(async (id: string) => {
				const found = allBookmarks.find((b) => b.id === id)
				return found ? [found] : []
			}),
			getTree: vi.fn().mockResolvedValue([
				{ id: 'root', type: 'folder', title: '', children: [] }
			]),
			getChildren: vi.fn().mockImplementation(async (id: string) => {
				if (id === syncFolder.id) {
					return syncFolderChildren
				}
				return allBookmarks.filter((b) => b.parentId === id)
			}),
			remove: vi.fn().mockImplementation(async (id: string) => {
				const index = syncFolderChildren.findIndex((b) => b.id === id)
				if (index >= 0) syncFolderChildren.splice(index, 1)
			}),
			update: vi.fn().mockImplementation(async (id: string, changes: { url?: string; title?: string }) => {
				const bookmark = allBookmarks.find((b) => b.id === id)
				if (bookmark && changes.url !== undefined) {
					bookmark.url = changes.url
				}
				if (bookmark && changes.title !== undefined) {
					bookmark.title = changes.title
				}
				return bookmark ?? { id, type: 'bookmark' as const }
			}),
			create: vi.fn().mockImplementation(async (details: { parentId: string; title: string; url?: string; type?: string }) => {
				createdIndex += 1
				const node: BookmarkNode = {
					id: `created-${createdIndex}`,
					type: (details.type as BookmarkNode['type']) ?? 'bookmark',
					title: details.title,
					parentId: details.parentId,
					...(details.url ? { url: details.url } : {}),
				}
				if (details.parentId === syncFolder.id) {
					syncFolderChildren.push(node)
				}
				return node
			}),
			onRemoved: { addListener: vi.fn() },
			onChanged: { addListener: vi.fn() },
			onCreated: { addListener: vi.fn() },
		},
		storage: {
			local: {
				get: vi.fn().mockImplementation(extensionStorage.get.bind(extensionStorage)),
				set: vi.fn().mockImplementation(extensionStorage.set.bind(extensionStorage)),
			},
		},
	} as unknown as BrowserApi
}

// --- Test helpers ---

function makeEncodedBookmark(id: string, token: string, containerIndex: number, realUrl: string): BookmarkNode {
	return {
		id,
		type: 'bookmark',
		url: getNewUrl({ value: token }, containerIndex, realUrl),
		title: `Encoded: ${realUrl}`,
	}
}

function makeMapping(index: number, name: string, cookieStoreId: string): ContainerMappingRecord {
	return { firstSeenIndex: index, backupName: name, cookieStoreId }
}

function makeSyncBookmark(record: ContainerMappingRecord): BookmarkNode {
	return {
		id: `sync-bm-${record.firstSeenIndex}`,
		type: 'bookmark',
		title: buildMappingTitle(record.backupName),
		url: buildContainerMappingUrl(record),
		parentId: 'sync-folder-1',
	}
}

// --- Tests ---

describe('scanOrphanedBookmarks', () => {
	it('returns bookmarks whose containerIndex is not in the target set', async () => {
		const bookmarks = [
			makeEncodedBookmark('bm-1', 'tokenAAA', 0, 'https://example.com'),
			makeEncodedBookmark('bm-2', 'tokenBBB', 5, 'https://orphan.com'),
		]
		const targetRecords = [makeMapping(0, 'Work', 'firefox-container-1')]

		const browserApi = createOptionsBrowserMock({ bookmarks })
		const orphans = await scanOrphanedBookmarks(browserApi, targetRecords)

		expect(orphans).toHaveLength(1)
		expect(orphans[0]!.id).toBe('bm-2')
	})

	it('returns empty when all indices resolve', async () => {
		const bookmarks = [
			makeEncodedBookmark('bm-1', 'tokenAAA', 0, 'https://a.com'),
			makeEncodedBookmark('bm-2', 'tokenBBB', 1, 'https://b.com'),
		]
		const targetRecords = [
			makeMapping(0, 'Work', 'firefox-container-1'),
			makeMapping(1, 'Personal', 'firefox-container-2'),
		]

		const browserApi = createOptionsBrowserMock({ bookmarks })
		const orphans = await scanOrphanedBookmarks(browserApi, targetRecords)
		expect(orphans).toHaveLength(0)
	})

	it('returns empty when there are no encoded bookmarks', async () => {
		const browserApi = createOptionsBrowserMock({ bookmarks: [] })
		const orphans = await scanOrphanedBookmarks(browserApi, [makeMapping(0, 'Work', 'c1')])
		expect(orphans).toHaveLength(0)
	})

	it('ignores bookmarks without valid fragment encoding', async () => {
		const bookmarks: BookmarkNode[] = [
			{ id: 'plain', type: 'bookmark', url: 'https://example.com', title: 'Plain' },
			{ id: 'frag', type: 'bookmark', url: 'https://example.com#section', title: 'Fragment' },
		]
		const browserApi = createOptionsBrowserMock({ bookmarks })
		const orphans = await scanOrphanedBookmarks(browserApi, [])
		expect(orphans).toHaveLength(0)
	})
})

describe('resetOrphanedBookmarks', () => {
	it('reverts encoded bookmarks to plain URLs', async () => {
		const bookmarks = [
			makeEncodedBookmark('bm-1', 'tokenAAA', 0, 'https://example.com'),
			makeEncodedBookmark('bm-2', 'tokenBBB', 5, 'https://orphan.com/page#section'),
		]
		const browserApi = createOptionsBrowserMock({ bookmarks })

		const count = await resetOrphanedBookmarks(browserApi, bookmarks)

		expect(count).toBe(2)
		expect(bookmarks[0]!.url).toBe('https://example.com')
		expect(bookmarks[1]!.url).toBe('https://orphan.com/page#section')
	})

	it('skips bookmarks without a url', async () => {
		const bookmarks: BookmarkNode[] = [
			{ id: 'no-url', type: 'bookmark', title: 'No URL' },
		]
		const browserApi = createOptionsBrowserMock({ bookmarks })
		const count = await resetOrphanedBookmarks(browserApi, bookmarks)
		expect(count).toBe(0)
	})

	it('returns zero when given empty array', async () => {
		const browserApi = createOptionsBrowserMock()
		const count = await resetOrphanedBookmarks(browserApi, [])
		expect(count).toBe(0)
	})
})

describe('local mapping read/write round-trip', () => {
	it('persists and reads back local mappings', async () => {
		const browserApi = createOptionsBrowserMock()
		const records = [
			makeMapping(0, 'Work', 'c1'),
			makeMapping(1, 'Personal', 'c2'),
		]

		await writeLocalMappings(browserApi, records)
		const loaded = await readLocalMappings(browserApi)

		expect(loaded).toHaveLength(2)
		expect(loaded[0]!.firstSeenIndex).toBe(0)
		expect(loaded[1]!.firstSeenIndex).toBe(1)
	})

	it('returns empty for missing storage key', async () => {
		const browserApi = createOptionsBrowserMock()
		const loaded = await readLocalMappings(browserApi)
		expect(loaded).toHaveLength(0)
	})
})

describe('synced mapping read/write round-trip', () => {
	it('reads mappings from sync folder children', async () => {
		const mappings = [
			makeMapping(0, 'Work', 'firefox-container-1'),
			makeMapping(1, 'Personal', 'firefox-container-2'),
		]
		const syncChildren = mappings.map(makeSyncBookmark)
		const browserApi = createOptionsBrowserMock({ syncFolderChildren: syncChildren })

		const loaded = await readSyncedMappings(browserApi)
		expect(loaded).toHaveLength(2)
		expect(loaded[0]!.backupName).toBe('Work')
		expect(loaded[1]!.backupName).toBe('Personal')
	})

	it('overwrites existing synced mappings', async () => {
		const oldMapping = makeMapping(0, 'OldContainer', 'firefox-old')
		const syncChildren = [makeSyncBookmark(oldMapping)]
		const browserApi = createOptionsBrowserMock({ syncFolderChildren: syncChildren })

		const newRecords = [
			makeMapping(0, 'Work', 'firefox-container-1'),
			makeMapping(1, 'Personal', 'firefox-container-2'),
		]

		await overwriteSyncedMappings(browserApi, newRecords)

		// Old mapping should have been removed, new ones created
		const loaded = await readSyncedMappings(browserApi)
		expect(loaded).toHaveLength(2)
		expect(loaded[0]!.backupName).toBe('Work')
		expect(loaded[1]!.backupName).toBe('Personal')
	})
})
