# Project Agent Rules

## CodeGraph

Use CodeGraph first for structural code questions in this repository:

- Use `codegraph_context` for feature, architecture, or bug-entry context.
- Use `codegraph_search` to find symbols by name.
- Use `codegraph_callers`, `codegraph_callees`, `codegraph_trace`, and `codegraph_impact` for call flow, dependency, and blast-radius analysis.
- Use `rg` after CodeGraph only for literal strings, logs, config keys, error messages, or non-code text.
- After edits that affect code structure, run `codegraph sync .` or use the MCP index after it catches up.

## arc42

Use the local arc42 workspace for architecture-sensitive changes:

- Main project document: `docs/architecture/arc42/claw-pi-openclaw-workbench.adoc`
- Template reference: `docs/architecture/arc42/template/ZH/arc42-template.adoc`

Update arc42 when a task changes or clarifies:

- OpenClaw runner integration.
- Model routing for chat, reasoning, or image generation.
- Workbench chat execution flow or permission behavior.
- WeChat/Feishu channel behavior.
- Runtime packaging, sidecar layout, or deployment.
- Latency, reliability, security, or usability requirements.
- Architecture decisions, tradeoffs, or unresolved risks.

Use arc42 sections consistently:

- Section 4: solution strategy.
- Section 5: building blocks and ownership.
- Section 6: runtime flow.
- Section 7: deployment and packaging.
- Section 9: architecture decisions.
- Section 10: quality requirements.
- Section 11: technical risks.

## Default Workflow

For future debugging and implementation work:

1. Use CodeGraph to locate the relevant symbols and call paths.
2. Use targeted file reads only after CodeGraph narrows the surface area.
3. Implement the smallest coherent fix.
4. Run focused tests or app validation.
5. Update arc42 if the change affects architecture, flows, constraints, or decisions.
