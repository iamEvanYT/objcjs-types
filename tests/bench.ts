import { NSApplication, NSEvent } from "../src/AppKit";

// WITHOUT THIS, THIS WILL TAKE 30ms+ TO RUN
NSApplication.sharedApplication();
await Bun.sleep(1000);
// THIS ABOVE

const start = performance.now();

NSEvent.mouseLocation();

const end = performance.now();

console.log(`Time taken: ${end - start} milliseconds`);

/*
It's **entirely Apple's fault**. The results make it clear:

```
1st call: 13.135 ms
2nd call:  0.062 ms
3rd call:  0.011 ms
```

The cost is a **one-time lazy initialization** triggered by the first `+[NSEvent mouseLocation]` call. Internally, Apple's implementation of that method has to establish a connection to the **window server** (via CoreGraphics / `CGSConnect`) and initialize the event subsystem — this is the "cold start" cost of any process that touches AppKit event APIs for the first time. It has nothing to do with objc-js.

After that first call, subsequent invocations are ~0.01ms — the actual ObjC method dispatch overhead is negligible.

The only way to "fix" this would be to warm up the event system earlier (e.g. call `NSApplication.sharedApplication()` or `NSEvent.mouseLocation()` at startup before it matters), but the cost itself is intrinsic to macOS.
*/
