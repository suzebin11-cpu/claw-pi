import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  steps?: Array<{
    name?: string;
    run?: string;
  }>;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
};

describe("desktop Windows release workflow", () => {
  it("skips macOS for tag releases and allows verified Windows publication", async () => {
    const source = await readFile(
      ".github/workflows/desktop-release.yml",
      "utf8",
    );
    const workflow = parse(source) as Workflow;

    expect(workflow.jobs.release.if).toContain(
      "github.event_name == 'workflow_dispatch'",
    );
    expect(workflow.jobs["release-windows"].needs).toEqual([
      "source-health",
      "release",
    ]);
    expect(workflow.jobs["release-windows"].if).toContain(
      "github.event_name == 'push'",
    );
    expect(workflow.jobs["finalize-release"].needs).toBe("release-windows");
  });

  it("publishes Windows manifests only after immutable artifacts", async () => {
    const source = await readFile(
      ".github/workflows/desktop-release.yml",
      "utf8",
    );
    const workflow = parse(source) as Workflow;
    const uploadStep = workflow.jobs["release-windows"].steps?.find(
      (step) => step.name === "Upload to Cloudflare R2",
    );
    const uploadScript = uploadStep?.run ?? "";

    expect(uploadScript).toContain("$immutableArtifacts");
    expect(uploadScript).toContain(
      'Publishing latest.yml last to $prefix/latest.yml',
    );
    expect(uploadScript.indexOf("foreach ($artifact in $immutableArtifacts)"))
      .toBeLessThan(uploadScript.indexOf("Publishing latest.yml last"));
  });
});
