---
title: "Practical Examples of Authentication in Meteor 1.0"
date: "2017-11-13T17:52:00.000Z"
slug: "practical-examples-of-authentication-in-meteor-1-0"
description: "A step-by-step guide to customize authentication via the accounts-ui package in Meteor 1.0."
---

My first dive into Meteor.js has been great. I'm starting to hit that point though (as you do with a full stack framework) where the default behaviours don't suit requirements. In this case my client doesn't like the default behaviours and appearance of the `accounts-ui` package.

`accounts-base` and `accounts-ui` are awesome packages that happen to make a heap of assumptions about how you're going to reason about your user's authentication and session management using a system called Accounts. That's alright though, because `accounts-ui` isn't necessarily intended to be the de facto way to provide access to the API of Accounts. It's there to get newcomers started, to help more experienced developers quickly prototype their ideas, and probably only occasionally remain a permanent fixture of the UI.

Here's a look at how we can replace the functionality of `accounts-ui` with custom behaviours and appearances.

### Get Your Packages

Before you can get going with this, you'll need to ensure you've pulled in both `accounts-base` and `accounts-password`. To do that, start up your terminal, change directories to your meteor project, and run these commands:

```bash
$ meteor add accounts-base
$ meteor add accounts-password
```

These are all you need for an impressive and comprehensive accounts management system in your app.

### Meteor.loginWithPassword()

Logging in with a username/email and password is the most common way your user will interact with Accounts. It's straight forward and relatively easy to interact with. These are the steps we'll need to take to get it working:

1. Provide a form for the user.
2. Set up a listener for the form's submit event.
3. Collect the form values as arguments for `loginWithPassword()`.

When calling `loginWithPassword`, you provide two, or optionally 3 arguments. First is the email or username, then the password. Finally you can provide a callback to handle the result of the login attempt.

The following examples assume you're using the iron:router package for the routing behaviours, but it isn't required - The Accounts system is totally decoupled from your application logic.

#### Step 1: Build the Template

To get started, we just need a template. Given you can literally put this _anywhere_ in a meteor app, do whatever suits you here. I keep my accounts and authentication-related files in `client/accounts/`. You can style this template any way you'd like - It has no bearing on the functionality.

```html
<template name="Login">
  <form id="login">
    <label for="login-username">User Name</label>
    <input type="text" id="login-username" />

    <label for="login-password">Password</label>
    <input type="password" id="login-password" />

    <input type="submit" value="Login" />

    <p id="form-messages"></p>
  </form>
</template>
```

<Note>client/accounts/login.html</Note>

#### Step 2: Set Up The Event

Once our template is present, Meteor's ready to listen to events inside of it. We can follow the Meteor convention here and drop the event into the `Template.Login.events` hash.

```javascript
Template.Login.events({
    'submit #login': function(event, template) {
        // Log in logic
    });

    return false;
});
```

<Note>client/accounts/login.js</Note>

#### Step 3: Provide the Authentication Logic

What will our event do? Not much, really - Accounts does most of the heavy lifting here.

1. First we collect our username and password data from the form.
2. Then we call `Meteor.loginWithPassword()` with our credentials and a callback.
3. Inside of that callback we determine if the user authenticated and respond accordingly.

```javascript
Template.Login.events({
  "submit #login": function (event, template) {
    // 1. Collect the username and password from the form
    var username = template.find("#login-username").value,
      password = template.find("#login-password").value;

    // 2. Attempt to login.
    Meteor.loginWithPassword(username, password, function (error) {
      // 3. Handle the response
      if (Meteor.user()) {
        // Redirect the user to where they're loggin into. Here, Router.go uses
        // the iron:router package.
        Router.go("dashboard");
      } else {
        // If no user resulted from the attempt, an error variable will be available
        // in this callback. We can output the error to the user here.
        var message =
          "There was an error logging in: <strong>" +
          error.reason +
          "</strong>";

        template.find("#form-messages").html(message);
      }

      return;
    });

    return false;
  },
});
```

