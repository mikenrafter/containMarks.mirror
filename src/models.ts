export type BookmarkNodeType = '' | 'bookmark' | 'folder' | 'separator'

export interface BookmarkNode {
	id: string
	type: BookmarkNodeType
	url?: string
	title?: string
	index?: number
	parentId?: string
	children?: BookmarkNode[]
}

export interface LegacyReference {
	bookmarkId: string
	backupName: string | null
}

export interface ParsedBookmarkUrl {
	url: string
	token: string
	containerIndex: number | null
}

export interface BookmarkReference extends ParsedBookmarkUrl {
	bookmarkId: string
	cookieStoreId: string | null
}

export interface ContainMarksSettings {
	targetFolderId: string
	resetTokensOnStartup: boolean
	regenerateTokenOnEveryUse: boolean
	acknowledgeRiskyTokenBehavior: boolean
	showPageActionButton: boolean
	enableBookmarkSync: boolean
	/** When true, newly-created bookmarks with `#cm:` encoding are not auto-stripped.
	 *  Useful during bookmark import/transfer. Reverts to `false` on every extension startup. */
	allowEncodedBookmarkImport: boolean
}

export interface ContainerMappingRecord {
	firstSeenIndex: number
	cookieStoreId: string
	backupName: string
}

export interface BookmarkTokenSource {
	value?: string
	seed?: () => number
}

export interface ContextualIdentity {
	name: string
	cookieStoreId: string
	icon:
		| 'fingerprint'
		| 'briefcase'
		| 'dollar'
		| 'cart'
		| 'circle'
		| 'gift'
		| 'vacation'
		| 'food'
		| 'fruit'
		| 'pet'
		| 'tree'
		| 'chill'
		| 'fence'
	iconUrl?: `resource://usercontext-content/${string}.svg`
	color: 'blue' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple' | 'toolbar'
	colorCode?: `#${string}`
}

export interface MenusOnClickInfo {
	bookmarkId: string
	menuItemId: string
}

export interface MenusOnShownInfo {
	contexts: string[]
	bookmarkId?: string
}

export interface TabChangeInfo {
	status?: string
	url?: string
}

export interface TabActivatedInfo {
	tabId: number
}

export interface Tab {
	id?: number
	url?: string
	index: number
	title?: string
	cookieStoreId?: string
	windowId?: number
}

export interface Window {
	id?: number
	tabs?: Tab[]
}

export interface MenusCreateDetails {
	id?: string
	title?: string
	contexts: string[]
	parentId?: string
	type?: 'separator' | 'radio'
	checked?: boolean
	icons?: Record<number, string>
}

export interface StorageLike {
	readonly length: number
	key(index: number): string | null
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
}

export interface BookmarksApi {
	search(query: {query?: string, url?: string, title?: string}): Promise<BookmarkNode[]>
	search(query: string): Promise<BookmarkNode[]>
	get(id: string): Promise<BookmarkNode[]>
	getTree(): Promise<BookmarkNode[]>
	getChildren(id: string): Promise<BookmarkNode[]>
	remove(id: string): Promise<void>
	update(id: string, changes: { url?: string; title?: string }): Promise<BookmarkNode>
	create(details: {
		parentId: string
		index?: number
		title: string
		url?: string
		type?: 'folder'
	}): Promise<BookmarkNode>
	onRemoved: {
		addListener(listener: (id: string, info: { node: BookmarkNode }) => void | Promise<void>): void
	}
	onChanged: {
		addListener(listener: (id: string, changeInfo: { url?: string; title?: string }) => void | Promise<void>): void
	}
	onCreated: {
		addListener(listener: (id: string, bookmark: BookmarkNode) => void | Promise<void>): void
	}
}

export interface MenusApi {
	create(details: MenusCreateDetails): void
	refresh(): void
	removeAll(): void
	onClicked: {
		addListener(listener: (info: MenusOnClickInfo) => void | Promise<void>): void
	}
	onShown: {
		addListener(listener: (info: MenusOnShownInfo) => void | Promise<void>): void
	}
	onHidden: {
		addListener(listener: () => void | Promise<void>): void
	}
}

export interface ContextualIdentitiesApi {
	query(details: { name?: string }): Promise<ContextualIdentity[]>
	get(cookieStoreId: string): Promise<ContextualIdentity>
}

export interface TabsApi {
	TAB_ID_NONE: number
	create(details: Partial<{ cookieStoreId: string; url: string; index: number }>): Promise<Tab>
	remove(tabId: number): Promise<void>
	get(tabId: number): Promise<Tab>
	update(tabId: number, updateProperties: { url?: string, loadReplace?: boolean }): Promise<Tab>
	query(queryInfo: { windowId?: number }): Promise<Tab[]>
	highlight(details: { populate: boolean; tabs: number[] }): Promise<void>
	onActivated: {
		addListener(listener: (activeInfo: TabActivatedInfo) => void | Promise<void>): void
	}
	onUpdated: {
		addListener(listener: (id: number, changeInfo: TabChangeInfo, tab: Tab) => void | Promise<void>): void
	}
	onCreated: {
		addListener(listener: (tab: Tab) => void | Promise<void>): void
	}
}

