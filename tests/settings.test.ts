import { describe, expect, it } from 'vitest'

import {
	DEFAULT_SETTINGS,
	hasRiskyTokenBehavior,
	sanitizeSettings,
	validateSettings
} from '../src/settings'

describe('settings helpers', () => {
	it('returns defaults for invalid payloads', () => {
		expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
		expect(sanitizeSettings('bad-value')).toEqual(DEFAULT_SETTINGS)
	})

	it('sanitizes partial payloads and keeps safe defaults', () => {
		const settings = sanitizeSettings({
			targetFolderId: 'menu________',
			regenerateTokenOnEveryUse: false
		})

		expect(settings).toEqual({
			targetFolderId: 'menu________',
			resetTokensOnStartup: false,
			regenerateTokenOnEveryUse: false,
			acknowledgeRiskyTokenBehavior: false,
			showPageActionButton: true,
			enableBookmarkSync: true,
			allowEncodedBookmarkImport: false
		})
	})

	it('forces safe retention settings when risk acknowledgement is missing', () => {
		const validated = validateSettings({
			targetFolderId: 'menu________',
			resetTokensOnStartup: true,
			regenerateTokenOnEveryUse: false,
			acknowledgeRiskyTokenBehavior: false,
			showPageActionButton: true,
			enableBookmarkSync: true,
			allowEncodedBookmarkImport: false
		})

		expect(validated).toEqual({
			targetFolderId: 'menu________',
			resetTokensOnStartup: false,
			regenerateTokenOnEveryUse: true,
			acknowledgeRiskyTokenBehavior: false,
			showPageActionButton: true,
			enableBookmarkSync: true,
			allowEncodedBookmarkImport: false
		})
	})

	it('marks custom retention settings as risky', () => {
		expect(hasRiskyTokenBehavior({
			targetFolderId: 'toolbar_____',
			resetTokensOnStartup: false,
			regenerateTokenOnEveryUse: true,
			acknowledgeRiskyTokenBehavior: false,
			showPageActionButton: true,
			enableBookmarkSync: true,
			allowEncodedBookmarkImport: false
		})).toBe(false)

		expect(hasRiskyTokenBehavior({
			targetFolderId: 'toolbar_____',
			resetTokensOnStartup: true,
			regenerateTokenOnEveryUse: true,
			acknowledgeRiskyTokenBehavior: true,
			showPageActionButton: true,
			enableBookmarkSync: true,
			allowEncodedBookmarkImport: false
		})).toBe(true)
	})
})
