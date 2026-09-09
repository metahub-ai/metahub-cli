#!/usr/bin/env bash
# End-to-end check of the standalone bundle against a sandboxed machine
# that has every supported harness on it.
#
#   pnpm bundle && bash scripts/e2e-harness-matrix.sh
#
# Creates a throwaway HOME (METAHUB_E2E_HOME) with the config directory of
# each harness, installs the tarball into a private npm prefix, then walks
# bootstrap → install skill → install MCP → doctor → refresh → uninstall →
# bootstrap --uninstall and asserts what landed where. Installs hit the real
# portal (one skill, one MCP artifact), so it needs network access.
#
# Env:
#   MH_TARBALL   path to the tarball (default packages/cli/standalone/mh-latest.tgz)
#   MH_SKILL     skill slug to install (default keynote-deck)
#   MH_MCP       mcp slug to install (default paretools-github)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARBALL="${MH_TARBALL:-$HERE/packages/cli/standalone/mh-latest.tgz}"
SKILL="${MH_SKILL:-keynote-deck}"
MCP="${MH_MCP:-paretools-github}"
[ -f "$TARBALL" ] || { echo "tarball not found: $TARBALL (run pnpm bundle)"; exit 1; }

SB="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/mh-e2e-XXXXXX")" && pwd -P)"
HOME_SB="$SB/home"
PREFIX="$SB/prefix"
WORK="$SB/work"
mkdir -p "$HOME_SB" "$PREFIX" "$WORK/.vscode"
if [ "${MH_E2E_KEEP:-0}" = 1 ]; then echo "sandbox: $SB"; else trap 'rm -rf "$SB"' EXIT; fi

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
# json FILE path/to/key  → the value as JSON, or `undefined`
json() { node -e "let v=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));for(const k of process.argv[2].split('/')){v=(v==null)?undefined:v[k]}process.stdout.write(v===undefined?'undefined':JSON.stringify(v))" "$1" "$2"; }
has_block() { grep -q '<!-- metahub:begin -->' "$1" && grep -q '<!-- metahub:end -->' "$1"; }

# ── a machine with every harness on it ────────────────────────────────────
for d in .claude .cursor .codex .continue .codeium/windsurf .config/zed .config/goose .config/opencode .gemini/antigravity .gemini/config .antigravity; do
  mkdir -p "$HOME_SB/$d"
done
mkdir -p "$HOME_SB/Library/Application Support/Claude"
printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$HOME_SB/.config/opencode/opencode.jsonc"
printf '# My rules\n\nAlways use pnpm.\n' > "$HOME_SB/.gemini/GEMINI.md"
: > "$HOME_SB/.gemini/antigravity/mcp_config.json"   # the zero-byte file older Antigravity builds leave
# A stub `codex` that records its calls.
CODEX_LOG="$SB/codex.log"
CODEX_TOML="$HOME_SB/.codex/config.toml"
cat > "$SB/codex" <<STUB
#!/bin/sh
# Stub of the codex CLI: records calls and keeps a config.toml the way
# \`codex mcp add\` / \`codex mcp remove\` would.
printf '%s\n' "\$*" >> "$CODEX_LOG"
if [ "\$1 \$2" = "mcp add" ]; then
  NAME="\$3"; for a; do LAST="\$a"; done
  printf '\n[mcp_servers.%s]\ncommand = "node"\nargs = ["%s"]\n' "\$NAME" "\$LAST" >> "$CODEX_TOML"
elif [ "\$1 \$2" = "mcp remove" ]; then
  [ -f "$CODEX_TOML" ] && node -e 'const fs=require("fs");const f=process.argv[1],n=process.argv[2];const out=[];let skip=false;for(const l of fs.readFileSync(f,"utf8").split("\\n")){if(/^\\[/.test(l))skip=l.startsWith("[mcp_servers."+n+"]");if(!skip)out.push(l)}fs.writeFileSync(f,out.join("\\n"))' "$CODEX_TOML" "\$3"
fi
exit 0
STUB
chmod +x "$SB/codex"

export METAHUB_E2E_HOME="$HOME_SB"
export METAHUB_CODEX_BIN="$SB/codex"
unset XDG_CONFIG_HOME METAHUB_NO_INSTRUCTIONS
cd "$WORK"

