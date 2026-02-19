import { getPointer } from "objc-js";
import { CGRect, createDelegate } from "../src";
import { NSString } from "../src/Foundation";
import { NSApplication, NSWindow, NSWindowStyleMask } from "../src/AppKit";
import { options } from "../src/helpers";

console.log("Hello via Bun!");

// Create a CGRect structure for the window frame
const rect = CGRect(100, 100, 800, 600);

// Define window style mask using the options() helper
const styleMask = options(
  NSWindowStyleMask.Titled,
  NSWindowStyleMask.Closable,
  NSWindowStyleMask.Miniaturizable,
  NSWindowStyleMask.Resizable
);

// NSBackingStoreBuffered = 2
const backingStoreType = 2;

// Create the window
const window = NSWindow.alloc().initWithContentRect$styleMask$backing$defer$(rect, styleMask, backingStoreType, false);

// Set window title
const title = NSString.stringWithUTF8String$("My Window");
if (!title) throw new Error("Failed to create title");
window.setTitle$(title);

// Make the window visible and key
window.makeKeyAndOrderFront$(null as any);

// Get the content view
const view = window.contentView();
if (!view) throw new Error("No content view found");

// Get the raw pointer as a Buffer and read the pointer as a BigInt (64-bit unsigned integer)
const pointerBuffer = getPointer(view);
const pointer = pointerBuffer.readBigUInt64LE(0);
console.log(`NSView pointer: 0x${pointer.toString(16)}`);

// Start the application run loop to keep the window open
const app = NSApplication.sharedApplication();

// Create a type-safe window delegate using protocol types.
// createDelegate() infers method names and parameter types from the protocol name.
const delegate = createDelegate("NSWindowDelegate", {
  windowDidResize$(notification) {
    console.log("Window resized!");
  },
  windowWillClose$(notification) {
    console.log("Window closing, terminating app...");
    app.terminate$(null);
  }
});
window.setDelegate$(delegate);

app.run();
