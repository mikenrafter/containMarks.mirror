import { describe, expect, it } from 'vitest'

import {
	CODEC_CHAIN,
	DELIMITER,
	FRAGMENT_PREFIX,
	PREFIX,
	TOKEN_SEGMENT_MIN_LENGTH,
	decodeToRealUrl,
	detectCodecVersion,
	generateKey,
	getNewUrl,
	isFragmentEncodedUrl,
	isLegacyEncodedUrl,
	isPrefixedUrl,
	migrateFromBetaToCurrent,
	migrateFromV100ToCurrent,
	migrateFromV110ToCurrent,
	parseBookmarkUrl,
	parseLegacyBookmarkUrl,
	readLegacyReference,
	readLegacyStorageKeys,
} from '../src/urlCodec'
import type { StorageLike } from '../src/models'

// --- Helpers ---

class MemoryStorage implements StorageLike {
	private readonly data = new Map<string, string>()

	public get length(): number {
		return this.data.size
	}

	public key(index: number): string | null {
		return [...this.data.keys()][index] ?? null
	}

	public getItem(key: string): string | null {
		return this.data.get(key) ?? null
	}

	public setItem(key: string, value: string): void {
		this.data.set(key, value)
	}

	public removeItem(key: string): void {
		this.data.delete(key)
	}
}

// --- Codec chain structure ---

describe('codec chain', () => {
	it('contains all four versions in newest-first order', () => {
		const versions = CODEC_CHAIN.map(c => c.version)
		expect(versions).toEqual(['v1.2.0', 'v1.1.0', 'v1.0.0', 'beta'])
	})

	it('exports expected constants', () => {
		expect(PREFIX).toBe('about')
		expect(DELIMITER).toBe(':')
		expect(TOKEN_SEGMENT_MIN_LENGTH).toBe(6)
		expect(FRAGMENT_PREFIX).toBe('cm')
	})
})

// --- Version detection ---

describe('detectCodecVersion', () => {
	it('detects v1.2.0 fragment-encoded URLs', () => {
		expect(detectCodecVersion('https://example.com#cm:token-123:0')).toBe('v1.2.0')
		expect(detectCodecVersion('https://example.com#cm:token-123:0#section')).toBe('v1.2.0')
	})

	it('detects v1.1.0 about-index URLs', () => {
		expect(detectCodecVersion('about:token-123:7:https://example.com')).toBe('v1.1.0')
	})

	it('detects v1.0.0 about-name URLs', () => {
		expect(detectCodecVersion('about:token-123:WorkContainer:https://example.com')).toBe('v1.0.0')
	})

	it('returns null for unencoded URLs', () => {
		expect(detectCodecVersion('https://example.com')).toBeNull()
		expect(detectCodecVersion('https://example.com#section')).toBeNull()
	})

	it('returns null for beta (no URL encoding)', () => {
		// Beta has no URL-based encoding, so any plain URL returns null
		expect(detectCodecVersion('https://plain-beta-bookmark.com')).toBeNull()
	})
})

// --- Individual codec parsing ---

describe('v1.2.0 codec (fragment)', () => {
	it('parses basic fragment-encoded URL', () => {
		expect(parseBookmarkUrl('https://example.com#cm:token-123:0')).toEqual({
			url: 'https://example.com',
			token: 'token-123',
			containerIndex: 0,
		})
	})

	it('parses fragment-encoded URL with original fragment', () => {
		expect(parseBookmarkUrl('https://example.com/page#cm:token-123:5#section')).toEqual({
			url: 'https://example.com/page#section',
			token: 'token-123',
			containerIndex: 5,
		})
	})

	it('rejects fragment URLs without cm: prefix', () => {
		const parsed = parseBookmarkUrl('https://example.com#section')
		expect(parsed).toEqual({ url: 'https://example.com#section', token: '', containerIndex: null })
	})
})

describe('v1.1.0 codec (about + index)', () => {
	it('parses about-index URL via legacy parser', () => {
		expect(parseLegacyBookmarkUrl('about:token-123:7:https://example.com')).toEqual({
			url: 'https://example.com',
			token: 'token-123',
			containerIndex: 7,
		})
	})

	it('parses URL with colons in the real URL', () => {
		expect(parseLegacyBookmarkUrl('about:token-123:0:https://example.com:8080/path')).toEqual({
			url: 'https://example.com:8080/path',
			token: 'token-123',
			containerIndex: 0,
		})
	})

	it('is not parsed by runtime parseBookmarkUrl (security boundary)', () => {
		const parsed = parseBookmarkUrl('about:token-123:7:https://example.com')
		expect(parsed?.containerIndex).toBeNull()
	})
})

