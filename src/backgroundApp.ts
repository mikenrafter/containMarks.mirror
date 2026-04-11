export const ENABLE_DEBUG_DEFAULT = false
export const NO_CONTAINER = 'firefox-default'

import type {
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
	TabChangeInfo
} from './models'
import { ContainerMappingStore } from './containerMappingStore'
import {
	DELIMITER,
	PREFIX,
	getNewUrl,
	isPrefixedUrl,
	listStorageKeys,
	parseBookmarkUrl,
	readLegacyReference,
} from './containerMappings'
import { loadSettings } from './settings'

export { DELIMITER, PREFIX, getNewUrl, isPrefixedUrl, parseBookmarkUrl } from './containerMappings'

/**
 * Coordinates extension runtime flows for menus, tab interception, migration, and quick bookmarking.
 *
 * Design note: this class owns event wiring, while mapping persistence remains delegated to
 * `ContainerMappingStore` and URL encoding rules remain delegated to `containerMappings`.
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
		await this.migrateLegacyStorage(mappingStore)
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

	private async refreshTokensOnStartup(mappingStore: ContainerMappingStore): Promise<void> {
		const bookmarks = await this.browserApi.bookmarks.search({ query: `${PREFIX}${DELIMITER}` })
		for (const bookmark of bookmarks) {
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

	public readonly handleMenuClick = async (info: MenusOnClickInfo): Promise<void> => {
		const bookmark = await this.browserApi.bookmarks.get(info.bookmarkId);
		this.debug(bookmark);
		await this.applyContainer(bookmark, info.menuItemId);
	}

	public readonly handleMenuShown = async (info: MenusOnShownInfo): Promise<void> => {
		try {
			if (info.contexts.includes('bookmark') && info.bookmarkId) {
				const bookmark = (await this.browserApi.bookmarks.get(info.bookmarkId))[0]
				if (bookmark?.type === 'separator') {
					this.browserApi.menus.refresh()
					return
				}

				if (bookmark) {
					await this.rebuildMenuItems(bookmark)
				}
			}
		} catch (error) {
			this.debug(error)
		}
	}

	public readonly handleTabUpdated = async (id: number, change: TabChangeInfo, tab: Tab): Promise<void> => {
		if (change.status === 'complete' && id !== this.browserApi.tabs.TAB_ID_NONE) {
			await this.syncPageActionVisibilityForTab(id)
		}

		const currentUrl = tab.url ?? change.url ?? ''
		if (change.status !== 'complete' || id === this.browserApi.tabs.TAB_ID_NONE || !isPrefixedUrl(currentUrl)) {
			return;
		}

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
		this.browserApi.tabs.onUpdated.addListener(this.handleTabUpdated)
		this.browserApi.tabs.onActivated.addListener(this.handleTabActivated)
		this.browserApi.pageAction.onClicked.addListener(this.handlePageActionClicked)
	}
}