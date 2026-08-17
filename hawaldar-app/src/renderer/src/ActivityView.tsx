import type { ReactNode } from 'react';
import MarkdownBody from './MarkdownBody';
import { toDisplayText } from './displayText';
import { restoreRedactedAddresses } from './keepAddresses';
import {
	findingBadgeFromStep,
	formatActivityLine,
	isApprovalWaitStep,
	isFindingRecordStep,
	isMemoryStep,
	isWorkflowStep,
	phaseLabel,
	workflowPhaseId,
	type ActivityStep,
	type DeskHop,
	type FindingBadge,
} from './chatActivityView';

function IconYou() {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
			<path d="M8 8a2.8 2.8 0 1 0 0-5.6A2.8 2.8 0 0 0 8 8zM2.6 13.4c.5-2.4 2.7-3.7 5.4-3.7s4.9 1.3 5.4 3.7c.1.6-.3 1.1-1 1.1H3.6c-.7 0-1.1-.5-1-1.1z" />
		</svg>
	);
}

function IconAgent() {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
			<path d="M5 2h6a1 1 0 0 1 1 1v1h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h1V3a1 1 0 0 1 1-1zm0 2H4v6h8V4h-1v1H5V4zm1 3.2a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8zm4 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8z" />
		</svg>
	);
}

function IconTool() {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
			<path d="M10.7 2.3a3.4 3.4 0 0 0-4.5 4.2L2.4 10.3a1.5 1.5 0 0 0 0 2.1l1.2 1.2a1.5 1.5 0 0 0 2.1 0l3.8-3.8a3.4 3.4 0 0 0 4.2-4.5l-2 2-2.1-.5-.5-2.1 2-2a3.4 3.4 0 0 0-.4-.4z" />
		</svg>
	);
}

function IconPhase() {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
			<path d="M3.5 2a.75.75 0 0 0-.75.75v10.5a.75.75 0 0 0 1.5 0V9.6l1.7-.43a4 4 0 0 1 2.2.06l1.9.63a2.5 2.5 0 0 0 2.26-.4l1.06-.82a.75.75 0 0 0 .12-1.05L11.05 4.6l2.44-2.02a.75.75 0 0 0-.47-1.33H4.25c-.26 0-.51.1-.7.29z" />
		</svg>
	);
}

function IconMemory() {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
			<ellipse cx="8" cy="3.6" rx="5.2" ry="2.1" />
			<path d="M2.8 5.9v2.2c0 1.2 2.3 2.1 5.2 2.1s5.2-.9 5.2-2.1V5.9c-1 1-3 1.6-5.2 1.6s-4.2-.6-5.2-1.6z" />
			<path d="M2.8 10.3v2.1c0 1.2 2.3 2.1 5.2 2.1s5.2-.9 5.2-2.1v-2.1c-1 1-3 1.6-5.2 1.6s-4.2-.6-5.2-1.6z" />
		</svg>
	);
}

function IconShield() {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
			<path d="M8 1.6 3 3.7v3.5c0 3.1 2.1 5.9 5 7.2 2.9-1.3 5-4.1 5-7.2V3.7L8 1.6zm2.7 5-3.2 3.4a.75.75 0 0 1-1.1 0L5.2 8.7a.75.75 0 1 1 1.1-1l1.2 1.3L9.6 5.5a.75.75 0 1 1 1.1 1z" />
		</svg>
	);
}

function IconFlag() {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
			<path d="M11.8 2H4.5a.75.75 0 0 0-.75.75v10.5a.75.75 0 0 0 1.5 0V9.5h6.05a.75.75 0 0 0 .6-1.2L10.4 5.7l1.5-2.6a.75.75 0 0 0-.6-1.1z" />
		</svg>
	);
}

function StatusIcon({ status }: { status: ActivityStep['status'] }) {
	if (status === 'start') {
		return <span className="tool-status is-running" aria-label="running" />;
	}
	if (status === 'error') {
		return (
			<span className="tool-status is-error" aria-label="failed">
				<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
					<path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM5.3 5.3a.75.75 0 0 1 1 0L8 6.9l1.7-1.6a.75.75 0 1 1 1 1L9.2 8l1.6 1.7a.75.75 0 1 1-1 1L8 9.2l-1.7 1.6a.75.75 0 1 1-1-1L6.9 8 5.3 6.3a.75.75 0 0 1 0-1z" />
				</svg>
			</span>
		);
	}
	return (
		<span className="tool-status is-ok" aria-label="done">
			<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
				<path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm3 5.2-3.5 3.8a.75.75 0 0 1-1.1 0L5 9a.75.75 0 1 1 1.1-1l.9 1 2.9-3.2a.75.75 0 1 1 1.1 1z" />
			</svg>
		</span>
	);
}

const HOP_ICONS: Record<DeskHop['kind'], ReactNode> = {
	you: <IconYou />,
	agent: <IconAgent />,
	tool: <IconTool />,
	phase: <IconPhase />,
};

