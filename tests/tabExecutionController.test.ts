import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TabExecutionControllerImpl } from '../src/background/tabExecutionController'
import type { TabExecutionControllerDeps } from '../src/background/tabExecutionController'
import type { BrowserApi, NavigationIntent, Tab, BookmarkNode, ContainMarksSettings } from '../src/models'
import { NO_CONTAINER, TEMP_CONTAINER_SENTINEL } from '../src/backgroundApp'

// --- Test helpers ---

function createMockBrowserApi(): BrowserApi {
	return {
		bookmarks: {
			search: vi.fn().mockResolvedValue([]),
			get: vi.fn().mockResolvedValue([]),
			getTree: vi.fn().mockResolvedValue([]),
			getChildren: vi.fn().mockResolvedValue([]),
			remove: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue({ id: 'b1', type: 'bookmark' }),
			create: vi.fn().mockImplementation(async (details) => ({
				id: 'created-1',
				type: 'bookmark',
				title: details.title,
				parentId: details.parentId,
				url: details.url
			})),
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
			get: vi.fn().mockImplementation(async (id: string) => ({
				cookieStoreId: id,
				name: `Container ${id}`,
				icon: 'circle' as const,
				color: 'blue' as const,
			})),
		},
		tabs: {
			TAB_ID_NONE: -1,
			create: vi.fn().mockResolvedValue(undefined),
			remove: vi.fn().mockResolvedValue(undefined),
			get: vi.fn().mockImplementation(async (tabId: number) => ({ id: tabId, index: 0 })),
			query: vi.fn().mockResolvedValue([]),
			highlight: vi.fn().mockResolvedValue(undefined),
			onActivated: { addListener: vi.fn() },
			onUpdated: { addListener: vi.fn() },
			onCreated: { addListener: vi.fn() },
		},
		windows: {
			onCreated: { addListener: vi.fn() },
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
			onBeforeNavigate: { addListener: vi.fn() },
		},
		webRequest: {
			onBeforeRequest: { addListener: vi.fn() },
		},
		management: {
			get: vi.fn().mockRejectedValue(new Error('not found')),
		},
		runtime: {
			sendMessage: vi.fn().mockResolvedValue(undefined),
		},
		storage: {
			local: {
				get: vi.fn().mockResolvedValue({}),
				set: vi.fn().mockResolvedValue(undefined),
			},
		},
	}
}

function createDefaultSettings(): ContainMarksSettings {
	return {
		targetFolderId: 'toolbar_____',
		resetTokensOnStartup: false,
		regenerateTokenOnEveryUse: false,
		acknowledgeRiskyTokenBehavior: false,
		showPageActionButton: true,
		enableBookmarkSync: false,
		allowEncodedBookmarkImport: false,
	}
}

function createMockDeps(overrides: Partial<TabExecutionControllerDeps> = {}): {
	deps: TabExecutionControllerDeps
	browserApi: BrowserApi
} {
	const browserApi = createMockBrowserApi()
	const settings = createDefaultSettings()
	const mappingStore = {
		initialize: vi.fn().mockResolvedValue(undefined),
		getByIndex: vi.fn().mockReturnValue(null),
		getByCookieStoreId: vi.fn().mockReturnValue(null),
		ensureMappingForContainer: vi.fn().mockResolvedValue({ firstSeenIndex: 0, cookieStoreId: 'cid', backupName: 'name' }),
		getRecords: vi.fn().mockReturnValue([]),
	}

	const deps: TabExecutionControllerDeps = {
		browserApi,
		logger: { log: vi.fn() },
		settings: vi.fn().mockResolvedValue(settings),
		mappingStore: vi.fn().mockReturnValue(mappingStore),
		tempContainersExtensionId: vi.fn().mockReturnValue(null),
		getContainer: vi.fn().mockImplementation(async ({ cookieStoreId }) => {
			if (!cookieStoreId || cookieStoreId === NO_CONTAINER) return null
			return { cookieStoreId, name: `Container ${cookieStoreId}`, icon: 'circle' as const, color: 'blue' as const }
		}),
		updateBookmarkContainerUrl: vi.fn().mockResolvedValue(null),
		...overrides,
	}

	return { deps, browserApi }
}

function makeTab(overrides: Partial<Tab> = {}): Tab {
	return { id: 1, url: 'https://example.com', index: 0, cookieStoreId: NO_CONTAINER, ...overrides }
}

// --- Tests ---

