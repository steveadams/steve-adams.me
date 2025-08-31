---
title: "Metaprogramming TypeScript with the Reflect API"
date: "2024-09-24T23:22:00.000Z"
slug: "metaprogramming-typescript-with-the-reflect-api"
description: "The Reflect API is a mystery to a lot of JavaScript developers. Let's take a look at a few of its features and see how it can be useful for basic metaprogramming in TypeScript."
image: "https://images.unsplash.com/photo-1727705744337-5da00ac764a6?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3wxMTc3M3wwfDF8YWxsfDI3fHx8fHx8fHwxNzI3OTM1NzU4fA&ixlib=rb-4.0.3&q=80&w=2000"
---

Do you ever wonder what exactly [Reflect](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Reflect) is for, and why you'd use it? You're not alone. In fact, there's a good chance a lot of people you work with have never heard of it.

Reflect's documentation covers a lot of lower-level, seemingly abstract ideas, which leads to it being unclear as to why you'd use it. This isn't because you're not catching on or understanding; it's because its functionality is narrow yet its capabilities are extremely broad.

Like generators, you can see this neat little contraption working, you see what it's doing, and you're left wondering _why_. Why do we need that? Can't I do that with a dozen other simpler, maybe even better solutions?

The answer is "usually, yes", but that's the boring answer. The more interesting answer is that when we understand lower level features like generators or Reflect, we can do way more interesting things, with more power, and sometimes with less code!

## What's Reflect good for?

The [MDN documentation of Reflect](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Reflect) does a good job of explaining what it's used for, but it might not be immediately obvious how it would be useful in your own work.

The reality is most of us won't usually need it. It isn't meant to be used all over your code, like switch or if statements. Generally speaking I'd expect to find it more often in relatively complex libraries where the usage of Reflect methods is hidden away. If you don't have an immediate use for it, don't worry! That's to be expected.

There are some key cases where it's particularly helpful though, and I'll outline them below.

### Interoperability with Proxies

Although Reflect can be used on its own, the API pairs really well with Proxies, providing excellent tools for metaprogramming. They work well together for several reasons:

1. Consistent behavior: The Reflect API provides a set of methods that mirror the internal methods of objects. These methods behave predictably and consistently, even if the object you're interacting with is a Proxy. This means that operations performed by Reflect will always work as expected, regardless of whether the target object is a Proxy or a POJO.
2. Sane defaults: Reflect methods provide the expected default behaviours for all object operations. When creating a Proxy, you can use these methods in your traps to easily implement default behaviour when you don't need to make modifications.
3. Effortless method forwarding: Along the same lines as sane defaults, in Proxy traps, you can easily use Reflect to forward operations to the target object. This is useful when you want to add some custom behaviour (such as side effects like logging) but still maintain the original functionality.
4. Better error handling: Reflect methods return boolean values for certain operations (like set and defineProperty) instead of throwing errors. This gives you better, more explicit control over how you handle errors within Proxy traps.
5. Simplification: The Reflect API methods correspond to the traps in a Proxy handler. This clear mapping between traps and their default implementations makes creating and managing Proxies much simpler.

Here's an example of forwarding inside of a Proxy:

```typescript
class Fish {
  species: string;

  constructor(species: string) {
    this.species = species;

    return new Proxy(this, {
      set(target, property, value) {
        console.log(`Setting species to ${value}`);
        return Reflect.set(target, property, value);
      },
      get(target, property) {
        return Reflect.get(target, property);
      },
    });
  }
}

const myFish = new Fish("betta imbellis");

console.log(myFish); // Fish: { "species": "betta imbellis" }

myFish.species = "Oncorhynchus kisutch"; // Logs "Settings species to Oncorhynchus kisutch"
console.log(myFish.species); // Logs "Oncorhynchus kisutch"
```

What's special here is that typically, you'd need a private property (\_species) to use with a getter and setter for species in order to avoid infinite loops from setting a value to species. If you directly set species inside of set, it'll recursively call set on itself. Here we've got an easily intercepted, clear, and reliable way of setting the property within a proxy.