describe('v1.0.0 codec (about + name)', () => {
	it('parses about-name URL via legacy parser', () => {
		const parsed = parseLegacyBookmarkUrl('about:token-123:WorkContainer:https://example.com')
		expect(parsed).toEqual({
			url: 'https://example.com',
			token: 'token-123',
			containerIndex: null,
		})
	})

	it('is not parsed by runtime parseBookmarkUrl (security boundary)', () => {
		const parsed = parseBookmarkUrl('about:token-123:WorkContainer:https://example.com')
		expect(parsed?.containerIndex).toBeNull()
	})
})

describe('beta codec', () => {
	it('never matches any URL (stub)', () => {
		const betaCodec = CODEC_CHAIN.find(c => c.version === 'beta')!
		expect(betaCodec.detect('https://anything.com')).toBe(false)
		expect(betaCodec.parse('https://anything.com')).toBeNull()
	})
})

// --- Detection helpers ---

describe('isFragmentEncodedUrl', () => {
	it('returns true for v1.2.0 URLs', () => {
		expect(isFragmentEncodedUrl('https://example.com#cm:token-123:0')).toBe(true)
		expect(isFragmentEncodedUrl('https://example.com#cm:token-123:0#section')).toBe(true)
	})

	it('returns false for other formats', () => {
		expect(isFragmentEncodedUrl('https://example.com#section')).toBe(false)
		expect(isFragmentEncodedUrl('https://example.com')).toBe(false)
		expect(isFragmentEncodedUrl('about:token-123:0:https://example.com')).toBe(false)
	})
})

describe('isLegacyEncodedUrl', () => {
	it('returns true for v1.1.0 URLs with valid tokens', () => {
		expect(isLegacyEncodedUrl('about:token-123:7:https://example.com')).toBe(true)
	})

	it('returns false for short tokens', () => {
		expect(isLegacyEncodedUrl('about:short:7:https://example.com')).toBe(false)
	})

	it('returns false for fragment-encoded URLs', () => {
		expect(isLegacyEncodedUrl('https://example.com#cm:token-123:0')).toBe(false)
	})
})

describe('isPrefixedUrl', () => {
	it('accepts valid tokens from v1.2.0 URLs', () => {
		expect(isPrefixedUrl('https://example.com#cm:token-123:7')).toBe(true)
	})

	it('rejects legacy about: URLs at runtime (security boundary)', () => {
		expect(isPrefixedUrl('about:token-123:7:https://example.com')).toBe(false)
	})

	it('rejects short tokens', () => {
		expect(isPrefixedUrl('about:short:7:https://example.com')).toBe(false)
		expect(isPrefixedUrl('https://example.com#cm:short:7')).toBe(false)
	})

	it('rejects plain URLs', () => {
		expect(isPrefixedUrl('https://example.com')).toBe(false)
	})
})

// --- Build / decode ---

