import type { PointerEvent as ReactPointerEvent } from 'react';

interface Props {
	label: string;
	onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
	onDoubleClick?: () => void;
	active?: boolean;
	className?: string;
}

export default function PaneSash({
	label,
	onPointerDown,
	onDoubleClick,
	active,
	className,
}: Props) {
	return (
		<div
			className={`pane-sash${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			title={`${label} — drag to resize, double-click to reset`}
			onPointerDown={onPointerDown}
			onDoubleClick={(event) => {
				event.preventDefault();
				event.stopPropagation();
				onDoubleClick?.();
			}}
		/>
	);
}
