import * as fs from 'node:fs';
import * as path from 'node:path';

function parseEnvFile(contents: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of contents.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const eq = line.indexOf('=');
		if (eq <= 0) {
			continue;
		}
		const key = line.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			continue;
		}
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"'))
			|| (value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

/**
 * Load KEY=VALUE files into process.env without overriding existing vars.
 * Never logs values. Tries hawaldar-app/.env and the repo parent .env.
 */
export function loadDotenvFiles(roots: string[] = []): void {
	const files: string[] = [];
	const seen = new Set<string>();
	const add = (file: string) => {
		const resolved = path.resolve(file);
		if (seen.has(resolved)) {
			return;
		}
		seen.add(resolved);
		files.push(resolved);
	};
	add(path.join(process.cwd(), '.env'));
	add(path.join(process.cwd(), '..', '.env'));
	for (const root of roots) {
		if (!root) {
			continue;
		}
		add(path.join(root, '.env'));
		add(path.join(root, '..', '.env'));
	}
	for (const file of files) {
		try {
			if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
				continue;
			}
			const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
			for (const [key, value] of Object.entries(parsed)) {
				const current = process.env[key];
				if (current == null || current === '') {
					process.env[key] = value;
				}
			}
		} catch {
			/* missing or unreadable .env is fine */
		}
	}
}
