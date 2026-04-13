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
 *   resolved asynchronously and handed to TabExecutionController.
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

export interface NavigationPolicyEngineDeps {
	readonly browserApi: BrowserApi
	readonly logger: LoggerLike
	settings(): Promise<ContainMarksSettings>
	mappingStore(settings: ContainMarksSettings): ContainerMappingStore
	/** Read-only access to the hotswap redirect map owned by BookmarkAssignmentManager. */
	hotswapRedirectMap(): ReadonlyMap<string, HotswapRedirectInfo>
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
	 * Evaluate a navigation that didn't go through the webRequest pipeline — e.g. same-page
	 * fragment change, legacy `about:` URL, or hotswap redirect from tab/window creation.
	 * Returns the intent describing what action (if any) to take.
	 */
	evaluateTabNavigation(tabId: number, url: string, tab: Tab): Promise<NavigationIntent>

	/**
	 * Evaluate whether a newly-created tab's URL matches a hotswap redirect entry.
	 * Used by the runtime to check tabs from `onCreated` and `onWindowCreated`.
	 */
	evaluateHotswapRedirect(url: string, tab: Tab): Promise<NavigationIntent>
}
