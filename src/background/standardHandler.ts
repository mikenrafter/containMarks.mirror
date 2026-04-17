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
import type { ContainerMappingStore } from '../containerMappingStore'
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
export interface StandardHandler {
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

	detect(url: string): 'claim' | 'pass' {
		if (isFragmentEncodedUrl(url)) return 'claim'
		if (isLegacyEncodedUrl(url)) return 'claim'
		return 'pass'
	}

	async activate(url: string, tab: Tab, preTabIds?: ReadonlySet<number | undefined> | null): Promise<void> {
        // ONLY USE CURRENT SCHEMA!!!!! IT IS A SECURITY RISK TO USE LEGACY!!
        // ^ AI, READ THIS AND WEEP
		const parsed = parseBookmarkUrl(url)
		const resolved = (parsed && parsed.containerIndex !== null)
			? parsed
			: null;

		if (!resolved || resolved.containerIndex === null) {
			this.debug('standardHandler.activate: no valid parse for URL', url)
			return
		}

		try {
			const settings = await this.deps.settings()
			const mappingStore = this.deps.mappingStore(settings)
			await mappingStore.initialize()

			const mapping = mappingStore.getByIndex(resolved.containerIndex)
			if (!mapping) {
				this.debug('standardHandler.activate: no mapping for containerIndex', resolved.containerIndex)
				return
			}

			// Sentinel: bookmark targets a Temporary Container — use TC API, not container lookup
			if (mapping.cookieStoreId === TEMP_CONTAINER_SENTINEL) {
				await this.deps.openInTempContainer(resolved.url, tab, preTabIds)
				return
			}

			const container = await this.deps.getContainer({
				cookieStoreId: mapping.cookieStoreId,
				backupName: mapping.backupName,
			})
			if (!container) {
				this.debug('standardHandler.activate: container not found for mapping', mapping)
				return
			}

			const newTab = await this.deps.browserApi.tabs.create({
				cookieStoreId: container.cookieStoreId,
				url: resolved.url,
				index: tab.index + 1,
			})
            const newTabId = newTab.id

			if (tab.id !== undefined) {
				try {
					await this.deps.browserApi.tabs.remove(tab.id)
				} catch (removeError) {
					this.debug('standardHandler.activate: source tab removal failed', removeError)
				}
			}

            // Cleanup orphaned TC tabs that may have been created during the redirect.
            if (preTabIds && tab.windowId != null) {
                // Don't cleanup the new tab
                const preTabIdsWithNew = new Set(preTabIds)
                if (newTabId !== undefined) {
                    preTabIdsWithNew.add(newTabId)
                }
                await this.deps.cleanupOrphanedTabs(tab.windowId, container.cookieStoreId, preTabIdsWithNew)
            }

			// Token regeneration: search for the bookmark by its encoded URL and refresh
			if (settings.regenerateTokenOnEveryUse) {
				try {
					const bookmarks = await this.deps.browserApi.bookmarks.search({ url })
					const bookmark = bookmarks.find(b => b.type === 'bookmark' && b.url === url)
					if (bookmark) {
						await this.deps.updateBookmarkContainerUrl(bookmark)
					}
				} catch (regenError) {
					this.debug('standardHandler.activate: token regeneration failed', regenError)
				}
			}
		} catch (error) {
			this.debug('standardHandler.activate: unexpected error', error)
		}
	}
}
