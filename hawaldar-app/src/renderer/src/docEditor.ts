export interface DocEditorHandle {
	save: () => Promise<boolean>;
	discard: () => void;
}

/** Ctrl+S / Cmd+S — document save, not a chat or global app save. */
export function isDocSaveHotkey(event: {
	defaultPrevented: boolean;
	altKey: boolean;
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	repeat?: boolean;
	key: string;
}): boolean {
	if (event.defaultPrevented || event.altKey || event.shiftKey || event.repeat) {
		return false;
	}
	if (event.key.toLowerCase() !== 's') {
		return false;
	}
	return event.metaKey || event.ctrlKey;
}
