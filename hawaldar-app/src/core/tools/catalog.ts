import { hasMinContainerfile, minImageFor } from '../sandbox/images';

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
	/** Extra specialists that may call this tool (in addition to agentId). */
	sharedWith?: string[];
}

const I = minImageFor;

/** PoC validation specialists (proof stage). Share the contained browser image via the poc alias. */
export const POC_AGENT_IDS = ['poc-injection', 'poc-xss', 'poc-ssrf', 'poc-auth'] as const;

/** Everyone who reads or writes the findings store. */
export const FINDING_TOOL_SHARED = [
	'vuln-injection',
	'vuln-xss',
	'vuln-ssrf',
	'vuln-auth',
	...POC_AGENT_IDS,
	'validation',
	'reporting',
] as const;

/** First-party Hawaldar tools. They run in Podman images. Refused ids are listed in EXCLUDED_MCP_TOOLS. */
export const TOOL_CATALOG: ToolSpec[] = [
	{ id: 'discover-hosts', agentId: 'nmap', title: 'Discover hosts', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 120_000, description: 'Ping scan (-sn) of an in-scope host or /24.' },
	{ id: 'quick-scan', agentId: 'nmap', title: 'Quick scan', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 180_000, description: 'TCP connect top-N ports. localhost / 127.0.0.1 allowed.' },
	{ id: 'scan-ports', agentId: 'nmap', title: 'Scan ports', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 180_000, description: 'TCP connect scan. Stealth types are refused. localhost / 127.0.0.1 allowed.' },
	{ id: 'detect-services', agentId: 'nmap', title: 'Detect services', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 240_000, description: 'TCP connect + version detect.' },
	{ id: 'scan-top-ports', agentId: 'nmap', title: 'Scan top ports', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 180_000, description: 'TCP connect scan of nmap top-N ports (default 100, max 1000). localhost / 127.0.0.1 allowed.' },
	{ id: 'scan-local-ports', agentId: 'nmap', title: 'Scan local ports', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 180_000, description: 'TCP connect scan of this machine (127.0.0.1). Top ports or 1-1024. -sT only.' },
	{ id: 'scan-port-range', agentId: 'nmap', title: 'Scan port range', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 300_000, description: 'TCP connect scan of an explicit port range (e.g. 1-1024).' },
	{ id: 'probe-http-ports', agentId: 'nmap', title: 'Probe HTTP ports', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 240_000, description: 'TCP connect + version on 80,443,8080,8443.' },
	{ id: 'reverse-dns', agentId: 'nmap', title: 'Reverse DNS', kind: 'host', image: I('nmap'), enabled: true, timeoutMs: 60_000, description: 'List scan (-sL) with system DNS / PTR. No port scan.' },
	{ id: 'nmap-xml-summary', agentId: 'nmap', title: 'Nmap XML summary', kind: 'meta', image: I('nmap'), enabled: true, timeoutMs: 15_000, description: 'Summarize the last workspace nmap XML (open ports, PTR).' },
	{ id: 'tshark-list-pcaps', agentId: 'tshark', title: 'List workspace pcaps', kind: 'meta', image: I('tshark'), enabled: true, timeoutMs: 15_000, description: 'List .pcap / .pcapng in ~/.hawaldar/workspace. No container. Bare names work as pcapPath.' },
	{ id: 'analyze_pcap', agentId: 'tshark', title: 'Analyze pcap', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'Packet JSON from a workspace or mounted pcap. Omit pcapPath to use ~/.hawaldar/workspace captures.' },
	{ id: 'get_summary_stats', agentId: 'tshark', title: 'Pcap protocol stats', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'tshark -z io,phs. Omit pcapPath to use ~/.hawaldar/workspace captures.' },
	{ id: 'get_conversations', agentId: 'tshark', title: 'Pcap conversations', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'tshark -z conv,tcp. Omit pcapPath to use ~/.hawaldar/workspace captures.' },
	{ id: 'pcap-protocols', agentId: 'tshark', title: 'Pcap protocol hierarchy', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'Protocol hierarchy from a workspace or mounted pcap. Omit pcapPath to use workspace captures.' },
	{ id: 'pcap-endpoints', agentId: 'tshark', title: 'Pcap endpoints', kind: 'pcap', image: I('tshark'), enabled: true, timeoutMs: 120_000, description: 'IPv4 and IPv6 endpoints from a workspace or mounted pcap. Omit pcapPath to use workspace captures.' },
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
	{ id: 'subfinder', agentId: 'subfinder', title: 'Subfinder', kind: 'host', image: I('subfinder'), enabled: true, timeoutMs: 180_000, description: 'Passive subdomains for an in-scope domain.', sharedWith: ['dns'] },
	{ id: 'subfinder-silent', agentId: 'subfinder', title: 'Subfinder silent', kind: 'host', image: I('subfinder'), enabled: true, timeoutMs: 180_000, description: 'Passive subdomains, silent/no-color output, in-scope domain only.', sharedWith: ['dns'] },
	{ id: 'subfinder-sources', agentId: 'subfinder', title: 'Subfinder all sources', kind: 'host', image: I('subfinder'), enabled: true, timeoutMs: 180_000, description: 'Passive subdomains using all sources for an in-scope domain.', sharedWith: ['dns'] },
	{ id: 'dnsx', agentId: 'dnsx', title: 'dnsx', kind: 'host', image: I('dnsx'), enabled: true, timeoutMs: 120_000, description: 'A/AAAA/CNAME for an in-scope host.', sharedWith: ['dns'] },
	{ id: 'dnsx-a', agentId: 'dnsx', title: 'dnsx A', kind: 'host', image: I('dnsx'), enabled: true, timeoutMs: 120_000, description: 'A record probe for an in-scope host.', sharedWith: ['dns'] },
	{ id: 'dnsx-cname', agentId: 'dnsx', title: 'dnsx CNAME', kind: 'host', image: I('dnsx'), enabled: true, timeoutMs: 120_000, description: 'CNAME probe for an in-scope host.', sharedWith: ['dns'] },
	{ id: 'dns-resolve', agentId: 'dns', title: 'DNS resolve', kind: 'host', image: I('dns'), enabled: true, timeoutMs: 60_000, description: 'A/AAAA lookup via dig. Named host or local/this machine is enough; empty scope does not block.' },
	{ id: 'dns-records', agentId: 'dns', title: 'DNS records', kind: 'host', image: I('dns'), enabled: true, timeoutMs: 60_000, description: 'Chosen DNS types (A, AAAA, MX, NS, TXT, CNAME, SOA) via dig.' },
	{ id: 'dns-ptr', agentId: 'dns', title: 'DNS PTR', kind: 'host', image: I('dns'), enabled: true, timeoutMs: 60_000, description: 'Reverse DNS (PTR) for an IPv4 or IPv6 address.' },
	{ id: 'dns-ns', agentId: 'dns', title: 'DNS NS', kind: 'host', image: I('dns'), enabled: true, timeoutMs: 60_000, description: 'Nameserver (NS) records via dig.' },
	{ id: 'dns-mx', agentId: 'dns', title: 'DNS MX', kind: 'host', image: I('dns'), enabled: true, timeoutMs: 60_000, description: 'Mail exchanger (MX) records via dig.' },
	{ id: 'dns-txt', agentId: 'dns', title: 'DNS TXT', kind: 'host', image: I('dns'), enabled: true, timeoutMs: 60_000, description: 'TXT records via dig.' },
	{ id: 'dns-cname', agentId: 'dns', title: 'DNS CNAME', kind: 'host', image: I('dns'), enabled: true, timeoutMs: 60_000, description: 'CNAME records via dig.' },
	{ id: 'dns-soa', agentId: 'dns', title: 'DNS SOA', kind: 'host', image: I('dns'), enabled: true, timeoutMs: 60_000, description: 'SOA record via dig.' },
	{ id: 'dns-axfr-check', agentId: 'dns', title: 'DNS AXFR check', kind: 'host', image: I('dns'), enabled: true, timeoutMs: 60_000, description: 'Check whether AXFR is permitted. Reports permit/refuse only — does not dump the zone.' },
	{ id: 'httpx', agentId: 'httpx', title: 'httpx', kind: 'host', image: I('httpx'), enabled: true, timeoutMs: 120_000, description: 'HTTP probe + title + tech.' },
	{ id: 'httpx-title', agentId: 'httpx', title: 'httpx title', kind: 'host', image: I('httpx'), enabled: true, timeoutMs: 120_000, description: 'HTTP probe with page title for an in-scope URL.' },
	{ id: 'httpx-tech', agentId: 'httpx', title: 'httpx tech', kind: 'host', image: I('httpx'), enabled: true, timeoutMs: 120_000, description: 'HTTP probe with technology detect for an in-scope URL.' },
	{ id: 'naabu', agentId: 'naabu', title: 'naabu', kind: 'host', image: I('naabu'), enabled: true, timeoutMs: 180_000, description: 'Top-100 TCP connect ports.' },
	{ id: 'naabu-top-ports', agentId: 'naabu', title: 'naabu top ports', kind: 'host', image: I('naabu'), enabled: true, timeoutMs: 180_000, description: 'Top-1000 TCP connect ports on an in-scope host.' },
	{ id: 'katana', agentId: 'katana', title: 'katana', kind: 'host', image: I('katana'), enabled: true, timeoutMs: 180_000, description: 'Same-host crawl: depth 3, concurrency 20, JS + robots/sitemap known-files.' },
	{ id: 'katana-depth', agentId: 'katana', title: 'katana depth', kind: 'host', image: I('katana'), enabled: true, timeoutMs: 180_000, description: 'Crawl depth 4, JS + known-files, same host (fqdn), in-scope URL.' },
	{ id: 'katana-js', agentId: 'katana', title: 'katana JS', kind: 'host', image: I('katana'), enabled: true, timeoutMs: 180_000, description: 'JS crawl at depth 2, known-files, same host, in-scope URL.' },
	{ id: 'nuclei', agentId: 'nuclei', title: 'nuclei (info)', kind: 'host', image: I('nuclei'), enabled: true, timeoutMs: 180_000, description: 'tech/dns/discovery tags, info severity only.', sharedWith: ['vuln-injection', 'vuln-xss', 'vuln-ssrf', 'vuln-auth'] },
	{ id: 'nuclei-tech', agentId: 'nuclei', title: 'nuclei tech', kind: 'host', image: I('nuclei'), enabled: true, timeoutMs: 180_000, description: 'Tech-detect templates, info severity only.', sharedWith: ['vuln-injection', 'vuln-xss', 'vuln-ssrf', 'vuln-auth'] },
	{ id: 'nuclei-severity-info', agentId: 'nuclei', title: 'nuclei info/low', kind: 'host', image: I('nuclei'), enabled: true, timeoutMs: 180_000, description: 'tech/misconfig/discovery tags, info and low severity only.', sharedWith: ['vuln-injection', 'vuln-xss', 'vuln-ssrf', 'vuln-auth'] },
	{ id: 'amass', agentId: 'amass', title: 'Amass passive', kind: 'host', image: I('amass'), enabled: true, timeoutMs: 180_000, description: 'Passive enum only.', sharedWith: ['dns'] },
	{ id: 'amass-passive', agentId: 'amass', title: 'Amass passive enum', kind: 'host', image: I('amass'), enabled: true, timeoutMs: 180_000, description: 'Passive enum only for an in-scope domain.', sharedWith: ['dns'] },
	{ id: 'ffuf_dir', agentId: 'ffuf', title: 'ffuf dirs', kind: 'host', image: I('ffuf'), enabled: true, timeoutMs: 180_000, description: 'Directory fuzz with the built-in short wordlist.' },
	{ id: 'ffuf_vhost', agentId: 'ffuf', title: 'ffuf vhost', kind: 'host', image: I('ffuf'), enabled: true, timeoutMs: 180_000, description: 'Host-header vhost fuzz with the built-in short wordlist. In-scope host only.' },
	{ id: 'ffuf_extensions', agentId: 'ffuf', title: 'ffuf extensions', kind: 'host', image: I('ffuf'), enabled: true, timeoutMs: 180_000, description: 'Directory fuzz with common extensions and the built-in short wordlist.' },
	{ id: 'msf-search', agentId: 'metasploit', title: 'MSF search', kind: 'meta', image: I('metasploit'), enabled: true, timeoutMs: 180_000, description: 'Search Metasploit modules (name, type, CVE). No network.' },
	{ id: 'msf-info', agentId: 'metasploit', title: 'MSF module info', kind: 'meta', image: I('metasploit'), enabled: true, timeoutMs: 180_000, description: 'Show options and description for one module path. Does not run the module.' },
	{ id: 'msf-aux-scan', agentId: 'metasploit', title: 'MSF auxiliary scan', kind: 'host', image: I('metasploit'), enabled: true, timeoutMs: 300_000, description: 'Run an auxiliary/scanner module against an in-scope host. exploit/payload/post refused.' },
	{ id: 'msf-http-version', agentId: 'metasploit', title: 'MSF HTTP version', kind: 'host', image: I('metasploit'), enabled: true, timeoutMs: 300_000, description: 'auxiliary/scanner/http/http_version on an in-scope host.' },
	{ id: 'msf-smb-version', agentId: 'metasploit', title: 'MSF SMB version', kind: 'host', image: I('metasploit'), enabled: true, timeoutMs: 300_000, description: 'auxiliary/scanner/smb/smb_version on an in-scope host.' },
	{ id: 'msf-ssh-version', agentId: 'metasploit', title: 'MSF SSH version', kind: 'host', image: I('metasploit'), enabled: true, timeoutMs: 300_000, description: 'auxiliary/scanner/ssh/ssh_version on an in-scope host.' },
	{ id: 'msf-check', agentId: 'metasploit', title: 'MSF check', kind: 'host', image: I('metasploit'), enabled: true, timeoutMs: 300_000, description: 'Read-only `check` for an exploit/* or auxiliary/* module against an in-scope host (HITL). Parses the [+]/[-] verdict line as evidence.' },
	{ id: 'msf-run', agentId: 'metasploit', title: 'MSF run', kind: 'host', image: I('metasploit'), enabled: true, timeoutMs: 600_000, description: 'HITL-gated run of an exploit/* or auxiliary/scanner/* module against an in-scope host. run -z / exploit -z backgrounds any session, sessions -K kills it before exit. post/* and payload builders refused.' },
	{ id: 'zap-status', agentId: 'zap', title: 'ZAP status', kind: 'meta', image: I('zap'), enabled: true, timeoutMs: 120_000, description: 'Start the local ZAP daemon on demand (127.0.0.1:8090, per-start API key) and report health/version. The operator may proxy their own browser or Burp through it.' },
	{ id: 'zap-spider', agentId: 'zap', title: 'ZAP spider', kind: 'host', image: I('zap'), enabled: true, timeoutMs: 300_000, description: 'Spider an in-scope URL via the local ZAP daemon. Found URLs capped at 100, target host only.' },
	{ id: 'zap-pscan', agentId: 'zap', title: 'ZAP passive scan', kind: 'host', image: I('zap'), enabled: true, timeoutMs: 180_000, description: 'Wait for the ZAP passive-scan queue to drain, then alert counts by risk (optional in-scope base URL filter).' },
	{ id: 'zap-history', agentId: 'zap', title: 'ZAP history', kind: 'meta', image: I('zap'), enabled: true, timeoutMs: 60_000, description: 'Proxied-traffic summary: sites, URLs, hosts, methods, status codes (capped; credential values redacted).' },
	{ id: 'zap-ascan', agentId: 'zap', title: 'ZAP active scan', kind: 'host', image: I('zap'), enabled: true, timeoutMs: 660_000, description: 'ACTIVE scan of an in-scope URL (intrusive, per-run operator approval). Alerts grouped by risk, capped to the target host.', sharedWith: [...POC_AGENT_IDS] },
	{ id: 'zap-alerts', agentId: 'zap', title: 'ZAP alerts', kind: 'meta', image: I('zap'), enabled: true, timeoutMs: 60_000, description: 'List current ZAP alerts (risk, name, URL, evidence excerpt; cap 200; secrets redacted).' },
	{ id: 'juice-shop-status', agentId: 'juice-shop', title: 'Juice Shop status', kind: 'meta', image: 'bkimminich/juice-shop', enabled: true, timeoutMs: 120_000, description: 'Built-in OWASP Juice Shop lab target at http://127.0.0.1:3000 (loopback). Reports daemon health; starts hw-juice-shop if the service is toggled on but the container is down.' },
	{ id: 'sqlmap-scan', agentId: 'sqlmap', title: 'SQLMap bounded proof', kind: 'host', image: I('sqlmap'), enabled: true, timeoutMs: 600_000, description: 'Prove SQL injectability on an in-scope URL (HITL). level/risk ≤ 2, techniques B/E/U/S/T (no Q), crawl ≤ 1, fingerprint flags only. Data-extraction flags refused in code.', sharedWith: ['poc-injection'] },
	{ id: 'browser-search', agentId: 'browser', title: 'Browser search', kind: 'host', image: I('browser'), enabled: true, timeoutMs: 90_000, description: 'Search the web in contained Chromium. Search engines are a hop; out-of-scope result links are listed, not visited.', sharedWith: ['research'] },
	{ id: 'browser-open', agentId: 'browser', title: 'Browser open', kind: 'host', image: I('browser'), enabled: true, timeoutMs: 120_000, description: 'Open an in-scope http(s) URL in contained Chromium. Off-scope redirects (e.g. Juice Shop docs) are ignored; returns the last in-scope snapshot.', sharedWith: ['research'] },
	{ id: 'research-search', agentId: 'research', title: 'Research search', kind: 'host', image: I('browser'), enabled: true, timeoutMs: 60_000, description: 'Search public docs, RFCs, CVE/advisory summaries, and vendor pages. Fetch-first (DuckDuckGo); Playwright fallback. Search-engine hop only; out-of-scope result links are listed, not visited.' },
	{ id: 'research-open', agentId: 'research', title: 'Research open', kind: 'host', image: I('browser'), enabled: true, timeoutMs: 120_000, description: 'Open an in-scope or named-target documentation URL in contained Chromium. Same scope rules as browser-open. Knowledge only — no exploits.' },
	{ id: 'browser-snapshot', agentId: 'browser', title: 'Browser snapshot', kind: 'host', image: I('browser'), enabled: true, timeoutMs: 90_000, description: 'Accessibility/text outline of an in-scope page in contained Chromium.' },
	{ id: 'browser-console', agentId: 'browser', title: 'Browser console', kind: 'host', image: I('browser'), enabled: true, timeoutMs: 90_000, description: 'Console errors and warnings from an in-scope page (exceptions).' },
	{ id: 'browser-network', agentId: 'browser', title: 'Browser network', kind: 'host', image: I('browser'), enabled: true, timeoutMs: 90_000, description: 'Failed requests and 4xx/5xx from an in-scope page. No auth-header HAR dump.' },
	{ id: 'browser-links', agentId: 'browser', title: 'Browser links', kind: 'host', image: I('browser'), enabled: true, timeoutMs: 90_000, description: 'Same-origin / in-scope links from an in-scope page.' },
	{ id: 'browser-close', agentId: 'browser', title: 'Browser close', kind: 'meta', image: I('browser'), enabled: true, timeoutMs: 15_000, description: 'No-op. Visits are ephemeral podman run --rm; there is no sticky browser session.' },
	{ id: 'scrapling-fetch', agentId: 'scrapling', title: 'Scrapling fetch', kind: 'host', image: I('scrapling'), enabled: true, timeoutMs: 90_000, description: 'Fetch an in-scope http(s) page with contained Scrapling (HTTP Fetcher). Returns title, status, final URL, text excerpt. Named URL is enough when scope is empty.' },
	{ id: 'scrapling-text', agentId: 'scrapling', title: 'Scrapling text', kind: 'host', image: I('scrapling'), enabled: true, timeoutMs: 90_000, description: 'Extract visible body text from an in-scope page via Scrapling Fetcher. No Python eval.' },
	{ id: 'scrapling-links', agentId: 'scrapling', title: 'Scrapling links', kind: 'host', image: I('scrapling'), enabled: true, timeoutMs: 90_000, description: 'Same-origin / in-scope links from an in-scope page via Scrapling. Out-of-scope links are dropped when scope is set.' },
	{ id: 'scrapling-select', agentId: 'scrapling', title: 'Scrapling select', kind: 'host', image: I('scrapling'), enabled: true, timeoutMs: 90_000, description: 'CSS or XPath extract from an in-scope page. No arbitrary Python.' },
	{ id: 'scrapling-adaptive', agentId: 'scrapling', title: 'Scrapling adaptive', kind: 'host', image: I('scrapling'), enabled: true, timeoutMs: 90_000, description: 'Adaptive CSS/XPath: save fingerprints, then relocate if the DOM changed. Persists under ~/.hawaldar/workspace/.scrapling.' },
	{ id: 'semgrep-list', agentId: 'semgrep', title: 'Semgrep list', kind: 'meta', image: I('semgrep'), enabled: true, timeoutMs: 15_000, description: 'List scannable source files in ~/.hawaldar/workspace. No container. Used by pre-recon / source-review.', sharedWith: ['vuln-injection', 'vuln-xss', 'vuln-ssrf', 'vuln-auth', 'validation'] },
	{ id: 'semgrep-scan', agentId: 'semgrep', title: 'Semgrep scan', kind: 'file', image: I('semgrep'), enabled: true, timeoutMs: 300_000, description: 'SAST on ~/.hawaldar/workspace with bundled security rules. Findings only — no autofix exploits, no payloads.', sharedWith: ['vuln-injection', 'vuln-xss', 'vuln-ssrf', 'vuln-auth', 'validation'] },
	{ id: 'semgrep-owasp', agentId: 'semgrep', title: 'Semgrep OWASP', kind: 'file', image: I('semgrep'), enabled: true, timeoutMs: 300_000, description: 'SAST on the workspace with bundled OWASP-class rules (injection, XSS, SSRF, auth). Detection only.', sharedWith: ['vuln-injection', 'vuln-xss', 'vuln-ssrf', 'vuln-auth', 'validation'] },
	{ id: 'semgrep-path', agentId: 'semgrep', title: 'Semgrep path', kind: 'file', image: I('semgrep'), enabled: true, timeoutMs: 300_000, description: 'SAST a relative path under ~/.hawaldar/workspace. Host paths outside the workspace are refused.', sharedWith: ['vuln-injection', 'vuln-xss', 'vuln-ssrf', 'vuln-auth'] },
	{ id: 'poc-request', agentId: 'poc', title: 'PoC HTTP request', kind: 'host', image: I('browser'), enabled: true, timeoutMs: 90_000, description: 'Bounded in-scope HTTP request for PoC validation (contained browser image, per-probe HITL). GET/POST/PUT/PATCH/HEAD/OPTIONS — no DELETE, no destructive SQL, credential headers redacted.', sharedWith: [...POC_AGENT_IDS] },
	{ id: 'poc-act', agentId: 'poc', title: 'PoC browser flow', kind: 'host', image: I('browser'), enabled: true, timeoutMs: 150_000, description: 'Ordered browser actions (goto/fill/click/submit/wait/extract) in contained Chromium for auth, registration, and IDOR proofs. HITL-approved. Fill values never echoed.', sharedWith: [...POC_AGENT_IDS] },
	{ id: 'poc-xss-canary', agentId: 'poc', title: 'PoC XSS canary', kind: 'host', image: I('browser'), enabled: true, timeoutMs: 90_000, description: 'Reflected-XSS canary in contained Chromium: proves JS execution via a window.__hwPocFired marker. Cookie/storage/network exfiltration refused in code.', sharedWith: [...POC_AGENT_IDS] },
	{ id: 'finding-record', agentId: 'runtime', title: 'Finding record', kind: 'meta', image: '', enabled: true, timeoutMs: 15_000, description: 'Create or update an engagement finding. confirmed requires reproduction steps + tool evidence (enforced by the store).', sharedWith: [...FINDING_TOOL_SHARED] },
	{ id: 'finding-list', agentId: 'runtime', title: 'Finding list', kind: 'meta', image: '', enabled: true, timeoutMs: 15_000, description: 'List engagement findings with counts by severity and status. Filter by class, status, or query.', sharedWith: [...FINDING_TOOL_SHARED] },
	{ id: 'finding-export', agentId: 'runtime', title: 'Finding report export', kind: 'meta', image: '', enabled: true, timeoutMs: 30_000, description: 'Render filtered findings to a watermarked PDF under ~/.hawaldar/workspace/reports and return the path. Default filter is this chat.', sharedWith: ['validation', 'reporting'] },
	{ id: 'knowledge-search', agentId: 'runtime', title: 'Knowledge search', kind: 'meta', image: '', enabled: true, timeoutMs: 30_000, description: 'Search Lance RAG over notes, tasks, playbooks, chat summaries, and ingested docs. Recon/docs only.', sharedWith: ['research'] },
	{ id: 'knowledge-ingest', agentId: 'runtime', title: 'Knowledge ingest', kind: 'meta', image: '', enabled: true, timeoutMs: 60_000, description: 'Ingest recon or documentation text into Lance knowledge. Refuses .env, secrets, and exploit kits.', sharedWith: ['research'] },
	{ id: 'start_service', agentId: 'runtime', title: 'Start service', kind: 'meta', image: '', enabled: true, timeoutMs: 600_000, description: 'Build/start one catalog or custom tool image (nmap, dns, research, tshark / wireshark, ghidra, browser, scrapling, semgrep, …) after in-app approval. Metasploit refused.' },
	{ id: 'stop_service', agentId: 'runtime', title: 'Stop service', kind: 'meta', image: '', enabled: true, timeoutMs: 60_000, description: 'Stop that catalog image’s hw-* containers and clear it from startedServices. Does not stop the Linux VM or Podman machine. Metasploit refused.' },
	{ id: 'restart_service', agentId: 'runtime', title: 'Restart service', kind: 'meta', image: '', enabled: true, timeoutMs: 600_000, description: 'Stop then start one catalog or custom tool image. Does not restart the Linux VM or Podman machine. Metasploit refused.' },
];

