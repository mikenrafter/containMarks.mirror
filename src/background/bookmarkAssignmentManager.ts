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
	BookmarkReference,
	BrowserApi,
	ContainerMappingRecord,
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
import {
	decodeToRealUrl,
	getNewUrl,
	isFragmentEncodedUrl,
	parseBookmarkUrl,
} from '../urlCodec'
import {
	HOTSWAP_STORAGE_KEY,
	NO_CONTAINER,
	TEMP_CONTAINER_SENTINEL,
	TEMP_CONTAINERS_EXTENSION_IDS,
} from '../backgroundApp'

/** How long to wait before reverting a hotswapped bookmark if no user edit is detected. */
const HOTSWAP_REVERT_DELAY_MS = 200

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

	/**
	 * Atomically lookup and remove a hotswap redirect entry. Returns the entry if found,
	 * or undefined if the URL was not in the map. Prevents duplicate redirects when
	 * multiple handlers (webNavigation, tabUpdated, tabCreated) race to consume the same entry.
	 */
	consumeHotswapRedirect(url: string): HotswapRedirectInfo | undefined

	/** Extension ID of detected TC/TC+ addon, or null if neither is installed. */
	readonly tempContainersExtensionId: string | null

	/**
	 * Tab IDs captured at `handleMenuHidden` time — before TC has a chance to create orphans.
	 * Used by TEC to distinguish pre-existing tabs from TC-created orphans during redirect.
	 * Null when no hotswap is in progress.
	 */
	readonly preHotswapTabIds: ReadonlySet<number | undefined> | null

	// --- Lifecycle ---

	/** Detect TC extension, recover persisted hotswap records, create initial menu items. */
	initialize(): Promise<void>

	/** Recover hotswap records from storage after a crash or restart. */
	recoverPendingHotswaps(): Promise<void>

	// --- Container resolution (injected into TEC deps) ---

	/**
	 * Resolves a container identity by cookieStoreId or backupName.
	 * BackupName fallback enables cross-device sync.
	 */
	getContainer(query: { cookieStoreId?: string | null; backupName?: string | null }): Promise<ContextualIdentity | null>

	/**
	 * Checks whether a cookieStoreId belongs to an ephemeral Temporary Container
	 * via the TC/TC+ runtime API. Returns false when no TC extension is installed.
	 * Shared by TEC (page action) and BAM (menu filtering) — canonical home is BAM
	 * because it owns the TC extension detection lifecycle.
	 */
	isTempContainer(cookieStoreId: string): Promise<boolean>

	/**
	 * Ensures a bookmark's URL encodes its container assignment with a fresh token.
	 * When cookieStoreId is provided, assigns to that container.
	 * When omitted, resolves existing mapping and regenerates the token.
	 */
	updateBookmarkContainerUrl(bookmark: BookmarkNode, cookieStoreId?: string | null): Promise<BookmarkReference | null>

	/** Recursively applies a container assignment to bookmarks or folders. */
	applyContainer(bookmarks: BookmarkNode[], cookieStoreId: string): Promise<void>

	// --- Menu management ---

	/** Builds the context menu tree with container radio items. */
	createMenuItems(bookmark?: Pick<BookmarkNode, 'type' | 'id' | 'url'>): Promise<void>

	// --- Menu event handlers (bound functions for direct listener registration) ---

	readonly handleMenuClick: (info: MenusOnClickInfo) => Promise<void>
	readonly handleMenuShown: (info: MenusOnShownInfo) => Promise<void>
	readonly handleMenuHidden: () => Promise<void>

	// --- Bookmark event handlers ---

	readonly handleBookmarkChanged: (id: string, changeInfo: { url?: string; title?: string }) => Promise<void>
	readonly handleBookmarkCreated: (id: string, bookmark: BookmarkNode) => Promise<void>
}

// --- Implementation ---

export class BookmarkAssignmentManagerImpl implements BookmarkAssignmentManager {
	private readonly browserApi: BrowserApi
	private readonly deps: BookmarkAssignmentManagerDeps

