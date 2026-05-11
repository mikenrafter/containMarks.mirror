/**
 * @module PageActionHandler
 * @role Owns page action button visibility and click-to-bookmark behavior.
 *
 * The page action button appears in the address bar. When clicked, it creates a
 * bookmark in the target folder and encodes the container assignment into the URL.
 * Visibility is synced on tab switch and load-complete events.
 *
 * Boundary contract:
 * - Reads settings to determine whether the button should be visible.
 * - Delegates bookmark encoding to `updateBookmarkContainerUrl` (owned by BAM).
 * - Delegates temp-container detection to `isTempContainer` (owned by TC layer).
 * - Never performs navigation or tab redirects.
 *
 * Failure modes:
 * - Tab removed before sync completes: silently caught (tab may close mid-flight).
 * - Bookmark creation failure: logged, no notification shown.
 * - Settings load failure: button hidden (fail-safe default).
 */

import type {
	BookmarkNode,
	BookmarkReference,
	BrowserApi,
	ContainMarksSettings,
	LoggerLike,
	Tab,
} from '../models'
import { NO_CONTAINER, TEMP_CONTAINER_SENTINEL } from '../constants'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PageActionHandlerDeps {
	readonly browserApi: BrowserApi
	readonly logger: LoggerLike
	/** Lazily loads the current settings snapshot. */
	settings(): Promise<ContainMarksSettings>
	/** Encode/refresh a bookmark's container URL. Returns null on failure. */
	updateBookmarkContainerUrl(bookmark: BookmarkNode, cookieStoreId?: string | null): Promise<BookmarkReference | null>
	/** Check if a cookieStoreId belongs to an ephemeral Temporary Container. */
	isTempContainer(cookieStoreId: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Manages the page action button: visibility sync and bookmark creation on click.
 *
 * - `syncPageActionVisibilityForTab`: shows/hides the button for a single tab.
 * - `syncPageActionVisibilityForAllTabs`: bulk sync on startup.
 * - `handlePageActionClicked`: creates a container-encoded bookmark from the active tab.
 */
export interface PageActionHandler {
	/**
	 * Show or hide the page action button for `tabId` based on the current
	 * `showPageActionButton` setting. Skips API calls when already in the desired state.
	 */
	syncPageActionVisibilityForTab(tabId: number): Promise<void>

	/**
	 * Bulk sync for all open tabs — called once at startup to ensure button state
	 * matches settings after extension load or browser restart.
	 */
	syncPageActionVisibilityForAllTabs(): Promise<void>

	/**
	 * Creates a bookmark for the tab's current page and encodes the container assignment.
	 * When the tab is in a temp container, uses `TEMP_CONTAINER_SENTINEL` as the assignment.
	 * When the tab has no container (firefox-default), creates a plain bookmark.
	 *
	 * Bound function property — safe to pass directly as a browser listener callback.
	 */
	readonly handlePageActionClicked: (tab: Tab) => Promise<void>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class PageActionHandlerImpl implements PageActionHandler {
	private readonly deps: PageActionHandlerDeps
	private readonly browserApi: BrowserApi

	constructor(deps: PageActionHandlerDeps) {
		this.deps = deps
		this.browserApi = deps.browserApi
	}

	async syncPageActionVisibilityForTab(tabId: number): Promise<void> {
		try {
			const settings = await this.deps.settings()
			const isCurrentlyShown = await this.browserApi.pageAction.isShown({ tabId })

			if (settings.showPageActionButton && !isCurrentlyShown) {
				await this.browserApi.pageAction.show(tabId)
			} else if (!settings.showPageActionButton && isCurrentlyShown) {
				await this.browserApi.pageAction.hide(tabId)
			}
		} catch {
			// Tab may have closed between the event and this handler — safe to ignore.
		}
	}

	async syncPageActionVisibilityForAllTabs(): Promise<void> {
		const tabs = await this.browserApi.tabs.query({})
		for (const tab of tabs) {
			if (tab.id !== undefined && tab.id !== this.browserApi.tabs.TAB_ID_NONE) {
				await this.syncPageActionVisibilityForTab(tab.id)
			}
		}
	}

	readonly handlePageActionClicked = async (tab: Tab): Promise<void> => {
		const settings = await this.deps.settings()

		// Fail-safe: if the button shouldn't be visible, hide it and bail
		if (!settings.showPageActionButton) {
			if (tab.id !== undefined) {
				await this.browserApi.pageAction.hide(tab.id)
			}
			return
		}

		if (!tab.url) return

		const bookmark = await this.browserApi.bookmarks.create({
			parentId: settings.targetFolderId,
			index: 0,
			title: (tab.title ?? tab.url).slice(0, 10),
			url: tab.url,
		})

		// Determine container assignment
		const cookieStoreId = tab.cookieStoreId
		if (!cookieStoreId || cookieStoreId === NO_CONTAINER) {
			// No container — plain bookmark, no encoding needed
			return
		}

		// Temp container → use sentinel so the bookmark opens in any temp container
		const isTemp = await this.deps.isTempContainer(cookieStoreId)
		const assignedId = isTemp ? TEMP_CONTAINER_SENTINEL : cookieStoreId

		await this.deps.updateBookmarkContainerUrl(bookmark, assignedId)

		const containerLabel = isTemp ? 'a Temporary Container' : cookieStoreId
		await this.browserApi.notifications.create({
			type: 'basic',
			title: 'ContainMarks',
			message: `Bookmarked "${bookmark.title}" in ${containerLabel}`,
		})
	}
}
