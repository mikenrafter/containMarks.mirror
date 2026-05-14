/**
 * @module HotswapHandler
 * @role Owns the hotswap decode/revert lifecycle for bookmark Properties dialog support.
 * @ownsState hotswapRecords, hotswapRevertTimers, selfUpdateBookmarkIds, hotswapRedirectMap,
 *            pendingEditBookmark, preHotswapTabIds, lockedUrls, consumedButNotActivated
 * @tests tests/hotswapHandler.test.ts
 *
 * Responsibilities:
 * - Temporarily decode an encoded bookmark URL so Firefox's Properties dialog shows the real URL
 * - Populate `hotswapRedirectMap` so navigations during the decode window are intercepted
 * - Schedule automatic revert timers that re-encode if the user doesn't edit the URL
 * - Detect user edits during the decode window and re-encode with the new URL
 * - Strip orphaned encoding from newly-created bookmarks (anti-injection)
 * - Persist hotswap state for crash recovery
 * - Provide a synchronous `detect()` / async `activate()` pipeline for tab interception
 *
 * Boundary contract:
 * - `detect()` is SYNCHRONOUS — called from `onBeforeRequest` blocking handler. It only
 *   checks in-memory maps. Returns 'claim' | 'locked' | 'pass'.
 * - `activate()` is ASYNC — directly creates tabs via `browserApi.tabs.create()` and removes
 *   source tabs. Does NOT produce NavigationIntent objects.
 * - `lockedUrls` prevents re-processing of URLs that are mid-activation.
 * - `preHotswapTabIds` is captured at menu-hidden time, before TC can create orphan tabs.
 *
 * Failure modes:
 * - Crash during hotswap: persisted records allow recovery on next startup.
 * - Missing mapping for container index: activation is silently skipped.
 * - Source tab already removed (TC replaced it): `tabs.remove()` error is caught and ignored.
 */

import type {
	BookmarkNode,
	BrowserApi,
	ContainMarksSettings,
	ContextualIdentity,
	HotswapRecord,
	HotswapRedirectInfo,
	LoggerLike,
	MenusOnShownInfo,
	StorageLike,
	Tab,
} from '../models'
import type { ContainerMappingStore } from '../mappings/containerMappingStore'
import {
	decodeToRealUrl,
	getNewUrl,
	isFragmentEncodedUrl,
	parseBookmarkUrl,
} from '../urlCodec'
import { HOTSWAP_STORAGE_KEY, TEMP_CONTAINER_SENTINEL } from '../constants'

/** How long to wait before reverting a hotswapped bookmark if no user edit is detected. */
const HOTSWAP_REVERT_DELAY_MS = 200

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * External services injected at construction time.
 *
 * Keeps HotswapHandler decoupled from concrete singletons so tests can substitute
 * lightweight fakes for browser APIs, settings storage, and container resolution.
 */
export interface HotswapHandlerDeps {
	readonly browserApi: BrowserApi
	readonly storage: StorageLike
	readonly logger: LoggerLike
	readonly randomValue: () => number
	/** Resolve current extension settings. */
	settings(): Promise<ContainMarksSettings>
	/** Obtain the mapping store for the given settings (sync vs local selection is caller's concern). */
	mappingStore(settings: ContainMarksSettings): ContainerMappingStore
	/**
	 * Resolves a container identity by cookieStoreId or backupName.
	 * BackupName fallback enables cross-device sync. Returns null when no match is found
	 * or the cookieStoreId is `firefox-default`.
	 */
	getContainer(query: { cookieStoreId?: string | null; backupName?: string | null }): Promise<ContextualIdentity | null>
	/** Open a URL in a fresh Temporary Container. No-op when TC is not installed. */
	openInTempContainer(url: string, tab: Tab, preTabIds?: ReadonlySet<number | undefined> | null): Promise<void>
    /** Cleanup orphaned TC tabs in the given window that aren't in the provided set. */
    cleanupOrphanedTabs(windowId: number, excludeCookieStoreId: string | null, knownTabIds: ReadonlySet<number | undefined>): Promise<void>
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Manages the hotswap decode/revert lifecycle for encoded bookmarks.
 *
 * When the user right-clicks an encoded bookmark, the URL is temporarily decoded so
 * the native Properties dialog shows the human-readable URL. This module tracks that
 * decoded state, intercepts navigations to the decoded URL, opens the correct container
 * tab, and reverts the bookmark after a short timeout.
 *
 * All event handlers are exposed as bound arrow-function properties so they can be
 * registered directly as browser event listeners without rebinding.
 */
export interface HotswapHandler {
	// --- State exposed to other modules ---

