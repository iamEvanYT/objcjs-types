/**
 * Type-level test: verifies that defineSubclass() provides type-safe
 * subclassing with typed `self`, protocol method autocomplete, and
 * correct return type for alloc/init.
 *
 * This file is NOT meant to be executed — it only needs to typecheck.
 * Run: bunx tsgo --noEmit tests/subclass.ts
 */

import { NSObject, type _NSObject } from "../src/Foundation";
import { NSWindow } from "../src/AppKit";
import { defineSubclass, callSuper } from "../src/subclass";

// --- Basic subclass with protocol conformance ---

const MyDelegate = defineSubclass(NSObject, {
  name: "MyDelegate",
  protocols: ["NSWindowDelegate"],
  methods: {
    // Protocol method — should typecheck
    windowDidResize$: {
      types: "v@:@",
      implementation(self, notification) {
        // self should be typed as _NSObject
        const desc: ReturnType<_NSObject["description"]> = self.description();
        void desc;
      }
    },
    windowWillClose$: {
      types: "v@:@",
      implementation(self, notification) {
        console.log("closing");
      }
    },
    // Superclass override
    init: {
      types: "@@:",
      implementation(self) {
        return callSuper(self, "init");
      }
    }
  }
});

// Return type should be typeof NSObject — alloc/init are available
const instance = MyDelegate.alloc().init();
// instance should be typed as _NSObject
const hash: ReturnType<_NSObject["hash"]> = instance.hash();
void hash;

// --- Subclass with no protocols ---

const MyObject = defineSubclass(NSObject, {
  name: "MyObject",
  methods: {
    customMethod: {
      types: "v@:",
      implementation(self) {
        // self is still typed as _NSObject
        self.description();
      }
    }
  }
});

const obj = MyObject.alloc().init();
void obj;

// --- Subclass of a more specific class ---

const MyWindow = defineSubclass(NSWindow, {
  name: "MyWindow",
  methods: {
    init: {
      types: "@@:",
      implementation(self) {
        // self should be typed as _NSWindow — has window-specific methods
        self.setTitle$(null as any);
        return callSuper(self, "init");
      }
    }
  }
});

// Should have NSWindow's static methods
const win = MyWindow.alloc().init();
win.makeKeyAndOrderFront$(null as any);
