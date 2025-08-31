---
title: "TypeScript Benchmarking with mitata"
date: "2023-02-16T11:42:00.000Z"
slug: "typescript-benchmarking-mitata"
description: "See how you can keep track of TypeScript performance with mitata: a tiny, fast, Rust-based benchmarking library."
---

Way back, [I wrote about benchmarking](./summing-the-largest-values-javascript-array) some sloppy interview code using jsperf.com (now [jsperf.app](https://jsperf.app)). The gist of it is that I wrote a naive array searching algorithm for finding the two largest numbers in an array, and upon discovering just how bad my solution was, I decided to benchmark it to properly stomp on my self esteem a little bit. The contrast between the first solution and the second was surprising and incredibly insightful, and since then I've loved leaning on benchmarks to learn more and hone in on better solutions.

These days I do most of my benchmarking in Go and Rust because it's implemented in their standard libraries so well; there's no reason not to do it. I'm not as diligent when it comes to TypeScript, so I wanted to revisit that old benchmark and try to devise a convention I'd actually use, regardless of which runtime I'm using.

Vitest offers an experimental bench command (which would be great to use because I use Vitest all the time) but it's fairly unstable still and uses tinybench under the hood, which I'm not as happy with as mitata. Deno and Bun have integrated mitata into their standard library which is great to see, but I don't typically use them. So, I'm going to set up a bare bones solution without any special tooling or conventions.

## Caveats

It looks like mitata hasn't been updated for a while now, and while it's stable and works very well, there are some things some people might believe should be ironed out. There are some relatively basic features that would be great to see, like a reporter API or a timeout argument for groups or single benchmarks. Even so, it's well-featured for how simple and nice it is to use, and I'm not going to let that get in the way.

Although people tend to be resistant to the idea, each of these features can be implemented in a benchmark running abstraction, and my impression is that this might be what the creator of mitata thinks is the correct solution.

## Setup

### package.json

I like to write tests to ensure what I'm benchmarking is working properly and as expected, so I'm including Vitest; you can feel free to exclude it. I'm also including prettier out of habit and it's safe to leave out as well.

To run the benchmarks which will be written in TypeScript, I'm using typescript, glob, and ts-node:

```json
{
  ...
  "scripts": {
    "build": "tsc --p tsconfig.build.json",
    "test": "vitest --reporter=verbose",
    "benchmark": "ts-node scripts/benchmark.ts",
  },
  "devDependencies": {
    "glob": "^10.2.7",
    "mitata": "^0.1.6",
    "prettier": "^2.8.8",
    "ts-node": "^10.9.1",
    "typescript": "^5.1.3",
    "vitest": "^0.32.2"
  }
}
```

<Note>package.json</Note>

### Typescript Configuration

The TypeScript configuration is typical except for a ts-node entry. This is used to modify the compilation for running scripts with ts-node, which we don't necessarily _have_ to do for this example but under real-world circumstances I expect you would. Likely the most modern feature you need is top-level await, making it so you can await the run function exported from mitata. You can [learn more about this ts-node convention here](https://typestrong.org/ts-node/docs/configuration/). I've also added a specific secondary config for builds, which avoids compiling any benchmarking or test files and provides an output destination:

```json
{
  "compilerOptions": {
    "module": "es2022",
    "moduleResolution": "node",
    "target": "es2017"
  },
  "include": ["src"],

  "ts-node": {
    "esm": true,
    "experimentalSpecifierResolution": "node",
    "compilerOptions": {
      "module": "es2022",
      "target": "es2022"
    }
  }
}
```

<Note>tsconfig.json</Note>

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./javascript"
  },
  "exclude": ["**/*.test.ts", "**/*.bench.ts"]
}
```

<Note>tsconfig.build.json</Note>

### The Benchmarking Script

I've created a `./scripts` directory with a file called `benchmark.ts`. This file uses glob to find all of our benchmarks and execute them:

```typescript
import { glob } from "glob";
import * as path from "path";

const executeFile = async (file: string) => {
  const absolutePath = path.resolve(file);
  return await import(absolutePath).then((module) => module);
};

