import type {
	BookmarkNode,
	ContainerMappingRecord,
} from '../models'
import { PREFIX, DELIMITER } from '../urlCodec'

export const SYNC_FOLDER_PARENT_ID = 'menu________'
export const SYNC_FOLDER_TITLE = 'ContainMarks Sync'
export const MAPPING_TITLE_PREFIX = 'Mapping: '
export const LOCAL_MAPPING_STORAGE_KEY = 'containMarks.localMappings'

/** Parses an untyped value into a ContainerMappingRecord, returning null if the shape is invalid. */
export function parseMappingRecord(value: unknown): ContainerMappingRecord | null {
	if (value === null || typeof value !== 'object') {
		return null
	}

	const candidate = value as Partial<ContainerMappingRecord>
	if (
		!Number.isInteger(candidate.firstSeenIndex)
		|| (candidate.firstSeenIndex as number) < 0
		|| typeof candidate.cookieStoreId !== 'string'
		|| candidate.cookieStoreId.length === 0
		|| typeof candidate.backupName !== 'string'
	) {
		return null
	}

	return {
		firstSeenIndex: candidate.firstSeenIndex as number,
		cookieStoreId: candidate.cookieStoreId,
		backupName: candidate.backupName
	}
}

// --- Container mapping URL codec ---

export function parseContainerMappingUrl(url: string): ContainerMappingRecord | null {
	const [prefix, firstSeenIndex, cookieStoreId = '', ...backupNameSegments] = url.split(DELIMITER)
	const idNumber = Number(firstSeenIndex)
	const backupName = backupNameSegments.join(DELIMITER)
	if (prefix !== PREFIX || !Number.isInteger(idNumber) || idNumber < 0 || !(cookieStoreId || backupName)) {
		return null
	}

	return {
		firstSeenIndex: idNumber,
		cookieStoreId,
		backupName: backupName ?? ''
	}
}

export function buildContainerMappingUrl(record: ContainerMappingRecord): string {
	return [PREFIX, String(record.firstSeenIndex), record.cookieStoreId, record.backupName].join(DELIMITER)
}

export function parseContainerMappingBookmark(bookmark: BookmarkNode): ContainerMappingRecord | null {
	if (bookmark.type !== 'bookmark' || typeof bookmark.url !== 'string') {
		return null
	}

	return parseContainerMappingUrl(bookmark.url)
}

export function buildMappingTitle(containerName: string): string {
	return `${MAPPING_TITLE_PREFIX}${containerName}`
}
