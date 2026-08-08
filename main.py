from __future__ import annotations

import os
import mimetypes
import json
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

# Windows can map .js files to text/plain, which browsers reject for ES modules.
mimetypes.add_type("text/javascript", ".js")

ALLOWED_AUDIO_TYPES = {
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-wav",
    "audio/aiff",
    "audio/aac",
    "audio/ogg",
    "audio/webm",
    "audio/flac",
    "audio/mp4",
    "audio/x-m4a",
}
MAX_UPLOAD_MB = 95 if os.getenv("VERCEL") else 200
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
DEFAULT_DATABASE_PATH = Path("/tmp/adivox.db") if os.getenv("VERCEL") else ROOT / "data" / "adivox.db"
DATABASE_PATH = Path(os.getenv("ADIVOX_DB_PATH", DEFAULT_DATABASE_PATH))
DATABASE_URL = os.getenv("DATABASE_URL")


class TranscriptSegment(BaseModel):
    speaker: str = Field(description="A stable concise speaker label, e.g. Speaker 1")
    start_seconds: float = Field(ge=0, description="Segment start in seconds")
    end_seconds: float = Field(ge=0, description="Segment end in seconds")
    text: str = Field(min_length=1, description="Verbatim spoken words")


class TranscriptContent(BaseModel):
    title: str = Field(description="A short descriptive recording title")
    summary: str = Field(description="A concise 1-3 sentence summary")
    language: str = Field(description="Primary spoken language")
    duration_seconds: float = Field(ge=0, description="Approximate full audio duration")
    segments: list[TranscriptSegment]


class TokenUsage(BaseModel):
    input_tokens: int = 0
    audio_input_tokens: int = 0
    text_input_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0
    total_tokens: int = 0
    estimated_cost_usd: float = 0
    model: str = "gemini-2.5-flash"
    pricing_basis: str = "Standard paid tier: $1.00/M audio input, $0.30/M text input, $2.50/M output"


class ApiKeyRequest(BaseModel):
    api_key: str = Field(min_length=10, max_length=256)


class TranscriptResponse(TranscriptContent):
    usage: TokenUsage = Field(default_factory=TokenUsage)


class SavedTranscript(TranscriptResponse):
    id: int
    created_at: str


class SavedTranscriptSummary(BaseModel):
    id: int
    title: str
    summary: str
    language: str
    duration_seconds: float
    speaker_count: int
    created_at: str


def _database():
    if DATABASE_URL:
        from psycopg import connect
        from psycopg.rows import dict_row

        return connect(DATABASE_URL, row_factory=dict_row)
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def _init_database() -> None:
    if not DATABASE_URL:
        DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _database() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS transcripts (
                id {id_type},
                title TEXT NOT NULL,
                summary TEXT NOT NULL,
                language TEXT NOT NULL,
                duration_seconds REAL NOT NULL,
                speaker_count INTEGER NOT NULL,
                transcript_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """.format(id_type="BIGSERIAL PRIMARY KEY" if DATABASE_URL else "INTEGER PRIMARY KEY AUTOINCREMENT")
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_transcripts_created_at_id
            ON transcripts(created_at DESC, id DESC)
            """
        )
        if not DATABASE_URL:
            connection.execute("PRAGMA optimize")


_init_database()


app = FastAPI(title="AdiVox API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

@app.get("/health")
@app.get("/api/health")
@app.get("/adivox/api/health")
def health() -> dict[str, str | bool | int]:
    return {
        "status": "ok",
        "configured": bool(_api_key()),
        "max_upload_mb": MAX_UPLOAD_MB,
        "storage": "postgres" if DATABASE_URL else "sqlite",
    }


def _api_key() -> str | None:
    return os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")


@app.post("/configure-key")
@app.post("/api/configure-key")
@app.post("/adivox/api/configure-key")
def configure_api_key(payload: ApiKeyRequest) -> dict[str, str | bool]:
    candidate = payload.api_key.strip()
    try:
        client = genai.Client(api_key=candidate)
        client.models.get(model="gemini-2.5-flash")
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="That Gemini API key could not be validated. Check the key and try again.",
        ) from exc
    return {"configured": True, "storage": "browser-memory"}


