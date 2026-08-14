import { minImageFor } from '../sandbox/images';

export type ToolKind = 'host' | 'file' | 'pcap' | 'meta';

export interface ToolSpec {
	id: string;
	agentId: string;
	title: string;
	kind: ToolKind;
	image: string;
	enabled: boolean;
	timeoutMs: number;
	description: string;
	/** Private note only. Never shown in product UI. */
	origin?: string;
	/** Accepted so catalog edits can keep a note. Never shown in product UI. */
	mcp?: string;
}

const I = minImageFor;

/** First-party Hawaldar tools. They run in Podman images. Refused ids are listed in EXCLUDED_MCP_TOOLS. */
export const TOOL_CATALOG: ToolSpec[] = [
	{ id: 'discover-hosts', agentId: 'nmap', title: 'Discover hosts', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 120_000, description: 'Ping scan (-sn) of an in-scope host or /24.' },
	{ id: 'quick-scan', agentId: 'nmap', title: 'Quick scan', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 180_000, description: 'TCP connect top-N ports.' },
	{ id: 'scan-ports', agentId: 'nmap', title: 'Scan ports', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 180_000, description: 'TCP connect scan. Stealth types are refused.' },
	{ id: 'detect-services', agentId: 'nmap', title: 'Detect services', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 240_000, description: 'TCP connect + version detect.' },
	{ id: 'scan-top-ports', agentId: 'nmap', title: 'Scan top ports', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 180_000, description: 'TCP connect scan of nmap top-N ports (default 100, max 1000).' },
	{ id: 'scan-port-range', agentId: 'nmap', title: 'Scan port range', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 300_000, description: 'TCP connect scan of an explicit port range (e.g. 1-1024).' },
	{ id: 'probe-http-ports', agentId: 'nmap', title: 'Probe HTTP ports', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 240_000, description: 'TCP connect + version on 80,443,8080,8443.' },
	{ id: 'reverse-dns', agentId: 'nmap', title: 'Reverse DNS', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 60_000, description: 'List scan (-sL) with system DNS / PTR. No port scan.' },
	{ id: 'nmap-xml-summary', agentId: 'nmap', title: 'Nmap XML summary', kind: 'meta', image: I('nmap'), enabled: true, timeoutMs: 15_000, description: 'Summarize the last workspace nmap XML (open ports, PTR).' },
	{ id: 'analyze_pcap', agentId: 'tshark', title: 'Analyze pcap', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'Packet JSON from a local pcap.' },
	{ id: 'get_summary_stats', agentId: 'tshark', title: 'Pcap protocol stats', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'tshark -z io,phs' },
	{ id: 'get_conversations', agentId: 'tshark', title: 'Pcap conversations', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'tshark -z conv,tcp' },
	{ id: 'pcap-protocols', agentId: 'tshark', title: 'Pcap protocol hierarchy', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'Protocol hierarchy from a workspace or mounted pcap.' },
	{ id: 'pcap-endpoints', agentId: 'tshark', title: 'Pcap endpoints', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'IPv4 and IPv6 endpoints from a workspace or mounted pcap.' },
	{ id: 'pcap-dns', agentId: 'tshark', title: 'Pcap DNS', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'DNS query and response names from a workspace or mounted pcap.' },
	{ id: 'pcap-http', agentId: 'tshark', title: 'Pcap HTTP', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'HTTP request hosts and URIs from a workspace or mounted pcap. Does not extract credentials.' },
	{ id: 'pcap-follow-stream', agentId: 'tshark', title: 'Pcap follow stream', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'Follow a TCP or UDP stream by index from a workspace or mounted pcap.' },
	{ id: 'pcap-export-objects', agentId: 'tshark', title: 'Pcap export HTTP objects', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'Export reconstructed HTTP objects into the shared workspace. Does not extract credentials.' },
	{ id: 'list_methods', agentId: 'ghidra', title: 'List functions', kind: 'file', image: I('ghidra'), enabled: true, timeoutMs: 300_000, description: 'Functions from headless Ghidra.' },
	{ id: 'list_imports', agentId: 'ghidra', title: 'List imports', kind: 'file', image: I('ghidra'), enabled: true, timeoutMs: 300_000, description: 'Imports from headless Ghidra.' },
	{ id: 'list_exports', agentId: 'ghidra', title: 'List exports', kind: 'file', image: I('ghidra'), enabled: true, timeoutMs: 300_000, description: 'Exports from headless Ghidra.' },
	{ id: 'list_strings', agentId: 'ghidra', title: 'List strings', kind: 'file', image: I('ghidra'), enabled: true, timeoutMs: 300_000, description: 'Defined strings from headless Ghidra.' },
	{ id: 'decompile_function', agentId: 'ghidra', title: 'Decompile function', kind: 'file', image: I('ghidra'), enabled: true, timeoutMs: 300_000, description: 'Pseudo-C for one function name.' },
	{ id: 'list_xrefs', agentId: 'ghidra', title: 'List xrefs', kind: 'file', image: I('ghidra'), enabled: true, timeoutMs: 300_000, description: 'Incoming xrefs to functions. Optional functionName filter.' },
	{ id: 'ghidra-entry', agentId: 'ghidra', title: 'Entry points', kind: 'file', image: I('ghidra'), enabled: true, timeoutMs: 300_000, description: 'Program entry points from the headless dump.' },
	{ id: 'r2_info', agentId: 'radare', title: 'Binary info', kind: 'file', image: I('radare'), enabled: true, timeoutMs: 120_000, description: 'r2 iI binary identity.' },
	{ id: 'r2_functions', agentId: 'radare', title: 'r2 functions', kind: 'file', image: I('radare'), enabled: true, timeoutMs: 180_000, description: 'r2 afl after aaa.' },
	{ id: 'r2_imports', agentId: 'radare', title: 'r2 imports', kind: 'file', image: I('radare'), enabled: true, timeoutMs: 120_000, description: 'r2 ii.' },
	{ id: 'r2_strings', agentId: 'radare', title: 'r2 strings', kind: 'file', image: I('radare'), enabled: true, timeoutMs: 120_000, description: 'r2 iz.' },
	{ id: 'r2_sections', agentId: 'radare', title: 'r2 sections', kind: 'file', image: I('radare'), enabled: true, timeoutMs: 120_000, description: 'Section headers (iS).' },
	{ id: 'r2_libs', agentId: 'radare', title: 'r2 libraries', kind: 'file', image: I('radare'), enabled: true, timeoutMs: 120_000, description: 'Linked libraries (il).' },
	{ id: 'r2_disasm', agentId: 'radare', title: 'r2 disasm', kind: 'file', image: I('radare'), enabled: true, timeoutMs: 180_000, description: 'Disassemble 64 instructions at functionName or address.' },
	{ id: 'binwalk_scan', agentId: 'binwalk', title: 'Binwalk scan', kind: 'file', image: I('binwalk'), enabled: true, timeoutMs: 180_000, description: 'Signature scan only. No extract.' },
	{ id: 'binwalk_entropy', agentId: 'binwalk', title: 'Binwalk entropy', kind: 'file', image: I('binwalk'), enabled: true, timeoutMs: 180_000, description: 'Entropy plot text.' },
	{ id: 'binwalk_signature', agentId: 'binwalk', title: 'Binwalk signatures', kind: 'file', image: I('binwalk'), enabled: true, timeoutMs: 180_000, description: 'Signature scan only (-B). No extract.' },
	{ id: 'binwalk_extract', agentId: 'binwalk', title: 'Binwalk extract', kind: 'file', image: I('binwalk'), enabled: true, timeoutMs: 180_000, description: 'Carve known signatures into the workspace binaries folder.' },
	{ id: 'subfinder', agentId: 'subfinder', title: 'Subfinder', kind: 'host', image: I('subfinder'), enabled: true, timeoutMs: 180_000, description: 'Passive subdomains for an in-scope domain.' },
	{ id: 'subfinder-silent', agentId: 'subfinder', title: 'Subfinder silent', kind: 'host', image: I('subfinder'), enabled: true, timeoutMs: 180_000, description: 'Passive subdomains, silent/no-color output, in-scope domain only.' },
	{ id: 'subfinder-sources', agentId: 'subfinder', title: 'Subfinder all sources', kind: 'host', image: I('subfinder'), enabled: true, timeoutMs: 180_000, description: 'Passive subdomains using all sources for an in-scope domain.' },
	{ id: 'dnsx', agentId: 'dnsx', title: 'dnsx', kind: 'host', image: I('dnsx'), enabled: true, timeoutMs: 120_000, description: 'A/AAAA/CNAME for an in-scope host.' },
	{ id: 'dnsx-a', agentId: 'dnsx', title: 'dnsx A', kind: 'host', image: I('dnsx'), enabled: true, timeoutMs: 120_000, description: 'A record probe for an in-scope host.' },
	{ id: 'dnsx-cname', agentId: 'dnsx', title: 'dnsx CNAME', kind: 'host', image: I('dnsx'), enabled: true, timeoutMs: 120_000, description: 'CNAME probe for an in-scope host.' },
	{ id: 'httpx', agentId: 'httpx', title: 'httpx', kind: 'host', image: I('httpx'), enabled: true, timeoutMs: 120_000, description: 'HTTP probe + title + tech.' },
	{ id: 'httpx-title', agentId: 'httpx', title: 'httpx title', kind: 'host', image: I('httpx'), enabled: true, timeoutMs: 120_000, description: 'HTTP probe with page title for an in-scope URL.' },
	{ id: 'httpx-tech', agentId: 'httpx', title: 'httpx tech', kind: 'host', image: I('httpx'), enabled: true, timeoutMs: 120_000, description: 'HTTP probe with technology detect for an in-scope URL.' },
	{ id: 'naabu', agentId: 'naabu', title: 'naabu', kind: 'host', image: I('naabu'), enabled: true, timeoutMs: 180_000, description: 'Top-100 TCP connect ports.' },
	{ id: 'naabu-top-ports', agentId: 'naabu', title: 'naabu top ports', kind: 'host', image: I('naabu'), enabled: true, timeoutMs: 180_000, description: 'Top-1000 TCP connect ports on an in-scope host.' },
	{ id: 'katana', agentId: 'katana', title: 'katana', kind: 'host', image: I('katana'), enabled: true, timeoutMs: 180_000, description: 'Crawl depth 2, same host only.' },
	{ id: 'katana-depth', agentId: 'katana', title: 'katana depth', kind: 'host', image: I('katana'), enabled: true, timeoutMs: 180_000, description: 'Crawl depth 3, same host (fqdn), in-scope URL.' },
	{ id: 'katana-js', agentId: 'katana', title: 'katana JS', kind: 'host', image: I('katana'), enabled: true, timeoutMs: 180_000, description: 'JS crawl at depth 1, same host, in-scope URL.' },
	{ id: 'nuclei', agentId: 'nuclei', title: 'nuclei (info)', kind: 'host', image: I('nuclei'), enabled: true, timeoutMs: 180_000, description: 'tech/dns/discovery tags, info severity only.' },
	{ id: 'nuclei-tech', agentId: 'nuclei', title: 'nuclei tech', kind: 'host', image: I('nuclei'), enabled: true, timeoutMs: 180_000, description: 'Tech-detect templates, info severity only.' },
	{ id: 'nuclei-severity-info', agentId: 'nuclei', title: 'nuclei info/low', kind: 'host', image: I('nuclei'), enabled: true, timeoutMs: 180_000, description: 'tech/misconfig/discovery tags, info and low severity only.' },
	{ id: 'amass', agentId: 'amass', title: 'Amass passive', kind: 'host', image: I('amass'), enabled: true, timeoutMs: 180_000, description: 'Passive enum only.' },
	{ id: 'amass-passive', agentId: 'amass', title: 'Amass passive enum', kind: 'host', image: I('amass'), enabled: true, timeoutMs: 180_000, description: 'Passive enum only for an in-scope domain.' },
	{ id: 'ffuf_dir', agentId: 'ffuf', title: 'ffuf dirs', kind: 'host', image: I('ffuf'), enabled: true, timeoutMs: 180_000, description: 'Directory fuzz with the built-in short wordlist.' },
	{ id: 'ffuf_vhost', agentId: 'ffuf', title: 'ffuf vhost', kind: 'host', image: I('ffuf'), enabled: true, timeoutMs: 180_000, description: 'Host-header vhost fuzz with the built-in short wordlist. In-scope host only.' },
	{ id: 'ffuf_extensions', agentId: 'ffuf', title: 'ffuf extensions', kind: 'host', image: I('ffuf'), enabled: true, timeoutMs: 180_000, description: 'Directory fuzz with common extensions and the built-in short wordlist.' },
];

