import {
  IconBrandGithub,
  IconBrandInstagram,
  IconBrandTwitter,
} from "@tabler/icons";
import type { FC } from "react";

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
        className="h-6 w-6 text-gray-600 hover:text-gray-900 dark:text-gray-200 dark:hover:text-gray-300"
        stroke={1.5}
      />
    ),
  },
  {
    name: "Instagram",
    href: "https://www.instagram.com/extreme_fruit_flavour/",
    title: "extreme_fruit_flavour on GitHub",
    icon: () => (
      <IconBrandInstagram
        className="h-6 w-6 text-gray-600 hover:text-gray-900 dark:text-gray-200 dark:hover:text-gray-300"
        stroke={1.5}
      />
    ),
  },
];

const Footer: FC = () => (
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
);

export default Footer;