describe('getNewUrl', () => {
	it('builds a v1.2.0 fragment-encoded URL', () => {
		expect(getNewUrl({ value: 'testtoken' }, 3, 'https://example.com')).toBe(
			'https://example.com#cm:testtoken:3'
		)
	})

	it('preserves original fragments', () => {
		expect(getNewUrl({ value: 'testtoken' }, 0, 'https://example.com/page#section')).toBe(
			'https://example.com/page#cm:testtoken:0#section'
		)
	})

	it('prevents double-encoding', () => {
		const first = getNewUrl({ value: 'firsttok' }, 0, 'https://example.com')
		const second = getNewUrl({ value: 'secondtk' }, 1, first)
		expect(second).toBe('https://example.com#cm:secondtk:1')
		expect(second).not.toContain('firsttok')
	})

	it('prevents double-encoding with original fragment', () => {
		const first = getNewUrl({ value: 'firsttok' }, 0, 'https://example.com/page#section')
		const second = getNewUrl({ value: 'secondtk' }, 2, first)
		expect(second).toBe('https://example.com/page#cm:secondtk:2#section')
		expect(second).not.toContain('firsttok')
	})

	it('throws when tokenSource has neither value nor seed', () => {
		expect(() => getNewUrl({}, 0, 'https://example.com')).toThrow()
	})

	it('uses seed when value is not provided', () => {
		const url = getNewUrl({ seed: () => 0.5 }, 0, 'https://example.com')
		expect(url).toMatch(/^https:\/\/example\.com#cm:[^:]+:0$/)
	})
})

describe('decodeToRealUrl', () => {
	it('strips fragment encoding', () => {
		expect(decodeToRealUrl('https://example.com#cm:testtoken:0')).toBe('https://example.com')
	})

	it('restores original fragment', () => {
		expect(decodeToRealUrl('https://example.com/page#cm:testtoken:0#section')).toBe(
			'https://example.com/page#section'
		)
	})

	it('returns non-encoded URLs unchanged', () => {
		expect(decodeToRealUrl('https://example.com')).toBe('https://example.com')
		expect(decodeToRealUrl('https://example.com#section')).toBe('https://example.com#section')
	})
})

describe('generateKey', () => {
	it('produces a non-empty string', () => {
		const key = generateKey(() => 0.5)
		expect(key.length).toBeGreaterThan(0)
	})
})

// --- Migration to current (v1.2.0) ---

describe('migrateFromBetaToCurrent', () => {
	it('encodes a plain URL into v1.2.0 format', () => {
		const result = migrateFromBetaToCurrent('https://example.com', 'token-123', 5)
		expect(result).toBe('https://example.com#cm:token-123:5')
	})

	it('preserves original fragments', () => {
		const result = migrateFromBetaToCurrent('https://example.com/page#section', 'mytoken1', 2)
		expect(result).toBe('https://example.com/page#cm:mytoken1:2#section')
	})
})

describe('migrateFromV100ToCurrent', () => {
	it('converts v1.0.0 to v1.2.0 with resolved index', () => {
		const result = migrateFromV100ToCurrent('about:token-123:Work:https://example.com', 5)
		expect(result).toBe('https://example.com#cm:token-123:5')
	})

	it('preserves real URL with colons', () => {
		const result = migrateFromV100ToCurrent('about:token-123:Personal:https://example.com:8080', 2)
		expect(result).toBe('https://example.com:8080#cm:token-123:2')
	})

	it('throws for non-v1.0.0 input', () => {
		expect(() => migrateFromV100ToCurrent('about:token-123:7:https://example.com', 5)).toThrow()
	})
})

describe('migrateFromV110ToCurrent', () => {
	it('converts v1.1.0 to v1.2.0 format', () => {
		const result = migrateFromV110ToCurrent('about:token-123:7:https://example.com')
		expect(result).toBe('https://example.com#cm:token-123:7')
	})

	it('preserves fragments in the real URL', () => {
		const result = migrateFromV110ToCurrent('about:token-123:0:https://example.com/page#section')
		expect(result).toBe('https://example.com/page#cm:token-123:0#section')
	})

	it('throws for non-v1.1.0 input', () => {
		expect(() => migrateFromV110ToCurrent('https://example.com#cm:token-123:7')).toThrow()
	})
})

describe('full migration: each version to current', () => {
	it('all versions converge to the same v1.2.0 output', () => {
		const realUrl = 'https://example.com/page#section'
		const token = 'token-123'
		const containerIndex = 3

		const fromBeta = migrateFromBetaToCurrent(realUrl, token, containerIndex)
		expect(fromBeta).toBe('https://example.com/page#cm:token-123:3#section')

		const v100Url = 'about:token-123:Work:https://example.com/page#section'
		const fromV100 = migrateFromV100ToCurrent(v100Url, containerIndex)
		expect(fromV100).toBe('https://example.com/page#cm:token-123:3#section')

		const v110Url = 'about:token-123:3:https://example.com/page#section'
		const fromV110 = migrateFromV110ToCurrent(v110Url)
		expect(fromV110).toBe('https://example.com/page#cm:token-123:3#section')

		// All three produce the same output
		expect(fromBeta).toBe(fromV100)
		expect(fromV100).toBe(fromV110)

		// And it round-trips correctly
		const parsed = parseBookmarkUrl(fromV110)
		expect(parsed).toEqual({
			url: realUrl,
			token,
			containerIndex,
		})
	})
})

// --- Legacy storage helpers ---

describe('readLegacyStorageKeys', () => {
	it('returns all keys from storage', () => {
		const storage = new MemoryStorage()
		storage.setItem('key1', 'val1')
		storage.setItem('key2', 'val2')
		expect(readLegacyStorageKeys(storage)).toEqual(['key1', 'key2'])
	})

	it('returns empty array for empty storage', () => {
		const storage = new MemoryStorage()
		expect(readLegacyStorageKeys(storage)).toEqual([])
	})
})

describe('readLegacyReference', () => {
	it('parses valid beta-era JSON references', () => {
		const storage = new MemoryStorage()
		storage.setItem('ref1', JSON.stringify({ id: 'bookmark-1', container: 'Work' }))
		expect(readLegacyReference(storage, 'ref1')).toEqual({
			bookmarkId: 'bookmark-1',
			backupName: 'Work',
		})
	})

	it('returns null for missing keys', () => {
		const storage = new MemoryStorage()
		expect(readLegacyReference(storage, 'missing')).toBeNull()
	})

	it('returns null for malformed JSON', () => {
		const storage = new MemoryStorage()
		storage.setItem('bad', 'not json')
		expect(readLegacyReference(storage, 'bad')).toBeNull()
	})

	it('returns null for entries missing required fields', () => {
		const storage = new MemoryStorage()
		storage.setItem('incomplete', JSON.stringify({ id: 'bm1' }))
		expect(readLegacyReference(storage, 'incomplete')).toBeNull()
	})
})
