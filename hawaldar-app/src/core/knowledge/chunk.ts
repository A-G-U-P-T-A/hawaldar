import { clipSnippet } from '../session-meta';
import type { KnowledgeChunk, KnowledgeDoc } from './types';

const TARGET = 900;
const OVERLAP = 120;

export function chunkDocument(doc: KnowledgeDoc): KnowledgeChunk[] {
	const text = doc.text.replace(/\r\n/g, '\n').trim();
	if (!text) {
		return [];
	}
	const blocks = splitBlocks(text);
	const pieces: string[] = [];
	let buf = '';
	for (const block of blocks) {
		if (!buf) {
			buf = block;
			continue;
		}
		if (buf.length + 2 + block.length <= TARGET) {
			buf = `${buf}\n\n${block}`;
			continue;
		}
		pieces.push(buf);
		const keep = buf.slice(Math.max(0, buf.length - OVERLAP));
		buf = keep && keep.length < block.length + OVERLAP ? `${keep}\n\n${block}` : block;
	}
	if (buf.trim()) {
		pieces.push(buf);
	}
	return pieces.map((piece, index) => ({
		id: `${doc.id}:${index}`,
		docId: doc.id,
		kind: doc.kind,
		sourceId: doc.sourceId,
		title: doc.title,
		text: piece.trim(),
		index,
	}));
}

export function docFromSource(input: {
	kind: KnowledgeDoc['kind'];
	sourceId: string;
	title: string;
	text: string;
	updatedAt?: number;
}): KnowledgeDoc {
	const text = input.text.replace(/\r\n/g, '\n').trim();
	return {
		id: `${input.kind}:${input.sourceId}`,
		kind: input.kind,
		sourceId: input.sourceId,
		title: input.title.trim() || input.sourceId,
		text,
		snippet: clipSnippet(text, 220),
		updatedAt: input.updatedAt ?? Date.now(),
	};
}

function splitBlocks(text: string): string[] {
	const raw = text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
	const out: string[] = [];
	for (const block of raw) {
		if (block.length <= TARGET * 1.4) {
			out.push(block);
			continue;
		}
		const lines = block.split('\n');
		let cur = '';
		for (const line of lines) {
			if (cur.length + line.length + 1 > TARGET && cur) {
				out.push(cur);
				cur = line;
			} else {
				cur = cur ? `${cur}\n${line}` : line;
			}
		}
		if (cur) {
			out.push(cur);
		}
	}
	return out.length > 0 ? out : [text.slice(0, TARGET)];
}
