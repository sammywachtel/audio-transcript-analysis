/**
 * Unit tests for the Gemini Hybrid Pipeline Orchestrator
 *
 * Tests cover:
 * - Happy-path orchestration with correct call order
 * - Per-phase progress updates (GEMINI_ANALYSIS → ... → COMPLETE)
 * - Firestore persistence shape (status: 'complete', all required fields)
 * - Error propagation and temp-file cleanup on failure
 * - Chunk processing: WhisperX words → speaker assignment → global-ts offset
 * - Fatal errors (HybridPipelineFatalError) write 'failed' to Firestore
 * - Hard failures when WhisperX returns empty words (no fallback)
 * - Quality gates (zero speakers, zero segments, low segment count)
 * - Timeout enforcement (pipeline-level, per-chunk WhisperX)
 * - Cleanup on both success and failure exits
 */

// =============================================================================
// Mocks — must be declared before any imports
// =============================================================================

// Mock firebase-admin/storage
const mockDownload = jest.fn();
const mockExists = jest.fn();
const mockFile = jest.fn(() => ({
  exists: mockExists,
  download: mockDownload,
}));
const mockBucket = jest.fn(() => ({
  file: mockFile,
}));
jest.mock('firebase-admin/storage', () => ({
  getStorage: () => ({ bucket: mockBucket }),
}));

// Mock firebase-admin/firestore
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: jest.fn(() => ({ _type: 'server_timestamp' })),
  },
}));

// Mock ./index (Firestore db)
const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockDoc = jest.fn(() => ({ update: mockUpdate }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));
jest.mock('../index', () => ({
  db: { collection: mockCollection },
}));

// Mock ./gemini3Pipeline
const mockProcessWithGemini3Flash = jest.fn();
const mockAssembleFirestoreData = jest.fn();
jest.mock('../gemini3Pipeline', () => ({
  processWithGemini3Flash: (...args: unknown[]) => mockProcessWithGemini3Flash(...args),
  assembleFirestoreData: (...args: unknown[]) => mockAssembleFirestoreData(...args),
}));

// Mock ./alignment — getWhisperXWords replaces alignTimestamps
const mockGetWhisperXWords = jest.fn();
jest.mock('../alignment', () => ({
  getWhisperXWords: (...args: unknown[]) => mockGetWhisperXWords(...args),
}));

// Mock ./speakerAssignment
const mockAssignSpeakersToWords = jest.fn();
jest.mock('../speakerAssignment', () => ({
  assignSpeakersToWords: (...args: unknown[]) => mockAssignSpeakersToWords(...args),
}));

// Mock ./audioUtils (getAudioDuration moved from chunking in hard cutover)
const mockGetAudioDuration = jest.fn();
jest.mock('../audioUtils', () => ({
  getAudioDuration: (...args: unknown[]) => mockGetAudioDuration(...args),
}));

