---
name: impact
description: "Analyze code impact when a planning term changes"
mcp_tool: suggest_code_changes
---

# /lingo:impact

Analyze what code needs to change when a planning term evolves.

## Usage

```
/lingo:impact
```

## Instructions

**IMPORTANT: 사용자에게 질문하거나 선택지를 제시할 때는 반드시 AskUserQuestion 도구를 사용하세요. 일반 텍스트로 질문하지 마세요.**

When the user invokes this skill:

### Step 1: Load MCP Tools

```
ToolSearch query: "+lingo suggest_code_changes"
```

### Step 2: Gather Parameters

Ask step by step via AskUserQuestion:

**Question 1 — Which term?**
```json
{
  "question": "어떤 용어가 변경되나요? (용어 이름 또는 ID)",
  "header": "Term",
  "options": [
    {"label": "직접 입력", "description": "변경되는 용어 이름을 입력합니다"}
  ]
}
```

If the user provides a name, first use `query_context` to find the term and get its ID.

**Question 2 — Change type:**
```json
{
  "question": "어떤 종류의 변경인가요?",
  "header": "Change Type",
  "options": [
    {"label": "rename", "description": "용어 이름 변경 (예: 결제→빌링)"},
    {"label": "redefine", "description": "정의/범위 변경"},
    {"label": "deprecate", "description": "용어 폐기"},
    {"label": "split", "description": "하나의 용어를 여러 개로 분리"},
    {"label": "merge", "description": "여러 용어를 하나로 통합"}
  ]
}
```

**Question 3 — Description:**
```json
{
  "question": "변경 내용을 설명해주세요.",
  "header": "Description",
  "options": [
    {"label": "직접 입력", "description": "변경 사항을 설명합니다 (예: '결제 모듈을 빌링 시스템으로 이름 변경')"}
  ]
}
```

### Step 3: Run Analysis

Call `suggest_code_changes`:
```
Tool: suggest_code_changes
Input: {
  "termId": "<id>",
  "changeType": "<type>",
  "description": "<description>"
}
```

### Step 4: Present Results

Group by file, show priority:

```
영향도 분석: "결제 모듈" → rename

🔴 Critical (즉시 수정 필요)
  src/services/payment.ts
  - PaymentService → BillingService (symbol-rename)
  - Before: class PaymentService
  - After:  class BillingService

🟡 Recommended
  src/api/billing.ts
  - import 경로 업데이트 (import-update)

🟢 Optional
  tests/payment.test.ts
  - 테스트 설명 업데이트 (comment-update)

요약: 3개 파일, 5개 수정 제안

📍 Next:
  /lingo:search <query> — 다른 용어를 검색합니다
```
