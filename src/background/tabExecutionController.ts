/**
 * @module TabExecutionController
 * @role Owns all tab/window side-effects. Consumes NavigationIntent objects from NavigationPolicyEngine.
 * @ownsState (none — purely effectful, no long-lived state)
 * @tests tests/tabExecutionController.test.ts
 *
 * Responsibilities:
 * - Execute NavigationIntent: create tab in container, remove source tab
 * - Route `redirect-temp` intents through TC/TC+ runtime API (with fallback)
 * - Handle `reset-token` intents by updating the bookmark URL after redirect
 * - Manage page action visibility (show/hide based on current tab URL and settings)
 * - Handle page action click: create bookmark + optional container assignment
 * - Clean up orphaned about:blank tabs left by Temporary Containers after redirect
 *
 * Boundary contract:
 * - Receives `BrowserApi`, settings accessor, mapping store accessor, and
 *   `tempContainersExtensionId` from BookmarkAssignmentManager.
 * - Consumes NavigationIntent — never decides whether to redirect (that's policy).
 * - Tab event handlers (`onCreated`, `onUpdated`, etc.) live in the runtime, which
 *   calls NavigationPolicyEngine for intent, then hands intent to this controller.
 *
 * Failure modes:
 * - TC extension unavailable for temp-container intent: falls back to default container.
 * - Tab removal fails (already closed): error is logged and swallowed.
 * - Page action toggle fails: error is logged, UI may be stale until next tab switch.
 */

import type {
	BookmarkNode,
	BookmarkReference,
	BrowserApi,
	ContainMarksSettings,
	ContextualIdentity,
	LoggerLike,
	NavigationIntent,
	Tab,
} from '../models'
import type { ContainerMappingStore } from '../containerMappingStore'

export interface TabExecutionControllerDeps {
	readonly browserApi: BrowserApi
	readonly logger: LoggerLike
	settings(): Promise<ContainMarksSettings>
	mappingStore(settings: ContainMarksSettings): ContainerMappingStore
	/** TC/TC+ extension ID from BookmarkAssignmentManager, or null if not installed. */
	tempContainersExtensionId(): string | null
	/** Resolves a container identity by cookieStoreId or backupName. Injected from BAM. */
	getContainer(query: { cookieStoreId?: string | null; backupName?: string | null }): Promise<ContextualIdentity | null>
	/** Encodes/refreshes a bookmark's container URL. Injected from BAM. */
	updateBookmarkContainerUrl(bookmark: BookmarkNode, cookieStoreId?: string | null): Promise<BookmarkReference | null>
	/** Checks whether a cookieStoreId belongs to an ephemeral Temporary Container. Injected from BAM. */
	isTempContainer(cookieStoreId: string): Promise<boolean>
}

/**
 * Executes tab and window side-effects described by NavigationIntent objects.
 *
 * This module never decides *whether* to redirect — it only knows *how*. All redirect
 * decisions flow through NavigationPolicyEngine first.
 */
export interface TabExecutionController {
	// --- Intent execution ---

	/**
	 * Execute a NavigationIntent against a source tab. Handles all variants:
	 * - `noop`: no action
	 * - `redirect`: create tab in cookieStoreId, remove source
	 * - `redirect-temp`: delegate to TC/TC+ API, remove source, fall back on failure
	 * - `reset-token`: redirect + regenerate the bookmark's token afterward
	 */
	executeIntent(intent: NavigationIntent, sourceTab: Tab): Promise<void>

	/**
	 * Open a URL in the specified container, positioned after the source tab, then close
	 * the source tab. Core redirect primitive used by `executeIntent`.
	 */
	openInContainer(cookieStoreId: string, url: string, tab: Tab): Promise<void>

	/**
	 * After a redirect, clean up orphaned about:blank tabs that Temporary Containers
	 * may have created in the same window.
	 */
	cleanupOrphanedTabs(windowId: number, targetCookieStoreId: string): Promise<void>

	// --- Page action ---

	/** Show or hide the page action icon for a specific tab based on URL and settings. */
	syncPageActionVisibilityForTab(tabId: number): Promise<void>

	/** Update page action visibility for all tabs in all windows. */
	syncPageActionVisibilityForAllTabs(): Promise<void>