export const EXCLUDED_MCP_TOOLS = [
	{ id: 'metasploit_run', reason: 'Exploitation. ADR 0003.' },
	{ id: 'sqlmap_scan', reason: 'Exploitation. ADR 0003.' },
	{ id: 'extract_credentials', reason: 'Credential dump refused.' },
	{ id: 'scan-vulnerabilities', reason: 'NSE vuln/exploit path refused.' },
	{ id: 'scan-ports:syn|fin|xmas|null', reason: 'Stealth scan types refused.' },
	{ id: 'traceroute-connect', reason: 'Needs CAP_NET_RAW / raw sockets. Not wired.' },
	{ id: 'ghidra.eval / r2_command', reason: 'Arbitrary runtime exec refused.' },
	{ id: 'shell_command', reason: 'Host/container shell is not a model tool.' },
	{ id: 'nuclei exploit/critical', reason: 'Exploit and high-severity templates refused.' },
	{ id: 'ffuf login/credential', reason: 'Password and credential spray refused.' },
];

export const AGENT_ROLES: Array<{ id: string; name: string; role: string }> = [
	{ id: 'orchestrator', name: 'Orchestrator', role: 'supervisor · delegates to specialists' },
	{ id: 'policy', name: 'Policy', role: 'scope gate' },
	{ id: 'nmap', name: 'Nmap', role: 'host discovery and port scans' },
	{ id: 'tshark', name: 'tshark', role: 'pcap analysis' },
	{ id: 'ghidra', name: 'Ghidra', role: 'read-only binary analysis' },
	{ id: 'radare', name: 'Radare2', role: 'read-only binary inspection' },
	{ id: 'binwalk', name: 'Binwalk', role: 'firmware signature scan' },
	{ id: 'subfinder', name: 'Subfinder', role: 'passive subdomain enum' },
	{ id: 'dnsx', name: 'dnsx', role: 'DNS record probes' },
	{ id: 'httpx', name: 'httpx', role: 'HTTP probe and tech detect' },
	{ id: 'naabu', name: 'naabu', role: 'TCP connect top ports' },
	{ id: 'katana', name: 'katana', role: 'bounded same-host crawl' },
	{ id: 'nuclei', name: 'Nuclei', role: 'info/tech templates only' },
	{ id: 'amass', name: 'Amass', role: 'passive enum' },
	{ id: 'ffuf', name: 'ffuf', role: 'short directory wordlist' },
	{ id: 'validation', name: 'Validation', role: 'claims stay unconfirmed' },
	{ id: 'reporting', name: 'Reporting', role: 'summarize, do not inflate' },
];

export function defaultImages(): Record<string, string> {
	const images: Record<string, string> = {};
	for (const tool of TOOL_CATALOG) {
		images[tool.agentId] = tool.image;
	}
	return images;
}

export function defaultEnabled(): string[] {
	return TOOL_CATALOG.map((tool) => tool.id);
}

export const BUILTIN_SOURCE = 'Built-in';

export type PublicTool = Omit<ToolSpec, 'mcp' | 'origin'> & { source: string };

/** Strip private notes. Product UI and IPC must use this, never `mcp`. */
export function toPublicTool(tool: ToolSpec, patch?: Partial<PublicTool>): PublicTool {
	const { mcp: _mcp, origin: _origin, ...rest } = tool;
	return { ...rest, source: BUILTIN_SOURCE, ...patch };
}
