---
title: "Creating SolidJS bindings for xstate/store"
date: "2024-08-28T06:08:53.000Z"
slug: "bringing-solid-js-bindings-to-xstate-store"
description: "SolidJS and XState are growing libraries with exceptionally happy users, including me. Here's a documentary of me finding more reasons to use them."
---

I've been using SolidJS a lot more lately, and XState has been a goto in my toolbox for years now. Recently, xstate/store was added and it's awesome. I decided I'd like to stick the two together and noticed there were only react bindings. I wondered if there was a good reason or if it was just waiting for someone like me to help out:

<PostImage 
  src="/images/2024/08/CleanShot-2024-08-24-at-13.12.34@2x.png"
  alt="Screenshot showing GitHub issue asking about SolidJS bindings for xstate/store"
  caption="A discord thread asking about SolidJS bindings for xstate/store"
/>

Well alright, let's do it!

## The plan of attack

The [XState contribution guide](https://github.com/statelyai/xstate/blob/main/CONTRIBUTING.md){target="\_blank"} makes it easy to figure out how to go about putting together this PR:

1. **Fork and clone** the `xstate` repository
2. **Create a new branch.** I checked for a branching convention, but there isn't an obvious one so I went with `xstate-store/solid`
3. **Make the changes**
4. **Add and run tests**
5. **Check the types** with `yarn typecheck`
6. **Create a changeset** with `yarn changeset`
7. **Create a pull request**

Fortunately I already had a fork of XState handy because I poke around in there all the time. I've been wanting to make it so stores can be limited to valid states, but damn, I'm not powerful enough to do it without breaking changes (yet). One of these days I guess.

## Writing the code

I started by looking at the React bindings. React and Solid are very similar so I expected to be able to use the React bindings to inform decisions around how to design the Solid bindings. They're dead simple:

```typescript
import { useCallback, useRef, useSyncExternalStore } from "react";
import { Store, SnapshotFromStore } from "./types";

function defaultCompare<T>(a: T | undefined, b: T) {
  return a === b;
}

function useSelectorWithCompare<TStore extends Store<any, any>, T>(
  selector: (snapshot: SnapshotFromStore<TStore>) => T,
  compare: (a: T | undefined, b: T) => boolean
): (snapshot: SnapshotFromStore<TStore>) => T {
  const previous = useRef<T>();

  return (state) => {
    const next = selector(state);
    return compare(previous.current, next)
      ? (previous.current as T)
      : (previous.current = next);
  };
}

/* redacted for brevity */
export function useSelector<TStore extends Store<any, any>, T>(
  store: TStore,
  selector: (snapshot: SnapshotFromStore<TStore>) => T,
  compare: (a: T | undefined, b: T) => boolean = defaultCompare
): T {
  const selectorWithCompare = useSelectorWithCompare(selector, compare);

  return useSyncExternalStore(
    useCallback(
      (handleStoreChange) => store.subscribe(handleStoreChange).unsubscribe,
      [store]
    ),
    () => selectorWithCompare(store.getSnapshot() as SnapshotFromStore<TStore>),
    () =>
      selectorWithCompare(
        store.getInitialSnapshot() as SnapshotFromStore<TStore>
      )
  );
}
```

<Note text="packages/xstate-store/src/react.ts" />

SolidJS is reactive so there's no need for a counterpart to `useSyncExternalStore`, and that entire block can be replaced by updating a signal inside of the store subscription. This is why I've been working with SolidJS a lot more. Even knowing React so well and working with it for so many years, I can't help feeling like its state management tooling is unnecessarily complex and high-friction.

### The SolidJS version

`useSelectorWithCompare` was an almost direct transfer to SolidJS, except that no `useRef`-like logic is necessary. Storing previous as a mutable variable is good enough. I also copied the `defaultCompare` function as–is because it doesn't seem important to generalize it between React and SolidJS at this point:

```typescript
function defaultCompare<T>(a: T | undefined, b: T) {
  return a === b;
}

function useSelectorWithCompare<TStore extends Store<any, any>, T>(
  selector: (snapshot: SnapshotFromStore<TStore>) => T,
  compare: (a: T | undefined, b: T) => boolean
): (snapshot: SnapshotFromStore<TStore>) => T {
  let previous: T | undefined;

  return (state): T => {
    const next = selector(state);

    if (previous === undefined || !compare(previous, next)) {
      previous = next;
    }

    return previous;
  };
}
```

<Note text="packages/xstate-store/src/solid.ts" />

`useSelector` was a bit more interesting. I really like this combination of `createEffect` and `onCleanup` here; it's super intuitive what it will do in comparison to `useEffect` and its opaque _return-as-disposal_ convention.

It's nice that the creation, use, and disposal of the subscription is pretty easy to follow.

````typescript
/**
 * Creates a selector which subscribes to the store and selects a value from the
 * store's snapshot, using an optional comparison function.
 *
 * @example
 *
 * ```tsx
 * import { donutStore } from './donutStore.ts';
 * import { useSelector } from '@xstate/store/solid';
 *
 * function DonutCounter() {
 *   const donutCount = useSelector(donutStore, (state) => state.context.donuts);
 *
 *   return (
 *     <div>
 *       <button onClick={() => donutStore.send({ type: 'addDonut' })}>
 *         Add donut ({donutCount()})
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 *
 * @param store The store, created from `createStore(…)`
 * @param selector A function which takes in the snapshot and returns a selected
 *   value from it
 * @param compare An optional function which compares the selected value to the
 *   previously selected value
 * @returns A read-only signal of the selected value
 */
export function useSelector<TStore extends Store<any, any>, T>(
  store: TStore,
  selector: (snapshot: SnapshotFromStore<TStore>) => T,
  compare: (a: T | undefined, b: T) => boolean = defaultCompare
): () => T {
  const selectorWithCompare = useSelectorWithCompare(selector, compare);
  const [selectedValue, setSelectedValue] = createSignal(
    selectorWithCompare(store.getSnapshot() as SnapshotFromStore<TStore>)
  );

  createEffect(() => {
    const subscription = store.subscribe(() => {
      const newValue = selectorWithCompare(
        store.getSnapshot() as SnapshotFromStore<TStore>
      );
      setSelectedValue(() => newValue);
    });

    onCleanup(() => {
      subscription.unsubscribe();
    });
  });

  return selectedValue;
}
````

<Note text="packages/xstate-store/src/solid.ts" />

Compare the `createEffect` logic to the `useSyncExternalStore` logic in React:

```typescript
// SolidJS style
createEffect(() => {
  const subscription = store.subscribe(() => {
    const newValue = selectorWithCompare(
      store.getSnapshot() as SnapshotFromStore<TStore>
    );
    setSelectedValue(() => newValue);
  });

  onCleanup(() => {
    subscription.unsubscribe();
  });
});

// React style
return useSyncExternalStore(
  useCallback(
    (handleStoreChange) => store.subscribe(handleStoreChange).unsubscribe,
    [store]
  ),
  () => selectorWithCompare(store.getSnapshot() as SnapshotFromStore<TStore>),
  () =>
    selectorWithCompare(store.getInitialSnapshot() as SnapshotFromStore<TStore>)
);
```

<Note text="createEffect strikes me as so much more intuitive" />

There's a lot of implicit and hidden behaviour in the React code.

#### Making sure it builds for development and testing

In order to get building and testing working, a few changes were necessary:

- solid-js needed to be added to the xstate/store dev and optional peer dependencies
- I needed to create a new `packages/xstate-store/solid` directory with a `package.json` to export this baby function into the world
- `solid-testing-library` would be useful, and it's already in use in the `xstate/solid` package
- Various little bits of configuration needed to be updated to accommodate and use the new code

The easiest way to do most of this was again to follow the convention already used for the React bindings. In this case, I needed to add exports, files, and preconstruct entry points to `xstate/store`'s `package.json`:

```json
  ...,
  "exports": {
    "./react": {
      "types": {
        "import": "./react/dist/xstate-store-react.cjs.mjs",
        "default": "./react/dist/xstate-store-react.cjs.js"
      },
      "module": "./react/dist/xstate-store-react.esm.js",
      "import": "./react/dist/xstate-store-react.cjs.mjs",
      "default": "./react/dist/xstate-store-react.cjs.js"
    },
    "./solid": {                                             // [!code ++]
      "types": {                                             // [!code ++]
        "import": "./solid/dist/xstate-store-solid.cjs.mjs", // [!code ++]
        "default": "./solid/dist/xstate-store-solid.cjs.js"  // [!code ++]
      },                                                     // [!code ++]
      "module": "./solid/dist/xstate-store-solid.esm.js",    // [!code ++]
      "import": "./solid/dist/xstate-store-solid.cjs.mjs",   // [!code ++]
      "default": "./solid/dist/xstate-store-solid.cjs.js"    // [!code ++]
    },                                                       // [!code ++]
  },
  "files": [
    "dist",
    "react",
    "solid"
  ],
  "preconstruct": {
    "umdName": "XStateStore",
    "entrypoints": [
      "./index.ts",
      "./react.ts",
      "./solid.ts"
    ]
  }
```

<Note text="packages/xstate-store/package.json" />

Finally I needed to include instructions in `babel.config.js` to include any new SolidJS test files in an override which uses `babel-preset-solid`. There was already an override for the `xstate/solid` package, so I just needed to add my test file to the existing regular expression:

```json
  overrides: [
    {
      ...
    },
    {                                             // [!code ++]
      test: /\/xstate-solid\/|solid\.test\.tsx$/, // [!code ++]
      presets: ['babel-preset-solid']             // [!code ++]
    }                                             // [!code ++]
  ],
```

<Note text="babel.config.js" />

## Wrap up

### Writing tests

Most package managers these days make it painless to install and use local packages, so when you fork something you can install it like this:

```
pnpm add ../xstate/packages/xstate/store
```

This creates a symbolic link which is convenient for picking up changes as you work. When I built `xstate`, I could restart my language server in the editor that's using `xstate/store` and immediately see my changes. I love how easy this has gotten over the years.

My main goal with the tests was to ensure that a) I could react to specific store changes and ignore others, and b) components rerender exactly as I'd expect and want them to.

