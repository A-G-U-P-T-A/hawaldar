import Icon from './Icon';
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

function HopGlyph({ kind }: { kind: DeskHop['kind'] }) {
	const name = kind === 'you' ? 'person' : kind === 'agent' ? 'smart_toy' : kind === 'tool' ? 'build' : 'flag';
	return <Icon name={name} size={16} />;
}

function StepStatus({ status }: { status: ActivityStep['status'] }) {
	if (status === 'start') {
		return <span className="tool-status is-running" aria-label="running" />;
	}
	if (status === 'error') {
		return (
			<span className="tool-status is-error" aria-label="failed">
				<Icon name="error" size={16} filled />
			</span>
		);
	}
	return (
		<span className="tool-status is-ok" aria-label="done">
			<Icon name="check_circle" size={16} filled />
		</span>
	);
}

export function ActivityTrail({ hops }: { hops: DeskHop[] }) {
	if (hops.length === 0) return null;
	return (
		<div className="trail" aria-label="Execution path">
			{hops.map((hop, index) => (
				<span key={`${hop.kind}-${hop.label}`} className="trail-item">
					{index > 0 ? <span className="trail-sep" aria-hidden>›</span> : null}
					<span className={`trail-chip is-${hop.kind}`}>
						<span className="trail-icon" aria-hidden><HopGlyph kind={hop.kind} /></span>
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
			<StepStatus status={step.status} />
			<span className={`tool-row-label${phaseId ? ' is-phase' : ''}${approval ? ' is-approval' : ''}`}>
				{approval ? <span className="tool-row-shield" aria-hidden><Icon name="shield" size={16} filled /></span> : null}
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
				<span className="memory-card-icon" aria-hidden><Icon name="database" size={16} /></span>
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
			<span className="finding-line-icon" aria-hidden><Icon name="flag" size={16} filled /></span>
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
