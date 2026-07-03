import { describe, expect, it } from "vitest";
import qaGateWorkflow from "../.github/workflows/qa-gate.yml?raw";

function actionRef(actionName: string): string {
  const match = qaGateWorkflow.match(new RegExp(`uses: actions/${actionName}@([^\\s]+)`));
  if (!match) {
    throw new Error(`missing actions/${actionName} reference`);
  }
  return match[1];
}

describe("agent automerge gate", () => {
  it("publishes a read-only automerge-gate workflow over repo quality checks", () => {
    expect(qaGateWorkflow).toContain("name: QA Gate");
    expect(qaGateWorkflow).toContain("pull_request:");
    expect(qaGateWorkflow).toContain("branches: [main]");
    expect(qaGateWorkflow).toContain("merge_group:");
    expect(qaGateWorkflow).toContain("permissions:");
    expect(qaGateWorkflow).toContain("contents: read");
    expect(actionRef("checkout")).toMatch(/^[0-9a-f]{40}$/);
    expect(actionRef("setup-node")).toMatch(/^[0-9a-f]{40}$/);
    expect(qaGateWorkflow).toContain("name: automerge-gate");
    expect(qaGateWorkflow).toContain("npm ci");
    expect(qaGateWorkflow).toContain("npm run typecheck");
    expect(qaGateWorkflow).toContain("npm test");
    expect(qaGateWorkflow).toContain("npm run build");
    expect(qaGateWorkflow).toContain("npm run test:workers");
  });
});