I noticed a lot of people check for rerenders in SolidJS using variables scoped outside of components, where they selectively opt to increment them in contexts where they think the component would rerender. This seemed pretty flimsy so I looked for more reliable ways, and I think I found something in `createRenderEffect`. I created a little utility to drop into components where you expect (or don't expect) rerenders called `useRenderTracker`, and I like it:

```typescript
/** A function that tracks renders caused by the given accessors changing */
const useRenderTracker = (...accessors: Accessor<unknown>[]) => {
  const [renders, setRenders] = createSignal(0);

  createRenderEffect(() => {
    accessors.forEach((s) => s());
    setRenders((p) => p + 1);
  });

  return renders;
};
```

<Note text="packages/xstate-store/test/solid.test.tsx" />

Along with this I wrote a few tests to validate `useSelector`'s behaviour. It went surprisingly smoothly.

### Creating a changeset

Creating a changeset was pleasantly easy, and I haven't encountered the tool they're using before. It guides you through choosing which packages should be included in the changeset, if it's a major or minor change, and adding a message describing the changes. This is great, and something I'd like to add to projects in the future.

### The pull request

[Here's the final PR!](https://github.com/statelyai/xstate/pull/5056){target="\_blank"} Hopefully it's put to good use.

## Closing

I think I'll contribute to XState more often. The team is super responsive and kind, the software is amazing, and there's a lot I could learn in there. The library has had such a positive impact on my career.