Despite this pairing making it seem as though they're meant to be used together exclusively, you can use them in isolation without issues. In this post, I'm going to cover using Reflect on its own rather than with proxies; I think it's an easier way to introduce the concepts. Once they begin to sink in, understanding how it can be used with proxies becomes clearer very quickly.

### Data inspection and manipulation

On its own, Reflect is an excellent tool for inspecting and manipulating data at runtime. Although most of the features Reflect offers are already possible through other means (some of them very, very similar such as Object.ownProperties), Reflect offers a more consistent and concise API. Even better still is that the API throws fewer errors than counterpart methods or approaches, so you can write less code for data manipulation that's more expressive while allowing for better error handling.

An example I really appreciate would be methods like set (which appears functionally identical to writing code like obj.value = ...) returning a boolean value indicating whether or not set succeeded. This means you can have type-level safety into your operations as well, similar to in a language like Go where you often see value_set, err := Example.Set(someValue). In Go you will also get hassled if you don't handle the error which is great, but at least in JavaScript the operation won't throw an error and need to be wrapped in a try/catch statement.

### Intercession

Another great use case for Reflect is wrapping functions and ultimately using Reflect.apply to execute function that was wrapped. Other inspection and manipulation can occur in this process (such as using Reflect to apply a different context to the called function, or replacing its prototype), but in the end this is how you'd execute the function.

On that note, let's take a look at some examples! I'll start with intercession and Reflect.apply since it's a nice, easy intro.

## Intercepting and calling functions

You've likely seen something like this before. Reflect.apply is very, very similar to Function.prototype.apply.call, but _not quite_ the same. The most obvious difference is that it's more concise. However, right off of the bat, we get one clear advantage: Reflect.apply is a consistent method to apply parameters to functions we call, and we don't need to wonder whether we should use one of:

1. Use the root of the prototype chain: Function.prototype.apply.call()
2. Or use it directly on the function itself: theFunction.apply()
3. Or was it .call.apply()... Function.prototype.call.apply()

Somehow, each of these is valid:

```typescript
const steve = {
  name: "Steve",
  greet(salutation = "Hello") {
    return `${salutation}, I'm ${this.name}`;
  },
};

const bob = {
  name: "Bob",
};

// Borrow the greet method and apply it to bob
console.log(Reflect.apply(steve.greet, bob, ["Hi"])); // Hi, I'm Bob

// So... Which one is correct, when, and why?
console.log(Function.prototype.apply.call(steve.greet, bob, [])); // Hello, I'm Bob
console.log(Function.prototype.call.apply(steve.greet, [bob, "Hi"])); // Hi, I'm Bob
console.log(steve.greet.apply(bob, ["Go away"])); // Go away, I'm Bob
```

<Note text="What the hell?" />

Instead of guessing, you can stick to one consistent method which always does what you expect with the correct context and parameters. You can always dig in deeper and understand when and why you'd do each of these, but the reality is that Reflect is more consistent _and_ it performs slightly better than traversing the prototype chain.

### More interception: A simple log decorator

Here we can get a sense of how you'd use apply in combination with another feature. Decorators perform interception by design, so Reflect is a great way to guarantee we don't get any unintended side effects during the process. We can go as far as safely inspecting the result of the method we're intercepting:

```typescript
function logs(
  _target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor
) {
  const originalMethod = descriptor.value;

  descriptor.value = function (...args: any[]) {
    console.log(
      `Calling method ${propertyKey} with arguments: ${JSON.stringify(args)}`
    );

    // Run the original logic passed into the decorator
    const result = Reflect.apply(originalMethod, this, args);

    console.log(`Method ${propertyKey} returned: ${JSON.stringify(result)}`);

    return result;
  };

  return descriptor;
}

// Use the decorator as usual
class Calculator {
  @logs
  add(a: number, b: number) {
    return a + b;
  }

  @logs
  multiply(a: number, b: number) {
    return a * b;
  }
}

