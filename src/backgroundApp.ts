export const ENABLE_DEBUG_DEFAULT = false
export const NO_CONTAINER = 'firefox-default'
export const HOTSWAP_STORAGE_KEY = 'containMarks.hotswaps'
/** How long to wait before reverting a hotswapped bookmark if no user edit is detected. */
const HOTSWAP_REVERT_DELAY_MS = 200

/** Sentinel cookieStoreId stored in mappings to indicate "open in a fresh Temporary Container". */
export const TEMP_CONTAINER_SENTINEL = 'temp-container'

/**
 * Gecko extension IDs for both Temporary Containers variants.
 * The original (stoically) is unmaintained but still widely installed.
 * TC+ (GodKratos) is the actively-maintained fork with identical API.
 */
export const TEMP_CONTAINERS_EXTENSION_IDS = [
	'{c607c8df-14a7-4f28-894f-29e8722976af}',  // Temporary Containers (stoically)
	'{1ea2fa75-677e-4702-b06a-50fc7d06fe7e}',  // Temporary Containers Plus (GodKratos)
] as const

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
	readLegacyStorageKeys,
	readLegacyReference,
	parseBookmarkUrl,
	parseLegacyBookmarkUrl,
} from './urlCodec'
import { loadSettings, saveSettings } from './settings'

