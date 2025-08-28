---
title: "Summing the Largest Numbers in a JavaScript Array"
date: "2017-10-21T07:00:00.000Z"
slug: "summing-the-largest-values-javascript-array"
description: "A simple yet insightful look into turning an n*log(n) algorithm into an O(n) algorithm without much effort at all."
---

Earlier today I ran into a problem posed as an interview question. At a glance it seems simple, but it's an open ended question. Like any good assessment, it leaves room for programmers to express different solutions and degrees of aptitude.

The problem went a bit like this:

> Write a function that efficiently takes an array of integers and returns the sum of the two largest integers in the array. The array can be made up of any valid integers, and the length is unknown (but could be very large).

The problem could be solved with either PHP or JavaScript, and I chose JavaScript.

My first thought was that this could be done two ways (that I know of) which I could implement properly in the test scenario. One is to sort the array in descending numeric order and pluck the top 2 elements. The other was to use a for loop to run through the array and continuously pull larger values until I hit the end and had the top 2 remaining. What's better, and why? What's the context of the usage cases? Does it need to scale?

Well, the problem states the arrays _'could be very large'_. Since I had a (self imposed) time limit I decided to implement something:

- Concise
- Reasonably fast
- Easy to understand

This would be trivial using Array.prototype.sort().

## The Initial Solution

```javascript
/**
 * Sums the two largest numbers in an array of numbers.
 *
 * @param  {Array} numbers An Array of Numbers
 *
 * @return {Number}        The sum of the two largest Numbers
 */
function sumTwoLargestNumbers(numbers) {
  // Ensure the array is sorted large -> small
  numbers = numbers.sort(function (a, b) {
    return b - a;
  });

  return numbers[0] + numbers[1];
}

sumTwoLargestNumbers([20, 5, 13, 7, 200]);
// > 22
```

It's consice and clean, and it appears to work, so what's wrong with it? Well, I missed something pretty important:

```javascript
return numbers[0] + numbers[1];
```

I'm adding numbers[0] and numbers[1] without ensuring those indexes will be there. That's an easy fix by adding a condition like so:

```javascript
/**
 * Sums the two largest numbers in an array of numbers.
 *
 * @param  {Array}  numbers An Array of Numbers
 *
 * @return {Number}        The sum of the two largest Numbers
 */
function sumTwoLargestNumbers(numbers) {
  // Is the array long enough to sum?
  if (numbers.length < 2) {
    throw new Error("Expected an array with at least 2 elements.");
  }

  // Sort the array large -> small
  numbers = numbers.sort(function (a, b) {
    return b - a;
  });

  return numbers[0] + numbers[1];
}

sumTwoLargestNumbers([20, 5, 13, 7, 15]);
// > 35 (20 + 15)

sumTwoLargestNumbers([5]);
// > Error: Expected an array with at least 2 elements.
```

That seems better, but there's still another problem to address.

### Inefficiency With Array.prototype.sort()

This appears to be a nice solution because it is, for the developer, highly practical to write, maintain, and use. If you'd only ever use this function on small arrays I think you could stick with it!

The thing is, being concise and easy to understand here is hiding a lot of algorithmic complexity. I haven't reduced the amount of work done by writing less code. Instead I've increased it by outsourcing the workload to a pretty heavy algorithm that isn't really intended to be used for this problem. It's doing work that the function doesn't imply it should do or even needs to do; sorting the array is pointless outside of convenience. This method only simplifies my job by offloading work to an algorithm which isn't doing the _right_ work for our task. That seems like bad programming, and in the scope of this assessment, it is.

## The Second Solution

Later in the day, the person who posed the initial test question asked why I chose sorting over using a for loop. I didn't have a great answer apart from what is overtly beneficial about the sort solution. It's easy, it's clean, and it works.

Needless to say it became pretty clear that I should reconsider my approach. I wasn't entirely wrong to choose sort, but I also wasn't right either. I needed a better answer and a better understanding of the problem. I sat down and wrote out the following for loop solution in around 20 minutes. My sorting function took a total of about 15, for comparison — not as much time saved as I would have guessed.

