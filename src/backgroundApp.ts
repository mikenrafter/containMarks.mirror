export const ENABLE_DEBUG_DEFAULT = false
export const NO_CONTAINER = 'firefox-default'
export const HOTSWAP_STORAGE_KEY = 'containMarks.hotswaps'
/** How long to wait before reverting a hotswapped bookmark if no user edit is detected. */
const HOTSWAP_REVERT_DELAY_MS = 1_000

import type {
	BlockingResponse,
	BookmarkNode,
	BookmarkReference,
	BrowserApi,
	ContainerMappingRecord,
	ContainMarksSettings,
	ContextualIdentity,
	LoggerLike,
	MenusOnClickInfo,
	MenusOnShownInfo,
	StorageLike,
	Tab,
	TabChangeInfo,
	WebNavigationBeforeNavigateDetails,
	WebRequestBeforeRequestDetails
} from './models'
import { ContainerMappingStore } from './containerMappingStore'
import {
	DELIMITER,
	FRAGMENT_PREFIX,
	PREFIX,
	decodeToRealUrl,
	getNewUrl,
	isFragmentEncodedUrl,
	isLegacyEncodedUrl,
	isPrefixedUrl,
	listStorageKeys,
	parseBookmarkUrl,
	readLegacyReference,
} from './containerMappings'
import { loadSettings, saveSettings } from './settings'

export { DELIMITER, FRAGMENT_PREFIX, PREFIX, getNewUrl, isFragmentEncodedUrl, isLegacyEncodedUrl, isPrefixedUrl, parseBookmarkUrl } from './containerMappings'

interface HotswapRecord {
	encodedUrl: string
	containerIndex: number
}

interface PendingInterception {
	containerIndex: number
	realUrl: string
	encodedUrl: string
}

/**
 * Coordinates extension runtime flows for menus, tab interception, migration, and quick bookmarking.
 *
 * Design note: this class owns event wiring, while mapping persistence remains delegated to
 * `ContainerMappingStore` and URL encoding rules remain delegated to `containerMappings`.
 *
 * Interception strategy: `webNavigation.onBeforeNavigate` detects fragment-encoded URLs (has
 * access to the fragment) and flags the tab. `webRequest.onBeforeRequest` then cancels the
 * HTTP request synchronously before any network activity. The tab is redirected to the correct
 * container asynchronously after cancellation.
 *
 * Hotswap: when the user right-clicks a bookmark, the fragment encoding is temporarily removed
 * so the native Properties dialog shows the clean URL. The encoding is restored after a timeout
 * or when the user saves edits. Crash-safe via storage persistence.
 */
export class BackgroundApp {
	public enableDebug = ENABLE_DEBUG_DEFAULT
	private contextMenuItemsCreated = false
	private readonly menuRootId = 'assign_container'
	private get settings(): Promise<ContainMarksSettings> {
		return loadSettings(this.browserApi)
	}
	private readonly syncMappingStore: ContainerMappingStore
	private readonly localMappingStore: ContainerMappingStore

	/**
	 * Set in onBeforeNavigate (synchronous, has fragment), read in onBeforeRequest (synchronous
	 * blocking cancel). Entries are short-lived — removed immediately when the request is cancelled.
	 */
	private readonly pendingInterceptions = new Map<number, PendingInterception>()

	/**
	 * Bookmarks that are currently decoded for the Properties dialog. Persisted to storage
	 * so that a crash during hotswap doesn't permanently lose the encoding.
	 */
	private readonly hotswapRecords = new Map<string, HotswapRecord>()

	/** Bookmark IDs whose next onChanged event is a self-update (decode or revert) to ignore. */
	private readonly selfUpdateBookmarkIds = new Set<string>()

	private readonly hotswapRevertTimers = new Map<string, ReturnType<typeof setTimeout>>()

	public constructor(
		private readonly browserApi: BrowserApi,
		private readonly storage: StorageLike,
		private readonly logger: LoggerLike = console,
		private readonly randomValue: () => number = Math.random
	) {
		this.syncMappingStore = new ContainerMappingStore(this.browserApi, this.logger, { enableBookmarkSync: true })
		this.localMappingStore = new ContainerMappingStore(this.browserApi, this.logger, { enableBookmarkSync: false })
	}

