import { describe, expect, it, vi } from 'vitest'

import { ContainerMappingStore } from '../src/containerMappingStore'
import { SYNC_FOLDER_TITLE } from '../src/containerMappings'
import type { BookmarkNode, BrowserApi, ContextualIdentity } from '../src/models'

function createMappingStoreBrowserMock(options?: {
	syncFolderExists?: boolean
	mappingBookmarks?: BookmarkNode[]
}): BrowserApi {
	let syncFolder: BookmarkNode | null = options?.syncFolderExists
		? { id: 'sync-folder-1', type: 'folder', title: SYNC_FOLDER_TITLE, parentId: 'menu________' }
		: null
	const mappingChildren = [...(options?.mappingBookmarks ?? [])]

	const bookmarks = {
		search: vi.fn().mockImplementation(async (query: Record<string, unknown>) => {
			if (query.title === SYNC_FOLDER_TITLE) {
				return syncFolder ? [syncFolder] : []
			}
			return []
		}),
		get: vi.fn().mockResolvedValue([]),
		getTree: vi.fn().mockResolvedValue([]),
		getChildren: vi.fn().mockImplementation(async (id: string) => {
			if (syncFolder && id === syncFolder.id) {
				return [...mappingChildren]
			}
			return []
		}),
		remove: vi.fn().mockImplementation(async (id: string) => {
			const index = mappingChildren.findIndex((node) => node.id === id)
			if (index >= 0) {
				mappingChildren.splice(index, 1)
			}
		}),
		update: vi.fn().mockImplementation(async (id: string, changes: { title?: string; url?: string }) => {
			const index = mappingChildren.findIndex((node) => node.id === id)
			if (index >= 0) {
				const existingNode = mappingChildren[index]
				if (existingNode) {
					mappingChildren[index] = {
						...existingNode,
						...(changes.title !== undefined ? { title: changes.title } : {}),
						...(changes.url !== undefined ? { url: changes.url } : {})
					}
				}
			}
			return mappingChildren[index] ?? { id, type: 'bookmark', ...changes }
		}),
		create: vi.fn().mockImplementation(async (details: {
			parentId: string
			title: string
			url?: string
			type?: 'folder'
		}) => {
			if (details.type === 'folder') {
				syncFolder = {
					id: 'sync-folder-created',
					type: 'folder',
					title: details.title,
					parentId: details.parentId
				}
				return syncFolder
			}

			const created: BookmarkNode = {
				id: `mapping-${mappingChildren.length + 1}`,
				type: 'bookmark',
				title: details.title,
				...(details.url !== undefined ? { url: details.url } : {}),
				parentId: details.parentId
			}
			mappingChildren.push(created)
			return created
		}),
		onRemoved: {
			addListener: vi.fn()
		},
		onChanged: {
			addListener: vi.fn()
		},
		onCreated: {
			addListener: vi.fn()
		}
	}

	return {
		bookmarks,
		menus: {
			create: vi.fn(),
			refresh: vi.fn(),
			removeAll: vi.fn(),
			onClicked: { addListener: vi.fn() },
			onShown: { addListener: vi.fn() },
			onHidden: { addListener: vi.fn() }
		},
		contextualIdentities: {
			query: vi.fn().mockResolvedValue([]),
			get: vi.fn().mockRejectedValue(new Error('unused'))
		},
		tabs: {
			TAB_ID_NONE: -1,
			create: vi.fn().mockResolvedValue(undefined),
			remove: vi.fn().mockResolvedValue(undefined),
			get: vi.fn().mockResolvedValue({ id: 0, index: 0 }),
			query: vi.fn().mockResolvedValue([]),
			highlight: vi.fn().mockResolvedValue(undefined),
			onActivated: { addListener: vi.fn() },
			onUpdated: { addListener: vi.fn() }
		},
		notifications: {
			create: vi.fn().mockResolvedValue('notification-id')
		},
		pageAction: {
			show: vi.fn().mockResolvedValue(undefined),
			hide: vi.fn().mockResolvedValue(undefined),
			onClicked: { addListener: vi.fn() }
		},
		webNavigation: {
			onBeforeNavigate: {
				addListener: vi.fn()
			}
		},
		webRequest: {
			onBeforeRequest: {
				addListener: vi.fn()
			}
		},
		storage: {
			local: {
				get: vi.fn().mockResolvedValue({}),
				set: vi.fn().mockResolvedValue(undefined)
			}
		}
	}
}