/** Research and PoC validation reuse the contained browser image. */
export const SERVICE_IMAGE_ALIAS: Record<string, string> = {
	research: 'browser',
	poc: 'browser',
};

/** Operator-facing groups for readiness + Runtime service list. */
export type ServiceLane = 'web-lab' | 'web-optional' | 'sast' | 'subdomain' | 'binary' | 'pcap' | 'other';

export const SERVICE_LANE_ORDER: ServiceLane[] = [
	'web-lab',
	'web-optional',
	'sast',
	'subdomain',
	'binary',
	'pcap',
	'other',
];

export const SERVICE_LANE_META: Record<ServiceLane, { label: string; hint: string; webLab: boolean }> = {
	'web-lab': {
		label: 'Web lab (Juice Shop)',
		hint: 'Toggle these on in Runtime → Tool services. Needed for a localhost web PoC (httpx, katana, zap, sqlmap, browser, scrapling, juice-shop).',
		webLab: true,
	},
	'web-optional': {
		label: 'Web optional',
		hint: 'Useful for web recon (nmap, dns, nuclei, ffuf, naabu). Not blocking for Juice Shop.',
		webLab: false,
	},
	sast: {
		label: 'SAST',
		hint: 'Workspace Semgrep. Skip when the target is a running web lab with no app tree in ~/.hawaldar/workspace.',
		webLab: false,
	},
	subdomain: {
		label: 'Subdomain enum',
		hint: 'Not used for a localhost web lab (127.0.0.1). Leave subfinder, amass, and dnsx off.',
		webLab: false,
	},
	binary: {
		label: 'Binary analysis',
		hint: 'Not used for a localhost web lab. Do not pull ghidra, radare, or binwalk for Juice Shop.',
		webLab: false,
	},
	pcap: {
		label: 'Packet capture',
		hint: 'Not used for a localhost web lab. Leave tshark off.',
		webLab: false,
	},
	other: {
		label: 'Other',
		hint: 'Metasploit and custom images. Not required for Juice Shop.',
		webLab: false,
	},
};

