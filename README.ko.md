# Yonote (메모)

[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md) | 한국어

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg" /></a>
  <img alt="Go 1.25" src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" />
  <img alt="Tauri 2" src="https://img.shields.io/badge/Windows-Tauri%202-FFC131?logo=tauri&logoColor=black" />
  <img alt="Capacitor 8" src="https://img.shields.io/badge/Android-Capacitor%208-3DDC84?logo=android&logoColor=white" />
  <a href="https://github.com/Yomihay-qut/yonote/releases"><img alt="Releases" src="https://img.shields.io/github/v/release/Yomihay-qut/yonote" /></a>
</p>

**셀프 호스팅 · 오프라인 우선** 크로스 플랫폼 메모 및 할 일 앱입니다(시스템·브라우저 언어를 자동 인식하며 중국어 간체 / English / 日本語 / 한국어 지원). Android, Windows 데스크톱, Web / PWA가 동일한 React 클라이언트를 공유하며, 서버는 CGO 없는 단일 바이너리 Go + SQLite(웹 UI 내장)와 세분화된 권한을 갖춘 **AI API 및 Streamable HTTP MCP**를 기본 제공합니다.

---

## 클라이언트 다운로드 (설치 후 바로 사용)

[Releases](https://github.com/Yomihay-qut/yonote/releases/latest)에서 OS에 맞는 클라이언트를 받으세요. **서버 없이도 기기 단독으로 오프라인 사용이 가능**하며, 여러 기기 간 동기화가 필요할 때만 **설정 → 계정 및 동기화**에 서버 주소를 입력하면 됩니다:

| 플랫폼 | 패키지 | 설명 |
| --- | --- | --- |
| **Android 스마트폰 / 태블릿** | `yonote-android-v*.apk` | 정식 서명된 릴리스 APK (Android 7.0+ 지원, 덮어쓰기 업데이트 가능) |
| **Windows 데스크톱 (설치형)** | `yonote-windows-setup-v*.exe` | Tauri v2 네이티브 데스크톱 창(WebView2), 다국어 설치 마법사 |
| **Windows 데스크톱 (포터블)** | `yonote-windows-portable-v*.exe` | 설치 없이 더블 클릭으로 바로 실행되는 단일 실행 파일 |
| **웹 / PWA** | 서버 도메인으로 직접 접속 | Go 단일 바이너리에서 직접 제공, Chrome/Edge에서 PWA 앱 설치 가능 |

---

## 서버 셀프 호스팅 (Docker 또는 Linux 단일 바이너리)

### 방법 1: Docker Compose (권장)

```bash
git clone https://github.com/Yomihay-qut/yonote.git
cd yonote
# 필요에 따라 docker-compose.yml의 YONOTE_PASSWORD(12자 이상)와 YONOTE_ORIGIN 수정
docker compose up -d
```

### 방법 2: Linux 단일 바이너리

[Releases](https://github.com/Yomihay-qut/yonote/releases/latest)에서 `yonote-server-linux-amd64-v*.tar.gz`(또는 `arm64`)를 다운로드하세요. 웹 프론트엔드는 `yonote` 단일 바이너리 안에 내장되어 있습니다:

```bash
sudo tar -xzf yonote-server-linux-amd64-v1.0.0.tar.gz -C /opt/yonote
/opt/yonote/yonote -addr 127.0.0.1:8787 -data /var/lib/yonote
```

> **웹 최초 초기 설정**: `YONOTE_ADMIN` / `YONOTE_PASSWORD` 환경 변수를 미리 지정하지 않고도 서버를 시작할 수 있습니다. 웹이나 클라이언트의 **설정 → 계정 및 동기화**에 서버 주소를 입력하면 **첫 번째 관리자 계정을 바로 생성**할 수 있습니다. 운영 환경용 systemd + Nginx HTTPS 구성은 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)를 참고하세요.

---

## 핵심 기능

- **다국어 및 시스템 언어 자동 추적**: 중국어 간체, English, 日本語, 한국어를 기본 내장하여 시스템·브라우저 언어를 자동으로 따르며, **설정 → 화면**에서 언제든 전환할 수 있습니다.
- **오프라인 우선 & 해시 기반 증분 동기화**: 모든 읽기·쓰기가 로컬 IndexedDB(Dexie)에 먼저 저장되어 오프라인에서도 자유롭게 작성할 수 있습니다. 온라인 복귀 시 SHA-256 콘텐츠 해시 기반 증분 프로토콜로 변경분만 동기화하며 첨부 파일도 중복 제거 전송을 지원합니다.
- **시맨틱 라이트/다크 테마 & 용지 시스템**: 배경 용지, 글자 색, 형광펜 강조 색상을 시맨틱 토큰으로 저장하여 다크/라이트 모드, 공개 공유 페이지, 인쇄/내보내기 환경에서 자동으로 고대비 색상을 유지합니다. 외부 서식 붙여넣기 시 불필요한 색상 스타일을 자동 정화합니다.
- **벡터 PDF 및 다양한 내보내기**: Web/Windows(숨김 `iframe` 인쇄)와 Android(시스템 `PrintManager`)에서 모두 텍스트 선택·검색·자동 페이지 나누기가 가능한 벡터 PDF를 출력하며, 긴 PNG 이미지 및 Markdown 내보내기도 지원합니다.
- **버전 기록 & 단어 단위 Diff 비교**: 서버에 편집 스냅샷이 자동 기록되며 데스크톱 2단 분할 및 모바일 상하 비교 뷰에서 단어 단위 차이를 확인하고 원클릭 복원할 수 있습니다.
- **네이티브 AI / MCP 통합**: 설정에서 세분화된 권한(`read` / `write` / `todo` + 지정 폴더 제한)을 가진 Bearer API 키를 발급해 Cherry Studio, Claude, Codex, RikkaHub 등 MCP 클라이언트(`/mcp`)에 바로 연결할 수 있습니다.

---

## 로컬 개발

필요 환경: **Node.js 22+**, **Go 1.25+** (Android 빌드는 JDK 21 + Android SDK 36, Windows 데스크톱 빌드는 Rust stable + MSVC 필요).

```bash
# 1. 프론트엔드 개발 서버 실행 (http://127.0.0.1:5178, /api를 8788로 프록시)
cd web
npm ci
npm run dev

# 2. 다른 터미널에서 Go 백엔드 실행
cd server
go run . -addr 127.0.0.1:8788 -data ../data/dev
```

전체 테스트 및 프로덕션 빌드:

```bash
# 프론트엔드 단위 테스트 및 빌드
cd web && npm test && npm run build

# 백엔드 정적 검사 및 단위 테스트
cd server && go vet ./... && go test -count=1 ./...
```

---

## 프로젝트 구조

```text
.
├── web/                  # React 19 + TipTap 3 + PWA + Capacitor Android 클라이언트
├── desktop/              # Tauri v2 Windows 데스크톱 래퍼
├── server/               # Go 1.25 단일 바이너리 백엔드 (웹 UI 내장 + SQLite + MCP/Agent API)
├── deploy/               # systemd, Nginx 리버스 프록시, 정기 백업 스크립트 템플릿
├── docs/                 # 아키텍처 및 셀프 호스팅 배포 가이드
├── Dockerfile            # 멀티 스테이지 Docker 빌드
└── docker-compose.yml    # 원클릭 셀프 호스팅 Compose 예시
```

## 문서 및 라이선스

- [아키텍처 설계](docs/ARCHITECTURE.md) · [배포 및 운영 가이드](docs/DEPLOYMENT.md) · [변경 이력](CHANGELOG.md) · [기여 가이드](CONTRIBUTING.md) · [보안 정책](SECURITY.md)
- [MIT License](LICENSE) 기반 오픈 소스
