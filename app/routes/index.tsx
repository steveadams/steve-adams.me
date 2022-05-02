import { IconAt, IconInfoCircle } from "@tabler/icons";
import type { FC } from "react";
import type React from "react";

const Link: FC<React.HTMLProps<HTMLAnchorElement>> = ({
  children,
  ...props
}) => (
  <a
    className="flex items-center gap-x-1.5 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-500 py-2 px-3 text-white/90 no-underline hover:bg-blue-500 hover:from-blue-600 hover:to-indigo-600 hover:text-white active:bg-blue-600 active:from-blue-700 active:to-indigo-700"
    {...props}
    rel="noreferrer"
    target="_blank"
  >
    {children}
  </a>
);

export default function Index() {
  return (
    <>
      <figure className="mx-auto mb-12 flex w-full max-w-6xl flex-col items-end gap-2 sm:px-4">
        <picture className="h-64 w-full overflow-hidden shadow-xl sm:h-[320px] sm:rounded-2xl">
          <source media="(max-width: 599px)" srcSet="/img/big_sur-sm.jpeg" />

          <img
            alt="A fine sandy beach below rocky, brushy slopes descending from the Cabrillo Highway in Big Sur, California. Thick kelp beds are anchored in the shallows, and a large boulder interjects part way along the smooth beach. Unseen is the Little Sur River emptying into the ocean behind the boulder. Evidence of its presence is seen as fine brown silt gathering near the outfall of the river, whereas the rest of the water is a relatively clear Pacific blue-green. I photographed this in 2016 on a road trip through California with my family."
            className="h-full w-full object-cover"
            src="/img/big_sur-lg.jpeg"
          />
        </picture>

        <figcaption className="px-2 text-xs italic text-gray-500 opacity-70 dark:text-gray-400 sm:px-0">
          A beach and kelp beds at Little Sur River Beach, California
        </figcaption>
      </figure>

      <div className="prose relative px-4 prose-headings:text-gray-700 prose-p:text-gray-700 dark:prose-headings:text-gray-200 dark:prose-p:text-gray-200 sm:mx-auto sm:max-w-4xl">
        <h1 className="text-2xl tracking-tight dark:text-gray-50 sm:text-4xl md:text-5xl">
          Hi, I&apos;m Steve.
          <br />
          <span className="bg-gradient-to-r from-indigo-500 via-red-500 to-yellow-500 bg-clip-text text-transparent dark:from-indigo-400 dark:via-red-500 dark:to-yellow-400">
            I build things people love
          </span>
          .
        </h1>

        <h2 className="text-2xl sm:text-3xl">
          I&apos;m a full-stack engineer with a proven track record of building
          fast, reliable, and lovable user experiences.
        </h2>

        <p className="text-xl">
          <strong className="text-gray-700 dark:text-gray-200">
            I&apos;m currently looking for work
          </strong>{" "}
          &mdash; Need someone with enough breadth and depth of experience to
          help guide your team? Get in touch! I&apos;m excited to hear about
          what you&apos;re working on.
        </p>

        <ul className="mx-auto my-16 flex w-fit grow-0 list-none justify-center gap-x-3 rounded-xl bg-white px-4 py-3 dark:bg-black/25">
          <li>
            <Link href="mailto:steve@steve-adams.me">
              <IconAt className="h-5 w-5" stroke={1.5} /> Email me
            </Link>
          </li>
          <li>
            <Link href="https://standardresume.co/r/steveadams">
              <IconInfoCircle className="h-5 w-5" stroke={1.5} /> Check out my
              CV &rarr;
            </Link>
          </li>
        </ul>
      </div>
    </>
  );
}
