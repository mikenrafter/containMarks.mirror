/**
 * @module ContainMarksRuntime
 * @role Wiring layer — connects browser event listeners to module handlers, owns startup/migration.
 * @ownsState syncMappingStore, localMappingStore (instantiation only; modules receive accessor)
 * @tests tests/backgroundApp.test.ts (existing, will adapt)
 *
 * Responsibilities:
 * - Construct and wire BookmarkAssignmentManager, NavigationPolicyEngine, TabExecutionController
 * - Register all browser event listeners, routing each callback to the appropriate module
 * - Run startup sequence: migration, hotswap recovery, TC detection, token refresh
 * - Provide settings accessor (lazy-loaded) and mapping store selector (sync vs local)
 * - Translate tab/window events into policy evaluation → intent execution pipeline
 *
 * Boundary contract:
 * - Only module that touches `registerListeners()` and `initialize()`.
 * - Routes event callbacks; does NOT embed business logic.
 * - Tab/window event handlers call NavigationPolicyEngine.evaluate…(), then pass the resulting
 *   NavigationIntent to TabExecutionController.executeIntent().
 * - Startup migrations are inlined here (one-time, non-recurring flows).
 *
 * Failure modes:
 * - Startup migration failure: logged, extension continues with reduced functionality.
 * - Individual listener callback failure: caught and logged, other listeners unaffected.
 *
 * Design direction:
 * - This is the future `BackgroundApp` replacement. During migration, `BackgroundApp` delegates
 *   to these modules incrementally until it contains only wiring code, then is renamed.
 */

import type {
	BrowserApi,
	ContainMarksSettings,
	LoggerLike,
	StorageLike,
	Tab,
	TabActivatedInfo,
	TabChangeInfo,
	Window,
} from '../models'
import type { ContainerMappingStore } from '../containerMappingStore'
import type { BookmarkAssignmentManager } from './bookmarkAssignmentManager'
import type { NavigationPolicyEngine } from './navigationPolicyEngine'
import type { TabExecutionController } from './tabExecutionController'

export interface ContainMarksRuntimeDeps {
	readonly browserApi: BrowserApi
	readonly storage: StorageLike
	readonly logger: LoggerLike
	readonly randomValue: () => number
}

/**
 * Top-level orchestrator for the extension background process.
 *
 * Replaces the monolithic `BackgroundApp` with a wiring layer that connects three behavioral
 * modules. This interface defines the public surface visible to `background.ts` — the single
 * entry point that calls `initialize()` at extension load.
 */
export interface ContainMarksRuntime {
	/** Debug mode toggle — suppressed during startup to reduce console noise. */
	enableDebug: boolean

	// --- Module accessors (primarily for testing and cross-module wiring) ---

	readonly assignmentManager: BookmarkAssignmentManager
	readonly policyEngine: NavigationPolicyEngine
	readonly executionController: TabExecutionController

	// --- Lifecycle ---

	/**
	 * Bootstrap entry point — called once at extension load.
	 * 1. Suppresses debug logging
	 * 2. Fires startup() (migration, hotswap recovery, TC detection)
	 * 3. Rebuilds context menu
	 * 4. Registers browser event listeners
	 * 5. Re-enables debug logging
	 */
	initialize(): void

	// --- Event routing (these translate browser callbacks into module calls) ---

	/**
	 * `tabs.onCreated` → evaluate hotswap redirect via policy engine → execute intent.
	 * Not on the policy engine because it needs tab-level context from the execution layer.
	 */
	readonly handleTabCreated: (tab: Tab) => Promise<void>

	/**
	 * `windows.onCreated` → for each tab in the window, evaluate and execute.
	 */
	readonly handleWindowCreated: (window: Window) => Promise<void>

	/**
	 * `tabs.onUpdated` → evaluate tab URL change via policy engine → execute intent.
	 * Handles both fragment-encoded navigations and hotswap redirect matches.
	 */
	readonly handleTabUpdated: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => Promise<void>

	/**
	 * `tabs.onActivated` → update page action visibility via execution controller.
	 */
	readonly handleTabActivated: (activeInfo: TabActivatedInfo) => Promise<void>
}
