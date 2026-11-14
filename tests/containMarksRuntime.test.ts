import { afterEach, describe, it, expect, vi } from 'vitest'
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
type BeforeRequestListener = (details: { requestId: string; tabId: number; url: string; type: string }) => { cancel?: boolean } | void | Promise<{ cancel?: boolean } | void>

interface RuntimeHarness {
	browserApi: BrowserApi
	bookmark: BookmarkNode
	menuShownListeners: MenuShownListener[]
	menuClickListeners: MenuClickListener[]
	menuHiddenListeners: MenuHiddenListener[]
	beforeNavigateListeners: BeforeNavigateListener[]
	beforeRequestListeners: BeforeRequestListener[]
	externalListeners: Array<(message: unknown, sender: { id?: string }) => unknown>
	storageState: Record<string, unknown>
	managementListeners: { installed: Array<(info: { id: string }) => unknown>; enabled: Array<(info: { id: string }) => unknown> }
	installTc(capabilities: unknown): void
}

interface RuntimeHarnessOptions {
	tcCapabilities?: unknown
	localMappings?: Array<{ firstSeenIndex: number; cookieStoreId: string; backupName: string }>
	tabsInWindow?: Tab[]
	/** Reuse a previous harness's local storage to model a browser restart. */
	storageState?: Record<string, unknown> | undefined
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
		askForFolderOnBookmark: false,
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

	const externalListeners: RuntimeHarness['externalListeners'] = []
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

	const storageState: Record<string, unknown> = options.storageState ?? {
		[SETTINGS_STORAGE_KEY]: defaultSettings(),
		[HOTSWAP_STORAGE_KEY]: {},
		[LOCAL_MAPPING_STORAGE_KEY]: options.localMappings ?? [],
	}
	let tcCapabilities = options.tcCapabilities
	const managementListeners: RuntimeHarness['managementListeners'] = { installed: [], enabled: [] }
	const tabsInWindow = options.tabsInWindow ?? [{ id: 1, index: 0, url: 'https://example.com', windowId: 1 }]

	let createdCounter = 0
	const createdBookmarksById = new Map<string, BookmarkNode>()

