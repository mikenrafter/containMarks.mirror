/**
 * @module ContainMarksRuntime
 * @role Top-level orchestrator — owns the navigation interception pipeline, module wiring, and startup/migration.
 * @ownsState pendingCancellations, claimedTabIds, syncMappingStore, localMappingStore
 * @tests tests/backgroundApp.test.ts (existing, will adapt)
 *
 * Replaces the former BackgroundApp + NavigationPolicyEngine pair with a unified pipeline that
 * routes navigation events directly through handler modules:
 *
 *   onBeforeNavigate (sync)  →  hotswap.detect() / standard.detect()  →  pendingCancellations
 *   onBeforeRequest  (sync)  →  cancel request if pending  →  claimedTabIds
 *   activateNavigation (async)  →  hotswap.activate() or standard.activate() wrapped by TC layer
 *   tabs.onUpdated   (async)  →  fallback detection for non-HTTP navigations
 *
 * Module responsibilities:
 * - HotswapHandler: bookmark decode/revert lifecycle, hotswap redirect map, bookmark events
 * - StandardHandler: fragment-encoded bookmark URL detection and container redirect
 * - TempContainerLayer: TC/TC+ extension detection, redirect wrapping, orphan cleanup
 * - BookmarkAssignmentManager: context menu management, container resolution, bookmark encoding
 * - PageActionHandler: page action visibility and click handling only *
 * Startup migrations (one-time, non-recurring) are inlined here:
 * - Legacy localStorage → bookmark-based mapping migration
 * - Legacy about: scheme → fragment-encoded URL migration
 * - Token refresh on startup (security feature)
 *
 * Boundary contract:
 * - Only module that calls registerListeners() and initialize().
 * - Owns the pipeline state (pendingCancellations, claimedTabIds).
 * - background.ts still uses BackgroundApp — this is a parallel implementation.
 *
 * Failure modes:
 * - Startup migration failure: logged, extension continues with reduced functionality.
 * - Individual listener callback failure: caught and logged, other listeners unaffected.
 * - TC not installed: wrapRedirect becomes passthrough, TC menu item hidden.
 */

import type {
	BlockingResponse,
	BookmarkNode,
	BrowserApi,
	ContainMarksSettings,
	LoggerLike,
	MenusOnShownInfo,
	StorageLike,
	Tab,
	TabActivatedInfo,
	TabChangeInfo,
	WebNavigationBeforeNavigateDetails,
	WebRequestBeforeRequestDetails,
	Window,
} from '../models'
import { ContainerMappingStore } from '../mappings/containerMappingStore'
import {
	DELIMITER,
	FRAGMENT_PREFIX,
	PREFIX,
	getNewUrl,
	isFragmentEncodedUrl,
	isLegacyEncodedUrl,
	parseLegacyBookmarkUrl,
	readLegacyReference,
	readLegacyStorageKeys,
} from '../urlCodec'
import { loadSettings, saveSettings } from '../preferences/settings'

import { HotswapHandlerImpl } from './hotswapHandler'
import type { HotswapHandler } from './hotswapHandler'
import { StandardHandlerImpl } from './standardHandler'
import type { StandardHandler } from './standardHandler'
import { TempContainerLayerImpl } from './tempContainerLayer'
import type { TempContainerLayer } from './tempContainerLayer'
import { BookmarkAssignmentManagerImpl } from './bookmarkAssignmentManager'
import type { BookmarkAssignmentManager } from './bookmarkAssignmentManager'
import { PageActionHandlerImpl } from './pageActionHandler'
import type { PageActionHandler } from './pageActionHandler'

import {
	ENABLE_DEBUG_DEFAULT,
	NO_CONTAINER,
	TEMP_CONTAINER_SENTINEL,
} from '../constants'