	private contextMenuItemsCreated = false
	private readonly menuRootId = 'assign_container'

	private readonly _hotswapRedirectMap = new Map<string, HotswapRedirectInfo>()
	private readonly hotswapRecords = new Map<string, HotswapRecord>()
	private readonly selfUpdateBookmarkIds = new Set<string>()
	private readonly hotswapRevertTimers = new Map<string, ReturnType<typeof setTimeout>>()
	private pendingEditBookmark: { id: string; containerIndex: number } | null = null

	private _tempContainersExtensionId: string | null = null
	private _preHotswapTabIds: Set<number | undefined> | null = null

	constructor(deps: BookmarkAssignmentManagerDeps) {
		this.deps = deps
		this.browserApi = deps.browserApi
	}

	get hotswapRedirectMap(): ReadonlyMap<string, HotswapRedirectInfo> {
		return this._hotswapRedirectMap
	}

	consumeHotswapRedirect(url: string): HotswapRedirectInfo | undefined {
		const info = this._hotswapRedirectMap.get(url)
		if (info) {
			this._hotswapRedirectMap.delete(url)
		}
		return info
	}

	get tempContainersExtensionId(): string | null {
		return this._tempContainersExtensionId
	}
	get preHotswapTabIds(): ReadonlySet<number | undefined> | null {
		return this._preHotswapTabIds
	}
	private debug(...args: unknown[]): void {
		this.deps.logger.log(...args)
	}

	// --- Lifecycle ---

	async initialize(): Promise<void> {
		await this.detectTempContainersExtension()
		await this.recoverPendingHotswaps()
		await this.rebuildMenuItems()
	}

	private async detectTempContainersExtension(): Promise<void> {
		for (const extensionId of TEMP_CONTAINERS_EXTENSION_IDS) {
			try {
				const extensionInfo = await this.browserApi.management.get(extensionId)
				if (extensionInfo.enabled) {
					this._tempContainersExtensionId = extensionId
					this.debug('Temporary Containers detected:', extensionInfo.name, extensionId)
					return
				}
			} catch {
				// Extension not installed — try next
			}
		}
		this._tempContainersExtensionId = null
		this.debug('No Temporary Containers extension found')
	}

	// --- Hotswap persistence ---

	private async persistHotswapRecords(): Promise<void> {
		const records: Record<string, HotswapRecord> = {}
		for (const [id, record] of this.hotswapRecords) {
			records[id] = record
		}
		await this.browserApi.storage.local.set({ [HOTSWAP_STORAGE_KEY]: records })
	}