	/**
	 * Checks whether a cookieStoreId belongs to an ephemeral Temporary Container
	 * via the TC/TC+ runtime API. Returns false when no TC extension is installed.
	 */
	isTempContainer(cookieStoreId: string): Promise<boolean>

	/**
	 * Handle page action click: create a bookmark for the current tab, optionally
	 * assign it to the tab's container, and show a notification.
	 */
	readonly handlePageActionClicked: (tab: Tab) => Promise<void>
}

// --- Implementation ---

import { NO_CONTAINER, TEMP_CONTAINER_SENTINEL } from '../backgroundApp'

export class TabExecutionControllerImpl implements TabExecutionController {
	private readonly browserApi: BrowserApi
	private readonly logger: LoggerLike
	private readonly deps: TabExecutionControllerDeps

	constructor(deps: TabExecutionControllerDeps) {
		this.deps = deps
		this.browserApi = deps.browserApi
		this.logger = deps.logger
	}

	private debug(...args: unknown[]): void {
		this.logger.log(...args)
	}

	async executeIntent(intent: NavigationIntent, sourceTab: Tab): Promise<void> {
		switch (intent.action) {
			case 'noop':
				return
			case 'redirect':
				await this.openInContainer(intent.cookieStoreId, intent.url, sourceTab)
				return
			case 'redirect-temp':
				await this.openInTempContainer(intent.url, sourceTab)
				return
			case 'reset-token':
				await this.openInContainer(intent.cookieStoreId, intent.url, sourceTab)
				await this.deps.updateBookmarkContainerUrl(intent.bookmark)
				return
		}
	}

	async openInContainer(cookieStoreId: string, url: string, tab: Tab): Promise<void> {
		this.debug('open', cookieStoreId, url, tab)

		if (cookieStoreId === TEMP_CONTAINER_SENTINEL) {
			await this.openInTempContainer(url, tab)
			return
		}

		try {
			const container = await this.deps.getContainer({ cookieStoreId })
			if (container === null || tab.id === undefined) {
				return
			}

			await this.browserApi.tabs.create({
				cookieStoreId: container.cookieStoreId,
				url,
				index: tab.index + 1
			})
			await this.browserApi.tabs.remove(tab.id!)
		} catch (error) {
			this.debug(error)
		}
	}

	/**
	 * Opens a URL in a fresh Temporary Container via the TC/TC+ runtime API. Falls back to
	 * opening in the default container if no TC extension is available or the API call fails.
	 */
	private async openInTempContainer(url: string, tab: Tab): Promise<void> {
		if (tab.id === undefined) return

		const extensionId = this.deps.tempContainersExtensionId()
		try {
			if (!extensionId) throw new Error('No Temporary Containers extension detected')

			this.debug('openInTempContainer: requesting createTabInTempContainer via', extensionId, url)
			await this.browserApi.runtime.sendMessage(extensionId, {
				method: 'createTabInTempContainer',
				url,
				active: true
			})
			await this.browserApi.tabs.remove(tab.id)
		} catch (error) {
			this.debug('openInTempContainer: TC API call failed, falling back', error)
			try {
				await this.browserApi.tabs.create({ url, index: tab.index + 1 })
				await this.browserApi.tabs.remove(tab.id)
			} catch (fallbackError) {
				this.debug('openInTempContainer: fallback also failed', fallbackError)
			}
		}
	}

	async cleanupOrphanedTabs(windowId: number, targetCookieStoreId: string): Promise<void> {
        const oldTabs = await this.browserApi.tabs.query({ windowId })
        this.debug('cleanupOrphanedTabs: existing tabs in window', windowId, oldTabs)

        // TC may create orphaned about:blank tabs asynchronously after the redirect, so wait a moment before checking
		await new Promise(resolve => setTimeout(resolve, 150))

		try {
			const tabs = await this.browserApi.tabs.query({ windowId })
			for (const tab of tabs) {
                // Exclusion guard: only consider tabs that appeared AFTER the delay,
                // so we never remove pre-existing about:blank tabs. Trade-off: if TC creates
                // the orphan before our snapshot (rare), we'll miss it — same heuristic as the
                // 150ms delay itself. Needs integration testing with TC installed.
                // HUMAN TODO test this in runtime extensively.

                // leave preexisting tabs be
                if (oldTabs.some(oldTab => oldTab.id === tab.id)) continue;

                const isOrphan = tab.url === 'about:blank'
					&& tab.cookieStoreId !== NO_CONTAINER
					&& tab.cookieStoreId !== targetCookieStoreId
					&& tab.id !== undefined

				if (isOrphan) {
					this.debug('cleanupOrphanedTabs: removing orphaned tab', tab.id, tab.cookieStoreId)
					await this.browserApi.tabs.remove(tab.id!)
				}
			}
		} catch (error) {
			this.debug('cleanupOrphanedTabs: error', error)
		}
	}

