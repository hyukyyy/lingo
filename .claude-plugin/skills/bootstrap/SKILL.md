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

When the user invokes this skill:

### Step 1: Load MCP Tools

```
ToolSearch query: "+lingo bootstrap"
```

### Step 2: Check Prerequisites

Check if `.lingo/config.json` exists. If not, suggest running `/lingo:setup` first.

### Step 3: Gather Parameters

Ask via AskUserQuestion:

```json
{
  "question": "어떤 디렉토리를 스캔할까요?",
  "header": "Scan",
  "options": [
    {"label": "현재 디렉토리", "description": "현재 작업 디렉토리를 스캔합니다"},
    {"label": "직접 입력", "description": "다른 경로를 지정합니다"}
  ]
}
```

```json
{
  "question": "PM 도구에서도 기획 용어를 가져올까요?",
  "header": "PM 연동",
  "options": [
    {"label": "코드만 스캔", "description": "코드베이스에서만 용어를 추출합니다"},
    {"label": "Notion 연동", "description": "Notion에서도 기획 아이템을 가져옵니다"}
  ]
}
```

### Step 4: Dry Run

Call the `bootstrap` MCP tool with `dryRun: true`:
```
Tool: bootstrap
Input: { "rootDir": "<path>", "dryRun": true, "adapterName": "<if selected>" }
```

Present results: 발견된 용어 수, 코드 위치 수, 카테고리별 분류.

### Step 5: Confirm

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

If confirmed, call `bootstrap` with `dryRun: false`.

Report final result:
```
Bootstrap 완료!
  생성된 용어: N개
  매핑된 코드 위치: M개

📍 Next:
  /lingo:learn <PR-URL> — PR에서 추가 용어를 학습합니다
  /lingo:search <query> — 글로서리를 검색합니다
```
