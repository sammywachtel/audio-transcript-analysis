/**
 * Unit tests for Gemini 3 Flash Pipeline Module
 *
 * Tests cover:
 * - Happy path with mocked Gemini API
 * - Cleanup behavior (success and failure paths)
 * - JSON truncation repair
 * - API failure handling
 */

// =============================================================================
// Mocks - Must be defined before imports
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

// Mock @ffmpeg-installer/ffmpeg
jest.mock('@ffmpeg-installer/ffmpeg', () => ({
  default: { path: '/mock/ffmpeg' },
}));

// Track execFile calls for verification
const execFileAsyncMock = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });

// Mock child_process
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

// Mock util promisify to return our controlled mock
jest.mock('util', () => {
  const actual = jest.requireActual('util');
  return {
    ...actual,
    promisify: jest.fn(() => execFileAsyncMock),
  };
});

// Track fs operations
const fsExistsSyncMock = jest.fn().mockReturnValue(true);
const fsUnlinkSyncMock = jest.fn();
const fsStatSyncMock = jest.fn().mockReturnValue({ size: 1024 * 1024 });

// Mock fs
jest.mock('fs', () => ({
  existsSync: (...args: unknown[]) => fsExistsSyncMock(...args),
  unlinkSync: (...args: unknown[]) => fsUnlinkSyncMock(...args),
  statSync: (...args: unknown[]) => fsStatSyncMock(...args),
}));

// Mock @google/genai
const mockFilesUpload = jest.fn();
const mockFilesGet = jest.fn();
const mockFilesDelete = jest.fn();
const mockGenerateContent = jest.fn();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    files: {
      upload: mockFilesUpload,
      get: mockFilesGet,
      delete: mockFilesDelete,
    },
    models: {
      generateContent: mockGenerateContent,
    },
  })),
  createPartFromUri: jest.fn((uri, mimeType) => ({ uri, mimeType })),
}));

// Mock firestoreUtils — sanitizeForFirestore is pure but we mock to avoid
// transitive import chains. Faithful reimplementation keeps tests honest.
jest.mock('../firestoreUtils', () => {
  function sanitize(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(sanitize);
    if (typeof obj === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (v !== undefined) out[k] = sanitize(v);
      }
      return out;
    }
    return obj;
  }
  return { sanitizeForFirestore: sanitize };
});

// Import after mocks are set up
import {
  processWithGemini3Flash,
  parseGeminiJson,
  GeminiPipelineError,
  assembleFirestoreData,
  GeminiPipelineResult,
  AlignedSegment,
} from '../gemini3Pipeline';

// =============================================================================
// Test Fixtures
// =============================================================================

const VALID_GEMINI_RESPONSE = {
  speakers: [
    { label: 'Speaker 1', name: 'Alice', role: 'presenter' },
    { label: 'Speaker 2', name: 'Bob', role: 'questioner' },
  ],
  segments: [
    { speaker: 'Speaker 1', text: 'Hello everyone', startMs: 0, endMs: 5000 },
    { speaker: 'Speaker 2', text: 'Hi Alice', startMs: 5000, endMs: 7000 },
    { speaker: 'Speaker 1', text: 'Let me explain', startMs: 7000, endMs: 15000 },
  ],
  terms: [
    { key: 'ai', display: 'AI', definition: 'Artificial Intelligence', aliases: ['artificial intelligence'] },
  ],
  topics: [
    { title: 'Introduction', startApproxMs: 0, endApproxMs: 10000, type: 'main' as const },
  ],
  persons: [
    { name: 'Charlie', affiliation: 'Acme Corp' },
  ],
};

// =============================================================================
// Test Setup
// =============================================================================

