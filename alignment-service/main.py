"""
Alignment Service API

A thin FastAPI service that orchestrates timestamp alignment for audio transcripts.
Takes Gemini's transcript (with inaccurate timestamps) and returns it with
precise timestamps from WhisperX forced alignment.

Endpoints:
  POST /align - Align transcript timestamps
  GET /health - Health check
"""

import base64
import logging
import os
import sys
from typing import List

from aligner import AlignmentError, align_transcript
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Configure logging - check for DEBUG environment variable
# Set DEBUG=1 or LOG_LEVEL=DEBUG to enable debug logging
log_level_str = os.environ.get("LOG_LEVEL", "INFO").upper()
if os.environ.get("DEBUG", "").lower() in ("1", "true", "yes"):
    log_level_str = "DEBUG"

log_level = getattr(logging, log_level_str, logging.INFO)
logging.basicConfig(
    level=log_level,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)
logger.info(f"Logging initialized at {log_level_str} level")

app = FastAPI(
    title="Transcript Alignment Service",
    description="Aligns Gemini transcript timestamps using WhisperX forced alignment",
    version="1.0.0",
)

# CORS - allow frontend to call this service
# Using regex for Cloud Run domains (glob patterns don't work in allow_origins)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
    ],
    allow_origin_regex=r"https://.*\.run\.app",  # Match all Cloud Run domains
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SegmentInput(BaseModel):
    """A single transcript segment from Gemini."""

    speakerId: str
    text: str
    startMs: int
    endMs: int


class AlignRequest(BaseModel):
    """Request body for alignment endpoint."""

    audio_base64: str  # Base64-encoded audio file
    segments: List[SegmentInput]


class SegmentOutput(BaseModel):
    """A single aligned segment with confidence score."""

    speakerId: str
    text: str
    startMs: int
    endMs: int
    confidence: float


class AlignResponse(BaseModel):
    """Response from alignment endpoint."""

    segments: List[SegmentOutput]
    average_confidence: float


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    replicate_configured: bool


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """
    Health check endpoint.
    Verifies the service is running and Replicate API key is configured.
    """
    replicate_token = os.environ.get("REPLICATE_API_TOKEN")
    logger.debug(
        "Health check requested",
        extra={
            "replicate_configured": bool(replicate_token),
            "log_level": log_level_str,
        },
    )
    return HealthResponse(status="ok", replicate_configured=bool(replicate_token))


