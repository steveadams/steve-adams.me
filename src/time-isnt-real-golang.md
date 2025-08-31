---
title: "Time Isn't Real: Schedules in Go with Channels and Signals"
date: "2023-10-27T20:03:00.000Z"
slug: "time-isnt-real-golang"
description: "Can't use cron, but can use go? No problem. Avoid the perils of writing really bad code like me and learn to use channels and signals properly. You can even test it!"
image: "https://images.unsplash.com/photo-1643424975787-f134e78ecbc8?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3wxMTc3M3wwfDF8c2VhcmNofDU3fHxjbG9ja3xlbnwwfHx8fDE3Mjc5MzYyOTB8MA&ixlib=rb-4.0.3&q=80&w=2000"
---

Last week I had a problem I hadn't encountered before. I was writing a service based around daily scheduling, and while cron would have been a really useful tool, I couldn't deploy my program to a server that supported it. Under the circumstances it simply wasn't an option. I did however have Go, so I gradually started piecing together a solution.

The requirements seemed simple enough: after the program is started, wait until 10am UTC to execute, then execute every 24 hours thereafter.

Just wait until 10am, run the function, then sleep for 24 hours! Right?

## Whoops: time.Sleep() Is blocking in Go

It turns out sleeping blocks Go programs—or at least the parts of it that you're sleeping in—which maybe could have been acceptable except that for development and debugging purposes it was totally unacceptable.

Having written JavaScript for a long time I'm not really sure what I expected. I suppose I expected Go to be a little more clever or capable, but lesson learned I guess.

I wasn't able to capture os.Interrupt or os.Kill signals in order to cancel the context in which that task was running, so the only opportunity to gracefully shut down was the brief period every 24 hours in which it stopped sleeping in order to run tasks.

Not being able to stop a program once it starts is such a bad feature that you might call it a bug. I started to dig around to find solutions, and found one I really like and thought was worth mentioning here. It isn't just nice for this task in particular, but an awesome pattern I think I'll use often in Go.

## Tickers and channels

I think a great way to frame this is that _time isn't real_, and programming as though it is can be a bad idea. We try to create nice familiar abstractions (like sleeping for a duration of time) so temporal logic is easier to reason about, but it tends to introduce bugs that are very hard to understand and uncover. Some light abstraction is often helpful, but I think this example is well within the bounds of where it becomes problematic to abstract it around typical human mental models.