def _normalise_mime(upload: UploadFile) -> str:
    content_type = (upload.content_type or "").lower()
    suffix = Path(upload.filename or "").suffix.lower()
    by_suffix = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".aiff": "audio/aiff",
        ".aif": "audio/aiff",
        ".aac": "audio/aac",
        ".ogg": "audio/ogg",
        ".webm": "audio/webm",
        ".flac": "audio/flac",
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
    }
    return by_suffix.get(suffix, content_type)


def _token_usage(response: object) -> TokenUsage:
    metadata = getattr(response, "usage_metadata", None)
    if metadata is None:
        return TokenUsage()

    input_tokens = int(getattr(metadata, "prompt_token_count", 0) or 0)
    candidates = int(getattr(metadata, "candidates_token_count", 0) or 0)
    thinking_tokens = int(getattr(metadata, "thoughts_token_count", 0) or 0)
    output_tokens = candidates + thinking_tokens
    total_tokens = int(getattr(metadata, "total_token_count", 0) or 0)
    audio_input_tokens = 0
    for detail in getattr(metadata, "prompt_tokens_details", None) or []:
        if "AUDIO" in str(getattr(detail, "modality", "")).upper():
            audio_input_tokens += int(getattr(detail, "token_count", 0) or 0)
    text_input_tokens = max(0, input_tokens - audio_input_tokens)
    estimated_cost = (
        audio_input_tokens * 1.00
        + text_input_tokens * 0.30
        + output_tokens * 2.50
    ) / 1_000_000
    return TokenUsage(
        input_tokens=input_tokens,
        audio_input_tokens=audio_input_tokens,
        text_input_tokens=text_input_tokens,
        output_tokens=output_tokens,
        thinking_tokens=thinking_tokens,
        total_tokens=total_tokens or input_tokens + output_tokens,
        estimated_cost_usd=round(estimated_cost, 8),
    )


@app.get("/transcripts", response_model=list[SavedTranscriptSummary])
@app.get("/api/transcripts", response_model=list[SavedTranscriptSummary])
@app.get("/adivox/api/transcripts", response_model=list[SavedTranscriptSummary])
def list_transcripts() -> list[SavedTranscriptSummary]:
    with _database() as connection:
        rows = connection.execute(
            """
            SELECT id, title, summary, language, duration_seconds,
                   speaker_count, created_at
            FROM transcripts
            ORDER BY created_at DESC, id DESC
            """
        ).fetchall()
    return [SavedTranscriptSummary.model_validate(dict(row)) for row in rows]


@app.post("/transcripts", response_model=SavedTranscript, status_code=201)
@app.post("/api/transcripts", response_model=SavedTranscript, status_code=201)
@app.post("/adivox/api/transcripts", response_model=SavedTranscript, status_code=201)
def save_transcript(transcript: TranscriptResponse) -> SavedTranscript:
    created_at = datetime.now(timezone.utc).isoformat()
    speaker_count = len({segment.speaker for segment in transcript.segments})
    with _database() as connection:
        query = """
            INSERT INTO transcripts (
                title, summary, language, duration_seconds, speaker_count,
                transcript_json, created_at
            ) VALUES ({placeholders})
            {returning}
            """.format(
                placeholders=", ".join(["%s" if DATABASE_URL else "?"] * 7),
                returning="RETURNING id" if DATABASE_URL else "",
            )
        cursor = connection.execute(
            query,
            (
                transcript.title,
                transcript.summary,
                transcript.language,
                transcript.duration_seconds,
                speaker_count,
                transcript.model_dump_json(),
                created_at,
            ),
        )
        transcript_id = cursor.fetchone()["id"] if DATABASE_URL else cursor.lastrowid
    return SavedTranscript(id=transcript_id, created_at=created_at, **transcript.model_dump())


