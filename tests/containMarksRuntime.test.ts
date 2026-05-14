import { describe, it, expect, vi } from 'vitest'
import { ContainMarksRuntimeImpl } from '../src/background/containMarksRuntime'
import type {
	BookmarkNode,
	BrowserApi,
	ContainMarksSettings,
	MenusOnClickInfo,
	MenusOnShownInfo,
	StorageLike,
	Tab,
	Window,
} from '../src/models'
import { HOTSWAP_STORAGE_KEY, NO_CONTAINER, TEMP_CONTAINER_SENTINEL } from '../src/constants'
import { getNewUrl, isFragmentEncodedUrl, parseBookmarkUrl } from '../src/urlCodec'
import { SETTINGS_STORAGE_KEY } from '../src/preferences/settings'
import { LOCAL_MAPPING_STORAGE_KEY } from '../src/mappings/containerMappings'

type MenuShownListener = (info: MenusOnShownInfo) => void | Promise<void>
type MenuClickListener = (info: MenusOnClickInfo) => void | Promise<void>
type MenuHiddenListener = () => void | Promise<void>
type BookmarkChangedListener = (id: string, changeInfo: { url?: string; title?: string }) => void | Promise<void>
type BookmarkCreatedListener = (id: string, bookmark: BookmarkNode) => void | Promise<void>
type TabUpdatedListener = (tabId: number, changeInfo: { status?: string; url?: string }, tab: Tab) => void | Promise<void>
type TabActivatedListener = (activeInfo: { tabId: number }) => void | Promise<void>
type TabCreatedListener = (tab: Tab) => void | Promise<void>
type WindowCreatedListener = (window: Window) => void | Promise<void>
type BeforeNavigateListener = (details: { tabId: number; url: string; frameId: number }) => void | Promise<void>
type BeforeRequestListener = (details: { requestId: string; tabId: number; url: string; type: string }) => { cancel?: boolean } | void

interface RuntimeHarness {
	browserApi: BrowserApi
	bookmark: BookmarkNode
	menuShownListeners: MenuShownListener[]
	menuClickListeners: MenuClickListener[]
	menuHiddenListeners: MenuHiddenListener[]
	beforeNavigateListeners: BeforeNavigateListener[]
	beforeRequestListeners: BeforeRequestListener[]
}

interface RuntimeHarnessOptions {
	localMappings?: Array<{ firstSeenIndex: number; cookieStoreId: string; backupName: string }>
	tabsInWindow?: Tab[]
}

function flushMicrotasks(rounds = 4): Promise<void> {
	let chain = Promise.resolve()
	for (let i = 0; i < rounds; i++) {
		chain = chain.then(() => Promise.resolve())
	}
	return chain
}

function defaultSettings(overrides: Partial<ContainMarksSettings> = {}): ContainMarksSettings {
	return {
		targetFolderId: 'toolbar_____',
		resetTokensOnStartup: false,
		regenerateTokenOnEveryUse: true,
		acknowledgeRiskyTokenBehavior: false,
		showPageActionButton: true,
		enableBookmarkSync: false,
		allowEncodedBookmarkImport: false,
		...overrides,
	}
}