<Note>client/accounts/login.js</Note>

The `error.reason` property provides a string clarifying the reason for the error, i.e. _"User not found"_ or _"Incorrect password"_.

So now what if your user wants to log out?

### Meteor.logout()

This works predictably - It logs out the user currently associated with the client's session. My approach here was to listen on the entire site's layout for the click of any element with the class `logout`, and upon logging out, redirect to the login page. In the callback you provide, a `Meteor.Error()` object will be present if there was an error, so you can handle that condition if you'd like to.

As a side note, this is how you can set a default layout for your templates using `iron:router` which makes setting events or helpers a lot more DRY.

```javascript
// Set a default layout template for all routes.
Router.configure({
  layoutTemplate: "Layout",
});

// As opposed to explicitly setting it with each route...
Router.route(
  "/my/route",
  function () {
    this.layout("Layout");
    this.render("MyPage");
  },
  {
    name: "my.page",
  }
);
```

<Note>client/routes/router.js</Note>

Once we've done that, we can set a `Template.Layout.events` method which handles all clicks of an anchor with the class `logout`. It can go in the navigation, in a dropdown menu, within some help text, whatever you like so long as the page uses the correct layout. If you choose to make logging out specific to a template, you can use the exact same code within a different template's events hash.

```javascript
Template.Layout.events({
  "click a.logout": function () {
    Meteor.logout(function () {
      // Redirect to login
      Router.go("/login");
    });

    return;
  },
});
```

<Note>client/layout/events.js</Note>

That is the most basic interaction with Accounts, but there's plenty more you can do. Up until this point, all of the examples make the assumption your application already has users. But what if you don't? How do you go about creating users, or creating a custom convention for creating users?

### Creating Users with Accounts.createUser()

This feature is slightly more nuanced than the previous ones. Its behaviour isn't consistent across the client and server, so the context of execution matters. It also allows quite a few callbacks to help with things like validation or altering the user before sending the data to the server.

### On the Client

When you create a user on the client, Meteor will automatically log you in as that user. If you've used `accounts-ui`, you probably noticed that the 'Create account' link on the `loginButtons` helper which provides a 'Password (again)' field will immediately log you in as that user once you submit the form. Because of this behaviour, it requires a username _and_ a password so the user can authenticate immediately, and then authenticate again at a later date.

The idea here is that in the most basic use case, someone can arrive at your app, enter credentials, and start using the app immediately as an authenticated user. There are options available to tailor that process, though. Accounts has support for verification emails for example, or you can implement your own approval process.

### On the Server

The server is less strict and doesn't require a password. This can be set arbitrarily at a later date using `Accounts.setPassword(userId, newPassword)`. You can also allow a user to choose their own password at a later date by triggering `Accounts.sendEnrollmentEmail(userId)`, which is highly configurable... But I won't go into that here.

### Creation from the Client

In my own case, I only needed to create users from the client using a form which covered the minimum requirements and provided an optional form for a user profile. Similar to authenticating, all we need here is:

1. A template with a form
2. A listener for the template's form submission event
3. Logic to use the form data with `Accounts.createUser()`

#### Step 1: The Template and Form

This template has a form with a field for the username, email, password, and profile values. Yours could be just about anything - The profile object in Accounts doesn't really care what exists there, and validation is entirely up to you.