@app.get("/transcripts/{transcript_id}", response_model=SavedTranscript)
@app.get("/api/transcripts/{transcript_id}", response_model=SavedTranscript)
@app.get("/adivox/api/transcripts/{transcript_id}", response_model=SavedTranscript)
def get_transcript(transcript_id: int) -> SavedTranscript:
    with _database() as connection:
        row = connection.execute(
            f"SELECT id, transcript_json, created_at FROM transcripts WHERE id = {'%s' if DATABASE_URL else '?'}",
            (transcript_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Saved transcript not found.")
    transcript = TranscriptResponse.model_validate_json(row["transcript_json"])
    return SavedTranscript(id=row["id"], created_at=row["created_at"], **transcript.model_dump())


@app.post("/transcribe", response_model=TranscriptResponse)
@app.post("/api/transcribe", response_model=TranscriptResponse)
@app.post("/adivox/api/transcribe", response_model=TranscriptResponse)
async def transcribe(
    audio: Annotated[UploadFile, File(description="Audio recording to transcribe")],
    x_gemini_api_key: Annotated[str | None, Header(alias="X-Gemini-API-Key")] = None,
) -> TranscriptResponse:
    api_key = _api_key() or (x_gemini_api_key or "").strip() or None
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="Provide a Gemini API key in AdiVox to generate a transcript.",
        )

    mime_type = _normalise_mime(audio)
    if mime_type not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(
            status_code=415,
            detail="Unsupported audio type. Use MP3, WAV, M4A, AAC, OGG, AIFF, or FLAC.",
        )

    suffix = Path(audio.filename or "audio").suffix or ".bin"
    temp_path: Path | None = None
    uploaded_file = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
            temp_path = Path(temp.name)
            total = 0
            while chunk := await audio.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail=f"Audio file must be {MAX_UPLOAD_MB} MB or smaller.")
                temp.write(chunk)

        client = genai.Client(api_key=api_key)
        uploaded_file = client.files.upload(
            file=str(temp_path), config={"mime_type": mime_type}
        )
        prompt = (
            "Create a faithful verbatim transcript of this recording. Identify every distinct "
            "human speaker and diarize the conversation, using a consistent short label for each "
            "speaker. There may be one, two, or many speakers: do not assume a fixed count. Split "
            "the transcript at natural speaker turns, include precise start and end times in "
            "seconds, preserve the spoken language and punctuation, and do not invent inaudible "
            "content. Also provide a short useful title and summary."
        )
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[prompt, uploaded_file],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=TranscriptContent,
                temperature=0.1,
            ),
        )
        if response.parsed:
            content = TranscriptContent.model_validate(response.parsed)
        elif response.text:
            content = TranscriptContent.model_validate_json(response.text)
        else:
            raise ValueError("Gemini returned an empty transcript")

        result = TranscriptResponse(**content.model_dump(), usage=_token_usage(response))

        result.segments.sort(key=lambda item: item.start_seconds)
        if result.segments:
            result.duration_seconds = max(
                result.duration_seconds, max(item.end_seconds for item in result.segments)
            )
        return result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Transcription failed: {exc}") from exc
    finally:
        await audio.close()
        if temp_path:
            temp_path.unlink(missing_ok=True)
        if uploaded_file is not None:
            try:
                client.files.delete(name=uploaded_file.name)
            except Exception:
                pass


FRONTEND_DIST = ROOT / "frontend" / "dist"
if FRONTEND_DIST.exists():
    assets = FRONTEND_DIST / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        requested = FRONTEND_DIST / full_path
        if full_path and requested.is_file():
            return FileResponse(requested)
        return FileResponse(FRONTEND_DIST / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
