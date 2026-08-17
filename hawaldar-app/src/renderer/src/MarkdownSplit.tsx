import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { isDocSaveHotkey } from './docEditor';
import MarkdownBody from './MarkdownBody';
import PaneSash from './PaneSash';
import { clampGrow, useDragResize, usePersistedPanelSize } from './paneResize';

interface Props {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	ariaLabel?: string;
	header?: ReactNode;
	onSave?: () => void;
}

/** Usable floor so a 50/50 min on both sides does not freeze the divider. */
const MARKDOWN_PANE_MIN_PX = 160;

export default function MarkdownSplit({
	value,
	onChange,
	placeholder,
	ariaLabel,
	header,
	onSave,
}: Props) {
	const splitRef = useRef<HTMLDivElement>(null);
	const pane = usePersistedPanelSize('markdownLeftPct');
	const resize = useDragResize({
		getValue: () => pane.sizeRef.current,
		apply: pane.setSize,
		clamp: (next) => {
			const width = splitRef.current?.clientWidth ?? 0;
			if (width <= 0) {
				return clampGrow(next, 20, 80);
			}
			const floorPct = Math.max(20, (MARKDOWN_PANE_MIN_PX / width) * 100);
			const maxPct = 100 - floorPct;
			if (maxPct <= floorPct) {
				return 50;
			}
			return clampGrow(next, floorPct, maxPct);
		},
		onCommit: pane.commit,
	});

	const onEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!onSave || !isDocSaveHotkey(event)) {
			return;
		}
		event.preventDefault();
		onSave();
	};

	return (
		<div
			ref={splitRef}
			className={`doc-editor-split${resize.active ? ' is-resizing' : ''}`}
			style={{ ['--md-left' as string]: `${pane.size}%` }}
			onKeyDown={onEditorKeyDown}
		>
			<div className="doc-editor-pane doc-editor-pane-edit">
				{header}
				<textarea
					className="doc-editor-body mono-input"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					spellCheck={false}
					placeholder={placeholder}
					aria-label={ariaLabel}
				/>
			</div>
			<PaneSash
				className="doc-editor-sash"
				label="Editor and preview"
				active={resize.active}
				onPointerDown={resize.onPointerDown}
				onDoubleClick={pane.reset}
			/>
			<div className="doc-editor-pane doc-editor-pane-preview" aria-label="Markdown preview">
				{value.trim()
					? <MarkdownBody className="doc-md" text={value} />
					: <div className="empty-rail">Nothing to preview.</div>}
			</div>
		</div>
	);
}
