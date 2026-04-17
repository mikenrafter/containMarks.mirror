import {
	buildContainerMappingUrl,
	buildMappingTitle,
	LOCAL_MAPPING_STORAGE_KEY,
	parseContainerMappingBookmark,
	parseMappingRecord,
	SYNC_FOLDER_PARENT_ID,
	SYNC_FOLDER_TITLE
} from './containerMappings'
import type { BookmarkNode, BrowserApi, ContainerMappingRecord, ContextualIdentity, LoggerLike } from '../models'

interface ContainerMappingStoreOptions {
	enableBookmarkSync: boolean
}

/**
 * Maintains a stable mapping between runtime container identities and sync-safe first-seen indexes.
 *
 * It keeps an in-memory index for fast lookups and persists records as bookmarks in the
 * `ContainMarks Sync` folder. Persistence is eventually consistent with bookmark storage.
 */
export class ContainerMappingStore {
	private readonly byCookieStoreId = new Map<string, ContainerMappingRecord>()
	private readonly byIndex = new Map<number, ContainerMappingRecord>()
	private readonly byBackupName = new Map<string, ContainerMappingRecord>()
	private readonly bookmarkIdByIndex = new Map<number, string>()
	private lastAssignedIndex = -1
	private syncFolderId: string | null = null
	private loaded = false
	private readonly enableBookmarkSync: boolean

	public constructor(
		private readonly browserApi: BrowserApi,
		private readonly logger: LoggerLike = console,
		options: ContainerMappingStoreOptions = { enableBookmarkSync: true }
	) {
		this.enableBookmarkSync = options.enableBookmarkSync
	}

	public async initialize(): Promise<void> {
		if (this.loaded) {
			return
		}

		if (!this.enableBookmarkSync) {
			await this.loadLocalMappings()
			this.loaded = true
			return
		}

		const folder = await this.findSyncFolder()
		if (!folder) {
			this.loaded = true
			return
		}

		this.syncFolderId = folder.id
		const loadedRecords = await this.readRecordsFromFolder(folder.id)
		if (loadedRecords.length > 0) {
			this.applyRecords(loadedRecords)
		}
		this.loaded = true
	}

	public getByIndex(index: number | null): ContainerMappingRecord | null {
		if (index === null) {
			return null
		}
		return this.byIndex.get(index) ?? null
	}

	public async ensureMappingForContainer(identity: ContextualIdentity): Promise<ContainerMappingRecord> {
		await this.initialize()

		let resolved = await this.tryResolveMapping(identity)
		if (!resolved) {
			if (this.enableBookmarkSync) {
				await this.refreshRecordsFromFolderForWrite()
			} else {
				await this.loadLocalMappings()
			}
			resolved = await this.tryResolveMapping(identity)
		}
		if (resolved) return resolved

		const record: ContainerMappingRecord = {
			firstSeenIndex: this.lastAssignedIndex + 1,
			cookieStoreId: identity.cookieStoreId,
			backupName: identity.name
		}
		this.lastAssignedIndex = record.firstSeenIndex
		this.rememberRecord(record)
		await this.persistMappingRecord(record)
		return record
	}

	/**
	 * Attempts to find an existing mapping for the given container identity,
	 * first by cookieStoreId (exact match) then by backup name (remap).
	 * Updates stale names or cookieStoreIds as a side effect when a match is found.
	 * Returns null when no existing mapping matches.
	 */
	private async tryResolveMapping(identity: ContextualIdentity): Promise<ContainerMappingRecord | null> {
		const knownByCookieStoreId = this.byCookieStoreId.get(identity.cookieStoreId)
		if (knownByCookieStoreId) {
			if (knownByCookieStoreId.backupName !== identity.name) {
				this.byBackupName.delete(knownByCookieStoreId.backupName)
				knownByCookieStoreId.backupName = identity.name
				await this.persistMappingRecord(knownByCookieStoreId)
			}
			return knownByCookieStoreId
		}

		const remapCandidate = this.byBackupName.get(identity.name)
		if (remapCandidate) {
			this.byCookieStoreId.delete(remapCandidate.cookieStoreId)
			remapCandidate.cookieStoreId = identity.cookieStoreId
			await this.persistMappingRecord(remapCandidate)
			return remapCandidate
		}

		return null
	}


	private rememberRecord(record: ContainerMappingRecord): void {
		const existingByIndex = this.byIndex.get(record.firstSeenIndex)
		if (existingByIndex) {
			this.byCookieStoreId.delete(existingByIndex.cookieStoreId)
			this.byBackupName.delete(existingByIndex.backupName)
		}
		this.byCookieStoreId.set(record.cookieStoreId, record)
		this.byIndex.set(record.firstSeenIndex, record)
		this.byBackupName.set(record.backupName, record)
		this.lastAssignedIndex = Math.max(this.lastAssignedIndex, record.firstSeenIndex)
	}