echo "── install bundle"
npm install -g --prefix "$PREFIX" "$TARBALL" >/dev/null 2>&1
MH="$PREFIX/bin/mh"; MCPBIN="$PREFIX/bin/metahub-mcp"
check "mh --version runs" "$MH --version | grep -q '^mh '"
check "metahub-mcp --version runs" "$MCPBIN --version | grep -q '^metahub '"
BIN_PATH="$PREFIX/lib/node_modules/@metahub-ai/mh/bin/metahub-mcp.js"

echo "── mh bootstrap"
OUT="$($MH bootstrap 2>&1)"
check "claude code wired at ~/.claude.json"        "[ \"\$(json $HOME_SB/.claude.json mcpServers/metahub/args/0)\" = '\"$BIN_PATH\"' ]"
check "cursor wired"                                "[ \"\$(json $HOME_SB/.cursor/mcp.json mcpServers/metahub/command)\" = '\"node\"' ]"
check "zed wired (context_servers)"                 "[ \"\$(json $HOME_SB/.config/zed/settings.json context_servers/metahub/command)\" = '\"node\"' ]"
check "windsurf wired"                              "[ \"\$(json $HOME_SB/.codeium/windsurf/mcp_config.json mcpServers/metahub/command)\" = '\"node\"' ]"
check "gemini cli wired at ~/.gemini/settings.json" "[ \"\$(json $HOME_SB/.gemini/settings.json mcpServers/metahub/command)\" = '\"node\"' ]"
check "antigravity wired at ~/.gemini/config/mcp_config.json" "[ \"\$(json $HOME_SB/.gemini/config/mcp_config.json mcpServers/metahub/command)\" = '\"node\"' ]"
check "opencode wired into existing .jsonc (mcp key, command array)" "[ \"\$(json $HOME_SB/.config/opencode/opencode.jsonc mcp/metahub/command/0)\" = '\"node\"' ] && [ ! -e $HOME_SB/.config/opencode/opencode.json ]"
check "opencode .jsonc kept its \$schema"           "[ \"\$(json $HOME_SB/.config/opencode/opencode.jsonc '\$schema')\" = '\"https://opencode.ai/config.json\"' ]"
check "vs code workspace wired (servers key)"       "[ \"\$(json $WORK/.vscode/mcp.json servers/metahub/command)\" = '\"node\"' ]"
check "claude desktop wired"                        "[ \"\$(json \"$HOME_SB/Library/Application Support/Claude/claude_desktop_config.json\" mcpServers/metahub/command)\" = '\"node\"' ]"
check "codex wired through 'codex mcp add'"         "grep -Eq '^mcp add metahub( --env [A-Z_]+=[^ ]+)* -- node $BIN_PATH\$' $CODEX_LOG && grep -q '^\[mcp_servers.metahub\]' $CODEX_TOML"
check "no registry url baked into client env"      "! grep -q METAHUB_REGISTRY_URL $HOME_SB/.claude.json"
check "continue / cline / goose got paste snippets" "echo \"\$OUT\" | grep -q 'Continue' && echo \"\$OUT\" | grep -q 'Goose' && echo \"\$OUT\" | grep -q 'extensions:'"
check "instructions: ~/.claude/CLAUDE.md"           "has_block $HOME_SB/.claude/CLAUDE.md"
check "instructions: ~/.codex/AGENTS.md"            "has_block $HOME_SB/.codex/AGENTS.md"
check "instructions: ~/.gemini/GEMINI.md appended, user text kept" "has_block $HOME_SB/.gemini/GEMINI.md && head -1 $HOME_SB/.gemini/GEMINI.md | grep -q '# My rules'"
check "instructions: ~/.cursor/rules/metahub.mdc alwaysApply" "grep -q 'alwaysApply: true' $HOME_SB/.cursor/rules/metahub.mdc"
check "instructions: opencode AGENTS.md"            "has_block $HOME_SB/.config/opencode/AGENTS.md"
check "instructions: goose .goosehints"             "has_block $HOME_SB/.config/goose/.goosehints"
check "instructions: windsurf global_rules.md"      "has_block $HOME_SB/.codeium/windsurf/memories/global_rules.md"
check "client configs are 0600"                     "[ \"\$(stat -f '%Lp' $HOME_SB/.claude.json 2>/dev/null || stat -c '%a' $HOME_SB/.claude.json)\" = 600 ]"