describe('gemini3Pipeline', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset environment
    process.env = { ...originalEnv, GEMINI_API_KEY: 'test-api-key' }; // pragma: allowlist secret

    // Default mock implementations
    mockExists.mockResolvedValue([true]);
    mockDownload.mockResolvedValue(undefined);

    // Reset fs mocks
    fsStatSyncMock.mockReturnValue({ size: 1024 * 1024 }); // 1MB
    fsExistsSyncMock.mockReturnValue(true);
    fsUnlinkSyncMock.mockReturnValue(undefined);

    // Reset execFile mock
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

    // Default: file is already processed (ACTIVE state)
    mockFilesUpload.mockResolvedValue({
      name: 'files/test-file-123',
      uri: 'gs://gemini-files/test-file-123',
      mimeType: 'audio/wav',
      state: 'ACTIVE',
    });

    mockFilesGet.mockResolvedValue({ state: 'ACTIVE' });
    mockFilesDelete.mockResolvedValue(undefined);

    // Default: successful generation
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(VALID_GEMINI_RESPONSE),
      usageMetadata: {
        promptTokenCount: 1000,
        candidatesTokenCount: 500,
        totalTokenCount: 1500,
      },
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ===========================================================================
  // Happy Path Tests
  // ===========================================================================

  describe('happy path', () => {
    it('processes audio and returns structured result', async () => {
      const result = await processWithGemini3Flash('users/123/audio/test.mp3', {
        conversationId: 'conv-123',
      });

      // Verify structure
      expect(result.speakers).toHaveLength(2);
      expect(result.segments).toHaveLength(3);
      expect(result.terms).toHaveLength(1);
      expect(result.topics).toHaveLength(1);
      expect(result.persons).toHaveLength(1);

      // Verify content
      expect(result.speakers[0].name).toBe('Alice');
      expect(result.segments[0].text).toBe('Hello everyone');

      // Verify metadata
      expect(result.tokenUsage).toEqual({
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('downloads audio from correct Storage path', async () => {
      await processWithGemini3Flash('users/abc/audio/meeting.mp3');

      expect(mockFile).toHaveBeenCalledWith('users/abc/audio/meeting.mp3');
      expect(mockDownload).toHaveBeenCalled();
    });

    it('waits for file processing when state is PROCESSING', async () => {
      // First call returns PROCESSING, second returns ACTIVE
      mockFilesUpload.mockResolvedValue({
        name: 'files/test-file-123',
        uri: 'gs://gemini-files/test-file-123',
        mimeType: 'audio/wav',
        state: 'PROCESSING',
      });

      let getCallCount = 0;
      mockFilesGet.mockImplementation(() => {
        getCallCount++;
        return Promise.resolve({
          state: getCallCount >= 2 ? 'ACTIVE' : 'PROCESSING',
        });
      });

      const result = await processWithGemini3Flash('users/123/audio/test.mp3');

      expect(mockFilesGet).toHaveBeenCalled();
      expect(result.speakers).toHaveLength(2);
    });

    it('uses default model when not specified', async () => {
      await processWithGemini3Flash('users/123/audio/test.mp3');

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-3-flash-preview',
        })
      );
    });

    it('uses custom model when specified', async () => {
      await processWithGemini3Flash('users/123/audio/test.mp3', {
        model: 'gemini-4-flash',
      });

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-4-flash',
        })
      );
    });
  });

  // ===========================================================================
  // Cleanup Behavior Tests
  // ===========================================================================

  describe('cleanup behavior', () => {
    it('cleans up Gemini file after successful processing', async () => {
      await processWithGemini3Flash('users/123/audio/test.mp3');

      expect(mockFilesDelete).toHaveBeenCalledWith({ name: 'files/test-file-123' });
    });

    it('cleans up local temp files after successful processing', async () => {
      await processWithGemini3Flash('users/123/audio/test.mp3');

      // Should try to clean up both mp3 and wav temp files
      expect(fsUnlinkSyncMock).toHaveBeenCalled();
    });

    it('cleans up Gemini file even when generation fails', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Generation failed'));

      await expect(processWithGemini3Flash('users/123/audio/test.mp3'))
        .rejects.toThrow(GeminiPipelineError);

      expect(mockFilesDelete).toHaveBeenCalledWith({ name: 'files/test-file-123' });
    });

    it('cleans up local files even when generation fails', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Generation failed'));

      await expect(processWithGemini3Flash('users/123/audio/test.mp3'))
        .rejects.toThrow(GeminiPipelineError);

      expect(fsUnlinkSyncMock).toHaveBeenCalled();
    });

    it('continues cleanup even if Gemini file deletion fails', async () => {
      mockFilesDelete.mockRejectedValue(new Error('Delete failed'));

      // Should not throw — cleanup failure is non-fatal
      const result = await processWithGemini3Flash('users/123/audio/test.mp3');

      expect(result.speakers).toHaveLength(2);
      expect(fsUnlinkSyncMock).toHaveBeenCalled(); // Local cleanup still runs
    });

    it('continues cleanup even if local file deletion fails', async () => {
      fsUnlinkSyncMock.mockImplementation(() => {
        throw new Error('Cannot delete file');
      });

      // Should not throw — cleanup failure is non-fatal
      const result = await processWithGemini3Flash('users/123/audio/test.mp3');

      expect(result.speakers).toHaveLength(2);
    });
  });

  // ===========================================================================
  // JSON Truncation Repair Tests
  // ===========================================================================

  describe('parseGeminiJson', () => {
    it('parses valid JSON', () => {
      const json = JSON.stringify(VALID_GEMINI_RESPONSE);
      const result = parseGeminiJson(json);

      expect(result.speakers).toHaveLength(2);
      expect(result.segments).toHaveLength(3);
    });

    it('strips markdown code fences', () => {
      const json = '```json\n' + JSON.stringify(VALID_GEMINI_RESPONSE) + '\n```';
      const result = parseGeminiJson(json);

      expect(result.speakers).toHaveLength(2);
    });

    it('repairs truncated JSON at object boundary', () => {
      // Simulate truncation after second segment
      const truncated = `{
        "speakers": [
          {"label": "Speaker 1", "name": "Alice"}
        ],
        "segments": [
          {"speaker": "Speaker 1", "text": "Hello", "startMs": 0, "endMs": 5000},
          {"speaker": "Speaker 1", "text": "World", "startMs": 5000, "endMs": 10000},`;
      // Missing: closing brackets and remaining fields

      const result = parseGeminiJson(truncated);

      expect(result.speakers).toHaveLength(1);
      expect(result.segments).toHaveLength(2);
    });

    it('repairs JSON cut off after last complete object in array', () => {
      // More realistic truncation — cut in the middle of the next object
      const truncated = `{
        "speakers": [{"label": "Speaker 1", "name": "Alice"}],
        "segments": [
          {"speaker": "Speaker 1", "text": "First", "startMs": 0, "endMs": 1000},
          {"speaker": "Speaker 1", "text": "Second", "startMs": 1000, "endMs": 2000}
        ],
        "terms": [{"key": "test", "display": "Test", "definition": "A test"},
          {"key": "incomplete", "display": "Inc`;
      // Cut off mid-string

      const result = parseGeminiJson(truncated);

      expect(result.speakers).toHaveLength(1);
      expect(result.segments).toHaveLength(2);
      expect(result.terms).toHaveLength(1); // Only first complete term
    });

    it('throws GeminiPipelineError for completely invalid JSON', () => {
      expect(() => parseGeminiJson('not json at all'))
        .toThrow(GeminiPipelineError);

      try {
        parseGeminiJson('not json at all');
        fail('Expected GeminiPipelineError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GeminiPipelineError);
        expect((err as GeminiPipelineError).code).toBe('PARSE_FAILED');
      }
    });

    it('handles empty arrays gracefully', () => {
      const json = JSON.stringify({
        speakers: [],
        segments: [],
        terms: [],
        topics: [],
        persons: [],
      });

      const result = parseGeminiJson(json);

      expect(result.speakers).toHaveLength(0);
      expect(result.segments).toHaveLength(0);
    });
  });

  // ===========================================================================
  // API Failure Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    it('throws DOWNLOAD_FAILED when audio not found in Storage', async () => {
      mockExists.mockResolvedValue([false]);

      await expect(processWithGemini3Flash('users/123/audio/missing.mp3'))
        .rejects.toThrow(GeminiPipelineError);

      await expect(processWithGemini3Flash('users/123/audio/missing.mp3'))
        .rejects.toMatchObject({
          code: 'DOWNLOAD_FAILED',
        });
    });

    it('throws UPLOAD_FAILED when Gemini file upload fails', async () => {
      mockFilesUpload.mockRejectedValue(new Error('Upload error'));

      await expect(processWithGemini3Flash('users/123/audio/test.mp3'))
        .rejects.toMatchObject({
          code: 'UPLOAD_FAILED',
        });
    });

    it('throws PROCESSING_FAILED when Gemini file processing fails', async () => {
      mockFilesUpload.mockResolvedValue({
        name: 'files/test',
        uri: 'gs://test',
        mimeType: 'audio/wav',
        state: 'FAILED',
      });

      await expect(processWithGemini3Flash('users/123/audio/test.mp3'))
        .rejects.toMatchObject({
          code: 'PROCESSING_FAILED',
        });
    });

    it('throws TIMEOUT when file processing takes too long', async () => {
      jest.useFakeTimers();

      mockFilesUpload.mockResolvedValue({
        name: 'files/test',
        uri: 'gs://test',
        mimeType: 'audio/wav',
        state: 'PROCESSING',
      });

      // Always return PROCESSING
      mockFilesGet.mockResolvedValue({ state: 'PROCESSING' });

      let caughtError: GeminiPipelineError | null = null;

      const promise = processWithGemini3Flash('users/123/audio/test.mp3').catch(err => {
        caughtError = err as GeminiPipelineError;
      });

      // Advance through all polling attempts (60 attempts * 2s each = 120s)
      for (let i = 0; i < 62; i++) {
        await jest.advanceTimersByTimeAsync(2000);
      }

      await promise;

      expect(caughtError).not.toBeNull();
      expect(caughtError!.code).toBe('TIMEOUT');

      jest.useRealTimers();
    });

    it('throws QUOTA_EXCEEDED for quota errors', async () => {
      mockGenerateContent.mockRejectedValue(new Error('RESOURCE_EXHAUSTED: quota exceeded'));

      await expect(processWithGemini3Flash('users/123/audio/test.mp3'))
        .rejects.toMatchObject({
          code: 'QUOTA_EXCEEDED',
        });
    });

    it('throws GENERATION_FAILED for other generation errors', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Unknown API error'));

      await expect(processWithGemini3Flash('users/123/audio/test.mp3'))
        .rejects.toMatchObject({
          code: 'GENERATION_FAILED',
        });
    });

    it('throws GENERATION_FAILED when API key missing', async () => {
      delete process.env.GEMINI_API_KEY;

      await expect(processWithGemini3Flash('users/123/audio/test.mp3'))
        .rejects.toMatchObject({
          code: 'GENERATION_FAILED',
          message: expect.stringContaining('GEMINI_API_KEY'),
        });
    });

    it('throws PARSE_FAILED when response is unparseable', async () => {
      mockGenerateContent.mockResolvedValue({
        text: 'totally not json {{{',
        usageMetadata: {},
      });

      await expect(processWithGemini3Flash('users/123/audio/test.mp3'))
        .rejects.toMatchObject({
          code: 'PARSE_FAILED',
        });
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('handles response with markdown fences', async () => {
      mockGenerateContent.mockResolvedValue({
        text: '```json\n' + JSON.stringify(VALID_GEMINI_RESPONSE) + '\n```',
        usageMetadata: { totalTokenCount: 100 },
      });

      const result = await processWithGemini3Flash('users/123/audio/test.mp3');

      expect(result.speakers).toHaveLength(2);
    });

    it('handles response without token metadata', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify(VALID_GEMINI_RESPONSE),
        // No usageMetadata
      });

      const result = await processWithGemini3Flash('users/123/audio/test.mp3');

      expect(result.tokenUsage).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
    });

    it('handles missing optional fields in response', async () => {
      const minimalResponse = {
        speakers: [{ label: 'Speaker 1', name: 'Test' }],
        segments: [],
        terms: [],
        topics: [],
        persons: [],
      };

      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify(minimalResponse),
        usageMetadata: {},
      });

      const result = await processWithGemini3Flash('users/123/audio/test.mp3');

      expect(result.speakers[0].role).toBeUndefined();
    });
  });

  // ===========================================================================
  // Firestore Assembly Tests
  // ===========================================================================

  describe('assembleFirestoreData', () => {
    // Shared fixture: a small but realistic Gemini result
    const GEMINI: GeminiPipelineResult = {
      speakers: [
        { label: 'Speaker 1', name: 'Alice', role: 'presenter' },
        { label: 'Speaker 2', name: 'Bob' },
      ],
      segments: [
        { speaker: 'Speaker 1', text: 'Welcome to the AI workshop', startMs: 0, endMs: 8000 },
        { speaker: 'Speaker 2', text: 'Thanks Alice', startMs: 8000, endMs: 11000 },
        { speaker: 'Speaker 1', text: 'Let me explain the ROI of machine learning', startMs: 11000, endMs: 24000 },
      ],
      terms: [
        { key: 'ai', display: 'AI', definition: 'Artificial Intelligence', aliases: ['artificial intelligence'] },
        { key: 'machine_learning', display: 'machine learning', definition: 'A branch of AI', aliases: ['ML'] },
        { key: 'roi', display: 'ROI', definition: 'Return on Investment', aliases: [] },
      ],
      topics: [
        { title: 'Introduction', startApproxMs: 0, endApproxMs: 11000, type: 'main' },
        { title: 'ML Benefits', startApproxMs: 11000, endApproxMs: 24000, type: 'main' },
      ],
      persons: [
        { name: 'Charlie', affiliation: 'Acme Corp' },
      ],
    };

    // HARDY-aligned segments: same text/speakers but with precise timestamps
    const ALIGNED: AlignedSegment[] = [
      { speakerId: 'Speaker 1', text: 'Welcome to the AI workshop', startMs: 0, endMs: 4800 },
      { speakerId: 'Speaker 2', text: 'Thanks Alice', startMs: 5100, endMs: 6900 },
      { speakerId: 'Speaker 1', text: 'Let me explain the ROI of machine learning', startMs: 7200, endMs: 14500 },
    ];

    const DURATION_MS = 15000;

    // -------------------------------------------------------------------------
    // Schema shape
    // -------------------------------------------------------------------------

    describe('schema shape', () => {
      it('returns all required Conversation payload fields', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        expect(result).toHaveProperty('speakers');
        expect(result).toHaveProperty('segments');
        expect(result).toHaveProperty('terms');
        expect(result).toHaveProperty('termOccurrences');
        expect(result).toHaveProperty('topics');
        expect(result).toHaveProperty('people');
        expect(result).toHaveProperty('durationMs');
      });

      it('uses correct ID prefixes', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        // Speakers: speaker_N
        const speakerIds = Object.keys(result.speakers);
        speakerIds.forEach(id => expect(id).toMatch(/^speaker_\d+$/));

        // Segments: seg_N
        result.segments.forEach(s => expect(s.segmentId).toMatch(/^seg_\d+$/));

        // Terms: t_N
        Object.keys(result.terms).forEach(id => expect(id).toMatch(/^t_\d+$/));

        // Occurrences: occ_N
        result.termOccurrences.forEach(o => expect(o.occurrenceId).toMatch(/^occ_\d+$/));

        // Topics: top_N
        result.topics.forEach(t => expect(t.topicId).toMatch(/^top_\d+$/));

        // People: p_N
        result.people.forEach(p => expect(p.personId).toMatch(/^p_\d+$/));
      });

      it('preserves durationMs pass-through', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, 42000);
        expect(result.durationMs).toBe(42000);
      });
    });

    // -------------------------------------------------------------------------
    // Speaker assembly
    // -------------------------------------------------------------------------

    describe('speaker assembly', () => {
      it('maps Gemini labels to sequential canonical IDs', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        expect(result.speakers['speaker_0']).toBeDefined();
        expect(result.speakers['speaker_1']).toBeDefined();
        expect(Object.keys(result.speakers)).toHaveLength(2);
      });

      it('builds displayName from name and role', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        // Alice has role "presenter"
        expect(result.speakers['speaker_0'].displayName).toBe('Alice (presenter)');
        // Bob has no role
        expect(result.speakers['speaker_1'].displayName).toBe('Bob');
      });

      it('assigns sequential colorIndex values', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        expect(result.speakers['speaker_0'].colorIndex).toBe(0);
        expect(result.speakers['speaker_1'].colorIndex).toBe(1);
      });

      it('creates deterministic fallback for unmapped speaker labels', () => {
        const alignedWithMystery: AlignedSegment[] = [
          ...ALIGNED,
          { speakerId: 'Mystery Voice', text: 'Who am I?', startMs: 15000, endMs: 16000 },
        ];

        const result = assembleFirestoreData(GEMINI, alignedWithMystery, DURATION_MS);

        // Should create a fallback speaker
        const fallbackId = 'speaker_unmapped_mystery_voice';
        expect(result.speakers[fallbackId]).toBeDefined();
        expect(result.speakers[fallbackId].displayName).toBe('Mystery Voice');

        // Last segment should reference the fallback
        const lastSeg = result.segments[result.segments.length - 1];
        expect(lastSeg.speakerId).toBe(fallbackId);
      });

      it('reuses same fallback ID for repeated unknown labels', () => {
        const alignedWithDupes: AlignedSegment[] = [
          { speakerId: 'Ghost', text: 'Boo', startMs: 0, endMs: 1000 },
          { speakerId: 'Ghost', text: 'Boo again', startMs: 1000, endMs: 2000 },
        ];

        const result = assembleFirestoreData(GEMINI, alignedWithDupes, DURATION_MS);

        // Both segments should reference the same fallback speaker
        expect(result.segments[0].speakerId).toBe(result.segments[1].speakerId);
        // Only one fallback speaker created
        const unmappedSpeakers = Object.keys(result.speakers).filter(k => k.includes('unmapped'));
        expect(unmappedSpeakers).toHaveLength(1);
      });
    });

    // -------------------------------------------------------------------------
    // Segment assembly
    // -------------------------------------------------------------------------

    describe('segment assembly', () => {
      it('uses aligned timestamps, not Gemini timestamps', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        // Aligned timestamps differ from Gemini's
        expect(result.segments[0].endMs).toBe(4800); // not 8000
        expect(result.segments[1].startMs).toBe(5100); // not 8000
      });

      it('generates sequential segment IDs and indices', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        result.segments.forEach((seg, i) => {
          expect(seg.segmentId).toBe(`seg_${i}`);
          expect(seg.index).toBe(i);
        });
      });

      it('every segment references a valid speaker record', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        for (const seg of result.segments) {
          expect(result.speakers[seg.speakerId]).toBeDefined();
        }
      });
    });

    // -------------------------------------------------------------------------
    // Term occurrence matching
    // -------------------------------------------------------------------------

    describe('term occurrence matching', () => {
      it('finds term display name in segment text', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        // "AI" appears in "Welcome to the AI workshop"
        const aiOccs = result.termOccurrences.filter(o => result.terms[o.termId]?.display === 'AI');
        expect(aiOccs.length).toBeGreaterThanOrEqual(1);
      });

      it('finds alias matches', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        // "machine learning" is the display, "ML" is an alias
        // "machine learning" appears in segment 2
        const mlOccs = result.termOccurrences.filter(o =>
          result.terms[o.termId]?.key === 'machine_learning'
        );
        expect(mlOccs.length).toBeGreaterThanOrEqual(1);
      });

      it('respects word boundaries — no substring matches', () => {
        // "AI" should NOT match inside "RAIN"
        const gemini: GeminiPipelineResult = {
          speakers: [{ label: 'Speaker 1', name: 'Test' }],
          segments: [{ speaker: 'Speaker 1', text: 'test', startMs: 0, endMs: 1000 }],
          terms: [{ key: 'ai', display: 'AI', definition: 'Artificial Intelligence', aliases: [] }],
          topics: [],
          persons: [],
        };
        const aligned: AlignedSegment[] = [
          { speakerId: 'Speaker 1', text: 'It was RAINING and the BRAIN was working', startMs: 0, endMs: 1000 },
        ];

        const result = assembleFirestoreData(gemini, aligned, 1000);

        // No occurrences — "AI" inside "RAINING" and "BRAIN" are not word-bounded
        const aiOccs = result.termOccurrences.filter(o => result.terms[o.termId]?.display === 'AI');
        expect(aiOccs).toHaveLength(0);
      });

      it('records correct startChar/endChar offsets', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        // "ROI" in "Let me explain the ROI of machine learning"
        const roiOccs = result.termOccurrences.filter(o => result.terms[o.termId]?.display === 'ROI');
        expect(roiOccs.length).toBeGreaterThanOrEqual(1);

        const roiOcc = roiOccs[0];
        const segText = result.segments.find(s => s.segmentId === roiOcc.segmentId)!.text;
        const extracted = segText.substring(roiOcc.startChar, roiOcc.endChar);
        expect(extracted).toBe('ROI');
      });

      it('generates sequential occurrence IDs', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        result.termOccurrences.forEach((occ, i) => {
          expect(occ.occurrenceId).toBe(`occ_${i}`);
        });
      });

      it('handles terms with no aliases', () => {
        // "ROI" has aliases: [] — should still match
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);
        const roiOccs = result.termOccurrences.filter(o => result.terms[o.termId]?.display === 'ROI');
        expect(roiOccs.length).toBeGreaterThanOrEqual(1);
      });
    });

    // -------------------------------------------------------------------------
    // Topic assembly
    // -------------------------------------------------------------------------

    describe('topic assembly', () => {
      it('produces valid startIndex/endIndex against segment array', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        for (const topic of result.topics) {
          expect(topic.startIndex).toBeGreaterThanOrEqual(0);
          expect(topic.startIndex).toBeLessThan(result.segments.length);
          expect(topic.endIndex).toBeGreaterThanOrEqual(topic.startIndex);
          expect(topic.endIndex).toBeLessThan(result.segments.length);
        }
      });

      it('maps scaled timestamps to nearest segment boundaries', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        // With 3 segments, the two topics should roughly split them
        expect(result.topics).toHaveLength(2);
        // First topic should include early segments
        expect(result.topics[0].startIndex).toBe(0);
        // Second topic should reach the last segment
        expect(result.topics[1].endIndex).toBe(2);
      });

      it('returns empty topics array when no segments', () => {
        const result = assembleFirestoreData(GEMINI, [], DURATION_MS);

        expect(result.topics).toHaveLength(0);
      });

      it('preserves topic type (main vs tangent)', () => {
        const geminiWithTangent: GeminiPipelineResult = {
          ...GEMINI,
          topics: [
            { title: 'Main topic', startApproxMs: 0, endApproxMs: 24000, type: 'main' },
            { title: 'Sidebar', startApproxMs: 5000, endApproxMs: 10000, type: 'tangent' },
          ],
        };

        const result = assembleFirestoreData(geminiWithTangent, ALIGNED, DURATION_MS);

        expect(result.topics[0].type).toBe('main');
        expect(result.topics[1].type).toBe('tangent');
      });
    });

    // -------------------------------------------------------------------------
    // People assembly
    // -------------------------------------------------------------------------

    describe('people assembly', () => {
      it('includes speakers as people with role affiliation', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        const alice = result.people.find(p => p.name === 'Alice');
        expect(alice).toBeDefined();
        expect(alice!.affiliation).toBe('Speaker (presenter)');
      });

      it('includes mentioned persons after speakers', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        const charlie = result.people.find(p => p.name === 'Charlie');
        expect(charlie).toBeDefined();
        expect(charlie!.affiliation).toBe('Acme Corp');
      });

      it('assigns sequential personIds (speakers first, then persons)', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        // 2 speakers + 1 person = p_0, p_1, p_2
        expect(result.people).toHaveLength(3);
        expect(result.people[0].personId).toBe('p_0');
        expect(result.people[1].personId).toBe('p_1');
        expect(result.people[2].personId).toBe('p_2');
      });

      it('omits undefined affiliation for speakers without role', () => {
        const result = assembleFirestoreData(GEMINI, ALIGNED, DURATION_MS);

        // Bob has no role → should NOT have affiliation key
        const bob = result.people.find(p => p.name === 'Bob');
        expect(bob).toBeDefined();
        expect(bob).not.toHaveProperty('affiliation');
      });

      it('omits undefined affiliation for persons without it', () => {
        const geminiNoAffil: GeminiPipelineResult = {
          ...GEMINI,
          persons: [{ name: 'Dana' }], // no affiliation
        };

        const result = assembleFirestoreData(geminiNoAffil, ALIGNED, DURATION_MS);

        const dana = result.people.find(p => p.name === 'Dana');
        expect(dana).toBeDefined();
        expect(dana).not.toHaveProperty('affiliation');
      });
    });

    // -------------------------------------------------------------------------
    // Sanitization
    // -------------------------------------------------------------------------

    describe('sanitization', () => {
      it('strips undefined values from output', () => {
        // Persons with no affiliation would have undefined if naively assigned
        const gemini: GeminiPipelineResult = {
          speakers: [{ label: 'Speaker 1', name: 'Solo' }],
          segments: [{ speaker: 'Speaker 1', text: 'test', startMs: 0, endMs: 1000 }],
          terms: [],
          topics: [],
          persons: [{ name: 'NoOrg' }],
        };
        const aligned: AlignedSegment[] = [
          { speakerId: 'Speaker 1', text: 'test', startMs: 0, endMs: 1000 },
        ];

        const result = assembleFirestoreData(gemini, aligned, 1000);

        // Deep scan for undefined — Firestore would reject these
        const json = JSON.stringify(result);
        expect(json).not.toContain('undefined');

        // Also verify via Object.values inspection
        for (const person of result.people) {
          for (const val of Object.values(person)) {
            expect(val).not.toBeUndefined();
          }
        }
      });
    });

    // -------------------------------------------------------------------------
    // Representative payload
    // -------------------------------------------------------------------------

    describe('representative PoC-style payload', () => {
      it('handles multi-speaker conversation with all data families', () => {
        // Simulates a realistic 6-speaker meeting (like the PoC test conversations)
        const gemini: GeminiPipelineResult = {
          speakers: [
            { label: 'Speaker 1', name: 'JJ', role: 'presenter' },
            { label: 'Speaker 2', name: 'Michael', role: 'analyst' },
            { label: 'Speaker 3', name: 'Sarah' },
            { label: 'Speaker 4', name: 'David', role: 'consultant' },
          ],
          segments: [
            { speaker: 'Speaker 1', text: 'Let us review the KPI dashboard for Q4', startMs: 0, endMs: 10000 },
            { speaker: 'Speaker 2', text: 'The ROI looks strong for the SaaS vertical', startMs: 10000, endMs: 20000 },
            { speaker: 'Speaker 3', text: 'I agree with Michael on the SaaS numbers', startMs: 20000, endMs: 30000 },
            { speaker: 'Speaker 4', text: 'We should revisit the KPI targets next quarter', startMs: 30000, endMs: 45000 },
            { speaker: 'Speaker 1', text: 'Good point David, let us schedule a follow-up', startMs: 45000, endMs: 55000 },
          ],
          terms: [
            { key: 'kpi', display: 'KPI', definition: 'Key Performance Indicator', aliases: ['key performance indicator'] },
            { key: 'roi', display: 'ROI', definition: 'Return on Investment', aliases: [] },
            { key: 'saas', display: 'SaaS', definition: 'Software as a Service', aliases: [] },
          ],
          topics: [
            { title: 'Q4 Dashboard Review', startApproxMs: 0, endApproxMs: 30000, type: 'main' },
            { title: 'Future Planning', startApproxMs: 30000, endApproxMs: 55000, type: 'main' },
          ],
          persons: [
            { name: 'Lisa Chen', affiliation: 'VP of Sales' },
          ],
        };

        // HARDY-aligned with realistic (non-drifted) timestamps
        const aligned: AlignedSegment[] = [
          { speakerId: 'Speaker 1', text: 'Let us review the KPI dashboard for Q4', startMs: 200, endMs: 5800 },
          { speakerId: 'Speaker 2', text: 'The ROI looks strong for the SaaS vertical', startMs: 6100, endMs: 11900 },
          { speakerId: 'Speaker 3', text: 'I agree with Michael on the SaaS numbers', startMs: 12200, endMs: 17800 },
          { speakerId: 'Speaker 4', text: 'We should revisit the KPI targets next quarter', startMs: 18500, endMs: 27200 },
          { speakerId: 'Speaker 1', text: 'Good point David, let us schedule a follow-up', startMs: 27800, endMs: 33500 },
        ];

        const result = assembleFirestoreData(gemini, aligned, 34000);

        // Speakers: 4 mapped
        expect(Object.keys(result.speakers)).toHaveLength(4);
        expect(result.speakers['speaker_0'].displayName).toBe('JJ (presenter)');

        // Segments: 5 with correct speaker references
        expect(result.segments).toHaveLength(5);
        for (const seg of result.segments) {
          expect(result.speakers[seg.speakerId]).toBeDefined();
        }

        // Terms: 3 with proper structure
        expect(Object.keys(result.terms)).toHaveLength(3);
        for (const term of Object.values(result.terms)) {
          expect(term.termId).toBeDefined();
          expect(term.key).toBeDefined();
          expect(term.display).toBeDefined();
          expect(term.definition).toBeDefined();
          expect(Array.isArray(term.aliases)).toBe(true);
        }

        // Term occurrences: KPI appears in segments 0 and 3 (twice)
        const kpiOccs = result.termOccurrences.filter(
          o => result.terms[o.termId]?.display === 'KPI'
        );
        expect(kpiOccs).toHaveLength(2);

        // Verify char offsets are correct for each occurrence
        for (const occ of result.termOccurrences) {
          const seg = result.segments.find(s => s.segmentId === occ.segmentId)!;
          const extracted = seg.text.substring(occ.startChar, occ.endChar);
          // Should be a case-insensitive match of the term display or an alias
          const term = result.terms[occ.termId];
          const lowerExtracted = extracted.toLowerCase();
          const allPatterns = [term.display, ...term.aliases].map(p => p.toLowerCase());
          expect(allPatterns).toContain(lowerExtracted);
        }

        // Topics: 2 with valid indices
        expect(result.topics).toHaveLength(2);
        for (const topic of result.topics) {
          expect(topic.startIndex).toBeGreaterThanOrEqual(0);
          expect(topic.endIndex).toBeLessThan(result.segments.length);
          expect(topic.endIndex).toBeGreaterThanOrEqual(topic.startIndex);
        }

        // People: 4 speakers + 1 mentioned person = 5
        expect(result.people).toHaveLength(5);
        const lisa = result.people.find(p => p.name === 'Lisa Chen');
        expect(lisa).toBeDefined();
        expect(lisa!.affiliation).toBe('VP of Sales');

        // No undefined values anywhere in the output
        const json = JSON.stringify(result);
        expect(json).not.toContain('undefined');
      });
    });

    // -------------------------------------------------------------------------
    // Edge cases
    // -------------------------------------------------------------------------

    describe('assembly edge cases', () => {
      it('handles empty speakers, segments, terms, topics, persons', () => {
        const empty: GeminiPipelineResult = {
          speakers: [],
          segments: [],
          terms: [],
          topics: [],
          persons: [],
        };

        const result = assembleFirestoreData(empty, [], 0);

        expect(Object.keys(result.speakers)).toHaveLength(0);
        expect(result.segments).toHaveLength(0);
        expect(Object.keys(result.terms)).toHaveLength(0);
        expect(result.termOccurrences).toHaveLength(0);
        expect(result.topics).toHaveLength(0);
        expect(result.people).toHaveLength(0);
      });

      it('handles terms with special regex characters', () => {
        const gemini: GeminiPipelineResult = {
          speakers: [{ label: 'Speaker 1', name: 'Test' }],
          segments: [{ speaker: 'Speaker 1', text: 'test', startMs: 0, endMs: 1000 }],
          terms: [
            { key: 'cpp', display: 'C++', definition: 'Programming language', aliases: [] },
            { key: 'dotnet', display: '.NET', definition: 'Microsoft framework', aliases: [] },
          ],
          topics: [],
          persons: [],
        };
        const aligned: AlignedSegment[] = [
          { speakerId: 'Speaker 1', text: 'We use C++ and .NET here', startMs: 0, endMs: 1000 },
        ];

        // Should not throw (regex special chars are escaped)
        const result = assembleFirestoreData(gemini, aligned, 1000);
        expect(result.segments).toHaveLength(1);
      });

      it('handles single segment with all data', () => {
        const result = assembleFirestoreData(
          {
            speakers: [{ label: 'Speaker 1', name: 'Solo' }],
            segments: [{ speaker: 'Speaker 1', text: 'hello', startMs: 0, endMs: 1000 }],
            terms: [{ key: 'hello', display: 'hello', definition: 'Greeting', aliases: [] }],
            topics: [{ title: 'Greeting', startApproxMs: 0, endApproxMs: 1000, type: 'main' }],
            persons: [],
          },
          [{ speakerId: 'Speaker 1', text: 'hello', startMs: 0, endMs: 800 }],
          1000,
        );

        expect(result.segments).toHaveLength(1);
        expect(result.topics).toHaveLength(1);
        expect(result.topics[0].startIndex).toBe(0);
        expect(result.topics[0].endIndex).toBe(0);
        expect(result.termOccurrences).toHaveLength(1);
      });
    });
  });
});
