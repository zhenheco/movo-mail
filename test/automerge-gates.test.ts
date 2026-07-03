import { describe, expect, it } from "vitest";
import diffReviewScript from "../.github/scripts/diff_review.py?raw";
import diffReviewWorkflow from "../.github/workflows/diff-review.yml?raw";
import qaGateWorkflow from "../.github/workflows/qa-gate.yml?raw";

describe("agent automerge gates", () => {
  it("publishes an automerge-gate workflow over the repo quality contract", () => {
    expect(qaGateWorkflow).toContain("name: QA Gate");
    expect(qaGateWorkflow).toContain("pull_request:");
    expect(qaGateWorkflow).toContain("branches: [main]");
    expect(qaGateWorkflow).toContain("merge_group:");
    expect(qaGateWorkflow).toContain("name: automerge-gate");
    expect(qaGateWorkflow).toContain("npm ci");
    expect(qaGateWorkflow).toContain("npm run typecheck");
    expect(qaGateWorkflow).toContain("npm test");
    expect(qaGateWorkflow).toContain("npm run build");
    expect(qaGateWorkflow).toContain("npm run test:workers");
  });

  it("publishes a fail-closed diff-review verdict status for target PRs", () => {
    expect(diffReviewWorkflow).toContain("pull_request_target:");
    expect(diffReviewWorkflow).toContain("statuses: write");
    expect(diffReviewWorkflow).toContain("context=diff-review-verdict");
    expect(diffReviewWorkflow).toContain('gh pr diff "$PR_NUMBER"');
    expect(diffReviewWorkflow).toContain("python3 .github/scripts/diff_review.py review");
    expect(diffReviewScript).toContain("def review_diff(");
    expect(diffReviewScript).toContain('return "fail"');
    expect(diffReviewScript).toContain("redact_secrets");
  });
});
