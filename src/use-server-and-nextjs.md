---
title: "'use server' and Next.js"
date: "2024-09-04T21:07:45.000Z"
slug: "use-server-and-nextjs"
description: "When you add the 'user server' directive to your files, you're implicitly creating public, privileged endpoints to your exported functions."
---

::: info Note:
There's a Github issue specific to this concern [here](https://github.com/vercel/next.js/issues/63804?ref=steve-adams.me).
:::

While debugging some issues in a client's Next.js project, I had to look closer at how `use server` works under the hood ([here's a decent overview](https://react.dev/reference/rsc/use-server)). I knew there must be http endpoints created for the functions—perhaps with some indirection—but I wasn't sure how it worked exactly.

Well, it turns out to be simple... And very direct. This is both good and a little concerning. If you understand it, it's a pretty handy tool that allows for some useful conventions, and it's easy enough to avoid exporting functions without the checks and balances public endpoints should have. If you don't understand (this could be a lot of Next.js devs), you can easily create endpoints for functions without realizing you did, or the significance of doing so.

Here's an example:

```typescript
"use server";

import { sql } from "@vercel/postgres";

const getUserByID = (id: string) =>
  await sql`SELECT * FROM users WHERE id = ${id}`;

// Totally hypothetical examples
export async function getUserPhonenUmber(userId: string) {
  const user = await getUserByID(userId);

  return user.phoneNumber;
}

export async function getUserPrivateData(userId: string) {
  const user = await getUserByID(userId);

  return user.somePrivateData;
}
```

<Note>/somewhere/user-data.ts</Note>

By adding `use server` to the top of the file, you're telling Next.js to turn these two exported functions into public endpoints called "server actions". This means not only your code has access to these functions, but anyone who cares to enumerate your client-side code for endpoints like these. This might be obvious to some more experienced developers but might go right over the heads of newcomers.

I have a feeling this would be especially true for developers who have been using Next.js predominantly for client side work in the past. This paradigm could be totally mysterious to them, and the implicit nature of this doesn't clearly highlight the need to treat server and client code differently.

I can't help thinking that in the age of inline SQL in JS, inexperienced developers are being given tools to accidentally expose extremely vulnerable endpoints without even knowing it. Then again, that was true 15 years ago when we were SQL-injecting our WordPress sites. Know your tools, I guess.

## What should you do?

First, recognize that every server action can be run by _anyone_. Ask yourself if that's alright, and if not, consider how you can remove or mitigate risks. If everything is safe to make public then you're okay, but you should always review this to ensure you don't eventually leak sensitive data through these functions.

If it isn't safe to expose, here are some strategies you can use.

### Stop using top-level 'use server'

One easy (though incomplete) step you can take is to stop exporting anything that doesn't actually need to be exported. You can easily do this by only using the directive inside of specific functions.

In our previous example, you can avoid the top level use server if one of the functions doesn't need to be exported, but one does:

```typescript
// 'use server' <-- Don't do this // [!code --]

import { sql } from "@vercel/postgres";

const getUserByID = (id: string) =>
  await sql`SELECT * FROM users WHERE id = ${id}`;

// Totally hypothetical examples
export async function getUserPhoneNUmber(userId: string) {
  "use server"; // <-- Do this [!code ++]
  const user = await getUserByID(userId);

  return user.phonenUmber;
}

// This will no longer be made public
export async function getUserPrivateData(userId: string) {
  const user = await getUserByID(userId);

  return user.somePrivateData;
}
```

<Note text="/somewhere/user-data.ts" />

You can even enforce that in your code base using [this eslint rule](https://github.com/c-ehrlich/eslint-plugin-use-server). It isn't perfect, but it's a good start and good practice in general.

### Import 'server-only'

Another strategy is specifying files as 'server-only'. This ensures nothing in the file will be made accessible to the client (using a [surprisingly simple method](https://github.com/vercel/next.js/blob/528980f680a7756264a38fe1cf3f900a1dceeef7/packages/next/src/compiled/server-only/index.js), too). In the example above, we can move our server-only function to a new file and specify that it should say on the server:

```typescript
import "server-only";
import { getUserById } from "../wherever.ts";

export async function getUserPrivateData(userId: string) {
  const user = await getUserByID(userId);

  return user.somePrivateData;
}
```

<Note text="/lib/private-user-data.ts" />

Now we can even import this and use it within our other file, and be confident the function will be used within that code but _not_ made public:

```typescript
import { sql } from "@vercel/postgres";
import { getUserPrivateData } from "../lib/private-user-data.ts";

const getUserByID = (id: string) =>
  await sql`SELECT * FROM users WHERE id = ${id}`;

export async function getUserPhoneNumber(userId: string) {
  "use server";
  const user = await getUserByID(userId);

  return user.phoneNumber;
}

// Some other function which wants private data
// This won't cause `getUserPrivateData` to be exposed despite it being exported in its own file
async function doThingsWithPrivateData(userId: string) {
  const privateData = getUserPrivateData(userId);

  // etc
}
```

<Note text="/somewhere/user-data.ts" />

Though this is a nice form of control, it might be a bit convoluted to newcomers. I think this is part of the inherent risk with this convention. There's a lot of implicit behaviours connected to these directives.

### Use access control

The best thing you can do is think about access control becoming a required component of how you write server functions. This is a good idea regardless of the framework (or lack thereof) that you're using, but arguably more important than ever with Next.js. Previously, anyone making public endpoints would have been doing so in the api directory. I think they'd be more likely know what they're doing and why. Now, anyone can create a pipe into a function just by typing 12 characters at the top of a file. They might not even be sure _why_ they're writing it, but copied it from a tutorial or something.

Anyway, by ensuring that the user performing a request has authorization to use a given function, it's okay if one is exposed when it doesn't need to be. The only people who will see the data are those who are already privileged to do so anyway.

This is accomplished by getting the current user and checking against their roles and permissions to see if they're allowed to see the data being accessed. Using the previous example, we can add some checks to see if the data should be exposed:

```typescript
import 'server-only';
import { cookies } from 'next/headers';

export async function getCurrentUser() => {
  const token = cookies().get('AUTH_TOKEN');
  const decodedToken = await decryptAndValidate(token);

  return new User(decodedToken.id);
};

// Admins and people on the same team can see phone numbers
function canSeePhoneNumber(viewer: User, user: User) {
  return viewer.isAdmin || user.team === viewer.team;
}

// Only admins can see the private data
function canSeePrivateData(viewer: User, user: User) {
  return viewer.isAdmin;
}
```

<Note text="/lib/auth.ts" />

```typescript
import { sql } from "@vercel/postgres";
import {
  getCurrentUser,
  canSeePhoneNumber,
  canSeePrivateData,
} from "../lib/auth.ts";
import { getUserPrivateData } from "../lib/private-user-data.ts";

const getUserByID = (id: string) =>
  await sql`SELECT * FROM users WHERE id = ${id}`;

export async function getUserPhoneNumber(userId: string) {
  "use server";
  const viewer = await getCurrentUser();
  const user = await getUserByID(userId);

  return canSeePhoneNumber(currentUser, user) ? user.phoneNumber : null;
}

// You can also extend this to multi-property endpoints
export async function getUserData(id: string) {
  const viewer = await getCurrentUser();
  const user = await getUserByID(userId);

  return {
    phoneNumber: canSeePhoneNumber(viewer, user) ? user.phoneNumber : null,
    privateData: canSeePrivateData(viewer, user) ? user.privateData : null,
  };
}
```

<Note text="/somewhere/user-data.ts" />

```typescript
import "server-only";
import { getCurrentUser } from "./auth.ts";

export async function getUserPrivateData(userId: string) {
  const viewer = await getCurrentUser();
  const user = await getUserByID(userId);

  return canSeePrivateData(currentUser, user) ? user.privateData : null;
}
```

<Note text="/lib/private-user-data.ts" />

Now, no matter what's exported, we know that only privileged users will see the data that the functions can expose. If someone were to clumsily add a use server to the top level of the file, it's going to be alright. Not everyone will be able to view the sensitive data, even though the function is public.

Of course, you'll want to think about organizing the code pertaining to access control in a way that it's easily testable and reusable. The example above isn't a suggestion for how to do that. [This example from Vercel](https://nextjs.org/blog/security-nextjs-server-components-actions) has some helpful ideas like the dto pattern, (which I've borrowed a bit from here), but if this is new territory to you, don't stop there! Security is wildly important and a single blog post will never be enough to get you up to speed.

### Configure code owner rules

Consider ensuring someone at your organization is tasked with reviewing these types of files any time they change. This kind of intentionality around code ownership is extremely helpful.

Especially if you use access control with DTO files, having someone who specifically reviews and tests these objects for holes and vulnerabilities is a really, really good idea.

```
# @dto-code-owner owns any file designated as a DTO
**/*-dto.ts @dto-code-owner

```

<Note text="CODEOWNERS" />

This same principle can be applied to any potentially sensitive files which generate server actions. Make sure someone will always be assigned to take a look at whether or not these actions should exist, that they're designed safely, and they expose the correct data. Imagine that all the rigour and care put into building an API safely should be put into practice here as well.

## Should you ever use top-level 'use server'?

Sure, if you're taking all of these precautions I think it can be fine. The key is being aware of what it does and having conventions in place which automatically mitigate any risks it could entail.

Good luck, and keep your users safe!
