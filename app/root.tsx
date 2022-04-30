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
import { IconBrandGithub, IconBrandTwitter } from "@tabler/icons";

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

const navigation = [
  {
    name: "Twitter",
    href: "https://twitter.com/tweetinAdams",
    title: "@tweetinAdams on Twitter",
    icon: () => (
      <IconBrandTwitter
        className="h-6 w-6 text-blue-500 hover:text-blue-600"
        stroke={1.5}
      />
    ),
  },
  {
    name: "GitHub",
    href: "https://github.com/steveadams",
    title: "steveadams on GitHub",
    icon: () => (
      <IconBrandGithub
        className="h-6 w-6 text-gray-700 hover:text-gray-900 dark:text-gray-200 dark:hover:text-gray-300"
        stroke={1.5}
      />
    ),
  },
];

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

        {/* TODO: Put this somewhere */}
        <footer>
          <div className="mx-auto max-w-7xl py-12 px-4 sm:px-6 md:flex md:items-center md:justify-between lg:px-8">
            <div className="flex justify-center space-x-6 md:order-2">
              {navigation.map((item) => (
                <a
                  className="text-gray-400 hover:text-gray-500"
                  href={item.href}
                  key={item.name}
                >
                  <span className="sr-only">{item.name}</span>
                  <item.icon aria-hidden="true" />
                </a>
              ))}
            </div>
            <div className="mt-8 md:order-1 md:mt-0">
              <p className="text-center text-base text-gray-400">Steve Adams</p>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
