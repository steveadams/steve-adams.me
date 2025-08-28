---
title: "Building Minesweeper with @xstate/store"
date: "2024-09-21T01:15:35.000Z"
slug: "building-minesweeper-with-xstate-store"
description: "@xstate/store is my new favourite lightweight state management tool. It integrates perfectly with all kinds of applications, backend or frontend, including those using React or SolidJS. Here's a bird's eye view of implementing minesweeper with @state/store, SolidJS, and ts-pattern."
image: "/images/2024/09/CleanShot-2024-09-20-at-18.36.43@2x.png"
---

State management is hard. If I had to guess, maybe most bugs I work on are some form of errant, brain-derived state management issues. This is an account of trying to find ways to make it less hard, hopefully use my brain less so it can't get in the way, and have some fun in the process.

## Why @xstate/store?

At first glance I thought "Why wouldn't I use x, y, or z state management library", but then something about the tiny API and event-driven nature sucked me in. After testing it out on some smaller problems I started to think there was definitely something worthwhile here. On top of being an excellent little store on its own, it integrates seamlessly with XState, and I love XState.

I'm pretty sure by the end of this you'll see the merits as well. This is a great library with a lot of potential.

## Why minesweeper?

I implemented it with state machines and the actor model a while back, and it was grotesque. It worked (really well) but it was way too much ceremony for a relatively simple game. I'm sure some people golf this in like 5 LOC.

I wanted to see how safe and robust I could get the game with a much simpler form of state management.

This isn't a complete guide, but it'll give you a sense of how to build the game with @xstate/store and these tools, and an idea of what it's like to work with the libraries.

## Project Outline

My goal from the outset was to essentially create a data structure with associated operations that can only perform valid updates. This can't be guaranteed at the type level here (transitions will let you return any possible state you want), but I found I could make it work really well regardless.

With some loose ideas of how to do that (only operate on known data types, only return states I know are valid, etc) I just needed to implement the game with that data and the events.

Before writing code, I like to have some some kind of a spec. I'm roughly going off of how the classic game works, but I'm sure there are plenty of variations:

- **Set up**
  - The grid can be configured with a 2 dimensional size and number of mines
  - The player gets as many flags as the grid has mines when the game starts
- **Controls**
  - Left-clicking reveals a cell, context-clicking sets a flag
  - The player can click the face the reset the game at any time
  - Chording is a thing, but I don't want to implement it
- **Implicit Behaviours**
  - The game is started when a cell is revealed or a flag is set
  - A timer begins as soon as the game is started
  - The game stops as soon as the player wins or loses
  - When a cell is revealed with no adjacent mines, neighbouring cells can also be revealed.
- **Rules**
  - If a cell is revealed to be safe, it displays the number of mines directly adjacent to it
  - If there are no adjacent mines, the adjacent tiles are recursively revealed using the same rules.
  - If the player reveals all cells without mines, they win
  - If the timer runs out, the player loses
  - If a mine cell is revealed, the player loses
  - You can never set more than (width \* height - 1) mines; we need at least one empty spot on the grid

And that's enough to describe our context and events!

### Data and types

I took a data-first rather than type-first approach here. By defining the data structures that make sense for the game I could then derive or infer types from that point on, and they'd always be correct (in theory).

This is great for validation and pattern matching in a type-safe way where the source of truth for types is aligned with things actually happening at runtime. Basically you can't really mess up your types by trying to be clever; they're derived from the data. You don't need to be clever at all, and that's usually ideal.

For now I'm using ts-pattern to help with this, though lately I've been using Effect and I've come to prefer it. In this case it's a bit too much overhead for what we're trying to achieve, and ts-pattern's simpler API gives us exactly what we need, so it's still great.

With that settled, here are the initial definitions of the game's data:

```typescript
import { P } from "ts-pattern";

const baseCell = P.shape({
  revealed: P.boolean,
  flagged: P.boolean,
  mine: P.boolean,
  adjacentMines: P.number,
});

export const coveredCell = baseCell.and({ revealed: false, flagged: false });
export const coveredCellWithoutMine = coveredCell.and({ mine: false });
export const coveredCellWithMine = coveredCell.and({ mine: true });

export const flaggedCell = baseCell.and({
  revealed: false,
  flagged: true,
});

export const revealedCell = baseCell.and({ flagged: false, revealed: true });
export const revealedCellWithMine = revealedCell.and({ mine: true });
export const revealedClearCell = revealedCell.and({ mine: false });

// This creates our
export const cell = P.union(
  coveredCell,
  coveredCellWithMine,
  coveredCellWithoutMine,
  flaggedCell,
  revealedClearCell,
  revealedCellWithMine
);

export const gameState = P.shape({
  config: P.shape({
    width: P.number,
    height: P.number,
    mines: P.number,
    timeLimit: P.number,
  }),
  cells: P.array(cell),
  visitedCells: P.set(P.number),
  status: P.union("ready", "playing", "win", "lose"),
  cellsRevealed: P.number,
  flagsLeft: P.number,
  playerIsRevealingCell: P.boolean,
  timeElapsed: P.number,
});
```

<Note text="The data required to represent the state of a game of minesweeper. You could get away with defining cells more loosely, but there's a reason I went crazy here." />

These shapes are enough to infer types from and then pattern match in downstream code in order to ensure I’m always working with the type of data I expect to be. Here's how to derive the types:

```typescript
import { createStore, SnapshotFromStore } from "@xstate/store";
import { P } from "ts-pattern";

import { cell, gameState, revealedCell } from "./data";

export type RevealedCell = P.infer<typeof revealedCell>;
export type Cell = P.infer<typeof cell>;
export type GameContext = P.infer<typeof gameState>;
export type Cells = GameContext["cells"];
```

<Note text="Enough types to keep us safe! Not enough to scare our coworkers." />

### Events

I could define events as data first as well, but I don’t expect to need to validate or pattern match on event data, and the store itself provides solid type safety here already. A type or interface should be fine for this step.

The EmittedEvent type isn't strictly required for @xstate/store, but it's a neat feature in version 2.4 that I wanted to experiment with. In your store—unless it's useful to you—you can skip over it:

```typescript
export type GameEvent = {
  initialize: { config: GameContext["config"] };
  startPlaying: object;
  revealCell: { index: number };
  toggleFlag: { index: number };
  setIsPlayerRevealing: { to: boolean };
  tick: object;
  win: object;
  lose: object;
};

export type EmittedEvent = {
  type: "endGame";
  result: "win" | "lose";
  cause: string;
};

export type GameStore = ReturnType<
  typeof createStore<GameContext, GameEvent, { emitted: EmittedEvent }>
>;
export type GameSnapshot = SnapshotFromStore<GameStore>;
```

<Note text="The events required to facilitate a game of minesweeper! You could pull a couple, but I like limited-scope event handlers." />

All together we can now derive the store's type:

```tsx
type GameStore = ReturnType<
  typeof createStore<GameContext, GameEvent, { emitted: EmittedEvents }>
>;
```

<Note text="There's a ton of useful data right here. I find this really impressive." />

This type can be used to tighten all kinds of logic pertaining the the store now. You could make all of your event handlers external functions you assign to the store so you can test them in isolation, or get the store's snapshot type in order to allow you to write isolated functions which safely operate on your state. It's pretty useful.

### Defining the store

My goal here was to be as minimal as I can be without making it needlessly awkward or compromising safety. In this case I think it's a good size of store and few enough events that we can reason about the game easily. I like it. Put together, the store structure looks like this:

```typescript
createStore<GameContext, GameEvent, { emitted: EmittedEvents }>({
  types: {} as { emitted: EmittedEvents },
  context: {
    // Set an initial context based on the schema
  },
  on: {
    initialize: () => {
      // Reset store for a new game
    },
    startPlaying: { status: "playing" },
    win: { status: "win" },
    lose: (ctx) => ({
      status: "lose",
      cells: // reveal all of the remaining mines in the grid
    }),
    revealCell: (ctx, event) => {
      // Implement recursive mine-revealing logic
    },
    toggleFlag: (ctx, event) => {
      // Toggle a cell's flag according to the rules laid out
    },
    setIsPlayerRevealing: (ctx, event) => {
      // Update the state to indicate that the player is/is not about to reveal a cell
    },
    tick: (ctx, _, { emit }) => {
      // Increment the timer. End the game is time is up.
    },
  },
});
```

<Note text="This is beautiful." />

Nice! This is a solid foundation. These are all of the possible handlers needed for the game to work.

Now I just need to make sure each event manages state safely and the UI calls the events appropriately. How hard can it be?

### Done! Kind of.

Well, except for the transition logic. Otherwise this is all your store will be in your code base apart from the odd store.send(event) call. Isn't that crazy? It reminds me a lot of XState. It does such a good job staying out of the way. This is such an invaluable aspect of good software.

