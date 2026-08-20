import Icon, { type IconName } from './Icon';

interface IconProps {
	size?: number;
	filled?: boolean;
}

function Mark({ name, size = 20, filled }: IconProps & { name: IconName }) {
	return <Icon name={name} size={size} filled={filled} />;
}

export function GearIcon({ size, filled }: IconProps) {
	return <Mark name="settings" size={size} filled={filled} />;
}

export function ContainerIcon({ size, filled }: IconProps) {
	return <Mark name="deployed_code" size={size} filled={filled} />;
}

export function PinIcon({ size, filled = false }: IconProps) {
	return <Mark name="keep" size={size} filled={filled} />;
}

export function RenameIcon({ size, filled }: IconProps) {
	return <Mark name="edit" size={size} filled={filled} />;
}

export function ChevronIcon({
	size = 20,
	expand,
	direction,
}: IconProps & { expand?: boolean; direction?: 'left' | 'right' | 'down' }) {
	const dir = direction ?? (expand ? 'right' : 'left');
	const name: IconName = dir === 'down' ? 'expand_more' : dir === 'right' ? 'chevron_right' : 'chevron_left';
	return <Mark name={name} size={size} />;
}

export function AgentsIcon({ size, filled }: IconProps) {
	return <Mark name="smart_toy" size={size} filled={filled} />;
}

export function ToolsIcon({ size, filled }: IconProps) {
	return <Mark name="build" size={size} filled={filled} />;
}

export function WorkflowsIcon({ size, filled }: IconProps) {
	return <Mark name="account_tree" size={size} filled={filled} />;
}

export function ProvidersIcon({ size, filled }: IconProps) {
	return <Mark name="cloud" size={size} filled={filled} />;
}

export function TracesIcon({ size, filled }: IconProps) {
	return <Mark name="timeline" size={size} filled={filled} />;
}

export function LogsIcon({ size, filled }: IconProps) {
	return <Mark name="subject" size={size} filled={filled} />;
}

export function StatusIcon({ size, filled }: IconProps) {
	return <Mark name="info" size={size} filled={filled} />;
}

export function ChatIcon({ size, filled }: IconProps) {
	return <Mark name="chat" size={size} filled={filled} />;
}

export function NotesIcon({ size, filled }: IconProps) {
	return <Mark name="note_stack" size={size} filled={filled} />;
}

export function GraphIcon({ size, filled }: IconProps) {
	return <Mark name="hub" size={size} filled={filled} />;
}

export function FindingsIcon({ size, filled }: IconProps) {
	return <Mark name="bug_report" size={size} filled={filled} />;
}

export function ReportsIcon({ size, filled }: IconProps) {
	return <Mark name="description" size={size} filled={filled} />;
}

export function TasksIcon({ size, filled }: IconProps) {
	return <Mark name="task_alt" size={size} filled={filled} />;
}

export function HomeIcon({ size, filled }: IconProps) {
	return <Mark name="home" size={size} filled={filled} />;
}

export function AddIcon({ size, filled }: IconProps) {
	return <Mark name="add" size={size} filled={filled} />;
}

export function CloseIcon({ size, filled }: IconProps) {
	return <Mark name="close" size={size} filled={filled} />;
}

export function SearchIcon({ size, filled }: IconProps) {
	return <Mark name="search" size={size} filled={filled} />;
}

export function RefreshIcon({ size, filled }: IconProps) {
	return <Mark name="refresh" size={size} filled={filled} />;
}

export function DeleteIcon({ size, filled }: IconProps) {
	return <Mark name="delete" size={size} filled={filled} />;
}

export function SendIcon({ size, filled }: IconProps) {
	return <Mark name="arrow_upward" size={size} filled={filled} />;
}

export function OpenInNewIcon({ size, filled }: IconProps) {
	return <Mark name="open_in_new" size={size} filled={filled} />;
}

export function DragIcon({ size, filled }: IconProps) {
	return <Mark name="drag_indicator" size={size} filled={filled} />;
}
