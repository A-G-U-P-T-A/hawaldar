interface Props {
	on: boolean;
	disabled?: boolean;
	onChange: (next: boolean) => void;
	label?: string;
	title?: string;
	tone?: 'thinking' | 'free';
}

export default function ThinkToggle({
	on,
	disabled,
	onChange,
	label = 'Thinking',
	title,
	tone = 'thinking',
}: Props) {
	const tip = title ?? (label === 'Thinking'
		? (on ? 'Thinking on — reasoning tokens when the model supports them' : 'Thinking off')
		: undefined);
	return (
		<button
			type="button"
			role="switch"
			className={`dd-switch dd-switch-${tone}${on ? ' on' : ''}`}
			aria-checked={on}
			disabled={disabled}
			title={tip}
			onClick={() => onChange(!on)}
		>
			<span className="dd-switch-label">{label}</span>
			<span className="dd-switch-track" aria-hidden>
				<span className="dd-switch-thumb" />
			</span>
		</button>
	);
}

export function modelSearchToolbar(opts: {
	showThinking: boolean;
	thinking: boolean;
	onThinking: (next: boolean) => void;
	showFree: boolean;
	freeOnly: boolean;
	onFreeOnly: (next: boolean) => void;
}) {
	if (!opts.showThinking && !opts.showFree) {
		return undefined;
	}
	return (
		<>
			{opts.showThinking && (
				<ThinkToggle on={opts.thinking} onChange={opts.onThinking} />
			)}
			{opts.showFree && (
				<ThinkToggle
					label="Free"
					tone="free"
					on={opts.freeOnly}
					onChange={opts.onFreeOnly}
					title={opts.freeOnly ? 'Showing free models' : 'Show free models only'}
				/>
			)}
		</>
	);
}
