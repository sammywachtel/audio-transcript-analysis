# Cloud Run GPU Whisper Diarization Service
#
# FastAPI server that mirrors the Cog /predict API. Runs Whisper Large v3 Turbo
# + pyannote 3.1 diarization on NVIDIA GPUs. Ships with a 180s hard timeout
# because nobody wants a GPU job running forever on their dime.

import asyncio
import logging
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# Configure structured logging before anything else
logging.basicConfig(
    level=logging.INFO,
    format=(
        '{"time":"%(asctime)s","level":"%(levelname)s",'
        '"logger":"%(name)s","message":"%(message)s"}'
    ),
    stream=sys.stdout,
)
logger = logging.getLogger("app")

# Timeouts — the 180s hard kill is non-negotiable, Cloud Run has a 300s backstop
HARD_TIMEOUT_S = 180
WARNING_TIMEOUT_S = 120

# Thread pool for running blocking inference off the event loop
_executor = ThreadPoolExecutor(max_workers=1)

# The predictor lives here after startup
_predictor = None


def _get_gpu_utilization() -> Optional[dict]:
    """Best-effort GPU utilization snapshot via pynvml."""
    try:
        import pynvml

        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        util = pynvml.nvmlDeviceGetUtilizationRates(handle)
        mem_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
        return {
            "gpu_util_pct": util.gpu,
            "mem_util_pct": util.memory,
            "mem_used_mb": round(mem_info.used / 1024 / 1024),
            "mem_total_mb": round(mem_info.total / 1024 / 1024),
        }
    except Exception:
        # pynvml not available or no GPU — not worth crashing over
        return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models into GPU memory at startup, clean up on shutdown."""
    global _predictor
    logger.info("Server starting — loading models into GPU memory")
    gpu_info = _get_gpu_utilization()
    if gpu_info:
        logger.info("GPU status at startup: %s", gpu_info)

    from predict import WhisperDiarizer

    _predictor = WhisperDiarizer()
    _predictor.setup_whisper()

    gpu_info = _get_gpu_utilization()
    if gpu_info:
        logger.info("GPU status after model load: %s", gpu_info)
    logger.info("Models loaded — server ready")
    yield
    logger.info("Server shutting down")


app = FastAPI(
    title="Whisper Diarization Service",
    description=(
        "Whisper Large v3 Turbo + pyannote 3.1 " "speaker diarization on Cloud Run GPU"
    ),
    lifespan=lifespan,
)


# -----------------------------------------------------------------------
# Request / Response models
# -----------------------------------------------------------------------


class PredictRequest(BaseModel):
    file_string: str = Field(
        ..., description="Base64 encoded audio file (raw or data: URI)"
    )
    num_speakers: Optional[int] = Field(
        None,
        description="Number of speakers (1-50), leave empty to autodetect",
        ge=1,
        le=50,
    )
    language: Optional[str] = Field(
        None, description="Language code like 'en'. Leave empty to auto-detect."
    )
    prompt: Optional[str] = Field(
        None,
        description=(
            "Vocabulary hint: names, acronyms and " "loanwords for better accuracy."
        ),
    )
    group_segments_gap: float = Field(
        1.0,
        description=(
            "Max time gap (seconds) to merge same-speaker "
            "segments. 0 disables grouping."
        ),
        ge=0.0,
        le=5.0,
    )
    timestamps_only: bool = Field(
        False,
        description=(
            "Skip diarization and embeddings, return timestamps"
            " only with generic speaker labels."
        ),
    )


class PredictResponse(BaseModel):
    segments: list
    language: Optional[str] = None
    num_speakers: Optional[int] = None
    speaker_embeddings: Optional[dict] = None


# -----------------------------------------------------------------------
# Endpoints
# -----------------------------------------------------------------------


@app.get("/health")
async def health():
    """Liveness / readiness probe."""
    gpu_info = _get_gpu_utilization()
    return {
        "status": "ok",
        "models_loaded": _predictor is not None,
        "gpu": gpu_info,
    }


@app.post("/predict", response_model=PredictResponse)
async def predict(request: PredictRequest, raw_request: Request):
    """
    Run Whisper transcription + pyannote diarization on base64-encoded audio.

    Returns the same JSON schema as the Cog /predict endpoint: segments with
    word-level timestamps, speaker assignments, and speaker embeddings.
    """
    request_start = time.monotonic()

    if _predictor is None:
        return JSONResponse(
            status_code=503,
            content={"error": "Models not loaded yet — server is still starting"},
            headers={"X-Predict-Time": f"{time.monotonic() - request_start:.3f}"},
        )

    request_id = f"req-{int(time.time())}"

    logger.info(
        "Predict request received",
        extra={
            "request_id": request_id,
            "file_string_len": len(request.file_string),
            "num_speakers": request.num_speakers,
            "language": request.language,
            "group_segments_gap": request.group_segments_gap,
            "timestamps_only": request.timestamps_only,
        },
    )

    # Fire-and-forget warning at 120s
    async def _warn_slow():
        await asyncio.sleep(WARNING_TIMEOUT_S)
        elapsed = time.monotonic() - request_start
        logger.warning(
            "Request approaching timeout",
            extra={
                "request_id": request_id,
                "elapsed_s": round(elapsed, 1),
                "hard_timeout_s": HARD_TIMEOUT_S,
                "gpu": _get_gpu_utilization(),
            },
        )

    warning_task = asyncio.create_task(_warn_slow())

    try:
        loop = asyncio.get_running_loop()
        result = await asyncio.wait_for(
            loop.run_in_executor(
                _executor,
                lambda: _predictor.run(
                    file_string=request.file_string,
                    num_speakers=request.num_speakers,
                    language=request.language,
                    prompt=request.prompt,
                    group_segments_gap=request.group_segments_gap,
                    timestamps_only=request.timestamps_only,
                ),
            ),
            timeout=HARD_TIMEOUT_S,
        )

        predict_time = time.monotonic() - request_start

        logger.info(
            "Predict request complete",
            extra={
                "request_id": request_id,
                "predict_time_s": round(predict_time, 3),
                "num_segments": len(result.get("segments", [])),
                "gpu": _get_gpu_utilization(),
            },
        )

        response = JSONResponse(content=result)
        response.headers["X-Predict-Time"] = f"{predict_time:.3f}"
        return response

    except asyncio.TimeoutError:
        elapsed = time.monotonic() - request_start
        logger.error(
            "Request timed out",
            extra={
                "request_id": request_id,
                "elapsed_s": round(elapsed, 1),
                "hard_timeout_s": HARD_TIMEOUT_S,
                "gpu": _get_gpu_utilization(),
            },
        )
        return JSONResponse(
            status_code=504,
            content={
                "error": f"Inference timed out after {HARD_TIMEOUT_S}s",
                "request_id": request_id,
            },
            headers={"X-Predict-Time": f"{elapsed:.3f}"},
        )

    except Exception as e:
        elapsed = time.monotonic() - request_start
        logger.exception(
            "Predict request failed",
            extra={"request_id": request_id, "elapsed_s": round(elapsed, 1)},
        )
        return JSONResponse(
            status_code=500,
            content={"error": str(e), "request_id": request_id},
            headers={"X-Predict-Time": f"{elapsed:.3f}"},
        )

    finally:
        warning_task.cancel()


# -----------------------------------------------------------------------
# Entrypoint
# -----------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8080"))
    logger.info("Starting server on port %d", port)
    uvicorn.run(app, host="0.0.0.0", port=port)