```javascript
/**
 * Sums the two largest numbers in an array of numbers.
 *
 * @param  {Array}  numbers An Array of Numbers
 *
 * @return {Number}        The sum of the two largest Numbers
 */
function sumTwoLargestNumbers(numbers) {
  var largest,
    secondLargest,
    length = numbers.length,
    // Start i at 2 so we skip the first indexes we've already used for
    // largest and secondLargest
    i = 2;

  // Is the array long enough to sum?
  if (length < 2) {
    throw new Error("Expected an array with at least 2 elements.");
  }

  // Assign our starting values
  largest = numbers[0];
  secondlargest = numbers[1];

  // Ensure we're starting with largest and secondLargest properly arranged
  if (largest < secondLargest) {
    largest = numbers[1];
    secondLargest = numbers[0];
  }

  // Loop through the numbers
  for (let i = 0; i < length; i++) {
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
}

sumTwoLargestNumbers([20, 5, 13, 7, 15]);
// > 35 (20 + 15)

sumTwoLargestNumbers([5]);
// > Error: Expected an array with at least 2 elements.
```

It turns out the code isn't that much larger or hard to read. My concerns about writing an excessively verbose solution were unfounded.

The logic from the top down is straight forward and we get the same behaviours as we did with sort. Now we also have the benefit of only looking at smaller numbers two times at most here: if (numbers[i] > largest), and then here: else if (numbers[i] > secondLargest). Our worst case scenario for performance is drastically better than the sort solution.

### O(n) vs. O(n log n)

::: info _Future Steve says:_
Though I'm sure no one reads this anymore, here's a great [overview of Big O notation](https://samwho.dev/big-o/).
:::

When we iterate through our array with a for loop, we have the benefit of knowing that if summing an array of 100 elements takes 5ms, then summing 500 elements should take something like 25ms. This is because the complexity of the task doesn't increase at all. Our work load has increased proportionally so if we have five times the work to do, we can expect our execution time to increase by around five times. This is O(n), and it's nice to have when possible.

When we use Array.prototype.sort(), we're passing the workload to the browser's implemented sorting algorithm. As I understand, *most *browsers use the [merge sort](https://web.archive.org/web/20190130165942/http://en.wikipedia.org/wiki/Merge_sort){target="\_blank"} algorithm which has a complexity of O(n log n). It's guaranteed to be significantly slower than using a for loop in my function.

### What Are the Implications?

Unless this function is meant to sum relatively small sets of values, you shouldn't use the sort approach.

That's not to say native sorting is inherently slower than using for in all cases. In my case, it's only faster to use for because we're avoiding a so much unnecessary work by not sorting the rest of the array. All we do is continuously flip through our elements and remember the biggest ones we saw. That's a simple task. Sorting the entire list is not a simple task, on the other hand.

I'm sure the sort algorithm is implemented extremely well. It's just the wrong tool for the job.

### Profiling Our Solutions

I decided to take my experiment to [jsperf](https://jsperf.app/sort-vs-for-in-array-summing){target="\_blank"} (now defunct 🫠) and see what the difference is. It's not a perfect test as it could be benefited by more samples and input variations... But its initial results are telling. The sort method is evidently **~97%** slower.

With a smaller array, perhaps with 5 to 10 elements, we'd probably see results with it being closer to 65% slower. This is on account of the sort algorithm's workload not increasing proportionally as the for loop's workload does; the performance will decrease as the workload increases.

That's probably acceptable for small tasks in the client. But the test above uses only 816 elements - What if you needed to sum 10,000 elements this way, and you have to do it frequently? It's clear that the for loop would be essential for getting acceptable performance from this type of function.

::: info _About profiling:_
Click [here](./typescript-benchmarking-mitata) to learn more about profiling your code without the use of services that disappear over time.
:::

## Lesson Learned

Don't be afraid to get your hands dirty, even if the problem seems too simple to warrant a more complex solution. It's always worth considering or even pursuing other options.
