import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
	main: {
		build: {
			rollupOptions: {
				input: {
					index: resolve('src/main/index.ts'),
				},
			},
		},
	},
	preload: {
		build: {
			rollupOptions: {
				input: {
					index: resolve('src/preload/index.ts'),
				},
			},
		},
	},
	renderer: {
		publicDir: resolve('resources/brand'),
		resolve: {
			alias: {
				'@renderer': resolve('src/renderer/src'),
			},
		},
		plugins: [react()],
	},
});
