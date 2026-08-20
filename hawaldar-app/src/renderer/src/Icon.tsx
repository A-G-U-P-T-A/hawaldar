import type { CSSProperties } from 'react';

/** Official Material Symbols Outlined ligatures used in Hawaldar chrome. */
export const ICONS = [
	'home',
	'chat',
	'add',
	'close',
	'search',
	'refresh',
	'settings',
	'deployed_code',
	'smart_toy',
	'build',
	'account_tree',
	'cloud',
	'timeline',
	'subject',
	'info',
	'hub',
	'task_alt',
	'bug_report',
	'description',
	'note_stack',
	'keep',
	'edit',
	'delete',
	'chevron_right',
	'chevron_left',
	'expand_more',
	'keyboard_arrow_up',
	'send',
	'arrow_upward',
	'open_in_new',
	'drag_indicator',
	'check_circle',
	'error',
	'progress_activity',
	'person',
	'flag',
	'shield',
	'database',
	'vpn_key',
	'public',
	'edit_note',
	'checklist',
	'gavel',
	'policy',
	'language',
	'light_mode',
	'dark_mode',
] as const;

export type IconName = (typeof ICONS)[number];

interface Props {
	name: IconName;
	size?: number;
	filled?: boolean;
	className?: string;
}

export default function Icon({ name, size = 20, filled = false, className }: Props) {
	const style: CSSProperties = {
		fontSize: size,
		width: size,
		height: size,
	};
	return (
		<span
			className={`ms-icon${filled ? ' is-filled' : ''}${className ? ` ${className}` : ''}`}
			style={style}
			aria-hidden="true"
		>
			{name}
		</span>
	);
}