const AGENT_LANE: Record<string, ServiceLane> = {
	httpx: 'web-lab',
	katana: 'web-lab',
	zap: 'web-lab',
	sqlmap: 'web-lab',
	browser: 'web-lab',
	research: 'web-lab',
	poc: 'web-lab',
	scrapling: 'web-lab',
	'juice-shop': 'web-lab',
	nmap: 'web-optional',
	dns: 'web-optional',
	nuclei: 'web-optional',
	ffuf: 'web-optional',
	naabu: 'web-optional',
	semgrep: 'sast',
	subfinder: 'subdomain',
	amass: 'subdomain',
	dnsx: 'subdomain',
	ghidra: 'binary',
	radare: 'binary',
	binwalk: 'binary',
	tshark: 'pcap',
	metasploit: 'other',
};

export function serviceLane(agentId: string): ServiceLane {
	const resolved = SERVICE_IMAGE_ALIAS[agentId] || agentId;
	return AGENT_LANE[agentId] || AGENT_LANE[resolved] || 'other';
}

/** Image the Runtime toggle builds/pulls — min Containerfile wins over leftover docker.io pins. */
export function resolveCatalogServiceImage(agentId: string, pinned?: string, fallback = ''): string {
	const resolved = SERVICE_IMAGE_ALIAS[agentId] || agentId;
	if (hasMinContainerfile(resolved)) {
		return minImageFor(resolved);
	}
	const pin = pinned?.trim();
	if (pin) {
		return pin;
	}
	return fallback;
}

