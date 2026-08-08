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
    assert response.json()["max_upload_mb"] in {95, 200}


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
    assert loaded.json()["usage"]["total_tokens"] == 0


def test_token_cost_estimate_uses_audio_and_output_rates() -> None:
    import main

    class Detail:
        modality = "AUDIO"
        token_count = 10_000

    class Metadata:
        prompt_token_count = 10_100
        prompt_tokens_details = [Detail()]
        candidates_token_count = 1_000
        thoughts_token_count = 200
        total_token_count = 11_300

    class Response:
        usage_metadata = Metadata()

    usage = main._token_usage(Response())
    assert usage.audio_input_tokens == 10_000
    assert usage.text_input_tokens == 100
    assert usage.output_tokens == 1_200
    assert usage.total_tokens == 11_300
    assert usage.estimated_cost_usd == 0.01303


def test_api_key_is_not_stored_server_side(monkeypatch) -> None:
    import main

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    assert main._api_key() is None


def test_service_routes_work_without_api_prefix() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
