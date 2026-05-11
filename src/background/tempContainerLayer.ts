/**
 * @module TempContainerLayer
 * @role Encapsulates all interaction with the Temporary Containers (TC/TC+) extension.
 * @ownsState _extensionId (detected TC addon ID)
 * @tests tests/tempContainerLayer.test.ts (future)
 *
 * Responsibilities:
 * - Detect whether TC or TC+ is installed at startup
 * - Wrap redirect operations with pre/post tab snapshots to clean up TC-created orphans
 * - Open URLs in fresh Temporary Containers via the TC runtime API
 * - Query the TC API to determine if a cookieStoreId is an ephemeral container
 * - Clean up orphaned about:blank tabs that TC creates during redirect races
 *
 * Boundary contract:
 * - Receives only `BrowserApi` and `LoggerLike` — no knowledge of bookmarks, settings, or mappings.
 * - Consumers (HotswapHandler, StandardHandler, BookmarkAssignmentManager) call through the interface.
 * - Falls back gracefully when no TC extension is installed (wrapRedirect becomes passthrough).
 *
 * Failure modes:
 * - TC extension not installed: `isPresent()` returns false, `wrapRedirect` skips cleanup.
 * - TC runtime API call fails: `openInTempContainer` falls back to default container.
 * - `isTempContainer` API error: returns false (safe default — won't remove non-TC tabs).
 * - Tab removal fails during redirect: logged and swallowed; cleanup phase handles it.
 */