	/** Read-only view of decoded URLs awaiting new-tab interception during hotswap. */
	readonly hotswapRedirectMap: ReadonlyMap<string, HotswapRedirectInfo>

	/**
	 * Atomically lookup and remove a hotswap redirect entry. Prevents duplicate redirects
	 * when multiple handlers (webNavigation, tabUpdated, tabCreated) race to consume it.
	 *
	 * @returns The redirect info if the URL was pending, or undefined if already consumed.
	 */
	consumeHotswapRedirect(url: string): HotswapRedirectInfo | undefined

	/**
	 * Tab IDs captured at `handleMenuHidden` time — before TC has a chance to create orphans.
	 * Used by TEC to distinguish pre-existing tabs from TC-created orphans during redirect.
	 * Null when no hotswap is in progress.
	 */
	readonly preHotswapTabIds: ReadonlySet<number | undefined> | null

	/**
	 * URLs that are currently being activated (between `detect('claim')` and `activate()` completion).
	 * Prevents re-interception by other listeners watching the same URL.
	 */
	readonly lockedUrls: ReadonlySet<string>

	/**
	 * Cancels any active hotswap lifecycle for the given bookmark.
	 *
	 * Used when the user selects an assignment action from the context menu
	 * (assign, unassign, or temp-container sentinel). This prevents stale
	 * hotswap records from re-applying the old container via onChanged/onHidden.
	 */
	inhibitForBookmark(bookmarkId: string): Promise<void>

	// --- Detection / Activation pipeline ---

	/**
	 * Synchronous check for whether a URL should be intercepted as a hotswap redirect.
	 *
	 * Called from `onBeforeRequest` blocking handlers where async work is not possible.
	 * Returns:
	 * - `'claim'`  — URL matched a pending hotswap; info stored for subsequent `activate()` call.
	 * - `'locked'` — URL is mid-activation by another handler; caller should skip.
	 * - `'pass'`   — URL is not a hotswap target; caller should continue normal processing.
	 */
	detect(url: string): 'claim' | 'locked' | 'pass'

	/**
	 * Opens the hotswap URL in the correct container and cleans up the source tab.
	 *
	 * Must be called after `detect()` returned `'claim'`. Resolves the container mapping,
	 * creates a new tab in that container positioned after the source tab, removes the
	 * source tab, and extends the revert timer for the bookmark.
	 *
	 * When the mapping targets TEMP_CONTAINER_SENTINEL, delegates to openInTempContainer
	 * which handles TC API interaction and orphan cleanup using the provided snapshot.
	 *
	 * @param preTabIds Pre-redirect tab snapshot for TC orphan cleanup. Optional.
	 * @throws Silently catches tab-removal errors (source tab may have been replaced by TC).
	 */
	activate(url: string, tab: Tab, preTabIds?: ReadonlySet<number | undefined> | null): Promise<void>

	/**
	 * Returns info for a URL that was claimed by `detect()` but not yet activated.
	 * Useful for callers that need the containerIndex or bookmarkId between the two steps.
	 *
	 * @returns The redirect info, or null if the URL was not claimed or already activated.
	 */
	getConsumedInfo(url: string): { containerIndex: number; bookmarkId: string } | null

	// --- Event handlers (bound arrow functions for direct listener registration) ---

	/**
	 * Called when the bookmark context menu is about to show.
	 * Clears `lockedUrls` for the new menu cycle, then starts hotswap if the bookmark is encoded.
	 *
	 * NOTE: Menu rebuild logic is NOT in this module — the `onMenuRebuild` callback delegates
	 * that to BAM. This handler only manages the hotswap-specific state transitions.
	 *
	 * @param info - Firefox menus.onShown event details
	 * @param onMenuRebuild - Callback to rebuild menu items for the shown bookmark
	 */
	readonly handleMenuShown: (info: MenusOnShownInfo, onMenuRebuild: (bookmark: BookmarkNode) => Promise<void>) => Promise<void>