	const browserApi: BrowserApi = {
		bookmarks: {
			search: vi.fn().mockImplementation(async (query: { query?: string; url?: string; title?: string } | string) => {
				if (typeof query === 'string') {
					return bookmark.url === query ? [{ ...bookmark }] : []
				}
				if (options.tcCapabilities !== undefined && query.url === bookmark.url) return [{ ...bookmark }]
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
				if (!name) return [...identities]
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
			setPopup: vi.fn().mockResolvedValue(undefined),
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
			get: vi.fn(async (id: string) => {
				if (tcCapabilities === undefined) throw new Error('Not installed')
				return { id, enabled: true, name: 'TC+', type: 'extension' }
			}),
			onInstalled: { addListener: vi.fn((listener: (info: { id: string }) => unknown) => managementListeners.installed.push(listener)) },
			onEnabled: { addListener: vi.fn((listener: (info: { id: string }) => unknown) => managementListeners.enabled.push(listener)) },
		},
		runtime: {
			onMessage: { addListener: vi.fn() },
			getURL: (path: string) => `moz-extension://containmarks/${path}`,
			sendMessage: vi.fn().mockResolvedValue(false),
		},
		storage: {
			onChanged: { addListener: vi.fn() },
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

	Object.assign(browserApi.runtime, { onMessageExternal: { addListener: vi.fn((listener: RuntimeHarness['externalListeners'][number]) => externalListeners.push(listener)) } })
	vi.mocked(browserApi.runtime.sendMessage).mockImplementation(async (_id: string | Record<string, unknown>, message?: Record<string, unknown>) => {
		if (tcCapabilities === undefined) return false
		if (message?.method === 'getCooperationCapabilities') return tcCapabilities
		if (message?.method === 'isTempContainer') return message.cookieStoreId === 'firefox-container-99'
		if (message?.method === 'createTabInTempContainer') return { id: 900, cookieStoreId: 'firefox-container-99' }
		return false
	})

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
		externalListeners,
		storageState,
		managementListeners,
		installTc: (capabilities) => { tcCapabilities = capabilities },
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

describe('ContainMarksRuntime folder picker wiring', () => {
	it('forwards picker messages to the page action handler', async () => {
		const harness = createRuntimeHarness('https://example.com')
		const onMessage = harness.browserApi.runtime.onMessage.addListener as ReturnType<typeof vi.fn>
		const listener = onMessage.mock.calls[0]?.[0] as (message: unknown, sender: { id?: string }) => Promise<unknown> | void

		expect(listener({ type: 'unrelated' }, {})).toBeUndefined()
		await expect(listener(
			{ type: 'containmarks:bookmark-tab', tabId: 1, parentId: 'unfiled_____', title: 'Picked' },
			{},
		)).resolves.toEqual({ ok: true })
		expect(harness.browserApi.bookmarks.create).toHaveBeenCalledWith(expect.objectContaining({
			parentId: 'unfiled_____',
			title: 'Picked',
		}))
	})

	it('re-syncs page action popups when settings change', async () => {
		const harness = createRuntimeHarness('https://example.com')
		const onChanged = harness.browserApi.storage.onChanged.addListener as ReturnType<typeof vi.fn>
		const listener = onChanged.mock.calls[0]?.[0] as (changes: Record<string, unknown>, area: string) => Promise<void>
		const setPopup = harness.browserApi.pageAction.setPopup as ReturnType<typeof vi.fn>
		await flushMicrotasks(20)
		setPopup.mockClear()

		await listener({ unrelated: {} }, 'local')
		expect(setPopup).not.toHaveBeenCalled()

		await listener({ 'containMarks.settings': { newValue: {} } }, 'local')
		expect(setPopup).toHaveBeenCalled()
	})
})


const negotiatedTc = '{c607c8df-14a7-4f28-894f-29e8722976af}'
const approved = { version: 1, approved: true }

async function cooperativeHarness(cookieStoreId = 'firefox-container-2', tcCapabilities: unknown = approved) {
	const encoded = 'https://example.com/article#cm:bookmarktoken:0#section'
	const harness = createRuntimeHarness(encoded, {
		tcCapabilities,
		localMappings: [{ firstSeenIndex: 0, cookieStoreId, backupName: 'Work' }],
		tabsInWindow: [{ id: 1, index: 0, windowId: 1, url: encoded }],
	})
	await flushMicrotasks(80)
	vi.mocked(harness.browserApi.tabs.query).mockClear()
	vi.mocked(harness.browserApi.runtime.sendMessage).mockClear()
	return { ...harness, encoded }
}

function callbackFor(harness: RuntimeHarness) {
	expect(harness.externalListeners).toHaveLength(1)
	return harness.externalListeners[0]!
}

const resolution = (url = 'https://example.com/article', requestId = 'cooperative-request') => ({
	method: 'resolveCooperativeNavigation', version: 1, request: { requestId, tabId: 1, url },
})
const completion = { method: 'cooperativeNavigationCompleted', version: 1,
	requestId: 'cooperative-request', tabId: 1, destinationTabId: 900 }

describe('ContainMarksRuntime approved TC cooperation', () => {
	afterEach(() => vi.useRealTimers())

	// WHY: CLAIM(cooperation-single-owner); all CM HTTP event entry points must defer after positive negotiation.
	// catches: adding a pure callback while leaving existing fire-and-forget activation and orphan scans alive.
	it('records stripped-fragment intent without independently activating or scanning', async () => {
		vi.useFakeTimers()
		const h = await cooperativeHarness()
		await h.beforeNavigateListeners[0]!({ tabId: 1, frameId: 0, url: h.encoded })
		h.beforeRequestListeners[0]!({ tabId: 1, requestId: 'cooperative-request', url: 'https://example.com/article', type: 'main_frame' })
		await flushMicrotasks(30)
		await vi.advanceTimersByTimeAsync(1000)
		expect(h.browserApi.tabs.create).not.toHaveBeenCalled()
		expect(h.browserApi.tabs.remove).not.toHaveBeenCalled()
		expect(h.browserApi.tabs.query).not.toHaveBeenCalled()
		expect(await callbackFor(h)(resolution(), { id: negotiatedTc })).toEqual({
			version: 1, action: 'route', url: 'https://example.com/article#section', cookieStoreId: 'firefox-container-2',
		})
		expect(h.browserApi.tabs.create).not.toHaveBeenCalled()
	})

	// WHY: CLAIM(cooperation-authorization); a body claiming the negotiated TC ID grants no authority.
	// catches: accepting external messages based on a method name, installation, or forged senderId.
	it('refuses forged callers, malformed requests and a stale same-tab URL cache', async () => {
		const h = await cooperativeHarness()
		const listener = callbackFor(h)
		await h.beforeNavigateListeners[0]!({ tabId: 1, frameId: 0, url: h.encoded })
		expect(await listener({ ...resolution(), senderId: negotiatedTc }, { id: 'attacker@test' })).toBeUndefined()
		expect(await listener({ ...resolution(), request: { tabId: -1, requestId: '', url: 'javascript:alert(1)' } }, { id: negotiatedTc }))
			.toEqual({ version: 1, action: 'pass' })
		await h.beforeNavigateListeners[0]!({ tabId: 1, frameId: 0, url: 'https://different.example/' })
		expect(await listener(resolution('https://different.example/'), { id: negotiatedTc })).toEqual({ version: 1, action: 'pass' })
		expect(h.browserApi.tabs.create).not.toHaveBeenCalled()
	})

	// WHY: CLAIM(cooperation-single-owner); token regeneration follows accepted routing, once, preserving original fragments.
	// catches: regenerating during classification or every duplicate completion, or forgetting completion maintenance entirely.
	it('proposes idempotently and regenerates bookmark token only on authenticated completion', async () => {
		const h = await cooperativeHarness()
		const listener = callbackFor(h)
		await h.beforeNavigateListeners[0]!({ tabId: 1, frameId: 0, url: h.encoded })
		expect(await listener(resolution(), { id: negotiatedTc })).toEqual({
			version: 1, action: 'route', url: 'https://example.com/article#section', cookieStoreId: 'firefox-container-2',
		})
		await listener(resolution(), { id: negotiatedTc })
		expect(h.bookmark.url).toBe(h.encoded)
		await listener(completion, { id: 'attacker@test' })
		expect(h.bookmark.url).toBe(h.encoded)
		await listener(completion, { id: negotiatedTc })
		const once = h.bookmark.url
		expect(once).not.toBe(h.encoded)
		expect(parseBookmarkUrl(once!)).toEqual(expect.objectContaining({ url: 'https://example.com/article#section', containerIndex: 0 }))
		const updateCount = vi.mocked(h.browserApi.bookmarks.update).mock.calls.length
		await listener(completion, { id: negotiatedTc })
		expect(h.browserApi.bookmarks.update).toHaveBeenCalledTimes(updateCount)
		expect(h.browserApi.tabs.create).not.toHaveBeenCalled()
		expect(h.browserApi.tabs.remove).not.toHaveBeenCalled()
	})

	// WHY: CLAIM(cooperation-single-owner); temporary intent must use the negotiated route, never legacy effectful fallback.
	// catches: calling legacy createTabInTempContainer before TC receives a proposal, including ACK-loss duplicate creation.
	it('returns temporary intent without sending legacy create or orphan queries', async () => {
		const h = await cooperativeHarness(TEMP_CONTAINER_SENTINEL)
		await h.beforeNavigateListeners[0]!({ tabId: 1, frameId: 0, url: h.encoded })
		expect(await callbackFor(h)(resolution(), { id: negotiatedTc })).toEqual({
			version: 1, action: 'route', url: 'https://example.com/article#section', cookieStoreId: 'temporary',
		})
		const methods = vi.mocked(h.browserApi.runtime.sendMessage).mock.calls.map(call => (call as unknown as [unknown, { method?: string }?])[1]?.method)
		expect(methods).not.toContain('createTabInTempContainer')
		expect(methods).not.toContain('isTempContainer')
		expect(h.browserApi.tabs.query).not.toHaveBeenCalled()
	})

	// WHY: CLAIM(cooperation-no-scan); a newly opened unrelated ephemeral tab is never CM-owned cleanup material.
	// catches: retaining the six 150ms cleanup polls on the approved hotswap path.
	it('keeps hotswap bookmark recoverable until completion, reverts it, and leaves unrelated temporary tabs alone', async () => {
		vi.useFakeTimers()
		const h = await cooperativeHarness()
		await h.menuShownListeners[0]!({ contexts: ['bookmark'], bookmarkId: h.bookmark.id })
		await flushMicrotasks(50)
		const decoded = h.bookmark.url!
		expect(decoded).toBe('https://example.com/article#section')
		vi.mocked(h.browserApi.tabs.query).mockClear()
		await h.menuHiddenListeners[0]!()
		await flushMicrotasks(30)
		await h.beforeNavigateListeners[0]!({ tabId: 1, frameId: 0, url: decoded })
		const listener = callbackFor(h)
		expect(await listener(resolution(decoded), { id: negotiatedTc })).toEqual({
			version: 1, action: 'route', url: decoded, cookieStoreId: 'firefox-container-2',
		})
		await listener(completion, { id: negotiatedTc })
		await vi.advanceTimersByTimeAsync(2000)
		expect(parseBookmarkUrl(h.bookmark.url!)).toEqual(expect.objectContaining({ url: decoded, containerIndex: 0 }))
		expect(h.browserApi.tabs.query).not.toHaveBeenCalled()
		expect(h.browserApi.tabs.remove).not.toHaveBeenCalled()
		expect(h.browserApi.tabs.create).not.toHaveBeenCalled()
	})

	// WHY: CLAIM(cooperation-legacy); old TC and denied callers must keep working without an accidental permanent suppression.
	// catches: treating management.get success or any truthy capability object as approval.
	it('uses existing activation when negotiation is unsupported or explicitly denied', async () => {
		vi.useFakeTimers()
		for (const capabilities of [false, { version: 1, approved: false }, { version: 99, approved: true }]) {
			const h = await cooperativeHarness('firefox-container-2', capabilities)
			await runStandardNavigationSequence(h, h.encoded)
			await vi.advanceTimersByTimeAsync(1000)
			// An explicit denial is still offered once at startup; routing itself must not create more than the legacy tab.
			expect(vi.mocked(h.browserApi.tabs.create).mock.calls.filter(([d]) => !d.url?.includes('offer/offer.html'))).toHaveLength(1)
			expect(h.browserApi.tabs.create).toHaveBeenCalledWith(expect.objectContaining({
				url: 'https://example.com/article#section', cookieStoreId: 'firefox-container-2',
			}))
			expect(h.browserApi.tabs.remove).toHaveBeenCalledWith(1)
		}
	})
	// WHY: CLAIM(cooperation-single-owner); UI updates survive HTTP routing ownership.
	it('syncs the page action on a cooperative HTTP load', async () => {
		const h = await cooperativeHarness()
		const popup = vi.mocked(h.browserApi.pageAction.setPopup)
		popup.mockClear()
		const listener = vi.mocked(h.browserApi.tabs.onUpdated.addListener).mock.calls[0]![0]
		await listener(1, { status: 'complete' }, { id: 1, index: 0, url: 'https://example.com/article' })
		expect(popup).toHaveBeenCalled()
		expect(h.browserApi.tabs.create).not.toHaveBeenCalled()
	})

})

const offerKey = 'containMarks.cooperationOffers'
const offerPage = 'moz-extension://containmarks/offer/offer.html?tc=' + encodeURIComponent(negotiatedTc)
const offerTabs = (h: RuntimeHarness) => vi.mocked(h.browserApi.tabs.create).mock.calls.filter(([d]) => d.url?.includes('offer/offer.html'))
const settle = () => vi.advanceTimersByTimeAsync(5000)

describe('ContainMarksRuntime automatic cooperation offer', () => {
	afterEach(() => { vi.useRealTimers() })
	const start = async (capabilities: unknown, storageState?: Record<string, unknown>) => {
		const h = createRuntimeHarness('https://example.com/', { tcCapabilities: capabilities, storageState })
		await settle()
		return h
	}

	// WHY: CLAIM(cooperation-offer); a compatible unapproved TC is offered once, at startup, without any settings visit.
	// catches: offering only from settings, offering before the version-1 reply, offering again after restart.
	it('offers once, records the decision before opening, and stays quiet after restart', async () => {
		vi.useFakeTimers()
		const first = createRuntimeHarness('https://example.com/', { tcCapabilities: { version: 1, approved: false } })
		let recordedWhenOpened: unknown
		vi.mocked(first.browserApi.tabs.create).mockImplementation(async () => {
			recordedWhenOpened = first.storageState[offerKey]
			return { id: 700, index: 1 }
		})
		await settle()
		expect(offerTabs(first).map(([d]) => d.url)).toEqual([offerPage])
		expect(recordedWhenOpened).toMatchObject({ [negotiatedTc]: { state: 'offered' } })
		const restarted = await start({ version: 1, approved: false }, first.storageState)
		expect(offerTabs(restarted)).toHaveLength(0)
	})

	// WHY: CLAIM(cooperation-offer); no offer for TC that cannot or need not be asked, and unapproved checks stay pure.
	// catches: offering to old TC, to already-approved CM, or recording state for them.
	it('does not offer for absent, legacy, unknown-version or approved TC', async () => {
		vi.useFakeTimers()
		for (const capabilities of [undefined, false, { version: 99, approved: false }, { version: 1, approved: true }]) {
			const h = await start(capabilities)
			expect(offerTabs(h), JSON.stringify(capabilities)).toHaveLength(0)
			const record = (h.storageState[offerKey] as Record<string, { state: string }> | undefined)?.[negotiatedTc]
			const alreadyApproved = (capabilities as { version?: number; approved?: boolean } | false | undefined) !== undefined && capabilities !== false &&
				(capabilities as { version?: number }).version === 1 && (capabilities as { approved?: boolean }).approved === true
			expect(record?.state, JSON.stringify(capabilities)).toBe(alreadyApproved ? 'approved' : undefined)
		}
	})

	// WHY: CLAIM(cooperation-offer); a later revoke must not turn into an automatic nag.
	// catches: treating approval as no history, so a revoked CM is offered at next startup.
	it('does not offer after a previously approved CM is revoked', async () => {
		vi.useFakeTimers()
		const approvedRun = await start({ version: 1, approved: true })
		const revoked = await start({ version: 1, approved: false }, approvedRun.storageState)
		expect(offerTabs(revoked)).toHaveLength(0)
	})

	// WHY: CLAIM(cooperation-offer); failure to open the offer must not permanently suppress a retry.
	it('rolls back the decision when the offer cannot open', async () => {
		vi.useFakeTimers()
		const failing = createRuntimeHarness('https://example.com/', { tcCapabilities: { version: 1, approved: false } })
		vi.mocked(failing.browserApi.tabs.create).mockRejectedValue(new Error('no window'))
		await settle()
		expect(failing.storageState[offerKey] ?? {}).toEqual({})
		const retry = await start({ version: 1, approved: false }, failing.storageState)
		expect(offerTabs(retry)).toHaveLength(1)
	})

	// WHY: CLAIM(cooperation-offer); TC installed or enabled after CM starts is offered once, without rerunning startup.
	// catches: ignoring unrelated extensions, duplicate management events, rerunning migrations.
	it('offers when TC is installed after startup, once, and ignores other extensions', async () => {
		vi.useFakeTimers()
		const h = await start(undefined)
		const searches = vi.mocked(h.browserApi.bookmarks.search).mock.calls.length
		h.installTc({ version: 1, approved: false })
		const { installed, enabled } = h.managementListeners
		expect(installed).toHaveLength(1)
		expect(enabled).toHaveLength(1)
		installed[0]!({ id: 'other@example.test' })
		await settle()
		expect(offerTabs(h)).toHaveLength(0)
		installed[0]!({ id: negotiatedTc })
		enabled[0]!({ id: negotiatedTc })
		await settle()
		expect(offerTabs(h)).toHaveLength(1)
		expect(vi.mocked(h.browserApi.bookmarks.search).mock.calls.length).toBe(searches)
	})

	// WHY: CLAIM(cooperation-offer); a freshly loaded TC may answer after the first probe.
	it('waits briefly for a TC that is not answering yet', async () => {
		vi.useFakeTimers()
		const h = createRuntimeHarness('https://example.com/', { tcCapabilities: false })
		await vi.advanceTimersByTimeAsync(600)
		h.installTc({ version: 1, approved: false })
		await settle()
		expect(offerTabs(h)).toHaveLength(1)
	})
})