	public debug(...args: unknown[]): void {
		if (this.enableDebug) {
			this.logger.log(...args)
		}
	}



	public initialize(): void {
		const realDebug = this.enableDebug
		this.enableDebug = false
		void this.startup().finally(() => {
			this.enableDebug = realDebug
		})

		void this.rebuildMenuItems()
		this.registerListeners()
	}

	public async startup(): Promise<void> {
		const settings = await this.settings
		const mappingStore = this.getMappingStore(settings)
		await mappingStore.initialize()

		// Auto-revert the one-session bypass — always reset on startup
		if (settings.allowEncodedBookmarkImport) {
			await saveSettings(this.browserApi, { ...settings, allowEncodedBookmarkImport: false })
		}

		await this.recoverPendingHotswaps()
		await this.migrateLegacyStorage(mappingStore)
		await this.migrateAboutBookmarks(mappingStore)
		await this.syncPageActionVisibilityForAllTabs(settings)

		if (settings.resetTokensOnStartup) {
			await this.refreshTokensOnStartup(mappingStore)
		}
	}

	private async migrateLegacyStorage(mappingStore: ContainerMappingStore): Promise<void> {
		for (const key of listStorageKeys(this.storage)) {
			const reference = readLegacyReference(this.storage, key)
			if (!reference || !reference?.backupName) continue;
			this.storage.removeItem(key)

			const identity = await this.getContainer({ backupName: reference.backupName })
			if (!identity) continue;
			const mapping = await mappingStore.ensureMappingForContainer(identity)
			if (!mapping) continue;

			try {
				const bookmark = (await this.browserApi.bookmarks.get(reference.bookmarkId))[0]
				if (!bookmark?.id) {
					continue
				}

				const parsed = parseBookmarkUrl(bookmark)
				if (!parsed || !parsed.token || parsed.containerIndex !== null) {
					continue
				}

				const migratedUrl = getNewUrl({ value: parsed.token }, mapping.firstSeenIndex, parsed.url)
				if (bookmark.url !== migratedUrl) {
					await this.browserApi.bookmarks.update(bookmark.id, { url: migratedUrl })
				}
			} catch (error) {
				this.debug(error)
			}
		}
	}

	/**
	 * Converts legacy `about:token:idx:url` bookmarks to the fragment-based scheme.
	 * Only touches bookmarks that match the old encoding — mapping bookmark URLs
	 * (short numeric "tokens") are excluded by isPrefixedUrl's token-length check.
	 */
	private async migrateAboutBookmarks(mappingStore: ContainerMappingStore): Promise<void> {
		const bookmarks = await this.browserApi.bookmarks.search({ query: `${PREFIX}${DELIMITER}` })
		for (const bookmark of bookmarks) {
			if (bookmark.type !== 'bookmark' || typeof bookmark.url !== 'string') continue
			if (!isLegacyEncodedUrl(bookmark.url)) continue

			const parsed = parseBookmarkUrl(bookmark)
			if (!parsed || !parsed.token || parsed.containerIndex === null) continue

			const mapping = mappingStore.getByIndex(parsed.containerIndex)
			if (!mapping) continue

			const newUrl = getNewUrl({ value: parsed.token }, parsed.containerIndex, parsed.url)
			if (bookmark.url !== newUrl) {
				await this.browserApi.bookmarks.update(bookmark.id, { url: newUrl })
			}
		}
	}

	private async refreshTokensOnStartup(mappingStore: ContainerMappingStore): Promise<void> {
		const legacyBookmarks = await this.browserApi.bookmarks.search({ query: `${PREFIX}${DELIMITER}` })
		const fragmentBookmarks = await this.browserApi.bookmarks.search({ query: `#${FRAGMENT_PREFIX}${DELIMITER}` })

		const seen = new Set<string>()
		const allBookmarks = [...legacyBookmarks, ...fragmentBookmarks].filter(bookmark => {
			if (seen.has(bookmark.id)) return false
			seen.add(bookmark.id)
			return true
		})

		for (const bookmark of allBookmarks) {
			const parsed = parseBookmarkUrl(bookmark)
			if (!parsed || !parsed.token || parsed.containerIndex === null) {
				continue
			}
			const mapping = mappingStore.getByIndex(parsed.containerIndex)
			if (!mapping) {
				continue
			}
			await this.ensureBookmarkContainerUrl(bookmark)
		}
	}

