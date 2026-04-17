import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BookmarkAssignmentManagerImpl } from '../src/background/bookmarkAssignmentManager'
import type { BookmarkAssignmentManagerDeps } from '../src/background/bookmarkAssignmentManager'
import type {
	BookmarkNode,
	BrowserApi,
	ContainMarksSettings,
	ContextualIdentity,
	HotswapRecord,
	StorageLike,
} from '../src/models'
import { NO_CONTAINER, TEMP_CONTAINER_SENTINEL, HOTSWAP_STORAGE_KEY } from '../src/constants'
import { getNewUrl, isFragmentEncodedUrl, parseBookmarkUrl } from '../src/urlCodec'

// --- Test helpers ---

function createMockBrowserApi(): BrowserApi {
	return {
		bookmarks: {
			search: vi.fn().mockResolvedValue([]),
			get: vi.fn().mockResolvedValue([]),
			getTree: vi.fn().mockResolvedValue([]),
			getChildren: vi.fn().mockResolvedValue([]),
			remove: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue({ id: 'b1', type: 'bookmark' }),
			create: vi.fn().mockResolvedValue({ id: 'b1', type: 'bookmark' }),
			onRemoved: { addListener: vi.fn() },
			onChanged: { addListener: vi.fn() },
			onCreated: { addListener: vi.fn() },
		},
		menus: {
			create: vi.fn(),
			refresh: vi.fn(),
			removeAll: vi.fn(),
			onClicked: { addListener: vi.fn() },
			onShown: { addListener: vi.fn() },
			onHidden: { addListener: vi.fn() },
		},
		contextualIdentities: {
			query: vi.fn().mockResolvedValue([
				{ cookieStoreId: 'firefox-container-1', name: 'Personal', icon: 'fingerprint', color: 'blue' },
				{ cookieStoreId: 'firefox-container-2', name: 'Work', icon: 'briefcase', color: 'orange' },
			]),
			get: vi.fn().mockImplementation(async (id: string) => ({
				cookieStoreId: id, name: `Container ${id}`, icon: 'circle', color: 'blue',
			})),
		},
		tabs: {
			TAB_ID_NONE: -1,
			create: vi.fn().mockResolvedValue(undefined),
			remove: vi.fn().mockResolvedValue(undefined),
			get: vi.fn().mockResolvedValue({ id: 1, index: 0 }),
			update: vi.fn().mockResolvedValue({ id: 1, index: 0 }),
			query: vi.fn().mockResolvedValue([]),
			highlight: vi.fn().mockResolvedValue(undefined),
			onActivated: { addListener: vi.fn() },
			onUpdated: { addListener: vi.fn() },
			onCreated: { addListener: vi.fn() },
		},
		windows: { onCreated: { addListener: vi.fn() } },
		notifications: { create: vi.fn().mockResolvedValue('nid') },
		pageAction: {
			isShown: vi.fn().mockResolvedValue(false),
			setTitle: vi.fn().mockResolvedValue(undefined),
			show: vi.fn().mockResolvedValue(undefined),
			hide: vi.fn().mockResolvedValue(undefined),
			onClicked: { addListener: vi.fn() },
		},
		webNavigation: { onBeforeNavigate: { addListener: vi.fn() } },
		webRequest: { onBeforeRequest: { addListener: vi.fn() } },
		management: { get: vi.fn().mockRejectedValue(new Error('not found')) },
		runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) },
		storage: {
			local: {
				get: vi.fn().mockResolvedValue({}),
				set: vi.fn().mockResolvedValue(undefined),
			},
		},
	}
}

function createDefaultSettings(): ContainMarksSettings {
	return {
		targetFolderId: 'toolbar_____',
		resetTokensOnStartup: false,
		regenerateTokenOnEveryUse: false,
		acknowledgeRiskyTokenBehavior: false,
		showPageActionButton: true,
		enableBookmarkSync: false,
		allowEncodedBookmarkImport: false,
	}
}

