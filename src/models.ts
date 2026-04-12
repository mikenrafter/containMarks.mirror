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
	create(details: { cookieStoreId: string; url: string; index: number }): Promise<void>
	remove(tabId: number): Promise<void>
	get(tabId: number): Promise<Tab>
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