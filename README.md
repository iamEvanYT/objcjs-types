# objcjs-types

TypeScript type declarations for macOS Objective-C frameworks. Auto-generated from Apple SDK headers via `clang -ast-dump=json`.

Designed for use with [objc-js](https://github.com/iamEvanYT/objc-js) and [Bun](https://bun.sh).

## Coverage

~5,400 classes, ~1,000 protocols, ~2,600 enums, and ~100 structs across 153 frameworks including Foundation, AppKit, WebKit, Metal, AVFoundation, CoreData, and more.

## Install

```bash
bun add objcjs-types objc-js
```

## Usage

Import frameworks by name:

```ts
import { NSApplication, NSWindow, NSWindowStyleMask } from "objcjs-types/AppKit";
import { NSString } from "objcjs-types/Foundation";
import { CGRect } from "objcjs-types";
import { options } from "objcjs-types/helpers";
```

Create a window:

```ts
const rect = CGRect(100, 100, 800, 600);

const styleMask = options(
  NSWindowStyleMask.Titled,
  NSWindowStyleMask.Closable,
  NSWindowStyleMask.Miniaturizable,
  NSWindowStyleMask.Resizable
);

const window = NSWindow.alloc().initWithContentRect$styleMask$backing$defer$(
  rect,
  styleMask,
  2, // NSBackingStoreBuffered
  false
);

const title = NSString.stringWithUTF8String$("Hello from Bun");
if (!title) throw new Error("Failed to create title");
window.setTitle$(title);
window.makeKeyAndOrderFront$(null as any);
```

### Type-safe delegates

`createDelegate` infers method names and parameter types from the protocol name:

```ts
import { createDelegate } from "objcjs-types";

const delegate = createDelegate("NSWindowDelegate", {
  windowDidResize$(notification) {
    console.log("Window resized!");
  },
  windowWillClose$(notification) {
    app.terminate$(null as any);
  }
});

window.setDelegate$(delegate);
```

### `instanceof` narrowing

Class constants have `Symbol.hasInstance` patched so that `instanceof` works with ObjC objects, using the runtime's `isKindOfClass:` check:

```ts
import {
  ASAuthorizationAppleIDCredential,
  ASPasswordCredential,
  type _ASAuthorization
} from "objcjs-types/AuthenticationServices";

declare const auth: _ASAuthorization;
const cred = auth.credential();

if (cred instanceof ASAuthorizationAppleIDCredential) {
  cred.user(); // narrowed to _ASAuthorizationAppleIDCredential
  cred.email();
} else if (cred instanceof ASPasswordCredential) {
  cred.user();
  cred.password();
}
```

There's also an `isKindOfClass` type guard for explicit narrowing with a generic type parameter:

```ts
import { isKindOfClass } from "objcjs-types/helpers";
import {
  ASAuthorizationAppleIDCredential,
  type _ASAuthorizationAppleIDCredential
} from "objcjs-types/AuthenticationServices";

if (isKindOfClass<_ASAuthorizationAppleIDCredential>(cred, ASAuthorizationAppleIDCredential)) {
  cred.user(); // narrowed
}
```

Both `instanceof` and `isKindOfClass` cache results per (object, class) pair so repeated checks skip the native boundary.

### NS_OPTIONS

Use `options()` to combine bitmask flags with type safety:

```ts
import { options } from "objcjs-types/helpers";
import { NSWindowStyleMask } from "objcjs-types/AppKit";

const mask = options(NSWindowStyleMask.Titled, NSWindowStyleMask.Closable, NSWindowStyleMask.Resizable);
```

Plain numeric expressions like `1 | 2 | 8` also work -- NS_OPTIONS types accept any `number`.

### Structs

Structs are plain objects with factory functions:

```ts
import { CGRect, CGPoint, CGSize } from "objcjs-types";

const rect = CGRect(0, 0, 800, 600);
const point: CGPoint = { x: 100, y: 200 };
const size: CGSize = { width: 800, height: 600 };
```

### NSData conversion (`objcjs-types/nsdata`)

Utilities for converting between NSData and JavaScript Buffers:

```ts
import { NSDataFromBuffer, bufferFromNSData, NSDataFromBase64, base64FromNSData } from "objcjs-types/nsdata";

const nsData = NSDataFromBuffer(Buffer.from("hello"));
const buffer = bufferFromNSData(nsData);
const b64 = base64FromNSData(nsData);
```

### OS version detection (`objcjs-types/osversion`)

Cached macOS version queries with named release constants:

```ts
import { getOSVersion, isAtLeast, macOS, formatVersion } from "objcjs-types/osversion";

console.log(formatVersion(getOSVersion())); // "15.3.1"

if (isAtLeast(macOS.Sequoia)) {
  // Sequoia+ only APIs
}
```

### Helpers (`objcjs-types/helpers`)

```ts
import {
  NSStringFromString,
  NSArrayFromObjects,
  NSDictionaryFromKeysAndValues,
  options,
  isKindOfClass
} from "objcjs-types/helpers";

const nsStr = NSStringFromString("hello");
```

## Subpath exports

| Import path                | Contents                                               |
| -------------------------- | ------------------------------------------------------ |
| `objcjs-types`             | Structs, `createDelegate`, barrel re-exports           |
| `objcjs-types/helpers`     | `NSStringFromString`, `options`, `isKindOfClass`, etc. |
| `objcjs-types/nsdata`      | NSData/Buffer conversion utilities                     |
| `objcjs-types/osversion`   | macOS version detection and comparison                 |
| `objcjs-types/delegates`   | `createDelegate` and `ProtocolMap` type                |
| `objcjs-types/<Framework>` | Framework exports (e.g. `objcjs-types/AppKit`)         |

## ObjC selector naming

Objective-C selectors are mapped using `$` as the separator:

| ObjC                                           | TypeScript                                          |
| ---------------------------------------------- | --------------------------------------------------- |
| `init`                                         | `init()`                                            |
| `initWithFrame:`                               | `initWithFrame$(frame)`                             |
| `initWithContentRect:styleMask:backing:defer:` | `initWithContentRect$styleMask$backing$defer$(...)` |

Properties emit getters and setters:

```ts
window.title(); // getter
window.setTitle$(value); // setter
```

## Available frameworks

<details>
<summary>All 153 frameworks</summary>

Accessibility, AccessorySetupKit, Accounts, AddressBook, AdServices, AdSupport,
AppKit, AppleScriptKit, AppTrackingTransparency, AudioToolbox, AudioVideoBridging,
AuthenticationServices, AutomaticAssessmentConfiguration, Automator, AVFAudio,
AVFoundation, AVKit, AVRouting, BackgroundAssets, BackgroundTasks, BrowserEngineCore,
BrowserEngineKit, BusinessChat, CalendarStore, CallKit, Cinematic, ClassKit, CloudKit,
Collaboration, Contacts, ContactsUI, CoreAudio, CoreAudioKit, CoreBluetooth, CoreData,
CoreHaptics, CoreImage, CoreLocation, CoreMediaIO, CoreMIDI, CoreML, CoreMotion,
CoreSpotlight, CoreTelephony, CoreText, CoreWLAN, CryptoTokenKit, DataDetection,
DeviceCheck, DeviceDiscoveryExtension, DiscRecording, DiscRecordingUI, EventKit,
ExceptionHandling, ExecutionPolicy, ExtensionKit, ExternalAccessory, FileProvider,
FileProviderUI, FinderSync, Foundation, FSKit, GameController, GameKit, GameplayKit,
GameSave, GLKit, HealthKit, IdentityLookup, ImageCaptureCore, InputMethodKit,
InstallerPlugins, InstantMessage, Intents, IntentsUI, IOSurface, IOUSBHost,
iTunesLibrary, JavaRuntimeSupport, JavaScriptCore, Kernel, LinkPresentation,
LocalAuthentication, LocalAuthenticationEmbeddedUI, MailKit, MapKit, Matter,
MediaAccessibility, MediaExtension, MediaLibrary, MediaPlayer, Metal, MetalFX,
MetalKit, MetalPerformanceShaders, MetalPerformanceShadersGraph, MetricKit, MLCompute,
ModelIO, MultipeerConnectivity, NaturalLanguage, NearbyInteraction, NetworkExtension,
NotificationCenter, OpenDirectory, OSAKit, OSLog, ParavirtualizedGraphics, PassKit,
PDFKit, PencilKit, PHASE, Photos, PhotosUI, PreferencePanes, PushKit, QuartzCore,
QuickLookThumbnailing, QuickLookUI, ReplayKit, SafariServices, SafetyKit, SceneKit,
ScreenCaptureKit, ScreenSaver, ScreenTime, ScriptingBridge, SecurityFoundation,
SecurityInterface, SecurityUI, SensitiveContentAnalysis, SensorKit, ServiceManagement,
SharedWithYou, SharedWithYouCore, ShazamKit, Social, SoundAnalysis, Speech, SpriteKit,
StoreKit, Symbols, SyncServices, SystemExtensions, ThreadNetwork,
UniformTypeIdentifiers, UserNotifications, UserNotificationsUI, VideoSubscriberAccount,
VideoToolbox, Virtualization, Vision, WebKit

</details>

## Regenerating types

Requires macOS with Xcode installed.

```bash
bun run build    # generate from SDK headers + compile to dist/
```

## License

MIT