// Fire it up
const calc = new Calculator();

calc.add(5, 3);
// Logs:
// "Calling method add with arguments: [5,3]"
// "Method add returned: 8"

calc.multiply(4, 2);
// Logs:
// "Calling method multiply with arguments: [4,2]"
// "Method multiply returned: 8"
```

Very nice, right? You can immediately see how useful this is, especially when combined with the ability to swap contexts. Though that becomes exceptionally dynamic, it's not difficult to implement and the potential is pretty huge. You can check out the playground for this code [here](https://www.typescriptlang.org/play/?noUncheckedIndexedAccess=true&allowUnreachableCode=true&allowUnusedLabels=true&noUnusedLocals=true&noUnusedParameters=true&experimentalDecorators=true&emitDecoratorMetadata=true&suppressImplicitAnyIndexErrors=true&suppressExcessPropertyErrors=false&noImplicitUseStrict=true&useUnknownInCatchVariables=true&strictBuiltinIteratorReturn=true&noFallthroughCasesInSwitch=true&noImplicitOverride=true&noPropertyAccessFromIndexSignature=true#code/GYVwdgxgLglg9mABAGzgcwM4AoD6UCGATmgKZQBci+YAngDSIAOhcjJhUNA0iTZRlEIwwaBgBMSGCEMZQ4hSgAUWbDjQAik6TFnyAlIgDeAKESIICAYnkw0w-MgCyZABZwxiALyIJUmXMIAOgA3BxASAG5jUx8tf3kQsJIvRFBIWAQsQOyiTEpqGgBtAF0DEzMzCzAMOGQSQNQ0LAADAGEHZGE0RABbV3dEABJDZlZ2Th4aAF9EAHcYKBcqYhA+sCgMSmGAKQBlAHkAOUCBIREYYBosXIw9Kea9KJizAHoXxAAlcERF5Js7MAOFDoGAQJj4DAYEgeYRyH4uZISCyEfABCqIZ7mSxQRCESQgZA47wfEjAOrQQL4RiMZBXf72Jz9MQMRYwDAMG6PTGYqo1OoNdAtZyLAbDUaqCa8GZ4qAgQhgaFbQx7I4nQRdC5XPEYAlQO4PKLozEyuVIbW6w2IKZPMwm+WxPw6AJRKbRN6IACqUPhiJIyNR8ioGEQIB1DmMEGQEOD7WQEAJAcIRhiAAFGhgYvgxGJrpQwKsAEbsBgFvOF9hlY1kU1URAAakQBctrrMqfTMR6up0tNziHzPSLhBLZYHFeT6LtSHwiAAVI3m8ZXcZ3QAxGB4xALEOMCPY8wOMHeBWzRCx+NRgJYLkRg+U7NYACsDAAzFz3QAZdCbZfvABEsc6EReiZKhszmBYllyVYSHWTZEEKJ9n2KX8MXdX9hTcDwsw8SdFUQAAOX9oggW9O0JbsrgAFgYAAmN93k-PIf0Qf8Oi6YCRQ8MjYBpGhwMWZY0Gg2DKEKaiaOQ1C-wwgZuIo3Fq3lPDCKAA).

Moving on, let's take a look at getting, setting, and defining properties in an example you might actually use daily, even if you aren't directly interfacing with the Reflect API.

## Dynamically constructing type-safe data

An awesome library for data pipelines is [Effect](https://effect.website). I haven't looked at the source for their Data module, but it struck me as a perfect example for how you can use Reflect to create data structures safely, reliably, and with type safety.

This will give you a look at how you might use Reflect.defineProperty. What's great about this method is that it essentially gives you a standard, reliable, consistent way to operate on an object. There are other ways you can do this, many of which people use successfully, but this is a method which ensures consistency across all platforms and scenarios.

### Defining properties

First, take a look at the [Data API's struct method](https://effect.website/docs/other/data-types/data#struct). It takes a wobbly unsafe plain old JS object and transforms it into something immutable and strongly typed. Although this seems easy enough to do with TypeScript and objects at a glance, stick with this and see where it can go.

Let's take a shot at reproducing the struct method by iterating over the keys of the object and defining immutable properties for each key. From the top, we write something which looks like this:

```typescript
class Data {
  static struct<T extends object>(data: T): Readonly<T> {
    return Object.freeze(new DataStruct(data)) as Readonly<T>;
  }
}

