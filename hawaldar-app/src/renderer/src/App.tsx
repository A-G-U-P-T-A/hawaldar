import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogItem, HitlAskEvent, LegalStatusDTO } from '../../preload/api';
import BrandMark from './BrandMark';
import BootScreen from './BootScreen';
import CatalogPage, { StatusPage } from './CatalogPage';
import Chat from './Chat';
import { isDocSaveHotkey, type DocEditorHandle } from './docEditor';
import FindingsPage from './FindingsPage';
import GraphTab from './GraphTab';
import HitlConfirm from './HitlConfirm';
import { useI18n } from './i18n';
import LegalGate from './LegalGate';
import NoteTab from './NoteTab';
import PageShell from './PageShell';
import { ContainerIcon, GearIcon } from './navIcons';
import { ThemeToggle } from './theme';
import PodmanPanel from './PodmanPanel';
import QuitConfirm from './QuitConfirm';
import ReportsPage from './ReportsPage';
import ReportViewer from './ReportViewer';
import SaveChangesConfirm from './SaveChangesConfirm';
import Settings, { type SettingsCategory } from './Settings';
import CommandMenu from './CommandMenu';
import CreateNoteModal from './CreateNoteModal';
import RightPanel from './RightPanel';
import Sidebar from './Sidebar';
import TabStrip from './TabStrip';
import TaskTab from './TaskTab';
import TasksPage from './TasksPage';
import { fullModelTitle, shortModelId } from './modelDisplay';
import { sameSessionList } from './sessionGroups';
import { isBoundChat, useWorkspaceTabs } from './workspaceTabs';

type SavePrompt = {
	kind: 'tab' | 'quit';
	keys: string[];
};

type View = 'chat' | 'settings' | 'podman' | 'status' | 'agents' | 'tools' | 'workflows' | 'providers' | 'traces' | 'logs';

function hasDesktopApi(): boolean {
	return typeof window.hawaldar?.getLegal === 'function';
}

function MissingDesktopBridge() {
	return (
		<div className="boot-error">
			<div className="app-titlebar">
				<div className="product">Hawaldar</div>
			</div>
			<div className="boot-error-body">
				<h1>Desktop bridge missing</h1>
				<p>
					window.hawaldar is not available, so the preload script did not load.
					Stop this process (Ctrl+C) and run scripts\dev.bat again.
				</p>
			</div>
		</div>
	);
}

export default function App() {
	if (!hasDesktopApi()) {
		return <MissingDesktopBridge />;
	}
	return <AppMain />;
}

