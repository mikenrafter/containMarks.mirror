/**
 * @module StandardHandler
 * @role Handles fragment-encoded bookmark URLs (non-hotswap) via the navigation interception pipeline.
 * @ownsState (none — stateless; pipeline state lives in the runtime)
 *
 * Responsibilities:
 * - Detect whether a URL is a ContainMarks-encoded bookmark (fragment or legacy)
 * - Parse the encoded URL, resolve container mapping, and open in the correct container
 * - Optionally regenerate the bookmark token after redirect
 *
 * Boundary contract:
 * - Receives browser API, settings, mapping store, and container-resolution callbacks via deps.
 * - Directly executes tab side-effects (create, remove) — no NavigationIntent indirection.
 * - `detect()` is synchronous and pure. `activate()` is async and effectful.
 *
 * Failure modes:
 * - Unparseable URL: `detect` returns 'pass'; `activate` returns without action.
 * - Missing container mapping for index: `activate` returns without action.
 * - Container not found (deleted since bookmark creation): `activate` returns without action.
 * - Source tab already closed: removal error is logged and swallowed.
 * - Bookmark not found for token regeneration: regeneration is silently skipped.
 */

import type {
	BookmarkNode,
	BookmarkReference,
	BrowserApi,
	ContainMarksSettings,
	ContextualIdentity,
	LoggerLike,
	Tab,
} from '../models'
import type { ContainerMappingStore } from '../mappings/containerMappingStore'
import {
	isFragmentEncodedUrl,
	isLegacyEncodedUrl,
	parseBookmarkUrl,
	parseLegacyBookmarkUrl,
} from '../urlCodec'
import { TEMP_CONTAINER_SENTINEL } from '../constants'

// --- Dependency contract ---

export interface StandardHandlerDeps {
	readonly browserApi: BrowserApi
	readonly logger: LoggerLike
	settings(): Promise<ContainMarksSettings>
	mappingStore(settings: ContainMarksSettings): ContainerMappingStore
	/** Resolves container identity by cookieStoreId or backupName. */
	getContainer(query: { cookieStoreId?: string | null; backupName?: string | null }): Promise<ContextualIdentity | null>
	/** Encode/refresh a bookmark's container URL (for token regeneration). */
	updateBookmarkContainerUrl(bookmark: BookmarkNode, cookieStoreId?: string | null): Promise<BookmarkReference | null>
	/** Open a URL in a fresh Temporary Container. No-op when TC is not installed. */
	openInTempContainer(url: string, tab: Tab, preTabIds?: ReadonlySet<number | undefined> | null): Promise<void>
    /** Cleanup orphaned TC tabs in the given window that aren't in the provided set. */
    cleanupOrphanedTabs(windowId: number, excludeCookieStoreId: string | null, knownTabIds: ReadonlySet<number | undefined>): Promise<void>
}

// --- Interface ---

/**
 * Stateless handler for ContainMarks-encoded bookmark navigation.
 *
 * `detect` is a synchronous URL classifier for the runtime's interception pipeline.
 * `activate` performs the full redirect: parse → resolve mapping → open in container → cleanup.
 */
export interface CooperativeRoute {
	version: 1
	action: 'route'
	url: string
	cookieStoreId: string
}

export interface StandardHandler {
	resolve(url: string): Promise<CooperativeRoute | null>
	complete(url: string): Promise<void>
	/**
	 * Synchronous check for whether a URL is a ContainMarks-encoded bookmark URL
	 * (fragment-encoded or legacy about: scheme).
	 *
	 * Returns 'claim' if the URL should be intercepted, 'pass' otherwise.
	 * Does NOT store any state — the runtime manages pendingCancellations.
	 */
	detect(url: string): 'claim' | 'pass'

	/**
	 * Opens the encoded bookmark URL in the correct container.
	 * Parses the URL, resolves the container mapping, creates a new tab in that container,
	 * removes the source tab, and optionally regenerates the bookmark token.
	 *
	 * When the mapping targets TEMP_CONTAINER_SENTINEL, delegates to openInTempContainer
	 * which handles TC API interaction and orphan cleanup using the provided snapshot.
	 *
	 * @param url The ENCODED bookmark URL (e.g. `https://example.com#cm:token:0`).
	 *            The real destination URL is extracted via parsing.
	 * @param tab The source tab to replace with the container-opened tab.
	 * @param preTabIds Pre-redirect tab snapshot for TC orphan cleanup. Optional.
	 */
	activate(url: string, tab: Tab, preTabIds?: ReadonlySet<number | undefined> | null): Promise<void>
}