export interface WindowsApi {
	onCreated: {
		addListener(listener: (window: Window) => void | Promise<void>): void
	}
}

export interface NotificationsApi {
	create(details: { type: 'basic'; title: string; message: string }): Promise<string>
}

export interface PageActionApi {
	isShown(request: { tabId: number }): Promise<boolean>
	setTitle(details: { tabId: number; title: string }): Promise<void>
	show(tabId: number): Promise<void>
	hide(tabId: number): Promise<void>
	onClicked: {
		addListener(listener: (tab: Tab) => void | Promise<void>): void
	}
}

export interface WebNavigationBeforeNavigateDetails {
	tabId: number
	url: string
	frameId: number
}

export interface WebNavigationApi {
	onBeforeNavigate: {
		addListener(
			listener: (details: WebNavigationBeforeNavigateDetails) => void | Promise<void>,
			filter?: { url: Array<{ urlContains?: string }> }
		): void
	}
}

export interface WebRequestBeforeRequestDetails {
	requestId: string
	tabId: number
	url: string
	type: string
}

export interface BlockingResponse {
	cancel?: boolean
}

export interface WebRequestApi {
	onBeforeRequest: {
		addListener(
			listener: (details: WebRequestBeforeRequestDetails) => BlockingResponse | void,
			filter: { urls: string[]; types?: string[] },
			extraInfoSpec?: string[]
		): void
	}
}

export interface ExtensionInfo {
	id: string
	name: string
	enabled: boolean
	type: string
}

/** Subset of browser.management used to detect companion extensions (e.g., Temporary Containers Plus). */
export interface ManagementApi {
	get(extensionId: string): Promise<ExtensionInfo>
}

/**
 * Subset of browser.runtime used for cross-extension messaging. The sendMessage overload here
 * targets a specific extension by ID — used to invoke the TC+ API.
 */
export interface RuntimeApi {
	sendMessage(extensionId: string, message: Record<string, unknown>): Promise<unknown>
}

export interface BrowserApi {
	bookmarks: BookmarksApi
	menus: MenusApi
	contextualIdentities: ContextualIdentitiesApi
	tabs: TabsApi
	windows: WindowsApi
	notifications: NotificationsApi
	pageAction: PageActionApi
	webNavigation: WebNavigationApi
	webRequest: WebRequestApi
	management: ManagementApi
	runtime: RuntimeApi
	storage: {
		local: {
			get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>
			set(items: Record<string, unknown>): Promise<void>
		}
	}
}

export interface LoggerLike {
	log: (...args: unknown[]) => void
}

// --- Navigation intent types (shared vocabulary for module boundaries) ---

/**
 * A bookmark URL that was temporarily decoded ("hotswapped") so the native Properties
 * dialog shows the clean URL. Persisted to storage for crash safety.
 */
export interface HotswapRecord {
	encodedUrl: string
	containerIndex: number
}

/**
 * A tab navigation that was flagged by `onBeforeNavigate` (which can read fragment) and
 * is awaiting cancellation by `onBeforeRequest`. Short-lived: deleted once the request
 * is cancelled and the async redirect fires.
 */
export interface PendingInterception {
	containerIndex: number
	realUrl: string
	encodedUrl: string
}

/**
 * Info attached to a decoded URL during a hotswap window, so that new-tab/new-window
 * navigations to the decoded URL can be intercepted and reopened in the correct container.
 */
export interface HotswapRedirectInfo {
	containerIndex: number
	bookmarkId: string
}

/**
 * Discriminated union returned by NavigationPolicyEngine. Each variant tells
 * the navigation pipeline exactly what side-effect to perform, without encoding
 * *how* to perform it.
 *
 * - `noop`: No redirect needed (already in target container, or no mapping found).
 * - `redirect`: Open the URL in a specific container, closing the source tab.
 * - `redirect-temp`: Open the URL in a fresh Temporary Container.
 * - `reset-token`: After redirect, regenerate the bookmark's token (when settings require it).
 */
export type NavigationIntent =
	| { readonly action: 'noop' }
	| { readonly action: 'redirect'; readonly cookieStoreId: string; readonly url: string }
	| { readonly action: 'redirect-temp'; readonly url: string }
	| { readonly action: 'reset-token'; readonly cookieStoreId: string; readonly url: string; readonly bookmark: BookmarkNode }