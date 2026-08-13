import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreadActions } from "./ThreadView";

describe("ThreadActions", () => {
  it("exposes separate accessible Reply and Reply All actions", () => {
    const html = renderToStaticMarkup(
      <ThreadActions onReply={() => undefined} onReplyAll={() => undefined} />,
    );

    expect(html).toContain("回覆");
    expect(html).toContain("全部回覆");
    expect(html).toContain("回覆寄件者");
    expect(html).toContain("回覆全部收件者");
  });
});
