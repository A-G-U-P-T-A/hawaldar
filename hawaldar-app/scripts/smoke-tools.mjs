/**
 * Hawaldar tool smoke test — runs OUTSIDE Electron.
 *
 *   node scripts/smoke-tools.mjs
 *
 * Bundles scripts/smoke-tools-entry.ts with esbuild (electron stubbed), then
 * executes every non-gated tool against the running Juice Shop lab
 * (http://127.0.0.1:3000) and loopback, asserting a defined {ok, stdout}
 * result. HITL-gated PoC/intrusive tools are listed as SKIPPED, never run.
 * Exits non-zero if any non-gated tool throws, returns undefined, or fails.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, '..');
process.chdir(appRoot);

// Bundle lives inside the app dir so externalized packages resolve node_modules.
const outfile = path.join(scriptDir, `.smoke-tools.bundle.${process.pid}.mjs`);

await build({
	entryPoints: [path.join(scriptDir, 'smoke-tools-entry.ts')],
	outfile,
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	logLevel: 'warning',
	packages: 'external',
	banner: {
		js: [
			"import { createRequire } from 'node:module';",
			"import * as path from 'node:path';",
			"import { fileURLToPath } from 'node:url';",
			'const require = createRequire(import.meta.url);',
			'const __dirname = path.dirname(fileURLToPath(import.meta.url));',
		].join('\n'),
	},
	alias: { electron: path.join(scriptDir, 'electron-stub.mjs') },
});

try {
	const mod = await import(pathToFileURL(outfile).href);
	const rows = [];
	await mod.runSmoke(appRoot, (row) => {
		rows.push(row);
		const detail = row.detail ? `  ${row.detail}` : '';
		console.log(`${row.status.padEnd(4)}  ${row.id.padEnd(20)} ${String(row.ms).padStart(7)}ms${detail}`);
	});

	const pass = rows.filter((r) => r.status === 'PASS').length;
	const fail = rows.filter((r) => r.status === 'FAIL').length;
	const skip = rows.filter((r) => r.status === 'SKIP').length;
	console.log('');
	console.log(`${pass} passed, ${fail} failed, ${skip} skipped (${rows.length} total)`);
	if (fail > 0) {
		console.log('FAILED:');
		for (const row of rows.filter((r) => r.status === 'FAIL')) {
			console.log(`  ${row.id}: ${row.detail}`);
		}
	}
	process.exitCode = fail > 0 ? 1 : 0;
} finally {
	fs.rmSync(outfile, { force: true });
}
