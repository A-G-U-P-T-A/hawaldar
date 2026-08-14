import { useCallback, useEffect, useState } from 'react';
import type { CatalogItem } from '../../preload/api';
import BrandMark from './BrandMark';
import CatalogPage, { StatusPage } from './CatalogPage';
import Chat from './Chat';
import { ContainerIcon, GearIcon } from './navIcons';
import PodmanPanel from './PodmanPanel';
import QuitConfirm from './QuitConfirm';
import Settings, { type SettingsCategory } from './Settings';
import Sidebar from './Sidebar';

type View = 'chat' | 'settings' | 'podman' | 'status' | 'agents' | 'tools' | 'workflows' | 'providers' | 'traces' | 'logs';

export default function App() {
	const [view, setView] = useState<View>('chat');
	const [threads, setThreads] = useState<CatalogItem[]>([]);
	const [catalog, setCatalog] = useState<CatalogItem[]>([]);
	const [status, setStatus] = useState<Record<string, unknown> | null>(null);
	const [pendingCommand, setPendingCommand] = useState<string | undefined>();
	const [modelLabel, setModelLabel] = useState('');
	const [agentId, setAgentId] = useState('orchestrator');
	const [activeTitle, setActiveTitle] = useState('New chat');
	const [quitPhase, setQuitPhase] = useState<'hidden' | 'ask' | 'stopping'>('hidden');
	const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('provider');
	const [hasSelectedProvider, setHasSelectedProvider] = useState(false);
	const [providerLabel, setProviderLabel] = useState('');

	const refreshThreads = useCallback(async () => {
		const list = await window.hawaldar.listThreads();
		setThreads(list);
		const active = list.find((t) => t.detail === 'active');
		if (active) {
			setActiveTitle(active.label);
		} else if (list[0]) {
			setActiveTitle(list[0].label);
		} else {
			setActiveTitle('New chat');
		}
		const [snap, settings, catalog] = await Promise.all([
			window.hawaldar.getStatus(),
			window.hawaldar.getSettings(),
			window.hawaldar.listProviderCatalog(),
		]);
		setStatus(snap);
		setHasSelectedProvider(settings.hasSelectedProvider === true);
		const selected = catalog.find((item) => item.id === settings.provider);
		setProviderLabel(selected?.label || settings.provider);
		setModelLabel(settings.hasSelectedProvider ? String(snap.model ?? settings.model ?? '') : '');
	}, []);

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
		return window.hawaldar.onQuitAsk((ev) => {
			setQuitPhase(ev.phase === 'stopping' ? 'stopping' : 'ask');
		});
	}, []);

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
		if (view !== 'chat' && view !== 'settings' && view !== 'podman') {
			void refreshCatalog(view);
		}
	}, [view, refreshCatalog]);

	const openView = (v: View) => {
		if (v === 'settings') {
			setSettingsCategory('provider');
		}
		setView(v);
	};

	const openProviderSettings = () => {
		setSettingsCategory('provider');
		setView('settings');
	};

	const onSelectThread = async (item: CatalogItem) => {
		await window.hawaldar.setActiveThread(item.id);
		setActiveTitle(item.label);
		await refreshThreads();
		setView('chat');
	};

	const onCatalogSelect = async (item: CatalogItem) => {
		if (view === 'agents' && item.id !== 'orchestrator') {
			setAgentId(item.id);
			setPendingCommand(item.id);
			setView('chat');
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
				const out = await window.hawaldar.runWorkflow(item.id, input);
				alert(out.slice(0, 4000));
				await refreshThreads();
			} catch (error) {
				alert(error instanceof Error ? error.message : String(error));
			}
		}
	};

	return (
		<div className="app">
			<div className="app-titlebar">
				<div className="product">
					<BrandMark size={24} className="brand-mark" />
					Hawaldar
					<span className="product-meta">{modelLabel || 'authorized recon'}</span>
				</div>
			</div>

			<div className="app-body">
				<Sidebar
					threads={threads}
					activeView={view}
					onOpenView={openView}
					onSelectThread={onSelectThread}
					onNewThread={async () => {
						const t = await window.hawaldar.createThread();
						setActiveTitle(t.label);
						await refreshThreads();
						setView('chat');
					}}
					onDeleteThread={async (id) => {
						await window.hawaldar.deleteThread(id);
						await refreshThreads();
					}}
					onRenameThread={async (id, title) => {
						const next = await window.hawaldar.renameThread(id, title);
						if (next.detail === 'active') {
							setActiveTitle(next.label);
						}
						await refreshThreads();
					}}
					onPinThread={async (id, pinned) => {
						await window.hawaldar.setThreadPinned(id, pinned);
						await refreshThreads();
					}}
				/>

				<div className="main-pane">
					{view === 'chat' && (
						<>
							<div className="chat-title">
								<span className="session-name">{activeTitle}</span>
								<div className="title-actions">
									{hasSelectedProvider ? (
										<span className="title-meta">{providerLabel}{modelLabel ? ` · ${modelLabel}` : ''}</span>
									) : (
										<button type="button" className="btn" onClick={openProviderSettings}>
											Select provider
										</button>
									)}
									<button
										type="button"
										className="icon-tool"
										title="Runtime"
										aria-label="Runtime"
										onClick={() => openView('podman')}
									>
										<ContainerIcon />
									</button>
									<button
										type="button"
										className="icon-tool"
										title="Settings"
										aria-label="Settings"
										onClick={() => openView('settings')}
									>
										<GearIcon />
									</button>
								</div>
							</div>
							<Chat
								agentId={agentId}
								onAgentChange={setAgentId}
								modelLabel={modelLabel}
								providerLabel={providerLabel}
								hasSelectedProvider={hasSelectedProvider}
								onModelChanged={() => void refreshThreads()}
								pendingCommand={pendingCommand}
								onCommandConsumed={() => setPendingCommand(undefined)}
								onActivity={() => void refreshThreads()}
							/>
						</>
					)}

					{view === 'settings' && (
						<Settings
							initialCategory={settingsCategory}
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

					{(view === 'agents' || view === 'tools' || view === 'workflows' || view === 'providers' || view === 'traces' || view === 'logs') && (
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
			</div>

			{quitPhase !== 'hidden' && (
				<QuitConfirm phase={quitPhase} onCancel={onQuitCancel} onConfirm={onQuitConfirm} />
			)}
		</div>
	);
}
