# profNote

[![CI](https://github.com/jeonjw85/profNote/actions/workflows/ci.yml/badge.svg)](https://github.com/jeonjw85/profNote/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/jeonjw85/profNote)](https://github.com/jeonjw85/profNote/releases/latest)

<a href="README.md"><strong>English</strong></a>
&nbsp;·&nbsp;
<a href="README.ko.md">한국어</a>

강의 음성을 녹음하면 화자 분리, 로컬 음성 인식(STT), LLM 요약을 거쳐 MD 강의 노트로 정리해 주는 데스크탑 앱

## 기능

- 마이크 녹음
- 화자 분리(pyannote) 후 교수님 발화만 선택해 전사 - 자동 추천 + 수동 정정
- 로컬 전사: whisper.cpp (`medium` / `large-v3` / `large-v3-turbo`, 앱 내에서 모델 다운로드, macOS Metal 가속)
- LLM 요약: OpenAI 호환 API(스트리밍, 자동 재시도), 표 포함 Markdown 출력
- 원문 타임스탬프 클릭 시 해당 지점부터 오디오 재생 (미니 플레이어 내장)
- 노트 검색: 제목, 전문, 요약 통합 검색
- 오디오 파일 가져오기: 기존 강의 음성(mp3, m4a, wav 등)을 드래그앤드롭으로 같은 파이프라인 처리
- 요약 재생성: 화자 변경 등으로 비워진 요약을 다시 생성
- 한국어/영어 UI 전환, 요약 언어 선택(자동/한국어/English)
- 원문/요약 탭 전환, Markdown 미리보기, `.md` 파일 저장

## 기술 스택

| 영역         | 기술                                  |
| ------------ | ------------------------------------- |
| 데스크탑     | Tauri v2 (Rust)                       |
| 프론트엔드   | React 19 + TypeScript, CSS Modules    |
| 오디오 캡처  | cpal                                  |
| 오디오 변환  | FFmpeg                                |
| 전사         | whisper-rs (whisper.cpp, macOS Metal) |
| 화자 분리    | pyannote.audio                        |
| 데이터베이스 | SQLite (tauri-plugin-sql)             |

## 요구 사항

- macOS (마이크 권한 필요)
- [Rust](https://rustup.rs) stable 툴체인 + Xcode Command Line Tools
- Node.js 20+
- FFmpeg: `brew install ffmpeg`
- (선택) 화자 분리용 Python 3.10+ 가상환경
- (선택) LLM API 키

## 시작하기

```bash
npm install
npm run tauri dev
```

첫 실행 시 마이크 권한을 허용 후 좌측 하단에서 Whisper 모델을 다운로드한 뒤 녹음 시작

### 화자 분리 설정 (선택)

릴리즈 앱은 Python을 따로 설치할 필요가 없습니다. 설정에서 **화자 분리 엔진 설치**를 누르면 런타임과 pyannote를 앱 데이터 디렉터리에 받습니다. 최초 설치는 torch 때문에 수 분~수십 분, 수 GB가 필요할 수 있습니다.

추가로 HuggingFace 토큰이 필요합니다. [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) 사용 조건에 먼저 동의하세요.

화자 분리가 켜져 있고 엔진, 토큰이 준비되면, 가장 오래 말한 화자를 교수님으로 자동 추천하고 에디터 상단에서 다른 화자로 바꿀 수 있습니다. 엔진이 없으면 전사는 그대로 진행하고 화자 분리만 건너뜁니다.

### 설정 요약

| 항목                           | 설명                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| AI 요약 사용                   | LLM 요약 단계 on/off                                                                     |
| LLM API 키 / Base URL / 모델명 | OpenAI 호환 API, Base URL과 모델명은 비워두면 각각 `https://api.openai.com/v1`, `gpt-4o` |
| Whisper 모델 / 전사 언어       | `medium` / `large-v3` / `large-v3-turbo`, 언어는 `ko`/`en`/`auto`                        |
| 화자 분리 사용                 | 화자 분리 단계 on/off                                                                    |
| 요약 언어                      | 요약 출력 언어 - 자동(전사 언어 따름) / 한국어 / English                                 |
| UI 언어                        | 인터페이스 언어 - 한국어 / English                                                       |

## 빌드

```bash
npm run tauri build
```

경로 : `src-tauri/target/release/bundle/`에 생성됩니다

## 검증

```bash
npm run typecheck
npm run lint
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
```

## 데이터 저장 위치

녹음, 모델, 노트, SQLite DB는 앱 데이터 디렉터리(`~/Library/Application Support/kr.jjw.profNote/`)에 저장됩니다.  
전사는 로컬에서만 수행되며, 요약 시 전사 텍스트만 설정된 LLM API로 전송됩니다.

## 릴리즈 macOS에서 열기 (ad-hoc 서명 앱)

이 앱은 Apple Developer ID가 아닌 **ad-hoc 서명**되어 있습니다.  
브라우저로 받은 설치 파일을 처음 열면 Developer ID 서명이 아니라는 이유로 `"확인되지 않은 개발자"` 안내가 뜹니다. 실제 손상이 아니니 아래 중 하나로 열면 됩니다.

- **시스템 설정 → 개인정보 보호 및 보안** → 하단의 **"그래도 열기"** 클릭

확인 대화상자에서 열기를 확정하면 이후부터는 정상적으로 열립니다.

> 혹시 `"손상되었기 때문에 열 수 없습니다"`라는 메시지가 뜬다면 터미널에서 아래 명령을 1회 실행하세요.
>
> ```bash
> xattr -cr /Applications/profNote.app
> ```
