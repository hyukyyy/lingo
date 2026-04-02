---
name: setup
description: "Configure tokens and initialize lingo for first use"
---

# /lingo:setup

Configure adapter tokens and initialize lingo for a project.

## Usage

```
/lingo:setup
```

## Instructions

**IMPORTANT: 사용자에게 질문하거나 선택지를 제시할 때는 반드시 AskUserQuestion 도구를 사용하세요. 일반 텍스트로 질문하지 마세요.**

When the user invokes this skill:

### Step 1: Load MCP Tools

Use ToolSearch to load lingo MCP tools:
```
ToolSearch query: "+lingo bootstrap list_adapters"
```

### Step 2: Discover Available Adapters

Call `list_adapters` to get the current PM and SCM adapters registered with Lingo:

```
Tool: list_adapters
Input: {}
```

This returns a list of `{ name, type, displayName }` entries. For example:
```json
[
  { "name": "notion", "type": "pm", "displayName": "Notion" },
  { "name": "json", "type": "pm", "displayName": "JSON File" },
  { "name": "github", "type": "scm", "displayName": "GitHub" }
]
```

Separate the results into PM adapters (`type === "pm"`) and SCM adapters (`type === "scm"`).

### Step 3: Generate Dynamic Setup Questions

Using the adapter list from Step 2, generate configuration questions dynamically.

**Question 1 — SCM Adapter Selection (if any SCM adapters available):**

Build options from the SCM adapters returned by `list_adapters`:

```json
{
  "question": "어떤 SCM(소스 관리) 도구를 연동할까요? PR 기반 학습에 필요합니다.",
  "header": "SCM 연동",
  "options": [
    // One option per SCM adapter from list_adapters
    // e.g. {"label": "GitHub", "description": "GitHub 저장소와 연동합니다 (PAT 필요, repo 권한)"},
    // e.g. {"label": "GitLab", "description": "GitLab 저장소와 연동합니다"},
    {"label": "나중에 설정", "description": "SCM 연동 없이 진행합니다"}
  ]
}
```

If the user selects an SCM adapter, ask for the token using AskUserQuestion:
```json
{
  "question": "<displayName> 토큰을 어떻게 설정할까요?",
  "header": "<displayName> Token",
  "options": [
    {"label": "직접 입력", "description": "여기에 PAT를 직접 입력합니다"},
    {"label": "나중에 설정", "description": "SCM 연동 없이 진행하고, 나중에 .lingo/config.json에 토큰을 추가합니다"},
    {"label": "환경변수명 지정", "description": "사용할 환경변수명을 알려주시면 config에 참조로 저장합니다"}
  ]
}
```

**Question 2 — PM Adapter Selection (if any PM adapters available):**

Build options from the PM adapters returned by `list_adapters`:

```json
{
  "question": "기획 도구(PM)를 연동할까요? (기획 아이템 연동용)",
  "header": "PM 연동",
  "options": [
    // One option per PM adapter from list_adapters
    // e.g. {"label": "Notion", "description": "Notion 워크스페이스와 연동합니다"},
    // e.g. {"label": "JSON File", "description": "로컬 JSON 파일에서 기획 아이템을 읽습니다"},
    {"label": "건너뛰기", "description": "PM 연동 없이 진행합니다"}
  ]
}
```

If the user selects a PM adapter that requires a token (e.g., Notion), ask for the token using AskUserQuestion:
```json
{
  "question": "<displayName> 토큰을 어떻게 설정할까요?",
  "header": "<displayName> Token",
  "options": [
    {"label": "직접 입력", "description": "여기에 API Token을 직접 입력합니다"},
    {"label": "나중에 설정", "description": "PM 연동 없이 진행하고, 나중에 .lingo/config.json에 토큰을 추가합니다"},
    {"label": "환경변수명 지정", "description": "사용할 환경변수명을 알려주시면 config에 참조로 저장합니다"}
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

### Step 4: Save Configuration

Write `<repoPath>/.lingo/config.json` using the Write tool (create the `.lingo/` directory if needed). Include only the adapters the user selected:

```json
{
  "scm": {
    "adapter": "<selected-scm-adapter-name or null>",
    "token": "<user-provided or empty>",
    "defaultRepo": "owner/repo"
  },
  "pm": {
    "adapter": "<selected-pm-adapter-name or null>",
    "token": "<user-provided or empty>",
    "config": {}
  },
  "repoPath": "<target-repo-path>"
}
```

Also set environment variables for the current session if tokens were provided:
- `LINGO_GITHUB_TOKEN` for GitHub SCM adapter
- Adapter-specific tokens as needed (e.g., Notion token in adapter config)

### Step 4.5: Update MCP Glossary Path

The MCP server stores the glossary at the path specified by `LINGO_GLOSSARY_PATH` in `.mcp.json`. This must point to the target repo, not the lingo project directory.

1. Read the project's `.mcp.json` file
2. Update `LINGO_GLOSSARY_PATH` to `<repoPath>/.lingo/glossary.json` (use the absolute path from Step 3)
3. Write the updated `.mcp.json` using Edit

Example — if the user selected `/home/user/my-project`:
```json
{
  "mcpServers": {
    "lingo": {
      "env": {
        "LINGO_GLOSSARY_PATH": "/home/user/my-project/.lingo/glossary.json"
      }
    }
  }
}
```

4. Inform the user: "`.mcp.json`이 업데이트되었습니다. MCP 서버 재연결을 위해 Claude Code를 재시작해주세요."

**Note:** If `repoPath` is the current working directory (same as cwd in `.mcp.json`), the relative path `.lingo/glossary.json` is sufficient and no update is needed.

### Step 5: Verify Connection

If an SCM token was provided, verify it works. For GitHub:
```bash
curl -s -H "Authorization: Bearer <token>" https://api.github.com/user | head -5
```

### Step 6: Suggest Next Steps

```
Setup complete!

📍 Next steps:
  /lingo:bootstrap — 코드베이스를 스캔하여 초기 글로서리를 생성합니다
  /lingo:learn <PR-URL> — PR에서 기획 용어를 학습합니다
```

### Edge Cases

- **No adapters available:** If `list_adapters` returns an empty list, inform the user that no adapters are registered and suggest running with default settings.
- **list_adapters fails:** Fall back to asking about GitHub (SCM) and Notion (PM) as defaults — these are the built-in adapters.
- **New adapter added at runtime:** Since `list_adapters` is called each time `/lingo:setup` runs, newly registered adapters will appear automatically without any SKILL.md changes.
