import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	BackgroundApp,
	NO_CONTAINER,
	getNewUrl,
	isPrefixedUrl,
	parseBookmarkUrl
} from '../src/backgroundApp'
import type {
	BookmarkNode,
	BrowserApi,
	ContextualIdentity,
	LoggerLike,
	StorageLike
} from '../src/models'

class MemoryStorage implements StorageLike {
	private readonly data = new Map<string, string>()

	public get length(): number {
		return this.data.size
	}

	public key(index: number): string | null {
		return [...this.data.keys()][index] ?? null
	}

	public getItem(key: string): string | null {
		return this.data.get(key) ?? null
	}

	public setItem(key: string, value: string): void {
		this.data.set(key, value)
	}

	public removeItem(key: string): void {
		this.data.delete(key)
	}

	public dump(): Record<string, string> {
		return Object.fromEntries(this.data.entries())
	}
}

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
			const entries = keys.map((key) => [key, this.data.get(key)] as const)
			return Object.fromEntries(entries)
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

function createBrowserMock(options?: {
	bookmarkById?: Record<string, BookmarkNode>
	bookmarkByUrl?: Record<string, BookmarkNode[]>
	bookmarkSearchByTitle?: Record<string, BookmarkNode[]>
	containers?: ContextualIdentity[]
	tabs?: Array<{ id: number, index: number, url?: string }>
}): BrowserApi {
	const bookmarkById = { ...(options?.bookmarkById ?? {}) }
	const bookmarkByUrl = options?.bookmarkByUrl ?? {}
	const bookmarkSearchByTitle = options?.bookmarkSearchByTitle ?? {}
	const containers = options?.containers ?? []
	const tabs = options?.tabs ?? []
	const extensionStorage = new MemoryExtensionStorage()
	let createdIndex = 0

	return {
		bookmarks: {
			search: vi.fn().mockImplementation(async (query: string | { query?: string, url?: string, title?: string }) => {
				if (typeof query === 'string') {
					return Object.values(bookmarkById).filter((item) =>
						(item.url && item.url.includes(query)) || (item.title && item.title.includes(query))
					)
				}
				if (typeof query.url === 'string') {
					if (bookmarkByUrl[query.url]) {
						return bookmarkByUrl[query.url]
					}
					return Object.values(bookmarkById).filter((item) => item.url === query.url)
				}
				if (typeof query.title === 'string') {
					if (bookmarkSearchByTitle[query.title]) {
						return bookmarkSearchByTitle[query.title]
					}
					return Object.values(bookmarkById).filter((item) => item.title === query.title)
				}
				return Object.values(bookmarkById)
			}),
			get: vi.fn().mockImplementation(async (id: string) => {
				const bookmark = bookmarkById[id]
				return bookmark ? [bookmark] : []
			}),
			getTree: vi.fn().mockResolvedValue([
				{ id: 'root', type: 'folder', title: 'root', children: [{ id: 'toolbar_____', type: 'folder', title: 'Toolbar' }] }
			]),
			getChildren: vi.fn().mockImplementation(async (id: string) => {
				return Object.values(bookmarkById).filter((node) => node.parentId === id)
			}),
			remove: vi.fn().mockImplementation(async (id: string) => {
				delete bookmarkById[id]
			}),
			update: vi.fn().mockImplementation(async (id: string, changes: { url?: string; title?: string }) => {
				const existing = bookmarkById[id] ?? { id, type: 'bookmark' as const }
				const updated = {
					...existing,
					...(changes.url !== undefined ? { url: changes.url } : {}),
					...(changes.title !== undefined ? { title: changes.title } : {})
				}
				bookmarkById[id] = updated
				return updated
			}),
			create: vi.fn().mockImplementation(async (details: {
				parentId: string
				index?: number
				title: string
				url?: string
				type?: 'folder'
			}) => {
				createdIndex += 1
				const createdId = details.type === 'folder' ? `created-folder-${createdIndex}` : `created-bookmark-${createdIndex}`
				const created: BookmarkNode = {
					id: createdId,
					type: details.type ?? 'bookmark',
					title: details.title,
					parentId: details.parentId,
					...(details.url !== undefined ? { url: details.url } : {})
				}
				bookmarkById[createdId] = created
				return created
			}),
			onRemoved: {
				addListener: vi.fn()
			},
			onChanged: {
				addListener: vi.fn()
			}
		},
		menus: {
			create: vi.fn(),
			refresh: vi.fn(),
			removeAll: vi.fn(),
			onClicked: {
				addListener: vi.fn()
			},
			onShown: {
				addListener: vi.fn()
			},
			onHidden: {
				addListener: vi.fn()
			}
		},
		contextualIdentities: {
			query: vi.fn().mockImplementation(async ({ name }: { name?: string }) => {
				if (!name) {
					return containers
				}
				return containers.filter((container) => container.name === name)
			}),
			get: vi.fn().mockImplementation(async (cookieStoreId: string) => {
				const container = containers.find((item) => item.cookieStoreId === cookieStoreId)
				if (!container) {
					throw new Error(`Unknown container: ${cookieStoreId}`)
				}
				return container
			})
		},
		tabs: {
			TAB_ID_NONE: -1,
			create: vi.fn().mockResolvedValue(undefined),
			remove: vi.fn().mockResolvedValue(undefined),
			get: vi.fn().mockImplementation(async (tabId: number) => {
				return tabs.find(t => t.id === tabId) ?? { id: tabId, index: 0 }
			}),
			query: vi.fn().mockResolvedValue(tabs),
			highlight: vi.fn().mockResolvedValue(undefined),
			onActivated: {
				addListener: vi.fn()
			},
			onUpdated: {
				addListener: vi.fn()
			}
		},
		notifications: {
			create: vi.fn().mockResolvedValue('notification-id')
		},
		pageAction: {
			show: vi.fn().mockResolvedValue(undefined),
			hide: vi.fn().mockResolvedValue(undefined),
			onClicked: {
				addListener: vi.fn()
			}
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
				get: vi.fn().mockImplementation(extensionStorage.get.bind(extensionStorage)),
				set: vi.fn().mockImplementation(extensionStorage.set.bind(extensionStorage))
			}
		}
	}
}

