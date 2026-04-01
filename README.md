# Lingo

> 조직의 언어를 AI에게 가르치는 MCP 서버

기획팀의 용어가 코드베이스 어디에 대응되는지를 매핑하고, AI 개발 도구(Claude Code, Cursor)가 조직 고유의 컨텍스트를 이해할 수 있게 해주는 MCP 서버입니다.

## 왜 필요한가

Cursor, Copilot 같은 AI 코딩 도구는 코드는 잘 읽지만, **"이 기획 용어가 코드 어디에 해당하는가"**는 모릅니다. Lingo는 조직의 기획 용어 ↔ 코드 위치 매핑을 축적하고, AI가 이를 조회할 수 있게 합니다.

## 주요 기능

| 기능 | 설명 |
|------|------|
| **Glossary CRUD** | 기획 용어 ↔ 코드 위치 매핑 생성/조회/수정/삭제 |
| **AI Bootstrap** | 코드베이스 스캔으로 초기 매핑 자동 생성 (Cold Start) |
| **Code Change Suggestions** | 기획 용어 변경 시 영향받는 코드 위치와 수정 제안 |
| **Reverse Flow** | 자연어 입력 → PM 도구 아이템 자동 생성 |
| **PM 도구 어댑터** | Notion 어댑터 내장, Linear/Jira 확장 가능 |
| **문서 스캔** | 마크다운 문서에서 도메인 용어 자동 추출 |
| **SCM 어댑터** | GitHub 등 SCM 도구 플러그인 방식 연동 |
| **Prompt 학습** | AI 도구 사용 시 용어 매핑 자동 강화 |

---

## 설치

### Claude Code (Plugin — MCP + Skills)

```bash
claude plugin add @hyukyyy/lingo-mcp-server
```

MCP 도구 + `/lingo:setup`, `/lingo:bootstrap` 등 slash command를 함께 사용할 수 있습니다.

### Claude Code (MCP only)

```bash
claude mcp add lingo -- npx @hyukyyy/lingo-mcp-server
```

MCP 도구만 연결합니다. Skills(슬래시 커맨드)는 포함되지 않습니다.

### Cursor

**Settings > MCP Servers > Add Server** 에서:
- Name: `lingo`
- Command: `npx @hyukyyy/lingo-mcp-server`

### 환경변수 (선택)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `LINGO_GLOSSARY_PATH` | `.lingo/glossary.json` | 글로서리 파일 경로 |
| `LINGO_ORG` | `default` | 조직 이름 |
| `LINGO_LOG_LEVEL` | `info` | 로그 레벨 |

> 개발자용 상세 설정(직접 빌드, 경로 지정, Claude Desktop 등)은 `docs/03-개발자-가이드.md` 참조

---

## MCP Tools

### 글로서리 관리

| Tool | 설명 | 주요 파라미터 |
|------|------|--------------|
| `add_term` | 새 용어 추가 | `name`, `definition`, `codeLocations[]` |
| `get_term` | 용어 조회 | `id` 또는 `name` |
| `update_term` | 용어 수정 | `id`, 수정할 필드 |
| `remove_term` | 용어 삭제 | `id` |
| `list_terms` | 전체 목록 | `category?`, `tag?`, `confidence?` |

### 검색 & 분석

| Tool | 설명 | 주요 파라미터 |
|------|------|--------------|
| `query_context` | 용어 검색 + 관련 코드 위치 반환 | `query`, `category?`, `limit?` |
| `find_by_file` | 파일과 연관된 용어 조회 | `filePath` |
| `suggest_code_changes` | 용어 변경의 코드 영향도 분석 | `termId`, `changeType`, `description` |

### 자동화

| Tool | 설명 | 주요 파라미터 |
|------|------|--------------|
| `bootstrap` | 코드베이스 스캔 → 초기 매핑 생성 | `rootDir`, `adapterName?`, `dryRun?` |
| `create_from_text` | 자연어 → PM 아이템 생성 | `text`, `defaultItemType?`, `adapterName?` |
| `learn_from_pr` | PR에서 기획 용어 학습 | `prUrl`, `githubToken?` |
| `record_signal` | 용어 커플링 신호 기록 | `termId`, `signalType` |
| `list_adapters` | 등록된 PM/SCM 어댑터 목록 | (없음) |

---

## Skills (Plugin 설치 시)

Plugin으로 설치하면 아래 slash command를 사용할 수 있습니다:

| Skill | 설명 |
|-------|------|
| `/lingo:setup` | 토큰 설정 및 어댑터 초기화 |
| `/lingo:bootstrap` | 코드베이스 스캔 → 글로서리 생성 |
| `/lingo:learn` | PR에서 기획 용어 학습 |
| `/lingo:search` | 용어 검색 |
| `/lingo:impact` | 용어 변경 영향도 분석 |
| `/lingo:create-items` | 자연어 → PM 아이템 생성 |

---

## 사용 예시

### 1. 초기 설정 (Cold Start)

```
Tool: bootstrap
Input: { "rootDir": ".", "dryRun": true }
```

코드베이스를 스캔하여 기획 용어 ↔ 코드 매핑을 자동 생성합니다. `dryRun: true`로 먼저 결과를 미리보기할 수 있습니다.

### 2. 용어 검색

```
Tool: query_context
Input: { "query": "결제 모듈" }
```

"결제 모듈"과 매칭되는 글로서리 용어와 관련 코드 위치를 반환합니다.

### 3. 코드 변경 영향도 분석

```
Tool: suggest_code_changes
Input: { "termId": "uuid-here", "changeType": "rename", "description": "결제 → 빌링으로 변경" }
```

용어 변경 시 영향받는 코드 파일과 수정 제안을 생성합니다.

### 4. 기획 아이템 생성 (Reverse Flow)

```
Tool: create_from_text
Input: { "text": "사용자 로그인 시 2단계 인증 추가", "defaultItemType": "story" }
```

자연어 텍스트를 파싱하여 구조화된 PM 아이템으로 변환합니다.

---

## 라이선스

MIT
