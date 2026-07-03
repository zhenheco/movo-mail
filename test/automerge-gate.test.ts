import { describe, expect, it } from "vitest";
import qaGateWorkflow from "../.github/workflows/qa-gate.yml?raw";

describe("agent automerge gate", () => {
  it("publishes a read-only automerge-gate workflow over repo quality checks", () => {
    expect(qaGateWorkflow).toContain("name: QA Gate");
    expect(qaGateWorkflow).toContain("pull_request:");
    expect(qaGateWorkflow).toContain("branches: [main]");
    expect(qaGateWorkflow).toContain("merge_group:");
    expect(qaGateWorkflow).toContain("permissions:");
    expect(qaGateWorkflow).toContain("contents: read");
    expect(qaGateWorkflow).toContain(
      "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
    );
    expect(qaGateWorkflow).toContain(
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    );
    expect(qaGateWorkflow).toContain("name: automerge-gate");
    expect(qaGateWorkflow).toContain("npm ci");
    expect(qaGateWorkflow).toContain("npm run typecheck");
    expect(qaGateWorkflow).toContain("npm test");
    expect(qaGateWorkflow).toContain("npm run build");
    expect(qaGateWorkflow).toContain("npm run test:workers");
  });
});
