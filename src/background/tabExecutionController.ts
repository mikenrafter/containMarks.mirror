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
	BrowserApi,
	ContainMarksSettings,
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
	 * Handle page action click: create a bookmark for the current tab, optionally
	 * assign it to the tab's container, and show a notification.
	 */
	readonly handlePageActionClicked: (tab: Tab) => Promise<void>
}