// TODO
class DataStruct {
  ...
}
```

It takes the object, freezes it as a DataStruct, and returns that as read only. Inside of DataStruct is where the interesting things happen:

```typescript
// DataStruct doesn't need much typing since the type inference happens in the Data.struct method.
class DataStruct {
  constructor(data: object) {
    Reflect.ownKeys(data).forEach((key) => {
      Reflect.defineProperty(this, key, {
        value: (data as any)[key],
        writable: false, // Immutable properties
        enumerable: true,
      });
    });
  }
}

const coho = Data.struct({
  species: "Oncorhynchus kisutch",
  colors: ["silver", "blue"],
});

// TypeScript knows that coho has properties "species" and "colors" with the correct types
console.log(coho.species); // "Oncorhynchus kisutch"
console.log(coho.colors.length); // 2

// TypeScript will throw errors if you try to modify the properties since it's readonly
// coho.species = "Betta imbellis"; // Error: Cannot assign to 'species' because it is a read-only property
```

Let's break down these two uses of Reflect.

#### Reflect.ownKeys()

Why do we use this rather than Object.keys? In many cases you can use Object.keys, but it doesn't provide as complete of a picture. It will skip over keys marked as enumerable, and it'll ignore symbols entirely. If we used Object.keys instead, any example where a type uses a symbol wouldn't work. This allows us to create a more consistent, predictable API that encourages more explicit data to be given to the constructor. If someone doesn't want non-enumerable keys to appear in their structs, the keys simply shouldn't be present.

#### Reflect.defineProperty()

Again, Object.defineProperty could be an option here, but Reflect provides us with a more fine-grained tool which provides compatibility with the Proxy API. When implementing lower-level features of a library like this, that consistency, control, and compatibility is extremely useful.

### Making it easier to use with Data.case

Though this isn't specific to Reflect, we can show that these data structures are type safe and able to create reproducible constructors very easily. In the Data module from Effect, you can create constructors based on an interface or type with the case method. Let's add the same feature ourselves:

```typescript
class Data {
  static struct<T extends object>(data: T): Readonly<T> {
    return Object.freeze(new DataStruct(data)) as Readonly<T>;
  }

  static case<T extends object>(): (data: T) => Readonly<T> {
    return (data: T): Readonly<T> => {
      return Object.freeze(new DataStruct(data)) as Readonly<T>;
    };
  }
}
```

With case implemented, we can now create instances of a type we've already defined! I love this. Creating data structures from types or inferring them from data (but always consistently one or the other) is an incredible way to avoid types and data drifting in unexpected ways. We can use our types as a source of truth here and provide ourselves with The Right Way to make a type of data structure. No more magical object creation:

```typescript
interface Fish {
  readonly species: string;
}

// Create a constructor for the Fish interface
const Fish = Data.case<Fish>();

// Create an instance
const coho = Fish({ species: "Oncorhynchus kisutch" });

// Access is type safe and the object behaves as expected
console.log(coho.species); // "Oncorhynchus kisutch"
```

### Implementing Equals

You likely noticed the Equals module alongside Data in the Effect link above. We can use Reflect to implement some of the basic behaviour of this module as well.

One of the benefits of using Reflect internally here is that we know we've used Reflect.ownKeys to create these data structures, and now using Reflect.ownKeys inside of Equal will ensure we're always iterating over the correct keys:

```typescript
class Equal {
  static equals(a: any, b: any): boolean {
    // Same reference
    if (a === b) {
      return true;
    }

    const aKeys = Reflect.ownKeys(a);
    const bKeys = Reflect.ownKeys(b);

    // Check if the number of keys is the same
    if (aKeys.length !== bKeys.length) {
      return false;
    }

    // Check for equality of properties
    return aKeys.every((key) => {
      const aValue = Reflect.get(a, key);
      const bValue = Reflect.get(b, key);

      // Recursively compare objects and arrays
      if (this.isObject(aValue) && this.isObject(bValue)) {
        return this.equals(aValue, bValue);
      }

      return aValue === bValue; // Check primitive values
    });
  }

