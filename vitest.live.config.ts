import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/live/**/*.live.test.ts'],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		// One Firefox per file; files share an Xvfb display range, so keep them serial.
		fileParallelism: false,
	}
})
