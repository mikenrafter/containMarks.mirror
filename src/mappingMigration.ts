/**
 * Helpers for reading, writing, scanning, and migrating container mapping records
 * between local storage and bookmark-synced storage.
 *
 * Extracted from `options.ts` so they can be tested independently without
 * triggering the options page DOM initialization.
 */

import {
	LOCAL_MAPPING_STORAGE_KEY,
	SYNC_FOLDER_PARENT_ID,
	SYNC_FOLDER_TITLE,
	buildContainerMappingUrl,
	buildMappingTitle,
	parseContainerMappingBookmark,
	parseMappingRecord
} from './containerMappings'
import { FRAGMENT_PREFIX, DELIMITER, parseBookmarkUrl, decodeToRealUrl } from './urlCodec'
import type { BookmarkNode, BrowserApi, ContainerMappingRecord } from './models'

function normalizeMappingRecords(records: ContainerMappingRecord[]): ContainerMappingRecord[] {
	const byIndex = new Map<number, ContainerMappingRecord>()
	for (const record of records) {
		byIndex.set(record.firstSeenIndex, record)
	}

	return [...byIndex.values()].sort((left, right) => left.firstSeenIndex - right.firstSeenIndex)
}

function isSyncFolderAtOfficialPath(node: BookmarkNode): boolean {
	return node.parentId === SYNC_FOLDER_PARENT_ID && node.title?.trim() === SYNC_FOLDER_TITLE
}

async function listSyncFolders(browserApi: BrowserApi): Promise<BookmarkNode[]> {
	const folders = await browserApi.bookmarks.search({ title: SYNC_FOLDER_TITLE })
	return folders.filter((node) => node.type === 'folder' && isSyncFolderAtOfficialPath(node))
}

export async function readSyncedMappings(browserApi: BrowserApi): Promise<ContainerMappingRecord[]> {
	const folders = await listSyncFolders(browserApi)
	const records: ContainerMappingRecord[] = []

	for (const folder of folders) {
		const children = await browserApi.bookmarks.getChildren(folder.id)
		for (const child of children) {
			const parsed = parseContainerMappingBookmark(child)
			if (parsed) {
				records.push(parsed)
			}
		}
	}

	return normalizeMappingRecords(records)
}

export async function readLocalMappings(browserApi: BrowserApi): Promise<ContainerMappingRecord[]> {
	const payload = await browserApi.storage.local.get(LOCAL_MAPPING_STORAGE_KEY)
	const rawValue = payload[LOCAL_MAPPING_STORAGE_KEY]
	if (!Array.isArray(rawValue)) {
		return []
	}

	const records = rawValue.map(parseMappingRecord).filter((record): record is ContainerMappingRecord => record !== null)
	return normalizeMappingRecords(records)
}

export async function writeLocalMappings(browserApi: BrowserApi, records: ContainerMappingRecord[]): Promise<void> {
	await browserApi.storage.local.set({ [LOCAL_MAPPING_STORAGE_KEY]: normalizeMappingRecords(records) })
}

/**
 * Finds all fragment-encoded bookmarks whose `containerIndex` doesn't resolve in the target mapping set.
 *
 * Called during storage mode migration to warn the user about bookmarks that will become inert
 * (no container will open) after the switch. Returns bookmark nodes so the caller can offer to
 * strip the encoding or display a count.
 */
export async function scanOrphanedBookmarks(browserApi: BrowserApi, targetRecords: ContainerMappingRecord[]): Promise<BookmarkNode[]> {
	const resolvedIndices = new Set(targetRecords.map(r => r.firstSeenIndex))
	const encoded = await browserApi.bookmarks.search({ query: `#${FRAGMENT_PREFIX}${DELIMITER}` })
	const orphans: BookmarkNode[] = []

	for (const bookmark of encoded) {
		const parsed = parseBookmarkUrl(bookmark)
		if (!parsed || parsed.containerIndex === null) continue
		if (!resolvedIndices.has(parsed.containerIndex)) {
			orphans.push(bookmark)
		}
	}

	return orphans
}

/**
 * Resets orphaned bookmarks by removing the container encoding, reverting to plain URLs.
 * Used when the user opts to clean up orphaned bookmarks during storage mode migration.
 */
export async function resetOrphanedBookmarks(browserApi: BrowserApi, orphans: BookmarkNode[]): Promise<number> {
	let resetCount = 0
	for (const bookmark of orphans) {
		if (!bookmark.url) continue
		const plainUrl = decodeToRealUrl(bookmark.url)
		if (plainUrl !== bookmark.url) {
			await browserApi.bookmarks.update(bookmark.id, { url: plainUrl })
			resetCount += 1
		}
	}
	return resetCount
}

export async function overwriteSyncedMappings(browserApi: BrowserApi, records: ContainerMappingRecord[]): Promise<void> {
	const syncFolders = await listSyncFolders(browserApi)

	for (const folder of syncFolders) {
		const children = await browserApi.bookmarks.getChildren(folder.id)
		for (const child of children) {
			if (parseContainerMappingBookmark(child)) {
				await browserApi.bookmarks.remove(child.id)
			}
		}
	}

	let targetFolder = syncFolders[0]
	if (!targetFolder) {
		targetFolder = await browserApi.bookmarks.create({
			parentId: SYNC_FOLDER_PARENT_ID,
			type: 'folder',
			title: SYNC_FOLDER_TITLE
		})
	}

	for (const record of normalizeMappingRecords(records)) {
		await browserApi.bookmarks.create({
			parentId: targetFolder.id,
			title: buildMappingTitle(record.backupName),
			url: buildContainerMappingUrl(record)
		})
	}
}