function createMockDeps(overrides: Partial<BookmarkAssignmentManagerDeps> = {}): {
	deps: BookmarkAssignmentManagerDeps
	browserApi: BrowserApi
} {
	const browserApi = createMockBrowserApi()
	const settings = createDefaultSettings()

	const mappingsByIndex = new Map<number, { firstSeenIndex: number; cookieStoreId: string; backupName: string }>()
	const mappingsByCookieStoreId = new Map<string, { firstSeenIndex: number; cookieStoreId: string; backupName: string }>()

	const mappingStore = {
		initialize: vi.fn().mockResolvedValue(undefined),
		getByIndex: vi.fn().mockImplementation((idx: number) => mappingsByIndex.get(idx) ?? null),
		getByCookieStoreId: vi.fn().mockImplementation((id: string) => mappingsByCookieStoreId.get(id) ?? null),
		ensureMappingForContainer: vi.fn().mockImplementation(async (container: ContextualIdentity) => {
			const idx = mappingsByIndex.size
			const record = { firstSeenIndex: idx, cookieStoreId: container.cookieStoreId, backupName: container.name }
			mappingsByIndex.set(idx, record)
			mappingsByCookieStoreId.set(container.cookieStoreId, record)
			return record
		}),
		getRecords: vi.fn().mockReturnValue([]),
		_addMapping(index: number, cookieStoreId: string, name: string = `Container ${cookieStoreId}`) {
			const record = { firstSeenIndex: index, cookieStoreId, backupName: name }
			mappingsByIndex.set(index, record)
			mappingsByCookieStoreId.set(cookieStoreId, record)
			return record
		},
	}

	const deps: BookmarkAssignmentManagerDeps = {
		browserApi,
		storage: { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} } as StorageLike,
		logger: { log: vi.fn() },
		randomValue: () => 0.5,
		settings: vi.fn().mockResolvedValue(settings),
		mappingStore: vi.fn().mockReturnValue(mappingStore),
		...overrides,
	}

	return { deps, browserApi }
}

// --- Tests ---

