import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_BYTES = 80 * 1024 * 1024;

export function assertLocalFile(filePath: string, extensions?: RegExp): string {
	const resolved = path.resolve(filePath);
	if (resolved.includes('..') || /[\s;|&$`<>]/.test(resolved)) {
		throw new Error('File path failed safety checks.');
	}
	if (extensions && !extensions.test(resolved)) {
		throw new Error('File type is not allowed for this tool.');
	}
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
		throw new Error(`File not found: ${resolved}`);
	}
	if (fs.statSync(resolved).size > MAX_BYTES) {
		throw new Error('File is larger than 80MB.');
	}
	return resolved;
}

export function fileHash(filePath: string): string {
	const hash = createHash('sha256');
	hash.update(fs.readFileSync(filePath));
	return hash.digest('hex');
}