	/**
	 * Called when the bookmark context menu closes.
	 * Captures `preHotswapTabIds`, populates the redirect map for any hotswap records
	 * that weren't already consumed, and schedules revert timers.
	 */
	readonly handleMenuHidden: () => Promise<void>

	/**
	 * Called when a bookmark's URL or title changes.
	 * Detects user edits during the hotswap window and re-encodes with the new URL.
	 * Self-updates (our own re-encoding) are ignored via `selfUpdateBookmarkIds` guard.
	 */
	readonly handleBookmarkChanged: (id: string, changeInfo: { url?: string; title?: string }) => Promise<void>

	/**
	 * Called when a new bookmark is created.
	 * Strips orphaned `#cm:` encoding from bookmarks that aren't duplicates of an existing
	 * encoded bookmark — prevents injection of container assignments via bookmark import.
	 * Respects the `allowEncodedBookmarkImport` setting.
	 */
	readonly handleBookmarkCreated: (id: string, node: BookmarkNode) => Promise<void>

	// --- Lifecycle ---

	/** Recover persisted hotswap records from storage after extension startup or crash recovery. */
	initialize(): Promise<void>

	/** Re-encode any bookmarks that were left decoded after a crash. Idempotent. */
	recoverPendingHotswaps(): Promise<void>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class HotswapHandlerImpl implements HotswapHandler {
	// --- Hotswap redirect state ---
	private readonly _hotswapRedirectMap = new Map<string, HotswapRedirectInfo>()
	private readonly hotswapRecords = new Map<string, HotswapRecord>()
	private readonly selfUpdateBookmarkIds = new Set<string>()
	private readonly hotswapRevertTimers = new Map<string, ReturnType<typeof setTimeout>>()
	private pendingEditBookmark: { id: string; containerIndex: number } | null = null

	// --- Tab snapshot for TC orphan detection ---
	private _preHotswapTabIds: Set<number | undefined> | null = null

	// --- Activation pipeline state ---
	private readonly _lockedUrls = new Set<string>()
	private readonly consumedButNotActivated = new Map<string, HotswapRedirectInfo>()

	constructor(private readonly deps: HotswapHandlerDeps) {}

	// --- Exposed read-only state ---

	get hotswapRedirectMap(): ReadonlyMap<string, HotswapRedirectInfo> {
		return this._hotswapRedirectMap
	}

	get preHotswapTabIds(): ReadonlySet<number | undefined> | null {
		return this._preHotswapTabIds
	}

	get lockedUrls(): ReadonlySet<string> {
		return this._lockedUrls
	}

	// --- Consume ---

	consumeHotswapRedirect(url: string): HotswapRedirectInfo | undefined {
		const info = this._hotswapRedirectMap.get(url)
		if (info) {
			this._hotswapRedirectMap.delete(url)
		}
		return info
	}

	async inhibitForBookmark(bookmarkId: string): Promise<void> {
		if (this.pendingEditBookmark?.id === bookmarkId) {
			this.pendingEditBookmark = null
		}

		this.cancelHotswapTimer(bookmarkId)

		const record = this.hotswapRecords.get(bookmarkId)
		if (record) {
			const decodedUrl = decodeToRealUrl(record.encodedUrl)
			this._hotswapRedirectMap.delete(decodedUrl)
			this.consumedButNotActivated.delete(decodedUrl)
			this._lockedUrls.delete(decodedUrl)

			this.hotswapRecords.delete(bookmarkId)
			await this.persistHotswapRecords()
		}

		const pendingUrls = [...this._hotswapRedirectMap.entries()]
			.filter(([, info]) => info.bookmarkId === bookmarkId)
			.map(([url]) => url)
		for (const url of pendingUrls) {
			this._hotswapRedirectMap.delete(url)
			this._lockedUrls.delete(url)
		}

		const consumedUrls = [...this.consumedButNotActivated.entries()]
			.filter(([, info]) => info.bookmarkId === bookmarkId)
			.map(([url]) => url)
		for (const url of consumedUrls) {
			this.consumedButNotActivated.delete(url)
			this._lockedUrls.delete(url)
		}
	}

	// --- Detection / Activation pipeline ---

	detect(url: string): 'claim' | 'locked' | 'pass' {
		if (this._lockedUrls.has(url)) return 'locked'

		const consumed = this.consumeHotswapRedirect(url)
		if (consumed) {
			this.consumedButNotActivated.set(url, consumed)
			this._lockedUrls.add(url)
			return 'claim'
		}

		return 'pass'
	}

	async activate(url: string, tab: Tab, preTabIds?: ReadonlySet<number | undefined> | null): Promise<void> {
		const info = this.consumedButNotActivated.get(url)
		if (!info) return
		this.consumedButNotActivated.delete(url)

		try {
			const settings = await this.deps.settings()
			const mappingStore = this.deps.mappingStore(settings)
			const mapping = mappingStore.getByIndex(info.containerIndex)
			if (!mapping) {
				this.debug('activate: no mapping for containerIndex', info.containerIndex)
				return
			}

			// Sentinel: bookmark targets a Temporary Container — use TC API, not container lookup
			if (mapping.cookieStoreId === TEMP_CONTAINER_SENTINEL) {
				await this.deps.openInTempContainer(url, tab, preTabIds)
				this.extendRevertTimer(info.bookmarkId)
				return
			}

			const container = await this.deps.getContainer({
				cookieStoreId: mapping.cookieStoreId,
				backupName: mapping.backupName,
			})
			if (!container) {
				this.debug('activate: container not found for mapping', mapping)
				return
			}

			const openBeforeClose = await this.shouldOpenBeforeClose(tab)
			let newTab: Tab

			if (openBeforeClose) {
				newTab = await this.deps.browserApi.tabs.create({
					cookieStoreId: container.cookieStoreId,
					url,
					index: tab.index,
				})
				await this.removeSourceTab(tab)
			} else {
				await this.removeSourceTab(tab)
				newTab = await this.deps.browserApi.tabs.create({
					cookieStoreId: container.cookieStoreId,
					url,
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

			// Extend the revert timer so the bookmark stays decoded long enough for the
			// redirect to complete, but still reverts if no user edit arrives.
			this.extendRevertTimer(info.bookmarkId)
		} finally {
			this._lockedUrls.delete(url)
		}
	}

	getConsumedInfo(url: string): { containerIndex: number; bookmarkId: string } | null {
		const info = this.consumedButNotActivated.get(url)
		if (!info) return null
		return { containerIndex: info.containerIndex, bookmarkId: info.bookmarkId }
	}

	// --- Event handlers ---

	readonly handleMenuShown = async (
		info: MenusOnShownInfo,
		onMenuRebuild: (bookmark: BookmarkNode) => Promise<void>,
	): Promise<void> => {
		this.pendingEditBookmark = null
		// New menu cycle — clear locked URLs from previous interaction.
		this._lockedUrls.clear()
		// Clear the previous tab snapshot. A new snapshot is set in handleMenuHidden.
		this._preHotswapTabIds = null

		try {
			if (!info.contexts.includes('bookmark') || !info.bookmarkId) return

			const bookmark = (await this.deps.browserApi.bookmarks.get(info.bookmarkId))[0]
			if (!bookmark || bookmark.type === 'separator') return

			// Delegate menu rebuild to BAM (not our concern)
			setTimeout(() => onMenuRebuild(bookmark), 0)

			// Start hotswap if the bookmark is encoded
			if (bookmark.type === 'bookmark' && bookmark.url && isFragmentEncodedUrl(bookmark.url)) {
				const parsed = parseBookmarkUrl(bookmark.url)
				if (parsed && parsed.containerIndex !== null) {
					this.hotswapRecords.set(bookmark.id, {
						encodedUrl: bookmark.url,
						containerIndex: parsed.containerIndex,
					})
					this.pendingEditBookmark = { id: bookmark.id, containerIndex: parsed.containerIndex }
					await this.persistHotswapRecords()

					const realUrl = decodeToRealUrl(bookmark.url)

					this._hotswapRedirectMap.set(realUrl, {
						containerIndex: parsed.containerIndex,
						bookmarkId: bookmark.id,
					})
					this.debug('handleMenuShown: registered pendingHotswapUrl', realUrl, '→ container', parsed.containerIndex)

					this.selfUpdateBookmarkIds.add(bookmark.id)
					await this.deps.browserApi.bookmarks.update(bookmark.id, { url: realUrl })
				}
			}
		} catch (error) {
			this.debug(error)
		}
	}

	readonly handleMenuHidden = async (): Promise<void> => {
		// Capture tab snapshot NOW — before TC can create orphan tabs in response to
		// the user's next action (Open, Open in New Tab, Open in New Window).
		// TEC uses this to distinguish pre-existing tabs from TC-created orphans.
		const allTabs = await this.deps.browserApi.tabs.query({})
		this._preHotswapTabIds = new Set(allTabs.map(t => t.id))

		for (const [bookmarkId, record] of this.hotswapRecords) {
			if (this.hotswapRevertTimers.has(bookmarkId)) continue

			const decodedUrl = decodeToRealUrl(record.encodedUrl)

			// Guard: handleBeforeNavigate may have already consumed the entry during the
			// async tabs.query above. Don't re-add — that would cause a duplicate redirect
			// when TC creates a replacement tab for the same URL.
			if (!this._hotswapRedirectMap.has(decodedUrl)) {
				this._hotswapRedirectMap.set(decodedUrl, {
					containerIndex: record.containerIndex,
					bookmarkId,
				})
			}

			const timer = setTimeout(async () => {
				await this.revertHotswap(bookmarkId, record)
				this._hotswapRedirectMap.delete(decodedUrl)
				this._lockedUrls.delete(decodedUrl)
			}, HOTSWAP_REVERT_DELAY_MS)
			this.hotswapRevertTimers.set(bookmarkId, timer)
		}
	}

	readonly handleBookmarkChanged = async (id: string, changeInfo: { url?: string; title?: string }): Promise<void> => {
		// Ignore our own re-encoding updates
		if (this.selfUpdateBookmarkIds.has(id)) {
			this.selfUpdateBookmarkIds.delete(id)
			return
		}

		if (!changeInfo.url) return

		// Case 1: User edited a bookmark that has an active hotswap record
		const record = this.hotswapRecords.get(id)
		if (record) {
			try {
				this.cancelHotswapTimer(id)

				const newEncodedUrl = getNewUrl({ seed: this.deps.randomValue }, record.containerIndex, changeInfo.url)
				this.selfUpdateBookmarkIds.add(id)
				await this.deps.browserApi.bookmarks.update(id, { url: newEncodedUrl })

				// Persist AFTER update to ensure near-atomic operation safety
				this.hotswapRecords.delete(id)
				await this.persistHotswapRecords()
			} catch (error) {
				this.debug(error)
			}
			return
		}

		// Case 2: User edited a bookmark that was pending (menu shown but not yet hidden)
		if (this.pendingEditBookmark && this.pendingEditBookmark.id === id) {
			const { containerIndex } = this.pendingEditBookmark
			this.pendingEditBookmark = null

			try {
				const newEncodedUrl = getNewUrl({ seed: this.deps.randomValue }, containerIndex, changeInfo.url)
				this.selfUpdateBookmarkIds.add(id)
				await this.deps.browserApi.bookmarks.update(id, { url: newEncodedUrl })
			} catch (error) {
				this.debug(error)
			}
		}
	}

	readonly handleBookmarkCreated = async (id: string, bookmark: BookmarkNode): Promise<void> => {
		if (bookmark.type !== 'bookmark' || !bookmark.url || !isFragmentEncodedUrl(bookmark.url)) {
			return
		}

		try {
			const settings = await this.deps.settings()
			if (settings.allowEncodedBookmarkImport) return

			// Allow duplicates — if another bookmark has the same encoded URL, this is
			// likely a legitimate copy/move, not injection.
			const matches = await this.deps.browserApi.bookmarks.search(bookmark.url)
			const duplicates = matches.filter(b => b.type === 'bookmark' && b.url === bookmark.url && b.id !== id)
			if (duplicates.length > 0) return

			const cleanUrl = decodeToRealUrl(bookmark.url)
			this.selfUpdateBookmarkIds.add(id)
			await this.deps.browserApi.bookmarks.update(id, { url: cleanUrl })
			this.debug('stripped orphaned encoding from new bookmark', id, bookmark.url, '→', cleanUrl)
		} catch (error) {
			this.debug(error)
		}
	}

	// --- Lifecycle ---

	async initialize(): Promise<void> {
		await this.recoverPendingHotswaps()
	}

	async recoverPendingHotswaps(): Promise<void> {
		const payload = await this.deps.browserApi.storage.local.get(HOTSWAP_STORAGE_KEY)
		const records = payload[HOTSWAP_STORAGE_KEY]
		if (!records || typeof records !== 'object') return

		for (const [bookmarkId, record] of Object.entries(records as Record<string, HotswapRecord>)) {
			if (!record?.encodedUrl || typeof record.containerIndex !== 'number') continue

			try {
				const bookmarks = await this.deps.browserApi.bookmarks.get(bookmarkId)
				const bookmark = bookmarks[0]
				if (!bookmark?.url) continue

				// Only re-encode if the bookmark is currently in decoded form
				if (!isFragmentEncodedUrl(bookmark.url)) {
					const newUrl = getNewUrl({ seed: this.deps.randomValue }, record.containerIndex, bookmark.url)
					await this.deps.browserApi.bookmarks.update(bookmarkId, { url: newUrl })
				}
			} catch (error) {
				this.debug('hotswap recovery failed for', bookmarkId, error)
			}
		}

		// Clear persisted records after recovery
		await this.deps.browserApi.storage.local.set({ [HOTSWAP_STORAGE_KEY]: {} })
	}

	// --- Internal helpers ---

	private debug(...args: unknown[]): void {
		this.deps.logger.log(...args)
	}

	private async shouldOpenBeforeClose(tab: Tab): Promise<boolean> {
		if (tab.windowId == null) return false
		try {
			const windowTabs = await this.deps.browserApi.tabs.query({ windowId: tab.windowId })
			return windowTabs.length <= 1
		} catch (error) {
			this.debug('activate: failed to count tabs in window', error)
			return false
		}
	}

	private async removeSourceTab(tab: Tab): Promise<void> {
		if (tab.id == null) return
		try {
			await this.deps.browserApi.tabs.remove(tab.id)
		} catch {
			this.debug('activate: source tab already removed (TC may have replaced it)')
		}
	}

	private async persistHotswapRecords(): Promise<void> {
		const records: Record<string, HotswapRecord> = {}
		for (const [id, record] of this.hotswapRecords) {
			records[id] = record
		}
		await this.deps.browserApi.storage.local.set({ [HOTSWAP_STORAGE_KEY]: records })
	}

	private cancelHotswapTimer(bookmarkId: string): void {
		const timer = this.hotswapRevertTimers.get(bookmarkId)
		if (timer) {
			clearTimeout(timer)
			this.hotswapRevertTimers.delete(bookmarkId)
		}
	}

	private async revertHotswap(bookmarkId: string, record: HotswapRecord): Promise<void> {
		try {
			this.hotswapRevertTimers.delete(bookmarkId)
			this.hotswapRecords.delete(bookmarkId)
			await this.persistHotswapRecords()

			this.selfUpdateBookmarkIds.add(bookmarkId)
			await this.deps.browserApi.bookmarks.update(bookmarkId, { url: record.encodedUrl })
		} catch (error) {
			this.debug(error)
		}
	}

	/**
	 * Resets and restarts the revert timer for a bookmark, giving the async redirect chain
	 * more time to complete before the bookmark is reverted to its encoded form.
	 */
	private extendRevertTimer(bookmarkId: string): void {
		this.cancelHotswapTimer(bookmarkId)

		const record = this.hotswapRecords.get(bookmarkId)
		if (!record) return

		const decodedUrl = decodeToRealUrl(record.encodedUrl)
		const timer = setTimeout(async () => {
			await this.revertHotswap(bookmarkId, record)
			this._hotswapRedirectMap.delete(decodedUrl)
			this._lockedUrls.delete(decodedUrl)
		}, HOTSWAP_REVERT_DELAY_MS)
		this.hotswapRevertTimers.set(bookmarkId, timer)
	}
}
