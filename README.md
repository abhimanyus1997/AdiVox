<div align="center">

# AdiVox

### Every voice, made clear.

Speaker-aware audio transcription powered by Gemini 2.5 Flash, FastAPI, and React.

[![Live Demo](https://img.shields.io/badge/Live_Demo-abhimanyu.fyi%2Fadivox-6c4ee3?style=for-the-badge)](https://abhimanyu.fyi/adivox)
[![CI/CD](https://github.com/abhimanyus1997/AdiVox/actions/workflows/ci.yml/badge.svg?branch=codex%2Fvercel-byok)](https://github.com/abhimanyus1997/AdiVox/actions/workflows/ci.yml)
[![Gemini](https://img.shields.io/badge/Gemini-2.5_Flash-4285F4?style=flat-square&logo=google)](https://ai.google.dev/gemini-api/docs)
[![FastAPI](https://img.shields.io/badge/FastAPI-Backend-009688?style=flat-square&logo=fastapi)](https://fastapi.tiangolo.com/)
[![React](https://img.shields.io/badge/React-Vite-61DAFB?style=flat-square&logo=react&logoColor=111)](https://vite.dev/)

[Open AdiVox](https://abhimanyu.fyi/adivox) · [Create a Gemini API key](https://aistudio.google.com/api-keys) · [Report an issue](https://github.com/abhimanyus1997/AdiVox/issues)

</div>

## Overview

AdiVox turns uploaded or browser-recorded audio into a searchable transcript with speaker labels and precise timestamps. It supports conversations with one, two, or many speakers and presents every speaker turn on an interactive playback timeline.

The hosted application uses a bring-your-own-key model. Your Gemini API key remains in the current browser tab's memory, is sent only with transcription requests, and is never saved by AdiVox.

## Features

- Multi-speaker diarization with no fixed speaker limit
- Audio upload and in-browser microphone recording
- Timestamped speaker turns and an interactive playback timeline
- Full-text search across speakers and dialogue
- Export to plain text, SRT subtitles, or structured JSON
- Save and reopen generated transcripts
- Gemini token utilization and estimated cost breakdown
- Responsive interface for desktop and mobile
- Runtime API-key prompt when no server-side key is configured

## Try it

Visit **[abhimanyu.fyi/adivox](https://abhimanyu.fyi/adivox)**.

1. Create a key in [Google AI Studio](https://aistudio.google.com/api-keys).
2. Paste the key into AdiVox. It is retained only for the current browser tab.
3. Upload a recording or record directly from your microphone.
4. Generate, search, review, save, and export the transcript.

Supported formats include MP3, WAV, M4A, AAC, OGG, WebM, FLAC, and AIFF. The hosted upload limit is 95 MB; local development supports files up to 200 MB.

## Architecture

```text
Browser (Vite + React)
  ├── upload or microphone recording
  ├── BYOK Gemini key held in tab memory
  └── transcript player, search, export, usage and cost
                │
                ▼
FastAPI
  ├── validates audio and API keys
  ├── requests structured transcription from Gemini 2.5 Flash
  ├── normalizes diarized segments and token usage
  └── stores and retrieves saved transcripts
                │
                ├── SQLite for local development
                └── PostgreSQL when DATABASE_URL is configured
```

| Layer | Technology |
| --- | --- |
| Frontend | React, TypeScript, Vite, Lucide React |
| Backend | FastAPI, Pydantic, Uvicorn |
| AI | Google Gemini 2.5 Flash via `google-genai` |
| Storage | SQLite locally; PostgreSQL-compatible production support |
| Hosting | Vercel with `/adivox` routing through `abhimanyu.fyi` |
| Automation | GitHub Actions for API tests, frontend builds, and gated deployments |

## Privacy and BYOK

AdiVox is designed so the public deployment does not need a shared Gemini key:

- The key entered in the UI stays in React component memory.
- It is not written to local storage, session storage, SQLite, PostgreSQL, logs, or source control.
- The backend validates the key without retaining it and receives it again for each transcription request.
- Refreshing or closing the tab clears the key.
- Temporary audio is removed after transcription, and the Gemini file upload is deleted after processing.

For a private deployment, `GEMINI_API_KEY` can be configured on the server instead.

## Local development

### Prerequisites

- Python 3.11 or newer
- [uv](https://docs.astral.sh/uv/)
- Node.js 22 or newer
- A [Gemini API key](https://aistudio.google.com/api-keys), optional at startup because the UI can request one

### Install

```powershell
git clone https://github.com/abhimanyus1997/AdiVox.git
cd AdiVox

Copy-Item .env.example .env
uv sync
npm ci --prefix frontend
```

Add your key to `.env` if you want server-side configuration:

```dotenv
GEMINI_API_KEY=your_gemini_api_key_here
```

### Run

Start the API:

```powershell
uv run uvicorn main:app --reload
```

In a second terminal, start Vite:

```powershell
npm run dev --prefix frontend
```

Open [http://localhost:5173](http://localhost:5173).

### Production-style local run

```powershell
npm run build --prefix frontend
uv run uvicorn main:app
```

Open [http://localhost:8000](http://localhost:8000).

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | No | Server-side Gemini key. When omitted, AdiVox enables BYOK in the browser. |
| `GOOGLE_API_KEY` | No | Alternative name accepted for the server-side Gemini key. |
| `ADIVOX_DB_PATH` | No | SQLite path; defaults to `data/adivox.db` locally. |
| `DATABASE_URL` | No | PostgreSQL connection string for durable hosted transcript storage. |

Never commit `.env`, `.env.local`, database files, or deployment credentials. They are excluded by the repository and Vercel ignore rules.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Configuration, storage, and upload-limit status |
| `POST` | `/api/configure-key` | Validate a browser-provided Gemini key without storing it |
| `POST` | `/api/transcribe` | Generate a diarized transcript from audio |
| `GET` | `/api/transcripts` | List saved transcripts |
| `POST` | `/api/transcripts` | Save a transcript |
| `GET` | `/api/transcripts/{id}` | Retrieve a saved transcript |

Interactive OpenAPI documentation is available at `/docs` when the FastAPI service is accessed directly.

## Quality checks

```powershell
uv run pytest
npm ci --prefix frontend
npm run build --prefix frontend
```

GitHub Actions runs the backend tests and frontend production build on every push and pull request. Vercel deployment jobs are included and can be enabled after dedicated deployment credentials are configured in GitHub Actions.

## Project structure

```text
AdiVox/
├── .github/workflows/ci.yml   # CI/CD pipeline
├── frontend/                  # React and Vite application
├── tests/                     # FastAPI tests
├── main.py                    # FastAPI application and Gemini integration
├── pyproject.toml             # Python dependencies and test configuration
└── vercel.json                # Vercel services and routing
```

## Contributing

Issues and pull requests are welcome. Please run the quality checks before submitting a change and do not include API keys, audio recordings, local databases, or other sensitive files.
