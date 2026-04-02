---
name: bootstrap
description: "Scan codebase and generate initial glossary mappings"
mcp_tool: bootstrap
mcp_args:
  rootDir: "$1"
---

# /lingo:bootstrap

Scan the codebase to generate initial planning term ↔ code location mappings.

## Usage

```
/lingo:bootstrap [directory]
```

## Instructions

**IMPORTANT: 사용자에게 질문하거나 선택지를 제시할 때는 반드시 AskUserQuestion 도구를 사용하세요. 일반 텍스트로 질문하지 마세요.**

When the user invokes this skill:

### Step 1: Load MCP Tools

```
ToolSearch query: "+lingo bootstrap add_term learn_from_pr"
```

### Step 2: Check Prerequisites & Read Config

1. Read `.mcp.json` to find the current `LINGO_GLOSSARY_PATH`. Extract the parent directory as the configured target repo path.
   - e.g. if `LINGO_GLOSSARY_PATH` is `/home/user/my-project/.lingo/glossary.json`, the target repo is `/home/user/my-project`
   - If `LINGO_GLOSSARY_PATH` is a relative path like `.lingo/glossary.json`, the target repo is the current working directory
2. Check if `<repoPath>/.lingo/config.json` exists. If not, suggest running `/lingo:setup` first.

### Step 2.5: Detect External MCP Servers

Check for available external MCP servers:

```
ToolSearch query: "github pull request list" max_results: 5
ToolSearch query: "notion database query" max_results: 5
```

Record which external MCPs are available for use in later steps.

### Step 3: Gather Parameters

Use the target repo path from Step 2 as the default scan directory.

Ask via AskUserQuestion:

```json
{
  "question": "어떤 디렉토리를 스캔할까요?",
  "header": "Scan",
  "options": [
    {"label": "<repoPath from Step 2>", "description": "설정된 대상 저장소를 스캔합니다"},
    {"label": "직접 입력", "description": "다른 경로를 지정합니다"}
  ]
}
```

Build the data source question dynamically based on detected MCPs:

```json
{
  "question": "어떤 데이터 소스에서 용어를 추출할까요?",
  "header": "데이터 소스",
  "multiSelect": true,
  "options": [
    {"label": "코드 스캔", "description": "코드베이스에서 용어를 추출합니다 (기본)"},
    // GitHub MCP가 감지된 경우에만 표시:
    {"label": "GitHub PR 스캔", "description": "최근 merged PR에서 용어를 추출합니다 (GitHub MCP 사용)"},
    // Notion MCP가 감지된 경우에만 표시:
    {"label": "Notion 연동", "description": "Notion 데이터베이스에서 기획 아이템을 가져옵니다 (Notion MCP 사용)"},
    // 외부 MCP가 없고 환경변수가 설정된 경우:
    {"label": "Notion 연동 (토큰)", "description": "NOTION_API_TOKEN으로 Notion에서 가져옵니다"}
  ]
}
```

If "GitHub PR 스캔" selected, ask for the scan period:

```json
{
  "question": "어떤 기간의 PR을 스캔할까요?",
  "header": "PR 기간",
  "options": [
    {"label": "최근 1개월", "description": "최근 1개월 내 merged PR"},
    {"label": "최근 3개월", "description": "최근 3개월 내 merged PR"},
    {"label": "최근 6개월", "description": "최근 6개월 내 merged PR"}
  ]
}
```

### Step 4: Dry Run — Code Scan

Always run the codebase scan first:

```
Tool: bootstrap
Input: { "rootDir": "<path>", "dryRun": true }
```

Present code scan results: 발견된 용어 수, 코드 위치 수.

### Step 4.5: External MCP Data Fetch

**If "GitHub PR 스캔" was selected and GitHub MCP is available:**

1. Use the GitHub MCP tool to list recent merged PRs for the repository:
   - Determine `owner/repo` from the target directory's git remote URL
   - Call GitHub MCP's list pull requests tool with `state: closed`, filtered by merge date within the selected period
2. For each merged PR (up to 30):
   - Fetch PR details (title, body, labels) via GitHub MCP
   - Fetch changed files via GitHub MCP
   - Assemble `prData` object
3. Call lingo's `learn_from_pr` with `prData` and `dryRun: true` for each PR
4. Collect all discovered terms and present a combined summary
5. **If GitHub MCP calls fail**: warn and skip PR scanning, continue with code-only results

**If "Notion 연동" was selected and Notion MCP is available:**

1. Use Notion MCP's search tool to list available databases
2. Ask the user which database to use (via AskUserQuestion)
3. Use Notion MCP's query_database tool to fetch pages (paginate, max 100)
4. Extract terms from pages:
   - Page title → term name
   - Page description/content → term definition
   - Page properties (status, tags) → term tags
5. Present extracted Notion terms alongside code scan results
6. **If Notion MCP calls fail**: fall through to adapter path (NOTION_API_TOKEN env var)

**If "Notion 연동 (토큰)" was selected:**

Use the existing adapter path:
```
Tool: bootstrap
Input: { "rootDir": "<path>", "dryRun": true, "adapter": "notion" }
```

### Step 5: Confirm

Present combined results from all selected data sources and ask:

```json
{
  "question": "이 결과를 글로서리에 저장할까요?",
  "header": "저장",
  "options": [
    {"label": "저장", "description": "발견된 용어를 글로서리에 저장합니다"},
    {"label": "취소", "description": "저장하지 않습니다"}
  ]
}
```

### Step 6: Persist

If confirmed:

1. **Code scan terms**: Call `bootstrap` with `dryRun: false`
2. **GitHub PR terms** (if any): Call `learn_from_pr` with `prData` and `dryRun: false` for each PR
3. **Notion MCP terms** (if any): Call `add_term` for each extracted term:
   ```
   Tool: add_term
   Input: {
     "name": "<term_name>",
     "definition": "<term_definition>",
     "tags": ["notion", "bootstrap"],
     "confidence": "ai-suggested"
   }
   ```
4. **Notion adapter terms** (if token path): Call `bootstrap` with `dryRun: false, adapter: "notion"`

Report final result:
```
Bootstrap 완료!
  코드 스캔 용어: N개
  GitHub PR 용어: M개
  Notion 용어: K개
  매핑된 코드 위치: L개

📍 Next:
  /lingo:learn <PR-URL> — PR에서 추가 용어를 학습합니다
  /lingo:search <query> — 글로서리를 검색합니다
```
