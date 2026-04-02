---
name: learn
description: "Learn terminology mappings from a GitHub Pull Request"
mcp_tool: learn_from_pr
mcp_args:
  prUrl: "$1"
---

# /lingo:learn

Learn organizational terminology from a merged GitHub Pull Request.

## Usage

```
/lingo:learn <PR-URL>
/lingo:learn https://github.com/owner/repo/pull/123
```

## Instructions

**IMPORTANT: 사용자에게 질문하거나 선택지를 제시할 때는 반드시 AskUserQuestion 도구를 사용하세요. 일반 텍스트로 질문하지 마세요.**

When the user invokes this skill:

### Step 1: Load MCP Tools

```
ToolSearch query: "+lingo learn"
```

### Step 2: Get PR URL

If no argument provided, ask via AskUserQuestion:

```json
{
  "question": "학습할 GitHub PR URL을 입력해주세요.",
  "header": "PR URL",
  "options": [
    {"label": "URL 입력", "description": "GitHub PR URL을 직접 입력합니다 (예: https://github.com/owner/repo/pull/123)"}
  ]
}
```

### Step 3: Dry Run

Call `learn_from_pr` with `dryRun: true`:
```
Tool: learn_from_pr
Input: { "prUrl": "<url>", "dryRun": true }
```

Present results in a clear format:
- PR 제목과 번호
- 추출된 용어 목록 (이름, 정의, 액션)
- 매핑된 코드 파일 목록

### Step 4: Confirm

```json
{
  "question": "이 용어들을 글로서리에 추가할까요?",
  "header": "저장",
  "options": [
    {"label": "저장", "description": "추출된 용어를 글로서리에 저장합니다"},
    {"label": "취소", "description": "저장하지 않습니다"}
  ]
}
```

### Step 5: Persist

If confirmed, call `learn_from_pr` with `dryRun: false`.

Report:
```
학습 완료!
  새 용어: N개 생성
  기존 용어: M개 업데이트
  코드 위치: K개 추가

📍 Next:
  /lingo:learn <another-PR> — 다른 PR에서도 학습합니다
  /lingo:search <query> — 학습된 용어를 검색합니다
```

### Error Handling

- GitHub token 없을 경우: `/lingo:setup`으로 안내
- PR URL 형식 오류: 올바른 형식 안내 (https://github.com/owner/repo/pull/123)
- API rate limit: 토큰 설정 안내
