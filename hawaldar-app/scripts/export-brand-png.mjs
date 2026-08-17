/**
 * Rasterize resources/brand/hawaldar.svg geometry to a 512×512 PNG.
 * Keep polygons in sync with the SVG. No extra dependencies (zlib only).
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = 512;
const SUPER = 4;
const SRC = OUT * SUPER;
const PAD = 0.08;

const SHIELD = [
	[6, 4],
	[26, 4],
	[26, 18],
	[16, 28],
	[6, 18],
];
const PIP = [
	[22, 4],
	[26, 4],
	[26, 8],
	[22, 8],
];
const CHEVRON = [
	[10, 12],
	[16, 18],
	[22, 12],
	[20, 10],
	[16, 14],
	[12, 10],
];

const GOLD = [0xc9, 0xa2, 0x27, 0xff];
const AMBER = [0xed, 0xc8, 0x5a, 0xff];
const IVORY = [0xf3, 0xef, 0xe4, 0xff];

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c ^= buf[i];
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
		}
	}
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const t = Buffer.from(type);
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const payload = Buffer.concat([t, data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(payload));
	return Buffer.concat([len, payload, crc]);
}

function inside(x, y, pts) {
	let hit = false;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const [xi, yi] = pts[i];
		const [xj, yj] = pts[j];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
			hit = !hit;
		}
	}
	return hit;
}

function toView(px, py) {
	const inset = SRC * PAD;
	const span = SRC - inset * 2;
	return [(px - inset) * (32 / span), (py - inset) * (32 / span)];
}

const hi = Buffer.alloc(SRC * SRC * 4);
for (let y = 0; y < SRC; y++) {
	for (let x = 0; x < SRC; x++) {
		const [vx, vy] = toView(x + 0.5, y + 0.5);
		let rgba = null;
		if (inside(vx, vy, PIP)) rgba = AMBER;
		else if (inside(vx, vy, CHEVRON)) rgba = IVORY;
		else if (inside(vx, vy, SHIELD)) rgba = GOLD;
		if (!rgba) continue;
		const o = (y * SRC + x) * 4;
		hi[o] = rgba[0];
		hi[o + 1] = rgba[1];
		hi[o + 2] = rgba[2];
		hi[o + 3] = rgba[3];
	}
}

const rgba = Buffer.alloc(OUT * OUT * 4);
const cell = SUPER * SUPER;
for (let y = 0; y < OUT; y++) {
	for (let x = 0; x < OUT; x++) {
		let r = 0;
		let g = 0;
		let b = 0;
		let a = 0;
		for (let dy = 0; dy < SUPER; dy++) {
			for (let dx = 0; dx < SUPER; dx++) {
				const o = ((y * SUPER + dy) * SRC + (x * SUPER + dx)) * 4;
				const alpha = hi[o + 3];
				r += hi[o] * alpha;
				g += hi[o + 1] * alpha;
				b += hi[o + 2] * alpha;
				a += alpha;
			}
		}
		const o = (y * OUT + x) * 4;
		if (a === 0) continue;
		rgba[o] = Math.round(r / a);
		rgba[o + 1] = Math.round(g / a);
		rgba[o + 2] = Math.round(b / a);
		rgba[o + 3] = Math.round(a / cell);
	}
}

const raw = Buffer.alloc(OUT * (1 + OUT * 4));
for (let y = 0; y < OUT; y++) {
	raw[y * (1 + OUT * 4)] = 0;
	rgba.copy(raw, y * (1 + OUT * 4) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	chunk('IHDR', ihdr),
	chunk('IDAT', deflateSync(raw, { level: 9 })),
	chunk('IEND', Buffer.alloc(0)),
]);

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'brand', 'hawaldar.png');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, png);
console.log(`wrote ${dest} (${png.length} bytes)`);
