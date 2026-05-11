export const ENABLE_DEBUG_DEFAULT = true
export const NO_CONTAINER = 'firefox-default'
export const HOTSWAP_STORAGE_KEY = 'containMarks.hotswaps'

/** Sentinel cookieStoreId stored in mappings to indicate "open in a fresh Temporary Container". */
export const TEMP_CONTAINER_SENTINEL = 'temp-container'

/**
 * Gecko extension IDs for both Temporary Containers variants.
 * The original (stoically) is unmaintained but still widely installed.
 * TC+ (GodKratos) is the actively-maintained fork with identical API.
 */
export const TEMP_CONTAINERS_EXTENSION_IDS = [
	'{c607c8df-14a7-4f28-894f-29e8722976af}',  // Temporary Containers (stoically)
	'{1ea2fa75-677e-4702-b06a-50fc7d06fe7e}',  // Temporary Containers Plus (GodKratos)
] as const
