import { BackgroundApp } from './backgroundApp'
import type { BrowserApi } from './models'

declare global {
	var browser: BrowserApi
	interface Window {
		browser: BrowserApi
	}
}

const app = new BackgroundApp(globalThis.browser, globalThis.localStorage, console)
app.initialize()