@app.post("/align", response_model=AlignResponse)
async def align_timestamps(request: AlignRequest):
    """
    Align transcript timestamps using WhisperX forced alignment.

    Takes Gemini's transcript segments (with potentially inaccurate timestamps)
    and returns them with precise timestamps derived from WhisperX's
    word-level forced alignment.

    The alignment process:
    1. Sends audio to Replicate's WhisperX model
    2. Gets word-level timestamps from forced alignment
    3. Fuzzy-matches each Gemini segment to the corresponding word sequence
    4. Returns segments with corrected timestamps and confidence scores

    A confidence score of 0.8+ indicates a good match.
    Below 0.5 suggests the segment text may not be in the audio.
    """
    import time

    request_start_time = time.time()

    # Decode audio to get size info for logging
    try:
        audio_bytes = base64.b64decode(request.audio_base64)
        audio_size_mb = len(audio_bytes) / (1024 * 1024)
    except Exception:
        audio_size_mb = 0

    logger.info(
        f"Received alignment request: segments={len(request.segments)}, "
        f"audio_size={audio_size_mb:.2f}MB"
    )

    # DEBUG: Log detailed request info
    if request.segments:
        first_seg = request.segments[0]
        last_seg = request.segments[-1]
        total_text_chars = sum(len(s.text) for s in request.segments)
        total_duration_ms = (
            last_seg.endMs - first_seg.startMs if last_seg.endMs > 0 else 0
        )

        logger.debug(
            f"[Align] Request details: "
            f"first_segment={{startMs={first_seg.startMs}, endMs={first_seg.endMs}, "
            f"text_preview='{first_seg.text[:50]}...'}}, "
            f"last_segment={{startMs={last_seg.startMs}, endMs={last_seg.endMs}, "
            f"text_preview='{last_seg.text[:50]}...'}}, "
            f"total_text_chars={total_text_chars}, "
            f"total_duration_ms={total_duration_ms}, "
            f"audio_base64_length={len(request.audio_base64)}"
        )

    # Validate we have segments
    if not request.segments:
        logger.warning("[Align] Request rejected: no segments provided")
        raise HTTPException(status_code=400, detail="No segments provided")

    # Validate audio data
    if not request.audio_base64:
        logger.warning("[Align] Request rejected: no audio data provided")
        raise HTTPException(status_code=400, detail="No audio data provided")

    # Check Replicate API key
    if not os.environ.get("REPLICATE_API_TOKEN"):
        logger.error("[Align] Replicate API token not configured")
        raise HTTPException(
            status_code=500, detail="Replicate API token not configured"
        )

    try:
        # Convert Pydantic models to dicts for aligner
        segments_dict = [
            {
                "speakerId": s.speakerId,
                "text": s.text,
                "startMs": s.startMs,
                "endMs": s.endMs,
            }
            for s in request.segments
        ]

        logger.debug(
            f"[Align] Calling align_transcript with {len(segments_dict)} segments"
        )
        align_start_time = time.time()

        # Run alignment
        aligned_segments = await align_transcript(request.audio_base64, segments_dict)

        align_duration = time.time() - align_start_time
        logger.debug(f"[Align] align_transcript completed in {align_duration:.2f}s")

        # Calculate average confidence
        confidences = [s["confidence"] for s in aligned_segments]
        avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0

        # Calculate confidence distribution
        high_conf = len([c for c in confidences if c >= 0.8])
        med_conf = len([c for c in confidences if 0.5 <= c < 0.8])
        low_conf = len([c for c in confidences if c < 0.5])

        total_duration = time.time() - request_start_time

        conf_dist = f"high={high_conf}, med={med_conf}, low={low_conf}"
        logger.info(
            f"[Align] ✅ Alignment complete: "
            f"avg_confidence={avg_confidence:.3f}, "
            f"confidence_distribution={{{conf_dist}}}, "
            f"total_time={total_duration:.2f}s"
        )

        # DEBUG: Log sample aligned segments
        if aligned_segments:
            first_aligned = aligned_segments[0]
            last_aligned = aligned_segments[-1]
            f_start = first_aligned["startMs"]
            f_end = first_aligned["endMs"]
            f_conf = first_aligned["confidence"]
            l_start = last_aligned["startMs"]
            l_end = last_aligned["endMs"]
            l_conf = last_aligned["confidence"]
            logger.debug(
                f"[Align] Sample aligned segments: "
                f"first={{startMs={f_start}, endMs={f_end}, conf={f_conf:.3f}}}, "
                f"last={{startMs={l_start}, endMs={l_end}, conf={l_conf:.3f}}}"
            )

        return AlignResponse(
            segments=[
                SegmentOutput(
                    speakerId=s["speakerId"],
                    text=s["text"],
                    startMs=s["startMs"],
                    endMs=s["endMs"],
                    confidence=s["confidence"],
                )
                for s in aligned_segments
            ],
            average_confidence=avg_confidence,
        )

    except AlignmentError as e:
        total_duration = time.time() - request_start_time
        logger.error(f"[Align] ❌ Alignment failed after {total_duration:.2f}s: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    except Exception as e:
        total_duration = time.time() - request_start_time
        logger.exception(f"[Align] ❌ Unexpected error after {total_duration:.2f}s")
        raise HTTPException(status_code=500, detail=f"Alignment failed: {str(e)}")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