	async isTempContainer(cookieStoreId: string): Promise<boolean> {
		return this.deps.isTempContainer(cookieStoreId)
	}

	async syncPageActionVisibilityForTab(tabId: number): Promise<void> {
		// Short-circuit via isShown to avoid redundant show/hide calls (prevents visual flicker).
        // HUMAN TODO: ensure this doesn't flicker
		const settings = await this.deps.settings()
        const tab = await this.browserApi.tabs.get(tabId)

        this.debug('pageAction visibility', { tabId, showPageActionButton: settings.showPageActionButton })
        const shown = await this.browserApi.pageAction.isShown({ tabId })
        const desiredState = settings.showPageActionButton && tab.cookieStoreId !== NO_CONTAINER && tab.cookieStoreId !== null

        if (desiredState && !shown) {
            await this.browserApi.pageAction.show(tabId)
        } else if (!desiredState && shown) {
            await this.browserApi.pageAction.hide(tabId)
        }

        if (desiredState) {
            const isTempContainer = await this.isTempContainer(tab.cookieStoreId ?? '')
            const containerSnippet = isTempContainer
                ? 'a Temporary Container'
                : 'the ' + await this.browserApi.contextualIdentities.get(tab.cookieStoreId as string).then(container => container.name) + ' container';
            await this.browserApi.pageAction.setTitle({ tabId, title: `Bookmark this page in ${containerSnippet}` })
        }
	}

	async syncPageActionVisibilityForAllTabs(): Promise<void> {
		const settings = await this.deps.settings()
		const tabs = await this.browserApi.tabs.query({})
		for (const tab of tabs) {
			if (tab.id === undefined) continue;
            setTimeout(() => this.syncPageActionVisibilityForTab(tab.id as number), 0)
		}
	}

	readonly handlePageActionClicked = async (tab: Tab): Promise<void> => {
		try {
			if (!tab.url) {
				return
			}

			const settings = await this.deps.settings()
			if (!settings.showPageActionButton) {
				if (tab.id !== undefined) {
					await this.syncPageActionVisibilityForTab(tab.id)
				}
				return
			}
			const mappingStore = this.deps.mappingStore(settings)

			let assignedCookieStoreId: string | null = null
			let containerLabel = 'No Container'
			const isTemp = tab.cookieStoreId ? await this.isTempContainer(tab.cookieStoreId) : false
			if (isTemp) {
				// Assign to the stable sentinel so the bookmark opens in a fresh TC each time,
				// rather than pinning to a specific ephemeral container that may already be gone.
				assignedCookieStoreId = TEMP_CONTAINER_SENTINEL
				containerLabel = 'a Temporary Container'
				await mappingStore.ensureMappingForContainer({
					cookieStoreId: TEMP_CONTAINER_SENTINEL,
					name: 'Temporary Container',
					icon: 'circle',
					color: 'toolbar'
				})
			} else {
				const container = await this.deps.getContainer({ cookieStoreId: tab.cookieStoreId ?? null })
				if (container) {
					await mappingStore.ensureMappingForContainer(container)
					assignedCookieStoreId = container.cookieStoreId
					containerLabel = container.name
				}
			}

			const MAX_NOTIFICATION_TITLE_LENGTH = 10
			const title = (tab.title ?? '').slice(0, MAX_NOTIFICATION_TITLE_LENGTH)
			const bookmark = await this.browserApi.bookmarks.create({
				parentId: settings.targetFolderId,
				index: 0,
				title,
				url: tab.url
			})

			if (assignedCookieStoreId !== null) {
				const assigned = await this.deps.updateBookmarkContainerUrl(bookmark, assignedCookieStoreId)
				this.debug(assigned)
			}

			await this.browserApi.notifications.create({
				type: 'basic',
				title: 'Bookmark Created',
				message: `${title} in ${containerLabel})`
			})
		} catch (error) {
			this.debug(error)
		}
	}
}
