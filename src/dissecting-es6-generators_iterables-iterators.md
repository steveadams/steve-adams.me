---
title: "Dissecting ES6 Generators 1: Iterables & Iterators"
date: "2023-06-14T22:25:00.000Z"
slug: "dissecting-es6-generators_iterables-iterators"
description: "Welcome to one of the best parts of ES6. Iterators are probably the most important concept to understand on the path to understanding and using generators effectively."
---

I've been writing JavaScript for well over 10 years, and while generators haven't been around the entire time (they appeared around 8 years ago), I never really _got_ them until recently.

Having come to understand them better, I think I missed out all that time. In fact, I'd say most people are missing out if they don't have a good grasp on generators, and that includes a lot of people I've worked with. I'm not sure if I've worked with anyone who had a good grasp on when, why, or how to use them; they're just a thing that kind of mattered for a stint of time (anyone remember [Koa's](https://koajs.com/){target="\_blank"} generators?) and then were superseded by `async` and `await`.

But were they?

That's not exactly true. `async` and `await` _are_ generators under the hood, and there are still valid use cases for generators where the syntactic sugar of `async...await` doesn't provide the same control and flexibility a raw generator offers. The trouble is, they aren't always obvious cases and—far too often—most of the people who will see the code with don't understand them well enough to reason about them.

So, why learn about generators? Why bother if they aren't already commonly used or a well-liked tool for day-to-day use?

In short: because they're the backbone of a lot of modern JavaScript, and every aspect of them is worth learning in order to better understand the language and many of its features you use on a daily basis. I really believe understanding generators can make you better not only with JavaScript, but programming in general. You'll find them in Python, Ruby, C#, PHP, and Dart for example.

Then again, who writes Dart?

## An analogy: pages and a bookmark

If you're totally new to generators, this is a rundown of what they are and what I consider a useful way to mentally model them: as a book.

Imagine a book with any number of pages; literally 1 to infinity.

With a very short book, you don't need any special methods of getting through it. You might be able to pick it up and finish it in one sitting, perhaps taking an hour so. That's fine, and you can find time to tend to other things you normally would.

Consider then if you take on a book with 300 or even 1500 pages. If you behaved like a regular function in JavaScript, you'd open the book and be totally fixated on it until the very last page, neglecting anything and everything else in the process.

In programming terms, especially in a single threaded browser runtime, this function would be blocking and you'd have no way to stop and resume it in order to prioritize other tasks.

To solve that problem with books, people typically use their memory of where they left off, or use a bookmark which indexes exactly where they left off.

Generators offer a mechanism exactly like this. Where regular functions are great at chipping away at small synchronous tasks (similar to you reading a 3-paged pamphlet in one pass) generators provide the tools to track each piece of a larger amount of data, like a book with hundreds or even thousands of pages.

```typescript
const fantasticBook = [
  "Once upon a time...",
  "Yer a wizard, Harry.",
  "The end."
];

function readBook(book) {
  for (let page of book) {
    console.log(page);
  }
}

// Once this starts reading, it won't stop until the last page.
readBook(fantasticBook);
// > "One upon a time...", "Yer a wizard, Harry.", "The end."

function bookReader* (book) {
  for (let page of book) {
  	yield page;
  }
}

// On the other hand, this will take one page at a time...
const reader = bookReader(fantasticBook);

console.log(reader.next()); // > "Once upon a time..."
// And it'll remember where it left off!
console.log(reader.next()); // > "Yer a wizard, Harry."
```

### Generators are a lot like functions

You define a generator almost exactly like a function, aside from an asterisk (`*`) after the `function` keyword:

```typescript
function* myGenerator() {
  return "I'm a generator";
}
```

<Note>Generally speaking, you wouldn't actually write this as a generator.</Note>

### They're functions with a lifetime

Unlike regular functions, generators don't necessarily run and then immediately return and get garbage collected. Instead, they can pause and resume from where they left off; they're multi-step functions that come with a bookmark, so to speak. As long as there's a bookmark in a page, it has more reading to do and won't return the book to the library.

The only trick you need to remember in order to keep the generator alive is to `yield` rather than `return`:

```typescript
function* myGenerator() {
  yield "still going..!";
  // JavaScript conveniently stops execution here

  return "all done";
  // This will be the last value the generator returns
}
```

<Note>ES6 came with complimentary bookmarks for functions</Note>

In fact, you can yield as much as you want. You can do it three times, twenty times, or you can do it infinitely inside of a while loop. So long as you keep asking for the next value from the generator, it'll keep passing them to you. That is, until it runs out of values (more on that later).

### Generators give you execution control

Execution control is the analog to the pause and play button on a stereo. As long as there's tape left on the cassette, you can either keep playing or pausing. But how does that work with a generator? How do you control it?

That's where this initial dissection begins. The way we control a generator is with an even lower-level data primitive called the _iterator_, which is to say it can be looped over and have its values stepped (iterated) through.

## What's an iterable?

All generators create a thing called an **iterable**. What's interesting is that the generator doesn't return the iterable and get wiped away by garbage collection, though. Instead it holds onto all the context it had until the last iteration is complete, and _then_ it returns. Fascinating, right? The iterable is like a little tunnel into a contextual, long-lived function.

So let's take a moment to break down the `yield` keyword and the concept of iterables, and we should come away with a much better grasp on what a generator is.

### Understanding iterables

Iterables aren't specific only to generators. You've probably seen them around, holding onto lists of data like `Map` and `Set`. A lot of people are confused because an iterable doesn't inherently offer the ability to `map` or `filter` like an array, yet the data is clearly a list of what seems like mappable, filterable stuff. Let's take a look at why that is.

Think of an iterable as a data structure which you can iterate over using patterns like `for...of` and spreading into arrays: `[...myData]`. JavaScript knows how to make this work because iterables are at the core of how the language works; even arrays themselves are iterable objects.

#### What makes something iterable?

In JavaScript, everything is an object. In fact, even arrays (`[1, 2, 3]`) are objects. The way JavaScript knows an array can be iterated is because the array object's prototype has a special key called `Symbol.iterator` which contains a method describing how to iterate the data in the array. If that's confusing, you can picture an extremely simplified definition of an array looking something like this:

```typescript
type CustomArray<T> = {
  data: Record<number, T> & { length: number };
  push: (item: T) => void;
  map: <U>(callback: (value: T, index: number) => U) => MyArray<U>;
  join: (separator: string) => string;
  [Symbol.iterator](): Iterator<T>; // <-- Here's the key
};
```

All that `Iterator[T]` needs to do is provide a step-by-step method of iterating over all of the data. [Here](https://codesandbox.io/p/sandbox/custom-array-implementation-with-iterable-2r45cg){target="\_blank"} you can see an implementation of the type above, with a working iterator. Apart from the syntax sugar, you can get fairly close to a native array!

Conveniently, since iterators are a foundational pattern in JavaScript, they have very well-defined structure which means you can write your own without much effort at all. Take a look at their typing—bear with me here if you aren't strong with types yet—and you'll see they're essentially composed of 3 parts:

1. The iterable: an object implementing the iterable interface.
2. The iterator: the object returned by calling the iterable.
3. The results: the object an iterator produces.

```typescript
// 1. An Iterable is any object which returns an Iterator
// from its [Symbol.iterator] key. Note that the key is a
// callable method, and the return type is the iterator:
interface Iterable<T> {
  [Symbol.iterator](): Iterator<T>;
}

// 2. An Iterator itself is a relatively simple object
// The only hard requirement is a `next()` method, with
// optional `return()` and `throw()` methods:
interface Iterator<T, Return = any, Next = undefined> {
  next(...args: [] | [Next]): IteratorResult<T, Return>;
  return?(value?: Return): IteratorResult<T, Return>;
  throw?(e?: any): IteratorResult<T, Return>;
}

// 3. Iterators' methods can either yield or return results:
type IteratorResult<T, Return = any> =
  | IteratorYieldResult<T>
  | IteratorReturnResult<Return>;

// 3a. Here's a yield result, which may or may not be `done`:
interface IteratorYieldResult<Yield> {
  done?: false;
  value: Yield;
}

// 3b. And here's a return result, which is always `done`:
interface IteratorReturnResult<Return> {
  done: true;
  value: Return;
}

// While an iterator can yield and return values, the
// return and yield types must be the same for both; you
// can't yield one type and then return another.
```

<Note>An iterable is just an object with an iterator</Note>

#### Make your own iterable

We can easily create our own iterables using TypeScript's interfaces — or even our own compatible interface. While I'd generally recommend leaning on TypeScript's baked-in types, let's use our own just to see how it works.

In the example below we've got a list of our favourite people, and the iterator returns one of them with each pass:

```typescript
interface FriendlyIterable {
  data: string[];
  // This bare-bones, narrow implementation satisfies the native type!
  [Symbol.iterator](): {
    next: () =>
      | { value: string; done: false }
      | { value: undefined; done: true };
  };
}

export const friends: FriendlyIterable = {
  data: ["Bill", "Ash", "Josh", "Devin", "Cecia", "Michael"],
  [Symbol.iterator]: function () {
    let index = 0;
    return {
      next: () =>
        index < this.data.length
          ? { value: this.data[index++], done: false }
          : { done: true },
    };
  },
};
```

Now that we've got some data in the object and there's a method describing how to iterate over it, we can do just that:

```typescript
for (let friend of friends) {
  console.log(friend);
  /**
   * > Bill
   * > Ash
   * > Josh
   * > Devin
   * > Cecia
   * > Michael
   */
}

[...friends].join(", "); // > "Bill, Ash, Josh, Devin, Cecia, Michael"
```

<Note>Looping over an object!</Note>

Because we can tell JavaScript when the data has "run out" and we're done iterating, the loop and spread operations behave and finish exactly as expected. This is evidence again of how iterables are present in familiar places where we already use these operations, even if we don't always see the iterators exposed to us.

Cool, right? An object is transformed into something we can iterate over directly, much like an array. Yet in this case it would actually make way more sense to iterate over the array directly; why bother putting it in an object like this?

Normally we wouldn't. Imagine though that you have more data you need to use in order to generate a list. A great example is a deck of cards, represented by the suits and ranks of an entire deck. If we iterate over it, it should produce all the possible cards in a standard deck:

```typescript
// Let's use the native Iterator<string> type now
type DeckOfCards = {
  suits: string[];
  ranks: string[];
  [Symbol.iterator](): Iterator<string>;
};

export const deck: DeckOfCards = {
  suits: ["Hearts", "Diamonds", "Clubs", "Spades"],
  ranks: [
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "Jack",
    "Queen",
    "King",
    "Ace",
  ],
  [Symbol.iterator]: function () {
    let suitsIndex = 0;
    let ranksIndex = 0;
    const { suits, ranks } = this;

    return {
      next: (): IteratorResult<string> => {
        if (suitsIndex >= suits.length) {
          return { done: true }; // all cards have been iterated
        } else {
          const value = `${ranks[ranksIndex]} of ${suits[suitsIndex]}`;

          ranksIndex = (ranksIndex + 1) % ranks.length;
          if (ranksIndex === 0) suitsIndex++;

          return { value, done: false };
        }
      },
    };
  },
};

let idx = 1;
for (let card of deck) {
  console.log(`${idx}. ${card}`);
  i++;

  /**
   * > 1. 2 of Hearts
   * > 2. 3 of Hearts
   * > ...
   * > 51. King of Spades
   * > 52. Ace of Spades
   *
   * All 52 cards from 4 suits and 13 ranks!
   */
}
```

This creates an encapsulated bit of data and logic which iterates into something greater than its parts! Very cool, right? We've designed a dynamic list which generates on the fly. Even without generators, this is a powerful tool.

Hopefully this illustrate how iterators work, a glimpse of their potential, and why you'd use them. They're a fundamental part of what makes generators useful, so moving on it should be even easier to see how these features combine with execution control to create an amazing programming construct.

Next let's take a look at the `yield` keyword and how it fits into the picture.

## Understanding the yield keyword

So we have iterables that work well, but we don't have a way to do the pause-and-resume thing yet that generators do. That's because an iterable defines a way to produce a list of data, but it doesn't offer any special conventions for how that data is consumed — it's the same as any `array` or `Map` in this regard.

This is where generators come in. You might remember that all generators produce an iterable, and that iterable is like a tunnel into a long-lived function. That function stays alive—retaining its state all the while—because it hasn't returned yet, and instead, each value it has generated was at a `yield` statement. As long as it doesn't return, the iterable will keep producing values this way.

### Yield values from a generator

Let's go back to our deck of cards example. Not only can we _dramatically_ simplify the deck of card's code by implementing a generator as the iterator, but we can make it far more efficient by gaining control of execution:

```typescript
type DeckOfCards = {
  suits: string[];
  ranks: string[];
  [Symbol.iterator](): Generator<string, void, unknown>;
};

export const deck: DeckOfCards = {
  suits: ["Hearts", "Diamonds", "Clubs", "Spades"],
  ranks: [
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "Jack",
    "Queen",
    "King",
    "Ace",
  ],
  [Symbol.iterator]: function* () {
    for (const suit of this.suits) {
      for (const rank of this.ranks) {
        // Think of yield as "send back this value, then wait"
        yield `${rank} of ${suit}`;
      }
    }
  },
};
```

<Note>The generator is cleaner even if you don't need execution control</Note>

And suddenly, we can treat this generator like an iterable _and_ like a stateful collection we can step through as needed:

```typescript
// Take one at a time:
deck.next() // > 2 of Hearts
deck.next() // > 3 of Hearts
deck.next() // > 4 of Hearts

// Or take all of what's remaining:
[...deck]

/**
 * 5 of Hearts
 * ...
 * King of Spades
 * Ace of Spades
 */
```

Control over execution is a huge deal! You're effectively pausing execution after each call of `next()` when the generator reaches a `yield` statement, preventing any further work from being done until you decide you're ready.

You might wonder: when would I ever write code where I take one card at a time? What if my game requires taking 5 cards at a time — would I need to write `deck.next()` 5 times?

No, generators are flexible when it comes to operating on collections. We can add a `draw` method to our deck which accepts any number of cards you want (up to the amount remaining; any more and we return from the deck's generator, effectively ending the deck's lifetime):

```typescript
export const deck: DeckOfCards = {
  // The rest is the same as before...
  *draw(count = 1) {
    for (let i = 0; i < count; i++) {
      if (this.currentDrawIndex < this.cards.length) {
        yield this.cards[this.currentDrawIndex++];
      } else {
        return; // If no more cards to draw, terminate the generator
      }
    }
  },
};

// Now we can draw as many as we need:

[...deck.draw(5)];
/**
 * > 2 of Hearts
 * > 3 of Hearts
 * > 4 of Hearts
 * > 5 of Hearts
 * > 6 of Hearts
 */

[...deck.draw(2)];
/**
 * > 7 of Hearts
 * > 8 of Hearts
 */

const card = deck.draw(1);

card.next(); // > "9 of Hearts"
```

This approach lets you bite off small pieces as you need them, both lazily and immediately, and maintains the state of your progress through the deck with no added logic.

This shows that we can `yield` a value from a generator to a caller, but `yield` is still more interesting: it can also receive values from callers. This means a generator can communicate bidirectionally, which is another capability that regular functions don't offer.

### Yield values to a generator

This capability makes it so generators can not only receive values from your calls to `next()`, but even from child generators called within the generator. Let's explore what that means, what it looks like, and how we can leverage it.

In this example, we take advantage of two key features: generators are stateful, and generators can receive and use values throughout their lifetime. We have a basic generator which defines some parameters for hit points and how to track them:

```typescript
function* trackHitPoints(
  max: number
): Generator<number, number, number | undefined> {
  let hitPoints = max;

  while (true) {
    const change = yield hitPoints;

    if (change) {
      hitpoints += change;
    }

    // Ensure hitPoints never exceed max and never go below zero
    hitPoints = Math.max(0, Math.min(max, hitPoints));

    if (hitPoints === 0) {
      break;
    }
  }

  return hitPoints;
}
```

If you observe how this behaves you'll see that you can feed values into the tracker, or call `next()` without any value in order to check the current value. Nice! The value will never exceed the maximum amount or drop below zero.

```typescript
let hp = trackHitpoints(50);

hp.next(); // > {value: 50, done: false}
hp.next(10); // > {value: 50, done: false}
hp.next(-10); // > {value: 40, done: false}
hp.next(); // > {value: 40, done: false}
hp.next(-25); // > {value: 15, done: false}
hp.next(15); // > {value: 30, done: false}
hp.next(); // > {value: 30, done: false}
hp.next(-40); // > {value: 0, done: true}
hp.next(); // > {value: undefined, done: true}
```

<Note>Send positive and negative values to increase or decrease health, or call with no value to check the current hit point value without making changes to it.</Note>

This accomplishes a few things:

1. State encapsulation: Nothing can modify the value except for calling `next()`, and the mutations can only occur in one way.
2. Separation of concerns: The logic for handling updates and the value's boundaries are blackboxed away in the generator, making it simple and safe to handle hit point state in the rest of your code.
3. Simple API: Modifying and getting the value is done with a single simple interface.
4. Safety: It's hard to mess this up! This approach allows you to model the hit point increment and decrement behaviours in isolation, without any worries for how other code could eventually interact with it.

### Yield to a child generator

This pattern is a bit more advanced, but one of the greatest strengths of generators. I find a useful way to picture this capability as generators being able to branch into trees of sequences — each time you `yield` to a generator, you branch out into its iterable sequence until you're finished, then carry on until the next one or a return statement. If generators `yield` to yet more generators, you'll effectively be creating tree-like branches of generated sequences. A more trivial yet useful example of this might be creating conditional branches of logic, like if we want to ask a user questions and take different routes through the tree depending on responses:

```typescript
const readline = require("readline").createInterface({
  input: process.stdin,
  output: process.stdout,
});

const askQuestion = (questionText) =>
  new Promise((resolve) => readline.question(questionText, resolve));

async function* configureServiceA() {
  let dbEngine = await askQuestion(
    "Which database engine would you like to use for Service A? (mysql/postgres) "
  );
  let dbUser = await askQuestion(
    "Please provide the database username for Service A: "
  );
  let dbPass = await askQuestion(
    "Please provide the database password for Service A: "
  );

  return {
    dbEngine,
    dbUser,
    dbPass,
  };
}

async function* configureServiceB() {
  let storageSize = await askQuestion(
    "What storage size would you like to provision for Service B? "
  );
  let region = await askQuestion(
    "Which region would you like Service B to be deployed in? "
  );

  return {
    storageSize,
    region,
  };
}

async function* configureDeployment() {
  let services = await askQuestion(
    "Which services would you like to deploy? (serviceA/serviceB/both) "
  );
  let configuration = {};

  if (services.includes("serviceA")) {
    configuration.serviceA = yield* configureServiceA();
  }

  if (services.includes("serviceB")) {
    configuration.serviceB = yield* configureServiceB();
  }

  return configuration;
}

async function run() {
  let deploymentConfiguration = await (async function () {
    let generator = configureDeployment();
    let result = await generator.next();

    while (!result.done) {
      result = await generator.next();
    }
    return result.value;
  })();

  console.log("Deployment configuration: ", deploymentConfiguration);
  readline.close();
}

run();
```

### So what's yield doing here?

The way I think of this is that `yield` still serves like our bookmark analogy from earlier, but in this scenario it not only stores the state of a generator and its linear position in a single iterable, but it turns the entire sequence, branches and all, into a sort of stateful tree you can incrementally traverse and track your position in.

The book analogy falls apart because this is almost as though various stories in your book suddenly branch off into another book, just growing off of the original book. These are 4D books I guess.

It's kind of magic at a glance, but it's not actually mysterious. `yield` will return from the correct generator at the correct position no matter how many steps you go through. Once it reaches the end of a generator it will return to its parent, follow any subsequent `yield` statements, and carry on until it's finally back at the root generator and able to return.

You essentially get declarative, iterable, stateful logic without a single imported library to speak of. Just remember that where you position `yield` is how you determine the direction of travel through the iterable tree.

It's incredibly cool once you break it down and see what's happening under the hood. Hopefully at this point the power and potential is a bit more obvious, but the mystery and complexity is receding a bit.

## Take a deep breath

What a trip. I hope you learned something. There's a lot more to cover! Next I'm going to explore practical applications for generators.

Why use them instead of `async` and `await`? Aren't they too complicated for normal tasks? What are the actual benefits of using them? When are they the right tool for the job? I'll do my best to answer those questions and hopefully more.

Thanks for reading!