function createContextualIdentity(name: string, cookieStoreId: string): ContextualIdentity {
	return {
		name,
		cookieStoreId,
		icon: 'briefcase',
		color: 'blue',
		colorCode: '#0000ff',
		iconUrl: 'resource://usercontext-content/briefcase.svg'
	}
}

describe('ContainerMappingStore', () => {
	it('loads mappings from existing sync folder', async () => {
		const browserApi = createMappingStoreBrowserMock({
			syncFolderExists: true,
			mappingBookmarks: [{
				id: 'mapping-1',
				type: 'bookmark',
				title: 'Mapping: Work',
				url: 'about:2:cid-2:Work',
				parentId: 'sync-folder-1'
			}]
		})

		const store = new ContainerMappingStore(browserApi)
		await store.initialize()

		expect(store.getByIndex(2)).toEqual({
			firstSeenIndex: 2,
			cookieStoreId: 'cid-2',
			backupName: 'Work'
		})
	})

	it('preserves first-seen index across container rename', async () => {
		const browserApi = createMappingStoreBrowserMock({
			syncFolderExists: true,
			mappingBookmarks: [{
				id: 'mapping-1',
				type: 'bookmark',
				title: 'Mapping: Work',
				url: 'about:0:cid-work:Work',
				parentId: 'sync-folder-1'
			}]
		})

		const store = new ContainerMappingStore(browserApi)
		await store.initialize()
		const record = await store.ensureMappingForContainer(createContextualIdentity('Work Renamed', 'cid-work'))

		expect(record.firstSeenIndex).toBe(0)
		expect(browserApi.bookmarks.update).toHaveBeenCalledWith(
			'mapping-1',
			expect.objectContaining({
				title: 'Mapping: Work Renamed',
				url: 'about:0:cid-work:Work Renamed'
			})
		)
	})

	it('remaps recreated container by backup name and keeps original index', async () => {
		const browserApi = createMappingStoreBrowserMock({
			syncFolderExists: true,
			mappingBookmarks: [{
				id: 'mapping-1',
				type: 'bookmark',
				title: 'Mapping: Work',
				url: 'about:0:cid-old:Work',
				parentId: 'sync-folder-1'
			}]
		})

		const store = new ContainerMappingStore(browserApi)
		await store.initialize()
		const record = await store.ensureMappingForContainer(createContextualIdentity('Work', 'cid-new'))

		expect(record).toEqual({ firstSeenIndex: 0, cookieStoreId: 'cid-new', backupName: 'Work' })
		expect(browserApi.bookmarks.update).toHaveBeenCalledWith(
			'mapping-1',
			expect.objectContaining({ url: 'about:0:cid-new:Work' })
		)
	})

	it('stores mappings in local storage when bookmark sync is disabled', async () => {
		const browserApi = createMappingStoreBrowserMock({ syncFolderExists: false })
		const store = new ContainerMappingStore(browserApi, console, { enableBookmarkSync: false })

		const record = await store.ensureMappingForContainer(createContextualIdentity('Work', 'cid-1'))

		expect(record).toEqual({ firstSeenIndex: 0, cookieStoreId: 'cid-1', backupName: 'Work' })
		expect(browserApi.bookmarks.create).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: 'folder', title: SYNC_FOLDER_TITLE })
		)
		expect(browserApi.storage.local.set).toHaveBeenCalledWith(
			expect.objectContaining({
				'containMarks.localMappings': [
					{ firstSeenIndex: 0, cookieStoreId: 'cid-1', backupName: 'Work' }
				]
			})
		)
	})
})