export function resolveServiceBuildTarget(serviceId: string): string {
	return SERVICE_IMAGE_ALIAS[serviceId] ?? serviceId;
}

export function aliasedServiceIds(serviceId: string): string[] {
	const ids = new Set<string>([serviceId]);
	const aliased = SERVICE_IMAGE_ALIAS[serviceId];
	if (aliased) {
		ids.add(aliased);
	}
	for (const [from, to] of Object.entries(SERVICE_IMAGE_ALIAS)) {
		if (from === serviceId || to === serviceId) {
			ids.add(from);
			ids.add(to);
		}
	}
	return [...ids];
}

export const SERVICE_CONTROL_TOOL_IDS = ['start_service', 'stop_service', 'restart_service'] as const;

export function isServiceControlTool(id: string): boolean {
	return (SERVICE_CONTROL_TOOL_IDS as readonly string[]).includes(id);
}

export const KNOWLEDGE_TOOL_IDS = ['knowledge-search', 'knowledge-ingest'] as const;

export function isKnowledgeTool(id: string): boolean {
	return (KNOWLEDGE_TOOL_IDS as readonly string[]).includes(id);
}

/**
 * Intrusive tools need per-call operator approval (HITL kind 'poc-probe') on top
 * of the service-start gate. executeTool routes these through the same approval
 * path as the poc-* probes, with the tool's own summary builder.
 */
