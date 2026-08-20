import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogItem, NoteSummaryDTO, ReportDTO, TaskDTO } from '../../preload/api';

export type WorkspaceTabKind = 'chat' | 'note' | 'task' | 'tasks' | 'graph' | 'findings' | 'reports' | 'report';

const TAB_KINDS = new Set<WorkspaceTabKind>(['chat', 'note', 'task', 'tasks', 'graph', 'findings', 'reports', 'report']);

function isTabKind(value: unknown): value is WorkspaceTabKind {
	return typeof value === 'string' && TAB_KINDS.has(value as WorkspaceTabKind);
}

export interface WorkspaceTab {
	/** Stable React key; survives session bind so Chat does not remount. */
	key: string;
	/** Lookup id: `kind:refId` (welcome chat uses `chat:welcome`). */
	id: string;
	kind: WorkspaceTabKind;
	refId: string;
	title: string;
	welcome?: boolean;
	/** Unpersisted note/task; first Save creates the record. */
	draft?: boolean;
}

const STORAGE_KEY = 'hawaldar.workspaceTabs';
const DEFAULT_CHAT_TITLES = new Set(['new chat', 'new thread']);

interface PersistedTab {
	key?: string;
	kind: WorkspaceTabKind;
	refId: string;
	welcome?: boolean;
}

interface PersistedWorkspace {
	tabs: PersistedTab[];
	activeId: string;
}

export function makeTabId(kind: WorkspaceTabKind, refId: string): string {
	return `${kind}:${refId || 'welcome'}`;
}

