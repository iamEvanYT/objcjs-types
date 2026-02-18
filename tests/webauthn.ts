import { ASAuthorizationPlatformPublicKeyCredentialProvider } from "../src/AuthenticationServices";
import { NSData, NSString } from "../src/Foundation";

const rpId = NSString.stringWithUTF8String$("com.example.app");
if (!rpId) throw new Error("Failed to create rpId");
const platformProvider =
  ASAuthorizationPlatformPublicKeyCredentialProvider.alloc().initWithRelyingPartyIdentifier$(
    rpId
  );
if (!platformProvider) throw new Error("Failed to create platform provider");
const challengeBuffer = Buffer.from("challenge", "utf-8");
const challenge = NSData.dataWithBytes$length$(
  challengeBuffer,
  challengeBuffer.length
);
if (!challenge) throw new Error("Failed to create challenge");
const platformKeyRequest =
  platformProvider.createCredentialAssertionRequestWithChallenge$(challenge);

console.log("platformKeyRequest", platformKeyRequest);
