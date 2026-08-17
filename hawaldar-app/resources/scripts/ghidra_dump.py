# Ghidra headless post-script — dumps program metadata as one JSON line.
# @category Hawaldar

from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor
import json

program = getCurrentProgram()
listing = program.getListing()
fm = program.getFunctionManager()
monitor = ConsoleTaskMonitor()

functions = []
decompiled = []
decomp = DecompInterface()
decomp.openProgram(program)

for fn in fm.getFunctions(True):
    name = fn.getName()
    entry = str(fn.getEntryPoint())
    functions.append({"name": name, "entry": entry})
    if len(decompiled) < 40:
        try:
            res = decomp.decompileFunction(fn, 30, monitor)
            if res and res.decompileCompleted():
                decompiled.append({"name": name, "c": res.getDecompiledFunction().getC()})
        except Exception:
            pass

imports = [{"name": str(s.getName())} for s in program.getSymbolTable().getExternalSymbols()]
exports = [{"name": str(s.getName())} for s in program.getSymbolTable().getExternalEntryPointIterator()]
# Prefer defined strings if available
strings = []
try:
    from ghidra.program.model.data import StringDataType
    data = listing.getDefinedData(True)
    while data.hasNext() and len(strings) < 200:
        d = data.next()
        if d.hasStringValue():
            strings.append({"value": str(d.getValue())[:200]})
except Exception:
    pass

out = {
    "program": program.getName(),
    "language": str(program.getLanguageID()),
    "functions": functions[:500],
    "imports": imports[:300],
    "exports": [{"name": str(x)} for x in list(program.getSymbolTable().getExternalEntryPointIterator())][:200] if False else [{"name": e.getName() if hasattr(e, 'getName') else str(e)} for e in []],
    "strings": strings,
    "decompiled": decompiled,
}
# Fix exports simply
exp = []
for s in program.getSymbolTable().getAllSymbols(True):
    if s.isExternalEntryPoint() or s.getSymbolType().toString() == "Function" and s.isGlobal():
        if s.isExternalEntryPoint():
            exp.append({"name": s.getName()})
out["exports"] = exp[:200]

entries = []
seen_entry = set()
st = program.getSymbolTable()
try:
    it = st.getExternalEntryPointIterator()
    while it.hasNext() and len(entries) < 80:
        addr = it.next()
        key = str(addr)
        if key in seen_entry:
            continue
        seen_entry.add(key)
        name = "entry"
        try:
            syms = st.getSymbols(addr)
            if syms is not None and len(syms) > 0:
                name = str(syms[0].getName())
        except Exception:
            pass
        entries.append({"name": name, "address": key})
except Exception:
    pass
try:
    for fn in fm.getFunctions(True):
        n = fn.getName()
        if n in ("_start", "start", "entry", "entry0", "main", "WinMain", "wWinMain", "wmain"):
            key = str(fn.getEntryPoint())
            if key not in seen_entry:
                seen_entry.add(key)
                entries.append({"name": n, "address": key})
except Exception:
    pass

xrefs = []
try:
    rm = program.getReferenceManager()
    for fn in fm.getFunctions(True):
        if len(xrefs) >= 300:
            break
        incoming = []
        try:
            refs = rm.getReferencesTo(fn.getEntryPoint())
            if refs is None:
                continue
            for ref in refs:
                if len(incoming) >= 24:
                    break
                incoming.append({
                    "from": str(ref.getFromAddress()),
                    "type": str(ref.getReferenceType()),
                })
        except Exception:
            continue
        if incoming:
            xrefs.append({
                "name": fn.getName(),
                "entry": str(fn.getEntryPoint()),
                "refs": incoming,
            })
except Exception:
    pass

out["image_base"] = str(program.getImageBase())
out["entries"] = entries
out["xrefs"] = xrefs

print(json.dumps(out))
