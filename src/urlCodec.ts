import type {
	BookmarkNode,
	BookmarkTokenSource,
	LegacyReference,
	LoggerLike,
	ParsedBookmarkUrl,
	StorageLike
} from './models'

// --- Shared constants ---

export const PREFIX = 'about'
export const DELIMITER = ':'
export const TOKEN_SEGMENT_MIN_LENGTH = 6

/** Fragment-based encoding prefix. Bookmark URLs use `#cm:token:containerIndex` with an optional `#originalFragment` suffix. */
export const FRAGMENT_PREFIX = 'cm'

// --- Codec version identifiers ---

export type CodecVersion = 'beta' | 'v1.0.0' | 'v1.1.0' | 'v1.2.0'

/**
 * A versioned URL codec that can detect and parse containMarks bookmark URLs.
 *
 * Each version represents a historical encoding scheme. The codec chain tries
 * newest-first so the current format wins when a URL could technically match
 * multiple versions.
 *
 * - `beta`:  No URL encoding — mappings lived in localStorage. detect/parse always return false/null.
 * - `v1.0.0`: `about:token:containerName:url` — container assignment by name.
 * - `v1.1.0`: `about:token:containerIndex:url` — container assignment by index.
 * - `v1.2.0`: `url#cm:token:containerIndex[#originalFragment]` — fragment-based.
 */
export interface BookmarkUrlCodec {
	readonly version: CodecVersion
	/** Returns true when the URL matches this version's encoding scheme. */
	detect(url: string): boolean
	/** Extracts token, container info, and real URL. Returns null when the URL doesn't match. */
	parse(url: string): ParsedBookmarkUrl | null
}

// --- Codec implementations ---

/**
 * Beta codec stub. The original extension stored container assignments in localStorage,
 * not in bookmark URLs. Detection and parsing always fail because there is no URL encoding.
 * Use `readLegacyStorageKeys`/`readLegacyReference` to access Beta-era data.
 */
const betaCodec: BookmarkUrlCodec = {
	version: 'beta',
	detect: () => false,
	parse: () => null,
}

/**
 * v1.0.0 codec: `about:token:containerName:url`.
 *
 * Container assignment was by NAME (a string), not by index. The third segment is
 * a non-numeric string identifying the container. Differentiated from v1.1.0 by
 * checking whether the third segment parses as a non-negative integer.
 */
const v100Codec: BookmarkUrlCodec = {
	version: 'v1.0.0',
	detect(url: string): boolean {
		const parts = url.split(DELIMITER)
		if (parts.length < 4 || parts[0] !== PREFIX) return false
		const token = parts[1] ?? ''
		if (token.length < TOKEN_SEGMENT_MIN_LENGTH) return false
		const thirdSegment = Number(parts[2])
		// v1.0.0 uses a container NAME (non-numeric) in the third segment
		return !Number.isInteger(thirdSegment) || thirdSegment < 0
	},
	parse(url: string): ParsedBookmarkUrl | null {
		const parts = url.split(DELIMITER)
		if (parts.length < 4 || parts[0] !== PREFIX) return null
		const token = parts[1] ?? ''
		const thirdSegment = Number(parts[2])
		// Only v1.0.0 if the third segment is NOT a valid non-negative integer
		if (Number.isInteger(thirdSegment) && thirdSegment >= 0) return null
		// In v1.0.0, containerIndex is null because it used names, not indices
		const realUrl = parts.slice(3).join(DELIMITER)
		return { url: realUrl, token, containerIndex: null }
	},
}

/**
 * v1.1.0 codec: `about:token:containerIndex:url`.
 *
 * Container assignment by numeric index. The third segment is a non-negative integer.
 */
const v110Codec: BookmarkUrlCodec = {
	version: 'v1.1.0',
	detect(url: string): boolean {
		const parts = url.split(DELIMITER)
		if (parts.length < 4 || parts[0] !== PREFIX) return false
		const token = parts[1] ?? ''
		if (token.length < TOKEN_SEGMENT_MIN_LENGTH) return false
		const index = Number(parts[2])
		return Number.isInteger(index) && index >= 0
	},
	parse(url: string): ParsedBookmarkUrl | null {
		const parts = url.split(DELIMITER)
		if (parts.length < 4 || parts[0] !== PREFIX) return null
		const token = parts[1] ?? ''
		const index = Number(parts[2])
		if (!Number.isInteger(index) || index < 0) return null
		return { url: parts.slice(3).join(DELIMITER), token, containerIndex: index }
	},
}