## Implementation and runtime safety

I'm not going to go too far into how to build minesweeper (it has been done thousands of times in at least half as many ways), but I'll cover a few parts I like where we can leverage our data structures, types, and the store to get pretty solid safety in such a small package.

I decided to use SolidJS for the UI here, but you could use anything. Even vanilla JS would be fine, but I wanted to test useSelector from @xstate/store/solid (see a [post about that here](./bringing-solid-js-bindings-to-xstate-store)).

### An unrelated obstacle: SolidJS isn't React

Right out of the gate I discovered SolidJS doesn't support a pattern I love, which is using match from ts-pattern to determine which UI components I want to render according to which data structure I'm matching on.

In React land this works really well, but for not-entirely-great reasons: it reruns your component's function on every render. This means your match is called each time your state changes (great) but it also means everything else about the component is run again as well (not great). It's a double edged sword I guess.

In SolidJS land, a component's function runs exactly once. Your match is run once and you're stuck with what it matched on even as signals within the component update. There are ways around this, but as far as I was able to determine, they break conventions and ultimately you lose out on fine-grained reactivity. A significant point of this endeavour was to get fine-grained reactivity from this store, so... I went with the SolidJS primitives Switch and Match. They're good, but not exhaustive. I'll find a way around it eventually.

### Getting the data you want

