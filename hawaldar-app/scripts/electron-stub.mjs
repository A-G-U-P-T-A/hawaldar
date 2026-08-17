/* Minimal electron stub for headless (non-GUI) Node runs, e.g. smoke-tools.
 * safeStorage is DPAPI-backed in the real app; headless we pass through. */
export const safeStorage = {
	isEncryptionAvailable: () => false,
	encryptString: (s) => Buffer.from(s, 'utf8'),
	decryptString: (b) => Buffer.from(b).toString('utf8'),
};
export const app = { isPackaged: false, getAppPath: () => process.cwd() };
export default { safeStorage, app };