	private applyRecords(records: Array<{ record: ContainerMappingRecord, bookmarkId: string }>): void {
		for (const record of records) {
			this.rememberRecord({ ...record.record })
			this.bookmarkIdByIndex.set(record.record.firstSeenIndex, record.bookmarkId)
		}
	}

	private async persistMappingRecord(record: ContainerMappingRecord): Promise<void> {
		if (!this.enableBookmarkSync) {
			this.rememberRecord(record)
			await this.persistLocalMappings()
			return
		}

		const folderId = await this.ensureSyncFolderId()
		const existing = await this.findMappingBookmark(folderId, record.firstSeenIndex)
		const mappingTitle = buildMappingTitle(record.backupName)
		const mappingUrl = buildContainerMappingUrl(record)
		if (existing) {
			await this.browserApi.bookmarks.update(existing.id, { title: mappingTitle, url: mappingUrl })
			this.bookmarkIdByIndex.set(record.firstSeenIndex, existing.id)
		} else {
			const created = await this.browserApi.bookmarks.create({
				parentId: folderId,
				title: mappingTitle,
				url: mappingUrl
			})
			this.bookmarkIdByIndex.set(record.firstSeenIndex, created.id)
		}

		this.rememberRecord(record)
	}

	private async refreshRecordsFromFolderForWrite(): Promise<void> {
		const folderId = await this.ensureSyncFolderId()
		const records = await this.readRecordsFromFolder(folderId)
		if (records.length === 0) {
			return
		}
		this.applyRecords(records)
	}

	private async ensureSyncFolderId(): Promise<string> {
		if (this.syncFolderId) {
			return this.syncFolderId
		}
		const existing = await this.findSyncFolder()
		if (existing) {
			this.syncFolderId = existing.id
			return existing.id
		}

		const created = await this.createSyncFolder()
		this.syncFolderId = created.id
		return created.id
	}

	private async findSyncFolder(): Promise<BookmarkNode | null> {
		const matches = await this.browserApi.bookmarks.search({ title: SYNC_FOLDER_TITLE })
		for (const bookmark of matches) {
			if (bookmark.type === 'folder' && bookmark.parentId === SYNC_FOLDER_PARENT_ID) {
				return bookmark
			}
		}
		return null
	}

	private async createSyncFolder(): Promise<BookmarkNode> {
		this.logger.log('Creating sync folder:', SYNC_FOLDER_TITLE)
		return this.browserApi.bookmarks.create({
			parentId: SYNC_FOLDER_PARENT_ID,
			type: 'folder',
			title: SYNC_FOLDER_TITLE
		})
	}

	private async readRecordsFromFolder(folderId: string): Promise<Array<{ record: ContainerMappingRecord, bookmarkId: string }>> {
		const children = await this.browserApi.bookmarks.getChildren(folderId)
		const records: Array<{ record: ContainerMappingRecord, bookmarkId: string }> = []
		for (const child of children) {
			const parsed = parseContainerMappingBookmark(child)
			if (parsed !== null) {
				records.push({ record: parsed, bookmarkId: child.id })
			}
		}
		return records
	}

	private async findMappingBookmark(folderId: string, index: number): Promise<BookmarkNode | null> {
		const knownBookmarkId = this.bookmarkIdByIndex.get(index)
		if (knownBookmarkId) {
			const bookmark = (await this.browserApi.bookmarks.get(knownBookmarkId))[0]
			if (bookmark?.type === 'bookmark') {
				return bookmark
			}
			this.bookmarkIdByIndex.delete(index)
		}

		const children = await this.browserApi.bookmarks.getChildren(folderId)
		for (const child of children) {
			const parsed = parseContainerMappingBookmark(child)
			if (parsed !== null && parsed.firstSeenIndex === index) {
				this.bookmarkIdByIndex.set(index, child.id)
				return child
			}
		}
		return null
	}

	private async loadLocalMappings(): Promise<void> {
		const payload = await this.browserApi.storage.local.get(LOCAL_MAPPING_STORAGE_KEY)
		const records = payload[LOCAL_MAPPING_STORAGE_KEY]
		if (!Array.isArray(records)) {
			return
		}

		for (const value of records) {
			const record = parseMappingRecord(value)
			if (record) {
				this.rememberRecord(record)
			}
		}
	}

	private async persistLocalMappings(): Promise<void> {
		const records = [...this.byIndex.values()].sort((left, right) => left.firstSeenIndex - right.firstSeenIndex)
		await this.browserApi.storage.local.set({ [LOCAL_MAPPING_STORAGE_KEY]: records })
	}
}
