interface IconProps {
	size?: number;
}

export function GearIcon({ size = 16 }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
			<circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.75" />
			<path
				d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
				stroke="currentColor"
				strokeWidth="1.75"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function ContainerIcon({ size = 16 }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
			<rect x="3" y="2.4" width="10" height="4.4" rx="1.1" stroke="currentColor" strokeWidth="1.35" />
			<rect x="2.4" y="8.2" width="11.2" height="5.4" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
			<path d="M5.2 10.9h5.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
		</svg>
	);
}

export function PinIcon({ size = 16, filled = false }: IconProps & { filled?: boolean }) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
			<path
				d="M8.9 2.4 13.6 7c.3.3.2.8-.2 1l-1.6.7-2.5 2.5-.7 1.7c-.2.4-.7.5-1 .2L3.9 9.4c-.3-.3-.2-.8.2-1l1.7-.7 2.5-2.5.7-1.6c.2-.4.7-.5 1-.2Z"
				fill={filled ? 'currentColor' : 'none'}
				stroke="currentColor"
				strokeWidth="1.35"
				strokeLinejoin="round"
			/>
			<path d="M6.2 9.8 3.2 13.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
		</svg>
	);
}

export function RenameIcon({ size = 16 }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
			<path d="M9.2 3.4 12.6 6.8 6 13.4H2.6V10Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
			<path d="M8.1 4.5 11.5 7.9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
		</svg>
	);
}

export function ChevronIcon({ size = 16, expand }: IconProps & { expand?: boolean }) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
			<path
				d={expand ? 'M6 3.5 10.5 8 6 12.5' : 'M10 3.5 5.5 8 10 12.5'}
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function AgentsIcon({ size = 16 }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
			<circle cx="6" cy="5.2" r="1.7" stroke="currentColor" strokeWidth="1.35" />
			<path d="M2.6 12.4c.2-2.1 1.6-3.3 3.4-3.3s3.2 1.2 3.4 3.3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
			<circle cx="11.1" cy="5.6" r="1.35" stroke="currentColor" strokeWidth="1.3" />
			<path d="M10.2 9.3c1.2.15 2.2 1 2.4 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
		</svg>
	);
}

export function ToolsIcon({ size = 16 }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
			<path
				d="M10.6 2.6a2.6 2.6 0 0 0-3.5 3.1L3.4 9.4a1.4 1.4 0 0 0 2 2l3.7-3.7a2.6 2.6 0 0 0 3.1-3.5L10.8 5.6 10.6 2.6z"
				stroke="currentColor"
				strokeWidth="1.35"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function WorkflowsIcon({ size = 16 }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
			<circle cx="4" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.35" />
			<circle cx="12" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.35" />
			<circle cx="4" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.35" />
			<path d="M5.5 4.6 10.4 7.3M5.5 11.4 10.4 8.7" stroke="currentColor" strokeWidth="1.35" />
		</svg>
	);
}

export function ProvidersIcon({ size = 16 }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
			<path
				d="M5.2 11.6h6.3A2.5 2.5 0 0 0 12 6.8a3.1 3.1 0 0 0-5.9-.7A2.4 2.4 0 0 0 5.2 11.6z"
				stroke="currentColor"
				strokeWidth="1.35"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function TracesIcon({ size = 16 }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
			<path d="M2.4 10.2 5.6 5.8 8.2 9.4 13.6 4.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
			<circle cx="13.6" cy="4.4" r="1.1" fill="currentColor" />
		</svg>
	);
}

export function LogsIcon({ size = 16 }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
			<path d="M3.2 4.2h9.6M3.2 8h9.6M3.2 11.8h6.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
		</svg>
	);
}

export function StatusIcon({ size = 16 }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
			<circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.35" />
			<path d="M8 7.1v4.1" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
			<circle cx="8" cy="5.2" r="0.7" fill="currentColor" />
		</svg>
	);
}
