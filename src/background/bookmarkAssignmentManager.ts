/**
 * @module BookmarkAssignmentManager
 * @role Owns context-menu-driven container assignment and hotswap lifecycle.
 * @ownsState hotswapRecords, hotswapRevertTimers, selfUpdateBookmarkIds, hotswapRedirectMap, pendingEditBookmark
 * @tests tests/bookmarkAssignmentManager.test.ts
 *
 * Responsibilities:
 * - Build and maintain context menu radio items reflecting current container assignment
 * - Execute container assignment when user picks a menu item (encode bookmark URL)
 * - Hotswap lifecycle: decode bookmark for Properties dialog, schedule revert, detect user edits
 * - Persist hotswap state for crash recovery
 * - Populate `hotswapRedirectMap` so NavigationPolicyEngine can intercept decoded-URL navigations
 * - Strip orphaned encoding from newly-created bookmarks (anti-injection)
 * - Detect Temporary Containers extension presence
 *
 * Boundary contract:
 * - Receives `BrowserApi`, settings accessor, and `ContainerMappingStore` accessor via constructor.
 * - Exposes `hotswapRedirectMap` as a read-only getter for NavigationPolicyEngine.
 * - Does NOT directly open tabs or create windows — all redirect execution is delegated
 *   to TabExecutionController via NavigationIntent objects.
 *
 * Failure modes:
 * - Crash during hotswap: persisted records allow recovery on next startup.
 * - Missing mapping for bookmark index: assignment is silently skipped (no container opened).
 * - TC extension not installed: temp-container menu item hidden, sentinel ignored at assignment time.
 */

import type {
	BookmarkNode,
	BrowserApi,
	ContainMarksSettings,
	ContextualIdentity,
	HotswapRecord,
	HotswapRedirectInfo,
	LoggerLike,
	MenusOnClickInfo,
	MenusOnShownInfo,
	StorageLike,
} from '../models'
import type { ContainerMappingStore } from '../containerMappingStore'

export interface BookmarkAssignmentManagerDeps {
	readonly browserApi: BrowserApi
	readonly storage: StorageLike
	readonly logger: LoggerLike
	readonly randomValue: () => number
	settings(): Promise<ContainMarksSettings>
	mappingStore(settings: ContainMarksSettings): ContainerMappingStore
}

/**
 * Manages the assignment of containers to bookmarks and the hotswap decode/revert cycle.
 *
 * All menu event handlers are exposed as bound function properties so they can be registered
 * directly as browser event listeners without rebinding.
 */
export interface BookmarkAssignmentManager {
	// --- State exposed to other modules ---

	/** Read-only view of decoded URLs awaiting new-tab interception during hotswap. */
	readonly hotswapRedirectMap: ReadonlyMap<string, HotswapRedirectInfo>

	/** Extension ID of detected TC/TC+ addon, or null if neither is installed. */
	readonly tempContainersExtensionId: string | null

	// --- Lifecycle ---

	/** Detect TC extension, recover persisted hotswap records, create initial menu items. */
	initialize(): Promise<void>

	/** Recover hotswap records from storage after a crash or restart. */
	recoverPendingHotswaps(): Promise<void>

	// --- Menu event handlers (bound functions for direct listener registration) ---

	readonly handleMenuClick: (info: MenusOnClickInfo) => Promise<void>
	readonly handleMenuShown: (info: MenusOnShownInfo) => Promise<void>
	readonly handleMenuHidden: () => Promise<void>

	// --- Bookmark event handlers ---

	readonly handleBookmarkChanged: (id: string, changeInfo: { url?: string; title?: string }) => Promise<void>
	readonly handleBookmarkCreated: (id: string, bookmark: BookmarkNode) => Promise<void>
}
