export const ENABLE_DEBUG_DEFAULT = true
export const NO_CONTAINER = 'firefox-default'
export const HOTSWAP_STORAGE_KEY = 'containMarks.hotswaps'

/** Sentinel cookieStoreId stored in mappings to indicate "open in a fresh Temporary Container". */
export const TEMP_CONTAINER_SENTINEL = 'temp-container'

/**
 * Gecko extension IDs for both Temporary Containers variants.
 * The original (stoically) is unmaintained but still widely installed.
 * TC+ (GodKratos) is the actively-maintained fork with identical API.
 */
export const TEMP_CONTAINERS_EXTENSION_IDS = [
	'{c607c8df-14a7-4f28-894f-29e8722976af}',  // Temporary Containers (stoically)
	'{1ea2fa75-677e-4702-b06a-50fc7d06fe7e}',  // Temporary Containers Plus (GodKratos)
] as const

import type {
	BrowserApi,
	ContainMarksSettings,
	LoggerLike,
	StorageLike,
	Tab,
	TabChangeInfo,
} from './models'
import { ContainerMappingStore } from './containerMappingStore'
import {
	DELIMITER,
	FRAGMENT_PREFIX,
	PREFIX,
	getNewUrl,
	isLegacyEncodedUrl,
	readLegacyStorageKeys,
	readLegacyReference,
	parseLegacyBookmarkUrl,
} from './urlCodec'
import { loadSettings, saveSettings } from './settings'
import { BookmarkAssignmentManagerImpl } from './background/bookmarkAssignmentManager'
import type { BookmarkAssignmentManager } from './background/bookmarkAssignmentManager'
import { NavigationPolicyEngineImpl } from './background/navigationPolicyEngine'
import type { NavigationPolicyEngine } from './background/navigationPolicyEngine'
import { TabExecutionControllerImpl } from './background/tabExecutionController'
import type { TabExecutionController } from './background/tabExecutionController'

export { DELIMITER, FRAGMENT_PREFIX, PREFIX, getNewUrl, isFragmentEncodedUrl, isLegacyEncodedUrl, isPrefixedUrl, parseBookmarkUrl, parseLegacyBookmarkUrl } from './urlCodec'

/**
 * Thin orchestration layer — wires extracted modules and handles startup/migration.
 *
 * Event handling is delegated entirely to the extracted modules:
 * - BookmarkAssignmentManager: menus, bookmark events, hotswap lifecycle
 * - NavigationPolicyEngine: webNavigation/webRequest interception, intent resolution
 * - TabExecutionController: tab redirects, page action, intent execution
 *
 * BackgroundApp retains only:
 * - Module instantiation and inter-module wiring
 * - Startup sequence orchestration
 * - One-time migration logic (legacy storage, about: bookmarks, token refresh)
 */
export class BackgroundApp {
	/** Debug mode is suppressed during `initialize()` to avoid startup noise in the console. */
	public enableDebug = ENABLE_DEBUG_DEFAULT

	/** Lazily loaded once — avoids re-reading storage on every operation that needs settings. */
	private get settings(): Promise<ContainMarksSettings> {
		return loadSettings(this.browserApi)
	}
	/** Container mappings backed by synced bookmarks — works across devices. */
	private readonly syncMappingStore: ContainerMappingStore
	/** Container mappings backed by local bookmarks — device-specific, faster. */
	private readonly localMappingStore: ContainerMappingStore

	// --- Extracted modules ---
	private readonly bookmarkAssignmentManager: BookmarkAssignmentManager
	private readonly navigationPolicyEngine: NavigationPolicyEngine
	private readonly tabExecutionController: TabExecutionController