```html
<template name="CreateUser">
  <form id="create-user">
    <fieldset>
      <legend>Credentials</legend>
      <label for="create-user-username">User Name</label>
      <input
        type="text"
        id="create-user-username"
        placeholder="SteamDonkey2014"
      />

      <label for="create-user-email">Email</label>
      <input type="text" id="create-user-email" placeholder="you@domain.tld" />

      <label for="create-user-password">Password</label>
      <input type="password" id="create-user-password" placeholder="Password" />

      <label for="create-user-password-confirm">Confirm Password</label>
      <input
        type="password"
        id="create-user-password-confirm"
        placeholder="Confirm Password"
      />
    </fieldset>

    <fieldset>
      <legend>Profile (Optional)</legend>
      <label for="create-user-name">Name</label>
      <input type="text" id="create-user-name" />

      <label for="create-user-astro">Astrological Symbol</label>
      <input type="text" id="create-user-astro" />

      <label for="create-user-newsletter">Subscribe to Newsletter</label>
      <input type="checkbox" id="create-user-newsletter" />
    </fieldset>

    <input type="submit" value="Sign Up!" />
  </form>
</template>
```

<Note>client/accounts/create-user.html</Note>

#### Step 2: Event Prep

Like before, setting up the event is simple.

```javascript
Template.CreateUser.events({
  'submit #create-user': function(event, template) {
      // Code goes here
    });

    return false;
  }
});
```

<Note>client/accounts/users.js</Note>

#### Step 3: Event Logic

We'll need a bit of boilerplate to get the data from the form, but once we've done that we're ready to fire off the data and see what happens. If your data is good and the user is created, you should be logged in as the user you just created.

```javascript
Template.CreateUser.events({
  "submit #create-user": function (event, template) {
    var user;

    // Collect data and validate it.

    // You can go about getting your data from the form any way you choose, but
    // in the end you want something formatted like so:
    user = {
      username: formUsername,
      password: formPassword,
      email: formEmail,
      profile: {
        name: formName,
        // etc...
      },
    };

    // Post the user to the server for creation
    Accounts.createUser(user, function (error) {
      if (error) {
        // :(
        console.log(error);
      }
    });

    return false;
  },
});
```

<Note>client/accounts/users.js</Note>

Worth noting is that if you have validation requirements beyond what Meteor enforces and you aren't performing validation before triggering `createUser`, you can run validation logic before a user is created using `Accounts.validateNewUser()`. If you return true from this method, Meteor will proceed with trying to create the user. If you return false, the process is aborted and `Accounts.createUser()` will return in the optional callback with an error. You can set the error reason by throwing your own `Meteor.Error()`, like so:

```javascript
// Validate new users
Accounts.validateNewUser(function (user) {
  // Ensure user name is long enough
  if (user.username.length < 5) {
    throw new Meteor.Error(403, "Your username needs at least 5 characters");
  }

  var passwordTest = new RegExp("(?=.{6,}).*", "g");
  if (passwordTest.test(user.password) == false) {
    throw new Meteor.Error(403, "Your password is too weak!");
  }

  return true;
});
```

<Note>client/validation/user.js</Note>

Remember `error.reason` in the login process? This is how you access your custom messages when throwing errors in `Meteor.Error`. If you'd like, you can let Meteor generate a default error by simply calling `Meteor.Error` with no arguments.