  static isObject(value: any): boolean {
    return (
      value !== null && (typeof value === "object" || Array.isArray(value))
    );
  }
}

// Let's make it more complicated to compare
interface Fish {
  species: string;
  colors: string[];
}

// Create a constructor for the Person type
const Fish = Data.case<Fish>();

// Create some instances to compare
const coho = Fish({ species: "Oncorhynchus kisutch" });
const betta = Fish({ species: "Betta imbellis" });
const siameseFighting = Fish({ species: "Betta imbellis" });

// Checking equality
console.log(Equal.equals(betta, siameseFighting)); // true
console.log(Equal.equals(coho, betta)); // false
```

Did you notice the new usage of Reflect here? It's Reflect.get, which again might seem unnecessary, but it's very useful.

#### Reflect.get and why we wouldn't use bracket notation

Previously I mentioned we already know our objects and keys are safe since we used Reflect.ownKeys. In theory we should be able to access the properties of nested objects using the keys we have already with bracket notation, right?

Not quite. It's possible with the API we've created to define keys which aren't accessible via bracket notation, such as non-enumerable keys or those which use a getter method. In cases where the object uses a proxy, Reflect.get(a, key) will trigger the get trap where as a[key] won't. This consistency with the Proxy API becomes very useful as you go deeper, and is more reliable and predictable as a whole.

Cool, right? I wouldn't ship this to production, but hopefully you can see some of the power you can begin to get with Reflect fairly quickly.

### Check out the code

You can play with this code in a playground [here](https://www.typescriptlang.org/play/?#code/MYGwhgzhAEAiYBczQN4ChrQkhBLYWCATgK7AIA8AKtAKYAeCtAdgCYwD2ARgFa3kA+ABStEYAFzQqASkkAlWmFYdmIAJ7UBqDJmhFaCEkWbQA8r34IAdADN9tAF60hzWgHc4YgMrEyCEWLS0tCQ0ApKKuqaANw6AL5oOtiI+NDAkLTUdIws7NDcfIJCstABSJIy0AC8WuHKqhpUWui6egZGJmUSUiV1kY1aNdqtmPqGxtAIABa4EFbYpORd0rGtcavQCQlooJAw8Eg+iwjDaSoLfhxEXZIFlsEtugo2IJZWHG7MANK0ahDLtiuAFEwMApkIANa-arNHStZ6vchWVi0Gy4VwABSIHAADrQiAg1EJprMADTQKFqcmPEbQABuYBAJFoki6IRgYGYamkAG1KQBdUlwkZuIi4JBcV6SGyMiC0ckAegV0AAkgBbNUkCWvaA47F4gm4WgQYWtFgkNX4sCSlmTUi0U2bFbCuLOzBbRK7KDQIEARxIjNOyTwBFo-tlQm6nKp0C4kmjJS4HA4r05p0wSugXjAlraNnxLGADtauBspWQVUrsYejrGHTtzI27sSrWA5xOYB+f2qYVRiOsH2+v3+YDdujbzGwsa7MCqvZeb0HM6EXGdwszKrL01o0GYFq4+PyZcpMFmzAA5Cdt1gc-LJlNfuf9NBWKX8-pmCcLuQTSWy5GZysV5mAAc2maAAEIqy4QDgLAqYa1pOsJhlEA5SbTYW10TMAGEH2ACFoBsK46HDEBxTUI9dX1fE8GNcl0VAEhX1A3djSYVhqNxWijV-XRkJMTthysWg6XxIlKRhdNx3bEIADVGWZHsETeECDEjclKTHVtZK4BSmR3OcVKRNT-C4TTfjXWlMwxfFiKINUX1oWgcTONUcTAMUIBUIiSLuH8QjYEIiCIMA-kdUtShJOZZnMQp-DAfTmWCAAyFL71mKxYosJY9MU2ggmk1oBIyuYwwDNDIySu88oMlZoEzBRgCMCBcDE9Q0nwwjXGwWhOP8hA+LWLDWlwjh3M8nc9VwNVxTancGQMob+PaCZEvy6poOqjDXQ2bZMGDVJsvioRFuZeMuUTZNUxMGk2nGEwzp3KC5z3EAQGgNKorUPEODLJ7Nrnc8BvPaAAB8wegABBEKwqyiAYdCoknqCPa0G2Ccp16sSewOMB5l8JYUGYW9JAAImx2gyfJMA1MkABmAB2XbPXOFNaCAjgQKESmrFpgroga5UmcSdEmCIGUi2gAAxWYpiDPFgF4yQFnRECNjbEArggFXiDVnl+VibZcP0RAd2QTHCYQEj7PvHdbKIbyTEJPEdlk2WIHluc8asdI5QoD2pmENdLbOKYOB7QOhBQLBFeV6AydMZg2yIKY1GTqYSBgCFZi1MFqbOLXHckHkyclZkC4p3AQDEogyf5J1YlDg8ECQSO5ej2P+HjsmACEDDbmaD3e2YC817WS7J-RWGpsuDMrrhsU+evG7dycv1wW85VlkCpjwVi5yjmOIDj41yf71vkCH2gR4gMeUwn6BS+nhf5-JMul+YFeWbX7zXk57mfoKoiTIv8FuSByStS3rQHee81aoyFg2B0mN2YAKEEAxkICKr-DbOHck4DRz1UzKhOUaAgA). Experiment with it a bit and see what's going on! It's simpler than it might look at a glance.

## Summary

I hope this lends some insight into why Reflect is so useful. This only scratches the surface, so in the near future I'd like to go broader and deeper into some examples of how dynamic object construction can be a great thing, and how Reflect makes this much nicer than it would be without it.

On its surface Reflect might seem redundant and/or opaque in its purpose. My goal here was to elucidate some of its features and explain how it fits into the language, so hopefully I've accomplished that.

Give it a try. As always, start small and work your way up.

### When you might use Reflect

If you aren't sure if you need the Reflect API, you probably don't. If it seems like you might, ask yourself these questions:

1. Am I dealing with very complex objects?
   - If so, is performance critical? There are some minor performance penalties incurred by the Reflect API (much like the Proxy API), apart from Reflect.apply().
2. Is handling property descriptors properly an imperative aspect of your project?
   - Reflect provides a real advantage here.
3. Is error handling a crucial component of the work I'm doing around Proxies and property descriptors?
   - Reflect's methods definitely provide more insight into what's causing errors and why, which can benefit both API consumers and its developers. It also reduces the need for verbose and frustrating try/catch statements.
4. Are dynamic properties a cornerstone of the code I'm writing?
   - Reflect is arguably the best way to safely and consistently handle dynamic object creation, manipulation, and access.
5. Do I need consistency and safety in how objects are defined and accessed?
   - In these cases, Reflect can provide a much more consistent, terse, and fine-grained solution for managing this type of logic.
6. Do I already use the Proxy API to manage getting and setting properties?
   - Reflect's compatibility with the Proxy API means less logic and margin for error when managing proxy methods.
7. Will the complexity ultimately help or hinder what I'm doing?
   - Like generators for example, Reflect comes with complexity. It's also less familiar to most developers. If this could be an issue for you, it might be best to stick with more familiar tools, even if they come with disadvantages.

This isn't an exhaustive list, but I think it's close. If you answer yes to a few, I'd consider taking the leap and start experimenting with the Reflect API. If you answer no to most or don't know the answer (that's fine), then don't worry about it. Write the code you know already and you'll be fine.