	public constructor(
		private readonly browserApi: BrowserApi,
		private readonly storage: StorageLike,
		private readonly logger: LoggerLike = console,
		private readonly randomValue: () => number = Math.random
	) {
		this.syncMappingStore = new ContainerMappingStore(this.browserApi, this.logger, { enableBookmarkSync: true })
		this.localMappingStore = new ContainerMappingStore(this.browserApi, this.logger, { enableBookmarkSync: false })

		this.bookmarkAssignmentManager = new BookmarkAssignmentManagerImpl({
			browserApi: this.browserApi,
			storage: this.storage,
			logger: this.logger,
			randomValue: this.randomValue,
			settings: () => this.settings,
			mappingStore: (s) => this.getMappingStore(s),
		})

		this.tabExecutionController = new TabExecutionControllerImpl({
			browserApi: this.browserApi,
			logger: this.logger,
			settings: () => this.settings,
			mappingStore: (s) => this.getMappingStore(s),
			tempContainersExtensionId: () => this.bookmarkAssignmentManager.tempContainersExtensionId,
			getContainer: (q) => this.bookmarkAssignmentManager.getContainer(q),
			updateBookmarkContainerUrl: (b, c) => this.bookmarkAssignmentManager.updateBookmarkContainerUrl(b, c),
			isTempContainer: (c) => this.bookmarkAssignmentManager.isTempContainer(c),
		})

		this.navigationPolicyEngine = new NavigationPolicyEngineImpl({
			browserApi: this.browserApi,
			logger: this.logger,
			settings: () => this.settings,
			mappingStore: (s) => this.getMappingStore(s),
			hotswapRedirectMap: () => this.bookmarkAssignmentManager.hotswapRedirectMap,
			consumeHotswapRedirect: (url) => this.bookmarkAssignmentManager.consumeHotswapRedirect(url),
			onIntentResolved: (intent, tabId) => {
				void (async () => {
					try {
						const tab = await this.browserApi.tabs.get(tabId)
						await this.tabExecutionController.executeIntent(intent, tab)
					} catch (error) {
						this.debug('onIntentResolved: error', error)
					}
				})()
			},
		})
	}

	public debug(...args: unknown[]): void {
		if (this.enableDebug) {
			this.logger.log(...args)
		}
	}

	/**
	 * Bootstrap entry point — called once at extension load. Suppresses debug logging during
	 * startup to keep the console clean, then re-enables it. Fires startup, menu creation,
	 * and listener registration concurrently since they're independent.
	 */
	public initialize(): void {
		const realDebug = this.enableDebug
		this.enableDebug = false
		void this.startup().finally(() => {
			this.enableDebug = realDebug
		})

		void this.bookmarkAssignmentManager.createMenuItems()
		this.registerListeners()
	}

	/**
	 * Ordered startup sequence — must run before any bookmark/tab event handling because it
	 * initializes the mapping store and recovers from crashes. Also auto-reverts the one-session
	 * `allowEncodedBookmarkImport` bypass so it never persists across restarts.
	 */
	public async startup(): Promise<void> {
		const settings = await this.settings
		const mappingStore = this.getMappingStore(settings)
		await mappingStore.initialize()

		// Detect TC extension + recover hotswap records (delegated to BAM)
		await this.bookmarkAssignmentManager.initialize()

		// Auto-revert the one-session bypass — always reset on startup
		if (settings.allowEncodedBookmarkImport) {
			await saveSettings(this.browserApi, { ...settings, allowEncodedBookmarkImport: false })
		}

		await this.migrateLegacyStorage(mappingStore)
		await this.migrateAboutBookmarks(mappingStore)
		await this.tabExecutionController.syncPageActionVisibilityForAllTabs()

		if (settings.resetTokensOnStartup) {
			await this.refreshTokensOnStartup(mappingStore)
		}
	}

	// --- Migration helpers (one-time, stay in BackgroundApp) ---

