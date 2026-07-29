import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HomePage } from "../src/pages/home";

vi.mock("@/lib/api", () => ({}));

vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1Channels: vi.fn(async () => ({
    data: {
      channels: [],
    },
  })),
}));

function renderHomePage(): string {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HomePage", () => {
  it("renders the operational workspace dashboard without the retired alpha hero", () => {
    const markup = renderHomePage();

    expect(markup).toContain("home.status.starting");
    expect(markup).toContain("home.channelsTitle");
    expect(markup).toContain("home.recentActivity");
    expect(markup).not.toContain("/nexu-alpha.mp4");
  });
});