echo "── mh bootstrap again (idempotent)"
OUT2="$($MH bootstrap 2>&1)"
check "no JSON client re-wired on second run"       "! echo \"\$OUT2\" | grep -q 'Wired metahub into'"
check "instruction blocks reported current"         "echo \"\$OUT2\" | grep -qi 'already current'"
check "GEMINI.md holds exactly one block"           "[ \"\$(grep -c 'metahub:begin' $HOME_SB/.gemini/GEMINI.md)\" = 1 ]"
check "bootstrap --status runs"                     "$MH bootstrap --status >/dev/null 2>&1"
check "status shows codex/gemini/antigravity/opencode wired" "! $MH bootstrap --status 2>&1 | sed -n '/Bundled MCP bin/,/Instruction files/p' | grep -E 'Codex CLI|Gemini CLI|Antigravity|opencode' | grep -v ' wired'"
check "status shows the instruction block present everywhere" "! $MH bootstrap --status 2>&1 | sed -n '/Instruction files/,\$p' | grep -E 'no MetaHub block|older block|harness not detected'"

echo "── mh install skills/$SKILL"
$MH install "skills/$SKILL" >/dev/null 2>&1 || bad "install skills/$SKILL exited non-zero"
CANON="$HOME_SB/.claude/skills/$SKILL"
check "canonical SKILL.md present"                  "[ -f $CANON/SKILL.md ]"
check "~/.agents/skills/$SKILL is a link to it"     "[ -L $HOME_SB/.agents/skills/$SKILL ] && [ \"\$(readlink $HOME_SB/.agents/skills/$SKILL)\" = $CANON ]"
check "~/.gemini/config/skills/$SKILL linked (antigravity)" "[ -L $HOME_SB/.gemini/config/skills/$SKILL ]"
check "continue rule written"                       "[ -f $HOME_SB/.continue/rules/$SKILL.md ]"
check "zed prompt written"                          "[ -f $HOME_SB/.config/zed/prompts/$SKILL.md ]"
check "no cursor .mdc duplicate"                    "[ ! -e $HOME_SB/.cursor/rules/$SKILL.mdc ]"
check "sidecar written"                             "[ -f $CANON/.metahub.json ]"
check "doctor skills/$SKILL passes"                 "$MH doctor skills/$SKILL >/dev/null 2>&1"
check "refresh is a no-op afterwards"               "$MH refresh 2>&1 | grep -q 'already wired'"

echo "── mh install mcps/$MCP (source tree → npm install + build)"
$MH install "mcps/$MCP" > "$SB/mcp-install.log" 2>&1 || bad "install mcps/$MCP exited non-zero"
MDIR="$HOME_SB/.metahub/mcp/$MCP"
check "install wired a runnable launch (built entry, or the published package)" "L=\$(json $HOME_SB/.claude.json mcpServers/$MCP/command); if [ \"\$L\" = '\"npx\"' ]; then json $HOME_SB/.claude.json mcpServers/$MCP/args/1 | grep -q '@'; else ENTRY=\$(json $HOME_SB/.claude.json mcpServers/$MCP/args/0); [ -f \"\${ENTRY//\\\"/}\" ]; fi"
check "install output explains what it did (Prepared / published package)" "grep -Eq 'Prepared|published package' $SB/mcp-install.log"
check "no 'No AI clients detected' false alarm"     "! grep -q 'No AI clients detected' $SB/mcp-install.log"
check "wired into gemini cli"                       "json $HOME_SB/.gemini/settings.json mcpServers/$MCP/command | grep -Eq '\"(node|npx)\"'"
check "wired into opencode"                         "[ \"\$(json $HOME_SB/.config/opencode/opencode.jsonc mcp/$MCP/type)\" = '\"local\"' ]"
check "codex add called with env"                   "grep -q \"^mcp add $MCP --env METAHUB_INGEST_API_KEY=mhi_\" $CODEX_LOG && grep -q \"^\[mcp_servers.$MCP\]\" $CODEX_TOML"
check "doctor mcps/$MCP passes"                     "$MH doctor mcps/$MCP >/dev/null 2>&1"

echo "── uninstall"
$MH uninstall "skills/$SKILL" >/dev/null 2>&1 || bad "uninstall skill exited non-zero"
check "canonical dir removed"                       "[ ! -e $CANON ]"
check "agents link removed"                         "[ ! -e $HOME_SB/.agents/skills/$SKILL ] && [ ! -L $HOME_SB/.agents/skills/$SKILL ]"
check "antigravity link removed"                    "[ ! -L $HOME_SB/.gemini/config/skills/$SKILL ]"
check "continue rule removed"                       "[ ! -e $HOME_SB/.continue/rules/$SKILL.md ]"
$MH uninstall "mcps/$MCP" >/dev/null 2>&1 || bad "uninstall mcp exited non-zero"
check "mcp entry gone from claude / gemini / opencode" "[ \"\$(json $HOME_SB/.claude.json mcpServers/$MCP)\" = undefined ] && [ \"\$(json $HOME_SB/.gemini/settings.json mcpServers/$MCP)\" = undefined ] && [ \"\$(json $HOME_SB/.config/opencode/opencode.jsonc mcp/$MCP)\" = undefined ]"
check "codex remove called"                         "grep -q \"^mcp remove $MCP\$\" $CODEX_LOG"

