import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	BackgroundApp,
	NO_CONTAINER,
	getNewUrl,
	isFragmentEncodedUrl,
	isPrefixedUrl,
	parseBookmarkUrl
} from '../src/backgroundApp'
import { decodeToRealUrl } from '../src/containerMappings'
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
	tabs?: Array<{ id: number, index: number, url?: string, cookieStoreId?: string, windowId?: number }>
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
			},
			onCreated: {
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
			},
			onCreated: {
				addListener: vi.fn()
			}
		},
		windows: {
			onCreated: {
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

	it('preserves original fragments through encode/decode round-trip', () => {
		const encoded = getNewUrl({ value: 'testtoken' }, 0, 'https://example.com/page#section')
		expect(encoded).toBe('https://example.com/page#cm:testtoken:0#section')

		const parsed = parseBookmarkUrl(encoded)
		expect(parsed).toEqual({
			url: 'https://example.com/page#section',
			token: 'testtoken',
			containerIndex: 0
		})

		const decoded = decodeToRealUrl(encoded)
		expect(decoded).toBe('https://example.com/page#section')
	})

	it('handles URLs with no pre-existing fragment', () => {
		const encoded = getNewUrl({ value: 'testtoken' }, 3, 'https://example.com')
		expect(encoded).toBe('https://example.com#cm:testtoken:3')

		const decoded = decodeToRealUrl(encoded)
		expect(decoded).toBe('https://example.com')
	})

	it('prevents double fragment encoding', () => {
		const firstEncode = getNewUrl({ value: 'firsttok' }, 0, 'https://example.com')
		expect(firstEncode).toBe('https://example.com#cm:firsttok:0')

		// Passing an already-encoded URL to getNewUrl must not double-encode
		const secondEncode = getNewUrl({ value: 'secondtk' }, 1, firstEncode)
		expect(secondEncode).toBe('https://example.com#cm:secondtk:1')
		expect(secondEncode).not.toContain('#cm:firsttok')
	})

	it('prevents double encoding when original URL has a fragment', () => {
		const firstEncode = getNewUrl({ value: 'firsttok' }, 0, 'https://example.com/page#section')
		expect(firstEncode).toBe('https://example.com/page#cm:firsttok:0#section')

		const secondEncode = getNewUrl({ value: 'secondtk' }, 2, firstEncode)
		expect(secondEncode).toBe('https://example.com/page#cm:secondtk:2#section')
		expect(secondEncode).not.toContain('#cm:firsttok')
	})

	it('identifies fragment-encoded vs plain URLs', () => {
		expect(isFragmentEncodedUrl('https://example.com#cm:token-123:0')).toBe(true)
		expect(isFragmentEncodedUrl('https://example.com#cm:token-123:0#section')).toBe(true)
		expect(isFragmentEncodedUrl('https://example.com#section')).toBe(false)
		expect(isFragmentEncodedUrl('https://example.com')).toBe(false)
		expect(isFragmentEncodedUrl('about:token-123:0:https://example.com')).toBe(false)
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

		const refreshed = await app.updateBookmarkContainerUrl({
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
		const result = await app.updateBookmarkContainerUrl({
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

	/**
	 * Why this matters: prevents a malicious page or shared link from injecting a container
	 * assignment. A URL like `https://evil.com#cm:token:0` bookmarked by the user should
	 * have its encoding stripped since no existing bookmark has that exact URL.
	 */
	it('strips fragment encoding from newly-created bookmarks without duplicates', async () => {
		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)

		await app.handleBookmarkCreated('new-bookmark', {
			id: 'new-bookmark',
			type: 'bookmark',
			url: 'https://evil.com#cm:injected:0'
		})

		expect(browserApi.bookmarks.update).toHaveBeenCalledWith(
			'new-bookmark',
			{ url: 'https://evil.com' }
		)
	})

	it('preserves fragment encoding when a duplicate bookmark exists', async () => {
		const encodedUrl = 'https://example.com#cm:token-123:0'
		browserApi = createBrowserMock({
			bookmarkById: {
				'existing-1': { id: 'existing-1', type: 'bookmark', url: encodedUrl }
			},
			containers: [{ cookieStoreId: 'firefox-container-1', name: 'Work', icon: 'fingerprint', color: 'blue' }]
		})

		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)

		// Create a duplicate bookmark with the same encoded URL
		await app.handleBookmarkCreated('copy-1', {
			id: 'copy-1',
			type: 'bookmark',
			url: encodedUrl
		})

		// Should NOT strip — a duplicate with the same URL already exists
		expect(browserApi.bookmarks.update).not.toHaveBeenCalled()
	})

	it('skips strip when allowEncodedBookmarkImport is enabled', async () => {
		await browserApi.storage.local.set({
			'containMarks.settings': {
				targetFolderId: 'toolbar_____',
				resetTokensOnStartup: false,
				regenerateTokenOnEveryUse: true,
				acknowledgeRiskyTokenBehavior: true,
				allowEncodedBookmarkImport: true,
				showPageActionButton: true,
				enableBookmarkSync: true
			}
		})

		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)

		await app.handleBookmarkCreated('imported-1', {
			id: 'imported-1',
			type: 'bookmark',
			url: 'https://example.com#cm:import-t:0'
		})

		expect(browserApi.bookmarks.update).not.toHaveBeenCalled()
	})

	it('auto-reverts allowEncodedBookmarkImport on startup', async () => {
		await browserApi.storage.local.set({
			'containMarks.settings': {
				targetFolderId: 'toolbar_____',
				resetTokensOnStartup: false,
				regenerateTokenOnEveryUse: true,
				acknowledgeRiskyTokenBehavior: true,
				allowEncodedBookmarkImport: true,
				showPageActionButton: true,
				enableBookmarkSync: true
			}
		})

		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)
		await app.startup()

		// The setting should have been persisted as false via saveSettings
		const settingsRaw = await browserApi.storage.local.get(['containMarks.settings'])
		const savedSettings = settingsRaw['containMarks.settings'] as Record<string, unknown>
		expect(savedSettings.allowEncodedBookmarkImport).toBe(false)
	})

	/**
	 * Why this matters: the user opens Properties (hotswap decodes URL), walks away, comes back
	 * and saves an edit. The revert timer has already fired by then. Without pendingEditBookmark,
	 * the edit would persist as a clean URL — losing the container assignment silently.
	 */
	it('re-encodes late bookmark edits via pendingEditBookmark fallback', async () => {
		vi.useFakeTimers()
		const encodedUrl = 'https://example.com#cm:token-123:0'
		browserApi = createBrowserMock({
			bookmarkById: {
				'bm-1': { id: 'bm-1', type: 'bookmark', url: encodedUrl }
			},
			containers: [{ cookieStoreId: 'firefox-container-1', name: 'Work', icon: 'fingerprint', color: 'blue' }]
		})

		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)

		// 1. Menu shown → hotswap (sets pendingEditBookmark)
		await app.handleMenuShown({ contexts: ['bookmark'], bookmarkId: 'bm-1' })

		// 2. Menu hidden → starts revert timer
		await app.handleMenuHidden()

		// 3. Consume the self-update from the hotswap decode
		await app.handleBookmarkChanged('bm-1', { url: 'https://example.com' })

		// 4. Advance past HOTSWAP_REVERT_DELAY_MS to fire the revert and flush its async chain
		await vi.advanceTimersByTimeAsync(3000)

		// 5. Consume the self-update from the revert (restores encoded URL)
		await app.handleBookmarkChanged('bm-1', { url: encodedUrl })

		// 6. User saves a late edit after the revert has completed
		await app.handleBookmarkChanged('bm-1', { url: 'https://example.com/edited' })

		// Should find a bookmarks.update call that re-encodes the edited URL with container 0
		const updateCalls = (browserApi.bookmarks.update as ReturnType<typeof vi.fn>).mock.calls
		const editedCall = updateCalls.find(
			(call: unknown[]) => {
				const url = (call[1] as Record<string, string>)?.url
				return call[0] === 'bm-1' && typeof url === 'string' && url.includes('/edited')
			}
		)
		expect(editedCall).toBeTruthy()
		expect((editedCall![1] as Record<string, string>).url).toMatch(/^https:\/\/example\.com\/edited#cm:[^:]+:0$/)

		vi.useRealTimers()
	})

	/**
	 * Why this matters: clicking "Open in New Tab" from a bookmark's context menu opens the
	 * decoded URL in the default container (because the bookmark is hotswapped). Without this
	 * interception, the page loads without the correct container assignment.
	 */
	it('intercepts new tabs with hotswapped decoded URLs', async () => {
		const encodedUrl = 'https://example.com#cm:token-123:0'
		browserApi = createBrowserMock({
			bookmarkById: {
				'bm-1': { id: 'bm-1', type: 'bookmark', url: encodedUrl }
			},
			bookmarkByUrl: {
				[encodedUrl]: [{ id: 'bm-1', type: 'bookmark', url: encodedUrl } as BookmarkNode]
			},
			containers: [{ cookieStoreId: 'firefox-container-1', name: 'Work', icon: 'fingerprint', color: 'blue' }]
		})

		// Set up container mapping so mappingStore.getByIndex(0) resolves
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

		// 1. Menu shown → hotswap
		await app.handleMenuShown({ contexts: ['bookmark'], bookmarkId: 'bm-1' })

		// 2. Menu hidden → registers pending hotswap URLs
		await app.handleMenuHidden()

		// 3. Firefox opens "Open in New Tab" with decoded URL in default container
		await app.handleTabCreated({
			id: 42,
			url: 'https://example.com',
			index: 1,
			cookieStoreId: 'firefox-default'
		})

		// Should create a new tab in the correct container
		expect(browserApi.tabs.create).toHaveBeenCalledWith(
			expect.objectContaining({
				cookieStoreId: 'firefox-container-1',
				url: 'https://example.com'
			})
		)
		// And remove the original tab
		expect(browserApi.tabs.remove).toHaveBeenCalledWith(42)
	})

	it('ignores new tabs already in the target container during hotswap window', async () => {
		const encodedUrl = 'https://example.com#cm:token-123:0'
		browserApi = createBrowserMock({
			bookmarkById: {
				'bm-1': { id: 'bm-1', type: 'bookmark', url: encodedUrl }
			},
			containers: [{ cookieStoreId: 'firefox-container-1', name: 'Work', icon: 'fingerprint', color: 'blue' }]
		})

		const app = new BackgroundApp(browserApi, storage, logger, () => 0.5)

		await app.handleMenuShown({ contexts: ['bookmark'], bookmarkId: 'bm-1' })
		await app.handleMenuHidden()

		// Tab already in the TARGET container — no redirect needed
		await app.handleTabCreated({
			id: 43,
			url: 'https://example.com',
			index: 1,
			cookieStoreId: 'firefox-container-1'
		})

		expect(browserApi.tabs.create).not.toHaveBeenCalled()
		expect(browserApi.tabs.remove).not.toHaveBeenCalled()
	})

	/**
	 * "Open in New Window" creates a new browser window with a tab navigating to the decoded
	 * URL. The windows.onCreated handler queries tabs in the new window and redirects matches
	 * to the correct container.
	 */
	it('intercepts Open in New Window during hotswap via handleWindowCreated', async () => {
		const encodedUrl = 'https://example.com#cm:token-123:0'
		browserApi = createBrowserMock({
			bookmarkById: {
				'bm-1': { id: 'bm-1', type: 'bookmark', url: encodedUrl }
			},
			bookmarkByUrl: {
				[encodedUrl]: [{ id: 'bm-1', type: 'bookmark', url: encodedUrl } as BookmarkNode]
			},
			containers: [{ cookieStoreId: 'firefox-container-1', name: 'Work', icon: 'fingerprint', color: 'blue' }]
		})

		// Set up container mapping store
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

		// Menu shown → hotswap
		await app.handleMenuShown({ contexts: ['bookmark'], bookmarkId: 'bm-1' })
		await app.handleMenuHidden()

		// Simulate tabs.query returning the new window's tab with the decoded URL
		;(browserApi.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			{ id: 99, url: 'https://example.com', index: 0, cookieStoreId: 'firefox-default' }
		])

		// Firefox creates a new window with the decoded URL
		await app.handleWindowCreated({ id: 10 })

		expect(browserApi.tabs.create).toHaveBeenCalledWith(
			expect.objectContaining({
				cookieStoreId: 'firefox-container-1',
				url: 'https://example.com'
			})
		)
		expect(browserApi.tabs.remove).toHaveBeenCalledWith(99)
	})

	/**
	 * When "Open in New Tab/Window" fires during a hotswap, all tab-level events initially
	 * see `about:blank`. The `webNavigation.onBeforeNavigate` handler is the first event that
	 * receives the actual URL, so the hotswap redirect is triggered there.
	 */
	it('redirects via handleBeforeNavigate when decoded URL is navigated during hotswap', async () => {
		const encodedUrl = 'https://example.com#cm:token-123:0'
		browserApi = createBrowserMock({
			bookmarkById: {
				'bm-1': { id: 'bm-1', type: 'bookmark', url: encodedUrl }
			},
			bookmarkByUrl: {
				[encodedUrl]: [{ id: 'bm-1', type: 'bookmark', url: encodedUrl } as BookmarkNode]
			},
			containers: [{ cookieStoreId: 'firefox-container-1', name: 'Work', icon: 'fingerprint', color: 'blue' }],
			tabs: [{ id: 55, url: 'about:blank', index: 0, cookieStoreId: 'firefox-default' }]
		})

		// Set up container mapping store
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

		// Menu shown → hotswap populates pendingHotswapUrls
		await app.handleMenuShown({ contexts: ['bookmark'], bookmarkId: 'bm-1' })
		await app.handleMenuHidden()

		// webNavigation.onBeforeNavigate fires with the actual decoded URL
		app.handleBeforeNavigate({ tabId: 55, url: 'https://example.com', frameId: 0 })

		// Allow the async fire-and-forget redirect to complete
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(browserApi.tabs.create).toHaveBeenCalledWith(
			expect.objectContaining({
				cookieStoreId: 'firefox-container-1',
				url: 'https://example.com'
			})
		)
		expect(browserApi.tabs.remove).toHaveBeenCalledWith(55)
	})
})