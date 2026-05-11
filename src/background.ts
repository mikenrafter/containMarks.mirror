import { ContainMarksRuntimeImpl } from './background/containMarksRuntime'
import type { BrowserApi } from './models'

declare global {
	var browser: BrowserApi
	interface Window {
		browser: BrowserApi
	}
}

const runtime = new ContainMarksRuntimeImpl({
	browserApi: globalThis.browser,
	storage: globalThis.localStorage,
	logger: console,
	randomValue: Math.random,
})
runtime.initialize()