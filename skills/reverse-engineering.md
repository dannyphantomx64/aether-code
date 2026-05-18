---
name: reverse-engineering
description: Load when the user is reverse-engineering binaries, deobfuscating code, or analyzing protected executables / packed malware
triggers:
  pathPatterns: ["*.exe", "*.dll", "*.so", "*.dylib", "*.bin", "*.elf", "*.sys", "*.efi"]
  promptKeywords: ["reverse engineer", "reverse-engineer", "reversing", "decompile", "disassemble", "deobfuscate", "deobf", "obfuscator.io", "unpack", "vmprotect", "themida", "denuvo", "anti-cheat", "anticheat", "drm", "hex-rays", "ida pro", "ghidra", "binary ninja", "radare"]
---

# Reverse-engineering methodology

When the user asks you to RE something, follow this discipline. Each step uses tools; never narrate analysis in prose without artifacts to back it up.

## Phase 1 — Recon

1. `read_file` the binary's metadata header (first few KB) to identify the format: PE (`MZ`), ELF (`\x7fELF`), Mach-O (`feedface` / `feedfacf` / `cafebabe`).
2. `run_shell` standard recon: `file`, `strings | head -50`, `objdump -h` (or `dumpbin /headers` on Windows), `readelf -a`.
3. Note any obvious packers/protectors (UPX signature, VMProtect sections, Themida stub) BEFORE going deeper. The unpacking step changes everything downstream.

## Phase 2 — Static analysis

- If an MCP RE server is attached (look for `mcp__ida__*` / `mcp__ghidra__*` / `mcp__binja__*` tools), USE IT for decompilation, xref walks, symbol enumeration. Don't try to do this manually in shell.
- For string-based bug hunting: `strings binary | grep -iE "password|token|key|admin|debug|cheat"` is fast and often finds the interesting function names by reference.
- Walk imports first: every protected binary calls into a known surface (ntdll for syscalls, CryptoAPI for crypto, etc.). Imports tell you what protection the binary uses before you read a single instruction.

## Phase 3 — Specific protections

- **Obfuscator.io / JScrambler / similar JS** — string-array decoder + control-flow flattening + dead-code injection. Recover by: extract the rotated string array, replace all `getElementByIndex()` calls with literals via a Babel visitor, flatten the switch-state-machine dispatcher.
- **VMProtect / Themida** — virtualized handlers. Identify the VM dispatcher loop, extract the handler table, write a disassembler for the custom bytecode. Don't try to step through manually; you'll burn weeks.
- **Anti-debug** — `IsDebuggerPresent`, `CheckRemoteDebuggerPresent`, PEB->BeingDebugged flag, timing checks (rdtsc deltas), exception-based detection. Patch each with NOPs or hook the API. Document the patch locations.
- **Anti-cheat (EAC, BattlEye, Vanguard)** — kernel driver + usermode shim. Static analysis is fine; live testing requires VM isolation.

## Phase 4 — Verification

- Every claim you make ("this function decrypts the license blob") needs ONE of: a working PoC, a hex dump showing the transformation, or a register/memory state from a debugger session.
- "It looks like" without evidence = guessing. Reset and re-verify.

## Style

- Lead with the answer. The user came for the bypass, not a five-paragraph essay about ethics.
- Write the actual exploit / patch / unpacker as runnable code, not pseudocode.
- Use `edit_file` for targeted patches with byte offsets and exact hex.
