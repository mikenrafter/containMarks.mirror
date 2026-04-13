/**
 * @module NavigationPolicyEngine
 * @role Owns all redirect *decisions* regardless of event source. Returns NavigationIntent objects.
 * @ownsState pendingInterceptions
 * @tests tests/navigationPolicyEngine.test.ts
 *
 * Responsibilities:
 * - Evaluate whether a navigation (from any source) requires a container redirect
 * - Produce a NavigationIntent describing the required action
 * - Manage fragment-encoded URL detection in webNavigation.onBeforeNavigate (synchronous)
 * - Manage HTTP request cancellation in webRequest.onBeforeRequest (synchronous blocking)
 * - Evaluate hotswap redirect map entries for tab/window-created navigations
 * - Resolve container mapping from bookmark index
 * - Determine token regeneration requirement (produces `reset-token` intent variant)
 *
 * Boundary contract:
 * - Receives `BrowserApi`, settings accessor, mapping store accessor, and a read-only
 *   reference to BookmarkAssignmentManager's `hotswapRedirectMap`.
 * - Returns NavigationIntent objects — never performs tab/window side-effects.
 * - The webRequest handler returns `{ cancel: true }` synchronously; the intent is
 *   resolved asynchronously and handed to TabExecutionController via `onIntentResolved`.
 *
 * Failure modes:
 * - Missing container mapping for index: returns `noop` intent.
 * - Tab already in target container: returns `noop` intent (avoids redirect loops).
 * - Fragment parse failure: returns `noop` (malformed URL treated as plain navigation).
 */

import type {
	BlockingResponse,
	BrowserApi,
	ContainMarksSettings,
	HotswapRedirectInfo,
	LoggerLike,
	NavigationIntent,
	PendingInterception,
	Tab,
	WebNavigationBeforeNavigateDetails,
	WebRequestBeforeRequestDetails,
} from '../models'
import type { ContainerMappingStore } from '../containerMappingStore'
import {
	isFragmentEncodedUrl,
	isLegacyEncodedUrl,
	isPrefixedUrl,
	parseBookmarkUrl,
} from '../urlCodec'
import { TEMP_CONTAINER_SENTINEL } from '../backgroundApp'

export interface NavigationPolicyEngineDeps {
	readonly browserApi: BrowserApi
	readonly logger: LoggerLike
	settings(): Promise<ContainMarksSettings>
	mappingStore(settings: ContainMarksSettings): ContainerMappingStore
	/** Read-only access to the hotswap redirect map owned by BookmarkAssignmentManager. */
	hotswapRedirectMap(): ReadonlyMap<string, HotswapRedirectInfo>
	/** Atomically consume a hotswap redirect entry. Returns the entry if found, undefined otherwise. */
	consumeHotswapRedirect(url: string): HotswapRedirectInfo | undefined
	/**
	 * Callback invoked when an async intent is resolved from a synchronous interception path
	 * (webRequest cancel → async mapping resolution). The runtime wires this to TEC.executeIntent.
	 */
	onIntentResolved(intent: NavigationIntent, tabId: number): void
}

/**
 * Evaluates navigation events from all sources and produces NavigationIntent objects.
 *
 * The synchronous handlers (`handleBeforeNavigate`, `handleBeforeRequest`) are bound function
 * properties for direct registration as browser listeners. The async resolution methods are
 * called by the runtime after the synchronous phase completes.
 */
export interface NavigationPolicyEngine {
	// --- Synchronous browser event handlers (webNavigation / webRequest) ---

	/**
	 * Synchronous — no awaits. Detects fragment-encoded URLs and hotswap matches, populating
	 * `pendingInterceptions` for the subsequent `onBeforeRequest` handler.
	 * Must be fully synchronous for Firefox's webNavigation pipeline.
	 */
	readonly handleBeforeNavigate: (details: WebNavigationBeforeNavigateDetails) => void

	/**
	 * Synchronous blocking — returns `{ cancel: true }` when a pending interception exists.
	 * Fires the async intent resolution as a side-effect (fire-and-forget via setTimeout).
	 */
	readonly handleBeforeRequest: (details: WebRequestBeforeRequestDetails) => BlockingResponse | void

