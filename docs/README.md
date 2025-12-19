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
- **[Testing](how-to/testing.md)** - Run and write tests

### [Reference](reference/) - Information-oriented
Technical descriptions and specifications.

- **[Architecture](reference/architecture.md)** - System architecture and data flow
- **[Data Model](reference/data-model.md)** - Firestore schema and TypeScript types
- **[Alignment Algorithm](reference/alignment-algorithm.md)** - HARDY timestamp alignment algorithm
- **[Alignment Architecture](reference/alignment-architecture.md)** - Timestamp alignment design decisions
- **[Alignment CI/CD](reference/alignment-cicd.md)** - Alignment service deployment pipeline

### [Explanation](explanation/) - Understanding-oriented
Background and context for design decisions.

- **[Design Decisions](explanation/design-decisions.md)** - Why we built it this way

## Quick Links

| Task | Document |
|------|----------|
| Set up development environment | [Getting Started](tutorials/getting-started.md) |
| Configure Firebase from scratch | [Firebase Setup](how-to/firebase-setup.md) |
| Deploy to production | [Deployment](how-to/deploy.md) |
| Run locally | [Local Development](how-to/local-development.md) |
| Understand the architecture | [Architecture](reference/architecture.md) |

## Product Requirements

See [conversation-transcript-context-prd.md](conversation-transcript-context-prd.md) for full product requirements document.

## Current Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
- **Backend**: Firebase (Firestore, Storage, Cloud Functions)
- **AI**: Google Gemini 2.5 Flash (server-side via Cloud Functions)
- **Auth**: Firebase Authentication (Google Sign-In)
- **Deployment**: Cloud Run (frontend), Firebase (backend services)
- **CI/CD**: GitHub Actions
