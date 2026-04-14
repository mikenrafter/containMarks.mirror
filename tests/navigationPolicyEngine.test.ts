import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NavigationPolicyEngineImpl } from '../src/background/navigationPolicyEngine'
import type { NavigationPolicyEngineDeps } from '../src/background/navigationPolicyEngine'
import type {
	BrowserApi,
	ContainerMappingRecord,
	HotswapRedirectInfo,
	NavigationIntent,
	PendingInterception,
	Tab,
} from '../src/models'
import { TEMP_CONTAINER_SENTINEL } from '../src/backgroundApp'
import { getNewUrl } from '../src/urlCodec'

// --- Helpers ---

function createMockBrowserApi(): BrowserApi {
	return {
		bookmarks: {
			search: vi.fn().mockResolvedValue([]),
			get: vi.fn().mockResolvedValue([]),
			getTree: vi.fn().mockResolvedValue([]),
			getChildren: vi.fn().mockResolvedValue([]),
			remove: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue({ id: 'b1', type: 'bookmark' }),
			create: vi.fn().mockResolvedValue({ id: 'b1', type: 'bookmark' }),
			onRemoved: { addListener: vi.fn() },
			onChanged: { addListener: vi.fn() },
			onCreated: { addListener: vi.fn() },
		},
		menus: {
			create: vi.fn(),
			refresh: vi.fn(),
			removeAll: vi.fn(),
			onClicked: { addListener: vi.fn() },
			onShown: { addListener: vi.fn() },
			onHidden: { addListener: vi.fn() },
		},
		contextualIdentities: {
			query: vi.fn().mockResolvedValue([]),
			get: vi.fn().mockResolvedValue({ cookieStoreId: 'c1', name: 'C1', icon: 'circle', color: 'blue' }),
		},
		tabs: {
			TAB_ID_NONE: -1,
			create: vi.fn().mockResolvedValue(undefined),
			remove: vi.fn().mockResolvedValue(undefined),
			get: vi.fn().mockImplementation(async (tabId: number) => ({
				id: tabId,
				index: 0,
				cookieStoreId: 'firefox-default',
			})),
			query: vi.fn().mockResolvedValue([]),
			highlight: vi.fn().mockResolvedValue(undefined),
			onActivated: { addListener: vi.fn() },
			onUpdated: { addListener: vi.fn() },
			onCreated: { addListener: vi.fn() },
		},
		windows: { onCreated: { addListener: vi.fn() } },
		notifications: { create: vi.fn().mockResolvedValue('nid') },
		pageAction: {
			isShown: vi.fn().mockResolvedValue(false),
			setTitle: vi.fn().mockResolvedValue(undefined),
			show: vi.fn().mockResolvedValue(undefined),
			hide: vi.fn().mockResolvedValue(undefined),
			onClicked: { addListener: vi.fn() },
		},
		webNavigation: { onBeforeNavigate: { addListener: vi.fn() } },
		webRequest: { onBeforeRequest: { addListener: vi.fn() } },
		management: { get: vi.fn().mockRejectedValue(new Error('not found')) },
		runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) },
		storage: {
			local: {
				get: vi.fn().mockResolvedValue({}),
				set: vi.fn().mockResolvedValue(undefined),
			},
		},
	}
}

function createMapping(index: number, cookieStoreId: string): ContainerMappingRecord {
	return { firstSeenIndex: index, cookieStoreId, backupName: `Container ${cookieStoreId}` }
}

function createMockDeps(overrides: Partial<NavigationPolicyEngineDeps> = {}): {
	deps: NavigationPolicyEngineDeps
	browserApi: BrowserApi
	hotswapMap: Map<string, HotswapRedirectInfo>
} {
	const browserApi = createMockBrowserApi()
	const hotswapMap = new Map<string, HotswapRedirectInfo>()

	const mappingsByIndex = new Map<number, ContainerMappingRecord>()

	const mappingStore = {
		initialize: vi.fn().mockResolvedValue(undefined),
		getByIndex: vi.fn().mockImplementation((idx: number) => mappingsByIndex.get(idx) ?? null),
		getByCookieStoreId: vi.fn().mockReturnValue(null),
		ensureMappingForContainer: vi.fn().mockResolvedValue(null),
		getRecords: vi.fn().mockReturnValue([]),
		_addMapping(index: number, cookieStoreId: string) {
			const record = createMapping(index, cookieStoreId)
			mappingsByIndex.set(index, record)
			return record
		},
	}

	const deps: NavigationPolicyEngineDeps = {
		browserApi,
		logger: { log: vi.fn() },
		settings: vi.fn().mockResolvedValue({
			targetFolderId: 'toolbar_____',
			resetTokensOnStartup: false,
			regenerateTokenOnEveryUse: false,
			acknowledgeRiskyTokenBehavior: false,
			showPageActionButton: true,
			enableBookmarkSync: false,
			allowEncodedBookmarkImport: false,
		}),
		mappingStore: vi.fn().mockReturnValue(mappingStore),
		hotswapRedirectMap: () => hotswapMap,
		consumeHotswapRedirect: (url: string) => {
			const info = hotswapMap.get(url)
			if (info) hotswapMap.delete(url)
			return info
		},
		onIntentResolved: vi.fn(),
		...overrides,
	}

	return { deps, browserApi, hotswapMap }
}

