/** Mastra working-memory scratchpad. Kept small so tool calls cannot balloon. */

export const WORKING_MEMORY_TEMPLATE = `# Engagement
- Targets:
- Scope notes:
- Findings:
- Open questions:
- Last tools:
`;

export const MAX_WORKING_MEMORY_CHARS = 4_000;

const HEADING = '# Engagement';

function normalize(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function isEmptyWorkingMemoryTemplate(text: string): boolean {
	const stripped = normalize(text)
		.replace(/^# Engagement\s*/i, '')
		.replace(/^-\s*(Targets|Scope notes|Findings|Open questions|Last tools):\s*$/gim, '')
		.trim();
	return stripped.length === 0;
}

/** Keep a single filled copy when the empty template was concatenated many times. */
export function collapseWorkingMemoryText(text: string): string {
	const raw = String(text ?? '');
	if (!raw.includes(HEADING)) {
		return raw.slice(0, MAX_WORKING_MEMORY_CHARS);
	}
	const chunks = raw.split(/(?=# Engagement)/).map((part) => part.trim()).filter(Boolean);
	if (chunks.length <= 1) {
		return raw.trim().slice(0, MAX_WORKING_MEMORY_CHARS);
	}
	const picked = [...chunks].reverse().find((part) => !isEmptyWorkingMemoryTemplate(part)) ?? chunks[chunks.length - 1];
	return picked.slice(0, MAX_WORKING_MEMORY_CHARS);
}

/** Collapse repeated template blocks inside a Mastra system reminder (keep preamble). */
export function collapseWorkingMemoryInSystemMessage(text: string): string {
	const first = text.indexOf(HEADING);
	const last = text.lastIndexOf(HEADING);
	if (first < 0 || first === last) {
		return text;
	}
	const preamble = text.slice(0, first);
	return `${preamble}${collapseWorkingMemoryText(text.slice(last))}`;
}

/** Undefined = skip the write (empty skeleton or no-op). */
export function sanitizeWorkingMemoryUpdate(text: string): string | undefined {
	const collapsed = collapseWorkingMemoryText(text);
	if (!collapsed || isEmptyWorkingMemoryTemplate(collapsed)) {
		return undefined;
	}
	return collapsed.slice(0, MAX_WORKING_MEMORY_CHARS);
}