	// --- Hotswap crash recovery ---

	private async persistHotswapRecords(): Promise<void> {
		const records: Record<string, HotswapRecord> = {}
		for (const [id, record] of this.hotswapRecords) {
			records[id] = record
		}
		await this.browserApi.storage.local.set({ [HOTSWAP_STORAGE_KEY]: records })
	}

	/**
	 * On startup, re-encodes any bookmarks that were left decoded by a crash during hotswap.
	 * Uses a fresh token since the old token was part of the now-stale encoded URL.
	 */
	private async recoverPendingHotswaps(): Promise<void> {
		const payload = await this.browserApi.storage.local.get(HOTSWAP_STORAGE_KEY)
		const records = payload[HOTSWAP_STORAGE_KEY]
		if (!records || typeof records !== 'object') return

		for (const [bookmarkId, record] of Object.entries(records as Record<string, HotswapRecord>)) {
			if (!record?.encodedUrl || typeof record.containerIndex !== 'number') continue

			try {
				const bookmarks = await this.browserApi.bookmarks.get(bookmarkId)
				const bookmark = bookmarks[0]
				if (!bookmark?.url) continue

				// Only re-encode if still decoded (not already fragment-encoded)
				if (!isFragmentEncodedUrl(bookmark.url)) {
					const newUrl = getNewUrl({ seed: this.randomValue }, record.containerIndex, bookmark.url)
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

	// --- Core helpers ---

	private getMappingStore(settings: ContainMarksSettings): ContainerMappingStore {
		return settings.enableBookmarkSync ? this.syncMappingStore : this.localMappingStore
	}

	private async syncPageActionVisibilityForAllTabs(settings: ContainMarksSettings): Promise<void> {
		const tabs = await this.browserApi.tabs.query({})
		for (const tab of tabs) {
			if (tab.id !== undefined) {
				await this.syncPageActionVisibilityForTab(tab.id, settings)
			}
		}
	}

	private async syncPageActionVisibilityForTab(tabId: number, settings?: ContainMarksSettings): Promise<void> {
		const activeSettings = settings ?? await this.settings
		this.debug('pageAction visibility', { tabId, showPageActionButton: activeSettings.showPageActionButton })
		if (activeSettings.showPageActionButton) {
			await this.browserApi.pageAction.show(tabId)
			return
		}

		await this.browserApi.pageAction.hide(tabId)
	}

	private async rebuildMenuItems(bookmark: Pick<BookmarkNode, 'type' | 'id'> = { type: '', id: '' }): Promise<void> {
		if (this.contextMenuItemsCreated) {
			this.browserApi.menus.removeAll()
			this.contextMenuItemsCreated = false
		}

		await this.createMenuItems(bookmark)
		this.contextMenuItemsCreated = true
	}

	private async getSelectedMenuContainerId(bookmark: Pick<BookmarkNode, 'type' | 'url'>): Promise<string | null> {
		if (bookmark.type !== 'bookmark') {
			return null
		}

		const settings = await this.settings
		const mappingStore = this.getMappingStore(settings)
		await mappingStore.initialize()
		const parsed = parseBookmarkUrl(bookmark.url ?? '')
		if (!parsed || parsed.containerIndex === null) {
			return NO_CONTAINER
		}

		const mapping = mappingStore.getByIndex(parsed.containerIndex)
		if (!mapping) {
			return NO_CONTAINER
		}

		return mapping.cookieStoreId
	}

	public async createMenuItems(bookmark: Pick<BookmarkNode, 'type' | 'id' | 'url'> = { type: '', id: '' }): Promise<void> {
		// handle things asynchronously for speed
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

		this.browserApi.menus.create({
			type: 'separator',
			contexts: ['bookmark'],
			parentId: this.menuRootId
		})

		const containers = await containerRequest
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

	public async getContainer(query: {cookieStoreId?: string | null, backupName?: string | null}): Promise<ContextualIdentity | null> {
		const { cookieStoreId, backupName } = query
		this.debug('getContainer', backupName, cookieStoreId)
		if (!cookieStoreId && !backupName) return null;
		if (cookieStoreId === NO_CONTAINER) return null;

		const containers: (ContextualIdentity | null)[] = []
		if (backupName) containers.unshift(...await this.browserApi.contextualIdentities.query({ name: backupName }))
		if (cookieStoreId) {
			try {
				containers.unshift(await this.browserApi.contextualIdentities.get(cookieStoreId))
			} catch {
				this.debug('container id not found', cookieStoreId)
			}
		}

		return containers.filter(x => x).at(0) ?? null as ContextualIdentity | null;
	}

	/**
	 * Ensures a bookmark's URL encodes its container assignment with a fresh token.
	 *
	 * When `cookieStoreId` is provided, the bookmark is assigned to that container.
	 * When omitted, the existing container mapping is resolved from the bookmark's
	 * embedded index and only the token is regenerated.
	 *
	 * Failure modes:
	 * - Returns `null` when the bookmark has no id, has an invalid URL shape, or mapping resolution fails.
	 * - Does not mutate the bookmark when refreshing an encoded bookmark with a missing mapping.
	 * 
	 */
	public async ensureBookmarkContainerUrl(bookmark: BookmarkNode, cookieStoreId: string | null = null): Promise<BookmarkReference | null> {
		if (!bookmark.id) {
			return null
		}

		const settings = await this.settings
		const mappingStore = this.getMappingStore(settings)

		const parsed = parseBookmarkUrl(bookmark.url ?? '')
		if (!parsed) return null;
		this.debug('assign:', bookmark, cookieStoreId, parsed);
		try {
			let mapping: ContainerMappingRecord | null = null
			let updatedUrl = bookmark.url ?? parsed.url

			if (cookieStoreId === NO_CONTAINER) {
				updatedUrl = parsed.url
			} else if (cookieStoreId) {
				const container = await this.getContainer({ cookieStoreId })
				if (!container) {
					return null
				}
				mapping = await mappingStore.ensureMappingForContainer(container)
			} else {
				mapping = mappingStore.getByIndex(parsed.containerIndex)
			}
			const index = mapping?.firstSeenIndex ?? null

			if (mapping && index !== null) {
				updatedUrl = getNewUrl({ seed: this.randomValue }, index, parsed.url)
				this.debug('refresh:', bookmark, updatedUrl)
			} else if (cookieStoreId === null) {
				return null
			}

			if (bookmark.url !== updatedUrl) {
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
			this.debug(error);
			return null;
		}
	}

	public async applyContainer(bookmarks: BookmarkNode[], cookieStoreId: string): Promise<void> {
		this.debug('apply', bookmarks, cookieStoreId)
		for (const bookmark of bookmarks) {
			if (bookmark.type === 'separator') {
				continue
			}

			try {
				if (bookmark.type === 'folder') {
					await this.applyContainer(await this.browserApi.bookmarks.getChildren(bookmark.id), cookieStoreId)
				} else {
					await this.ensureBookmarkContainerUrl(bookmark, cookieStoreId);
				}
			} catch (error) {
				this.debug(error)
			}
		}
	}

	public async openInContainer(cookieStoreId: string, url: string, tab: Tab): Promise<void> {
		this.debug('open', cookieStoreId, url, tab);
		try {
			const container = await this.getContainer({ cookieStoreId: cookieStoreId });
			if (container === null || tab.id === undefined) {
				return;
			}

			await this.browserApi.tabs.create({
				cookieStoreId: container.cookieStoreId,
				url: url,
				index: tab.index + 1
			});
			await this.browserApi.tabs.remove(tab.id);
		} catch (error) {
			this.debug(error);
		}
	}

	// --- Request interception (fragment-encoded bookmark navigation) ---

	/**
	 * MUST be fully synchronous — no awaits. Populates `pendingInterceptions` so that the
	 * subsequent `onBeforeRequest` handler can cancel the HTTP request before any network activity.
	 *
	 * Only processes top-level frame navigations (`frameId === 0`).
	 */
	public readonly handleBeforeNavigate = (details: WebNavigationBeforeNavigateDetails): void => {
		if (details.frameId !== 0) return
		if (!isFragmentEncodedUrl(details.url)) return

		const parsed = parseBookmarkUrl(details.url)
		if (!parsed || parsed.containerIndex === null) return

		this.pendingInterceptions.set(details.tabId, {
			containerIndex: parsed.containerIndex,
			realUrl: parsed.url,
			encodedUrl: details.url
		})
	}

	/**
	 * Synchronous blocking handler — returns `{ cancel: true }` immediately when the tab was
	 * flagged by `handleBeforeNavigate`. The async container-open work is fire-and-forget so
	 * the cancel response is not delayed.
	 *
	 * Only intercepts `main_frame` requests (iframes and XHR are never touched).
	 */
	public readonly handleBeforeRequest = (details: WebRequestBeforeRequestDetails): BlockingResponse | void => {
		if (details.type !== 'main_frame') return

		const interception = this.pendingInterceptions.get(details.tabId)
		if (!interception) return

		this.pendingInterceptions.delete(details.tabId)
		void this.executeInterception(details.tabId, interception)

		return { cancel: true }
	}

	private async executeInterception(tabId: number, interception: PendingInterception): Promise<void> {
		try {
			const settings = await this.settings
			const mappingStore = this.getMappingStore(settings)
			await mappingStore.initialize()

			const mapping = mappingStore.getByIndex(interception.containerIndex)
			if (!mapping) {
				this.debug('missing mapping for interception', interception.containerIndex)
				return
			}

			const tab = await this.browserApi.tabs.get(tabId)

			await this.browserApi.tabs.create({
				cookieStoreId: mapping.cookieStoreId,
				url: interception.realUrl,
				index: tab.index + 1
			})
			await this.browserApi.tabs.remove(tabId)

			if (settings.regenerateTokenOnEveryUse) {
				const bookmarks = await this.browserApi.bookmarks.search(interception.encodedUrl)
				const bookmark = bookmarks.find(b => b.type === 'bookmark' && b.url === interception.encodedUrl)
				if (bookmark) {
					await this.ensureBookmarkContainerUrl(bookmark)
				}
			}
		} catch (error) {
			this.debug(error)
		}
	}

	// --- Menu event handlers ---

	public readonly handleMenuClick = async (info: MenusOnClickInfo): Promise<void> => {
		const bookmark = await this.browserApi.bookmarks.get(info.bookmarkId);
		this.debug(bookmark);
		await this.applyContainer(bookmark, info.menuItemId);
	}

	/**
	 * Rebuilds context-menu radio items to reflect the bookmark's container assignment, then
	 * hotswaps the bookmark URL so the native Properties dialog shows the clean (decoded) URL.
	 */
	public readonly handleMenuShown = async (info: MenusOnShownInfo): Promise<void> => {
		try {
			if (info.contexts.includes('bookmark') && info.bookmarkId) {
				const bookmark = (await this.browserApi.bookmarks.get(info.bookmarkId))[0]
				if (bookmark?.type === 'separator') {
					this.browserApi.menus.refresh()
					return
				}

				if (bookmark) {
					// Build menu with the ORIGINAL encoded URL so radio state is correct
					await this.rebuildMenuItems(bookmark)

					// Hotswap: temporarily decode so Properties dialog shows the clean URL
					if (bookmark.type === 'bookmark' && bookmark.url && isFragmentEncodedUrl(bookmark.url)) {
						const parsed = parseBookmarkUrl(bookmark.url)
						if (parsed && parsed.containerIndex !== null) {
							this.hotswapRecords.set(bookmark.id, {
								encodedUrl: bookmark.url,
								containerIndex: parsed.containerIndex
							})
							await this.persistHotswapRecords()

							const realUrl = decodeToRealUrl(bookmark.url)
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

	/**
	 * Starts revert timers for all currently-hotswapped bookmarks. If no user edit arrives
	 * via `handleBookmarkChanged` before the timer fires, the encoding is restored.
	 */
	public readonly handleMenuHidden = async (): Promise<void> => {
		for (const [bookmarkId, record] of this.hotswapRecords) {
			if (this.hotswapRevertTimers.has(bookmarkId)) continue

			const timer = setTimeout(() => {
				void this.revertHotswap(bookmarkId, record)
			}, HOTSWAP_REVERT_DELAY_MS)
			this.hotswapRevertTimers.set(bookmarkId, timer)
		}
	}

	/**
	 * Detects user edits to hotswapped bookmarks. Self-updates (from our own decode/revert)
	 * are filtered via `selfUpdateBookmarkIds`. Real user edits trigger re-encoding with the
	 * same container assignment and a fresh token.
	 */
	public readonly handleBookmarkChanged = async (id: string, changeInfo: { url?: string; title?: string }): Promise<void> => {
		if (this.selfUpdateBookmarkIds.has(id)) {
			this.selfUpdateBookmarkIds.delete(id)
			return
		}

		const record = this.hotswapRecords.get(id)
		if (!record || !changeInfo.url) return

		try {
			this.cancelHotswapTimer(id)
			this.hotswapRecords.delete(id)
			await this.persistHotswapRecords()

			// Re-encode the (possibly edited) URL with the same container
			const newEncodedUrl = getNewUrl({ seed: this.randomValue }, record.containerIndex, changeInfo.url)
			this.selfUpdateBookmarkIds.add(id)
			await this.browserApi.bookmarks.update(id, { url: newEncodedUrl })
		} catch (error) {
			this.debug(error)
		}
	}

	/**
	 * Strips `#cm:` encoding from newly-created bookmarks that aren't duplicates of existing
	 * encoded bookmarks. This prevents a malicious page or shared link from injecting a
	 * container assignment into a URL the user bookmarks.
	 *
	 * When `allowEncodedBookmarkImport` is enabled (under "I understand the risks"), this
	 * check is bypassed — useful during bulk import/transfer. That setting auto-reverts
	 * to `false` on every extension startup.
	 *
	 * Duplicates (multiple bookmarks sharing the same encoded URL) are left intact because
	 * they indicate the user copied an existing legit container-assigned bookmark.
	 */
	public readonly handleBookmarkCreated = async (id: string, bookmark: BookmarkNode): Promise<void> => {
		if (bookmark.type !== 'bookmark' || !bookmark.url || !isFragmentEncodedUrl(bookmark.url)) {
			return
		}

		try {
			const settings = await this.settings
			if (settings.allowEncodedBookmarkImport) {
				return
			}

			// Check if another bookmark already has this exact encoded URL (duplicate/copy)
			const matches = await this.browserApi.bookmarks.search(bookmark.url)
			const duplicates = matches.filter(b => b.type === 'bookmark' && b.url === bookmark.url && b.id !== id)
			if (duplicates.length > 0) {
				return
			}

			// No duplicates — this is a freshly-bookmarked URL with embedded encoding. Strip it.
			const cleanUrl = decodeToRealUrl(bookmark.url)
			this.selfUpdateBookmarkIds.add(id)
			await this.browserApi.bookmarks.update(id, { url: cleanUrl })
			this.debug('stripped orphaned encoding from new bookmark', id, bookmark.url, '→', cleanUrl)
		} catch (error) {
			this.debug(error)
		}
	}

	// --- Tab event handlers ---

	/**
	 * Fallback interception path for cases where `onBeforeRequest` didn't fire — e.g. same-page
	 * fragment navigations where no HTTP request is made. Also handles legacy `about:` encoded
	 * bookmarks that aren't intercepted by the webRequest pipeline.
	 */
	public readonly handleTabUpdated = async (id: number, change: TabChangeInfo, tab: Tab): Promise<void> => {
		if (change.status === 'complete' && id !== this.browserApi.tabs.TAB_ID_NONE) {
			await this.syncPageActionVisibilityForTab(id)
		}

		const currentUrl = tab.url ?? change.url ?? ''
		if (id === this.browserApi.tabs.TAB_ID_NONE || !isPrefixedUrl(currentUrl)) {
			return
		}

		// Fragment URLs: trigger on URL change (handles same-page navigation where no request fires)
		// Legacy about: URLs: trigger only on status complete (original behavior)
		const isFragment = isFragmentEncodedUrl(currentUrl)
		if (isFragment && !change.url) return
		if (!isFragment && change.status !== 'complete') return

		const settings = await this.settings;
		const mappingStore = this.getMappingStore(settings)
		await mappingStore.initialize()
		const bookmarks = await this.browserApi.bookmarks.search(currentUrl);
		const bookmark = bookmarks.find((item) => item.type === 'bookmark' && item.url === currentUrl);
		if (!bookmark?.id) {
			return;
		}

		const parsed = parseBookmarkUrl(bookmark)
		if (!parsed || !parsed.token || parsed.containerIndex === null) {
			return
		}

		const mapping = mappingStore.getByIndex(parsed.containerIndex)
		if (!mapping) {
			this.debug('missing mapping for bookmark', bookmark.id, parsed.containerIndex)
			return
		}

		await this.openInContainer(mapping.cookieStoreId, parsed.url, tab);

		if (settings.regenerateTokenOnEveryUse) {
			await this.ensureBookmarkContainerUrl(bookmark);
		}
	}

	public readonly handleTabActivated = async (activeInfo: { tabId: number }): Promise<void> => {
		try {
			if (activeInfo.tabId !== this.browserApi.tabs.TAB_ID_NONE) {
				await this.syncPageActionVisibilityForTab(activeInfo.tabId)
			}
		} catch (error) {
			this.debug(error)
		}
	}

	/**
	 * Creates a new bookmark for the current tab and optionally assigns it to a container.
	 *
	 * Acts as a quicker alternative to the standard browser favorite button —
	 * when the tab has a container, the bookmark is automatically container-mapped.
	 * When no container is present, a plain bookmark is created instead.
	 */
	public readonly handlePageActionClicked = async (tab: Tab): Promise<void> => {
		try {
			if (!tab.url) {
				return
			}

			const settings = await this.settings
			if (!settings.showPageActionButton) {
				if (tab.id !== undefined) {
					await this.syncPageActionVisibilityForTab(tab.id)
				}
				return
			}
			const mappingStore = this.getMappingStore(settings)

			let assignedCookieStoreId: string | null = null
			let containerLabel = 'No Container'
			const container = await this.getContainer({ cookieStoreId: tab.cookieStoreId ?? null })
			if (container) {
				await mappingStore.ensureMappingForContainer(container)
				assignedCookieStoreId = container.cookieStoreId
				containerLabel = container.name
			}

			const MAX_NOTIFICATION_TITLE_LENGTH = 10
			const title = (tab.title ?? '').slice(0, MAX_NOTIFICATION_TITLE_LENGTH)
			const bookmark = await this.browserApi.bookmarks.create({
				parentId: settings.targetFolderId,
				index: 0,
				title: title,
				url: tab.url
			})

			if (assignedCookieStoreId !== null) {
				const assigned = await this.ensureBookmarkContainerUrl(bookmark, assignedCookieStoreId)
				this.debug(assigned)
			}

			await this.browserApi.notifications.create({
				type: 'basic',
				title: 'Bookmark Created',
				message: `${title} in ${containerLabel}\n(1st item on your bookmarks bar)`
			})
		} catch (error) {
			this.debug(error)
		}
	}

	private registerListeners(): void {
		this.browserApi.menus.onClicked.addListener(this.handleMenuClick)
		this.browserApi.menus.onShown.addListener(this.handleMenuShown)
		this.browserApi.menus.onHidden.addListener(this.handleMenuHidden)
		this.browserApi.tabs.onUpdated.addListener(this.handleTabUpdated)
		this.browserApi.tabs.onActivated.addListener(this.handleTabActivated)
		this.browserApi.pageAction.onClicked.addListener(this.handlePageActionClicked)
		this.browserApi.bookmarks.onChanged.addListener(this.handleBookmarkChanged)
		this.browserApi.bookmarks.onCreated.addListener(this.handleBookmarkCreated)
		this.browserApi.webNavigation.onBeforeNavigate.addListener(this.handleBeforeNavigate)
		this.browserApi.webRequest.onBeforeRequest.addListener(
			this.handleBeforeRequest,
			{ urls: ['<all_urls>'], types: ['main_frame'] },
			['blocking']
		)
	}
}