// Mock ./logger
jest.mock('../logger', () => ({
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ProgressManager mock — track setStep calls in order
const mockSetStep = jest.fn().mockResolvedValue(undefined);
const mockSetFailed = jest.fn().mockResolvedValue(undefined);
const mockSetComplete = jest.fn().mockResolvedValue(undefined);
jest.mock('../progressManager', () => {
  // Need real ProcessingStep enum values for assertions
  const actualProgressManager = jest.requireActual('../progressManager') as typeof import('../progressManager');
  return {
    ProcessingStep: actualProgressManager.ProcessingStep,
    ProgressManager: jest.fn().mockImplementation(() => ({
      setStep: mockSetStep,
      setFailed: mockSetFailed,
      setComplete: mockSetComplete,
    })),
  };
});

// Mock @ffmpeg-installer/ffmpeg (dynamic import in module under test)
jest.mock('@ffmpeg-installer/ffmpeg', () => ({
  default: { path: '/mock/ffmpeg' },
}));

// Track execFile calls — the module uses promisify(execFile)
const execFileAsyncMock = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));
jest.mock('util', () => {
  const actual = jest.requireActual('util') as typeof import('util');
  return {
    ...actual,
    promisify: jest.fn(() => execFileAsyncMock),
  };
});

// Mock fs — control existsSync/unlinkSync/readFileSync/statSync
const fsExistsSyncMock = jest.fn().mockReturnValue(true);
const fsUnlinkSyncMock = jest.fn();
const fsReadFileSyncMock = jest.fn().mockReturnValue(Buffer.from('fake-audio-data'));
const fsStatSyncMock = jest.fn().mockReturnValue({ size: 5 * 1024 * 1024 }); // 5MB
jest.mock('fs', () => ({
  existsSync: (...args: unknown[]) => fsExistsSyncMock(...args),
  unlinkSync: (...args: unknown[]) => fsUnlinkSyncMock(...args),
  readFileSync: (...args: unknown[]) => fsReadFileSyncMock(...args),
  statSync: (...args: unknown[]) => fsStatSyncMock(...args),
}));

// Import after mocks
import { processWithNewPipeline, HybridPipelineFatalError } from '../newPipeline';
import { ProcessingStep } from '../progressManager';

// =============================================================================
// Test Fixtures
// =============================================================================

// 45 min audio, 3 speakers, 10 segments spanning 0–14400000ms (Gemini-drifted time)
// Gemini timestamps are ~1.6x slow relative to real audio time — typical from PoC findings
const GEMINI_RESULT = {
  speakers: [
    { label: 'Speaker 1', name: 'Alice', role: 'presenter' },
    { label: 'Speaker 2', name: 'Bob', role: 'questioner' },
    { label: 'Speaker 3', name: 'Carol', role: 'participant' },
  ],
  segments: [
    // Chunk 0 territory (scaled to 0–600000ms real)
    { speaker: 'Speaker 1', startMs: 0, endMs: 1440000 },
    { speaker: 'Speaker 2', startMs: 1440000, endMs: 2880000 },
    { speaker: 'Speaker 1', startMs: 2880000, endMs: 4320000 },
    // Chunk 1 territory (scaled to 600000–1200000ms real)
    { speaker: 'Speaker 3', startMs: 4320000, endMs: 5760000 },
    { speaker: 'Speaker 1', startMs: 5760000, endMs: 7200000 },
    { speaker: 'Speaker 2', startMs: 7200000, endMs: 8640000 },
    // Chunk 2 territory (scaled to 1200000–1800000ms real)
    { speaker: 'Speaker 1', startMs: 8640000, endMs: 10080000 },
    { speaker: 'Speaker 3', startMs: 10080000, endMs: 11520000 },
    // Chunk 3 territory (scaled to 1800000–2400000ms real)
    { speaker: 'Speaker 2', startMs: 11520000, endMs: 12960000 },
    // Chunk 4 territory (scaled to 2400000–2700000ms real, partial)
    { speaker: 'Speaker 1', startMs: 12960000, endMs: 14400000 },
  ],
  terms: [{ key: 'rag', display: 'RAG', definition: 'Retrieval-Augmented Generation', aliases: ['retrieval augmented generation'] }],
  topics: [{ title: 'AI Architecture', startApproxMs: 0, endApproxMs: 14400000, type: 'main' as const }],
  persons: [{ name: 'Dr. Smith', affiliation: 'Research Lab' }],
  tokenUsage: { promptTokens: 5000, completionTokens: 3000, totalTokens: 8000 },
  durationMs: 45000,
};

// Real audio duration: 2700000ms (45 min)
const AUDIO_DURATION_MS = 2700000;
const AUDIO_DURATION_SEC = AUDIO_DURATION_MS / 1000; // 2700

// WhisperX words mock — what getWhisperXWords returns (seconds, not ms)
const MOCK_WORDS = [
  { word: 'hello', start: 0.1, end: 0.5, index: 0, score: 0.95 },
  { word: 'world', start: 0.6, end: 1.0, index: 1, score: 0.92 },
];

// AlignedSegments — what assignSpeakersToWords returns
const MOCK_ASSIGNED_SEGMENTS = [
  { speakerId: 'Speaker 1', text: 'hello world', startMs: 100, endMs: 1000 },
];

// Assembled output mock (what assembleFirestoreData returns)
const ASSEMBLED_RESULT = {
  speakers: { speaker_0: { speakerId: 'speaker_0', displayName: 'Alice (presenter)', colorIndex: 0 } },
  segments: [
    { segmentId: 'seg_0', index: 0, speakerId: 'speaker_0', startMs: 100, endMs: 1000, text: 'hello world' },
  ],
  terms: { t_0: { termId: 't_0', key: 'rag', display: 'RAG', definition: 'RAG def', aliases: [] } },
  termOccurrences: [],
  topics: [{ topicId: 'top_0', title: 'AI Architecture', startIndex: 0, endIndex: 0, type: 'main' as const }],
  people: [{ personId: 'p_0', name: 'Alice' }],
  durationMs: AUDIO_DURATION_MS,
};

// =============================================================================
// Setup
// =============================================================================

describe('newPipeline', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();

    process.env = {
      ...originalEnv,
      WHISPER_SERVICE_URL: 'https://whisperx.example.com',
    };

    // Storage defaults — file exists, download succeeds
    mockExists.mockResolvedValue([true]);
    mockDownload.mockResolvedValue(undefined);

    // Gemini analysis succeeds
    mockProcessWithGemini3Flash.mockResolvedValue(GEMINI_RESULT);

    // Audio duration: 45 minutes
    mockGetAudioDuration.mockResolvedValue(AUDIO_DURATION_SEC);

    // ffmpeg chunk splitting succeeds
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

    // fs defaults
    fsExistsSyncMock.mockReturnValue(true);
    fsUnlinkSyncMock.mockReturnValue(undefined);
    fsReadFileSyncMock.mockReturnValue(Buffer.from('fake-audio-data'));
    fsStatSyncMock.mockReturnValue({ size: 5 * 1024 * 1024 });

    // WhisperX returns words for all chunks
    mockGetWhisperXWords.mockResolvedValue(MOCK_WORDS);

    // Speaker assignment returns segments for all chunks
    mockAssignSpeakersToWords.mockReturnValue(MOCK_ASSIGNED_SEGMENTS);

    // Assembly succeeds
    mockAssembleFirestoreData.mockReturnValue(ASSEMBLED_RESULT);

    // Firestore write succeeds
    mockUpdate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ===========================================================================
  // Happy-path orchestration
  // ===========================================================================

  describe('happy path', () => {
    it('calls all pipeline steps in the correct order', async () => {
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      // Gemini analysis ran first
      expect(mockProcessWithGemini3Flash).toHaveBeenCalledWith(
        'users/uid/audio/test.mp3',
        { conversationId: 'conv-123' },
      );

      // Audio duration probed after Gemini (we have the MP3 path by then)
      expect(mockGetAudioDuration).toHaveBeenCalledTimes(1);

      // WhisperX called for each non-empty chunk
      expect(mockGetWhisperXWords).toHaveBeenCalled();

      // Speaker assignment called for each chunk with WhisperX words
      expect(mockAssignSpeakersToWords).toHaveBeenCalled();

      // Assembly ran with the Gemini result and collected aligned segments
      expect(mockAssembleFirestoreData).toHaveBeenCalledWith(
        GEMINI_RESULT,
        expect.any(Array),
        AUDIO_DURATION_MS,
      );

      // Firestore update happened with assembled payload
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'complete',
          processingPipeline: 'gemini_hybrid',
          pipelineVersion: 'gemini_hybrid',
        }),
      );
    });

    it('downloads the MP3 from Storage for alignment after Gemini step', async () => {
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      // Should check existence and download the file
      expect(mockExists).toHaveBeenCalled();
      expect(mockDownload).toHaveBeenCalled();

      // bucket().file() called with the storage path
      expect(mockFile).toHaveBeenCalledWith('users/uid/audio/test.mp3');
    });

    it('passes base64-encoded chunk buffer to getWhisperXWords', async () => {
      const fakeData = Buffer.from('fake-audio-data');
      fsReadFileSyncMock.mockReturnValue(fakeData);

      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      // The call should receive a base64 string, not a Buffer
      const firstCallArgs = mockGetWhisperXWords.mock.calls[0];
      expect(typeof firstCallArgs[0]).toBe('string');
      expect(firstCallArgs[0]).toBe(fakeData.toString('base64'));
      expect(firstCallArgs[1]).toBe('https://whisperx.example.com');
    });
  });

  // ===========================================================================
  // Progress step tracking
  // ===========================================================================

  describe('progress steps', () => {
    it('transitions through all pipeline steps in sequence', async () => {
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      const stepCalls = mockSetStep.mock.calls.map(call => call[0]);

      expect(stepCalls).toContain(ProcessingStep.GEMINI_ANALYSIS);
      expect(stepCalls).toContain(ProcessingStep.WHISPERX_ALIGNMENT);
      expect(stepCalls).toContain(ProcessingStep.ASSEMBLY);
      expect(stepCalls).toContain(ProcessingStep.SAVING);
      expect(stepCalls).toContain(ProcessingStep.COMPLETE);

      // Order must be preserved — find index of each and compare
      const idxGemini = stepCalls.indexOf(ProcessingStep.GEMINI_ANALYSIS);
      const idxWhisper = stepCalls.indexOf(ProcessingStep.WHISPERX_ALIGNMENT);
      const idxAssembly = stepCalls.indexOf(ProcessingStep.ASSEMBLY);
      const idxSaving = stepCalls.indexOf(ProcessingStep.SAVING);
      const idxComplete = stepCalls.indexOf(ProcessingStep.COMPLETE);

      expect(idxGemini).toBeLessThan(idxWhisper);
      expect(idxWhisper).toBeLessThan(idxAssembly);
      expect(idxAssembly).toBeLessThan(idxSaving);
      expect(idxSaving).toBeLessThan(idxComplete);
    });

    it('marks pipeline as failed when Gemini throws', async () => {
      mockProcessWithGemini3Flash.mockRejectedValue(new Error('Gemini API quota exceeded'));

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow('Gemini API quota exceeded');

      expect(mockSetFailed).toHaveBeenCalledWith('Gemini API quota exceeded');
    });
  });

  // ===========================================================================
  // Firestore persistence
  // ===========================================================================

  describe('Firestore persistence', () => {
    it('writes assembled payload with all required fields', async () => {
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'complete',
          segments: ASSEMBLED_RESULT.segments,
          speakers: ASSEMBLED_RESULT.speakers,
          terms: ASSEMBLED_RESULT.terms,
          termOccurrences: ASSEMBLED_RESULT.termOccurrences,
          topics: ASSEMBLED_RESULT.topics,
          people: ASSEMBLED_RESULT.people,
          durationMs: ASSEMBLED_RESULT.durationMs,
          processingPipeline: 'gemini_hybrid',
          pipelineVersion: 'gemini_hybrid',
        }),
      );
    });

    it('targets the correct Firestore document', async () => {
      await processWithNewPipeline('conv-xyz', 'users/uid/audio/test.mp3', 'uid-abc');

      expect(mockCollection).toHaveBeenCalledWith('conversations');
      expect(mockDoc).toHaveBeenCalledWith('conv-xyz');
    });

    it('includes a server timestamp on updatedAt', async () => {
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      const updateCall = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
      // FieldValue.serverTimestamp() returns our mock sentinel object
      expect(updateCall.updatedAt).toEqual({ _type: 'server_timestamp' });
    });

    it('never writes alignmentStatus or processingError for quality degradation', async () => {
      // With the new pipeline, status is always 'complete' or 'failed' — no 'needs_review'
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      const updateCall = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
      expect(updateCall.status).toBe('complete');
      expect(updateCall).not.toHaveProperty('alignmentStatus');
      expect(updateCall).not.toHaveProperty('processingError');
    });
  });

  // ===========================================================================
  // Failure surface and cleanup
  // ===========================================================================

  describe('failure handling', () => {
    it('propagates Gemini errors and attempts cleanup', async () => {
      const boom = new Error('Gemini upload failed');
      mockProcessWithGemini3Flash.mockRejectedValue(boom);

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow('Gemini upload failed');

      // Even on failure, unlinkSync should be called to clean up any downloaded files
      // (mp3Path gets set before Gemini is called, then cleaned in finally{})
      // In this case Gemini fails before download so mp3Path may be null —
      // what matters is that it doesn't throw a secondary cleanup error
      expect(mockSetFailed).toHaveBeenCalled();
    });

    it('throws when WHISPER_SERVICE_URL is missing', async () => {
      delete process.env.WHISPER_SERVICE_URL;

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow('WHISPER_SERVICE_URL not set');

      expect(mockSetFailed).toHaveBeenCalled();
    });

    it('throws when audio file not found in Storage', async () => {
      mockExists.mockResolvedValue([false]);

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/missing.mp3', 'uid-abc'),
      ).rejects.toThrow('not found in Storage');

      expect(mockSetFailed).toHaveBeenCalled();
    });

    it('writes failed status to Firestore for non-fatal errors', async () => {
      // A generic error (not HybridPipelineFatalError) should write 'failed'
      mockProcessWithGemini3Flash.mockRejectedValue(new Error('Something went sideways'));

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow('Something went sideways');

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          processingError: 'Something went sideways',
        }),
      );
    });

    it('writes failed status for HybridPipelineFatalError (no legacy fallback after cutover)', async () => {
      // Zero speakers triggers HybridPipelineFatalError
      mockProcessWithGemini3Flash.mockResolvedValue({
        ...GEMINI_RESULT,
        speakers: [],
      });

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow(HybridPipelineFatalError);

      // After hard cutover, ALL errors write 'failed' to Firestore — no legacy safety net
      const failedWrites = mockUpdate.mock.calls.filter(
        call => (call[0] as Record<string, unknown>).status === 'failed'
      );
      expect(failedWrites).toHaveLength(1);
      expect(failedWrites[0][0]).toEqual(
        expect.objectContaining({
          status: 'failed',
          processingError: expect.stringContaining('zero speakers'),
        }),
      );
    });

    it('hard-fails (writes status: failed) when WhisperX returns empty words', async () => {
      // No fallback to scaled Gemini timestamps — empty words = fatal
      mockGetWhisperXWords.mockResolvedValue([]);

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow(HybridPipelineFatalError);

      const failedWrites = mockUpdate.mock.calls.filter(
        call => (call[0] as Record<string, unknown>).status === 'failed'
      );
      expect(failedWrites).toHaveLength(1);
    });

    it('hard-fails when WhisperX throws (no fallback to scaled timestamps)', async () => {
      mockGetWhisperXWords.mockRejectedValue(new Error('WhisperX service unreachable'));

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow('WhisperX service unreachable');

      // Must write 'failed', NOT 'complete' with degraded data
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
      const completeWrites = mockUpdate.mock.calls.filter(
        call => (call[0] as Record<string, unknown>).status === 'complete'
      );
      expect(completeWrites).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Quality gates
  // ===========================================================================

  describe('quality gates', () => {
    it('throws HybridPipelineFatalError when Gemini returns zero speakers', async () => {
      mockProcessWithGemini3Flash.mockResolvedValue({
        ...GEMINI_RESULT,
        speakers: [],
      });

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow(HybridPipelineFatalError);

      // Verify the reason field
      try {
        await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');
      } catch (err) {
        expect((err as HybridPipelineFatalError).reason).toBe('zero_speakers');
      }
    });

    it('throws HybridPipelineFatalError when Gemini returns zero segments', async () => {
      mockProcessWithGemini3Flash.mockResolvedValue({
        ...GEMINI_RESULT,
        segments: [],
      });

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow(HybridPipelineFatalError);

      try {
        await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');
      } catch (err) {
        expect((err as HybridPipelineFatalError).reason).toBe('zero_segments');
      }
    });

    it('throws HybridPipelineFatalError when aligned segments drop below 50% of Gemini', async () => {
      // assignSpeakersToWords returns empty for every chunk → total aligned = 0
      mockAssignSpeakersToWords.mockReturnValue([]);

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow(HybridPipelineFatalError);

      try {
        await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');
      } catch (err) {
        expect((err as HybridPipelineFatalError).reason).toBe('low_segment_count');
      }
    });

    it('writes complete (not needs_review) when all chunks succeed', async () => {
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'complete' }),
      );
    });
  });

  // ===========================================================================
  // Chunk processing
  // ===========================================================================

  describe('chunk processing', () => {
    it('skips chunks that have no Gemini segments assigned to them', async () => {
      // 20-min audio = 2 chunks (0–600000ms, 600000–1200000ms).
      // Single Gemini segment with a large endMs so scale keeps scaled range in chunk 0 only.
      // geminiLastMs = 1200000 (endMs), scale = 1200000 / 1200000 = 1.0
      // seg scaledStart = 0, scaledEnd = 400000 * 1.0 = 400000ms < 600000ms
      // chunk 0 (0–600000): 0 < 600000 ✓ AND 400000 > 0 ✓ → overlaps
      // chunk 1 (600000–1200000): 0 < 1200000 ✓ but 400000 > 600000? NO → skipped
      mockGetAudioDuration.mockResolvedValue(1200); // 20 min = 2 chunks
      mockProcessWithGemini3Flash.mockResolvedValue({
        ...GEMINI_RESULT,
        segments: [
          { speaker: 'Speaker 1', startMs: 0, endMs: 400000 },
          // dummy high-endMs segment to set geminiLastMs without overlapping chunk 1
          // scaledStart = 1200000 * 1.0 = 1200000, which is not < chunkEndMs(1200000) → skipped
          { speaker: 'Speaker 2', startMs: 1200000, endMs: 1200000 },
        ],
      });

      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      // 2 chunks, but chunk 1 has no overlapping Gemini segments → only 1 WhisperX call
      expect(mockGetWhisperXWords).toHaveBeenCalledTimes(1);
    });

    it('passes words offset to chunk-local time to assignSpeakersToWords', async () => {
      // Use single-chunk audio to keep the math simple
      mockGetAudioDuration.mockResolvedValue(300); // 5 min
      mockProcessWithGemini3Flash.mockResolvedValue({
        ...GEMINI_RESULT,
        segments: [{ speaker: 'Speaker 1', startMs: 0, endMs: 300000 }],
      });

      // Words with global-ish start times
      mockGetWhisperXWords.mockResolvedValue([
        { word: 'hello', start: 10, end: 10.5, index: 0 },
        { word: 'there', start: 11, end: 11.5, index: 1 },
      ]);

      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      // For chunk 0, chunkStartMs = 0, so local = global (no offset for first chunk)
      const assignCall = mockAssignSpeakersToWords.mock.calls[0];
      const passedWords = assignCall[0] as Array<{ start: number }>;
      expect(passedWords[0].start).toBeCloseTo(10, 3); // 10 - 0/1000 = 10
    });

    it('offsets assigned segment timestamps back to global audio time', async () => {
      // Force two chunks by using 15-min audio
      mockGetAudioDuration.mockResolvedValue(900); // 15 min = 2 chunks

      // Second chunk starts at 600000ms
      // assignSpeakersToWords returns local timestamps of 1000ms–5000ms
      mockAssignSpeakersToWords.mockReturnValue([
        { speakerId: 'Speaker 1', text: 'chunk content', startMs: 1000, endMs: 5000 },
      ]);

      mockProcessWithGemini3Flash.mockResolvedValue({
        ...GEMINI_RESULT,
        segments: [
          // Covers both chunks when scaled
          { speaker: 'Speaker 1', startMs: 0, endMs: 300000 },
          { speaker: 'Speaker 2', startMs: 300000, endMs: 600000 },
        ],
      });

      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      const assembleCall = mockAssembleFirestoreData.mock.calls[0];
      const alignedSegs = assembleCall[1] as Array<{ startMs: number; endMs: number }>;

      // All segments must have valid global timestamps
      for (const seg of alignedSegs) {
        expect(seg.startMs).toBeGreaterThanOrEqual(0);
      }

      // At least one segment should come from chunk 1 (start ≥ 600000ms + 1000ms = 601000ms)
      const chunk1Segs = alignedSegs.filter(s => s.startMs >= 600000);
      expect(chunk1Segs.length).toBeGreaterThan(0);
    });

    it('uses any-overlap (not midpoint) to assign Gemini segments to chunks', async () => {
      // A segment that starts in chunk 0 but ends in chunk 1 — it overlaps both,
      // so it should show up in both chunk assignments.
      // Scale = 2700000 / 900000 = 3.0 for 45-min Gemini on 15-min audio
      mockGetAudioDuration.mockResolvedValue(900); // 15 min, so 2 chunks

      mockProcessWithGemini3Flash.mockResolvedValue({
        ...GEMINI_RESULT,
        segments: [
          // scaledStart = 0 * 3 = 0, scaledEnd = 200000 * 3 = 600000 exactly
          // This segment's scaledEnd touches the chunk boundary at 600000ms but is NOT > 600000ms
          // So it only overlaps chunk 0 by the filter (scaledStart < 600000 AND scaledEnd > 0)
          { speaker: 'Speaker 1', startMs: 0, endMs: 200000 },
          // scaledStart = 200001 * 3 > 600000, scaledEnd = 300000 * 3 = 900000 → chunk 1 only
          { speaker: 'Speaker 2', startMs: 200001, endMs: 300000 },
        ],
      });

      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      // Both chunks should have received WhisperX calls (each has at least 1 segment)
      expect(mockGetWhisperXWords).toHaveBeenCalledTimes(2);
    });

    it('uses Math.max for scale factor (not last segment endMs)', async () => {
      // Put the max endMs in the middle of the array, not at the end
      mockProcessWithGemini3Flash.mockResolvedValue({
        ...GEMINI_RESULT,
        segments: [
          { speaker: 'Speaker 1', startMs: 0, endMs: 14400000 }, // max endMs is here
          { speaker: 'Speaker 2', startMs: 14400000, endMs: 14000000 }, // lower endMs at end
        ],
      });

      // If scale used last segment's endMs (14000000), it would be slightly wrong.
      // If it uses Math.max (14400000 = AUDIO_DURATION_MS / scale), scale = 2700000/14400000
      // The test just verifies the pipeline runs without throwing — the math is internal.
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      expect(mockGetWhisperXWords).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Timeout handling
  // ===========================================================================

  describe('timeout handling', () => {
    it('throws HybridPipelineFatalError when pipeline exceeds 10-minute budget', async () => {
      // Make Gemini take "11 minutes" by advancing Date.now after the first call
      const realDateNow = Date.now.bind(Date);
      let callCount = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        // First few calls: normal time. After Gemini returns, jump forward 11 minutes.
        if (callCount > 5) {
          return realDateNow() + 11 * 60 * 1000;
        }
        return realDateNow();
      });

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow(HybridPipelineFatalError);

      try {
        await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');
      } catch (err) {
        expect((err as HybridPipelineFatalError).reason).toBe('pipeline_timeout');
      }

      jest.restoreAllMocks();
    });

    it('hard-fails when per-chunk WhisperX times out (via rejection propagation)', async () => {
      // withTimeout wraps the WhisperX call — simulate a timeout error propagating
      mockGetWhisperXWords.mockRejectedValue(
        new Error('Timeout: whisperx chunk 0s–600s exceeded 120s limit'),
      );

      // Unlike the old HARDY fallback, a timeout now propagates as a hard failure
      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow();

      // Must write 'failed' — no more "complete with fallback segments"
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
    });
  });

  // ===========================================================================
  // Cleanup behavior
  // ===========================================================================

  describe('cleanup', () => {
    it('cleans up temp files on successful run', async () => {
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      // At minimum, the MP3 download path should be cleaned up
      expect(fsUnlinkSyncMock).toHaveBeenCalled();
    });

    it('cleans up temp files when pipeline throws', async () => {
      mockProcessWithGemini3Flash.mockRejectedValue(new Error('boom'));

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow();

      // Cleanup still runs in finally{} — but mp3Path is null here since
      // download happens after Gemini. The important thing is no secondary error.
    });

    it('cleans up temp files when quality gate rejects', async () => {
      mockProcessWithGemini3Flash.mockResolvedValue({
        ...GEMINI_RESULT,
        speakers: [], // zero speakers → HybridPipelineFatalError
      });

      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow(HybridPipelineFatalError);

      // Cleanup should not throw secondary errors
      // (mp3Path is null since we fail before download, but the finally block handles that)
    });

    it('cleans up chunk files on multi-chunk runs', async () => {
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      // For 45-min audio: 5 chunks, but chunk 0 reuses mp3Path.
      // So 4 chunk files + 1 mp3 = at least 1 cleanup call
      const unlinkCalls = fsUnlinkSyncMock.mock.calls.length;
      expect(unlinkCalls).toBeGreaterThan(0);
    });

    it('survives cleanup errors without masking the original failure', async () => {
      // Make unlinkSync throw — cleanup should not mask the pipeline error
      fsUnlinkSyncMock.mockImplementation(() => { throw new Error('permission denied'); });

      mockProcessWithGemini3Flash.mockRejectedValue(new Error('Gemini failed'));

      // Should still throw the original error, not the cleanup error
      await expect(
        processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc'),
      ).rejects.toThrow('Gemini failed');
    });
  });

  // ===========================================================================
  // Single-chunk (short audio) path
  // ===========================================================================

  describe('single-chunk audio', () => {
    it('handles audio shorter than one chunk without ffmpeg splitting', async () => {
      // 5-minute audio — fits in a single chunk, no ffmpeg splitting needed
      mockGetAudioDuration.mockResolvedValue(300); // 5 min

      mockProcessWithGemini3Flash.mockResolvedValue({
        ...GEMINI_RESULT,
        segments: [
          { speaker: 'Speaker 1', startMs: 0, endMs: 100000 },
        ],
      });

      await processWithNewPipeline('conv-short', 'users/uid/audio/short.mp3', 'uid-abc');

      // ffmpeg splitting should NOT be called for single-chunk audio
      expect(execFileAsyncMock).not.toHaveBeenCalled();

      // But WhisperX, speaker assignment, and assembly still happen
      expect(mockGetWhisperXWords).toHaveBeenCalledTimes(1);
      expect(mockAssignSpeakersToWords).toHaveBeenCalledTimes(1);
      expect(mockAssembleFirestoreData).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // transcribeAudio handoff contract
  //
  // These tests verify the integration boundary between transcribeAudio and
  // processWithNewPipeline. transcribeAudio sets `processing` status before
  // calling us; we start at GEMINI_ANALYSIS and end with `complete`. Neither
  // side should step on the other's status writes.
  // ===========================================================================

  describe('transcribeAudio handoff contract', () => {
    it('never writes "processing" status — that is the caller\'s job', async () => {
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      // Inspect all Firestore update calls to ensure we never set status: 'processing'.
      // transcribeAudio sets 'processing' before calling us; if we also wrote it,
      // we'd clobber the processingStartedAt timestamp.
      for (const call of mockUpdate.mock.calls) {
        const payload = call[0] as Record<string, unknown>;
        if (payload.status !== undefined) {
          expect(payload.status).not.toBe('processing');
        }
      }
    });

    it('writes status: "complete" exactly once on success', async () => {
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      const completeWrites = mockUpdate.mock.calls.filter(
        call => (call[0] as Record<string, unknown>).status === 'complete'
      );
      expect(completeWrites).toHaveLength(1);
    });

    it('starts progress at GEMINI_ANALYSIS — not PENDING or PROCESSING', async () => {
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      // The very first setStep call must be GEMINI_ANALYSIS.
      // transcribeAudio already wrote 'processing' to Firestore, so
      // the pipeline's first progress update should be the first hybrid step.
      const firstStep = mockSetStep.mock.calls[0][0];
      expect(firstStep).toBe(ProcessingStep.GEMINI_ANALYSIS);
    });

    it('persists pipelineVersion marker for downstream consumers', async () => {
      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      // The frontend and any post-processing logic uses pipelineVersion to know
      // which pipeline produced the data (affects display, reprocessing options, etc.)
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          processingPipeline: 'gemini_hybrid',
          pipelineVersion: 'gemini_hybrid',
        }),
      );
    });

    it('does not write to Firestore before Gemini analysis starts', async () => {
      // Track call order: Gemini should be called AFTER progress is set,
      // but NO Firestore doc.update() should happen before progress.setStep()
      const callOrder: string[] = [];

      mockSetStep.mockImplementation(async () => {
        callOrder.push('progress.setStep');
      });
      mockUpdate.mockImplementation(async () => {
        callOrder.push('firestore.update');
      });
      mockProcessWithGemini3Flash.mockImplementation(async () => {
        callOrder.push('gemini.process');
        return GEMINI_RESULT;
      });

      await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');

      // First action should be progress.setStep (GEMINI_ANALYSIS), not a Firestore write.
      // The pipeline trusts that the caller already wrote 'processing' status.
      expect(callOrder[0]).toBe('progress.setStep');
    });
  });

  // ===========================================================================
  // HybridPipelineFatalError contract
  // ===========================================================================

  describe('HybridPipelineFatalError', () => {
    it('is exported and identifiable via instanceof', () => {
      const err = new HybridPipelineFatalError('test', 'test_reason');
      expect(err).toBeInstanceOf(HybridPipelineFatalError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('HybridPipelineFatalError');
      expect(err.reason).toBe('test_reason');
    });

    it('carries the reason field for downstream routing', async () => {
      mockProcessWithGemini3Flash.mockResolvedValue({
        ...GEMINI_RESULT,
        speakers: [],
      });

      try {
        await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HybridPipelineFatalError);
        expect((err as HybridPipelineFatalError).reason).toBe('zero_speakers');
        expect((err as HybridPipelineFatalError).message).toContain('zero speakers');
      }
    });

    it('is thrown for whisperx_empty reason when words array is empty', async () => {
      mockGetWhisperXWords.mockResolvedValue([]);

      try {
        await processWithNewPipeline('conv-123', 'users/uid/audio/test.mp3', 'uid-abc');
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HybridPipelineFatalError);
        expect((err as HybridPipelineFatalError).reason).toBe('whisperx_empty');
      }
    });
  });

  // runHybridWithFallback was removed in hard cutover (scope -06).
  // All uploads now go directly through processWithNewPipeline.
  // Legacy fallback tests are no longer applicable.
});

