# AGENTS.md

## Project overview

Discord bot extension for Pi. Detached daemon with per-channel persistent sessions, multi-instance support, agent system, and ambient orchestration.

Read `README.md` for the human-facing overview.

## Setup commands

```bash
npm install
npm test
pi install git:github.com/PopCat19/pi-discord
```

## README workflow

Edit `readme_manifest/*.md`, then run `bash tools/generate-readme.sh`.

## Code style

- Node.js / Pi extension SDK
- Headless-safe: no interactive TUI assumptions
- State separation: runtime data never mixed with package code
