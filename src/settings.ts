import type { BrowserApi, ContainMarksSettings } from './models'

export const SETTINGS_STORAGE_KEY = 'containMarks.settings'
export const DEFAULT_TARGET_FOLDER_ID = 'toolbar_____'

export const DEFAULT_SETTINGS: ContainMarksSettings = {
	targetFolderId: DEFAULT_TARGET_FOLDER_ID,
	resetTokensOnStartup: false,
	regenerateTokenOnEveryUse: true,
	acknowledgeRiskyTokenBehavior: false,
	showPageActionButton: true,
	enableBookmarkSync: true
}

export function sanitizeSettings(value: unknown): ContainMarksSettings {
	if (value === null || typeof value !== 'object') {
		return { ...DEFAULT_SETTINGS }
	}

	const candidate = value as Partial<ContainMarksSettings>
	const targetFolderId =
		typeof candidate.targetFolderId === 'string' && candidate.targetFolderId.length > 0
			? candidate.targetFolderId
			: DEFAULT_SETTINGS.targetFolderId

	return {
		targetFolderId,
		resetTokensOnStartup: candidate.resetTokensOnStartup ?? DEFAULT_SETTINGS.resetTokensOnStartup,
		regenerateTokenOnEveryUse: candidate.regenerateTokenOnEveryUse ?? DEFAULT_SETTINGS.regenerateTokenOnEveryUse,
		acknowledgeRiskyTokenBehavior: candidate.acknowledgeRiskyTokenBehavior ?? DEFAULT_SETTINGS.acknowledgeRiskyTokenBehavior,
		showPageActionButton: candidate.showPageActionButton ?? DEFAULT_SETTINGS.showPageActionButton,
		enableBookmarkSync: candidate.enableBookmarkSync ?? DEFAULT_SETTINGS.enableBookmarkSync
	}
}

export function hasRiskyTokenBehavior(settings: ContainMarksSettings): boolean {
	return settings.resetTokensOnStartup || settings.regenerateTokenOnEveryUse === false
}

export function validateSettings(settings: ContainMarksSettings): ContainMarksSettings {
	if (hasRiskyTokenBehavior(settings) && !settings.acknowledgeRiskyTokenBehavior) {
		return {
			...settings,
			resetTokensOnStartup: DEFAULT_SETTINGS.resetTokensOnStartup,
			regenerateTokenOnEveryUse: DEFAULT_SETTINGS.regenerateTokenOnEveryUse
		}
	}

	return settings
}

export async function loadSettings(browserApi: BrowserApi): Promise<ContainMarksSettings> {
	const payload = await browserApi.storage.local.get(SETTINGS_STORAGE_KEY)
	return sanitizeSettings(payload[SETTINGS_STORAGE_KEY])
}

export async function saveSettings(browserApi: BrowserApi, settings: ContainMarksSettings): Promise<ContainMarksSettings> {
	const sanitized = validateSettings(sanitizeSettings(settings))
	await browserApi.storage.local.set({ [SETTINGS_STORAGE_KEY]: sanitized })
	return sanitized
}
