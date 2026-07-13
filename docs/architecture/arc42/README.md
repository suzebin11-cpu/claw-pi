# arc42 Architecture Workspace

This directory installs the arc42 documentation framework for Claw-Pi architecture work.

## Layout

- `template/` contains the upstream arc42 Chinese AsciiDoc template files mirrored from `arc42/arc42-template`.
- `claw-pi-openclaw-workbench.adoc` is the project-specific arc42 document for the current OpenClaw workbench migration.

## Working Rule

Future changes related to OpenClaw runner integration, model routing, workbench chat, WeChat/Feishu channels, image generation, runtime packaging, or local permission behavior should update the relevant arc42 sections:

- Section 4 for solution strategy changes.
- Section 5 for component/module ownership changes.
- Section 6 for runtime flow changes.
- Section 7 for packaging/deployment changes.
- Section 9 for architecture decisions.
- Section 10 for latency, reliability, security, and usability requirements.
- Section 11 for unresolved risks.

## Source

Upstream template: https://github.com/arc42/arc42-template

The local template copy currently uses the `ZH` AsciiDoc version from the upstream `master` branch.
