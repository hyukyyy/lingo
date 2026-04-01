---
name: create-items
description: "Parse natural language text into structured PM items"
mcp_tool: create_from_text
mcp_args:
  text: "$1"
---

# /lingo:create-items

Convert natural language planning text into structured PM items.

## Usage

```
/lingo:create-items [text]
/lingo:create-items 사용자 로그인 시 2단계 인증 추가
```

## Instructions

When the user invokes this skill:

### Step 1: Load MCP Tools

```
ToolSearch query: "+lingo create_from_text"
```

### Step 2: Get Text Input

If no argument provided, ask via AskUserQuestion:

```json
{
  "question": "PM 아이템으로 변환할 텍스트를 입력해주세요. (기능 설명, 요구사항, 불릿 리스트 등)",
  "header": "Input",
  "options": [
    {"label": "직접 입력", "description": "자연어 텍스트를 입력합니다"}
  ]
}
```

### Step 3: Select Item Type

```json
{
  "question": "기본 아이템 유형을 선택해주세요.",
  "header": "Item Type",
  "options": [
    {"label": "task", "description": "작업 (기본)"},
    {"label": "story", "description": "사용자 스토리"},
    {"label": "epic", "description": "에픽 (큰 범위)"},
    {"label": "bug", "description": "버그 리포트"}
  ]
}
```

### Step 4: Parse

Call `create_from_text`:
```
Tool: create_from_text
Input: {
  "text": "<input text>",
  "defaultItemType": "<selected type>"
}
```

### Step 5: Present Results

Show parsed items:

```
파싱 결과:

1. [story] 사용자 로그인 시 2단계 인증 추가
   상태: backlog
   우선순위: medium
   설명: 사용자 로그인 시 2단계 인증을 추가하여 보안을 강화한다

의도: create (confidence: 0.85)
```

### Step 6: Follow-up

```
📍 Next:
  /lingo:create-items — 다른 텍스트를 변환합니다
  /lingo:search <query> — 관련 용어를 검색합니다
```