try {
  const files = await glob("**/*.bench.ts");

  for (const file of files) {
    await executeFile(file);
  }
} catch (e) {
  console.error(e);
}
```

<Note>benchmark.ts</Note>

This is rudimentary at this point, but it's loaded with potential. Although mitata always outputs results to stdout for you to view in the terminal, you'll see later that it also provides a way for us to read and, if we choose to, write results from the benchmarks here.

## Writing a Benchmark

This part is satisfyingly easy. In its most basic form, all you need to do is end a file's name with `.bench.ts`, wrap what you're measuring in `bench()` and then `run()` it:

```typescript
import { run, bench } from "mitata";

const helloTemplate = (name: string) => `hello ${name}!`;
const helloConcat = (name: string) => "hello " + name;

bench("hello (template string)", () => helloTemplate("world"));
bench("hello (concatenation)", () => helloConcat("world"));

await run();
```

<Note>hello.bench.ts</Note>

Now we can use the bench script from package.json to run this benchmark:

```bash
$ yarn bench

benchmark                    time (avg)             (min … max)       p75       p99      p995
--------------------------------------------------------------- -----------------------------
hello (template string)  434.19 ps/iter  (284.9 ps … 902.06 ns)  366.8 ps   1.56 ns   2.27 ns
hello (concatenation)      7.62 ns/iter   (5.85 ns … 190.93 ns)   7.45 ns  20.89 ns  31.52 ns
```

<Note>This is awesome</Note>

### run's Options

In the example above I'm using run with no options passed in, but there are several to choose from:

```typescript
export function run(options?: {
  avg?: boolean;
  colors?: boolean;
  min_max?: boolean;
  collect?: boolean;
  percentiles?: boolean;
  json?: number | boolean;
}): Promise<Report>;
```

<Note>Taken from mitata's `cli.d.ts` types</Note>

::: info About `collect`:
_I haven't figured out how **collect** does anything meaningfully different, but the rest are fairly straight forward._
:::

### `run`'s Return Value

You might have noticed run returns a `Promise<Report>`; the report object looks like this:

```typescript
interface Report {
  cpu: string;
  runtime: string;

  benchmarks: {
    name: string;
    time: number;
    fn: () => any;
    async: boolean;
    warmup: boolean;
    baseline: boolean;
    group: string | null;

    error?: {
      stack: string;
      message: string;
    };

    stats?: {
      n: number;
      avg: number;
      min: number;
      max: number;
      p75: number;
      p99: number;
      p995: number;
      p999: number;
      jit: number[];
    };
  }[];
}
```

<Note>Interestingly, <code>p999</code> is excluded from the percentile columns</Note>

The Report object struck me as the perfect way to store data about benchmarks after they complete. While the run's results will always output to stdout, you can use that as feedback while the actual results are piped into files for later use.

I haven't quite figured out how I want to use the reports yet, but I'd love to create a convention for identifying functions and their changes over time, and tracking their performance along with each diff. This could help point out major performance improvements or degradations during pull requests or other stages of development, but it wouldn't require any special effort from developers — you'd just need to write the benchmarks.

### Benchmarking sumTwoLargestNumbers

Like the example above, this is about as easy. I'm starting with the two implementations I had in my post from 2017:

```typescript
export type TwoOrMoreNumbers = [number, number, ...number[]];

/**
 * Sums the two largest numbers in an array of numbers with an O(n) algorithm.
 */
export const sumTwoLargestNumbers = (numbers: TwoOrMoreNumbers): number => {
  let largest: number, secondLargest: number;
  const length = numbers.length;

  if (length < 2) {
    throw new Error("Expected an array with at least 2 elements.");
  }

  // Assign our starting values
  largest = numbers[0];
  secondLargest = numbers[1];

  // Ensure we're starting with largest and secondLargest properly arranged
  if (largest < secondLargest) {
    largest = numbers[1];
    secondLargest = numbers[0];
  }

  // Loop through the numbers
  for (let i = 2; i < length; i++) {
    // If the new number is greater than largest, assign it to largest and
    // pass largest's value to secondLargest.
    if (numbers[i] > largest) {
      secondLargest = largest;
      largest = numbers[i];
    }
    // If the new number isn't greater than largest, check if it's still
    // greater than secondLargest.
    else if (numbers[i] > secondLargest) {
      secondLargest = numbers[i];
    }
  }

  return largest + secondLargest;
};

/**
 * Sums the two largest numbers in an array of numbers using an n*log(n) algorithm (picking from quicksort).
 */