/**
 * v1.2.0 codec: `url#cm:token:containerIndex[#originalFragment]`.
 *
 * Fragment-based encoding. The real URL is visible and navigable; the container
 * assignment is embedded in the `#` fragment. Pre-existing fragments are preserved
 * after a second `#` separator inside the fragment body.
 */
const v120Codec: BookmarkUrlCodec = {
	version: 'v1.2.0',
	detect(url: string): boolean {
		const hashIndex = url.indexOf('#')
		if (hashIndex < 0) return false
		return url.slice(hashIndex + 1).startsWith(FRAGMENT_PREFIX + DELIMITER)
	},
	parse(url: string): ParsedBookmarkUrl | null {
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
		if (parts.length !== 2) return null

		const token = parts[0] ?? ''
		if (token.length < TOKEN_SEGMENT_MIN_LENGTH) return null

		const index = Number(parts[1])
		if (!Number.isInteger(index) || index < 0) return null

		const baseUrl = url.slice(0, hashIndex)
		const realUrl = originalFragment ? `${baseUrl}#${originalFragment}` : baseUrl

		return { url: realUrl, token, containerIndex: index }
	},
}

/**
 * Ordered codec chain, newest-first. Used during startup migration to detect and
 * upgrade legacy bookmark URLs. Normal runtime operations should use `parseBookmarkUrl`
 * which only checks the current v1.2.0 format.
 */
export const CODEC_CHAIN: readonly BookmarkUrlCodec[] = [v120Codec, v110Codec, v100Codec, betaCodec]

// --- Public parse / detect / build API ---

/**
 * Extracts the token, container index, and real URL from a v1.2.0 fragment-encoded bookmark URL.
 * Accepts either a BookmarkNode or a raw URL string.
 *
 * Only checks the current v1.2.0 format. Legacy formats are intentionally ignored at runtime
 * to avoid interpreting attacker-crafted legacy-encoded URLs as container assignments.
 * Use `parseLegacyBookmarkUrl` during startup migration for older formats.
 *
 * Returns a default `{ url, token: '', containerIndex: null }` for unencoded URLs.
 */
export function parseBookmarkUrl(source: BookmarkNode | string): ParsedBookmarkUrl | null {
	const url = typeof source === 'string' ? source : source.url
	if (typeof url !== 'string') return null
	if (typeof source !== 'string' && source.type !== 'bookmark') return null

	const parsed = v120Codec.parse(url)
	if (parsed !== null && (parsed.token.length > 0 || parsed.containerIndex !== null)) {
		return parsed
	}

	return { url, token: '', containerIndex: null }
}

/**
 * Parses a bookmark URL using the full codec chain (v1.2.0 → v1.1.0 → v1.0.0).
 *
 * **Startup migration only.** Must not be used at runtime — older formats should have been
 * migrated to v1.2.0 by the time normal event handlers fire. Using this at runtime would
 * reopen attack surface for crafted legacy-format URLs.
 */
export function parseLegacyBookmarkUrl(source: BookmarkNode | string): ParsedBookmarkUrl | null {
	const url = typeof source === 'string' ? source : source.url
	if (typeof url !== 'string') return null
	if (typeof source !== 'string' && source.type !== 'bookmark') return null

	for (const codec of CODEC_CHAIN) {
		const parsed = codec.parse(url)
		if (parsed !== null && (parsed.token.length > 0 || parsed.containerIndex !== null)) {
			return parsed
		}
	}

	return { url, token: '', containerIndex: null }
}

/** Returns true when the URL uses the current fragment-based encoding scheme (v1.2.0). */
export function isFragmentEncodedUrl(url: string): boolean {
	return v120Codec.detect(url)
}