import type {
	BrowserApi,
	LoggerLike,
	Tab,
} from '../models'
import { TEMP_CONTAINERS_EXTENSION_IDS } from '../constants'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface TempContainerLayerDeps {
	readonly browserApi: BrowserApi
	readonly logger: LoggerLike
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface TempContainerLayer {
	/** TC/TC+ extension ID, or null if not installed. */
	readonly extensionId: string | null

	/** Returns true when a TC/TC+ extension is detected. */
	isPresent(): boolean

	/**
	 * Detect TC/TC+ extension presence via `management.get()`. Called once at startup.
	 * Probes each known extension ID in order and stores the first enabled match.
	 */
	initialize(): Promise<void>

	/**
	 * Wraps a redirect operation with TC-specific orphan cleanup.
	 *
	 * 1. Takes a pre-redirect tab snapshot (or uses the provided `preTabIds`)
	 * 2. Calls `redirectFn` to perform the actual tab create + source removal
	 * 3. If source tab removal failed (TC replaced it), the error is swallowed
	 * 4. Runs `cleanupOrphanedTabs` to remove TC-created ephemeral about:blank tabs
	 *
	 * When no TC extension is present, `redirectFn` is called directly with no wrapping.
	 *
	 * @param redirectFn - The actual redirect: creates a tab in the target container and removes the source
	 * @param tab - Source tab being redirected (used for windowId-based snapshot)
	 * @param targetCookieStoreId - Target container ID (excluded from orphan cleanup)
	 * @param preTabIds - Optional pre-computed tab snapshot (e.g. captured at menu-hidden time by HotswapHandler)
	 */
	wrapRedirect(
		redirectFn: (tab: Tab) => Promise<void>,
		tab: Tab,
		targetCookieStoreId: string,
		preTabIds?: ReadonlySet<number | undefined> | null,
	): Promise<void>

	/**
	 * Open a URL in a fresh Temporary Container via the TC/TC+ runtime API.
	 * Falls back to opening in the default container if the TC API call fails
	 * or no TC extension is installed.
	 *
	 * When TC is present and `preTabIds` is provided, runs orphan cleanup after
	 * creating the tab to remove any TC replacement tabs.
	 *
	 * @param preTabIds - Tab snapshot captured before the redirect, used for orphan detection.
	 *                    When omitted, cleanup is skipped.
	 */
	openInTempContainer(url: string, tab: Tab, preTabIds?: ReadonlySet<number | undefined> | null): Promise<void>

	/**
	 * Check if a cookieStoreId belongs to an ephemeral Temporary Container
	 * by querying the TC/TC+ runtime API. Returns false when no TC extension
	 * is installed or the API call fails.
	 */
	isTempContainer(cookieStoreId: string): Promise<boolean>

	/**
	 * Remove orphaned TC tabs from a window after a redirect.
	 *
	 * Polls the window's tab list up to 6 times (150ms apart) to catch tabs
	 * that TC creates asynchronously. Only removes tabs that:
	 * - Were NOT present in `preTabIds` (appeared after the redirect started)
	 * - Are NOT in `targetCookieStoreId` (that's the redirect destination)
	 * - Are confirmed ephemeral by the TC `isTempContainer` API
	 */
	cleanupOrphanedTabs(
		windowId: number,
		targetCookieStoreId: string,
		preTabIds: ReadonlySet<number | undefined>,
	): Promise<void>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class TempContainerLayerImpl implements TempContainerLayer {
	private readonly browserApi: BrowserApi
	private readonly logger: LoggerLike
	private _extensionId: string | null = null

	constructor(deps: TempContainerLayerDeps) {
		this.browserApi = deps.browserApi
		this.logger = deps.logger
	}

	// --- Accessors ---

	get extensionId(): string | null {
		return this._extensionId
	}

	isPresent(): boolean {
		return this._extensionId !== null
	}

	// --- Lifecycle ---

	async initialize(): Promise<void> {
		for (const extensionId of TEMP_CONTAINERS_EXTENSION_IDS) {
			try {
				const extensionInfo = await this.browserApi.management.get(extensionId)
				if (extensionInfo.enabled) {
					this._extensionId = extensionId
					this.debug('Temporary Containers detected:', extensionInfo.name, extensionId)
					return
				}
			} catch {
				// Extension not installed — try next
			}
		}
		this._extensionId = null
		this.debug('No Temporary Containers extension found')
	}

	// --- Redirect wrapping ---

	async wrapRedirect(
		redirectFn: (tab: Tab) => Promise<void>,
		tab: Tab,
		targetCookieStoreId: string,
		preTabIds?: ReadonlySet<number | undefined> | null,
	): Promise<void> {
		// No TC extension — just execute the redirect directly.
		if (!this._extensionId) {
			await redirectFn(tab)
			return
		}

		// Capture pre-redirect tab snapshot for orphan detection.
		// Prefer caller-provided snapshot (e.g. from HotswapHandler menu-hidden capture).
		const snapshot = preTabIds ?? (tab.windowId != null
			? new Set((await this.browserApi.tabs.query({ windowId: tab.windowId })).map(t => t.id))
			: null)

		try {
			await redirectFn(tab)
		} catch (redirectError) {
			// TC may have already replaced the source tab (changing its ID), making
			// tabs.remove inside redirectFn fail. That's expected — cleanup handles it.
			this.debug('wrapRedirect: redirectFn error (TC likely replaced source tab)', redirectError)
		}

		// Clean up orphaned TC tabs regardless of whether redirectFn succeeded.
		if (snapshot && tab.windowId != null) {
			await this.cleanupOrphanedTabs(tab.windowId, targetCookieStoreId, snapshot)
		}
	}

	// --- TC API operations ---

	async openInTempContainer(url: string, tab: Tab, preTabIds?: ReadonlySet<number | undefined> | null): Promise<void> {
		if (tab.id === undefined) return

        let newTab: Tab | undefined = undefined

		try {
			if (!this._extensionId) throw new Error('No Temporary Containers extension detected')

			this.debug('openInTempContainer: requesting createTabInTempContainer via', this._extensionId, url)
			await this.browserApi.tabs.remove(tab.id)
			newTab = await this.browserApi.runtime.sendMessage(this._extensionId, {
				method: 'createTabInTempContainer',
				url: url + '#TC',
				active: true,
			}) as Tab
		} catch (error) {
			this.debug('openInTempContainer: TC API call failed, falling back', error)
			try {
                // fire and forget
				this.browserApi.tabs.remove(tab.id)
				newTab = await this.browserApi.tabs.create({ url: url + '#TC', index: tab.index })
			} catch (fallbackError) {
				this.debug('openInTempContainer: fallback also failed', fallbackError)
			}
		}

		// Cleanup orphaned TC tabs that may have been created during the redirect.
		if (preTabIds && tab.windowId != null) {
            // Don't cleanup the new tab
            const preTabIdsWithNew = new Set(preTabIds)
            if (newTab!.id !== undefined) {
                preTabIdsWithNew.add(newTab!.id)
            }
			await this.cleanupOrphanedTabs(tab.windowId, newTab?.cookieStoreId || '', preTabIdsWithNew)
		}
	}

	async isTempContainer(cookieStoreId: string): Promise<boolean> {
		if (!this._extensionId) return false
		try {
			return await this.browserApi.runtime.sendMessage(
				this._extensionId,
				{ method: 'isTempContainer', cookieStoreId },
			) as boolean
		} catch {
			return false
		}
	}

	async cleanupOrphanedTabs(
		windowId: number,
		targetCookieStoreId: string,
		preTabIds: ReadonlySet<number | undefined>,
	): Promise<void> {
		this.debug('cleanupOrphanedTabs: pre-redirect tab IDs', [...preTabIds])

		let iteration = 0
		// Poll multiple times to catch tabs TC creates asynchronously after redirect.
		while (iteration++ < 6) {
			this.debug(
				`cleanupOrphanedTabs: iteration ${iteration} — checking for TC orphan tabs`,
				`in window ${windowId} targeting container ${targetCookieStoreId}`,
			)
			// TC may still be creating orphan tabs — wait for it to settle.
			await new Promise(resolve => setTimeout(resolve, 150))

			try {
				const tabs = await this.browserApi.tabs.query({ windowId })
				for (const tab of tabs) {
					// Only consider tabs that appeared after the pre-redirect snapshot.
					if (preTabIds.has(tab.id)) continue
					if (tab.id === undefined || !tab.cookieStoreId) continue
					// Skip the target container — that's our redirect destination, not an orphan.
					if (tab.cookieStoreId === targetCookieStoreId) continue

					// Ask TC directly whether this tab's container is ephemeral.
					const isTemp = await this.isTempContainer(tab.cookieStoreId)
					if (isTemp) {
						this.debug('cleanupOrphanedTabs: removing TC orphan tab', tab.id, tab.cookieStoreId)
						await this.browserApi.tabs.remove(tab.id)
					}
				}
			} catch (error) {
				this.debug('cleanupOrphanedTabs: error', error)
			}
		}
	}

	// --- Internal ---

	private debug(...args: unknown[]): void {
		this.logger.log(...args)
	}
}
