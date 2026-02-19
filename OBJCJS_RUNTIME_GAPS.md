# objc-js Runtime Gaps

This document describes Objective-C type patterns that cannot be accurately represented
in TypeScript because the objc-js native bridge does not yet support them. These were
identified by auditing the C++ source in `node_modules/objc-js/src/native/`.

## Class Parameters (`#` type encoding)

**Problem:** The `AsObjCArgument()` switch in `bridge.h` has no case for the `#`
(Class) type encoding. Passing a class object as a parameter throws a TypeError at
runtime.

**Affected APIs:** Any method that accepts a `Class` parameter, e.g.:

- `NSKeyedUnarchiver.unarchivedObjectOfClass$fromData$error$`
- `NSBundle.loadNibNamed$owner$topLevelObjects$`
- Various `+classForKeyedUnarchiver`, `+classForCoder` style methods

**Current workaround:** These parameters are typed as `NobjcObject`, which is
technically incorrect but at least doesn't suggest a non-object type.

**Fix needed in objc-js:** Add a `#` case to `AsObjCArgument()` that accepts
`NobjcObject` instances whose underlying native object is a Class.

## Pointer Return Types (`^` type encoding)

**Problem:** `GetInvocationReturnVisitor` in `type-conversion.h` throws a TypeError
for pointer-type return values (`^v`, `^{...}`, etc.). The `validReturnTypes` string
in `ObjcObject.mm` is `"cislqCISLQfdB*v@#:"` which does not include `^`.

**Affected APIs:** Methods returning `void *`, CF types (e.g., `CGColorRef`,
`CGImageRef`, `CTFontRef`), or typed pointers.

**Current workaround:** Return types for these are mapped to `NobjcObject` in the
generated declarations. At runtime, calling these methods will throw.

**Fix needed in objc-js:** Support returning pointer types, likely by wrapping them in
a Buffer or a new `NobjcPointer` type.

## Block Parameters (`@?` type encoding)

**Problem:** While blocks can be _received_ from Objective-C (as `NobjcObject`), there
is no way to _pass_ a JavaScript function as a block parameter. The `@?` encoding
matches the `@` case in `AsObjCArgument()`, which expects a `NobjcObject` — not a JS
function. Creating block objects from JS closures is not supported.

**Affected APIs:** All callback/completion-handler patterns, e.g.:

- `NSURLSession.dataTaskWithURL$completionHandler$`
- `NSAnimationContext.runAnimationGroup$completionHandler$`
- `dispatch_async` style APIs

**Current typing:** Block parameters are typed as `NobjcObject`, which is accurate for
what the bridge accepts today but prevents the common use case of passing JS callbacks.

**Fix needed in objc-js:** Implement block creation from JS functions, using
`ffi_closure` or `imp_implementationWithBlock` to bridge JS callbacks into ObjC blocks.

## Out-Parameters in Callbacks (`^@` in block signatures)

**Problem:** When Objective-C calls a JS-created block (if supported in the future),
out-parameters (e.g., `NSError **`) are passed as `null` to the JS callback instead of
a mutable reference. The JS side cannot write back to these out-params.

**Current impact:** Minimal — since block creation from JS isn't supported yet, this is
a future concern.

**Fix needed in objc-js:** Provide a mechanism (e.g., a wrapper object with a `set()`
method) for JS callbacks to write values into out-parameters.

## Summary Table

| Feature           | Type Encoding     | Runtime Behavior        | TS Workaround |
| ----------------- | ----------------- | ----------------------- | ------------- |
| Class params      | `#`               | Throws TypeError        | `NobjcObject` |
| Pointer returns   | `^v`, `^{...}`    | Throws TypeError        | `NobjcObject` |
| JS → Block params | `@?`              | Must pass `NobjcObject` | `NobjcObject` |
| Block out-params  | `^@` in block sig | Passed as `null`        | N/A           |
