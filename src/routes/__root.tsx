import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { Toaster } from "sonner";
import appCss from "../styles.css?url";

const APP_NAME = "ATS Align";

/** Vite base ends with `/` (e.g. `/job/`). Join without double slashes. */
function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  const cleaned = path.replace(/^\/+/, "");
  return `${base}${cleaned}`;
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1" },
      { title: APP_NAME },
      {
        name: "description",
        content:
          "Align an HTML resume to a job description. Extract ATS keywords, rewrite, grammar-check, audit stuffing, and keep the original layout.",
      },
      { name: "theme-color", content: "#12110F" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: assetUrl("favicon.svg") },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: assetUrl("__grok/manifest.webmanifest") },
      { rel: "apple-touch-icon", href: assetUrl("__grok/icon-180.png") },
      {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&display=swap",
      },
    ],
  }),
  component: () => (
    <html lang="en" className="antialiased" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <PreviewHostBridge />
        <AuthProvider>
          <Outlet />
          <Toaster
            theme="system"
            position="bottom-right"
            toastOptions={{
              className:
                "font-sans !bg-popover !text-popover-foreground !border-border",
            }}
          />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  ),
});