function makeTab(overrides: Partial<Tab> = {}): Tab {
	return { id: 1, url: 'https://example.com', index: 0, cookieStoreId: 'firefox-default', ...overrides }
}

// Generates a fragment-encoded bookmark URL for a given container index
function makeEncodedUrl(containerIndex: number, realUrl: string = 'https://example.com'): string {
	return getNewUrl({ value: 'testtoken' }, containerIndex, realUrl)
}

// --- Tests ---

describe('NavigationPolicyEngineImpl', () => {
	describe('handleBeforeNavigate', () => {
		it('ignores non-top-level frames', () => {
			const { deps } = createMockDeps()
			const npe = new NavigationPolicyEngineImpl(deps)

			npe.handleBeforeNavigate({ tabId: 1, url: makeEncodedUrl(0), frameId: 1 })

			// No pending interception created for sub-frames
			const result = npe.handleBeforeRequest({ requestId: '1', tabId: 1, url: 'https://example.com', type: 'main_frame' })
			expect(result).toBeUndefined()
		})

		it('populates pendingInterceptions for fragment-encoded URLs', () => {
			const { deps } = createMockDeps()
			const npe = new NavigationPolicyEngineImpl(deps)
			const encodedUrl = makeEncodedUrl(3)

			npe.handleBeforeNavigate({ tabId: 5, url: encodedUrl, frameId: 0 })

			// Verify by checking that handleBeforeRequest cancels
			const result = npe.handleBeforeRequest({ requestId: '1', tabId: 5, url: 'https://example.com', type: 'main_frame' })
			expect(result).toEqual({ cancel: true })
		})

		it('does not populate for non-encoded URLs', () => {
			const { deps } = createMockDeps()
			const npe = new NavigationPolicyEngineImpl(deps)

			npe.handleBeforeNavigate({ tabId: 1, url: 'https://example.com', frameId: 0 })

			const result = npe.handleBeforeRequest({ requestId: '1', tabId: 1, url: 'https://example.com', type: 'main_frame' })
			expect(result).toBeUndefined()
		})

		it('detects hotswap match and resolves asynchronously', async () => {
			const { deps, browserApi, hotswapMap } = createMockDeps()
			const npe = new NavigationPolicyEngineImpl(deps)

			// Add a mapping for the hotswap target
			const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
			mappingStore._addMapping(2, 'firefox-container-1');

			// Set up tab mock to return a tab in the default container
			(browserApi.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: 10, index: 0, cookieStoreId: 'firefox-default'
			})

			hotswapMap.set('https://decoded.com', { containerIndex: 2, bookmarkId: 'bm1' })

			npe.handleBeforeNavigate({ tabId: 10, url: 'https://decoded.com', frameId: 0 })

			// Wait for async resolution
			await vi.waitFor(() => {
				expect(deps.onIntentResolved).toHaveBeenCalled()
			})

			expect(deps.onIntentResolved).toHaveBeenCalledWith(
				{ action: 'redirect', cookieStoreId: 'firefox-container-1', url: 'https://decoded.com' },
				10
			)
		})
	})

	describe('handleBeforeRequest', () => {
		it('returns undefined for non-main_frame requests', () => {
			const { deps } = createMockDeps()
			const npe = new NavigationPolicyEngineImpl(deps)

			const result = npe.handleBeforeRequest({
				requestId: '1', tabId: 1, url: 'https://example.com', type: 'sub_frame'
			})
			expect(result).toBeUndefined()
		})

		it('returns undefined when no pending interception', () => {
			const { deps } = createMockDeps()
			const npe = new NavigationPolicyEngineImpl(deps)

			const result = npe.handleBeforeRequest({
				requestId: '1', tabId: 1, url: 'https://example.com', type: 'main_frame'
			})
			expect(result).toBeUndefined()
		})

		it('returns cancel:true and fires async resolution when interception exists', () => {
			const { deps } = createMockDeps()
			const npe = new NavigationPolicyEngineImpl(deps)

			npe.handleBeforeNavigate({ tabId: 7, url: makeEncodedUrl(1), frameId: 0 })

			const result = npe.handleBeforeRequest({
				requestId: '1', tabId: 7, url: 'https://example.com', type: 'main_frame'
			})
			expect(result).toEqual({ cancel: true })
		})
	})

	describe('resolveInterception', () => {
		it('returns noop when mapping is missing', async () => {
			const { deps } = createMockDeps()
			const npe = new NavigationPolicyEngineImpl(deps)

			const intent = await npe.resolveInterception({
				containerIndex: 99,
				realUrl: 'https://example.com',
				encodedUrl: makeEncodedUrl(99),
			})
			expect(intent.action).toBe('noop')
		})

		it('returns redirect intent when mapping exists', async () => {
			const { deps } = createMockDeps()
			const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
			mappingStore._addMapping(2, 'firefox-container-1')
			const npe = new NavigationPolicyEngineImpl(deps)

			const intent = await npe.resolveInterception({
				containerIndex: 2,
				realUrl: 'https://example.com',
				encodedUrl: makeEncodedUrl(2),
			})
			expect(intent).toEqual({
				action: 'redirect',
				cookieStoreId: 'firefox-container-1',
				url: 'https://example.com',
			})
		})

		it('returns redirect-temp for temp container sentinel', async () => {
			const { deps } = createMockDeps()
			const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
			mappingStore._addMapping(5, TEMP_CONTAINER_SENTINEL)
			const npe = new NavigationPolicyEngineImpl(deps)

			const intent = await npe.resolveInterception({
				containerIndex: 5,
				realUrl: 'https://temp-target.com',
				encodedUrl: makeEncodedUrl(5),
			})
			expect(intent).toEqual({
				action: 'redirect-temp',
				url: 'https://temp-target.com',
			})
		})

		it('returns reset-token when regenerateTokenOnEveryUse is enabled', async () => {
			const { deps, browserApi } = createMockDeps()
			const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
			mappingStore._addMapping(1, 'firefox-container-1')

			const encodedUrl = makeEncodedUrl(1, 'https://token-page.com')
			const bookmark = { id: 'bm1', type: 'bookmark' as const, url: encodedUrl }
			;(browserApi.bookmarks.search as ReturnType<typeof vi.fn>).mockResolvedValue([bookmark])

			;(deps.settings as ReturnType<typeof vi.fn>).mockResolvedValue({
				targetFolderId: 'toolbar_____',
				resetTokensOnStartup: false,
				regenerateTokenOnEveryUse: true,
				acknowledgeRiskyTokenBehavior: false,
				showPageActionButton: true,
				enableBookmarkSync: false,
				allowEncodedBookmarkImport: false,
			})

			const npe = new NavigationPolicyEngineImpl(deps)
			const intent = await npe.resolveInterception({
				containerIndex: 1,
				realUrl: 'https://token-page.com',
				encodedUrl,
			})

			expect(intent.action).toBe('reset-token')
			if (intent.action === 'reset-token') {
				expect(intent.cookieStoreId).toBe('firefox-container-1')
				expect(intent.url).toBe('https://token-page.com')
				expect(intent.bookmark).toBe(bookmark)
			}
		})
	})

	describe('evaluateTabNavigation', () => {
		it('returns noop for non-prefixed URLs', async () => {
			const { deps } = createMockDeps()
			const npe = new NavigationPolicyEngineImpl(deps)

			const intent = await npe.evaluateTabNavigation('https://normal.com', makeTab())
			expect(intent.action).toBe('noop')
		})

		it('returns noop when no bookmark matches the URL', async () => {
			const { deps, browserApi } = createMockDeps()
			;(browserApi.bookmarks.search as ReturnType<typeof vi.fn>).mockResolvedValue([])
			const npe = new NavigationPolicyEngineImpl(deps)

			const encodedUrl = makeEncodedUrl(1)
			const intent = await npe.evaluateTabNavigation(encodedUrl, makeTab())
			expect(intent.action).toBe('noop')
		})

		it('returns redirect intent when bookmark and mapping exist', async () => {
			const { deps, browserApi } = createMockDeps()
			const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
			mappingStore._addMapping(1, 'firefox-container-2')

			const encodedUrl = makeEncodedUrl(1, 'https://nav-target.com')
			const bookmark = { id: 'bm1', type: 'bookmark', url: encodedUrl }
			;(browserApi.bookmarks.search as ReturnType<typeof vi.fn>).mockResolvedValue([bookmark])

			const npe = new NavigationPolicyEngineImpl(deps)
			const intent = await npe.evaluateTabNavigation(encodedUrl, makeTab())

			expect(intent).toEqual({
				action: 'redirect',
				cookieStoreId: 'firefox-container-2',
				url: 'https://nav-target.com',
			})
		})

		it('returns noop when mapping is missing for bookmark index', async () => {
			const { deps, browserApi } = createMockDeps()
			const encodedUrl = makeEncodedUrl(99, 'https://orphan.com')
			const bookmark = { id: 'bm1', type: 'bookmark', url: encodedUrl }
			;(browserApi.bookmarks.search as ReturnType<typeof vi.fn>).mockResolvedValue([bookmark])

			const npe = new NavigationPolicyEngineImpl(deps)
			const intent = await npe.evaluateTabNavigation(encodedUrl, makeTab())
			expect(intent.action).toBe('noop')
		})
	})

	describe('evaluateHotswapRedirect', () => {
		it('returns noop when hotswap map is empty', async () => {
			const { deps } = createMockDeps()
			const npe = new NavigationPolicyEngineImpl(deps)

			const intent = await npe.evaluateHotswapRedirect('https://any.com', makeTab())
			expect(intent.action).toBe('noop')
		})

		it('returns noop when URL not in hotswap map', async () => {
			const { deps, hotswapMap } = createMockDeps()
			hotswapMap.set('https://other.com', { containerIndex: 1, bookmarkId: 'bm1' })
			const npe = new NavigationPolicyEngineImpl(deps)

			const intent = await npe.evaluateHotswapRedirect('https://nomatch.com', makeTab())
			expect(intent.action).toBe('noop')
		})

		it('returns redirect intent when hotswap match found', async () => {
			const { deps, hotswapMap } = createMockDeps()
			const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
			mappingStore._addMapping(3, 'firefox-container-5')

			hotswapMap.set('https://hotswap.com', { containerIndex: 3, bookmarkId: 'bm1' })

			const npe = new NavigationPolicyEngineImpl(deps)
			const intent = await npe.evaluateHotswapRedirect(
				'https://hotswap.com',
				makeTab({ cookieStoreId: 'firefox-default' })
			)

			expect(intent).toEqual({
				action: 'redirect',
				cookieStoreId: 'firefox-container-5',
				url: 'https://hotswap.com',
			})
		})

		it('returns noop when tab already in target container', async () => {
			const { deps, hotswapMap } = createMockDeps()
			const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
			mappingStore._addMapping(1, 'firefox-container-1')

			hotswapMap.set('https://already.com', { containerIndex: 1, bookmarkId: 'bm1' })

			const npe = new NavigationPolicyEngineImpl(deps)
			const intent = await npe.evaluateHotswapRedirect(
				'https://already.com',
				makeTab({ cookieStoreId: 'firefox-container-1' })
			)
			expect(intent.action).toBe('noop')
		})

		it('returns redirect-temp for temp container sentinel mapping', async () => {
			const { deps, hotswapMap } = createMockDeps()
			const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
			mappingStore._addMapping(4, TEMP_CONTAINER_SENTINEL)

			hotswapMap.set('https://temphs.com', { containerIndex: 4, bookmarkId: 'bm1' })

			const npe = new NavigationPolicyEngineImpl(deps)
			const intent = await npe.evaluateHotswapRedirect(
				'https://temphs.com',
				makeTab({ cookieStoreId: 'firefox-default' })
			)
			expect(intent).toEqual({ action: 'redirect-temp', url: 'https://temphs.com' })
		})
	})

	describe('evaluateTabUpdated', () => {
		it('returns noop for non-encoded URLs', async () => {
			const { deps } = createMockDeps()
			const npe = new NavigationPolicyEngineImpl(deps)

			const intent = await npe.evaluateTabUpdated(
				'https://plain.com',
				makeTab(),
				{ status: 'complete', url: 'https://plain.com' }
			)
			expect(intent.action).toBe('noop')
		})

		it('returns redirect for fragment-encoded URL when changeInfo.url is present', async () => {
			const { deps, browserApi } = createMockDeps()
			const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
			mappingStore._addMapping(1, 'firefox-container-2')

			const encodedUrl = makeEncodedUrl(1, 'https://tab-nav.com')
			const bookmark = { id: 'bm1', type: 'bookmark', url: encodedUrl }
			;(browserApi.bookmarks.search as ReturnType<typeof vi.fn>).mockResolvedValue([bookmark])

			const npe = new NavigationPolicyEngineImpl(deps)
			const intent = await npe.evaluateTabUpdated(
				encodedUrl,
				makeTab({ url: encodedUrl }),
				{ url: encodedUrl }
			)
			expect(intent).toEqual({
				action: 'redirect',
				cookieStoreId: 'firefox-container-2',
				url: 'https://tab-nav.com',
			})
		})

		it('returns noop for fragment-encoded URL when changeInfo.url is absent (status-only update)', async () => {
			const { deps } = createMockDeps()
			const npe = new NavigationPolicyEngineImpl(deps)

			const encodedUrl = makeEncodedUrl(1)
			const intent = await npe.evaluateTabUpdated(
				encodedUrl,
				makeTab({ url: encodedUrl }),
				{ status: 'complete' }
			)
			expect(intent.action).toBe('noop')
		})

		it('returns noop when webRequest pipeline claimed the tab (prevents double-open)', async () => {
			const { deps, browserApi } = createMockDeps()
			const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
			mappingStore._addMapping(1, 'firefox-container-1')

			const encodedUrl = makeEncodedUrl(1, 'https://double-open.com')
			const bookmark = { id: 'bm1', type: 'bookmark', url: encodedUrl }
			;(browserApi.bookmarks.search as ReturnType<typeof vi.fn>).mockResolvedValue([bookmark])

			const npe = new NavigationPolicyEngineImpl(deps)

			// Simulate the webRequest pipeline: onBeforeNavigate + onBeforeRequest
			npe.handleBeforeNavigate({ tabId: 1, url: encodedUrl, frameId: 0 })
			const cancelResult = npe.handleBeforeRequest({
				requestId: '1', tabId: 1, url: 'https://double-open.com', type: 'main_frame'
			})
			expect(cancelResult).toEqual({ cancel: true })

			// Now evaluateTabUpdated fires for the same tab — should yield noop
			const intent = await npe.evaluateTabUpdated(
				encodedUrl,
				makeTab({ id: 1, url: encodedUrl }),
				{ url: encodedUrl }
			)
			expect(intent.action).toBe('noop')
		})

		it('returns noop when pendingInterception exists but handleBeforeRequest has not fired yet', async () => {
			const { deps } = createMockDeps()
			const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
			mappingStore._addMapping(1, 'firefox-container-1')

			const encodedUrl = makeEncodedUrl(1, 'https://pending.com')

			const npe = new NavigationPolicyEngineImpl(deps)

			// Simulate only onBeforeNavigate (no onBeforeRequest yet)
			npe.handleBeforeNavigate({ tabId: 1, url: encodedUrl, frameId: 0 })

			const intent = await npe.evaluateTabUpdated(
				encodedUrl,
				makeTab({ id: 1, url: encodedUrl }),
				{ url: encodedUrl }
			)
			expect(intent.action).toBe('noop')
		})

		it('checks hotswap redirect map before encoded-URL checks', async () => {
			const { deps, hotswapMap } = createMockDeps()
			const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
			mappingStore._addMapping(2, 'firefox-container-3')

			hotswapMap.set('https://hotswap-tab.com', { containerIndex: 2, bookmarkId: 'bm1' })

			const npe = new NavigationPolicyEngineImpl(deps)
			const intent = await npe.evaluateTabUpdated(
				'https://hotswap-tab.com',
				makeTab({ cookieStoreId: 'firefox-default' }),
				{ url: 'https://hotswap-tab.com' }
			)
			expect(intent).toEqual({
				action: 'redirect',
				cookieStoreId: 'firefox-container-3',
				url: 'https://hotswap-tab.com',
			})
		})
	})
})
