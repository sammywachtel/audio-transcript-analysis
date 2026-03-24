# Whisper diarization inference pipeline — Cloud Run GPU edition
#
# Ported from cog-whisper-diarization/predict.py. Same models, same output
# schema, no Cog dependency. Set HF env vars before touching huggingface_hub.
#
# Configurable at runtime via env vars:
#   WHISPER_MODEL_PATH  — CTranslate2 model dir
#     (default: /models/faster-whisper-large-v3-turbo)
#   WHISPER_BEAM_SIZE   — beam size for decoding
#     (default: 5, lower = faster but maybe rougher)

import os

os.environ["HF_HOME"] = "/models"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

import base64  # noqa: E402
import logging  # noqa: E402
import re  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402
from typing import Any, Dict, List, Optional  # noqa: E402

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import torch  # noqa: E402
import torchaudio  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402
from faster_whisper.vad import VadOptions  # noqa: E402
from pyannote.audio import Inference, Model, Pipeline  # noqa: E402
from pyannote.core import Segment  # noqa: E402

logger = logging.getLogger("predict")


class WhisperDiarizer:
    """
    Loads Whisper + pyannote once, runs inference many times.
    Drop-in replacement for the Cog Predictor class, minus the Cog parts.
    """

    def __init__(self) -> None:
        self.model: Optional[WhisperModel] = None
        self.diarization_model: Optional[Pipeline] = None
        self.embedding_model: Optional[Model] = None
        self.embedding_inference: Optional[Inference] = None

    # ------------------------------------------------------------------
    # Model loading
    # ------------------------------------------------------------------

    def setup_whisper(self) -> None:
        """Load Whisper ASR model at startup.

        Fast path for timestamps_only requests.
        """
        # Model path and beam size are configurable via env vars so we can
        # A/B test different models and settings without rebuilding the image.
        model_path = os.environ.get(
            "WHISPER_MODEL_PATH", "/models/faster-whisper-large-v3-turbo"
        )
        logger.info("Loading Whisper model from %s", model_path)
        self.model = WhisperModel(
            model_path,
            device="cuda",
            compute_type="float16",
        )
        logger.info(
            "Whisper model loaded — diarization models"
            " will lazy-load on first full request"
        )

    def ensure_diarization_models_loaded(self) -> None:
        """Lazy-load pyannote diarization + embedding models on demand.
        Idempotent — safe to call every time, only loads once."""
        if self.diarization_model is not None:
            # Already loaded, nothing to do
            return

        logger.info(
            "Lazy-loading diarization models (first non-timestamps_only request)"
        )
        hf_token = os.environ.get("HF_TOKEN", "")

        logger.info("Loading pyannote speaker-diarization-3.1")
        self.diarization_model = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token or None,
        ).to(torch.device("cuda"))

        logger.info("Loading pyannote wespeaker embedding model")
        self.embedding_model = Model.from_pretrained(
            "pyannote/wespeaker-voxceleb-resnet34-LM",
            use_auth_token=hf_token or None,
        )
        self.embedding_inference = Inference(
            self.embedding_model,
            window="whole",
            device=torch.device("cuda"),
        )
        logger.info("Diarization models loaded")

    # ------------------------------------------------------------------
    # Public predict interface
    # ------------------------------------------------------------------

    def run(
        self,
        file_string: str,
        num_speakers: Optional[int] = None,
        language: Optional[str] = None,
        prompt: Optional[str] = None,
        group_segments_gap: float = 1.0,
        timestamps_only: bool = False,
    ) -> Dict[str, Any]:
        """
        Run transcription + diarization on base64-encoded audio.

        Returns dict matching the Cog Output schema:
          {segments, language, num_speakers, speaker_embeddings}
        """
        temp_wav = None
        temp_raw = None
        try:
            # Decode base64 (handles both raw base64 and data: URIs)
            raw_b64 = file_string.split(",")[1] if "," in file_string else file_string
            audio_data = base64.b64decode(raw_b64)

            # Write raw audio to a temp file, then convert to 16kHz mono WAV
            temp_raw = tempfile.NamedTemporaryFile(suffix=".audio", delete=False)
            temp_raw.write(audio_data)
            temp_raw.close()

            temp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            temp_wav.close()

            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    temp_raw.name,
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    temp_wav.name,
                ],
                check=True,
                capture_output=True,
            )

            segments, detected_num_speakers, detected_language, speaker_embeddings = (
                self._speech_to_text(
                    temp_wav.name,
                    num_speakers=num_speakers,
                    prompt=prompt or "",
                    language=language,
                    group_segments_gap=group_segments_gap,
                    timestamps_only=timestamps_only,
                )
            )

            logger.info(
                "Inference complete",
                extra={
                    "num_segments": len(segments),
                    "num_speakers": detected_num_speakers,
                    "language": detected_language,
                    "embeddings": list(speaker_embeddings.keys()),
                },
            )

            return {
                "segments": segments,
                "language": detected_language,
                "num_speakers": detected_num_speakers,
                "speaker_embeddings": speaker_embeddings,
            }

        finally:
            # Temp file cleanup — we don't leave trash in /tmp on GPU boxes
            for f in (temp_raw, temp_wav):
                if f is not None and os.path.exists(f.name):
                    os.remove(f.name)

    # ------------------------------------------------------------------
    # Internal pipeline
    # ------------------------------------------------------------------

    def _speech_to_text(
        self,
        audio_file_wav: str,
        num_speakers: Optional[int] = None,
        prompt: str = "",
        language: Optional[str] = None,
        group_segments_gap: float = 1.0,
        timestamps_only: bool = False,
    ):
        time_start = time.time()

        # --- Transcription ---
        # Beam size is tunable via env var — lower values trade quality for speed,
        # which is the whole point of this cost evaluation exercise.
        beam_size = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))
        logger.info("Starting transcription (beam_size=%d)", beam_size)
        options = dict(
            language=language,
            beam_size=beam_size,
            vad_filter=True,
            vad_parameters=VadOptions(
                max_speech_duration_s=self.model.feature_extractor.chunk_length,
                min_speech_duration_ms=100,
                speech_pad_ms=100,
                threshold=0.25,
                neg_threshold=0.2,
            ),
            word_timestamps=True,
            initial_prompt=prompt if prompt else None,
            language_detection_segments=1,
        )
        raw_segments, transcript_info = self.model.transcribe(audio_file_wav, **options)
        raw_segments = list(raw_segments)
        segments = [
            {
                "avg_logprob": s.avg_logprob,
                "start": float(s.start),
                "end": float(s.end),
                "text": s.text,
                "words": [
                    {
                        "start": float(w.start),
                        "end": float(w.end),
                        "word": w.word,
                        "probability": w.probability,
                    }
                    for w in s.words
                ],
            }
            for s in raw_segments
        ]

        time_transcribing_end = time.time()
        logger.info(
            "Transcription complete",
            extra={
                "duration_s": round(time_transcribing_end - time_start, 3),
                "segment_count": len(segments),
            },
        )

        if timestamps_only:
            # Skip diarization entirely — stamp everything as SPEAKER_00
            logger.info("timestamps_only=True, skipping diarization and embeddings")
            for segment in segments:
                segment["speaker"] = "SPEAKER_00"
                for word in segment["words"]:
                    word["speaker"] = "SPEAKER_00"

            # Text cleanup (same as diarization path)
            for segment in segments:
                segment["text"] = re.sub(r"\s+", " ", segment["text"]).strip()
                segment["text"] = re.sub(r"\s+([.,!?])", r"\1", segment["text"])
                segment["duration"] = segment["end"] - segment["start"]

            time_end = time.time()
            logger.info(
                "Timestamps-only complete",
                extra={
                    "final_segments": len(segments),
                    "total_duration_s": round(time_end - time_start, 3),
                },
            )

            return (
                segments,
                1,  # num_speakers — just the generic one
                transcript_info.language,
                {},  # no speaker embeddings
            )

        else:
            # Full diarization path — lazy-load models if this is the first rodeo
            self.ensure_diarization_models_loaded()

            # --- Diarization ---
            logger.info("Starting diarization")
            waveform, sample_rate = torchaudio.load(audio_file_wav)
            diarization = self.diarization_model(
                {"waveform": waveform, "sample_rate": sample_rate},
                num_speakers=num_speakers,
            )

            time_diarization_end = time.time()
            logger.info(
                "Diarization complete",
                extra={
                    "duration_s": round(time_diarization_end - time_transcribing_end, 3)
                },
            )

            # Build diarization DataFrame
            diarize_segments = []
            diarization_list = list(diarization.itertracks(yield_label=True))
            for turn, _, speaker in diarization_list:
                diarize_segments.append(
                    {"start": turn.start, "end": turn.end, "speaker": speaker}
                )
            diarize_df = pd.DataFrame(diarize_segments)
            unique_speakers = {speaker for _, _, speaker in diarization_list}
            detected_num_speakers = len(unique_speakers)

            logger.info(
                "Diarization stats",
                extra={
                    "raw_diarization_segments": len(diarize_segments),
                    "detected_speakers": detected_num_speakers,
                },
            )

            # --- Speaker embeddings ---
            logger.info("Extracting speaker embeddings")
            time_embedding_start = time.time()
            speaker_embeddings = self._extract_speaker_embeddings(
                audio_file_wav, diarization_list, unique_speakers
            )
            time_embedding_end = time.time()
            logger.info(
                "Embedding extraction complete",
                extra={
                    "speakers": len(speaker_embeddings),
                    "duration_s": round(time_embedding_end - time_embedding_start, 3),
                },
            )

            # --- Merge segments with diarization ---
            logger.info("Merging transcription with diarization")
            final_segments = self._merge_segments(
                segments, diarize_df, speaker="UNKNOWN"
            )

            # --- Group same-speaker segments ---
            if len(final_segments) > 0 and group_segments_gap > 0:
                final_segments = self._group_segments(
                    final_segments, group_segments_gap
                )

            # Final text cleanup
            for segment in final_segments:
                segment["text"] = re.sub(r"\s+", " ", segment["text"]).strip()
                segment["text"] = re.sub(r"\s+([.,!?])", r"\1", segment["text"])
                segment["duration"] = segment["end"] - segment["start"]

            time_merging_end = time.time()
            logger.info(
                "Merge complete",
                extra={
                    "final_segments": len(final_segments),
                    "total_duration_s": round(time_merging_end - time_start, 3),
                },
            )

            return (
                final_segments,
                detected_num_speakers,
                transcript_info.language,
                speaker_embeddings,
            )

    # ------------------------------------------------------------------
    # Speaker assignment — identical logic to Cog predict.py
    # ------------------------------------------------------------------

    def _merge_segments(
        self,
        segments: List[Dict],
        diarize_df: pd.DataFrame,
        speaker: str = "UNKNOWN",
    ) -> List[Dict]:
        """Assign speakers to segments and words, split on speaker changes."""
        final_segments = []

        for segment in segments:
            # Segment-level speaker via max intersection
            diarize_df["intersection"] = np.minimum(
                diarize_df["end"], segment["end"]
            ) - np.maximum(diarize_df["start"], segment["start"])
            diarize_df["union"] = np.maximum(
                diarize_df["end"], segment["end"]
            ) - np.minimum(diarize_df["start"], segment["start"])

            dia_tmp = diarize_df[diarize_df["intersection"] > 0]
            if len(dia_tmp) > 0:
                seg_speaker = (
                    dia_tmp.groupby("speaker")["intersection"]
                    .sum()
                    .sort_values(ascending=False)
                    .index[0]
                )
            else:
                seg_speaker = speaker

            # Word-level speaker assignment
            words_with_speakers = []
            for word in segment["words"]:
                diarize_df["intersection"] = np.minimum(
                    diarize_df["end"], word["end"]
                ) - np.maximum(diarize_df["start"], word["start"])
                diarize_df["union"] = np.maximum(
                    diarize_df["end"], word["end"]
                ) - np.minimum(diarize_df["start"], word["start"])

                dia_tmp = diarize_df[diarize_df["intersection"] > 0]
                if len(dia_tmp) > 0:
                    word_speaker = (
                        dia_tmp.groupby("speaker")["intersection"]
                        .sum()
                        .sort_values(ascending=False)
                        .index[0]
                    )
                else:
                    word_speaker = seg_speaker

                word["speaker"] = word_speaker
                words_with_speakers.append(word)

            # Split segment at word-level speaker changes
            if len(words_with_speakers) > 0:
                split_segments = []
                current_words = [words_with_speakers[0]]
                current_speaker = words_with_speakers[0].get("speaker", seg_speaker)

                for word in words_with_speakers[1:]:
                    word_speaker = word.get("speaker", seg_speaker)
                    if word_speaker != current_speaker:
                        if current_words:
                            text = "".join(w["word"] for w in current_words).strip()
                            split_segments.append(
                                {
                                    "start": current_words[0]["start"],
                                    "end": current_words[-1]["end"],
                                    "text": text,
                                    "speaker": current_speaker,
                                    "avg_logprob": segment["avg_logprob"],
                                    "words": current_words.copy(),
                                }
                            )
                        current_words = [word]
                        current_speaker = word_speaker
                    else:
                        current_words.append(word)

                # Last group
                if current_words:
                    text = "".join(w["word"] for w in current_words).strip()
                    split_segments.append(
                        {
                            "start": current_words[0]["start"],
                            "end": current_words[-1]["end"],
                            "text": text,
                            "speaker": current_speaker,
                            "avg_logprob": segment["avg_logprob"],
                            "words": current_words.copy(),
                        }
                    )

                final_segments.extend(split_segments)
            else:
                final_segments.append(
                    {
                        "start": segment["start"],
                        "end": segment["end"],
                        "text": segment["text"],
                        "speaker": seg_speaker,
                        "avg_logprob": segment["avg_logprob"],
                        "words": words_with_speakers,
                    }
                )

        return final_segments

    # ------------------------------------------------------------------
    # Segment grouping — same logic as Cog predict.py
    # ------------------------------------------------------------------

    @staticmethod
    def _group_segments(
        final_segments: List[Dict], group_segments_gap: float
    ) -> List[Dict]:
        """Merge consecutive same-speaker segments within gap threshold."""
        sentence_end_pattern = r"[.!?]+"
        grouped = []
        current_group = final_segments[0].copy()

        for segment in final_segments[1:]:
            time_gap = segment["start"] - current_group["end"]
            current_duration = current_group["end"] - current_group["start"]

            can_combine = (
                segment["speaker"] == current_group["speaker"]
                and time_gap <= group_segments_gap
                and current_duration < 30.0
                and not re.search(sentence_end_pattern, current_group["text"][-1:])
            )

            if can_combine:
                current_group["end"] = segment["end"]
                current_group["text"] += " " + segment["text"]
                current_group["words"].extend(segment["words"])
            else:
                grouped.append(current_group)
                current_group = segment.copy()

        grouped.append(current_group)
        return grouped

    # ------------------------------------------------------------------
    # Speaker embedding extraction — same logic as Cog predict.py
    # ------------------------------------------------------------------

    def _extract_speaker_embeddings(
        self,
        audio_file: str,
        diarization_list: list,
        unique_speakers: set,
    ) -> Dict[str, List[float]]:
        """
        Extract voice embeddings for each speaker using their longest segment.
        Returns dict mapping speaker ID to embedding vector (256 floats).
        """
        speaker_embeddings: Dict[str, List[float]] = {}

        # Find longest segment per speaker
        speaker_segments: Dict[str, Dict] = {}
        for turn, _, spk in diarization_list:
            duration = turn.end - turn.start
            if (
                spk not in speaker_segments
                or duration > speaker_segments[spk]["duration"]
            ):
                speaker_segments[spk] = {
                    "start": turn.start,
                    "end": turn.end,
                    "duration": duration,
                }

        for spk in unique_speakers:
            if spk not in speaker_segments:
                logger.warning("No segments found for speaker %s", spk)
                continue

            seg_info = speaker_segments[spk]
            if seg_info["duration"] < 0.5:
                logger.warning(
                    "Segment too short for %s (%.2fs), skipping embedding",
                    spk,
                    seg_info["duration"],
                )
                continue

            try:
                segment = Segment(seg_info["start"], seg_info["end"])
                embedding = self.embedding_inference.crop(audio_file, segment)
                embedding_list = embedding.flatten().tolist()
                speaker_embeddings[spk] = embedding_list
                logger.debug(
                    "Extracted %d-dim embedding for %s (%.1fs segment)",
                    len(embedding_list),
                    spk,
                    seg_info["duration"],
                )
            except Exception as e:
                logger.error("Error extracting embedding for %s: %s", spk, e)
                continue

        return speaker_embeddings