	/**
	 * One-time migration from the original `localStorage`-based container mapping to the current
	 * bookmark-based mapping store. Reads and deletes each legacy key, then re-encodes the
	 * bookmark URL with the new mapping index.
	 */
	private async migrateLegacyStorage(mappingStore: ContainerMappingStore): Promise<void> {
		for (const key of readLegacyStorageKeys(this.storage)) {
			const reference = readLegacyReference(this.storage, key)
			if (!reference || !reference?.backupName) continue;
			this.storage.removeItem(key)

			const identity = await this.bookmarkAssignmentManager.getContainer({ backupName: reference.backupName })
			if (!identity) continue;
			const mapping = await mappingStore.ensureMappingForContainer(identity)
			if (!mapping) continue;

			try {
				const bookmark = (await this.browserApi.bookmarks.get(reference.bookmarkId))[0]
				if (!bookmark?.id) {
					continue
				}

				const parsed = parseLegacyBookmarkUrl(bookmark)
				if (!parsed || !parsed.token || parsed.containerIndex !== null) {
					continue
				}

				const migratedUrl = getNewUrl({ value: parsed.token }, mapping.firstSeenIndex, parsed.url)
				if (bookmark.url !== migratedUrl) {
					await this.browserApi.bookmarks.update(bookmark.id, { url: migratedUrl })
				}
			} catch (error) {
				this.debug(error)
			}
		}
	}

	/**
	 * Converts legacy `about:token:idx:url` bookmarks to the fragment-based scheme.
	 * Only touches bookmarks that match the old encoding — mapping bookmark URLs
	 * (short numeric "tokens") are excluded by isPrefixedUrl's token-length check.
	 */
	private async migrateAboutBookmarks(mappingStore: ContainerMappingStore): Promise<void> {
		const bookmarks = await this.browserApi.bookmarks.search({ query: `${PREFIX}${DELIMITER}` })
		for (const bookmark of bookmarks) {
			if (bookmark.type !== 'bookmark' || typeof bookmark.url !== 'string') continue
			if (!isLegacyEncodedUrl(bookmark.url)) continue

			const parsed = parseLegacyBookmarkUrl(bookmark)
			if (!parsed || !parsed.token || parsed.containerIndex === null) continue

			const mapping = mappingStore.getByIndex(parsed.containerIndex)
			if (!mapping) continue

			const newUrl = getNewUrl({ value: parsed.token }, parsed.containerIndex, parsed.url)
			if (bookmark.url !== newUrl) {
				await this.browserApi.bookmarks.update(bookmark.id, { url: newUrl })
			}
		}
	}

	/**
	 * Security feature: regenerates all bookmark tokens on startup when `resetTokensOnStartup`
	 * is enabled. Prevents token-based URL prediction by ensuring tokens change every session.
	 */
	private async refreshTokensOnStartup(mappingStore: ContainerMappingStore): Promise<void> {
		const legacyBookmarks = await this.browserApi.bookmarks.search({ query: `${PREFIX}${DELIMITER}` })
		const fragmentBookmarks = await this.browserApi.bookmarks.search({ query: `#${FRAGMENT_PREFIX}${DELIMITER}` })

		const seen = new Set<string>()
		const allBookmarks = [...legacyBookmarks, ...fragmentBookmarks].filter(bookmark => {
			if (seen.has(bookmark.id)) return false
			seen.add(bookmark.id)
			return true
		})

		for (const bookmark of allBookmarks) {
			const parsed = parseLegacyBookmarkUrl(bookmark)
			if (!parsed || !parsed.token || parsed.containerIndex === null) {
				continue
			}
			const mapping = mappingStore.getByIndex(parsed.containerIndex)
			if (!mapping) {
				continue
			}
			await this.bookmarkAssignmentManager.updateBookmarkContainerUrl(bookmark)
		}
	}

	// --- Core helpers ---

	/** Routes to sync or local mapping store based on user preference. */
	private getMappingStore(settings: ContainMarksSettings): ContainerMappingStore {
		return settings.enableBookmarkSync ? this.syncMappingStore : this.localMappingStore
	}

	// --- Delegate event handlers ---

