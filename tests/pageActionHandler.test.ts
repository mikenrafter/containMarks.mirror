import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PageActionHandlerImpl } from '../src/background/pageActionHandler'
import type { PageActionHandlerDeps } from '../src/background/pageActionHandler'
import type { BrowserApi, Tab, ContainMarksSettings } from '../src/models'
import { NO_CONTAINER, TEMP_CONTAINER_SENTINEL } from '../src/constants'

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
			update: vi.fn().mockImplementation(async (tabId: number) => ({ id: tabId, index: 0 })),
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

function createMockDeps(overrides: Partial<PageActionHandlerDeps> = {}): {
	deps: PageActionHandlerDeps
	browserApi: BrowserApi
} {
	const browserApi = createMockBrowserApi()
	const settings = createDefaultSettings()

	const deps: PageActionHandlerDeps = {
		browserApi,
		logger: { log: vi.fn() },
		settings: vi.fn().mockResolvedValue(settings),
		updateBookmarkContainerUrl: vi.fn().mockResolvedValue(null),
		isTempContainer: vi.fn().mockResolvedValue(false),
		...overrides,
	}

	return { deps, browserApi }
}

function makeTab(overrides: Partial<Tab> = {}): Tab {
	return { id: 1, url: 'https://example.com', index: 0, cookieStoreId: NO_CONTAINER, ...overrides }
}

// --- Tests ---

describe('PageActionHandlerImpl', () => {
	describe('syncPageActionVisibilityForTab', () => {
		it('shows page action when setting is enabled and not already shown', async () => {
			const { deps, browserApi } = createMockDeps()
			;(browserApi.pageAction.isShown as ReturnType<typeof vi.fn>).mockResolvedValue(false)
			;(browserApi.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, index: 0, cookieStoreId: 'firefox-container-1' })
			const handler = new PageActionHandlerImpl(deps)

			await handler.syncPageActionVisibilityForTab(1)

			expect(browserApi.pageAction.show).toHaveBeenCalledWith(1)
		})

		it('hides page action when setting is disabled and currently shown', async () => {
			const settings = createDefaultSettings()
			settings.showPageActionButton = false
			const { deps, browserApi } = createMockDeps({
				settings: vi.fn().mockResolvedValue(settings),
			})
			;(browserApi.pageAction.isShown as ReturnType<typeof vi.fn>).mockResolvedValue(true)
			const handler = new PageActionHandlerImpl(deps)

			await handler.syncPageActionVisibilityForTab(1)

			expect(browserApi.pageAction.hide).toHaveBeenCalledWith(1)
		})

		it('skips show/hide when already in desired state', async () => {
			const { deps, browserApi } = createMockDeps()
			;(browserApi.pageAction.isShown as ReturnType<typeof vi.fn>).mockResolvedValue(true)
			;(browserApi.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, index: 0, cookieStoreId: 'firefox-container-1' })
			const handler = new PageActionHandlerImpl(deps)

			await handler.syncPageActionVisibilityForTab(1)

			expect(browserApi.pageAction.show).not.toHaveBeenCalled()
			expect(browserApi.pageAction.hide).not.toHaveBeenCalled()
		})
	})

	describe('handlePageActionClicked', () => {
		it('creates bookmark and assigns to container when tab has container', async () => {
			const { deps, browserApi } = createMockDeps()
			const handler = new PageActionHandlerImpl(deps)
			const tab = makeTab({ id: 1, url: 'https://example.com', title: 'Example Page', cookieStoreId: 'firefox-container-1' })

			await handler.handlePageActionClicked(tab)

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
			const handler = new PageActionHandlerImpl(deps)
			const tab = makeTab({ cookieStoreId: NO_CONTAINER, url: 'https://plain.com', title: 'Plain' })

			await handler.handlePageActionClicked(tab)

			expect(browserApi.bookmarks.create).toHaveBeenCalled()
			expect(deps.updateBookmarkContainerUrl).not.toHaveBeenCalled()
		})

		it('does nothing when tab has no URL', async () => {
			const { deps, browserApi } = createMockDeps()
			const handler = new PageActionHandlerImpl(deps)

			await handler.handlePageActionClicked({ id: 1, index: 0 })

			expect(browserApi.bookmarks.create).not.toHaveBeenCalled()
		})

		it('assigns TEMP_CONTAINER_SENTINEL when tab is in a temp container', async () => {
			const { deps, browserApi } = createMockDeps({
				isTempContainer: vi.fn().mockResolvedValue(true),
			})
			const handler = new PageActionHandlerImpl(deps)
			const tab = makeTab({ cookieStoreId: 'firefox-tmp-42', url: 'https://temp-page.com', title: 'Temp Page' })

			await handler.handlePageActionClicked(tab)

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
			const handler = new PageActionHandlerImpl(deps)
			const tab = makeTab({ id: 5 })

			await handler.handlePageActionClicked(tab)

			expect(browserApi.bookmarks.create).not.toHaveBeenCalled()
		})
	})
})