describe('TabExecutionControllerImpl', () => {
	describe('executeIntent', () => {
		it('does nothing for noop intent', async () => {
			const { deps, browserApi } = createMockDeps()
			const tec = new TabExecutionControllerImpl(deps)
			const intent: NavigationIntent = { action: 'noop' }

			await tec.executeIntent(intent, makeTab())

			expect(browserApi.tabs.create).not.toHaveBeenCalled()
			expect(browserApi.tabs.remove).not.toHaveBeenCalled()
		})

		it('redirects tab to container for redirect intent', async () => {
			const { deps, browserApi } = createMockDeps()
			const tec = new TabExecutionControllerImpl(deps)
			const intent: NavigationIntent = { action: 'redirect', cookieStoreId: 'firefox-container-1', url: 'https://target.com' }
			const tab = makeTab({ id: 5, index: 2 })

			await tec.executeIntent(intent, tab)

			expect(browserApi.tabs.create).toHaveBeenCalledWith({
				cookieStoreId: 'firefox-container-1',
				url: 'https://target.com',
				index: 3,
			})
			expect(browserApi.tabs.remove).toHaveBeenCalledWith(5)
		})

		it('delegates redirect-temp to TC API', async () => {
			const tcExtId = '{test-tc-ext}'
			const { deps, browserApi } = createMockDeps({
				tempContainersExtensionId: vi.fn().mockReturnValue(tcExtId),
			})
			const tec = new TabExecutionControllerImpl(deps)
			const intent: NavigationIntent = { action: 'redirect-temp', url: 'https://temp.com' }
			const tab = makeTab({ id: 10 })

			await tec.executeIntent(intent, tab)

			expect(browserApi.runtime.sendMessage).toHaveBeenCalledWith(tcExtId, {
				method: 'createTabInTempContainer',
				url: 'https://temp.com',
				active: true,
			})
			expect(browserApi.tabs.remove).toHaveBeenCalledWith(10)
		})

		it('falls back to default tab when TC API fails for redirect-temp', async () => {
			const { deps, browserApi } = createMockDeps({
				tempContainersExtensionId: vi.fn().mockReturnValue(null),
			})
			const tec = new TabExecutionControllerImpl(deps)
			const intent: NavigationIntent = { action: 'redirect-temp', url: 'https://fallback.com' }
			const tab = makeTab({ id: 7, index: 3 })

			await tec.executeIntent(intent, tab)

			// Falls back: creates tab without container and removes source
			expect(browserApi.tabs.create).toHaveBeenCalledWith({ url: 'https://fallback.com', index: 4 })
			expect(browserApi.tabs.remove).toHaveBeenCalledWith(7)
		})

		it('redirects and refreshes token for reset-token intent', async () => {
			const { deps, browserApi } = createMockDeps()
			const bookmark: BookmarkNode = { id: 'bm1', type: 'bookmark', url: 'https://encoded.com#cm:abc:1' }
			const tec = new TabExecutionControllerImpl(deps)
			const intent: NavigationIntent = {
				action: 'reset-token',
				cookieStoreId: 'firefox-container-2',
				url: 'https://encoded.com',
				bookmark,
			}
			const tab = makeTab({ id: 3 })

			await tec.executeIntent(intent, tab)

			expect(browserApi.tabs.create).toHaveBeenCalled()
			expect(browserApi.tabs.remove).toHaveBeenCalledWith(3)
			expect(deps.updateBookmarkContainerUrl).toHaveBeenCalledWith(bookmark)
		})
	})

	describe('openInContainer', () => {
		it('creates tab in target container and removes source', async () => {
			const { deps, browserApi } = createMockDeps()
			const tec = new TabExecutionControllerImpl(deps)
			const tab = makeTab({ id: 1, index: 5 })

			await tec.openInContainer('firefox-container-1', 'https://example.com', tab)

			expect(browserApi.tabs.create).toHaveBeenCalledWith({
				cookieStoreId: 'firefox-container-1',
				url: 'https://example.com',
				index: 6,
			})
			expect(browserApi.tabs.remove).toHaveBeenCalledWith(1)
		})

		it('does nothing when container not found', async () => {
			const { deps, browserApi } = createMockDeps({
				getContainer: vi.fn().mockResolvedValue(null),
			})
			const tec = new TabExecutionControllerImpl(deps)

			await tec.openInContainer('nonexistent', 'https://example.com', makeTab())

			expect(browserApi.tabs.create).not.toHaveBeenCalled()
		})

		it('does nothing when tab has no id', async () => {
			const { deps, browserApi } = createMockDeps()
			const tec = new TabExecutionControllerImpl(deps)

			await tec.openInContainer('firefox-container-1', 'https://example.com', { index: 0 })

			expect(browserApi.tabs.create).not.toHaveBeenCalled()
		})

		it('routes temp-container sentinel to TC API', async () => {
			const tcExtId = '{tc-ext}'
			const { deps, browserApi } = createMockDeps({
				tempContainersExtensionId: vi.fn().mockReturnValue(tcExtId),
			})
			const tec = new TabExecutionControllerImpl(deps)
			const tab = makeTab({ id: 2 })

			await tec.openInContainer(TEMP_CONTAINER_SENTINEL, 'https://temp.com', tab)

			expect(browserApi.runtime.sendMessage).toHaveBeenCalledWith(tcExtId, {
				method: 'createTabInTempContainer',
				url: 'https://temp.com',
				active: true,
			})
		})
	})

	describe('cleanupOrphanedTabs', () => {
		it('removes new about:blank tabs in non-default containers', async () => {
			const { deps, browserApi } = createMockDeps()
			const tec = new TabExecutionControllerImpl(deps)

			// First query (pre-delay snapshot): window has one pre-existing tab
			const preExistingTab = { id: 10, url: 'https://keep.com', index: 0, cookieStoreId: 'firefox-container-1' }
			// Second query (post-delay): TC added an orphan
			const orphanTab = { id: 20, url: 'about:blank', index: 1, cookieStoreId: 'firefox-container-99' }
			;(browserApi.tabs.query as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce([preExistingTab])       // pre-delay snapshot
				.mockResolvedValueOnce([preExistingTab, orphanTab])  // post-delay check

			await tec.cleanupOrphanedTabs(1, 'firefox-container-1')

			expect(browserApi.tabs.remove).toHaveBeenCalledWith(20)
		})

		it('does not remove pre-existing about:blank tabs', async () => {
			const { deps, browserApi } = createMockDeps()
			const tec = new TabExecutionControllerImpl(deps)

			const preExistingBlank = { id: 10, url: 'about:blank', index: 0, cookieStoreId: 'firefox-container-99' }
			;(browserApi.tabs.query as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce([preExistingBlank])   // pre-delay snapshot
				.mockResolvedValueOnce([preExistingBlank])   // post-delay — same tab still there

			await tec.cleanupOrphanedTabs(1, 'firefox-container-1')

			expect(browserApi.tabs.remove).not.toHaveBeenCalled()
		})

		it('does not remove tabs in target container', async () => {
			const { deps, browserApi } = createMockDeps()
			const tec = new TabExecutionControllerImpl(deps)

			const newTabInTarget = { id: 30, url: 'about:blank', index: 1, cookieStoreId: 'firefox-container-1' }
			;(browserApi.tabs.query as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce([])               // pre-delay — empty
				.mockResolvedValueOnce([newTabInTarget])  // post-delay — new tab, but it's in target container

			await tec.cleanupOrphanedTabs(1, 'firefox-container-1')

			expect(browserApi.tabs.remove).not.toHaveBeenCalled()
		})

		it('does not remove tabs in default container', async () => {
			const { deps, browserApi } = createMockDeps()
			const tec = new TabExecutionControllerImpl(deps)

			const defaultBlank = { id: 40, url: 'about:blank', index: 1, cookieStoreId: NO_CONTAINER }
			;(browserApi.tabs.query as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([defaultBlank])

			await tec.cleanupOrphanedTabs(1, 'firefox-container-1')

			expect(browserApi.tabs.remove).not.toHaveBeenCalled()
		})
	})

	describe('isTempContainer', () => {
		it('returns false when no TC extension is installed', async () => {
			const { deps } = createMockDeps()
			const tec = new TabExecutionControllerImpl(deps)

			expect(await tec.isTempContainer('firefox-container-1')).toBe(false)
		})

		it('returns true when TC API confirms temporary', async () => {
			const tcExtId = '{tc-ext}'
			const { deps, browserApi } = createMockDeps({
				tempContainersExtensionId: vi.fn().mockReturnValue(tcExtId),
			})
			;(browserApi.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(true)
			const tec = new TabExecutionControllerImpl(deps)

			expect(await tec.isTempContainer('firefox-container-42')).toBe(true)
			expect(browserApi.runtime.sendMessage).toHaveBeenCalledWith(tcExtId, {
				method: 'isTempContainer',
				cookieStoreId: 'firefox-container-42',
			})
		})

		it('returns false when TC API throws', async () => {
			const { deps, browserApi } = createMockDeps({
				tempContainersExtensionId: vi.fn().mockReturnValue('{tc-ext}'),
			})
			;(browserApi.runtime.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'))
			const tec = new TabExecutionControllerImpl(deps)

			expect(await tec.isTempContainer('firefox-container-1')).toBe(false)
		})
	})

	describe('syncPageActionVisibilityForTab', () => {
		it('shows page action when setting is enabled and not already shown', async () => {
			const { deps, browserApi } = createMockDeps()
			;(browserApi.pageAction.isShown as ReturnType<typeof vi.fn>).mockResolvedValue(false)
			const tec = new TabExecutionControllerImpl(deps)

			await tec.syncPageActionVisibilityForTab(1)

			expect(browserApi.pageAction.show).toHaveBeenCalledWith(1)
		})

		it('hides page action when setting is disabled and currently shown', async () => {
			const settings = createDefaultSettings()
			settings.showPageActionButton = false
			const { deps, browserApi } = createMockDeps({
				settings: vi.fn().mockResolvedValue(settings),
			})
			;(browserApi.pageAction.isShown as ReturnType<typeof vi.fn>).mockResolvedValue(true)
			const tec = new TabExecutionControllerImpl(deps)

			await tec.syncPageActionVisibilityForTab(1)

			expect(browserApi.pageAction.hide).toHaveBeenCalledWith(1)
		})

		it('skips show/hide when already in desired state', async () => {
			const { deps, browserApi } = createMockDeps()
			;(browserApi.pageAction.isShown as ReturnType<typeof vi.fn>).mockResolvedValue(true)
			const tec = new TabExecutionControllerImpl(deps)

			await tec.syncPageActionVisibilityForTab(1)

			expect(browserApi.pageAction.show).not.toHaveBeenCalled()
			expect(browserApi.pageAction.hide).not.toHaveBeenCalled()
		})
	})

	describe('handlePageActionClicked', () => {
		it('creates bookmark and assigns to container when tab has container', async () => {
			const { deps, browserApi } = createMockDeps()
			const tec = new TabExecutionControllerImpl(deps)
			const tab = makeTab({ id: 1, url: 'https://example.com', title: 'Example Page', cookieStoreId: 'firefox-container-1' })

			await tec.handlePageActionClicked(tab)

			expect(browserApi.bookmarks.create).toHaveBeenCalledWith({
				parentId: 'toolbar_____',
				index: 0,
				title: 'Example Pa',
				url: 'https://example.com',
			})
			expect(deps.updateBookmarkContainerUrl).toHaveBeenCalled()
			expect(browserApi.notifications.create).toHaveBeenCalled()
		})

		it('creates plain bookmark when tab has no container', async () => {
			const { deps, browserApi } = createMockDeps()
			const tec = new TabExecutionControllerImpl(deps)
			const tab = makeTab({ cookieStoreId: NO_CONTAINER, url: 'https://plain.com', title: 'Plain' })

			await tec.handlePageActionClicked(tab)

			expect(browserApi.bookmarks.create).toHaveBeenCalled()
			expect(deps.updateBookmarkContainerUrl).not.toHaveBeenCalled()
		})

		it('does nothing when tab has no URL', async () => {
			const { deps, browserApi } = createMockDeps()
			const tec = new TabExecutionControllerImpl(deps)

			await tec.handlePageActionClicked({ id: 1, index: 0 })

			expect(browserApi.bookmarks.create).not.toHaveBeenCalled()
		})

		it('assigns TEMP_CONTAINER_SENTINEL when tab is in a temp container', async () => {
			const tcExtId = '{tc-ext}'
			const { deps, browserApi } = createMockDeps({
				tempContainersExtensionId: vi.fn().mockReturnValue(tcExtId),
			})
			;(browserApi.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(true)
			const tec = new TabExecutionControllerImpl(deps)
			const tab = makeTab({ cookieStoreId: 'firefox-tmp-42', url: 'https://temp-page.com', title: 'Temp Page' })

			await tec.handlePageActionClicked(tab)

			expect(deps.updateBookmarkContainerUrl).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'created-1' }),
				TEMP_CONTAINER_SENTINEL,
			)
			expect(browserApi.notifications.create).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining('a Temporary Container'),
				}),
			)
		})

		it('hides page action and returns when setting is disabled', async () => {
			const settings = createDefaultSettings()
			settings.showPageActionButton = false
			const { deps, browserApi } = createMockDeps({
				settings: vi.fn().mockResolvedValue(settings),
			})
			const tec = new TabExecutionControllerImpl(deps)
			const tab = makeTab({ id: 5 })

			await tec.handlePageActionClicked(tab)

			expect(browserApi.bookmarks.create).not.toHaveBeenCalled()
		})
	})
})
