import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	BackgroundApp,
	NO_CONTAINER,
	getNewUrl,
	isFragmentEncodedUrl,
	isPrefixedUrl,
	parseBookmarkUrl,
	parseLegacyBookmarkUrl
} from '../src/constants'
import { decodeToRealUrl } from '../src/urlCodec'
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
			update: vi.fn().mockImplementation(async (tabId: number) => {
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
			isShown: vi.fn().mockResolvedValue(false),
			setTitle: vi.fn().mockResolvedValue(undefined),
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
		management: {
			get: vi.fn().mockRejectedValue(new Error('Extension not found'))
		},
		runtime: {
			sendMessage: vi.fn().mockResolvedValue(undefined)
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
	it('parses v1.2.0 fragment-encoded bookmark urls', () => {
		expect(parseBookmarkUrl('https://example.com#cm:token-123:7')).toEqual({
			url: 'https://example.com',
			token: 'token-123',
			containerIndex: 7
		})
	})

	it('does not parse legacy about: urls at runtime (security boundary)', () => {
		// parseBookmarkUrl only handles v1.2.0 — legacy formats are ignored to prevent
		// attacker-crafted legacy URLs from being interpreted as container assignments.
		const parsed = parseBookmarkUrl('about:token-123:7:https://example.com')
		expect(parsed?.containerIndex).toBeNull()
		expect(parsed?.token).toBe('')
	})

	it('parses legacy urls via parseLegacyBookmarkUrl (startup migration only)', () => {
		expect(parseLegacyBookmarkUrl('about:token-123:7:https://example.com')).toEqual({
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
		// isPrefixedUrl only matches v1.2.0 at runtime
		expect(isPrefixedUrl('about:token-123:7:https://example.com')).toBe(false)
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
})