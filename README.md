# ClawPi

ClawPi is a desktop AI workspace for OpenClaw. It connects your AI assistant to WeChat and provides a built-in desktop chat interface, so users can talk to the same assistant from both WeChat and the local "Dragon Brain" experience.

The app is designed for a simple first-run flow: open the desktop client, connect WeChat, choose a model, and start chatting.

## What It Does

- Connects OpenClaw to WeChat through a desktop app.
- Provides a built-in web chat interface for direct conversations.
- Lets users choose models from the model marketplace.
- Keeps the selected model consistent across WeChat and the desktop chat.
- Uses `gpt-5.5` as the default chat model for new users.
- Uses `gpt-image-2` as the default image generation model.
- Keeps user data and runtime state local to the machine.

## Current Focus

This repository is being maintained as the ClawPi desktop client. The current development focus is:

- Reliable desktop startup.
- Stable WeChat connection and QR login flow.
- Correct model switching across both WeChat and Dragon Brain.
- A smaller, clearer model marketplace.
- Faster responses after the runtime is ready.
- Safer rollback points through Git tags.

## Supported Platforms

- Windows 10+
- macOS 12+ on Apple Silicon or Intel

## Getting Started For Development

### Requirements

- Node.js 22+
- pnpm 10+

### Install Dependencies

```bash
pnpm install
```

### Run The Desktop App

```bash
pnpm dev:desktop
```

This starts the desktop app, controller service, and web interface used during local testing.

### Common Checks

```bash
pnpm --filter @nexu/controller typecheck
pnpm --filter @nexu/web typecheck
pnpm --filter @nexu/web build
```

Targeted controller tests used for the current model and startup work:

```bash
pnpm --filter @nexu/controller exec vitest run tests/route-compat.test.ts tests/nexu-config-store.test.ts tests/openclaw-config-compiler.test.ts tests/workspace-template-writer.test.ts
```

## Repository Layout

```text
apps/
  controller/   Controller service and OpenClaw runtime integration
  desktop/      Desktop shell
  web/          Web UI
packages/
  shared/       Shared schemas and utilities
tests/          Desktop and integration-oriented tests
```

Some internal package names still use legacy identifiers for compatibility with the existing codebase. The product and repository name for this fork is ClawPi.

## Versioning And Rollback

Stable checkpoints are recorded with Git commits and desktop version tags.

Current rollback tag:

```bash
desktop-v0.3.4
```

To inspect that version:

```bash
git checkout desktop-v0.3.4
```

To force the local working tree back to that version:

```bash
git reset --hard desktop-v0.3.4
```

## License

This project is based on open-source OpenClaw desktop client work and is maintained here as the ClawPi desktop client. See [LICENSE](LICENSE) for license details.