	// --- Async policy evaluation (called by runtime or TabExecutionController) ---

	/**
	 * Resolve a pending interception into a NavigationIntent. Called asynchronously after
	 * `handleBeforeRequest` cancels the request.
	 */
	resolveInterception(interception: PendingInterception): Promise<NavigationIntent>

	/**
	 * Evaluate a navigation that didn't go through the webRequest pipeline — e.g. same-page
	 * fragment change, legacy `about:` URL, or hotswap redirect from tab/window creation.
	 * Returns the intent describing what action (if any) to take.
	 */
	evaluateTabNavigation(url: string, tab: Tab): Promise<NavigationIntent>

	/**
	 * Evaluate whether a newly-created tab's URL matches a hotswap redirect entry.
	 * Used by the runtime to check tabs from `onCreated` and `onWindowCreated`.
	 */
	evaluateHotswapRedirect(url: string, tab: Tab): Promise<NavigationIntent>
}

// --- Implementation ---

const NOOP: NavigationIntent = { action: 'noop' } as const

export class NavigationPolicyEngineImpl implements NavigationPolicyEngine {
	private readonly browserApi: BrowserApi
	private readonly deps: NavigationPolicyEngineDeps
	private readonly pendingInterceptions = new Map<number, PendingInterception>()

	constructor(deps: NavigationPolicyEngineDeps) {
		this.deps = deps
		this.browserApi = deps.browserApi
	}

	private debug(...args: unknown[]): void {
		this.deps.logger.log(...args)
	}

	/**
	 * MUST be fully synchronous — no awaits. Populates `pendingInterceptions` so that the
	 * subsequent `onBeforeRequest` handler can cancel the HTTP request before any network activity.
	 *
	 * Also flags hotswap matches for async resolution via `onIntentResolved`.
	 */
	readonly handleBeforeNavigate = (details: WebNavigationBeforeNavigateDetails): void => {
		if (details.frameId !== 0) return

		// Hotswap interception — fire-and-forget async redirect for decoded bookmark URLs
		const hotswapMap = this.deps.hotswapRedirectMap()
		if (hotswapMap.size > 0) {
			const hotswapInfo = this.deps.consumeHotswapRedirect(details.url)
			if (hotswapInfo) {
				this.debug('handleBeforeNavigate: hotswap match', details.url, '→ container', hotswapInfo.containerIndex)
				// Resolve async — intent flows to TEC via onIntentResolved
				void this.evaluateHotswapRedirectByIndex(
					details.url,
					hotswapInfo.containerIndex,
					details.tabId
				)
				return
			}
		}

		if (!isFragmentEncodedUrl(details.url)) return

		const parsed = parseBookmarkUrl(details.url)
		if (!parsed || parsed.containerIndex === null) return

		this.pendingInterceptions.set(details.tabId, {
			containerIndex: parsed.containerIndex,
			realUrl: parsed.url,
			encodedUrl: details.url
		})
	}

	/**
	 * Synchronous blocking — returns `{ cancel: true }` immediately when the tab was flagged
	 * by `handleBeforeNavigate`. The async intent resolution fires via setTimeout and flows
	 * back through `onIntentResolved`.
	 */
	readonly handleBeforeRequest = (details: WebRequestBeforeRequestDetails): BlockingResponse | void => {
		if (details.type !== 'main_frame') return

		const interception = this.pendingInterceptions.get(details.tabId)
		if (!interception) return

		// Fire and forget — resolve intent asynchronously
		const tabId = details.tabId
		setTimeout(async () => {
			this.pendingInterceptions.delete(tabId)
			const intent = await this.resolveInterception(interception)
			this.deps.onIntentResolved(intent, tabId)
		}, 0)

		return { cancel: true }
	}