export { DELIMITER, FRAGMENT_PREFIX, PREFIX, getNewUrl, isFragmentEncodedUrl, isLegacyEncodedUrl, isPrefixedUrl, parseBookmarkUrl, parseLegacyBookmarkUrl } from './urlCodec'

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
	/** Debug mode is suppressed during `initialize()` to avoid startup noise in the console. */
	public enableDebug = ENABLE_DEBUG_DEFAULT

	/** Prevents duplicate menu registration when context menus are rebuilt on bookmark changes. */
	private contextMenuItemsCreated = false
	private readonly menuRootId = 'assign_container'

	/** Lazily loaded once — avoids re-reading storage on every operation that needs settings. */
	private get settings(): Promise<ContainMarksSettings> {
		return loadSettings(this.browserApi)
	}
	/** Container mappings backed by synced bookmarks — works across devices. */
	private readonly syncMappingStore: ContainerMappingStore
	/** Container mappings backed by local bookmarks — device-specific, faster. */
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

	/** Revert timers keyed by bookmark ID — cancelled if user edits arrive before expiry. */
	private readonly hotswapRevertTimers = new Map<string, ReturnType<typeof setTimeout>>()

	/**
	 * The bookmark from the most recent menu-shown hotswap. Used by `handleBookmarkChanged`
	 * to catch late user edits that arrive after the revert timer fires — e.g. the user opens
	 * Properties, waits, then saves. Cleared on the next `handleMenuShown` call.
	 */
	private pendingEditBookmark: { id: string; containerIndex: number } | null = null

	/**
	 * Decoded URLs of currently-hotswapped bookmarks, mapped to their container assignment.
	 * Populated eagerly in `handleMenuShown` (and redundantly in `handleMenuHidden`); consumed
	 * by `handleBeforeNavigate`, `handleTabCreated`, `handleWindowCreated`, and `handleTabUpdated`
	 * to intercept "Open in New Tab/Window" clicks that launch the decoded URL outside the
	 * assigned container. Cleared when revert timers fire.
	 */
	private readonly hotswapRedirectMap = new Map<string, { containerIndex: number; bookmarkId: string }>()

	/** True when Temporary Containers Plus is installed and enabled — gates the menu item and activation path. */
	/** Whether TC or TC+ is installed — stores the detected extension ID, or null if neither found. */
	private tempContainersExtensionId: string | null = null

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



	/**
	 * Bootstrap entry point — called once at extension load. Suppresses debug logging during
	 * startup to keep the console clean, then re-enables it. Fires startup, menu creation,
	 * and listener registration concurrently since they're independent.
	 */
	public initialize(): void {
		const realDebug = this.enableDebug
		this.enableDebug = false
		void this.startup().finally(() => {
			this.enableDebug = realDebug
		})

		void this.rebuildMenuItems()
		this.registerListeners()
	}

	/**
	 * Checks if either Temporary Containers (stoically) or Temporary Containers Plus (GodKratos)
	 * is installed and enabled. Tries each known extension ID in priority order (original first).
	 * Silently swallows errors because neither may be installed — this is a purely additive feature.
	 */
	private async detectTempContainersExtension(): Promise<void> {
		for (const extensionId of TEMP_CONTAINERS_EXTENSION_IDS) {
			try {
				const extensionInfo = await this.browserApi.management.get(extensionId)
				if (extensionInfo.enabled) {
					this.tempContainersExtensionId = extensionId
					this.debug('Temporary Containers detected:', extensionInfo.name, extensionId)
					return
				}
			} catch {
				// Extension not installed — try next
			}
		}
		this.tempContainersExtensionId = null
		this.debug('No Temporary Containers extension found')
	}

	/**
	 * Ordered startup sequence — must run before any bookmark/tab event handling because it
	 * initializes the mapping store and recovers from crashes. Also auto-reverts the one-session
	 * `allowEncodedBookmarkImport` bypass so it never persists across restarts.
	 */
	public async startup(): Promise<void> {
		const settings = await this.settings
		const mappingStore = this.getMappingStore(settings)
		await mappingStore.initialize()

		// Detect Temporary Containers Plus — gates the "Temporary Container" menu item
		await this.detectTempContainersExtension()

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

	/**
	 * One-time migration from the original `localStorage`-based container mapping to the current
	 * bookmark-based mapping store. Reads and deletes each legacy key, then re-encodes the
	 * bookmark URL with the new mapping index.
	 */
	private async migrateLegacyStorage(mappingStore: ContainerMappingStore): Promise<void> {
		for (const key of readLegacyStorageKeys(this.storage)) {
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

				const parsed = parseLegacyBookmarkUrl(bookmark)
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

			const parsed = parseLegacyBookmarkUrl(bookmark)
			if (!parsed || !parsed.token || parsed.containerIndex === null) continue

			const mapping = mappingStore.getByIndex(parsed.containerIndex)
			if (!mapping) continue

			const newUrl = getNewUrl({ value: parsed.token }, parsed.containerIndex, parsed.url)
			if (bookmark.url !== newUrl) {
				await this.browserApi.bookmarks.update(bookmark.id, { url: newUrl })
			}
		}
	}

	/**
	 * Security feature: regenerates all bookmark tokens on startup when `resetTokensOnStartup`
	 * is enabled. Prevents token-based URL prediction by ensuring tokens change every session.
	 */
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
			const parsed = parseLegacyBookmarkUrl(bookmark)
			if (!parsed || !parsed.token || parsed.containerIndex === null) {
				continue
			}
			const mapping = mappingStore.getByIndex(parsed.containerIndex)
			if (!mapping) {
				continue
			}
			await this.updateBookmarkContainerUrl(bookmark)
		}
	}

	// --- Hotswap crash recovery ---

	/** Persists hotswap state to `storage.local` so crash recovery can restore encoded URLs. */
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

	/** Prevents a stale revert from overwriting a user edit that arrived before the timer fired. */
	private cancelHotswapTimer(bookmarkId: string): void {
		const timer = this.hotswapRevertTimers.get(bookmarkId)
		if (timer) {
			clearTimeout(timer)
			this.hotswapRevertTimers.delete(bookmarkId)
		}
	}

	/**
	 * Restores the original encoded URL after the hotswap window expires without a user edit.
	 * Also cleans up the pendingHotswapUrls entry and persists the updated state.
	 */
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

	/** Routes to sync or local mapping store based on user preference. */
	private getMappingStore(settings: ContainMarksSettings): ContainerMappingStore {
		return settings.enableBookmarkSync ? this.syncMappingStore : this.localMappingStore
	}

	/** Ensures the page-action button reflects the current `showPageActionButton` setting across all tabs. */
	private async syncPageActionVisibilityForAllTabs(settings: ContainMarksSettings): Promise<void> {
		const tabs = await this.browserApi.tabs.query({})
		for (const tab of tabs) {
			if (tab.id !== undefined) {
				await this.syncPageActionVisibilityForTab(tab.id, settings)
			}
		}
	}

	/** Shows or hides the page-action icon for a single tab — called on tab switch and startup. */
	private async syncPageActionVisibilityForTab(tabId: number, settings?: ContainMarksSettings): Promise<void> {
		const activeSettings = settings ?? await this.settings
		this.debug('pageAction visibility', { tabId, showPageActionButton: activeSettings.showPageActionButton })
		if (activeSettings.showPageActionButton) {
			await this.browserApi.pageAction.show(tabId)
			return
		}

		await this.browserApi.pageAction.hide(tabId)
	}

	/** Tears down and recreates all menu items — needed when container assignments change. */
	private async rebuildMenuItems(bookmark: Pick<BookmarkNode, 'type' | 'id'> = { type: '', id: '' }): Promise<void> {
		if (this.contextMenuItemsCreated) {
			this.browserApi.menus.removeAll()
			this.contextMenuItemsCreated = false
		}

		await this.createMenuItems(bookmark)
		this.contextMenuItemsCreated = true
	}

	/** Resolves the currently-assigned container for a bookmark to pre-select the menu radio button. */
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

	/**
	 * Builds the "Assign Bookmark to Container" context menu tree. Fetches containers and the
	 * bookmark's current assignment in parallel for speed. Duplicate container names are
	 * disambiguated with the cookieStoreId suffix.
	 */
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

		// "Temporary Container" option — only shown when TC or TC+ is installed
		if (this.tempContainersExtensionId) {
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

		// When TC/TC+ is installed, filter out ephemeral temp containers — users should use
		// the dedicated "Temporary Container" menu item instead of assigning to a specific one.
		if (this.tempContainersExtensionId) {
			let i = 0
			while (i < containers.length) {
				try {
					const isTemp = await this.browserApi.runtime.sendMessage(
						this.tempContainersExtensionId,
						{ method: 'isTempContainer', cookieStoreId: containers[i]!.cookieStoreId }
					)
					if (isTemp) {
						containers.splice(i, 1)
					} else {
						i++
					}
				} catch {
					i++  // Graceful fallback: assume permanent if API fails
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

	/**
	 * Resolves a container identity by cookieStoreId or backupName. The backupName fallback
	 * enables cross-device sync: when a container ID differs between devices, the human-readable
	 * name can still resolve the correct container.
	 */
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
	public async updateBookmarkContainerUrl(bookmark: BookmarkNode, cookieStoreId: string | null = null): Promise<BookmarkReference | null> {
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
			} else if (cookieStoreId === TEMP_CONTAINER_SENTINEL) {
				// Synthetic identity for "open in fresh Temporary Container via TC API"
				mapping = await mappingStore.ensureMappingForContainer({
					cookieStoreId: TEMP_CONTAINER_SENTINEL,
					name: 'Temporary Container',
					icon: 'circle',
					color: 'toolbar'
				})
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
				// Guard against handleBookmarkChanged treating this self-update as a user edit.
				// Without this, the hotswap late-edit fallback would re-encode with the OLD container.
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
			this.debug(error);
			return null;
		}
	}

	/**
	 * Recursively applies a container assignment to a bookmark or all bookmarks in a folder.
	 * Separators are skipped. Each bookmark gets a fresh token via `updateBookmarkContainerUrl`.
	 */
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
					await this.updateBookmarkContainerUrl(bookmark, cookieStoreId);
				}
			} catch (error) {
				this.debug(error)
			}
		}
	}

	/**
	 * Creates a new tab in the specified container, positioned after the source tab, then closes
	 * the source tab. This is the core redirect mechanism used by all interception paths.
	 */
	public async openInContainer(cookieStoreId: string, url: string, tab: Tab): Promise<void> {
		this.debug('open', cookieStoreId, url, tab);

		// Route to TC+ API when the sentinel is used
		if (cookieStoreId === TEMP_CONTAINER_SENTINEL) {
			await this.openInTempContainer(url, tab)
			return
		}

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
			await this.browserApi.tabs.remove(tab.id!);
		} catch (error) {
			this.debug(error);
		}
	}

	/**
	 * Opens a URL in a fresh Temporary Container via the TC/TC+ runtime API. Falls back to
	 * opening in the default container if no TC extension is available or the API call fails.
	 */
	private async openInTempContainer(url: string, tab: Tab): Promise<void> {
		if (tab.id === undefined) return

		const extensionId = this.tempContainersExtensionId
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

	/**
	 * Async redirect for a tab whose navigation matched a `pendingHotswapUrls` entry. Resolves
	 * the container mapping and reopens the URL in the correct container. Called fire-and-forget
	 * from the synchronous `handleBeforeNavigate`.
	 */
	private async redirectHotswappedTab(tabId: number, url: string, containerIndex: number): Promise<void> {
		try {
			const tab = await this.browserApi.tabs.get(tabId)
			const settings = await this.settings
			const mappingStore = this.getMappingStore(settings)
			await mappingStore.initialize()

			const mapping = mappingStore.getByIndex(containerIndex)
			this.debug('redirectHotswappedTab: mapping', { containerIndex, mapping, tabCookieStoreId: tab.cookieStoreId })
			if (!mapping) return

			if (tab.cookieStoreId === mapping.cookieStoreId) {
				this.debug('redirectHotswappedTab: already in target container, skipping')
				return
			}

			this.debug('redirectHotswappedTab: redirecting tab', tabId, 'to container', mapping.cookieStoreId)
			await this.openInContainer(mapping.cookieStoreId, url, tab)

			// Temporary Containers addons may race our redirect and create an orphaned
			// about:blank tab in the same window. Wait briefly, then close any about:blank
			// tabs in that window that aren't the tab we just created.
			if (tab.windowId) {
				await this.cleanupOrphanedTabs(tab.windowId, mapping.cookieStoreId)
			}
		} catch (error) {
			this.debug('redirectHotswappedTab: error', error)
		}
	}

	/**
	 * After a hotswap redirect, Temporary Containers addons may create an orphaned `about:blank`
	 * tab in the same window as a replacement for the tab we just removed. This method waits
	 * briefly for the orphan to appear, then closes any `about:blank` tabs in the window that
	 * aren't in the target container.
	 */
	private async cleanupOrphanedTabs(windowId: number, targetCookieStoreId: string): Promise<void> {
		// Brief delay to let the Temporary Containers addon create its replacement tab
		await new Promise(resolve => setTimeout(resolve, 150))

		try {
			const tabs = await this.browserApi.tabs.query({ windowId })
			for (const tab of tabs) {
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

	// --- Request interception (fragment-encoded bookmark navigation) ---

	/**
	 * MUST be fully synchronous for the fragment-encoded path — no awaits. Populates
	 * `pendingInterceptions` so that the subsequent `onBeforeRequest` handler can cancel the
	 * HTTP request before any network activity.
	 *
	 * Also handles hotswap interception: when a navigation targets a decoded URL that's in
	 * `pendingHotswapUrls` (from "Open in New Tab/Window" during a hotswap), it fires off an
	 * async redirect. This reliably catches navigations that `tabs.onCreated`/`onUpdated` miss
	 * because they initially see `about:blank`.
	 *
	 * Only processes top-level frame navigations (`frameId === 0`).
	 */
	public readonly handleBeforeNavigate = (details: WebNavigationBeforeNavigateDetails): void => {
		if (details.frameId !== 0) return

		// Hotswap interception — async fire-and-forget redirect for decoded bookmark URLs
		if (this.hotswapRedirectMap.size > 0) {
			const hotswapInfo = this.hotswapRedirectMap.get(details.url)
			if (hotswapInfo) {
				this.debug('handleBeforeNavigate: hotswap match', details.url, '→ container', hotswapInfo.containerIndex)
				this.hotswapRedirectMap.delete(details.url)
				void this.redirectHotswappedTab(details.tabId, details.url, hotswapInfo.containerIndex)
				return
			}
		}

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

		// fire and forget for rapid response
		setTimeout(async () => {
			this.pendingInterceptions.delete(details.tabId)
			void this.executeInterception(details.tabId, interception);
		}, 0);

		return { cancel: true }
	}

	/**
	 * Completes the async portion of the two-phase request interception: resolves the container
	 * mapping from the bookmark's index and opens the real URL in the correct container.
	 */
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

			if (mapping.cookieStoreId === TEMP_CONTAINER_SENTINEL) {
				await this.openInTempContainer(interception.realUrl, tab)
			} else {
				await this.browserApi.tabs.create({
					cookieStoreId: mapping.cookieStoreId,
					url: interception.realUrl,
					index: tab.index + 1
				})
				await this.browserApi.tabs.remove(tabId)
			}

			if (settings.regenerateTokenOnEveryUse) {
				const bookmarks = await this.browserApi.bookmarks.search(interception.encodedUrl)
				const bookmark = bookmarks.find(b => b.type === 'bookmark' && b.url === interception.encodedUrl)
				if (bookmark) {
					await this.updateBookmarkContainerUrl(bookmark)
				}
			}
		} catch (error) {
			this.debug(error)
		}
	}

	// --- Menu event handlers ---

	/** Dispatches the selected container assignment when the user clicks a context menu item. */
	public readonly handleMenuClick = async (info: MenusOnClickInfo): Promise<void> => {
		// Clear the hotswap late-edit fallback — the user is making an explicit assignment,
		// not a late edit via Properties. Without this, handleBookmarkChanged would re-encode
		// the bookmark with the OLD container stored in pendingEditBookmark.
		this.pendingEditBookmark = null

		// Cancel and clean up the hotswap revert timer — the assignment will produce a new
		// encoded URL, so the old encoded URL stored in the revert record is now stale.
		this.cancelHotswapTimer(info.bookmarkId)
		this.hotswapRecords.delete(info.bookmarkId)

		const bookmark = await this.browserApi.bookmarks.get(info.bookmarkId);
		this.debug(bookmark);
		await this.applyContainer(bookmark, info.menuItemId);
	}

	/**
	 * Rebuilds context-menu radio items to reflect the bookmark's container assignment, then
	 * hotswaps the bookmark URL so the native Properties dialog shows the clean (decoded) URL.
	 * Sets `pendingEditBookmarkId` to catch late user edits after the revert timer fires.
	 */
	public readonly handleMenuShown = async (info: MenusOnShownInfo): Promise<void> => {
		// Clear previous pending edit — a new menu open supersedes the old one
		this.pendingEditBookmark = null

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
							this.pendingEditBookmark = { id: bookmark.id, containerIndex: parsed.containerIndex }
							await this.persistHotswapRecords()

							const realUrl = decodeToRealUrl(bookmark.url)

							// Eagerly register the decoded URL so new-tab interception works even
							// if the tab is created before handleMenuHidden fires.
							this.hotswapRedirectMap.set(realUrl, {
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

	/**
	 * Starts revert timers for all currently-hotswapped bookmarks. If no user edit arrives
	 * via `handleBookmarkChanged` before the timer fires, the encoding is restored.
	 *
	 * Also populates `pendingHotswapUrls` so that `handleTabCreated` can intercept "Open in
	 * New Tab" clicks that launch the decoded (clean) URL outside any container.
	 */
	public readonly handleMenuHidden = async (): Promise<void> => {
		for (const [bookmarkId, record] of this.hotswapRecords) {
			if (this.hotswapRevertTimers.has(bookmarkId)) continue

			// Register the decoded URL for new-tab interception
			const decodedUrl = decodeToRealUrl(record.encodedUrl)
			this.hotswapRedirectMap.set(decodedUrl, {
				containerIndex: record.containerIndex,
				bookmarkId
			})

			const timer = setTimeout(() => {
				this.hotswapRedirectMap.delete(decodedUrl)
				void this.revertHotswap(bookmarkId, record)
			}, HOTSWAP_REVERT_DELAY_MS)
			this.hotswapRevertTimers.set(bookmarkId, timer)
		}
	}

	/**
	 * Detects user edits to hotswapped bookmarks. Self-updates (from our own decode/revert)
	 * are filtered via `selfUpdateBookmarkIds`. Real user edits trigger re-encoding with the
	 * same container assignment and a fresh token.
	 *
	 * Falls back to `pendingEditBookmark` for late edits that arrive after the revert timer
	 * has already restored the encoding — e.g. user opens Properties, waits, then saves.
	 */
	public readonly handleBookmarkChanged = async (id: string, changeInfo: { url?: string; title?: string }): Promise<void> => {
		if (this.selfUpdateBookmarkIds.has(id)) {
			this.selfUpdateBookmarkIds.delete(id)
			return
		}

		if (!changeInfo.url) return

		// Primary path: bookmark is still in the hotswap window
		const record = this.hotswapRecords.get(id)
		if (record) {
			try {
				this.cancelHotswapTimer(id)
				this.hotswapRecords.delete(id)
				await this.persistHotswapRecords()

				const newEncodedUrl = getNewUrl({ seed: this.randomValue }, record.containerIndex, changeInfo.url)
				this.selfUpdateBookmarkIds.add(id)
				await this.browserApi.bookmarks.update(id, { url: newEncodedUrl })
			} catch (error) {
				this.debug(error)
			}
			return
		}

		// Fallback: late edit after revert timer already fired
		if (this.pendingEditBookmark && this.pendingEditBookmark.id === id) {
			const { containerIndex } = this.pendingEditBookmark
			this.pendingEditBookmark = null

			try {
				const newEncodedUrl = getNewUrl({ seed: this.randomValue }, containerIndex, changeInfo.url)
				this.selfUpdateBookmarkIds.add(id)
				await this.browserApi.bookmarks.update(id, { url: newEncodedUrl })
			} catch (error) {
				this.debug(error)
			}
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
	 * Intercepts "Open in New Tab" clicks during a hotswap window. When a user right-clicks a
	 * container bookmark and chooses "Open in New Tab", Firefox opens the decoded (clean) URL
	 * outside the correct container because the bookmark was temporarily hotswapped. This handler
	 * compares newly-created tab URLs against `pendingHotswapUrls` and reopens matches in the
	 * correct container.
	 *
	 * Skips tabs that are already in the target container to avoid redundant redirects.
	 * Compatible with Temporary Containers addons that assign non-default cookieStoreIds.
	 */
	public readonly handleTabCreated = async (tab: Tab): Promise<void> => {
		this.debug('handleTabCreated', { url: tab.url, id: tab.id, cookieStoreId: tab.cookieStoreId, pendingCount: this.hotswapRedirectMap.size, pendingUrls: [...this.hotswapRedirectMap.keys()] })
		if (this.hotswapRedirectMap.size === 0) return
		if (!tab.url || !tab.id) {
			this.debug('handleTabCreated: skipped — no url or id', { url: tab.url, id: tab.id })
			return
		}

		const hotswapInfo = this.hotswapRedirectMap.get(tab.url)
		if (!hotswapInfo) {
			this.debug('handleTabCreated: no pending hotswap match for', tab.url)
			return
		}

		try {
			const settings = await this.settings
			const mappingStore = this.getMappingStore(settings)
			await mappingStore.initialize()

			const mapping = mappingStore.getByIndex(hotswapInfo.containerIndex)
			this.debug('handleTabCreated: mapping lookup', { containerIndex: hotswapInfo.containerIndex, mapping, tabCookieStoreId: tab.cookieStoreId })
			if (!mapping) return

			// Already in the correct container — no redirect needed
			if (tab.cookieStoreId === mapping.cookieStoreId) {
				this.debug('handleTabCreated: already in target container, skipping')
				return
			}

			this.debug('handleTabCreated: redirecting tab', tab.id, 'to container', mapping.cookieStoreId)
			this.hotswapRedirectMap.delete(tab.url)
			await this.openInContainer(mapping.cookieStoreId, tab.url, tab)
		} catch (error) {
			this.debug('handleTabCreated: error', error)
		}
	}

	/**
	 * Insurance handler for "Open in New Window" during a hotswap. Firefox's `tabs.onCreated`
	 * and `tabs.onUpdated` may not fire reliably for tabs in newly-created windows. This handler
	 * queries tabs in the new window and checks their URLs against `pendingHotswapUrls`.
	 */
	public readonly handleWindowCreated = async (window: import('./models').Window): Promise<void> => {
		this.debug('handleWindowCreated', { windowId: window.id, pendingCount: this.hotswapRedirectMap.size, pendingUrls: [...this.hotswapRedirectMap.keys()] })
		if (this.hotswapRedirectMap.size === 0) return
		if (!window.id) return

		try {
			const tabs = await this.browserApi.tabs.query({ windowId: window.id })
			this.debug('handleWindowCreated: tabs in window', window.id, tabs.map(t => ({ id: t.id, url: t.url, cookieStoreId: t.cookieStoreId })))

			for (const tab of tabs) {
				const url = tab.url
				if (!url || !tab.id) continue

				const hotswapInfo = this.hotswapRedirectMap.get(url)
				if (!hotswapInfo) {
					this.debug('handleWindowCreated: no pending hotswap match for', url)
					continue
				}

				const settings = await this.settings
				const mappingStore = this.getMappingStore(settings)
				await mappingStore.initialize()

				const mapping = mappingStore.getByIndex(hotswapInfo.containerIndex)
				this.debug('handleWindowCreated: mapping lookup', { containerIndex: hotswapInfo.containerIndex, mapping, tabCookieStoreId: tab.cookieStoreId })
				if (!mapping) continue
				if (tab.cookieStoreId === mapping.cookieStoreId) {
					this.debug('handleWindowCreated: already in target container, skipping')
					continue
				}

				this.debug('handleWindowCreated: redirecting tab', tab.id, 'to container', mapping.cookieStoreId)
				this.hotswapRedirectMap.delete(url)
				await this.openInContainer(mapping.cookieStoreId, url, tab)
			}
		} catch (error) {
			this.debug('handleWindowCreated: error', error)
		}
	}

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

		// Check if this tab navigated to a hotswapped decoded URL ("Open in New Tab" during
		// hotswap). Skips tabs already in the target container. Compatible with Temporary
		// Containers addons that assign non-default cookieStoreIds to new tabs.
		if (currentUrl && this.hotswapRedirectMap.size > 0) {
			this.debug('handleTabUpdated: hotswap check', { tabId: id, currentUrl, cookieStoreId: tab.cookieStoreId, pendingUrls: [...this.hotswapRedirectMap.keys()] })
			const hotswapInfo = this.hotswapRedirectMap.get(currentUrl)
			if (hotswapInfo && tab.id !== undefined) {
				try {
					const settings = await this.settings
					const mappingStore = this.getMappingStore(settings)
					await mappingStore.initialize()
					const mapping = mappingStore.getByIndex(hotswapInfo.containerIndex)
					this.debug('handleTabUpdated: hotswap mapping', { containerIndex: hotswapInfo.containerIndex, mapping, tabCookieStoreId: tab.cookieStoreId })
					if (mapping && tab.cookieStoreId !== mapping.cookieStoreId) {
						this.debug('handleTabUpdated: redirecting tab', id, 'to container', mapping.cookieStoreId)
						this.hotswapRedirectMap.delete(currentUrl)
						await this.openInContainer(mapping.cookieStoreId, currentUrl, tab)
						return
					} else if (mapping) {
						this.debug('handleTabUpdated: already in target container, skipping')
					}
				} catch (error) {
					this.debug('handleTabUpdated: hotswap error', error)
				}
			} else if (!hotswapInfo) {
				this.debug('handleTabUpdated: no pending hotswap match for', currentUrl)
			}
		}

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
			await this.updateBookmarkContainerUrl(bookmark);
		}
	}

	/** Updates page-action visibility when the user switches to a different tab. */
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
				const assigned = await this.updateBookmarkContainerUrl(bookmark, assignedCookieStoreId)
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

	/** Wires all browser event listeners. Called once during `initialize()`. */
	private registerListeners(): void {
		this.browserApi.menus.onClicked.addListener(this.handleMenuClick)
		this.browserApi.menus.onShown.addListener(this.handleMenuShown)
		this.browserApi.menus.onHidden.addListener(this.handleMenuHidden)
		this.browserApi.tabs.onUpdated.addListener(this.handleTabUpdated)
		this.browserApi.tabs.onActivated.addListener(this.handleTabActivated)
		this.browserApi.tabs.onCreated.addListener(this.handleTabCreated)
		this.browserApi.windows.onCreated.addListener(this.handleWindowCreated)
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