export const INTRUSIVE_TOOL_IDS = ['zap-ascan', 'sqlmap-scan', 'msf-check', 'msf-run'] as const;

export function isIntrusiveTool(id: string): boolean {
	return (INTRUSIVE_TOOL_IDS as readonly string[]).includes(id);
}

export const EXCLUDED_MCP_TOOLS = [
	{ id: 'msfvenom / payload builders / post', reason: 'Payload builders and post-exploitation stay refused. Metasploit is search/info, read-only check, and HITL-gated exploit/* + auxiliary/scanner/* runs; sessions are backgrounded (run -z / exploit -z) and auto-killed (sessions -K).' },
	{ id: 'sqlmap data-extraction flags', reason: 'sqlmap-scan proves injectability only (level/risk ≤ 2, techniques B/E/U/S/T, fingerprint flags). --dump/--dump-all, --os-shell/--os-pwn, --file-read/--file-write, --passwords/--users/--privileges/--roles, --sql-query/--sql-shell, --eval, --tor, tamper scripts, and non-scope proxies stay refused.' },
	{ id: 'extract_credentials', reason: 'Credential dump refused.' },
	{ id: 'scan-vulnerabilities', reason: 'NSE vuln/exploit path refused.' },
	{ id: 'scan-ports:syn|fin|xmas|null', reason: 'Stealth scan types refused.' },
	{ id: 'traceroute-connect', reason: 'Needs CAP_NET_RAW / raw sockets. Not wired.' },
	{ id: 'ghidra.eval / r2_command', reason: 'Arbitrary runtime exec refused.' },
	{ id: 'shell_command', reason: 'Host/container shell is not a model tool.' },
	{ id: 'podman machine / docker desktop', reason: 'Linux VM is human-only. Models start catalog images only.' },
	{ id: 'nuclei exploit/critical', reason: 'Exploit and high-severity templates refused.' },
	{ id: 'ffuf login/credential', reason: 'Password and credential spray refused.' },
	{ id: 'browser password/cookie harvest', reason: 'Password-field harvest and cookie theft refused.' },
	{ id: 'javascript: / XSS proof', reason: 'javascript: injection and XSS proofs are refused.' },
	{ id: 'drive-by download', reason: 'Drive-by downloads are refused.' },
	{ id: 'host Chrome / host Playwright', reason: 'Browser recon runs only in Podman Chromium. Host Chrome is not wired.' },
	{ id: 'host Wireshark / host dumpcap / live capture', reason: 'Packet analysis is contained tshark on workspace pcaps. Host GUI and live dumpcap are not wired.' },
	{ id: 'dns zone dump / AXFR transfer dump', reason: 'AXFR is a permit-check only. Zone dumps are not wired.' },
	{ id: 'scrapling python eval / exec', reason: 'Arbitrary Python in the scrapling image is refused. CSS/XPath only.' },
	{ id: 'captcha farm / WAF-attack / Turnstile solver', reason: 'CAPTCHA farms and WAF-attack kits are refused. Stealth is HTTP TLS impersonation of in-scope URLs only.' },
	{ id: 'credential stuffing / login spray', reason: 'Credential stuffing and login spray are refused.' },
	{ id: 'credential / cookie / token theft', reason: 'PoC validators prove impact without harvesting secrets. Exfiltration is refused in poc tooling (code-enforced).' },
	{ id: 'destructive payloads / DoS', reason: 'DROP/DELETE/UPDATE/INSERT, INTO OUTFILE, BENCHMARK, and DoS are refused. State changes are limited to benign test records with operator approval.' },
	{ id: 'DELETE method in poc-request', reason: 'PoC probes never delete resources. GET/POST/PUT/PATCH/HEAD/OPTIONS only.' },
];