export function ActivityTrail({ hops }: { hops: DeskHop[] }) {
	if (hops.length === 0) return null;
	return (
		<div className="trail" aria-label="Execution path">
			{hops.map((hop, index) => (
				<span key={`${hop.kind}-${hop.label}`} className="trail-item">
					{index > 0 ? <span className="trail-sep" aria-hidden>›</span> : null}
					<span className={`trail-chip is-${hop.kind}`}>
						<span className="trail-icon" aria-hidden>{HOP_ICONS[hop.kind]}</span>
						{hop.label}
					</span>
				</span>
			))}
		</div>
	);
}

function looksLikeOutput(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (trimmed.includes('\n')) return true;
	if (trimmed.length > 160) return true;
	return false;
}

function firstLine(text: string, max = 140): string {
	const line = text.split('\n')[0].trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function ToolRow({ step }: { step: ActivityStep }) {
	const phaseId = workflowPhaseId(step);
	const approval = isApprovalWaitStep(step);
	const detail = step.detail ? restoreRedactedAddresses(toDisplayText(step.detail)).trim() : '';
	const expandable = !phaseId && !approval && looksLikeOutput(detail);
	const line = formatActivityLine({ ...step, detail });
	const title = phaseId ? phaseLabel(phaseId) : expandable ? firstLine(line) : line;

	const head = (
		<>
			<StatusIcon status={step.status} />
			<span className={`tool-row-label${phaseId ? ' is-phase' : ''}${approval ? ' is-approval' : ''}`}>
				{approval ? <span className="tool-row-shield" aria-hidden><IconShield /></span> : null}
				{title}
				{step.status === 'start' ? <span className="ellipsis" /> : null}
			</span>
		</>
	);

	if (expandable) {
		return (
			<details className={`tool-row${step.status === 'error' ? ' is-error' : ''}${step.status === 'start' ? ' is-running' : ''}`}>
				<summary>{head}</summary>
				<pre className="tool-row-output">{detail}</pre>
			</details>
		);
	}
	return (
		<div
			className={`tool-row${step.status === 'error' ? ' is-error' : ''}${step.status === 'start' ? ' is-running' : ''}${phaseId ? ' is-phase' : ''}${approval ? ' is-approval' : ''}`}
		>
			{head}
		</div>
	);
}

export function ToolStepList({ steps }: { steps: ActivityStep[] }) {
	if (steps.length === 0) return null;
	return (
		<div className="tool-steps">
			{steps.map((step) => <ToolRow key={step.id} step={step} />)}
		</div>
	);
}

function memoryPreview(detail: string): string[] {
	return detail
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('- ') && !line.endsWith(':'))
		.map((line) => line.slice(2).trim())
		.filter(Boolean)
		.slice(0, 3);
}

export function MemoryCard({ step }: { step: ActivityStep }) {
	const detail = step.detail ? restoreRedactedAddresses(toDisplayText(step.detail)).trim() : '';
	const preview = memoryPreview(detail);
	return (
		<div className={`memory-card${step.status === 'start' ? ' is-running' : ''}`}>
			<div className="memory-card-head">
				<span className="memory-card-icon" aria-hidden><IconMemory /></span>
				<span className="memory-card-title">Working memory updated</span>
				{step.status === 'start' ? <span className="ellipsis" /> : null}
			</div>
			{preview.length > 0 ? (
				<ul className="memory-card-preview">
					{preview.map((line) => <li key={line}>{line}</li>)}
				</ul>
			) : null}
			{detail ? (
				<details className="memory-card-full">
					<summary>Show scratchpad</summary>
					<MarkdownBody text={detail} />
				</details>
			) : null}
		</div>
	);
}

const SEV_LABEL: Record<FindingBadge['severity'], string> = {
	critical: 'Critical',
	high: 'High',
	medium: 'Medium',
	low: 'Low',
	info: 'Info',
};

export function FindingLine({ step, onOpenFindings }: { step: ActivityStep; onOpenFindings?: () => void }) {
	const badge = findingBadgeFromStep(step);
	if (!badge) return null;
	const title = restoreRedactedAddresses(badge.title);
	return (
		<div className={`finding-line sev-${badge.severity}${step.status === 'error' ? ' is-error' : ''}`}>
			<span className="finding-line-icon" aria-hidden><IconFlag /></span>
			<span className={`finding-line-sev sev-${badge.severity}`}>
				<span className="finding-line-dot" aria-hidden />
				{SEV_LABEL[badge.severity]}
			</span>
			<span className="finding-line-title" title={title}>{title}</span>
			{onOpenFindings ? (
				<button
					type="button"
					className="finding-line-open"
					onClick={onOpenFindings}
					title="Open the Findings tab"
				>
					Findings →
				</button>
			) : null}
		</div>
	);
}
