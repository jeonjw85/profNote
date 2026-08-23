# profNote

[![CI](https://github.com/jeonjw85/profNote/actions/workflows/ci.yml/badge.svg)](https://github.com/jeonjw85/profNote/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/jeonjw85/profNote)](https://github.com/jeonjw85/profNote/releases/latest)

<a href="README.md"><strong>English</strong></a>
&nbsp;·&nbsp;
<a href="README.ko.md">한국어</a>

A desktop app that turns lecture recordings into Markdown lecture notes through speaker diarization, local speech recognition (STT), and LLM summarization.

## Features

- Microphone recording
- Speaker diarization (pyannote) to transcribe only the professor's speech - automatic suggestion + manual correction
- Local transcription: whisper.cpp (`medium` / `large-v3` / `large-v3-turbo`, in-app model download, macOS Metal acceleration)
- LLM summarization: OpenAI-compatible API (streaming, automatic retry) with Markdown output including tables
- Click a transcript timestamp to play the recording from that point (built-in mini player)
- Note search across titles, transcripts, and summaries
- Audio import: drag and drop existing lecture recordings (mp3, m4a, wav, ...) into the same pipeline
- Summary regeneration for notes whose summary was cleared (e.g. after changing the professor speaker)
- Korean/English UI with a summary language option (auto / Korean / English)
- Transcript/summary tabs, Markdown preview, `.md` file export

## Tech Stack

| Area          | Technology                            |
| ------------- | ------------------------------------- |
| Desktop       | Tauri v2 (Rust)                       |
| Frontend      | React 19 + TypeScript, CSS Modules    |
| Audio capture | cpal                                  |
| Audio convert | FFmpeg                                |
| Transcription | whisper-rs (whisper.cpp, macOS Metal) |
| Diarization   | pyannote.audio                        |
| Database      | SQLite (tauri-plugin-sql)             |

## Getting Started

Two lines in Terminal and you are done.

```bash
brew install --cask jeonjw85/tap/profnote
brew install ffmpeg
```

Open the app, grant microphone permission, download a Whisper model from the bottom-left panel, then start recording.

> If you see an `"Unidentified Developer"` warning on first open, see the **Opening the Release on macOS** section below.

### Diarization Setup (Optional)

The release app does not require a separate Python installation. Click **Install diarization engine** in Settings to download the runtime and pyannote into the app data directory. The first install may take several minutes to tens of minutes and several GB due to torch.

You also need a HuggingFace token. Accept the usage terms of [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) first.

When diarization is enabled and the engine and token are ready, the speaker who talked the longest is automatically suggested as the professor, and you can switch to another speaker from the editor header. Without the engine, transcription proceeds as usual and only diarization is skipped.

### Settings Overview

| Setting                        | Description                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| AI summary                     | Toggles the LLM summarization stage                                                          |
| LLM API key / Base URL / model | OpenAI-compatible API. Empty Base URL/model default to `https://api.openai.com/v1`, `gpt-4o` |
| Whisper model / language       | `medium` / `large-v3` / `large-v3-turbo`, language `ko`/`en`/`auto`                          |
| Speaker diarization            | Toggles the diarization stage                                                                |
| Summary language               | Output language of summaries: Auto (match transcript) / Korean / English                     |
| UI language                    | Interface language: Korean / English                                                         |

## Data Storage Location

Recordings, models, notes, and the SQLite database are stored in the app data directory (`~/Library/Application Support/kr.jjw.profNote/`).  
Transcription runs entirely locally; only the transcript text is sent to the configured LLM API during summarization.

## Opening the Release on macOS (ad-hoc Signed App)

This app is **ad-hoc signed**, not signed with an Apple Developer ID.  
The first time you open an installer downloaded via browser, macOS reports an `"Unidentified Developer"` warning because of the missing Developer ID signature. This does not mean the app is damaged - open it using one of the methods below.

- **System Settings → Privacy & Security** → click **"Open Anyway"** at the bottom

Once confirmed in the dialog, the app opens normally afterwards.

> If you see `"profNote.app is damaged and can't be opened"`, run the following command once in Terminal.
>
> ```bash
> xattr -cr /Applications/profNote.app
> ```

## Development

### Requirements

- macOS (microphone permission required)
- [Rust](https://rustup.rs) stable toolchain + Xcode Command Line Tools
- Node.js 20+
- FFmpeg: `brew install ffmpeg`

### Run

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

Output: `src-tauri/target/release/bundle/`

### Verification

```bash
npm run typecheck
npm run lint
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
```