export const AGENT_ROLES: Array<{ id: string; name: string; role: string }> = [
	{ id: 'orchestrator', name: 'Orchestrator', role: 'supervisor · delegates to specialists' },
	{ id: 'policy', name: 'Policy', role: 'scope gate' },
	{ id: 'nmap', name: 'Nmap', role: 'host discovery and port scans' },
	{ id: 'dns', name: 'DNS', role: 'DNS recon (resolve, records, PTR, AXFR check)' },
	{ id: 'tshark', name: 'tshark', role: 'pcap / Wireshark (contained tshark) analysis' },
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
	{ id: 'metasploit', name: 'Metasploit', role: 'module search/info, read-only check, HITL-gated runs (sessions auto-killed)' },
	{ id: 'zap', name: 'ZAP', role: 'local ZAP daemon: proxy, spider, passive scan, HITL-gated active scan' },
	{ id: 'juice-shop', name: 'Juice Shop', role: 'built-in OWASP Juice Shop lab at http://127.0.0.1:3000' },
	{ id: 'sqlmap', name: 'SQLMap', role: 'bounded SQLi proof (fingerprint only, HITL)' },
	{ id: 'browser', name: 'Browser', role: 'contained web recon (search, open, console, network)' },
	{ id: 'scrapling', name: 'Scrapling', role: 'contained page scrape (fetch, text, links, adaptive CSS/XPath)' },
	{ id: 'semgrep', name: 'Semgrep', role: 'workspace SAST (detection only)' },
	{ id: 'research', name: 'Research', role: 'docs, RFCs, CVE/advisory summaries (knowledge only)' },
	{ id: 'vuln-injection', name: 'Vuln injection', role: 'injection-class detection (SAST + nuclei info/low + research)' },
	{ id: 'vuln-xss', name: 'Vuln XSS', role: 'XSS-class detection (SAST + nuclei info/low + research)' },
	{ id: 'vuln-ssrf', name: 'Vuln SSRF', role: 'SSRF-class detection (SAST + nuclei info/low + research)' },
	{ id: 'vuln-auth', name: 'Vuln auth', role: 'authn/authz detection (SAST + nuclei info/low + research)' },
	{ id: 'poc-injection', name: 'PoC injection', role: 'proves injection hypotheses (read-only error/boolean/time probes, HITL)' },
	{ id: 'poc-xss', name: 'PoC XSS', role: 'proves XSS hypotheses (contained canary execution, no exfiltration, HITL)' },
	{ id: 'poc-ssrf', name: 'PoC SSRF', role: 'proves SSRF hypotheses (in-scope self-callback evidence, HITL)' },
	{ id: 'poc-auth', name: 'PoC auth', role: 'proves authn/authz/IDOR hypotheses (browser flows in contained Chromium, HITL)' },
	{ id: 'validation', name: 'Validation', role: 'confirmed vs unconfirmed from tool evidence' },
	{ id: 'reporting', name: 'Reporting', role: 'engagement Markdown report' },
];

