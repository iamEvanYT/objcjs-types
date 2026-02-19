/**
 * Type-level test: verifies that `instanceof` narrows union return types
 * from protocol-typed methods (e.g. ASAuthorization.credential()).
 *
 * This file is NOT meant to be executed — it only needs to typecheck.
 * Run: bunx tsgo --noEmit tests/instanceof-narrowing.ts
 */

import {
  ASAuthorization,
  ASAuthorizationAppleIDCredential,
  ASPasswordCredential,
  type _ASAuthorization,
  type _ASAuthorizationAppleIDCredential,
  type _ASPasswordCredential
} from "../src/AuthenticationServices";

// Simulate having an ASAuthorization instance
declare const auth: _ASAuthorization;

// credential() should return a union of concrete conformers, not the empty protocol
const cred = auth.credential();

// instanceof should narrow the type
if (cred instanceof ASAuthorizationAppleIDCredential) {
  // After narrowing, cred should be _ASAuthorizationAppleIDCredential
  // which has .user(), .email(), etc.
  const user: ReturnType<_ASAuthorizationAppleIDCredential["user"]> = cred.user();
  const email: ReturnType<_ASAuthorizationAppleIDCredential["email"]> = cred.email();
  void user;
  void email;
} else if (cred instanceof ASPasswordCredential) {
  // After narrowing, cred should be _ASPasswordCredential
  // which has .user() and .password()
  const user: ReturnType<_ASPasswordCredential["user"]> = cred.user();
  const password: ReturnType<_ASPasswordCredential["password"]> = cred.password();
  void user;
  void password;
}
