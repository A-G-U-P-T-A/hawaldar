import type { HawaldarAPI } from './api';

declare global {
	interface Window {
		hawaldar: HawaldarAPI;
	}
}

export {};