export function builtinToolIds(): string[] {
	return TOOL_CATALOG.map((tool) => tool.id);
}

export function defaultImages(): Record<string, string> {
	const images: Record<string, string> = {};
	for (const tool of TOOL_CATALOG) {
		if (isServiceControlTool(tool.id) || !tool.image) {
			continue;
		}
		images[tool.agentId] = tool.image;
	}
	return images;
}

export function defaultEnabled(): string[] {
	return builtinToolIds();
}

/**
 * Fill missing/empty agent image pins with catalog min images.
 * Builtin min-Containerfile services always pin localhost/hawaldar/<id>:min so leftover
 * docker.io catalog pins (projectdiscovery/*, blacktop/ghidra, …) do not hide the image
 * Runtime actually builds when the service is toggled on.
 */
export function hydrateToolImages(stored?: Record<string, string>): Record<string, string> {
	const defaults = defaultImages();
	if (!stored) {
		return defaults;
	}
	const out: Record<string, string> = { ...defaults };
	for (const [agentId, image] of Object.entries(stored)) {
		if (typeof image !== 'string' || !image.trim()) {
			continue;
		}
		const resolved = SERVICE_IMAGE_ALIAS[agentId] || agentId;
		if (hasMinContainerfile(resolved)) {
			out[agentId] = minImageFor(resolved);
			continue;
		}
		out[agentId] = image.trim();
	}
	return out;
}

