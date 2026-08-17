# Minimal container images for Hawaldar tool services.
#
# Tags: localhost/hawaldar/<service>:min
# Built automatically when you toggle a service on in the Podman panel.
#
# Manual build example:
#   podman build -t localhost/hawaldar/nmap:min -f nmap/Containerfile nmap
#
# Most images are Alpine + a single binary/package.
# dns is Alpine + bind-tools (`dig`) for recon lookups and AXFR permit-checks.
# Ghidra is larger (JRE + stripped Ghidra) — unavoidable for headless analysis.
#
# Runtime: ephemeral `podman run --rm` (or docker). Shared bind:
#   ~/.hawaldar/workspace → /workspace
# compose.hawaldar.yml documents images + that mount only — do not compose up.
# Stealth nmap / OS-detect / msfvenom are not shipped.
# Metasploit is the official framework image (large). Toggle builds it.
# Browser is Debian Chromium + playwright-core (no host Chrome). Toggle builds it.
# Scrapling is Python slim + scrapling Fetcher / curl_cffi (no Playwright). Toggle builds it.
# Semgrep is Python slim + bundled SAST rules (workspace only, network none). Toggle builds it.
# Juice Shop is pull-only (bkimminich/juice-shop). Toggle on starts hw-juice-shop on 127.0.0.1:3000.