Once you're outside of the store in UI land (or where ever you happen to be), it's pretty easy to pull data from the store. I like to use selectors out of habit (unless I'm directly accessing primitive data types), but you can either do that or pull from the snapshot.

Here's an example based on the GameInfo component (where the flags, little face, and timer go in a typical minesweeper game):

```tsx
export const GameInfo: Component = () => {
  const store = useStore();
  const config = useStoreSelector(({ context }) => context.config);
  const flagsLeft = useStoreSelector(({ context }) => context.flagsLeft);
  const time = useStoreSelector(({ context }) => context.timeElapsed);
  const face = useStoreSelector(faceEmoji);
  const gameStarted = useStoreSelector(gameIsStarted);
  const gameLost = useStoreSelector(gameIsOver);
  const gameWon = useStoreSelector(gameIsWon);

  let interval: number | undefined;

  createEffect(() => {
    if (gameStarted()) {
      interval = window.setInterval(() => store.send({ type: "tick" }), 1000);
    }
  });

  createEffect(() => {
    if (gameLost() || gameWon() || !gameStarted()) {
      interval = resetInterval(interval);
    }
  });

  onCleanup(() => {
    interval = resetInterval(interval);
  });

  return (
    <div class="flex justify-between font-mono text-xl mb-4">
      <div role="meter">🚩 {flagsLeft()}</div>
      <div id="game-status">
        <button
          onClick={() => store.send({ type: "initialize", config: config() })}
          aria-label="face"
        >
          {FACES[face()]}
        </button>
      </div>
      <time role="timer" datetime={`PT${time().toString()}S`}>
        {time().toString().padStart(3, "0")}
      </time>
    </div>
  );
};
```

<Note text="It's about as easy as it gets." />

### Rendering exactly what you meant to

After defining all of these cell data structures and getting a discriminated union out of them, you can use it to ensure you’re always rendering the right component (cells in my case). As mentioned, in React you can do this exhaustively (which is so nice), but in SolidJS you can still get a fairly ergonomic and safe solution.

By using isMatching from ts-pattern you can be certain it’s matching on the data properly, even though you can't use match:

```tsx
export const CellButton: CellComponent = (props) => {
  const { cell } = props;

  return (
    <Switch fallback={<div>Unknown cell</div>}>
      <Match when={isMatching(coveredCell, cell())} keyed>
        <CoveredCell {...props} />
      </Match>
      <Match when={isMatching(flaggedCell, cell())} keyed>
        <FlaggedCell {...props} />
      </Match>
      <Match when={isMatching(revealedClearCell, cell())} keyed>
        <RevealedCell {...props} />
      </Match>
      <Match when={isMatching(revealedCellWithMine, cell())} keyed>
        <RevealedMine {...props} />
      </Match>
    </Switch>
  );
};
```

<Note text="Every runtime cell state we need to handle! It isn't exhaustive at the type level, but we can mitigate some risks with tests (or use React, I guess). Figuring out how to do this better is on my TODO list." />

Now all I needed to do in order to render these cells and get the fine grained reactivity I wanted is to iterate over them with SolidJS's Index component:

```tsx
export const Minesweeper: Component = () => {
  const store = useStore();
  const cells = useSelector(store, ({ context }) => context.cells);

  return (
    <Index each={cells()}>
      {(cell, index) => <CellButton cell={cell} index={index} />}
    </Index>
  );
});
```

<Note text="Index is a primitive for iterating over lists with a known length. For less boring data, the For primitive is better suited." />

Nice. So, that'll just dump out a big flat list of cells. That won’t work for actually playing, but it’s not hard to fix with a bit of tailwind and inline css:

```tsx
export const Minesweeper: Component = () => {
  const store = useStore();
  const cells = useSelector(store, ({ context }) => context.cells);

  return (
    <div class="flex justify-center">
      <div
        class="grid gap-1 min-w-min"
        style={`grid-template-columns: repeat(${width()}, 1fr);`}
        role="grid"
      >
        <Index each={cells()}>
          {(cell, index) => <CellButton cell={cell} index={index} />}
        </Index>
      </div>
    </div>
  );
});
```

<Note text="Inlining is fine if it's a game because anything goes in game development." />

In the implementation of the store logic I'm using math to treat the list like a grid. It's possible to use a 2D array here with nested Index components, but I wasn't able to get the reactivity or tiny DOM updates I knew were otherwise possible so it didn't seem worthwhile.

### A convention for handling event data precisely

Another way in which the data structures and pattern matching help out is that they not only define data, but to a degree, intent. This is great in logic where we might reason about objects like real things, and treat them as such, but where the underlying implementation of that data could change.

Take for example when I want to reveal a cell. I’ve got options, but I think the two most obvious ones are these:

1. Determine at the UI layer which kind of cell I’m revealing and send the corresponding event to the store.
2. Send a single event where the store can figure out what to do based on the event data.

The issue with 1 is that I really don't want my UI to know much about the store. I want the UI to be really dumb, and to interact with the smallest API possible where the implementation of that API is as irrelevant as possible.

The issue with 2 is that I then need much better safety in my event because I’m working with the least data and the most responsibility possible. The good news is that with the approach I’m using, it's trivial to mitigate that concern.

For example, when handling a revealCell event, I only get an index to look up the cell with. That's enough though, because I can fetch the cell and check the only two conditions in whichI’d need to react, then do the appropriate thing in response:

```typescript
createStore({
  // store info
  on: {
    // other event handlers
    revealCell: (ctx, event, { emit }) => {
      const cell = ctx.cells[event.index];

      return match(cell)
        .with(coveredCellWithoutMine, () => {
          // Reveal a safe cell
        })
        .with(coveredCellWithMine, () => {
          // Reveal a mine
        })
        .otherwise(() => {
          // Do nothing
        });
    },
  },
});
```

<Note markdown="`revealCell` is a lot more limited in how it can fail now, and the store is *more reliable* as a result" />

The alternative to this might be some fragile logic like this:

```typescript
createStore({
  // store info
  on: {
    // other event handlers
    revealCell: (ctx, event, { emit }) => {
      const cell = ctx.cells[event.index];

      if (!cell) {
        return ctx;
      }

      const isCovered = !cell.revealed && !cell.flagged;

      if (isCovered && !cell.mine) {
        // Reveal a safe cell
      } else if (isCovered && cell.mine) {
        // Reveal a mine
      } else {
        // Do nothing
      }
    },
  },
});
```

<Note text="A lot more can go wrong here." />

This might look okay on the surface, and even familiar or comfortable to a lot of us, but there's a major issue here. If the implementation of a cell changes _at all_, these conditions could fail.

I don't want to check against flags explicitly. I want to check against types in a much more complete sense. This is where definitions of the possible cell states become an expression not only of state but intent; how I intend the logic to handle states, how I intend the game to be played, and so on. This means I can modify the underlying data structures and leave the match(cell) code exactly as is, because it'll still be matching on the same types of cells - even if property names or potential property values change.

This kind of idiomatic code has been popular in the object oriented world for decades, but that’s often riddled with all kinds of associated complexity and implicitness. In this case, we’re working with plain JavaScript objects. There’s nothing waiting to surprise us here.

Something I also appreciate is that an if statement only expresses the intent to check arbitrary conditions. A switch statement is better, but still doesn't protect us against the underlying implementation shifting. With a match, we can see at the top level exactly what's being matched, what the output can be, if it’s checking all possible conditions, and whether or not it's guaranteed to return a value. That's awesome.

### Connecting events to the UI

It’s very straight forward to connect the UI with the store. In the case of the cells, the most interactive component is the CoveredCell. It leads to all others forms of cells, and apart from the flagged cell, it's the only one with event handlers. It’s a great example of how to hook up events:

```tsx
// This button is composed in all cells (cells are just buttons internally)
const BaseButton: Component<JSX.ButtonHTMLAttributes<HTMLButtonElement>> = (
  props
) => (
  <button
    {...props}
    class={`flex aspect-square size-10 rounded-sm text-white focus:outline-none focus:ring-2 focus:ring-offset-2 items-center justify-center ${
      props.class || ""
    }`}
    role="gridcell"
  >
    {props.children}
  </button>
);

type CellComponent = Component<{
  cell: Accessor<Cell>;
  index: number;
}>;

const CoveredCell: CellComponent = ({ index }) => {
  // I've got my store in a context, but you can get it any way you like
  const store = useStore();
  // I've also abstracted my store selection, but you can use `useSelector` the same way
  const revealing = useStoreSelector(
    ({ context }) => context.playerIsRevealingCell
  );

  // All you need is to define a function which sends the event as required
  const revealCell = () => store.send({ type: "revealCell", index });

  // Like so...
  const toggleFlag = (e: MouseEvent) => {
    e.preventDefault();
    store.send({ type: "toggleFlag", index });
  };

  const setRevealing = (e: MouseEvent) => {
    if (e.button === 0) {
      store.send({ type: "setIsPlayerRevealing", to: true });
    }
  };

  const unsetRevealing = (e: MouseEvent) => {
    if (e.button === 0 && revealing()) {
      store.send({ type: "setIsPlayerRevealing", to: false });
    }
  };

  // Then assign them like you would any other DOM event handlers:
  return (
    <BaseButton
      class="bg-slate-900 hover:bg-slate-700 focus:ring-slate-400 dark:bg-slate-700 dark:hover:bg-slate-600"
      onClick={revealCell}
      onContextMenu={toggleFlag}
      onPointerLeave={unsetRevealing}
      onPointerDown={setRevealing}
      onPointerUp={unsetRevealing}
      data-covered
    ></BaseButton>
  );
};
```

<Note markdown="SolidJS's lack of `useCallback` in this snippet is refreshing." />

Once you load the page, your button (or whatever you created) will be talking to your store and the state changes will be propagating to your components.

### Put it all together and...

It works really well!

By combining all of these patterns, you wind up with a remarkably reliable and robust state management tool. Once I'd implemented all of my logic, my store (representing the entire game's logic) came to about 250 LOC despite me not taking many efforts to minimize that metric. Although it isn't very large, it's very robust, easy to read or change, and extremely straight forward to test.

