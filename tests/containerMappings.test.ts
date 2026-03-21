import { describe, expect, it } from 'vitest'

import {
	buildContainerMappingUrl,
	parseContainerMappingUrl,
	parseContainerMappingBookmark
} from '../src/containerMappings'

describe('container mapping urls', () => {
	it('builds and parses mapping URLs', () => {
		const url = buildContainerMappingUrl({
			firstSeenIndex: 4,
			cookieStoreId: 'firefox-container-3',
			backupName: 'Work'
		})

		expect(url).toBe('about:4:firefox-container-3:Work')
		expect(parseContainerMappingUrl(url)).toEqual({
			firstSeenIndex: 4,
			cookieStoreId: 'firefox-container-3',
			backupName: 'Work'
		})
	})

	it('rejects malformed mapping URLs', () => {
		expect(parseContainerMappingUrl('about:not-a-number:abc:Work')).toBeNull()
		expect(parseContainerMappingUrl('about:3::')).toBeNull()
		expect(parseContainerMappingUrl('about:3::Work')).toEqual({
			firstSeenIndex: 3,
			cookieStoreId: '',
			backupName: 'Work'
		})
		expect(parseContainerMappingUrl('about:3:cookieOnly')).toEqual({
			firstSeenIndex: 3,
			cookieStoreId: 'cookieOnly',
			backupName: ''
		})
	})

	it('parses bookmark entries containing mapping URLs', () => {
		expect(parseContainerMappingBookmark({
			id: 'mapping-bookmark-1',
			type: 'bookmark',
			url: 'about:2:firefox-container-1:Personal'
		})).toEqual({
			firstSeenIndex: 2,
			cookieStoreId: 'firefox-container-1',
			backupName: 'Personal'
		})
	})
})