Finally, if you want to do work on users before they're persisted to the database, there's another Accounts method called [`onCreateUser()`](https://web.archive.org/web/20180916154925/http://docs.meteor.com/#/full/accounts_oncreateuser) which allows you to push the user object through a callback before it hits the server. It also allows you to throw an error to abort creation, but its purpose isn't validation, so if errors occur they should be for other reasons.

## What's Next?

To really round this out, we still need a couple of things. Users should be able to reset their passwords and recover their passwords for convenience and security.

### Reset a Forgotten Password

I'll assume by now that you're comfortable with Meteor conventions and I'll outline these tasks quickly, showing the templates and then corresponding code.

```html
<template name="RecoverPassword">
  {{#if resetPassword}}
  <form id="set-new-password">
    <label for="new-password">New Password</label>
    <input
      type="text"
      id="new-password"
      placeholder="Try not to forget this one."
    />

    <input type="submit" value="Set New Password" />

    <p id="form-messages"></p>
  </form>
  {{else}}
  <form id="forgot-password">
    <label for="user-email">Email</label>
    <input type="text" id="user-email" placeholder="Email" />

    <input type="submit" value="Get Reset Password Instructions" />

    <p id="form-messages"></p>
  </form>
  {{/if}}
</template>
```

<Note>client/accounts/forgot-reset-password.html</Note>

`Accounts.forgotPassword()` only requires and email, so this template is dead simple. Once we've wired this thing up, Meteor will send an email to the given email address if it's valid.

```javascript
// Ensure we have the token to pass into the template when it's present
if (Accounts._resetPasswordToken) {
  Session.set('resetPasswordToken', Accounts._resetPasswordToken);
}

Template.RecoverPassword.helpers({
  resetPassword: function() {
    return Session.get('resetPasswordToken');
  }
});

Template.RecoverPassword.events({
  'submit #forgot-password': function(event, template) {
    var email = template.find('#user-email'),
      message;

    // You will probably want more robust validation than this!
    if (email) {
      // This will send a link to the address which, upon clicking, prompts the
      user to enter a new password.
      Accounts.forgotPassword(email);
      message = 'Sent a reset password link to ' + email + '.';
    } else {
      message = 'Please enter a valid email address.'
    }

    // Inform the user.
    template.find('#form-messages').html(message);

    return false;
  },
  'submit #set-new-password': function (event, template) {
    // Proper decoupled validation would be much nicer than this
    var password = template.find('#new-password').value,
      passwordTest = new RegExp("(?=.{6,}).*", "g");

    // If the password is valid, we can reset it.
    if (passwordTest.test(password)) {
      Accounts.resetPassword(
        Session.get('resetPasswordToken'),
        password,
        function (error) {
          if (err) {
            template.find('#form-messages').html('There was a problem resetting your password.');
          } else {
            // Get rid of the token so the forms render properly when they come back.
            Session.set('resetPasswordToken', null);
          }
        })
      });
    } else {
      // Looks like they blew it
      template.find('#form-messages').html('Your password is too weak!');
    }

    return false;
  }
});
```

<Note>client/accounts/recover-password.js</Note>

And there you have it - Password recovery. Finally, for routine password updates for users, it's as simple this:

```html
<template name="ChangePassword">
  <form id="change-password">
    <label for="current-password">Current Password</label>
    <input type="text" id="current-password" placeholder="Current Password" />

    <label for="new-password">New Password</label>
    <input type="text" id="new-password" placeholder="New Password" />

    <label for="new-password-repeated">Repeat New Password</label>
    <input
      type="text"
      id="new-password-repeated"
      placeholder="Repeat New Password"
    />

    <input type="submit" value="Update Password" />

    <p id="form-messages"></p>
  </form>
</template>
```

<Note>client/accounts/change-password.html</Note>

You don't _have_ to force the user to repeat their new password, but it's certainly a good idea. If anything it just prevents using the forgot password process again if they typed something wrong, at only a minor inconvenience. Finally, here's all we need to do to change it:

```javascript
Template.RecoverPassword.events({
  "submit #change-password": function (event, template) {
    var currentPassword, newPassword, newPasswordRepeated;

    currentPassword = template.find("#current-password");
    newPassword = template.find("#new-password");
    newPasswordRepeated = template.find("#new-password-repeated");

    // You will want to validate your passwords better than this
    if (newPassword !== newPasswordRepeated) {
      template.find("#form-messages").html("The new passwords don't match!");

      return false;
    }

    Accounts.changePassword(currentPassword, newPassword, function (error) {
      if (error) {
        message = "There was an issue: " + error.reason;
      } else {
        message = "You reset your password!";
      }
    });

    // Inform the user.
    template.find("#form-messages").html(message);

    return false;
  },
});
```

<Note>client/accounts/change-password.js</Note>

Anyway, that's plenty to get your feet wet doing manual account management with Meteor. There's so much more you can do to customize your app, and the best way to find out how is [reading the docs!](http://docs.meteor.com) With this foundation, the rest of it is a breeze.