	/**
	 * Thin routing for `tabs.onUpdated` — page-action sync stays here (UI concern),
	 * all navigation policy evaluation is delegated to NavigationPolicyEngine.
	 */
	public readonly handleTabUpdated = async (id: number, change: TabChangeInfo, tab: Tab): Promise<void> => {
		// Page action sync on load complete
		if (change.status === 'complete' && id !== this.browserApi.tabs.TAB_ID_NONE) {
			await this.tabExecutionController.syncPageActionVisibilityForTab(id)
		}

		if (id === this.browserApi.tabs.TAB_ID_NONE) return

		const currentUrl = tab.url ?? change.url ?? ''
		const intent = await this.navigationPolicyEngine.evaluateTabUpdated(currentUrl, tab, change)
		if (intent.action !== 'noop') {
			await this.tabExecutionController.executeIntent(intent, tab)
		}
	}

	/** Updates page-action visibility when the user switches to a different tab. */
	public readonly handleTabActivated = async (activeInfo: { tabId: number }): Promise<void> => {
		try {
			if (activeInfo.tabId !== this.browserApi.tabs.TAB_ID_NONE) {
				await this.tabExecutionController.syncPageActionVisibilityForTab(activeInfo.tabId)
			}
		} catch (error) {
			this.debug(error)
		}
	}

	/**
	 * Intercepts "Open in New Tab" clicks during a hotswap window. Evaluates the
	 * newly-created tab's URL against the hotswap redirect map via NPE.
	 */
	public readonly handleTabCreated = async (tab: Tab): Promise<void> => {
		if (!tab.url || !tab.id) return

		const intent = await this.navigationPolicyEngine.evaluateHotswapRedirect(tab.url, tab)
		if (intent.action !== 'noop') {
			await this.tabExecutionController.executeIntent(intent, tab)
		}
	}

	/**
	 * Insurance handler for "Open in New Window" during a hotswap. Queries tabs in
	 * the new window and checks their URLs against the hotswap redirect map via NPE.
	 */
	public readonly handleWindowCreated = async (window: import('./models').Window): Promise<void> => {
		if (!window.id) return

		try {
			const tabs = await this.browserApi.tabs.query({ windowId: window.id })
			for (const tab of tabs) {
				if (!tab.url || !tab.id) continue

				const intent = await this.navigationPolicyEngine.evaluateHotswapRedirect(tab.url, tab)
				if (intent.action !== 'noop') {
					await this.tabExecutionController.executeIntent(intent, tab)
				}
			}
		} catch (error) {
			this.debug('handleWindowCreated: error', error)
		}
	}

	/** Wires all browser event listeners to the appropriate module handlers. */
	private registerListeners(): void {
		// Menu events → BookmarkAssignmentManager
		this.browserApi.menus.onClicked.addListener(this.bookmarkAssignmentManager.handleMenuClick)
		this.browserApi.menus.onShown.addListener(this.bookmarkAssignmentManager.handleMenuShown)
		this.browserApi.menus.onHidden.addListener(this.bookmarkAssignmentManager.handleMenuHidden)

		// Tab/window events → delegate handlers (evaluate via NPE, execute via TEC)
		this.browserApi.tabs.onUpdated.addListener(this.handleTabUpdated)
		this.browserApi.tabs.onActivated.addListener(this.handleTabActivated)
		this.browserApi.tabs.onCreated.addListener(this.handleTabCreated)
		this.browserApi.windows.onCreated.addListener(this.handleWindowCreated)

		// Page action → TabExecutionController
		this.browserApi.pageAction.onClicked.addListener(this.tabExecutionController.handlePageActionClicked)

		// Bookmark events → BookmarkAssignmentManager
		this.browserApi.bookmarks.onChanged.addListener(this.bookmarkAssignmentManager.handleBookmarkChanged)
		this.browserApi.bookmarks.onCreated.addListener(this.bookmarkAssignmentManager.handleBookmarkCreated)

		// Web navigation/request interception → NavigationPolicyEngine
		this.browserApi.webNavigation.onBeforeNavigate.addListener(this.navigationPolicyEngine.handleBeforeNavigate)
		this.browserApi.webRequest.onBeforeRequest.addListener(
			this.navigationPolicyEngine.handleBeforeRequest,
			{ urls: ['<all_urls>'], types: ['main_frame'] },
			['blocking']
		)
	}
}