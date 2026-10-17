/** Starts a live Firefox (see firefox-addon-live) with ContainMarks loaded from `src/`. */

import { resolve } from 'node:path'
import { FirefoxSession, type FirefoxSessionOptions } from 'firefox-addon-live'

export const EXTENSION_ID = 'cont@bmarks'
export const EXTENSION_SOURCE = resolve(import.meta.dirname, '../../src')

/** Run `npm run build` first; the add-on loads from the built `src/`. */
export function startContainMarks(options: Omit<FirefoxSessionOptions, 'addon'> = {}): Promise<FirefoxSession> {
	return FirefoxSession.start({ ...options, addon: { source: EXTENSION_SOURCE, id: EXTENSION_ID } })
}
