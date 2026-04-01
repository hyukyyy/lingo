#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────
# Lingo — Prompt Learning Hook (PostToolUse)
#
# Claude Code hook that scans tool output for glossary term matches
# and advises the AI to call record_signal for coupling reinforcement.
#
# Usage in .claude/settings.json:
#   "hooks": {
#     "PostToolUse": [{
#       "type": "command",
#       "command": "bash hooks/prompt-learning-hook.sh"
#     }]
#   }
#
# Input:  JSON on stdin with { tool_name, tool_input, tool_result }
# Output: Free-form advisory text on stdout suggesting record_signal
#         calls when glossary terms are detected in tool output.
#
# Requirements: bash, jq
# ────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────
GLOSSARY_PATH="${LINGO_GLOSSARY_PATH:-.lingo/glossary.json}"

# Lingo MCP tool names to skip (avoid infinite recursion)
LINGO_TOOLS="query_context get_term add_term update_term remove_term list_terms find_by_file bootstrap suggest_code_changes create_from_text learn_from_pr record_signal list_adapters"

# ── Read stdin JSON ─────────────────────────────────────────────────
INPUT="$(cat)"

# Bail out silently if input is empty
if [ -z "$INPUT" ]; then
  exit 0
fi

# ── Extract tool name ───────────────────────────────────────────────
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)" || true

# Bail if we couldn't extract a tool name
if [ -z "$TOOL_NAME" ]; then
  exit 0
fi

# ── Skip Lingo's own tools ──────────────────────────────────────────
for lingo_tool in $LINGO_TOOLS; do
  if [ "$TOOL_NAME" = "$lingo_tool" ]; then
    exit 0
  fi
done

# Also skip any tool that starts with "mcp__lingo" or "mcp__lingo-mcp-server"
case "$TOOL_NAME" in
  mcp__lingo*|lingo__*|lingo:*)
    exit 0
    ;;
esac

# ── Check glossary exists ───────────────────────────────────────────
if [ ! -f "$GLOSSARY_PATH" ]; then
  exit 0
fi

# ── Extract tool result text ────────────────────────────────────────
# The tool_result can be a string or structured content; we extract
# all text content into a single searchable string.
RESULT_TEXT="$(echo "$INPUT" | jq -r '
  if .tool_result | type == "string" then
    .tool_result
  elif .tool_result | type == "object" then
    [.tool_result.content[]? | select(.type == "text") | .text] | join(" ")
  else
    ""
  end
' 2>/dev/null)" || true

# Also include tool_input text for broader matching
INPUT_TEXT="$(echo "$INPUT" | jq -r '
  if .tool_input | type == "string" then
    .tool_input
  elif .tool_input | type == "object" then
    [.tool_input | to_entries[] | .value | tostring] | join(" ")
  else
    ""
  end
' 2>/dev/null)" || true

SEARCHABLE_TEXT="$INPUT_TEXT $RESULT_TEXT"

# Bail if there's nothing to search
if [ -z "${SEARCHABLE_TEXT// /}" ]; then
  exit 0
fi

# ── Load glossary terms ─────────────────────────────────────────────
# Extract term id, name, and aliases into a TSV stream:
#   id<TAB>name_or_alias
TERMS="$(jq -r '
  .terms | to_entries[] | .value |
  .id as $id |
  .name as $name |
  ([$name] + (.aliases // [])) |
  .[] |
  "\($id)\t\(.)"
' "$GLOSSARY_PATH" 2>/dev/null)" || true

if [ -z "$TERMS" ]; then
  exit 0
fi

# ── Scan for matches ────────────────────────────────────────────────
# Collect unique term IDs that have at least one matching name/alias
# in the searchable text. Use case-insensitive matching.
MATCH_COUNT=0
declare -A MATCHED_TERMS  # id -> name (first match wins)

while IFS=$'\t' read -r term_id term_label; do
  # Skip empty labels
  [ -z "$term_label" ] && continue

  # Case-insensitive word-boundary-aware grep
  # Use \b for word boundaries to avoid partial matches
  if echo "$SEARCHABLE_TEXT" | grep -qi "\b${term_label}\b" 2>/dev/null; then
    # Only record first match per term ID
    if [ -z "${MATCHED_TERMS[$term_id]+_}" ]; then
      MATCHED_TERMS[$term_id]="$term_label"
      MATCH_COUNT=$((MATCH_COUNT + 1))
    fi
  fi
done <<< "$TERMS"

# ── Output advisory ─────────────────────────────────────────────────
if [ "$MATCH_COUNT" -eq 0 ]; then
  exit 0
fi

echo "Lingo detected glossary terms in the tool output from '$TOOL_NAME'."
echo "Consider strengthening coupling by calling record_signal for these terms:"
echo ""

for term_id in "${!MATCHED_TERMS[@]}"; do
  term_label="${MATCHED_TERMS[$term_id]}"
  echo "  - record_signal(termId: \"$term_id\", signalType: \"prompt\")  # matched: \"$term_label\""
done

echo ""
echo "This reinforces the mapping between organizational terms and code locations."
