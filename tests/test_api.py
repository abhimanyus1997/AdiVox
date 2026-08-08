import sys
from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import _normalise_mime, app
from starlette.datastructures import Headers
from fastapi import UploadFile


client = TestClient(app)


def test_health_reports_configuration_state() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert isinstance(response.json()["configured"], bool)


def test_transcribe_rejects_unsupported_file() -> None:
    response = client.post(
        "/api/transcribe", files={"audio": ("notes.txt", b"not audio", "text/plain")}
    )
    assert response.status_code in {415, 503}


def test_browser_recording_webm_is_supported() -> None:
    upload = UploadFile(
        file=BytesIO(b"audio"),
        filename="recording.webm",
        headers=Headers({"content-type": "audio/webm"}),
    )
    assert _normalise_mime(upload) == "audio/webm"


def test_save_and_load_transcript(tmp_path, monkeypatch) -> None:
    import main

    monkeypatch.setattr(main, "DATABASE_PATH", tmp_path / "adivox-test.db")
    main._init_database()
    payload = {
        "title": "Team sync",
        "summary": "A short meeting.",
        "language": "English",
        "duration_seconds": 12.5,
        "segments": [
            {
                "speaker": "Speaker 1",
                "start_seconds": 0,
                "end_seconds": 4.2,
                "text": "Hello team.",
            },
            {
                "speaker": "Speaker 2",
                "start_seconds": 4.2,
                "end_seconds": 12.5,
                "text": "Let's begin.",
            },
        ],
    }
    saved = client.post("/api/transcripts", json=payload)
    assert saved.status_code == 201
    assert saved.json()["id"] > 0

    listed = client.get("/api/transcripts")
    assert listed.status_code == 200
    assert listed.json()[0]["speaker_count"] == 2

    loaded = client.get(f"/api/transcripts/{saved.json()['id']}")
    assert loaded.status_code == 200
    assert loaded.json()["segments"] == payload["segments"]