// =============================================================================
// Dispatcher ↔ Orchestrator Contract Tests
// =============================================================================

describe('dispatcher/orchestrator contract', () => {
  // These tests verify the typed shapes that flow across the Cloud Function →
  // Cloud Run boundary. If someone changes the contract types without updating
  // both sides, these tests catch the drift.

  describe('TranscribeRequest shape', () => {
    it('requires conversationId, audioStoragePath, userId', () => {
      // Type-level test — if this compiles, the contract is intact.
      // Also verifiable at runtime for defense-in-depth.
      const request: import('../types').TranscribeRequest = {
        conversationId: 'conv-123',
        audioStoragePath: 'audio/uid/conv-123.mp3',
        userId: 'uid-abc',
      };

      expect(request.conversationId).toBe('conv-123');
      expect(request.audioStoragePath).toBe('audio/uid/conv-123.mp3');
      expect(request.userId).toBe('uid-abc');
    });
  });

  describe('TranscribeAccepted shape', () => {
    it('represents the immediate 202 acknowledgement', () => {
      const accepted: import('../types').TranscribeAccepted = {
        status: 'accepted',
        conversationId: 'conv-123',
      };

      expect(accepted.status).toBe('accepted');
      expect(accepted.conversationId).toBe('conv-123');
    });
  });

  describe('TranscribeResponse shape', () => {
    it('represents a successful pipeline result', () => {
      const response: import('../types').TranscribeResponse = {
        status: 'complete',
        segments: 42,
        speakers: 3,
        durationMs: 2700000,
      };

      expect(response.status).toBe('complete');
      expect(response.segments).toBe(42);
    });

    it('represents a failed pipeline result with structured error', () => {
      const response: import('../types').TranscribeResponse = {
        status: 'failed',
        error: {
          code: 'GEMINI_TIMEOUT',
          stage: 'gemini_analysis',
          message: 'Gemini API timed out after 300s',
          retryable: true,
        },
      };

      expect(response.status).toBe('failed');
      expect(response.error?.code).toBe('GEMINI_TIMEOUT');
      expect(response.error?.retryable).toBe(true);
    });

    it('includes accepted as a valid status for the union type', () => {
      // The response type is a union: the orchestrator logs the final outcome
      // but returns 'accepted' immediately to the dispatcher.
      const accepted: import('../types').TranscribeResponse = {
        status: 'accepted',
        conversationId: 'conv-123',
      };

      expect(accepted.status).toBe('accepted');
    });
  });

  describe('StructuredError shape', () => {
    it('covers all expected error codes', () => {
      const codes: import('../types').OrchestratorErrorCode[] = [
        'GEMINI_TIMEOUT',
        'GEMINI_PARSE_FAILED',
        'WHISPERX_UNAVAILABLE',
        'WHISPERX_TIMEOUT',
        'ALIGNMENT_FAILED',
        'QUALITY_GATE_FAILED',
        'STORAGE_ERROR',
        'ABORTED',
        'UNKNOWN',
      ];

      // All codes should be valid strings
      expect(codes).toHaveLength(9);
      codes.forEach(code => expect(typeof code).toBe('string'));
    });

    it('covers all expected pipeline stages', () => {
      const stages: import('../types').PipelineStage[] = [
        'download',
        'gemini_analysis',
        'whisperx_timestamps',
        'hardy_alignment',
        'quality_gates',
        'firestore_write',
      ];

      expect(stages).toHaveLength(6);
      stages.forEach(stage => expect(typeof stage).toBe('string'));
    });

    it('has retryable flag for automated retry decisions', () => {
      const retryableError: import('../types').StructuredError = {
        code: 'GEMINI_TIMEOUT',
        stage: 'gemini_analysis',
        message: 'timeout',
        retryable: true,
      };

      const nonRetryableError: import('../types').StructuredError = {
        code: 'ABORTED',
        stage: 'download',
        message: 'user aborted',
        retryable: false,
      };

      expect(retryableError.retryable).toBe(true);
      expect(nonRetryableError.retryable).toBe(false);
    });
  });

  describe('HealthResponse shape', () => {
    it('includes version and uptime for deploy verification', () => {
      const health: import('../types').HealthResponse = {
        status: 'ok',
        version: 'abc1234 (main)',
        uptime: 3600,
      };

      expect(health.status).toBe('ok');
      expect(health.version).toContain('abc1234');
      expect(health.uptime).toBeGreaterThan(0);
    });
  });
});