Where time.Sleep() _feels_ like the right tool (we don't want to do anything while we wait for ~24 hours), it comes with baggage that gets in our way. What we're really aiming to do here isn't necessarily wait for a duration at all; we simply want functions to be called according to time-based events. It's kind of a semantic mistake, but my problem was still due to modelling the problem incorrectly in my head.

So, how would you model this if it weren't temporal? In Go, I started to realize a lot of people would use channels to arbitrarily trigger executions, but I wasn't aware of a good way to do this. It turns out [time.Ticker](https://pkg.go.dev/time#Ticker) is meant for exactly this purpose: it repeatedly produces a signal on a dedicated, internal channel (Ticker.C) after the elapse of a [time.Duration](https://pkg.go.dev/time#Duration) up until [Ticker.Stop()](https://pkg.go.dev/time#Ticker.Stop) is called.

## A solution

Here's how a function might work with a start and delay, waiting to execute and then executing for each passage of the delay duration:

```go
func Forever(ctx context.Context, start time.Time, delay time.Duration) <-chan time.Time {
  // Create the channel which we will return
  stream := make(chan time.Time, 1)

  // Calculating the first start time in the future
  // Need to check if the time is zero (e.g. if time.Time{} was used)
  if !start.IsZero() {
    diff := time.Until(start)

    if diff < 0 {
      total := diff - delay
      times := total / delay * -1

      start = start.Add(times * delay)
    }
  }

  // Run in a goroutine or it will block until the first event
  go func() {
    // Add the first scheduled call once it gets to the start time
    t := <-time.After(time.Until(start))
    stream <- t

    // Start the ticker
    ticker := time.NewTicker(delay)
    defer ticker.Stop()

    for {
      select {
      // Listen to the ticker and pass its events to the stream
      case tickerSignal := <-ticker.C:
        stream <- tickerSignal
      // Listen for cancellation to escape the process
      case <-ctx.Done():
        close(stream)
        return
      }
    }
  }()

  return stream
}
```

To use this, we can create a context (in this case, one which is cancelled by os.Interrupt or os.Kill), then the start and delay parameters. In my case I needed to run at 10am UTC, then every 24 hours:

```go
ctx, _ := signal.NotifyContext(context.Background(), os.Interrupt, os.Kill)

oneDay := time.Hour * 24
start := time.Now().UTC().Truncate(oneDay).Add(time.Hour * 10)

for range util.Forever(ctx, start, oneDay) {
  // call my function
}

```

By iterating over the values returned from Forever, you can then do whatever you need to do at each tick of the time.Ticker instance within.

Although this implementation is somewhat specific to my task at hand, the concept itself is powerful and I was pretty happy with the improvement. It was no longer tied as tightly to time, and the concept of a stream of events can be extended to meet all kinds of requirements.

## Testing temporal code

This was the second snag I hit. I wanted to ensure my timing-based logic was correct, so I did allow for some tests to actually wait for Forever to execute. This forces some hard-coded delay into the testing pipeline, but given that the error margin in production would expand rapidly if there was a bug introduced, I felt comfortable keeping the delays short and the tests very few.

I also swapped in a private function to bypass time.NewTimer. In my case, it yields a Timer but it has been overridden to allow for sending signals on demand rather than waiting for the ticker:

```go
// By default, use time.NewTicker. In tests, substitute with a custom ticker to avoid
// waiting for ticks to complete in order to verify behaviours unrelated to timing
// Since this is private, it can only be overriden in tests.

var newTicker = time.NewTicker

func Forever(ctx context.Context, start time.Time, delay time.Duration) <-chan time.Time {

  // ...

  // Run in a goroutine or it will block until the first event
  go func() {
    // Add the first scheduled call once it gets to the start time
    t := <-time.After(time.Until(start))
    stream <- t

    // Start the ticker
    ticker := newTicker(delay)
    defer ticker.Stop()

    // ...

```

Then in the test, I define a function which overwrites newTicker to meet my needs:

```go
// useControlledTicker Override `newTicker` to use an externally controlled channel
// This allows tests to be progressed without actually waiting in order to confirm
// `newTicker` implementors have correct behaviours on ticks
func useControlledTicker(timeChannel chan time.Time) func() {
  originalNewTicker := newTicker

  // Returning a cleanup method to defer makes it easier to restore behaviour
  cleanup := func() {
    newTicker = originalNewTicker
  }

  // Substitute a time.Ticker with an externally controllable channel
  newTicker = func(delay time.Duration) *time.Ticker {
    return &time.Ticker{C: timeChannel}
  }

  return cleanup
}

```

In a test where the ticker needs to be controlled, I create a channel to control and pass it in:

```go
func TestForeverBehaviour(t *testing.T) {
  t.Parallel()

  // Create our externally controlled ticker.
  // Defer cleanup to ensure `newTicker` is reverted
  tickerChannel := make(chan time.Time, 1)
  cleanup := useControlledTicker(tickerChannel)
  defer cleanup()

  tests := []behaviourTest{
    // ...
  }

  for _, bt := range tests {

    t.Run(bt.name, func(t *testing.T) {
      var (
        tick int
        expectedTicks int
        start = bt.start()
      )

      ctx, cancel := context.WithCancel(context.Background())
      defer cancel()

      if bt.interruptOnTick > 0 {
        expectedTicks = bt.interruptOnTick
      } else {
        expectedTicks = maximumTicks
      }

    foreverLoop:
      for range Forever(ctx, start, 1337) {
        if tick == maximumTicks {
          cancel()
          break foreverLoop
        } else {
          tick++
        }

        if bt.interruptOnTick == tick {
          c := make(chan os.Signal)
          signal.Notify(c, os.Interrupt, syscall.SIGTERM)

          go func() {
            select {
            case <-c:
              // Shouldn't be an error yet...
              assert.Nil(t, ctx.Err())
            case <-ctx.Done():
              // Should have the cancelled error
              assert.Equal(t, ctx.Err().Error(), context.Canceled.Error())
            }
          }()

          break foreverLoop
        }

        // Immediately execute the next iteration (no waiting required!)
        tickerChannel <- time.Now()
      }

      // Did it stop early unexpectedly?
      assert.Equal(t, tick, expectedTicks)
    })
  }
}

```

I like it! It isn't perfect, but I find Go tends to land me close enough to 'good', rarely exactly where I'd like to be, so this is where I call it quits. There are ways to improve this but it's a great start.

## In closing

I hope this was helpful for giving some insights on working with channels and signals. And more importantly, how _not_ to think about time when solving problems like this. I try to remember: don't think about the logic of waiting. Focus more on when you need to execute.

There are versions of this type of logic where you wouldn't even need the delay (for example, if you only run one time per day and you're certain you'll never need to several times per day/hour/minute/etc). The simpler your time-handling logic is, the happier you'll be.