	async recoverPendingHotswaps(): Promise<void> {
		const payload = await this.browserApi.storage.local.get(HOTSWAP_STORAGE_KEY)
		const records = payload[HOTSWAP_STORAGE_KEY]
		if (!records || typeof records !== 'object') return

		for (const [bookmarkId, record] of Object.entries(records as Record<string, HotswapRecord>)) {
			if (!record?.encodedUrl || typeof record.containerIndex !== 'number') continue

			try {
				const bookmarks = await this.browserApi.bookmarks.get(bookmarkId)
				const bookmark = bookmarks[0]
				if (!bookmark?.url) continue

				if (!isFragmentEncodedUrl(bookmark.url)) {
					const newUrl = getNewUrl({ seed: this.deps.randomValue }, record.containerIndex, bookmark.url)
					await this.browserApi.bookmarks.update(bookmarkId, { url: newUrl })
				}
			} catch (error) {
				this.debug('hotswap recovery failed for', bookmarkId, error)
			}
		}

		await this.browserApi.storage.local.set({ [HOTSWAP_STORAGE_KEY]: {} })
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
			await this.browserApi.bookmarks.update(bookmarkId, { url: record.encodedUrl })
		} catch (error) {
			this.debug(error)
		}
	}

	// --- Container resolution ---

	async getContainer(query: { cookieStoreId?: string | null; backupName?: string | null }): Promise<ContextualIdentity | null> {
		const { cookieStoreId, backupName } = query
		this.debug('getContainer', backupName, cookieStoreId)
		if (!cookieStoreId && !backupName) return null
		if (cookieStoreId === NO_CONTAINER) return null

		const containers: (ContextualIdentity | null)[] = []
		if (backupName) containers.unshift(...await this.browserApi.contextualIdentities.query({ name: backupName }))
		if (cookieStoreId) {
			try {
				containers.unshift(await this.browserApi.contextualIdentities.get(cookieStoreId))
			} catch {
				this.debug('container id not found', cookieStoreId)
			}
		}

		return containers.filter(x => x).at(0) ?? null as ContextualIdentity | null
	}

	async isTempContainer(cookieStoreId: string): Promise<boolean> {
		if (!this._tempContainersExtensionId) return false
		try {
			return await this.browserApi.runtime.sendMessage(
				this._tempContainersExtensionId,
				{ method: 'isTempContainer', cookieStoreId }
			) as boolean
		} catch {
			return false
		}
	}

	async updateBookmarkContainerUrl(bookmark: BookmarkNode, cookieStoreId: string | null = null): Promise<BookmarkReference | null> {
		if (!bookmark.id) return null

		const settings = await this.deps.settings()
		const mappingStore = this.deps.mappingStore(settings)

		const parsed = parseBookmarkUrl(bookmark.url ?? '')
		if (!parsed) return null
		this.debug('assign:', bookmark, cookieStoreId, parsed)

		try {
			let mapping: ContainerMappingRecord | null = null
			let updatedUrl = bookmark.url ?? parsed.url

			if (cookieStoreId === NO_CONTAINER) {
				updatedUrl = parsed.url
			} else if (cookieStoreId === TEMP_CONTAINER_SENTINEL) {
				mapping = await mappingStore.ensureMappingForContainer({
					cookieStoreId: TEMP_CONTAINER_SENTINEL,
					name: 'Temporary Container',
					icon: 'circle',
					color: 'toolbar'
				})
			} else if (cookieStoreId) {
				const container = await this.getContainer({ cookieStoreId })
				if (!container) return null
				mapping = await mappingStore.ensureMappingForContainer(container)
			} else {
				mapping = mappingStore.getByIndex(parsed.containerIndex)
			}
			const index = mapping?.firstSeenIndex ?? null

			if (mapping && index !== null) {
				updatedUrl = getNewUrl({ seed: this.deps.randomValue }, index, parsed.url)
				this.debug('refresh:', bookmark, updatedUrl)
			} else if (cookieStoreId === null) {
				return null
			}

			if (bookmark.url !== updatedUrl) {
				this.selfUpdateBookmarkIds.add(bookmark.id)
				await this.browserApi.bookmarks.update(bookmark.id, { url: updatedUrl })
			}
			return {
				bookmarkId: bookmark.id,
				cookieStoreId: mapping?.cookieStoreId ?? NO_CONTAINER,
				containerIndex: index,
				url: updatedUrl,
				token: parsed.token,
			}
		} catch (error) {
			this.debug(error)
			return null
		}
	}

	async applyContainer(bookmarks: BookmarkNode[], cookieStoreId: string): Promise<void> {
		this.debug('apply', bookmarks, cookieStoreId)
		for (const bookmark of bookmarks) {
			if (bookmark.type === 'separator') continue

			try {
				if (bookmark.type === 'folder') {
					await this.applyContainer(await this.browserApi.bookmarks.getChildren(bookmark.id), cookieStoreId)
				} else {
					await this.updateBookmarkContainerUrl(bookmark, cookieStoreId)
				}
			} catch (error) {
				this.debug(error)
			}
		}
	}

	// --- Menu management ---

	private async rebuildMenuItems(bookmark: Pick<BookmarkNode, 'type' | 'id'> = { type: '', id: '' }): Promise<void> {
		if (this.contextMenuItemsCreated) {
			this.browserApi.menus.removeAll()
			this.contextMenuItemsCreated = false
		}
		await this.createMenuItems(bookmark)
		this.contextMenuItemsCreated = true
	}

	private async getSelectedMenuContainerId(bookmark: Pick<BookmarkNode, 'type' | 'url'>): Promise<string | null> {
		if (bookmark.type !== 'bookmark') return null

		const settings = await this.deps.settings()
		const mappingStore = this.deps.mappingStore(settings)
		await mappingStore.initialize()
		const parsed = parseBookmarkUrl(bookmark.url ?? '')
		if (!parsed || parsed.containerIndex === null) return NO_CONTAINER

		const mapping = mappingStore.getByIndex(parsed.containerIndex)
		if (!mapping) return NO_CONTAINER

		return mapping.cookieStoreId
	}

	async createMenuItems(bookmark: Pick<BookmarkNode, 'type' | 'id' | 'url'> = { type: '', id: '' }): Promise<void> {
		const containerRequest = this.browserApi.contextualIdentities.query({})
		const selectedContainerIdRequest = this.getSelectedMenuContainerId(bookmark)
		const mainMessage = [
			'Assign',
			bookmark.type === 'folder'
				? `Bookmarks in ${bookmark.id === 'toolbar_____' ? 'Toolbar' : 'Folder'}`
				: 'Bookmark',
			'to container'
		]

		this.browserApi.menus.create({
			id: this.menuRootId,
			title: mainMessage.join(' '),
			contexts: ['bookmark']
		})

		this.browserApi.menus.create({
			id: NO_CONTAINER,
			title: 'No Container',
			contexts: ['bookmark'],
			parentId: this.menuRootId,
			...(bookmark.type === 'bookmark' && (await selectedContainerIdRequest) === NO_CONTAINER ? { type: 'radio', checked: true } : {})
		})

		if (this._tempContainersExtensionId) {
			this.browserApi.menus.create({
				id: TEMP_CONTAINER_SENTINEL,
				title: 'Temporary Container',
				contexts: ['bookmark'],
				parentId: this.menuRootId,
				...(bookmark.type === 'bookmark' && (await selectedContainerIdRequest) === TEMP_CONTAINER_SENTINEL
					? { type: 'radio', checked: true }
					: { icons: { 48: 'icons/temp-container.svg' } })
			})
		}

		this.browserApi.menus.create({
			type: 'separator',
			contexts: ['bookmark'],
			parentId: this.menuRootId
		})

		const containers = await containerRequest

		if (this._tempContainersExtensionId) {
			let i = 0
			while (i < containers.length) {
				const isTemp = await this.isTempContainer(containers[i]!.cookieStoreId)
				if (isTemp) {
					containers.splice(i, 1)
				} else {
					i++
				}
			}
		}

		const namesSeen: string[] = []
		for (const container of containers) {
			let menuTitle = container.name
			if (!namesSeen.includes(container.name)) {
				namesSeen.push(container.name)
			} else {
				menuTitle = `${container.name} (${container.cookieStoreId})`
			}

			this.browserApi.menus.create({
				id: container.cookieStoreId,
				title: menuTitle,
				contexts: ['bookmark'],
				parentId: this.menuRootId,
				...(bookmark.type === 'bookmark' && (await selectedContainerIdRequest) === container.cookieStoreId
					? { type: 'radio', checked: true }
					: { icons: { 16: `icons/${container.icon}.svg#${container.color}` } })
			})
		}

		this.browserApi.menus.refresh()
	}

	// --- Event handlers ---

	readonly handleMenuClick = async (info: MenusOnClickInfo): Promise<void> => {
		this.pendingEditBookmark = null
		this.cancelHotswapTimer(info.bookmarkId)
		this.hotswapRecords.delete(info.bookmarkId)

		const bookmark = await this.browserApi.bookmarks.get(info.bookmarkId)
		this.debug(bookmark)
		await this.applyContainer(bookmark, info.menuItemId)
	}

	readonly handleMenuShown = async (info: MenusOnShownInfo): Promise<void> => {
		this.pendingEditBookmark = null
		// Clear the previous hotswap tab snapshot — a new menu interaction starts fresh.
		// The snapshot is set in handleMenuHidden and persists until the next handleMenuShown,
		// giving the async redirect chain time to consume it even after the revert timer fires.
		this._preHotswapTabIds = null

		try {
			if (info.contexts.includes('bookmark') && info.bookmarkId) {
				const bookmark = (await this.browserApi.bookmarks.get(info.bookmarkId))[0]
				if (bookmark?.type === 'separator') {
					this.browserApi.menus.refresh()
					return
				}

				if (bookmark) {
					await this.rebuildMenuItems(bookmark)

					if (bookmark.type === 'bookmark' && bookmark.url && isFragmentEncodedUrl(bookmark.url)) {
						const parsed = parseBookmarkUrl(bookmark.url)
						if (parsed && parsed.containerIndex !== null) {
							this.hotswapRecords.set(bookmark.id, {
								encodedUrl: bookmark.url,
								containerIndex: parsed.containerIndex
							})
							this.pendingEditBookmark = { id: bookmark.id, containerIndex: parsed.containerIndex }
							await this.persistHotswapRecords()

							const realUrl = decodeToRealUrl(bookmark.url)

							this._hotswapRedirectMap.set(realUrl, {
								containerIndex: parsed.containerIndex,
								bookmarkId: bookmark.id
							})
							this.debug('handleMenuShown: registered pendingHotswapUrl', realUrl, '→ container', parsed.containerIndex)

							this.selfUpdateBookmarkIds.add(bookmark.id)
							await this.browserApi.bookmarks.update(bookmark.id, { url: realUrl })
						}
					}
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
		const allTabs = await this.browserApi.tabs.query({})
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
					bookmarkId
				})
			}

			const timer = setTimeout(async () => {
				await this.revertHotswap(bookmarkId, record)
				this._hotswapRedirectMap.delete(decodedUrl)
			}, HOTSWAP_REVERT_DELAY_MS)
			this.hotswapRevertTimers.set(bookmarkId, timer)
		}
	}

	readonly handleBookmarkChanged = async (id: string, changeInfo: { url?: string; title?: string }): Promise<void> => {
		if (this.selfUpdateBookmarkIds.has(id)) {
			this.selfUpdateBookmarkIds.delete(id)
			return
		}

		if (!changeInfo.url) return

		const record = this.hotswapRecords.get(id)
		if (record) {
			try {
				this.cancelHotswapTimer(id)

				const newEncodedUrl = getNewUrl({ seed: this.deps.randomValue }, record.containerIndex, changeInfo.url)
				this.selfUpdateBookmarkIds.add(id)
				await this.browserApi.bookmarks.update(id, { url: newEncodedUrl })

                // persist AFTER update to ensure near-ATOMIC operation safety
				this.hotswapRecords.delete(id)
				await this.persistHotswapRecords()
			} catch (error) {
				this.debug(error)
			}
			return
		}

		if (this.pendingEditBookmark && this.pendingEditBookmark.id === id) {
			const { containerIndex } = this.pendingEditBookmark
			this.pendingEditBookmark = null

			try {
				const newEncodedUrl = getNewUrl({ seed: this.deps.randomValue }, containerIndex, changeInfo.url)
				this.selfUpdateBookmarkIds.add(id)
				await this.browserApi.bookmarks.update(id, { url: newEncodedUrl })
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

			const matches = await this.browserApi.bookmarks.search(bookmark.url)
			const duplicates = matches.filter(b => b.type === 'bookmark' && b.url === bookmark.url && b.id !== id)
			if (duplicates.length > 0) return

			const cleanUrl = decodeToRealUrl(bookmark.url)
			this.selfUpdateBookmarkIds.add(id)
			await this.browserApi.bookmarks.update(id, { url: cleanUrl })
			this.debug('stripped orphaned encoding from new bookmark', id, bookmark.url, '→', cleanUrl)
		} catch (error) {
			this.debug(error)
		}
	}
}