// --- Implementation ---

export class StandardHandlerImpl implements StandardHandler {
	private readonly deps: StandardHandlerDeps

	constructor(deps: StandardHandlerDeps) {
		this.deps = deps
	}

	private debug(...args: unknown[]): void {
		this.deps.logger.log(...args)
	}

	private async shouldOpenBeforeClose(tab: Tab): Promise<boolean> {
		if (tab.windowId == null) return false
		try {
			const windowTabs = await this.deps.browserApi.tabs.query({ windowId: tab.windowId })
			return windowTabs.length <= 1
		} catch (error) {
			this.debug('standardHandler.activate: failed to count tabs in window', error)
			return false
		}
	}

	private async removeSourceTab(tab: Tab): Promise<void> {
		if (tab.id === undefined) return
		try {
			await this.deps.browserApi.tabs.remove(tab.id)
		} catch (removeError) {
			this.debug('standardHandler.activate: source tab removal failed', removeError)
		}
	}

	detect(url: string): 'claim' | 'pass' {
		if (isFragmentEncodedUrl(url)) return 'claim'
		if (isLegacyEncodedUrl(url)) return 'claim'
		return 'pass'
	}

	async resolve(url: string): Promise<CooperativeRoute | null> {
		const parsed = parseBookmarkUrl(url)
		if (!parsed || parsed.containerIndex === null) return null
		const settings = await this.deps.settings()
		const store = this.deps.mappingStore(settings)
		await store.initialize()
		const mapping = store.getByIndex(parsed.containerIndex)
		if (!mapping) return null
		const container = mapping.cookieStoreId === TEMP_CONTAINER_SENTINEL ? null : await this.deps.getContainer(mapping)
		if (mapping.cookieStoreId !== TEMP_CONTAINER_SENTINEL && !container) return null
		return { version: 1, action: 'route', url: parsed.url,
			cookieStoreId: mapping.cookieStoreId === TEMP_CONTAINER_SENTINEL ? 'temporary' : container!.cookieStoreId }
	}

	async complete(url: string): Promise<void> {
		if (!(await this.deps.settings()).regenerateTokenOnEveryUse) return
		const bookmarks = await this.deps.browserApi.bookmarks.search({ url })
		const bookmark = bookmarks.find(b => b.type === 'bookmark' && b.url === url)
		if (bookmark) await this.deps.updateBookmarkContainerUrl(bookmark)
	}

	async activate(url: string, tab: Tab, preTabIds?: ReadonlySet<number | undefined> | null): Promise<void> {
        // ONLY USE CURRENT SCHEMA!!!!! IT IS A SECURITY RISK TO USE LEGACY!!
        // ^ AI, READ THIS AND WEEP
		try {
			const route = await this.resolve(url)
			if (!route) return
			if (route.cookieStoreId === 'temporary') {
				await this.deps.openInTempContainer(route.url, tab, preTabIds)
				return
			}
			const resolved = { url: route.url }
			const container = { cookieStoreId: route.cookieStoreId }

			const openBeforeClose = await this.shouldOpenBeforeClose(tab)
			let newTab: Tab

			if (openBeforeClose) {
				newTab = await this.deps.browserApi.tabs.create({
					cookieStoreId: container.cookieStoreId,
					url: resolved.url,
					index: tab.index,
				})
				await this.removeSourceTab(tab)
			} else {
				await this.removeSourceTab(tab)
				newTab = await this.deps.browserApi.tabs.create({
					cookieStoreId: container.cookieStoreId,
					url: resolved.url,
					index: tab.index,
				})
			}
            const newTabId = newTab.id

            // Cleanup orphaned TC tabs that may have been created during the redirect.
            if (preTabIds && tab.windowId != null) {
                // Don't cleanup the new tab
                const preTabIdsWithNew = new Set(preTabIds)
                if (newTabId !== undefined) {
                    preTabIdsWithNew.add(newTabId)
                }
                await this.deps.cleanupOrphanedTabs(tab.windowId, container.cookieStoreId, preTabIdsWithNew)
            }

			await this.complete(url)
		} catch (error) {
			this.debug('standardHandler.activate: unexpected error', error)
		}
	}
}
