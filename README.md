# AdiVox

A speaker-aware audio transcription app with a FastAPI backend, Gemini 2.5 Flash, and a Vite + React frontend.

Generated transcripts can be saved to the local SQLite library at `data/adivox.db`. Database files are excluded from Git.

## Setup

1. Copy `.env.example` to `.env` and set `GEMINI_API_KEY`.
2. Install backend dependencies with `uv sync`.
3. Install frontend dependencies with `npm install` inside `frontend`.

## Development

Run the API:

```powershell
uv run uvicorn main:app --reload
```

In another terminal, run the frontend:

```powershell
cd frontend
npm run dev
```

Open `http://localhost:5173`.

## Production-style local run

Build the frontend, then serve the entire app from FastAPI:

```powershell
cd frontend
npm run build
cd ..
uv run uvicorn main:app
```

Open `http://localhost:8000`.