function AppMain() {
	const { t } = useI18n();
	const [view, setView] = useState<View>('chat');
	const [threads, setThreads] = useState<CatalogItem[]>([]);
	const [catalog, setCatalog] = useState<CatalogItem[]>([]);
	const [status, setStatus] = useState<Record<string, unknown> | null>(null);
	const [pendingCommand, setPendingCommand] = useState<string | undefined>();
	const [modelLabel, setModelLabel] = useState('');
	const [agentId, setAgentId] = useState('orchestrator');
	const [quitPhase, setQuitPhase] = useState<'hidden' | 'ask' | 'stopping'>('hidden');
	const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('provider');
	const [hasSelectedProvider, setHasSelectedProvider] = useState(false);
	const [legal, setLegal] = useState<LegalStatusDTO | null>(null);
	const [legalBusy, setLegalBusy] = useState(false);
	const [legalError, setLegalError] = useState('');
	const [booting, setBooting] = useState(true);
	const [bootStatusKey, setBootStatusKey] = useState('boot.loading');
	const [providerLabel, setProviderLabel] = useState('');
	const [providerId, setProviderId] = useState('');
	const [listEpoch, setListEpoch] = useState(0);
	const [dirtyIds, setDirtyIds] = useState<Set<string>>(() => new Set());
	const [savePrompt, setSavePrompt] = useState<SavePrompt | null>(null);
	const [saveBusy, setSaveBusy] = useState(false);
	const [hitlAsk, setHitlAsk] = useState<HitlAskEvent | null>(null);
	const [hitlBusy, setHitlBusy] = useState(false);
	const hitlBusyRef = useRef(false);
	const [createTaskTick, setCreateTaskTick] = useState(0);
	const [createNoteOpen, setCreateNoteOpen] = useState(false);
	const [createNoteBusy, setCreateNoteBusy] = useState(false);
	const [createNoteError, setCreateNoteError] = useState('');
	const [findingsCount, setFindingsCount] = useState(0);
	const hitlQueue = useRef<HitlAskEvent[]>([]);
	const workspace = useWorkspaceTabs();
	const docHandles = useRef(new Map<string, DocEditorHandle>());
	const dirtyIdsRef = useRef(dirtyIds);
	const tabsRef = useRef(workspace.tabs);
	const savePromptRef = useRef(savePrompt);
	const viewRef = useRef(view);
	const activeIdRef = useRef(workspace.activeId);
	const quitPhaseRef = useRef(quitPhase);
	dirtyIdsRef.current = dirtyIds;
	tabsRef.current = workspace.tabs;
	savePromptRef.current = savePrompt;
	viewRef.current = view;
	activeIdRef.current = workspace.activeId;
	quitPhaseRef.current = quitPhase;

	const refreshThreadList = useCallback(async () => {
		try {
			const list = await window.hawaldar.listThreads();
			setThreads((prev) => (sameSessionList(prev, list) ? prev : list));
			workspace.syncChatTitles(list);
		} catch {
			/* threads need a booted runtime */
		}
	}, [workspace.syncChatTitles]);

	const refreshThreads = useCallback(async () => {
		await refreshThreadList();
		try {
			const [settings, catalog] = await Promise.all([
				window.hawaldar.getSettings(),
				window.hawaldar.listProviderCatalog(),
			]);
			const selected = settings.hasSelectedProvider === true && Boolean(settings.provider);
			setHasSelectedProvider(selected);
			const row = selected ? catalog.find((item) => item.id === settings.provider) : undefined;
			setProviderLabel(selected ? (row?.label || settings.provider) : '');
			setProviderId(selected ? settings.provider : '');
			let model = selected ? (settings.model || '') : '';
			try {
				const snap = await window.hawaldar.getStatus();
				setStatus(snap);
				if (selected) {
					model = settings.model || String(snap.model ?? '');
				}
			} catch {
				/* status needs a booted runtime */
			}
			setModelLabel(model);
		} catch {
			/* keep last known provider chrome */
		}
	}, [refreshThreadList]);

	const refreshCatalog = useCallback(async (v: View) => {
		const api = window.hawaldar;
		if (v === 'agents') setCatalog(await api.listAgents());
		else if (v === 'tools') setCatalog(await api.listTools());
		else if (v === 'workflows') setCatalog(await api.listWorkflows());
		else if (v === 'providers') setCatalog(await api.listProviders());
		else if (v === 'traces') setCatalog(await api.listTraces());
		else if (v === 'logs') setCatalog(await api.listLogs());
		else if (v === 'status') setStatus(await api.getStatus());
	}, []);

	useEffect(() => {
		void refreshThreads();
	}, [refreshThreads]);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				setBootStatusKey('boot.legal');
				const next = await window.hawaldar.getLegal();
				if (cancelled) {
					return;
				}
				setLegal(next);
				if (next.accepted) {
					setBootStatusKey('boot.settings');
					await window.hawaldar.getSettings().catch(() => null);
					if (cancelled) {
						return;
					}
					setBootStatusKey('boot.knowledge');
					await Promise.all([
						window.hawaldar.knowledgeStatus().catch(() => null),
						window.hawaldar.getStatus().catch(() => null),
					]);
				}
			} catch (err) {
				if (!cancelled) {
					setLegalError(err instanceof Error ? err.message : String(err));
				}
			} finally {
				if (!cancelled) {
					setBooting(false);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!legal?.accepted) {
			return;
		}
		let cancelled = false;
		void window.hawaldar.getPodmanStatus().then((status) => {
			if (!cancelled && status.availability === 'not_installed') {
				setView('podman');
			}
		});
		return () => {
			cancelled = true;
		};
	}, [legal?.accepted]);

	useEffect(() => {
		let cancelled = false;
		let inflight = false;
		const tick = async () => {
			if (inflight || cancelled) {
				return;
			}
			inflight = true;
			try {
				await refreshThreadList();
			} finally {
				inflight = false;
			}
		};
		const id = window.setInterval(() => {
			void tick();
		}, 1000);
		return () => {
			cancelled = true;
			window.clearInterval(id);
		};
	}, [refreshThreadList]);

	useEffect(() => {
		const onCopy = (event: ClipboardEvent) => {
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed) {
				return;
			}
			const text = sel.toString();
			if (!text) {
				return;
			}
			const node = sel.anchorNode;
			if (!node) {
				return;
			}
			const el = node instanceof Element ? node : node.parentElement;
			if (el?.closest('textarea, input, [contenteditable="true"]')) {
				return;
			}
			event.preventDefault();
			event.clipboardData?.setData('text/plain', text);
		};
		document.addEventListener('copy', onCopy);
		return () => document.removeEventListener('copy', onCopy);
	}, []);

	useEffect(() => {
		if (!workspace.hydrated) {
			return;
		}
		const tab = workspace.activeTab;
		if (tab && isBoundChat(tab)) {
			void window.hawaldar.setActiveThread(tab.refId);
		}
	}, [workspace.hydrated, workspace.activeId, workspace.activeTab]);

	const setTabDirty = useCallback((tabId: string, dirty: boolean) => {
		setDirtyIds((prev) => {
			const has = prev.has(tabId);
			if (has === dirty) {
				return prev;
			}
			const next = new Set(prev);
			if (dirty) {
				next.add(tabId);
			} else {
				next.delete(tabId);
			}
			return next;
		});
	}, []);

	const bindDoc = useCallback((tabKey: string) => (handle: DocEditorHandle | null) => {
		if (handle) {
			docHandles.current.set(tabKey, handle);
		} else {
			docHandles.current.delete(tabKey);
		}
	}, []);

	const dirtyDocKeys = useCallback(() => {
		return tabsRef.current
			.filter((tab) => (tab.kind === 'note' || tab.kind === 'task') && dirtyIdsRef.current.has(tab.id))
			.map((tab) => tab.key);
	}, []);

	useEffect(() => {
		return window.hawaldar.onQuitAsk((ev) => {
			if (ev.phase === 'stopping') {
				setSavePrompt(null);
				setQuitPhase('stopping');
				return;
			}
			const keys = dirtyDocKeys();
			if (keys.length > 0) {
				setQuitPhase('hidden');
				setSavePrompt({ kind: 'quit', keys });
				return;
			}
			setQuitPhase('ask');
		});
	}, [dirtyDocKeys]);

	const onQuitCancel = useCallback(() => {
		if (quitPhase === 'stopping') {
			return;
		}
		setQuitPhase('hidden');
		void window.hawaldar.cancelQuit();
	}, [quitPhase]);

	const onQuitConfirm = useCallback(() => {
		setQuitPhase('stopping');
		void window.hawaldar.confirmQuit();
	}, []);

	useEffect(() => {
		return window.hawaldar.onHitlAsk((ev) => {
			setHitlAsk((current) => {
				if (current && current.requestId !== ev.requestId) {
					hitlQueue.current.push(ev);
					return current;
				}
				return ev;
			});
		});
	}, []);

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			try {
				const list = await window.hawaldar.listFindings();
				if (!cancelled) {
					setFindingsCount(list.length);
				}
			} catch {
				/* findings need a booted runtime */
			}
		};
		void load();
		const off = window.hawaldar.onFindingsChanged(() => void load());
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	const finishHitl = useCallback(async (approved: boolean) => {
		const ask = hitlAsk;
		if (!ask || hitlBusyRef.current) {
			return;
		}
		hitlBusyRef.current = true;
		setHitlBusy(true);
		const requestId = String(ask.requestId || '');
		try {
			await window.hawaldar.respondHitl(requestId, approved);
		} catch (error) {
			console.error('[hawaldar] hitl.respond', error);
		} finally {
			hitlBusyRef.current = false;
			setHitlBusy(false);
			setHitlAsk(hitlQueue.current.shift() ?? null);
		}
	}, [hitlAsk]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!isDocSaveHotkey(event)) {
				return;
			}
			if (viewRef.current !== 'chat' || savePromptRef.current || quitPhaseRef.current !== 'hidden') {
				return;
			}
			const tab = tabsRef.current.find((item) => item.id === activeIdRef.current);
			if (!tab || (tab.kind !== 'note' && tab.kind !== 'task')) {
				return;
			}
			event.preventDefault();
			void docHandles.current.get(tab.key)?.save();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	const persistDocKeys = useCallback(async (keys: string[]) => {
		for (const key of keys) {
			const tab = tabsRef.current.find((item) => item.key === key);
			const handle = docHandles.current.get(key);
			if (!handle) {
				if (tab) {
					workspace.focusTab(tab.id);
				}
				return false;
			}
			const ok = await handle.save();
			if (!ok) {
				if (tab) {
					workspace.focusTab(tab.id);
				}
				return false;
			}
		}
		return true;
	}, [workspace]);

	const discardDocKeys = useCallback((keys: string[]) => {
		for (const key of keys) {
			docHandles.current.get(key)?.discard();
		}
	}, []);

	const requestCloseTab = useCallback((id: string) => {
		const tab = workspace.tabs.find((item) => item.id === id);
		if (tab && (tab.kind === 'note' || tab.kind === 'task') && dirtyIds.has(id)) {
			workspace.focusTab(id);
			setSavePrompt({ kind: 'tab', keys: [tab.key] });
			return;
		}
		workspace.closeTab(id);
	}, [dirtyIds, workspace]);

	const onSavePromptCancel = useCallback(() => {
		if (saveBusy) {
			return;
		}
		const prompt = savePromptRef.current;
		setSavePrompt(null);
		if (prompt?.kind === 'quit') {
			void window.hawaldar.cancelQuit();
		}
	}, [saveBusy]);

	const onSavePromptDiscard = useCallback(() => {
		if (saveBusy) {
			return;
		}
		const prompt = savePromptRef.current;
		if (!prompt) {
			return;
		}
		discardDocKeys(prompt.keys);
		setSavePrompt(null);
		if (prompt.kind === 'quit') {
			setQuitPhase('ask');
			return;
		}
		for (const key of prompt.keys) {
			const tab = tabsRef.current.find((item) => item.key === key);
			if (tab) {
				workspace.closeTab(tab.id);
			}
		}
	}, [discardDocKeys, saveBusy, workspace]);

	const onSavePromptSave = useCallback(() => {
		if (saveBusy) {
			return;
		}
		const prompt = savePromptRef.current;
		if (!prompt) {
			return;
		}
		setSaveBusy(true);
		void (async () => {
			const ok = await persistDocKeys(prompt.keys);
			setSaveBusy(false);
			if (!ok) {
				setSavePrompt(null);
				if (prompt.kind === 'quit') {
					void window.hawaldar.cancelQuit();
				}
				return;
			}
			setSavePrompt(null);
			if (prompt.kind === 'quit') {
				setQuitPhase('ask');
				return;
			}
			for (const key of prompt.keys) {
				const tab = tabsRef.current.find((item) => item.key === key);
				if (tab) {
					workspace.closeTab(tab.id);
				}
			}
		})();
	}, [persistDocKeys, saveBusy, workspace]);

	useEffect(() => {
		if (view !== 'chat' && view !== 'settings' && view !== 'podman') {
			void refreshCatalog(view);
		}
	}, [view, refreshCatalog]);

	const openSettings = (category: SettingsCategory = 'provider') => {
		setSettingsCategory(category);
		setView('settings');
	};

	const openView = (v: View) => {
		if (v === 'settings') {
			openSettings('provider');
			return;
		}
		if (v === 'tools') {
			openSettings('tools');
			return;
		}
		setView(v);
	};

	const openProviderSettings = () => {
		openSettings('provider');
	};

	const showWorkspace = () => {
		setView('chat');
	};

	const focusChatTab = async (id: string) => {
		workspace.focusTab(id);
		const tab = workspace.tabs.find((item) => item.id === id);
		if (tab && isBoundChat(tab)) {
			await window.hawaldar.setActiveThread(tab.refId);
		}
		showWorkspace();
	};

	const onSelectThread = async (item: CatalogItem) => {
		await window.hawaldar.setActiveThread(item.id);
		workspace.openChat(item.id, item.label);
		await refreshThreads();
		showWorkspace();
	};

	const onNewThread = () => {
		workspace.openNewChat();
		showWorkspace();
	};

	const onHome = () => {
		workspace.focusHome();
		showWorkspace();
	};

	const onDeleteThread = async (id: string) => {
		await window.hawaldar.deleteThread(id);
		workspace.closeByRef('chat', id);
		await refreshThreads();
	};

	const onRenameThread = async (id: string, title: string) => {
		const next = await window.hawaldar.renameThread(id, title);
		workspace.setTabTitle(`chat:${id}`, next.label);
		await refreshThreads();
	};

	const onOpenNote = (id: string, title: string) => {
		workspace.openNote(id, title);
		showWorkspace();
	};

	const onOpenTask = (id: string, title: string) => {
		workspace.openTask(id, title);
		showWorkspace();
	};

	const onCreateNote = () => {
		workspace.openDraftNote();
		showWorkspace();
	};

	const onOpenGraph = () => {
		workspace.openGraph();
		showWorkspace();
	};

	const onOpenTasks = () => {
		workspace.openTasks();
		showWorkspace();
	};

	const onOpenFindings = () => {
		workspace.openFindings();
		showWorkspace();
	};

	const onOpenReports = () => {
		workspace.openReports();
		showWorkspace();
	};

	const onOpenReport = (id: string, title: string) => {
		workspace.openReport(id, title);
		showWorkspace();
	};

	const onCreateTask = () => {
		workspace.openTasks();
		showWorkspace();
		setCreateTaskTick((n) => n + 1);
	};

	const persistNewNote = async (title: string) => {
		setCreateNoteBusy(true);
		setCreateNoteError('');
		try {
			const note = await window.hawaldar.upsertNote({ title, body: '' });
			setCreateNoteOpen(false);
			setListEpoch((n) => n + 1);
			workspace.openNote(note.id, note.title);
			showWorkspace();
		} catch (err) {
			setCreateNoteError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreateNoteBusy(false);
		}
	};

	const sidebarView: View = view === 'settings' && settingsCategory === 'tools' ? 'tools' : view;
	const activeTab = workspace.activeTab;
	const activeTabKey = activeTab?.key;
	const activeSessionId = activeTab && isBoundChat(activeTab)
		? activeTab.refId
		: (activeTab?.kind === 'chat'
			? undefined
			: [...workspace.tabs].reverse().find(isBoundChat)?.refId);
	const activeNoteId = activeTab?.kind === 'note' ? activeTab.refId : undefined;
	const activeTaskId = activeTab?.kind === 'task' ? activeTab.refId : undefined;

	const modelTitle = fullModelTitle(providerLabel, providerId, modelLabel);
	const modelShort = shortModelId(providerId, modelLabel);

	const acceptLegal = async () => {
		setLegalBusy(true);
		setLegalError('');
		try {
			setLegal(await window.hawaldar.acceptLegal());
		} catch (err) {
			setLegalError(err instanceof Error ? err.message : String(err));
		} finally {
			setLegalBusy(false);
		}
	};

	const declineLegal = () => {
		void window.hawaldar.declineLegal();
	};

	const onCatalogSelect = async (item: CatalogItem) => {
		if (view === 'agents' && item.id !== 'orchestrator') {
			setAgentId(item.id);
			setPendingCommand(item.id);
			workspace.ensureChatTab();
			showWorkspace();
			return;
		}
		if (view === 'workflows') {
			const target = window.prompt('Target, file, or pcap path');
			if (!target) return;
			const looksFile = /[\\/]/.test(target) || /\.(pcap|pcapng|exe|dll|so|bin)$/i.test(target);
			const input = looksFile && /\.pcap/i.test(target)
				? { pcapPath: target, message: target }
				: looksFile
					? { filePath: target, message: target }
					: { target, message: target };
			try {
				await window.hawaldar.runWorkflow(item.id, input);
				workspace.openFindings();
				showWorkspace();
				await refreshThreads();
			} catch (error) {
				alert(error instanceof Error ? error.message : String(error));
			}
		}
	};

	const titleActions = (
		<>
			{hasSelectedProvider ? (
				<span className="title-meta" title={modelTitle}>
					<span className="title-meta-provider">{providerLabel}</span>
					{modelShort ? <span className="title-meta-model">{modelShort}</span> : null}
				</span>
			) : (
				<button type="button" className="btn" onClick={openProviderSettings}>
					Select provider
				</button>
			)}
			<button
				type="button"
				className="icon-tool"
				title={t('nav.runtime')}
				aria-label={t('nav.runtime')}
				onClick={() => openView('podman')}
			>
				<ContainerIcon />
			</button>
			<ThemeToggle />
			<button
				type="button"
				className="icon-tool"
				title={t('nav.settings')}
				aria-label={t('nav.settings')}
				onClick={() => openView('settings')}
			>
				<GearIcon />
			</button>
		</>
	);

	if (booting) {
		return (
			<div className="app">
				<div className="app-titlebar">
					<div className="product">
						<BrandMark size={24} className="brand-mark" />
						Hawaldar
						<span className="product-meta">authorized recon</span>
					</div>
				</div>
				<BootScreen status={t(bootStatusKey)} />
				{quitPhase !== 'hidden' && (
					<QuitConfirm phase={quitPhase} onCancel={onQuitCancel} onConfirm={onQuitConfirm} />
				)}
			</div>
		);
	}

	if (!legal || !legal.accepted) {
		return (
			<div className="app">
				<div className="app-titlebar">
					<div className="product">
						<BrandMark size={24} className="brand-mark" />
						Hawaldar
						<span className="product-meta">authorized recon</span>
					</div>
				</div>
				<div className="app-body">
					<div className="main-pane">
						{legal ? (
							<LegalGate
								document={legal.document}
								busy={legalBusy}
								error={legalError}
								onAccept={() => void acceptLegal()}
								onDecline={declineLegal}
							/>
						) : (
							<PageShell title={t('legal.title')}>
								<section className="widget">
									<p className="widget-help">{legalError || t('legal.loadingAgreement')}</p>
								</section>
							</PageShell>
						)}
					</div>
				</div>
				{quitPhase !== 'hidden' && (
					<QuitConfirm phase={quitPhase} onCancel={onQuitCancel} onConfirm={onQuitConfirm} />
				)}
			</div>
		);
	}

	return (
		<div className="app">
			<div className="app-titlebar">
				<div className="product">
					<BrandMark size={24} className="brand-mark" />
					Hawaldar
					<span className="product-meta" title={modelTitle || undefined}>
						{modelShort || 'authorized recon'}
					</span>
				</div>
			</div>

			<div className="app-body">
				<Sidebar
					threads={threads}
					activeView={sidebarView}
					activeSessionId={activeSessionId}
					onOpenView={openView}
					onSelectThread={onSelectThread}
					onNewThread={onNewThread}
					onHome={onHome}
					onDeleteThread={(id) => void onDeleteThread(id)}
					onRenameThread={(id, title) => void onRenameThread(id, title)}
					onPinThread={async (id, pinned) => {
						await window.hawaldar.setThreadPinned(id, pinned);
						await refreshThreadList();
					}}
				onRefreshThreads={() => void refreshThreadList()}
				onOpenGraph={onOpenGraph}
				onOpenTasks={onOpenTasks}
				onOpenFindings={onOpenFindings}
				graphActive={view === 'chat' && activeTab?.kind === 'graph'}
				tasksActive={view === 'chat' && activeTab?.kind === 'tasks'}
				findingsActive={view === 'chat' && activeTab?.kind === 'findings'}
				homeActive={view === 'chat' && Boolean(activeTab?.welcome)}
				findingsCount={findingsCount}
			/>

				<div className="main-pane">
					<div className={`workspace-stack${view === 'chat' ? '' : ' is-hidden'}`} inert={view !== 'chat'}>
							<TabStrip
								tabs={workspace.tabs}
								activeId={workspace.activeId}
								activeKey={activeTabKey}
								dirtyIds={dirtyIds}
								actions={titleActions}
								onFocus={(id) => void focusChatTab(id)}
								onClose={requestCloseTab}
							/>
							<div className="workspace-pages">
								{workspace.tabs.map((tab) => {
									const active = tab.key === activeTabKey;
									return (
										<div
											key={tab.key}
											className={`workspace-page${active ? ' active' : ''}`}
											inert={!active}
											aria-hidden={!active}
										>
											{tab.kind === 'chat' && (
												<Chat
													sessionId={isBoundChat(tab) ? tab.refId : undefined}
													onSessionBound={(id) => {
														workspace.bindChatSession(tab.key, id);
														void window.hawaldar.setActiveThread(id);
														void refreshThreadList();
													}}
													agentId={agentId}
													onAgentChange={setAgentId}
													modelLabel={modelLabel}
													providerLabel={providerLabel}
													hasSelectedProvider={hasSelectedProvider}
													onModelChanged={() => void refreshThreads()}
												pendingCommand={active ? pendingCommand : undefined}
												onCommandConsumed={() => setPendingCommand(undefined)}
												onActivity={() => void refreshThreads()}
												onOpenFindings={onOpenFindings}
											/>
											)}
											{tab.kind === 'note' && (
												<NoteTab
													ref={bindDoc(tab.key)}
													tabId={tab.id}
													noteId={tab.refId}
													draft={Boolean(tab.draft)}
													onTitle={(title) => workspace.setTabTitle(tab.id, title)}
													onChanged={() => setListEpoch((n) => n + 1)}
													onBound={(id) => workspace.rebindDoc(tab.key, 'note', id)}
													onDirtyChange={setTabDirty}
												/>
											)}
										{tab.kind === 'graph' && (
											<GraphTab />
										)}
										{tab.kind === 'findings' && (
											<FindingsPage
												activeSessionId={activeSessionId}
												onOpenReport={onOpenReport}
											/>
										)}
										{tab.kind === 'reports' && (
											<ReportsPage onOpenReport={onOpenReport} />
										)}
										{tab.kind === 'report' && (
											<ReportViewer reportId={tab.refId} />
										)}
											{tab.kind === 'tasks' && (
												<TasksPage
													listEpoch={listEpoch}
													createTick={createTaskTick}
													activeTaskId={activeTaskId}
													onChanged={() => setListEpoch((n) => n + 1)}
													onOpenCardTab={onOpenTask}
													onRemoved={(id) => workspace.closeByRef('task', id)}
												/>
											)}
											{tab.kind === 'task' && (
												<TaskTab
													ref={bindDoc(tab.key)}
													tabId={tab.id}
													taskId={tab.refId}
													draft={Boolean(tab.draft)}
													onTitle={(title) => workspace.setTabTitle(tab.id, title)}
													onChanged={() => setListEpoch((n) => n + 1)}
													onBound={(id) => workspace.rebindDoc(tab.key, 'task', id)}
													onDirtyChange={setTabDirty}
												/>
											)}
										</div>
									);
								})}
							</div>
					</div>

					{view === 'settings' && (
						<Settings
							initialCategory={settingsCategory}
							onCategoryChange={setSettingsCategory}
							onClose={() => setView('chat')}
							onSaved={async () => {
								await window.hawaldar.reloadRuntime();
								await refreshThreads();
								setView('chat');
							}}
						/>
					)}

					{view === 'podman' && (
						<PodmanPanel onClose={() => setView('chat')} />
					)}

					{(view === 'agents' || view === 'workflows' || view === 'providers' || view === 'traces' || view === 'logs') && (
						<CatalogPage
							view={view}
							items={catalog}
							onClose={() => setView('chat')}
							onSelect={view === 'agents' || view === 'workflows'
								? (item) => void onCatalogSelect(item)
								: undefined}
						/>
					)}

					{view === 'status' && (
						<StatusPage status={status} onClose={() => setView('chat')} />
					)}
				</div>

				{view === 'chat' && (
					<RightPanel
						activeNoteId={activeNoteId}
						listEpoch={listEpoch}
						onOpenNote={onOpenNote}
						onCreateNote={onCreateNote}
						onNoteRemoved={(id) => workspace.closeByRef('note', id)}
						onOpenFindings={onOpenFindings}
						onOpenReports={onOpenReports}
						onOpenReport={onOpenReport}
						findingsCount={findingsCount}
						activeSessionId={activeSessionId}
					/>
				)}
			</div>

			{savePrompt && (
				<SaveChangesConfirm
					busy={saveBusy}
					detail={savePrompt.kind === 'quit'
						? 'Unsaved notes and tasks keep their last saved version if you choose No.'
						: undefined}
					onCancel={onSavePromptCancel}
					onDiscard={onSavePromptDiscard}
					onSave={onSavePromptSave}
				/>
			)}
			{quitPhase !== 'hidden' && !savePrompt && !hitlAsk && (
				<QuitConfirm phase={quitPhase} onCancel={onQuitCancel} onConfirm={onQuitConfirm} />
			)}
			{hitlAsk && (
				<HitlConfirm
					title={hitlAsk.title}
					explanation={hitlAsk.explanation}
					kind={hitlAsk.kind}
					serviceId={hitlAsk.serviceId}
					busy={hitlBusy}
					onCancel={() => void finishHitl(false)}
					onApprove={() => void finishHitl(true)}
				/>
			)}
			{createNoteOpen && (
				<CreateNoteModal
					busy={createNoteBusy}
					error={createNoteError}
					onClose={() => {
						if (!createNoteBusy) {
							setCreateNoteOpen(false);
							setCreateNoteError('');
						}
					}}
					onSubmit={(title) => void persistNewNote(title)}
				/>
			)}
			<CommandMenu
				disabled={Boolean(savePrompt) || quitPhase !== 'hidden' || Boolean(hitlAsk) || createNoteOpen}
				onCreateTask={onCreateTask}
				onCreateNote={() => {
					setCreateNoteError('');
					setCreateNoteOpen(true);
				}}
				onCreateChat={() => {
					workspace.openNewChat();
					showWorkspace();
				}}
				onOpenTasks={onOpenTasks}
				onOpenGraph={onOpenGraph}
				onOpenSettings={() => openView('settings')}
				onOpenRuntime={() => openView('podman')}
			/>
		</div>
	);
}
