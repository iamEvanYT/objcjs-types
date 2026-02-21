# Missing Patterns Analysis

**Date:** February 21, 2026  
**Context:** Investigation of missing enum and type patterns in objcjs-types generator

This document catalogs patterns found in macOS SDK headers that are not currently captured by the type generator.

---

## Currently Handled Patterns ✅

The generator successfully captures:

1. **`typedef NS_ENUM(Type, Name) { ... }`** - Integer enums (e.g., NSWindowStyleMask)
2. **`typedef NS_OPTIONS(Type, Name) { ... }`** - Bitmask options
3. **`typedef NSString * Name NS_TYPED_EXTENSIBLE_ENUM;`** - String enums
4. **`typedef NSString * Name NS_STRING_ENUM;`** - String enums
5. **`typedef NSString * Name NS_TYPED_ENUM;`** - String enums
6. **`typedef NSInteger Name NS_TYPED_EXTENSIBLE_ENUM;`** - Integer extensible enums (added Feb 2026)
7. **`@interface ClassName`** - Classes
8. **`@protocol ProtocolName`** - Protocols

---

## Missing Patterns - Detailed Analysis

### Priority 1: NS_ERROR_ENUM 🔴 **HIGH PRIORITY**

**Count:** 71 instances across 20+ frameworks  
**Status:** NOT CAPTURED  
**Impact:** HIGH - Error enums are critical for proper error handling

**Pattern:**

```objc
typedef NS_ERROR_ENUM(DomainName, ErrorTypeName) {
    ErrorName1 = value1,
    ErrorName2 = value2,
    ...
}
```

**Distribution:**

- ImageCaptureCore: 8 instances
- PassKit: 6 instances
- WebKit: 5 instances
- CallKit: 5 instances
- AuthenticationServices: 4 instances
- 20+ other frameworks

**Examples:**

```objc
// From WebKit/WKWebExtension.h
typedef NS_ERROR_ENUM(WKWebExtensionErrorDomain, WKWebExtensionError) {
    WKWebExtensionErrorUnknown = 1,
    WKWebExtensionErrorResourceNotFound,
    WKWebExtensionErrorInvalidManifest,
    ...
}

// From AuthenticationServices/ASAuthorizationError.h
typedef NS_ERROR_ENUM(ASAuthorizationErrorDomain, ASAuthorizationError) {
    ASAuthorizationErrorUnknown = 1000,
    ASAuthorizationErrorCanceled = 1001,
    ASAuthorizationErrorInvalidResponse = 1002,
    ...
}
```

**Implementation:** Simple regex addition - identical AST structure to NS_ENUM:

```typescript
const NS_ERROR_ENUM_RE = /typedef\s+NS_ERROR_ENUM\s*\(\s*\w+\s*,\s*(\w+)\s*\)/;
```

---

### Priority 2: NS_CLOSED_ENUM 🟡 **LOW-MEDIUM PRIORITY**

**Count:** 8 instances  
**Status:** NOT CAPTURED (but some may be captured anyway via comments/fallback)  
**Impact:** LOW - Only 8 instances, semantically identical to NS_ENUM for TypeScript

**Pattern:**

```objc
typedef NS_CLOSED_ENUM(Type, Name) {
    Value1,
    Value2,
    ...
}
```

**Examples:**

```objc
// From AppKit/NSCursor.h
typedef NS_CLOSED_ENUM(NSUInteger, NSCursorFrameResizePosition) {
    NSCursorFrameResizePositionTop = (1 << 0),
    NSCursorFrameResizePositionLeft = (1 << 1),
    NSCursorFrameResizePositionBottom = (1 << 2),
    NSCursorFrameResizePositionRight = (1 << 3),
    ...
}

// From Foundation/NSObjCRuntime.h (currently DOES work)
typedef NS_CLOSED_ENUM(NSInteger, NSComparisonResult) {
    NSOrderedAscending = -1,
    NSOrderedSame = 0,
    NSOrderedDescending = 1,
}
```

**Implementation:** Trivial - add to existing alternation:

```typescript
const NS_ENUM_RE = /typedef\s+NS_(?:ENUM|OPTIONS|CLOSED_ENUM)\s*\(\s*\w+\s*,\s*(\w+)\s*\)/;
```

---

### Priority 3: CF_ENUM / CF_OPTIONS 🟠 **MEDIUM (BLOCKED)**

**Count:** 336 instances (CF_ENUM: 227, CF_OPTIONS: 109)  
**Status:** NOT CAPTURED - Blocked because CoreFoundation isn't processed  
**Impact:** MEDIUM - Many instances, but all in CoreFoundation which isn't currently supported

**Pattern:**

```objc
typedef CF_ENUM(Type, Name) { ... }
typedef CF_OPTIONS(Type, Name) { ... }
```

**Examples:**

```objc
// From CoreFoundation/CFAvailability.h
typedef CF_ENUM(CFIndex, CFComparisonResult) {
    kCFCompareLessThan = -1,
    kCFCompareEqualTo = 0,
    kCFCompareGreaterThan = 1
};

// From CoreFoundation/CFStream.h
typedef CF_OPTIONS(CFOptionFlags, CFStreamEventType) {
    kCFStreamEventNone = 0,
    kCFStreamEventOpenCompleted = 1,
    kCFStreamEventHasBytesAvailable = 2,
    ...
}
```

**Blocker:** The generator only processes `.framework` bundles. CoreFoundation is distributed differently in the SDK.

---

### Priority 4: CF_CLOSED_ENUM 🟢 **LOW (BLOCKED)**

