# Audio Transcript Analysis App Documentation

Documentation for the Audio Transcript Analysis App - a React application that transforms audio recordings into interactive, navigable transcripts with AI-powered analysis.

## Documentation Structure

This documentation follows the [Diátaxis framework](https://diataxis.fr/), organizing content by purpose:

### [Tutorials](tutorials/) - Learning-oriented
Step-by-step lessons for new users and developers.

- **[Getting Started](tutorials/getting-started.md)** - Complete setup from scratch

### [How-to Guides](how-to/) - Task-oriented
Practical guides for solving specific problems.

- **[Firebase Setup](how-to/firebase-setup.md)** - Configure Firebase project, enable APIs, set secrets
- **[Deployment](how-to/deploy.md)** - Deploy to Cloud Run and Firebase
- **[Local Development](how-to/local-development.md)** - Run the app locally
- **[Query Firestore Emulator](how-to/query-firestore-emulator.md)** - Debug and extract data from local Firestore
- **[Testing](how-to/testing.md)** - Run and write tests

### [Reference](reference/) - Information-oriented
Technical descriptions and specifications.

- **[Architecture](reference/architecture.md)** - System architecture and data flow
- **[Pipeline Flow](reference/pipeline-flow.md)** - Transcription pipeline reference (dispatcher + orchestrator)
- **[Cloud Functions Flow](reference/cloud-functions-flow.md)** - Non-pipeline Cloud Functions (callables, stats, billing)
- **[Data Model](reference/data-model.md)** - Firestore schema and TypeScript types
- **[Alignment Algorithm](reference/alignment-algorithm.md)** - HARDY timestamp alignment algorithm
- **[HARDY Alignment](reference/alignment-architecture.md)** - HARDY technical reference with call graph and constants
- **[CI/CD Pipeline](reference/alignment-cicd.md)** - Deployment pipeline for Functions

### [Explanation](explanation/) - Understanding-oriented
Background and context for design decisions.

- **[Design Decisions](explanation/design-decisions.md)** - Why we built it this way
- **[Gemini 3 Migration](explanation/gemini3-migration.md)** - Why and how we migrated to the Gemini 3 Flash hybrid pipeline

## Quick Links

| Task | Document |
|------|----------|
| Set up development environment | [Getting Started](tutorials/getting-started.md) |
| Configure Firebase from scratch | [Firebase Setup](how-to/firebase-setup.md) |
| Deploy to production | [Deployment](how-to/deploy.md) |
| Run locally | [Local Development](how-to/local-development.md) |
| Debug Firestore emulator data | [Query Firestore Emulator](how-to/query-firestore-emulator.md) |
| Understand the architecture | [Architecture](reference/architecture.md) |

## Product Requirements

See [conversation-transcript-context-prd.md](conversation-transcript-context-prd.md) for full product requirements document.

## Current Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
- **Backend**: Firebase (Firestore, Storage, Cloud Functions)
- **AI**: Google Gemini 3 Flash (transcription, diarization, content analysis) + WhisperX via Cloud Run GPU (timestamp alignment)
- **Auth**: Firebase Authentication (Google Sign-In)
- **Deployment**: Cloud Run (frontend), Firebase Functions (backend)
- **CI/CD**: GitHub Actions (parallel frontend + functions deployment)