function createRuntimeHarness(initialBookmarkUrl: string, options: RuntimeHarnessOptions = {}): RuntimeHarness {
	const bookmark: BookmarkNode = {
		id: 'bm1',
		type: 'bookmark',
		title: 'Example bookmark',
		url: initialBookmarkUrl,
		index: 0,
		parentId: 'toolbar_____',
	}

	const menuShownListeners: MenuShownListener[] = []
	const menuClickListeners: MenuClickListener[] = []
	const menuHiddenListeners: MenuHiddenListener[] = []
	const bookmarkChangedListeners: BookmarkChangedListener[] = []
	const bookmarkCreatedListeners: BookmarkCreatedListener[] = []
	const tabUpdatedListeners: TabUpdatedListener[] = []
	const tabActivatedListeners: TabActivatedListener[] = []
	const tabCreatedListeners: TabCreatedListener[] = []
	const windowCreatedListeners: WindowCreatedListener[] = []
	const beforeNavigateListeners: BeforeNavigateListener[] = []
	const beforeRequestListeners: BeforeRequestListener[] = []

	const identities = [
		{ cookieStoreId: 'firefox-container-1', name: 'Personal', icon: 'circle' as const, color: 'blue' as const },
		{ cookieStoreId: 'firefox-container-2', name: 'Work', icon: 'briefcase' as const, color: 'orange' as const },
	]

	const storageState: Record<string, unknown> = {
		[SETTINGS_STORAGE_KEY]: defaultSettings(),
		[HOTSWAP_STORAGE_KEY]: {},
		[LOCAL_MAPPING_STORAGE_KEY]: options.localMappings ?? [],
	}
	const tabsInWindow = options.tabsInWindow ?? [{ id: 1, index: 0, url: 'https://example.com', windowId: 1 }]

	let createdCounter = 0
	const createdBookmarksById = new Map<string, BookmarkNode>()

	const browserApi: BrowserApi = {
		bookmarks: {
			search: vi.fn().mockImplementation(async (query: { query?: string; url?: string; title?: string } | string) => {
				if (typeof query === 'string') {
					return bookmark.url === query ? [{ ...bookmark }] : []
				}
				if (query.title || query.query || query.url) return []
				return []
			}),
			get: vi.fn().mockImplementation(async (id: string) => {
				if (id === bookmark.id) return [{ ...bookmark }]
				const created = createdBookmarksById.get(id)
				return created ? [{ ...created }] : []
			}),
			getTree: vi.fn().mockResolvedValue([]),
			getChildren: vi.fn().mockImplementation(async (id: string) => {
				return [...createdBookmarksById.values()].filter(node => node.parentId === id)
			}),
			remove: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockImplementation(async (id: string, changes: { url?: string; title?: string }) => {
				const target = id === bookmark.id ? bookmark : createdBookmarksById.get(id)
				if (!target) throw new Error(`Bookmark not found: ${id}`)

				if (changes.url !== undefined) {
					target.url = changes.url
					for (const listener of bookmarkChangedListeners) {
						await listener(id, { url: changes.url })
					}
				}
				if (changes.title !== undefined) {
					target.title = changes.title
					for (const listener of bookmarkChangedListeners) {
						await listener(id, { title: changes.title })
					}
				}

				return { ...target }
			}),
			create: vi.fn().mockImplementation(async (details: {
				parentId: string
				index?: number
				title: string
				url?: string
				type?: 'folder'
			}) => {
				createdCounter += 1
				const created: BookmarkNode = {
					id: `created-${createdCounter}`,
					type: details.type === 'folder' ? 'folder' : 'bookmark',
					parentId: details.parentId,
					title: details.title,
					url: details.url ?? '',
					index: details.index ?? 0,
				}
				createdBookmarksById.set(created.id, created)
				for (const listener of bookmarkCreatedListeners) {
					await listener(created.id, { ...created })
				}
				return { ...created }
			}),
			onRemoved: { addListener: vi.fn() },
			onChanged: {
				addListener: vi.fn().mockImplementation((listener: BookmarkChangedListener) => {
					bookmarkChangedListeners.push(listener)
				}),
			},
			onCreated: {
				addListener: vi.fn().mockImplementation((listener: BookmarkCreatedListener) => {
					bookmarkCreatedListeners.push(listener)
				}),
			},
		},
		menus: {
			create: vi.fn(),
			refresh: vi.fn(),
			removeAll: vi.fn(),
			onClicked: {
				addListener: vi.fn().mockImplementation((listener: MenuClickListener) => {
					menuClickListeners.push(listener)
				}),
			},
			onShown: {
				addListener: vi.fn().mockImplementation((listener: MenuShownListener) => {
					menuShownListeners.push(listener)
				}),
			},
			onHidden: {
				addListener: vi.fn().mockImplementation((listener: MenuHiddenListener) => {
					menuHiddenListeners.push(listener)
				}),
			},
		},
		contextualIdentities: {
			query: vi.fn().mockImplementation(async ({ name }: { name?: string }) => {
				if (!name) return identities
				return identities.filter(identity => identity.name === name)
			}),
			get: vi.fn().mockImplementation(async (cookieStoreId: string) => {
				const found = identities.find(identity => identity.cookieStoreId === cookieStoreId)
				if (!found) throw new Error(`Unknown identity ${cookieStoreId}`)
				return found
			}),
		},
		tabs: {
			TAB_ID_NONE: -1,
			create: vi.fn().mockResolvedValue({ id: 900, index: 1, url: 'https://example.com' }),
			remove: vi.fn().mockResolvedValue(undefined),
			get: vi.fn().mockResolvedValue({ id: 1, index: 0, url: 'https://example.com', windowId: 1 }),
			update: vi.fn().mockImplementation(async (tabId: number, props: { url?: string; loadReplace?: boolean }) => ({
				id: tabId,
				index: 0,
				url: props.url,
				windowId: 1,
			})),
			query: vi.fn().mockResolvedValue(tabsInWindow),
			highlight: vi.fn().mockResolvedValue(undefined),
			onActivated: {
				addListener: vi.fn().mockImplementation((listener: TabActivatedListener) => {
					tabActivatedListeners.push(listener)
				}),
			},
			onUpdated: {
				addListener: vi.fn().mockImplementation((listener: TabUpdatedListener) => {
					tabUpdatedListeners.push(listener)
				}),
			},
			onCreated: {
				addListener: vi.fn().mockImplementation((listener: TabCreatedListener) => {
					tabCreatedListeners.push(listener)
				}),
			},
		},
		windows: {
			onCreated: {
				addListener: vi.fn().mockImplementation((listener: WindowCreatedListener) => {
					windowCreatedListeners.push(listener)
				}),
			},
		},
		notifications: {
			create: vi.fn().mockResolvedValue('notification-id'),
		},
		pageAction: {
			isShown: vi.fn().mockResolvedValue(false),
			setTitle: vi.fn().mockResolvedValue(undefined),
			show: vi.fn().mockResolvedValue(undefined),
			hide: vi.fn().mockResolvedValue(undefined),
			onClicked: { addListener: vi.fn() },
		},
		webNavigation: {
			onBeforeNavigate: {
				addListener: vi.fn().mockImplementation((listener: BeforeNavigateListener) => {
					beforeNavigateListeners.push(listener)
				}),
			},
		},
		webRequest: {
			onBeforeRequest: {
				addListener: vi.fn().mockImplementation((listener: BeforeRequestListener) => {
					beforeRequestListeners.push(listener)
				}),
			},
		},
		management: {
			get: vi.fn().mockRejectedValue(new Error('Not installed')),
		},
		runtime: {
			sendMessage: vi.fn().mockResolvedValue(false),
		},
		storage: {
			local: {
				get: vi.fn().mockImplementation(async (keys?: string | string[] | Record<string, unknown> | null) => {
					if (keys == null) return { ...storageState }
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
					if (Array.isArray(keys)) {
						const payload: Record<string, unknown> = {}
						for (const key of keys) payload[key] = storageState[key]
						return payload
					}
					const payload: Record<string, unknown> = {}
					for (const [key, value] of Object.entries(keys)) {
						payload[key] = storageState[key] ?? value
					}
					return payload
				}),
				set: vi.fn().mockImplementation(async (items: Record<string, unknown>) => {
					Object.assign(storageState, items)
				}),
			},
		},
	}

	const runtime = new ContainMarksRuntimeImpl({
		browserApi,
		storage: {
			length: 0,
			key: () => null,
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
		} as StorageLike,
		logger: { log: vi.fn() },
		randomValue: () => 0.123456789,
	})

	runtime.initialize()

	return {
		browserApi,
		bookmark,
		menuShownListeners,
		menuClickListeners,
		menuHiddenListeners,
		beforeNavigateListeners,
		beforeRequestListeners,
	}
}

