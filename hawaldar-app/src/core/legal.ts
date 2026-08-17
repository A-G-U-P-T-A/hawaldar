/** Bump when in-app authorized-use text changes so operators re-accept. */
export const LEGAL_VERSION = '1';

export interface LegalDocument {
	version: string;
	licenseName: string;
	licenseId: string;
	summary: string[];
	authorizedUse: string[];
	runtime: string[];
	disclaimer: string;
}

export const LEGAL_DOCUMENT: LegalDocument = {
	version: LEGAL_VERSION,
	licenseName: 'Apache License 2.0',
	licenseId: 'Apache-2.0',
	summary: [
		'Hawaldar is open source under Apache License 2.0. That license includes a copyright license and an express patent grant, which is why companies can adopt it for real work.',
		'You may use, modify, and distribute the software under Apache-2.0. The full text ships as LICENSE. NOTICE is attribution only and does not change the license.',
	],
	authorizedUse: [
		'Hawaldar is a reconnaissance and authorized pentest workstation. Use it only on systems you own or administer, with prior written permission from the owner, or under a contracted engagement.',
		'Unauthorized scanning, access, or interference can be a crime. You are responsible for scope, approvals, and the law that applies to you.',
		'Accepting these terms records that you saw them. It is not a clickwrap substitute for an engagement letter, statement of work, or legal advice. See LICENSE-USAGE.md in the source tree.',
	],
	runtime: [
		'Hawaldar requires Podman (or Docker if it is already installed). Without a container engine, tools do not run.',
		'Do not look for a wiki as the install path. After you accept, open Set up Podman in the app. On Windows that flow uses winget or the official MSI and needs WSL or Hyper-V. The app does not silently install Podman.',
	],
	disclaimer: 'Software is provided AS IS under Apache-2.0. Contributors are not liable for how you use it.',
};

export function isLegalAccepted(version?: string, acceptedAt?: number | null): boolean {
	const at = Number(acceptedAt) || 0;
	return Boolean(version && version === LEGAL_VERSION && at > 0);
}