export function newTabKey(): string {
	return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newDraftRefId(): string {
	return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isDraftRef(refId: string): boolean {
	return refId.startsWith('draft-');
}

export function welcomeTab(): WorkspaceTab {
	const refId = newDraftRefId();
	return {
		key: newTabKey(),
		id: makeTabId('chat', refId),
		kind: 'chat',
		refId,
		title: 'New chat',
		welcome: true,
	};
}

export function isDefaultChatTitle(title: string): boolean {
	return DEFAULT_CHAT_TITLES.has(title.trim().toLowerCase());
}

export function isBoundChat(tab: WorkspaceTab): boolean {
	return tab.kind === 'chat' && Boolean(tab.refId) && !isDraftRef(tab.refId);
}

export function readPersistedWorkspace(): PersistedWorkspace | null {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as PersistedWorkspace;
		if (!parsed || !Array.isArray(parsed.tabs)) {
			return null;
		}
		const tabs = parsed.tabs.filter((tab): tab is PersistedTab => (
			Boolean(tab) && isTabKind(tab.kind) && typeof tab.refId === 'string'
		));
		return { tabs, activeId: typeof parsed.activeId === 'string' ? parsed.activeId : '' };
	} catch {
		return null;
	}
}

export function writePersistedWorkspace(tabs: WorkspaceTab[], activeId: string): void {
	try {
		const payload: PersistedWorkspace = {
			activeId,
			tabs: tabs.map((tab) => ({
				key: tab.key,
				kind: tab.kind,
				refId: tab.refId,
				welcome: tab.welcome || undefined,
			})),
		};
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
	} catch {
		/* private mode / quota */
	}
}

export function hydrateWorkspace(
	persisted: PersistedWorkspace | null,
	catalogs: {
		threads: CatalogItem[];
		notes: NoteSummaryDTO[];
		tasks: TaskDTO[];
		reports: ReportDTO[];
	},
): { tabs: WorkspaceTab[]; activeId: string } {
	try {
		return hydrateWorkspaceUnsafe(persisted, catalogs);
	} catch {
		const fresh = welcomeTab();
		return { tabs: [fresh], activeId: fresh.id };
	}
}

function hydrateWorkspaceUnsafe(
	persisted: PersistedWorkspace | null,
	catalogs: {
		threads: CatalogItem[];
		notes: NoteSummaryDTO[];
		tasks: TaskDTO[];
		reports: ReportDTO[];
	},
): { tabs: WorkspaceTab[]; activeId: string } {
	const threads = new Map((catalogs.threads ?? []).map((item) => [item.id, item]));
	const notes = new Map((catalogs.notes ?? []).map((item) => [item.id, item]));
	const tasks = new Map((catalogs.tasks ?? []).map((item) => [item.id, item]));
	const reports = new Map((catalogs.reports ?? []).map((item) => [item.id, item]));
	const raw: WorkspaceTab[] = [];

	for (const row of persisted?.tabs ?? []) {
		if (!isTabKind(row.kind) || typeof row.refId !== 'string') {
			continue;
		}
		if (row.kind === 'chat') {
			if (row.welcome || !row.refId || isDraftRef(row.refId)) {
				const refId = row.refId && row.refId !== 'welcome' ? row.refId : newDraftRefId();
				raw.push({
					key: row.key || newTabKey(),
					id: makeTabId('chat', refId),
					kind: 'chat',
					refId,
					title: 'New chat',
					welcome: true,
				});
				continue;
			}
			const thread = threads.get(row.refId);
			if (!thread) {
				continue;
			}
			raw.push({
				key: row.key || newTabKey(),
				id: makeTabId('chat', thread.id),
				kind: 'chat',
				refId: thread.id,
				title: thread.label,
			});
			continue;
		}
		if (row.kind === 'graph') {
			raw.push({
				key: row.key || newTabKey(),
				id: makeTabId('graph', 'memory'),
				kind: 'graph',
				refId: 'memory',
				title: 'Memory graph',
			});
			continue;
		}
		if (row.kind === 'tasks') {
			raw.push({
				key: row.key || newTabKey(),
				id: makeTabId('tasks', 'board'),
				kind: 'tasks',
				refId: 'board',
				title: 'Tasks',
			});
			continue;
		}
		if (row.kind === 'findings') {
			raw.push({
				key: row.key || newTabKey(),
				id: makeTabId('findings', 'engagement'),
				kind: 'findings',
				refId: 'engagement',
				title: 'Findings',
			});
			continue;
		}
		if (row.kind === 'reports') {
			raw.push({
				key: row.key || newTabKey(),
				id: makeTabId('reports', 'gallery'),
				kind: 'reports',
				refId: 'gallery',
				title: 'Reports',
			});
			continue;
		}
		if (row.kind === 'report') {
			const report = reports.get(row.refId);
			if (!report?.id) {
				continue;
			}
			raw.push({
				key: row.key || newTabKey(),
				id: makeTabId('report', report.id),
				kind: 'report',
				refId: report.id,
				title: report.title || 'Report',
			});
			continue;
		}
		if (row.kind === 'note') {
			const note = notes.get(row.refId);
			if (!note) {
				continue;
			}
			raw.push({
				key: row.key || newTabKey(),
				id: makeTabId('note', note.id),
				kind: 'note',
				refId: note.id,
				title: note.title,
			});
			continue;
		}
		if (row.kind !== 'task') {
			continue;
		}
		const task = tasks.get(row.refId);
		if (!task) {
			continue;
		}
		raw.push({
			key: row.key || newTabKey(),
			id: makeTabId('task', task.id),
			kind: 'task',
			refId: task.id,
			title: task.title,
		});
	}

	const tabs = uniqueTabs(raw);
	if (tabs.length === 0) {
		const fresh = welcomeTab();
		return { tabs: [fresh], activeId: fresh.id };
	}

	const active = tabs.find((tab) => tab.id === persisted?.activeId) ?? tabs[0];
	return { tabs, activeId: active.id };
}

/** One workspace row per tab id so two chats cannot stack as both “active”. */
export function uniqueTabs(tabs: WorkspaceTab[]): WorkspaceTab[] {
	const seen = new Set<string>();
	const out: WorkspaceTab[] = [];
	for (const tab of tabs) {
		if (seen.has(tab.id)) {
			continue;
		}
		seen.add(tab.id);
		out.push(tab);
	}
	return out;
}

function neighborAfterClose(tabs: WorkspaceTab[], closedId: string): string | undefined {
	const idx = tabs.findIndex((tab) => tab.id === closedId);
	if (idx < 0) {
		return tabs[0]?.id;
	}
	return (tabs[idx + 1] ?? tabs[idx - 1])?.id;
}

export function useWorkspaceTabs() {
	const initial = useMemo(() => welcomeTab(), []);
	const [openTabs, setOpenTabs] = useState<WorkspaceTab[]>([initial]);
	const [activeId, setActiveId] = useState(initial.id);
	const [hydrated, setHydrated] = useState(false);
	const tabsRef = useRef(openTabs);
	const activeIdRef = useRef(activeId);
	tabsRef.current = openTabs;
	activeIdRef.current = activeId;

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const api = window.hawaldar;
				if (!api) {
					return;
				}
				const [threads, notes, tasks, reportRows] = await Promise.all([
					api.listThreads(),
					api.listNotes(),
					api.listTasks(),
					api.listReports().catch(() => [] as ReportDTO[]),
				]);
				if (cancelled) {
					return;
				}
				const next = hydrateWorkspace(readPersistedWorkspace(), {
					threads,
					notes,
					tasks,
					reports: reportRows,
				});
				setOpenTabs(next.tabs);
				setActiveId(next.activeId);
			} catch {
				/* keep the in-memory welcome; do not wipe stored tabs */
				return;
			}
			if (!cancelled) {
				setHydrated(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!hydrated) {
			return;
		}
		const unique = uniqueTabs(openTabs);
		if (unique.length !== openTabs.length) {
			setOpenTabs(unique);
			if (!unique.some((tab) => tab.id === activeId)) {
				setActiveId(unique[0]?.id ?? activeId);
			}
			return;
		}
		writePersistedWorkspace(openTabs, activeId);
	}, [openTabs, activeId, hydrated]);

	const activeTab = useMemo(
		() => openTabs.find((tab) => tab.id === activeId) ?? openTabs[0],
		[openTabs, activeId],
	);

	const focusTab = useCallback((id: string) => {
		setActiveId(id);
	}, []);

	const openTab = useCallback((kind: WorkspaceTabKind, refId: string, title: string, welcome = false) => {
		const id = makeTabId(kind, refId);
		setOpenTabs((prev) => {
			const existing = prev.find((tab) => tab.id === id);
			if (existing) {
				return prev.map((tab) => (
					tab.id === id
						? { ...tab, title: title || tab.title, welcome: welcome ? true : undefined }
						: tab
				));
			}
			return [...prev, {
				key: newTabKey(),
				id,
				kind,
				refId,
				title,
				welcome: welcome || undefined,
			}];
		});
		setActiveId(id);
		return id;
	}, []);

	const openChat = useCallback((refId: string, title: string, welcome = false) => {
		return openTab('chat', refId, title, welcome);
	}, [openTab]);

	const openNote = useCallback((refId: string, title: string) => {
		return openTab('note', refId, title);
	}, [openTab]);

	const openTask = useCallback((refId: string, title: string) => {
		return openTab('task', refId, title);
	}, [openTab]);

	const openGraph = useCallback(() => {
		return openTab('graph', 'memory', 'Memory graph');
	}, [openTab]);

	const openTasks = useCallback(() => {
		return openTab('tasks', 'board', 'Tasks');
	}, [openTab]);

	const openFindings = useCallback(() => {
		return openTab('findings', 'engagement', 'Findings');
	}, [openTab]);

	const openReports = useCallback(() => {
		return openTab('reports', 'gallery', 'Reports');
	}, [openTab]);

	const openReport = useCallback((refId: string, title: string) => {
		return openTab('report', refId, title);
	}, [openTab]);

	const openDraft = useCallback((kind: 'note' | 'task') => {
		const refId = newDraftRefId();
		const id = makeTabId(kind, refId);
		setOpenTabs((prev) => [...prev, {
			key: newTabKey(),
			id,
			kind,
			refId,
			title: 'Untitled',
			draft: true,
		}]);
		setActiveId(id);
		return id;
	}, []);

	const openDraftNote = useCallback(() => openDraft('note'), [openDraft]);
	const openDraftTask = useCallback(() => openDraft('task'), [openDraft]);

	const rebindDoc = useCallback((tabKey: string, kind: 'note' | 'task', refId: string, title?: string) => {
		const nextId = makeTabId(kind, refId);
		setOpenTabs((prev) => prev.map((tab) => (
			tab.key === tabKey
				? { ...tab, id: nextId, refId, title: title || tab.title, draft: undefined }
				: tab
		)));
		setActiveId((current) => {
			const tab = tabsRef.current.find((item) => item.key === tabKey);
			return !tab || current === tab.id ? nextId : current;
		});
		return nextId;
	}, []);

	const closeTab = useCallback((id: string) => {
		const prev = tabsRef.current;
		const closed = prev.find((tab) => tab.id === id);
		const next = prev.filter((tab) => tab.id !== id);
		let result = next;
		let createdWelcome: WorkspaceTab | undefined;
		if (result.length === 0 || (closed?.kind === 'chat' && !result.some((tab) => tab.kind === 'chat'))) {
			createdWelcome = welcomeTab();
			result = result.length === 0 ? [createdWelcome] : [...result, createdWelcome];
		}
		const current = activeIdRef.current;
		const nextActive = current === id && createdWelcome
			? createdWelcome.id
			: current !== id && result.some((tab) => tab.id === current)
				? current
				: neighborAfterClose(prev, id) ?? result[0].id;
		setOpenTabs(result);
		setActiveId(nextActive);
	}, []);

	const openNewChat = useCallback(() => {
		const tab = welcomeTab();
		setOpenTabs((prev) => [...prev, tab]);
		setActiveId(tab.id);
		return tab.id;
	}, []);

	const focusHome = useCallback(() => {
		const existing = tabsRef.current.find((tab) => tab.kind === 'chat' && tab.welcome);
		if (existing) {
			setActiveId(existing.id);
			return existing.id;
		}
		const tab = welcomeTab();
		setOpenTabs((prev) => [...prev, tab]);
		setActiveId(tab.id);
		return tab.id;
	}, []);

	const closeByRef = useCallback((kind: WorkspaceTabKind, refId: string) => {
		const id = makeTabId(kind, refId);
		if (tabsRef.current.some((tab) => tab.id === id)) {
			closeTab(id);
		}
	}, [closeTab]);

	const bindChatSession = useCallback((tabKey: string, sessionId: string, title?: string) => {
		const id = sessionId.trim();
		if (!id || isDraftRef(id)) {
			return;
		}
		const nextId = makeTabId('chat', id);
		setOpenTabs((prev) => {
			if (!prev.some((tab) => tab.key === tabKey)) {
				return prev;
			}
			const existing = prev.find((tab) => tab.key !== tabKey && tab.id === nextId);
			return prev
				.filter((tab) => tab.key === tabKey || tab.id !== nextId)
				.map((tab) => (
					tab.key === tabKey
						? {
							...tab,
							id: nextId,
							refId: id,
							welcome: undefined,
							title: title
								|| (existing && isDefaultChatTitle(tab.title) ? existing.title : tab.title),
						}
						: tab
				));
		});
		setActiveId((current) => {
			const tab = tabsRef.current.find((item) => item.key === tabKey);
			return !tab || current === tab.id ? nextId : current;
		});
	}, []);

	const setTabTitle = useCallback((id: string, title: string) => {
		const next = title.trim();
		if (!next) {
			return;
		}
		setOpenTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, title: next } : tab)));
	}, []);

	const syncChatTitles = useCallback((threads: CatalogItem[]) => {
		const labels = new Map(threads.map((item) => [item.id, item.label]));
		setOpenTabs((prev) => {
			let changed = false;
			const next = prev.map((tab) => {
				if (tab.kind !== 'chat' || !tab.refId) {
					return tab;
				}
				const label = labels.get(tab.refId);
				if (!label || label === tab.title) {
					return tab;
				}
				changed = true;
				return { ...tab, title: label };
			});
			return changed ? next : prev;
		});
	}, []);

	const ensureChatTab = useCallback(() => {
		const chats = tabsRef.current.filter((tab) => tab.kind === 'chat');
		if (chats.length > 0) {
			setActiveId(chats[chats.length - 1].id);
			return;
		}
		const fresh = welcomeTab();
		setOpenTabs((prev) => [...prev, fresh]);
		setActiveId(fresh.id);
	}, []);

	return {
		tabs: openTabs,
		activeId,
		activeTab,
		hydrated,
		focusTab,
		openChat,
		openNote,
		openTask,
		openTasks,
		openGraph,
		openFindings,
		openReports,
		openReport,
		openDraftNote,
		openDraftTask,
		rebindDoc,
		openNewChat,
		focusHome,
		closeTab,
		closeByRef,
		bindChatSession,
		setTabTitle,
		syncChatTitles,
		ensureChatTab,
	};
}
