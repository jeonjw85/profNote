# profNote

[![CI](https://github.com/jeonjw85/profNote/actions/workflows/ci.yml/badge.svg)](https://github.com/jeonjw85/profNote/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/jeonjw85/profNote)](https://github.com/jeonjw85/profNote/releases/latest)

<a href="README.md"><strong>English</strong></a>
&nbsp;·&nbsp;
<a href="README.ko.md">한국어</a>

A desktop app that turns lecture recordings into Markdown notes with speaker diarization, local STT, and LLM summaries.

## Getting Started

```bash
brew install --cask jeonjw85/tap/profnote
```

Or download an installer from [Releases](https://github.com/jeonjw85/profNote/releases/latest).

Open the app, grant microphone access, then download FFmpeg and a Whisper model from the bottom bar to start recording.

> On macOS, if you see `"Unidentified Developer"`, see [Opening on macOS](#opening-on-macos).

## Features

- Record from the mic, or drop in an existing audio file
- Diarize speakers and transcribe only the professor (auto-pick, can change)
- Local speech recognition, LLM summary, edit transcript/summary, save `.md`
- Click a timestamp to play, search notes, regenerate a summary
- Korean/English UI, summary language option

## Settings

Turn summary, transcription language, and diarization on or off in Settings. Summaries use an OpenAI-compatible API.

Diarization is optional. Install the engine in Settings, accept the [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) terms, and add a HuggingFace token. Without the engine, transcription still runs.

Recordings, models, and notes live in `~/Library/Application Support/kr.jjw.profNote/`. Transcription stays local. Only the transcript text is sent to the LLM API when summarizing.

## Opening on macOS

This app is ad-hoc signed. If macOS shows `"Unidentified Developer"`, go to **System Settings → Privacy & Security** and click **Open Anyway**.

If you see `"profNote.app is damaged and can't be opened"`, run this once:

```bash
xattr -cr /Applications/profNote.app
```

## Development

Tauri v2, React 19, whisper-rs, pyannote, SQLite.

- macOS, Rust stable, Xcode Command Line Tools, Node.js 20+

```bash
npm install
npm run tauri dev
npm run tauri build
```

Build output: `src-tauri/target/release/bundle/`

```bash
npm run typecheck
npm run lint
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
```