// Re-export constants and codec functions for external consumers (mirrors backgroundApp exports).
export { ENABLE_DEBUG_DEFAULT, NO_CONTAINER, TEMP_CONTAINER_SENTINEL }
export { DELIMITER, FRAGMENT_PREFIX, PREFIX, getNewUrl, isFragmentEncodedUrl, isLegacyEncodedUrl } from '../urlCodec'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ContainMarksRuntimeDeps {
	readonly browserApi: BrowserApi
	readonly storage: StorageLike
	readonly logger: LoggerLike
	readonly randomValue: () => number
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Top-level extension background process orchestrator.
 *
 * Owns the navigation interception pipeline, module construction, startup/migration,
 * and browser event listener registration. Exposes module accessors for testing.
 */
export interface ContainMarksRuntime {
	/** Debug mode toggle — suppressed during startup to reduce console noise. */
	enableDebug: boolean

	// --- Module accessors (for testing and diagnostics) ---

	readonly hotswapHandler: HotswapHandler
	readonly standardHandler: StandardHandler
	readonly tcLayer: TempContainerLayer
	readonly assignmentManager: BookmarkAssignmentManager
	readonly pageActionHandler: PageActionHandler

	// --- Lifecycle ---

	/**
	 * Bootstrap entry point — called once at extension load.
	 * Suppresses debug logging during startup, fires startup() + listener
	 * registration, then re-enables debug logging.
	 */
	initialize(): void

	// --- Pipeline event handlers (exposed for testing) ---

	/** Synchronous — detects hotswap/standard URLs, populates pendingCancellations. */
	readonly handleBeforeNavigate: (details: WebNavigationBeforeNavigateDetails) => void
	/** Synchronous blocking — cancels pending navigations, returns { cancel: true }. */
	readonly handleBeforeRequest: (details: WebRequestBeforeRequestDetails) => BlockingResponse | void
	/** Async fallback — handles navigations that webRequest didn't catch. */
	readonly handleTabUpdated: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => Promise<void>
	/** Page action sync on tab switch. */
	readonly handleTabActivated: (activeInfo: TabActivatedInfo) => Promise<void>
	/** Intercepts newly-created tabs (e.g. "Open in New Tab" during hotswap). */
	readonly handleTabCreated: (tab: Tab) => Promise<void>
	/** Intercepts tabs in newly-created windows (e.g. "Open in New Window" during hotswap). */
	readonly handleWindowCreated: (window: Window) => Promise<void>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ContainMarksRuntimeImpl implements ContainMarksRuntime {
	public enableDebug = ENABLE_DEBUG_DEFAULT

	// --- Pipeline state ---

	/**
	 * Maps tabId → handler type for navigations detected by handleBeforeNavigate
	 * that are awaiting cancellation by handleBeforeRequest. Short-lived: cleared
	 * when webRequest fires, or consumed by handleTabUpdated as fallback.
	 */
	private readonly pendingCancellations = new Map<number, 'hotswap' | 'standard'>()

	/**
	 * Tab IDs whose requests were cancelled by handleBeforeRequest. Prevents handleTabUpdated
	 * from double-processing the same navigation. Cleared one microtask after insertion via
	 * setTimeout(0) — enough time for handleTabUpdated to see it, but not long enough to
	 * interfere with future navigations on the same tab.
	 */
	private readonly claimedTabIds = new Set<number>()

	/**
	 * URLs currently being activated (redirect in flight). Prevents TC replacement tabs
	 * from triggering a second redirect for the same encoded URL. When TC creates a new
	 * tab for an intercepted navigation, our handleTabUpdated/handleTabCreated might see
	 * the same encoded URL again — this set deduplicates.
	 */
	private readonly activatingUrls = new Set<string>()

	// --- Mapping stores ---

	/** Container mappings backed by synced bookmarks — works across devices. */
	private readonly syncMappingStore: ContainerMappingStore
	/** Container mappings backed by local bookmarks — device-specific, faster. */
	private readonly localMappingStore: ContainerMappingStore

	// --- Modules ---

	private readonly _hotswapHandler: HotswapHandler
	private readonly _standardHandler: StandardHandler
	private readonly _tcLayer: TempContainerLayer
	private readonly _bam: BookmarkAssignmentManager
	private readonly _pageAction: PageActionHandler

	private readonly browserApi: BrowserApi
	private readonly storage: StorageLike
	private readonly logger: LoggerLike
	private readonly randomValue: () => number

	constructor(deps: ContainMarksRuntimeDeps) {
		this.browserApi = deps.browserApi
		this.storage = deps.storage
		this.logger = deps.logger
		this.randomValue = deps.randomValue

		this.syncMappingStore = new ContainerMappingStore(this.browserApi, this.logger, { enableBookmarkSync: true })
		this.localMappingStore = new ContainerMappingStore(this.browserApi, this.logger, { enableBookmarkSync: false })

		// BAM — menu management, container resolution, bookmark encoding.
		// Constructed first because other modules depend on getContainer/updateBookmarkContainerUrl.
		this._bam = new BookmarkAssignmentManagerImpl({
			browserApi: this.browserApi,
			storage: this.storage,
			logger: this.logger,
			randomValue: this.randomValue,
			settings: () => this.settings,
			mappingStore: (s) => this.getMappingStore(s),
		})

		// TC layer — TC/TC+ detection, redirect wrapping, orphan cleanup
		this._tcLayer = new TempContainerLayerImpl({
			browserApi: this.browserApi,
			logger: this.logger,
		})

		// Hotswap handler — bookmark decode/revert lifecycle, redirect map, bookmark events
		this._hotswapHandler = new HotswapHandlerImpl({
			browserApi: this.browserApi,
			storage: this.storage,
			logger: this.logger,
			randomValue: this.randomValue,
			settings: () => this.settings,
			mappingStore: (s) => this.getMappingStore(s),
			getContainer: (q) => this._bam.getContainer(q),
			openInTempContainer: (url, tab, pre) => this._tcLayer.openInTempContainer(url, tab, pre),
		    cleanupOrphanedTabs: (windowId: number, excludeCookieStoreId: string | null, knownTabIds: ReadonlySet<number | undefined>) => this._tcLayer.cleanupOrphanedTabs(windowId, excludeCookieStoreId || '', knownTabIds),
		})

		// Standard handler — fragment/legacy encoded URL detection and container redirect
		this._standardHandler = new StandardHandlerImpl({
			browserApi: this.browserApi,
			logger: this.logger,
			settings: () => this.settings,
			mappingStore: (s) => this.getMappingStore(s),
			getContainer: (q) => this._bam.getContainer(q),
			updateBookmarkContainerUrl: (b, c) => this._bam.updateBookmarkContainerUrl(b, c),
			openInTempContainer: (url, tab, pre) => this._tcLayer.openInTempContainer(url, tab, pre),
			cleanupOrphanedTabs: (windowId: number, excludeCookieStoreId: string | null, knownTabIds: ReadonlySet<number | undefined>) => this._tcLayer.cleanupOrphanedTabs(windowId, excludeCookieStoreId || '', knownTabIds),
		})

		// Page action — visibility sync and click-to-bookmark
		this._pageAction = new PageActionHandlerImpl({
			browserApi: this.browserApi,
			logger: this.logger,
			settings: () => this.settings,
			updateBookmarkContainerUrl: (b, c) => this._bam.updateBookmarkContainerUrl(b, c),
			isTempContainer: (c) => this._tcLayer.isTempContainer(c),
		})
	}

	// --- Module accessors ---

	get hotswapHandler(): HotswapHandler { return this._hotswapHandler }
	get standardHandler(): StandardHandler { return this._standardHandler }
	get tcLayer(): TempContainerLayer { return this._tcLayer }
	get assignmentManager(): BookmarkAssignmentManager { return this._bam }
	get pageActionHandler(): PageActionHandler { return this._pageAction }

	// --- Settings ---

	/** Lazily loaded from storage on each access — settings can change at any time. */
	private get settings(): Promise<ContainMarksSettings> {
		return loadSettings(this.browserApi)
	}

	/** Routes to sync or local mapping store based on user preference. */
	private getMappingStore(settings: ContainMarksSettings): ContainerMappingStore {
		return settings.enableBookmarkSync ? this.syncMappingStore : this.localMappingStore
	}

	// --- Debug ---

	private debug(...args: unknown[]): void {
		if (this.enableDebug) {
			this.logger.log(...args)
		}
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/**
	 * Bootstrap entry point — called once at extension load. Suppresses debug logging
	 * during startup to keep the console clean, restores it afterward.
	 */
	initialize(): void {
		const realDebug = this.enableDebug
		this.enableDebug = false
		void this.startup().finally(() => {
			this.enableDebug = realDebug
		})

		// Build the initial context menu (no bookmark context — generic menu items).
		void this._bam.createMenuItems()

		this.registerListeners()
	}

	/**
	 * Ordered startup sequence — must complete before event handlers depend on mapping
	 * state. Initializes stores, detects TC, recovers hotswaps, runs migrations, and
	 * syncs the page action.
	 */
	private async startup(): Promise<void> {
		const settings = await this.settings
		const mappingStore = this.getMappingStore(settings)
		await mappingStore.initialize()

		// TC detection (TempContainerLayer is the canonical owner)
		await this._tcLayer.initialize()

		// Hotswap crash recovery (re-encodes bookmarks left decoded)
		await this._hotswapHandler.initialize()

		// BAM init: redundant TC detection + hotswap recovery (idempotent),
		// but needed because BAM reads its own _tempContainersExtensionId for menu items.
		await this._bam.initialize()

		// Auto-revert the one-session allowEncodedBookmarkImport bypass
		if (settings.allowEncodedBookmarkImport) {
			await saveSettings(this.browserApi, { ...settings, allowEncodedBookmarkImport: false })
		}

		await this.migrateLegacyStorage(mappingStore)
		await this.migrateAboutBookmarks(mappingStore)
		await this._pageAction.syncPageActionVisibilityForAllTabs()

		if (settings.resetTokensOnStartup) {
			await this.refreshTokensOnStartup(mappingStore)
		}
	}

	// =========================================================================
	// Navigation Pipeline — Synchronous Interception
	// =========================================================================

	/**
	 * `webNavigation.onBeforeNavigate` — fully synchronous, no awaits.
	 *
	 * Probes the URL against hotswap and standard handlers. If either claims the URL,
	 * the tab is flagged in `pendingCancellations` for the subsequent `onBeforeRequest`
	 * handler to cancel. The async activation fires as a fire-and-forget side effect.
	 */
	readonly handleBeforeNavigate = (details: WebNavigationBeforeNavigateDetails): void => {
		if (details.frameId !== 0) return

		const hotswapResult = this._hotswapHandler.detect(details.url)
		// Only check standard if hotswap didn't claim or lock the URL
		const standardResult = hotswapResult === 'pass'
			? this._standardHandler.detect(details.url)
			: 'pass' as const

		if (hotswapResult === 'claim') {
			this.pendingCancellations.set(details.tabId, 'hotswap')
		} else if (standardResult === 'claim') {
			this.pendingCancellations.set(details.tabId, 'standard')
		}

		// Fire async activation for any non-pass result
		if (hotswapResult !== 'pass' || standardResult !== 'pass') {
			void this.activateNavigation(details, hotswapResult, standardResult)
		}
	}

	/**
	 * `webRequest.onBeforeRequest` — synchronous blocking, returns `{ cancel: true }`.
	 *
	 * If the tab was flagged by handleBeforeNavigate, cancels the HTTP request to prevent
	 * the encoded URL from loading. The actual redirect runs asynchronously via
	 * activateNavigation (already fired from handleBeforeNavigate).
	 *
	 * Sets claimedTabIds so handleTabUpdated won't double-process this navigation.
	 * The setTimeout(0) cleanup gives handleTabUpdated one event-loop turn to check.
	 */
	readonly handleBeforeRequest = (details: WebRequestBeforeRequestDetails): BlockingResponse | void => {
		if (details.type !== 'main_frame') return

		const pending = this.pendingCancellations.get(details.tabId)
		if (!pending) return

		this.claimedTabIds.add(details.tabId)
		this.pendingCancellations.delete(details.tabId)
		// Clear after one event-loop turn — enough for handleTabUpdated to see it
		setTimeout(() => this.claimedTabIds.delete(details.tabId), 0)

		return { cancel: true }
	}

	// =========================================================================
	// Navigation Pipeline — Async Activation
	// =========================================================================

	/**
	 * Resolves the tab and routes to the appropriate activation handler.
	 * Called as fire-and-forget from handleBeforeNavigate.
	 */
	private async activateNavigation(
		details: WebNavigationBeforeNavigateDetails,
		hotswapResult: 'claim' | 'locked' | 'pass',
		standardResult: 'claim' | 'pass',
	): Promise<void> {
		try {
			const tab = await this.browserApi.tabs.get(details.tabId)

			if (hotswapResult === 'claim') {
				await this.activateHotswap(details.url, tab)
			} else if (hotswapResult === 'locked') {
				// URL is mid-activation by another handler. Only TC orphan cleanup
				// is needed — the primary redirect is already in flight.
				if (this._tcLayer.isPresent() && tab.windowId != null) {
					const preTabIds = this._hotswapHandler.preHotswapTabIds
					if (preTabIds) {
						await this._tcLayer.cleanupOrphanedTabs(tab.windowId, '', preTabIds)
					}
				}
			} else if (standardResult === 'claim') {
				await this.activateStandard(details.url, tab)
			}
		} catch (error) {
			this.debug('activateNavigation: error', error)
		}
	}

	/**
	 * Opens a hotswap redirect in the correct container, wrapped with TC orphan cleanup.
	 *
	 * The targetCookieStoreId is passed as '' because the redirect target is a real
	 * container (not ephemeral). TC cleanup's isTempContainer check will never match
	 * the target, so it won't be removed even without an explicit exclusion.
	 */
	private async activateHotswap(url: string, tab: Tab): Promise<void> {
		if (this.activatingUrls.has(url)) return
		this.activatingUrls.add(url)
		try {
			// Prefer the pre-hotswap snapshot (captured at menu-hidden time).
			// Fall back to live query for non-menu paths.
			const preTabIds = this._hotswapHandler.preHotswapTabIds
				?? await this.captureTabSnapshot(tab)
			await this._hotswapHandler.activate(url, tab, preTabIds)
		} catch (error) {
			this.debug('activateHotswap: error', error)
		} finally {
			this.activatingUrls.delete(url)
		}
	}

	/**
	 * Opens a standard encoded bookmark URL in the correct container.
	 */
	private async activateStandard(url: string, tab: Tab): Promise<void> {
		if (this.activatingUrls.has(url)) return
		this.activatingUrls.add(url)
		try {
			const preTabIds = await this.captureTabSnapshot(tab)
			await this._standardHandler.activate(url, tab, preTabIds)
		} catch (error) {
			this.debug('activateStandard: error', error)
		} finally {
			this.activatingUrls.delete(url)
		}
	}

	/**
	 * Captures a pre-redirect tab snapshot for TC orphan detection.
	 * Returns null when no TC extension is present or tab has no windowId.
	 */
	private async captureTabSnapshot(tab: Tab): Promise<ReadonlySet<number | undefined> | null> {
		if (!this._tcLayer.isPresent() || tab.windowId == null) return null
		const tabs = await this.browserApi.tabs.query({ windowId: tab.windowId })
		return new Set(tabs.map(t => t.id))
	}

	// =========================================================================
	// Tab / Window Event Handlers
	// =========================================================================

	/**
	 * `tabs.onUpdated` — async fallback for navigations that skipped the webRequest pipeline.
	 *
	 * Three roles:
	 * 1. Page action sync on load complete
	 * 2. Consume orphaned pendingCancellations (webRequest didn't fire for non-HTTP navigations)
	 * 3. Direct hotswap/standard detection for URL changes the pipeline missed
	 *
	 * Timing guards on standard detection prevent double-redirect:
	 * - Fragment-encoded: only on changeInfo.url (actual URL change), skip status-only updates
	 * - Legacy about: URLs: only on status 'complete'
	 */
	readonly handleTabUpdated = async (tabId: number, changeInfo: TabChangeInfo, tab: Tab): Promise<void> => {
		// Page action sync on load complete
		if (changeInfo.status === 'complete' && tabId !== this.browserApi.tabs.TAB_ID_NONE) {
			await this._pageAction.syncPageActionVisibilityForTab(tabId)

			// Strip the #TC sentinel fragment appended by TempContainerLayer.openInTempContainer.
			// The fragment prevents re-interception during the TC redirect; once the page finishes
			// loading it's safe to clean the URL so the address bar shows the real destination.
			const tabUrl = tab.url ?? ''
			if (tabUrl.endsWith('#TC')) {
				const cleanUrl = tabUrl.slice(0, -3)
				await this.browserApi.tabs.update(tabId, { url: cleanUrl, loadReplace: true })
			}
		}

		if (tabId === this.browserApi.tabs.TAB_ID_NONE) return

		// webRequest already cancelled this navigation — redirect is in flight
		if (this.claimedTabIds.has(tabId)) return

		// Orphaned pending cancellation: webRequest didn't fire because navigation
		// uses a non-HTTP scheme (about:, same-page fragment, etc.)
		const pending = this.pendingCancellations.get(tabId)
		if (pending) {
			this.pendingCancellations.delete(tabId)
			const url = tab.url ?? changeInfo.url ?? ''
			if (pending === 'hotswap') {
				await this.activateHotswap(url, tab)
			} else {
				await this.activateStandard(url, tab)
			}
			return
		}

		// Direct URL detection fallback
		const url = tab.url ?? changeInfo.url ?? ''
		if (!url) return

		// Hotswap redirect — lockedUrls mechanism in HotswapHandler prevents duplicate detection
		const hotResult = this._hotswapHandler.detect(url)
		if (hotResult === 'claim') {
			await this.activateHotswap(url, tab)
			return
		}

		// Standard encoded URL detection with timing guards to prevent double-redirect.
		// Fragment-encoded: intercept only on URL-change events (changeInfo.url present),
		// not on subsequent status-only updates after the redirect completed.
		// Legacy about: URLs: intercept only on load-complete.
		if (isFragmentEncodedUrl(url)) {
			if (changeInfo.url && this._standardHandler.detect(url) === 'claim') {
				await this.activateStandard(url, tab)
			}
		} else if (isLegacyEncodedUrl(url) && changeInfo.status === 'complete') {
			if (this._standardHandler.detect(url) === 'claim') {
				await this.activateStandard(url, tab)
			}
		}
	}

	/** Updates page-action visibility when the user switches to a different tab. */
	readonly handleTabActivated = async (activeInfo: TabActivatedInfo): Promise<void> => {
		try {
			if (activeInfo.tabId !== this.browserApi.tabs.TAB_ID_NONE) {
				await this._pageAction.syncPageActionVisibilityForTab(activeInfo.tabId)
			}
		} catch (error) {
			this.debug(error)
		}
	}

	/**
	 * Intercepts "Open in New Tab" during a hotswap window or for encoded bookmark clicks.
	 * Checks the new tab's URL against hotswap and standard handlers.
	 */
	readonly handleTabCreated = async (tab: Tab): Promise<void> => {
		if (!tab.url || !tab.id) return

		const hotResult = this._hotswapHandler.detect(tab.url)
		if (hotResult === 'claim') {
			await this.activateHotswap(tab.url, tab)
			return
		}

		if (this._standardHandler.detect(tab.url) === 'claim') {
			await this.activateStandard(tab.url, tab)
		}
	}

	/**
	 * Intercepts "Open in New Window" during a hotswap window.
	 *
	 * Captures the window's initial tab set BEFORE any redirects, then uses it as the
	 * pre-redirect snapshot for TC orphan cleanup. This avoids the stale-snapshot problem
	 * where TC orphans are present before wrapRedirect captures its own snapshot.
	 */
	readonly handleWindowCreated = async (window: Window): Promise<void> => {
		if (!window.id) return

		try {
			const tabs = await this.browserApi.tabs.query({ windowId: window.id })

			for (const tab of tabs) {
				if (!tab.url || !tab.id) continue

				const hotResult = this._hotswapHandler.detect(tab.url)
				if (hotResult === 'claim') {
					await this.activateHotswap(tab.url, tab)
					continue
				}

				if (this._standardHandler.detect(tab.url) === 'claim') {
					await this.activateStandard(tab.url, tab)
				}
			}
		} catch (error) {
			this.debug('handleWindowCreated: error', error)
		}
	}

	// =========================================================================
	// Listener Registration
	// =========================================================================

	/** Wires all browser event listeners to the appropriate module handlers. */
	private registerListeners(): void {
		// Menu events — HotswapHandler owns the decode/revert lifecycle,
		// BAM owns menu click handling and menu item construction.
		this.browserApi.menus.onClicked.addListener((info) => {
			void (async () => {
				await this._hotswapHandler.inhibitForBookmark(info.bookmarkId)
				await this._bam.handleMenuClick(info)
			})()
		})
		this.browserApi.menus.onShown.addListener((info: MenusOnShownInfo) => {
			void this._hotswapHandler.handleMenuShown(info, async (bookmark: BookmarkNode) => {
				this.browserApi.menus.removeAll()
				await this._bam.createMenuItems(bookmark)
			})
		})
		this.browserApi.menus.onHidden.addListener(this._hotswapHandler.handleMenuHidden)

		// Navigation pipeline — sync interception → async activation
		this.browserApi.webNavigation.onBeforeNavigate.addListener(this.handleBeforeNavigate)
		this.browserApi.webRequest.onBeforeRequest.addListener(
			this.handleBeforeRequest,
			{ urls: ['<all_urls>'], types: ['main_frame'] },
			['blocking'],
		)

		// Tab/window events — fallback detection + page action sync
		this.browserApi.tabs.onUpdated.addListener(this.handleTabUpdated)
		this.browserApi.tabs.onActivated.addListener(this.handleTabActivated)
		this.browserApi.tabs.onCreated.addListener(this.handleTabCreated)
		this.browserApi.windows.onCreated.addListener(this.handleWindowCreated)

		// Page action → PageActionHandler
		this.browserApi.pageAction.onClicked.addListener(this._pageAction.handlePageActionClicked)

		// Bookmark events → HotswapHandler (decode/revert, anti-injection stripping)
		this.browserApi.bookmarks.onChanged.addListener(this._hotswapHandler.handleBookmarkChanged)
		this.browserApi.bookmarks.onCreated.addListener(this._hotswapHandler.handleBookmarkCreated)
	}

	// =========================================================================
	// Migration Helpers (one-time, stay in the runtime)
	// =========================================================================

	/**
	 * One-time migration from the original localStorage-based container mapping to the current
	 * bookmark-based mapping store. Reads and deletes each legacy key, then re-encodes the
	 * bookmark URL with the new mapping index.
	 */
	private async migrateLegacyStorage(mappingStore: ContainerMappingStore): Promise<void> {
		for (const key of readLegacyStorageKeys(this.storage)) {
			const reference = readLegacyReference(this.storage, key)
			if (!reference || !reference?.backupName) continue
			this.storage.removeItem(key)

			const identity = await this._bam.getContainer({ backupName: reference.backupName })
			if (!identity) continue
			const mapping = await mappingStore.ensureMappingForContainer(identity)
			if (!mapping) continue

			try {
				const bookmark = (await this.browserApi.bookmarks.get(reference.bookmarkId))[0]
				if (!bookmark?.id) continue

				const parsed = parseLegacyBookmarkUrl(bookmark)
				if (!parsed || !parsed.token || parsed.containerIndex !== null) continue

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
			if (!parsed || !parsed.token || parsed.containerIndex === null) continue

			const mapping = mappingStore.getByIndex(parsed.containerIndex)
			if (!mapping) continue

			await this._bam.updateBookmarkContainerUrl(bookmark)
		}
	}
}