describe('BookmarkAssignmentManagerImpl', () => {
	describe('initialize', () => {
		it('detects TC extension and builds menu', async () => {
			const { deps, browserApi } = createMockDeps()
			;(browserApi.management.get as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true, name: 'TC' })
			const bam = new BookmarkAssignmentManagerImpl(deps)

			await bam.initialize()

			expect(bam.tempContainersExtensionId).not.toBeNull()
			expect(browserApi.menus.create).toHaveBeenCalled()
		})

		it('sets tempContainersExtensionId to null when no TC installed', async () => {
			const { deps } = createMockDeps()
			const bam = new BookmarkAssignmentManagerImpl(deps)

			await bam.initialize()

			expect(bam.tempContainersExtensionId).toBeNull()
		})
	})

	describe('getContainer', () => {
		it('resolves by cookieStoreId', async () => {
			const { deps } = createMockDeps()
			const bam = new BookmarkAssignmentManagerImpl(deps)

			const result = await bam.getContainer({ cookieStoreId: 'firefox-container-1' })
			expect(result).not.toBeNull()
			expect(result!.cookieStoreId).toBe('firefox-container-1')
		})

		it('returns null for NO_CONTAINER', async () => {
			const { deps } = createMockDeps()
			const bam = new BookmarkAssignmentManagerImpl(deps)

			expect(await bam.getContainer({ cookieStoreId: NO_CONTAINER })).toBeNull()
		})

		it('returns null when neither cookieStoreId nor backupName provided', async () => {
			const { deps } = createMockDeps()
			const bam = new BookmarkAssignmentManagerImpl(deps)

			expect(await bam.getContainer({})).toBeNull()
		})

		it('falls back to backupName when cookieStoreId not found', async () => {
			const { deps, browserApi } = createMockDeps()
			;(browserApi.contextualIdentities.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not found'))
			;(browserApi.contextualIdentities.query as ReturnType<typeof vi.fn>).mockResolvedValue([
				{ cookieStoreId: 'firefox-container-3', name: 'Personal', icon: 'circle', color: 'blue' }
			])
			const bam = new BookmarkAssignmentManagerImpl(deps)

			const result = await bam.getContainer({ cookieStoreId: 'nonexistent', backupName: 'Personal' })
			// cookieStoreId lookup failed, so falls back to name-based resolution
			expect(result?.cookieStoreId).toBe('firefox-container-3')
		})
	})

	describe('isTempContainer', () => {
		it('returns false when no TC extension installed', async () => {
			const { deps } = createMockDeps()
			const bam = new BookmarkAssignmentManagerImpl(deps)
			await bam.initialize()

			expect(await bam.isTempContainer('firefox-container-42')).toBe(false)
		})

		it('returns true when TC API confirms temporary', async () => {
			const { deps, browserApi } = createMockDeps()
			;(browserApi.management.get as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true, name: 'TC' })
			;(browserApi.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(true)
			const bam = new BookmarkAssignmentManagerImpl(deps)
			await bam.initialize()

			expect(await bam.isTempContainer('firefox-container-42')).toBe(true)
		})

		it('returns false when TC API throws', async () => {
			const { deps, browserApi } = createMockDeps()
			;(browserApi.management.get as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true, name: 'TC' })
			;(browserApi.runtime.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'))
			const bam = new BookmarkAssignmentManagerImpl(deps)
			await bam.initialize()

			expect(await bam.isTempContainer('firefox-container-1')).toBe(false)
		})
	})

	describe('updateBookmarkContainerUrl', () => {
		it('assigns container to bookmark', async () => {
			const { deps, browserApi } = createMockDeps()
			const bam = new BookmarkAssignmentManagerImpl(deps)
			const bookmark: BookmarkNode = { id: 'bm1', type: 'bookmark', url: 'https://example.com' }

			const result = await bam.updateBookmarkContainerUrl(bookmark, 'firefox-container-1')

			expect(result).not.toBeNull()
			expect(result!.cookieStoreId).toBe('firefox-container-1')
			expect(browserApi.bookmarks.update).toHaveBeenCalledWith('bm1', {
				url: expect.stringMatching(/^https:\/\/example\.com#cm:/)
			})
		})

		it('strips container when assigned to NO_CONTAINER', async () => {
			const { deps, browserApi } = createMockDeps()
			const bam = new BookmarkAssignmentManagerImpl(deps)
			const encodedUrl = getNewUrl({ value: 'testtoken' }, 0, 'https://example.com')
			const bookmark: BookmarkNode = { id: 'bm1', type: 'bookmark', url: encodedUrl }

			const result = await bam.updateBookmarkContainerUrl(bookmark, NO_CONTAINER)

			expect(result).not.toBeNull()
			expect(result!.cookieStoreId).toBe(NO_CONTAINER)
			expect(browserApi.bookmarks.update).toHaveBeenCalledWith('bm1', { url: 'https://example.com' })
		})

		it('returns null when bookmark has invalid url', async () => {
			const { deps } = createMockDeps()
			const bam = new BookmarkAssignmentManagerImpl(deps)
			const bookmark: BookmarkNode = { id: 'bm1', type: 'bookmark', url: '' }

			expect(await bam.updateBookmarkContainerUrl(bookmark)).toBeNull()
		})

		it('assigns TEMP_CONTAINER_SENTINEL for temp containers', async () => {
			const { deps, browserApi } = createMockDeps()
			const bam = new BookmarkAssignmentManagerImpl(deps)
			const bookmark: BookmarkNode = { id: 'bm1', type: 'bookmark', url: 'https://example.com' }

			const result = await bam.updateBookmarkContainerUrl(bookmark, TEMP_CONTAINER_SENTINEL)

			expect(result).not.toBeNull()
			expect(result!.cookieStoreId).toBe(TEMP_CONTAINER_SENTINEL)
		})
	})

	describe('handleMenuClick', () => {
		it('applies container to bookmark', async () => {
			const { deps, browserApi } = createMockDeps()
			const bookmark: BookmarkNode = { id: 'bm1', type: 'bookmark', url: 'https://example.com' }
			;(browserApi.bookmarks.get as ReturnType<typeof vi.fn>).mockResolvedValue([bookmark])
			const bam = new BookmarkAssignmentManagerImpl(deps)

			await bam.handleMenuClick({ bookmarkId: 'bm1', menuItemId: 'firefox-container-1' })

			expect(browserApi.bookmarks.update).toHaveBeenCalled()
		})
	})

	describe('handleMenuShown', () => {
		it('rebuilds menu and hotswaps encoded bookmark', async () => {
			const { deps, browserApi } = createMockDeps()
			const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
			mappingStore._addMapping(1, 'firefox-container-1')

			const encodedUrl = getNewUrl({ value: 'testtoken' }, 1, 'https://example.com')
			const bookmark: BookmarkNode = { id: 'bm1', type: 'bookmark', url: encodedUrl }
			;(browserApi.bookmarks.get as ReturnType<typeof vi.fn>).mockResolvedValue([bookmark])

			const bam = new BookmarkAssignmentManagerImpl(deps)
			await bam.handleMenuShown({ contexts: ['bookmark'], bookmarkId: 'bm1' })

			// Should decode bookmark for Properties dialog
			expect(browserApi.bookmarks.update).toHaveBeenCalledWith('bm1', { url: 'https://example.com' })
			// Should register decoded URL in hotswap redirect map
			expect(bam.hotswapRedirectMap.has('https://example.com')).toBe(true)
			// Should persist hotswap state
			expect(browserApi.storage.local.set).toHaveBeenCalled()
		})

		it('does nothing for separators', async () => {
			const { deps, browserApi } = createMockDeps()
			const separator: BookmarkNode = { id: 'sep1', type: 'separator' }
			;(browserApi.bookmarks.get as ReturnType<typeof vi.fn>).mockResolvedValue([separator])
			const bam = new BookmarkAssignmentManagerImpl(deps)

			await bam.handleMenuShown({ contexts: ['bookmark'], bookmarkId: 'sep1' })

			expect(browserApi.menus.refresh).toHaveBeenCalled()
			expect(browserApi.bookmarks.update).not.toHaveBeenCalled()
		})
	})

	describe('handleMenuHidden', () => {
		it('sets revert timer that restores encoded URL after delay', async () => {
			vi.useFakeTimers()
			try {
				const { deps, browserApi } = createMockDeps()
				const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
				mappingStore._addMapping(1, 'firefox-container-1')

				const encodedUrl = getNewUrl({ value: 'testtoken' }, 1, 'https://example.com')
				const bookmark: BookmarkNode = { id: 'bm1', type: 'bookmark', url: encodedUrl }
				;(browserApi.bookmarks.get as ReturnType<typeof vi.fn>).mockResolvedValue([bookmark])

				const bam = new BookmarkAssignmentManagerImpl(deps)
				await bam.handleMenuShown({ contexts: ['bookmark'], bookmarkId: 'bm1' })

				// After handleMenuShown, bookmark.update was called to decode. Clear to track revert.
				;(browserApi.bookmarks.update as ReturnType<typeof vi.fn>).mockClear()

				await bam.handleMenuHidden()

				// Redirect map populated immediately
				expect(bam.hotswapRedirectMap.has('https://example.com')).toBe(true)

				// Before timer fires: no revert yet
				expect(browserApi.bookmarks.update).not.toHaveBeenCalled()

				// Advance past revert delay (200ms)
				await vi.advanceTimersByTimeAsync(250)

				// Revert should have restored the original encoded URL
				expect(browserApi.bookmarks.update).toHaveBeenCalledWith('bm1', { url: encodedUrl })
				// Redirect map should be cleaned up after revert
				expect(bam.hotswapRedirectMap.has('https://example.com')).toBe(false)
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe('handleBookmarkChanged', () => {
		it('re-encodes on user edit during hotswap', async () => {
			vi.useFakeTimers()
			try {
				const { deps, browserApi } = createMockDeps()
				const mappingStore = (deps.mappingStore as ReturnType<typeof vi.fn>)()
				mappingStore._addMapping(1, 'firefox-container-1')

				const encodedUrl = getNewUrl({ value: 'testtoken' }, 1, 'https://example.com')
				const bookmark: BookmarkNode = { id: 'bm1', type: 'bookmark', url: encodedUrl }
				;(browserApi.bookmarks.get as ReturnType<typeof vi.fn>).mockResolvedValue([bookmark])

				const bam = new BookmarkAssignmentManagerImpl(deps)
				// Trigger hotswap: decodes the bookmark, adds bm1 to selfUpdateBookmarkIds
				await bam.handleMenuShown({ contexts: ['bookmark'], bookmarkId: 'bm1' })
                await bam.handleMenuHidden() // sets revert timer

				// Simulate the browser firing onChanged for the self-update (decode)
				await bam.handleBookmarkChanged('bm1', { url: 'https://example.com' })

				// Now simulate the user changing the URL in Properties dialog
				await bam.handleBookmarkChanged('bm1', { url: 'https://new-example.com' })

				// Should re-encode with new URL, same container index
				expect(browserApi.bookmarks.update).toHaveBeenLastCalledWith('bm1', {
					url: expect.stringMatching(/^https:\/\/new-example\.com#cm:/)
				})
			} finally {
				vi.useRealTimers()
			}
		})

		it('ignores self-updates', async () => {
			const { deps, browserApi } = createMockDeps()
			const bam = new BookmarkAssignmentManagerImpl(deps)

			// Simulate a self-update via updateBookmarkContainerUrl
			const bookmark: BookmarkNode = { id: 'bm1', type: 'bookmark', url: 'https://example.com' }
			await bam.updateBookmarkContainerUrl(bookmark, 'firefox-container-1')

			// This change should be ignored (selfUpdateBookmarkIds contains 'bm1')
			const updateCallCount = (browserApi.bookmarks.update as ReturnType<typeof vi.fn>).mock.calls.length
			await bam.handleBookmarkChanged('bm1', { url: 'https://something-else.com' })

			// No additional update call
			expect((browserApi.bookmarks.update as ReturnType<typeof vi.fn>).mock.calls.length).toBe(updateCallCount)
		})
	})

	describe('handleBookmarkCreated', () => {
		it('strips encoding from new bookmark with no duplicate', async () => {
			const { deps, browserApi } = createMockDeps()
			const encodedUrl = getNewUrl({ value: 'testtoken' }, 0, 'https://example.com')
			;(browserApi.bookmarks.search as ReturnType<typeof vi.fn>).mockResolvedValue([
				{ id: 'bm1', type: 'bookmark', url: encodedUrl }
			])
			const bam = new BookmarkAssignmentManagerImpl(deps)

			await bam.handleBookmarkCreated('bm1', { id: 'bm1', type: 'bookmark', url: encodedUrl })

			expect(browserApi.bookmarks.update).toHaveBeenCalledWith('bm1', { url: 'https://example.com' })
		})

		it('preserves encoding when duplicate exists', async () => {
			const { deps, browserApi } = createMockDeps()
			const encodedUrl = getNewUrl({ value: 'testtoken' }, 0, 'https://example.com')
			;(browserApi.bookmarks.search as ReturnType<typeof vi.fn>).mockResolvedValue([
				{ id: 'bm1', type: 'bookmark', url: encodedUrl },
				{ id: 'bm2', type: 'bookmark', url: encodedUrl },
			])
			const bam = new BookmarkAssignmentManagerImpl(deps)

			await bam.handleBookmarkCreated('bm1', { id: 'bm1', type: 'bookmark', url: encodedUrl })

			expect(browserApi.bookmarks.update).not.toHaveBeenCalled()
		})

		it('skips stripping when allowEncodedBookmarkImport is enabled', async () => {
			const settings = createDefaultSettings()
			settings.allowEncodedBookmarkImport = true
			const { deps, browserApi } = createMockDeps({
				settings: vi.fn().mockResolvedValue(settings),
			})
			const encodedUrl = getNewUrl({ value: 'testtoken' }, 0, 'https://example.com')
			const bam = new BookmarkAssignmentManagerImpl(deps)

			await bam.handleBookmarkCreated('bm1', { id: 'bm1', type: 'bookmark', url: encodedUrl })

			expect(browserApi.bookmarks.update).not.toHaveBeenCalled()
		})

		it('ignores non-encoded bookmarks', async () => {
			const { deps, browserApi } = createMockDeps()
			const bam = new BookmarkAssignmentManagerImpl(deps)

			await bam.handleBookmarkCreated('bm1', { id: 'bm1', type: 'bookmark', url: 'https://plain.com' })

			expect(browserApi.bookmarks.update).not.toHaveBeenCalled()
		})
	})

	describe('recoverPendingHotswaps', () => {
		it('re-encodes decoded bookmarks from storage', async () => {
			const { deps, browserApi } = createMockDeps()
			const records: Record<string, HotswapRecord> = {
				'bm1': { encodedUrl: 'https://example.com#cm:tok:1:https://example.com', containerIndex: 1 }
			}
			;(browserApi.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
				[HOTSWAP_STORAGE_KEY]: records
			})
			;(browserApi.bookmarks.get as ReturnType<typeof vi.fn>).mockResolvedValue([
				{ id: 'bm1', url: 'https://example.com' } // decoded state
			])

			const bam = new BookmarkAssignmentManagerImpl(deps)
			await bam.recoverPendingHotswaps()

			expect(browserApi.bookmarks.update).toHaveBeenCalledWith('bm1', {
				url: expect.stringMatching(/^https:\/\/example\.com#cm:/)
			})
			// Should clear storage after recovery
			expect(browserApi.storage.local.set).toHaveBeenCalledWith({ [HOTSWAP_STORAGE_KEY]: {} })
		})

		it('skips already-encoded bookmarks', async () => {
			const { deps, browserApi } = createMockDeps()
			const encodedUrl = getNewUrl({ value: 'testtoken' }, 1, 'https://example.com')
			const records: Record<string, HotswapRecord> = {
				'bm1': { encodedUrl, containerIndex: 1 }
			}
			;(browserApi.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
				[HOTSWAP_STORAGE_KEY]: records
			})
			;(browserApi.bookmarks.get as ReturnType<typeof vi.fn>).mockResolvedValue([
				{ id: 'bm1', url: encodedUrl } // already encoded
			])

			const bam = new BookmarkAssignmentManagerImpl(deps)
			await bam.recoverPendingHotswaps()

			expect(browserApi.bookmarks.update).not.toHaveBeenCalled()
		})
	})

	describe('createMenuItems', () => {
		it('creates menu root and container items', async () => {
			const { deps, browserApi } = createMockDeps()
			const bam = new BookmarkAssignmentManagerImpl(deps)

			await bam.createMenuItems()

			// Root + No Container + separator + 2 containers = at least 4 calls
			expect((browserApi.menus.create as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(4)
			expect(browserApi.menus.refresh).toHaveBeenCalled()
		})

		it('filters out temp containers when TC is installed', async () => {
			const { deps, browserApi } = createMockDeps()
			;(browserApi.management.get as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true, name: 'TC' })
			;(browserApi.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (_id, msg) => {
				return msg.cookieStoreId === 'firefox-container-2'
			})
			const bam = new BookmarkAssignmentManagerImpl(deps)
			await bam.initialize()

			;(browserApi.menus.create as ReturnType<typeof vi.fn>).mockClear()
			await bam.createMenuItems()

			// Should include TEMP_CONTAINER_SENTINEL item but filter out container-2
			const createCalls = (browserApi.menus.create as ReturnType<typeof vi.fn>).mock.calls
			const menuItemIds = createCalls.map((call: unknown[]) => (call[0] as { id?: string }).id).filter(Boolean)
			expect(menuItemIds).toContain(TEMP_CONTAINER_SENTINEL)
			expect(menuItemIds).toContain('firefox-container-1')
			expect(menuItemIds).not.toContain('firefox-container-2')
		})
	})
})
