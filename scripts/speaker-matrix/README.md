# Speaker Detection Test Matrix

Fast feedback loop for testing Pass 1 speaker intelligence extraction.

## Why This Works

Pass 1 is **text-only** — it analyzes WhisperX transcripts without audio. This means we can:
1. Test with transcript snippets (no audio files needed)
2. Get results in seconds, not minutes
3. Iterate on prompts quickly

## Usage

```bash
# Run all test cases
npx tsx scripts/speaker-matrix/run-matrix.ts

# Run specific test case
npx tsx scripts/speaker-matrix/run-matrix.ts --case brief_speaker

# Run with verbose output
npx tsx scripts/speaker-matrix/run-matrix.ts --verbose
```

## Test Cases

Each test case in `test-cases.json` defines:
- `id`: Unique identifier
- `description`: What this tests
- `transcript`: WhisperX-style transcript text
- `expected.speakerCount`: How many speakers should be found
- `expected.speakers`: Array of expected speaker names (fuzzy matched)
- `expected.anchorPoints`: Optional anchor points to verify

## Adding Test Cases

1. Add a new entry to `test-cases.json`
2. Run the matrix to verify
3. Iterate on the prompt if needed

## Confusion Matrix Output

The runner produces a matrix showing:
- Which speakers were found vs expected
- Which speakers were missed
- False positives (hallucinated speakers)