/**
 * Built-in catalog ids missing from `enabledTools` default on (opt-out).
 * `knownBuiltinTools` records catalog ids already seen so a later uncheck is not
 * treated as “new” and re-enabled. Custom ids stay exactly as stored.
 */
export function mergeEnabledTools(
	storedEnabled: string[] | undefined,
	knownBuiltin: string[] | undefined,
	customIds: string[] = [],
): { enabledTools: string[]; knownBuiltinTools: string[]; changed: boolean } {
	const catalogIds = builtinToolIds();
	const catalogSet = new Set(catalogIds);
	const customSet = new Set(customIds);
	const known = new Set(Array.isArray(knownBuiltin) ? knownBuiltin : []);
	const enabled = new Set(Array.isArray(storedEnabled) ? storedEnabled : []);

	for (const id of catalogIds) {
		if (!known.has(id)) {
			enabled.add(id);
		}
	}

	const nextEnabled = [
		...catalogIds.filter((id) => enabled.has(id)),
		...[...enabled].filter((id) => customSet.has(id) && !catalogSet.has(id)),
	];
	const nextKnown = catalogIds;
	const changed = !sameMembers(storedEnabled, nextEnabled) || !sameMembers(knownBuiltin, nextKnown);
	return { enabledTools: nextEnabled, knownBuiltinTools: nextKnown, changed };
}

function sameMembers(a: string[] | undefined, b: string[]): boolean {
	if (!a || a.length !== b.length) {
		return false;
	}
	const left = new Set(a);
	return b.every((id) => left.has(id));
}

export const BUILTIN_SOURCE = 'Built-in';

export type PublicTool = Omit<ToolSpec, 'mcp' | 'origin' | 'sharedWith'> & { source: string };

/** Strip private notes. Product UI and IPC must use this, never `mcp`. */
export function toPublicTool(tool: ToolSpec, patch?: Partial<PublicTool>): PublicTool {
	const { mcp: _mcp, origin: _origin, sharedWith: _sharedWith, ...rest } = tool;
	return { ...rest, source: BUILTIN_SOURCE, ...patch };
}

export function catalogToolsForAgent(agentId: string): ToolSpec[] {
	return TOOL_CATALOG.filter((tool) => tool.agentId === agentId || tool.sharedWith?.includes(agentId));
}
