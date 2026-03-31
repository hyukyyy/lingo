---
name: setup
description: "Configure tokens and initialize lingo for first use"
---

# /lingo:setup

Configure GitHub/Notion tokens and initialize lingo for a project.

## Usage

```
/lingo:setup
```

## Instructions

When the user invokes this skill:

### Step 1: Load MCP Tools

Use ToolSearch to load lingo MCP tools:
```
ToolSearch query: "+lingo bootstrap"
```

### Step 2: Gather Configuration

Ask the user for configuration via AskUserQuestion:

**Question 1 — GitHub Token:**
```json
{
  "question": "GitHub Personal Access Token을 입력해주세요. PR 기반 학습에 필요합니다. (repo 권한 필요)",
  "header": "GitHub",
  "options": [
    {"label": "직접 입력", "description": "PAT를 직접 입력합니다"},
    {"label": "나중에 설정", "description": "GitHub 연동 없이 진행합니다"}
  ]
}
```

If "직접 입력", ask for the token text.

**Question 2 — Notion Token (Optional):**
```json
{
  "question": "Notion API Token을 설정할까요? (기획 아이템 연동용)",
  "header": "Notion",
  "options": [
    {"label": "직접 입력", "description": "Notion Integration Token을 입력합니다"},
    {"label": "건너뛰기", "description": "Notion 연동 없이 진행합니다"}
  ]
}
```

**Question 3 — Target Repo:**
```json
{
  "question": "lingo를 사용할 대상 저장소 경로를 입력해주세요.",
  "header": "Repository",
  "options": [
    {"label": "현재 디렉토리", "description": "현재 작업 디렉토리를 대상으로 합니다"},
    {"label": "직접 입력", "description": "다른 경로를 지정합니다"}
  ]
}
```

### Step 3: Save Configuration

Write `.lingo/config.json` using the Write tool:

```json
{
  "github": {
    "token": "<user-provided or empty>",
    "defaultRepo": "owner/repo"
  },
  "notion": {
    "token": "<user-provided or empty>",
    "databaseIds": []
  },
  "repoPath": "<target-repo-path>"
}
```

Also set environment variables for the current session if tokens were provided:
- `LINGO_GITHUB_TOKEN` for GitHub
- Notion token in adapter config

### Step 4: Verify Connection

If GitHub token was provided, verify it works:
```bash
curl -s -H "Authorization: Bearer <token>" https://api.github.com/user | head -5
```

### Step 5: Suggest Next Steps

```
Setup complete!

📍 Next steps:
  /lingo:bootstrap — 코드베이스를 스캔하여 초기 글로서리를 생성합니다
  /lingo:learn <PR-URL> — PR에서 기획 용어를 학습합니다
```
