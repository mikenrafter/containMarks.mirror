import type {
	BookmarkNode,
	ContainerMappingRecord,
	LegacyReference,
	LoggerLike,
	ParsedBookmarkUrl,
	StorageLike
} from './models'

export const PREFIX = 'about'
export const DELIMITER = ':'
export const TOKEN_SEGMENT_MIN_LENGTH = 6

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

export interface BookmarkTokenSource {
	value?: string
	seed?: () => number
}

// --- Bookmark URL codec ---

/**
 * Extracts the token, container index, and real URL from a containMarks-encoded bookmark URL.
 * Accepts either a BookmarkNode (returns null if it's not a bookmark with a string URL)
 * or a raw URL string for cases where the bookmark identity isn't available.
 *
 * URL scheme: `about:<token>:<containerIndex>:<realUrl>`
 */
export function parseBookmarkUrl(source: BookmarkNode | string): ParsedBookmarkUrl | null {
	const url = typeof source === 'string' ? source : source.url
	if (typeof url !== 'string') return null
	if (typeof source !== 'string' && source.type !== 'bookmark') return null

	let parsedUrl = url
	let token = ''
	let containerId: number | null = null
	let parts = url.split(DELIMITER)

	if (parts.length >= 3 && parts[0] === PREFIX) {
		token = parts[1] ?? ''
		const maybeContainerId = Number(parts[2])
		if (parts.length >= 4 && Number.isInteger(maybeContainerId) && maybeContainerId >= 0) {
			containerId = maybeContainerId
			parts = parts.slice(3)
		} else {
			parts = parts.slice(2)
		}
		parsedUrl = parts.join(DELIMITER)
	}

	return {
		url: parsedUrl,
		token,
		containerIndex: containerId
	}
}

export function generateKey(randomValue: () => number): string {
	return randomValue().toString(32).slice(2)
}

/**
 * Builds a containMarks bookmark URL.
 *
 * Failure mode: throws when both `value` and `seed` are missing.
 */
export function getNewUrl(tokenSource: BookmarkTokenSource, containerIndex: number, url: string): string {
	const tokenString = tokenSource.value ?? (tokenSource.seed ? generateKey(tokenSource.seed) : null)
	if (!tokenString) {
		throw new Error('getNewUrl requires either tokenSource.value or tokenSource.seed')
	}

	return [PREFIX, tokenString, String(containerIndex), url].join(DELIMITER)
}

/** Checks whether a URL is a containMarks-encoded bookmark URL with a valid token. */
export function isPrefixedUrl(url: string, logger?: LoggerLike): boolean {
	const parsed = parseBookmarkUrl(url)
	logger?.log('isPrefixedUrl', url, parsed)
	return parsed !== null && parsed.token.length >= TOKEN_SEGMENT_MIN_LENGTH && parsed.containerIndex !== null
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

// --- Legacy storage helpers ---

export function listStorageKeys(storage: StorageLike): string[] {
	const keys: string[] = []
	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index)
		if (key !== null) {
			keys.push(key)
		}
	}
	return keys
}

export function readLegacyReference(storage: StorageLike, key: string): LegacyReference | null {
	const rawValue = storage.getItem(key)
	if (rawValue === null) {
		return null
	}

	try {
		const { id, container } = JSON.parse(rawValue) as { id: string, container: string }
		if (!id || !container) return null
		else return {
			bookmarkId: id,
			backupName: container,
		}
	} catch {
		return null
	}
}