async function runMenuSequence(harness: RuntimeHarness, menuItemId: string): Promise<string> {
	expect(harness.menuShownListeners).toHaveLength(1)
	expect(harness.menuClickListeners).toHaveLength(1)
	expect(harness.menuHiddenListeners).toHaveLength(1)

	await harness.menuShownListeners[0]!({ contexts: ['bookmark'], bookmarkId: harness.bookmark.id })
	await flushMicrotasks()

	await harness.menuClickListeners[0]!({ bookmarkId: harness.bookmark.id, menuItemId })
	await flushMicrotasks()

	await harness.menuHiddenListeners[0]!()
	await flushMicrotasks()

	await vi.advanceTimersByTimeAsync(250)
	await flushMicrotasks()

	return harness.bookmark.url ?? ''
}

async function runStandardNavigationSequence(harness: RuntimeHarness, encodedUrl: string): Promise<void> {
	expect(harness.beforeNavigateListeners).toHaveLength(1)
	expect(harness.beforeRequestListeners).toHaveLength(1)

	await harness.beforeNavigateListeners[0]!({
		tabId: 1,
		url: encodedUrl,
		frameId: 0,
	})

	const result = harness.beforeRequestListeners[0]!({
		requestId: 'request-1',
		tabId: 1,
		url: encodedUrl,
		type: 'main_frame',
	})
	expect(result).toEqual({ cancel: true })

	await flushMicrotasks(8)
}