echo "── mh bootstrap --uninstall"
$MH bootstrap --uninstall >/dev/null 2>&1 || bad "bootstrap --uninstall exited non-zero"
check "metahub entry gone from claude / gemini / opencode / antigravity" "[ \"\$(json $HOME_SB/.claude.json mcpServers/metahub)\" = undefined ] && [ \"\$(json $HOME_SB/.gemini/settings.json mcpServers/metahub)\" = undefined ] && [ \"\$(json $HOME_SB/.config/opencode/opencode.jsonc mcp/metahub)\" = undefined ] && [ \"\$(json $HOME_SB/.gemini/config/mcp_config.json mcpServers/metahub)\" = undefined ]"
check "CLAUDE.md that held only the block is gone" "[ ! -e $HOME_SB/.claude/CLAUDE.md ]"
check "GEMINI.md restored to the user's text"       "[ \"\$(cat $HOME_SB/.gemini/GEMINI.md)\" = \"\$(printf '# My rules\n\nAlways use pnpm.')\" ]"
check "cursor rule file removed"                    "[ ! -e $HOME_SB/.cursor/rules/metahub.mdc ]"

echo "── malformed config is never overwritten"
printf '{ "mcpServers": { "keepme": { "command": "x" }, ' > "$HOME_SB/.cursor/mcp.json"
BROKEN="$(cat "$HOME_SB/.cursor/mcp.json")"
$MH bootstrap --no-instructions >/dev/null 2>&1 || true
check "broken cursor mcp.json left byte-for-byte"   "[ \"\$(cat $HOME_SB/.cursor/mcp.json)\" = \"\$BROKEN\" ]"
check "other clients still wired"                   "[ \"\$(json $HOME_SB/.claude.json mcpServers/metahub/command)\" = '\"node\"' ]"

echo "── stdio probe"
PROBE="$(node -e '
const { spawn } = require("node:child_process");
const p = spawn(process.argv[1], [], { stdio: ["pipe", "pipe", "ignore"] });
let buf = "";
p.stdout.on("data", (d) => (buf += d));
const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
setTimeout(() => {
  p.kill();
  let instr = "", tools = -1;
  for (const l of buf.split("\n")) { try { const m = JSON.parse(l); if (m.id === 1) instr = m.result.instructions || ""; if (m.id === 2) tools = m.result.tools.length; } catch {} }
  console.log(`instructions=${instr.slice(0, 30)}|tools=${tools}`);
}, 5000);
' "$MCPBIN")"
check "initialize carries instructions"             "echo \"\$PROBE\" | grep -q 'instructions=MetaHub is the registry'"
check "tools/list has 13 tools"                     "echo \"\$PROBE\" | grep -q 'tools=13'"

echo "── npx cache launch form"
NPX_HOME="$SB/home-npx"; mkdir -p "$NPX_HOME/.claude" "$SB/npm/_npx/deadbeef/node_modules/@metahub-ai"
cp -R "$PREFIX/lib/node_modules/@metahub-ai/mh" "$SB/npm/_npx/deadbeef/node_modules/@metahub-ai/mh"
METAHUB_E2E_HOME="$NPX_HOME" node "$SB/npm/_npx/deadbeef/node_modules/@metahub-ai/mh/bin/mh.js" bootstrap --no-instructions >/dev/null 2>&1 || bad "npx-form bootstrap exited non-zero"
check "npx-cache install wires the npx form"        "[ \"\$(json $NPX_HOME/.claude.json mcpServers/metahub/command)\" = '\"npx\"' ] && [ \"\$(json $NPX_HOME/.claude.json mcpServers/metahub/args/1)\" = '\"--package=@metahub-ai/mh\"' ]"

echo
echo "passed: $pass  failed: $fail"
if [ "$fail" != 0 ] && [ -f "$SB/mcp-install.log" ]; then
  echo "── mcp install output"; sed 's/^/   /' "$SB/mcp-install.log"
fi
[ "$fail" = 0 ]