describe('background helpers', () => {
	/**
	 * Why this matters: URL parsing is the contract boundary for every bookmark operation.
	 * A regression here breaks assignment, migration, and open-in-container flows globally.
	 */
	it('parses tokenized bookmark urls', () => {
		expect(parseBookmarkUrl('about:token-123:7:https://example.com')).toEqual({
			url: 'https://example.com',
			token: 'token-123',
			containerIndex: 7
		})
		expect(parseBookmarkUrl('https://example.com#cm:token-123:7')).toEqual({
			url: 'https://example.com',
			token: 'token-123',
			containerIndex: 7
		})
	})

	/**
	 * Why this matters: tab interception must only trigger for valid containMarks URLs.
	 * This prevents false positives on normal browsing URLs and malformed tokens.
	 */
	it('detects containmarks bookmark urls', () => {
		expect(isPrefixedUrl('about:token-123:7:https://example.com')).toBe(true)
		expect(isPrefixedUrl('about:short:7:https://example.com')).toBe(false)
		expect(isPrefixedUrl('https://example.com')).toBe(false)
		expect(isPrefixedUrl('https://example.com#cm:token-123:7')).toBe(true)
		expect(isPrefixedUrl('https://example.com#cm:short:7')).toBe(false)
	})
})

describe('BackgroundApp', () => {
	let storage: MemoryStorage
	let browserApi: BrowserApi
	let logger: LoggerLike

	beforeEach(() => {
		storage = new MemoryStorage()
		logger = { log: vi.fn() }
		browserApi = createBrowserMock({
			bookmarkById: {
				'bookmark-1': {
					id: 'bookmark-1',
					type: 'bookmark',
					url: 'https://example.com#cm:token-123:0'
				}
			},
			containers: [
				{
					name: 'Work',
					cookieStoreId: 'firefox-container-1',
					icon: 'briefcase',
					color: 'blue',
					colorCode: '#0000ff',
					iconUrl: 'resource://usercontext-content/briefcase.svg'
				}
			]
		})
	})

	/**
	 * Why this matters: assigned bookmarks must preserve encoded container identity
	 * while rotating token-compatible URLs during maintenance operations.
	 */
	it('refreshes bookmarks with mapped URL format', async () => {
		const syncFolder = await browserApi.bookmarks.create({
			parentId: 'menu________',
			type: 'folder',
			title: 'ContainMarks Sync'
		})
		await browserApi.bookmarks.create({
			parentId: syncFolder.id,
			title: 'Mapping: Work',
			url: 'about:0:firefox-container-1:Work'
		})

		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)
		await app.startup()

		const refreshed = await app.ensureBookmarkContainerUrl({
			id: 'bookmark-1',
			type: 'bookmark',
			url: 'https://example.com#cm:token-123:0'
		})

		expect(refreshed?.token).toBeTruthy()
		expect(browserApi.bookmarks.update).toHaveBeenCalledWith(
			'bookmark-1',
			expect.objectContaining({ url: expect.stringMatching(/^https:\/\/example\.com#cm:[^:]+:\d+$/) })
		)
	})

	/**
	 * Why this matters: runtime behavior must open encoded bookmarks in their mapped container,
	 * or users can silently land in the wrong identity context.
	 */
	it('opens matching bookmarks in their assigned container', async () => {
		const syncFolder = await browserApi.bookmarks.create({
			parentId: 'menu________',
			type: 'folder',
			title: 'ContainMarks Sync'
		})
		await browserApi.bookmarks.create({
			parentId: syncFolder.id,
			title: 'Mapping: Work',
			url: 'about:0:firefox-container-1:Work'
		})
		const app = new BackgroundApp(browserApi, storage, logger, () => 0.75)
		await app.startup()

		await app.handleTabUpdated(
			7,
			{ status: 'complete', url: 'https://example.com#cm:token-123:0' },
			{ id: 7, index: 2, url: 'https://example.com#cm:token-123:0' }
		)

		expect(browserApi.tabs.create).toHaveBeenCalledWith({
			cookieStoreId: 'firefox-container-1',
			url: 'https://example.com',
			index: 3
		})
		expect(browserApi.tabs.remove).toHaveBeenCalledWith(7)
		expect(browserApi.notifications.create).not.toHaveBeenCalled()
	})

	/**
	 * Why this matters: sync behavior must not depend on local token stores,
	 * otherwise bookmarks transferred across devices lose correct container routing.
	 */
	it('opens synced bookmarks using container mapping cache without local token storage', async () => {
		const syncedUrl = 'https://example.com#cm:sync-token:0'
		const syncedBookmark: BookmarkNode = {
			id: 'bookmark-sync-1',
			type: 'bookmark',
			url: syncedUrl
		}
		browserApi = createBrowserMock({
			bookmarkById: {
				'bookmark-sync-1': syncedBookmark
			},
			bookmarkByUrl: {
				[syncedUrl]: [syncedBookmark]
			},
			containers: [
				{
					name: 'Work',
					cookieStoreId: 'firefox-container-1',
					icon: 'briefcase',
					color: 'blue',
					colorCode: '#0000ff',
					iconUrl: 'resource://usercontext-content/briefcase.svg'
				}
			]
		})
		const syncFolder = await browserApi.bookmarks.create({
			parentId: 'menu________',
			type: 'folder',
			title: 'ContainMarks Sync'
		})
		await browserApi.bookmarks.create({
			parentId: syncFolder.id,
			title: 'Mapping: Work',
			url: 'about:0:firefox-container-1:Work'
		})

		const app = new BackgroundApp(browserApi, storage, logger, () => 0.75)
		await app.startup()

		await app.handleTabUpdated(
			4,
			{ status: 'complete', url: syncedUrl },
			{ id: 4, index: 2, url: syncedUrl }
		)

		expect(browserApi.tabs.create).toHaveBeenCalledWith({
			cookieStoreId: 'firefox-container-1',
			url: 'https://example.com',
			index: 3
		})
		expect(browserApi.notifications.create).not.toHaveBeenCalled()
	})

	/**
	 * Why this matters: page-action bookmarking is a primary user path,
	 * and must create a bookmark that is immediately container-mapped when possible.
	 */
	it('creates page-action bookmark and maps it', async () => {
		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)
		await app.startup()

		await app.handlePageActionClicked({
			id: 22,
			index: 0,
			title: 'Example title',
			url: 'https://example.com',
			cookieStoreId: 'firefox-container-1'
		})

		expect(browserApi.bookmarks.create).toHaveBeenCalledWith(
			expect.objectContaining({ url: 'https://example.com' })
		)
		expect(browserApi.bookmarks.update).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				url: expect.stringMatching(/^https:\/\/example\.com#cm:[^:]+:\d+$/)
			})
		)
	})

	/**
	 * Why this matters: radio menu UX must reflect current assignment state,
	 * so users can trust which container is currently active for a bookmark.
	 * Only the current assignment state is a radio button. The menu UI doesn't handle both well.
	 */
	it('renders bookmark container choices as radios with checked prior assignment', async () => {
		browserApi = createBrowserMock({
			bookmarkById: {
				'bookmark-radio-1': {
					id: 'bookmark-radio-1',
					type: 'bookmark',
					url: 'https://example.com#cm:token-123:0'
				}
			},
			containers: [
				{
					name: 'Work',
					cookieStoreId: 'firefox-container-1',
					icon: 'briefcase',
					color: 'blue',
					colorCode: '#0000ff',
					iconUrl: 'resource://usercontext-content/briefcase.svg'
				}
			]
		})

		const syncFolder = await browserApi.bookmarks.create({
			parentId: 'menu________',
			type: 'folder',
			title: 'ContainMarks Sync'
		})
		await browserApi.bookmarks.create({
			parentId: syncFolder.id,
			title: 'Mapping: Work',
			url: 'about:0:firefox-container-1:Work'
		})

		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)
		await app.startup()
		await app.handleMenuShown({ contexts: ['bookmark'], bookmarkId: 'bookmark-radio-1' })

		expect(browserApi.menus.create).toHaveBeenCalledWith(
			expect.objectContaining({
				id: NO_CONTAINER
			})
		)
		expect(browserApi.menus.create).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'firefox-container-1',
				type: 'radio',
				checked: true
			})
		)
	})

	/**
	 * Why this matters: folder actions are bulk operations and should not imply single-choice state.
	 * Keeping non-radio presentation avoids misleading selection semantics.
	 */
	it('keeps folder container choices as non-radio items', async () => {
		browserApi = createBrowserMock({
			bookmarkById: {
				'folder-1': {
					id: 'folder-1',
					type: 'folder',
					title: 'Folder'
				}
			},
			containers: [
				{
					name: 'Work',
					cookieStoreId: 'firefox-container-1',
					icon: 'briefcase',
					color: 'blue',
					colorCode: '#0000ff',
					iconUrl: 'resource://usercontext-content/briefcase.svg'
				}
			]
		})

		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)
		await app.startup()
		await app.handleMenuShown({ contexts: ['bookmark'], bookmarkId: 'folder-1' })

		const menuCreateCalls = (browserApi.menus.create as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls
		const noContainerCall = menuCreateCalls
			.map((entry) => entry[0])
			.find((details) => details.id === NO_CONTAINER)
		const mappedContainerCall = menuCreateCalls
			.map((entry) => entry[0])
			.find((details) => details.id === 'firefox-container-1')

		expect(noContainerCall).toBeTruthy()
		expect(mappedContainerCall).toBeTruthy()
		expect(noContainerCall?.type).toBeUndefined()
		expect(mappedContainerCall?.type).toBeUndefined()
	})

	/**
	 * Why this matters: page-action must degrade safely for default (non-container) tabs.
	 * This preserves core bookmarking functionality even when no container is present.
	 */
	it('creates a plain page-action bookmark when tab has no container', async () => {
		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)
		await app.startup()

		await app.handlePageActionClicked({
			id: 24,
			index: 0,
			title: 'Uncontained tab',
			url: 'https://example.com/plain'
		})

		expect(browserApi.bookmarks.create).toHaveBeenCalledWith(
			expect.objectContaining({ url: 'https://example.com/plain' })
		)
		expect(browserApi.bookmarks.update).not.toHaveBeenCalled()
	})

	/**
	 * Why this matters: missing mapping data should never silently strip encoded URLs.
	 * This guards against destructive rewrites when sync state is incomplete.
	 */
	it('does not strip encoded url when mapping is missing', async () => {
		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)
		await app.startup()

		const updateMock = browserApi.bookmarks.update as unknown as { mock: { calls: unknown[] } }
		const beforeCallCount = updateMock.mock.calls.length
		const result = await app.ensureBookmarkContainerUrl({
			id: 'bookmark-1',
			type: 'bookmark',
			url: 'https://example.com#cm:token-123:0'
		})

		expect(result).toBeNull()
		expect(updateMock.mock.calls.length).toBe(beforeCallCount)
	})

	it('hides page-action button when setting disables it', async () => {
		await browserApi.storage.local.set({
			'containMarks.settings': {
				targetFolderId: 'toolbar_____',
				resetTokensOnStartup: false,
				regenerateTokenOnEveryUse: true,
				acknowledgeRiskyTokenBehavior: false,
				showPageActionButton: false,
				enableBookmarkSync: true
			}
		})

		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)
		await app.handleTabUpdated(22, { status: 'complete', url: 'https://example.com' }, { id: 22, index: 0, url: 'https://example.com' })

		expect(browserApi.pageAction.hide).toHaveBeenCalledWith(22)
	})

	it('ignores page-action clicks when setting disables button', async () => {
		await browserApi.storage.local.set({
			'containMarks.settings': {
				targetFolderId: 'toolbar_____',
				resetTokensOnStartup: false,
				regenerateTokenOnEveryUse: true,
				acknowledgeRiskyTokenBehavior: false,
				showPageActionButton: false,
				enableBookmarkSync: true
			}
		})

		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)
		await app.handlePageActionClicked({
			id: 23,
			index: 0,
			title: 'Should not create bookmark',
			url: 'https://example.com/no-op',
			cookieStoreId: 'firefox-container-1'
		})

		expect(browserApi.bookmarks.create).not.toHaveBeenCalled()
	})

	it('keeps mappings local when bookmark sync is disabled', async () => {
		await browserApi.storage.local.set({
			'containMarks.settings': {
				targetFolderId: 'toolbar_____',
				resetTokensOnStartup: false,
				regenerateTokenOnEveryUse: true,
				acknowledgeRiskyTokenBehavior: false,
				showPageActionButton: true,
				enableBookmarkSync: false
			}
		})

		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)
		await app.startup()
		await app.handlePageActionClicked({
			id: 25,
			index: 0,
			title: 'Local mapping mode',
			url: 'https://example.com/local-only',
			cookieStoreId: 'firefox-container-1'
		})

		expect(browserApi.bookmarks.create).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: 'folder', title: 'ContainMarks Sync' })
		)
		expect(browserApi.bookmarks.update).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				url: expect.stringMatching(/^https:\/\/example\.com\/local-only#cm:[^:]+:\d+$/)
			})
		)
	})

	it('refreshes page-action visibility when user switches tabs', async () => {
		await browserApi.storage.local.set({
			'containMarks.settings': {
				targetFolderId: 'toolbar_____',
				resetTokensOnStartup: false,
				regenerateTokenOnEveryUse: true,
				acknowledgeRiskyTokenBehavior: false,
				showPageActionButton: false,
				enableBookmarkSync: true
			}
		})

		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)
		await app.handleTabActivated({ tabId: 31 })

		expect(browserApi.pageAction.hide).toHaveBeenCalledWith(31)
	})
})