// Struct type definitions and factory functions for objc-js
// These match the field names produced by the objc-js native bridge.

// --- Core Geometry ---

export interface CGPoint {
  x: number;
  y: number;
}

export function CGPoint(x: number, y: number): CGPoint {
  return { x, y };
}

export interface CGSize {
  width: number;
  height: number;
}

export function CGSize(width: number, height: number): CGSize {
  return { width, height };
}

export interface CGRect {
  origin: CGPoint;
  size: CGSize;
}

export function CGRect(
  x: number,
  y: number,
  width: number,
  height: number
): CGRect {
  return { origin: { x, y }, size: { width, height } };
}

export interface CGVector {
  dx: number;
  dy: number;
}

export function CGVector(dx: number, dy: number): CGVector {
  return { dx, dy };
}

// --- NS Aliases (identical layout to CG counterparts) ---

export type NSPoint = CGPoint;
export const NSPoint = CGPoint;

export type NSSize = CGSize;
export const NSSize = CGSize;

export type NSRect = CGRect;
export const NSRect = CGRect;

// --- Foundation Structs ---

export interface NSRange {
  location: number;
  length: number;
}

export function NSRange(location: number, length: number): NSRange {
  return { location, length };
}

export interface NSEdgeInsets {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export function NSEdgeInsets(
  top: number,
  left: number,
  bottom: number,
  right: number
): NSEdgeInsets {
  return { top, left, bottom, right };
}

export interface NSDirectionalEdgeInsets {
  top: number;
  leading: number;
  bottom: number;
  trailing: number;
}

export function NSDirectionalEdgeInsets(
  top: number,
  leading: number,
  bottom: number,
  trailing: number
): NSDirectionalEdgeInsets {
  return { top, leading, bottom, trailing };
}

// --- Transforms ---

export interface CGAffineTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export function CGAffineTransform(
  a: number,
  b: number,
  c: number,
  d: number,
  tx: number,
  ty: number
): CGAffineTransform {
  return { a, b, c, d, tx, ty };
}

// NSAffineTransformStruct is not in the objc-js known field table,
// so the runtime uses positional names (field0, field1, ...).
// The actual ObjC fields are: m11, m12, m21, m22, tX, tY.

export interface NSAffineTransformStruct {
  field0: number; // m11
  field1: number; // m12
  field2: number; // m21
  field3: number; // m22
  field4: number; // tX
  field5: number; // tY
}

export function NSAffineTransformStruct(
  field0: number,
  field1: number,
  field2: number,
  field3: number,
  field4: number,
  field5: number
): NSAffineTransformStruct {
  return { field0, field1, field2, field3, field4, field5 };
}