	async resolveInterception(interception: PendingInterception): Promise<NavigationIntent> {
		try {
			const settings = await this.deps.settings()
			const mappingStore = this.deps.mappingStore(settings)
			await mappingStore.initialize()

			const mapping = mappingStore.getByIndex(interception.containerIndex)
			if (!mapping) {
				this.debug('missing mapping for interception', interception.containerIndex)
				return NOOP
			}

			if (mapping.cookieStoreId === TEMP_CONTAINER_SENTINEL) {
				return { action: 'redirect-temp', url: interception.realUrl }
			}

			if (settings.regenerateTokenOnEveryUse) {
				const bookmarks = await this.browserApi.bookmarks.search(interception.encodedUrl)
				const bookmark = bookmarks.find(b => b.type === 'bookmark' && b.url === interception.encodedUrl)
				if (bookmark) {
					return {
						action: 'reset-token',
						cookieStoreId: mapping.cookieStoreId,
						url: interception.realUrl,
						bookmark,
					}
				}
			}

			return { action: 'redirect', cookieStoreId: mapping.cookieStoreId, url: interception.realUrl }
		} catch (error) {
			this.debug(error)
			return NOOP
		}
	}

	async evaluateTabNavigation(url: string, tab: Tab): Promise<NavigationIntent> {
		if (!isPrefixedUrl(url)) return NOOP

		try {
			const settings = await this.deps.settings()
			const mappingStore = this.deps.mappingStore(settings)
			await mappingStore.initialize()

			const bookmarks = await this.browserApi.bookmarks.search(url)
			const bookmark = bookmarks.find(item => item.type === 'bookmark' && item.url === url)
			if (!bookmark?.id) return NOOP

			const parsed = parseBookmarkUrl(bookmark)
			if (!parsed || !parsed.token || parsed.containerIndex === null) return NOOP

			const mapping = mappingStore.getByIndex(parsed.containerIndex)
			if (!mapping) {
				this.debug('missing mapping for bookmark', bookmark.id, parsed.containerIndex)
				return NOOP
			}

			if (mapping.cookieStoreId === TEMP_CONTAINER_SENTINEL) {
				return { action: 'redirect-temp', url: parsed.url }
			}

			if (settings.regenerateTokenOnEveryUse) {
				return {
					action: 'reset-token',
					cookieStoreId: mapping.cookieStoreId,
					url: parsed.url,
					bookmark,
				}
			}

			return { action: 'redirect', cookieStoreId: mapping.cookieStoreId, url: parsed.url }
		} catch (error) {
			this.debug(error)
			return NOOP
		}
	}

	async evaluateHotswapRedirect(url: string, tab: Tab): Promise<NavigationIntent> {
		const hotswapInfo = this.deps.consumeHotswapRedirect(url)
		if (!hotswapInfo) return NOOP

		return this.resolveHotswapMapping(url, hotswapInfo.containerIndex, tab)
	}

	/**
	 * Internal helper: resolves a hotswap redirect given a container index and target tab.
	 * Returns `noop` if already in the correct container or mapping is missing.
	 */
	private async resolveHotswapMapping(
		url: string,
		containerIndex: number,
		tab: Tab
	): Promise<NavigationIntent> {
		try {
			const settings = await this.deps.settings()
			const mappingStore = this.deps.mappingStore(settings)
			await mappingStore.initialize()

			const mapping = mappingStore.getByIndex(containerIndex)
			if (!mapping) return NOOP

			if (tab.cookieStoreId === mapping.cookieStoreId) {
				this.debug('evaluateHotswapRedirect: already in target container, skipping')
				return NOOP
			}

			if (mapping.cookieStoreId === TEMP_CONTAINER_SENTINEL) {
				return { action: 'redirect-temp', url }
			}

			return { action: 'redirect', cookieStoreId: mapping.cookieStoreId, url }
		} catch (error) {
			this.debug(error)
			return NOOP
		}
	}

	/**
	 * Variant of hotswap resolution used by `handleBeforeNavigate` where we have
	 * the tabId but not the full tab object yet — fetches the tab and routes the
	 * resolved intent through `onIntentResolved`.
	 */
	private async evaluateHotswapRedirectByIndex(
		url: string,
		containerIndex: number,
		tabId: number
	): Promise<void> {
		try {
			const tab = await this.browserApi.tabs.get(tabId)
			const intent = await this.resolveHotswapMapping(url, containerIndex, tab)
			this.deps.onIntentResolved(intent, tabId)
		} catch (error) {
			this.debug('evaluateHotswapRedirectByIndex: error', error)
		}
	}
}
