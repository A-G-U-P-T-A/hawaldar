import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const SPLASH_FONTS = [
	'Poppins-Regular.ttf',
	'Poppins-Medium.ttf',
	'Poppins-Bold.ttf',
	'MaterialSymbolsOutlined.woff2',
];

function copySplashHtml(): void {
	const destDir = resolve('out/renderer');
	const fontDest = resolve(destDir, 'fonts');
	const fontSrc = resolve('src/renderer/src/assets/fonts');
	mkdirSync(fontDest, { recursive: true });
	copyFileSync(resolve('src/renderer/splash.html'), resolve(destDir, 'splash.html'));
	for (const name of SPLASH_FONTS) {
		copyFileSync(resolve(fontSrc, name), resolve(fontDest, name));
	}
}

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
		server: {
			host: '127.0.0.1',
			port: 5173,
			strictPort: false,
		},
		publicDir: resolve('resources/brand'),
		optimizeDeps: {
			exclude: ['pdfjs-dist'],
		},
		resolve: {
			alias: {
				'@renderer': resolve('src/renderer/src'),
			},
		},
		plugins: [
			react(),
			{
				name: 'hawaldar-copy-splash',
				buildStart() {
					copySplashHtml();
				},
				closeBundle() {
					copySplashHtml();
				},
			},
		],
	},
});