I'm sure some leetcoder could point out some really bad ideas in here and cut the logic down quite a bit. I'm alright with that. Check out the [entire store implementation here](https://github.com/steveadams/minesweeper-store/blob/main/src/store/store.ts){target="\_blank"}.

## On emitted events

One final thing I wanted to touch on is the emitted events I defined which don’t get sent to the store. As of version 2.4.0, a store can emit events—which has important implications within the XState ecosystem—but also for the standalone stores as well.

Emitted events are kind of like "fire and forget" events. If something is interested in listening to them it can do whatever it want with them, and if it isn't interested that's fine as well. They're great for allowing consumers to opt in to knowing that certain things have happened, even if the store logic doesn't care about it.

In the case of minesweeper, I'm using these emissions to let the UI layer implement handling of when the player wins or loses. For example, take a look at the tick event handler:

```typescript
tick: (ctx, _, { emit }) => {
  const timeElapsed = ctx.timeElapsed + 1;
  const status = timeElapsed < ctx.config.timeLimit ? "playing" : "lose";

  if (status === "lose") {
    // Let anyone who's listen that it's game over (and why)
    emit({
      type: "endGame",
      result: "lose",
      cause: "You ran out of time.",
    });
  }

  return { timeElapsed, status };
},
```

I wouldn't want my tick event to have an opinion on how the consumer (the UI in this case) handles this information, but if a consumer of the store wants to, they now have the option to hook into that event:

```tsx
export const Minesweeper: Component = () => {
  const store = useStore();
  // ...

  onMount(() => {
    const endGameSub = store.on("endGame", (event) => {
      match(event.result)
        .with("win", () => {
          store.send({ type: "win" });
          toast.success(`You won! ${event.cause}`);
        })
        .with("lose", () => {
          store.send({ type: "lose" });
          toast.error(`You lost! ${event.cause}`);
        })
        .exhaustive();
    });

    onCleanup(() => {
      endGameSub.unsubscribe();
    });
  });

  return (
    // ...
  );
});
```

<Note text="This opens up a ton of possibilities for reducing store logic in some cases, or allowing consumers to handle key events how they'd prefer to" />

Again, matching on possible event values mean if this event ever changes, I’ll know immediately and be able to update the handler accordingly.

## Testing revisited

I made a note about testing earlier, and I won't go into it too deeply here. Something I noticed while working on this though is that this way of modelling state, while not quite as rock-solid as a state machine, is very nice to model tests around. Once you have your context events defined, it becomes relatively clear what kinds of states you want to validate and the edge cases you want to rule out.

Really, the process of writing the [integration tests](https://github.com/steveadams/minesweeper-store/blob/main/src/components/App.test.tsx){target="\_blank"} for this game took very little time and once I was finished, changing implementations very rarely caused the tests to fail. It's a really nice pattern.

```bash
 RERUN  src/components/App.test.tsx x26

 ✓ src/components/App.test.tsx (13) 1067ms
   ✓ game state interactions (6)
     ✓ starts the game once a cell is revealed
     ✓ starts the game once a cell is flagged
     ✓ ends the game once a mine is revealed
     ✓ tracks time and ends the game at 999 seconds
     ✓ shows a worried face as a cell is being revealed
     ✓ doesn't show a worried face as a cell is being flagged
   ✓ cell interaction behaviours (3)
     ✓ reveals neighbouring cells with adjacent mines
     ✓ revealing neighbouring cells with adjacent mines shows adjacent mine count
     ✓ reveals no neighbouring cells if target has adjacent mines
   ✓ game controls and settings (4) 589ms
     ✓ resets the game when the face is clicked
     ✓ can initialize preset games
     ✓ can initialize custom game settings
     ✓ cannot initialize custom game settings with invalid or missing values

 Test Files  1 passed (1)
      Tests  13 passed (13)
   Start at  17:53:53
   Duration  1.31s


 PASS  Waiting for file changes...
       press h to show help, press q to quit

```

<Note>🤩</Note>

## Give it a try!

You can try this game out yourself [here](https://storesweeper.steve-adams.me/){target="\_blank"} (don't mind the ugly UI), and check out the repository [here](https://github.com/steveadams/minesweeper-store){target="\_blank"}.

I've had a ton of fun experimenting with this store and I'm going to be using it a lot in the future. It's a great blend of features, and the resulting performance for most applications would be excellent. I really can't see a reason not to check it out.

## What would I like to see in @xstate/store?

At the moment it's a great library, but there are a couple things I'd love to have:

### Type-safe event transitions

If I could guarantee that an event can only return the context in a certain state (Or a partial context matching a certain state), this could lead to super-tight and reliable transitions. What I've got above is good enough and likely better than most state management I encounter in the wild, but it _could_ be better at the type level without much application-level ceremony required. That would be awesome.

I've taken a crack at making this possible to a degree, and it's fairly easy to accomplish by removing the option to assign partial context values to the store, but that's a massive departure from the current feature-set. I considered something like a createStrictStore function which returns a store that only allows complete assignments, but it seems awkward as well. It does allow for slightly safer transitions if used with discriminated unions of your valid states, but there's nothing stopping you from returning a "valid state" in the wrong transitions.

So, ultimately the best case scenario would be the ability to define that in _x_ transition I can only return *y *context.

### Some kind of middleware

I don't recall why it occurred to me on this project, but it struck me that it would be awesome to be able to pass middleware to the store.

At the moment you can subscribe to a store and watch changes externally, but I think what I'd like to see is some kind of pipeline internal to the store which allows you to (optionally) intercept and process events, emissions, and assignments. The intent wouldn't be to modify the underlying store logic. Instead I think I'd like to see it provide an API for adding guards, "always" or "after"-like actions, inspection and logging, persisting state, and so on.

I think there's a way this could be opt-in and very useful without making the store too complicated/losing its appeal. Regardless, it's good enough as it is. I really like it.

## The end

How did you get this far? You must really like minesweeper.
