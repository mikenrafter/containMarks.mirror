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

/** Fragment-based encoding prefix. Bookmark URLs use `#cm:token:containerIndex` with an optional `#originalFragment` suffix. */
export const FRAGMENT_PREFIX = 'cm'

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
 * Parses a fragment-encoded bookmark URL: `https://real.url#cm:token:containerIndex` or
 * `https://real.url#cm:token:containerIndex#originalFragment`.
 *
 * The second `#` inside the fragment separates the encoding from any pre-existing fragment.
 * Returns null when the URL has no fragment or doesn't start with `cm:`.
 */
function parseFragmentEncoding(url: string): ParsedBookmarkUrl | null {
	const hashIndex = url.indexOf('#')
	if (hashIndex < 0) return null

	const fragment = url.slice(hashIndex + 1)
	const cmPrefix = FRAGMENT_PREFIX + DELIMITER
	if (!fragment.startsWith(cmPrefix)) return null

	const afterPrefix = fragment.slice(cmPrefix.length)
	const secondHashIndex = afterPrefix.indexOf('#')
	const encodingPart = secondHashIndex >= 0 ? afterPrefix.slice(0, secondHashIndex) : afterPrefix
	const originalFragment = secondHashIndex >= 0 ? afterPrefix.slice(secondHashIndex + 1) : ''

	const parts = encodingPart.split(DELIMITER)
	if (parts.length < 2) return null

	const token = parts[0] ?? ''
	const maybeIndex = Number(parts[1])
	if (!Number.isInteger(maybeIndex) || maybeIndex < 0) return null

	const baseUrl = url.slice(0, hashIndex)
	const realUrl = originalFragment ? `${baseUrl}#${originalFragment}` : baseUrl

	return { url: realUrl, token, containerIndex: maybeIndex }
}

/**
 * Parses a legacy `about:token:containerIndex:realUrl` encoded bookmark URL.
 * Kept for backward compatibility during migration from the old encoding scheme.
 */
function parseLegacyEncoding(url: string): ParsedBookmarkUrl | null {
	let parts = url.split(DELIMITER)
	if (parts.length < 3 || parts[0] !== PREFIX) return null

	const token = parts[1] ?? ''
	const maybeContainerId = Number(parts[2])
	let containerId: number | null = null
	if (parts.length >= 4 && Number.isInteger(maybeContainerId) && maybeContainerId >= 0) {
		containerId = maybeContainerId
		parts = parts.slice(3)
	} else {
		parts = parts.slice(2)
	}

	return {
		url: parts.join(DELIMITER),
		token,
		containerIndex: containerId
	}
}

/**
 * Extracts the token, container index, and real URL from a containMarks-encoded bookmark URL.
 * Accepts either a BookmarkNode or a raw URL string.
 *
 * Tries fragment encoding (`#cm:token:idx`) first, then falls back to the legacy
 * `about:token:idx:url` scheme for backward compatibility.
 */
export function parseBookmarkUrl(source: BookmarkNode | string): ParsedBookmarkUrl | null {
	const url = typeof source === 'string' ? source : source.url
	if (typeof url !== 'string') return null
	if (typeof source !== 'string' && source.type !== 'bookmark') return null

	return parseFragmentEncoding(url) ?? parseLegacyEncoding(url) ?? {
		url,
		token: '',
		containerIndex: null
	}
}

/** Returns true when the URL uses the current fragment-based encoding scheme. */
export function isFragmentEncodedUrl(url: string): boolean {
	const hashIndex = url.indexOf('#')
	if (hashIndex < 0) return false
	return url.slice(hashIndex + 1).startsWith(FRAGMENT_PREFIX + DELIMITER)
}

/** Returns true when the URL uses the legacy `about:` encoding scheme. */
export function isLegacyEncodedUrl(url: string): boolean {
	const parsed = parseLegacyEncoding(url)
	return parsed !== null && parsed.token.length >= TOKEN_SEGMENT_MIN_LENGTH && parsed.containerIndex !== null
}

/**
 * Strips the fragment encoding from a bookmark URL, returning the real URL.
 * Used during hotswap to show the user the clean URL in the Properties dialog.
 * Returns the URL unchanged if it's not fragment-encoded.
 */
export function decodeToRealUrl(url: string): string {
	const parsed = parseFragmentEncoding(url)
	return parsed ? parsed.url : url
}

export function generateKey(randomValue: () => number): string {
	return randomValue().toString(32).slice(2)
}

/**
 * Builds a fragment-encoded bookmark URL: `realUrl#cm:token:containerIndex[#originalFragment]`.
 *
 * Pre-existing fragments on the real URL are preserved after the encoding.
 * Failure mode: throws when both `value` and `seed` are missing.
 */
export function getNewUrl(tokenSource: BookmarkTokenSource, containerIndex: number, url: string): string {
	const tokenString = tokenSource.value ?? (tokenSource.seed ? generateKey(tokenSource.seed) : null)
	if (!tokenString) {
		throw new Error('getNewUrl requires either tokenSource.value or tokenSource.seed')
	}

	// Strip any pre-existing fragment encoding to prevent double-encoding
	const cleanUrl = decodeToRealUrl(url)

	const hashIndex = cleanUrl.indexOf('#')
	const baseUrl = hashIndex >= 0 ? cleanUrl.slice(0, hashIndex) : cleanUrl
	const originalFragment = hashIndex >= 0 ? cleanUrl.slice(hashIndex + 1) : ''

	const encoding = [FRAGMENT_PREFIX, tokenString, String(containerIndex)].join(DELIMITER)
	if (originalFragment) {
		return `${baseUrl}#${encoding}#${originalFragment}`
	}
	return `${baseUrl}#${encoding}`
}

/** Checks whether a URL is a containMarks-encoded bookmark URL (fragment or legacy) with a valid token. */
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