describe('ContainMarksRuntime hotswap inhibition on assignment actions', () => {
	it('does not apply stale hotswap when assigning to a different container', async () => {
		vi.useFakeTimers()
		try {
			const realUrl = 'https://example.com/article'
			const oldEncoded = getNewUrl({ value: 'oldtoken' }, 7, realUrl)
			const harness = createRuntimeHarness(oldEncoded)

			const finalUrl = await runMenuSequence(harness, 'firefox-container-2')

			const parsed = parseBookmarkUrl(finalUrl)
			expect(parsed).not.toBeNull()
			expect(parsed!.containerIndex).toBe(0)
			expect(finalUrl).not.toBe(oldEncoded)
		} finally {
			vi.useRealTimers()
		}
	})

	it('does not apply stale hotswap when unassigning from a container', async () => {
		vi.useFakeTimers()
		try {
			const realUrl = 'https://example.com/unassign'
			const oldEncoded = getNewUrl({ value: 'oldtoken' }, 3, realUrl)
			const harness = createRuntimeHarness(oldEncoded)

			const finalUrl = await runMenuSequence(harness, NO_CONTAINER)

			expect(finalUrl).toBe(realUrl)
			expect(isFragmentEncodedUrl(finalUrl)).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it('does not apply stale hotswap when assigning Temporary Container sentinel', async () => {
		vi.useFakeTimers()
		try {
			const realUrl = 'https://example.com/temp'
			const oldEncoded = getNewUrl({ value: 'oldtoken' }, 11, realUrl)
			const harness = createRuntimeHarness(oldEncoded)

			const finalUrl = await runMenuSequence(harness, TEMP_CONTAINER_SENTINEL)

			const parsed = parseBookmarkUrl(finalUrl)
			expect(parsed).not.toBeNull()
			expect(parsed!.containerIndex).toBe(0)
			expect(isFragmentEncodedUrl(finalUrl)).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('ContainMarksRuntime tab reopen ordering', () => {
	it('opens replacement tab before closing source when source window has only one tab', async () => {
		const realUrl = 'https://example.com/reopen-one-tab'
		const encodedUrl = getNewUrl({ value: 'tokenone' }, 0, realUrl)
		const harness = createRuntimeHarness(encodedUrl, {
			localMappings: [
				{ firstSeenIndex: 0, cookieStoreId: 'firefox-container-2', backupName: 'Work' },
			],
			tabsInWindow: [
				{ id: 1, index: 0, url: encodedUrl, windowId: 1 },
			],
		})

		await runStandardNavigationSequence(harness, encodedUrl)

		const createMock = harness.browserApi.tabs.create as ReturnType<typeof vi.fn>
		const removeMock = harness.browserApi.tabs.remove as ReturnType<typeof vi.fn>
		expect(createMock).toHaveBeenCalledWith({
			cookieStoreId: 'firefox-container-2',
			url: realUrl,
			index: 0,
		})
		expect(removeMock).toHaveBeenCalledWith(1)

		const createOrder = createMock.mock.invocationCallOrder[0]
		const removeOrder = removeMock.mock.invocationCallOrder[0]
		expect(createOrder).toBeLessThan(removeOrder ?? 0)
	})

	it('closes source tab before opening replacement when source window has multiple tabs', async () => {
		const realUrl = 'https://example.com/reopen-many-tabs'
		const encodedUrl = getNewUrl({ value: 'tokentwo' }, 0, realUrl)
		const harness = createRuntimeHarness(encodedUrl, {
			localMappings: [
				{ firstSeenIndex: 0, cookieStoreId: 'firefox-container-2', backupName: 'Work' },
			],
			tabsInWindow: [
				{ id: 1, index: 0, url: encodedUrl, windowId: 1 },
				{ id: 2, index: 1, url: 'https://example.com/other', windowId: 1 },
			],
		})

		await runStandardNavigationSequence(harness, encodedUrl)

		const createMock = harness.browserApi.tabs.create as ReturnType<typeof vi.fn>
		const removeMock = harness.browserApi.tabs.remove as ReturnType<typeof vi.fn>
		const createOrder = createMock.mock.invocationCallOrder[0]
		const removeOrder = removeMock.mock.invocationCallOrder[0]
		expect(removeOrder).toBeLessThan(createOrder ?? 0)
	})
})