**Count:** 7 instances  
**Status:** NOT CAPTURED - Blocked by CoreFoundation  
**Impact:** VERY LOW - Only 7 instances, all in CoreFoundation

**Example:**

```objc
typedef CF_CLOSED_ENUM(uint32_t, CGRectEdge) {
    CGRectMinXEdge, CGRectMinYEdge, CGRectMaxXEdge, CGRectMaxYEdge
};
```

---

### Priority 5: CF String Enums 🟠 **MEDIUM (BLOCKED)**

**Count:** 18 instances  
**Status:** NOT CAPTURED - Blocked by CoreFoundation  
**Impact:** MEDIUM - String enums, similar to NSString enums (which ARE supported)

**Pattern:**

```objc
typedef CFStringRef Name CF_EXTENSIBLE_STRING_ENUM;
typedef CFStringRef Name CF_STRING_ENUM;
```

**Examples:**

```objc
typedef CFStringRef CFNotificationName CF_EXTENSIBLE_STRING_ENUM;
typedef CFStringRef CFStreamPropertyKey CF_EXTENSIBLE_STRING_ENUM;
typedef CFStringRef CFDateFormatterKey CF_STRING_ENUM;
```

---

### Priority 6: Anonymous NS_ERROR_ENUM 🟢 **VERY LOW**

**Count:** 2 instances  
**Status:** NOT CAPTURED  
**Impact:** VERY LOW - Only 2 instances, legacy pattern

**Pattern:**

```objc
NS_ERROR_ENUM(DomainName) {
    ErrorName1 = value1,
    ...
}
```

**Example:**

```objc
NS_ERROR_ENUM(NSURLErrorDomain)
{
    NSURLErrorUnknown = -1,
    NSURLErrorCancelled = -999,
    NSURLErrorBadURL = -1000,
    ...
}
```

---

### Priority 7: Anonymous NS_ENUM 🟢 **VERY LOW**

**Count:** ~12 instances  
**Status:** NOT CAPTURED  
**Impact:** VERY LOW - Rare, creates global constants without a named type

**Pattern:**

```objc
NS_ENUM(Type) {
    ConstantName1 = value1,
    ...
}
```

**Example:**

```objc
NS_ENUM(NSInteger)
{
    NSURLErrorCancelledReasonUserForceQuitApplication = 0,
    NSURLErrorCancelledReasonBackgroundUpdatesDisabled = 1,
    ...
}
```

---

### Priority 8: Plain Anonymous Enums 🟢 **VERY LOW**

**Count:** ~5 instances  
**Status:** NOT CAPTURED  
**Impact:** VERY LOW - Old-style C enums, very rare

**Pattern:**

```objc
enum {
    ConstantName1 = value1,
    ...
};
```

**Example:**

```objc
enum {
    NSBundleExecutableArchitectureI386 = 0x00000007,
    NSBundleExecutableArchitecturePPC = 0x00000012,
    NSBundleExecutableArchitectureX86_64 = 0x01000007,
    ...
};
```

---

### Priority 9: Block Typedefs 🟡 **LOW-MEDIUM**

**Count:** ~10 instances in Foundation  
**Status:** NOT CAPTURED  
**Impact:** LOW-MEDIUM - Useful for type annotations, but blocks are just functions in objc-js

**Pattern:**

```objc
typedef ReturnType (^BlockName)(Params...);
```

**Examples:**

```objc
typedef NSComparisonResult (^NSComparator)(id obj1, id obj2);
typedef void (NS_SWIFT_SENDABLE ^NSProgressUnpublishingHandler)(void);
typedef void (^NSItemProviderCompletionHandler)(id item, NSError *error);
```

**Note:** Would require significant AST parsing to extract parameter and return types properly.

---

### Priority 10: Function Pointer Typedefs 🟢 **NONE**

**Count:** 0 instances found  
**Status:** NOT FOUND in modern frameworks  
**Impact:** NONE - Not used in modern Objective-C frameworks

**Pattern:**

```objc
typedef ReturnType (*FunctionName)(Params...);
```

---

## Recommendations

### Immediate Action Required

1. **Add NS_ERROR_ENUM support** (Priority 1)
   - 71 instances across 20+ frameworks
   - Critical for error handling
   - Easy implementation (identical AST structure to NS_ENUM)
   - Regex: `/typedef\s+NS_ERROR_ENUM\s*\(\s*\w+\s*,\s*(\w+)\s*\)/`

2. **Add NS_CLOSED_ENUM support** (Priority 2)
   - 8 instances, easy win for completeness
   - Trivial implementation (add to existing regex)
   - Pattern: `/typedef\s+NS_(?:ENUM|OPTIONS|CLOSED_ENUM)\s*\(\s*\w+\s*,\s*(\w+)\s*\)/`

### Future Considerations

3. **CoreFoundation support** (Blocked - architecture change needed)
   - Would unlock 336 CF_ENUM/CF_OPTIONS instances
   - Would unlock 18 CF string enum instances
   - Requires framework discovery changes

4. **Block typedefs** (Defer)
   - Limited value for current use cases
   - Significant implementation effort
   - Can revisit if user demand emerges

5. **Anonymous enums** (Skip)
   - Too rare (~20 total instances)
   - Low value for TypeScript consumers
   - Not worth the complexity

---

## Summary

**Bottom Line:** Add NS_ERROR_ENUM and NS_CLOSED_ENUM support immediately (both are trivial regex additions). The other missing patterns are either blocked by CoreFoundation support or too rare to warrant implementation.

**Total impact of immediate fixes:** 79 additional enum types across major frameworks.
