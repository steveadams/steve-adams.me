import type { MetaFunction, LinksFunction } from "@remix-run/node";
import {
  Links,
  LiveReload,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";

import tailwindStylesheetUrl from "./styles/tailwind.css";
import fontsStylesheetUrl from "./styles/fonts.css";
import { ThemeToggle } from "./components/ThemeToggle";
import Footer from "./components/Footer";

export const links: LinksFunction = () => {
  return [
    { rel: "stylesheet", href: tailwindStylesheetUrl },
    { rel: "stylesheet", href: fontsStylesheetUrl },
    { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    { rel: "icon", type: "image/png", href: "/favicon.png" },
  ];
};

export const meta: MetaFunction = () => ({
  charset: "utf-8",
  title: "Steve Adams, Full Stack Software Engineer from Victoria, BC, Canada",
  viewport: "width=device-width,initial-scale=1",
});

export default function App() {
  return (
    // TODO: How can Remix update these classes without causing hydration errors?
    // Seems to be tracked here: https://github.com/remix-run/remix/issues/2570
    <html className="h-full w-full" lang="en">
      <head>
        <Meta />
        <Links />

        <script
          dangerouslySetInnerHTML={{
            __html: `
                try {
                  if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                    document.documentElement.classList.add('dark')
                  } else {
                    document.documentElement.classList.remove('dark')
                  }
                } catch (_) {}
              `,
          }}
        />

        <script
          data-domain="steve-adams.me"
          defer
          src="https://plausible.io/js/plausible.js"
        ></script>
      </head>

      <body className="bg-gradient-to-tr from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-800">
        <main className="relative flex h-fit flex-col justify-center overflow-hidden py-6">
          <header className="relative z-10 mx-auto mb-2 flex w-full max-w-6xl justify-end gap-x-8 px-4 text-gray-800">
            <ThemeToggle />
          </header>

          <Outlet />
          <ScrollRestoration />
          <Scripts />
          <LiveReload />
        </main>

        <Footer />
      </body>
    </html>
  );
}