export const sumTwoLargestNumbersSort = (numbers: TwoOrMoreNumbers): number => {
  // Is the array long enough to sum?
  if (numbers.length < 2) {
    throw new TypeError("Expected an array with at least 2 elements.");
  }

  // Sort the array large -> small
  numbers = numbers.sort(function (a, b) {
    return b - a;
  });

  return numbers[0] + numbers[1];
};
```

<Note>sumTwoLargestNumbers.ts</Note>

Then to write the benchmarks, I'm grouping each assessment with both implementations run with the same data:

```typescript
import { run, bench, group } from "mitata";

import {
  TwoOrMoreNumbers,
  sumTwoLargestNumbers,
  sumTwoLargestNumbersSort,
} from "./index";

const randomNumber = () => Math.floor(Math.random() * 40);
const makeArrayOfLength = (length: number): TwoOrMoreNumbers => [
  1,
  2,
  ...Array.from({ length }, randomNumber),
];

const smallArray = makeArrayOfLength(3);
const mediumArray = makeArrayOfLength(100);
const largeArray = makeArrayOfLength(1000);

group("sumTwoLargestNumbers: Small arrays", () => {
  bench("for loop", () => sumTwoLargestNumbers(smallArray));
  bench("sort and pick", () => sumTwoLargestNumbersSort(smallArray));
});

group("sumTwoLargestNumbers: Medium arrays", () => {
  bench("for loop", () => sumTwoLargestNumbers(mediumArray));
  bench("sort and pick", () => sumTwoLargestNumbersSort(mediumArray));
});

group("sumTwoLargestNumbers: Large arrays", () => {
  bench("for loop", () => sumTwoLargestNumbers(largeArray));
  bench("sort and pick", () => sumTwoLargestNumbersSort(largeArray));
});

await run();
```

<Note>sumTwoLargestNumbers.bench.ts</Note>

Now we can run our benchmarking script and see the results:

```bash
$ yarn benchmark
yarn run v1.22.19
$ ts-node scripts/benchmark.ts
cpu: Intel(R) Core(TM) i5-8210Y CPU @ 1.60GHz
runtime: node v18.16.0 (x64-darwin)

benchmark          time (avg)             (min … max)       p75       p99      p995
----------------------------------------------------- -----------------------------
• sumTwoLargestNumbers: Small arrays
----------------------------------------------------- -----------------------------
for loop         8.37 ns/iter   (6.97 ns … 285.34 ns)   8.38 ns  22.48 ns  34.41 ns
sort and pick  254.06 ns/iter   (182.44 ns … 1.36 µs) 265.35 ns  590.1 ns 604.48 ns

summary for sumTwoLargestNumbers: Small arrays
  for loop
   30.36x faster than sort and pick

• sumTwoLargestNumbers: Medium arrays
----------------------------------------------------- -----------------------------
for loop       221.24 ns/iter   (178.14 ns … 2.25 µs) 215.12 ns 603.46 ns 752.25 ns
sort and pick    2.41 µs/iter     (2.13 µs … 3.33 µs)   2.57 µs   3.33 µs   3.33 µs

summary for sumTwoLargestNumbers: Medium arrays
  for loop
   10.88x faster than sort and pick

• sumTwoLargestNumbers: Large arrays
----------------------------------------------------- -----------------------------
for loop         1.92 µs/iter     (1.79 µs … 2.82 µs)   1.93 µs   2.82 µs   2.82 µs
sort and pick   20.91 µs/iter    (17.04 µs … 1.45 ms)  21.34 µs  41.15 µs  66.25 µs

summary for sumTwoLargestNumbers: Large arrays
  for loop
   10.89x faster than sort and pick
✨  Done in 6.94s.
```

<Note>A 10x improvement is still huge!</Note>

Incredible, right? What a huge difference between the two. The difference is smaller than it was 6 years ago, and my best guess at this point is that it's due to JIT optimizations.

## Wrapping Up

mitata seems great so far. There are a few quality of life features I'd like to see, such as quieting it's writing to `console.log` — sometimes I'd like to take over there, outputting what I want to see instead. Even so, in a pinch it's still possible to either a) ignore default outputs or b) write your outputs to a file and pipe mitata's outputs into the void. Given how simple and effective it is, I'm really happy with it as it is.

In the future I'll hopefully write a bit about building around mitata to create useful tools for tracking performance over time, but I'll need to put some thought into making that useful and portable.

Feel free to [take a look at the code on github](https://github.com/steveadams/sum-two-largest-numbers/tree/v1.0.0).
