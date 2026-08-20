import { useEffect, useState } from 'react';
import type { CatalogItem, FindingDTO, FindingFilterDTO } from '../../preload/api';

export const THIS_CHAT = 'this';
export const ALL_CHATS = 'all';

const RETEST_TOOLS = new Set(['poc-request', 'poc-act', 'poc-xss-canary', 'sqlmap-scan']);

export function isUnassignedSession(sessionId?: string): boolean {
	return !sessionId?.trim();
}

export function defaultChatScope(activeSessionId?: string): string {
	return activeSessionId?.trim() ? THIS_CHAT : ALL_CHATS;
}

export function sessionFilter(chatKey: string, activeSessionId?: string): string | undefined {
	if (chatKey === ALL_CHATS) {
		return undefined;
	}
	if (chatKey === THIS_CHAT) {
		return activeSessionId?.trim() || '';
	}
	return chatKey;
}

export function includeUnassignedInScope(chatKey: string): boolean {
	return chatKey === THIS_CHAT || chatKey === ALL_CHATS;
}

export function toFindingsListFilter(
	chatKey: string,
	activeSessionId?: string,
	target?: string,
): FindingFilterDTO {
	const sessionId = sessionFilter(chatKey, activeSessionId);
	const includeUnassigned = includeUnassignedInScope(chatKey) && Boolean(sessionId);
	return {
		...(sessionId !== undefined ? { sessionId } : {}),
		...(includeUnassigned ? { includeUnassigned: true } : {}),
		...(target ? { target } : {}),
	};
}

export function useFindingsChatScope(activeSessionId?: string) {
	const [chatFilter, setChatFilter] = useState(() => defaultChatScope(activeSessionId));
	useEffect(() => {
		setChatFilter((current) => {
			if (current !== THIS_CHAT && current !== ALL_CHATS) {
				return current;
			}
			return defaultChatScope(activeSessionId);
		});
	}, [activeSessionId]);
	return [chatFilter, setChatFilter] as const;
}

export function chatIdSlice(id: string): string {
	return id ? id.slice(0, 8) : '';
}

export function canInformFinding(finding: FindingDTO): boolean {
	if (finding.status === 'informed' || finding.status === 'fixed') {
		return false;
	}
	return finding.status === 'confirmed' || (finding.status === 'unconfirmed' && Boolean(finding.evidence));
}

export function canRetestFinding(finding: FindingDTO): boolean {
	const tool = finding.request?.tool || '';
	if (tool && !RETEST_TOOLS.has(tool)) {
		return false;
	}
	if (tool === 'poc-xss-canary' && !finding.request?.payload) {
		return false;
	}
	if (tool === 'poc-act' && (!finding.request?.actions || finding.request.actions.length === 0)) {
		return false;
	}
	return Boolean(finding.request?.url || finding.target);
}

export function threadLabel(item: CatalogItem): string {
	return `${item.label || 'Chat'} · ${chatIdSlice(item.id)}`;
}
