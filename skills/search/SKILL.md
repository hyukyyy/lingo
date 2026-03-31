---
name: search
description: "Search organizational glossary for terms and code locations"
mcp_tool: query_context
mcp_args:
  query: "$1"
---

# /lingo:search

Search the organizational glossary for terms matching a query.

## Usage

```
/lingo:search <query>
/lingo:search 결제 모듈
```

## Instructions

When the user invokes this skill:

### Step 1: Load MCP Tools

```
ToolSearch query: "+lingo query_context"
```

### Step 2: Get Search Query

If no argument provided, ask via AskUserQuestion:

```json
{
  "question": "어떤 용어를 찾고 있나요?",
  "header": "Search",
  "options": [
    {"label": "직접 입력", "description": "검색할 용어를 입력합니다"}
  ]
}
```

### Step 3: Search

Call `query_context`:
```
Tool: query_context
Input: { "query": "<search term>" }
```

### Step 4: Present Results

If results found, present in clean format:

```
검색 결과: "<query>"

1. **결제 모듈** (confidence: manual)
   정의: 사용자 결제를 처리하는 서비스 모듈
   별칭: payment, 빌링
   코드 위치:
   - src/services/payment.ts → PaymentService (defines)
   - src/api/billing.ts → BillingController (implements)
   - tests/payment.test.ts (tests)
```

If no results:
- If glossary is empty → suggest `/lingo:bootstrap` or `/lingo:learn`
- If glossary has data → inform no match, suggest alternative queries

### Step 5: Follow-up

After showing results, suggest related actions:
```
📍 Related:
  /lingo:impact — 이 용어의 코드 변경 영향도를 분석합니다
  /lingo:search <other> — 다른 용어를 검색합니다
```
