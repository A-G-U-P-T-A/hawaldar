# Hawaldar

Authorized reconnaissance workstation: a **VS Code fork** with a built-in Mastra runtime. Policy is the authority on scope. Tools run only in Podman.

Not an exploitation platform. Metasploit, SQLMap, credential dumping, and host shells are not wired.

## Layout

```
vscode/                         VS Code 1.133.0 submodule
  product.json                  Hawaldar name / protocol
  extensions/hawaldar/          Agent, settings, MCP-mapped tools
```

## Run

VS Code 1.133 uses **npm**, not Yarn. Node **24.18.0** (see `vscode/.nvmrc`).

```bash
cd vscode
npm i
npm run watch
```

In another terminal:

```bash
.\scripts\code.bat
```

On macOS/Linux use `./scripts/code.sh`. First build is long.

Open **Hawaldar: Settings** to pick a Mastra provider, set the Podman path, and add in-scope hosts. Chat is `@hawaldar`. Memory is LibSQL at `~/.hawaldar/mastra.db`.

## Tools

Tool names match public MCP servers (nmap-mcp, WireMCP, GhidraMCP, radare2-mcp, pd-tools-mcp, and others). Execution is Hawaldar’s policy gate + Podman, not those MCP processes.

See `ARCHITECTURE.md` for the map and the refused list.
