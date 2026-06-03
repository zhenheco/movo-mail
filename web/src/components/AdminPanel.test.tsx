import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminPanel } from "./AdminPanel";

describe("AdminPanel", () => {
  it("labels the owner field as the Cloudflare Access login email", () => {
    const html = renderToStaticMarkup(
      <AdminPanel onClose={() => undefined} />,
    );

    expect(html).toContain("Owner login email");
    expect(html).toContain(
      "The email they sign in to Cloudflare Access with (their Google/Gmail)",
    );
    expect(html).toContain("owner@gmail.com");
    expect(html).not.toContain("owner@movo.com.my");
  });
});
