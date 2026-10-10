import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import App from "./App";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./i18n/config", () => ({
  default: {
    language: "en",
    changeLanguage: vi.fn(),
  },
}));

vi.mock("./config", () => ({
  API_URL: "",
  SITE_URL: "http://localhost",
}));

vi.mock("./contexts/AuthContext", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ isAuthenticated: false }),
}));

vi.mock("./contexts/SSEToasterContext", () => ({
  SSEToasterProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("./components/ContentGrid", () => ({
  default: ({ album }: { album: string }) => (
    <div data-testid="content-grid">{album}</div>
  ),
}));

vi.mock("./components/Header", () => ({
  default: ({
    albums,
    externalLinks,
    siteName,
  }: {
    albums: unknown[];
    externalLinks: unknown[];
    siteName: string;
  }) => (
    <header>
      <span data-testid="site-name">{siteName}</span>
      <span data-testid="album-count">{albums.length}</span>
      <span data-testid="external-link-count">{externalLinks.length}</span>
    </header>
  ),
}));

vi.mock("./components/Footer", () => ({
  default: () => <footer />,
}));

vi.mock("./components/SSEToaster", () => ({
  default: () => null,
}));

vi.mock("./components/Misc/ScrollToTop", () => ({
  default: () => null,
}));

vi.mock("./components/Misc/SEO", () => ({
  SEO: () => null,
}));

vi.mock("./components/Misc/StructuredData", () => ({
  StructuredData: () => null,
}));

vi.mock("./utils/analytics", () => ({
  trackPageView: vi.fn(),
  trackError: vi.fn(),
}));

vi.mock("./utils/logger", () => ({
  debug: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
}));

vi.mock("./utils/navigationInterceptor", () => ({
  useServiceWorkerNavigationReload: vi.fn(),
}));

type BootstrapEndpoint = "albums" | "external-pages" | "branding";

const successfulPayloads: Record<BootstrapEndpoint, unknown> = {
  albums: {
    albums: [{ name: "published-album", published: true }],
    folders: [],
  },
  "external-pages": {
    externalLinks: [{ title: "Example", url: "https://example.com" }],
  },
  branding: {
    siteName: "Test Portfolio",
  },
};

function endpointFromUrl(url: string): BootstrapEndpoint | null {
  if (url.endsWith("/api/albums")) return "albums";
  if (url.endsWith("/api/external-pages")) return "external-pages";
  if (url.endsWith("/api/branding")) return "branding";
  return null;
}

function mockBootstrapFailure(
  failedEndpoint: BootstrapEndpoint,
  rejectRequest = false
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith("/api/setup/status")) {
        return Response.json({ setupComplete: true });
      }

      const endpoint = endpointFromUrl(url);
      if (!endpoint) {
        throw new Error(`Unexpected request: ${url}`);
      }

      if (endpoint === failedEndpoint) {
        if (rejectRequest) {
          throw new Error(`${endpoint} unavailable`);
        }
        return Response.json({ error: "unavailable" }, { status: 503 });
      }

      return Response.json(successfulPayloads[endpoint]);
    })
  );
}

async function expectRegularRoute() {
  expect((await screen.findByTestId("content-grid")).textContent).toBe(
    "homepage"
  );
  expect(document.querySelector(".backend-error")).toBeNull();
}

describe("bootstrap endpoint failures", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    delete (window as Window & { __INITIAL_DATA__?: unknown })
      .__INITIAL_DATA__;
    delete (window as Window & { __RUNTIME_BRANDING__?: unknown })
      .__RUNTIME_BRANDING__;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps the regular route available when albums fail", async () => {
    mockBootstrapFailure("albums", true);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("external-link-count").textContent).toBe("1");
      expect(screen.getByTestId("site-name").textContent).toBe(
        "Test Portfolio"
      );
    });
    await expectRegularRoute();
    expect(screen.getByTestId("album-count").textContent).toBe("0");
  });

  it("uses empty navigation links when external pages fail", async () => {
    mockBootstrapFailure("external-pages");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("album-count").textContent).toBe("1");
      expect(screen.getByTestId("site-name").textContent).toBe(
        "Test Portfolio"
      );
    });
    await expectRegularRoute();
    expect(screen.getByTestId("external-link-count").textContent).toBe("0");
  });

  it("uses default branding when branding fails", async () => {
    mockBootstrapFailure("branding");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("album-count").textContent).toBe("1");
      expect(screen.getByTestId("external-link-count").textContent).toBe("1");
    });
    await expectRegularRoute();
    expect(screen.getByTestId("site-name").textContent).toBe("Galleria");
  });
});