/** Returns true when the URL uses the legacy `about:` encoding scheme (v1.0.0 or v1.1.0). */
export function isLegacyEncodedUrl(url: string): boolean {
	const parsed = v110Codec.parse(url)
	return parsed !== null && parsed.token.length >= TOKEN_SEGMENT_MIN_LENGTH && parsed.containerIndex !== null
}

/**
 * Strips the fragment encoding from a bookmark URL, returning the real URL.
 * Used during hotswap to show the user the clean URL in the Properties dialog.
 * Returns the URL unchanged if it's not fragment-encoded.
 */
export function decodeToRealUrl(url: string): string {
	const parsed = v120Codec.parse(url)
	return parsed ? parsed.url : url
}

export function generateKey(randomValue: () => number): string {
	return randomValue().toString(32).slice(2)
}

/**
 * Builds a fragment-encoded bookmark URL (v1.2.0): `realUrl#cm:token:containerIndex[#originalFragment]`.
 *
 * Pre-existing fragments on the real URL are preserved after the encoding.
 * Failure mode: throws when both `value` and `seed` are missing from tokenSource.
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

/** Checks whether a URL is a containMarks-encoded bookmark URL (any version) with a valid token. */
export function isPrefixedUrl(url: string, logger?: LoggerLike): boolean {
	const parsed = parseBookmarkUrl(url)
	logger?.log('isPrefixedUrl', url, parsed)
	return parsed !== null && parsed.token.length >= TOKEN_SEGMENT_MIN_LENGTH && parsed.containerIndex !== null
}

/**
 * Detects which codec version a URL matches, or null for unencoded URLs.
 * Useful for diagnostics and targeted migration.
 */
export function detectCodecVersion(url: string): CodecVersion | null {
	for (const codec of CODEC_CHAIN) {
		if (codec.detect(url)) return codec.version
	}
	return null
}

// --- Migration functions ---
// Each function migrates a URL directly to the current format (v1.2.0).
// The caller is responsible for providing any external data (e.g. container index resolution).

/**
 * Migrates a Beta-era plain URL to the current v1.2.0 encoding.
 *
 * Beta stored container assignments in localStorage with no URL encoding.
 * The caller must supply the token and resolved container index from the mapping store.
 */
export function migrateFromBetaToCurrent(realUrl: string, token: string, containerIndex: number): string {
	return getNewUrl({ value: token }, containerIndex, realUrl)
}

/**
 * Migrates a v1.0.0 URL (`about:token:containerName:url`) to the current v1.2.0 encoding.
 *
 * v1.0.0 used container names, not indices. The caller must resolve the name to an index
 * externally — the codec module has no access to the mapping store.
 */
export function migrateFromV100ToCurrent(v100Url: string, containerIndex: number): string {
	const parsed = v100Codec.parse(v100Url)
	if (!parsed) throw new Error(`migrateFromV100ToCurrent: not a v1.0.0 URL: ${v100Url}`)
	return getNewUrl({ value: parsed.token }, containerIndex, parsed.url)
}

/**
 * Migrates a v1.1.0 URL (`about:token:idx:url`) to the current v1.2.0 encoding.
 *
 * Pure URL transformation — no external data needed. Preserves token, index, and any
 * fragment on the real URL.
 */
export function migrateFromV110ToCurrent(v110Url: string): string {
	const parsed = v110Codec.parse(v110Url)
	if (!parsed || parsed.containerIndex === null) {
		throw new Error(`migrateFromV110ToCurrent: not a v1.1.0 URL: ${v110Url}`)
	}
	return getNewUrl({ value: parsed.token }, parsed.containerIndex, parsed.url)
}

// --- Legacy storage helpers (Beta-era localStorage access) ---

/**
 * Enumerates all keys in a `localStorage`-compatible storage object.
 * Used during Beta → current migration to discover legacy container assignments.
 */
export function readLegacyStorageKeys(storage: StorageLike): string[] {
	const keys: string[] = []
	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index)
		if (key !== null) {
			keys.push(key)
		}
	}
	return keys
}

/**
 * Reads a Beta-era legacy reference from `localStorage`. Each entry stored a JSON
 * object `{ id: bookmarkId, container: containerName }` mapping a bookmark to
 * a container by name.
 *
 * Returns null for missing keys or entries with invalid shape.
 */
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
