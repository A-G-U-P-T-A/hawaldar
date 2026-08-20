import type { MouseEvent, ReactNode } from 'react';
import { ChatIcon, CloseIcon, FindingsIcon, GraphIcon, NotesIcon, ReportsIcon, TasksIcon } from './navIcons';
import type { WorkspaceTab } from './workspaceTabs';
import { useI18n } from './i18n';

interface Props {
	tabs: WorkspaceTab[];
	activeId: string;
	/** Prefer key so two tabs that share an id cannot both paint as active. */
	activeKey?: string;
	dirtyIds?: ReadonlySet<string>;
	actions?: ReactNode;
	onFocus: (id: string) => void;
	onClose: (id: string) => void;
}

function TabGlyph({ tab }: { tab: WorkspaceTab }) {
	if (tab.kind === 'note') {
		return <NotesIcon size={18} />;
	}
	if (tab.kind === 'task' || tab.kind === 'tasks') {
		return <TasksIcon size={18} />;
	}
	if (tab.kind === 'graph') {
		return <GraphIcon size={18} />;
	}
	if (tab.kind === 'findings') {
		return <FindingsIcon size={18} />;
	}
	if (tab.kind === 'reports' || tab.kind === 'report') {
		return <ReportsIcon size={18} />;
	}
	return <ChatIcon size={18} />;
}

export default function TabStrip({ tabs, activeId, activeKey, dirtyIds, actions, onFocus, onClose }: Props) {
	const { t } = useI18n();
	const onAuxClick = (event: MouseEvent<HTMLButtonElement>, id: string) => {
		if (event.button === 1) {
			event.preventDefault();
			onClose(id);
		}
	};

	return (
		<div className="tab-strip">
			<div className="tab-strip-list" role="tablist" aria-label="Workspace tabs">
				{tabs.map((tab) => {
					const active = activeKey ? tab.key === activeKey : tab.id === activeId;
					const dirty = Boolean(dirtyIds?.has(tab.id));
					return (
						<div key={tab.key} className={`chrome-tab${active ? ' active' : ''}${dirty ? ' dirty' : ''}`}>
							<button
								type="button"
								role="tab"
								aria-selected={active}
								className="chrome-tab-main"
								title={dirty ? `${tab.title} (unsaved)` : tab.title}
								onClick={() => onFocus(tab.id)}
								onAuxClick={(event) => onAuxClick(event, tab.id)}
							>
								<span className="chrome-tab-glyph" aria-hidden="true">
									<TabGlyph tab={tab} />
								</span>
								<span className="chrome-tab-title">{tab.title}</span>
								{dirty && <span className="chrome-tab-dirty" aria-hidden="true" />}
							</button>
							<button
								type="button"
								className="chrome-tab-close"
								title={t('chrome.closeTab')}
								aria-label={`${t('chrome.closeTab')}: ${tab.title}`}
								onClick={(event) => {
									event.stopPropagation();
									onClose(tab.id);
								}}
							>
								<CloseIcon size={16} />
							</button>
						</div>
					);
				})}
			</div>
			{actions && <div className="tab-strip-actions title-actions">{actions}</div>}
		</div>
	);
}
