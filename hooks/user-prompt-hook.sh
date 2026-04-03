#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────
# Lingo — User Prompt Context Hook (UserPromptSubmit)
#
# Claude Code hook that automatically injects organizational glossary
# context into every user prompt. When the user mentions terms that
# exist in the lingo glossary, this hook provides their definitions
# and code locations so Claude understands the organization's language.
#
# This is the core value mechanism of Lingo: after bootstrap, every
# prompt automatically gets enriched with relevant terminology context.
#
# Usage in .claude/settings.json:
#   "hooks": {
#     "UserPromptSubmit": [{
#       "type": "command",
#       "command": "bash /path/to/hooks/user-prompt-hook.sh"
#     }]
#   }
#
# Input:  JSON on stdin with { "prompt": "user text", ... }
# Output: Matched glossary terms with definitions and code locations
#
# Requirements: bash, jq
# ────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────
GLOSSARY_PATH="${LINGO_GLOSSARY_PATH:-.lingo/glossary.json}"
MAX_TERMS=10  # Maximum terms to include in context

# ── Read stdin JSON ─────────────────────────────────────────────────
INPUT="$(cat)"

if [ -z "$INPUT" ]; then
  exit 0
fi

# ── Extract prompt text ─────────────────────────────────────────────
PROMPT="$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)" || true

if [ -z "$PROMPT" ]; then
  exit 0
fi

# ── Check glossary exists ───────────────────────────────────────────
if [ ! -f "$GLOSSARY_PATH" ]; then
  exit 0
fi

# ── Extract terms from glossary ─────────────────────────────────────
# Produces TSV: id<TAB>name<TAB>couplingScore<TAB>definition<TAB>filePath<TAB>symbol<TAB>relationship
# Also includes aliases as additional lines with same id
TERMS_DATA="$(jq -r '
  .terms | to_entries[] | .value |
  .id as $id |
  .name as $name |
  (.coupling.score // 0) as $score |
  (.definition // "" | gsub("\n"; " ") | .[:200]) as $def |
  (.codeLocations[0].filePath // "") as $fp |
  (.codeLocations[0].symbol // "") as $sym |
  (.codeLocations[0].relationship // "") as $rel |
  ([$name] + (.aliases // [])) as $labels |
  $labels[] |
  "\($id)\t\($name)\t\($score)\t\($def)\t\($fp)\t\($sym)\t\($rel)\t\(.)"
' "$GLOSSARY_PATH" 2>/dev/null)" || true

if [ -z "$TERMS_DATA" ]; then
  exit 0
fi

# ── Match terms against prompt ──────────────────────────────────────
# Collect matches: id -> (name, score, definition, filePath, symbol, relationship)
declare -A MATCHED_IDS       # id -> 1 (dedup)
declare -A MATCHED_NAMES     # id -> term name
declare -A MATCHED_SCORES    # id -> coupling score
declare -A MATCHED_DEFS      # id -> definition
declare -A MATCHED_FILES     # id -> filePath
declare -A MATCHED_SYMBOLS   # id -> symbol
declare -A MATCHED_RELS      # id -> relationship

MATCH_COUNT=0

while IFS=$'\t' read -r term_id term_name term_score term_def term_fp term_sym term_rel match_label; do
  [ -z "$match_label" ] && continue

  # Skip already matched terms
  if [ -n "${MATCHED_IDS[$term_id]+_}" ]; then
    continue
  fi

  # Case-insensitive matching with flexible boundaries
  # Works with Korean/CJK characters adjacent to English terms
  # Escape special regex chars in the label
  escaped_label="$(printf '%s' "$match_label" | sed 's/[.[\*^$()+?{|\\]/\\&/g')"

  # Use word boundary OR start/end of string for matching
  # The (^|[^a-zA-Z0-9]) pattern handles cases like "module도" where \b fails
  if echo "$PROMPT" | grep -qiP "(^|[^a-zA-Z0-9_])${escaped_label}([^a-zA-Z0-9_]|$)" 2>/dev/null; then
    MATCHED_IDS[$term_id]=1
    MATCHED_NAMES[$term_id]="$term_name"
    MATCHED_SCORES[$term_id]="$term_score"
    MATCHED_DEFS[$term_id]="$term_def"
    MATCHED_FILES[$term_id]="$term_fp"
    MATCHED_SYMBOLS[$term_id]="$term_sym"
    MATCHED_RELS[$term_id]="$term_rel"
    MATCH_COUNT=$((MATCH_COUNT + 1))

    # Stop after MAX_TERMS matches
    if [ "$MATCH_COUNT" -ge "$MAX_TERMS" ]; then
      break
    fi
  fi
done <<< "$TERMS_DATA"

# ── Output context ──────────────────────────────────────────────────
if [ "$MATCH_COUNT" -eq 0 ]; then
  exit 0
fi

# Sort by coupling score (highest first) and output
# Build sortable lines: score<TAB>id
SORTED_IDS=""
for term_id in "${!MATCHED_IDS[@]}"; do
  score="${MATCHED_SCORES[$term_id]}"
  SORTED_IDS="${SORTED_IDS}${score}\t${term_id}\n"
done

echo "[Lingo Context] Organizational terms detected in your prompt:"
echo ""

# Sort by score descending, then output each term
echo -e "$SORTED_IDS" | sort -t$'\t' -k1 -rn | head -n "$MAX_TERMS" | while IFS=$'\t' read -r _score term_id; do
  [ -z "$term_id" ] && continue

  name="${MATCHED_NAMES[$term_id]}"
  def="${MATCHED_DEFS[$term_id]}"
  fp="${MATCHED_FILES[$term_id]}"
  sym="${MATCHED_SYMBOLS[$term_id]}"
  rel="${MATCHED_RELS[$term_id]}"

  if [ -n "$fp" ] && [ -n "$sym" ]; then
    echo "- ${name} (${fp}#${sym}, ${rel})"
  elif [ -n "$fp" ]; then
    echo "- ${name} (${fp})"
  else
    echo "- ${name}"
  fi

  if [ -n "$def" ]; then
    echo "  ${def}"
  fi
  echo ""
done
