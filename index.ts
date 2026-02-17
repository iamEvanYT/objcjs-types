import { getPointer, NobjcLibrary } from "objc-js";
import { CGRect, NSApplication, NSString, NSWindow } from "./src";

console.log("Hello via Bun!");

// Load AppKit framework with full path
const AppKit = new NobjcLibrary(
  "/System/Library/Frameworks/AppKit.framework/AppKit"
);

// Create a CGRect structure for the window frame
const rect = CGRect(100, 100, 800, 600);

// Define window style mask
// NSWindowStyleMaskTitled (1) | NSWindowStyleMaskClosable (2) | NSWindowStyleMaskMiniaturizable (4) | NSWindowStyleMaskResizable (8)
const styleMask = 1 | 2 | 4 | 8; // = 15

// NSBackingStoreBuffered = 2
const backingStoreType = 2;

// Create the window
const window = NSWindow.alloc().initWithContentRect$styleMask$backing$defer$(
  rect,
  styleMask,
  backingStoreType,
  false
);

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
app.run();
