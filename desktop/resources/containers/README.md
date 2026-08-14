# Minimal container images for Hawaldar tool services.
#
# Tags: localhost/hawaldar/<service>:min
# Built automatically when you toggle a service on in the Podman panel.
#
# Manual build example:
#   podman build -t localhost/hawaldar/nmap:min -f nmap/Containerfile nmap
#
# Most images are Alpine + a single binary/package.
# Ghidra is larger (JRE + stripped Ghidra) — unavoidable for headless analysis.
#
# Runtime: ephemeral `podman run --rm` (or docker). Shared bind:
#   ~/.hawaldar/workspace → /workspace
# compose.hawaldar.yml documents images + that mount only — do not compose up.
# Metasploit / stealth nmap / OS-detect are not shipped.
