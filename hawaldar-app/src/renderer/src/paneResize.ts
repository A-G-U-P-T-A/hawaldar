import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

const STORAGE_KEY = 'hawaldar.panelSizes';

/** CSS defaults — also the hard minimum (grow-only, shrink back to this). */
export const PANEL_DEFAULTS = {
	sidebar: 280,
	rightRail: 280,
	settingsNav: 192,
	markdownLeftPct: 50,
	libraryLeft: 220,
} as const;

export type PanelSizeKey = keyof typeof PANEL_DEFAULTS;

type PanelSizes = Partial<Record<PanelSizeKey, number>>;

function readAll(): PanelSizes {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw) as PanelSizes;
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

function writeAll(next: PanelSizes) {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		/* private mode / quota */
	}
}

function sanitize(key: PanelSizeKey, value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return null;
	}
	if (key === 'markdownLeftPct') {
		return Math.min(80, Math.max(20, Math.round(value * 10) / 10));
	}
	return Math.max(PANEL_DEFAULTS[key], Math.round(value));
}

export function readPanelSize(key: PanelSizeKey): number {
	return sanitize(key, readAll()[key]) ?? PANEL_DEFAULTS[key];
}

export function readPanelSizeOptional(key: PanelSizeKey): number | null {
	return sanitize(key, readAll()[key]);
}

export function writePanelSize(key: PanelSizeKey, value: number) {
	const next = { ...readAll(), [key]: sanitize(key, value) ?? PANEL_DEFAULTS[key] };
	writeAll(next);
}

export function clearPanelSize(key: PanelSizeKey) {
	const next = { ...readAll() };
	delete next[key];
	writeAll(next);
}

export function usePersistedPanelSize(key: PanelSizeKey) {
	const fallback = PANEL_DEFAULTS[key];
	const [size, setSizeState] = useState(() => readPanelSize(key));
	const sizeRef = useRef(size);
	sizeRef.current = size;

	const setSize = useCallback((next: number) => {
		const clamped = sanitize(key, next) ?? fallback;
		sizeRef.current = clamped;
		setSizeState(clamped);
	}, [fallback, key]);

	const commit = useCallback(() => {
		writePanelSize(key, sizeRef.current);
	}, [key]);

	const reset = useCallback(() => {
		sizeRef.current = fallback;
		setSizeState(fallback);
		clearPanelSize(key);
	}, [fallback, key]);

	return { size, sizeRef, setSize, commit, reset, min: fallback };
}

export function useDragResize(options: {
	enabled?: boolean;
	invert?: boolean;
	/** When true, pointerdown does not preventDefault (needed so a button still clicks). */
	allowClick?: boolean;
	getValue: () => number;
	apply: (next: number) => void;
	clamp?: (next: number) => number;
	onCommit?: () => void;
}) {
	const enabled = options.enabled !== false;
	const invert = Boolean(options.invert);
	const allowClick = Boolean(options.allowClick);
	const getValueRef = useRef(options.getValue);
	const applyRef = useRef(options.apply);
	const clampRef = useRef(options.clamp);
	const onCommitRef = useRef(options.onCommit);
	getValueRef.current = options.getValue;
	applyRef.current = options.apply;
	clampRef.current = options.clamp;
	onCommitRef.current = options.onCommit;

	const dragRef = useRef<{
		id: number;
		startX: number;
		startValue: number;
		moved: boolean;
		el: HTMLElement;
	} | null>(null);
	const draggedRef = useRef(false);
	const [active, setActive] = useState(false);

	const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
		if (!enabled || event.button !== 0) {
			return;
		}
		if (!allowClick) {
			event.preventDefault();
		}
		event.stopPropagation();
		const el = event.currentTarget;
		el.setPointerCapture(event.pointerId);
		draggedRef.current = false;
		dragRef.current = {
			id: event.pointerId,
			startX: event.clientX,
			startValue: getValueRef.current(),
			moved: false,
			el,
		};
		document.body.classList.add('is-pane-resizing');
		setActive(true);
	}, [allowClick, enabled]);

	useEffect(() => {
		if (!active) {
			document.body.classList.remove('is-pane-resizing');
			return;
		}
		document.body.classList.add('is-pane-resizing');
		const onMove = (event: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag || event.pointerId !== drag.id) {
				return;
			}
			const dx = invert ? drag.startX - event.clientX : event.clientX - drag.startX;
			if (!drag.moved && Math.abs(dx) < 3) {
				return;
			}
			drag.moved = true;
			draggedRef.current = true;
			const raw = drag.startValue + dx;
			const next = clampRef.current ? clampRef.current(raw) : raw;
			applyRef.current(next);
		};
		const onUp = (event: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag || event.pointerId !== drag.id) {
				return;
			}
			dragRef.current = null;
			setActive(false);
			try {
				drag.el.releasePointerCapture(event.pointerId);
			} catch {
				/* already released */
			}
			if (drag.moved) {
				onCommitRef.current?.();
			}
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
		return () => {
			document.body.classList.remove('is-pane-resizing');
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
		};
	}, [active, invert]);

	const consumeDrag = useCallback(() => {
		const moved = draggedRef.current;
		draggedRef.current = false;
		return moved;
	}, []);

	return { onPointerDown, active, consumeDrag };
}

export function clampGrow(next: number, min: number, max: number) {
	return Math.max(min, Math.min(Math.max(min, max), next));
}

/** Keep the center column usable while a side rail grows. */
export const MAIN_PANE_MIN = 360;
