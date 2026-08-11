# profNote

강의 음성을 녹음하면 화자 분리, 로컬 음성 인식(STT), LLM 요약을 거쳐 MD 강의 노트로 정리해 주는 데스크탑 앱

## 기능

- 마이크 녹음
- 화자 분리(pyannote) 후 교수님 발화만 선택해 전사 — 자동 추천 + 수동 정정
- 로컬 전사: whisper.cpp (`medium` / `large-v3`, 앱 내에서 모델 다운로드)
- LLM 요약: OpenAI 호환 API(스트리밍, 자동 재시도), 표 포함 Markdown 출력
- 원문/요약 탭 전환, Markdown 미리보기, `.md` 파일 저장

## 기술 스택

| 영역         | 기술                               |
| ------------ | ---------------------------------- |
| 데스크탑     | Tauri v2 (Rust)                    |
| 프론트엔드   | React 19 + TypeScript, CSS Modules |
| 오디오 캡처  | cpal                               |
| 오디오 변환  | FFmpeg                             |
| 전사         | whisper-rs (whisper.cpp 바인딩)    |
| 화자 분리    | pyannote.audio                     |
| 데이터베이스 | SQLite (tauri-plugin-sql)          |

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

```bash
python3 -m venv .venv-diarize
.venv-diarize/bin/pip install pyannote.audio
```

설정에서 다음 값을 입력합니다:

- Python 실행 파일: `.venv-diarize/bin/python` (절대 경로)
- 다이어라이제이션 스크립트: `scripts/diarize.py`
- HuggingFace 토큰: [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) 모델 사용 조건에 먼저 동의해야 합니다

화자 분리가 켜져 있으면 가장 오래 말한 화자를 교수님으로 자동 추천하고, 에디터 상단에서 다른 화자로 바꿀 수 있습니다.

### 설정 요약

| 항목                           | 설명                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| AI 요약 사용                   | LLM 요약 단계 on/off                                                                     |
| LLM API 키 / Base URL / 모델명 | OpenAI 호환 API, Base URL과 모델명은 비워두면 각각 `https://api.openai.com/v1`, `gpt-4o` |
| Whisper 모델 / 전사 언어       | `medium` 또는 `large-v3`, 언어는 `ko`/`en`/`auto`                                        |
| 화자 분리 사용                 | 화자 분리 단계 on/off                                                                    |

## 빌드

```bash
npm run tauri build
```

경로 : `src-tauri/target/release/bundle/`에 생성됩니다

Windows 버전은 macOS에서 빌드할 수 없습니다. `tauri.conf.json`의 `version`과 같은 버전 태그(예: `v0.1.0`)를 push하면 GitHub Actions가 Windows 설치 파일을 빌드해 Release 초안으로 첨부합니다.

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
