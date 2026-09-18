import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "CloudChef Cloudflare App",
      },
      {
        name: "description",
        content: "A TanStack Start app running on Cloudflare Workers.",
      },
      { property: "og:title", content: "CloudChef Cloudflare App" },
      {
        property: "og:description",
        content: "A TanStack Start app running on Cloudflare Workers.",
      },
      { property: "og:type", content: "website" },
      {
        property: "og:image",
        content: "https://cloudchef.build/social-preview-share-v3.png",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "CloudChef Cloudflare App" },
      {
        name: "twitter:description",
        content: "A TanStack Start app running on Cloudflare Workers.",
      },
      {
        name: "twitter:image",
        content: "https://cloudchef.build/social-preview-share-v3.png",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
});

function RootComponent() {
  return <Outlet />;
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
