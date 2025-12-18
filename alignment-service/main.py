"""
Alignment Service API

A thin FastAPI service that orchestrates timestamp alignment for audio transcripts.
Takes Gemini's transcript (with inaccurate timestamps) and returns it with
precise timestamps from WhisperX forced alignment.

Endpoints:
  POST /align - Align transcript timestamps
  GET /health - Health check
"""

import logging
import os
from typing import List

from aligner import AlignmentError, align_transcript
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Transcript Alignment Service",
    description="Aligns Gemini transcript timestamps using WhisperX forced alignment",
    version="1.0.0",
)

# CORS - allow frontend to call this service
# In production, restrict this to your actual frontend domain
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "https://*.run.app",  # Cloud Run domains
        os.environ.get("FRONTEND_URL", ""),
    ],
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
    logger.info(f"Received alignment request with {len(request.segments)} segments")

    # Validate we have segments
    if not request.segments:
        raise HTTPException(status_code=400, detail="No segments provided")

    # Validate audio data
    if not request.audio_base64:
        raise HTTPException(status_code=400, detail="No audio data provided")

    # Check Replicate API key
    if not os.environ.get("REPLICATE_API_TOKEN"):
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

        # Run alignment
        aligned_segments = await align_transcript(request.audio_base64, segments_dict)

        # Calculate average confidence
        confidences = [s["confidence"] for s in aligned_segments]
        avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0

        logger.info(f"Alignment complete. Average confidence: {avg_confidence:.2f}")

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
        logger.error(f"Alignment failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    except Exception as e:
        logger.exception("Unexpected error during alignment")
        raise HTTPException(status_code=500, detail=f"Alignment failed: {str(e)}")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
