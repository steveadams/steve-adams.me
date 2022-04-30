import { Listbox } from "@headlessui/react";
import clsx from "clsx";
import { Fragment, useEffect, useRef, useState } from "react";
import { useIsomorphicLayoutEffect } from "../hooks/useIsomorphicLayoutEffect";

function update() {
  if (
    localStorage.theme === "dark" ||
    (!("theme" in localStorage) &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  ) {
    console.log("adding dark");
    document.documentElement.classList.add("dark", "changing-theme");
  } else {
    console.log("removing dark");
    document.documentElement.classList.remove("dark", "changing-theme");
  }
  window.setTimeout(() => {
    document.documentElement.classList.remove("changing-theme");
  });
}

const settings = [
  ["light", SunIcon],
  ["dark", MoonIcon],
  ["system", SystemIcon],
] as const;

function SunIcon(props: { className?: string }) {
  return (
    <svg
      fill="none"
      height={24}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
      width={24}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <desc>An icon depicting the sun</desc>
      <path d="M0 0h24v24H0z" fill="none" stroke="none"></path>
      <circle cx={12} cy={12} r={4}></circle>
      <path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7"></path>
    </svg>
  );
}

function MoonIcon({ ...props }: { className?: string }) {
  return (
    <svg
      fill="none"
      height={24}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
      width={24}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <desc>An icon depicting a moon and stars</desc>
      <path d="M0 0h24v24H0z" fill="none" stroke="none"></path>
      <path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z"></path>
      <path d="M17 4a2 2 0 0 0 2 2a2 2 0 0 0 -2 2a2 2 0 0 0 -2 -2a2 2 0 0 0 2 -2"></path>
      <path d="M19 11h2m-1 -1v2"></path>
    </svg>
  );
}

function SystemIcon({ ...props }: { className?: string }) {
  return (
    <svg
      fill="none"
      height={24}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
      width={24}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <desc>An icon depicting a computer</desc>
      <path d="M0 0h24v24H0z" fill="none" stroke="none"></path>
      <rect height={12} rx={1} width={18} x={3} y={4}></rect>
      <line x1={7} x2={17} y1={20} y2={20}></line>
      <line x1={9} x2={9} y1={16} y2={20}></line>
      <line x1={15} x2={15} y1={16} y2={20}></line>
    </svg>
  );
}

function useTheme() {
  const [setting, setSetting] = useState<"light" | "dark" | "system">("system");
  const initial = useRef(true);

  console.log(setting);

  useIsomorphicLayoutEffect(() => {
    const theme = localStorage.theme;

    if (theme === "light" || theme === "dark") {
      setSetting(theme);
    }
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (setting === "system") {
      localStorage.removeItem("theme");
      console.log("removed theme");
    } else if (setting === "light" || setting === "dark") {
      localStorage.theme = setting;
    }

    if (initial.current) {
      initial.current = false;
    } else {
      update();
    }
  }, [setting]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    if (mediaQuery?.addEventListener) {
      mediaQuery.addEventListener("change", update);
    } else {
      mediaQuery.addListener(update);
    }

    function onStorage() {
      update();

      const theme = localStorage.theme;

      if (theme === "light" || theme === "dark") {
        setSetting(theme);
      } else {
        setSetting("system");
      }
    }

    window.addEventListener("storage", onStorage);

    return () => {
      if (mediaQuery?.removeEventListener) {
        mediaQuery.removeEventListener("change", update);
      } else {
        mediaQuery.removeListener(update);
      }

      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return [setting, setSetting] as const;
}

export function ThemeToggle({
  panelClassName = "mt-4",
}: {
  panelClassName?: string;
}) {
  const [setting, setSetting] = useTheme();

  return (
    <Listbox onChange={setSetting} value={setting}>
      <Listbox.Label className="sr-only">Theme</Listbox.Label>
      <Listbox.Button className="rounded-full" type="button">
        <span className="dark:hidden">
          <SunIcon
            className={clsx(
              setting !== "system"
                ? "fill-amber-400/20 stroke-amber-500"
                : "stroke-slate-400 dark:stroke-slate-500",
              "h-6 w-6"
            )}
          />
        </span>
        <span className="hidden dark:inline">
          <MoonIcon
            className={clsx(
              setting !== "system"
                ? "fill-purple-400/20 stroke-purple-500"
                : "stroke-slate-400 dark:stroke-slate-500",
              "h-6 w-6"
            )}
          />
        </span>
      </Listbox.Button>
      <Listbox.Options
        className={clsx(
          "dark:highlight-white/5 absolute top-full right-0 z-50 w-36 overflow-hidden rounded-lg bg-white py-1 text-sm font-semibold text-slate-700 shadow-lg ring-1 ring-slate-900/10 dark:bg-slate-800 dark:text-slate-300 dark:ring-0",
          panelClassName
        )}
      >
        {settings.map(([value, Icon]) => (
          <Listbox.Option as={Fragment} key={value} value={value}>
            {({ active, selected }) => (
              <li
                className={clsx(
                  "flex cursor-pointer items-center py-1 px-2",
                  selected && {
                    "text-amber-600": value === "light",
                    "text-purple-500": value === "dark",
                    "text-gray-600": value === "system",
                  },
                  active && "bg-slate-50 dark:bg-slate-600/30"
                )}
              >
                <Icon
                  className={clsx(
                    "mr-2 h-6 w-6",
                    selected && {
                      "fill-purple-400/20 stroke-purple-500":
                        setting === "dark",
                      "fill-amber-400/20 stroke-amber-500": setting === "light",
                      "fill-blue-400/20 stroke-blue-500": setting === "system",
                    }
                  )}
                />
                <span>{value}</span>
              </li>
            )}
          </Listbox.Option>
        ))}
      </Listbox.Options>
    </Listbox>
  );
}

export function ThemeSelect() {
  const [setting, setSetting] = useTheme();

  return (
    <div className="flex items-center justify-between">
      <label
        className="font-normal text-slate-700 dark:text-slate-400"
        htmlFor="theme"
      >
        Switch theme
      </label>
      <div className="dark:highlight-white/5 relative flex items-center rounded-lg p-2 font-semibold text-slate-700 shadow-sm ring-1 ring-slate-900/10 dark:bg-slate-600 dark:text-slate-200 dark:ring-0">
        <SunIcon className="mr-2 h-6 w-6 dark:hidden" />
        <svg
          className="mr-2 hidden h-6 w-6 dark:block"
          fill="none"
          viewBox="0 0 24 24"
        >
          <path
            className="fill-transparent"
            clipRule="evenodd"
            d="M17.715 15.15A6.5 6.5 0 0 1 9 6.035C6.106 6.922 4 9.645 4 12.867c0 3.94 3.153 7.136 7.042 7.136 3.101 0 5.734-2.032 6.673-4.853Z"
            fillRule="evenodd"
          />
          <path
            className="fill-slate-400"
            d="m17.715 15.15.95.316a1 1 0 0 0-1.445-1.185l.495.869ZM9 6.035l.846.534a1 1 0 0 0-1.14-1.49L9 6.035Zm8.221 8.246a5.47 5.47 0 0 1-2.72.718v2a7.47 7.47 0 0 0 3.71-.98l-.99-1.738Zm-2.72.718A5.5 5.5 0 0 1 9 9.5H7a7.5 7.5 0 0 0 7.5 7.5v-2ZM9 9.5c0-1.079.31-2.082.845-2.93L8.153 5.5A7.47 7.47 0 0 0 7 9.5h2Zm-4 3.368C5 10.089 6.815 7.75 9.292 6.99L8.706 5.08C5.397 6.094 3 9.201 3 12.867h2Zm6.042 6.136C7.718 19.003 5 16.268 5 12.867H3c0 4.48 3.588 8.136 8.042 8.136v-2Zm5.725-4.17c-.81 2.433-3.074 4.17-5.725 4.17v2c3.552 0 6.553-2.327 7.622-5.537l-1.897-.632Z"
          />
          <path
            className="fill-slate-400"
            clipRule="evenodd"
            d="M17 3a1 1 0 0 1 1 1 2 2 0 0 0 2 2 1 1 0 1 1 0 2 2 2 0 0 0-2 2 1 1 0 1 1-2 0 2 2 0 0 0-2-2 1 1 0 1 1 0-2 2 2 0 0 0 2-2 1 1 0 0 1 1-1Z"
            fillRule="evenodd"
          />
        </svg>
        <span className="capitalize">{setting}</span>
        <svg className="ml-2 h-6 w-6 text-slate-400" fill="none">
          <path
            d="m15 11-3 3-3-3"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          />
        </svg>
        <select
          className="absolute inset-0 h-full w-full appearance-none opacity-0"
          id="theme"
          onChange={(e) =>
            setSetting(e.target.value as "light" | "dark" | "system")
          }
          value={setting}
        >
          {settings.map(([value]) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
