import { Link } from "@remix-run/react";
export default function Index() {
  return (
    <div className="relative flex flex-col justify-center overflow-hidden py-6 sm:py-12">
      <div className="z-10 mx-auto flex max-w-7xl flex-col">
        <main className="mx-auto flex max-w-7xl flex-col justify-center px-4 sm:px-6 lg:px-8">
          <div className="flex flex-shrink-0 justify-center">
            <a className="inline-flex" href="/">
              <span className="sr-only">Steve Adams</span>
              <img alt="" className="h-12 w-auto" src="/img/logo.svg" />
            </a>
          </div>
          <div className="py-8">
            <div className="text-center">
              <h1 className="mt-2 text-4xl font-extrabold tracking-tight text-gray-800 dark:text-gray-200 sm:text-5xl">
                <span className="bg-gradient-to-r from-red-600 via-rose-500 to-amber-600 bg-clip-text text-transparent">
                  Page not found
                </span>
              </h1>
              <p className="mt-2 text-base text-gray-500 dark:text-gray-400">
                Sorry, I couldn’t find the page you’re looking for.
              </p>
              <div className="mt-6">
                <Link
                  className="text-base font-medium text-slate-600 hover:text-slate-500 dark:text-slate-300 dark:hover:text-slate-200"
                  to="/"
                >
                  Go back home<span aria-hidden="true"> &rarr;</span>
                </Link>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
